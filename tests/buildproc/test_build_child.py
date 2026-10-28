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
from pathlib import Path

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
    """A note the build cannot publish exits EXIT_BUILD_FAILED, not EXIT_CRASHED.

    A lone surrogate (from `bytes.decode(errors="surrogateescape")`) is refused
    at the declaration as a ValueError while model.py is imported, and
    `geometry.load_model` turns it into a BuildError. This test holds the exit
    code; the unit halves are in tests/cadbuild
    (`test_model_doors.py::test_every_door_answers_for_the_model_in_build_error_terms[importing model.py at geometry.load_model]`
    and `test_geometry.py::test_the_import_names_the_line_the_model_failed_on`).

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
    """The hang dump names the line of the model it stuck on.

    SPEC 8A.2 step 4 asks for `faulthandler` because it is implemented in C and
    does not take the GIL: a hang inside a native OCCT call never returns to the
    interpreter, so a watchdog thread or a signal handler stays unscheduled
    while this one still prints.

    The budget has to exceed a legitimate start: the child arms the watchdog
    twice (child.py, steps 1 and 5) with the whole budget each time, so a budget
    below the start cost fires inside runpy and the import machinery. A start
    measured 0.8-1.8 s quiet, 2.4-3.9 s with the cores oversubscribed and
    4.2-7.6 s at a load average of 300 on ten cores, nearly all of it the OCP
    import in `_cap_occt_threads`; twelve seconds covers that. The test below
    pins the arming order without waiting.
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

    The watchdog is re-armed after the child's own start (the OCP import in
    `_cap_occt_threads`, the chdir, importing the build half), so a slow start
    neither comes out of the model's budget nor gets reported as a model hang.

    Pinned by the order of the two armings rather than by a stack: the budget
    here is smaller than the injected start and must never fire.
    `dump_traceback_later` cancels the pending timer before arming a new one,
    so the second arming is the one in force; the test above proves a dump
    names the model's line. The slow start is injected so the test also bites
    on a machine with no usable OCP, where the start is fast.
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
    """A model that closes its own log is reported as a crash, not a hang.

    `EXIT_HANG_DUMP` is 1 because that is what `faulthandler` exits with, and 1
    is also what the interpreter exits with on an uncaught exception, which
    `runner` would read as STATUS_HANG. Here the model closes its own log, so
    every later `print` in the child raises, including the handler's
    `traceback.print_exc()`.

    Of the three guards on that path only `_print_exc_quietly` is held by this
    test (measured by removing each); the two tests below hold `_say` and the
    blanket handler in `child.main`. The log is empty because the model closed
    it; the exit code is all that survives.
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

    Projects written against this package (src/cadbuild/__init__.py) read their
    own files -- meshes, profiles, a CSV of hole positions -- by relative path.
    The child chdirs into the unpacked tree so those reads resolve there rather
    than inside the hub.
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

    Both ways that happens are here, because they arrive as different
    exceptions; `name == "OCP"` is what they share, and it is the whole rule.

      * not installed: `ModuleNotFoundError(name="OCP")`.
      * installed and refusing to load: plain `ImportError(name="OCP")`, as on a
        bare `python:3.11-slim` with requirements.txt but without the system
        libraries the Dockerfile adds (`libGL.so.1: cannot open shared object
        file`). Reading that as a refusal would fail the suite on every machine
        where the kernel is installed but cannot load.

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

    It fails in the dangerous direction: OCP having loaded means the kernel is
    in this interpreter, so a pool comes up at one thread per core the moment
    cadquery touches it -- against an RLIMIT_CPU sized for `occt_threads`. On a
    twenty-core host that ceiling then fires ten times sooner than its number
    says, with nothing in the log to connect the two.

    Both shapes are covered because they arrive as different exceptions, and
    what makes them the same verdict is that neither names `OCP`: a submodule
    that will not import (`ModuleNotFoundError(name="OCP.OSD")`) and a module
    whose symbol is gone (`ImportError(name="OCP.OSD")`, which is a version
    skew).
    """
    # The submodule has to go: `from OCP.OSD import OSD_ThreadPool` is answered
    # from `sys.modules["OCP.OSD"]` without looking at the parent, so replacing
    # `OCP` alone does nothing once an earlier test imported the real kernel.
    # A stale submodule is planted so the `delitem` is exercised on every run,
    # not only in an unlucky test order; `_Answering` stands in for the real
    # pool, and reaching it makes the `pytest.raises` below fail.
    stale = type(sys)("OCP.OSD")
    stale.OSD_ThreadPool = _Answering
    monkeypatch.setitem(sys.modules, "OCP.OSD", stale)
    # `raising=False` because the ordinary case is a machine with no importable
    # OCP at all -- and, now, because the line above may be the only reason it is
    # there.
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


