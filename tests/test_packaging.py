"""`pyproject.toml` says five things about the tool, and all five can go stale.

The file is metadata for the CLIENT and for nothing else: the distribution name
`hammerola`, the version, the python floor, the packages and the console
script. Nothing
reads it in this repository — no target builds a wheel, no workflow installs one
— so every claim in it is a claim nothing would notice going false. The comments
inside it already say "keep this equal to", which is this project's own
signal that the sentence belongs in a test rather than in a comment.

WHAT EACH CHECK IS AGAINST, since none of them is about `pip` working:

  * The floor is stated TWICE — here and in `onboarding.MIN_PYTHON`, which is
    what the zipapp's generated entry point prints when the interpreter is too
    old. Raise one and the installed tool promises a version the downloaded one
    refuses, or the reverse.
  * `packages` is written out rather than discovered, and that is load-bearing:
    deleting the line does not fail the build, it makes setuptools sweep this
    flat layout and package `src` as well — and `src` shadowing every other
    project's `src` on a laptop is the exact thing giving the tool a name of its
    own was for.
  * The console script names a module and an attribute as a string, so nothing
    checks it until somebody installs the distribution and runs the command.
  * The VERSION is stated twice — here, where an installed copy reports it from,
    and in `hammerola.VERSION`, which is what the tool says about itself and
    what the hub repeats in its manifest for `build` to compare against. The
    zipapp, which is how the tool is usually installed, carries no metadata at
    all, so the two can only be kept together by being asserted equal.
"""

import importlib
import tomllib
from pathlib import Path

import hammerola
from src import onboarding

ROOT = Path(__file__).resolve().parents[1]
METADATA = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_the_declared_floor_is_the_one_the_client_checks_at_startup():
    assert METADATA["project"]["requires-python"] == f">={onboarding.MIN_PYTHON_TEXT}", (
        "pyproject.toml and onboarding.MIN_PYTHON name different python floors, "
        "so an installed `hammerola` and the downloaded zipapp disagree about "
        "which interpreters the tool runs on.")


def test_the_distribution_packages_the_tool_and_never_the_hub():
    assert METADATA["tool"]["setuptools"]["packages"] == ["hammerola"], (
        "the distribution must contain the client package and nothing else — "
        "auto-discovery over this flat layout would add `src`, which is the hub "
        "and would shadow every other project's `src` once installed.")


def test_the_declared_version_is_the_one_the_tool_states_about_itself():
    """Two copies of one number, and the drift between them is silent.

    Nothing in this repository reads `pyproject.toml`, so a version raised in
    one place and not the other produces an installed `hammerola` that reports
    one number while the hub — which imports the constant — states another. What
    that costs is the refusal in `update.refuse_if_behind`: a client that says
    it is older than the hub is stopped from publishing and told to update,
    which is a loop when the update it fetches carries the same disagreement.
    """
    assert METADATA["project"]["version"] == hammerola.VERSION, (
        "pyproject.toml and hammerola.VERSION name different versions of the "
        "same tool, so an installed copy reports one number and the hub's "
        "manifest states another.")


def test_the_console_script_points_at_something_that_can_be_run():
    module_name, _, attribute = METADATA["project"]["scripts"]["hammerola"].partition(":")
    entry_point = getattr(importlib.import_module(module_name), attribute)
    assert callable(entry_point), (
        f"the `hammerola` console script names {module_name}:{attribute}, which "
        f"is not callable — the installed command would fail on first run.")
