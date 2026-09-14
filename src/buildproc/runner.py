#!/usr/bin/env python3
"""The parent half: start the build somewhere else, and be able to end it.

`run_isolated` is the machinery -- one process, ceilings on it, a wall-clock
deadline, its output captured with a lid on it. `run_build` is that machinery
pointed at `src.buildproc.child`, which is the only target the hub ever uses.
The split is not decoration: everything that can go wrong with a hostile
process (it hangs, it burns CPU, it prints for ever, it spawns something that
outlives it, it reads the environment for a token) is a property of the
machinery and is tested against small programs that do exactly one of those
things, on a python with no CAD stack in it.

CALLED FROM A BUILD WORKER, never from a request thread (SPEC 8A.2 step 5):
`src/jobs.py` owns the queue and the pool, and everything here happens on one of
its threads. The gate fires on this side -- step 6, closed: `src/jobs.py`
publishes only `if outcome.ok`, and a refused build leaves `latest` and `dev`
where they were.

WHAT "SPAWN, NOT FORK" MEANS HERE, since `subprocess` does technically fork.
The prohibition is on a child that CONTINUES AS A COPY of this interpreter --
`multiprocessing` with the fork start method, or a bare `os.fork()`. OCCT's
thread pool does not survive that: the threads do not come across, their locks
do, and the first parallel operation in the child deadlocks. `subprocess` forks
and immediately execs, so the copy never runs a line of Python; what comes out
the other side is a fresh interpreter with a clean `sys.modules`, no inherited
locks and no thread pool. `test_isolation.py` pins that empirically rather than
by reading this paragraph.

For the same reason there is no `preexec_fn` anywhere in this file. See
limits.py -- the hub is multi-threaded, and the window between fork and exec is
the one place a threaded program may not run interpreter code. `start_new_session`
does the one thing that IS needed in that window, and `subprocess` performs it
in C with a single async-signal-safe `setsid()`.

WHAT THE PROCESS GROUP DOES AND DOES NOT COVER, because the difference is a real
hole and not a caveat. `start_new_session=True` plus `killpg` reaches everything
the build spawned that STAYED IN THE GROUP, which is everything spawned in the
ordinary way. It does not reach a descendant that called `setsid()` itself: that
process is in a group of its own, by number, and there is no way to enumerate
"the groups this build created" -- the kernel keeps no such list, and walking
/proc for descendants loses the race against a reparented orphan anyway. Such a
straggler survives the kill, keeps its inherited copy of the output pipe open,
and therefore costs the hub DRAIN_GRACE_SECONDS of waiting plus one thread and
one descriptor for as long as it lives. `ProcessResult.stragglers` says it
happened and the build log carries a line saying so, because the alternative is
a leak nobody can see. The real fix is the container's `pids` limit and a
supervisor that reaps, which is SPEC 8A.2 step 0 and not this file's to make.
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
# `src.safeio` and NOT `src.store`: it imports nothing of its own, which is what
# lets the build half of this package read a file the same way the hub does
# without pulling the hub in behind it.
from src.safeio import read_regular_text


# The repository root: src/buildproc/runner.py -> src/buildproc -> src -> here.
# It is the working directory every isolated process is started in, which is
# what makes `-m src.buildproc.*` resolve -- and what keeps it resolving to THIS
# tree rather than to an uploaded one that happens to carry a `src/`.
HUB_ROOT = Path(__file__).resolve().parents[2]

# How long to wait for a process to be gone after SIGKILL. Only an
# uninterruptible kernel call can stretch this, and if one does, waiting longer
# does not help -- the parent gives up and says so rather than blocking the
# thread that is handling somebody's request.
KILL_GRACE_SECONDS = 5.0
# How long to wait for the output reader after the process is gone. Reaching it
# means something is still holding the write end of the pipe after the whole
# process group was killed -- see the module docstring on `setsid`.
DRAIN_GRACE_SECONDS = 5.0
# How often the output directory is measured WHILE the build runs. The wait loop
# below polls far more often than this near the end of its backoff, and each
# measurement walks a directory, so the guard rate-limits itself: 0.5 s is short
# enough that a writer has to sustain a gigabyte a second to cross the ceiling
# unseen, and long enough that measuring costs nothing next to the build.
OUTPUT_POLL_SECONDS = 0.5

# --- how `_wait_without_reaping` ended --------------------------------------
# Kept apart from each other because the KILL that follows differs, and getting
# that wrong is a SIGKILL sent to a stranger's process group: see `_kill_group`.
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

# What a comparison asked for an artefact has to leave behind, and the only
# thing this side of it ever looks at. SPELLED AGAIN rather than imported from
# `comparechild`, which is the module that writes them: importing that module
# here would put `src.cadbuild` into the HUB's process, and nothing on the
# serving side may import the build half (src/cadbuild/__init__.py says why).
# `tests/test_compare.py` holds this equal to `comparechild.ARTEFACTS` and to
# `store.COMPARE_FILES`.
_COMPARE_ARTEFACTS = ("scene.json", "report.json")

# Appended to the log of a build that left a straggler behind. In the log rather
# than only in a field, because a field nobody reads is a leak nobody sees --
# and this one costs the hub a thread and a descriptor until that process dies.
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

    `pid` and `files` are the PARENT's answers and not the child's. The child
    process runs the model and the model can write anything it likes into the
    result file (see child.py), so the project id comes from the push the hub
    accepted and every file name was checked against the output directory before
    it appeared here.
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

    `project_dir` is an UNTRUSTED tree -- someone pushed it and the hub
    unpacked it (SPEC 8A.2 step 2). It contributes a path to this call and
    nothing else: the interpreter, the module that runs and every ceiling it
    runs under are literals in this repository.

    `pid` is the project id of the push the hub ACCEPTED, and it is a parameter
    rather than something read back out of the build because it decides which
    project's `latest` a successful build replaces. The build process cannot be
    allowed to name it: the model runs in that process, so a pid taken from
    anything the child wrote is a pid the model chose, and a model that chose
    somebody else's would publish itself over their project. The tree's own
    project.json is read by the build (it is what `meta.json` ends up saying)
    and disagreement between the two is the gate's business, in step 6 -- this
    function's business is that the disagreement cannot be silent.

    `force` is the push asking for the MODEL's own checks() not to be run
    (issue #52). Those are the author's, so they are the author's to waive; the
    hub's own gates are not, and every one of them runs on a forced build.

    `baseline` is the `dev` slot's metrics.json, which the build prints what
    moved against. It is COPIED into the scratch directory below rather than
    named where it lies, and the copy is what the child is told about.
    """
    project_dir = Path(project_dir).resolve()
    out_dir = Path(out_dir).resolve()

    # The scratch directory is the parent's, not the model's: HOME, TMPDIR and
    # the matplotlib cache point into it, so the build cannot write into the
    # real home of the `app` user -- where, on a bad day, a `.pth` file would
    # be executed by the next interpreter to start (SPEC 8A.3). It also holds
    # the result file, and it is 0700 and removed when the build is over.
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
            # Spelled out on every invocation rather than appended only when it
            # is true: the child takes `--key value` pairs and no bare flags, so
            # the value is where the boolean lives either way, and a build that
            # ran the checks says so in its own command line.
            "--force", "true" if force else "false",
        ]
        if limits.hang_dump_seconds is not None:
            target += ["--hang-dump-seconds", str(limits.hang_dump_seconds)]
        # A COPY, AND THE ORDER OF THESE LINES IS THE CORRECTNESS. It is taken
        # here, in the parent and before the child starts, so a `dev` build is
        # compared against the PREVIOUS `dev` rather than against itself: the
        # publish that overwrites the slot happens after this call returns
        # (`jobs._build_and_publish`). Copying also settles the other race --
        # `store._swap_dev_slot` is a pair of renames, so a parallel build of
        # the same project can replace the slot halfway through this one and a
        # path held into the store would then be read as something third.
        #
        # Scratch is the channel: it is the parent's directory, the one
        # `result.json` already travels in, and it is the only way this side
        # hands the child a file.
        #
        # A COPY THAT WILL NOT BE MADE COSTS THE COMPARISON AND NOT THE BUILD.
        # The child is then started without `--baseline`, which is the ordinary
        # "nothing to compare against" branch, and the build publishes as it
        # otherwise would.
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

    The sibling of `run_build` and much smaller, because everything that makes
    the build path careful is about a process running SOMEBODY ELSE'S code. None
    of that applies here: the child is this repository's own module, the two
    directories it reads were written by this hub's own builds, and what it
    writes -- when it writes anything at all -- goes into a directory the caller
    named. So there is no output guard, no result file, and nothing to check for
    forgery.

    THE CHILD'S LOG IS ALWAYS THE ANSWER: the report it prints is what a person
    reads back through the job log, and `hammerola diff --material` asks for
    nothing else. Called with `out_dir` and `view` -- together, or the call is
    refused -- the same run also leaves `scene.json` and `report.json` in that
    directory, which the caller then publishes into the comparison cache. The
    PARENT's only question about those two is whether they are there: it is the
    difference between a job that has something to publish and one that does
    not, and `BuildOutcome.files` reports it the way the build path does.

    The kernel is what makes this a separate process at all: importing it costs
    ~450 MB resident, and the hub is the process that must not pay that.
    """
    if (out_dir is None) != (view is None):
        # The caller is `jobs.compare_arguments`, so this is a programming error
        # and not a request: one without the other would start a child that
        # refuses the invocation, and the job would report a crash instead of
        # the mistake.
        raise ValueError("run_compare takes an output directory and a view "
                         "together, or neither")
    old_dir = Path(old_dir).resolve()
    new_dir = Path(new_dir).resolve()
    out_dir = None if out_dir is None else Path(out_dir).resolve()

    # HOME and TMPDIR point in here for the reason the build path gives: the
    # kernel and matplotlib write caches, and they may not land in the real home
    # of the `app` account. 0700, and gone when the comparison is over.
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
            # Appended only when there is an artefact to write, unlike the
            # build path's `--force`: here the ABSENCE of the pair is a mode of
            # its own, and one this route takes on every `hammerola diff`.
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

    The target is composed by the CALLER and is never request data -- see
    wrapper.py. `env` is the complete environment of the child: this function
    passes it through untouched and adds nothing, so whatever `child_environment`
    left out is genuinely absent.

    `guard`, when given, is called on the wait loop's own polls and returns a
    one-line complaint to stop the process early, or None to let it run. It
    rides on the loop that is already polling rather than on a thread of its own
    -- `_OutputGuard` is the only one today and it measures a directory, which
    is exactly the kind of work that must not happen twenty times a second.
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
        # One stream, so a traceback stays in the right place relative to the
        # progress lines a build prints. Nobody parses this text -- it is the
        # log handed back to whoever pushed.
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        # A session of its own, which makes this pid a process GROUP leader:
        # `killpg` then reaches what the model spawned in the ordinary way,
        # rather than only the process the hub started. NOT a descendant that
        # called `setsid()` itself -- see the module docstring. Performed by
        # subprocess in C between fork and exec, which is why nothing else may
        # run there.
        start_new_session=True,
        # The default, restated because it is load-bearing: the hub holds
        # listening sockets, a data volume and file descriptors that have
        # nothing to do with a build.
        close_fds=True,
    )

    drain = _Drain(process.stdout, limits.log_bytes)
    reader = threading.Thread(target=drain.run, name="buildproc-log", daemon=True)
    reader.start()

    # THE ceiling that catches a hang burning no CPU: a deadlocked thread pool,
    # a sleep, a socket that never answers. RLIMIT_CPU cannot see any of those
    # -- it counts processor time, and there is none being spent.
    state, complaint = _wait_without_reaping(
        process.pid, time.monotonic() + limits.wall_seconds, guard=guard)
    timed_out = state == _WAIT_DEADLINE

    # Unconditional, and on the clean path too: the model may have left
    # something running, and anything it left is holding the write end of this
    # pipe. Killing the group here is also what keeps a background process from
    # making every later build wait DRAIN_GRACE_SECONDS for an EOF that is
    # never coming.
    #
    # ...except on the one path where the pid is no longer ours to vouch for.
    # `_WAIT_UNOBSERVABLE` means `waitid` refused to tell us anything, and the
    # ordinary cause of that is ECHILD -- somebody else already reaped this
    # child, so its pid, and therefore its process GROUP id, is free for the
    # kernel to hand out again. A `killpg` there is a SIGKILL to whatever group
    # now carries that number, which is precisely what `_wait_without_reaping`
    # exists to prevent. `Popen.kill` is the most that may be done: it is one
    # pid rather than a group, and `subprocess` will not send it once it has a
    # return code of its own.
    group_is_ours = state != _WAIT_UNOBSERVABLE
    if group_is_ours:
        _kill_group(process)
    else:
        _kill_process_only(process)
    # Bounded on BOTH paths, including the one where the process is already a
    # zombie and this returns at once. An unbounded `wait()` here would be a
    # request thread lost for ever on the day `_wait_without_reaping` reports an
    # exit that has not happened -- and this component exists to make sure no
    # part of a build can do that to the hub.
    _wait_after_kill(process, group_is_ours=group_is_ours)

    # The reader owns `process.stdout` and closes it itself (see `_Drain.run`).
    # This thread must not: a `close()` on a buffered reader takes the same lock
    # `read1` is holding, so closing it here on the straggler path -- the one
    # path where the reader is still blocked -- would hang the hub's request
    # thread on a descriptor instead of leaking it. Handing ownership to the
    # reader is what makes "closed in every case" true: on the ordinary path it
    # happens at EOF, and on the straggler path it happens whenever the process
    # holding the write end finally dies.
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
    """The child's WHOLE environment, built key by key.

    An allowlist and not a filter, and the difference is the point. A filter --
    "os.environ minus the names we consider secret" -- is a list somebody has
    to remember to extend: the day a variable is added to the compose file, it
    is in the build's environment, and nothing anywhere fails. The hub holds
    EDIT_TOKEN today (src/settings.py) and may hold more; none of them means
    anything to a build, so the build is handed a dictionary that was empty a
    moment ago.
    """
    return {
        # Fixed, not inherited. Nothing in a build should be resolving a
        # command by name, and if something does it will find the system's.
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        # Into the scratch directory, all of it. matplotlib writes a font cache
        # on first use, and without MPLCONFIGDIR it writes into $HOME -- which
        # would otherwise be the `app` user's real home, shared by every build
        # and read by the next interpreter to start.
        #
        # A private cache directory per build has a MEASURED price: matplotlib
        # rebuilds its font cache every time, 6.5 s of CPU on this workstation
        # (0.24 s once it is warm). That is paid out of the CPU ceiling, and the
        # fix belongs in the image rather than here -- bake the cache at build
        # time and point MPLCONFIGDIR at a read-only copy of it. Sharing a
        # WRITABLE one between builds is the wrong economy: it is a directory
        # untrusted code can put files in, read back by the next build.
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
        # Unbuffered, because the log of a build that gets KILLED is the log
        # that matters most -- buffered output dies with the process.
        "PYTHONUNBUFFERED": "1",
        # Do not write .pyc files into somebody else's tree: it is not ours to
        # modify, and a stale one from a previous push of the same project
        # would be a build running code that is not in the source.
        "PYTHONDONTWRITEBYTECODE": "1",
        # Belt and braces with the `-s` on the command line.
        "PYTHONNOUSERSITE": "1",
        # Every numeric library that reads a thread count, held to the same
        # number as the OCCT pool. RLIMIT_CPU is summed over threads, so a
        # library quietly taking a core each is a CPU ceiling that fires early
        # for no visible reason -- and BLAS is imported by numpy, which the
        # preview renderer imports, on every build.
        "OMP_NUM_THREADS": str(threads),
        "OPENBLAS_NUM_THREADS": str(threads),
        "MKL_NUM_THREADS": str(threads),
        "NUMEXPR_NUM_THREADS": str(threads),
        "VECLIB_MAXIMUM_THREADS": str(threads),
    }


def _read_outcome(process, result_path, *, out_dir, pid, limits):
    """Read a `ProcessResult` as a build.

    Success is a result file whose every claim CHECKED OUT -- not the exit code,
    and not the mere existence of the file either. Both of those are things the
    model can produce on its own from inside the build process, and the second
    one was reproduced rather than imagined: read `--result` out of `sys.argv`,
    write `{"files": [...]}`, `os._exit(0)`, and a parent that trusted the file
    reported a finished build for a staging directory that was never created.
    """
    log = process.log
    status = STATUS_CRASHED
    files = ()

    if process.output_limit is not None:
        # Checked before everything else: the guard's kill arrives as a SIGKILL
        # like any other, so read in the wrong order it would come out as
        # STATUS_KILLED and the reason -- the one thing that says what the build
        # did wrong -- would appear nowhere.
        status = STATUS_OUTPUT_LIMIT
        log += f"\nbuildproc: {process.output_limit}\n"
    elif process.timed_out:
        status = STATUS_TIMEOUT
    elif process.signal is not None:
        # SIGXCPU is RLIMIT_CPU announcing itself. On Linux soft == hard means
        # the kernel follows it with SIGKILL immediately, so this can also
        # arrive as signal 9 -- which is why `timed_out` above is checked
        # first: it is the only way to tell the parent's SIGKILL from anyone
        # else's.
        xcpu = getattr(signal, "SIGXCPU", None)
        status = (STATUS_CPU_EXHAUSTED
                  if xcpu is not None and process.signal == int(xcpu)
                  else STATUS_KILLED)
    elif process.exit_code == EXIT_OK:
        claimed = _read_result_file(result_path)
        overflow = _measure_output(out_dir, limits)
        if claimed is None:
            # A clean exit with nothing to show for it. The ordinary cause is a
            # model that ended the interpreter itself -- `os._exit(0)` from its
            # import runs before `build()` is ever called -- and the zero it
            # chose is not evidence of anything.
            status = STATUS_CRASHED
            log += ("\nbuildproc: the build exited 0 but wrote no readable "
                    "result, so nothing was built\n")
        elif overflow is not None:
            # The authoritative measurement, taken once the writer is gone. The
            # guard on the wait loop is what stops the volume filling; this is
            # what makes sure nothing over the ceiling is ever PUBLISHED, and it
            # is the half that cannot be outrun by a build that writes it all
            # between two polls.
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
        # The hub's, always -- including on the paths where there is no result
        # at all, because "which project was this" is a question about the push
        # and not about how the build went.
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

    The exit code IS the verdict here, which it deliberately is not on the build
    path: the child is our own module rather than somebody's model, so there is
    no claim to check and no forgery to be worried about -- a comparison that
    ended cleanly printed its report, and one that did not says why in the log.

    THE ONE THING THE PARENT LOOKS AT ON DISK is whether an artefact it asked
    for arrived, and it is a question about this hub and not about the child's
    honesty: a clean exit with no `scene.json` beside it is a bug here, and
    publishing that directory would put an empty cache entry at a URL the
    browser then 404s on. Nothing about the CONTENT of the two files is read --
    that is the geometry half's business, on the other side of the rename.

    NO `EXIT_HANG_DUMP` BRANCH, and its absence is the point. `run_compare`
    passes no `--hang-dump-seconds` and `comparechild` arms no watchdog, so
    nothing on this path exits 1 on purpose; 1 here is the interpreter's own
    (the module would not import, `runpy` threw), which is a crash and is
    reported as one. Reading it as a hang would put back exactly the defect
    `child.py` records at length -- "THE HUB'S OWN BUG WAS THAT 1 MEANT TWO
    THINGS" -- with the pusher told a stack is in the log and no stack in it.
    A comparison that genuinely wedges in the kernel is still caught, by the
    wall deadline above: `timeout`, killed with its process group.
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

    EXACTLY `{"files": [...]}` and nothing else. Being strict about the shape
    costs nothing here -- the only honest writer of this file is child.py, forty
    lines away -- and it is what keeps a forged result from smuggling a field
    past a reader that only checked the ones it knew about.

    AND THE FILE ITSELF IS AS UNTRUSTED AS ITS CONTENTS. `--result` names a path
    the child is free to replace with a fifo -- one `os.mkfifo` in `model.py`,
    and the read below never returns while the parent has already reaped the
    process and is holding a build worker. `safeio` refuses it as an `OSError`,
    which is the arm this already had.
    """
    try:
        data = json.loads(read_regular_text(path))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or set(data) != {"files"}:
        return None
    if not isinstance(data["files"], list):
        return None
    return data