def test_the_baseline_reaches_the_child_as_a_copy_in_its_own_scratch(tmp_path,
                                                                     monkeypatch):
    """A COPY, NEVER THE PATH IN THE STORE, and the copy is made in the parent.

    Two things ride on that and neither is visible from the child's side. The
    slot is replaced by a pair of renames (`store._swap_dev_slot`), so a
    parallel build of the same project can swap it halfway through this one and
    a path held into the store would be read as something third. And the copy is
    taken BEFORE the child starts, while the publish that overwrites the slot
    happens after the build returns — which is what makes a `dev` build compare
    against the PREVIOUS `dev` instead of against itself.

    A baseline that cannot be copied costs the comparison and not the build: the
    child is started with no `--baseline` at all, which is the ordinary "nothing
    to compare against" branch.

    The process is never started, as in the `--force` test above: what is under
    test is the composition.
    """
    from src.buildproc import runner

    composed = []

    def recording_run_isolated(target_argv, **kw):
        argv = list(target_argv)
        if "--baseline" in argv:
            # READ WHILE THE CALL IS STILL RUNNING, because scratch is removed
            # in `run_build`'s `finally` — so this is the only moment the copy
            # exists at all, and that it exists is half of what is asserted.
            named = Path(argv[argv.index("--baseline") + 1])
            composed.append((argv, named, named.read_bytes()))
        else:
            composed.append((argv, None, None))
        return runner.ProcessResult(
            exit_code=child.EXIT_BUILD_FAILED, signal=None, timed_out=False,
            log="", log_truncated=False, dropped_bytes=0,
            duration_seconds=0.0, stragglers=False)

    monkeypatch.setattr(runner, "run_isolated", recording_run_isolated)
    slot = tmp_path / "dev" / "metrics.json"
    slot.parent.mkdir()
    slot.write_bytes(b'{"version": 1, "parts": {}}\n')

    for baseline in (slot, tmp_path / "dev" / "nothing-here.json", None):
        runner.run_build(tmp_path, tmp_path / "out", pid="abc123def456",
                         limits=TEST_LIMITS, baseline=baseline)

    (_argv, named, content), (missing, _n, _c), (absent, _n2, _c2) = composed
    assert named != slot, "the child was pointed at the file in the store"
    assert content == slot.read_bytes()
    # SCRATCH, and this is what says so rather than the name of the directory.
    # `run_build` removes it in its `finally`, so a copy that is gone once the
    # call has returned was in the parent's scratch; one that survives was put
    # somewhere that outlives the build -- `out`, say, which is the tree the hub
    # publishes, and where an extra file is a file the author never wrote.
    assert not named.exists(), (
        "the copy outlived the build, so it was not made in the scratch that "
        "is torn down with it")
    assert named.parent != tmp_path / "out"
    assert "--baseline" not in missing, (
        "a baseline that could not be copied has to leave the option off "
        "entirely, not name a file the child cannot open")
    assert "--baseline" not in absent

    # ...and the other end of that string: the child takes it as an ordinary
    # `--key value` pair, and its absence is None rather than an error.
    required = ["--project", "/tmp", "--out", "/tmp/out", "--result", "/tmp/r"]
    assert child._parse(required + ["--baseline", "/s/b.json"])["baseline"] == \
        "/s/b.json"
    assert child._parse(required)["baseline"] is None


def test_the_child_hands_the_parsed_baseline_on_to_the_build(tmp_path,
                                                             monkeypatch):
    """`_run` passes `baseline=opts["baseline"]` on to the build.

    The other links of the baseline wire are pinned elsewhere: the slot's path
    (`store.dev_metrics_path`), the copy and the command line (the test above),
    `_parse`, the worker's call (`tests/test_jobs.py`), and `build()`'s call to
    `report_metrics`.

    `_run` is called in this process, unlike the rest of this suite, because
    what is checked is an argument passed between two functions and a real
    child would need a CAD kernel. The steps past the call are replaced --
    capping the OCCT pool, absolutising `sys.path`, and arming `faulthandler`
    (which would leave this process's fatal-signal handler on a captured stderr
    pytest closes) -- and what `_run` mutates besides (the working directory,
    `paths._root`) is restored by `monkeypatch`.

    `src.cadbuild.build` imports no cadquery at module scope, so importing it
    here keeps the autouse kernel fixture in conftest satisfied.
    """
    from src.cadbuild import build as build_module
    from src.cadbuild import paths

    handed = []

    def recording_build(out_dir, **keywords):
        handed.append(keywords)
        return "abc123def456", {}, ["model.stl"]

    monkeypatch.setattr(child, "_cap_occt_threads", lambda threads: None)
    monkeypatch.setattr(child, "_absolutise_sys_path", lambda: None)
    monkeypatch.setattr(child.faulthandler, "enable", lambda: None)
    monkeypatch.setattr(build_module, "build", recording_build)
    # Restored to what it is now (None) whatever `paths.set_project_root` inside
    # `_run` leaves behind: tests/cadbuild's autouse fixture fails the NEXT
    # test in the session over state this one left, and this directory sorts
    # before that one.
    monkeypatch.setattr(paths, "_root", None)
    monkeypatch.chdir(tmp_path)

    out = tmp_path / "out"
    out.mkdir()
    copy = tmp_path / "scratch-copy.json"
    argv = ["buildproc", "--project", str(tmp_path), "--out", str(out),
            "--result", str(tmp_path / "result.json")]

    assert child._run(argv + ["--baseline", str(copy)]) == child.EXIT_OK
    assert child._run(argv) == child.EXIT_OK

    named, absent = handed
    assert named.get("baseline") == str(copy), (
        "the child parsed --baseline and then did not pass it on, so no build "
        "on the hub compares against anything")
    assert absent.get("baseline", "not passed at all") is None, (
        "no --baseline has to reach `build()` as None -- the branch that says "
        "there is nothing to compare against -- and not as a missing argument")


