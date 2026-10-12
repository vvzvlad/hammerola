#!/usr/bin/env python3
"""The parent half: start the build somewhere else, and be able to end it.

`run_isolated` is the machinery: one process, ceilings on it, a wall-clock
deadline, capped output capture. `run_build` points it at
`src.buildproc.child`. The split lets every hostile-process behaviour (hang,
CPU burn, endless output, spawned survivors, reading the environment) be
tested against small programs on a python with no CAD stack.

Called from a build worker, never a request thread (SPEC 8A.2 step 5):
`src/jobs.py` owns the queue and pool, and publishes only `if outcome.ok`, so a
refused build leaves `latest` and `dev` where they were.

Spawn, not fork: the prohibition is on a child that continues as a copy of
this interpreter (`multiprocessing` fork, bare `os.fork()`). OCCT's pool does
not survive that: its locks come across without the threads, and the first
parallel operation deadlocks. `subprocess` forks and immediately execs a fresh
interpreter (`test_isolation.py` pins this). There is no `preexec_fn` for the
same reason as in limits.py; `start_new_session` runs as a single
async-signal-safe `setsid()` in C.

The process group: `start_new_session=True` plus `killpg` reaches everything
the build spawned that stayed in the group. A descendant that called `setsid()`
itself is in its own group and cannot be enumerated (the kernel keeps no list,
and walking /proc races reparented orphans). Such a straggler survives the
kill and holds the output pipe, costing DRAIN_GRACE_SECONDS plus one thread
and one descriptor while it lives; `ProcessResult.stragglers` and a log line
record it. The real fix is the container's `pids` limit and a reaping
supervisor (SPEC 8A.2 step 0).
"""

from dataclasses import dataclass
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from src.buildproc.child import (
    EXIT_BUILD_FAILED,
    EXIT_CRASHED,
    EXIT_HANG_DUMP,
    EXIT_INVOCATION,
    EXIT_OK,
    EXIT_UNCAPPED,
)
from src.buildproc.limits import DEFAULT_LIMITS, WRAPPER_EXIT_CODES


# The repository root, and the working directory of every isolated process, so
# `-m src.buildproc.*` resolves to this tree rather than an uploaded `src/`.
HUB_ROOT = Path(__file__).resolve().parents[2]

# How long to wait for a process to be gone after SIGKILL. Only an
# uninterruptible kernel call can stretch this, and waiting longer would not
# help; the parent gives up and says so.
KILL_GRACE_SECONDS = 5.0
# How long to wait for the output reader after the process is gone. Reaching it
# means something is still holding the write end of the pipe after the whole
# process group was killed -- see the module docstring on `setsid`.
DRAIN_GRACE_SECONDS = 5.0
# How often the output directory is measured while the build runs; each
# measurement walks a directory. At 0.5 s a writer would have to sustain a
# gigabyte a second to cross the ceiling unseen.
OUTPUT_POLL_SECONDS = 0.5

# --- how `_wait_without_reaping` ended --------------------------------------
# Distinct because the kill that follows differs, and getting it wrong sends
# SIGKILL to a stranger's process group: see `_kill_group`.
_WAIT_EXITED = "exited"                # gone, and a zombie is holding the pid
_WAIT_DEADLINE = "deadline"            # still running when the wall clock ran out
_WAIT_GUARD = "guard"                  # still running, and the guard says stop
_WAIT_UNOBSERVABLE = "unobservable"    # cannot be waited for -- pid not ours now

# --- statuses `run_build` reports ------------------------------------------
STATUS_OK = "ok"                        # built, and the result checks out
STATUS_FAILED = "failed"                # BuildError: the model or a gate said no
STATUS_CRASHED = "crashed"              # an unexpected end -- ours to look at
STATUS_TIMEOUT = "timeout"              # the parent's wall clock, then SIGKILL
STATUS_HANG = "hang"                    # the child's own watchdog, with a stack
STATUS_CPU_EXHAUSTED = "cpu_exhausted"  # RLIMIT_CPU: it burned its allowance
STATUS_KILLED = "killed"                # a signal from outside: OOM killer, etc.
STATUS_LIMITS_ERROR = "limits_error"    # the ceilings would not go on
STATUS_OUTPUT_LIMIT = "output_limit"    # it wrote more than one build may write
STATUS_BAD_RESULT = "bad_result"        # it claimed something that is not true

