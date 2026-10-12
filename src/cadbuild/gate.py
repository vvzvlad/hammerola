#!/usr/bin/env python3
"""The gates that read a whole view: the print plate, and the assembly.

All of them run before anything is exported. An export meshes the shape in
place, and from then on OCCT's box is the mesh's, bigger and never smaller
(geometry.drop_mesh has the measurements). The plate judges extents outright,
so an inflated box could fail a correct layout. `check_interference` uses
boxes only as a filter, but an inflated box can send a body pair to a boolean
that the kernel refuses, and a refusal ends the whole part pair
(`_intersection_volume`), losing the verdict on a real overlap in it.

The inflation measured so far is more than an order of magnitude below
`PRINT_OVERLAP_TOL`, but that is a coincidence: the tolerance was not sized
against a triangulation.

Coverage is set membership: a view references catalogue keys.
"""

import time

from .artifacts import ASSEMBLED_VIEW_ID, PRINT_VIEW_ID
from .errors import BuildError
from .geometry import as_shapes
from .palette import INVISIBLE_ALPHA
from .parts import KIND_MOCK, KIND_PRINTABLE, printable_keys


# Millimetres of bounding-box overlap to shrug off in the print view.
#
# It must clear the accuracy of the boxes. Shape.BoundingBox() is
# BRepBndLib.AddOptimal_s, the exact box (the cheap BRepBndLib.Add_s bounds a
# B-spline by its control-point hull, measured 3.6 mm too wide on a swept
# spline). AddOptimal pads by ~1e-7 and its extremum search on a swept
# B-spline lands within ~1e-3 mm.
#
# 0.05 mm is not a layout mistake by any physical reading: a twentieth of a
# nozzle, less than the first-layer squish, under the slicer's arc tolerance.
# The check exists to catch the forgotten layout, where parts sit at the origin
# inside one another and overlap by millimetres.
PRINT_OVERLAP_TOL = 0.05

# How far a rotation matrix may be from an exact turn about Z before the print
# gate calls it a tilt.
#
# Exact axes composed by OCCT leave errors around 1e-15; a rotation of 0.0001
# degrees about X already puts 1.7e-6 into the checked row. Nothing real falls
# in between.
Z_ROTATION_TOL = 1e-6

# Cubic millimetres of intersection to shrug off in the assembled view.
#
# About the boolean, not the design: OCC's `common` on two solids that merely
# touch returns an empty compound (exactly 0.0), but a tangential contact can
# also come back as a sliver solid of numerical dust. A 0.05 mm press fit on a
# 10 mm boss 5 mm deep is ~8 mm3, four orders above this, and should be
# reported and declared.
#
# A sliver of an open shell is excluded, not tolerated: `_intersection_volume`
# sums `Solids()`. `Volume()` of an open shell is the volume of the body OCC
# closes it into, which can be large.
INTERFERENCE_VOLUME_TOL = 1e-3


def _view(prepared, vid):
    """The prepared view with this id, or None."""
    for view in prepared:
        if view["id"] == vid:
            return view
    return None


def _bodies(node, vid):
    """A leaf's bodies and their bounding boxes -- resolved ONCE, side by side.

    Every body of every object: an object assembled with `.add()` is several
    solids, and any of them may stand in a neighbour.

    Returned together so downstream code uses the same solids in the same
    order. A node without an `at` holds the model's object verbatim
    (`views._read_reference`, `_placed`), and a model is arbitrary code, so a
    second `vals()` is not promised to answer like the first: boxes from one
    list and booleans on another could test the wrong pair, or raise
    IndexError outside the gate's `try`.
    """
    shapes = as_shapes(node["shape"], f"view {vid!r} part {node['label']}")
    return shapes, [shape.BoundingBox() for shape in shapes]


def _overlap(a, b):
    """How far two boxes overlap on each axis; negative means a gap."""
    return (min(a.xmax, b.xmax) - max(a.xmin, b.xmin),
            min(a.ymax, b.ymax) - max(a.ymin, b.ymin),
            min(a.zmax, b.zmax) - max(a.zmin, b.zmin))


