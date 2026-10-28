#!/usr/bin/env python3
"""What this build measured, and what moved since the last one.

Every number in metrics.json is one the gate measured anyway; nothing here
computes geometry. It is written next to the geometry, so the NEXT build of the
same project can read it back and say what changed.

The baseline is a file: the parent copies the previous metrics.json out of the
`dev` slot into the build's scratch and names it on the command line
(`buildproc.runner.run_build`), and `read_baseline` opens the copy. The build
never touches the network, so the diff cannot fail a build.

The comparison lives in `hammerola/metricsdiff.py` and is imported back here:
`hammerola diff` also reads metrics.json, and the client is stdlib-only and
never imports the build half. See that module's docstring for why it is shared
rather than copied.

The import is absolute because `hammerola.metricsdiff` is outside the package.
A model's own `hammerola/` directory could shadow the name once the model is
loaded (`geometry.load_model` puts its directory first), but this module is
imported when `src.cadbuild.build` is, before the child reaches any model.
"""

from datetime import datetime, timezone
from importlib import metadata
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
    metrics_diff,
    metrics_summary,
    moved_fields,
    toolchain_diff,
    unchanged_code_moved_geometry,
    unchanged_code_note,
)

from . import checklib
from .hubspec import DEV_LABEL
from .paths import project_root

# Re-exported: the build and its tests import these names from here. Every
# name imported above is used in this file or listed in `__all__`, so a linter
# finds no unused import to delete.
__all__ = [
    "METRIC_FIELDS", "METRICS_NAME", "METRICS_REL_TOL", "METRICS_VERSION",
    "collect_metrics", "metrics_diff", "metrics_summary", "read_baseline",
    "report_metrics", "source_fingerprints", "unchanged_code_moved_geometry",
    "write_metrics",
]


# METRICS_NAME is imported above from the module the readers share. The hub
# needs nothing special for it: it passes the member rule, `.json` is served,
# and every member has its own URL, which is how the next build and `hammerola
# diff` read it.
#
# Bumped when a reader of an older file would misread it; a build refuses to
# compare against an unknown version rather than diff fields whose meaning
# changed. Kept here with the writer, since the readers do not enforce it
# (`metrics_diff` compares the fields it recognises and ignores the rest).
#
# Adding fields does not need a bump: the comparison walks fields present in
# both documents. A bump would make every published revision incomparable.
METRICS_VERSION = 1

# The CAD stack the geometry comes out of, recorded by version in every build
# (`toolchain`): what tells "the same code, other bytes" apart from a model
# that is not deterministic (`metricsdiff.unchanged_code_note`).
TOOLCHAIN_PACKAGES = ("cadquery", "cadquery-ocp", "ocp-tessellate")