# What a comparison asked for an artefact must leave behind. Not imported from
# `comparechild`: that would put `src.cadbuild` into the hub's process
# (src/cadbuild/__init__.py says why). `tests/test_compare.py` holds this equal
# to `comparechild.ARTEFACTS` and `store.COMPARE_FILES`.
_COMPARE_ARTEFACTS = ("scene.json", "report.json")

# Appended to the log of a build that left a straggler behind, so the leaked
# thread and descriptor are visible.
STRAGGLER_NOTE = (
    "\nbuildproc: something this build started outlived the kill of its process "
    "group -- it called setsid(), so it is in a group of its own -- and is "
    "still holding the output pipe. The hub keeps one thread and one descriptor "
    "for it until it exits.\n")


@dataclass(frozen=True)
class ProcessResult:
    """What became of one isolated process."""

    exit_code: int | None      # None when a signal ended it
    signal: int | None         # the signal number, or None
    timed_out: bool            # the PARENT's wall clock is what killed it
    log: str                   # stdout and stderr, merged, capped
    log_truncated: bool        # ...and there was more than the cap
    dropped_bytes: int         # how much more
    duration_seconds: float
    stragglers: bool           # something outlived the kill and held the pipe
    output_limit: str | None = None   # the guard stopped it; why, in one line

    @property
    def ok(self):
        return self.exit_code == 0


@dataclass(frozen=True)
class BuildOutcome:
    """What became of one build: `ProcessResult` read as a build.

    `pid` and `files` are the parent's answers, not the child's: the model can
    write anything into the result file (see child.py), so the project id comes
    from the accepted push and every file name was checked against the output
    directory.
    """

    status: str
    pid: str | None            # the hub's, from the accepted push
    files: tuple[str, ...]     # checked to exist under out_dir; empty unless ok
    log: str
    log_truncated: bool
    exit_code: int | None
    signal: int | None
    duration_seconds: float

    @property
    def ok(self):
        return self.status == STATUS_OK


