#!/usr/bin/env python3
"""Two revisions in ONE scene: both shells neutral and see-through, the difference bright.

Answers where a revision changed: revision A and revision B drawn translucent
in one neutral colour, and the material the change added and removed drawn
bright on top, in one window. This module only assembles that payload (no
route, job, subprocess or CLI). `shapediff.measure` says what the difference
is; this says where.

Neither revision is tessellated here. Both arrive as the view documents their
builds exported (`views.export_views`), and are re-labelled: every id rebuilt
under its revision's prefix, every leaf recoloured to the neutral shell. Only
the measured difference is tessellated (a part only one revision has is
re-labelled like the rest). That is the cheap third: for a real pair 0.33 s
reading the STEP files, 0.86 s fusing, 0.30 s tessellating.

The prefixes matter: merging two documents without rebuilding ids silently
loses colliding paths (5 parts in, 3 tree leaves, 5 scene objects; the
duplicate is drawn but cannot be hidden, recoloured or cut, and highlighting
its path lights both).

The difference is measured in the frame of the part's STEP file: a build
exports one per printable from `catalogue[key]["shape"]`, unmoved by any view,
with whatever location that solid carries of its own baked into the geometry.
A view moves the solid by its `at`, which the build records on the leaf
(`views.shaped_document`); the leaf's `loc` is that motion composed with the
solid's own location, so a piece drawn with it would have the own location
applied twice. Each difference piece is drawn with its leaf's `at`.

Refusals are `ValueError`, not `BuildError`: nothing here runs a model, so a
document that cannot be merged is like one the hub cannot serve
(`render.check_view_file`).

Costly imports are inside the functions that need them: `report` is
arithmetic over dicts and must run without a kernel (in CI and in tests).
"""

import json


__all__ = [
    "ADDED_COLOR",
    "ADDED_NAME",
    "DIFFERENCE_ALPHA",
    "REMOVED_COLOR",
    "REMOVED_NAME",
    "REVISION_A_NAME",
    "REVISION_B_NAME",
    "ROOT_NAME",
    "SHELL_ALPHA",
    "SHELL_COLOR",
    "STATUSES",
    "build_scene",
    "report",
]


# The five names the scene is addressed by, a contract with the browser: the
# interface hides and shows a revision by matching the id prefix `/cmp/rev a`
# or `/cmp/rev b`, so renaming one silently breaks the toggles.
ROOT_NAME = "cmp"
REVISION_A_NAME = "rev a"
REVISION_B_NAME = "rev b"
REMOVED_NAME = "removed"
ADDED_NAME = "added"

# The palette, colourblind-safe.
#
# There is no industry convention (green-is-added in GitHub, NX and AutoCAD,
# the reverse in CATIA; in metrology red means excess material). Every tool
# mutes the unchanged, so the browser's legend is compulsory; this module only
# holds to the colours it names.
SHELL_COLOR = "#7a8fa6"
SHELL_ALPHA = 0.18
REMOVED_COLOR = "#d1495b"
ADDED_COLOR = "#2a9d5c"

# Opaque is required: a difference shares faces with the shells it was cut
# from, and the viewer's depth peeling keeps only one of two translucent faces
# at the same depth, so a translucent difference would come and go in a
# pattern following the triangles. Opaque, it is drawn whole before the shells
# and they are layered over it.
DIFFERENCE_ALPHA = 1.0

# What `report` may say about a part, and the whole of it.
#
# `not measured` is spelled as the printed report spells it
# (`buildproc.comparechild`), since a reader sees both over the same pair. It
# is the alarming silence: the gate refused the measurement (`shapediff.check`
# refuses where the kernel may have lied) or the part's file could not be
# read. `not compared` is the routine one: the two builds did not both export
# the part as STEP, so nothing was fused -- mostly `hardware` and `mock`
# entries, sometimes a part that changed kind between revisions. Separate
# words so routine rows do not bury what changed.
#
# Neither may be shown as `unchanged` or counted into a summary that says the
# revisions are identical: nobody looked.
STATUSES = ("unchanged", "changed", "new", "removed", "not measured",
            "not compared")

