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
METRIC_FIELDS = ("volume_mm3", "bbox_mm", "first_layer_mm2", "overhang_mm2",
                 "faces", "edges", "solids", "triangles", "watertight")

# The same question asked of the WHOLE build rather than of one part, and a
# tuple of its own because these live under `assembly` and are not per part:
# how big the product is, how much bed it takes to print, how much material is
# in it. `bbox_mm` IS THE PRODUCT'S OWN ENVELOPE, with the scenery left out: a
# mock overlaps the product by construction, so a box that took the mocks in
# would report the size of the wall a bracket bolts to and hide the bracket
# moving on it.
ASSEMBLY_FIELDS = ("bbox_mm", "print_bbox_mm", "volume_mm3")

# The fields about the PHYSICAL OBJECT, as against the model source or the
# tessellation of it. A face count moves when a fillet is drawn differently and
# a triangle count moves when a tolerance changes; none of that is the part
# coming out another shape. Named ONCE, here, so "did this round of edits change
# anything physical" is a question with one answer rather than a judgement each
# reader makes for itself -- `hammerola diff --json` is the reader today.
PHYSICAL_FIELDS = ("volume_mm3", "bbox_mm", "first_layer_mm2", "overhang_mm2")


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
    if field in ("bbox_mm", "print_bbox_mm"):
        return "x".join(f"{axis:.2f}" for axis in value) + " mm"
    if field.endswith("_mm2"):
        # One decimal, and square millimetres rather than square centimetres:
        # these are areas of tens to hundreds of mm2, and a part's whole first
        # layer is often under one cm2.
        return f"{value:.1f} mm2"
    if field == "watertight":
        return "watertight" if value else "NOT watertight"
    # `1 solid`, not `1 solids`: these lines are read at a glance and the
    # plural on a count of one reads as a typo in the number.
    return f"{value} {field[:-1] if value == 1 else field}"


# What a field is called in a line, where its own name is not what a person
# would say. Only the ones that need it: everything else prints under the name
# it is stored as.
_LABELS = {"volume_mm3": "volume", "bbox_mm": "bbox", "print_bbox_mm": "plate"}


def _area_label(field):
    """`first_layer_mm2` -> `first layer`. The unit is printed beside the value.

    ONE FUNCTION FOR BOTH LINES, the summary's and the moved one's, because the
    two are read side by side: an area named in one and bare in the other reads
    as two different measurements of one part.
    """
    return field[:-len("_mm2")].replace("_", " ")


def _field_moved(field, old, new):
    """`volume 33.06 -> 31.90 cm3 (-3.5%)` and friends."""
    if field == "volume_mm3":
        share = f" ({(new - old) / old * 100.0:+.1f}%)" if old else ""
        return f"volume {old / 1000.0:.2f} -> {new / 1000.0:.2f} cm3{share}"
    if field.endswith("_mm2"):
        # A PERCENTAGE, as on the volume, and it is the whole reason these two
        # numbers are published: `first layer 640.0 -> 210.0 mm2 (-67.2%)` is a
        # part about to start coming off the bed, and the two absolute numbers
        # alone leave that arithmetic to the reader.
        share = f" ({(new - old) / old * 100.0:+.1f}%)" if old else ""
        label = _area_label(field)
        # The unit once at the end, as on the volume line above: two numbers
        # and one `mm2` reads as a movement, where a unit on each reads as two
        # separate facts.
        return f"{label} {old:.1f} -> {new:.1f} mm2{share}"
    if field in ("bbox_mm", "print_bbox_mm", "watertight"):
        label = _LABELS.get(field)
        return (f"{label + ' ' if label else ''}"
                f"{_shown(field, old)} -> {_shown(field, new)}")
    return f"{field} {old} -> {new}"


