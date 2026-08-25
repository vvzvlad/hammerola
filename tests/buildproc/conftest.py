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

NO MODULE-STATE GUARD, and that is checked rather than assumed: `src.buildproc`
holds no module-level mutable state. `Limits` is a frozen dataclass,
DEFAULT_LIMITS is one instance of it, HUB_ROOT is a Path computed at import.
The state this component does mutate -- `src.cadbuild.paths._root`, the OCCT
thread pool -- is mutated in the CHILD process and dies with it, which is the
same reason the hub is allowed to run untrusted code at all.
"""

import json
import sys
import textwrap

import pytest

from src.buildproc import child_environment, run_build, run_isolated

from probes import BUILD_LIMITS, TEST_LIMITS


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
        "PUBLISH_TOKEN": "publish-token-must-not-leak-4a1f",
        "COMMENT_READ_TOKEN": "comment-token-must-not-leak-9b2e",
        # Not ours, and that is the point: a filter is a list of names somebody
        # maintains, and this is the variable nobody thought to add to it.
        "AWS_SECRET_ACCESS_KEY": "decoy-must-not-leak-c7d3",
    }
    for name, value in secrets.items():
        monkeypatch.setenv(name, value)
    return secrets