def _verified_files(claimed, out_dir, limits):
    """Check every name the build claimed. Returns (names, complaint).

    The parent's own answer to a question the child cannot be trusted with. Each
    name has to survive four things, and each one is a real attack rather than a
    tidy-up:

      * it must not escape `out_dir`. `../../builds/someone-else/meta.json` is a
        build publishing into another project, and `/etc/passwd` is worse.
      * no component may be a SYMLINK, checked with `lstat` on the way down
        rather than by resolving the path. `resolve()` follows links, so a link
        planted inside out_dir and pointing at one of the hub's own files
        resolves to a path OUTSIDE out_dir and is caught -- but a link pointing
        back INSIDE it resolves to a path that passes any containment test,
        while still being a link the hub then copies or serves.
      * it must exist, and be a regular file. A name for a file that was never
        written is a build the hub reports as complete and then serves 404s for;
        a fifo is a read that never returns.
      * there may not be more of them than one build may write at all.

    Nothing here judges the CONTENT -- that is the gate, in step 6. This is only
    the part where the hub stops repeating a claim it has not checked.
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
        # `./meta.json`, `sub//part.stl`, `sub/` -- all of them name a file the
        # checks below would then accept, under a string that is not the one the
        # hub would serve it as. Requiring the normal form keeps ONE name per
        # file: the alternative is a claim list where two entries are the same
        # file and a `latest` whose index disagrees with its own directory.
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

    # Belt and braces over the loop above: with no symlink in the chain and no
    # `..` in the name this can only agree with it, which is the point -- the
    # day one of those two checks is weakened, this is what still refuses.
    resolved = Path(os.path.realpath(walked))
    if resolved != walked or out_dir not in resolved.parents:
        return f"{name!r} resolves to {resolved}, outside the build directory"
    return None


def _measure_output(out_dir, limits):
    """Walk `out_dir` and complain if it is over a ceiling. None if it is not.

    Stops at the first crossing rather than measuring the whole tree: the answer
    is a yes/no, and the case worth being cheap in is exactly the one where the
    tree is enormous. Symlinks are never followed, so a link into the data
    volume cannot make this walk somebody else's builds -- and `lstat` is what
    charges the link itself rather than its target.
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
            # Not there yet, or gone. Either way there is nothing to measure --
            # a missing output directory is `_verified_files`' complaint to
            # make, and it makes a better one.
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

    WHY THIS RUNS DURING THE BUILD AND NOT ONLY AFTER IT. A check after the
    process is gone is the one that decides what gets published, and it is not
    enough on its own: by the time it runs, the bytes are already on the volume.
    A full volume is not a build that failed, it is a hub that cannot serve --
    reading is what it exists for -- and the damage outlasts the build that did
    it, unlike every other ceiling here. So the ceiling has to be able to stop
    the writer, and stopping the writer means measuring while it writes.
    """

    def __init__(self, out_dir, limits, interval=None):
        self._out_dir = out_dir
        self._limits = limits
        # Read here rather than taken as a default argument, which would freeze
        # the module constant at import time and make it unsettable from a test.
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

    `Popen.wait(timeout=...)` would be the obvious call and it is the wrong one
    here, for a reason that only shows up in the kill that comes next. `wait`
    REAPS: the moment it returns, the pid is free for the kernel to hand to
    something else -- and the pid IS the process group id (`start_new_session`
    above), so the `killpg` that follows would be aimed at a number that may no
    longer mean this build. The window is microseconds wide and the target is a
    SIGKILL to a whole process group of somebody else's, which is not a trade
    worth taking.

    `waitid` with WNOWAIT reports the exit and leaves the process a zombie, and
    a zombie holds its pid: the group id cannot be recycled while it exists, so
    the kill is aimed at this build for certain. `Popen.wait()` then collects it
    immediately afterwards.

    AND THAT IS WHY ECHILD IS ITS OWN ANSWER rather than folded into "it
    exited". `ChildProcessError` means this process is not our child any more --
    something already reaped it, or it never was ours -- so there is no zombie
    holding the pid and the whole argument above has stopped applying. Saying
    "exited" there and letting the caller `killpg` anyway would be the exact
    mistake the paragraph above is about, one branch further along: the number
    is free, the kernel may have handed it to somebody else, and the signal is a
    SIGKILL to every process in their group. `_WAIT_UNOBSERVABLE` is what the
    caller checks before choosing between `killpg` and a single `kill`.

    The polling is what `Popen.wait(timeout=...)` does internally anyway --
    there is no timeout in POSIX `waitid` -- and the backoff keeps a build that
    runs for two minutes from costing thousands of syscalls.
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

    A model that spawns anything in the ordinary way -- a helper, a mesher, a
    shell -- would otherwise leave it running on the host after its parent is
    gone, holding memory and the write end of our pipe. `start_new_session=True`
    in Popen is what makes the group exist and makes its id equal to this pid.

    It does NOT reach a descendant that called `setsid()` for itself; that one
    is in a group of its own and nothing here can name it. See the module
    docstring -- the survivor shows up as `ProcessResult.stragglers` and in the
    build log, which is all this component can honestly do about it.

    ONLY EVER CALLED WHILE THE PID IS STILL OURS. The caller checks that (see
    `_WAIT_UNOBSERVABLE` in `_wait_without_reaping`); this function cannot,
    because by the time it is asked the difference is invisible.

    SIGKILL rather than SIGTERM, with nothing polite before it: the process
    being killed is either untrusted or wedged inside a native call, and in
    both cases a signal it has to notice is a signal it can ignore.
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
    a bare `os.kill` on purpose: subprocess refuses to signal a pid it has
    already collected a return code for, which is one more check between us and
    a signal sent to a stranger.
    """
    try:
        process.kill()
    except OSError:
        pass


