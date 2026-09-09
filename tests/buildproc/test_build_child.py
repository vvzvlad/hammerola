"""The build entry: what a real model.py does to `run_build`.

test_isolation.py and test_ceilings.py fence in a process that could be doing
anything. This file is about the one target the hub actually points that
machinery at -- `src.buildproc.child` -- and about the four answers it has to
be able to give: it built, the model does not build, the model never came back,
and something happened that is ours to look at rather than the pusher's.

Only two tests here need a CAD kernel. Everything else is arranged to fail
before `import cadquery` is ever reached, which is not a trick: a model that
does not import, hangs on import or ends the interpreter is a model the build
half never gets to, and those are the cases worth pinning cheaply.
"""

import io
import json
import re
import sys
import textwrap

import pytest

from src.buildproc import (
    STATUS_CRASHED,
    STATUS_FAILED,
    STATUS_HANG,
    STATUS_OK,
    STATUS_TIMEOUT,
)
from src.buildproc import child

from probes import (
    BUILD_LIMITS,
    TEST_LIMITS,
    block_import,
    needs_cadquery,
    needs_occt,
    payload,
)


# --------------------------------------------------------------------------
# the four answers
# --------------------------------------------------------------------------

@needs_cadquery
def test_a_simple_model_builds_and_reports_what_it_wrote(project):
    """The whole path, once, on real geometry.

    Everything else in this suite tests a fence around a process; this tests
    that the process inside the fence still does its job -- imports cadquery,
    meshes a box, passes the gates and writes `_out/`. The file list travels in
    a FILE rather than on stdout, because a model prints whatever it likes; the
    parent then checks every name in it against the output directory, because a
    model writes whatever it likes too (test_result_forgery.py).

    The `os.chdir` in the model is not decoration. A model.py is arbitrary code
    and may leave the working directory anywhere it likes; the project root is
    PINNED by the child (`paths.set_project_root`) rather than searched for
    from the working directory, and `source_fingerprints` -- which runs at the
    very end of the build, long after the model has had its way -- is the one
    piece of the build that would otherwise hash whatever tree it landed in.
    Unpinned, this build does not merely record the wrong fingerprint: it dies
    looking for a project.json above `/`.
    """
    outcome = project.build("""
        import os
        import cadquery as cq

        os.chdir("/")

        def parts():
            return {"body": {"shape": cq.Workplane("XY").box(20, 10, 5),
                             "kind": "printable"}}

        def views():
            return [
                {"id": "print", "name": "print", "parts": ["body"]},
                {"id": "assembled", "name": "assembled", "parts": ["body"]},
            ]
    """)

    assert outcome.status == STATUS_OK, outcome.log
    assert outcome.ok
    assert outcome.pid == "abc123def456"
    assert "meta.json" in outcome.files
    assert "body.stl" in outcome.files
    for name in outcome.files:
        assert (project.out / name).is_file(), f"{name} was reported but not written"
    assert "build ok: abc123def456" in outcome.log
    assert not outcome.log_truncated

    from src.cadbuild.metrics import source_fingerprints

    written = json.loads((project.out / "metrics.json").read_text(encoding="utf-8"))
    assert written["source"] == source_fingerprints(root=project.root), (
        "the build fingerprinted a directory that is not the one it was given")


def test_a_model_that_does_not_import_is_a_failed_build(project):
    """The pusher's problem, and it comes back with the reason.

    A distinct status from a crash on purpose: SPEC 8A.2 step 6 has the hub
    throwing the staging directory away and returning an error with the log,
    and "your model does not build" and "the hub broke" are answered
    differently -- one of them is a bug report.
    """
    outcome = project.build("""
        raise ValueError("the model is not ready")
    """)

    assert outcome.status == STATUS_FAILED
    assert outcome.exit_code == child.EXIT_BUILD_FAILED
    assert "the model is not ready" in outcome.log
    assert outcome.files == ()


