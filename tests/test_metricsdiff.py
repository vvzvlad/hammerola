"""metrics.json has two readers and exactly ONE comparison behind them.

WHY THIS FILE EXISTS AT ALL. The build prints what moved since `dev`, and
`hammerola diff` prints what moved between two revisions. Both read the same
document and want the same sentences out of it, and the client cannot import the
build half — it is stdlib-only and takes nothing from `requirements.txt` or from
`src/cadbuild/` (`src/client/__init__.py`). That is precisely the shape that
produced `cad_publish/hubspec.py`: a second copy of somebody else's rules, in a
place that could not see the original, with nothing comparing the two — and
publication broke when they drifted.

The answer here was to MOVE the comparison rather than copy it, into
`src/metricsdiff.py`, which both sides import. So there is nothing to keep in
step and no conformance test to write; what these tests pin is that this stays
true — that `src.cadbuild.metrics` re-exports the very same objects instead of
growing a copy again, and that the shared module stays importable on a laptop's
bare python3, which is the property that made the move possible.

The behaviour of the comparison itself is tested where it was written and where
its callers are: `tests/cadbuild/test_metrics.py`.
"""

import ast
import sys
from pathlib import Path

from src import metricsdiff
from src.cadbuild import metrics

SHARED = Path(metricsdiff.__file__)

# What the build half is expected to go on exposing under its own name. The
# build, its tests and every project's `make` output are written against
# `cadbuild.metrics`, so moving the implementation had to leave those spellings
# working.
RE_EXPORTED = ("METRIC_FIELDS", "METRICS_NAME", "METRICS_REL_TOL",
               "metrics_diff", "metrics_summary",
               "unchanged_code_moved_geometry")


def test_the_build_half_re_exports_the_shared_objects_and_not_copies():
    """`is`, not `==`: two functions with identical source are exactly what a
    copy looks like on the day it is made, and this test has to fail then rather
    than a year later."""
    for name in RE_EXPORTED:
        assert getattr(metrics, name) is getattr(metricsdiff, name), name


def test_the_client_and_the_build_compare_with_the_same_function():
    """The whole point of the move, asserted from the CLIENT's side.

    `src/client/revdiff.py` imports `metrics_diff` to print what moved between
    two revisions; `src/cadbuild/metrics.report_metrics` calls it to print what
    moved since `dev`. One object, so the two can never disagree about what a
    change is.
    """
    from src.client import revdiff

    assert revdiff.metrics_diff is metricsdiff.metrics_diff
    assert revdiff.metrics_diff is metrics.metrics_diff


def test_the_shared_module_imports_nothing_but_the_standard_library():
    """What makes it importable by the client at all.

    The client runs under whatever python3 a laptop has and installs nothing, so
    a single `import numpy` here — or an import of anything under
    `src/cadbuild/`, which is the build half and exists to load a CAD kernel —
    would break `hammerola diff` on every machine that has no CAD stack, from an
    edit that looks local to the hub.
    """
    imported = _imported_modules(SHARED)
    outside = sorted(name for name in imported
                     if name not in sys.stdlib_module_names)
    assert outside == [], (
        f"{SHARED.name} imports {outside}, and it may import only the standard "
        f"library: the client imports this module and installs nothing")


def _imported_modules(path: Path) -> set:
    """The TOP-LEVEL module name of every import in a file.

    Read out of the syntax tree rather than by importing and inspecting
    `sys.modules`: an import that only happens inside a function would be
    invisible to the second method until the day it runs, which is the day it
    breaks somebody's laptop.
    """
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names
