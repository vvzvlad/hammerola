#!/usr/bin/env python3
"""The ceilings one build runs under, and the code that puts them on.

Three mechanisms guard a build and they do not overlap (SPEC 8A.2 step 4):

  * `RLIMIT_CPU` -- the kernel kills a process that has burned that much
    processor time. The only one that still holds for an orphaned build. It
    cannot see a hang that consumes no CPU, and it is summed over threads,
    which is why the OCCT pool is capped (see `Limits.occt_threads`).
  * the parent's wall-clock timer plus `SIGKILL` (`runner.run_isolated`) --
    the only thing that catches a deadlock or a sleep.
  * `faulthandler.dump_traceback_later(..., exit=True)` inside the child
    (`child.py`) -- second echelon, and the only one that says where the build
    got stuck.

No cgroup CPU limit: it throttles rather than kills, `/sys/fs/cgroup` is
mounted read-only in the container, and the image has no systemd for
`systemd-run`.

A wrapper process rather than `preexec_fn`: the hub is multi-threaded
(`ThreadingHTTPServer`), and code between fork and exec in a forked
multi-threaded process may deadlock on locks no thread will release. So
`wrapper.py`, a fresh single-threaded interpreter, sets the ceilings on itself
and `execv`s the real child, which inherits them.
"""

from dataclasses import dataclass, replace
import os
import resource
import sys


MiB = 1024 * 1024

# --- how many cores one build may use --------------------------------------
# How many builds the hub runs at once. Must equal `jobs.MAX_CONCURRENT_BUILDS`
# but cannot import it (jobs imports this package);
# `tests/test_build_ceilings.py` compares the two.
BUILDS_SHARING_THE_HOST = 4

# Ceiling on the pool whatever the machine has. OCCT's parallel sections scale
# sublinearly, and `cpu_seconds` is a multiple of this number: on a 64-core
# host an uncapped share (64 // 4 = 16 threads) would put the CPU backstop at
# five hours, i.e. switch it off.
MAX_OCCT_THREADS = 8


def _cgroup_cpu_quota():
    """Cores this container may use per the cgroup, or None if unlimited.

    `os.cpu_count()` reports the host's cores and ignores a compose `cpus:`
    limit, so with a two-core quota on a sixteen-core host every derived number
    would be eight times too big. SPEC 8A.2 step 0 sets container limits at
    deploy.
    """
    try:  # cgroup v2
        with open("/sys/fs/cgroup/cpu.max", encoding="ascii") as handle:
            quota, period = handle.read().split()[:2]
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
        return None
    except (OSError, ValueError, IndexError):
        pass
    try:  # cgroup v1
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", encoding="ascii") as handle:
            quota = int(handle.read().strip())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us", encoding="ascii") as handle:
            period = int(handle.read().strip())
        if quota > 0 and period > 0:
            return max(1, int(quota / period))
    except (OSError, ValueError):
        pass
    return None


def _usable_cores():
    """The smallest honest answer to "how many cores can this process use".

    The affinity mask, the cgroup quota and `os.cpu_count()` are each blind to
    something; the minimum of those available cannot overpromise.
    """
    answers = [count for count in (
        len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
        _cgroup_cpu_quota(),
        os.cpu_count(),
    ) if count]
    return min(answers) if answers else 1