def check_print_layout(prepared, catalogue):
    """The `print` view has to be a plate: printable parts, upright, laid out.

    Three rules:

    Only printables. `print.stl` may be handed to a slicer; a mock of a bought
    bearing or a screw on it invites printing it.

    No tilt. Print orientation is a property of the part, held by the catalogue;
    `at` may translate and turn about Z (laying out a bed). Any other rotation
    re-orients the part, so the printed part is not the catalogue's.

    Nothing standing inside anything. Orienting helpers return parts at the
    origin and laying them out is an easy step to forget; the view would still
    publish, as parts inside one another.

    Bounding boxes, not booleans, for the last: parts on a bed need clear air,
    so overlapping boxes are already the answer. Touching (zero gap) passes. A
    one-part print view has nothing to lay out, and a print view is optional.
    """
    view = _view(prepared, PRINT_VIEW_ID)
    if view is None:
        return
    nodes = view["nodes"]

    not_printed = [node for node in nodes
                   if catalogue[node["key"]]["kind"] != KIND_PRINTABLE]
    if not_printed:
        listed = "\n".join(
            f"  - {node['label']} is {catalogue[node['key']]['kind']}"
            for node in not_printed)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} holds parts that are not printed:\n"
            f"{listed}\n"
            f"The {PRINT_VIEW_ID!r} view is the bed, and {PRINT_VIEW_ID}.stl "
            "is a file somebody may open in a slicer -- a bought part on it is "
            "an offer to print the thing that was bought. Show it in "
            f"{ASSEMBLED_VIEW_ID!r}, where it belongs, and leave the plate to "
            "what comes off the printer."
        )

    tilted = [node for node in nodes if not _turns_about_z_only(node["at"])]
    if tilted:
        listed = "\n".join(f"  - {node['label']}" for node in tilted)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} turns parts off the bed:\n{listed}\n"
            'On the plate "at" may move a part and turn it about Z, and that '
            "is all: which way up a part prints is a property of the part, so "
            "the catalogue holds it in its print orientation and the view only "
            "lays it out. Rotate it where it is built, not where it is shown. "
            "A MIRROR is refused by the same line and for a stronger reason: "
            "reflecting a chiral part produces a different part, and the file "
            "published under this key would hold the other one."
        )

    if len(nodes) < 2:
        return
    allowed = view["nested_ok"]

    entries = []
    for index, node in enumerate(nodes):
        # The plate judges extents only, but this is the first place an
        # entry's whole stack is checked: `parts.read_catalogue` admits it via
        # `as_shape` (`obj.val()` only), and `views._placed` runs `as_shapes`
        # only when the reference has an `at`. So a bare reference whose stack
        # holds a non-geometry second item is caught here, by part name.
        _, boxes = _bodies(node, PRINT_VIEW_ID)
        for box in boxes:
            entries.append((index, node, box))

    problems = []
    seen_pairs = set()
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            owner_i, node_i, box_i = entries[i]
            owner_j, node_j, box_j = entries[j]
            # Bodies of the same object are one part to the view (one label),
            # so they are not compared and could not be declared nested_ok.
            if owner_i == owner_j:
                continue
            if frozenset((node_i["key"], node_j["key"])) in allowed:
                continue
            over = _overlap(box_i, box_j)
            # Boxes intersect only when they overlap on all three axes; a gap
            # on any one of them means the parts are clear.
            if min(over) <= PRINT_OVERLAP_TOL:
                continue
            # One line per pair of parts, not per pair of bodies.
            pair = frozenset((owner_i, owner_j))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            problems.append(
                f"  - {node_i['label']} and {node_j['label']} overlap by "
                f"X {over[0]:.2f}, Y {over[1]:.2f}, Z {over[2]:.2f} mm"
            )
    if problems:
        listed = "\n".join(problems)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} has parts standing inside each other:\n"
            f"{listed}\n"
            "The print view is the bed: every part needs its own patch of it. "
            'Give each reference an "at" that moves it clear of the others. A '
            "pair that really is nested on purpose goes in the view's "
            '"nested_ok": [("a", "b")], by catalogue key.'
        )


def _turns_about_z_only(at):
    """Is this Location a translation and a turn about Z, and nothing else?

    Read off the rotation matrix rather than Euler angles (no conventions or
    gimbal cases): a rotation is about Z exactly when the third row and third
    column are both (0, 0, 1).

    That alone does not exclude a mirror: a reflection in a plane containing Z
    leaves both at (0, 0, 1) (cadquery 2.8.0:
    `gp_Trsf.SetMirror(gp_Ax2(origin, X))` gives
    [[-1,0,0],[0,1,0],[0,0,1]]). The `gp_Ax1` overload is a half turn about
    the axis (determinant +1, moves Z) and is caught by the rows.

    A mirrored chiral part is a different part from the catalogue's, and it
    would be printed while `<key>.stl` holds the other. So the determinant's
    sign is checked first: `IsNegative()` is true exactly for a negative
    determinant of the vectorial part.
    """
    if at is None:
        return True
    try:
        trsf = at.wrapped.Transformation()
        mirrored = bool(trsf.IsNegative())
        rows = [[float(trsf.Value(row, col)) for col in (1, 2, 3)]
                for row in (1, 2, 3)]
    except Exception as exc:
        raise BuildError(
            f'"at" is {at!r}, and the build could not read a rotation out of '
            f"it ({type(exc).__name__}: {exc}). It has to be a cq.Location."
        ) from exc
    if mirrored:
        return False
    third_row = rows[2]
    third_column = [rows[0][2], rows[1][2], rows[2][2]]
    return all(abs(value - want) <= Z_ROTATION_TOL
               for line in (third_row, third_column)
               for value, want in zip(line, (0.0, 0.0, 1.0)))