def test_a_note_that_cannot_be_published_is_a_failed_build(project):
    """END TO END on what the note ceiling is actually FOR: the exit code.

    A note carrying a lone surrogate -- which arrives without malice, from
    `bytes.decode(errors="surrogateescape")` -- used to be accepted by the
    constructor and then raise UnicodeEncodeError from `print()` and from
    `json.dumps(..., ensure_ascii=False)`. Neither is a BuildError, so the
    branch above caught it as a BaseException and the build ended in
    EXIT_CRASHED: the hub reporting its OWN fault for a string the model wrote.
    Refused at the declaration, it is a ValueError raised while model.py is
    being imported, `geometry.load_model` turns that into a BuildError, and this
    is where that becomes a number.

    IT IS HERE AND NOT IN `tests/cadbuild/` because the exit code exists only
    here. Two tests over there used to carry this docstring between them and
    assert on message substrings instead -- neither could see a code, so nothing
    anywhere checked the one thing the story is about. What is left over there is
    the unit half: the door turns it into a BuildError
    (`test_model_doors.py::test_every_door_answers_for_the_model_in_build_error_terms[importing model.py at geometry.load_model]`)
    and the message names the model's line
    (`test_geometry.py::test_the_import_names_the_line_the_model_failed_on`).

    No kernel is needed: the model fails on its third line, long before anything
    reaches `import cadquery`.
    """
    outcome = project.build("""
        import checklib

        WALL = checklib.estimated(2.4, "\\ud800 decoded loosely")
    """)

    assert outcome.status == STATUS_FAILED, outcome.log
    assert outcome.exit_code == child.EXIT_BUILD_FAILED, (
        f"a note the model wrote ended the build with "
        f"{outcome.exit_code}; EXIT_CRASHED here is the hub reporting its own "
        f"fault for the pusher's string. Whole log:\n{outcome.log}")
    assert "not a printable character" in outcome.log
    assert outcome.files == ()


def test_a_model_that_never_returns_is_killed_by_the_wall_clock(project):
    """A build that hangs is a build that ends, and the hub says which it was."""
    limits = BUILD_LIMITS.replace(wall_seconds=3.0, hang_dump_seconds=None)
    outcome = project.build("""
        import time
        time.sleep(600)
    """, limits=limits)

    assert outcome.status == STATUS_TIMEOUT
    # Tight for the reason spelled out in test_ceilings.py: five seconds of
    # slack here would also pass with the kill removed, because the reap path
    # kills again when its grace runs out.
    assert outcome.duration_seconds < 7
    assert outcome.files == ()


def test_the_hang_dump_names_the_line_of_the_model_it_stuck_on(project):
    """Second echelon, and the only one that answers "where".

    SPEC 8A.2 step 4 asks for `faulthandler` specifically because it is
    implemented in C and does not take the GIL: a hang inside a native OCCT
    call never returns to the interpreter, so a watchdog thread and a signal
    handler both stay unscheduled while this one still prints.

    THE BUDGET HAS TO BE BIGGER THAN A LEGITIMATE START, and that is why the
    number here is twelve seconds rather than the 1.5 it used to be. The child
    arms the watchdog TWICE (child.py, steps 1 and 5) and each arming gets the
    whole budget, so a budget under the cost of the start is spent by the
    START's window: the dump then prints a stack inside runpy and the import
    machinery, which is a true report of a start that took longer than a build
    may hang for -- and not the thing this test is about.

    Measured on this workstation, a start costs 0.8-1.8 s quiet, 2.4-3.9 s with
    the cores oversubscribed, and 4.2-7.6 s at a load average of 300 on ten
    cores; nearly all of it is the OCP import inside `_cap_occt_threads`. At
    1.5 s that lost the race two runs in three under ordinary load. Twelve is
    three times the realistic worst and still over the pathological one, and the
    test costs about that long on every run, because a watchdog can only be
    observed by waiting for it. The cheap half of the same change is the test
    below, which pins the arming ORDER without waiting for anything.
    """
    limits = BUILD_LIMITS.replace(wall_seconds=30.0, hang_dump_seconds=12.0)
    outcome = project.build("""
        import time

        def a_boolean_that_never_finishes():
            time.sleep(600)

        a_boolean_that_never_finishes()
    """, limits=limits)

    assert outcome.status == STATUS_HANG, outcome.log
    assert "Timeout (" in outcome.log
    assert "a_boolean_that_never_finishes" in outcome.log
    assert "model.py" in outcome.log


