#!/usr/bin/env python3
"""Generate the view payload the JS tests read — with the REAL exporter.

    make ui-fixture                     # rewrite ui/tests/fixtures/assembled.json
    make ui-fixture-data                # ...and publish a build into data/ for `make run`

WHY A GENERATOR AND NOT A HAND-WRITTEN JSON. The file this writes is the
contract between the hub's build half and the browser: `{name, color, parts:
[...]}` all the way down, with a mesh and a catalogue `key` on every leaf. A
hand-written stand-in would freeze somebody's IDEA of that shape, and it would
go stale in silence — `ocp_tessellate` renames a field, the adapter is updated
to match, and the JS suite stays green against a document no build produces any
more. Everything below therefore goes through the functions a real build calls,
in the order `src/cadbuild/build.py` calls them — `read_catalogue()`,
`prepare_views()`, the three gates, `export_printables()` and `export_views()` —
so the fixture is output rather than an impression of it. Seven calls across
four modules, and `export_printables()` is on the list rather than left out as
scenery: `--data` cannot publish a fixture without it (see `export()`).

    tests/test_view_fixture.py is the other half of that: it re-runs this
    generator and compares the STRUCTURE of the result with the committed file,
    so the day the exporter's shape changes is the day the suite says so.

WHY THE COMMITTED PAYLOAD IS THE ARTEFACT, rather than generating it at test
time. The JS suite runs in a `node:22-bookworm-slim` container in CI, where
there is no Python at all, let alone CadQuery — and on a workstation the kernel
is only there if the dev dependencies were installed. A fixture generated on the
fly would therefore be a JS suite that cannot run in the place it has to run.
The committed file is ~150 KB (17 KB over the wire — it is JSON full of
repeating float text and compresses ten to one), which is a rounding error next
to the 3.6 MB of viewer and three already in this repository.

WHAT THE MODEL IS AND WHY IT IS THIS ONE. Small enough to commit, and
deliberately not degenerate:

  * FOUR PARTS, not one — the part tree has to be a tree with siblings, and the
    hidden/ghost/select code in ui/src/viewport/parts.js works by path prefix,
    which one node cannot exercise;
  * FLAT FACES on every part, because the section tool takes its plane from the
    normal of a face somebody clicked;
  * SOMETHING CURVED on every part (the post's barrel, the holes through the
    plate and the cap), because a mesh with three normals in it would not tell a
    working tessellation from a broken one;
  * THREE PRINTABLES AND ONE BOUGHT PART, so the colours in the file are three
    different palette entries plus one grey. A file where every part is the same
    colour cannot show that the colour travels per part. The grey is no longer
    ARRANGED — it follows from the entry's `kind`, because `catalogue_colors()`
    gives a palette entry to a printable and paints `hardware` in
    `HARDWARE_COLOR`.

ONE THING IT DELIBERATELY DOES NOT HAVE: NESTING. The tree comes out two levels
deep — a `Group` and one leaf per reference — and that IS a choice made here,
rather than the limit it used to be: a view may hold
`{"group": "housing", "parts": [...]}` and `export_views()` writes those group
nodes into the file (src/render.py validates the nesting to a depth of 64). What
one reference can never be is several leaves — `read_catalogue()` puts every
entry's `shape` through `as_shape()`, which requires CadQuery geometry and
refuses a `cq.Assembly` outright, and `shaped_document()` refuses a
tessellation that came back with a different number of parts than the view has
leaves. The fixture stays flat because the JS suite's own expectations are read
straight off `assembled.parts`; the recursion in `treeFromShapes` is covered
there against a tree built by nesting these real leaves, with the difference
spelled out there.

REGENERATING IT. `make ui-fixture` from the repository root, then commit the
result. Needs the CAD kernel, so `make install` first on a machine that has not
had it. The mesh depends on the pinned `cadquery`/`ocp-tessellate` versions, so
a diff bigger than a few floats after an unrelated change is worth reading
rather than committing blind — that IS the drift this file exists to make
visible.
"""

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

# ui/tests/fixtures -> ui/tests -> ui -> the repository root.
ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

HERE = Path(__file__).resolve().parent

# The one view the JS suite reads. `print` is generated too (a real project has
# both, and the pipeline gates them differently), but only this one is committed:
# what the suite reads a view file FOR is the leaf contract, and the second file
# would double the bytes in the repository to say nothing new about it.
FIXTURE_VIEW = "assembled"
FIXTURE_PATH = HERE / f"{FIXTURE_VIEW}.json"

# What `make ui-fixture-data` publishes under. `dev` is the hub's local slot,
# which is the right one for something a person is about to look at: it is
# served `no-cache` and every push rewrites it, so re-running this never piles
# builds up in data/.
FIXTURE_PID = "fixture0000"
FIXTURE_TITLE = "Fixture model (generated by ui/tests/fixtures/make_fixture.py)"