# The `loc` of a node that moves nothing: no translation, unit quaternion.
# Carried by the scene root and by a freshly tessellated piece before it is
# placed.
IDENTITY_LOC = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]

# The six numbers a bounding box is, in the spelling the viewer reads them in.
BB_FIELDS = ("xmin", "ymin", "zmin", "xmax", "ymax", "zmax")


def build_scene(document_a, document_b, diffs, *, view_id):
    """One payload the viewer's own `render()` takes, out of two published views.

    `document_a` and `document_b` are the two revisions' parsed view documents
    for the same view. `diffs` is `{catalogue key: measurement}` from
    `shapediff.measure(..., keep_shapes=True)`, already gated by `check` and
    filtered by `drop_slivers` by the caller. `view_id` names the view in every
    refusal.

    What is compared is the view, as in `report`. A part both views show is
    compared piece by piece from `diffs`; a part only one shows is difference
    geometry in its entirety and is drawn from its own leaf (`_whole`); a STEP
    measurement of such a part is not drawn.

    The result is one root group with exactly four children, in this order:
    revision A, revision B, the material removed, the material added.
    """
    root_id = f"/{ROOT_NAME}"
    shell_a, places_a = _revision(document_a, REVISION_A_NAME, root_id, view_id)
    shell_b, places_b = _revision(document_b, REVISION_B_NAME, root_id, view_id)

    # What both views show, by `report`'s rule. Every place is either compared
    # or drawn whole, so no leaf gets two nodes on one path.
    common = _shown(document_a, view_id) & _shown(document_b, view_id)

    # Each side is placed by its own revision's document: removed material
    # stands where A shows the part, added where B does.
    plan = (_planned(places_a, diffs, common, "removed", REMOVED_NAME,
                     REMOVED_COLOR, view_id)
            + _planned(places_b, diffs, common, "added", ADDED_NAME,
                       ADDED_COLOR, view_id))
    drawn, tessellated_version = _drawn(plan, view_id)

    # A whole part is a difference too; its geometry is the leaf already being
    # re-labelled, so it costs nothing.
    drawn[REMOVED_NAME] += _whole(places_a, common, REMOVED_COLOR)
    drawn[ADDED_NAME] += _whole(places_b, common, ADDED_COLOR)

    seen = {REVISION_A_NAME: document_a.get("version"),
            REVISION_B_NAME: document_b.get("version")}
    if plan:
        seen["the difference"] = tessellated_version
    version = _one_version(seen, view_id)

    return {
        "version": version,
        "name": ROOT_NAME,
        "id": root_id,
        "loc": IDENTITY_LOC,
        # Copied rather than computed: the viewer never reads it (the vendored
        # bundle has no `normal_len`), and both documents come from one
        # exporter.
        "normal_len": document_a.get("normal_len", 0),
        "bb": _union_bb(document_a, document_b, view_id),
        "parts": [
            shell_a,
            shell_b,
            _group(REMOVED_NAME, root_id, version, drawn[REMOVED_NAME]),
            _group(ADDED_NAME, root_id, version, drawn[ADDED_NAME]),
        ],
    }


