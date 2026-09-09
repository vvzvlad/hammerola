"""Check units: what the decorator refuses, and what comes back from a worker.

Two halves, and the second is the one worth the process starts. Registration is
pure and is tested as such. The RUN is tested against real spawned workers
against a real model.py on disk, because everything that can go wrong with it
goes wrong at the process boundary: a record filled in a worker and not merged
back leaves metrics.json empty on a build that measured it, a unit that never
returns has to be killed by the parent, and a name has to survive a pickle to
end up in the timings table.

Nothing here imports cadquery, and every test runs on a machine that has no CAD
kernel at all. The model.py these tests write has `parts()` and `views()`
because `load_model` insists on them, and geometry that is a plain number -- the
mechanism under test is the queue, the budget, the merge and the process
boundary, and none of it knows what a solid is.

ONE THING DOES REACH FOR THE KERNEL AND IS WRITTEN SO THAT IT NEED NOT FIND IT:
a worker caps its OCCT thread pool before it imports the model, so `OCP` is
imported there where it exists. Where it does not, the cap says so and goes on,
which is the same answer `buildproc.child` gives -- so the test below reads the
ORDER of the worker's two lines rather than a thread count nothing here can
produce.
"""

from types import SimpleNamespace
import multiprocessing
import sys
import textwrap
import time

import pytest

from src.buildproc.limits import DEFAULT_HANG_DUMP_SECONDS
from src.cadbuild import checklib, checkunits
from src.cadbuild.errors import BuildError
from src.cadbuild.modelchecks import CheckReport, run_checks


@pytest.fixture(autouse=True)
def clean_units():
    """The registry and the three records, both ends, like the conftest guard.

    A unit left behind is not a stale number: `run_units` would start a worker
    process for it in some later test.
    """
    checklib._UNITS.clear()
    checklib._take_records()
    yield
    checklib._UNITS.clear()
    checklib._take_records()


@pytest.fixture
def model_project(isolated_project, monkeypatch):
    """Write a model.py, import it here, and let a worker import it there.

    The PARENT has to hold the registry too -- that is where `run_units` reads
    the names from -- so this imports the model in this process as well, and
    takes it back out of sys.modules afterwards: `import model` is one name for
    every project, and a second test would otherwise get the first one's file.
    """
    def write(body):
        # DEDENTED SEPARATELY AND NOT AS ONE STRING. The two halves are written
        # at different indentations -- one at module level here, one inside a
        # test function -- and `dedent` strips the common prefix of whatever it
        # is given. Joined first, the units keep four spaces and become
        # unreachable statements inside `views()`, the decorator never runs, and
        # the test reads as "nothing was registered".
        (isolated_project / "model.py").write_text(
            textwrap.dedent(CONTRACT) + textwrap.dedent(body), encoding="utf-8")
        monkeypatch.syspath_prepend(str(isolated_project))
        sys.modules.pop("model", None)
        from src.cadbuild.geometry import load_model
        return load_model()

    yield write
    sys.modules.pop("model", None)


# The two entry points `load_model` insists on, and nothing else. Every model
# below opens with this.
CONTRACT = """
    import checklib

    def parts():
        return {}

    def views():
        return []
"""


# --------------------------------------------------------------------------
# What the decorator refuses, and where
# --------------------------------------------------------------------------

def test_a_registered_unit_is_reachable_by_name_and_still_callable():
    """The decorator registers and hands the function BACK unchanged.

    Unchanged matters: a model composes its checks out of ordinary functions,
    and a decorator that returned a wrapper would make `check_lip()` inside
    another check call something else.
    """
    def build_lid():
        return 7

    @checklib.check("lip joint", needs={"lid": build_lid})
    def check_lip(lid):
        return lid

    assert checklib.registered_units()["lip joint"].func is check_lip
    assert check_lip(3) == 3


def test_a_needs_key_that_names_no_parameter_is_refused_at_the_at_sign():
    """The mistake the contract is most likely to attract, named where written.

    `needs` maps the CHECK'S OWN parameter names; naming a key of parts()
    instead is the shape this refusal is for, and getting it as a TypeError out
    of a worker process would cost a whole geometry phase first.
    """
    with pytest.raises(ValueError) as raised:
        @checklib.check("lip", needs={"lid": lambda: 1, "base": lambda: 2})
        def check_lip(lid):
            return lid

    assert "base" in str(raised.value)
    assert not checklib.registered_units()


