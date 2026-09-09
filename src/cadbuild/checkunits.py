#!/usr/bin/env python3
"""The registered check units, run several at a time and each on a leash.

WHY THIS EXISTS, measured rather than assumed. On prod the model's own checks
are 47-95% of a build's wall clock -- ford-cup-4 spent 160 seconds of 169 in
them -- and 27% of all the machine time the hub burned went to seven builds
that HUNG, at 891 seconds each. `checks()` is one function in one process, so
neither number has anywhere to go: the whole budget before a kill is the
build's own wall clock, and one endless `while` inside a model's checks holds a
worker for a quarter of an hour with twenty cores idle beside it.

A unit fixes both at once, and the second half is the one that pays first. K
persistent workers pull units off ONE shared queue and report back each on a
CHANNEL OF ITS OWN, and each unit gets a budget -- so a hung check costs
`UNIT_BUDGET_SECONDS` and ONE worker, the rest of the units finish on the
others, and the log names the check that hung. The channels are one per worker
rather than one queue for all of them because a worker that dies holding a
shared queue's lock silences the survivors; the reasoning is at the `Pipe` in
`run_units`.

WHY IT IS HERE AND NOT IN `src/buildproc/`. That package is forbidden the words
`fork`, `preexec_fn` and `multiprocessing` in executable code, and
`tests/buildproc/test_isolation.py` holds it to that with a tokenizer: what
runs the model must be a fresh interpreter, never a copy of a threaded parent
whose OCCT pool would deadlock. Nothing here weakens that -- the context below
is `spawn`, which is the same fork-and-exec-in-C `subprocess` does -- but the
rule is about a directory, and this is a different one.

WHY THERE IS NO SCHEDULER. Units are NOT grouped by the builders they need. A
worker is persistent and the builders are `@cache`-decorated, so the second
unit that needs `build_lid()` gets it for free from the first one that did,
whatever order they arrive in; grouping is a pure optimisation on top of that,
and what it would buy is a number the timings table below has to measure first.
The order is deliberately RANDOM instead, so a unit that secretly depends on
another one having run first fails on the build that introduces it rather than
on some later build that happened to shuffle differently.
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
# THE BINDING CONSTRAINT IS MEMORY AND NOT CORES, which is what settles this
# number low. The arithmetic, from the figures measured on the deployed hub
# (SPEC, MAX_CONCURRENT_BUILDS: 20 cores, ~12 GB free, ~450 MB resident per
# build) and from `buildproc.limits.BUILDS_SHARING_THE_HOST`, which is 4:
#
#   * rlimits are PER PROCESS and are INHERITED, so a worker does not share the
#     build's ceiling with it -- it gets a second one of its own. K workers
#     multiply the memory and CPU ceilings by K rather than dividing them.
#   * a worker holds the model's whole geometry, because that is what its
#     builders produce, so its working set is the build's own and not a share
#     of it: 4 builds x (1 parent + K workers) x ~450 MB.
#   * K=2 is 5.4 GB of the ~12 GB free, K=3 is 7.2 GB and K=4 is 9.0 GB.
#
# AND 450 MB IS A FLOOR, NOT A PEAK -- it was measured right after `import
# cadquery`, before a model has built anything -- so the real multiplier is
# above it by an unknown amount. Two workers is the number that stays under
# half the free memory at that floor and still has room when the real figure
# turns out to be twice it. Raise it when the timings table this module prints
# has measured what a unit actually costs; that measurement is the reason the
# table is part of the same change.
#
# CORES ARE NOT WHAT LIMITS IT EITHER -- but the arithmetic is NOT the one this
# comment used to give. It said "two workers fit inside the share this build
# already had", which reads the OCCT pool as something a worker inherits. It is
# not: the pool is per PROCESS and per interpreter, `buildproc.child`
# `_cap_occt_threads` sizes it once in the build process before cadquery is
# imported, and a SPAWNED worker starts a fresh interpreter where none of that
# has happened. So a build running units holds 1 + K pools rather than one
# divided K ways: with the cap repeated in the worker (`_cap_occt_threads`
# below) that is 3 x 5 = 15 threads on the 20-core hub, against a nominal share
# of 5. The oversubscription is accepted deliberately -- the threads are a POOL
# and sit idle unless a unit is inside a parallel kernel operation, memory is
# what binds first (above), and dividing the share by K would make each unit
# slower than the same check was inside `checks()`.
#
# WHAT REPEATING THE CAP BUYS IS THE CPU CEILING, and that is why it is not
# optional. `RLIMIT_CPU` is inherited per process and is summed over a process's
# THREADS, so every worker gets its own copy of `limits.DEFAULT_CPU_SECONDS`
# (5625 s = 900 x 5 x 1.25, sized for a pool of five). A worker whose pool came
# up at one thread per logical core -- twenty on the hub -- burns that ceiling
# four times faster than the number says, and the kernel's SIGKILL arrives with
# nothing in the log connecting the two: the unit is reported dead or lost and
# not one word of the report says CPU.
CHECK_WORKERS = 2

# What ONE unit may take before its worker is killed and the unit is reported
# failed.
#
# IT MUST STAY UNDER `buildproc.limits.DEFAULT_HANG_DUMP_SECONDS` (890 s), and
# comfortably: that ceiling is the whole build's, and a unit budget anywhere
# near it would mean a hung unit still costs the build everything -- which is
# the failure this module is for. `tests/cadbuild/test_checkunits.py` holds the
# two numbers in that order.
#
# 120 s is the top of the band the owner set, and it is picked there rather
# than lower for one reason: the slowest checks phase measured on prod is 160 s
# for the WHOLE of ford-cup-4's checks(), so a single unit at 120 s would
# already be three quarters of the slowest model's entire checking. Nothing
# legitimate measured so far comes close, and a hang now costs 120 s instead of
# 891 -- a 7.4x cut -- with the rest of the units still finishing beside it.
UNIT_BUDGET_SECONDS = 120.0

# How long the parent waits on the workers' channels before it looks at the
# clock. Small, because it is what bounds how far past its budget a hung unit
# runs, and how long a worker's death goes unnoticed; not smaller, because it is
# also how often a build that is behaving wakes up for nothing.
_POLL_SECONDS = 0.2

# How long a worker is given to exit on its own once there is nothing left to
# do. It is waiting on `Queue.get` and has a sentinel coming, so this covers
# interpreter shutdown and nothing more. It is also what `_collect` waits for an
# exit code with, which is the same wait: a worker whose channel has closed is
# already on its way out.
_SHUTDOWN_SECONDS = 5.0

# What a worker says. `_STARTED` is what makes the budget possible at all: the
# parent has to know WHICH unit a worker took and WHEN, or it has nothing to
# kill and nothing to name when the time runs out.
_STARTED = "started"
_DONE = "done"

# What became of one unit. `seconds` is wall clock measured in the worker, so
# it excludes the queue wait and is comparable between units that ran on
# different workers.
UnitResult = collections.namedtuple("UnitResult", "name status message seconds")

PASSED = "passed"
FAILED = "failed"
TIMED_OUT = "timed out"
# The worker ended while the unit was still running, and NOT because the budget
# ran out. Separate from TIMED_OUT because it sends the reader somewhere else
# entirely: a timeout is a check that will not return, a death is the kernel or
# the interpreter ending the process under it.
DIED = "died"
LOST = "lost"

# The hub's own repository root -- the directory `src/` sits in. See
# `_hub_root_first`, which is the only thing that wants it.
_HUB_ROOT = str(Path(__file__).resolve().parents[2])


@contextlib.contextmanager
def _hub_root_first():
    """Put the hub ahead of the project on `sys.path` while a worker starts.

    A MODEL PROJECT MAY CARRY A DIRECTORY CALLED `src`, and everything around
    here is built so that it may. `geometry.load_model` puts the project root on
    `sys.path` FIRST on purpose -- a model's `import mocks` has to find the
    model's own mocks.py -- which hands the project the name `src` for the rest
    of the process; `geometry._shadowed_src_hint` exists to explain that to an
    author, and the `checklib.py` shim at the repository root resolves this
    package BY PATH precisely so that it never says the word `src` at all.

    A spawned worker breaks the arrangement from the other end. `spawn` copies
    the parent's `sys.path` into the child -- `get_preparation_data`, taken
    inside `Process.start()` -- and the child then has to `import
    src.cadbuild.checkunits` in a FRESH interpreter to reach `_work`. With the
    project first that import resolves into the MODEL. Reproduced: a model with
    an ordinary `src/` beside its model.py died with `ModuleNotFoundError: No
    module named 'src.cadbuild'` in every worker and reported `check units: 0 of
    1 passed`, and the identical model without the directory was green.

    So the hub goes in front for the duration of the start and the path is put
    back the moment it is over: this process goes on being one where the project
    owns `src`, and the child is born with the hub ahead of it. The worker's own
    `load_model` then moves the project back to the head before it imports
    anything of the model's, so the project owns the head of the path there as
    it does here. The hub sits one place behind it rather than at the end, where
    `buildproc.child._absolutise_sys_path` appends it -- a difference that can
    only show on a top-level name the hub root and site-packages share.
    """
    saved = list(sys.path)
    sys.path.insert(0, _HUB_ROOT)
    try:
        yield
    finally:
        sys.path[:] = saved


def _occt_pool_size():
    """How many threads THIS process's OCCT pool has, or None when there is none.

    The number a worker has to repeat -- see `_cap_occt_threads` for why it must
    be repeated at all. It is read off the live pool rather than recomputed,
    because what the worker owes the CPU ceiling is the number the build process
    actually got: `buildproc.child` takes it from `--occt-threads`, which the
    wrapper may set to something other than `limits.DEFAULT_OCCT_THREADS`.

    `DefaultPool_s` is a singleton getter -- OCCT builds the pool on the FIRST
    call and returns that same one forever after, argument and all ignored -- so
    the `-1` here reads the pool `child.py` already sized and cannot resize it.
    The argument is spelled out rather than left to a default because the OCP
    binding's defaults are not ours to rely on.

    IN A PROCESS THAT HAS NO POOL YET THIS CALL IS WHAT MAKES ONE, at the
    interpreter's own default of a thread per logical core. That is a fact about
    the getter and not a hazard here: this runs deep inside a build, after the
    geometry phase, in a process where `buildproc.child` sized the pool before
    cadquery was imported.

    None on a python with no usable OCP, which is every machine without the CAD
    stack, this suite included: there is no pool to measure and no model that
    could compute anything either.
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

    A FRESH INTERPRETER HAS AN UNCAPPED POOL, and nothing carries the cap across
    for it. The environment variables that look like they would -- OMP_NUM_THREADS
    and its family -- ARE inherited and are not what holds OCCT: the pool is
    sized by an in-process call, `buildproc.child._cap_occt_threads`, made once
    before cadquery is imported. Without this line a worker takes one thread per
    logical core, twenty on the hub against the five its `RLIMIT_CPU` was sized
    for, and burns that ceiling four times faster than its number says. See the
    arithmetic at CHECK_WORKERS.

    IT PRINTS, for the reason `child.py` prints the same line: the thread count
    a build actually ran with is not otherwise recoverable from its log, and it
    is the first number anybody asks for when a worker is killed by a signal.

    A failure to cap is a printed warning and not a refusal. The build process
    refuses to start uncapped because its whole CPU ceiling is sized against the
    cap; a worker that cannot cap is a degraded worker whose own ceiling fires
    early, which is now reported as the death it is (`DIED`) rather than as a
    hang.
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
    count: one registered unit is one check. A model that has moved all of its
    checks into units therefore reports the number it always did, and
    metrics.json goes on being able to say that a project lost a check.

    THAT LAST SENTENCE IS ONLY TRUE BECAUSE `run_checks` DISTINGUISHES A COUNT
    OF ZERO FROM AN UNCOUNTABLE ONE, and it did not: a half-migrated model -- an
    empty `checks()`, whose refusal the units now waive, plus eight units --
    counted 0, went through `(0 - 0) or None`, and arrived here as "unknown". A
    number added to `None` is still `None`, so metrics.json carried
    `checks_passed: null` for a model with eight checks and `report_metrics`
    could no longer say the project had lost one. An unknown count stays unknown
    here, which is right; what it must not be handed is a zero dressed up as
    one (`modelchecks.run_checks`).

    NOTHING HAPPENS AT ALL WHEN NOTHING IS REGISTERED -- no process is started,
    nothing is printed -- which is what leaves every model written against
    `checks()` behaving exactly as it did.

    Raises BuildError naming every unit that did not pass. A unit that hung is
    one of those: it is reported by name, with the budget it exceeded, on a
    build that finished the rest of its checks.
    """
    # checklib is imported HERE and not at module level for
    # `modelchecks.print_check_sections`'s reason: this has to reach the module
    # the MODEL filled, and the model's own `import checklib` may be what loads
    # it, through the shim at the repository root.
    from . import checklib

    names = list(checklib.registered_units())
    if not names:
        return report
    # See the module docstring: a hidden dependency between two units surfaces
    # on the build that introduces it, rather than on whichever later build
    # happens to draw them the other way round.
    #
    # A GENERATOR OF ITS OWN and not `random.shuffle`, which draws from the
    # module's global one. A model.py that calls `random.seed(...)` at import
    # time -- and models do, to keep a pattern or a sample reproducible -- would
    # otherwise pin the order this exists to vary, silently and for every build
    # after.
    random.Random().shuffle(names)

    # `spawn`, which is what SPEC 8A.2 step 4 requires of anything that runs a
    # model: a fork of this process would carry its OCCT thread pool into a
    # child where no thread survives to release its locks.
    context = multiprocessing.get_context("spawn")
    tasks = context.Queue()
    for name in names:
        tasks.put(name)
    # One sentinel per worker, queued behind the work, so a worker that finds
    # the queue empty stops instead of blocking on it forever.
    for _ in range(CHECK_WORKERS):
        tasks.put(None)

    # ONE CHANNEL PER WORKER AND NOT ONE QUEUE FOR ALL OF THEM. A
    # `multiprocessing.Queue` is a pipe plus a feeder THREAD plus a lock, and
    # the lock is shared by every process that writes to it: a worker killed
    # while its feeder held that lock -- an OCCT crash, the OOM killer, a
    # `sys.exit` out of a check -- leaves the semaphore taken for good, and the
    # messages of the SURVIVING workers stop arriving. Reproduced: three runs of
    # one model gave three different verdicts, a unit that had finished in three
    # seconds was reported "timed out", the one still running was reported
    # "lost", and a healthy neighbour was SIGKILLed on the way out. A
    # `Connection` has no thread and no lock -- `send` writes to the fd in the
    # calling thread -- so a poisoned channel can only ever be the dead worker's
    # own, and its closing is also what tells the parent it is gone.
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
    # INSIDE `.start()`, and the hub has to be in front of the project in it.
    with _hub_root_first():
        for worker in workers:
            worker.start()
    # The parent's own copies of the writing ends, dropped now that each worker
    # holds the one that is its own. While this process holds a writer, the
    # reader beside it never reaches EOF -- and EOF is the whole of how a
    # worker's death is noticed.
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
    # The sections the units filled are in this process now, so the table can
    # be printed against the whole run. A model that still has a `checks()`
    # gets this table twice -- `run_checks` printed the first one before the
    # units ran -- and the second is the superset.
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

    THE PARENT IS THE ONLY THING THAT CAN ENFORCE IT. A worker cannot time
    itself out -- the hang this is for is inside the CAD kernel, where a Python
    signal handler does not run until the kernel comes back -- so the budget is
    a deadline the parent holds and a SIGKILL it sends. The worker is not
    replaced: one hung unit costs one worker, and the rest of the queue drains
    on the others.

    A WORKER'S DEATH IS NOTICED AS ITSELF AND NOT AS A DEADLINE. Death used to
    be invisible until the budget ran out, and was then reported as "still
    running after 120s, so the worker was killed", about a process that had not
    existed for two minutes -- a sentence that sends its reader to look for an
    endless loop inside a check the OOM killer ended.

    WHAT NOTICES IT IS THE CHANNEL CLOSING. A worker holds the only other end of
    its own `Pipe`, so its death is an EOF here and `live` loses that index --
    which is what the per-worker channel bought, and it is load-bearing. The
    `is_alive()` question below is asked of the index the unit is outstanding ON
    rather than of all of them, but that only shortens the wait by a poll: the
    verdict is reached from the closed channel either way, and the exit code is
    then waited for rather than guessed at.

    Every result MERGES ITS RECORDS as it arrives rather than at the end, so a
    build that dies half way still has the interference and clearance numbers
    of the units that finished.
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
            # `==` and never `is`: these strings came back through a pickle, so
            # the interned constant above is a different object from what
            # arrived.
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
                # It is gone, but its verdict is already in the channel: read it
                # next round rather than declaring a death over the top of it.
                continue
            # Either the channel is closed, or the worker is gone and the
            # channel is empty. Nothing more can arrive on it either way,
            # whatever `is_alive()` happens to say this instant -- so the exit
            # code is waited for rather than guessed at.
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

    In a `finally`, because the build must not be held by a worker after the
    verdict is known -- including when `_collect` itself raised.
    """
    for worker in workers:
        worker.join(timeout=_SHUTDOWN_SECONDS)
        if worker.is_alive():
            worker.kill()
            worker.join(timeout=_SHUTDOWN_SECONDS)
    # `cancel_join_thread` FIRST: unread sentinels and names are worth nothing
    # now, and waiting for a feeder thread to push them into a pipe whose
    # readers are dead is a way for a finished build to hang.
    tasks.cancel_join_thread()
    tasks.close()
    for reader in readers:
        reader.close()


