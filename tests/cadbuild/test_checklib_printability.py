"""The two printability checks that ask about ASSEMBLY rather than about shape.

`tool_access` asks whether a screwdriver can reach a screw that is already
modelled, seated and dimensioned correctly; `swept_clearance` asks whether a
lid that fits where it ends up can get there at all. Both catch a part that is
right in every view of the assembled thing, which is why neither of them can be
written as a check of the assembled position -- `pairwise_interference` looks
at exactly that position and calls both defects clean.

The file is in two halves, and the split is the same one `test_checklib.py` and
`test_material_at.py` make between them. The refusals are plain Python and run
everywhere, CI included: a size that is not a size, a sweep of one position, an
exemption for a part that is not in the assembly, an argument that is not
geometry. The measurements need the CAD kernel and skip without it, so in CI
(a python:3.11-slim container with no OCCT) that half contributes nothing.

The geometry the second half runs on is built here rather than fetched: a
socket with a narrow mouth over a wider cavity, and a lid whose head has to
pass through the mouth to reach it. A head 0.1 mm under the mouth passes; a
head 0.3 mm wider than that does not -- and it sits in the cavity, clear of
everything, once it is through. That is the defect these tests exist for, and
it is invisible from the assembled position.
"""

import pytest

import checklib as top_level
from src.cadbuild import checklib


@pytest.fixture(autouse=True)
def clean_record():
    """The sweep's accumulator, both ends -- the conftest guard checks the same."""
    checklib._CLEARANCE.clear()
    yield
    checklib._CLEARANCE.clear()


def _cq():
    return pytest.importorskip(
        "cadquery", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so neither "
               "a point probe nor a boolean can be built -- see this module's "
               "docstring")


# --------------------------------------------------------------------------
# The plain-Python half -- no kernel needed, so this is what CI actually runs
# --------------------------------------------------------------------------

def test_minimum_feature_is_the_nozzle_laid_down_twice():
    assert checklib.minimum_feature() == pytest.approx(0.8)
    assert checklib.minimum_feature(nozzle_mm=0.6) == pytest.approx(1.2)
    assert checklib.minimum_feature(nozzle_mm=0.4, lines=3) == pytest.approx(1.2)


def test_the_axial_step_is_under_the_thinnest_wall_this_nozzle_prints():
    """Why `tool_access` samples along the path every half millimetre.

    An obstruction ACROSS the path is seen only if it is at least one step
    thick, so the step is chosen under the thinnest wall this nozzle can lay
    down: a wall a model may legitimately have cannot fall between two levels.
    A wider nozzle would want a shorter step, and this is what says so -- in
    the file rather than in the comment at the step itself.
    """
    assert checklib.minimum_feature() > 0.5


def test_tool_access_refuses_a_sampling_that_probes_nothing():
    """Zero rings or zero points around buys the same silence a zero diameter does."""
    with pytest.raises(ValueError, match="rings is 0"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 1),
                             diameter=8, length=20, rings=0)
    with pytest.raises(ValueError, match="around is 0"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 1),
                             diameter=8, length=20, around=0)


def test_tool_access_refuses_a_direction_that_is_not_a_direction():
    """Unguarded this divides by zero somewhere inside checklib instead."""
    with pytest.raises(ValueError, match="direction"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 0),
                             diameter=8, length=20)


def test_tool_access_refuses_a_diameter_of_zero():
    with pytest.raises(ValueError, match="diameter"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 1),
                             diameter=0, length=20)


def test_tool_access_refuses_a_negative_length():
    with pytest.raises(ValueError, match="length"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 1),
                             diameter=8, length=-20)


def test_tool_access_refuses_an_exemption_for_a_part_that_is_not_there():
    """An ignored name nobody handed in is a typo, and it exempts nothing."""
    with pytest.raises(ValueError, match="wal"):
        checklib.tool_access([], [], origin=(0, 0, 0), direction=(0, 0, 1),
                             diameter=8, length=20, ignore=("wal",))


def test_tool_access_refuses_something_that_is_not_geometry():
    with pytest.raises(TypeError, match="obstacle #0"):
        checklib.tool_access(["not a solid"], ["wall"], origin=(0, 0, 0),
                             direction=(0, 0, 1), diameter=8, length=20)