def test_a_parameter_with_no_builder_is_refused_too():
    """The other direction: the check asks for something `needs` never names."""
    with pytest.raises(ValueError) as raised:
        @checklib.check("lip", needs={"lid": lambda: 1})
        def check_lip(lid, base):
            return lid, base

    assert "base" in str(raised.value)
    assert not checklib.registered_units()


def test_a_builder_that_is_not_callable_is_refused_by_name():
    """`build_lid()` written where `build_lid` was meant -- the value, not the
    function. It would be a TypeError at call time, in another process."""
    with pytest.raises(TypeError) as raised:
        @checklib.check("lip", needs={"lid": 12.0})
        def check_lip(lid):
            return lid

    assert "lid" in str(raised.value)
    assert not checklib.registered_units()


def test_two_units_cannot_share_a_name():
    """The name is what the table and the refusal call it; two would read as one."""
    @checklib.check("lip")
    def first():
        return None

    with pytest.raises(ValueError):
        @checklib.check("lip")
        def second():
            return None

    assert list(checklib.registered_units()) == ["lip"]


def test_a_name_that_is_not_a_usable_heading_is_refused():
    for name in (None, 12, ""):
        with pytest.raises(TypeError):
            checklib.check(name)
    assert not checklib.registered_units()


def test_needs_that_is_not_a_mapping_is_refused():
    with pytest.raises(TypeError):
        checklib.check("lip", needs=["build_lid"])


def test_a_unit_that_needs_nothing_is_legal():
    """`needs` is optional: a check that reads a file and no geometry has none."""
    @checklib.check("provenance")
    def check_nothing():
        return None

    assert checklib.registered_units()["provenance"].needs == {}


# --------------------------------------------------------------------------
# The records, and the process boundary they have to cross
# --------------------------------------------------------------------------

def test_taking_the_records_empties_them_so_a_worker_reports_one_unit_at_a_time():
    checklib._INTERFERENCE["a|b"] = 4.0
    checklib._SECTIONS["probe"] = 1.5
    checklib._CLEARANCE["lid"] = {"min_gap": 0.2}

    interference, sections, clearance = checklib._take_records()

    assert interference == {"a|b": 4.0}
    assert sections == {"probe": 1.5}
    assert clearance == {"lid": {"min_gap": 0.2}}
    assert checklib.recorded_interference() == {}
    assert checklib.recorded_sections() == {}
    assert checklib.recorded_clearance() == {}


def test_merging_sums_the_sections_and_replaces_the_other_two():
    """The three records do NOT merge the same way, and each rule is the one
    a single-process run would have produced for the same work."""
    checklib._merge_records({"a|b": 4.0}, {"probe": 1.5}, {"lid": {"min_gap": 0.2}})
    checklib._merge_records({"a|c": 0.0}, {"probe": 2.5}, {"lid": {"min_gap": 0.1}})

    assert checklib.recorded_interference() == {"a|b": 4.0, "a|c": 0.0}
    # Summed: a label used in two units is one row whose seconds are the total,
    # exactly as a label used twice inside one checks() is.
    assert checklib.recorded_sections() == {"probe": 4.0}
    # Replaced: the record that arrives LAST is the one that survives. Which of
    # two sweeps that is, is decided by the workers and not by the model -- see
    # `_merge_records`; what is pinned here is the rule, not an order.
    assert checklib.recorded_clearance() == {"lid": {"min_gap": 0.1}}


def test_a_clearance_record_handed_back_is_a_copy():
    """`recorded_clearance` copies one level deeper than the other two, and the
    merge must not undo that by sharing the dict it was given."""
    given = {"min_gap": 0.2}
    checklib._merge_records({}, {}, {"lid": given})
    checklib.recorded_clearance()["lid"]["min_gap"] = 99.0
    assert checklib.recorded_clearance() == {"lid": {"min_gap": 0.2}}


# --------------------------------------------------------------------------
# The budget
# --------------------------------------------------------------------------

def test_the_unit_budget_stays_well_under_the_build_wide_hang_dump():
    """The point of a per-unit budget is that a hung unit does NOT cost the
    build its wall clock. A budget at or near the build's own ceiling would
    give that back without anything failing."""
    assert 60.0 <= checkunits.UNIT_BUDGET_SECONDS <= 120.0
    assert checkunits.UNIT_BUDGET_SECONDS < DEFAULT_HANG_DUMP_SECONDS / 2