def test_the_distance_cache_is_installed_before_the_build_and_counted_after(
        tmp_path, monkeypatch, capsys):
    """`--distance-cache` from `run_build`'s argv to `distcache.install` in the child.

    The path in the store goes over as it is, unlike the baseline: the cache
    outlives the build. The composition is checked with the process never
    started, and `_run` in this process with the same replacements as the
    baseline test above; `distcache` imports no kernel at module scope.
    """
    from src.buildproc import runner
    from src.cadbuild import build as build_module
    from src.cadbuild import distcache, paths

    composed = []

    def recording_run_isolated(target_argv, **kw):
        composed.append(list(target_argv))
        return runner.ProcessResult(
            exit_code=child.EXIT_BUILD_FAILED, signal=None, timed_out=False,
            log="", log_truncated=False, dropped_bytes=0,
            duration_seconds=0.0, stragglers=False)

    monkeypatch.setattr(runner, "run_isolated", recording_run_isolated)
    cache = tmp_path / "cache" / "distance.sqlite"
    for distance_cache in (cache, None):
        runner.run_build(tmp_path, tmp_path / "out", pid="abc123def456",
                         limits=TEST_LIMITS,
                         distance_cache=distance_cache)
    named, absent = composed
    assert named[named.index("--distance-cache") + 1] == str(cache)
    assert "--distance-cache" not in absent

    events = []

    def recording_build(out_dir, **keywords):
        events.append("build")
        return "abc123def456", {}, ["model.stl"]

    monkeypatch.setattr(child, "_cap_occt_threads", lambda threads: None)
    monkeypatch.setattr(child, "_absolutise_sys_path", lambda: None)
    monkeypatch.setattr(child.faulthandler, "enable", lambda: None)
    monkeypatch.setattr(build_module, "build", recording_build)
    monkeypatch.setattr(distcache, "install",
                        lambda path: events.append(f"install {path}"))
    monkeypatch.setattr(distcache, "counts", lambda: (2, 3))
    monkeypatch.setattr(paths, "_root", None)
    monkeypatch.chdir(tmp_path)

    argv = ["buildproc", "--project", str(tmp_path), "--out",
            str(tmp_path / "out"), "--result", str(tmp_path / "result.json")]
    assert child._run(argv + ["--distance-cache", str(cache)]) == child.EXIT_OK
    assert events == [f"install {cache}", "build"]
    assert ("distance cache: 2 of 3 distances answered from the cache"
            in capsys.readouterr().err)
    assert child._parse(argv[1:])["distance_cache"] is None


def test_the_exit_codes_do_not_collide():
    """Every code this component assigns means exactly one thing.

    They are read by `runner._read_outcome` to decide what happened, and 1 is
    deliberately unassigned: `faulthandler.dump_traceback_later(exit=True)`
    exits with it after printing the stack. The interpreter also exits 1 on an
    uncaught exception; the isolating tests above hold that the child's guards
    prevent that. Here the assertion is only that nothing this component
    assigns collides with 1.
    """
    from src.buildproc.limits import WRAPPER_EXIT_CODES

    mine = {child.EXIT_OK, child.EXIT_HANG_DUMP, child.EXIT_BUILD_FAILED,
            child.EXIT_CRASHED, child.EXIT_INVOCATION, child.EXIT_UNCAPPED}
    assert len(mine) == 6
    assert not (mine & WRAPPER_EXIT_CODES)
    assert child.EXIT_HANG_DUMP == 1
