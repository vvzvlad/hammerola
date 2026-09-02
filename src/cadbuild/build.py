#!/usr/bin/env python3
"""The local build: gate the model, export it, write _out/."""

from datetime import datetime, timezone
import json
import shutil
import time

from .artifacts import ASSEMBLED_STEM, PREVIEW_SUFFIX
from .assembly import export_assembled, export_print_plate, render_previews
from .gate import check_print_layout, check_printables_shown
from .geometry import load_model
from .metrics import METRICS_NAME, collect_metrics, write_metrics
from .modelchecks import run_checks
from .printables import (collect_printables, export_printables,
                         overview_meshes, preview_files)
from .project import load_project
from .project_title import title_problem
from .views import PRINT_VIEW_ID, collect_notes, export_views, prepare_views


# WHERE THE TIME WENT, phase by phase, in the same shape every other timing in
# this build is printed in (`  name: 1.2s`, one decimal -- see
# assembly.render_previews and views.export_views).
#
# Each phase prints as it finishes rather than all of them in a block at the
# end, and that is the difference between a table and no table at all: a build
# that fails does so INSIDE a phase, and a summary printed after the last one
# never runs. What survives on the log is every phase that completed. The
# broken one is the one with NO line -- these print after the work, so a phase
# that raised never reaches its own print, and the first name missing from the
# list is where the build stopped. That is a reading, not a label: the log does
# not say which phase failed, it stops before saying it.
#
# PHASES ARE THE COARSE HALF ON PURPOSE. On a real model measured 2026-08-29 the
# checks phase was 495 seconds and 52% of it sat in ONE loop inside it -- a
# number no per-phase breakdown can produce. `checklib.section(...)` is the
# other half, and the two exist together (SPEC: the build prints both tables).
def _phase(name, since):
    """`  name: 1.2s`, and the moment to measure the next phase from."""
    print(f"  {name}: {time.monotonic() - since:.1f}s")
    return time.monotonic()


def build(out_dir, preview_mode="iso"):
    """Full local build. Returns (pid, meta, list of files to ship)."""
    started = time.monotonic()
    pid, project, title = load_project()
    model = load_model()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print(f"project {project} ({pid})")
    # RIGHT UNDER THE NAME IT IS ABOUT, and a warning rather than a refusal --
    # the same trade `_warn_if_checklib_shadowed` makes, for the same reason: a
    # part that is modelled and ready to print must not fail to publish over the
    # wording of its own name. What it catches is a card nobody can identify.
    # WHAT FOLLOWS IS WHY THE WARNING EXISTS, NOT WHAT IT CAN SAY: there are
    # eight message branches in `title_problem`, and the one most authors
    # actually meet is in none of the three below -- a plain `hammerola create`
    # with no `--title` writes the directory's slug into both fields, so the
    # card reads `t13-ceiling-mount` over `t13-ceiling-mount` and the warning is
    # the bare-slug sentence. The three this was built for: NOTHING names the
    # project, so it publishes under its own id; the `project` key names it but
    # the title carries no slug, so nothing in the words on the card ties them
    # to the name it publishes under; or the title carries SOMEBODY ELSE's slug,
    # which is what a project copied from another one looks like. Only the first
    # ends in publication under the id -- an earlier version of this comment
    # attached that consequence to the second as well, which stopped being true
    # when `hammerola create` began writing the key. `title_problem` is handed
    # the resolved `project` and not a directory name, and `pid` alongside it so
    # it can tell the case where the two are the same -- read its docstring
    # before changing any of the three arguments.
    problem = title_problem(title, project, pid)
    if problem:
        print(f"warning: {problem}")

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
    # meshes the shape in place: from then on the box OCCT hands back is the
    # MESH's, reading bigger than the shape and never smaller. A gate about
    # extents therefore belongs before any export, whatever the size of the
    # difference (drop_mesh has the measurements and how far they travel; gate
    # has what this particular gate would and would not notice). They are also
    # the cheapest checks in the run, so a model laid out wrong fails in
    # milliseconds instead of after the exports.
    printables = collect_printables(model)
    # printables goes in because a view is coloured by what is printed: a part
    # the gate can match to one gets a palette colour, everything else grey.
    prepared = prepare_views(model.views(), printables)
    check_print_layout(prepared)
    check_printables_shown(prepared, printables)
    # Everything above is the model's own geometry being computed -- the @cache
    # builders run for the first time here, which on a heavy model is most of
    # this number rather than the gates it is measured at the end of.
    phase = _phase("geometry", started)

    print("exporting printables:")
    downloads, part_metrics = export_printables(printables, out_dir)
    phase = _phase("printables", phase)

    # After the geometry gate (the STLs it checks are on disk now), before the
    # slow tessellation and before anything is packed.
    checks_passed = run_checks(model, out_dir)
    # Two lines about checks, and they answer different questions: run_checks
    # prints how many there were, this prints what they cost.
    phase = _phase("checks", phase)

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
    # The two lines above cost nothing, so this measures what the section really
    # spent -- and the name undersells it: `export_print_plate` above fuses the
    # `print` view into one compound, measures it and writes an STL, so the
    # phase carries a modelling step and not only the drawing of pictures. The
    # LAYOUT itself is the author's, made in views(); this only collects it.
    phase = _phase("rendering", phase)

    print("tessellating views:")
    views = export_views(prepared, out_dir)
    # The last phase, so its return value goes nowhere -- everything after this
    # is writing two small JSON documents, and the total below covers it.
    _phase("tessellation", phase)

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
    # The total, and it is deliberately not the sum of the phases above: the
    # writing of meta.json and metrics.json belongs to no phase, and a total
    # that quietly excluded it would make the phases look like the whole build.
    _phase("total", started)
    return pid, meta, files