def report(diffs, document_a, document_b, *, view_id, refused, covered):
    """What changed, per part and in total, as a plain JSON-able dict.

    `{"parts": [{"key", "status", "added_mm3", "removed_mm3"}, ...], "totals":
    {"added_mm3", "removed_mm3"}}`, `status` one of `STATUSES`, plus a `reason`
    on `not measured` and `not compared` rows. No kernel or geometry: this half
    must run where `build_scene` cannot.

    `refused` is `{catalogue key: reason}` for parts that could not be
    measured, as `buildproc.comparechild` collected them. Required (see
    `_demanded`): forgetting it would publish every refusal as `unchanged`. An
    empty mapping is the ordinary case.

    `covered` is the set of keys the walk actually compared
    (`buildproc.comparechild._compare`), also required: `unchanged` is said
    only about keys in it. The walk is over `*.step` files, one per printable
    (`cadbuild.printables`), while a view shows every kind of entry, so its
    `hardware` and `mock` keys are never covered; nor is a part only one build
    exported.

    The parts are those the two views show, by the same rule as the scene
    (`_shown`), so the list and the picture agree: a part this view does not
    show has no row, and a part only one revision shows is `new` or `removed`
    in both. The printed report (`buildproc.comparechild`) still covers every
    exported part, including ones no view shows.

    A list, with the key inside each row, because `compareRows` in
    ui/src/HammerolaViewer.jsx takes `report.parts` as an array and drops rows
    without a string `key`; a map would show "this report lists no parts".

    Sorted by key, the order the printed report walks
    (`sorted(set(old) | set(new))`); the browser's stable sort keeps it within
    each half of its list.

    A key both views show is `unchanged` only if the walk covered it and
    neither map holds it (equal bytes, or a fuse that found nothing or only
    slivers). An uncovered key is `not compared` with its reason
    (`_uncovered_line`): `unchanged` comes from membership, never absence. A
    key in `refused` is `not measured` with the reason the job log gives. A
    part only one view shows is `new` or `removed` first.

    Volumes are the pieces' own, not the measurement's totals: `drop_slivers`
    leaves `removed_mm3` as measured (the gate's identities sum every piece),
    so a noise-only part would otherwise be unchanged with a volume. A part
    only one view shows counts as no material either way; its volume is in its
    revision's metrics.json, for the text half (`buildproc.comparechild`).
    """
    in_a, in_b = _shown(document_a, view_id), _shown(document_b, view_id)
    parts = []
    for key in sorted(in_a | in_b):
        if key not in in_a:
            parts.append(_line(key, "new"))
        elif key not in in_b:
            parts.append(_line(key, "removed"))
        elif key in refused:
            parts.append(_refused_line(key, refused[key]))
        elif key not in covered:
            # Before `diffs`: whether anything measured this part decides,
            # not what value came back (as `comparechild._compare` routes by
            # verdict).
            parts.append(_uncovered_line(key))
        else:
            parts.append(_measured_line(key, diffs.get(key)))
    return {
        "parts": parts,
        "totals": {
            "added_mm3": sum((line["added_mm3"] for line in parts), 0.0),
            "removed_mm3": sum((line["removed_mm3"] for line in parts), 0.0),
        },
    }


def _line(key, status, added_mm3=0.0, removed_mm3=0.0):
    return {"key": key, "status": status, "added_mm3": added_mm3,
            "removed_mm3": removed_mm3}


def _refused_line(key, reason):
    """The line for a part something went wrong on, and what went wrong.

    The alarming silence: the gate refused the measurement or the part's file
    could not be read. The routine silence is `_uncovered_line`.

    No volumes (zeroes, as on `new`/`removed`); the reason is the row's only
    content, the same sentence the job log has (`buildproc.comparechild`).
    """
    return dict(_line(key, "not measured"), reason=reason)


def _uncovered_line(key):
    """The line for a part in the view that no measurement ever looked at.

    Not the gate's word: nothing is wrong (nobody compares bought screws), and
    with the warning word these rows would bury the parts that changed. Still
    never `unchanged`: an M3x8 swapped for an M3x12 is invisible here.

    The view and the walk are different sets: the walk is over the STEP files,
    one per printable; a view shows every kind of entry (`parts.KINDS`).

    The reason defines the category before the example: a part that changed
    kind between revisions is uncovered too, though one build did export a
    STEP. What holds for all is that no pair of STEP files exists, so nothing
    was fused. The browser's legend (`NOT_COMPARED_WHY` in
    ui/src/HammerolaViewer.jsx) says the same in the same order.
    """
    return dict(_line(key, "not compared"),
                reason="the two builds did not both export it as STEP, so "
                       "nothing was fused -- hardware and mocks most often")


def _measured_line(key, measurement):
    """The line for a part both revisions have and the gate vouched for.

    Refused and uncovered parts are routed elsewhere by `report`, so `None`
    here means the walk measured the part and kept nothing (equal bytes, or a
    fuse that found nothing worth keeping): unchanged.
    """
    if measurement is None:
        return _line(key, "unchanged")
    # Indexed, never `.get`: a refused measurement carries only `reason`, and
    # a KeyError here enforces that the gate runs first (as `drop_slivers`
    # does); a default would report it as unchanged.
    removed, added = measurement["removed"], measurement["added"]
    status = "changed" if (removed or added) else "unchanged"
    return _line(key, status,
                 sum((piece["volume_mm3"] for piece in added), 0.0),
                 sum((piece["volume_mm3"] for piece in removed), 0.0))