def test_the_hang_budget_is_armed_again_where_the_model_starts(
        project, run_program, tmp_path):
    """`hang_dump_seconds` means "the model has been stuck this long".

    It used to mean "this process has existed this long", because the only
    arming was the first line of `child.main` -- before the OCP import in
    `_cap_occt_threads`, before the chdir, before the build half is imported.
    Whatever that start cost came out of the model's budget, and on a hub that
    is now the builder and runs several of these at once it can cost more than
    the budget outright: the dump then fires during the child's OWN start and
    the pusher is handed a build log accusing their model of a hang that never
    happened.

    Written against the ORDER of the two armings rather than against a stack,
    because the order is the whole change and it can be pinned without waiting
    for a timer: the budget here is deliberately smaller than the start and is
    never allowed to go off. That the SECOND arming is the one in force is a
    property of `faulthandler` itself -- `dump_traceback_later` cancels the
    pending timer before arming a new one, so calling it twice replaces rather
    than accumulates -- and the end-to-end proof that a dump really does name
    the model's line is the test above.

    The slow start is injected rather than waited for. On this workstation the
    real one costs 0.8-3.9 s (see the test above) and would make the point on
    its own; in the CI container there is no usable OCP at all, so without the
    injection the start is fast enough that a test written here would pass
    against the broken code.
    """
    budget = 0.5
    slow = 1.0
    (project.root / "model.py").write_text(
        "import time\n"
        "raise ValueError('MODEL_STARTED %r' % time.time())\n",
        encoding="utf-8")

    result = run_program(textwrap.dedent("""
        import json, sys, time

        hub_root, project_dir, out_dir, result_file, budget, slow = sys.argv[1:]
        sys.path.insert(0, hub_root)

        import faulthandler
        from src.buildproc import child

        # Armed, never fired. A real timer with this budget would end the
        # process during the slow start below -- which is exactly the bug, and
        # a dead process cannot report when it was armed.
        armed = []
        faulthandler.dump_traceback_later = lambda timeout, **kw: armed.append(
            {"at": time.time(), "timeout": timeout, "exit": kw.get("exit")})

        # Stands in for the OCP import the real one does, which is where a
        # start spends its seconds.
        capped, prep = child._cap_occt_threads, {}
        def slow_start(count):
            prep["started"] = time.time()
            time.sleep(float(slow))
            try:
                return capped(count)
            finally:
                prep["finished"] = time.time()
        child._cap_occt_threads = slow_start

        code = child.main(["child", "--project", project_dir, "--out", out_dir,
                           "--result", result_file,
                           "--hang-dump-seconds", budget])
        print("PAYLOAD " + json.dumps({"armed": armed, "prep": prep, "code": code}))
    """), limits=BUILD_LIMITS, args=(
        str(child.HUB_ROOT), str(project.root), str(project.out),
        str(tmp_path / "result.json"), str(budget), str(slow)))

    data = payload(result)
    assert data["code"] == child.EXIT_BUILD_FAILED, result.log
    started = re.search(r"MODEL_STARTED ([0-9.]+)", result.log)
    assert started, result.log
    model_started = float(started.group(1))

    armed, prep = data["armed"], data["prep"]
    assert len(armed) == 2, (
        "the watchdog was armed once, at the birth of the process, so its "
        "budget was already being spent while the child was still starting")
    # Both windows get the WHOLE budget: the first covers the start, which is
    # the one place a hang has nothing else watching it, and the second covers
    # the model. Sharing one budget between them would give the model less of
    # it the slower the host is.
    assert [one["timeout"] for one in armed] == [budget, budget]
    assert [one["exit"] for one in armed] == [True, True]

    # The start, all of it, sits between the two -- and it outlasts the budget,
    # so on the first arming alone the deadline had passed before model.py was
    # so much as read.
    assert armed[0]["at"] <= prep["started"]
    assert armed[1]["at"] >= prep["finished"]
    assert model_started - armed[0]["at"] > budget

    # ...and the second arming is the model's own: nothing but `load_project`
    # and the import of model.py stands between it and the first line of
    # somebody else's code. Measured against the start rather than against a
    # constant, because everything here stretches together on a loaded host and
    # a constant would be this test's own flake.
    assert armed[1]["at"] <= model_started
    assert model_started - armed[1]["at"] < prep["finished"] - prep["started"]