def check_assembled_coverage(prepared, catalogue):
    """Every printable has to be IN the assembled view, by catalogue key.

    A part can be modelled, exported and checked and still be missing from the
    picture the product is judged by. This is an exact question: is the key
    among those the view references.

    A reference at alpha 0 is not drawn, so it does not count. It is warned
    about where the alpha is read (prepare_views).
    """
    view = _view(prepared, ASSEMBLED_VIEW_ID)
    if view is None:
        # Defensive half of prepare_views' rule (it refuses a model without
        # one).
        raise BuildError(f"there is no {ASSEMBLED_VIEW_ID!r} view to judge")

    shown = {node["key"] for node in view["nodes"]
             if node["alpha"] > INVISIBLE_ALPHA}
    missing = [key for key in printable_keys(catalogue) if key not in shown]
    if missing:
        raise BuildError(
            f"view {ASSEMBLED_VIEW_ID!r} does not show printable(s) "
            f"{', '.join(repr(k) for k in missing)}. The assembled view is "
            "what the design is judged by and the only place the build counts "
            "parts from, so every printed part is in it -- add the key to its "
            '"parts". Hardware and mocks alongside are fine; printables are '
            "what must be there."
        )

    for node in view["nodes"]:
        if (catalogue[node["key"]]["kind"] == KIND_PRINTABLE
                and node["alpha"] < 1.0):
            # A warning, not a refusal: a person may have meant it. A
            # see-through printed part in the judged view is usually a leftover
            # from looking inside the assembly.
            print(
                f"warning: view {ASSEMBLED_VIEW_ID!r} draws printable "
                f"{node['label']} at alpha {node['alpha']:g}. This is the view "
                "the product is judged by, and a part that is printed solid is "
                "drawn solid in it -- look through the mocks instead, or take "
                "the alpha off once you have seen inside."
            )