def test_the_worker_caps_the_occt_pool_before_it_imports_the_model(
        model_project, monkeypatch, capfd):
    """The pool is per INTERPRETER, and a spawned worker starts a fresh one.

    Nothing carries the cap across. The environment variables that look as
    though they would -- OMP_NUM_THREADS and its family -- are inherited and are
    not what holds OCCT: `buildproc.child._cap_occt_threads` sizes the pool with
    an in-process call, once, before cadquery is imported. Uncapped, a worker
    takes a thread per core (twenty on the hub against the five its RLIMIT_CPU
    was sized for) and the kernel kills it four times sooner than the ceiling
    says, with nothing in the log about CPU.

    BEFORE THE MODEL AND NOT MERELY SOMEWHERE, which is what the ordering below
    is: importing model.py is the first thing that can pull the kernel in, and a
    cap applied after the pool exists is a cap on nothing. The order is read off
    the two lines because there is no kernel on this machine to ask -- what runs
    here is the plumbing, and `capfd` sees a spawned process's output where
    `capsys` does not.
    """
    monkeypatch.setattr(checkunits, "_occt_pool_size", lambda: 5)
    model_project("""
        print("model imported")

        @checklib.check("one")
        def check_one():
            pass
    """)
    capfd.readouterr()   # this process imported the model too; that is not it

    checkunits.run_units(CheckReport(0, 0))

    lines = capfd.readouterr().out.splitlines()
    capped = [i for i, line in enumerate(lines)
              if line.startswith("check unit worker")]
    imported = [i for i, line in enumerate(lines) if line == "model imported"]
    assert capped and imported, "a worker said neither what it capped nor that "\
                                "it had imported the model"
    assert min(capped) < min(imported), (
        "the model was imported before the pool was capped, so the cap landed "
        "on a pool the kernel had already sized itself")
    assert "5" in lines[min(capped)], (
        "the worker capped at some other number than the one the build process "
        "is running with")


# --------------------------------------------------------------------------
# The run itself, against real spawned workers
# --------------------------------------------------------------------------

def test_nothing_is_started_and_nothing_is_printed_when_no_unit_is_registered(
        capsys, monkeypatch):
    """Every model written against `checks()` has to behave exactly as before,
    and "exactly" includes not paying for two interpreter starts."""
    def refuse(*args, **kwargs):
        raise AssertionError("a worker was started for a model with no units")

    monkeypatch.setattr(checkunits.multiprocessing, "get_context", refuse)

    report = CheckReport(3, 1)
    assert checkunits.run_units(report) is report
    assert capsys.readouterr().out == ""


def test_every_unit_runs_and_the_table_comes_out_slowest_first(
        model_project, capsys):
    model_project("""
        @checklib.check("slow")
        def check_slow():
            import time
            time.sleep(0.35)

        @checklib.check("quick")
        def check_quick():
            pass

        @checklib.check("middling")
        def check_middling():
            import time
            time.sleep(0.15)
    """)

    report = checkunits.run_units(CheckReport(2, 0))

    # Three units are three more checks on top of the two checks() reported.
    assert report == CheckReport(5, 0)
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "check units: 3 passed"
    assert [line.split(":")[0].strip() for line in lines[1:4]] == [
        "slow", "middling", "quick"]


def test_the_builders_named_in_needs_are_what_the_check_is_called_with(
        model_project):
    model_project("""
        from functools import cache

        @cache
        def build_base():
            return 10

        @cache
        def build_lid():
            return 4

        @checklib.check("lip joint", needs={"body": build_base, "lid": build_lid})
        def check_lip(body, lid):
            assert body - lid == 6, f"got {body} and {lid}"
    """)

    assert checkunits.run_units(CheckReport(0, 0)) == CheckReport(1, 0)