def test_a_model_that_closes_the_log_is_not_reported_as_a_hang(project):
    """EXIT 1 IS SHARED, and this is the ordinary way a build lands on it.

    `EXIT_HANG_DUMP` is 1 because that is what `faulthandler` exits with -- and
    1 is also what the interpreter exits with on an exception nobody caught. So
    any raise that escapes `child.main` is read by `runner` as STATUS_HANG, and
    the author is told the build stopped responding and its stack is in the log.
    That is the HUB reporting the wrong thing about its own crash, and it sends
    a person looking for a thread that is not stuck.

    THE MODEL HERE CLOSES ITS OWN LOG, which is one line somebody writes without
    meaning anything by it (a `with` around `sys.stdout`, a redirect that got
    away). From then on every `print` in the child raises: the build's first
    `print` fails, the handler reporting it calls `traceback.print_exc()`, that
    fails too, and the interpreter exits 1.

    OF THE THREE GUARDS ON THAT PATH exactly ONE is load-bearing here, measured
    in every combination rather than inferred. `_say`'s `try` and the blanket
    handler in `child.main` can both be deleted, TOGETHER, and this still
    passes; replace `_print_exc_quietly`'s body with a bare
    `traceback.print_exc()` and this fails with `status 'hang', exit 1`. So this
    test is the SOLE witness for that one guard and no witness at all for the
    other two, which the two tests below supply one guard at a time, each of
    them removable-and-red.

    THE LOG IS EMPTY ON PURPOSE and nothing here asserts otherwise: the model
    closed it. The exit code is the whole of what survives, which is exactly why
    it has to be the right one.
    """
    outcome = project.build("""
        import sys

        sys.stdout.close()
        sys.stderr.close()

        def parts():
            raise RuntimeError("the model's own fault")

        def views():
            return []
    """)

    assert outcome.status == STATUS_CRASHED, (
        f"status {outcome.status!r}, exit {outcome.exit_code}; STATUS_HANG here "
        f"sends the author after a build that is not stuck. Whole log:\n"
        f"{outcome.log}")
    assert outcome.exit_code == child.EXIT_CRASHED
    assert outcome.files == ()


class _NotAnException(BaseException):
    """Off the `Exception` branch on purpose -- see the test below."""


def test_the_blanket_handler_in_main_answers_for_anything_at_all(monkeypatch):
    """`child.main` on its own, with the thing it wraps made to raise.

    ISOLATING, WHICH IS THE POINT. The end-to-end test above goes through a real
    build and three guards, so it stays green with this one deleted; nothing
    then holds the property the exit-code comment claims -- that a bug ANYWHERE
    under `main` is a crash and never a 1. Here `_run` is the only thing in the
    way, and what it raises is the shape a `except Exception` would let past.

    `BaseException` AND NOT `Exception` is the half worth isolating. The parent
    reads 1 as the watchdog, and the interpreter exits 1 for a `MemoryError` or
    a `RecursionError` -- both `Exception`s -- but also for anything off that
    branch, and a narrower handler here would report the second kind as a stuck
    build with no stack in the log.
    """
    def refuse(argv):
        raise _NotAnException("a bug nobody foresaw")

    monkeypatch.setattr(child, "_run", refuse)

    assert child.main(["child", "--project", "/tmp"]) == child.EXIT_CRASHED


def test_the_log_line_never_raises_even_with_nowhere_to_write(monkeypatch):
    """`_say` on its own, with nowhere left to write.

    ISOLATING for the same reason: the blanket handler above would turn a raise
    from here into EXIT_CRASHED anyway, which is the right code for the wrong
    reason -- the build would stop at whatever line was being logged, and the
    lines after it would never be written. `_say` is on the failure path
    precisely so that reporting a failure cannot become the failure.

    `sys.stderr` closed rather than replaced by a raising object, because that
    is what really happens -- `sys.stderr.close()` is one line of somebody's
    model, and the child inherits the model's interpreter.
    """
    closed = io.StringIO()
    closed.close()
    monkeypatch.setattr(sys, "stderr", closed)

    child._say("a line with nowhere to go")  # must not raise


