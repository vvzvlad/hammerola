#!/usr/bin/env python3
"""The local build: gate the model, export it, write _out/."""

from datetime import datetime, timezone
import functools
import json
import shutil
import time

from .artifacts import ASSEMBLED_STEM, ASSEMBLED_VIEW_ID, PREVIEW_SUFFIX, PRINT_VIEW_ID
from .assembly import export_assembled, export_print_plate, render_previews
from .gate import (check_assembled_coverage, check_interference,
                   check_print_layout)
from .geometry import load_model
from .errors import BuildError
from .metrics import METRICS_NAME, collect_metrics, write_metrics
from .modelchecks import (call_model, fail_site, raised_by_the_model,
                          run_checks)
from .modeltext import MAX_MESSAGE_CHARS, shown
from .parts import printable_keys, read_catalogue
from .paths import project_root
from .printables import export_printables, overview_meshes, preview_files
from .project import load_project
from .project_title import title_problem
# THE MODULE AND NOT ITS NAMES, which is the one import here written that way.
# Everything it exports is a bare verb, and every one of them would need an
# alias to read as anything at a call site in this file: `collect` and `report`
# sit beside `collect_metrics` and `report_metrics`, which are about something
# else entirely, and `check` on its own says nothing at all.
# `provenance.check(...)` says which. HOW MANY OF THEM THIS FILE USES IS
# DELIBERATELY NOT WRITTEN DOWN: the sentence that was said four and then named
# three, leaving `unwrapped` to be found by whoever noticed the arithmetic, and
# a fifth function would have made it false with nothing to fail on.
from . import provenance
from .views import export_views, prepare_views


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