def run_build(project_dir, out_dir, *, pid, limits=DEFAULT_LIMITS,
              preview_mode="iso", force=False, baseline=None):
    """Build the model in `project_dir` into `out_dir`, in a process of its own.

    `project_dir` is an untrusted tree (SPEC 8A.2 step 2). It contributes only
    a path: the interpreter, the module and every ceiling are literals here.

    `pid` is the project id of the accepted push. It is a parameter because it
    decides which project's `latest` a successful build replaces, and the model
    runs in the child, so anything the child writes is model-chosen. A mismatch
    with the tree's project.json is the gate's business (step 6).

    `force` skips the model's own checks(); the hub's gates still
    run.

    `baseline` is the `dev` slot's metrics.json, which the build diffs against.
    It is copied into the scratch directory and the copy is passed to the child.
    """
    project_dir = Path(project_dir).resolve()
    out_dir = Path(out_dir).resolve()

    # The parent's scratch directory: HOME, TMPDIR and the matplotlib cache
    # point into it, so the build cannot write into the `app` user's real home
    # (where a `.pth` file would run in the next interpreter, SPEC 8A.3). It
    # also holds the result file; 0700, removed afterwards.
    scratch = Path(tempfile.mkdtemp(prefix="hammerola-build-"))
    try:
        home = scratch / "home"
        tmp = scratch / "tmp"
        for directory in (home, tmp):
            directory.mkdir(mode=0o700)
        result_path = scratch / "result.json"

        target = [
            sys.executable, "-s", "-m", "src.buildproc.child",
            "--project", str(project_dir),
            "--out", str(out_dir),
            "--result", str(result_path),
            "--preview-mode", str(preview_mode),
            "--occt-threads", str(limits.occt_threads),
            # Always spelled out: the child takes only `--key value` pairs.
            "--force", "true" if force else "false",
        ]
        if limits.hang_dump_seconds is not None:
            target += ["--hang-dump-seconds", str(limits.hang_dump_seconds)]
        # Copied here, in the parent, before the child starts, so a `dev` build
        # is compared against the previous `dev` (the publish that overwrites
        # the slot happens after this returns, `jobs._build_and_publish`), and
        # so a parallel build swapping the slot (`store._swap_dev_slot`, two
        # renames) cannot change what is read halfway. Scratch is the only
        # channel for handing the child a file.
        #
        # A failed copy costs only the comparison: the child runs without
        # `--baseline`, the "nothing to compare against" branch.
        if baseline is not None:
            copy = scratch / "baseline.json"
            try:
                shutil.copyfile(baseline, copy)
            except OSError:
                pass
            else:
                target += ["--baseline", str(copy)]

        process = run_isolated(
            target, limits=limits,
            env=child_environment(home=home, tmp=tmp,
                                  threads=limits.occt_threads),
            guard=_OutputGuard(out_dir, limits))
        return _read_outcome(process, result_path, out_dir=out_dir, pid=pid,
                             limits=limits)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def run_compare(old_dir, new_dir, *, pid, limits=DEFAULT_LIMITS, out_dir=None,
                view=None):
    """Compare two published revisions in a process of its own.

    Smaller than `run_build`: the child is this repository's own module, it
    reads directories this hub's builds wrote and writes only where the caller
    said, so there is no output guard, result file or forgery check.

    The child's log is the answer (what `hammerola diff --material` reads).
    With `out_dir` and `view` (together or refused) it also leaves
    `scene.json` and `report.json` there for the caller to publish into the
    comparison cache; the parent only checks they exist and reports them in
    `BuildOutcome.files`.

    It is a separate process because importing the kernel costs hundreds of
    megabytes resident, which the hub must not pay.
    """
    if (out_dir is None) != (view is None):
        # The caller is `jobs.compare_arguments`, so this is a programming
        # error; the child would refuse the invocation and the job would report
        # a crash instead of the mistake.
        raise ValueError("run_compare takes an output directory and a view "
                         "together, or neither")
    old_dir = Path(old_dir).resolve()
    new_dir = Path(new_dir).resolve()
    out_dir = None if out_dir is None else Path(out_dir).resolve()

    # HOME and TMPDIR point here, as on the build path: the kernel and
    # matplotlib write caches. 0700, removed afterwards.
    scratch = Path(tempfile.mkdtemp(prefix="hammerola-compare-"))
    try:
        home = scratch / "home"
        tmp = scratch / "tmp"
        for directory in (home, tmp):
            directory.mkdir(mode=0o700)

        target = [
            sys.executable, "-s", "-m", "src.buildproc.comparechild",
            "--old-dir", str(old_dir),
            "--new-dir", str(new_dir),
            "--occt-threads", str(limits.occt_threads),
        ]
        if out_dir is not None:
            # Appended only when there is an artefact to write: the absence of
            # the pair is the plain `hammerola diff` mode.
            target += ["--out-dir", str(out_dir), "--view", str(view)]
        process = run_isolated(
            target, limits=limits,
            env=child_environment(home=home, tmp=tmp,
                                  threads=limits.occt_threads),
            guard=None)
        return _compare_outcome(process, pid=pid, out_dir=out_dir)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def run_isolated(target_argv, *, limits, env, cwd=None, guard=None):
    """Run `target_argv` behind the wrapper, under `limits`, and capture it.

    The target is composed by the caller and is never request data (see
    wrapper.py). `env` is the child's complete environment, passed untouched.

    `guard`, when given, is called on the wait loop's polls and returns a
    one-line complaint to stop the process early, or None. It rides on the
    existing loop rather than a thread; `_OutputGuard` rate-limits itself.
    """
    argv = [
        sys.executable, "-s", "-m", "src.buildproc.wrapper",
        json.dumps(limits.rlimit_spec()), "--", *target_argv,
    ]
    started = time.monotonic()
    process = subprocess.Popen(
        argv,
        cwd=str(cwd or HUB_ROOT),
        env=dict(env),
        # No terminal and no input. A model that reads stdin gets EOF instead of
        # blocking on a socket the hub is holding.
        stdin=subprocess.DEVNULL,
        # One stream, so a traceback stays in place relative to the progress
        # lines. Nobody parses it; it is the log handed back to the pusher.
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        # A session of its own makes this pid a process group leader, so
        # `killpg` reaches what the model spawned in the ordinary way (not a
        # descendant that called `setsid()`, see the module docstring).
        start_new_session=True,
        # The default, restated: the hub holds listening sockets, a data volume
        # and descriptors that a build must not inherit.
        close_fds=True,
    )

    drain = _Drain(process.stdout, limits.log_bytes)
    reader = threading.Thread(target=drain.run, name="buildproc-log", daemon=True)
    reader.start()

    # The ceiling that catches a hang burning no CPU (deadlock, sleep, a socket
    # that never answers), which RLIMIT_CPU cannot see.
    state, complaint = _wait_without_reaping(
        process.pid, time.monotonic() + limits.wall_seconds, guard=guard)
    timed_out = state == _WAIT_DEADLINE

    # Unconditional, on the clean path too: anything the model left running
    # holds the write end of the pipe and would make the drain wait
    # DRAIN_GRACE_SECONDS.
    #
    # Except when the pid is no longer ours: `_WAIT_UNOBSERVABLE` usually means
    # ECHILD (already reaped), so the pid and group id may be reused and a
    # `killpg` could hit a stranger's group. `Popen.kill` signals one pid and
    # refuses once subprocess has a return code.
    group_is_ours = state != _WAIT_UNOBSERVABLE
    if group_is_ours:
        _kill_group(process)
    else:
        _kill_process_only(process)
    # Bounded on both paths: an unbounded `wait()` would lose a thread forever
    # if `_wait_without_reaping` ever reported an exit that has not happened.
    _wait_after_kill(process, group_is_ours=group_is_ours)

    # The reader owns `process.stdout` and closes it (see `_Drain.run`). This
    # thread must not: `close()` on a buffered reader takes the lock `read1`
    # holds, so on the straggler path it would hang this thread.
    reader.join(timeout=DRAIN_GRACE_SECONDS)
    stragglers = reader.is_alive()

    log = drain.text()
    if stragglers:
        log += STRAGGLER_NOTE

    code = process.returncode
    return ProcessResult(
        exit_code=None if code is not None and code < 0 else code,
        signal=-code if code is not None and code < 0 else None,
        timed_out=timed_out,
        log=log,
        log_truncated=drain.dropped > 0,
        dropped_bytes=drain.dropped,
        duration_seconds=time.monotonic() - started,
        stragglers=stragglers,
        output_limit=complaint if state == _WAIT_GUARD else None,
    )