def _shown(document, view_id):
    """The catalogue keys a view document references, once each.

    The one answer to "which parts is this view about", read by both the scene
    (compare or draw whole) and the report (which rows), so they cannot
    describe different sets.

    A key appears once however many times it is referenced: `pin` and
    `pin(2)` are one entry in two places. `_revision` answers where each
    stands.

    The group rule is `"parts" in node`, the viewer's own (see `_toned`).
    """
    keys = set()
    _gather(document, keys, view_id)
    return keys


def _gather(node, keys, view_id):
    if "parts" in node:
        for child in node["parts"]:
            _gather(child, keys, view_id)
        return
    keys.add(_demanded(node, "key", node.get("id"), view_id))


def _revision(document, name, root_id, view_id):
    """The revision's whole document, re-rooted under the scene and toned down.

    Returns `(group, places)`: the node to hang under the scene root, and where
    every part it shows stands -- key, leaf name, `at`, and the toned leaf. One
    walk, because a difference piece is drawn with the `at` of the very leaf
    recoloured here, and for a part the other revision lacks that leaf is the
    difference (`_whole`).

    The document's root becomes the revision's group, so `/Group/front` becomes
    `/cmp/rev a/front`: one prefix per revision keeps the paths apart.

    Nothing passed in is modified; every node is copied before it is changed.
    The mesh under a leaf is shared, not copied: it is by far the largest
    thing, nothing writes to it, and it is serialised by value.
    """
    places = []
    return _toned(document, name, root_id, view_id, places), places


def _toned(node, name, parent_id, view_id, places):
    """One node of a revision: copied, re-ided, and greyed out if it is a leaf."""
    copy = dict(node)
    copy["name"] = name
    copy["id"] = f"{parent_id}/{name}"
    copy["loc"] = _demanded(node, "loc", copy["id"], view_id)

    # `"parts" in node` is the viewer's rule for a group
    # (`isShapeTree(shape) { return "parts" in shape; }`) and the hub's
    # (`render.check_view_file`); anything else (`is None`, truthiness) would
    # disagree with the browser on e.g. `{"parts": null}`.
    if "parts" in node:
        copy["parts"] = [
            _toned(child, _demanded(child, "name", copy["id"], view_id),
                   copy["id"], view_id, places)
            for child in node["parts"]]
        return copy

    copy["color"] = SHELL_COLOR
    copy["alpha"] = SHELL_ALPHA
    # The leaf goes on the place beside its `at`: for a part only this revision
    # has, it is the difference geometry itself. `_whole` copies it again
    # before recolouring, so the shell stays neutral. `at` is read, not
    # demanded: only a piece to place needs it (`_planned`).
    places.append({"key": _demanded(node, "key", copy["id"], view_id),
                   "name": name, "at": node.get("at"), "leaf": copy})
    return copy


def _demanded(node, field, where, view_id, why=None):
    """A field the scene cannot be built without, or the sentence saying so.

    Required rather than defaulted (as in `views.shaped_document`), because a
    missing one produces a wrong scene that looks fine:

      * no `name` -- every node under it shares one path;
      * no `loc` -- the part stands at the origin;
      * no `key` on a leaf -- that part silently loses its difference geometry;
      * no `at` on a leaf whose part has pieces to draw -- nothing says where
        those pieces stand.

    `why` replaces the general sentence where the field is missing for a
    reason of its own.
    """
    # Empty counts as missing: `""` collides like a missing name, and `[]` is
    # no place to stand.
    value = node.get(field)
    if not value:
        raise ValueError(
            f"view {view_id!r}: the node {where!r} of the comparison scene "
            f"carries no {field!r} ({value!r}). " + (
                why or "Every node of the two documents merged here has to "
                "have one -- without it this draws a scene that is wrong "
                "rather than one that fails."))
    return value


