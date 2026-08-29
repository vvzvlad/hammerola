"""Fixtures for the client suite.

THREE THINGS HAVE TO BE TAKEN AWAY FROM EVERY TEST HERE, and all of them would
otherwise make a run depend on the machine it is on.

The first is `EDIT_TOKEN`. `tests/conftest.py` puts one in the environment at
import time so `src.settings` can be constructed — and the CLIENT reads a
variable of the same name, for the same hub, meaning something else: the token
the harness's hub actually checks is `harness.TOKEN`. A client test that
inherited the settings one would push with the wrong secret and get a 401 that
has nothing to do with what it was testing.

The second is `~/.config/hammerola/env`. It is a real file on a machine that
publishes models, so a suite that read it could pass because the developer is
configured and fail on anybody else's machine — or, far worse, push at a real
hub. `HAMMEROLA_ENV_FILE` points every test at a path that does not exist, so
the only settings in play are the ones a test sets for itself.

The third is HOME ITSELF, and it is here because the home directory stopped
being somewhere this tool only READS from. `skill update` writes over
`~/.claude/skills/hammerola/SKILL.md` without asking — that is the verb — and
on the machine running this suite that path is very likely the developer's own
working copy of the instructions. Every test today passes `--path` into
`tmp_path`, but that is discipline and not a mechanism: one forgotten flag in
one future test and the suite silently replaces the file its author is working
from. So the home the client can reach is a directory under `tmp_path`, which
turns that mistake into a test writing somewhere harmless.

The helpers live in `modeldir.py`, not here: see its docstring.
"""

import pytest
from modeldir import make_model


@pytest.fixture(autouse=True)
def client_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "no-such-file"))
    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    # BOTH names, because `Path.expanduser()` — which is what turns the `~` in
    # `skill.DEFAULT_PATH` into a real path — reads USERPROFILE on Windows and
    # HOME everywhere else. Setting one leaves the other platform pointed at
    # the machine's real home, i.e. exactly the case this is here to prevent.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def model(tmp_path):
    return make_model(tmp_path / "demo")
