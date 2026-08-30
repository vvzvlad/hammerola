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

import contextlib
import math
import time
# `import types`, not `from types import SimpleNamespace`: a bare name
# imported here becomes a public name of this module, and the root shim then
# owes it a re-export (test_everything_a_model_calls_is_re_exported).
import types

# CUBIC millimetres -- it is compared against volumes, and this line said
# "Millimetres" while `is_empty` said "cubic millimetres" a screenful below.
# Volumes below this are boolean noise, not overlap.
#
# IT WAS CALIBRATED FOR ONE QUESTION AND IS NOW USED FOR TWO. The question it
# was chosen for is "did this boolean BETWEEN TWO PARTS return real overlap or
# arithmetic dust"; `is_empty` asks it of a WHOLE PART, which is a different
# question with the same units and no measurement behind this value. It is
# reused rather than given a second constant because on this scale the two
# cannot disagree in practice: the smallest thing a printer can put down is a
# 0.4 mm extrusion at a 0.2 mm layer over 0.4 mm, i.e. 0.032 mm3, more than
# four orders of magnitude above this. A body that is real but under this
# threshold would have to be a sliver no process could make. Give `is_empty` a threshold
# of its own the day a caller has a reason to want a different one -- the
# parameter is already there.
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


# What each `with section(...)` block of checks() cost, in seconds, summed by
# label. Written by `section` below; PRINTED BY THE CORE and not by the model
# (cadbuild.modelchecks.run_checks), so the table comes out on a failed build
# too -- which is the log somebody actually opens.
#
# The same shape as _INTERFERENCE above and for the same reason: a record of
# work already done, taken as the work goes, so reading it costs nothing and
# accumulates over the whole run. A label reused -- inside a loop, or in two
# places -- is ONE line whose seconds are the sum, which is the point: what a
# repeated stretch costs altogether is the number that decides anything.
#
# NESTED SECTIONS EACH MEASURE THEIR OWN WALL TIME, so an inner one is also
# inside its outer one's total and the column does not add up to the run.
# Left that way deliberately: subtracting inner time would make a label's number
# depend on where else it was used.
_SECTIONS = {}


@contextlib.contextmanager
def section(label):
    """Mark a stretch of checks() so the build log can say what it cost.

        def checks(out_dir):
            problems = []
            with checklib.section("interference"):
                problems += checklib.pairwise_interference(parts, names)
            with checklib.section("probe grid"):
                for x, y in grid:
                    assert solid(x, y, 2.0), f"no material at {x},{y}"
            return problems

    Seconds per label, longest first, printed by the build after checks() ends
    -- including when it ends by failing.

    WHY THIS AND NOT A DECORATOR ON A HELPER. The hub counts the checks in a
    model by reading the SOURCE of `checks()` (modelchecks.count_checks), and a
    `checks()` with no check in its own body fails the build outright -- "an
    empty checks() is worse than none". Splitting the body into decorated
    helpers would leave exactly that: a `checks()` that only calls things. A
    `with` block leaves every assert where the counter can see it, which is
    measured rather than assumed -- `tests/cadbuild/test_modelchecks.py` counts
    asserts and `problems +=` lines sitting inside one.

    WHY IT IS WORTH MARKING ANYTHING AT ALL. Phases of a build are timed by
    build.py, and on a real model measured 2026-08-29 that was not enough: the
    checks phase was 495 seconds and 52% of it sat in a single loop inside it,
    which no per-phase number can point at.

    The label is a string and is refused if it is not one -- it is a table
    heading, and a stray tuple or Path would come out as one.
    """
    if not isinstance(label, str):
        raise TypeError(
            f"section() takes a label to print, got {type(label).__name__}. "
            "Write it as `with checklib.section('the joint'):`.")
    started = time.monotonic()
    try:
        yield
    finally:
        # In `finally`, so a check that fails inside a section still leaves its
        # cost behind: the failed build is the one whose timing is read.
        _SECTIONS[label] = _SECTIONS.get(label, 0.0) + (time.monotonic() - started)


def recorded_sections():
    """`{label: seconds}` for every section() block that has finished so far."""
    return dict(_SECTIONS)


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