def _default_occt_threads():
    """The OCCT pool one build gets: its share of the cores, floor 2, cap 8.

    A share, because `BUILDS_SHARING_THE_HOST` builds run at once: on the
    20-core hub that is 20 // 4 = 5 threads per build, and `cpu_seconds`
    follows by formula. The floor of two keeps a host that under-reports its
    cores (fractional quota, odd affinity mask) from making builds slower.
    """
    return max(2, min(MAX_OCCT_THREADS, _usable_cores() // BUILDS_SHARING_THE_HOST))


DEFAULT_OCCT_THREADS = _default_occt_threads()

# --- the two ceilings that follow from it ----------------------------------
# Wall clock and the two numbers derived from it, in one place so the
# derivations are code. The reasoning for each value is at its field below.
DEFAULT_WALL_SECONDS = 300.0

# The gap the child's traceback needs to land in before the parent's SIGKILL.
DEFAULT_HANG_DUMP_GAP_SECONDS = 10.0
DEFAULT_HANG_DUMP_SECONDS = DEFAULT_WALL_SECONDS - DEFAULT_HANG_DUMP_GAP_SECONDS

# RLIMIT_CPU is summed over threads, so the backstop has to clear what a fully
# parallel build may legitimately burn -- wall x threads -- with room.
CPU_HEADROOM = 1.25
DEFAULT_CPU_SECONDS = int(
    DEFAULT_WALL_SECONDS * DEFAULT_OCCT_THREADS * CPU_HEADROOM)

# --- exit codes owned by the WRAPPER ---------------------------------------
# High and distinctive: these mean the ceilings themselves went wrong, and they
# cannot collide with the child's codes (child.py) or a plain `sys.exit(1)`.
EXIT_LIMITS_UNAVAILABLE = 90
EXIT_WRAPPER_INVOCATION = 91
EXIT_EXEC_FAILED = 92
WRAPPER_EXIT_CODES = frozenset(
    {EXIT_LIMITS_UNAVAILABLE, EXIT_WRAPPER_INVOCATION, EXIT_EXEC_FAILED})


class LimitsUnavailable(RuntimeError):
    """A requested ceiling could not be applied, so the build must not start.

    Fail closed: a build running without a configured ceiling looks the same
    from outside as one running with it. Refusing is loud, happens before any
    untrusted code runs, and names the limit.
    """


# Drives both the message and the application. The resource name (not the
# constant) lets the wrapper report "RLIMIT_AS is not settable on darwin" where
# the attribute exists but the kernel refuses it.
_RLIMIT_TABLE = (
    # (Limits field, resource attribute, unit for the message)
    ("cpu_seconds", "RLIMIT_CPU", "s"),
    ("memory_bytes", "RLIMIT_AS", "B"),
    ("file_bytes", "RLIMIT_FSIZE", "B"),
    ("open_files", "RLIMIT_NOFILE", ""),
    ("processes", "RLIMIT_NPROC", ""),
    ("core_bytes", "RLIMIT_CORE", "B"),
)

# The fields of `Limits` the wrapper is given; the rest belong to the parent
# (wall clock, log) or the child (OCCT, faulthandler).
RLIMIT_FIELDS = tuple(field for field, _name, _unit in _RLIMIT_TABLE)

# The resource attributes those fields land on, for code outside this module
# that must know which ceilings exist instead of keeping a copy -- the test
# suite's rlimit guard (tests/process_limits.py, feeding
# tests/conftest.py::guard_process_limits).
RLIMIT_NAMES = tuple(name for _field, name, _unit in _RLIMIT_TABLE)


def memory_limit_supported():
    """Whether this platform lets a process cap its own address space.

    Linux does. Darwin does not: `setrlimit` returns EINVAL for RLIMIT_AS,
    RLIMIT_DATA and RLIMIT_RSS at every value from 512 MiB to 200 GiB, with
    finite and infinite hard limits alike (measured).

    So a macOS workstation cannot run a build under the production ceilings:
    `apply_process_limits` refuses loudly (see LimitsUnavailable) instead of
    running unbounded. Production is a Linux container.
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
    # Wall clock: the only ceiling that catches a hang which burns no CPU.
    #
    # The hub is 3.7-4x slower than a laptop on the same geometry (booleans are
    # single-threaded). A model's checks run as units
    # (`checkunits.UNIT_BUDGET_SECONDS`, 120 s each, own worker), so one hung
    # check costs 120 s rather than the whole wall clock. Heavy models must use
    # units: a model whose checks legitimately need more than five minutes is
    # killed.
    #
    # With MAX_CONCURRENT_BUILDS = 4, the worst honest queue wait is
    # MAX_QUEUED_JOBS x wall / workers = 16 x 300 / 4 = 20 minutes.
    #
    # Two numbers derive from this one: `LEFTOVER_MAX_AGE_SECONDS` in
    # src/store.py (must not sweep a build still queued) and `JOB_TIMEOUT` in
    # hammerola/hub.py (must not give up on a build still waiting).
    # `tests/test_build_ceilings.py` checks both against `worst_honest_wait()`;
    # the prose around them is not checked, so reread both when changing this.
    #
    # Not settable per deployment: nothing reads the environment and `jobs.py`
    # calls `run_build` without `limits=`, so these defaults are production.
    wall_seconds: float = DEFAULT_WALL_SECONDS
    # Bytes of the child's output kept. The rest is drained and discarded: a
    # child blocked on a full pipe would hang and be reported as a timeout.
    log_bytes: int = MiB
    # What the build may leave in its output directory, in total and in
    # entries. `file_bytes` (RLIMIT_FSIZE) caps one file; nothing in the kernel
    # caps the sum, and a full data volume outlives the build. Enforced by the
    # parent on the wait loop's polls (`runner._OutputGuard`) and once more
    # after exit, since a fast writer can cross between two polls.
    #
    # An order of magnitude above any real build (builds export single-digit
    # megabytes across tens of files). 512 MiB is twice the single-file limit;
    # 4096 entries stops a million empty files, which cost inodes rather than
    # bytes.
    output_bytes: int | None = 512 * MiB
    output_files: int | None = 4096

    # --- the wrapper's (rlimits, applied to the child process) -------------
    # CPU seconds, summed over all threads. For the case the wall timer cannot
    # cover: an orphaned build whose parent is gone.
    #
    # Computed, not picked: `wall_seconds` x `occt_threads` is the most a build
    # can legitimately burn before the wall timer fires, plus a quarter. Any
    # lower and it becomes the binding ceiling, killing a fully parallel build
    # inside its wall clock and reporting it as something other than a timeout.
    cpu_seconds: int | None = DEFAULT_CPU_SECONDS
    # Address space, not resident memory. OCP and VTK map several gigabytes of
    # shared objects up front (~450 MB resident right after `import cadquery`),
    # so this cannot be near the working set. The container's memory limit is
    # the real quota (SPEC 8A.2 step 0); this stops one absurd allocation and
    # holds when the parent is gone.
    memory_bytes: int | None = 6 * 1024 * MiB
    # One file's size; exceeding it raises SIGXFSZ, which kills by default. It
    # bounds what the build writes, not the pushed sources it reads.
    file_bytes: int | None = 256 * MiB
    # File descriptors. Generous: matplotlib and VTK open fonts and data files
    # by the dozen; this stops a leak, it is not meant to be tight.
    open_files: int | None = 1024
    # Processes/threads. Off: RLIMIT_NPROC counts per uid, and every build runs
    # as `app`, so a second concurrent build would be refused threads because of
    # the first. The container's `pids` limit is the right place (SPEC 8A.2
    # step 0).
    processes: int | None = None
    # Core dumps. Zero: a crashed OCCT would write hundreds of megabytes of
    # process memory into the working directory.
    core_bytes: int | None = 0

    # --- the child's -------------------------------------------------------
    # The OCCT pool takes every core by default and RLIMIT_CPU is summed over
    # threads; capping the pool makes the CPU ceiling mean roughly what it says.
    #
    # It costs build time: the pairwise interference check (325
    # independent intersects) is ~20x slower than on a laptop using every core,
    # but it is about a tenth of the build, so lifting the cap buys ~8%. Most of
    # the time is single-threaded booleans.
    #
    # `_default_occt_threads` derives it from the container's cores at runtime;
    # `cpu_seconds` follows by formula and test_build_ceilings.py checks it.
    #
    # `cProfile` counts the pool's time: the main thread waits inside the OCC
    # call (a boolean's `Build`) while the pool computes, and that wall time
    # lands on the call. What it cannot show is the pool threads' CPU time, so
    # compare its total with the clock, not with CPU time.
    occt_threads: int = DEFAULT_OCCT_THREADS
    # `faulthandler.dump_traceback_later(N, exit=True)` in the child; None
    # disables it. Must stay under `wall_seconds` (`__post_init__` enforces it)
    # or the parent's SIGKILL wins and the stack is lost. The child arms it
    # after its own start, so the 10 s gap covers the slowest start (measured
    # 0.8-7.6 s). A build that runs out of time dies here, at 290 s, not 300.
    hang_dump_seconds: float | None = DEFAULT_HANG_DUMP_SECONDS

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
    """Put every requested ceiling on this process. Refuse if one will not go on.

    Called by the wrapper on itself, one exec before the untrusted code. The
    returned list goes into the build log: what was applied may be tighter than
    what was asked (see the clamping below).

    The spec must name exactly the known fields. A missing field (drift between
    the two halves, truncated JSON) would otherwise read as a ceiling switched
    off, and an unknown key (a rename, a typo) would be dropped; both fail open
    silently. `None` is the explicit way to switch one off.
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

        # Clamp down to the inherited hard limit rather than fail: only root may
        # raise a hard limit, and a lower inherited cap is stricter, not broken.
        #
        # Inside the try because this comparison is the other place a
        # non-number reaches (when the hard limit is finite), and it must come
        # out as a refusal, not an uncaught TypeError.
        #
        # soft == hard matters for RLIMIT_CPU: the soft limit sends SIGXCPU,
        # which a process can ignore; the hard limit sends SIGKILL.
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