def child_environment(*, home, tmp, threads):
    """The child's whole environment, built key by key.

    An allowlist, not a filter: a filter must be extended whenever a variable is
    added to the compose file, and nothing fails when it is not. The hub holds
    EDIT_TOKEN (src/settings.py); nothing in it means anything to a build.
    """
    return {
        # Fixed, not inherited. Nothing in a build should be resolving a
        # command by name, and if something does it will find the system's.
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        # Into the scratch directory: matplotlib writes a font cache on first
        # use, into $HOME without MPLCONFIGDIR, and the real home is shared.
        #
        # A private cache per build costs a font-cache rebuild each time
        # (6.5 s CPU measured, 0.24 s warm), out of the CPU ceiling. The fix
        # belongs in the image (bake the cache, point MPLCONFIGDIR at a
        # read-only copy); a shared writable cache would let one build plant
        # files for the next.
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "XDG_CACHE_HOME": str(Path(home) / ".cache"),
        "MPLCONFIGDIR": str(Path(home) / "matplotlib"),
        # No display exists in the container, and the preview renderer draws
        # PNGs off-screen (src/cadbuild/preview_png.py).
        "MPLBACKEND": "Agg",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        # Unbuffered: the log of a killed build matters most, and buffered
        # output dies with the process.
        "PYTHONUNBUFFERED": "1",
        # No .pyc files in somebody else's tree: a stale one could run code
        # that is not in the source.
        "PYTHONDONTWRITEBYTECODE": "1",
        # Belt and braces with the `-s` on the command line.
        "PYTHONNOUSERSITE": "1",
        # Every numeric library that reads a thread count, held to the OCCT
        # pool size: RLIMIT_CPU sums threads, and numpy (imported by the
        # preview renderer) brings BLAS on every build.
        "OMP_NUM_THREADS": str(threads),
        "OPENBLAS_NUM_THREADS": str(threads),
        "MKL_NUM_THREADS": str(threads),
        "NUMEXPR_NUM_THREADS": str(threads),
        "VECLIB_MAXIMUM_THREADS": str(threads),
    }


