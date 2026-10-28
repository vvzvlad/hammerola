"""Reading metrics.json: what a build measured, and what moved between two.

metrics.json has one writer (`cadbuild.metrics.write_metrics`) and two
readers: the build, printing what moved since `dev`, and `hammerola diff`. Both
import this module rather than a copy (`tests/test_metricsdiff.py` pins that).
It lives in the client package, outside `src.cadbuild`, so `hammerola diff`
never imports the geometry package.

STDLIB ONLY: the client imports this.
"""

# The name the build writes and both readers fetch.
METRICS_NAME = "metrics.json"

# Below this a volume difference is arithmetic noise, not a change. Relative,
# because the parts these run on span three orders of magnitude of volume.
METRICS_REL_TOL = 1e-9

# The fields compared between two builds, in the order they are printed.
METRIC_FIELDS = ("volume_mm3", "bbox_mm", "first_layer_mm2", "overhang_mm2",
                 "faces", "edges", "solids", "triangles", "watertight")

# Whole-build fields under `assembly`. `bbox_mm` is the product's own envelope
# without the mocks, which overlap it by construction and would hide changes.
ASSEMBLY_FIELDS = ("bbox_mm", "print_bbox_mm", "volume_mm3")

# The fields about the PHYSICAL object, not the source or its tessellation
# (face and triangle counts move without the part changing shape). Used by
# `hammerola diff --json` and the build's summary.
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
        # mm2, not cm2: a whole first layer is often under one cm2.
        return f"{value:.1f} mm2"
    if field == "watertight":
        return "watertight" if value else "NOT watertight"
    # `1 solid`, not `1 solids`.
    return f"{value} {field[:-1] if value == 1 else field}"


# What a field is called in a line, where its own name is not what a person
# would say. Only the ones that need it: everything else prints under the name
# it is stored as.
_LABELS = {"volume_mm3": "volume", "bbox_mm": "bbox", "print_bbox_mm": "plate"}


def _area_label(field):
    """`first_layer_mm2` -> `first layer`. The unit is printed beside the value.

    Shared by the summary and the moved line so both name an area the same.
    """
    return field[:-len("_mm2")].replace("_", " ")


def _field_moved(field, old, new):
    """`volume 33.06 -> 31.90 cm3 (-3.5%)` and friends."""
    if field == "volume_mm3":
        share = f" ({(new - old) / old * 100.0:+.1f}%)" if old else ""
        return f"volume {old / 1000.0:.2f} -> {new / 1000.0:.2f} cm3{share}"
    if field.endswith("_mm2"):
        # A percentage, as on the volume: `first layer 640.0 -> 210.0 mm2
        # (-67.2%)` flags a part about to come off the bed.
        share = f" ({(new - old) / old * 100.0:+.1f}%)" if old else ""
        label = _area_label(field)
        return f"{label} {old:.1f} -> {new:.1f} mm2{share}"
    if field in ("bbox_mm", "print_bbox_mm", "watertight"):
        label = _LABELS.get(field)
        return (f"{label + ' ' if label else ''}"
                f"{_shown(field, old)} -> {_shown(field, new)}")
    return f"{field} {old} -> {new}"


def _part_summary(part, fields=METRIC_FIELDS):
    """Everything measured about one part, on one line.

    Only the two areas carry labels: they share a unit and would be
    indistinguishable otherwise.

    `fields` narrows the line; the build's summary passes PHYSICAL_FIELDS. The
    default (everything) is what `metrics_diff` uses for an appeared or vanished
    part.
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

    `fields` narrows only the per-part lines (see `_part_summary`).
    """
    lines = []
    for name, part in sorted((metrics.get("parts") or {}).items()):
        lines.append(f"{name}: {_part_summary(part, fields)}")
    assembly = metrics.get("assembly") or {}
    # The whole build on one line, absent when none of it was measured. Every
    # entry is labelled: two of the three are bounding boxes.
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
    "compared": n}` -- the walk `metrics_diff` makes, unformatted and
    unrounded. `hammerola diff --json` passes PHYSICAL_FIELDS.

    Only `parts`, and only those present in both; the `assembly` block is not
    walked. `compared` tells "nothing moved" apart from "nothing was comparable"
    (documents with no field in common).
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
    # The whole build on one line. Fields present in only one side are skipped,
    # so older revisions compare cleanly.
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

    # Swept pairs: appeared, gone, or tightest gap moved. Only the gap is
    # compared; `positions` and `at` describe how the sweep was run.
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
    # `checks passed` excludes asserts decided by constants alone, so a drop
    # there may be a check that became a tautology; this line explains it.
    # Compared normalized (absent == 0) but printed raw, so `None -> 0` is not
    # reported and `None -> 2` is.
    if (old.get("checks_static") or 0) != (new.get("checks_static") or 0):
        lines.append(f"checks decided by constants: {old.get('checks_static')} "
                     f"-> {new.get('checks_static')}")
    return lines


def toolchain_diff(old, new):
    """`toolchain: <package> <old> -> <new>` per version that moved.

    Apart from `metrics_diff` and printed after its verdict: a version is not
    a measurement, so a new CAD stack alone leaves "every measured number is
    the same" standing.
    """
    return [f"toolchain: {change}"
            for change in toolchain_changes(old, new) or []]


def toolchain_changes(old, new):
    """`cadquery-ocp 7.9.3.1.1 -> 7.9.4` for each package of the CAD stack
    whose version differs between two builds; None when either recorded none.

    A package one build did not have reads as `absent`.
    """
    if "toolchain" not in old or "toolchain" not in new:
        return None
    was, now = old["toolchain"], new["toolchain"]
    return [f"{name} {was.get(name, 'absent')} -> {now.get(name, 'absent')}"
            for name in sorted(set(was) | set(now))
            if was.get(name) != now.get(name)]


def unchanged_code_note(old, new, shifted):
    """The line that says `unchanged_code_moved_geometry` named `shifted`.

    One wording for both readers. It names the versions of the CAD stack that
    changed, and when the two builds recorded the same ones it says so instead
    of blaming the stack.
    """
    head = (f"! the geometry moved while the model's code did not "
            f"({', '.join(shifted)}): the same source built into a different "
            f"solid")
    changes = toolchain_changes(old, new)
    if changes is None:
        return (f"{head}. The two builds did not both record their CAD stack: "
                f"compare the one each ran on, or the model is not "
                f"deterministic")
    if changes:
        return f"{head} on another CAD stack: {', '.join(changes)}"
    same = ", ".join(f"{name} {version}"
                     for name, version in sorted(new["toolchain"].items()))
    return (f"{head} on the same CAD stack ({same}): the model is not "
            f"deterministic, or it builds from files besides the *.py at its "
            f"root")


def unchanged_code_moved_geometry(old, new):
    """Parts whose measurements moved while the model's code did not.

    The same source produced a different solid, so the cause is outside the
    source: the geometry was computed elsewhere, the CAD stack changed
    (CadQuery/OCCT), or the model is not deterministic. It cannot fire on an
    ordinary edit.

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
