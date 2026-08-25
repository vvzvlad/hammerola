#!/usr/bin/env python3
"""The ceilings one build runs under, and the code that puts them on.

Three different mechanisms guard a build and they do NOT overlap, so nothing
here is a spare copy of anything else (SPEC 8A.2 step 4):

  * `RLIMIT_CPU` -- the kernel kills a process that has BURNED that much
    processor time. It is the only one of the three that survives the hub: an
    orphaned build whose parent died still hits it. It cannot see a hang that
    consumes no CPU, and it is summed over threads, which is why the OCCT pool
    is capped as well (see `Limits.occt_threads`).
  * the parent's wall-clock timer plus `SIGKILL` (`runner.run_isolated`) -- the
    only thing that catches a deadlocked thread pool or a sleep, neither of
    which spends a microsecond of CPU.
  * `faulthandler.dump_traceback_later(..., exit=True)` inside the child
    (`child.py`) -- second echelon, and the only one that says WHERE the build
    got stuck.

A cgroup CPU limit is deliberately absent from that list, and not by oversight:
it throttles rather than kills, and a container cannot create a cgroup of its
own anyway -- `/sys/fs/cgroup` is mounted read-only. `systemd-run` is not an
option either, the image carries neither systemd nor dbus.

WHY A WRAPPER PROCESS RATHER THAN `preexec_fn`. `subprocess` will happily run a
callable between fork and exec, and that callable could call `setrlimit` -- and
the documentation marks it unsafe in the presence of threads, which is exactly
what the hub is (`ThreadingHTTPServer`). Between fork and exec only
async-signal-safe code may run, and the child of a forked multi-threaded
process holds locks that no thread will ever release, the interpreter's own
among them. So the ceilings go on in a process of their OWN: `wrapper.py` is a
fresh, single-threaded interpreter that sets them on itself and then `execv`s
the real child, which inherits them. Nothing unsafe happens in the window.
"""

from dataclasses import dataclass, replace
import resource
import sys


MiB = 1024 * 1024

# --- exit codes owned by the WRAPPER ---------------------------------------
# High and distinctive on purpose: an exit code from this range means the
# ceilings themselves went wrong, and it can never collide with the child's own
# codes (child.py) or with a plain `sys.exit(1)` out of the interpreter.
EXIT_LIMITS_UNAVAILABLE = 90
EXIT_WRAPPER_INVOCATION = 91
EXIT_EXEC_FAILED = 92
WRAPPER_EXIT_CODES = frozenset(
    {EXIT_LIMITS_UNAVAILABLE, EXIT_WRAPPER_INVOCATION, EXIT_EXEC_FAILED})


class LimitsUnavailable(RuntimeError):
    """A requested ceiling could not be applied, so the build must not start.

    Fail CLOSED, and that is the whole point of this exception existing rather
    than a warning: a build that runs without the ceiling it was configured
    with is indistinguishable, from the outside, from one that runs with it --
    right up to the moment somebody's model eats the host. Refusing is loud,
    lands before a line of untrusted code has run, and names the limit.
    """


# The table that drives both the message and the application. Keeping the
# resource NAME here rather than the constant lets the wrapper say
# "RLIMIT_AS is not settable on darwin" on a platform where the attribute
# exists but the kernel refuses it -- which is a real platform, see below.
_RLIMIT_TABLE = (
    # (Limits field, resource attribute, unit for the message)
    ("cpu_seconds", "RLIMIT_CPU", "s"),
    ("memory_bytes", "RLIMIT_AS", "B"),
    ("file_bytes", "RLIMIT_FSIZE", "B"),
    ("open_files", "RLIMIT_NOFILE", ""),
    ("processes", "RLIMIT_NPROC", ""),
    ("core_bytes", "RLIMIT_CORE", "B"),
)

