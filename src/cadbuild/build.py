#!/usr/bin/env python3
"""The local build: gate the model, export it, write _out/."""

from datetime import datetime, timezone
import json
import shutil

from .artifacts import ASSEMBLED_STEM
from .assembly import export_assembled, render_previews
from .gate import check_print_layout, check_printables_shown
from .geometry import load_model
from .metrics import METRICS_NAME, collect_metrics, write_metrics
from .modelchecks import run_checks
from .printables import collect_printables, export_printables
from .project import load_project
from .views import collect_notes, export_views, prepare_views


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
    render_previews(out_dir, list(printables) + [ASSEMBLED_STEM], preview_mode,
                    parts={ASSEMBLED_STEM: assembled_parts})

    print("tessellating views:")
    views = export_views(prepared, out_dir)

    meta = {
        "project": project,
        "title": title,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "views": views,
        "downloads": downloads,
    }
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
    files = ["meta.json", METRICS_NAME]
    files += [v["file"] for v in views]
    files += sorted(set(downloads.values()))
    return pid, meta, files
