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

from src import onboarding

# First-party names a client module may reach for. `src` is this repository —
# the package the tool is run out of (`python3 -m src.client`, or the zipapp
# built from it) — and what it may take from there is narrowed below rather than
# left open.
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
    """(archive name, path) for every module the downloaded tool is made of.

    `onboarding.client_members()` RATHER THAN A GLOB OF `src/client/`, and the
    difference is the whole reach of this file. The zipapp carries a second
    group — `CLIENT_EXTRA_MODULES`, the modules OUTSIDE the package that the
    client is allowed to import — and a glob of the package cannot see any of
    them. `src/__init__.py` is in that group and is imported before anything
    else in the archive, so one `import httpx` there fails every verb of the
    tool on a laptop, and the comment above that constant invites the list to
    grow. Asking the builder what it puts in the archive is what makes this
    guard cover whatever the archive actually carries, including a module
    reached for lazily from inside a function — which is the form this code
    already uses elsewhere and which no import-time check would ever notice.

    The archive name is what a failure is reported under, because the file NAME
    is not unique across the two groups: `src/__init__.py` and
    `src/client/__init__.py` are two different modules called `__init__.py`.
    """
    return onboarding.client_members()


def test_every_client_module_imports_only_the_standard_library():
    offenders = {}
    for name, path in _client_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        outside = sorted(
            imported for imported in _modules(tree)
            if imported.split(".")[0] not in sys.stdlib_module_names
            and imported.split(".")[0] not in FIRST_PARTY)
        if outside:
            offenders[name] = outside
    assert offenders == {}, (
        f"these client modules import something that is not in the standard "
        f"library: {offenders}. The tool installs nothing and runs under "
        f"whatever python3 the author's machine has.")


def test_the_client_never_reaches_into_the_service_or_the_build_half():
    offenders = {}
    for name, path in _client_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        reached = sorted(
            imported for imported in _modules(tree)
            if imported.split(".")[0] == "src"
            and len(imported.split(".")) > 1
            and imported.split(".")[1] in FORBIDDEN_SRC_MODULES)
        if reached:
            offenders[name] = reached
    assert offenders == {}, (
        f"these client modules import the service or the build half: "
        f"{offenders}. Both bring dependencies the client does not have — "
        f"copy the constant into `limits.py` with a test that pins it, or move "
        f"the pure part out to where both halves can import it "
        f"(`src/metricsdiff.py` is the worked example).")


def test_the_command_itself_is_covered_by_this():
    """What the two checks above are actually looking at.

    The entry point is a client module like any other, and it is the one an
    import error would be noticed at. `src/__init__.py` is named beside it for a
    different reason: it is the sentinel for the SECOND group, the one a glob of
    `src/client/` used to miss entirely, and it is the module every other one in
    the archive is imported through.
    """
    names = {name for name, _path in _client_modules()}
    assert {"src/client/cli.py", "src/client/hub.py", "src/client/revdiff.py",
            "src/__init__.py"} <= names
