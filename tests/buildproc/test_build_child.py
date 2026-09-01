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


def test_the_exit_codes_do_not_collide():
    """Every code this component assigns means exactly one thing.

    They are read by `runner._read_outcome` to decide what happened, and 1 is
    deliberately unassigned: `faulthandler.dump_traceback_later(exit=True)`
    exits with it after printing the stack, and that is the only way a 1 can
    come out of the child.
    """
    from src.buildproc.limits import WRAPPER_EXIT_CODES

    mine = {child.EXIT_OK, child.EXIT_HANG_DUMP, child.EXIT_BUILD_FAILED,
            child.EXIT_CRASHED, child.EXIT_INVOCATION, child.EXIT_UNCAPPED}
    assert len(mine) == 6
    assert not (mine & WRAPPER_EXIT_CODES)
    assert child.EXIT_HANG_DUMP == 1
