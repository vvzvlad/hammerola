#!/usr/bin/env python3
"""The local build: gate the model, export it, write _out/."""

from datetime import datetime, timezone
import functools
import json
import shutil
import time

from .artifacts import ASSEMBLED_STEM, ASSEMBLED_VIEW_ID, PREVIEW_SUFFIX, PRINT_VIEW_ID
from .assembly import export_assembled, export_print_plate, render_previews
from .checkunits import run_units
from .gate import (check_assembled_coverage, check_interference,
                   check_print_layout)
from .geometry import load_model
from .errors import BuildError
from .metrics import (METRICS_NAME, collect_metrics, read_baseline,
                      report_metrics, write_metrics)
from .modelchecks import (call_model, fail_site, raised_by_the_model,
                          run_checks)
from .modeltext import MAX_MESSAGE_CHARS, shown
from .parts import catalogue_colors, printable_keys, read_catalogue
from .paths import project_root
from .printables import export_printables, overview_meshes, preview_files
from .project import load_project
from .project_title import title_problem
# The module rather than its names: its exports are bare verbs (`collect`,
# `report`, `check`) that would clash with or read worse than
# `collect_metrics`/`report_metrics` here; `provenance.check(...)` says which.
from . import provenance
from .views import export_views, prepare_views


# Where the time went, phase by phase, in the same `  name: 1.2s` shape as
# assembly.render_previews and views.export_views.
#
# Each phase prints as it finishes, so a failed build's log still shows every
# completed phase; the first missing name is where it stopped.
#
# Phases are the coarse half; `checklib.section(...)` gives the fine-grained
# timing inside checks (SPEC: the build prints both tables).
def _phase(name, since):
    """`  name: 1.2s`, and the moment to measure the next phase from."""
    print(f"  {name}: {time.monotonic() - since:.1f}s")
    return time.monotonic()


def _answers_for_the_model(run):
    """The one handler that decides whose fault a failed build was.

    Sufficient, not necessary: a frame from the model's own tree on the stack
    proves the fault is the author's, and its absence proves nothing. It makes
    a model.py mistake end as EXIT_BUILD_FAILED wherever the author's code left
    a frame, including unwrapped places. `modelchecks.MODEL_DOORS` remains for
    the rest: at a door the message names the entrance and line (`parts()
    raised TypeError (model.py:5)`), and around `as_shape`/`as_shapes` the
    raising code is the CAD kernel's, leaving no model frame.

    A `BuildError` passes through untouched, as in `call_model`. `Exception`,
    not `BaseException`, also as in `call_model`: a `SystemExit` is terminal on
    every path (`buildproc.child` catches BaseException), and `run_checks` has
    its own branch for it.

    A decorator rather than an inner `_build`: `tests/cadbuild/test_model_doors.py`
    reads the `views()` site in `MODEL_DOORS` from a real traceback rooted at
    `build.build`.
    """
    @functools.wraps(run)
    def answering(*args, **kwargs):
        try:
            return run(*args, **kwargs)
        except BuildError:
            raise
        except Exception as exc:
            if not raised_by_the_model(exc):
                raise
            raise BuildError(
                f"model.py's own code raised {type(exc).__name__}"
                f"{fail_site(exc)}: "
                f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}") from exc

    return answering


