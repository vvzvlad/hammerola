"""`checklib.material_at` -- the fast way to ask "is there material here".

The question a model asks a few hundred times per build: probe a channel along
its length, sample a grid over a seat, confirm a boss is solid where a screw
lands. There are two ways to answer it and they differ by three orders of
magnitude -- a boolean against a small cube, or a point classifier.

WHAT IS PROVED HERE IS NOT "they are the same". It is the pair of facts a
migration needs: away from surfaces they agree exactly, and within reach of the
cube they do not, because a cube asks about a NEIGHBOURHOOD and a classifier
asks about a POINT. The first test alone would be a comfortable half-truth --
it was written that way first, with a point 0.2 mm off a fillet in the list,
and it went red. That red is now the second test.

THE SECOND SUBJECT HERE IS WHAT THE PROBE REFUSES TO ANSWER ABOUT, and it is
the same question asked from the other end: a body that a boolean emptied is
still an object, still truthy, and a classifier built on it says IN at every
point in the universe. Every `assert solid(...)` in every model then passes. So
`material_at` refuses such a part, `volume`/`is_empty` are how a model asks
whether anything survived, and the tests for all three are below.

Every test here needs the CAD kernel and skips without it. The image CI runs the
suite in carries it (issue #27), so this file contributes there too; on a machine
with no kernel it contributes nothing, and what holds these there is the pair below.
"""

import sys

import pytest

import checklib as top_level
from src.cadbuild import checklib


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so a point "
               "probe cannot be built -- see this module's docstring")


def _slow_probe(part, point, side=0.6):
    """The boolean a model would otherwise write. The thing being replaced.

    Kept here deliberately rather than described: the equivalence claim is only
    worth anything if the slow side is the code people actually write, and the
    only way to keep that true is to run it.
    """
    cq = _cq()
    cube = cq.Workplane("XY").box(side, side, side).translate(point)
    common = part.val().intersect(cube.val())
    return sum(solid.Volume() for solid in common.Solids()) > 0


def test_a_point_inside_the_part_is_material():
    cq = _cq()
    box = cq.Workplane("XY").box(20, 20, 10)
    probe = checklib.material_at(box)
    assert probe(0, 0, 0) is True


def test_a_point_outside_the_part_is_not():
    cq = _cq()
    box = cq.Workplane("XY").box(20, 20, 10)
    probe = checklib.material_at(box)
    assert probe(50, 0, 0) is False


def test_a_point_in_a_hole_is_not_material():
    """The case the probe exists for: material removed, not material absent.

    A bounding box says yes here and so does any test that reasons about
    extents -- the point is inside the part's envelope and outside its solid.
    """
    cq = _cq()
    plate = (cq.Workplane("XY").box(30, 30, 6)
             .faces(">Z").workplane().hole(8))
    probe = checklib.material_at(plate)
    assert probe(0, 0, 0) is False, "the bore should read as empty"
    assert probe(12, 12, 0) is True, "the corner should read as solid"


def _part():
    cq = _cq()
    return (cq.Workplane("XY").box(30, 20, 10)
            .faces(">Z").workplane().hole(6)
            .edges("|Z").fillet(2))


def test_it_agrees_with_the_boolean_it_replaces_away_from_surfaces():
    """The equivalence, where the equivalence holds.

    This is the argument for the function: being fast costs nothing in
    correctness, PROVIDED the points are not sitting on a boundary. Every point
    below is at least 1 mm from any face -- comfortably outside the 0.3 mm
    reach of the cube the slow probe uses -- and there the two answer alike.

    The next test is the other half, and the two are only worth anything
    together: this one alone would read as "they are the same thing".
    """
    part = _part()
    probe = checklib.material_at(part)

    points = [(0, 0, 0), (0, 0, 4), (10, 6, 0), (13, 8, 0),
              (2, 0, 0), (4, 0, 0), (0, 0, 6), (-10, -6, -4),
              (20, 0, 0), (0, 0, -4), (7, 0, 2), (0, 0, 20)]
    fast = [probe(*p) for p in points]
    slow = [_slow_probe(part, p) for p in points]
    assert fast == slow, (
        "the classifier and the boolean disagree at "
        f"{[p for p, a, b in zip(points, fast, slow) if a != b]}")
    # A test where every point answered the same way would pass on a probe that
    # returns a constant.
    assert True in fast and False in fast, "the points do not exercise both answers"


