"""Reusable geometry checks for the `checks()` in model.py.

NOT PART OF THE TEMPLATE, and this line used to say it was — "the shared half
of the template, like `scripts/` and the `Makefile`", which described a
directory in `cad_publish` that a project copied and that no longer exists.
This module ships INSIDE THE HUB'S IMAGE and is reached by the `checklib.py`
shim at the repository root; what `hammerola create` unpacks is `model_template/`,
and there is nothing of this file in it. A fix therefore rolls out with the
image, to every model at once, rather than being copied into projects — which is
the same rule read from the other end: the project author calls these and does
not edit them, and a `checklib.py` of one's own SHADOWS this one (the model's
directory goes first on `sys.path`) rather than extending it.

Every function measures the solids and returns a **list of problem strings**,
empty when nothing is wrong. That is the same shape `checks()` may return, so
a model composes them:

    import checklib

    def checks(out_dir):
        problems = []
        problems += checklib.pairwise_interference([body, lid], ["body", "lid"])
        problems += checklib.mating_face_flat(body, BOX_HEIGHT, name="body rim")
        return problems

Nothing here restates a constant from the model. Each function reads the shape
that actually came out of the modelling operations, which is the only way a
check can fail when the geometry drifts away from the numbers that drove it.

Axes are the model's own coordinates, and Z is up: `material_under_head`
probes along Z, `mating_face_flat` takes the height of the joint as `plane_z`.
A part modelled lying on its side has to be rotated before these two mean
anything.
"""

import math

# Millimetres. Volumes below this are boolean noise, not overlap.
DEFAULT_VOLUME_TOL = 1e-6
# A face normal is "in the plane" when its Z component is under this. Pure
# geometry, not a fudge: a wall meeting the joint at a right angle gives 0.0,
# a 45 deg chamfer gives 0.707, a fillet tangent to the joint gives 1.0.
# DIMENSIONLESS -- it is a component of a unit vector, never a length.
NORMAL_TOL = 1e-3
# Millimetres. How close to `plane_z` a face or an edge has to be to count as
# reaching the joint. A separate constant from NORMAL_TOL on purpose: the two
# happen to share a value and measure different things, and one parameter
# carrying both means a caller who widens the distance also, silently, widens
# what counts as a flat face.
PLANE_TOL = 1e-3

# There is no wall-thickness check here on purpose. Measuring a wall by firing
# rays along surface normals gave a false red on ordinary spline geometry --
# lofts, sweeps, imported STEP -- and no amount of filtering the artefacts made
# the number trustworthy. Thin walls are looked at by eye, on the preview and
# in the slicer.


# Every pair pairwise_interference actually intersected, and the volume it
# measured -- including the zeroes, which are the ones worth keeping: a pair
# that reads 0.00 mm3 today and 4.10 mm3 tomorrow is a part that grew into its
# neighbour, and the build that reports it is the one where it happened.
#
# It is a RECORD OF WORK ALREADY DONE, not a second computation: the numbers are
# taken as the check goes, so cadbuild.metrics can put them in metrics.json
# single extra boolean. Pairs the cheap bounding-box reject skipped are not in
# here, because nothing measured them -- absence means "not computed", never
# "zero". Accumulates over the run: a model may call the check once per
# subassembly, and each call adds its own pairs.
_INTERFERENCE = {}


def recorded_interference():
    """`{"a|b": mm3}` for every pair pairwise_interference has measured so far."""
    return dict(_INTERFERENCE)


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

def _shape(obj, where):
    """Accept a Workplane or a bare Shape, hand back a Shape."""
    shape = obj.val() if hasattr(obj, "val") else obj
    if not hasattr(shape, "BoundingBox"):
        raise TypeError(f"{where}: expected a CadQuery object, got {type(obj).__name__}")
    return shape


def _classifier(shape):
    """Point-in-solid test for one shape, built once and reused.

    Booleans are the obvious way to ask "is there material here", and far too
    slow to ask a few hundred times. The classifier answers the same question
    per point in microseconds. ON counts as material: a probe landing exactly
    on a face is touching the part, not hanging off it. Callers must therefore
    keep their probe points off the surfaces -- a point that sits on a face
    answers about the face, not about what is behind it.
    """
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    classifier = BRepClass3d_SolidClassifier(shape.wrapped)

    def inside(x, y, z):
        classifier.Perform(gp_Pnt(x, y, z), 1e-7)
        return classifier.State() != TopAbs_OUT

    return inside