# There is no `_shape` helper here any more, and its absence is deliberate.
# It returned `Workplane.val()` -- the FIRST body -- under the justification
# "fine where one body is all there can be (a printable is one part)". Both of
# its callers took arbitrary assembly objects rather than printables, so the
# sentence excused nothing while reading like it had been checked: measured on
# cadquery 2.8.0, `pairwise_interference` missed 800.00 mm3 of interference
# because the overlap was with the SECOND body of a part, and
# `mating_face_flat` reported "there is no flat mating face there at all" for a
# joint that lay on the second body. Everything here goes through `_shapes`.
# Bring a first-body helper back only for a caller that can say why one body is
# all there can be -- and none of the callers here can.
def _shapes(obj, where):
    """Every body a Workplane holds, not just the first. A bare Shape is one.

    `val()` is the first object on the stack, so a Workplane put together with
    `.add()` gets judged on its first body alone. Measured on cadquery 2.8.0:
    two 10 mm boxes 50 mm apart, added into one Workplane, give `vals()` of
    length 2 -- and a classifier built on `val()` answers OUT at the centre of
    the second box.

    A LOCAL ANALOGUE OF `geometry.as_shapes` RATHER THAN AN IMPORT OF IT, and
    the reason is the same one that made `checklib.py` at the repository root
    resolve this file by PATH. That shim loads this module with
    `spec_from_file_location` under the name `src.cadbuild.checklib` without
    importing `src.cadbuild` at all, precisely because a model project owns the
    name `src` (its root goes on sys.path first, see geometry.load_model). A
    `from .geometry import as_shapes` here would ask for that parent package
    anyway and put the whole shim back behind the name it was taken out from
    behind. That is not a prediction: the import was tried, and it turns
    `test_the_shim_survives_a_model_project_that_has_a_src_of_its_own` red --
    the test asserts the name `src` is never touched at all -- along with
    `test_everything_a_model_calls_is_re_exported`, since an imported function
    is a public name of this module and the root shim would then owe it a
    re-export.

    The error discipline differs too, and it is not cosmetic: as_shapes raises
    BuildError, which belongs to the hub, while everything in this file raises
    what a model author's own code raises -- run_checks turns a ValueError or a
    TypeError out of checks() into a failed build with the message and the line,
    which is the same treatment an assert gets.

    An empty stack comes back as an empty list rather than as a refusal here:
    the caller that cares (material_at) has one message for "no geometry" and
    "geometry with no solid in it", because they are the same mistake.
    """
    shapes = list(obj.vals()) if hasattr(obj, "vals") else [obj]
    for shape in shapes:
        if not hasattr(shape, "BoundingBox"):
            raise TypeError(
                f"{where}: expected CadQuery geometry, got {type(shape).__name__}")
    return shapes


