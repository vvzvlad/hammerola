#!/usr/bin/env python3
"""The registered check units, run several at a time and each on a leash.

On prod a model's own checks are 47-95% of a build's wall clock, and
`checks()` is one function in one process: an endless loop in it holds a
worker for the whole wall clock with the other cores idle.

K persistent workers pull units off one shared queue and report back each on
its own channel, and each unit has a budget, so a hung check costs
`UNIT_BUDGET_SECONDS` and one worker, the other units finish, and the log
names the check that hung. One channel per worker because a worker dying while
holding a shared queue's lock silences the survivors (see the `Pipe` in
`run_units`).

Not in `src/buildproc/`: that package may not contain `fork`, `preexec_fn` or
`multiprocessing` in executable code (`tests/buildproc/test_isolation.py`
enforces it with a tokenizer). The context here is `spawn`, a fresh
interpreter like `subprocess`, so the rule's intent holds.

No scheduler: workers are persistent and builders are `@cache`-decorated, so a
second unit needing `build_lid()` gets it free whatever the order. The order is
random, so a unit that secretly depends on another having run first fails on
the build that introduces it.
"""

import collections
import contextlib
import faulthandler
import multiprocessing
import multiprocessing.connection
import random
import signal
import sys
import time
from pathlib import Path

from .errors import BuildError
from .modelchecks import CheckReport, fail_site, print_check_sections
from .modeltext import MAX_MESSAGE_CHARS, shown, shown_text
from .paths import project_root


# --- how many units run at once --------------------------------------------
# Memory, not cores, is the binding constraint. With
# `buildproc.limits.BUILDS_SHARING_THE_HOST` = 4 and the deployed hub's figures
# (SPEC, MAX_CONCURRENT_BUILDS: 20 cores, ~12 GB free, ~450 MB resident per
# build):
#
#   * rlimits are per process and inherited, so each worker gets its own copy
#     of the build's ceilings: K workers multiply them by K.
#   * a worker holds the model's whole geometry, so its working set is the
#     build's own: 4 builds x (1 parent + K workers) x ~450 MB.
#   * K=2 is 5.4 GB of the ~12 GB free, K=3 is 7.2 GB, K=4 is 9.0 GB.
#
# 450 MB is a floor (measured right after `import cadquery`), so the real
# figure is higher. Two workers stay under half the free memory at the floor.
# Raise it once the timings table this module prints shows what units cost.
#
# The OCCT pool is per interpreter and a spawned worker starts uncapped, so the
# cap is repeated in each worker (`_cap_occt_threads` below): a build running
# units holds 1 + K pools, 3 x 5 = 15 threads on the 20-core hub against a
# share of 5. Accepted: the threads sit idle outside parallel kernel
# operations, memory binds first, and dividing the share would make each unit
# slower than inside `checks()`.
#
# Repeating the cap is required for the CPU ceiling: each worker inherits
# `limits.DEFAULT_CPU_SECONDS` (1875 s = 300 x 5 x 1.25, sized for a pool of
# five), summed over its threads. An uncapped pool (twenty threads on the hub)
# burns it four times faster, and the SIGKILL leaves nothing in the log that
# says CPU.
CHECK_WORKERS = 2

# What one unit may take before its worker is killed and the unit is reported
# failed.
#
# Must stay well under `buildproc.limits.DEFAULT_HANG_DUMP_SECONDS` (the whole
# build's ceiling), or a hung unit would still cost the build everything.
# `tests/cadbuild/test_checkunits.py` requires a factor of two. At 290 s that
# ceiling makes this 41% of it.
#
# 120 s: the slowest whole checks() measured on prod is 160 s, so a single
# unit at 120 s is already three quarters of the slowest model's checking.
UNIT_BUDGET_SECONDS = 120.0

# How long the parent waits on the workers' channels before looking at the
# clock. It bounds how far past its budget a hung unit runs and how long a
# worker's death goes unnoticed, and is how often an idle build wakes.
_POLL_SECONDS = 0.2