def _boxes_apart(a, b, tol):
    """True when two bounding boxes cannot possibly share a point."""
    return (a.xmin > b.xmax + tol or b.xmin > a.xmax + tol
            or a.ymin > b.ymax + tol or b.ymin > a.ymax + tol
            or a.zmin > b.zmax + tol or b.zmin > a.zmax + tol)


def name_pairs(pairs, argument, where=""):
    """Validate a list of name pairs and return it as a set of frozensets.

    `allowed_touching=("body", "lid")` is the mistake this exists for. It is a
    tuple of two strings, so it looks exactly like one pair -- and iterating it
    yields two *strings*, each of which frozenset() happily turns into a set of
    letters. Nothing raises, nothing matches, and the exemption the author
    wrote is silently not there. So: every element has to be a pair of strings,
    and anything else stops the check with a message that says which.

    Public, and shared: `cadbuild.views` validates a view's `nested_ok`
    with this same function. The two lists mean the same thing to two different
    checks, and when each file had its own copy of this the copies drifted --
    one of them ended up iterating the pair twice, which for a generator is
    once too many: the second pass sees nothing, `all()` over nothing is True,
    and a pair of non-strings walked straight through. One implementation, one
    behaviour, one message.

    `argument` names the option in the message ("allowed_touching",
    "nested_ok"); `where` is an optional prefix for the caller's context, e.g.
    "view 'print': ".

    Every element is consumed exactly once, so a generator of pairs -- and a
    generator *as* a pair -- is validated the same as a list.
    """
    if isinstance(pairs, str):
        raise ValueError(
            f"{where}{argument} must be a list of name PAIRS, got the string "
            f"{pairs!r}. Write it as [('a', 'b')]."
        )
    out = set()
    for index, pair in enumerate(pairs):
        if isinstance(pair, str) or not hasattr(pair, "__iter__"):
            raise ValueError(
                f"{where}{argument}[{index}] is {pair!r}, not a pair of names. "
                f"A flat {argument}=('body', 'lid') is two names, not one "
                "pair -- it matches nothing. Write "
                f"{argument}=[('body', 'lid')]."
            )
        # Once. `pair` may be a generator, and a second pass over it is empty.
        items = list(pair)
        if len(items) != 2 or not all(isinstance(x, str) for x in items):
            raise ValueError(
                f"{where}{argument}[{index}] is {pair!r}: a pair is exactly two "
                "part names, both strings."
            )
        out.add(frozenset(items))
    return out


# --------------------------------------------------------------------------
# 1. Interference between parts
# --------------------------------------------------------------------------

def pairwise_interference(objects, names, allowed_touching=(), tol=DEFAULT_VOLUME_TOL):
    """Every pair of parts, checked for shared volume. No hand-written list.

    Catches: a rim modelled a touch too generously passing straight through
    two neighbours, because the hand-written list of pairs to check happened
    to name neither of them. Enumerating pairs by hand is the bug -- the pair
    nobody thought of is exactly the pair that breaks -- so this takes every
    part in the assembly and checks all of them against each other.

    `objects` are the parts positioned as assembled (the same objects the
    `assembled` view shows), `names` their labels, one per object. Parts that
    are *meant* to share space -- a press fit, an insert modelled sunk into
    its boss -- go into `allowed_touching` as name pairs and are skipped:

        allowed_touching=[("body", "brass_insert")]

    A list of PAIRS, note: a flat `("body", "brass_insert")` is two names and
    exempts nothing, so it is rejected rather than ignored.

    Solids that only touch face to face intersect in zero volume, so seated
    parts pass without being listed. `tol` is in cubic millimetres and exists
    to swallow boolean noise, nothing more.

    Returns a list of problem strings.
    """
    shapes = [_shape(obj, f"object #{i}") for i, obj in enumerate(objects)]
    names = list(names)
    if len(names) != len(shapes):
        raise ValueError(
            f"pairwise_interference got {len(shapes)} objects but {len(names)} names"
        )

    skip = name_pairs(allowed_touching, "allowed_touching")
    known = set(names)
    for pair in skip:
        unknown = sorted(pair - known)
        if unknown:
            raise ValueError(
                "allowed_touching names "
                f"{', '.join(repr(x) for x in unknown)}, which is not among "
                f"the parts handed in ({', '.join(repr(n) for n in names)}). "
                "An exemption for a part that is not there exempts nothing."
            )

    boxes = [s.BoundingBox() for s in shapes]
    problems = []

    for i in range(len(shapes)):
        for j in range(i + 1, len(shapes)):
            if frozenset((names[i], names[j])) in skip:
                continue
            # Cheap reject first: most pairs in an assembly are nowhere near
            # each other, and a boolean on a complex solid is not free.
            if _boxes_apart(boxes[i], boxes[j], 0.0):
                continue
            try:
                common = shapes[i].intersect(shapes[j])
            except Exception as exc:  # OCCT gives up on some degenerate pairs
                problems.append(
                    f"cannot test {names[i]!r} against {names[j]!r}: the "
                    f"intersection failed ({type(exc).__name__}: {exc}). "
                    "Check that pair by eye."
                )
                continue
            volume = sum(solid.Volume() for solid in common.Solids())
            # Recorded whether it is a problem or not -- see _INTERFERENCE.
            _INTERFERENCE["|".join(sorted((names[i], names[j])))] = volume
            if volume > tol:
                box = common.BoundingBox()
                problems.append(
                    f"{names[i]!r} and {names[j]!r} share {volume:.2f} mm3 of "
                    f"space, in the region "
                    f"X {box.xmin:.1f}..{box.xmax:.1f}, "
                    f"Y {box.ymin:.1f}..{box.ymax:.1f}, "
                    f"Z {box.zmin:.1f}..{box.zmax:.1f}. "
                    "Parts cannot occupy the same volume; if this pair is a "
                    "press fit, list it in allowed_touching."
                )
    return problems


