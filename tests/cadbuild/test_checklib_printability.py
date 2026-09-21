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
geometry. The measurements need the CAD kernel and skip without it; CI's test
container has it (issue #27), so both halves run there.

The geometry the second half runs on is built here rather than fetched: a
socket with a narrow mouth over a wider cavity, and a lid whose head has to
pass through the mouth to reach it. A head 0.1 mm under the mouth passes; a
head 0.3 mm wider than that does not -- and it sits in the cavity, clear of
everything, once it is through. That is the defect these tests exist for, and
it is invisible from the assembled position.
"""

import ast
import pathlib
import re

import pytest

import checklib as top_level
from src.cadbuild import checklib
from src.cadbuild.artifacts import STL_ANGULAR_TOLERANCE, STL_TOLERANCE


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


def test_thin_walls_refuses_a_minimum_no_run_can_be_under():
    """A check that passes for every part is worse than none (issue #55)."""
    for minimum in (0.0, -0.8):
        with pytest.raises(ValueError, match="min_thickness"):
            checklib.thin_walls("not geometry either", [0.0], minimum)


def test_thin_walls_refuses_a_step_that_does_not_divide_the_minimum():
    """The condition the one-sided error rests on, made an argument check.

    A run is counted in whole steps, so a wall of exactly the minimum is seen
    as `floor(min / step)` samples long -- which adds up to the minimum only
    when the division is whole. Measured before this refusal existed: a 0.8 mm
    wall at min_thickness 0.8 and step 0.3 was reported as 0.60 mm on 24 scan
    runs, the false red this check promises never to give.
    """
    with pytest.raises(ValueError, match="does not divide"):
        checklib.thin_walls("not geometry", [0.0], 0.8, step=0.3)


def test_thin_walls_refuses_a_step_that_leaves_one_division():
    """It divides cleanly and measures nothing, so it needs its own refusal.

    A run is counted in whole steps, so with one division no run can be under
    one -- the check returns nothing for every part there is, including a rib
    eight times under the minimum. That is the same failure the min_thickness
    refusal is named after (issue #55), reached by a different argument.
    """
    with pytest.raises(ValueError, match="the whole of min_thickness"):
        checklib.thin_walls("not geometry", [0.0], 0.8, step=0.8)


def test_thin_walls_takes_a_step_that_does_divide_it():
    """The refusal above has to let a whole division through, and the arithmetic
    is floating point: 0.8 / 4 is not exact, so a comparison against a rounded
    number of divisions is the only one that passes here. The call reaches the
    geometry and fails there instead, which is what proves the step was
    accepted."""
    with pytest.raises(TypeError, match="expected CadQuery geometry"):
        checklib.thin_walls("not geometry", [0.0], 0.8, step=0.2)


def test_thin_walls_refuses_an_axis_name_written_as_a_bare_string():
    """`axes="xy"` iterates by character and both characters are axis names.

    So the one diagonal the author asked for silently becomes the two straight
    axes, nothing raises, and the worst case the docstring promises goes from
    1.08x to 1.41x. An unknown key is a different matter and needs no check --
    it raises KeyError naming itself.
    """
    with pytest.raises(ValueError, match="iterates by character"):
        checklib.thin_walls("not geometry", [0.0], 0.8, axes="xy")


def test_unsupported_area_refuses_a_budget_no_part_can_meet():
    """Zero is a decision an author can mean; below it is not.

    Area is never negative, so a negative budget cannot be met even by a part
    with no overhang at all -- and the measuring half would report a problem
    with no patch to name, since `total` starts at 0.0 and 0.0 is not under a
    negative number.
    """
    with pytest.raises(ValueError, match="max_area_mm2"):
        checklib.unsupported_area(__file__, -1.0, name="lid")


def test_unsupported_area_refuses_a_path_with_no_mesh_at_it():
    """And says where the mesh comes from, because that is the mistake.

    The refusal is here rather than in the measuring half because it has to
    answer on a machine with no kernel and no trimesh: nothing has been
    imported yet when it fires.
    """
    with pytest.raises(ValueError, match="no mesh at"):
        checklib.unsupported_area("_out/lid.stl", 10.0, name="lid")


def test_the_build_half_never_calls_a_check_that_needs_the_authors_number():
    """Where the line between the gate and this module runs, made checkable.

    The gate holds what needs no number from the author -- a mesh that is not
    watertight is wrong for every part there will ever be. These four need one:
    how much unsupported area THIS design tolerates, how thin ITS walls may be,
    what tool drives its screws, how far its lid travels. Nothing in the build
    half can know any of those, so nothing in the build half may call them --
    it would have to invent the number, and a number invented on the author's
    behalf is exactly the false red this file argues against everywhere else.

    `minimum_feature` is deliberately NOT in the set: it is a property of the
    nozzle rather than of the design, and `printables.py` calls it to gate a
    part whose whole body is thinner than a printed line.
    """
    gated = {"unsupported_area", "thin_walls", "tool_access", "swept_clearance"}
    files = sorted(pathlib.Path(checklib.__file__).parent.rglob("*.py"))
    # BOTH ENDS OF THE SWEEP ARE ANCHORED, because either of them going empty
    # leaves a test that passes by looking at nothing: a walk that stops finding
    # the build half returns no files, and a check that gets renamed is no
    # longer a name anybody could call. The four names are asked of the module
    # rather than spelled twice -- a rename then fails here instead of quietly
    # emptying the set.
    assert {path.stem for path in files} >= {"gate", "printables", "checklib"}
    assert sorted(n for n in gated if hasattr(checklib, n)) == sorted(gated)
    calls = []
    for path in files:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            called = (getattr(node.func, "attr", None)
                      or getattr(node.func, "id", None))
            if called in gated:
                calls.append(f"{path.name}:{node.lineno} calls {called}()")
    assert calls == []


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


def _bracket():
    """A plate standing on the bed with a shelf cantilevered off its top.

    The shelf is 20 x 12 mm and hangs at z = 27 with nothing but air under it,
    which is 240 mm2 of overhang. Turned over it lands ON the bed and the plate
    stands up instead -- the same shape, and no overhang at all.
    """
    cq = _cq()
    plate = cq.Workplane("XY").box(20, 4, 30, centered=(False, False, False))
    shelf = (cq.Workplane("XY").box(20, 12, 3, centered=(False, False, False))
             .translate((0, 4, 27)))
    return plate.union(shelf)


def _stl(out_dir, obj, name):
    """The part as the gate would have written it, in the build directory."""
    path = out_dir / f"{name}.stl"
    # The numbers `printables.export_printables` exports with, TAKEN FROM WHERE
    # IT TAKES THEM rather than copied: the sentence above is the claim that
    # this is the mesh a real build hands the check, and a literal here would
    # leave that claim standing after the export was re-tuned.
    obj.val().exportStl(str(path), tolerance=STL_TOLERANCE,
                        angularTolerance=STL_ANGULAR_TOLERANCE,
                        ascii=False, relative=False)
    return path


def _area(problem):
    """The square millimetres a problem string leads with."""
    return float(re.search(r"([\d.]+) mm2", problem).group(1))


def _point(problem):
    """The (x, y, z) a problem string names."""
    found = re.search(r"\((-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\)", problem)
    return tuple(float(value) for value in found.groups())


def test_the_shelf_of_a_bracket_is_the_unsupported_area(out_dir):
    problems = checklib.unsupported_area(_stl(out_dir, _bracket(), "bracket"),
                                         10.0, name="bracket")
    assert len(problems) == 1
    assert _area(problems[0]) == pytest.approx(240.0, abs=1.0)
    assert "24.0x the 10 mm2" in problems[0]
    x, y, z = _point(problems[0])
    assert z == pytest.approx(27.0), "the overhang is the underside of the shelf"
    assert 4.0 <= y <= 16.0 and 0.0 <= x <= 20.0


def test_the_same_bracket_turned_over_has_no_overhang_at_all(out_dir):
    """The pair is the whole argument: this measures the ORIENTATION.

    The shape is identical to the one above, down to the vertex, and the answer
    is not -- because the shelf that hung in the air now lies on the plate. A
    check that read the solid rather than the exported mesh could not tell the
    two apart, and with a tolerance of zero this says the area is zero rather
    than merely small.
    """
    turned = _bracket().rotate((0, 0, 0), (1, 0, 0), 180).translate((0, 0, 30))
    assert checklib.unsupported_area(_stl(out_dir, turned, "turned"), 0.0) == []


def test_the_first_layer_is_not_an_overhang(out_dir):
    """A box's whole bottom face points down and is held up by the plate."""
    cq = _cq()
    box = cq.Workplane("XY").box(20, 20, 5)
    assert checklib.unsupported_area(_stl(out_dir, box, "box"), 0.0) == []


def _rib(thickness, angle=0.0):
    """A wall 20 mm long and `thickness` thick, standing across y = 7.

    BOTH ARGUMENTS TO `rotate` ARE POINTS, not a point and a direction, so the
    second one is on the same vertical as the first: `(0, 7, 1)` turns the rib
    about Z, in the plane the scan lines live in, which is the whole subject of
    the test below. `(0, 0, 1)` would name the axis (0, -7, 1) instead -- almost
    -Y -- and tip the rib out of that plane, leaving the section at z=0 the same
    unturned wall the caller asked to have turned.
    """
    cq = _cq()
    rib = cq.Workplane("XY").box(20, thickness, 10).translate((0, 7, 0))
    return rib.rotate((0, 7, 0), (0, 7, 1), angle) if angle else rib


def test_a_half_millimetre_rib_is_found_and_the_string_says_where():
    problems = checklib.thin_walls(_rib(0.5), [0.0], 0.8, name="rib")
    assert len(problems) == 1
    x, y, z = _point(problems[0])
    assert 6.5 <= y <= 7.5, "the reported point is not on the rib"
    assert -10.0 <= x <= 10.0
    assert z == pytest.approx(0.0)


def test_a_rib_twice_the_minimum_is_not_reported():
    """The check has to be able to say yes, or the one above proves nothing."""
    assert checklib.thin_walls(_rib(1.6), [0.0], 0.8, name="rib") == []


def test_a_hand_passed_step_measures_in_whole_steps_not_in_millimetres():
    """The half of the divisibility rule that the refusal alone does not buy.

    `min_thickness / step` is whole here to any tolerance the refusal could
    use -- and `3 * 0.3` is still 0.8999999999999999, so a run of three steps
    compared in millimetres came out under a 0.9 mm minimum and named a 1.1 mm
    wall thin. The scan counts samples against the same number of divisions the
    refusal computed, which is two integers and loses nothing.
    """
    assert checklib.thin_walls(_rib(1.1), [0.0], 0.9, step=0.3, name="rib") == []


def test_a_rib_at_45_degrees_to_the_scan_axes_never_falsely_accuses():
    """The ONE-SIDED error, from both sides.

    A wall oblique to a scan axis is crossed by a longer run than it is thick,
    so the thin one here may be found or missed and the test says nothing about
    which. The thick one is the half that matters: whatever the angle, a wall
    over the minimum must never be named -- and it is the diagonal axes cutting
    the corners of a part that make that a real risk rather than a theoretical
    one.
    """
    assert checklib.thin_walls(_rib(1.6, angle=45.0), [0.0], 0.8) == []
    thin = checklib.thin_walls(_rib(0.5, angle=45.0), [0.0], 0.8, name="rib")
    assert len(thin) <= 1
    if thin:
        assert _point(thin[0])[2] == pytest.approx(0.0)


def test_a_plane_that_misses_the_part_says_so_rather_than_passing():
    """Silence here would be a plane that measured nothing reading as clean."""
    problems = checklib.thin_walls(_rib(0.5), [50.0], 0.8, name="rib")
    assert len(problems) == 1
    assert "nothing lies in the plane z=50" in problems[0]