def test_the_records_a_worker_fills_arrive_in_the_parent(model_project):
    """THE LOAD-BEARING ONE. Filled in a worker's own process and not merged
    back, `_INTERFERENCE` and `_CLEARANCE` leave metrics.json with empty
    interference and clearance numbers on a build that measured both, and
    nothing goes red -- which is the failure the shim at the repository root
    exists one level further in to prevent."""
    # The real writers of these two records are `pairwise_interference` and
    # `swept_clearance`, and both want a CAD kernel this suite does not have --
    # so the record is written directly, through the implementation module
    # rather than through the shim (which re-exports no private name, on
    # purpose). What is under test is the crossing, not the measuring.
    model_project("""
        from src.cadbuild import checklib as record

        @checklib.check("overlap")
        def check_overlap():
            with checklib.section("probing"):
                record._INTERFERENCE["body|lid"] = 4.0
                record._CLEARANCE["lid drop"] = {"min_gap": 0.25}

        @checklib.check("second overlap")
        def check_second():
            with checklib.section("probing"):
                record._INTERFERENCE["body|screw"] = 0.0
    """)

    checkunits.run_units(CheckReport(0, 0))

    assert checklib.recorded_interference() == {"body|lid": 4.0, "body|screw": 0.0}
    assert checklib.recorded_clearance() == {"lid drop": {"min_gap": 0.25}}
    # One label, both units, summed -- and present at all, which is the point.
    assert list(checklib.recorded_sections()) == ["probing"]


def test_a_failing_unit_is_named_with_its_own_message_and_its_line(
        model_project, capsys):
    model_project("""
        @checklib.check("lip joint")
        def check_lip():
            assert False, "lip joint too shallow"

        @checklib.check("fine")
        def check_fine():
            pass
    """)

    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))

    message = str(raised.value)
    assert "1 check unit(s) failed" in message
    assert "lip joint" in message and "lip joint too shallow" in message
    assert "model.py:" in message
    # The table still comes out: the build that went red is the log anybody
    # opens, and the unit that failed has a row in it.
    out = capsys.readouterr().out
    assert "check units: 1 of 2 passed" in out
    assert "-- failed" in out


def test_a_unit_that_raises_something_other_than_an_assert_is_a_failure_too(
        model_project):
    model_project("""
        @checklib.check("lip joint")
        def check_lip():
            raise ValueError("no lip here")
    """)

    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))

    assert "raised ValueError" in str(raised.value)


def test_a_unit_that_exits_the_worker_does_not_take_the_queue_with_it(
        model_project):
    """`sys.exit()` in a unit is a BaseException: left uncaught it would end the
    worker silently, and every unit still queued behind it would be reported
    lost for a reason nothing names."""
    model_project("""
        @checklib.check("leaves")
        def check_leaves():
            import sys
            sys.exit(0)
    """)

    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))

    assert "raised SystemExit" in str(raised.value)


def test_a_unit_that_never_returns_is_killed_on_its_budget_and_named(
        model_project, capsys, monkeypatch):
    """The 891-second hang, costing seconds and one worker instead.

    The other unit finishing is half the verdict: a build that loses a worker to
    a hang still runs the rest of its checks.
    """
    monkeypatch.setattr(checkunits, "UNIT_BUDGET_SECONDS", 2.0)
    model_project("""
        @checklib.check("endless")
        def check_endless():
            while True:
                pass

        @checklib.check("fine")
        def check_fine():
            pass
    """)

    started = time.monotonic()
    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))
    elapsed = time.monotonic() - started

    assert "endless" in str(raised.value)
    assert "still running after 2s" in str(raised.value)
    # Bounded by the budget and not by anything build-wide. Generous on the
    # upper side: this is two interpreter starts plus the budget.
    assert elapsed < 60.0
    out = capsys.readouterr().out
    assert "check units: 1 of 2 passed" in out
    assert "endless: 2.0s -- timed out" in out


def test_the_units_are_handed_out_in_random_order(model_project, monkeypatch):
    """A hidden dependency between two units has to surface on the build that
    introduces it, not on whichever later build happens to draw them the other
    way round.

    THROUGH A GENERATOR OF ITS OWN and not `random.shuffle`, which is what the
    stand-in below is asserting by its shape: the module-level one is seeded by
    whatever ran last, and `random.seed(...)` at the top of a model.py -- a
    perfectly ordinary line -- would pin this order for every build after.
    """
    shuffled = []
    monkeypatch.setattr(checkunits.random, "Random",
                        lambda: SimpleNamespace(shuffle=shuffled.append))
    model_project("""
        @checklib.check("one")
        def check_one():
            pass

        @checklib.check("two")
        def check_two():
            pass
    """)

    checkunits.run_units(CheckReport(0, 0))

    assert shuffled and sorted(shuffled[0]) == ["one", "two"]