# How long a worker is given to exit once there is nothing left to do (it has
# a sentinel coming), so it covers interpreter shutdown only. `_collect` uses
# the same wait for an exit code: a worker whose channel closed is exiting.
_SHUTDOWN_SECONDS = 5.0

# What a worker says. `_STARTED` tells the parent which unit a worker took and
# when, which the budget depends on.
_STARTED = "started"
_DONE = "done"

# What became of one unit. `seconds` is wall clock measured in the worker, so
# it excludes the queue wait.
UnitResult = collections.namedtuple("UnitResult", "name status message seconds")

PASSED = "passed"
FAILED = "failed"
TIMED_OUT = "timed out"
# The worker ended while the unit was still running, not because the budget
# ran out: a kernel or interpreter death, not a check that will not return.
DIED = "died"
LOST = "lost"

# The hub's repository root (where `src/` sits), for `_hub_root_first`.
_HUB_ROOT = str(Path(__file__).resolve().parents[2])


@contextlib.contextmanager
def _hub_root_first():
    """Put the hub ahead of the project on `sys.path` while a worker starts.

    A model project may carry a directory called `src`. `geometry.load_model`
    puts the project root first on `sys.path` (a model's `import mocks` must
    find its own mocks.py), handing the project the name `src`; the root
    `checklib.py` shim resolves this package by path for that reason.

    `spawn` copies the parent's `sys.path` into the child inside
    `Process.start()` (`get_preparation_data`), and the child must import
    `src.cadbuild.checkunits` to reach `_work`. With the project first, that
    resolves into the model: a model with its own `src/` died with
    `ModuleNotFoundError: No module named 'src.cadbuild'` in every worker.

    So the hub goes in front only for the start and the path is restored
    afterwards. The worker's `load_model` then puts the project back at the
    head, with the hub one place behind (not at the end, where
    `buildproc.child._absolutise_sys_path` appends it; that only matters for
    a top-level name the hub root and site-packages share).
    """
    saved = list(sys.path)
    sys.path.insert(0, _HUB_ROOT)
    try:
        yield
    finally:
        sys.path[:] = saved


def _occt_pool_size():
    """How many threads this process's OCCT pool has, or None when there is none.

    The number a worker must repeat (see `_cap_occt_threads`). Read off the
    live pool rather than recomputed, because `buildproc.child` takes it from
    `--occt-threads`, which may differ from `limits.DEFAULT_OCCT_THREADS`.

    `DefaultPool_s` is a singleton getter: OCCT builds the pool on the first
    call and ignores the argument afterwards, so `-1` reads the pool `child.py`
    sized. The argument is explicit because the OCP binding's defaults are not
    ours to rely on. In a process with no pool yet this call would create one
    at a thread per core; here `buildproc.child` has always sized it first.

    None on a python without usable OCP (no pool, and no model could compute).
    """
    try:
        from OCP.OSD import OSD_ThreadPool
    except ImportError:
        return None
    try:
        return OSD_ThreadPool.DefaultPool_s(-1).NbThreads()
    except Exception:
        return None


def _cap_occt_threads(count, index):
    """Repeat the build process's OCCT cap in this worker. Runs in the worker.

    A fresh interpreter has an uncapped pool. OMP_NUM_THREADS and its family
    are inherited but do not hold OCCT; the pool is sized by an in-process call
    (`buildproc.child._cap_occt_threads`) before cadquery is imported. Without
    this a worker takes a thread per core, twenty on the hub against the five
    its `RLIMIT_CPU` was sized for (see CHECK_WORKERS).

    It prints, as `child.py` does: the thread count is otherwise not in the
    log, and it is the first number asked for when a worker is killed by a
    signal.

    A failure to cap is a warning, not a refusal: the worker's own ceiling
    fires early and is reported as a death (`DIED`).
    """
    if count is None:
        print(f"check unit worker {index}: this build process has no OCCT pool "
              f"to measure, so nothing is capped here", flush=True)
        return None
    try:
        from OCP.OSD import OSD_ThreadPool
    except ImportError as exc:
        print(f"check unit worker {index}: no usable OCP in this interpreter, "
              f"so no thread pool to cap at {count} ({exc})", flush=True)
        return None
    try:
        actual = OSD_ThreadPool.DefaultPool_s(count).NbThreads()
    except Exception as exc:
        print(f"warning: check unit worker {index}: the OCCT thread pool would "
              f"not be capped at {count} ({type(exc).__name__}: {exc}), so this "
              f"worker runs one thread per core against a CPU ceiling sized for "
              f"{count}", flush=True)
        return None
    print(f"check unit worker {index}: OCCT thread pool capped at {actual}",
          flush=True)
    return actual