def material_at(part, name="part"):
    """A fast "is there material at this point" probe for one part.

    Returns a function `probe(x, y, z) -> bool`, built once and reusable for as
    many points as you like:

        solid = checklib.material_at(body)
        if not solid(0, 0, 12.5):
            problems.append("the boss is hollow where the screw seats")

    USE THIS INSTEAD OF INTERSECTING WITH A SMALL CUBE. Asking the question
    with a boolean -- `body.intersect(cq.Workplane().box(0.6, 0.6, 0.6)
    .translate(p))` and looking at the volume -- is the obvious way and it is
    the reason builds take minutes: a boolean on a complex solid costs
    milliseconds to tens of milliseconds and this costs microseconds. A model
    doing a few hundred of them (a scan along a channel, a probe grid over a
    seat) pays seconds against nothing. Measured on a real model, 2026-08-29:
    point probes done with booleans were the single largest line of a
    495-second check run.

    BUT THEY ARE NOT THE SAME QUESTION, and anybody replacing one with the
    other has to know where they part. A cube asks "is there material within
    half a cube of here"; this asks about the POINT. Away from surfaces they
    agree exactly. Within half the cube's diagonal of a face they need not: a
    point sitting 0.2 mm OUTSIDE the part is empty here and material to a
    0.6 mm cube, which reaches 0.3 mm in every direction. So a probe grid
    ported across without moving its points can flip exactly the answers that
    sit near a boundary -- which, in a check written to ask "is there material
    right up against this face", is most of them.

    The fix is to say what you mean rather than to tune a cube: put the point
    where material is REQUIRED -- half a millimetre inside the wall, not on its
    surface -- and the two agree again. `tests/cadbuild/test_material_at.py`
    pins both halves of this, the agreement and the disagreement.

    ON COUNTS AS MATERIAL. A probe landing exactly on a face is touching the
    part rather than hanging off it, which means a point that sits on a surface
    answers about the surface and not about what is behind it -- another reason
    to keep probe points off the faces.

    THE PROBE IS BOUND TO THE PART AS IT WAS WHEN YOU ASKED FOR IT. It holds a
    classifier over that shape; moving or rebuilding the part afterwards does
    not update it. Take a fresh probe after a transform, and do not cache one
    across a rebuild.

    EVERY BODY IS PROBED, not the first one. A Workplane put together with
    `.add()` holds several, and the probe covers all of them: it holds ONE
    CLASSIFIER PER SOLID and answers yes as soon as one of them says yes.
    Measured on cadquery 2.8.0 -- on two 10 mm boxes 50 mm apart added into one
    Workplane, a classifier built the old way (on `val()`) answered OUT at the
    centre of the second box.

    Per solid, and not over a compound of them, because a classifier built over
    a compound answers WRONGLY on bodies that touch or nest -- it is documented
    for a solid, and over a compound the nearest face wins whichever solid it
    belongs to. On two touching 10 mm boxes it read "no material" inside the
    second one; on a 20 mm box holding a 2 mm cube it read "no material" over
    most of the box. The comment at the code has the points and the cost.

    A PART WITH NO SOLID IN IT IS REFUSED rather than probed. That is what a
    boolean which removed everything leaves behind, and the reason for the
    refusal is that the alternatives lie -- see the message itself.

    Anything with a solid in it works -- a Workplane, a Shape, a Compound --
    exactly like the other checks here. `name` only improves the error message
    when it is handed something that is not geometry, or geometry with nothing
    in it.
    """
    # THE TYPE CHECK COMES FIRST, BEFORE THE KERNEL IS IMPORTED, and the order
    # is the whole point rather than style. `_shapes` is plain Python; the OCP
    # import below needs the native OpenCASCADE libraries, which exist in the
    # hub's image and in very few other places. With the import first, handing
    # this a string answered `ImportError: libGL.so.1` on any machine without
    # them -- an error about the environment, for a mistake in the argument,
    # and one that made a test of the refusal impossible to run anywhere the
    # kernel is absent. That is exactly how it was caught: CI went red on the
    # test that asserts the refusal, in a container that has no OpenCASCADE.
    shapes = _shapes(part, name)

    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    solids = [solid for shape in shapes for solid in shape.Solids()]
    if not solids:
        # TWO DIFFERENT EMPTIES, and one message describing both would be false
        # about one of them: a Workplane with an empty stack has no body at all,
        # while a boolean that removed everything leaves a body that still looks
        # like geometry. The second is the one worth explaining at length --
        # nothing about it says "empty" until the volume is asked for.
        if not shapes:
            what = (
                "there is nothing here at all -- `.vals()` is empty, so not "
                "even a body came through. An empty Workplane, or a stack that "
                "every operation dropped.")
        else:
            what = (
                f"{len(shapes)} object(s) came through, not one of them with a "
                "solid in it. A boolean that removed everything leaves exactly "
                "this, and it does not look empty: `.vals()` is still a list "
                "holding one Compound, so it is still truthy, and only the "
                "VOLUME says the material is gone (checklib.is_empty is how to "
                "ask). It is refused instead of probed because both ways of "
                "asking about such a body lie, measured on cadquery 2.8.0. "
                "Probed: BRepClass3d_SolidClassifier built on it answers IN at "
                "EVERY point -- (0, 0, 0), (1000, 1000, 1000) and "
                "(-50000, 30000, 7000) all read as material -- so every `assert "
                "solid(...)` written against it passes and the part is "
                "certified solid everywhere in the universe. Intersected: it "
                "answers as its PREVIOUS version, because Workplane.intersect "
                "resolves its operand with findSolid(searchParents=True), which "
                "walks back up the chain to the solid that was there before the "
                "boolean emptied it -- a 4 mm probe cube against an emptied "
                "10 mm box measured 64.00 mm3, the whole cube.")
        raise ValueError(
            f"material_at({name}): there is no solid here to probe -- {what} "
            "Find the operation that came back empty; the geometry is what is "
            "wrong, not the check.")

    # ONE CLASSIFIER PER SOLID, and the answers OR'd together. The obvious
    # alternative -- `Compound.makeCompound(solids)` and one classifier over it
    # -- is WRONG, and wrong quietly: BRepClass3d_SolidClassifier is documented
    # for a SOLID, and over a compound it resolves a point against the nearest
    # face among all of them, so a face belonging to a different solid decides
    # the verdict. Measured on cadquery 2.8.0, against per-solid classifiers and
    # against an independent check (a 0.2 mm cube intersected solid by solid),
    # which agreed with each other everywhere:
    #
    #   two 10 mm boxes 50 mm apart   compound right   val() wrong
    #   the same two boxes TOUCHING   compound WRONG   val() wrong
    #   20 mm box, 2 mm cube INSIDE   compound WRONG   val() right
    #
    # On the touching pair the compound answered "no material" at (7, 0, 0),
    # (10, 0, 0) and (12, 0, 0), all of which are inside the second box; on the
    # nested pair it answered "no material" at (4, 0, 0) and (8, 0, 0), which
    # are inside the 20 mm box -- so a model that added an insert with `.add()`
    # would have read as hollow over most of its own body. Note the third row:
    # there the compound is worse than the single-body classifier this replaced.
    #
    # THE COST IS O(number of solids) PER POINT rather than O(1), and the short
    # circuit only helps when the answer is yes. Measured on this machine,
    # 20000 probes: ~11 us per classifier consulted, so a miss over 3 solids is
    # 33 us against 11 us for one, while a hit on the first solid stays at ~11 us
    # whatever the count. An ordinary part is 1-3 solids. There is deliberately
    # no bounding-box prefilter in front of this: it has not been measured to be
    # needed, and it would be a second, subtler thing to get wrong.
    classifiers = [BRepClass3d_SolidClassifier(solid.wrapped) for solid in solids]

    def probe(x, y, z):
        # The point is built once and handed to each classifier in turn.
        point = gp_Pnt(float(x), float(y), float(z))
        for classifier in classifiers:
            classifier.Perform(point, 1e-7)
            if classifier.State() != TopAbs_OUT:
                return True
        return False

    return probe