def test_swept_clearance_refuses_a_sweep_of_one_position():
    """One position is the assembled state, which another check already sees."""
    with pytest.raises(ValueError, match="1 position"):
        checklib.swept_clearance(["only the assembled one"], "body")


def test_swept_clearance_refuses_something_that_is_not_geometry():
    with pytest.raises(TypeError, match="position #0"):
        checklib.swept_clearance(["not a solid", "nor this one"], "body")


def test_the_clearance_record_starts_empty():
    assert checklib.recorded_clearance() == {}


def test_the_clearance_record_is_a_copy_callers_cannot_corrupt():
    """Both levels of it: the values here are dicts, not the floats next door."""
    checklib._CLEARANCE["lid|body"] = {"positions": 18, "min_gap_mm": 0.4,
                                       "at": 5}
    taken = checklib.recorded_clearance()
    taken["lid|body"]["min_gap_mm"] = 99.0
    taken["hinge|body"] = {"positions": 2, "min_gap_mm": 0.0, "at": 0}
    assert checklib.recorded_clearance() == {
        "lid|body": {"positions": 18, "min_gap_mm": 0.4, "at": 5}}


def test_the_clearance_record_is_shared_between_the_two_names():
    """A model writes it through `import checklib` and the package half reads it
    back, so two module objects would mean two records -- the failure
    `_INTERFERENCE` already had and this shim exists to prevent."""
    checklib._CLEARANCE["lid|body"] = {"positions": 18, "min_gap_mm": 0.4,
                                       "at": 5}
    assert top_level.recorded_clearance() == {
        "lid|body": {"positions": 18, "min_gap_mm": 0.4, "at": 5}}


# --------------------------------------------------------------------------
# The measurements -- these need the kernel
# --------------------------------------------------------------------------

def _plate():
    """A plate with a screw seat in the middle of its top face, at z = 10."""
    cq = _cq()
    return cq.Workplane("XY").box(40, 40, 10, centered=(True, True, False))


def _wall():
    """A wall standing 2 mm from the axis of the seat and 20 mm up past it."""
    cq = _cq()
    return (cq.Workplane("XY").box(4, 40, 20, centered=(True, True, False))
            .translate((4, 0, 10)))


def _lid_across(centre, thickness=2.0):
    """A plate lying ACROSS the path, centred at that height above the seat."""
    cq = _cq()
    return cq.Workplane("XY").box(40, 40, thickness).translate((0, 0, centre))


def _socket():
    """A box with a narrow mouth over a wider cavity.

    The mouth is 10 mm square and the cavity below it 11 mm, so a head under
    10 mm passes through and reaches a place where nothing is near it -- which
    is what makes the assembled position useless as evidence.
    """
    cq = _cq()
    outer = cq.Workplane("XY").box(20, 20, 12, centered=(True, True, False))
    cavity = (cq.Workplane("XY").box(11, 11, 8, centered=(True, True, False))
              .translate((0, 0, 2)))
    mouth = (cq.Workplane("XY").box(10, 10, 4, centered=(True, True, False))
             .translate((0, 0, 10)))
    return outer.cut(cavity).cut(mouth)


def _lid(head, offset):
    """The lid at one stop: a plate, a stem through the mouth, a head under it.

    `head` is how wide the head is -- the one dimension that decides whether
    the thing can be assembled -- and `offset` how far above the assembled
    position this stop sits.
    """
    cq = _cq()
    plate = (cq.Workplane("XY").box(20, 20, 2, centered=(True, True, False))
             .translate((0, 0, 12)))
    stem = (cq.Workplane("XY").box(9, 9, 4, centered=(True, True, False))
            .translate((0, 0, 8)))
    bead = (cq.Workplane("XY").box(head, head, 4, centered=(True, True, False))
            .translate((0, 0, 4)))
    return plate.union(stem).union(bead).translate((0, 0, offset))


def _sweep(head, stops=18):
    """The lid lowered onto the socket, from 10.5 mm up to assembled.

    The last stop leaves the plate 0.5 mm above the socket's top face -- the
    lid hangs on its bead down in the cavity rather than on the plate -- so the
    tightest gap along the travel is the one at the mouth and not an artefact
    of two faces landing on each other.
    """
    return [_lid(head, 0.5 + 10.0 * (stops - 1 - i) / (stops - 1))
            for i in range(stops)]