# --------------------------------------------------------------------------
# 2. The joint between two parts has to stay flat
# --------------------------------------------------------------------------

def mating_face_flat(part, plane_z, tol=PLANE_TOL, name="part",
                     normal_tol=NORMAL_TOL):
    """The face a split part mates on must be flat all the way to its edge.

    Catches: a chamfer or fillet applied to "all edges" biting into the
    parting line. The two halves then rest on their remaining flat rings and
    stand apart by the size of the bevel -- a 0.6 mm chamfer on each half is a
    1.2 mm gap in the assembled box. It reads as a modelling detail and costs
    a run of one-line fixes, each of which moves the problem to another edge.

    Purely geometric, no constants involved: every face that reaches the plane
    z == `plane_z` must either lie *in* it (the mating face itself) or leave
    it at a right angle (a wall). A face that departs at any other angle is a
    bevel eating the joint. The reported angle is measured from the plane: an
    honest vertical wall leaves at 90 deg (and is not reported), a 45 deg
    chamfer at 45, a fillet running tangent to the joint at 0. Vertical corner
    fillets and the walls of holes are all fine and are not reported.

    `plane_z` is the height of the joint in the part's own coordinates, so Z
    is the axis of the split.

    TWO TOLERANCES, because two different things are being measured and one
    parameter used to carry both. `tol` is MILLIMETRES: how close to `plane_z`
    a face or an edge has to be to count as reaching the joint, and how thin a
    face has to be in Z to count as lying in it. `normal_tol` is
    DIMENSIONLESS: the Z component of a unit normal below which the face is
    called upright. Passing a millimetre figure as `tol` used to also move the
    verdict, because the decisive comparison read the module constant instead
    of the argument -- so a caller who widened the search by a tenth of a
    millimetre got a mixture: a wider search and, still, the default verdict.

    Every edge of a face that lies in the plane is sampled, not just the first
    one: a single face can reach the joint along several edges -- a shelf that
    runs round three sides of a pocket, a chamfer broken by a hole -- and the
    bevel is as likely to be on the third edge as on the first. The worst edge
    of each face is the one reported.

    KNOWN GAP: a face that crosses the plane *transversally without having an
    edge in it* -- a sloped wall passing straight through the joint height, a
    cone whose surface simply continues past it -- is not covered. There is no
    edge to sample the normal at, and finding where such a face meets the
    plane means sectioning it, which costs more than this check is worth.
    Where that matters, split the part at the joint so the plane becomes a real
    edge, or check the section by eye.

    Returns a list of problem strings.
    """
    shape = _shape(part, name)
    problems = []
    flat_area = 0.0
    seen_faces = 0

    for face in shape.Faces():
        box = face.BoundingBox()
        if box.zmin > plane_z + tol or box.zmax < plane_z - tol:
            continue  # nowhere near the joint
        seen_faces += 1

        if box.zlen <= tol:
            # Lies in the plane: this is the mating surface (or a piece of it).
            flat_area += face.Area()
            continue

        # Reaches the plane and leaves it. Sample the normal exactly where it
        # touches -- at the middle of an edge lying in the plane -- because
        # the middle of the face says nothing about the angle at the contact.
        # All such edges, worst one wins.
        worst = None
        for edge in face.Edges():
            ebox = edge.BoundingBox()
            if ebox.zlen > tol or abs(ebox.zmin - plane_z) > tol:
                continue
            point = edge.positionAt(0.5)
            try:
                normal = face.normalAt(point)
            except Exception:
                continue  # cannot sample this one; the others still count
            out_of_plane = abs(normal.z)
            if worst is None or out_of_plane > worst[0]:
                worst = (out_of_plane, point)

        if worst is None or worst[0] <= normal_tol:
            continue

        out_of_plane, point = worst
        # Angle from the plane: acos, not asin. The normal is perpendicular to
        # the face, so a normal fully out of plane (|nz| == 1) is a face lying
        # flat *along* it -- 0 deg, a tangent fillet -- and a normal lying in
        # the plane is an upright wall at 90.
        angle = math.degrees(math.acos(min(1.0, out_of_plane)))
        bite = max(box.zmax - plane_z, plane_z - box.zmin)
        problems.append(
            f"{name}: the mating face at z={plane_z:g} is cut by a "
            f"{face.geomType().lower()} face at "
            f"({point.x:.1f}, {point.y:.1f}) that leaves the plane at "
            f"{angle:.0f} deg and reaches {bite:.2f} mm past it. "
            "The joint is no longer flat: assembled, the halves stand "
            "apart by that much. Chamfer and fillet the other edges, "
            "not this one."
        )

    if seen_faces == 0 or flat_area <= 0.0:
        problems.append(
            f"{name}: nothing lies in the plane z={plane_z:g} -- there is no "
            "flat mating face there at all. Wrong height, or the joint was "
            "modelled away."
        )
    return problems