def _print_timings(ordered, failed):
    """The units, slowest first -- the table the next K is chosen from.

    Longest first for `print_check_sections`'s reason: the question this is
    read for is always which one to look at. Every unit gets a row, including
    the fast ones, because the shape of the list is what says whether the work
    is spread or sitting in one unit.
    """
    total = len(ordered)
    if failed:
        print(f"check units: {total - failed} of {total} passed")
    else:
        print(f"check units: {total} passed")
    for result in ordered:
        # THE NAME IS THE MODEL'S, and it is the one field of this table that
        # is. `check()` refuses a non-string and scans it for nothing else, so
        # a newline in it would turn one row into two and a table read as a
        # ranking into a list nobody can rank.
        note = "" if result.status == PASSED else f" -- {result.status}"
        print(f"  {shown_text(result.name)}: {result.seconds:.1f}s{note}")


def _work(root, threads, tasks, results, index):
    """One persistent worker: import the model once, then pull units forever.

    PERSISTENT IS THE WHOLE DESIGN. The model is imported once per worker and
    its builders are `@cache`-decorated, so the geometry a unit needs is built
    the first time some unit on this worker asks for it and is free for every
    unit after -- which is what makes a queue of small units cheaper than one
    big `checks()` instead of `CHECK_WORKERS` times more expensive.

    Runs in a spawned interpreter, so this is a top-level function taking only
    picklable arguments: it is reached by name in a fresh process, not carried
    there.

    THE FIRST TWO LINES ARE THE START `buildproc.child` MAKES, in the same order
    and for the same reasons -- this is a fresh interpreter, and neither of them
    is inherited. `faulthandler` goes FIRST because the line after it is itself
    the risky one: capping the pool imports OCP, which is 2-3 seconds of loading
    the kernel, and a native crash in there with the handler not yet armed is a
    bare signal number in the parent's `DIED` line. Armed first, it covers that
    import and every check after it. The cap still lands before anything that
    could import the kernel for real (see `_cap_occt_threads`) -- `faulthandler`
    is stdlib and pulls in nothing.

    `dump_traceback_later` is deliberately NOT armed beside it: a unit's budget
    is a deadline the PARENT holds (see `_collect`), and a second timer in here
    would be a worker killing itself on a clock the parent cannot see.
    """
    faulthandler.enable()
    _cap_occt_threads(threads, index)

    from . import checklib
    from . import paths
    from .geometry import load_model

    paths.set_project_root(root)
    load_model()
    # Whatever importing the model recorded belongs to no unit, and reporting
    # it against the first one drawn would attribute it at random.
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

    `BaseException` and not `Exception`, for `modelchecks.run_checks`'s reason:
    a unit that calls `sys.exit()` would otherwise end this worker silently and
    take every unit still queued behind it with it. A check reports by raising.
    """
    from . import checklib

    try:
        unit = checklib.registered_units()[name]
        unit.func(**{parameter: build()
                     for parameter, build in unit.needs.items()})
    except AssertionError as exc:
        # `shown` calls `str()` itself: an assert message is usually an f-string
        # over the author's own objects, and a `__str__` with a bug in it would
        # otherwise raise out of this handler.
        text = shown(exc, str, limit=MAX_MESSAGE_CHARS).strip()
        return FAILED, (f"assertion failed{fail_site(exc)}: "
                        f"{text or 'no message given'}")
    except BaseException as exc:
        return FAILED, (f"raised {type(exc).__name__}{fail_site(exc)}: "
                        f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}")
    return PASSED, ""
