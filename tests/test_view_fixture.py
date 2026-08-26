"""The committed JS fixture, and whether the exporter still produces it.

`ui/tests/fixtures/assembled.json` is read by the vitest suite as the payload a
real build hands the browser. It is COMMITTED, because the JS suite runs in a
node container in CI where there is no Python and no CAD kernel — the generator's
docstring has that argument in full.

A committed artefact drifts, and this file is the mechanism that stops it
drifting in silence. `ui/tests/fixtures/make_fixture.py` is re-run here against
the same pipeline a push goes through, and the STRUCTURE of what comes out is
compared with the structure of what is committed: the tree, the field names, the
types. Not the floats — those are the tessellator's business and a comparison of
them would fail on an unrelated kernel bump while saying nothing about the format
the adapter reads.

So the day `ocp_tessellate` renames a field or `views.py` stops emitting one, this
goes red — instead of the JS suite staying green against a document no build
produces any more.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from src.render import check_view_file

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "ui" / "tests" / "fixtures" / "assembled.json"
GENERATOR = ROOT / "ui" / "tests" / "fixtures" / "make_fixture.py"

# A ceiling on what the repository carries, not a measurement of today's file
# (152 KB, 17 KB compressed). It is here so a model that grew a chamfer and
# quadrupled the mesh has to be a deliberate commit rather than a quiet one.
MAX_FIXTURE_BYTES = 320 * 1024


def load_generator():
    """The generator, imported by path — it is a script, not a package member."""
    spec = importlib.util.spec_from_file_location("make_fixture", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def outline(node: dict) -> dict:
    """A view node with every NUMBER thrown away and every NAME kept.

    What survives is exactly what the browser half reads and what a format change
    would move: the field names at each level, the tree, the part names, the
    colours, and — for a leaf — the names of the mesh buffers and how long each
    one is relative to the others.
    """
    row = {
        "fields": sorted(node),
        "name": node.get("name"),
        "id": node.get("id"),
        "color": node.get("color"),
        "alpha": node.get("alpha"),
        "type": node.get("type"),
        "subtype": node.get("subtype"),
        "state": node.get("state"),
    }
    if "parts" in node:
        row["parts"] = [outline(part) for part in node["parts"]]
        return row
    shape = node["shape"]
    # The LENGTHS, not the values: a buffer that changed length is a different
    # mesh and none of this file's business, but a buffer that vanished or was
    # renamed is exactly what it is here to catch. Kept as a set of names plus
    # emptiness, so a finer tessellation does not fail this test.
    row["shape"] = {key: (type(value).__name__, bool(value))
                    for key, value in sorted(shape.items())}
    return row


@pytest.fixture(scope="module")
def committed() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_is_committed_and_stays_small(committed):
    size = FIXTURE.stat().st_size
    assert size <= MAX_FIXTURE_BYTES, (
        f"{FIXTURE.relative_to(ROOT)} is {size / 1024:.0f} KB — either shrink the "
        f"model in {GENERATOR.name} or raise MAX_FIXTURE_BYTES on purpose")
    assert committed["name"], "the root node has no name to build paths from"


def test_fixture_would_survive_the_hub_s_own_gate():
    """It has to be a payload the hub would ACCEPT, not merely one it can parse.

    `check_view_file` is what every pushed view goes through, and it is the only
    thing standing between a push and the DOM. A fixture that could not get past
    it would be testing the browser half against a document the hub would have
    refused.
    """
    check_view_file(FIXTURE, "assembled")


def test_fixture_is_a_tree_with_siblings_and_a_mesh_on_every_leaf(committed):
    """The four properties the JS suite leans on, asserted where they are cheap.

    The vitest suite checks these too, from the other side; they are here as well
    because a fixture that lost one of them would make several JS tests pass
    vacuously — a prefix rule cannot be wrong with one leaf, and a colour cannot
    fail to travel when every part is the same colour.
    """
    parts = committed["parts"]
    assert len(parts) >= 3, "the part tree needs siblings to have a prefix rule"
    assert len({part["color"] for part in parts}) > 1, "one colour proves nothing"
    assert any(part["alpha"] != 1.0 for part in parts), (
        "no part is transparent, so a stray opacity of 1.0 would hide here")
    for part in parts:
        shape = part["shape"]
        assert shape["triangles"] and shape["vertices"] and shape["normals"]
        assert len(shape["vertices"]) == len(shape["normals"]), (
            "one normal per vertex is what the viewer assumes")
        assert len(shape["vertices"]) % 3 == 0


def test_the_exporter_still_produces_the_committed_structure(committed, tmp_path):
    """Re-run the generator and compare the SHAPE of what it wrote.

    Deliberately not a byte comparison: the mesh depends on the pinned
    `cadquery` / `ocp-tessellate` versions and on nothing this repository owns, so
    a byte assertion would fail on a kernel bump that changed a coordinate in the
    last decimal place — noise, on a test whose whole job is to be believed. What
    it does compare is every name and every nesting level, which is what the
    adapter reads and what a format change moves.

    THIS TEST DOES NOT RUN IN CI, AND THAT IS WHAT THE GUARD BELOW COSTS. Both
    workflows run the suite in a bare `python:3.11-slim` carrying nothing but
    `git`, while the system libraries the CAD kernel links against are installed
    by the RUNTIME Dockerfile only — so there `import cadquery` dies with
    `ImportError: libGL.so.1`: the distribution is on disk, the shared object it
    loads is not. The guard turns that into a skip, exactly as tests/cadbuild/
    does for the same reason.

    What is being paid for it, stated plainly rather than left to read as
    routine: NOT ONE test that computes real geometry executes in CI. Not the
    ~169 under tests/cadbuild/, and from now on not this one either — so the
    committed fixture is compared against the real exporter only on a workstation
    where `make install` put the kernel in place. Between such runs the drift this
    file exists to catch is unwatched: a change to src/cadbuild/views.py that
    moves the payload's shape goes through a green CI, and the vitest suite keeps
    passing against a document no build produces any more. Closing the hole means
    putting libgl1 into the test container, which also switches those ~169
    geometry tests on — a step of its own, with its own cost to measure; it is
    written up in docs/SPEC.md §8.

    Guarding on `cadquery` alone covers `ocp_tessellate` too, which the export
    also needs: both are pinned in requirements.txt and both fail on the same
    missing system library, so an interpreter that imports the first imports the
    second.

    `exc_type=ImportError` is explicit because the failure this guard is FOR is
    an ImportError that is not a ModuleNotFoundError — the module is found and
    its extension refuses to load. pytest 9 still defaults to catching plain
    ImportError but warns about it, and 9.1 changes the default to
    ModuleNotFoundError; without the argument this guard would then stop
    skipping and the CI container would go red again on a pytest bump.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so the real "
               "exporter cannot be run — see this test's docstring for what "
               "skipping it costs in CI")

    module = load_generator()
    module.export(tmp_path / "out")
    fresh = json.loads(
        (tmp_path / "out" / "assembled.json").read_text(encoding="utf-8"))

    assert outline(fresh) == outline(committed), (
        "the exporter no longer produces the committed fixture's shape. If that "
        "is the intended change, run `make ui-fixture`, read the diff and commit "
        "it — and check ui/tests/*.test.js for assertions about the old shape")
