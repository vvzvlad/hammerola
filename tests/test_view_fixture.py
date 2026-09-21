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
    catalogue keys, the colours, and — for a leaf — the names of the mesh
    buffers and how long each one is relative to the others.

    THE KEY IS A VALUE HERE AND NOT MERELY A FIELD NAME, which is what `fields`
    alone left out. `shaped_document` stamps each leaf's key on BY POSITION
    (`zip(flat, nodes)`) and says in its own words what a mismatch would mean:
    "silently, and permanently, into an immutable build".

    BE PRECISE ABOUT WHICH FAILURE THIS ROW ADDS, because the obvious answer is
    wrong and believing it would cost the row that does the work. An
    `ocp_tessellate` handing `parts` back in a different order is caught by
    `name` and `id`, and always was: `export_views` passes `names=[node["key"]
    ...]`, so a name travels with its mesh and a reorder desynchronises the two
    within a leaf. What the key adds is the failure the names cannot see — a
    change to where `shaped_document` stamps the key FROM, so that keys stop
    tracking the list the names came out of. Do not read this row as making
    `name` and `id` redundant: on a view holding one part twice the keys are
    equal by design (`pin`, `pin(2)`, both keyed `pin`), and there the names
    are the only witness left.

    `.get` rather than `[...]`: a group node carries no key (the build writes
    none, `treeFromShapes` refuses one that was written by hand), and this walk
    descends through groups too.
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


def _keys_in(node) -> dict:
    """A catalogue declaring exactly the keys this view file names, and no more.

    `check_view_file` cross-checks every leaf `key` against the catalogue of the
    build it belongs to (issue #75), and a view file does not carry that
    catalogue — referential integrity is a property of the PAIR, which is why the
    argument exists at all. So the one built here says nothing about the project:
    it is derived from the file, which leaves every other rule in the walk doing
    its job (a key still has to be a legal part name) and takes only the one
    check this file cannot answer on its own out of play.

    Written as a walk rather than as a fixed map on purpose: it has to keep
    answering for whatever the generator writes, and the generator's model is
    free to change under it.

    EVERY RECORD IS `printable`, which is a shortcut and worth naming as one:
    the kinds are the generator's to declare (three printables and one piece of
    hardware today), and nothing this map is handed to reads a kind —
    `check_view_file` asks membership and nothing else. A caller that publishes
    rather than validates needs more than this (see `exported_tree`).
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

    `check_view_file` is what every pushed view goes through, and it is the only
    thing standing between a push and the DOM. A fixture that could not get past
    it would be testing the browser half against a document the hub would have
    refused.

    THE COMMITTED DOCUMENT GOES IN UNCHANGED, which it did not use to: the
    generator predated the catalogue key, a leaf with no `key` is a 422, and a
    helper here filled one in from each leaf's name so the walk was refusing
    nothing but the fixture's age. Regenerating the fixture is what retired it.
    """
    declared = _keys_in(committed)
    assert declared, (
        "the fixture names no catalogue key at all, so the cross-check in "
        "`check_view_file` has nothing to cross-check and this test is idle — "
        "regenerate it with `make ui-fixture`")

    path = tmp_path / "assembled.json"
    path.write_text(json.dumps(committed), encoding="utf-8")

    shown = check_view_file(path, "assembled", declared)

    # The RETURN VALUE, which is the half `meta.json` is then held against
    # (`_match_selection`): every leaf the walk reached, named. Read off the
    # `key` field of each committed leaf rather than off its `name`, which is
    # the comparison that became possible when the fixture started carrying
    # keys — the two strings are equal on this document (the tessellator names a
    # leaf by its key and only disambiguates repeats, and there are none here),
    # so naming the field under test is what keeps this a witness for the walk
    # rather than for the equality. What it witnesses: the walk has to REACH
    # every leaf and report one key per leaf, instead of stopping at the root or
    # folding them together.
    assert shown == {part["key"] for part in committed["parts"]}


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