def _planned(places, diffs, common, side, group_name, color, view_id):
    """Every piece of one side, once per place the part it belongs to stands in.

    Only for parts both views show (`common`); a part only one view shows is
    the whole difference and `_whole` draws it. Splitting the places between
    the two keeps a leaf from getting two nodes on one path.

    Once per place, not per part: one catalogue entry may be referenced many
    times, each with its own leaf and `at`.

    Each piece is placed by its leaf's `at`, the motion the view applied to the
    solid the STEP file was written from, and it is demanded here, where a
    piece is placed, and nowhere else: a revision built before views recorded
    it still compares while nothing in the view changed.

    A key in `diffs` this view does not show is skipped: a view shows a subset
    of the catalogue, while STEP files exist for every printable.
    """
    planned = []
    for place in places:
        if place["key"] not in common:
            continue
        measurement = diffs.get(place["key"])
        if measurement is None:
            continue
        # Indexed, as in `_measured_line`: the gate belongs in front of this.
        for index, piece in enumerate(measurement[side], start=1):
            if "shape" not in piece:
                raise ValueError(
                    f"view {view_id!r}: the difference measured for "
                    f"{place['key']!r} has no shape to draw. "
                    "`shapediff.measure(..., keep_shapes=True)` is what puts "
                    "one on each piece; the default keeps two floats and throws "
                    "the solids away.")
            planned.append({
                "group": group_name,
                "color": color,
                # The leaf's name, not the catalogue key, which repeats across
                # occurrences (`pin`, `pin(2)`). The index separates the pieces
                # of one part; a boolean routinely produces several.
                "name": f"{place['name']} #{index}",
                "key": place["key"],
                "at": _demanded(
                    place, "at", place["leaf"]["id"], view_id,
                    "The revision was built before views recorded where each "
                    "part is placed, so the difference measured for this part "
                    "cannot be placed in the scene."),
                "shape": piece["shape"],
            })
    return planned


def _whole(places, common, color):
    """Every part this view shows and the other revision's does not, drawn entire.

    A part only one view shows appeared or went entirely. Without this it
    would look like an untouched neutral shell while `report` calls it `new`
    or `removed`. A STEP measurement of it is not drawn (`_planned` skips
    it): the view gained or lost the part, not those pieces.

    Nothing is tessellated: the published leaf is already triangles in the
    frame its `loc` moves and carries the key, so the bright copy is that leaf
    with the colour and alpha `_drawn` gives a fused piece. The opaque copy
    writes depth and wins over the neutral shell.

    Once per place, as in `_planned`.
    """
    bright = []
    for place in places:
        if place["key"] in common:
            continue
        leaf = dict(place["leaf"])
        # Numbered like a measured piece (`body #1`): one naming scheme for
        # every leaf in these two groups.
        leaf["name"] = f"{place['name']} #1"
        leaf["color"] = color
        leaf["alpha"] = DIFFERENCE_ALPHA
        bright.append(leaf)
    return bright


def _drawn(plan, view_id):
    """The planned pieces, tessellated and placed. `({group: [leaf]}, version)`."""
    drawn = {REMOVED_NAME: [], ADDED_NAME: []}
    if not plan:
        # Nothing changed in this view: a legitimate answer, and no reason to
        # call the tessellator with nothing.
        return drawn, None

    flat, version = _tessellate(plan)
    if not isinstance(flat, list) or len(flat) != len(plan):
        # One object in, one entry back; everything below is aligned by
        # position (as `views.shaped_document` checks), or pieces would be
        # drawn under the wrong part.
        raise ValueError(
            f"view {view_id!r}: the tessellator was handed {len(plan)} pieces "
            f"of difference geometry and gave back "
            f"{len(flat) if isinstance(flat, list) else type(flat).__name__}. "
            "Each piece is placed by its position in that list.")

    for leaf, entry in zip(flat, plan):
        placed = dict(leaf)
        if placed.get("loc") != IDENTITY_LOC:
            # A fused piece read from STEP comes back with an identity
            # location, so the mesh is in the STEP file's frame, the one the
            # `at` below moves. A piece with its own location would have it
            # dropped here and be drawn with the wrong shape.
            raise ValueError(
                f"view {view_id!r}: the tessellator gave the difference piece "
                f"{entry['name']!r} a location of its own ({placed.get('loc')!r}). "
                "The pieces are drawn in the frame of the part's STEP file and "
                "placed with the motion the view applied to the part, so there "
                "is nowhere for a second one to go.")
        placed["name"] = entry["name"]
        # The piece was measured in the STEP file's frame; its place in this
        # view is the motion the view applied to that solid, the referencing
        # leaf's `at`. Without it every bright piece is drawn at the origin.
        placed["loc"] = entry["at"]
        # Set explicitly rather than trusted from the tessellation: these two
        # are what the scene is for.
        placed["color"] = entry["color"]
        placed["alpha"] = DIFFERENCE_ALPHA
        # Stated rather than parsed from the name, as `views.export_views`
        # stamps a key on every leaf.
        placed["key"] = entry["key"]
        drawn[entry["group"]].append(placed)
    return drawn, version


