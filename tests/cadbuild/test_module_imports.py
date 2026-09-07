"""Where each name in this package is taken FROM, read off the syntax tree.

`from .views import hub_text_problem` resolved perfectly and was wrong: the
function had moved to `hubspec`, and `views` only still had the name because it
imports it itself. Nothing fails on that -- until the day `views` stops needing
it, when a module that never mentioned `views` breaks. The first cost arrives
earlier and never announces itself: `project.py` is about project.json and a
pure function over a string, and that one line made it drag in `views` and with
it `checklib`, `parts`, `palette` and `geometry`.

So every `from .<module> import <name>` inside `src/cadbuild/` has to name a
module that DEFINES the name, and re-export has to be a decision somebody wrote
down rather than a coincidence. Read from the syntax tree rather than by
importing, so a module that needs the CAD kernel is swept here too -- i.e. in CI
as well as on a workstation.
"""

import ast
import pathlib

import pytest


PACKAGE = pathlib.Path(__file__).resolve().parents[2] / "src" / "cadbuild"

# The one re-export that IS the design, named here so it stays one. `metrics`
# re-exports the pure half of the comparison, which lives in `src/metricsdiff.py`
# so the stdlib-only client can have it too; the module says so in a comment and
# lists the names in `__all__`. Anything else that turns up below is the
# accident this file exists for.
DELIBERATE_REEXPORTS = {("metrics", "METRICS_NAME")}


def _module_names(path):
    """What this file DEFINES at module level, and what it merely IMPORTED."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    defined, imported = set(), set()
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef,
                                  ast.ClassDef)):
            defined.add(statement.name)
        elif isinstance(statement, ast.Assign):
            defined.update(target.id for target in statement.targets
                           if isinstance(target, ast.Name))
        elif isinstance(statement, ast.AnnAssign):
            if isinstance(statement.target, ast.Name):
                defined.add(statement.target.id)
        elif isinstance(statement, ast.ImportFrom):
            imported.update(alias.asname or alias.name
                            for alias in statement.names)
        elif isinstance(statement, ast.Import):
            imported.update((alias.asname or alias.name).split(".")[0]
                            for alias in statement.names)
    return defined, imported


@pytest.fixture(scope="module")
def package():
    """Every module of the package, by stem, with what it defines and imports."""
    return {path.stem: _module_names(path)
            for path in sorted(PACKAGE.glob("*.py"))}


@pytest.fixture(scope="module")
def sibling_imports(package):
    """Every `(module, name)` that one module of this package takes from another.

    The same lines the sweep below walks, collected as data -- which is what
    lets the whitelist be held to them rather than merely to the re-export
    surviving. Read with `ast.walk` for the same reason the sweep is: an import
    buried inside a function counts too.
    """
    used = set()
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for statement in ast.walk(tree):
            if not isinstance(statement, ast.ImportFrom):
                continue
            if statement.level != 1 or statement.module not in package:
                continue
            used.update((statement.module, alias.name)
                        for alias in statement.names)
    return used


def test_the_package_is_where_this_thinks_it_is():
    """The sweep below passes vacuously over an empty directory."""
    stems = {path.stem for path in PACKAGE.glob("*.py")}
    assert {"views", "hubspec", "project", "gate", "parts"} <= stems


def test_every_name_is_imported_from_the_module_that_defines_it(package):
    stale = []
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for statement in ast.walk(tree):
            if not isinstance(statement, ast.ImportFrom):
                continue
            # `from . import x` and anything reaching outside the package are
            # somebody else's rule; this one is about sibling modules.
            if statement.level != 1 or statement.module not in package:
                continue
            defined, imported = package[statement.module]
            for alias in statement.names:
                if alias.name in defined:
                    continue
                if (statement.module, alias.name) in DELIBERATE_REEXPORTS:
                    continue
                where = "re-exported" if alias.name in imported else "absent"
                stale.append(f"{path.name}: from .{statement.module} import "
                             f"{alias.name} -- {where} there")
    assert not stale, "\n".join(stale)


def test_the_deliberate_re_exports_are_still_re_exports(package, sibling_imports):
    """A list entry that stopped excusing anything is a check that vanished.

    The same failure `ci/smoke.py` counts its verdicts against: this list can
    only ever grow by somebody deciding to add to it, so an entry left behind
    after a name moved back home would silently widen the sweep above.

    IT TAKES BOTH HALVES TO SAY THAT, and the second is the one that was
    missing. "Still re-exported" only asks whether `metrics` still hands the
    name on; it says nothing about anybody taking it from there. The day
    `build.py` writes `from src.metricsdiff import METRICS_NAME` instead, the
    entry excuses no line of the sweep above -- and the sweep above is the only
    thing it can excuse -- while a check that asked the first half alone stays
    green. So the entry also has to name a line that really exists.
    """
    for module, name in DELIBERATE_REEXPORTS:
        defined, imported = package[module]
        assert name in imported and name not in defined, (
            f"`{name}` is no longer re-exported by `{module}`; take it off "
            "DELIBERATE_REEXPORTS rather than leaving a dead excuse behind")
        assert (module, name) in sibling_imports, (
            f"nothing in this package imports `{name}` from `{module}` any "
            "more, so this entry excuses no line of the sweep above; take it "
            "off DELIBERATE_REEXPORTS rather than leaving a dead excuse behind")