@_answers_for_the_model
def build(out_dir, preview_mode="iso", force=False, baseline=None):
    """Full local build. Returns (pid, meta, list of files to ship).

    `force` skips the model's own checks() and nothing else: those
    are most of a build's cost on a real model, and the hub's gates apply to
    every model, so none of them is waived.

    `baseline` is a metrics.json to diff against: the previous `dev` build's,
    copied into this process's scratch by the parent
    (`buildproc.runner.run_build`), or None. It can only cost the printed
    comparison, never the build (see `metrics.report_metrics`).
    """
    started = time.monotonic()
    pid, project, title = load_project()
    model = load_model()

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    print(f"project {project} ({pid})")
    # Right under the name it is about, and a warning rather than a refusal (as
    # `_warn_if_checklib_shadowed`): a ready part must not fail to publish over
    # its name's wording. It catches a card nobody can identify: nothing names
    # the project (it publishes under its id); the title does not carry the
    # slug; or it carries another project's slug (a copied project). The most
    # common case is a plain `hammerola create` without `--title`, which writes
    # the slug into both fields. `title_problem` takes the resolved `project`
    # and `pid` -- read its docstring before changing the arguments.
    problem = title_problem(title, project, pid)
    if problem:
        print(f"warning: {problem}")

    # Importing model.py is its own phase: everything at module level of the
    # author's file runs here, and on a model that builds at import time this
    # is where the time goes. The mark covers everything from the start of the
    # build through the load; the rest before it is negligible.
    phase = _phase("model", started)

    # Provenance first: a rule about the source (the case of a name and the
    # type of a value, read off model.py), so it costs a parse and no geometry.
    # After the project line, so its estimates follow the project's name.
    # `collect()` and `unwrapped()` share one parse.
    model_lines = provenance.module_level_lines()
    declared = provenance.collect(model, model_lines)
    bare = provenance.unwrapped(model, model_lines)
    provenance.check(declared, bare, project_root())
    provenance_summary = provenance.report(declared)

    # Names, then the view gates: everything that can be wrong before a single
    # triangle exists, cheapest first.
    #
    # The catalogue (keys, kinds, notes, colours) and view dict shapes need no
    # geometry. The catalogue comes before the views because views reference
    # into it: `prepare_views` refuses unknown parts and paints leaves by kind.
    #
    # Then the view gates. Two read bounding boxes, and an export meshes the
    # shape in place, after which OCCT's box is the mesh's (never smaller), so
    # extent gates belong before any export (drop_mesh and gate have the
    # details). They are also cheap.
    #
    # `views()` is a door into the model (`modelchecks.MODEL_DOORS`) and is
    # called here because `prepare_views` has other callers and cannot own it.
    catalogue = read_catalogue(model)
    prepared = prepare_views(call_model("views()", model.views), catalogue)
    check_print_layout(prepared, catalogue)
    check_assembled_coverage(prepared, catalogue)
    # The catalogue, because the gate reads each leaf's kind: a mock is scenery
    # and is not checked for overlaps.
    check_interference(prepared, catalogue)
    # Everything above computes the model's geometry (the @cache builders run
    # for the first time here), so on a heavy model this is mostly geometry,
    # not gates. Measured from the load's mark, so import time is excluded.
    phase = _phase("geometry", phase)

    print("exporting printables:")
    part_files, part_metrics = export_printables(catalogue, out_dir)
    phase = _phase("printables", phase)

    # After the geometry gate (the STLs it checks are on disk now), before the
    # slow tessellation and before anything is packed.
    if force:
        # Both counts None, which means "unknown" (as `run_checks` answers for
        # an uncountable checks()). Nothing else about a forced build is
        # recorded in metrics.json or shown on the pages; the hub marks it in
        # meta.json (`forced`), and this one line, where the checks' verdict
        # would be, tells the pusher.
        checks_passed = checks_static = None
        print("checks: not run -- this push asked for the model's own checks "
              "to be skipped")
    else:
        # The registered units are the model's own checks too, so they are
        # skipped by `force` and their count folds into the same report.
        # `run_units` does nothing when the model registered none.
        checks_passed, checks_static = run_units(run_checks(model, out_dir))
    # run_checks prints how many checks there were, this prints their cost.
    # Printed for a forced build too: a phase with no line reads as the build
    # having stopped there (see `_phase`).
    phase = _phase("checks", phase)

    print("rendering:")
    # The catalogue, because the box is measured off the product: a leaf's kind
    # says whether it is product or scenery.
    assembled_parts, assembled_bbox = export_assembled(prepared, out_dir,
                                                       catalogue)
    # The meshes before the pictures: render_previews reads each stem's STL for
    # the footer and refuses a missing one. The pictures are drawn two phases
    # down, after the view documents exist.
    plate = export_print_plate(prepared, out_dir)
    stems = printable_keys(catalogue) + [ASSEMBLED_STEM]
    # Touching parts weld into one body when the mesh is loaded, so anything
    # holding several bodies needs its count, or its footer claims
    # watertightness.
    parts = {ASSEMBLED_STEM: assembled_parts}
    # None without a plate; `collect_metrics` then writes no `print_bbox_mm`.
    plate_bbox = None
    if plate is None:
        # No `warning:` prefix: a single part already in print orientation has
        # no `print` view, and that is fine. It names both missing files,
        # since `print.stl` is what somebody looks for.
        print(f"  {PRINT_VIEW_ID} view: none, so no {PRINT_VIEW_ID}.stl and no "
              f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}")
    else:
        plate_bodies, plate_bbox = plate
        stems.append(PRINT_VIEW_ID)
        parts[PRINT_VIEW_ID] = plate_bodies
    # Despite the name, this phase includes fusing the `print` view into one
    # compound, measuring it and writing an STL. No picture is drawn here (see
    # the previews phase).
    phase = _phase("rendering", phase)

    print("tessellating views:")
    views = export_views(prepared, out_dir)
    phase = _phase("tessellation", phase)

    # Every file is filed under what owns it: the part it is of or the view it
    # is of, so readers never parse ownership out of keys. `assembled.stl` and
    # `print.stl` belong to views and are not download buttons (see
    # overview_meshes).
    #
    # `overview` and `previews` are keyed by file stem, view entries by view
    # id. They meet only because `ASSEMBLED_STEM`/`ASSEMBLED_VIEW_ID` are both
    # "assembled" and "print" serves both roles. cadbuild.artifacts keeps the
    # names apart, so an explicit translation makes a rename of either fail
    # loudly here, and avoids hanging a part's picture on a view whose id
    # equals that part's key. Defined here because the previews phase uses it
    # too.
    stem_of_view = {ASSEMBLED_VIEW_ID: ASSEMBLED_STEM,
                    PRINT_VIEW_ID: PRINT_VIEW_ID}

    print("drawing previews:")
    # After the tessellation: a whole-view picture is drawn from the view
    # document the browser loads (the only thing with per-part colour, alpha
    # and placement), so the documents must exist first. A printable's own
    # picture is drawn from its STL in its catalogue colour, matching the
    # assembly.
    scenes = {stem_of_view[entry["id"]]: entry["file"] for entry in views
              if entry["id"] in stem_of_view}
    # The pictures actually written, so the preview map and the file list
    # below are facts. `cards` is the same for each whole view's bare tile
    # (front-page card), keyed by stem.
    written, cards = render_previews(out_dir, stems, preview_mode, parts=parts,
                                     colors=catalogue_colors(catalogue),
                                     scenes=scenes)
    overview = overview_meshes(plate is not None)
    previews = preview_files(written)
    # The two lines above cost nothing, so this is the drawing. The last
    # phase; the JSON writing after it is in the total.
    _phase("previews", phase)

    for entry in views:
        stem = stem_of_view.get(entry["id"])
        if stem is None:
            continue
        if stem in overview:
            entry["overview"] = overview[stem]
        if stem in previews:
            entry["preview"] = previews[stem]
        if stem in cards:
            entry["card"] = cards[stem]
    # Optional keys are absent rather than empty: an empty object would be a
    # second way of saying "none".
    parts_meta = {}
    for key, record in catalogue.items():
        entry = {"kind": record["kind"]}
        # Only a printable has files: nothing is exported for a bought screw or
        # the wall a bracket bolts to.
        if key in part_files:
            entry["files"] = part_files[key]
        if key in previews:
            entry["preview"] = previews[key]
        # The author's note travels only here: the tessellated view file is the
        # tessellator's document, and the catalogue stays in the build process.
        if record["note"]:
            entry["note"] = record["note"]
        parts_meta[key] = entry
    meta = {
        "project": project,
        "title": title,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "views": views,
        # The whole catalogue, every kind, exported or not: a reader can filter
        # printables out of it, but could not reconstruct the rest.
        "parts": parts_meta,
    }
    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    # Written after the checks, because it carries what they measured and how
    # many of them there were.
    write_metrics(out_dir, collect_metrics(project, part_metrics, checks_passed,
                                           checks_static, provenance_summary,
                                           assembled_bbox, plate_bbox))

    # What this build measured and what moved since `dev`: the only channel
    # that reaches the pusher without a second action. In `build()` rather
    # than the child, so every caller gets it and tests can hold it without a
    # CAD kernel.
    #
    # It cannot fail the build: `read_baseline` never raises and
    # `report_metrics` guards each walk separately, so an unreadable baseline
    # costs only the comparison. Both docstrings promise it and tests hold it.
    previous, why = read_baseline(baseline)
    report_metrics(out_dir, previous, why)

    # metrics.json is named here rather than derived from meta.json: the viewer
    # never loads it; the hub hands it to the next build as its baseline.
    shipped = ["meta.json", METRICS_NAME]
    shipped += [v["file"] for v in views]
    shipped += sorted({name for files in part_files.values()
                       for name in files.values()})
    # Overlaps meta.json on purpose. What exists depends on the build (no plate
    # without a `print` view, no pictures without a rendering stack), so the
    # names come from the same evidence meta.json's do (`plate`, `written`),
    # not from meta.json: that is what a reader is offered, this is what the
    # build wrote, and a file left off this list is hashed and checked by
    # nobody. Duplicates collapse below.
    shipped.append(f"{ASSEMBLED_STEM}.stl")
    if plate is not None:
        shipped.append(f"{PRINT_VIEW_ID}.stl")
    shipped += written
    # The cards: a file nothing declares is not served, so a card missing here
    # is a view pointing at a name the hub refuses (422).
    shipped += list(cards.values())
    # One entry per name, in order. Nothing above produces a duplicate (unique
    # keys, RESERVED_NAMES, RESERVED_STEMS, distinct suffixes in artifacts.py);
    # this is defence, and matters because each entry counts against
    # `limits.output_files`.
    files = list(dict.fromkeys(shipped))
    # Not the sum of the phases: writing meta.json and metrics.json belongs to
    # no phase.
    _phase("total", started)
    return pid, meta, files
