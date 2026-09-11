#!/usr/bin/env python3
"""What this build measured, and what moved since the last one.

Every number in metrics.json is one the gate measured anyway; nothing here
computes geometry. It is written next to the geometry, so the NEXT build of the
same project can read it back and say what changed.

ONE FUNCTION OF THIS MODULE STAYED ON THE CLIENT SIDE and is deliberately not
here: `check_project_match`, which refuses to publish over a snapshot belonging
to somebody else. It is about a laptop talking to a hub over HTTP, and it guards
against a copied project.json pointing at a stranger's id -- a question the hub
answers from its own store, not from a build's own numbers. Everything that is
pure -- the fingerprints, the diff, the summary and the printing -- came across
unchanged.

THE BASELINE IS A FILE, NOT A REQUEST, and that is the one thing this module
does differently from the laptop it came off. There it was `fetch_baseline`,
a GET of the previous metrics.json off `{hub}/project/<pid>/dev/`; inside the
hub the parent process copies that file out of the `dev` slot into the build's
own scratch and names it on the command line (`buildproc.runner.run_build`), and
`read_baseline` below opens the copy. A build process that had to reach the
network to publish would be a build that fails when the network does, and the
whole promise of the diff below is that it cannot fail a build (issue #59).

THE COMPARISON ITSELF NOW LIVES IN `hammerola/metricsdiff.py` and is imported back
here, so this module still exposes every name it always did. It moved because
metrics.json gained a SECOND reader that cannot import this one: `hammerola
diff` prints what moved between two published revisions, and the client is
stdlib-only and never imports the build half. Read that module's docstring for
why a shared module beat a second copy -- the short version is that a copy is
what broke publication once already.

WHY THE IMPORT IS ABSOLUTE where every other import in this package is
relative. `hammerola.metricsdiff` is outside the package, so there is no relative
spelling; naming `hammerola` is safe HERE because of when this module is
imported. A model is loaded with its own directory first on `sys.path`
(`geometry.load_model`), so a project with a `hammerola/` directory of its own
can shadow the name -- but that happens inside `build()`, and
`src.cadbuild.build` imports this module at its own import time, which is before
the child process reaches any model. THE NAME TO CHECK IS `hammerola` AND NOT
`src`: the shared modules moved into the client package when the tool got a
distribution name, so the directory a model could shadow this with is no longer
the one this sentence used to name.
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import tokenize

from hammerola.metricsdiff import (
    METRIC_FIELDS,
    METRICS_NAME,
    METRICS_REL_TOL,
    PHYSICAL_FIELDS,
    _field_moved,
    _moved,
    _part_summary,
    _shown,
    metrics_diff,
    metrics_summary,
    moved_fields,
    unchanged_code_moved_geometry,
)

from . import checklib
from .hubspec import DEV_LABEL
from .paths import project_root

# Re-exported on purpose: `from .metrics import METRICS_NAME` and
# `from src.cadbuild.metrics import metrics_diff` are what the build and its
# tests are written against, and moving the implementation must not move the
# names. Listed explicitly so a linter cannot decide the imports above are
# unused and delete the module's public surface.
__all__ = [
    "METRIC_FIELDS", "METRICS_NAME", "METRICS_REL_TOL", "METRICS_VERSION",
    "collect_metrics", "metrics_diff", "metrics_summary", "read_baseline",
    "report_metrics", "source_fingerprints", "unchanged_code_moved_geometry",
    "write_metrics",
]


# METRICS_NAME -- the file this writes and both readers fetch -- is imported
# above, from the module the readers share. Nothing on the hub has to know about
# it: the name passes the member rule, `.json` is a type the hub serves, and
# every member is reachable at its own URL, which is how the next build and
# `hammerola diff` read it back.
#
# Bumped when a reader of an older file would misread it. A build refuses to
# compare against a version it does not know and says so, rather than diffing
# fields that have quietly changed meaning. It stays HERE, with the writer: the
# readers do not enforce it (`metrics_diff` compares fields it recognises and
# ignores the rest), so a shared constant would only look as though they did.
#
# STILL 1 AFTER ISSUE #58, DELIBERATELY, and this is written down because the
# next reader's instinct is to bump it "just in case". That issue only ADDED
# fields -- two per part, and four on the assembly: the two boxes, the volume
# and the swept clearance -- and changed the meaning of none, so an older file
# is read exactly as correctly as it was before: the
# comparison walks the fields present in BOTH documents and passes over the
# rest. A bump would say the opposite -- that this file cannot be compared with
# what came before it -- and every revision already published would drop out of
# comparison the day it landed, which is the one thing an immutable revision is
# kept for.
METRICS_VERSION = 1


# --------------------------------------------------------------------------
# Metrics, and the comparison with the previous build
# --------------------------------------------------------------------------
#
# Every number in metrics.json is one the gate measured anyway; nothing here
# computes geometry. It rides in the archive, so the hub can hand it to the NEXT
# build of the same project as a baseline and that build can say what moved --
# which is the only form of "did that edit do what I meant" that does not
# involve opening two viewers side by side and squinting.
#
# TWO BLOCKS, AND THEY ANSWER DIFFERENT QUESTIONS. The summary says what this
# build measured and is printed on EVERY run: the numbers are in metrics.json
# too, but that file has to be fetched by name, while the log arrives on its own
# and arrives at whoever pushed. The diff says what moved since `dev` and is
# printed whenever there is a baseline -- including when nothing moved, because
# silence there is indistinguishable from a comparison that never happened.
#
# The summary is kept SHORT for a reason that is not taste, and the reason is at
# the call site rather than here (`report_metrics`, PHYSICAL_FIELDS): a face or
# triangle count is a fact about the TESSELLATION, not about the part, so it
# belongs where it explains why something moved -- in the diff below and in
# metrics.json -- and not on a line somebody reads to see what they just built.
#
# THIS ONCE SAID THE LOG IS READ ONCE AND NEVER RE-READ, and that was false in
# both halves. `_keep_the_code` does return early for the slot, but the build LOG
# is not what it handles: `JobStore` writes `data/jobs/<id>/log.txt`, jobs have no
# retention at all (AGENTS.md), and the slot's meta.json carries the job id
# precisely so `hammerola log dev` can read that log back as often as it likes
# (issue #79, `hammerola/sources.py:_dev_log`). Nothing about how long this text
# lives may be argued from that sentence again.


def _comment_free(text):
    """The source with comments stripped, or None if it will not tokenize.

    Indentation survives as structure (an INDENT token, not the spaces it was
    written with) so that moving a line into or out of a block still counts as
    a change of code. Blank lines and comments do not.
    """
    pieces = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(text).readline):
            if token.type in (tokenize.COMMENT, tokenize.NL):
                continue
            if token.type in (tokenize.INDENT, tokenize.DEDENT):
                pieces.append(f"<{token.type}>")
                continue
            pieces.append(token.string)
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    return "\x00".join(pieces)


def source_fingerprints(root=None):
    """Two hashes of the model source: as written, and with comments removed.

    Only the *.py at the root of the project -- model.py, mocks.py and whatever
    else the model imports from beside itself. The build machinery is
    deliberately out of it: it is an installed package now and lives nowhere
    near the project, so upgrading it cannot read as "the geometry changed".

    The second hash is the one with a job: it tells *only comments were
    touched* apart from a real edit, so that a rewritten comment does not read
    as a changed model. unchanged_code_moved_geometry is what reads it -- same
    hash and different solids means the source is not what changed. When the
    hash is empty the file did not tokenize (a syntax error in something
    nothing imports, say) and nothing may be claimed about it, which is why
    that check requires a non-empty one.
    """
    written = hashlib.sha256()
    code = hashlib.sha256()
    readable = True
    root = project_root() if root is None else Path(root)
    for path in sorted(root.glob("*.py")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            readable = False
            continue
        written.update(path.name.encode("utf-8"))
        written.update(text.encode("utf-8"))
        stripped = _comment_free(text)
        if stripped is None:
            readable = False
            continue
        code.update(path.name.encode("utf-8"))
        code.update(stripped.encode("utf-8"))
    return {"files": written.hexdigest(),
            "code": code.hexdigest() if readable else ""}


def collect_metrics(project, parts, checks_passed, checks_static, provenance,
                    bbox, print_bbox):
    """The build's numbers, in the shape metrics.json is written in.

    `checks_static` is how many of the checks the constants at the top of
    model.py settled on their own (see `modelchecks.static_asserts`). It rides
    beside `checks_passed` rather than inside it because it is a fact about the
    same set of checks: a project whose count fell while this rose lost nothing
    -- the checks were counted differently -- and one where this rose on its own
    is drifting towards a checks() that proves nothing.

    EITHER NUMBER MAY BE None, WHICH IS "COUNT UNKNOWN" AND NOT ZERO.
    `checks_passed` has always been able to be (`modelchecks.run_checks` answers
    it for a body nobody could count), and both of them are None on a build that
    skipped the model's own checks at the push's request. Nothing else in the
    file says so, deliberately: a forced build is not marked (issue #52).

    `provenance` is what `cadbuild.provenance.report` handed back at the top of
    the build: how many of this model's numbers were measured, derived or
    merely chosen, which ones nobody measured, and the note each declaration
    carries -- the sentence `derived()` promises its author will end up here. It
    is a REQUIRED argument rather than one with a default, because a default
    would let a caller drop the whole record by forgetting it, and the file
    would still look complete.

    `bbox` and `print_bbox` are the boxes `export_assembled` and
    `export_print_plate` measured BEFORE they meshed anything -- the product's
    own envelope, scenery excluded, and how much bed it takes to print. They are
    REQUIRED for the reason above, and they are taken rather than measured
    because measuring again here would measure the mesh (see either export's
    docstring).

    EITHER MAY BE None, AND THEN ITS KEY IS ABSENT rather than empty.
    `print_bbox` is None on a model with no `print` view, and an empty one would
    be this build saying it occupies no bed; `bbox` is None on a view holding
    nothing but mocks, where there is no product to measure at all and three
    zeroes would be this build saying it made something of no size.
    """
    # ONE ASSEMBLY, four kinds of number: how big the product is -- its own
    # envelope, with the scenery left out, because a mock overlaps the product
    # by construction and a box round it would report the wall rather than the
    # part standing against it -- how much bed it takes, how much material is
    # in it, and the two records the model's own checks() left behind. The
    # volume is SUMMED from what the gate already measured per part rather than
    # measured off the compound, because an assembly is glued and not fused and
    # a boolean union of it is minutes of work.
    #
    # SO IT IS A SUM OVER THE CATALOGUE AND NOT OVER THE SCENE, which is what
    # the issue asked for and is worth stating because the two differ: a part
    # placed several times in the `assembled` view -- five pins are five
    # references to one `pin`, and that is the ordinary case -- is counted ONCE
    # here. The number answers "how much material do the distinct printables
    # come to", not "how much filament does one product take".
    assembly = {
        "volume_mm3": sum(part["volume_mm3"] for part in parts.values()),
        # Empty unless the model's checks() called checklib.pairwise_interference
        # -- these are volumes it measured, never volumes computed for this file.
        "interference_mm3": checklib.recorded_interference(),
        # Empty unless it called checklib.swept_clearance, and empty the same
        # way: the tightest gap along a pair's travel, measured as the check
        # went. EMPTY RATHER THAN ABSENT, exactly as interference is: "this
        # model swept no pair" is an answer, and a reader has one way of asking.
        "clearance": checklib.recorded_clearance(),
    }
    if bbox is not None:
        assembly["bbox_mm"] = [bbox.xlen, bbox.ylen, bbox.zlen]
    if print_bbox is not None:
        assembly["print_bbox_mm"] = [print_bbox.xlen, print_bbox.ylen,
                                     print_bbox.zlen]
    return {
        "version": METRICS_VERSION,
        "project": project,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source_fingerprints(),
        # Beside `source` because it is about the same thing the two hashes
        # above are: the model as it was written, not the solid that came out.
        "provenance": provenance,
        "parts": parts,
        "assembly": assembly,
        "checks_passed": checks_passed,
        "checks_static": checks_static,
    }


def write_metrics(out_dir, metrics):
    """metrics.json, with the floats rounded to something a human can read."""
    def trim(value):
        if isinstance(value, bool):
            return value
        if isinstance(value, float):
            return round(value, 6)
        if isinstance(value, dict):
            return {k: trim(v) for k, v in value.items()}
        if isinstance(value, list):
            return [trim(v) for v in value]
        return value

    (out_dir / METRICS_NAME).write_text(
        json.dumps(trim(metrics), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def read_baseline(path):
    """The published `dev` metrics.json to compare against, and why not.

    Returns `(baseline, why)`: a dict this build knows how to read, or None
    with one clause saying what was wrong with it. Never raises -- everything
    it can be handed is a file somebody else published, and the caller's
    promise is that a diff cannot fail a build.

    What it settles is deliberately only what CAN be settled cheaply: the file
    parses, it is an object, and its `version` is one this build knows. Nothing
    about what is inside it -- `{"version": 1, "parts": {"body": 42}}` passes
    all three and is a TypeError in the middle of the comparison, which is why
    report_metrics keeps its guard.

    `path` IS None WHEN THE PARENT HAD NOTHING TO GIVE, which covers a project
    with no `dev` build and one whose slot the copy could not be made from
    (`buildproc.runner.run_build`). It is a path on the command line for
    everything else, and a path that is not there is a `dev` build that shipped
    no metrics.json -- a build older than this work, or one published by hand.
    """
    if path is None:
        # SAYS WHAT IS TRUE OF BOTH CASES AND NOT MORE. The paragraph above is
        # the reason: None also means the copy could not be made from a slot
        # that IS there, so "this project has no dev build yet" -- which is what
        # this said -- told an author who pushes `dev` every day that they do
        # not. The parent knows which of the two it was; this side does not, and
        # a line printed to whoever pushed may not assert what it cannot see.
        return None, f"this build was handed no {DEV_LABEL} {METRICS_NAME}"
    # ONE CLAUSE FOR EVERY WAY THE FILE IS NOT A DOCUMENT -- it would not open,
    # it is not UTF-8, it is not JSON, it is not an object. They are one answer
    # to whoever pushed ("what is in the slot cannot be read"), and telling them
    # apart in the log would describe the hub's volume to somebody who cannot
    # look at it.
    unreadable = f"the {METRICS_NAME} published as {DEV_LABEL} is not readable"
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, f"the {DEV_LABEL} build published no {METRICS_NAME}"
    except (OSError, UnicodeDecodeError):
        return None, unreadable
    try:
        baseline = json.loads(text)
    except (ValueError, RecursionError):
        # RecursionError beside the ValueErrors for the reason `hub._payload`
        # gives: `json.loads` recurses per nesting level, so a file of nothing
        # but brackets raises that instead.
        return None, unreadable
    if not isinstance(baseline, dict):
        return None, unreadable
    version = baseline.get("version")
    if version != METRICS_VERSION:
        # The behaviour the comment on METRICS_VERSION promises: a build
        # refuses to compare against a version it does not know and says so,
        # rather than diffing fields that have quietly changed meaning.
        return None, (f"the {METRICS_NAME} published as {DEV_LABEL} is version "
                      f"{version}, this build writes version {METRICS_VERSION}")
    return baseline, None


def report_metrics(out_dir, baseline, why):
    """Print what this build measured, and what moved since the `dev` build.

    TWO BLOCKS AND ONE OF THEM IS UNCONDITIONAL. The summary is what this build
    measured and is printed on every run, with or without a baseline: the log
    is the only channel that arrives at whoever pushed without a second action,
    and it must not depend on whether there was a previous build. The diff
    follows it when there is a baseline, and it prints even when nothing moved
    -- with how many numbers were compared, because silence reads exactly like
    a comparison that never happened.

    THIS NEVER FAILS A BUILD, and that promise has to hold against the baseline
    as well as against the network. read_baseline settles two things about the
    file the parent handed over -- an object, of a version this build knows --
    and nothing at all about what is inside it. `{"version": 1, "parts":
    {"body": 42}}` is a perfectly good answer to both questions and a TypeError
    in the middle of the comparison; a string where a measured volume belongs is
    a ValueError in a format specifier. Neither is a BuildError, so neither is
    caught by main(), and a build that modelled, gated and was ready to publish
    would go red over the shape of a file whose entire job is a printed diff --
    with the docstrings and the documentation both promising it cannot.

    SO EACH BLOCK CARRIES ITS OWN GUARD, and that is what makes the first
    paragraph true rather than aspirational. The whole comparison sits under one
    of them rather than each field under its own: the failures are not a list to
    enumerate, they are every way a dict of unknown shape can be walked, and one
    line saying the published file is not one is the right amount to say about
    all of them. unchanged_code_moved_geometry is inside that guard, because it
    walks the same two dicts and is no safer than the diff is. The SUMMARY is
    NOT, and that is the whole reason there are two guards: it walks the
    document this build just wrote, and under the baseline's guard a baseline
    that is rubbish inside cost the sizes as well as the diff -- a build that
    printed no numbers at all, which is the defect this block exists to fix,
    arriving by a different road. Each guard covers its own printing too, but
    each block's lines are built first on purpose -- a formatting error then
    happens before anything reaches the terminal, instead of halfway through a
    block.

    WHAT IS PRINTED HERE IS NOT EVIDENCE OF ANYTHING. The model runs in this
    process and can rewrite both its baseline and this output; publication goes
    by the file list the PARENT verified and by the exit code, and no decision
    in the hub may ever be attached to this text.
    """
    try:
        current = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # The build wrote it moments ago. If it is not there, the missing file
        # is the build's problem to report, not this line's.
        return
    # THE SUMMARY, AND IT IS OWED WHETHER OR NOT THERE IS A BASELINE. Nothing
    # in this block touches `baseline` except to pick the heading, so nothing
    # the previous build published can take these lines away.
    try:
        if baseline is None:
            lines = [f"metrics: nothing to compare against -- {why}. "
                     "This build:"]
        else:
            lines = ["metrics, this build:"]
        # PHYSICAL_FIELDS: what the part came out as, not how it was
        # tessellated. The face and triangle counts stay in metrics.json and in
        # the diff below, where they answer WHY something moved.
        lines += [f"  {line}"
                  for line in metrics_summary(current, fields=PHYSICAL_FIELDS)]
        for line in lines:
            print(line)
    except Exception:
        print(f"metrics: this build's own {METRICS_NAME} could not be "
              "summarised, so there are no sizes to print")
    if baseline is None:
        return
    # THE DIFF, under a guard of its own: everything below walks a document
    # somebody else published, and one line is the right amount to say about
    # every way that walk can end.
    try:
        moved = metrics_diff(baseline, current)
        # Last, and after the numbers it is a conclusion about: the diff says
        # WHAT moved, this says the source cannot be why.
        shifted = unchanged_code_moved_geometry(baseline, current)
        if shifted:
            moved.append(
                f"! the geometry changed but the code did not ({', '.join(shifted)}) "
                f"-- the same model source built into a different solid than the "
                f"one published as {DEV_LABEL}. Both builds ran here, so what "
                "moved between them is the CAD stack this image resolves"
            )
        lines = ["", f"metrics vs {DEV_LABEL}:"]
        if moved:
            lines += [f"  {line}" for line in moved]
        else:
            # HOW MANY, and `part numbers` rather than `numbers`, for the
            # reasons `revdiff._print_geometry` gives at the same sentence: two
            # documents with no field in common compare nothing and move
            # nothing, and `moved_fields` walks `parts` only while the diff
            # above also compares the assembly and the check counts.
            compared = moved_fields(baseline, current)["compared"]
            lines.append(f"  every measured number is the same "
                         f"({compared} part numbers compared)")
        for line in lines:
            print(line)
    except Exception:
        print(f"metrics: the {METRICS_NAME} published as {DEV_LABEL} is not "
              "shaped like one, so there is nothing to compare against")