def test_a_model_that_exits_zero_without_building_is_not_a_success(project):
    """The exit code is not the answer; the result file is.

    A model runs before `build()` finishes anything, and `os._exit(0)` from its
    own import ends the process with the code of a job well done. If the hub
    read that zero as success it would publish an empty staging directory over
    a working build -- so success is a result file the child wrote after the
    build returned, and this is what says so.
    """
    outcome = project.build("""
        import os
        os._exit(0)
    """)

    assert outcome.exit_code == 0
    assert outcome.status == STATUS_CRASHED
    assert outcome.files == ()
    assert "no readable result" in outcome.log


# --------------------------------------------------------------------------
# what the model can and cannot see
# --------------------------------------------------------------------------

def test_the_model_cannot_read_the_hubs_token(project, hub_secrets):
    """The environment test of test_isolation.py, from inside a real model.

    Worth having twice: that one proves `child_environment` composes the right
    dictionary, this one proves the dictionary is what a model.py actually
    runs with -- through the wrapper, the exec and the chdir.
    """
    outcome = project.build("""
        import os
        raise RuntimeError("token=%r decoy=%r" % (
            os.environ.get("EDIT_TOKEN"),
            os.environ.get("AWS_SECRET_ACCESS_KEY")))
    """)

    assert outcome.status == STATUS_FAILED
    assert "token=None decoy=None" in outcome.log
    for value in hub_secrets.values():
        assert value not in outcome.log


def test_the_build_starts_in_the_models_own_directory(project):
    """The working directory is part of the contract with a model.

    Nine projects are written against this package (src/cadbuild/__init__.py)
    and they read their own files -- meshes, profiles, a CSV of hole positions
    -- by relative path, because until this step they ran from a checkout on
    somebody's laptop. The child chdirs into the unpacked tree so that keeps
    working; without it every one of those reads resolves inside the hub.
    """
    (project.root / "beside-the-model.txt").write_text("here", encoding="utf-8")

    outcome = project.build("""
        import os
        raise ValueError("cwd=%s beside=%r" % (
            os.getcwd(), open("beside-the-model.txt").read()))
    """)

    assert outcome.status == STATUS_FAILED
    assert f"cwd={project.root.resolve()} " in outcome.log
    assert "beside='here'" in outcome.log


# --------------------------------------------------------------------------
# the OCCT thread pool
# --------------------------------------------------------------------------

@needs_occt
def test_the_occt_pool_is_capped_before_the_model_runs(project):
    """...and the model sees the capped pool, not the default one.

    The default takes one thread per logical core, and RLIMIT_CPU is summed
    over threads: uncapped, on a twenty-core host, a CPU ceiling fires twenty
    times sooner than its number suggests -- which reads as "the build is too
    slow" and gets the ceiling raised instead.
    """
    outcome = project.build("""
        from OCP.OSD import OSD_ThreadPool
        raise ValueError("pool=%d" % OSD_ThreadPool.DefaultPool_s().NbThreads())
    """, limits=BUILD_LIMITS.replace(occt_threads=2))

    assert "buildproc: OCCT thread pool capped at 2" in outcome.log
    assert "pool=2" in outcome.log, outcome.log


def test_a_pool_that_refuses_to_be_capped_stops_the_build(monkeypatch):
    """OCP present and uncapped is the case that must not be waved through.

    The CPU ceiling was sized against a capped pool. An OCP that imports but
    will not be held to a thread count leaves that arithmetic wrong in the
    dangerous direction, so the build does not start.
    """
    class Refuses:
        @staticmethod
        def DefaultPool_s(_count):
            raise RuntimeError("active thread pool can not be resized")

    monkeypatch.setitem(sys.modules, "OCP.OSD",
                        type(sys)("OCP.OSD"))
    sys.modules["OCP.OSD"].OSD_ThreadPool = Refuses

    with pytest.raises(RuntimeError, match="would not be capped"):
        child._cap_occt_threads(2)