def _tessellate(plan):
    """The difference geometry turned into triangles, in one call. `(parts, version)`.

    The first argument must be `None`: otherwise the exporter writes `var
    shapes = {...}` instead of bare JSON (SPEC 5.1). Without `filename` it
    returns the JSON as a string, which is what a request-scoped comparison
    wants.

    Flat, one object per piece, as `views.export_views` does: given a dict the
    tessellator nests a group's name, loses leaf names and colours the group.
    The names below are positional and the caller overwrites them.

    It takes a bare `TopoDS_Shape` and imports no cadquery (verified:
    `sys.modules` holds no `cadquery` afterwards): 271 MB resident for OCP
    against the ~450 MB of `import cadquery`.
    """
    from ocp_tessellate.convert import export_three_cad_viewer_js

    document = json.loads(export_three_cad_viewer_js(
        None, *[entry["shape"] for entry in plan],
        names=[f"piece {index}" for index in range(len(plan))],
        colors=[entry["color"] for entry in plan],
        alphas=[DIFFERENCE_ALPHA] * len(plan)))
    return document.get("parts"), document.get("version")


def _group(name, root_id, version, leaves):
    """One child of the scene root, with its leaves' ids rebuilt under it.

    A group moves nothing (every leaf carries its own loc); the identity is
    written out because the viewer reads `loc` off every node.
    """
    group_id = f"{root_id}/{name}"
    for leaf in leaves:
        leaf["id"] = f"{group_id}/{leaf['name']}"
    return {"version": version, "name": name, "id": group_id,
            "loc": IDENTITY_LOC, "parts": leaves}


def _one_version(seen, view_id):
    """The payload version the scene declares, which all its sources must agree on.

    A document declares once, at the root, how its buffers are encoded, and a
    merged scene can only declare it once. Sources from different images or a
    newer tessellator would put meshes in two formats under one number, which
    renders wrong rather than failing.
    """
    distinct = set(seen.values())
    if len(distinct) != 1:
        described = ", ".join(f"{label}: {version!r}"
                              for label, version in sorted(seen.items()))
        raise ValueError(
            f"view {view_id!r}: the parts of this comparison do not agree on "
            f"the payload version ({described}). One scene declares one "
            "version, and the meshes under it have to be written to it.")
    return distinct.pop()


def _union_bb(document_a, document_b, view_id):
    """The box around both revisions, which is the box the viewer frames on.

    Required from both documents: the vendored viewer reads it once, off the
    root (`if (shapes.bb) { this._bbox = new BoundingBox(...) }`), and without
    it the camera, view cube and section planes work from nothing.

    The difference cannot widen it: removed material is part of A, added part
    of B.
    """
    boxes = [_bb_of(document_a, REVISION_A_NAME, view_id),
             _bb_of(document_b, REVISION_B_NAME, view_id)]
    return {field: (min if field.endswith("min") else max)(
        box[field] for box in boxes) for field in BB_FIELDS}


def _bb_of(document, label, view_id):
    box = document.get("bb")
    if not isinstance(box, dict) or not all(
            isinstance(box.get(field), (int, float)) for field in BB_FIELDS):
        raise ValueError(
            f"view {view_id!r}: {label} carries no usable bounding box "
            f"({box!r}). The viewer takes the scene's own extent from the root "
            f"of the document and nowhere else, so the six numbers "
            f"{', '.join(BB_FIELDS)} have to be there.")
    return box
