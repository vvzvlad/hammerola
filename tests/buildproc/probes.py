"""What the isolation suite needs besides fixtures: ceilings, marks, helpers.

Kept out of conftest.py deliberately. Three directories under tests/ have a
conftest.py of their own and every one of them lands on sys.path, so
`from conftest import ...` in a test module resolves to whichever of the three
pytest inserted first -- a coin toss that changes with collection order. A
module with a name of its own cannot be confused with anything (the pattern
tests/cadbuild/fakes.py already follows).
"""

import json
import os
import subprocess
import sys

import pytest

from src.buildproc import Limits
from src.buildproc.limits import MiB


# Sized for a test suite, not for a build. `memory_bytes` is None because macOS
# cannot apply RLIMIT_AS at all (see limits.memory_limit_supported) and every
# test here would refuse to start on a workstation; the tests that are ABOUT
# the memory ceiling ask for it explicitly and skip where it cannot work.
TEST_LIMITS = Limits(
    wall_seconds=5.0,
    log_bytes=64 * 1024,
    cpu_seconds=20,
    memory_bytes=None,
    file_bytes=16 * MiB,
    open_files=256,
    processes=None,
    core_bytes=0,
    occt_threads=2,
    hang_dump_seconds=None,
)

# For the tests that run a REAL build. Wider than TEST_LIMITS because a build
# imports cadquery, meshes geometry and lets matplotlib build a font cache in
# the scratch HOME it was given -- 6.5 s of CPU on its own, measured (see
# `child_environment`). Still an order of magnitude under the production
# numbers, so a test that hangs fails in a minute rather than in five.
BUILD_LIMITS = TEST_LIMITS.replace(wall_seconds=90.0, cpu_seconds=180)

# Programs print their answer on one line behind this marker, so a test can
# find it in a log that also carries the wrapper's own "ceilings in force" line
# and, on a bad day, a traceback.
MARKER = "PAYLOAD "


def payload(result):
    """The one marked line a program printed, parsed. Fails loudly with the log."""
    for line in result.log.splitlines():
        if line.startswith(MARKER):
            return json.loads(line[len(MARKER):])
    raise AssertionError(
        f"the program printed no {MARKER!r} line. Its whole log was:\n{result.log}")


def import_works(name):
    """Whether `import name` really WORKS -- decided by trying it, elsewhere.

    `importlib.util.find_spec` is the obvious call and it is WRONG here, in the
    one environment these marks exist for. Both CI workflows run the suite in a
    bare `python:3.11-slim` with requirements.txt installed and none of the
    system libraries the Dockerfile adds, and there `find_spec("cadquery")`
    answers yes -- the distribution is on disk -- while `import cadquery` dies
    with `libGL.so.1: cannot open shared object file`. A mark built on find_spec
    therefore does not skip, and the two tests that need real geometry fail in
    CI for a reason that has nothing to do with them.

    In a process of its own so that a pytest run does not end up with the whole
    CAD stack (and an OCCT thread pool) resident just to answer a question about
    it. Run once at import, which is what makes it two subprocesses per session
    rather than two per test.
    """
    finished = subprocess.run(
        [sys.executable, "-s", "-c", f"import {name}"],
        capture_output=True, timeout=300)
    return finished.returncode == 0


needs_cadquery = pytest.mark.skipif(
    not import_works("cadquery"),
    reason="the CAD stack does not import in this interpreter (the image's does; "
           "a bare checkout or the CI test container may be missing it, or the "
           "system libraries it loads)")

needs_occt = pytest.mark.skipif(
    not import_works("OCP"),
    reason="OCP does not import in this interpreter, so there is no thread pool "
           "to cap")

linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"),
    reason="this ceiling is enforced by the Linux kernel; see "
           "limits.memory_limit_supported for the measured Darwin behaviour")

darwin_only = pytest.mark.skipif(
    not sys.platform.startswith("darwin"),
    reason="this is about the platform that CANNOT apply the ceiling")


def block_import(monkeypatch, name, error=None):
    """Make `import name` fail exactly as it does where the package is absent.

    `error` overrides the exception, for the OTHER way a package can be
    unusable: installed, and its extension refusing to load. That one arrives as
    a plain `ImportError` rather than a `ModuleNotFoundError` and is a real
    measurement, not a hypothetical -- see `child._cap_occt_threads`.

    Needed because this workstation HAS the CAD stack, and the case under test
    is the interpreter that does not. Deleting it from `sys.modules` is not
    enough -- the next import finds it on disk again -- and `sys.modules[name] =
    None` produces the WRONG exception for what this is simulating: the import
    machinery then fails on the parent's missing `__path__` and raises
    `ModuleNotFoundError(name="OCP.OSD")`, whereas a package that is genuinely
    not installed fails with `name="OCP"`. Those two are precisely what
    `child._cap_occt_threads` has to tell apart, so a helper that blurred them
    would test the opposite of the intended thing.

    A finder at the front of `sys.meta_path` raises before any real finder is
    asked, which is what an absent package looks like from the inside.
    """
    for loaded in [m for m in sys.modules
                   if m == name or m.startswith(f"{name}.")]:
        monkeypatch.delitem(sys.modules, loaded)

    class Blocker:
        @staticmethod
        def find_spec(fullname, path=None, target=None):
            if fullname == name or fullname.startswith(f"{name}."):
                raise error or ModuleNotFoundError(
                    f"No module named {fullname!r}", name=fullname)
            return None

    monkeypatch.setattr(sys, "meta_path", [Blocker, *sys.meta_path])


def alive(pid):
    """Whether a pid is still there. Used to watch a straggler and to clean up."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