def model():
    """The model, in the shape a project's model.py hands over.

    Returns `(views, parts)` — exactly the two things `build()` reads out of a
    model.py, so what happens to them below is what happens to a real one.

    `parts()` IS THE CATALOGUE and the one place geometry lives; the key of an
    entry is the part's identity — the stem it is exported under, the label on
    the viewer's tree row, and the string every reference below points at. A
    view carries no geometry at all: it is a list of references, and where a
    part stands is said with `at` rather than by handing the view a solid that
    has already been moved.
    """
    import cadquery as cq

    # ONE curved feature per part, and no more, because every one of them is
    # paid for in the committed file: a hole is a cylindrical wall plus two
    # discretised circles, and the tessellator writes those out as
    # full-precision floats. Two holes in the plate instead of one cost 18 KB on
    # their own — measured, by generating both. What the fixture needs is that
    # curvature is PRESENT on every part, not that there is a lot of it.
    #
    # The plate: flat top and bottom for the section tool, one bore for the mesh.
    plate = (cq.Workplane("XY").box(24, 16, 3)
             .faces(">Z").workplane().hole(3))
    # The barrel. Nothing but curvature and two flat ends.
    post = cq.Workplane("XY").circle(4).extrude(12)
    # A cap with a bore. The bore is the cap's CURVED FEATURE — the third rule
    # in this file's docstring, one curve per part — and that is the whole of
    # its job. It used to be justified here by keeping the cap and the plate
    # distinguishable as SOLIDS, which named a mechanism that does not exist:
    # nothing chooses a colour from geometry (`catalogue_colors` paints by the
    # entry's `kind`, and `palette_colors` takes the palette slot from an md5 of
    # the KEY), and the one thing that ever did reconstruct identity from volume
    # and face areas — the coverage gate — was itself removed when a view
    # started referencing a catalogue key (src/cadbuild/gate.py, "what these
    # gates no longer do"). Two identical solids would therefore cost this
    # fixture a curve, not a colour.
    cap = (cq.Workplane("XY").box(12, 12, 3)
           .faces(">Z").workplane().hole(5))
    # NOT printed: a bought part, the kind a real assembly shows for reference.
    # Its KIND is what makes one leaf of the fixture grey while the other three
    # carry palette colours — `catalogue_colors()` paints `hardware` in
    # HARDWARE_COLOR — where the grey used to have to be arranged, by giving the
    # part a shape the old fingerprint matcher would fail to pair with anything
    # printed. A plain disc rather than a washer with its bore: the bore was the
    # single most expensive feature in the file (a tube is two cylindrical walls
    # and four circles, 71 KB of the first 221 KB version) and bought nothing
    # the plate's hole does not already cover.
    spacer = cq.Workplane("XY").circle(5).extrude(1)

    # `hardware` RATHER THAN `mock`, and the two are not interchangeable here:
    # a mock is scenery and `check_interference` skips a pair with one on either
    # side, so the fixture would be generated behind a gate that never looked at
    # its fourth part. A spacer is material that is really there.
    parts = {
        "plate": {"shape": plate, "kind": "printable"},
        "post": {"shape": post, "kind": "printable"},
        "cap": {"shape": cap, "kind": "printable"},
        # The note travels into meta.json and nowhere near assembled.json, so it
        # costs the committed file nothing and gives `--data` a part with
        # something written under it.
        "reference_spacer": {"shape": spacer, "kind": "hardware",
                             "note": "bought: a 10 x 1 mm spacer"},
    }

    assembled = {
        "id": FIXTURE_VIEW,
        "name": "assembled",
        "parts": [
            "plate",
            {"part": "post", "at": cq.Location((0, 0, 1.5))},
            {"part": "cap", "at": cq.Location((0, 0, 15))},
            # Half transparent, because the fixture should carry an alpha that
            # is not 1: `defaultOpacity` and the per-part transparency path in
            # parts.js are the two places a stray 1.0 would hide.
            #
            # UNDER the plate, where it used to sit halfway up the post: that
            # was a disc of radius 5 crossing a cylinder of radius 4, i.e. some
            # 50 mm3 of shared material, and `check_interference` now runs over
            # this view with `hardware` under the gate. Flush against the
            # plate's underside, so the two boxes touch and share nothing.
            {"part": "reference_spacer", "at": cq.Location((0, 0, -2.5)),
             "alpha": 0.6},
        ],
    }
    # The print plate. Laid out with clear air between the parts, because
    # check_print_layout() refuses a pile — and a fixture that could not pass
    # the gates it is generated behind would be a fixture of nothing. The spacer
    # is absent from it for a rule of the same gate: the bed carries printables
    # and nothing else, because print.stl is a file somebody may slice.
    printed = {
        "id": "print",
        "name": "as printed",
        "parts": [
            "plate",
            {"part": "post", "at": cq.Location((22, 0, 0))},
            {"part": "cap", "at": cq.Location((-22, 0, 0))},
        ],
    }
    return [assembled, printed], parts


