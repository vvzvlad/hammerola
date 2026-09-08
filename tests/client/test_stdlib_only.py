"""The client imports the standard library and this repository, and nothing else.

THE RULE IS WRITTEN IN `hammerola/__init__.py` AND WAS NOT CHECKED ANYWHERE.
`hammerola` is installed on the author's machine and installs nothing: it runs
under whatever python3 is there, so one `import httpx` in a client module makes
the tool fail at startup on every machine that is not a checkout of this
repository with a virtualenv in it — and it fails at IMPORT, so it takes every
verb with it, not the one that grew the dependency. Nothing in the suite would
notice: the test environment has every runtime dependency installed, so the
import succeeds here and only here.

WHAT THE SECOND CHECK IS FOR, AND WHAT IT NO LONGER IS. The package carries the
pure modules the hub and the client share — `buildnames`, `metricsdiff`,
`projectslug` — so nothing in it reaches into `src` any more, and the first
check is what holds that: `FIRST_PARTY` is `{"hammerola"}`, so ANY import of
`src` fails it, not merely the dangerous halves. THE SECOND CHECK CANNOT FAIL
WHILE THE FIRST PASSES, and it is kept anyway rather than deleted, because it is
where the two halves are NAMED with their reasons: `src/cadbuild/` is the build
half and exists to load a CAD kernel, `src/store.py` brings loguru and the
service. Do not read it as a safety net under the first one — it is a subset of
it, so anybody loosening `FIRST_PARTY` back to `{"src"}` reopens
`src.onboarding` and everything else along with it.

Read out of the syntax tree rather than by importing: an import inside a
function is invisible to `sys.modules` until it runs, and the run where it first
happens would be on somebody's laptop.
"""

import ast
import sys

from src import onboarding

# First-party names a client module may reach for. `hammerola` is the tool's own
# distribution — the package the command is run out of (the installed script,
# `python3 -m hammerola`, or the zipapp built from it) — and it is the only one,
# because every module the tool imports travels inside it.
FIRST_PARTY = {"hammerola"}

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

    `onboarding.client_members()` RATHER THAN A GLOB OF `hammerola/`, and the
    difference is the whole reach of this file: the builder decides what goes
    into the archive, so asking it is what makes this guard cover whatever the
    archive actually carries — including a module reached for lazily from
    inside a function, which is the form this code already uses elsewhere and
    which no import-time check would ever notice. The two happen to be the same
    set today, because the distribution is one package; the day the builder
    puts something else in, this sweeps that too instead of missing it.

    The archive name is what a failure is reported under, because that is the
    name the module has inside the zipapp.
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
        f"(`hammerola/metricsdiff.py` is the worked example).")


def test_the_command_itself_is_covered_by_this():
    """What the two checks above are actually looking at.

    The entry point is a client module like any other, and it is the one an
    import error would be noticed at; the other two are named beside it because
    a sweep that found nothing at all would pass every check above in silence.
    """
    names = {name for name, _path in _client_modules()}
    assert {"hammerola/cli.py", "hammerola/hub.py",
            "hammerola/revdiff.py"} <= names
