"""The two checks that used to judge a part by its FIRST body only.

`pairwise_interference` and `mating_face_flat` both went through a helper that
returned `Workplane.val()`, excused by the line "fine where one body is all
there can be (a printable is one part)". Neither of them takes printables: the
first takes the parts as assembled, the second takes whatever a model hands it,
and a part is several bodies as soon as anything is `.add()`ed or a helper
returns an assembly. Measured on cadquery 2.8.0, before the change:

  * an object whose bodies sit at X -5..5 and X 25..35 has a `val()` bounding
    box of -5..5, so a neighbour overlapping the SECOND body by 800.00 mm3 was
    rejected by the cheap box test and never intersected -- `[]`, no problem
    reported;
  * a two-body part whose joint face lies on the second body was told "there is
    no flat mating face there at all" -- a false RED, which is the direction
    that wastes somebody's afternoon.

Both failures are silent in the sense that matters: nothing about the result
says a body was skipped. So the tests below are written to fail on the old
implementation rather than to describe the new one.

Needs the CAD kernel and skips without it, like test_material_at.py. CI's test
image carries the kernel's libraries (issue #27), so this runs there.
"""

import re

import pytest

from src.cadbuild import checklib


@pytest.fixture(autouse=True)
def clean_record():
    """`pairwise_interference` accumulates into a module dict, so clear it.

    Both ends, like the identical fixture in test_checklib.py: the conftest
    guard asserts the same accumulator is empty before and after every test in
    this directory, and the volumes measured here would otherwise turn up in
    some later test's metrics.
    """
    checklib._INTERFERENCE.clear()
    yield
    checklib._INTERFERENCE.clear()


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so nothing "
               "here can be intersected -- see this module's docstring")


def _two_bodies_apart():
    """One object, bodies at X -5..5 and X 25..35. `val()` is the first."""
    cq = _cq()
    return (cq.Workplane().box(10, 10, 10)
            .add(cq.Workplane().box(10, 10, 10).translate((30, 0, 0))))


# --------------------------------------------------------------------------
# pairwise_interference
# --------------------------------------------------------------------------

def test_an_overlap_with_the_second_body_is_found():
    """The 800.00 mm3 the first-body version reported nothing about."""
    cq = _cq()
    a = _two_bodies_apart()
    b = cq.Workplane().box(10, 10, 10).translate((32, 0, 0))

    problems = checklib.pairwise_interference([a, b], ["A", "B"])

    assert len(problems) == 1, problems
    assert "'A' and 'B' share 800.00 mm3" in problems[0], problems[0]


def test_the_cheap_box_reject_does_not_hide_the_second_body():
    """The prefilter is where the miss actually happened, so it gets its own.

    `val().BoundingBox()` of that object is X -5..5 and the neighbour starts at
    27, so the pair was discarded before any boolean ran. A hull over every body
    can only ever be too generous, never too tight.
    """
    cq = _cq()
    a = _two_bodies_apart()
    first_box = a.val().BoundingBox()
    neighbour = cq.Workplane().box(10, 10, 10).translate((32, 0, 0))
    assert first_box.xmax < neighbour.val().BoundingBox().xmin, (
        "the premise: the first body's box does not reach the neighbour at all")

    assert checklib.pairwise_interference([a, neighbour], ["A", "B"]) != []


def test_the_recorded_volume_is_the_sum_over_every_body_pair():
    """Two bodies of one part overlapping one body of another add up.

    Recorded as well as reported, because `recorded_interference` is what
    `metrics` publishes -- a number short by a body is worse than a missing one.
    """
    cq = _cq()
    # Bodies at X -5..5 and X 7..17, both spanning Z -5..5.
    a = (cq.Workplane().box(10, 10, 10)
         .add(cq.Workplane().box(10, 10, 10).translate((12, 0, 0))))
    # A slab lying across both of them: X -9..21, Y -5..5, Z 3..5.
    b = cq.Workplane().box(30, 10, 2).translate((6, 0, 4))

    checklib.pairwise_interference([a, b], ["A", "B"])
    recorded = checklib.recorded_interference()

    assert set(recorded) == {"A|B"}
    # 10 x 10 x 2 out of each body. One body alone would give exactly half,
    # which is the number the first-body version would have recorded.
    per_body = 10 * 10 * 2
    assert recorded["A|B"] == pytest.approx(2 * per_body, rel=1e-6)


def test_parts_that_are_genuinely_apart_still_pass():
    """The fix must not have made the check answer yes to everything."""
    cq = _cq()
    a = _two_bodies_apart()
    b = cq.Workplane().box(10, 10, 10).translate((200, 0, 0))

    assert checklib.pairwise_interference([a, b], ["A", "B"]) == []
    assert checklib.recorded_interference() == {}, (
        "nothing was intersected, so nothing should have been recorded")


def test_a_touching_pair_is_not_an_overlap():
    """Face to face is zero volume, and stays zero over several bodies."""
    cq = _cq()
    a = _two_bodies_apart()
    b = cq.Workplane().box(10, 10, 10).translate((40, 0, 0))

    assert checklib.pairwise_interference([a, b], ["A", "B"]) == []


# --------------------------------------------------------------------------
# mating_face_flat
# --------------------------------------------------------------------------

def test_a_joint_on_the_second_body_is_found():
    """The false red: the face is there, on the body `val()` does not return."""
    cq = _cq()
    part = (cq.Workplane().box(10, 10, 10)
            .add(cq.Workplane().box(10, 10, 4).translate((30, 0, 0))))
    first_only = part.val().BoundingBox()
    assert first_only.zmax > 2, (
        "the premise: the first body has nothing lying in the plane z=2")

    assert checklib.mating_face_flat(part, 2, name="part") == []


def test_a_bevel_on_the_second_body_is_still_reported():
    """The other direction: finding the face must not have blinded the check.

    A chamfer on the second body's joint edge is exactly the mistake this
    function exists for, and it has to be reported by name from there too.
    """
    cq = _cq()
    bevelled = (cq.Workplane().box(10, 10, 4)
                .edges("<Z").chamfer(0.6)
                .translate((30, 0, 0)))
    part = cq.Workplane().box(10, 10, 10).add(bevelled.val())

    problems = checklib.mating_face_flat(part, -2, name="part")

    # One per chamfered edge -- the count is not the point and is not pinned.
    assert problems, "a bevel eating the joint has to be reported from any body"
    assert all("the mating face at z=-2 is cut by a" in p for p in problems)
    reported_x = [float(m.group(1)) for m in
                  (re.search(r"\((-?[\d.]+), -?[\d.]+\) that leaves", p)
                   for p in problems) if m]
    assert len(reported_x) == len(problems), problems
    assert all(24.0 < x < 36.0 for x in reported_x), (
        f"every reported point should sit on the SECOND body (X 25..35): "
        f"{reported_x}")


def test_a_part_with_no_face_at_the_plane_is_still_reported():
    """The "nothing lies in the plane" branch has to survive the change."""
    cq = _cq()
    part = _two_bodies_apart()

    problems = checklib.mating_face_flat(part, 100, name="part")

    assert len(problems) == 1, problems
    assert "there is no flat mating face there at all" in problems[0]
