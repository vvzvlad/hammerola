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
"""

from datetime import datetime, timezone
from pathlib import Path
import hashlib
import io
import json
import tokenize

from . import checklib
from .hubspec import DEV_LABEL
from .paths import project_root


# The numbers this build measured, shipped in the archive next to the geometry
# (see collect_metrics). Nothing on the hub has to know about it: the name
# passes the member rule, `.json` is a type the hub serves, and every member is
# reachable at its own URL -- which is how the NEXT build reads this one back.
METRICS_NAME = "metrics.json"
# Bumped when a reader of an older file would misread it. A build refuses to
# compare against a version it does not know and says so, rather than diffing
# fields that have quietly changed meaning.
METRICS_VERSION = 1
# Below this a volume difference is arithmetic noise, not a change. Relative,
# because the parts these run on span three orders of magnitude of volume.
METRICS_REL_TOL = 1e-9


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

# The fields compared between two builds, in the order they are printed.
METRIC_FIELDS = ("volume_mm3", "bbox_mm", "faces", "edges", "solids",
                 "triangles", "watertight")


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


def collect_metrics(project, parts, checks_passed):
    """The build's numbers, in the shape metrics.json is written in."""
    return {
        "version": METRICS_VERSION,
        "project": project,
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source_fingerprints(),
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


def _moved(old, new):
    """True when two measured values really differ."""
    if isinstance(old, bool) or isinstance(new, bool):
        return bool(old) != bool(new)
    if isinstance(old, (int, float)) and isinstance(new, (int, float)):
        return abs(new - old) > METRICS_REL_TOL * max(1.0, abs(old), abs(new))
    if isinstance(old, list) and isinstance(new, list):
        return len(old) != len(new) or any(_moved(a, b) for a, b in zip(old, new))
    return old != new


def _shown(field, value):
    """One measured value, in the unit a person thinks in."""
    if field == "volume_mm3":
        return f"{value / 1000.0:.2f} cm3"
    if field == "bbox_mm":
        return "x".join(f"{axis:.2f}" for axis in value) + " mm"
    if field == "watertight":
        return "watertight" if value else "NOT watertight"
    # `1 solid`, not `1 solids`: these lines are read at a glance and the
    # plural on a count of one reads as a typo in the number.
    return f"{value} {field[:-1] if value == 1 else field}"


def _field_moved(field, old, new):
    """`volume 33.06 -> 31.90 cm3 (-3.5%)` and friends."""
    if field == "volume_mm3":
        share = f" ({(new - old) / old * 100.0:+.1f}%)" if old else ""
        return f"volume {old / 1000.0:.2f} -> {new / 1000.0:.2f} cm3{share}"
    if field in ("bbox_mm", "watertight"):
        label = "bbox " if field == "bbox_mm" else ""
        return f"{label}{_shown(field, old)} -> {_shown(field, new)}"
    return f"{field} {old} -> {new}"


def _part_summary(part):
    """Everything measured about one part, on one line."""
    bits = []
    for field in METRIC_FIELDS:
        if field in part:
            bits.append(_shown(field, part[field]))
    return ", ".join(bits)


def metrics_summary(metrics):
    """Every number this build measured, for when there is nothing to diff."""
    lines = []
    for name, part in sorted((metrics.get("parts") or {}).items()):
        lines.append(f"{name}: {_part_summary(part)}")
    shared = ((metrics.get("assembly") or {}).get("interference_mm3")) or {}
    for pair, volume in sorted(shared.items()):
        lines.append(f"{pair}: {volume:.3f} mm3 shared")
    if metrics.get("checks_passed") is not None:
        lines.append(f"checks passed: {metrics['checks_passed']}")
    return lines


def metrics_diff(old, new):
    """What moved between two builds. Empty when nothing did -- print nothing."""
    lines = []
    was = old.get("parts") or {}
    now = new.get("parts") or {}
    for name in sorted(set(was) | set(now)):
        before, after = was.get(name), now.get(name)
        if before is None:
            lines.append(f"{name}: new part, {_part_summary(after)}")
            continue
        if after is None:
            lines.append(f"{name}: gone (was {_part_summary(before)})")
            continue
        moved = [_field_moved(field, before[field], after[field])
                 for field in METRIC_FIELDS
                 if field in before and field in after
                 and _moved(before[field], after[field])]
        if moved:
            lines.append(f"{name}: " + ", ".join(moved))

    was_shared = ((old.get("assembly") or {}).get("interference_mm3")) or {}
    now_shared = ((new.get("assembly") or {}).get("interference_mm3")) or {}
    for pair in sorted(set(was_shared) | set(now_shared)):
        before, after = was_shared.get(pair), now_shared.get(pair)
        if before is None:
            lines.append(f"{pair}: now share {after:.3f} mm3")
        elif after is None:
            lines.append(f"{pair}: no longer measured (shared {before:.3f} mm3)")
        elif _moved(before, after):
            lines.append(f"{pair}: shared volume {before:.3f} -> {after:.3f} mm3")

    if old.get("checks_passed") != new.get("checks_passed"):
        lines.append(f"checks passed: {old.get('checks_passed')} -> "
                     f"{new.get('checks_passed')}")
    return lines


# There used to be a SECOND alarm next to the one below, printing a `!` line
# that guessed at what an edit had MEANT to do: "material is gone and the face
# count did not move -- so this was a face shifting, not a feature cut".
# Widening an existing hole or pocket, deepening a slot, thinning a wall,
# growing a chamfer -- all of them remove volume and leave the face count
# exactly where it was, and all of them are ordinary edits. An alarm that fires
# on ordinary work gets skipped over, and it takes the lines around it with it.
#
# A diff between two builds is the wrong place for that question anyway. "The
# boolean cut nothing away" is answerable exactly where the boolean happens,
# against the shapes going into it, with no dependence on what was published
# last week -- so it belongs in the model's own checks(), not here.


def unchanged_code_moved_geometry(old, new):
    """Parts whose measurements moved while the model's code did not.

    The one comparison here that says something a person cannot read off the
    numbers, and it is not a guess about intent: it reports that the SAME
    SOURCE produced a DIFFERENT SOLID. No ordinary edit can do that -- editing
    is what changes the code hash -- so when it fires, the difference came from
    outside the source, and there are only a few candidates: the geometry was
    computed somewhere else (a build on the node against a build with LOCAL=1),
    the CAD stack moved under it (a rebuilt builder image, a different
    CadQuery/OCCT than the venv here), or the model is not deterministic.

    That is why it stays while the other one went. It cannot fire on a normal
    edit, and the two-places-to-build arrangement this template uses -- node by
    default, LOCAL=1 whenever the node is down -- is exactly the arrangement
    that makes a silent divergence between them possible.

    It reads `source.code`, the hash of the root *.py with comments stripped:
    the same source with a comment rewritten is still the same source, so a
    reformatted comment must not raise this and does not. An empty hash means
    the source did not tokenize and nothing is claimed at all.
    """
    was_code = (old.get("source") or {}).get("code")
    now_code = (new.get("source") or {}).get("code")
    if not was_code or was_code != now_code:
        return []
    was = old.get("parts") or {}
    now = new.get("parts") or {}
    return [name for name in sorted(set(was) & set(now))
            if any(field in was[name] and field in now[name]
                   and _moved(was[name][field], now[name][field])
                   for field in METRIC_FIELDS)]


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