def _read_outcome(process, result_path, *, out_dir, pid, limits):
    """Read a `ProcessResult` as a build.

    Success is a result file whose every claim checked out, not the exit code
    and not the file's existence: the model can produce both from inside the
    build process (read `--result` from `sys.argv`, write `{"files": [...]}`,
    `os._exit(0)`).
    """
    log = process.log
    status = STATUS_CRASHED
    files = ()

    if process.output_limit is not None:
        # Checked first: the guard's kill is a SIGKILL like any other and would
        # otherwise read as STATUS_KILLED, losing the reason.
        status = STATUS_OUTPUT_LIMIT
        log += f"\nbuildproc: {process.output_limit}\n"
    elif process.timed_out:
        status = STATUS_TIMEOUT
    elif process.signal is not None:
        # SIGXCPU is RLIMIT_CPU. With soft == hard Linux follows it with SIGKILL
        # at once, so it can also arrive as signal 9; `timed_out` is checked
        # first because it is the only way to tell the parent's SIGKILL apart.
        xcpu = getattr(signal, "SIGXCPU", None)
        status = (STATUS_CPU_EXHAUSTED
                  if xcpu is not None and process.signal == int(xcpu)
                  else STATUS_KILLED)
    elif process.exit_code == EXIT_OK:
        claimed = _read_result_file(result_path)
        overflow = _measure_output(out_dir, limits)
        if claimed is None:
            # A clean exit with nothing to show, usually a model that ended
            # the interpreter itself (`os._exit(0)` during import); the zero
            # is not evidence.
            status = STATUS_CRASHED
            log += ("\nbuildproc: the build exited 0 but wrote no readable "
                    "result, so nothing was built\n")
        elif overflow is not None:
            # The authoritative measurement, once the writer is gone: the wait
            # loop's guard stops the volume filling, this makes sure nothing
            # over the ceiling is published even if written between two polls.
            status = STATUS_OUTPUT_LIMIT
            log += f"\nbuildproc: {overflow}\n"
        else:
            names, complaint = _verified_files(claimed["files"], out_dir, limits)
            if complaint is not None:
                status = STATUS_BAD_RESULT
                log += (f"\nbuildproc: the build claimed a result the hub "
                        f"cannot confirm: {complaint}\n")
            else:
                status = STATUS_OK
                files = names
    elif process.exit_code == EXIT_BUILD_FAILED:
        status = STATUS_FAILED
    elif process.exit_code == EXIT_HANG_DUMP:
        status = STATUS_HANG
    elif process.exit_code in WRAPPER_EXIT_CODES or process.exit_code == EXIT_UNCAPPED:
        status = STATUS_LIMITS_ERROR
    elif process.exit_code in (EXIT_CRASHED, EXIT_INVOCATION):
        status = STATUS_CRASHED

    return BuildOutcome(
        status=status,
        # The hub's, always: "which project" is a question about the push.
        pid=pid,
        files=files,
        log=log,
        log_truncated=process.log_truncated,
        exit_code=process.exit_code,
        signal=process.signal,
        duration_seconds=process.duration_seconds,
    )