def run_units(report):
    """Run every registered unit, K at a time, and fold them into `report`.

    Returns the `CheckReport` `run_checks` produced with the units added to its
    count: one registered unit is one check, so a model that moved its checks
    into units reports the same number, and metrics.json can still say a
    project lost a check. This relies on `run_checks` distinguishing a count of
    zero from an uncountable one: an unknown count stays unknown here, a zero
    gets the units added (`modelchecks.run_checks`).

    Nothing happens when nothing is registered -- no process, no output -- so
    models written against `checks()` behave as before.

    Raises BuildError naming every unit that did not pass, including a hung
    one, with the budget it exceeded, after the rest finished.
    """
    # Imported here, as in `modelchecks.print_check_sections`: this must reach
    # the module the model filled, which the model's own `import checklib` may
    # have loaded through the root shim.
    from . import checklib

    names = list(checklib.registered_units())
    if not names:
        return report
    # Random order (see the module docstring), from a generator of its own:
    # `random.shuffle` uses the global one, and a model.py calling
    # `random.seed(...)` at import would pin the order.
    random.Random().shuffle(names)

    # `spawn`, as SPEC 8A.2 step 4 requires of anything that runs a model: a
    # fork would carry the OCCT thread pool into a child where no thread
    # survives to release its locks.
    context = multiprocessing.get_context("spawn")
    tasks = context.Queue()
    for name in names:
        tasks.put(name)
    # One sentinel per worker, queued behind the work, so a worker that finds
    # the queue empty stops instead of blocking on it forever.
    for _ in range(CHECK_WORKERS):
        tasks.put(None)

    # One channel per worker, not one queue: a `multiprocessing.Queue` has a
    # feeder thread and a lock shared by every writer, and a worker killed
    # while its feeder held the lock (OCCT crash, OOM killer, `sys.exit` in a
    # check) leaves it taken, so the survivors' messages stop arriving. A
    # `Connection` has no thread or lock (`send` writes the fd in the calling
    # thread), so only the dead worker's own channel can be poisoned, and its
    # closing tells the parent the worker is gone.
    root = str(project_root())
    threads = _occt_pool_size()
    channels = [context.Pipe(duplex=False) for _ in range(CHECK_WORKERS)]
    readers = [reader for reader, _writer in channels]
    workers = [
        context.Process(target=_work,
                        args=(root, threads, tasks, channels[index][1], index),
                        name=f"check-unit-{index}", daemon=True)
        for index in range(CHECK_WORKERS)
    ]
    # See `_hub_root_first`: the child's `sys.path` is taken from this one
    # inside `.start()`.
    with _hub_root_first():
        for worker in workers:
            worker.start()
    # Drop the parent's copies of the writing ends: while this process holds a
    # writer, the reader never reaches EOF, and EOF is how a worker's death is
    # noticed.
    for _reader, writer in channels:
        writer.close()
    try:
        collected = _collect(names, workers, readers)
    finally:
        _shut_down(workers, tasks, readers)

    ordered = sorted(collected.values(), key=lambda result: result.seconds,
                     reverse=True)
    failed = [result for result in ordered if result.status != PASSED]
    _print_timings(ordered, len(failed))
    # The units' sections are in this process now. A model that still has a
    # `checks()` gets this table twice (`run_checks` printed one before the
    # units ran); the second is the superset.
    print_check_sections()

    if failed:
        listed = "\n".join(f"  - {shown_text(result.name)}: {result.message}"
                           for result in failed)
        raise BuildError(f"{len(failed)} check unit(s) failed:\n{listed}")

    passed = None if report.passed is None else report.passed + len(names)
    return CheckReport(passed, report.static)


