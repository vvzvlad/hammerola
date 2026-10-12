"""The committed JS fixture, and whether the exporter still produces it.

`ui/tests/fixtures/assembled.json` is read by the vitest suite as the payload a
real build hands the browser. It is committed because the JS suite runs in a
node container without Python or the CAD kernel (see the generator's docstring).

`ui/tests/fixtures/make_fixture.py` is re-run here through the push pipeline,
and the STRUCTURE of the output (tree, field names, types) is compared with the
committed one. Not the floats: those are the tessellator's and would fail on an
unrelated kernel bump. A renamed or dropped field fails here instead of the JS
suite staying green against a document no build produces.
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

# A ceiling on what the repository carries, not a measurement of today's file:
# a much larger mesh has to be a deliberate commit.
MAX_FIXTURE_BYTES = 320 * 1024


def load_generator():
    """The generator, imported by path — it is a script, not a package member."""
    spec = importlib.util.spec_from_file_location("make_fixture", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def outline(node: dict) -> dict:
    """A view node with every NUMBER thrown away and every NAME kept.

    What survives is what the browser reads and a format change would move: the
    field names at each level, the tree, part names, catalogue keys, colours,
    and for a leaf the mesh buffer names and whether each is empty.

    The key is kept as a value: `shaped_document` stamps each leaf's key by
    position (`zip(flat, nodes)`), and a mistake there would be baked into an
    immutable build. A reordered `parts` from `ocp_tessellate` is caught by
    `name` and `id` (`export_views` passes `names=[node["key"] ...]`); the key
    catches a change to where the key is stamped from. The names stay necessary:
    a view holding one part twice has equal keys (`pin`, `pin(2)`, both keyed
    `pin`).

    `.get` because group nodes carry no key, and the walk descends through them.
    """
    row = {
        "fields": sorted(node),
        "name": node.get("name"),
        "key": node.get("key"),
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
    # Names plus emptiness, not lengths or values: a vanished or renamed buffer
    # fails, a finer tessellation does not.
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


def _keys_in(node) -> dict:
    """A catalogue declaring exactly the keys this view file names, and no more.

    `check_view_file` cross-checks every leaf `key` against the build's
    catalogue, which a view file does not carry. Deriving it from the file takes
    only that cross-check out of play; every other rule (a key must be a legal
    part name) still applies. A walk, so it follows whatever the generator
    writes.

    Every record is `printable`: `check_view_file` reads membership only, not
    kinds. A caller that publishes needs more (see `exported_tree`).
    """
    found = {}
    key = node.get("key")
    if isinstance(key, str):
        found[key] = {"kind": "printable"}
    for child in node.get("parts", ()):
        found.update(_keys_in(child))
    return found


def test_fixture_would_survive_the_hub_s_own_gate(committed, tmp_path):
    """It has to be a payload the hub would ACCEPT, not merely one it can parse.

    `check_view_file` is what every pushed view goes through before the DOM. The
    committed document goes in unchanged.
    """
    declared = _keys_in(committed)
    assert declared, (
        "the fixture names no catalogue key at all, so the cross-check in "
        "`check_view_file` has nothing to cross-check and this test is idle — "
        "regenerate it with `make ui-fixture`")

    path = tmp_path / "assembled.json"
    path.write_text(json.dumps(committed), encoding="utf-8")

    shown = check_view_file(path, "assembled", declared)

    # The return value, which `meta.json` is then held against
    # (`_match_selection`): the walk must reach every leaf and report one key per
    # leaf. Read off each leaf's `key` field, not `name` (equal on this fixture),
    # so the field under test is the one compared.
    assert shown == {part["key"] for part in committed["parts"]}


def test_fixture_is_a_tree_with_siblings_and_a_mesh_on_every_leaf(committed):
    """The four properties the JS suite leans on, asserted where they are cheap.

    Without them several JS tests would pass vacuously: a prefix rule cannot be
    wrong with one leaf, and a colour cannot fail to travel when every part has
    the same colour.
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


