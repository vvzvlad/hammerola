"""`make cad-test` names six tests by node id, and node ids rot.

The target is the ONLY thing that runs the six tests the CI container cannot
(issue #27: `libgl1` is deliberately not installed there). It fails loudly when
a name it holds no longer exists -- but only for somebody who runs it, and the
whole reason the target exists is that this half of the suite is easy to forget.
So the list is checked here instead, on every run of the ordinary suite, where
a rename shows up the day it happens rather than the day somebody remembers.

This does NOT run the six; running them needs the kernel and that is the
target's job. It checks that each name still points at a function.
"""

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# `CAD_TESTS := a \` + continuation lines, ending at the first line with no
# trailing backslash. Written against the Makefile's own text rather than by
# asking make, because `make -p` runs the shell and this test must not.
CAD_TESTS_RE = re.compile(r"^CAD_TESTS\s*:=\s*(.*?)(?<!\\)\n", re.M | re.S)


def _declared_node_ids() -> list[str]:
    text = (ROOT / "Makefile").read_text(encoding="utf-8")
    match = CAD_TESTS_RE.search(text)
    assert match, "the Makefile no longer declares CAD_TESTS; `make cad-test` " \
                  "is what runs the six tests CI skips (issue #27)"
    body = match.group(1).replace("\\\n", " ")
    return body.split()


def test_the_target_still_names_six_tests():
    """Six, and the number is deliberate -- see issue #27 for which six.

    A seventh that arrives without a decision, or a sixth that quietly leaves,
    both change what "we catch it by hand" covers, and neither should happen
    without somebody reading this line.

    The sixth arrived with step 8 (issue #10): the difference between two
    revisions is drawn from pieces the kernel fuses, and the one fact that
    cannot be checked without a kernel is that those pieces come out in the
    PART's coordinates and have to be placed with the view leaf's own `loc`.
    Nothing else in the suite would notice that drifting.
    """
    assert len(_declared_node_ids()) == 6


def test_every_name_the_target_runs_still_exists():
    for node_id in _declared_node_ids():
        rel, _, name = node_id.partition("::")
        assert name, f"{node_id} is not a `path::name` node id"
        path = ROOT / rel
        assert path.is_file(), f"{rel}, named by CAD_TESTS, is gone"
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        found = any(isinstance(node, ast.FunctionDef) and node.name == name
                    for node in tree.body)
        assert found, (f"CAD_TESTS names {node_id}, and {rel} has no such test "
                       f"any more -- `make cad-test` would error on it")
