#!/usr/bin/env python3
"""The local build: gate the model, export it, write _out/."""

from datetime import datetime, timezone
import json
import shutil

from .artifacts import ASSEMBLED_STEM, PREVIEW_SUFFIX
from .assembly import export_assembled, export_print_plate, render_previews
from .gate import check_print_layout, check_printables_shown
from .geometry import load_model
from .metrics import METRICS_NAME, collect_metrics, write_metrics
from .modelchecks import run_checks
from .printables import (collect_printables, export_printables,
                         overview_meshes, preview_files)
from .project import load_project
from .views import PRINT_VIEW_ID, collect_notes, export_views, prepare_views


def build(out_dir, preview_mode="iso"):
    """Full local build. Returns (pid, meta, list of files to ship)."""
    pid, project, title = load_project()
    model = load_model()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print(f"project {project} ({pid})")

    # Names, then the two view gates -- everything that can be wrong before a
    # single triangle exists, in the order it costs least to find out.
    #
    # NAMES FIRST. Part names, the download labels they turn into, view ids and
    # the shape of every view dict: all of it is rules about strings, none of
    # it needs geometry. The label rule in particular used to be applied inside
    # the export loop, so a name a couple of characters over the hub's 32 went
    # red only after the parts ahead of it had been built, exported and meshed
    # -- a whole build spent on an answer that was in the source all along.
    #
    # The shape of every view is settled in the same breath, and that includes
    # refusing the retired parallel-list form: it is a rule about the source,
    # so it goes red before a single part is exported and the output stays
    # short enough to read the rewritten views printed in the message.
    #
    # THEN THE VIEW GATES. Both read bounding boxes and names, and an export
    # meshes the shape in place: from then on OCCT measures bounding boxes off
    # the mesh, which on a filleted part is out by tenths of a millimetre (that
    # is what drop_mesh is for). They are also the cheapest checks in the run,
    # so a model laid out wrong fails in milliseconds instead of after the
    # exports.
    printables = collect_printables(model)
    # printables goes in because a view is coloured by what is printed: a part
    # the gate can match to one gets a palette colour, everything else grey.
    prepared = prepare_views(model.views(), printables)
    check_print_layout(prepared)
    check_printables_shown(prepared, printables)

    print("exporting printables:")
    downloads, part_metrics = export_printables(printables, out_dir)
    # After the geometry gate (the STLs it checks are on disk now), before the
    # slow tessellation and before anything is packed.
    checks_passed = run_checks(model, out_dir)

    print("rendering:")
    assembled_parts = export_assembled(prepared, printables, out_dir)
    # THE PLATE BEFORE THE PICTURES, and the order is the correctness here:
    # render_previews renders a stem from the STL already sitting next to it and
    # refuses one whose file is missing.
    plate = export_print_plate(prepared, out_dir)
    stems = list(printables) + [ASSEMBLED_STEM]
    # `parts` is what stops a picture printing a false fact: touching parts weld
    # into one body when the mesh is loaded, so anything holding several bodies
    # has to arrive with its own count or its footer claims watertightness.
    parts = {ASSEMBLED_STEM: assembled_parts}
    if plate is None:
        # Said plainly and WITHOUT the `warning:` prefix: a model whose single
        # part is already in print orientation has no `print` view to draw, and
        # that is not something to tell its author off for.
        #
        # It names the MESH as well as the picture, because both are missing
        # along with their two download buttons, and `print.stl` is what
        # somebody goes looking for; a line about the picture alone leaves the
        # other absence unexplained. Indented like every other line of this
        # section, so it reads as one of them rather than as a heading.
        print(f"  {PRINT_VIEW_ID} view: none, so no {PRINT_VIEW_ID}.stl and no "
              f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}")
    else:
        plate_bodies, _plate_bbox = plate
        stems.append(PRINT_VIEW_ID)
        parts[PRINT_VIEW_ID] = plate_bodies
    # KEPT, not discarded: this is the list of pictures that were really
    # written, and both things built out of it below -- the preview map and the
    # file list -- are only true because it is a fact and not a plan.
    written = render_previews(out_dir, stems, preview_mode, parts=parts)
    overview = overview_meshes(plate is not None)
    previews = preview_files(written)

    print("tessellating views:")
    views = export_views(prepared, out_dir)

    # THREE MAPS AND NOT ONE, because "a client may fetch this" and "the page
    # draws a button for this" used to be the same statement and they are not
    # the same thing. `downloads` is per PART, cut up by part name in the
    # browser, and it is the only one with buttons; `overview` is the two meshes
    # about the whole build; `previews` is every picture there is, the per-part
    # ones included. The last two are declared so they can be FETCHED -- an
    # undeclared file is one nothing can find except by assembling its URL --
    # and neither is drawn: see overview_meshes for why a `print.stl` button
    # would be the wrong offer to put on a public page.
    meta = {
        "project": project,
        "title": title,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "views": views,
        "downloads": downloads,
        # Unconditional, unlike the two optional keys below: `export_assembled`
        # either writes assembled.stl or raises, so this map is never empty.
        "overview": overview,
    }
    # Absent rather than empty when nothing was rendered, for the reason the
    # notes below are: an empty object is a build SAYING it has no pictures, so
    # a reader would have two ways of asking one question -- and a build made
    # before this key existed answers only one of them.
    if previews:
        meta["previews"] = previews
    # The author's notes, keyed by part NAME rather than by anything the
    # tessellator produces: the per-part dicts of views() do not survive into
    # meta.json (`views` is a list of files here) and the tessellated view file
    # is the tessellator's own document, so this is the only way they travel.
    # The key is ABSENT when nothing declared one -- a build with no notes and
    # a build made before notes existed have to reach the hub as one document.
    notes = collect_notes(prepared)
    if notes:
        meta["notes"] = notes
    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    # Written after the checks, because it carries what they measured and how
    # many of them there were.
    write_metrics(out_dir, collect_metrics(project, part_metrics, checks_passed))

    # metrics.json is named HERE and not derived from meta.json like the rest.
    # meta.json lists what the viewer loads, and the viewer never loads this --
    # it is written for the next build of this project to read back off `dev`.
    shipped = ["meta.json", METRICS_NAME]
    shipped += [v["file"] for v in views]
    shipped += sorted(set(downloads.values()))
    # DELIBERATE REDUNDANCY, not the sole source: `overview` and `previews` name
    # the same files again, so this list overlaps them by construction. HOW MUCH
    # OF IT EXISTS DEPENDS ON THE BUILD, which is why this cannot be written as
    # "both meshes and every picture" -- there is no plate without a `print`
    # view, and no picture at all on a python with no rendering stack, and both
    # of those are degradations this build supports.
    # The names below are therefore taken from the same evidence the maps are
    # (`plate`, `written`) rather than FROM the maps, because the two answer
    # different questions -- a map is what a reader is offered, this is what the
    # build says it wrote -- and making the second a function of the first would
    # let a later narrowing of an offer stop declaring a file that is still on
    # disk. That is the one thing nothing catches: what is not on this list is
    # hashed by nothing and checked by nobody. Repeating costs nothing, the
    # names collapse below.
    shipped.append(f"{ASSEMBLED_STEM}.stl")
    if plate is not None:
        shipped.append(f"{PRINT_VIEW_ID}.stl")
    shipped += written
    # One entry per name, in the order they were added. NOTHING ABOVE CAN
    # PRODUCE A DUPLICATE TODAY, and writing that down is the point of this
    # comment rather than an argument for deleting the line: the download values
    # arrive as a set, a view file is `<vid>.json` under an id that is unique and
    # cannot be `meta` or `metrics` (RESERVED_NAMES), both whole-build stems are
    # refused to printables (RESERVED_STEMS), and the pictures are the only
    # `.png`s here. So this collapse is defence against the NEXT writer of this
    # function, not the folding of an overlap that exists -- and being wrong
    # about that costs more than tidiness: a repeat costs the output hash nothing
    # (it builds a dict) but is counted one by one against the ceiling on how
    # many files a build may declare (`limits.output_files`).
    files = list(dict.fromkeys(shipped))
    return pid, meta, files