def check_interference(prepared, catalogue):
    """Nothing in the assembled view may overlap unless the view says why.

    Every solid in the view is a catalogue part, so the remaining way to
    publish an impossible assembly is two parts occupying the same space.
    Intended interference (a thread biting into its seat, a barb in a tube, an
    insert melted into its hole) is declared with a reason, printed here.

    A `mock` is not material and is not asked about: a pair with a mock on
    either side is skipped. Mocks are scenery (the wall a bracket bolts to)
    and overlap the product by construction; declaring each would bury the
    real declarations. `hardware` stays under the gate: a screw thread in a
    printed hole is exactly what should be declared.

    Boxes come first because pairs grow with the square of references and
    booleans cost seconds; clear boxes cannot intersect.

    The filter runs once, on body pairs: a part pair needs a boolean exactly
    when some body pair survives. That is stricter than a per-part hull test.
    `checklib.pairwise_interference` keeps a hull level too; it is not copied
    here because the per-body boxes are taken anyway and a far pair costs only
    float comparisons. Body pairs that cannot overlap must never reach a
    boolean (see `_intersection_volume`).

    An exemption is by catalogue key, so it covers every instance: five
    references to `pin` are ten pairs and one declaration covers all ten,
    as with `nested_ok` on the plate.
    """
    view = _view(prepared, ASSEMBLED_VIEW_ID)
    if view is None or len(view["nodes"]) < 2:
        return
    nodes = view["nodes"]
    allowed = view["interference_ok"]
    for pair, reason in sorted(allowed.items(), key=lambda item: sorted(item[0])):
        # Printed whether or not the pair overlaps, so the log shows every
        # exemption, including ones no longer needed.
        listed = " and ".join(repr(key) for key in sorted(pair))
        print(f"  {ASSEMBLED_VIEW_ID}: {listed} may overlap -- {reason}")

    started = time.monotonic()
    # Scenery is decided before any box is taken: `Shape.BoundingBox()` is
    # AddOptimal_s (see PRINT_OVERLAP_TOL), and mocks are typically heavy
    # (an imported STEP of a wall or a board).
    scenery = [catalogue[node["key"]]["kind"] == KIND_MOCK for node in nodes]
    # One resolution per node (see `_bodies`). Mocks are not resolved: their
    # geometry is still validated by `assembly.assembled_shape` and
    # `views.export_views`. Skipping them also keeps a mesh leaf (shape None)
    # away from `as_shapes`; only a mock may be a mesh
    # (`parts.read_catalogue`), so this is the whole guard.
    resolved = [None if is_scenery else _bodies(node, ASSEMBLED_VIEW_ID)
                for node, is_scenery in zip(nodes, scenery)]
    problems = []
    tested = 0
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if scenery[i] or scenery[j]:
                continue
            if frozenset((nodes[i]["key"], nodes[j]["key"])) in allowed:
                continue
            # Strictly greater than zero, no tolerance: overlap depth is not
            # overlap volume (0.1 mm across a 30 x 30 mm face is 90 mm3), so
            # any slack here could hide a real finding. Speed comes from pairs
            # nowhere near each other.
            #
            # The surviving body pairs are carried: they decide whether the
            # part pair needs a boolean and which body pairs do. And since
            # `_intersection_volume` ends the part pair on the first refused
            # boolean, a body pair that cannot overlap must not reach one.
            # The bodies themselves are carried, not indices (see `_bodies`).
            left_bodies, left_boxes = resolved[i]
            right_bodies, right_boxes = resolved[j]
            pairs = [(left, right)
                     for left, left_box in zip(left_bodies, left_boxes)
                     for right, right_box in zip(right_bodies, right_boxes)
                     if min(_overlap(left_box, right_box)) > 0.0]
            if not pairs:
                continue
            tested += 1
            volume = _intersection_volume(nodes[i]["label"], nodes[j]["label"],
                                          pairs)
            # None means the kernel would not answer (already warned); no
            # verdict on a pair nothing measured.
            if volume is not None and volume > INTERFERENCE_VOLUME_TOL:
                problems.append(
                    f"  - {nodes[i]['label']} and {nodes[j]['label']} share "
                    f"{volume:.3f} mm3"
                )
    # With its time, in the build's `1.2s` format: O(n^2) booleans inside the
    # `geometry` phase, so a slow build can see whether this is where the
    # minutes went. Timed directly rather than with `checklib.section`, whose
    # table is for the model's own checks(); this gate runs before them.
    print(f"  {ASSEMBLED_VIEW_ID}: {tested} pair(s) needed a boolean, "
          f"{len(allowed)} declared, {time.monotonic() - started:.1f}s")
    if problems:
        listed = "\n".join(problems)
        raise BuildError(
            f"view {ASSEMBLED_VIEW_ID!r} has parts occupying the same space:\n"
            f"{listed}\n"
            "Two solids cannot both be there, so one of two things is true: "
            "the parts do not fit and the model says so, or the overlap is the "
            "joint -- a printed thread, a barb, an insert. Say which, by "
            'catalogue key, in the view\'s "interference_ok": [("a", "b", "why '
            'they overlap")]. The reason is required and it is printed in this '
            "log."
        )


def _intersection_volume(first_label, second_label, body_pairs):
    """How much space two leaves really share, in mm3, or None if unanswerable.

    `body_pairs` holds the bodies, `(a body of the first part, a body of the
    second)`, for every pair whose boxes overlap; the caller dropped the rest.
    Solids rather than indices, so the boxes and the booleans refer to the same
    objects (see `_bodies`). The labels are for the warning.

    The first boolean the kernel refuses ends the pair and returns None: a
    partial sum would understate the overlap while reading like a verdict, and
    could publish a build under INTERFERENCE_VOLUME_TOL on no evidence. The
    warning says the pair went unchecked.

    Hence the box filter before the loop: a clear body pair cannot overlap but
    can still make the kernel fail, which would bury a real overlap between
    other bodies of the same parts.

    Only solids are counted: a tangential touch can return a shell sliver,
    whose `Volume()` is the volume of the body OCC closes it into.

    These three decisions are copied from `checklib.pairwise_interference`,
    which is not called because its contract differs: it returns problem
    strings with model labels and records into `checklib._INTERFERENCE` (the
    model's metrics.json), while this raises BuildError, names catalogue keys
    and must not touch the model's record.
    """
    total = 0.0
    for left, right in body_pairs:
        try:
            common = left.intersect(right)
            volume = sum(float(solid.Volume()) for solid in common.Solids())
        except Exception as exc:
            # A failed boolean says nothing about the model, so the build is not
            # refused over it, but it must not report "no interference" either.
            print(
                f"warning: could not test {first_label} against "
                f"{second_label} for interference "
                f"({type(exc).__name__}: {exc}). Their bounding boxes "
                "overlap, so this pair went UNCHECKED."
            )
            return None
        if volume > 0.0:
            total += volume
    return total