def test_no_usable_occt_is_not_a_refusal(monkeypatch, capsys):
    """An interpreter with no usable kernel is not a hole -- there is no pool to
    cap and no model can compute anything either. It says so and carries on.

    BOTH ways that happens are here, because they arrive as different
    exceptions and only the second one is easy to get wrong. `name == "OCP"` is
    what they share, and it is the whole rule.

      * not installed: `ModuleNotFoundError(name="OCP")`.
      * installed and refusing to load: plain `ImportError(name="OCP")`. This is
        the CI test container, measured -- `python:3.11-slim` with
        requirements.txt but without the system libraries the Dockerfile adds
        gives `libGL.so.1: cannot open shared object file` for `import OCP`, and
        `import cadquery` fails identically. Reading THAT as a refusal turns the
        whole suite red in the one environment it is supposed to run in.

    Simulated with a meta-path blocker rather than with `sys.modules` (see
    `probes.block_import`): the sys.modules trick produces an exception naming
    `OCP.OSD`, which is the opposite verdict.
    """
    block_import(monkeypatch, "OCP")
    assert child._cap_occt_threads(2) is None
    assert "no usable OCP in this interpreter" in capsys.readouterr().err

    block_import(monkeypatch, "OCP", error=ImportError(
        "libGL.so.1: cannot open shared object file: No such file or directory",
        name="OCP"))
    assert child._cap_occt_threads(2) is None
    assert "libGL.so.1" in capsys.readouterr().err


class _Answering:
    """A thread pool that lets itself be capped, standing in for the real one.

    It exists to be REACHED BY MISTAKE. Planted in `sys.modules["OCP.OSD"]`, it
    is what a stale submodule left behind by an earlier test looks like from
    inside `_cap_occt_threads` -- so a test that forgets to remove one gets a
    number back instead of the refusal it asserts, and fails.
    """

    @staticmethod
    def DefaultPool_s(count):
        return _Answering()

    @staticmethod
    def NbThreads():
        return 2


def test_an_occt_that_loaded_but_hides_its_pool_is_not_read_as_no_occt(monkeypatch):
    """OCP LOADED and its thread pool out of reach is a REFUSAL, not a shrug.

    The distinction the old `except Exception` could not make, and it fails in
    the dangerous direction: OCP having loaded means the kernel is in this
    interpreter, so a pool comes up at one thread per core the moment cadquery
    touches it -- against an RLIMIT_CPU sized for `occt_threads`. On a
    twenty-core host that ceiling then fires ten times sooner than its number
    says, and the build dies with nothing in the log to connect the two.

    Both shapes are covered because they arrive as different exceptions, and
    what makes them the same verdict is that neither names `OCP`: a submodule
    that will not import (`ModuleNotFoundError(name="OCP.OSD")`) and a module
    whose symbol is gone (`ImportError(name="OCP.OSD")`, which is a version
    skew).
    """
    # THE SUBMODULE HAS TO GO FIRST, and the two lines below are the whole of a
    # failure that pre-dated the numbers work: `from OCP.OSD import
    # OSD_ThreadPool` is answered out of `sys.modules["OCP.OSD"]` without the
    # import system ever looking at the parent, so replacing `OCP` alone did
    # nothing whenever some earlier test in the same process had imported the
    # real kernel. This test then capped the REAL pool at two threads and
    # reported DID NOT RAISE.
    #
    # THE STALE SUBMODULE IS PLANTED HERE RATHER THAN WAITED FOR, and that is
    # what makes the `delitem` load-bearing on every run instead of on the
    # unlucky ones. Without the plant this test passed in a CI container with no
    # OCP whether the deletion was there or not -- the line was correct and
    # nothing held it, so deleting it went green and the failure came back the
    # next time a workstation ran the suite in a different order. `_Answering`
    # stands in for the real pool: reached, it caps and returns, and the
    # `pytest.raises` below fails.
    stale = type(sys)("OCP.OSD")
    stale.OSD_ThreadPool = _Answering
    monkeypatch.setitem(sys.modules, "OCP.OSD", stale)
    # `raising=False` because the ordinary case is a CI container with no OCP at
    # all -- and, now, because the line above may be the only reason it is there.
    monkeypatch.delitem(sys.modules, "OCP.OSD", raising=False)
    # An OCP that is there and is not a package: importing OCP.OSD off it fails
    # with `name == "OCP.OSD"`, which is the first shape.
    monkeypatch.setitem(sys.modules, "OCP", type(sys)("OCP"))
    with pytest.raises(RuntimeError, match="pool could not be reached"):
        child._cap_occt_threads(2)

    # ...and one where the submodule imports but carries no OSD_ThreadPool.
    package = type(sys)("OCP")
    package.__path__ = []
    monkeypatch.setitem(sys.modules, "OCP", package)
    monkeypatch.setitem(sys.modules, "OCP.OSD", type(sys)("OCP.OSD"))
    with pytest.raises(RuntimeError, match="pool could not be reached"):
        child._cap_occt_threads(2)