def test_near_a_face_the_cube_says_material_and_the_point_does_not():
    """They are NOT the same question, and this is where a migration breaks.

    A 0.6 mm cube reaches 0.3 mm in every direction, so it reports material for
    a point that is up to that far OUTSIDE the part. A check written as "is
    there material right against this face" with a cube is really asking about
    a neighbourhood, and porting its points to a true point probe flips exactly
    the answers it was built on -- silently, into a check that now passes for a
    different reason or fails for none.

    Pinned with a concrete point rather than described, because the tempting
    reading of the previous test is that the two are interchangeable.
    """
    part = _part()
    probe = checklib.material_at(part)
    # The vertical edges carry a 2 mm fillet, so this corner point is off the
    # solid -- but within reach of a cube centred on it.
    near_corner = (14.6, 9.6, 0)

    assert probe(*near_corner) is False, "the point itself is outside the part"
    assert _slow_probe(part, near_corner) is True, (
        "the cube should still catch material near this point -- if it does "
        "not, this test no longer demonstrates the difference it is here for")


def test_a_probe_answers_about_the_part_it_was_taken_from():
    """It is bound to the shape at the moment it was asked for.

    Documented, and worth a test because the failure is silent: a probe kept
    across a rebuild goes on answering about the old geometry, and a check
    written on it certifies a part that is no longer there.
    """
    cq = _cq()
    solid = cq.Workplane("XY").box(20, 20, 10)
    probe = checklib.material_at(solid)
    drilled = solid.faces(">Z").workplane().hole(8)

    assert probe(0, 0, 0) is True, "the old probe still describes the old part"
    assert checklib.material_at(drilled)(0, 0, 0) is False


def test_something_that_is_not_geometry_is_refused_by_name():
    with pytest.raises(TypeError, match="lid"):
        checklib.material_at("not a solid", name="lid")


def test_the_refusal_does_not_need_the_cad_kernel(monkeypatch):
    """A bad argument answers TypeError even where OpenCASCADE is absent.

    Note what this test does NOT do: call `_cq()`. It runs everywhere, and it
    has to, because the machine without the kernel is the case it is about.

    The first version of `material_at` imported OCP at the top of the function,
    before looking at its argument, so passing a string answered
    `ImportError: libGL.so.1` -- an error about the environment for a mistake
    in the code. CI caught it by going red on the test above, back when its
    container had no importable kernel at all. Where the kernel IS installed
    neither test can see the difference, which is why the import is blocked here
    rather than assumed absent -- and since issue #27 that includes CI.
    """
    for name in ("OCP", "OCP.BRepClass3d", "OCP.gp", "OCP.TopAbs"):
        monkeypatch.setitem(sys.modules, name, None)

    with pytest.raises(TypeError, match="lid"):
        checklib.material_at("not a solid", name="lid")


def test_a_model_reaches_it_under_the_top_level_name():
    """`import checklib` is the contract; the package path is not.

    The derived re-export check in test_checklib.py covers this for every
    public name at once. It is asserted again here, on the object, because
    this is the one a model is being told to use.
    """
    assert top_level.material_at is checklib.material_at


# --------------------------------------------------------------------------
# A part that a boolean emptied
# --------------------------------------------------------------------------

def _emptied():
    """A Workplane a boolean left with nothing in it.

    Two boxes that do not meet, intersected. What comes back is NOT an empty
    stack -- `.vals()` is a list of one Compound with no solids in it, which is
    the whole trap: it is truthy, it has a length, and only its volume says the
    material is gone.
    """
    cq = _cq()
    return (cq.Workplane().box(10, 10, 10)
            .intersect(cq.Workplane().box(1, 1, 1).translate((100, 0, 0))))


def test_an_emptied_body_still_looks_like_geometry():
    """The premise every assertion below rests on, pinned rather than assumed.

    If a future cadquery makes this an empty stack, or raises instead, the
    refusals below stop being about the thing they were written for -- and this
    test is what says so, instead of them silently guarding nothing.
    """
    emptied = _emptied()
    bodies = emptied.vals()
    assert len(bodies) == 1, "still one object on the stack"
    assert bool(bodies) is True, "`assert wp.vals()` cannot fail on this"
    assert bodies[0].Solids() == [], "and there is no solid inside it"


