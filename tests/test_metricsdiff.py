"""metrics.json has two readers and exactly ONE comparison behind them.

The build prints what moved since `dev`, and `hammerola diff` prints what moved
between two revisions. Both want the same sentences from the same document, and
the client cannot import the build half: it is stdlib-only and takes nothing from
`requirements.txt` or `src/cadbuild/` (`hammerola/__init__.py`). So the comparison
lives in `hammerola/metricsdiff.py`, which both sides import. These tests pin that
`src.cadbuild.metrics` re-exports the same objects instead of growing a copy, and
that the shared module stays importable on a laptop's bare python3.

The comparison's behaviour is tested in `tests/cadbuild/test_metrics.py`.
"""

import ast
import sys
from pathlib import Path

from hammerola import metricsdiff
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

    `hammerola/revdiff.py` imports `metrics_diff` to print what moved between
    two revisions; `src/cadbuild/metrics.report_metrics` calls it to print what
    moved since `dev`. One object, so the two can never disagree about what a
    change is.
    """
    from hammerola import revdiff

    assert revdiff.metrics_diff is metricsdiff.metrics_diff
    assert revdiff.metrics_diff is metrics.metrics_diff


def test_the_asserts_the_constants_settled_get_a_line_of_their_own():
    """The asserts the constants settled get a line of their own.

    The build subtracts the asserts its own constants settle from the count it
    reports. Alone, `checks passed: 5 -> 3` reads as two dropped checks; the
    second line says two checks proved nothing. A baseline without
    `checks_static` renders as `None -> 2`, since the number did not exist then.
    """
    lines = metricsdiff.metrics_diff({"checks_passed": 5},
                                     {"checks_passed": 3, "checks_static": 2})
    assert lines == ["checks passed: 5 -> 3",
                     "checks decided by constants: None -> 2"]


def _part(**fields):
    """One part's measurements, in the shape the build writes them."""
    return dict({"volume_mm3": 1000.0, "bbox_mm": [10.0, 10.0, 10.0],
                 "first_layer_mm2": 100.0, "overhang_mm2": 0.0,
                 "faces": 6, "triangles": 12, "watertight": True}, **fields)


def test_nothing_physical_moved_is_an_empty_answer_and_a_count():
    """The half a script acts on, and the half that makes it readable.

    An empty `moved` says nothing changed only if something was looked at, so
    `compared` rides beside it: two documents with no field in common — a
    revision published before a field existed against one published after —
    compare nothing and move nothing.
    """
    before = {"parts": {"body": _part(faces=6)}}
    after = {"parts": {"body": _part(faces=9)}}
    answer = metricsdiff.moved_fields(before, after,
                                      metricsdiff.PHYSICAL_FIELDS)
    # The face count moved and it is not a PHYSICAL field: a fillet drawn out
    # of two surfaces instead of one is the same object.
    assert answer == {"moved": [], "compared": 4}


def test_a_moved_number_is_named_by_part_and_by_field():
    before = {"parts": {"body": _part(), "lid": _part()}}
    after = {"parts": {"body": _part(first_layer_mm2=40.0), "lid": _part()}}
    answer = metricsdiff.moved_fields(before, after,
                                      metricsdiff.PHYSICAL_FIELDS)
    assert answer["moved"] == [{"part": "body", "field": "first_layer_mm2",
                                "old": 100.0, "new": 40.0}]
    assert answer["compared"] == 8


def test_two_documents_with_no_field_in_common_compare_nothing():
    """The case `compared` exists for, and the only one where it reads zero.

    The test above has the same empty `moved` with four numbers behind it. Here
    a revision published before these fields existed meets one published after,
    so the walk finds no pair to compare at all — same list, different answer,
    and `compared` is what tells a script which of the two it is holding.
    """
    before = {"parts": {"body": {"faces": 6}}}
    after = {"parts": {"body": {"volume_mm3": 1000.0}}}
    answer = metricsdiff.moved_fields(before, after,
                                      metricsdiff.PHYSICAL_FIELDS)
    assert answer == {"moved": [], "compared": 0}


def test_a_new_cad_stack_alone_leaves_the_part_the_same(tmp_path, capsys):
    """Both readers keep "every measured number is the same" when only the
    versions moved: that line is the one the skill stops on, and a version is
    not a measurement. The versions follow it on lines of their own."""
    from hammerola import revdiff

    before = {"parts": {"body": _part()},
              "toolchain": {"cadquery-ocp": "7.9.3.1.1"}}
    after = dict(before, toolchain={"cadquery-ocp": "7.9.4"})

    revdiff._print_geometry(before, after)
    metrics.write_metrics(tmp_path, after)
    metrics.report_metrics(tmp_path, before, None)

    out = capsys.readouterr().out
    assert out.count("every measured number is the same") == 2, out
    assert out.count("  toolchain: cadquery-ocp 7.9.3.1.1 -> 7.9.4\n") == 2, out


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