def test_a_project_with_a_src_of_its_own_still_reaches_the_hub_in_a_worker(
        model_project, isolated_project, capsys):
    """THE LAYOUT THIS FEATURE IS MOST LIKELY TO MEET, and it used to lose every
    unit on it.

    `geometry.load_model` gives the project root the FIRST place on `sys.path`
    deliberately, so a repository that carries a directory called `src` -- about
    the most ordinary name there is -- owns that name for the rest of the
    process. `spawn` copies this process's `sys.path` into the worker, and the
    worker then has to `import src.cadbuild.checkunits` in a fresh interpreter
    to reach `_work` at all. Reproduced: `ModuleNotFoundError: No module named
    'src.cadbuild'` in every worker, `check units: 0 of 1 passed`, a build red
    for nothing its author wrote -- and the identical model, with the directory
    removed, green.

    THE PATH IS ALSO PUT BACK, and that half is asserted here because the fix
    is a context manager around `Process.start()` and nothing else would notice
    it leaking. The hub going in front is for the CHILD's benefit; this process
    has to go on being one where the project owns `src`, or every import the
    build makes after the units resolves somewhere new.
    """
    (isolated_project / "src").mkdir()
    (isolated_project / "src" / "__init__.py").write_text("", encoding="utf-8")
    model_project("""
        @checklib.check("lip joint")
        def check_lip():
            pass
    """)

    before = list(sys.path)
    assert checkunits.run_units(CheckReport(0, 0)) == CheckReport(1, 0)
    assert "check units: 1 passed" in capsys.readouterr().out
    assert sys.path == before, (
        "run_units left the hub root on this process's sys.path -- from here "
        "on, the project no longer owns the name `src` in the build that "
        "called it")


def test_a_worker_that_dies_mid_unit_does_not_take_the_other_units_with_it(
        model_project, capsys):
    """THE RESULTS CHANNEL IS PER WORKER, and this is what that buys.

    On one shared `multiprocessing.Queue` the writers share a lock held by a
    feeder THREAD, and a process killed while holding it leaves the semaphore
    taken for good: the messages of every SURVIVING worker stop arriving.
    Reproduced on one model -- three runs, three verdicts, a unit that had
    finished in three seconds reported "timed out", the one still running
    reported "lost", and a healthy worker SIGKILLed on the way out.

    The records are what makes this a test of the CHANNEL rather than of the
    count: they are filled in the surviving worker and have to be merged here,
    which is the same crossing the poisoned lock was breaking.
    """
    model_project("""
        from src.cadbuild import checklib as record

        @checklib.check("boom")
        def check_boom():
            import os
            import signal
            os.kill(os.getpid(), signal.SIGKILL)

        @checklib.check("one")
        def check_one():
            record._INTERFERENCE["a|one"] = 1.0

        @checklib.check("two")
        def check_two():
            record._INTERFERENCE["a|two"] = 2.0

        @checklib.check("three")
        def check_three():
            record._INTERFERENCE["a|three"] = 3.0
    """)

    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))

    assert "boom" in str(raised.value)
    assert "check units: 3 of 4 passed" in capsys.readouterr().out
    assert checklib.recorded_interference() == {
        "a|one": 1.0, "a|two": 2.0, "a|three": 3.0}


def test_a_worker_killed_mid_unit_is_reported_dead_rather_than_timed_out(
        model_project, capsys, monkeypatch):
    """A death is not a hang, and it used to be reported as one.

    `is_alive()` was asked only about ALL the workers at once, so a worker that
    died with a unit open while its neighbour was still working went unnoticed
    until the budget ran out. What the log then said -- "still running after
    120s, so the worker was killed" -- is false twice over: the process had been
    gone for two minutes, and the sentence sends its reader to look for an
    endless loop inside a check the OOM killer ended.

    The budget here is far longer than the test: a run that waits it out has not
    noticed the death at all, which is exactly the defect.
    """
    monkeypatch.setattr(checkunits, "UNIT_BUDGET_SECONDS", 60.0)
    model_project("""
        @checklib.check("oom")
        def check_oom():
            import os
            import signal
            os.kill(os.getpid(), signal.SIGKILL)

        @checklib.check("fine")
        def check_fine():
            pass
    """)

    started = time.monotonic()
    with pytest.raises(BuildError) as raised:
        checkunits.run_units(CheckReport(0, 0))
    elapsed = time.monotonic() - started

    message = str(raised.value)
    assert "killed by signal 9 (SIGKILL)" in message, (
        "the exit code is the first thing anybody asks for, and a signal "
        "number is the difference between an OOM kill and a check that raised")
    assert "did NOT run out of its" in message
    assert "still running after" not in message, "that is the timeout's words"
    assert elapsed < 30.0, (
        "the death was waited out on the budget instead of being noticed -- on "
        "prod that is 120 seconds of a build spent watching a dead process")
    out = capsys.readouterr().out
    assert "check units: 1 of 2 passed" in out
    assert "-- died" in out