# The fields of `Limits` the wrapper is given; everything else in the dataclass
# belongs to the parent (wall clock, log) or to the child (OCCT, faulthandler),
# and passing those along would only invite somebody to enforce them twice.
RLIMIT_FIELDS = tuple(field for field, _name, _unit in _RLIMIT_TABLE)


def memory_limit_supported():
    """Whether this platform lets a process cap its own address space.

    Linux does -- and Linux is where the hub runs. Darwin does NOT: measured
    here rather than assumed, `setrlimit` returns EINVAL for RLIMIT_AS,
    RLIMIT_DATA and RLIMIT_RSS alike, at every value tried from 512 MiB to
    200 GiB and with the hard limit both finite and infinite. There is no value
    that works, so there is no cleverness to add later.

    What that costs: a macOS workstation cannot run a build under the
    production ceilings at all -- `apply_process_limits` refuses, on purpose
    (see LimitsUnavailable). It is a development inconvenience and not a hole,
    because production is a Linux container; the deliberate part is that the
    refusal is LOUD there instead of silently running a build unbounded.
    """
    return not sys.platform.startswith("darwin")


@dataclass(frozen=True)
class Limits:
    """Every ceiling one build runs under, in one object.

    Read by three different processes, each taking only its own part: the
    parent (`wall_seconds`, `log_bytes`), the wrapper (everything in
    RLIMIT_FIELDS) and the child (`occt_threads`, `hang_dump_seconds`).
    """

    # --- the parent's ------------------------------------------------------
    # Wall clock. The ONLY ceiling that catches a hang which burns no CPU, and
    # therefore the one that cannot be dropped. SPEC 8A.2 puts the target at
    # 60-120 s for a real build.
    wall_seconds: float = 120.0
    # Bytes of the child's output kept. The rest is drained and discarded --
    # draining matters, a child blocked writing into a full pipe is a hang the
    # parent then has to kill, which would report a runaway `print` as a
    # timeout.
    log_bytes: int = MiB
    # What the build may leave in its output directory, in TOTAL and in ENTRIES.
    # `file_bytes` below is RLIMIT_FSIZE and caps one file; nothing in the
    # kernel caps the sum, so a loop writing small files fills the data volume
    # while every individual write stays legal -- and unlike CPU or memory, that
    # effect OUTLIVES the build. Enforced by the parent: while the build runs it
    # is measured on the wait loop's own polls and the build is killed when it
    # crosses (`runner._OutputGuard`), and the same measurement is taken once
    # more after the process is gone, because a fast writer can cross both
    # ceilings between two polls.
    #
    # The numbers are an order of magnitude above any real build and are meant
    # to be unreachable by accident: the whole UPLOAD is capped at 64 MiB
    # (MAX_BUILD_BYTES) and a build of it exports a handful of STLs, a few PNGs
    # and the tessellated views -- single-digit megabytes across tens of files.
    # 512 MiB is twice what one file may be, so the sum can never be dominated
    # by a legal single file; 4096 entries is what stops the OTHER shape of the
    # same attack, a million empty files, which costs inodes rather than bytes
    # and which a byte ceiling alone never notices.
    output_bytes: int | None = 512 * MiB
    output_files: int | None = 4096

    # --- the wrapper's (rlimits, applied to the child process) -------------
    # CPU seconds, summed over all threads. Bigger than `wall_seconds` because
    # of that summing: with `occt_threads` threads busy, the wall deadline is
    # reached first for anything that merely runs long. This ceiling is for the
    # case the wall timer cannot cover -- an orphaned build whose parent is
    # gone, where the kernel is the only thing left holding the leash.
    cpu_seconds: int | None = 300
    # Address space, NOT resident memory. OCP and VTK map several gigabytes of
    # shared objects before a model does anything, so this cannot be set near
    # the real working set (measured: ~450 MB resident right after `import
    # cadquery`). The container's own memory limit is the real memory quota
    # (SPEC 8A.2 step 0); this stops a single absurd allocation from ever being
    # attempted and, again, still holds when the parent is gone.
    memory_bytes: int | None = 6 * 1024 * MiB
    # One file's size. Exceeding it raises SIGXFSZ, which kills by default. The
    # whole upload is capped at 64 MiB elsewhere (MAX_BUILD_BYTES), so an
    # exported part an order of magnitude larger than the entire input is
    # already pathological.
    file_bytes: int | None = 256 * MiB
    # File descriptors. Generous: matplotlib and VTK open fonts and data files
    # by the dozen, and this is here to stop a leak from reaching the host's
    # table, not to be tight.
    open_files: int | None = 1024
    # Processes/threads. OFF by default, and the reason is that RLIMIT_NPROC is
    # counted PER UID rather than per process: every build in the container
    # runs as the same `app` user, so a second concurrent build would be
    # refused a thread because the first one already has some -- a failure that
    # looks like a bug in whichever model happened to be second. The container's
    # `pids` limit is where this belongs (SPEC 8A.2 step 0), and it counts the
    # right thing.
    processes: int | None = None
    # Core dumps. Zero, always: a crashed OCCT would otherwise write hundreds of
    # megabytes into the working directory -- with whatever the process had in
    # memory in it.
    core_bytes: int | None = 0

    # --- the child's -------------------------------------------------------
    # The OCCT thread pool takes every core it can see by default, and
    # RLIMIT_CPU is summed over threads: on a 20-core host that limit would
    # therefore fire twenty times sooner than the number suggests. Capping the
    # pool is what makes the CPU ceiling mean roughly what it says.
    occt_threads: int = 2
    # `faulthandler.dump_traceback_later(N, exit=True)` in the child. MUST stay
    # under `wall_seconds` or it never fires -- the parent's SIGKILL gets there
    # first and the stack, which is the entire reason this exists, is lost.
    # None disables it.
    hang_dump_seconds: float | None = 110.0

    def __post_init__(self):
        if self.wall_seconds <= 0:
            raise ValueError("wall_seconds must be positive")
        if self.log_bytes <= 0:
            raise ValueError("log_bytes must be positive")
        if self.occt_threads < 1:
            raise ValueError("occt_threads must be at least 1")
        for field in ("output_bytes", "output_files"):
            value = getattr(self, field)
            if value is not None and value < 1:
                raise ValueError(f"{field} must be positive or None")
        for field in RLIMIT_FIELDS:
            value = getattr(self, field)
            if value is not None and value < 0:
                raise ValueError(f"{field} must not be negative")
        if self.hang_dump_seconds is not None:
            if self.hang_dump_seconds <= 0:
                raise ValueError("hang_dump_seconds must be positive or None")
            if self.hang_dump_seconds >= self.wall_seconds:
                raise ValueError(
                    "hang_dump_seconds must be under wall_seconds, otherwise "
                    "the parent's SIGKILL always wins and the child never "
                    "dumps the stack it exists to dump")

    def rlimit_spec(self):
        """Just the part the wrapper enforces, as a plain dict for JSON."""
        return {field: getattr(self, field) for field in RLIMIT_FIELDS}

    def replace(self, **kw):
        """A copy with fields changed -- `dataclasses.replace`, re-exported."""
        return replace(self, **kw)


