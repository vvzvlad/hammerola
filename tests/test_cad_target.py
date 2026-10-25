"""`make cad-test` names six tests by node id, and node ids rot.

The target runs those six without the rest of the suite, for the edit-run-edit loop
on the export half; CI runs them too, since its test image (`ci/Dockerfile.test`)
carries the kernel's libraries. The target fails on a missing name only for
somebody who runs it, so the list is checked here on every run of the ordinary
suite. This does NOT run the six (that needs the kernel); it checks that each name
still points at a function.
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
                  "is what runs the six kernel tests on their own (issue #27)"
    body = match.group(1).replace("\\\n", " ")
    return body.split()


def test_the_target_still_names_six_tests():
    """Six, and the number is deliberate.

    A seventh added or a sixth removed changes what the kernel-backed loop covers,
    and neither should happen without somebody reading this line. One of the six
    checks that the pieces the revision diff is drawn from stand, in world
    coordinates, on the part they were cut from -- placed with the view leaf's
    `at`, not its `loc` -- which nothing else in the suite would notice drifting.
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