def _part_summary(part, fields=METRIC_FIELDS):
    """Everything measured about one part, on one line.

    THE TWO AREAS CARRY THEIR NAMES and nothing else here does, for the reason
    the assembly line labels all of its own: `2392.3 mm2, 0.0 mm2` is two
    numbers in one unit with no way to tell the bed contact from the overhang,
    where `4 solids` and `watertight` say what they are. A bounding box needs no
    label on this line either -- it is the only `NNxNNxNN mm` on it.

    `fields` NARROWS WHAT THE LINE IS ABOUT, and the caller that narrows it is
    the build's own summary: it passes PHYSICAL_FIELDS, because millimetres are
    what a person reads a build log for and a triangle count is a fact about the
    tessellation. THE DEFAULT DOES NOT CHANGE, which is what keeps `metrics_diff`
    describing a part that appeared -- or one that went away -- with everything
    measured about it: nobody has seen that part before, so there is nothing to
    leave out.
    """
    bits = []
    for field in fields:
        if field not in part:
            continue
        shown = _shown(field, part[field])
        bits.append(f"{_area_label(field)} {shown}"
                    if field.endswith("_mm2") else shown)
    return ", ".join(bits)


def _swept_summary(record):
    """One mating pair the model swept, on one line.

    The shape `checklib.swept_clearance` records under each label: how many
    stops were run, the tightest gap seen and the stop it was at.
    """
    return (f"min gap {record.get('min_gap_mm'):.2f} mm at position "
            f"{record.get('at')} of {record.get('positions')}")


def metrics_summary(metrics, fields=METRIC_FIELDS):
    """Every number this build measured, in the shape a person reads.

    `fields` is handed straight to `_part_summary` and says which of them the
    per-part line carries; everything below that line -- the assembly, the
    interference, the swept pairs, the check count -- is one entry per record
    and is not a per-part field, so it is unaffected by the narrowing.
    """
    lines = []
    for name, part in sorted((metrics.get("parts") or {}).items()):
        lines.append(f"{name}: {_part_summary(part, fields)}")
    assembly = metrics.get("assembly") or {}
    # The whole build on one line, in the same shape a part gets. Absent
    # entirely on a build that measured none of it -- a revision published
    # before these fields existed reads exactly as it did then.
    #
    # EVERY ENTRY CARRIES ITS LABEL, which a part's line does not need: two of
    # these three are bounding boxes, and `100.00x50.00x20.00 mm,
    # 180.00x180.00x8.00 mm` says nothing about which of them is the product and
    # which is the bed.
    whole = [f"{_LABELS.get(field, field)} {_shown(field, assembly[field])}"
             for field in ASSEMBLY_FIELDS if field in assembly]
    if whole:
        lines.append("assembly: " + ", ".join(whole))
    shared = assembly.get("interference_mm3") or {}
    for pair, volume in sorted(shared.items()):
        lines.append(f"{pair}: {volume:.3f} mm3 shared")
    swept = assembly.get("clearance") or {}
    for label, record in sorted(swept.items()):
        lines.append(f"{label}: {_swept_summary(record)}")
    if metrics.get("checks_passed") is not None:
        lines.append(f"checks passed: {metrics['checks_passed']}")
    return lines