def test_the_classifier_on_an_emptied_body_would_say_material_everywhere():
    """WHY the refusal exists, measured rather than described.

    This is the failure being prevented: built the old way, the probe answers
    IN at every point handed to it -- inside the part that is gone, a metre
    away, fifty metres away -- so every `assert solid(...)` in a model passes
    and the build certifies a part that is not there.
    """
    cq = _cq()
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    classifier = BRepClass3d_SolidClassifier(_emptied().val().wrapped)
    for point in [(0, 0, 0), (1000, 1000, 1000), (-50000, 30000, 7000)]:
        classifier.Perform(gp_Pnt(*[float(x) for x in point]), 1e-7)
        assert classifier.State() != TopAbs_OUT, (
            f"{point} reads as material on a body with no solid in it -- if "
            "this ever stops being true, the refusal in material_at is "
            "guarding against something that no longer happens")


def test_a_part_with_no_solid_left_is_refused():
    with pytest.raises(ValueError) as exc:
        checklib.material_at(_emptied(), name="bracket")
    assert "bracket" in str(exc.value)


def test_the_refusal_names_both_ways_of_being_fooled():
    """The message is the whole value of the refusal: it has to send the reader
    to the boolean that came back empty, and say why neither the classifier nor
    a second intersection would have told them."""
    with pytest.raises(ValueError) as exc:
        checklib.material_at(_emptied())
    message = str(exc.value)
    assert "IN at EVERY point" in message
    assert "findSolid(searchParents=True)" in message and "PREVIOUS" in message


def test_an_empty_stack_gets_its_own_message_and_not_the_emptied_bodys():
    """Two different empties, and one sentence cannot be true about both.

    A Workplane whose stack is empty has no body at all, so the long
    explanation -- "`.vals()` is still a list holding one Compound, so it is
    still truthy" -- is simply false about it: `.vals()` is `[]`. The message
    for it says what is actually the matter instead.
    """
    cq = _cq()
    empty = cq.Workplane()
    assert empty.vals() == [], "the premise: nothing on the stack at all"

    with pytest.raises(ValueError) as exc:
        checklib.material_at(empty, name="bracket")
    message = str(exc.value)

    assert "bracket" in message
    assert "nothing here at all" in message and "`.vals()` is empty" in message
    assert "holding one Compound" not in message, (
        "that describes the OTHER empty, and it is not true of this one")


def test_an_intersection_with_an_emptied_body_answers_for_its_old_self():
    """The second trap, measured: 64.00 mm3 out of a 4 mm cube -- all of it.

    `Workplane.intersect` resolves its operand with findSolid(searchParents=
    True), which walks back up the chain to the solid that was there BEFORE the
    boolean emptied it. So the obvious way of double-checking an empty part
    reports the part that is gone. `Shape.intersect`, one level down, raises
    instead -- which is the loud behaviour and the reason the refusal in
    material_at is worth having at the level a model works at.
    """
    cq = _cq()
    emptied = _emptied()
    probe = cq.Workplane().box(4, 4, 4)

    common = emptied.intersect(probe)
    measured = sum(solid.Volume()
                   for body in common.vals() for solid in body.Solids())
    assert measured == pytest.approx(4 * 4 * 4, rel=1e-6), (
        "the whole probe cube came back as shared volume, i.e. the answer is "
        "about the 10 mm box that was there before the boolean")
    with pytest.raises(ValueError):
        emptied.val().intersect(probe.val())


def test_material_under_head_inherits_the_refusal():
    """It builds its probe with material_at, so the empty part stops here too --
    rather than reporting a screw seat on a part that does not exist."""
    with pytest.raises(ValueError):
        checklib.material_under_head(_emptied(), (0, 0, 5), 8.0, 3.0)


# --------------------------------------------------------------------------
# Every body, not the first one
# --------------------------------------------------------------------------