def _compare_outcome(process, *, pid, out_dir=None):
    """Read a `ProcessResult` as a comparison.

    The exit code is the verdict: the child is our own module, so there is no
    claim to check. The parent only checks that a requested artefact arrived;
    a clean exit without `scene.json` is a hub bug, and publishing it would put
    an empty cache entry at a URL that 404s. The files' content is not read.

    No `EXIT_HANG_DUMP` branch: `run_compare` passes no `--hang-dump-seconds`
    and `comparechild` arms no watchdog, so exit 1 here is the interpreter's
    own and is a crash. A comparison wedged in the kernel is caught by the
    wall deadline as `timeout`.
    """
    log = process.log
    files = ()
    status = STATUS_CRASHED
    if process.timed_out:
        status = STATUS_TIMEOUT
    elif process.signal is not None:
        xcpu = getattr(signal, "SIGXCPU", None)
        status = (STATUS_CPU_EXHAUSTED
                  if xcpu is not None and process.signal == int(xcpu)
                  else STATUS_KILLED)
    elif process.exit_code == EXIT_OK:
        status = STATUS_OK
    elif process.exit_code in WRAPPER_EXIT_CODES or process.exit_code == EXIT_UNCAPPED:
        status = STATUS_LIMITS_ERROR

    if status == STATUS_OK and out_dir is not None:
        missing = [name for name in _COMPARE_ARTEFACTS
                   if not (out_dir / name).is_file()]
        if missing:
            status = STATUS_CRASHED
            log += (f"\nbuildproc: the comparison exited 0 without writing "
                    f"{', '.join(missing)}, so there is nothing to publish\n")
        else:
            files = _COMPARE_ARTEFACTS

    return BuildOutcome(
        status=status,
        pid=pid,
        files=files,
        log=log,
        log_truncated=process.log_truncated,
        exit_code=process.exit_code,
        signal=process.signal,
        duration_seconds=process.duration_seconds,
    )