def _ready(live):
    """The indices of the workers with something to say, or none within a poll."""
    if not live:
        return []
    by_reader = {reader: index for index, reader in live.items()}
    return [by_reader[reader] for reader in
            multiprocessing.connection.wait(list(by_reader),
                                            timeout=_POLL_SECONDS)]


def _exit_note(worker):
    """How a worker ended, in the words its reader has to act on."""
    code = worker.exitcode
    if code is None:
        return "and has not finished exiting"
    if code >= 0:
        return f"and exited with code {code}"
    try:
        named = f" ({signal.Signals(-code).name})"
    except ValueError:
        named = ""
    return f"and was killed by signal {-code}{named}"


def _collect(names, workers, readers):
    """Read results until every unit is accounted for, enforcing the budget.

    Only the parent can enforce it: the hang is inside the CAD kernel, where a
    Python signal handler does not run, so the budget is a deadline the parent
    holds and a SIGKILL it sends. The worker is not replaced; the rest of the
    queue drains on the others.

    A worker's death is reported as a death, not as a timeout, so nobody looks
    for an endless loop in a check the OOM killer ended. It is noticed by the
    channel closing: a worker holds the only other end of its own `Pipe`, so
    its death is an EOF here. The `is_alive()` check only shortens the wait by
    a poll; the exit code is then waited for.

    Each result merges its records as it arrives, so a build that dies half way
    keeps the interference and clearance numbers of finished units.
    """
    from . import checklib

    outstanding = {}   # worker index -> (unit name, started, deadline)
    collected = {}
    live = dict(enumerate(readers))     # index -> channel, until it reaches EOF
    while len(collected) < len(names):
        for index in _ready(live):
            try:
                message = live[index].recv()
            except EOFError:
                # A worker closes its end by ending, and by nothing else.
                del live[index]
                continue
            # `==`, not `is`: these strings came back through a pickle.
            if message[0] == _STARTED:
                _, name = message
                started = time.monotonic()
                outstanding[index] = (name, started,
                                      started + UNIT_BUDGET_SECONDS)
            else:
                _, result, records = message
                outstanding.pop(index, None)
                collected[result.name] = result
                checklib._merge_records(*records)

        now = time.monotonic()
        for index, (name, started, deadline) in list(outstanding.items()):
            worker = workers[index]
            reader = live.get(index)
            if reader is not None and worker.is_alive():
                if now < deadline:
                    continue
                worker.kill()
                del outstanding[index]
                collected[name] = UnitResult(
                    name, TIMED_OUT,
                    f"still running after {UNIT_BUDGET_SECONDS:.0f}s, so the "
                    f"worker was killed. That budget is per unit and is well "
                    f"under the build's own wall clock, which is what a check "
                    f"that never returns used to cost",
                    UNIT_BUDGET_SECONDS)
                continue
            if reader is not None and reader.poll():
                # Gone, but its verdict is in the channel: read it next round.
                continue
            # The channel is closed, or the worker is gone with an empty
            # channel; nothing more can arrive, so wait for the exit code.
            worker.join(timeout=_SHUTDOWN_SECONDS)
            del outstanding[index]
            collected[name] = UnitResult(
                name, DIED,
                f"the worker running it died {_exit_note(worker)} after "
                f"{now - started:.1f}s, with the unit unfinished -- it did NOT "
                f"run out of its {UNIT_BUDGET_SECONDS:.0f}s budget. Two kinds "
                f"of cause, and they read differently: a native crash inside "
                f"the kernel leaves a fault dump higher up this log, which is "
                f"where to start; a kill with no dump at all is the kernel's "
                f"doing -- the OOM killer, or RLIMIT_CPU, which is summed over "
                f"every thread of the process",
                now - started)
        if not live:
            # Every channel is closed, so no message can ever arrive again.
            break

    for name in names:
        # A unit nobody reported on: its worker ended before it could say which
        # unit it had taken, or never got as far as taking one.
        collected.setdefault(name, UnitResult(
            name, LOST,
            "the worker that was to run it ended before it said it had "
            "started, so this unit never ran. Three ways to end up here, in the "
            "order worth checking: the worker was killed on the budget of a "
            "DIFFERENT unit, which is a row above with its own time on it; it "
            "crashed, and left a traceback or a fault dump earlier in this log; "
            "or it was killed outright and left no word behind, which is what "
            "the OOM killer and RLIMIT_CPU do", 0.0))
    return collected