def test_the_probe_covers_every_body_of_a_workplane():
    """`.add()` puts several bodies on the stack and `val()` is the first.

    Measured before the fix: a classifier built on `val()` answers OUT at the
    centre of the second box. That is a check quietly asking about one part of
    an assembly it was handed whole.
    """
    cq = _cq()
    both = (cq.Workplane().box(10, 10, 10)
            .add(cq.Workplane().box(10, 10, 10).translate((50, 0, 0))))
    assert len(both.vals()) == 2, "the premise: two bodies on the stack"

    probe = checklib.material_at(both)
    assert probe(0, 0, 0) is True, "inside the first body"
    assert probe(50, 0, 0) is True, "inside the SECOND body -- the whole point"
    assert probe(25, 0, 0) is False, "the gap between them is not material"
    assert probe(500, 0, 0) is False, "and neither is anywhere else"

    # The old way, kept next to it: without this line the test above would pass
    # on any implementation that happened to be generous.
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    first_only = BRepClass3d_SolidClassifier(both.val().wrapped)
    first_only.Perform(gp_Pnt(50.0, 0.0, 0.0), 1e-7)
    assert first_only.State() == TopAbs_OUT, (
        "the first body alone does not contain the centre of the second -- if "
        "it did, this test would not be demonstrating anything")


def test_a_compound_is_probed_whole():
    """A Compound is one object holding several solids, and it works as it did
    -- the fix must not have turned it into "the first solid of it"."""
    cq = _cq()
    from cadquery.occ_impl.shapes import Compound

    compound = Compound.makeCompound([
        cq.Workplane().box(10, 10, 10).val(),
        cq.Workplane().box(10, 10, 10).translate((50, 0, 0)).val(),
    ])
    probe = checklib.material_at(compound)
    assert [probe(0, 0, 0), probe(50, 0, 0), probe(25, 0, 0)] == [True, True, False]


# The two configurations above and below are not the same test twice. BODIES
# 50 mm APART ARE THE ONE ARRANGEMENT A COMPOUND CLASSIFIER GETS RIGHT, so a
# suite made only of those passes on an implementation that is wrong for every
# part anybody actually builds. These two are what a classifier over
# `Compound.makeCompound(solids)` fails.

def test_the_probe_is_right_where_two_bodies_TOUCH():
    """Face to face -- an insert seated in its pocket, a lid on its rim.

    Measured on cadquery 2.8.0: one classifier over a compound of the two
    answers "no material" at (7, 0, 0), (10, 0, 0) and (12, 0, 0), every one of
    which is inside the second box. BRepClass3d_SolidClassifier is documented
    for a SOLID; over a compound the nearest face decides, whichever solid owns
    it.
    """
    cq = _cq()
    touching = (cq.Workplane().box(10, 10, 10)
                .add(cq.Workplane().box(10, 10, 10).translate((10, 0, 0))))
    assert len(touching.vals()) == 2, "the premise: two bodies, sharing a face"

    probe = checklib.material_at(touching)
    assert probe(0, 0, 0) is True, "the middle of the first body"
    assert probe(7, 0, 0) is True, "inside the second body, near the shared face"
    assert probe(10, 0, 0) is True, "the middle of the second body"
    assert probe(12, 0, 0) is True, "inside the second body, near its far face"
    assert probe(30, 0, 0) is False, "and outside is still outside"


def test_the_probe_is_right_where_one_body_is_INSIDE_another():
    """A part with an insert added into it -- and the case that made the
    compound worse than what it replaced.

    Measured: over a compound of the two, (4, 0, 0) and (8, 0, 0) read as no
    material, though both are well inside the 20 mm box. A classifier built the
    OLD way, on `val()`, answers correctly here -- so a compound would have been
    a regression, not a partial fix, for any model that added an insert.
    """
    cq = _cq()
    nested = (cq.Workplane().box(20, 20, 20)
              .add(cq.Workplane().box(2, 2, 2)))
    assert len(nested.vals()) == 2, "the premise: a small body inside a big one"

    probe = checklib.material_at(nested)
    assert probe(0, 0, 0) is True, "inside both bodies at once"
    assert probe(0.5, 0, 0) is True, "inside the small body, off centre"
    assert probe(4, 0, 0) is True, "in the big body, outside the small one"
    assert probe(8, 0, 0) is True, "in the big body, close to its wall"
    assert probe(30, 0, 0) is False, "outside both"