def exported_tree(directory: Path) -> tuple[list[dict], dict]:
    """A stand-in for `export()`: the two maps meta.json is assembled out of.

    The committed payload under both view names, plus the catalogue that
    declares what those files show. Enough to publish, because publishing never
    looks at what is inside a view file beyond what `check_view_file` checks —
    and the committed fixture is a file that passes it (the test above asserts
    exactly that). What this buys is a test of the publishing half that needs no
    CAD kernel, i.e. one that runs in the place the kernel-bound test cannot.

    EVERYTHING IS DERIVED FROM THE FIXTURE, and none of it is typed out, because
    the hub holds the two documents to each other: every key a view declares has
    to be a record in `parts` (`render._view_parts`), the declared list has to be
    EXACTLY the keys the view file carries (`render._match_selection`), and a
    `printable` that declares no files is refused (`render._catalogue`). A list
    written out here would therefore not go quietly stale — it would go red the
    next time the generator's model changes, which is a test failing for a
    reason that is nothing to do with what it tests.

    THE KINDS ARE NOT THE GENERATOR'S, and that is the one place this document
    is a stand-in rather than a copy: every record is `printable` with a single
    exported file, because that is the cheapest shape `_catalogue` accepts. What
    the real build declares — three formats a part, one entry of `hardware` with
    a note and no files — is the kernel-bound test's business next door. The
    dummy files are written beside the views because a declared name has to be
    one the build really shipped (`render._check_declared_file` looks it up in
    the hash of what was published).
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
    # Both views are the same bytes, so both show the same parts. That is what
    # makes the second entry legal rather than lazy: `_match_selection` compares
    # the declaration with the FILE, and the file here is `assembled.json` twice.
    return [
        {"id": "assembled", "name": "assembled", "file": "assembled.json",
         "parts": keys},
        {"id": "print", "name": "as printed", "file": "print.json",
         "parts": keys},
    ], parts


def test_publish_to_data_lands_a_build_and_a_rerun_keeps_the_slot(tmp_path):
    """`make ui-fixture-data`, the half of the generator that talks to the Store.

    That target is the supported way to look at the real interface in a browser,
    and it was dead for as long as it took somebody to open one: `publish_dev`
    became `publish_dev_built` and took a staging directory instead of a tar, and
    nothing anywhere called it. The test above is next door and could not have
    caught it — it needs a CAD kernel, so it skips wherever one does not import.
    This one hands the export IN and therefore runs everywhere, including on a
    machine with no kernel at all.

    The second publish is the other half of the check, and not a formality: the
    slot is a page somebody has open, so re-running the target when nothing
    changed has to answer 200 and leave the directory alone rather than swap a
    freshly written one under the reader. That is what makes the digest choice in
    `payload_digest()` observable — a digest covering the meta.json's wall clock
    would rewrite the slot on every run.
    """
    module = load_generator()
    data_dir = tmp_path / "data"

    first = tmp_path / "first"
    module.publish_to_data(first, *exported_tree(first), data_dir)

    slot = data_dir / "project" / module.FIXTURE_PID / "dev"
    assert (slot / "assembled.json").read_bytes() == FIXTURE.read_bytes()
    meta = json.loads((slot / "meta.json").read_text(encoding="utf-8"))
    assert [view["id"] for view in meta["views"]] == ["assembled", "print"]
    # The catalogue survived the round trip, which is the half a view's `parts`
    # list points at: `build_meta` rebuilds both field by field and refuses a
    # view naming a key this map does not declare.
    assert sorted(meta["parts"]) == sorted(meta["views"][0]["parts"])
    assert meta["dev"] is True, "the local slot has to be published as a dev build"
    # Nothing may be left behind in the project directory: the staging tree is
    # the caller's to remove on every path that is not the rename.
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

    Deliberately not a byte comparison: the mesh depends on the pinned
    `cadquery` / `ocp-tessellate` versions and on nothing this repository owns, so
    a byte assertion would fail on a kernel bump that changed a coordinate in the
    last decimal place — noise, on a test whose whole job is to be believed. What
    it does compare is every name and every nesting level, which is what the
    adapter reads and what a format change moves.

    THIS TEST RUNS IN CI, and it did not always: both workflows used to run the
    suite in a bare `python:3.11-slim` carrying nothing but `git`, so there
    `import cadquery` died with `ImportError: libGL.so.1` — the distribution on
    disk, the shared object it loads not — and the guard below turned that into a
    skip. The test container installs the kernel's system libraries now (issue
    #27), so the committed fixture is compared against the real exporter on every
    push instead of only on a workstation. The guard stays for the machine that
    has no kernel, which is what it was written for.

    Guarding on `cadquery` alone covers `ocp_tessellate` too, which the export
    also needs: both are pinned in requirements.txt and both fail on the same
    missing system library, so an interpreter that imports the first imports the
    second.

    `exc_type=ImportError` is explicit because the failure this guard is FOR is
    an ImportError that is not a ModuleNotFoundError — the module is found and
    its extension refuses to load. pytest 9 still defaults to catching plain
    ImportError but warns about it, and 9.1 changes the default to
    ModuleNotFoundError; without the argument this guard would then stop skipping
    on a machine whose kernel is installed but cannot load, and go red there on a
    pytest bump.
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