def export(out_dir):
    """Run the model through the real pipeline. Returns the two meta.json maps.

    `(view entries, parts catalogue)` — the two documents `build()` assembles
    meta.json out of, and every call below is one `src/cadbuild/build.py` makes,
    in that order.

    WHAT IS LEFT OUT is what a viewer payload has nothing to do with: the
    whole-build `assembled.stl` and `print.stl`, the PNG previews, the model's
    own `checks()` and metrics.json. THE PART EXPORTS ARE NO LONGER AMONG THEM,
    and that is the line of this docstring worth reading twice — this function
    used to be proud of writing no STL at all. `--data` publishes through the
    hub's own `render.build_meta`, and `render._catalogue` there refuses a
    `printable` that declares no files (and a non-printable that declares any),
    so a fixture generated without `export_printables` cannot be published.
    Nothing is committed for it: the STEP/STL/3MF land in the scratch directory
    beside the view files, and `assembled.json` is the only thing that leaves.

    THE THREE GATES ARE NOT A FORMALITY. `check_interference` is what decides
    where the spacer may stand (see `model()`), and all three together are what
    make the fixture a payload a real build would have accepted rather than one
    that happens to tessellate.
    """
    from types import SimpleNamespace

    from src.cadbuild.gate import (check_assembled_coverage, check_interference,
                                   check_print_layout)
    from src.cadbuild.parts import read_catalogue
    from src.cadbuild.printables import export_printables
    from src.cadbuild.views import export_views, prepare_views

    views, parts = model()
    out_dir.mkdir(parents=True, exist_ok=True)
    # THROUGH THE REAL READER rather than handing `prepare_views` the dict
    # above, and it buys two things. It normalises every record to the four keys
    # the rest of the build indexes (`shape`, `kind`, `color`, `note`), so what
    # travels on is what a real build carries; and it holds every key to the
    # BUILD's alphabet, MEMBER_RE, which is narrower than the hub's rule for the
    # same string — `render._check_part_name` accepts a space, `MEMBER_RE` does
    # not, so `reference spacer` is a key the hub would take and no build can
    # write. It reads `model.parts()`, so what goes in is the smallest object
    # that answers that call.
    catalogue = read_catalogue(SimpleNamespace(parts=lambda: parts))
    prepared = prepare_views(views, catalogue)
    check_print_layout(prepared, catalogue)
    check_assembled_coverage(prepared, catalogue)
    check_interference(prepared, catalogue)
    part_files, _measured = export_printables(catalogue, out_dir)
    entries = export_views(prepared, out_dir)

    # meta.json's `parts`, assembled the way `cadbuild.build` assembles it: the
    # kind of every entry whatever it is, the files of the ones that were
    # exported, the note where the author wrote one. No `preview` on any record,
    # because nothing here renders a picture.
    declared = {}
    for key, record in catalogue.items():
        entry = {"kind": record["kind"]}
        if key in part_files:
            entry["files"] = part_files[key]
        if record["note"]:
            entry["note"] = record["note"]
        declared[key] = entry
    return entries, declared


def write_fixture(out_dir):
    """Copy one exported view out of `out_dir` and over the committed fixture."""
    source = out_dir / f"{FIXTURE_VIEW}.json"
    # Byte-for-byte what the exporter wrote. Not re-serialised through
    # json.dumps() with indentation: a fixture that had been through somebody's
    # pretty-printer is no longer evidence of what the exporter emits, which is
    # the only reason this file exists.
    FIXTURE_PATH.write_bytes(source.read_bytes())
    print(f"{FIXTURE_PATH.relative_to(ROOT)}: "
          f"{FIXTURE_PATH.stat().st_size / 1024:.1f} KB")


def meta_json(entries, parts):
    """The meta.json a push carries beside its views.

    Only the fields src/render.py reads: it normalises the rest itself and
    rejects anything it does not recognise, so writing more would be guessing.

    `parts` IS THE CATALOGUE and it is required rather than decorative:
    `render._catalogue` refuses a document without a non-empty one, every key a
    view names in its own `parts` has to be a record in it
    (`render._view_parts`), and every key any leaf of a view FILE carries has to
    be one too (`render.check_view_file`). The view entries already carry those
    key lists — `export_views` writes them — so the two halves of this document
    are one statement made by one run rather than two lists kept in step by
    hand. `downloads` is gone with the flat maps it belonged to: what a part
    ships is filed under the part.
    """
    return {
        "project": "fixture",
        "title": FIXTURE_TITLE,
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "views": entries,
        "parts": parts,
    }


