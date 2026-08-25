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
import sys

import pytest

from src.buildproc import (
    STATUS_CRASHED,
    STATUS_FAILED,
    STATUS_HANG,
    STATUS_OK,
    STATUS_TIMEOUT,
)
from src.buildproc import child

from probes import BUILD_LIMITS, block_import, needs_cadquery, needs_occt


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

        def printables():
            return {"body": cq.Workplane("XY").box(20, 10, 5)}

        def views():
            body = printables()["body"]
            part = [{"shape": body, "name": "body"}]
            return [
                {"id": "print", "name": "print", "parts": part},
                {"id": "assembled", "name": "assembled", "parts": part},
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
    """
    limits = BUILD_LIMITS.replace(wall_seconds=30.0, hang_dump_seconds=1.5)
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

def test_the_model_cannot_read_the_hubs_tokens(project, hub_secrets):
    """The environment test of test_isolation.py, from inside a real model.

    Worth having twice: that one proves `child_environment` composes the right
    dictionary, this one proves the dictionary is what a model.py actually
    runs with -- through the wrapper, the exec and the chdir.
    """
    outcome = project.build("""
        import os
        raise RuntimeError("token=%r read=%r decoy=%r" % (
            os.environ.get("PUBLISH_TOKEN"),
            os.environ.get("COMMENT_READ_TOKEN"),
            os.environ.get("AWS_SECRET_ACCESS_KEY")))
    """)

    assert outcome.status == STATUS_FAILED
    assert "token=None read=None decoy=None" in outcome.log
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