def _read_result_file(path):
    """The result, or None if it is missing, unreadable or not what we asked for.

    Exactly `{"files": [...]}`: the only honest writer is child.py, and a strict
    shape keeps a forged result from smuggling extra fields past a reader.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or set(data) != {"files"}:
        return None
    if not isinstance(data["files"], list):
        return None
    return data


def _verified_files(claimed, out_dir, limits):
    """Check every name the build claimed. Returns (names, complaint).

    Each name must:

      * not escape `out_dir` (`../../builds/someone-else/meta.json`,
        `/etc/passwd`);
      * have no symlink component, checked with `lstat` on the way down:
        `resolve()` follows links, so a link pointing back inside out_dir would
        pass a containment test while still being a link the hub serves;
      * exist and be a regular file (a missing name means 404s for a
        "complete" build; a fifo is a read that never returns);
      * and the list may not exceed what one build may write.

    Content is judged by the gate (step 6), not here.
    """
    if not claimed:
        return (), "it reported no files at all, so nothing was built"
    if limits.output_files is not None and len(claimed) > limits.output_files:
        return (), (f"it reported {len(claimed)} files, over the "
                    f"{limits.output_files} one build may write")

    names = []
    for name in claimed:
        complaint = _verify_output_file(name, out_dir)
        if complaint is not None:
            return (), complaint
        names.append(name)
    return tuple(names), None


def _verify_output_file(name, out_dir):
    """One claimed name against the filesystem. A complaint, or None."""
    if not isinstance(name, str) or not name or "\x00" in name:
        return f"{name!r} is not a usable file name"
    candidate = Path(name)
    if candidate.is_absolute():
        return f"{name!r} is an absolute path, not a name under the build"
    if str(candidate) != name:
        # `./meta.json`, `sub//part.stl`, `sub/` would pass the checks below
        # under a string the hub would not serve the file as. The normal form
        # keeps one name per file.
        return (f"{name!r} is not written in its normal form "
                f"({str(candidate)!r})")

    walked = out_dir
    info = None
    for part in candidate.parts:
        if part in ("..", "."):
            return f"{name!r} does not stay inside the build directory"
        walked = walked / part
        try:
            info = os.lstat(walked)
        except OSError as exc:
            return f"{name!r} was reported but is not there ({exc.strerror})"
        if stat.S_ISLNK(info.st_mode):
            return f"{name!r} goes through a symlink at {part!r}"
    if info is None or not stat.S_ISREG(info.st_mode):
        return f"{name!r} is not a regular file"

        # Redundant with the loop above by design: it still refuses if one of
        # those checks is ever weakened.
    resolved = Path(os.path.realpath(walked))
    if resolved != walked or out_dir not in resolved.parents:
        return f"{name!r} resolves to {resolved}, outside the build directory"
    return None


def _measure_output(out_dir, limits):
    """Walk `out_dir` and complain if it is over a ceiling. None if it is not.

    Stops at the first crossing: the answer is yes/no, and cheapness matters
    most when the tree is enormous. Symlinks are never followed (a link into
    the data volume cannot make this walk other builds), and `lstat` charges
    the link itself.
    """
    max_files = limits.output_files
    max_bytes = limits.output_bytes
    if max_files is None and max_bytes is None:
        return None

    entries = 0
    total = 0
    stack = [out_dir]
    while stack:
        try:
            scan = os.scandir(stack.pop())
        except OSError:
            # Not there yet, or gone; a missing output directory is
            # `_verified_files`' complaint to make.
            continue
        with scan:
            for entry in scan:
                entries += 1
                if max_files is not None and entries > max_files:
                    return (f"the build wrote more than {max_files} files into "
                            f"its output directory, which is what one build may "
                            f"write in total")
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(info.st_mode):
                    stack.append(Path(entry.path))
                    continue
                total += info.st_size
                if max_bytes is not None and total > max_bytes:
                    return (f"the build wrote more than {max_bytes} bytes into "
                            f"its output directory, which is what one build may "
                            f"write in total")
    return None


class _OutputGuard:
    """`_measure_output`, rate-limited, shaped as the wait loop's `guard`.

    The post-exit check decides what gets published, but by then the bytes are
    on the volume, and a full volume is a hub that cannot serve, outlasting the
    build. So the ceiling must be able to stop the writer while it writes.
    """

    def __init__(self, out_dir, limits, interval=None):
        self._out_dir = out_dir
        self._limits = limits
        # Not a default argument, so tests can change the module constant.
        self._interval = OUTPUT_POLL_SECONDS if interval is None else interval
        self._next_check = time.monotonic() + self._interval

    def __call__(self):
        now = time.monotonic()
        if now < self._next_check:
            return None
        self._next_check = now + self._interval
        return _measure_output(self._out_dir, self._limits)


def _wait_without_reaping(pid, deadline, guard=None):
    """Wait for the process to exit, but leave the zombie.

    Returns `(state, complaint)`, where state is one of the `_WAIT_*` constants
    above and the complaint is the guard's, or None.

    `Popen.wait(timeout=...)` reaps: once it returns the pid, which is also the
    process group id (`start_new_session`), is free for reuse, so the `killpg`
    that follows could hit someone else's group. `waitid` with WNOWAIT reports
    the exit and leaves a zombie holding the pid; `Popen.wait()` collects it
    after the kill.

    ECHILD is its own answer (`_WAIT_UNOBSERVABLE`): the process is no longer
    our child, no zombie holds the pid, and the caller must not `killpg`.

    POSIX `waitid` has no timeout, hence the polling (as `Popen.wait` does
    internally); the backoff keeps a long build from costing thousands of
    syscalls.
    """
    delay = 0.001
    while True:
        try:
            info = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT | os.WNOHANG)
        except ChildProcessError:
            return _WAIT_UNOBSERVABLE, None   # not ours any more; pid may be reused
        except OSError:
            return _WAIT_UNOBSERVABLE, None   # cannot be asked -- same conclusion
        if info is not None:
            return _WAIT_EXITED, None
        if guard is not None:
            complaint = guard()
            if complaint is not None:
                return _WAIT_GUARD, complaint
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return _WAIT_DEADLINE, None
        time.sleep(min(delay, remaining))
        delay = min(delay * 1.5, 0.05)


def _kill_group(process):
    """SIGKILL the whole process group, not just the process we started.

    A model that spawns a helper, mesher or shell would otherwise leave it on
    the host holding memory and our pipe. `start_new_session=True` makes the
    group and makes its id equal to this pid.

    It does not reach a descendant that called `setsid()` itself (see the
    module docstring); that shows up as `ProcessResult.stragglers`.

    Only called while the pid is still ours; the caller checks that (see
    `_WAIT_UNOBSERVABLE`), this function cannot.

    SIGKILL with nothing before it: the process is untrusted or wedged in a
    native call, and a catchable signal can be ignored.
    """
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # Gone already, or never became a group leader. Either way the process
        # itself is still ours to end.
        _kill_process_only(process)
    except OSError:
        pass


def _kill_process_only(process):
    """SIGKILL the one process, never the group.

    The fallback for a pid we can no longer vouch for. `Popen.kill` rather than
    `os.kill`: subprocess refuses to signal a pid it already collected.
    """
    try:
        process.kill()
    except OSError:
        pass


def _wait_after_kill(process, *, group_is_ours=True):
    """Reap the killed process, and give up rather than block a request thread.

    A pid that was not ours for the first kill is not `killpg`'d on the second.
    """
    kill = _kill_group if group_is_ours else _kill_process_only
    for _attempt in range(2):
        try:
            process.wait(timeout=KILL_GRACE_SECONDS)
            return True
        except subprocess.TimeoutExpired:
            kill(process)
    return False


class _Drain:
    """Read a pipe to EOF, keep the first `cap` bytes, count the rest.

    Keeping a cap stops a looping `print` from exhausting the hub's memory.
    Reading to EOF anyway stops the writer stalling on a full pipe, which would
    look like a hang and be reported as a timeout.

    The head is kept rather than the tail: it says what the build was doing
    when the flood started. A build that floods and then hangs loses its stack
    (counted in `dropped_bytes`).

    It owns the stream and closes it in a `finally`: the parent cannot, since
    `close()` on a buffered reader waits for the lock `read1` holds and would
    hang on a straggler's pipe. The close happens at EOF, or when the
    straggler dies.
    """

    def __init__(self, stream, cap):
        self._stream = stream
        self._cap = cap
        self._kept = bytearray()
        self.dropped = 0

    def run(self):
        try:
            while True:
                try:
                    chunk = self._stream.read1(65536)
                except (OSError, ValueError):
                    # The pipe went away (process killed or file closed).
                    return
                if not chunk:
                    return
                room = self._cap - len(self._kept)
                if room > 0:
                    self._kept += chunk[:room]
                self.dropped += max(0, len(chunk) - max(room, 0))
        finally:
            try:
                self._stream.close()
            except (OSError, ValueError):
                pass

    def text(self):
        # `replace`: the cap can split a UTF-8 sequence and a model may print
        # non-text bytes. The log is read by a person, never round-tripped.
        return bytes(self._kept).decode("utf-8", errors="replace")
