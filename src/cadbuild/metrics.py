#!/usr/bin/env python3
"""What this build measured, and what moved since the last one.

Every number in metrics.json is one the gate measured anyway; nothing here
computes geometry. It is written next to the geometry, so the NEXT build of the
same project can read it back and say what changed.

TWO FUNCTIONS OF THIS MODULE STAYED ON THE CLIENT SIDE and are deliberately not
here: `fetch_baseline`, which GET's the previous metrics.json off
`{hub}/project/<pid>/dev/`, and `check_project_match`, which refuses to publish
over a snapshot belonging to somebody else. Both are about a laptop talking to
a hub over HTTP. Inside the hub the first is a file on the volume rather than a
request (whatever reads it will pass it to report_metrics below, which already
takes the baseline as an argument), and the second guards against a copied
project.json pointing at a stranger's id -- a question the hub answers from its
own store, not from a build's own numbers. Everything that is pure -- the
fingerprints, the diff, the summary and the printing -- came across unchanged.

THE COMPARISON ITSELF NOW LIVES IN `src/metricsdiff.py` and is imported back
here, so this module still exposes every name it always did. It moved because
metrics.json gained a SECOND reader that cannot import this one: `hammerola
diff` prints what moved between two published revisions, and the client is
stdlib-only and never imports the build half. Read that module's docstring for
why a shared module beat a second copy -- the short version is that a copy is
what broke publication once already.

WHY THE IMPORT IS ABSOLUTE where every other import in this package is
relative. `src.metricsdiff` is outside the package, so there is no relative
spelling; naming `src` is safe HERE because of when this module is imported. A
model is loaded with its own directory first on `sys.path` (`geometry.load_model`),
so a project with a `src/` directory of its own can shadow the name -- but that
happens inside `build()`, and `src.cadbuild.build` imports this module at its
own import time, which is before the child process reaches any model. Same
spelling `src/buildproc/` already uses throughout.
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import tokenize

from src.metricsdiff import (
    METRIC_FIELDS,
    METRICS_NAME,
    METRICS_REL_TOL,
    _field_moved,
    _moved,
    _part_summary,
    _shown,
    metrics_diff,
    metrics_summary,
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
    "collect_metrics", "metrics_diff", "metrics_summary", "report_metrics",
    "source_fingerprints", "unchanged_code_moved_geometry", "write_metrics",
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
METRICS_VERSION = 1


# --------------------------------------------------------------------------
# Metrics, and the comparison with the previous build
# --------------------------------------------------------------------------
#
# Every number in metrics.json is one the gate measured anyway; nothing here
# computes geometry. It rides in the archive, so the NEXT build of the same
# project can fetch it back from `dev` and say what moved -- which is the only
# form of "did that edit do what I meant" that does not involve opening two
# viewers side by side and squinting.
#
# What it prints is ONLY the difference, and only when there is one. A block
# that appears after every build, saying the same numbers, is a block that
# stops being read some builds before the one where it mattered.


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


def collect_metrics(project, parts, checks_passed, provenance):
    """The build's numbers, in the shape metrics.json is written in.

    `provenance` is what `cadbuild.provenance.report` handed back at the top of
    the build: how many of this model's numbers were measured, derived or
    merely chosen, which ones nobody measured, and the note each declaration
    carries -- the sentence `derived()` promises its author will end up here. It
    is a REQUIRED argument rather than one with a default, because a default
    would let a caller drop the whole record by forgetting it, and the file
    would still look complete.
    """
    return {
        "version": METRICS_VERSION,
        "project": project,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source_fingerprints(),
        # Beside `source` because it is about the same thing the two hashes
        # above are: the model as it was written, not the solid that came out.
        "provenance": provenance,
        "parts": parts,
        # Empty unless the model's checks() called checklib.pairwise_interference
        # -- these are volumes it measured, never volumes computed for this file.
        "assembly": {"interference_mm3": checklib.recorded_interference()},
        "checks_passed": checks_passed,
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


def report_metrics(out_dir, baseline, why):
    """Print what moved since the `dev` build, or why there is nothing to compare.

    THIS NEVER FAILS A BUILD, and that promise has to hold against the baseline
    as well as against the network. fetch_baseline settles two things about
    what came off the wire -- an object, of a version this build knows -- and
    nothing at all about what is inside it. `{"version": 1, "parts": {"body":
    42}}` is a perfectly good answer to both questions and a TypeError in the
    middle of the comparison; a string where a measured volume belongs is a
    ValueError in a format specifier. Neither is a BuildError, so neither is
    caught by main(), and a build that modelled, gated and was ready to publish
    would go red over the shape of a file whose entire job is a printed diff --
    with the docstrings and the documentation both promising it cannot.

    So the whole comparison sits under one guard rather than each field under
    its own: the failures are not a list to enumerate, they are every way a
    dict of unknown shape can be walked, and one line saying the published file
    is not one is the right amount to say about all of them. The guard covers
    the printing too, but the lines are built first on purpose -- a formatting
    error then happens before anything reaches the terminal, instead of halfway
    through a block. It also covers unchanged_code_moved_geometry, which walks
    the same two dicts and is no safer than the diff is.
    """
    try:
        current = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # The build wrote it moments ago. If it is not there, the missing file
        # is the build's problem to report, not this line's.
        return
    if baseline is None:
        print(f"metrics: nothing to compare against -- {why}. This build:")
        for line in metrics_summary(current):
            print(f"  {line}")
        return
    try:
        lines = metrics_diff(baseline, current)
        # Last, and after the numbers it is a conclusion about: the diff says
        # WHAT moved, this says the source cannot be why.
        shifted = unchanged_code_moved_geometry(baseline, current)
        if shifted:
            lines.append(
                f"! the geometry changed but the code did not ({', '.join(shifted)}) "
                f"-- the same model source built into a different solid than the "
                f"one published as {DEV_LABEL}. Compare the environments: this "
                "build against the other place it gets built (the node, or "
                "LOCAL=1 here), and the CAD stack in each"
            )
        if lines:
            print(f"metrics vs {DEV_LABEL}:")
            for line in lines:
                print(f"  {line}")
    except Exception:
        print(f"metrics: the {METRICS_NAME} published as {DEV_LABEL} is not "
              "shaped like one, so there is nothing to compare against")