def volume(obj):
    """Cubic millimetres of material, over every body and every solid in it.

    The one honest answer to "did anything survive that boolean". `assert
    wp.vals()` is the answer people write instead, and IT CANNOT FAIL: measured
    on cadquery 2.8.0, a 10 mm box intersected with a 1 mm box 100 mm away
    hands back a Workplane whose `.vals()` is a list of ONE Compound -- truthy,
    length 1, no solids inside it, total volume 0.0. In the model that produced
    this function an `assert wp.vals()` had stood for months over the line
    beneath it, which read a bounding box off exactly that empty compound.

    THE BOUNDING BOX IS NOT AN ALTERNATIVE either: `BoundingBox()` on that body
    raises `Standard_Failure: Bnd_Box is void`, so a check reaching for extents
    to see whether anything is left dies with a message about a box.

    Solids only, like everywhere else here -- a sketch, a wire or a loose face
    is not material and contributes nothing. A Workplane, a Shape and a Compound
    are all accepted, and every body of a Workplane is counted (`.add()` puts
    several on the stack).
    """
    shapes = _shapes(obj, "volume")
    # The 0.0 start is not decoration: `sum([])` is the int 0, and this function
    # promises cubic millimetres for every input including the empty one.
    return sum((solid.Volume() for shape in shapes for solid in shape.Solids()),
               0.0)


def is_empty(obj, tol=DEFAULT_VOLUME_TOL):
    """True when nothing of substance is left -- the predicate over volume().

        assert not checklib.is_empty(body), "the pocket cut the whole part away"

    Write this where `assert body.vals()` suggests itself: that one is true for
    an emptied body (see volume), so it is an assert that cannot fail.

    `tol` is in cubic millimetres. Its default is DEFAULT_VOLUME_TOL, which was
    chosen for a different question -- boolean noise between two parts, not
    emptiness of one -- and is reused because nothing printable comes anywhere
    near it; the reasoning is written out at the constant. Pass your own where
    that matters.
    """
    return volume(obj) <= tol


def _boxes_apart(a, b, tol):
    """True when two bounding boxes cannot possibly share a point."""
    return (a.xmin > b.xmax + tol or b.xmin > a.xmax + tol
            or a.ymin > b.ymax + tol or b.ymin > a.ymax + tol
            or a.zmin > b.zmax + tol or b.zmin > a.zmax + tol)