def _answers_for_the_model(run):
    """The one handler that decides whose fault a failed build was.

    SUFFICIENT AND NOT NECESSARY: a frame from the model's own tree on the
    stack proves the fault is the author's, and its ABSENCE PROVES NOTHING.
    What it buys is that a mistake in a model.py ends the build as
    EXIT_BUILD_FAILED -- "the model said no" -- wherever the author's code left
    a frame, INCLUDING the places nobody thought to wrap. That is most of them,
    and the reason `modelchecks.MODEL_DOORS` still exists is the rest: at a
    door the message names the entrance and the line (`parts() raised TypeError
    (model.py:5)`), where this can only say that the model's own code raised
    something, and at the two round `as_shape`/`as_shapes` the fault leaves NO
    model frame at all, because the code that raises is the CAD kernel's.

    A `BuildError` PASSES THROUGH UNTOUCHED for the reason `call_model` gives:
    everything below already speaks in those terms, and wrapping a considered
    refusal again would put a second sentence in front of it.

    `Exception` AND NOT `BaseException`, also for `call_model`'s reason: a
    `SystemExit` out of a model is terminal on every path already
    (`buildproc.child` catches BaseException), so there is no green-and-published
    outcome to guard against -- and the one place that DOES need to tell a
    SystemExit apart, `run_checks`, has its own branch for it.

    A DECORATOR AND NOT A `try:` AROUND THE BODY, for one measurable reason:
    the site in `MODEL_DOORS` is read out of a real traceback by
    `tests/cadbuild/test_model_doors.py`, and the `views()` entry there is
    rooted at `build.build`. Splitting the body into an inner `_build` would
    rename it to `build._build` -- a rewrite of the list to keep a refactor
    invisible.
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
def build(out_dir, preview_mode="iso", force=False):
    """Full local build. Returns (pid, meta, list of files to ship).

    `force` skips the model's own checks() and NOTHING else (issue #52): the
    call below is not made at all, because on a real model those checks are
    most of what a build costs and the point of the flag is to get something
    unfinished published quickly. Every gate this file runs is the hub's rule
    for every model rather than this author's, so none of them is waived.
    """
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

    # WHERE THE NUMBERS CAME FROM, first of all of these. It is a rule about
    # the SOURCE -- the case of a name and the type of a value, read off the
    # file the model was imported from -- so it costs a parse and no geometry
    # at all, and it belongs at the head of the section below rather than
    # anywhere further down. It is spoken here, after `load_model()` and after
    # the line naming the project, so that the estimates it prints are attached
    # to a project the reader has already been told the name of.
    declared = provenance.collect(model)
    bare = provenance.unwrapped(model)
    provenance.check(declared, bare, project_root())
    provenance_summary = provenance.report(declared)

    # Names, then the view gates -- everything that can be wrong before a
    # single triangle exists, in the order it costs least to find out.
    #
    # NAMES FIRST. Catalogue keys, kinds, notes, colours, view ids and the shape
    # of every view dict: all of it is rules about strings and about the shape
    # of a dict, none of it needs geometry. So a catalogue that cannot be read
    # costs milliseconds rather than a build.
    #
    # THE CATALOGUE BEFORE THE VIEWS, because a view is a list of references
    # INTO it: `prepare_views` refuses a reference to a part that does not
    # exist, and it paints each leaf by what the catalogue says the part is.
    #
    # THEN THE VIEW GATES. Two of the three read bounding boxes, and an export
    # meshes the shape in place: from then on the box OCCT hands back is the
    # MESH's, reading bigger than the shape and never smaller. A gate about
    # extents therefore belongs before any export, whatever the size of the
    # difference (drop_mesh has the measurements and how far they travel; gate
    # has what these gates would and would not notice). They are also the
    # cheapest checks in the run, so a model laid out wrong fails in
    # milliseconds instead of after the exports.
    #
    # `views()` IS A DOOR INTO THE MODEL (`modelchecks.MODEL_DOORS` is the
    # list) and this is where it sits, because unlike `parts()` there is no
    # single function of ours that both calls it and reads it. Its answer goes
    # straight into `prepare_views`, which is called from elsewhere too and
    # therefore cannot own the call.
    catalogue = read_catalogue(model)
    prepared = prepare_views(call_model("views()", model.views), catalogue)
    check_print_layout(prepared, catalogue)
    check_assembled_coverage(prepared, catalogue)
    # The catalogue, because the gate reads each leaf's KIND out of it: a mock
    # is scenery and is not asked whether it shares space with anything.
    check_interference(prepared, catalogue)
    # Everything above is the model's own geometry being computed -- the @cache
    # builders run for the first time here, which on a heavy model is most of
    # this number rather than the gates it is measured at the end of.
    phase = _phase("geometry", started)

    print("exporting printables:")
    part_files, part_metrics = export_printables(catalogue, out_dir)
    phase = _phase("printables", phase)

    # After the geometry gate (the STLs it checks are on disk now), before the
    # slow tessellation and before anything is packed.
    if force:
        # BOTH COUNTS ARE None, WHICH ALREADY MEANS "UNKNOWN" HERE: `run_checks`
        # answers `passed=None` for a checks() nobody could count, and
        # metrics.json has always carried that. A number would be this build
        # claiming something was counted.
        #
        # ONE LINE, ADDRESSED TO WHOEVER PUSHED, and it is not a badge: nothing
        # about a forced build is recorded in metrics.json, in the build page or
        # in the project card. It sits where the checks' own verdict would be,
        # so the log reads in the same order either way.
        checks_passed = checks_static = None
        print("checks: not run -- this push asked for the model's own checks "
              "to be skipped")
    else:
        checks_passed, checks_static = run_checks(model, out_dir)
    # Two lines about checks, and they answer different questions: run_checks
    # prints how many there were, this prints what they cost. It is printed for
    # a forced build too, and deliberately: a phase with NO line is how this log
    # says the build stopped there (see `_phase`), so a skipped phase that
    # printed nothing would read as a build that died in the checks.
    phase = _phase("checks", phase)

    print("rendering:")
    # The catalogue, because the box is measured off the PRODUCT: a leaf's kind
    # is what says whether it is the product or the scenery around it.
    assembled_parts, assembled_bbox = export_assembled(prepared, out_dir,
                                                       catalogue)
    # THE PLATE BEFORE THE PICTURES, and the order is the correctness here:
    # render_previews renders a stem from the STL already sitting next to it and
    # refuses one whose file is missing.
    plate = export_print_plate(prepared, out_dir)
    stems = printable_keys(catalogue) + [ASSEMBLED_STEM]
    # `parts` is what stops a picture printing a false fact: touching parts weld
    # into one body when the mesh is loaded, so anything holding several bodies
    # has to arrive with its own count or its footer claims watertightness.
    parts = {ASSEMBLED_STEM: assembled_parts}
    # None when there is no plate, and `collect_metrics` writes no
    # `print_bbox_mm` for it -- see the branch below for why a build can have
    # no `print` view at all.
    plate_bbox = None
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
        plate_bodies, plate_bbox = plate
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

    # EVERYTHING IS FILED UNDER WHAT OWNS IT, and that is the whole shape of
    # this document. It used to be four flat maps side by side -- `downloads`
    # keyed by a label of the form `<part>.<ext>`, `overview` and `previews`
    # keyed by a stem that was sometimes a part and sometimes a view id, `notes`
    # keyed by a part name -- so every reader had to work out from the KEY which
    # kind of thing it was holding, by splitting strings. The viewer did exactly
    # that and got it wrong on a part with a dot in its name.
    #
    # Now a file belongs to the part it is of, or to the view it is of, and the
    # ownership is stated rather than parsed. `assembled.stl` and `print.stl`
    # belong to views because that is what they are pictures of -- and they are
    # still not buttons: see overview_meshes for why a `print.stl` button would
    # be the wrong offer to put on a public page.
    #
    # WHAT FOLLOWS IS A SEAM BETWEEN TWO NAMESPACES and it is worth naming,
    # because it breaks silently. `overview` and `previews` are keyed by a FILE
    # STEM; a view entry is keyed by a VIEW ID. The two meet in exactly two
    # places, and only because the strings are equal: `ASSEMBLED_STEM` and
    # `ASSEMBLED_VIEW_ID` are both "assembled", and "print" is one word doing
    # both jobs. cadbuild.artifacts keeps those names apart deliberately so a
    # rename of one does not move the other -- which means a rename of either
    # lands HERE, as a view that quietly declares no picture and no mesh rather
    # than as a failure. Writing the translation out is what makes the rename
    # visible: this dict stops compiling the day one of them changes. It also
    # closes a collision the plain `vid in previews` had -- `previews` is keyed
    # by catalogue keys too, so a view id that happened to equal a part's name
    # hung that PART's picture on the view.
    stem_of_view = {ASSEMBLED_VIEW_ID: ASSEMBLED_STEM,
                    PRINT_VIEW_ID: PRINT_VIEW_ID}
    for entry in views:
        stem = stem_of_view.get(entry["id"])
        if stem is None:
            continue
        if stem in overview:
            entry["overview"] = overview[stem]
        if stem in previews:
            entry["preview"] = previews[stem]
    # Optional keys are ABSENT rather than empty, throughout: an empty object is
    # a build SAYING it has none of something, so a reader would have two ways
    # of asking one question.
    parts_meta = {}
    for key, record in catalogue.items():
        entry = {"kind": record["kind"]}
        # Only a printable has files, which is the point of the kind: nothing
        # is exported for a bought screw or for the wall a bracket bolts to.
        if key in part_files:
            entry["files"] = part_files[key]
        if key in previews:
            entry["preview"] = previews[key]
        # The author's note. It has nowhere else to travel: the tessellated view
        # file is the tessellator's own document, and the catalogue itself does
        # not leave the build process.
        if record["note"]:
            entry["note"] = record["note"]
        parts_meta[key] = entry
    meta = {
        "project": project,
        "title": title,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "views": views,
        # THE CATALOGUE, as the build published it: every part, whatever its
        # kind, whether or not anything was exported for it. A reader that
        # wanted only the printed ones can see which those are; a reader given
        # only the printed ones could never reconstruct the rest.
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

    # metrics.json is named HERE and not derived from meta.json like the rest.
    # meta.json lists what the viewer loads, and the viewer never loads this --
    # it is written for the next build of this project to read back off `dev`.
    shipped = ["meta.json", METRICS_NAME]
    shipped += [v["file"] for v in views]
    shipped += sorted({name for files in part_files.values()
                       for name in files.values()})
    # DELIBERATE REDUNDANCY, not the sole source: meta.json names the same files
    # again -- on the views and on the parts -- so this list overlaps it by
    # construction. HOW MUCH
    # OF IT EXISTS DEPENDS ON THE BUILD, which is why this cannot be written as
    # "both meshes and every picture" -- there is no plate without a `print`
    # view, and no picture at all on a python with no rendering stack, and both
    # of those are degradations this build supports.
    # The names below are therefore taken from the same evidence meta.json's are
    # (`plate`, `written`) rather than FROM meta.json, because the two answer
    # different questions -- that document is what a reader is offered, this is
    # what the build says it wrote -- and making the second a function of the
    # first would
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
    # comment rather than an argument for deleting the line: the part files
    # arrive as a set and are named after keys that are unique by being dict
    # keys, a view file is `<vid>.json` under an id that is unique and cannot be
    # `meta` or `metrics` (RESERVED_NAMES), both whole-build stems are refused
    # to the catalogue (RESERVED_STEMS), and the pictures are the only `.png`s
    # here. So this collapse is defence against the NEXT writer of this
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