def _wait_after_kill(process, *, group_is_ours=True):
    """Reap the killed process, and give up rather than block a request thread.

    The second kill follows the first one's rule: a pid we could not vouch for
    when we chose `_kill_process_only` is not one we may `killpg` a moment later
    just because a timeout expired.
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

    Both halves matter. KEEPING a cap is what stops a model printing in a loop
    from being a memory ceiling the hub reaches instead of the model. Reading to
    EOF ANYWAY is what stops the same model from stalling on a full pipe: a
    process blocked writing consumes no CPU and looks exactly like a hang, so it
    would be reported as a timeout and the real reason -- that the parent
    stopped reading -- would appear nowhere.

    The head is kept rather than the tail because that is where a build says
    what it was doing when the flood started; the tail of a runaway `print` is
    the same line over and over. It costs the stack in the case where a build
    both floods the log and then hangs, which is noted in `dropped_bytes`.

    IT ALSO OWNS THE STREAM AND CLOSES IT -- in a `finally`, on every path out
    of `run`. That ownership is what makes the descriptor closed in every case
    rather than only on the happy one. The parent cannot do it: `close()` on a
    buffered reader waits for the same lock `read1` is holding, so a parent
    closing it while this thread is still blocked on a straggler's copy of the
    pipe would hang the hub's request thread rather than leak a descriptor --
    strictly the worse of the two. Left here, the close happens at EOF on the
    ordinary path and whenever the straggler dies on the other one, which is as
    early as it can honestly happen.
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
                    # The pipe went away under us -- the process was killed, or
                    # the file object was closed. Either way there is nothing
                    # more.
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
        # `replace` because the cap can land in the middle of a UTF-8 sequence,
        # and because a model may print bytes that are not text at all. A build
        # log is read by a person; it never has to round-trip.
        return bytes(self._kept).decode("utf-8", errors="replace")
