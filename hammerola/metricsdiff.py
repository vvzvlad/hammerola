"""Reading metrics.json: what a build measured, and what moved between two.

ONE IMPLEMENTATION WITH TWO READERS, which is the only reason this file is not
part of `src/cadbuild/metrics.py` where it was written. metrics.json has a
writer (the build, `cadbuild.metrics.write_metrics`) and now two readers: the
build itself, printing what moved since `dev`, and `hammerola diff`, printing
what moved between two published revisions. The client is stdlib-only and takes
nothing from `requirements.txt` or from the build half (`hammerola/__init__.py`
says why), so the choice was between a second copy and a move. It is a move.

A COPY WAS THE WRONG ANSWER AND WE KNOW WHAT IT COSTS. `cad_publish/hubspec.py`
held the hub's ceilings in a repository that could not see the hub's, nothing
compared the two, and publication broke. The lesson that produced
`tests/client/test_limits.py` was "a copy needs a test that pins it"; the
stronger form is "do not make the copy". Here nothing had to be copied at all —
these functions read a JSON document and format text, they touch no CAD kernel,
no filesystem and no network — so both sides import the same objects and there
is nothing left to drift. `tests/test_metricsdiff.py` pins that identity, so a
future re-copy fails at the commit that makes it.

WHY IT SITS AT THE TOP OF `src/` rather than inside `cadbuild`. Importing
`src.cadbuild.<anything>` runs that package's `__init__`, and that package's
whole job is geometry: its own docstring already has to promise that importing
it stays light. Hanging the client's `diff` off that promise would mean the day
somebody adds a module-level `import cadquery` up there, `hammerola diff` stops
working on a laptop with no CAD kernel — a blast radius nobody would predict
from the edit. A neutral module has no such edge.

STDLIB ONLY, and that is a rule rather than a coincidence: the client imports
this.
"""

# The name the build writes and both readers fetch. Here rather than beside the
# writer because a reader needs it to ASK for the file, and a reader that
# spelled it itself would be the copy this module exists to avoid.
METRICS_NAME = "metrics.json"

# Below this a volume difference is arithmetic noise, not a change. Relative,
# because the parts these run on span three orders of magnitude of volume.
METRICS_REL_TOL = 1e-9

# The fields compared between two builds, in the order they are printed.
METRIC_FIELDS = ("volume_mm3", "bbox_mm", "faces", "edges", "solids",
                 "triangles", "watertight")


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
    computed somewhere else, the CAD stack moved under it (a rebuilt image, a
    different CadQuery/OCCT), or the model is not deterministic.

    That is why it stays while the alarm above it went. It cannot fire on a
    normal edit, and being built in two places -- which was the arrangement
    that made a silent divergence possible -- is exactly what it catches.

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