def test_a_screw_at_a_wall_cannot_be_reached_and_the_wall_is_named():
    problems = checklib.tool_access(
        [_wall()], ["wall"], origin=(0, 0, 10), direction=(0, 0, 1),
        diameter=8, length=20)
    assert len(problems) == 1
    assert "'wall'" in problems[0]


def test_the_same_screw_moved_away_from_the_wall_is_clean():
    """The check has to be able to say yes, or the one above proves nothing."""
    assert checklib.tool_access(
        [_wall()], ["wall"], origin=(-15, 0, 10), direction=(0, 0, 1),
        diameter=8, length=20) == []


def test_a_part_named_in_ignore_is_not_in_the_way():
    """The screw goes in before that part does, so the path through it counts."""
    assert checklib.tool_access(
        [_wall()], ["wall"], origin=(0, 0, 10), direction=(0, 0, 1),
        diameter=8, length=20, ignore=("wall",)) == []


def test_a_lid_across_the_path_is_seen_wherever_along_it_the_lid_sits():
    """The AXIAL spacing, which nothing else in this file exercises.

    `_wall()` runs parallel to the tool, so it is present at every level and any
    spacing at all finds it; a lid is present at one level or at none. These
    four heights are ones the axial step walked straight over while it was tied
    to the tool's radius rather than being a length.
    """
    for centre in (2.5, 6.0, 11.5, 14.0):
        problems = checklib.tool_access(
            [_lid_across(centre)], ["lid"], origin=(0, 0, 0),
            direction=(0, 0, 1), diameter=8, length=20)
        assert len(problems) == 1, f"the lid at z={centre} was walked over"
        assert "'lid'" in problems[0]


def test_a_thin_blade_across_the_path_pins_the_axial_step():
    """The NUMBER, which the lid above does not hold.

    A 2 mm lid is found at every height by any step up to about 1.9 mm, so that
    test would stay green on a step four times the current one. A blade of
    0.6 mm -- under `minimum_feature()`, so under anything the check undertakes
    to see -- is found at these eight heights and only these steps: the current
    one, and nothing longer than 0.65 mm. Lengthening the step therefore fails
    here rather than silently widening the gap the docstring describes.
    """
    for centre in (0.7, 3.3, 5.1, 7.7, 9.4, 13.6, 17.2, 19.3):
        problems = checklib.tool_access(
            [_lid_across(centre, thickness=0.6)], ["blade"], origin=(0, 0, 0),
            direction=(0, 0, 1), diameter=8, length=20)
        assert len(problems) == 1, f"the 0.6 mm blade at z={centre} was missed"


def test_a_lid_that_fits_through_the_mouth_clears_every_stop():
    problems = checklib.swept_clearance(_sweep(9.9), _socket(),
                                        names=("lid", "body"))
    assert problems == []
    record = checklib.recorded_clearance()
    assert set(record) == {"lid|body"}
    assert record["lid|body"]["positions"] == 18
    # Half of what the head is under the mouth: 9.9 mm through 10 mm.
    assert record["lid|body"]["min_gap_mm"] == pytest.approx(0.05, abs=1e-6)
    assert 0 <= record["lid|body"]["at"] < 18


def test_a_gap_under_min_gap_is_a_problem_and_the_same_sweep_without_one_is_not():
    problems = checklib.swept_clearance(_sweep(9.9), _socket(),
                                        names=("lid", "body"), min_gap=0.2)
    assert len(problems) == 1
    assert "0.05 mm" in problems[0]


def test_a_lid_three_tenths_wider_fouls_in_the_middle_of_the_travel():
    """The defect this check exists for: it is clean where it ends up.

    Nothing that looks at the assembled position can see this -- and that is
    asserted here rather than described, because it is the whole argument for
    the function.
    """
    stops = _sweep(10.2)
    body = _socket()
    assert checklib.is_empty(stops[-1].intersect(body)), (
        "the wide lid is supposed to be clear once it is seated; without that "
        "this test would be about an ordinary interference")

    problems = checklib.swept_clearance(stops, body, names=("lid", "body"))
    fouled = [p for p in problems if "runs into" in p]
    assert fouled, problems
    assert all("'lid'" in p and "'body'" in p for p in fouled)
    assert not any(f"position {len(stops) - 1} of" in p for p in fouled), (
        "the assembled position is clear -- a problem reported there means the "
        "geometry, not the sweep, is what this test caught")