def test_a_tiny_cube_agrees_with_the_probe_on_both_arrangements():
    """An independent mechanism, because two classifiers can be wrong together.

    A 0.2 mm cube intersected body by body asks the same question through the
    booleans instead of through the classifier. It agreed with the probe on
    every point of both arrangements when this was measured; it is here so that
    a future change to how the probe is built has something to disagree with
    that is not built the same way.
    """
    cq = _cq()
    cases = [
        ((cq.Workplane().box(10, 10, 10)
          .add(cq.Workplane().box(10, 10, 10).translate((10, 0, 0)))),
         [((0, 0, 0), True), ((7, 0, 0), True), ((12, 0, 0), True),
          ((30, 0, 0), False)]),
        ((cq.Workplane().box(20, 20, 20).add(cq.Workplane().box(2, 2, 2))),
         [((4, 0, 0), True), ((8, 0, 0), True), ((30, 0, 0), False)]),
    ]
    for part, points in cases:
        probe = checklib.material_at(part)
        solids = [s for body in part.vals() for s in body.Solids()]
        for point, expected in points:
            cube = cq.Workplane().box(0.2, 0.2, 0.2).translate(point).val()
            by_boolean = any(
                sum(x.Volume() for x in solid.intersect(cube).Solids()) > 1e-9
                for solid in solids)
            assert probe(*point) is expected, f"probe at {point}"
            assert by_boolean is expected, f"the cube at {point}"


# --------------------------------------------------------------------------
# volume() / is_empty()
# --------------------------------------------------------------------------

def test_volume_is_what_tells_an_emptied_body_apart():
    """`assert wp.vals()` is the assert that cannot fail; this is the one that
    can. Both halves asserted together, because the first is the reason the
    second exists."""
    emptied = _emptied()
    assert bool(emptied.vals()) is True
    assert checklib.volume(emptied) == 0.0
    assert checklib.is_empty(emptied) is True


def test_a_bounding_box_is_not_an_alternative_way_to_ask():
    """The line the missing check used to stand over: reaching for extents on an
    emptied body dies with a message about a box."""
    with pytest.raises(Exception, match="Bnd_Box is void"):
        _emptied().val().BoundingBox()


def test_volume_counts_every_body_and_a_real_part_is_not_empty():
    cq = _cq()
    box = cq.Workplane().box(10, 10, 10)
    assert checklib.volume(box) == pytest.approx(1000.0)
    assert checklib.is_empty(box) is False

    both = box.add(cq.Workplane().box(10, 10, 10).translate((50, 0, 0)))
    assert checklib.volume(both) == pytest.approx(2000.0), (
        "the second body counts too -- `val()` would have answered 1000")


def test_volume_is_cubic_millimetres_even_when_there_is_nothing_to_add_up():
    """`sum([])` is the int 0, and this function documents cubic millimetres.

    A stray int is not a crash, which is why it is worth a test: it survives
    every comparison a check makes and only shows up somewhere far away -- in
    metrics.json as `0` beside a column of floats, or in a formatter that
    treats the two differently.
    """
    cq = _cq()
    measured = checklib.volume(cq.Workplane())
    assert measured == 0.0
    assert isinstance(measured, float), f"got {type(measured).__name__}"


def test_a_sliver_under_the_tolerance_counts_as_empty():
    """`tol` is the same boolean-noise floor pairwise_interference uses: what a
    boolean that nearly missed leaves behind is not material a check can rely
    on."""
    cq = _cq()
    # 1e-7 mm3 of overlap -- a tenth of DEFAULT_VOLUME_TOL, and every edge of
    # it still far above the kernel's own resolution, so what is being measured
    # is the tolerance rather than a degenerate solid.
    sliver = cq.Workplane().box(10, 10, 10).intersect(
        cq.Workplane().box(0.01, 0.01, 0.001).translate((0, 0, 4)))
    assert checklib.is_empty(sliver) is True
    assert checklib.is_empty(sliver, tol=0.0) is False, (
        "with no tolerance at all it is not empty, so the tolerance is what "
        "this test is about rather than an accident of the geometry")