# --------------------------------------------------------------------------
# Metrics, and the comparison with the previous build
# --------------------------------------------------------------------------
#
# Every number in metrics.json is one the gate measured anyway. The hub hands
# the file to the next build of the project as a baseline, so that build can
# say what moved.
#
# Two blocks. The summary (what this build measured) prints on every run: the
# log reaches the pusher on its own, while metrics.json must be fetched. The
# diff (what moved since `dev`) prints whenever there is a baseline, even when
# nothing moved, since silence would look like no comparison.
#
# The summary stays short: face and triangle counts describe the tessellation,
# not the part, so they belong in the diff and metrics.json (see
# `report_metrics`, PHYSICAL_FIELDS).
#
# The build log is kept (`data/jobs/<id>/log.txt`, no retention) and can be
# re-read with `hammerola log dev` (`hammerola/sources.py:_dev_log`).


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

    Only the *.py at the project root (model.py, mocks.py and whatever the
    model imports beside itself). The build machinery is an installed package
    elsewhere, so upgrading it cannot read as "the geometry changed".

    The second hash tells a comment-only edit from a real one;
    unchanged_code_moved_geometry reads it (same hash, different solids means
    the source is not what changed). An empty hash means a file did not
    tokenize and nothing may be claimed, which is why that check requires a
    non-empty one.
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

    `checks_static` is how many checks the constants at the top of model.py
    settled on their own (see `modelchecks.static_asserts`). It sits beside
    `checks_passed` because it is about the same set: a count that fell while
    this rose lost nothing, and this rising alone means checks() drifting
    towards proving nothing.

    Either may be None, meaning "count unknown", not zero: `checks_passed` for
    an uncountable body (`modelchecks.run_checks`), and both on a build that
    skipped the model's checks at the push's request. That is all a forced
    build leaves here; the hub marks it in meta.json (`forced`).

    `provenance` is what `cadbuild.provenance.report` returned: how many of
    the model's numbers were measured, derived or chosen, which nobody
    measured, and each declaration's note. Required, so a forgetful caller
    cannot drop the record while the file still looks complete.

    `bbox` and `print_bbox` are the boxes `export_assembled` and
    `export_print_plate` measured before meshing (the product's envelope
    without scenery, and the bed it takes). Required for the same reason, and
    passed in because measuring here would measure the mesh.

    Either may be None, and its key is then absent: no `print` view, or a view
    holding only mocks. An empty box would claim no bed or a product of no
    size.

    `toolchain` is the installed version of each of TOOLCHAIN_PACKAGES; a
    package that is not installed is left out.
    """
    # One assembly: how big the product is (its own envelope; mocks overlap it
    # by construction), how much bed it takes, how much material, and the two
    # records the model's checks() left. The volume is summed from per-part
    # volumes the gate measured, since a boolean union of a glued assembly
    # takes minutes.
    #
    # A sum over the catalogue, not the scene: a part placed several times
    # (five references to one `pin`) counts once. It answers "how much material
    # do the distinct printables come to", not "how much filament per product".
    assembly = {
        "volume_mm3": sum(part["volume_mm3"] for part in parts.values()),
        # Empty unless the model's checks() called checklib.pairwise_interference
        # -- these are volumes it measured, never volumes computed for this file.
        "interference_mm3": checklib.recorded_interference(),
        # Empty unless it called checklib.swept_clearance: the tightest gap
        # along a pair's travel. Empty rather than absent, like interference:
        # "no pair swept" is an answer.
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
        # Beside `source`: both describe the model as written, not the solid.
        "provenance": provenance,
        "toolchain": _toolchain(),
        "parts": parts,
        "assembly": assembly,
        "checks_passed": checks_passed,
        "checks_static": checks_static,
    }


def _toolchain():
    """`{package: version}` of TOOLCHAIN_PACKAGES, less what is not installed."""
    versions = {}
    for name in TOOLCHAIN_PACKAGES:
        try:
            versions[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return versions


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

    It settles only what is cheap: the file parses, is an object, and has a
    known `version`. Its contents are not checked (`{"version": 1, "parts":
    {"body": 42}}` passes and breaks the comparison), which is why
    report_metrics keeps its guard.

    `path` is None when the parent had nothing to give: no `dev` build, or a
    copy that could not be made (`buildproc.runner.run_build`). A path that
    does not exist means the `dev` build shipped no metrics.json (published by
    hand, or before metrics existed).
    """
    if path is None:
        # Only what is true of both cases: None also means the copy failed
        # from a slot that exists, which this side cannot tell apart.
        return None, f"this build was handed no {DEV_LABEL} {METRICS_NAME}"
    # One clause for every way the file is not a document (will not open, not
    # UTF-8, not JSON, not an object): the pusher cannot look at the hub's
    # volume anyway.
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

    Two blocks, one of them unconditional. The summary of what this
    build measured prints on every run, baseline or not: the log is the only
    channel that reaches the pusher without a second action. The diff follows
    when there is a baseline, and prints even when nothing moved, with how
    many numbers were compared.

    This never fails a build. read_baseline checks only that the file is an
    object of a known version; its contents can still raise TypeError or
    ValueError mid-comparison, which are not BuildErrors and would turn a
    ready build red over a printed diff.

    So each block has its own guard. The comparison sits under one guard as a
    whole (the failures are every way a dict of unknown shape can be walked),
    including unchanged_code_moved_geometry, which walks the same dicts. The
    summary has its own, because it walks this build's own document and a bad
    baseline must not cost the sizes too. Each block builds its lines before
    printing, so a formatting error happens before any output.

    What is printed here is not evidence: the model runs in this process and
    can rewrite both its baseline and this output. Publication goes by the
    file list the parent verified and the exit code; no hub decision may
    depend on this text.
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
            moved.append(unchanged_code_note(baseline, current, shifted))
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
        lines += [f"  {line}" for line in toolchain_diff(baseline, current)]
        for line in lines:
            print(line)
    except Exception:
        print(f"metrics: the {METRICS_NAME} published as {DEV_LABEL} is not "
              "shaped like one, so there is nothing to compare against")