def test_a_verdict_already_in_the_channel_beats_the_death_of_its_worker():
    """The one race the per-worker channel does not settle on its own.

    The parent reads ONE message per channel per round, so it can be a message
    behind -- a big `_merge_records`, or four builds' worth of processes on the
    host, is all it takes. It sees `_STARTED`; by then the worker has sent its
    result, taken the sentinel and exited. The next round therefore finds a unit
    outstanding on a worker that is gone, which is exactly the shape of a death,
    and without the `reader.poll()` guard it says so: `DIED` written over a
    verdict sitting unread in the pipe, the unit's records dropped, and a build
    failed on a unit that passed.

    NO PROCESS IS NEEDED TO STAGE IT, and that is why this test exists at all --
    the race is real but too narrow to provoke on demand, so it is assembled
    instead: `_collect` takes its workers and readers as arguments, and a closed
    pipe holding both messages with a worker that reports a clean exit IS the
    situation. Remove the two-line guard and this goes red at once.
    """
    reader, writer = multiprocessing.get_context("spawn").Pipe(duplex=False)
    writer.send((checkunits._STARTED, "lip"))
    writer.send((checkunits._DONE,
                 checkunits.UnitResult("lip", checkunits.PASSED, "", 0.1),
                 ({}, {}, {})))
    # The worker's end is gone AND its verdict is already in the channel, which
    # is the whole point: EOF and an unread result at the same instant.
    writer.close()

    gone = SimpleNamespace(is_alive=lambda: False, exitcode=0,
                           kill=lambda: None, join=lambda timeout=None: None)

    collected = checkunits._collect(["lip"], [gone], [reader])

    assert collected["lip"].status == checkunits.PASSED, (
        f"the unit was reported as {collected['lip'].status!r}: a worker that "
        f"exited right after sending its result was called a death, over a "
        f"verdict that was already in the channel")


def test_an_unknown_count_stays_unknown_when_the_units_are_added(model_project):
    """`passed=None` means "nobody could count this checks()", and adding a
    number to that would claim the total was known."""
    model_project("""
        @checklib.check("one")
        def check_one():
            pass
    """)

    assert checkunits.run_units(CheckReport(None, 0)) == CheckReport(None, 0)


# --------------------------------------------------------------------------
# How units count towards the number `checks()` is refused for
# --------------------------------------------------------------------------

def test_an_empty_checks_is_still_refused_when_the_model_has_no_units():
    def checks():
        pass

    with pytest.raises(BuildError, match="no check"):
        run_checks(_Model(checks), None)


def test_an_empty_checks_is_allowed_once_the_model_has_units():
    """A model half way through moving its checks into units keeps building.

    The refusal exists because "every run prints that the checks passed, for a
    model nothing looked at" -- and a model with units is one the build does
    look at, and counts.
    """
    @checklib.check("lip joint")
    def check_lip():
        pass

    def checks():
        pass

    assert run_checks(_Model(checks), None) == CheckReport(0, 0)


def test_an_empty_checks_with_units_counts_zero_rather_than_unknown():
    """0 is what was COUNTED here, and it is not the reserved 0 of the refusal.

    `passed=None` means "nobody could count this checks()", and a number added
    to it stays None -- so a model that had moved every check into units, which
    is exactly the model this refusal is waived for, reached metrics.json with
    `checks_passed: null` for eight checks and `report_metrics` could no longer
    say the project had lost one. The zero has to survive as a zero for
    `run_units` to have anything to add to.
    """
    @checklib.check("lip joint")
    def check_lip():
        pass

    def checks():
        pass

    report = run_checks(_Model(checks), None)
    assert report.passed == 0, "counted, and it came to nothing -- not unknown"


def test_an_all_static_checks_is_still_unknown_when_there_are_no_units():
    """The other side of the same line: 0 stays reserved for the refusal when
    the units are not there to make it an ordinary answer."""
    def checks():
        assert 2 > 1, "the parameter table, guarded"

    assert run_checks(_Model(checks), None) == CheckReport(None, 1)


class _Model:
    """A stand-in for model.py carrying only its checks()."""

    def __init__(self, checks):
        self.checks = checks