DEFAULT_LIMITS = Limits()


def apply_process_limits(spec):
    """Put every requested ceiling on THIS process. Refuse if one will not go on.

    Called by the wrapper, on itself, one exec before the untrusted code. The
    returned list is printed into the build log: what was asked for is not what
    was necessarily applied (see the clamping below), and the log is the only
    place that difference is ever visible.

    THE SPEC MUST NAME EVERY FIELD, and an unknown one is a refusal. The obvious
    version of this loop -- ask the spec for each field, skip what is not there
    -- fails OPEN in the two ways that matter, and both of them are silent. A
    field that went MISSING because the two halves of this component drifted
    apart, or because the JSON was truncated somewhere between them, reads
    identically to a ceiling deliberately switched off, so the build runs with
    one less limit than it was configured with and nothing says so. And an
    unknown key -- a field renamed on one side of the process boundary, a typo
    in a caller -- is dropped without a word, which is the same failure wearing
    the other hat: the ceiling is in the spec, the wrapper never applies it.
    `python -m src.buildproc.wrapper '{}' -- <anything>` used to run its target
    under no ceilings at all and print a cheerful "ceilings in force:" line
    above it. So: exactly the known set, no more and no less. `None` stays the
    way to switch one off, and it has to be written down to mean that.
    """
    if not isinstance(spec, dict):
        raise LimitsUnavailable(f"the rlimit spec must be an object, not "
                                f"{type(spec).__name__}")
    missing = sorted(set(RLIMIT_FIELDS) - set(spec))
    unknown = sorted(set(spec) - set(RLIMIT_FIELDS))
    if missing or unknown:
        raise LimitsUnavailable(
            "the rlimit spec must name exactly the fields this wrapper knows "
            f"({', '.join(RLIMIT_FIELDS)}); missing: "
            f"{', '.join(missing) or 'none'}; unknown: "
            f"{', '.join(unknown) or 'none'}")

    applied = []
    for field, name, unit in _RLIMIT_TABLE:
        requested = spec[field]
        if requested is None:
            # Present and explicitly off. `processes` is the standing example --
            # RLIMIT_NPROC is counted per UID and every build shares one, so it
            # is deliberately not applied (see the field's comment above).
            applied.append(f"{name}=off")
            continue
        # The spec crossed a process boundary as JSON, so its types are worth
        # one line: `setrlimit` raises different things on different platforms
        # for a value that is not a number, and one of them would arrive as an
        # uncaught exception rather than as a refusal.
        if not isinstance(requested, int) or isinstance(requested, bool):
            raise LimitsUnavailable(
                f"{name}: {field}={requested!r} is not an integer")
        which = getattr(resource, name, None)
        if which is None:
            raise LimitsUnavailable(
                f"{name} does not exist on {sys.platform}, so the ceiling "
                f"{field}={requested} cannot be applied")
        try:
            _soft, hard = resource.getrlimit(which)
        except (OSError, ValueError) as exc:
            raise LimitsUnavailable(f"cannot read {name}: {exc}") from exc

        # Clamp DOWN to the inherited hard limit rather than fail on it: only
        # root may raise a hard limit, and a container that already caps
        # something lower than we asked is stricter, not broken. Lowering is
        # always permitted, so what remains is either the request or something
        # tighter -- never looser.
        #
        # Inside the try with the setrlimit, and the type check above stands
        # even so: this comparison is the OTHER thing a non-number reaches, and
        # only for a resource whose inherited hard limit happens to be finite.
        # Left outside, that one case would come out as an uncaught TypeError
        # -- a traceback and an exit code that says nothing -- instead of as
        # the refusal every other bad ceiling produces.
        #
        # soft == hard, and for RLIMIT_CPU that is load-bearing rather than
        # tidy. At the SOFT limit the kernel sends SIGXCPU, which a process may
        # catch and ignore; at the HARD limit Linux sends SIGKILL, which it may
        # not. Leaving a gap between them hands untrusted code a documented way
        # to run as long as it likes -- one signal handler.
        try:
            value = requested
            if hard != resource.RLIM_INFINITY:
                value = min(value, hard)
            resource.setrlimit(which, (value, value))
        except (OSError, ValueError, TypeError) as exc:
            hint = ""
            if name == "RLIMIT_AS" and not memory_limit_supported():
                hint = (" -- this platform does not implement it at ANY value, "
                        "measured; the hub runs on Linux, where it does")
            raise LimitsUnavailable(
                f"{name} cannot be set to {value} on {sys.platform}: {exc}{hint}"
            ) from exc
        applied.append(f"{name}={value}{unit}")
    return applied