def _hull(boxes):
    """One box enclosing them all -- for rejecting a PART against a part.

    A multi-body part has no single bounding box of its own, and the one thing
    a prefilter may never do is reject a pair that does overlap. Measured on
    cadquery 2.8.0: a part whose bodies sit at X -5..5 and X 25..35 has a
    `val().BoundingBox()` of -5..5, so a neighbour at X 27..37 was rejected as
    "nowhere near" while sharing 800.00 mm3 with the second body. The hull is
    a superset of every body, so it can only ever be too generous -- and the
    per-body pair below is what makes it tight again.
    """
    return types.SimpleNamespace(
        xmin=min(b.xmin for b in boxes), xmax=max(b.xmax for b in boxes),
        ymin=min(b.ymin for b in boxes), ymax=max(b.ymax for b in boxes),
        zmin=min(b.zmin for b in boxes), zmax=max(b.zmax for b in boxes))


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

    A PART MAY BE SEVERAL BODIES and all of them are checked, against all of
    the other part's. What is reported is one line per PART pair: the volumes
    of every overlapping body pair added up, and the region enclosing them.
    That is the pair a person can act on -- "which two parts collide" -- and it
    keeps `allowed_touching`, which names parts, meaning what it says. When the
    kernel refuses one body pair the whole part pair is reported as untestable
    rather than answered from the rest: a partial sum understates the overlap
    while reading exactly like a verdict.

    Returns a list of problem strings.
    """
    # EVERY BODY OF EVERY OBJECT. An object here is a part as assembled, which
    # is routinely several bodies -- `.add()`, a helper returning a lid and its
    # lip -- and judging one of them was not a simplification but a hole: see
    # the note where `_shape` used to be for the 800.00 mm3 it measured through.
    bodies = [_shapes(obj, f"object #{i}") for i, obj in enumerate(objects)]
    names = list(names)
    if len(names) != len(bodies):
        raise ValueError(
            f"pairwise_interference got {len(bodies)} objects but {len(names)} names"
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

    # Two levels of box, and they do different jobs. `hulls` rejects a PART
    # against a part in one comparison; `boxes` is per body, and rejects the
    # body pairs inside a part pair that survived. Neither may reject a pair
    # that overlaps, which is why the outer one is a hull rather than the first
    # body's box (see _hull).
    boxes = [[body.BoundingBox() for body in group] for group in bodies]
    hulls = [_hull(group) if group else None for group in boxes]
    problems = []

    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            if frozenset((names[i], names[j])) in skip:
                continue
            # Cheap reject first: most pairs in an assembly are nowhere near
            # each other, and a boolean on a complex solid is not free.
            if hulls[i] is None or hulls[j] is None:
                continue  # an object with no bodies cannot overlap anything
            if _boxes_apart(hulls[i], hulls[j], 0.0):
                continue

            volume = 0.0
            region = []
            failure = None
            for bi, left in enumerate(bodies[i]):
                for bj, right in enumerate(bodies[j]):
                    if _boxes_apart(boxes[i][bi], boxes[j][bj], 0.0):
                        continue
                    try:
                        common = left.intersect(right)
                    except Exception as exc:  # OCCT gives up on some pairs
                        failure = exc
                        break
                    shared = sum(solid.Volume() for solid in common.Solids())
                    if shared > 0.0:
                        volume += shared
                        region.append(common.BoundingBox())
                if failure is not None:
                    break

            if failure is not None:
                # One body pair the kernel could not do makes the whole part
                # pair unanswerable: a partial sum would understate the overlap
                # and read like a verdict.
                problems.append(
                    f"cannot test {names[i]!r} against {names[j]!r}: the "
                    f"intersection failed ({type(failure).__name__}: {failure}). "
                    "Check that pair by eye."
                )
                continue

            # Recorded whether it is a problem or not -- see _INTERFERENCE.
            _INTERFERENCE["|".join(sorted((names[i], names[j])))] = volume
            if volume > tol:
                box = _hull(region)
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

    A part may be several bodies; the faces of all of them are examined
    together, so a joint carried by the second body counts exactly like one on
    the first.

    Returns a list of problem strings.
    """
    # EVERY BODY, and the faces of all of them pooled: a part is often several
    # bodies and the joint does not have to be on the first. Judging one body
    # gave a false RED, which is the worse direction -- measured on cadquery
    # 2.8.0, a two-body part whose second body carries the face at z=2 was told
    # "there is no flat mating face there at all".
    problems = []
    flat_area = 0.0
    seen_faces = 0

    for face in [f for shape in _shapes(part, name) for f in shape.Faces()]:
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

    The probe comes from `material_at`, so this inherits both of its rules:
    every body of a Workplane is probed rather than the first, and a part with
    no solid left in it is refused instead of answering "material" everywhere.

    Returns a list of problem strings.
    """
    # Validated here as well as inside material_at below, and the point is the
    # ORDER: this is plain Python, the classifier needs the native kernel, and a
    # bad argument has to answer about the argument on a machine that has no
    # OpenCASCADE (the same reason material_at checks its type before importing
    # OCP). Nothing is kept -- the probe is built from `part` itself further
    # down, because collapsing it to one body here is the defect this call fixed.
    _shapes(part, name)

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

    inside = material_at(part, name)
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