def _shut_down(workers, tasks, readers):
    """Leave no worker and no queue thread behind, whatever went wrong above.

    Called in a `finally`, including when `_collect` raised.
    """
    for worker in workers:
        worker.join(timeout=_SHUTDOWN_SECONDS)
        if worker.is_alive():
            worker.kill()
            worker.join(timeout=_SHUTDOWN_SECONDS)
    # `cancel_join_thread` first: unread sentinels are worthless, and waiting
    # for a feeder thread to push into a pipe with dead readers could hang.
    tasks.cancel_join_thread()
    tasks.close()
    for reader in readers:
        reader.close()


def _print_timings(ordered, failed):
    """The units, slowest first -- the table the next K is chosen from.

    Every unit gets a row: the shape of the list shows whether the work is
    spread or sitting in one unit.
    """
    total = len(ordered)
    if failed:
        print(f"check units: {total - failed} of {total} passed")
    else:
        print(f"check units: {total} passed")
    for result in ordered:
        # The name is the model's and `check()` only refuses non-strings, so
        # it goes through `shown_text` (a newline would split a row).
        note = "" if result.status == PASSED else f" -- {result.status}"
        print(f"  {shown_text(result.name)}: {result.seconds:.1f}s{note}")


def _work(root, threads, tasks, results, index):
    """One persistent worker: import the model once, then pull units forever.

    Persistence is the design: the model is imported once per worker and its
    builders are `@cache`-decorated, so geometry is built once per worker and
    free for every later unit.

    Runs in a spawned interpreter, so it is a top-level function with picklable
    arguments.

    The first two lines repeat `buildproc.child`'s start, neither being
    inherited. `faulthandler` goes first because capping the pool imports OCP
    (2-3 s), and a native crash there would otherwise be a bare signal number
    in the parent's `DIED` line. The cap still lands before anything imports
    the kernel for real.

    No `dump_traceback_later`: the unit budget is a deadline the parent holds
    (see `_collect`).
    """
    faulthandler.enable()
    _cap_occt_threads(threads, index)

    from . import checklib
    from . import paths
    from .geometry import load_model

    paths.set_project_root(root)
    load_model()
    # Whatever importing the model recorded belongs to no unit.
    checklib._take_records()

    while True:
        name = tasks.get()
        if name is None:
            return
        # No index in the message: the channel it arrives on IS the worker.
        results.send((_STARTED, name))
        started = time.monotonic()
        status, message = _run(name)
        results.send((_DONE,
                      UnitResult(name, status, message,
                                 time.monotonic() - started),
                      checklib._take_records()))


def _run(name):
    """Call one unit with its builders' output. Returns `(status, message)`.

    `BaseException`, not `Exception`, as in `modelchecks.run_checks`: a unit
    calling `sys.exit()` would otherwise end this worker and every unit queued
    behind it. A check reports by raising.
    """
    from . import checklib

    try:
        unit = checklib.registered_units()[name]
        unit.func(**{parameter: build()
                     for parameter, build in unit.needs.items()})
    except AssertionError as exc:
        # `shown` calls `str()` itself, so a buggy `__str__` in an assert
        # message cannot raise out of this handler.
        text = shown(exc, str, limit=MAX_MESSAGE_CHARS).strip()
        return FAILED, (f"assertion failed{fail_site(exc)}: "
                        f"{text or 'no message given'}")
    except BaseException as exc:
        return FAILED, (f"raised {type(exc).__name__}{fail_site(exc)}: "
                        f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}")
    return PASSED, ""
