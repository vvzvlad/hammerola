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

Every test here needs the CAD kernel and skips without it, so in CI (a
python:3.11-slim container with no OCCT) this file contributes nothing. That is
the same trade `tests/test_template.py` makes and it is worth stating: what
holds these on a workstation is the pair below, and what holds them in CI is
nothing at all.
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
    in the code. CI caught it by going red on the test above, in the
    python:3.11-slim container the suite runs in. On a workstation with the
    kernel installed neither test can see the difference, which is why the
    import is blocked here rather than assumed absent.
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
