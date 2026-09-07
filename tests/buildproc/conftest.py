"""Fixtures for the isolation suite, and nothing else.

Every test in this directory starts a REAL process and reads what came back
from it. That is the only way this component can be tested at all: what it
promises -- that a hang is killed, that a token is not in the environment, that
a runaway `print` does not become the hub's memory problem -- is a property of
an operating-system process, and a mock of `subprocess` would assert that the
code calls what it calls rather than that the fence holds.

So the tests are written against SMALL PROGRAMS, one behaviour each, written
into tmp_path and run through exactly the machinery the hub uses. Most of them
need no CAD stack at all: `run_isolated` does not care whether the process it
is fencing in imports cadquery or counts to ten, which is what keeps this suite
at seconds instead of minutes.

NO GUARD ON `src.buildproc`'s OWN STATE, and that is checked rather than
assumed: it holds none. `Limits` is a frozen dataclass, DEFAULT_LIMITS is one
instance of it, HUB_ROOT is a Path computed at import. The state this component
mutates -- `src.cadbuild.paths._root`, the OCCT thread pool -- is mutated in the
CHILD process and dies with it, which is the same reason the hub is allowed to
run untrusted code at all.

THAT LAST SENTENCE HAS ONE EXCEPTION AND IT IS WHAT `the_kernel_is_left_alone`
BELOW IS FOR: `tests/buildproc/test_build_child.py` calls `child._cap_occt_threads`
IN PROCESS, in the pytest interpreter, which on a workstation with the CAD stack
installed is an interpreter holding the real kernel. What that function does when
it reaches the real pool is resize it, process-wide and permanently.
"""

import json
import sys
import textwrap

import pytest

from src.buildproc import child_environment, run_build, run_isolated

from probes import BUILD_LIMITS, TEST_LIMITS

# The two names `_cap_occt_threads` imports through, and the only handle on the
# kernel anything here can see.
_KERNEL = ("OCP", "OCP.OSD")


@pytest.fixture(scope="session")
def kernel_at_the_start():
    """Whatever was under the kernel's two names before this suite ran anything.

    A baseline of the SESSION and not of the test, because "clean" has to mean
    something a test can be compared against at its START as well as at its end
    -- and on a workstation with the CAD stack installed the honest baseline is
    "not imported", while in the CI container it is the same. `probes.py` asks
    whether OCP imports in a SUBPROCESS precisely so that asking does not change
    this answer.
    """
    return {name: sys.modules.get(name) for name in _KERNEL}


@pytest.fixture(autouse=True)
def the_kernel_is_left_alone(kernel_at_the_start):
    """No test in this directory may reach the real OCCT pool, either way round.

    WHAT IT CHECKS IS THE MODULES AND NOT THE POOL, and the difference is worth
    knowing before trusting it. The pool's size is readable only through
    `OSD_ThreadPool.DefaultPool_s()`, and that call CREATES the pool at one
    thread per logical core when there is not one yet -- so a fixture reading it
    would do, twice per test, the exact thing it exists to catch. What is
    observable for free is whether a different object is under either kernel
    name: a stub planted without `monkeypatch` (which is how a fake outlives the
    test that made it), and the real kernel IMPORTED where there was none, which
    is the step immediately before capping it.

    BOTH ENDS, per the repository's rule. The before-check fails the test that
    INHERITED a dirty interpreter, so the report says "an earlier test did this"
    rather than leaving the reader to work out that the test in front of them is
    innocent; the after-check fails the test that DID it -- which is the only
    one that can be fixed, and which otherwise passes, having done its own job
    perfectly.
    """
    _same_kernel(kernel_at_the_start, "was already")
    yield
    _same_kernel(kernel_at_the_start, "is")


def _same_kernel(baseline, tense):
    for name in _KERNEL:
        assert sys.modules.get(name) is baseline[name], (
            f"sys.modules[{name!r}] {tense} not the object this session started "
            f"with. A stub planted without monkeypatch outlives the test that "
            f"made it, and the real kernel imported in this process is one call "
            f"to _cap_occt_threads away from having its thread pool resized for "
            f"the whole pytest run")


@pytest.fixture
def run_program(tmp_path):
    """Write a program, run it behind the fence, hand back the ProcessResult."""
    counter = [0]

    def run(source, *, limits=TEST_LIMITS, args=()):
        counter[0] += 1
        script = tmp_path / f"program{counter[0]}.py"
        script.write_text(source, encoding="utf-8")
        home = tmp_path / f"home{counter[0]}"
        tmp = tmp_path / f"tmp{counter[0]}"
        for directory in (home, tmp):
            directory.mkdir()
        return run_isolated(
            [sys.executable, "-s", str(script), *args],
            limits=limits,
            env=child_environment(home=home, tmp=tmp, threads=limits.occt_threads),
        )

    return run


class _Project:
    """One model project on disk, and `run_build` pointed at it.

    A project is two files -- project.json and model.py -- and the tests here
    vary only the second. The id is a real one in shape (SPEC 3.1: a safe path
    component) because `load_project` refuses anything else and the refusal
    would then be what every test in this file was measuring.
    """

    # The id the HUB accepted for this push. It is deliberately the same string
    # project.json carries, so that a test which cares about the difference
    # (test_build_child's forgery tests) has to say so out loud.
    PID = "abc123def456"

    def __init__(self, tmp_path):
        self.root = tmp_path / "project"
        self.root.mkdir()
        (self.root / "project.json").write_text(
            json.dumps({"id": self.PID, "title": "Isolation test box"}),
            encoding="utf-8")
        self.out = tmp_path / "staging"

    def build(self, model_source, *, limits=BUILD_LIMITS, pid=None):
        (self.root / "model.py").write_text(
            textwrap.dedent(model_source), encoding="utf-8")
        return run_build(self.root, self.out, pid=pid or self.PID, limits=limits)


@pytest.fixture
def project(tmp_path):
    """A model project to build, with `.root`, `.out` and `.build(source)`."""
    return _Project(tmp_path)


@pytest.fixture
def hub_secrets(monkeypatch):
    """Put the hub's real credentials into the PARENT's environment.

    The names are the ones src/settings.py declares, and the values are
    distinctive so a test can look for the VALUE anywhere in a log rather than
    only for the name. Without this fixture the suite would be asserting the
    absence of variables that were never there -- which passes against any
    implementation, including one that inherits `os.environ` whole.
    """
    secrets = {
        # The one credential src/settings.py declares (issue #26).
        "EDIT_TOKEN": "edit-token-must-not-leak-4a1f",
        # Not ours, and that is the point: a filter is a list of names somebody
        # maintains, and this is the variable nobody thought to add to it. It
        # matters MORE now that the hub declares a single secret — with two, a
        # filter that named both looked complete; with one, it looks trivial.
        "AWS_SECRET_ACCESS_KEY": "decoy-must-not-leak-c7d3",
    }
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    return secrets
