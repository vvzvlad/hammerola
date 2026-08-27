"""The client imports the standard library and this repository, and nothing else.

THE RULE IS WRITTEN IN `src/client/__init__.py` AND WAS NOT CHECKED ANYWHERE.
`hammerola` is installed on the author's machine and installs nothing: it runs
under whatever python3 is there, so one `import httpx` in a client module makes
the tool fail at startup on every machine that is not a checkout of this
repository with a virtualenv in it — and it fails at IMPORT, so it takes every
verb with it, not the one that grew the dependency. Nothing in the suite would
notice: the test environment has every runtime dependency installed, so the
import succeeds here and only here.

WHY IT MATTERS MORE NOW. `revdiff.py` imports `src.metricsdiff`, which is the
first time a client module has reached outside its own package. That is safe
because that module is stdlib-only (`tests/test_metricsdiff.py` pins it) — but
the door is open, and the two modules it must not walk through are
`src/cadbuild/` (the build half, which exists to load a CAD kernel) and
`src/store.py` (which brings loguru and the service). Both are named below.

Read out of the syntax tree rather than by importing: an import inside a
function is invisible to `sys.modules` until it runs, and the run where it first
happens would be on somebody's laptop.
"""

import ast
import sys
from pathlib import Path

from src import client

CLIENT_DIR = Path(client.__file__).resolve().parent

# First-party names a client module may reach for. `src` is this repository —
# the package the tool is run out of (`bin/hammerola`) — and what it may take
# from there is narrowed below rather than left open.
FIRST_PARTY = {"src"}

# The halves of `src/` a client module may NOT import, and why each would hurt:
# `cadbuild` is the build half and loads a CAD kernel; `store`, `app`, `jobs`,
# `render`, `comments`, `settings` and `buildproc` are the service and bring
# loguru and pydantic with them.
FORBIDDEN_SRC_MODULES = {
    "cadbuild", "store", "app", "jobs", "render", "comments", "settings",
    "buildproc", "multipart", "config_errors",
}


def _modules(tree) -> set:
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module)
    return names


def _client_modules() -> list:
    return sorted(CLIENT_DIR.glob("*.py"))


def test_every_client_module_imports_only_the_standard_library():
    offenders = {}
    for path in _client_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        outside = sorted(
            name for name in _modules(tree)
            if name.split(".")[0] not in sys.stdlib_module_names
            and name.split(".")[0] not in FIRST_PARTY)
        if outside:
            offenders[path.name] = outside
    assert offenders == {}, (
        f"these client modules import something that is not in the standard "
        f"library: {offenders}. The tool installs nothing and runs under "
        f"whatever python3 the author's machine has.")


def test_the_client_never_reaches_into_the_service_or_the_build_half():
    offenders = {}
    for path in _client_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        reached = sorted(
            name for name in _modules(tree)
            if name.split(".")[0] == "src"
            and len(name.split(".")) > 1
            and name.split(".")[1] in FORBIDDEN_SRC_MODULES)
        if reached:
            offenders[path.name] = reached
    assert offenders == {}, (
        f"these client modules import the service or the build half: "
        f"{offenders}. Both bring dependencies the client does not have — "
        f"copy the constant into `limits.py` with a test that pins it, or move "
        f"the pure part out to where both halves can import it "
        f"(`src/metricsdiff.py` is the worked example).")


def test_the_command_itself_is_covered_by_this():
    """The entry point is a client module like any other, and it is the one an
    import error would be noticed at."""
    names = {path.name for path in _client_modules()}
    assert {"cli.py", "hub.py", "revdiff.py"} <= names