# --------------------------------------------------------------------------
# invocation
# --------------------------------------------------------------------------

def test_the_child_refuses_an_invocation_it_does_not_understand(capsys):
    """A distinct exit code, because this one is a bug in the HUB.

    `run_build` composes the command line; a model contributes a directory path
    to it and nothing else. So a parse failure here can only mean the two
    halves of this component have drifted apart, and it must not arrive looking
    like a model that failed to build.
    """
    assert child.main(["child", "--project", "/tmp"]) == child.EXIT_INVOCATION
    assert "--out is required" in capsys.readouterr().err

    assert child.main(["child", "--nonsense", "x"]) == child.EXIT_INVOCATION
    assert "unknown option" in capsys.readouterr().err


def test_the_force_flag_arrives_as_a_value_and_leaves_as_a_boolean(tmp_path,
                                                                   monkeypatch):
    """The one option that comes from a person, all the way to the child's argv.

    `--force` starts as a flag on the command line the author typed and has to
    end up in the command line the hub composes for this process — and this
    parser takes `--key value` pairs and understands no bare flags, so the
    boolean lives in a VALUE. Both halves are held here: what `run_build` puts
    in the argv, and what `_parse` makes of it.

    The process is never started: `run_isolated` is replaced by something that
    records the command and reports a failed build, because what is under test
    is the composition and not the build.
    """
    from src.buildproc import runner

    composed = []

    def recording_run_isolated(target_argv, **kw):
        composed.append(list(target_argv))
        return runner.ProcessResult(
            exit_code=child.EXIT_BUILD_FAILED, signal=None, timed_out=False,
            log="", log_truncated=False, dropped_bytes=0,
            duration_seconds=0.0, stragglers=False)

    monkeypatch.setattr(runner, "run_isolated", recording_run_isolated)
    for force in (True, False):
        runner.run_build(tmp_path, tmp_path / "out", pid="abc123def456",
                         limits=TEST_LIMITS, force=force)

    forced, ordinary = composed
    assert forced[forced.index("--force") + 1] == "true"
    assert ordinary[ordinary.index("--force") + 1] == "false"

    # ...and the other end of that pair of strings.
    required = ["--project", "/tmp", "--out", "/tmp/out", "--result", "/tmp/r"]
    assert child._parse(required + ["--force", "true"])["force"] is True
    assert child._parse(required + ["--force", "false"])["force"] is False
    # Absent, because the value carries the boolean and nothing else does.
    assert child._parse(required)["force"] is False
    with pytest.raises(ValueError, match="--force takes true or false"):
        child._parse(required + ["--force", "1"])


def test_the_exit_codes_do_not_collide():
    """Every code this component assigns means exactly one thing.

    They are read by `runner._read_outcome` to decide what happened, and 1 is
    deliberately unassigned: `faulthandler.dump_traceback_later(exit=True)`
    exits with it after printing the stack.

    IT IS NOT THE ONLY WAY A 1 CAN COME OUT, which this used to say and which
    `child.py`'s own comment on the codes contradicts: the interpreter exits 1
    on an uncaught exception too, so 1 is SHARED and "the watchdog fired" is
    what the child's guards make true rather than what the number means. The
    two isolating tests above are where that is held; here the assertion is
    only that nothing this component ASSIGNS collides with it.
    """
    from src.buildproc.limits import WRAPPER_EXIT_CODES

    mine = {child.EXIT_OK, child.EXIT_HANG_DUMP, child.EXIT_BUILD_FAILED,
            child.EXIT_CRASHED, child.EXIT_INVOCATION, child.EXIT_UNCAPPED}
    assert len(mine) == 6
    assert not (mine & WRAPPER_EXIT_CODES)
    assert child.EXIT_HANG_DUMP == 1