def payload_digest(out_dir, names):
    """A stable fingerprint of the exported views. Hex sha256.

    The hub uses this number for exactly one thing: telling a re-publish of the
    same thing from a genuinely new one. A real push digests the SOURCE tree it
    unpacked, because that is what the pusher supplied — and this fixture has no
    source tree at all: `model()` is right here and `export()` writes artefacts
    straight out of it. So the exported outputs are what there is to fingerprint.

    WHICH outputs is the load-bearing part, and the answer is the VIEW FILES
    and nothing else. meta.json is left out because it
    stamps the wall clock (`built`), so hashing it would make every run a
    different push: the slot would be rewritten each time, and whatever page the
    reader has open on /project/fixture0000/dev/ would be re-rendered under them
    for nothing. A random or time-based number would do the same, only always.
    The view files, in contrast, are a pure function of the model above and the
    pinned `cadquery`/`ocp-tessellate`, so re-running the target without touching
    either answers 200 and leaves the slot alone — which is the behaviour someone
    looking at the interface by hand actually wants.

    THE PART EXPORTS ARE OUT FOR THE SAME REASON, and that is a measurement
    rather than a caution: two runs of an unchanged model produce STEP and 3MF
    files that differ byte for byte, because both formats carry the moment they
    were written (measured 2026-09-01 on the pinned cadquery 2.8.0 — the binary
    STL of the same solid hashed identically across the two runs, the other two
    did not). Hashing them would rewrite the slot on every run, which is exactly
    what leaving `built` out avoids.

    That is the same reasoning `Store` applies to a real push, where the
    rewritten meta.json is deliberately outside the digest as well.
    """
    digest = hashlib.sha256()
    for name in sorted(names):
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update((out_dir / name).read_bytes())
    return digest.hexdigest()


def publish_to_data(out_dir, entries, parts, data_dir):
    """Put a real build in `data/` so `make run` has something to show.

    Through the hub's OWN store rather than by writing the directory by hand.
    `Store.publish_dev_built()` is what an actual push ends in — it validates
    every view file, writes the normalised meta.json and the payload digest, and
    swaps the local slot — so what lands under data/ is a build the hub made,
    not an imitation of one that would diverge the first time the layout changed.

    The SAME export the fixture came out of, handed in rather than recomputed:
    a second tessellation would take twice as long to produce a build that is
    only nearly the file the JS suite reads.

    WHAT IS HANDED OVER is an unpacked directory, not an archive: since the hub
    builds models itself (SPEC 8A.2 step 5) the build writes into the staging
    directory that is renamed into place, so unpacking happens before publishing
    rather than inside it. This target is the same shape with the build already
    done — which is why the export is copied into the staging directory the
    store names, and not published from the scratch directory it was written in:
    publication is a rename WITHIN the project directory (`Store.build_staging`).
    """
    from src.store import DEV_LINK, Store

    (out_dir / "meta.json").write_text(
        json.dumps(meta_json(entries, parts), indent=2) + "\n", encoding="utf-8")

    # What a build declares it ships, in the shape `publish_dev_built` takes it:
    # the list `src/cadbuild/build.py` returns, minus what this fixture does not
    # produce (no metrics.json, no assembled.stl, no print.stl, no pictures).
    #
    # THE PART FILES ARE ON IT AND HAVE TO BE: `render._check_declared_file`
    # answers "did this build ship a file called that" by looking the name up in
    # the map hashed from exactly this list, so a record naming `plate.stl` that
    # is not declared here is a 422 rather than a missing button.
    views = [entry["file"] for entry in entries]
    exported = sorted({name for record in parts.values()
                       for name in record.get("files", {}).values()})
    names = ["meta.json"] + views + exported

    store = Store(data_dir, max_build_bytes=64 * 1024 * 1024)
    staging = store.build_staging(FIXTURE_PID, DEV_LINK)
    shutil.copytree(out_dir, staging)
    try:
        status, answer = store.publish_dev_built(
            FIXTURE_PID, staging, names, payload_digest(out_dir, views))
    finally:
        # The caller owns the staging tree on every path except the one where
        # publishing renamed it away — the 200 above included, where the slot
        # already holds this build and nothing was moved.
        shutil.rmtree(staging, ignore_errors=True)
    print(f"published {status} into {data_dir}: {answer.get('url', '')}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--data", metavar="DIR",
        help="also publish a full build into this hub data directory "
             "(default: nothing is written outside ui/tests/fixtures/)")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as scratch:
        out_dir = Path(scratch) / "out"
        entries, parts = export(out_dir)
        write_fixture(out_dir)
        if args.data:
            publish_to_data(out_dir, entries, parts, Path(args.data).resolve())


if __name__ == "__main__":
    main()