def exported_tree(directory: Path) -> tuple[list[dict], dict]:
    """A stand-in for `export()`: the two maps meta.json is assembled out of.

    The committed payload under both view names, plus a catalogue declaring what
    they show: enough to publish without a CAD kernel, since publishing checks a
    view file only through `check_view_file`, which the fixture passes.

    Everything is derived from the fixture: every declared key must be a record
    in `parts` (`render._view_parts`), the declared list must equal the file's
    keys (`render._match_selection`), and a `printable` must declare files
    (`render._catalogue`), so a typed-out list would break on any generator
    change.

    Every record is `printable` with one stl, the cheapest shape `_catalogue`
    accepts; the real kinds are the kernel-bound test's business. The dummy files
    are written beside the views because a declared name must be one the build
    shipped (`render._check_declared_file`).
    """
    directory.mkdir(parents=True)
    payload = FIXTURE.read_bytes()
    for name in ("assembled.json", "print.json"):
        (directory / name).write_bytes(payload)
    keys = list(_keys_in(json.loads(payload)))
    parts = {}
    for key in keys:
        (directory / f"{key}.stl").write_bytes(b"solid stand-in\n")
        parts[key] = {"kind": "printable", "files": {"stl": f"{key}.stl"}}
    # Both views are the same bytes, so both show the same parts, which is what
    # `_match_selection` compares against.
    return [
        {"id": "assembled", "name": "assembled", "file": "assembled.json",
         "parts": keys},
        {"id": "print", "name": "as printed", "file": "print.json",
         "parts": keys},
    ], parts


def test_publish_to_data_lands_a_build_and_a_rerun_keeps_the_slot(tmp_path):
    """`make ui-fixture-data`, the half of the generator that talks to the Store.

    That target is how to look at the real interface in a browser. This test
    hands the export in, so it runs without a CAD kernel.

    The second publish checks that re-running with nothing changed leaves the
    slot alone (a reader may have it open): `payload_digest()` must not cover
    meta.json's wall clock.
    """
    module = load_generator()
    data_dir = tmp_path / "data"

    first = tmp_path / "first"
    module.publish_to_data(first, *exported_tree(first), data_dir)

    slot = data_dir / "project" / module.FIXTURE_PID / "dev"
    assert (slot / "assembled.json").read_bytes() == FIXTURE.read_bytes()
    meta = json.loads((slot / "meta.json").read_text(encoding="utf-8"))
    assert [view["id"] for view in meta["views"]] == ["assembled", "print"]
    # The catalogue survived the round trip: `build_meta` refuses a view naming
    # a key the map does not declare.
    assert sorted(meta["parts"]) == sorted(meta["views"][0]["parts"])
    assert meta["dev"] is True, "the local slot has to be published as a dev build"
    # The staging tree is the caller's to remove on every path but the rename.
    assert sorted(p.name for p in (data_dir / "project" / module.FIXTURE_PID)
                  .iterdir()) == ["builds.json", "dev"]

    # Survives the second publish only if the slot was not rewritten.
    (slot / "sentinel.txt").write_text("kept", encoding="utf-8")
    # Changes the meta.json and nothing else, standing in for the `built` stamp
    # that really does differ between two runs: it must not count as a new build.
    module.FIXTURE_TITLE = "a different title"

    second = tmp_path / "second"
    module.publish_to_data(second, *exported_tree(second), data_dir)

    assert (slot / "sentinel.txt").is_file(), (
        "the slot was rewritten by a re-run that published the same views — the "
        "page a reader has open re-renders for nothing")
    kept = json.loads((slot / "meta.json").read_text(encoding="utf-8"))
    assert kept["title"] == meta["title"]


def test_the_exporter_still_produces_the_committed_structure(committed, tmp_path):
    """Re-run the generator and compare the SHAPE of what it wrote.

    Not bytes: the mesh depends on the pinned `cadquery` / `ocp-tessellate`
    versions, and a byte assertion would fail on noise. Every name and nesting
    level is compared, which is what the adapter reads.

    Runs in CI (`ci/Dockerfile.test` carries the kernel's system libraries);
    skips on a machine without the kernel. Guarding on `cadquery` covers
    `ocp_tessellate` too: both are pinned and fail on the same missing library.
    `exc_type=ImportError` is explicit because the skip is for an ImportError
    that is not a ModuleNotFoundError (installed but unloadable), and pytest 9.1
    changes the default.
    """
    pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so the real "
               "exporter cannot be run — see this test's docstring for what "
               "skipping it costs")

    module = load_generator()
    module.export(tmp_path / "out")
    fresh = json.loads(
        (tmp_path / "out" / "assembled.json").read_text(encoding="utf-8"))

    assert outline(fresh) == outline(committed), (
        "the exporter no longer produces the committed fixture's shape. If that "
        "is the intended change, run `make ui-fixture`, read the diff and commit "
        "it — and check ui/tests/*.test.js for assertions about the old shape")