def moved_fields(old, new, fields=METRIC_FIELDS):
    """What moved between two builds, by part and by field, for a MACHINE.

    `{"moved": [{"part": ..., "field": ..., "old": ..., "new": ...}],
    "compared": n}` -- the same walk `metrics_diff` makes, with nothing
    formatted and nothing rounded. That is the whole of the difference between
    the two: one of them is read by a person and the other by a script deciding
    whether a PART came out another shape, and a script that had to parse
    `volume 33.06 -> 31.90 cm3 (-3.5%)` back into numbers would be reading
    prose. `hammerola diff --json` passes PHYSICAL_FIELDS and asks exactly that
    question.

    `parts` AND ONLY `parts`: the `assembly` block is outside this walk
    entirely, so a build whose plate grew while every part stayed the same
    answers `{"moved": [], ...}` here. That is the answer the caller's question
    deserves and not a gap to plug in passing -- the printed diff carries the
    assembly line, and a document that grew a second shape would change what
    every existing reader parses.

    `compared` IS PART OF THE ANSWER AND NOT A STATISTIC. An empty `moved` means
    "nothing moved" only if something was looked at: two documents with no field
    in common -- a revision published before a field existed against one
    published after -- compare nothing and move nothing, and without this number
    the two are indistinguishable.

    ONLY THE PARTS PRESENT IN BOTH. A part that appeared or went away is not a
    field that moved and has no `old` or `new` to report; `metrics_diff` says so
    in words, and this walk stays one shape rather than growing a second.
    """
    was = old.get("parts") or {}
    now = new.get("parts") or {}
    moved, compared = [], 0
    for name in sorted(set(was) & set(now)):
        before, after = was[name], now[name]
        for field in fields:
            if field not in before or field not in after:
                continue
            compared += 1
            if _moved(before[field], after[field]):
                moved.append({"part": name, "field": field,
                              "old": before[field], "new": after[field]})
    return {"moved": moved, "compared": compared}


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

    was_assembly = old.get("assembly") or {}
    now_assembly = new.get("assembly") or {}
    # The whole build, on one line, exactly as a part gets one: a product that
    # grew 2 mm taller or a plate that no longer fits the bed is the same kind
    # of news as a part that did. Fields present in ONE of the two are passed
    # over, which is what lets a revision published before these existed be
    # compared with one published after.
    whole = [_field_moved(field, was_assembly[field], now_assembly[field])
             for field in ASSEMBLY_FIELDS
             if field in was_assembly and field in now_assembly
             and _moved(was_assembly[field], now_assembly[field])]
    if whole:
        lines.append("assembly: " + ", ".join(whole))

    was_shared = was_assembly.get("interference_mm3") or {}
    now_shared = now_assembly.get("interference_mm3") or {}
    for pair in sorted(set(was_shared) | set(now_shared)):
        before, after = was_shared.get(pair), now_shared.get(pair)
        if before is None:
            lines.append(f"{pair}: now share {after:.3f} mm3")
        elif after is None:
            lines.append(f"{pair}: no longer measured (shared {before:.3f} mm3)")
        elif _moved(before, after):
            lines.append(f"{pair}: shared volume {before:.3f} -> {after:.3f} mm3")

    # The pairs the model swept along their travel, in the same three cases the
    # interference above is read in: one that appeared, one that is no longer
    # measured, one whose tightest gap moved. The GAP is what is compared --
    # `positions` and `at` are how the sweep was run, and a sweep run at more
    # stops is not the parts having moved.
    was_swept = was_assembly.get("clearance") or {}
    now_swept = now_assembly.get("clearance") or {}
    for label in sorted(set(was_swept) | set(now_swept)):
        before, after = was_swept.get(label), now_swept.get(label)
        if before is None:
            lines.append(f"{label}: now swept, {_swept_summary(after)}")
        elif after is None:
            lines.append(f"{label}: no longer swept "
                         f"(was {_swept_summary(before)})")
        elif _moved(before.get("min_gap_mm"), after.get("min_gap_mm")):
            lines.append(f"{label}: min gap {before.get('min_gap_mm'):.2f} -> "
                         f"{after.get('min_gap_mm'):.2f} mm")

    if old.get("checks_passed") != new.get("checks_passed"):
        lines.append(f"checks passed: {old.get('checks_passed')} -> "
                     f"{new.get('checks_passed')}")
    # WITHOUT THIS THE LINE ABOVE LIES AT THE ROLLOUT BOUNDARY. The build
    # subtracts the asserts the constants settle on their own from the number it
    # reports, so a project whose real check degenerated into a tautology prints
    # a SMALLER `checks passed` with nothing lost -- read alone, that is a check
    # gone missing. A baseline written before the build measured this has no
    # `checks_static` at all and renders `None -> 2`, which is the truth: the
    # number did not exist then.
    #
    # COMPARED NORMALIZED, PRINTED RAW. A baseline from before the rollout has
    # no `checks_static`, so a plain `!=` makes "absent" differ from 0 and every
    # such project prints `None -> 0` once -- a line saying that nothing moved,
    # in a document whose whole rule is "only the difference, and only when
    # there is one". Between two immutable revisions astride the rollout it
    # prints for ever. `None -> 2` still prints, because that one IS a
    # difference.
    if (old.get("checks_static") or 0) != (new.get("checks_static") or 0):
        lines.append(f"checks decided by constants: {old.get('checks_static')} "
                     f"-> {new.get('checks_static')}")
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