# --------------------------------------------------------------------------
# 3. Material under a screw head
# --------------------------------------------------------------------------

def material_under_head(part, centre, head_diameter, depth, name="part", angles=24):
    """A screw head (or counterbore) needs material under all of it.

    Catches: a screw boss placed close to a rounded corner, where part of the
    head footprint hangs over the edge. The hole is there, the screw goes in,
    and the head bears on half a ring -- visible only once the part is in your
    hand, or in a section view nobody took.

    Probes the outer rim of the footprint, which is where a head running off
    an edge loses its seat first, at several depths from the seating plane
    down. The clearance hole in the middle is deliberately not probed: it is
    supposed to be empty.

    **The probe runs along Z, and only along Z.** `centre` is (x, y, z) of the
    middle of the seating face in the part's own coordinates, and `depth` is
    measured down the Z axis from it: positive probes downwards (a head
    pressing on an upward-facing seat), negative probes upwards (a head
    seating from below). A screw going in sideways has to be checked on a
    rotated copy of the part -- there is no axis argument, because a check
    that quietly measured the wrong direction would be worse than none.

    `head_diameter` is the diameter of what bears on the seat: screw head,
    washer, or counterbore.

    `depth` may not be zero. With no depth every probe lands on the seating
    plane itself, where the classifier counts ON as material and the check
    passes for every part ever handed to it, hole or no hole.

    Returns a list of problem strings.
    """
    shape = _shape(part, name)

    try:
        cx, cy, cz = centre
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"material_under_head({name}): centre must be (x, y, z) of the "
            f"seating face, got {centre!r}"
        ) from exc

    if abs(depth) < 1e-9:
        raise ValueError(
            f"material_under_head({name}): depth is {depth!r}. With zero depth "
            "every probe sits on the seating plane itself, which counts as "
            "material, and the check passes for anything. Pass how deep the "
            "material has to run below the seat -- the plate thickness, the "
            "boss height -- or negative for a head seating from below."
        )

    inside = _classifier(shape)
    radius = head_diameter / 2.0
    levels = max(3, int(abs(depth) / 0.5) + 1)
    misses = []

    for i in range(angles):
        theta = 2.0 * math.pi * i / angles
        px = cx + radius * math.cos(theta)
        py = cy + radius * math.sin(theta)
        for k in range(levels):
            # Mid-cell sampling: the seating plane itself and the far face are
            # boundaries, and a probe sitting exactly on one says ON for a
            # reason that has nothing to do with the material in between.
            pz = cz - depth * (k + 0.5) / levels
            if not inside(px, py, pz):
                misses.append((px, py, pz, math.degrees(theta)))
                break

    if misses:
        px, py, pz, theta = misses[0]
        return [
            f"{name}: no material under the {head_diameter:g} mm head at "
            f"({cx:g}, {cy:g}, {cz:g}) -- {len(misses)} of {angles} points "
            f"around its rim sit over air, the first at "
            f"({px:.1f}, {py:.1f}, {pz:.1f}), {theta:.0f} deg round. "
            f"The head has no seat for the full {abs(depth):g} mm along Z: "
            "move the screw inwards, or grow the boss."
        ]
    return []
