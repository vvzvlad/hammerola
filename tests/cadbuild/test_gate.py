"""The gates that read a whole view: the plate, coverage, and interference.

All three have caught real defects and all three are cheap to get subtly wrong,
so they are pinned here on stand-in geometry (see fakes.py) rather than left to
whichever project happens to trip over them next.

COVERAGE IS A SET MEMBERSHIP NOW, and the tests that went with the old answer
are gone rather than ported: a fingerprint of each solid (volume, face count,
face areas) used to be matched against `printables()` by a bipartite matching,
with a whole-word match on names as a courtesy. What that machinery got wrong
cannot be expressed here any more -- a decoy solid has no catalogue key, and a
part renamed in a view is a reference to the same key.
"""

import re

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.gate import (
    INTERFERENCE_VOLUME_TOL,
    PRINT_OVERLAP_TOL,
    Z_ROTATION_TOL,
    check_assembled_coverage,
    check_interference,
    check_print_layout,
)

from fakes import (Box, Location, Shape, Workplane, catalogue, mirrored, node,
                   part, turned, view)


# --------------------------------------------------------------------------
# The print plate
# --------------------------------------------------------------------------

def test_parts_laid_out_clear_of_each_other_pass():
    prepared = [view("print", [node("body", part(0, 0)), node("lid", part(50, 0))])]
    check_print_layout(prepared, catalogue(body="printable", lid="printable"))


def test_parts_left_at_the_origin_are_refused():
    """The defect this gate exists for: the layout step was forgotten."""
    prepared = [view("print", [node("body", part(0, 0)), node("lid", part(0, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))
    assert "standing inside each other" in str(exc.value)
    assert "'body'" in str(exc.value) and "'lid'" in str(exc.value)


def test_parts_touching_edge_to_edge_pass():
    """A gap of zero is a layout, not a mistake."""
    prepared = [view("print", [node("body", part(0, 0, size=10)),
                               node("lid", part(10, 0, size=10))])]
    check_print_layout(prepared, catalogue(body="printable", lid="printable"))


def test_overlap_under_the_tolerance_passes():
    nudge = PRINT_OVERLAP_TOL / 2
    prepared = [view("print", [node("body", part(0, 0, size=10)),
                               node("lid", part(10 - nudge, 0, size=10))])]
    check_print_layout(prepared, catalogue(body="printable", lid="printable"))


def test_overlap_over_the_tolerance_is_refused():
    nudge = PRINT_OVERLAP_TOL * 4
    prepared = [view("print", [node("body", part(0, 0, size=10)),
                               node("lid", part(10 - nudge, 0, size=10))])]
    with pytest.raises(BuildError):
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))


def test_a_gap_on_one_axis_is_enough_to_be_clear():
    """Boxes intersect only when they overlap on all three axes."""
    low = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)))
    high = Workplane(Shape(Box(0, 0, 50, 10, 10, 60)))
    check_print_layout([view("print", [node("body", low), node("lid", high)])],
                       catalogue(body="printable", lid="printable"))


def test_a_declared_nested_pair_is_allowed():
    prepared = [view("print", [node("body", part(0, 0)), node("insert", part(0, 0))],
                     nested_ok={frozenset(("body", "insert"))})]
    check_print_layout(prepared, catalogue(body="printable", insert="printable"))


def test_the_assembled_view_is_not_a_plate():
    """Parts touching in `assembled` is the point of it."""
    check_print_layout([view("assembled", [node("body", part(0, 0)),
                                           node("lid", part(0, 0))])],
                       catalogue(body="printable", lid="printable"))


def test_a_project_with_no_print_view_has_no_plate_to_judge():
    check_print_layout([view("assembled", [node("body")])],
                       catalogue(body="printable"))


def test_a_one_part_print_view_has_nothing_to_lay_out():
    check_print_layout([view("print", [node("body", part(0, 0))])],
                       catalogue(body="printable"))


def test_two_bodies_of_the_same_object_are_not_compared():
    """One object built with .add() is one part carrying one label.

    There would be no way to declare such a pair nested_ok, so overlapping
    bodies inside a single object must not be a finding.
    """
    both = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                     Shape(Box(1, 1, 1, 9, 9, 9)))
    check_print_layout(
        [view("print", [node("combo", both), node("lid", part(50, 0))])],
        catalogue(combo="printable", lid="printable"))


def test_a_second_body_standing_in_a_neighbour_is_caught():
    """`val()` is the first body only, which is how this used to be missed."""
    two = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(50, 0, 0, 60, 10, 10)))
    other = Workplane(Shape(Box(52, 2, 2, 58, 8, 8)))
    with pytest.raises(BuildError):
        check_print_layout(
            [view("print", [node("combo", two), node("lid", other)])],
            catalogue(combo="printable", lid="printable"))


def test_a_second_body_that_is_not_geometry_is_named_here_and_not_later():
    """For a part ON THE PLATE, this is where its stack is first read WHOLE.

    Nothing before it looks past the first body of an entry: `read_catalogue`
    admits the entry through `as_shape`, which is `obj.val()`, and
    `views._placed` runs a reference through `as_shapes` only when it carries an
    `at`. So an entry holding [a solid, something that is not geometry],
    referenced BARE, arrives at this gate checked on its first body alone --
    and this gate stands ahead of coverage and interference, so it is where the
    second body is met. What must come out is a BuildError naming the part,
    rather than an AttributeError from whatever asks that object for a box.

    Only for a part on the plate, and only when something else is on it too: a
    plate of one part returns before the loop, and a part that is in no `print`
    view at all is first read whole by `check_interference`, through the same
    `_bodies`.
    """
    junk = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)), object())
    with pytest.raises(BuildError) as exc:
        check_print_layout(
            [view("print", [node("lid", junk), node("body", part(50, 0))])],
            catalogue(lid="printable", body="printable"))
    assert "expected CadQuery geometry" in str(exc.value)
    assert "'lid'" in str(exc.value)


def test_one_line_per_pair_of_parts_not_per_pair_of_bodies():
    two = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(1, 1, 1, 9, 9, 9)))
    other = Workplane(Shape(Box(2, 2, 2, 8, 8, 8)))
    with pytest.raises(BuildError) as exc:
        check_print_layout(
            [view("print", [node("combo", two), node("lid", other)])],
            catalogue(combo="printable", lid="printable"))
    assert str(exc.value).count("overlap by") == 1


def test_two_references_to_one_part_are_told_apart_in_the_message():
    """Five pins are five references to one key; a message has to say which."""
    prepared = [view("print", [node("pin", part(0, 0), label="'pin' #1"),
                               node("pin", part(0, 0), label="'pin' #2")])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(pin="printable"))
    assert "'pin' #1 and 'pin' #2" in str(exc.value)


# --------------------------------------------------------------------------
# The print plate: only printables, and only upright
# --------------------------------------------------------------------------

def test_a_mock_on_the_plate_is_refused():
    """`print.stl` is a file somebody may hand to a slicer."""
    prepared = [view("print", [node("body", part(0, 0)),
                               node("bearing", part(50, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", bearing="mock"))
    assert "not printed" in str(exc.value)
    assert "'bearing' is mock" in str(exc.value)


def test_hardware_on_the_plate_is_refused():
    prepared = [view("print", [node("body", part(0, 0)),
                               node("screw", part(50, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", screw="hardware"))
    assert "'screw' is hardware" in str(exc.value)


def test_moving_a_part_on_the_plate_is_allowed():
    prepared = [view("print", [node("body", part(0, 0), at=Location(0, 0, 0)),
                               node("lid", part(50, 0), at=Location(50, 0, 0))])]
    check_print_layout(prepared, catalogue(body="printable", lid="printable"))


def test_turning_a_part_about_z_is_allowed():
    """Laying out a bed is moving parts and turning them flat on it."""
    prepared = [view("print", [node("body", part(0, 0), at=turned(37, "z")),
                               node("lid", part(50, 0))])]
    check_print_layout(prepared, catalogue(body="printable", lid="printable"))


@pytest.mark.parametrize("axis", ["x", "y"])
def test_tilting_a_part_off_the_bed_is_refused(axis):
    """Which way up a part prints is a property of the part, not of the view."""
    prepared = [view("print", [node("body", part(0, 0), at=turned(15, axis)),
                               node("lid", part(50, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))
    assert "turns parts off the bed" in str(exc.value)
    assert "'body'" in str(exc.value)


@pytest.mark.parametrize("axis", ["x", "y", "z"])
def test_mirroring_a_part_on_the_bed_is_refused(axis):
    """A reflection is not a placement: it is a different part.

    The twin of the tilt above, and it is the case the tilt check could not
    see. A mirror in a plane CONTAINING Z leaves Z exactly where it was, so the
    third row and the third column both read (0, 0, 1) and every comparison the
    gate makes about them passes -- only the sign of the determinant separates
    it from a turn. For a chiral part (a left-hand bracket against a right-hand
    one) the thing standing on the plate is then not the thing in the catalogue,
    and `<key>.stl` next to it holds the other one.
    """
    prepared = [view("print", [node("body", part(0, 0), at=mirrored(axis)),
                               node("lid", part(50, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))
    assert "turns parts off the bed" in str(exc.value)
    assert "'body'" in str(exc.value)


def test_the_fake_location_answers_is_negative_the_way_gp_trsf_does():
    """The fake must not disagree with OCC about what a mirror is.

    Everything above runs on stand-in geometry, so the whole mirror gate rests
    on `_Trsf.IsNegative()` in fakes.py answering as the real thing does. It is
    computed off the determinant of the same matrix -- which is what gp_Trsf
    does -- and this is what proves it, by building the real transformations and
    comparing both the matrix and the verdict.
    """
    OCP_gp = pytest.importorskip(
        "OCP.gp", exc_type=ImportError,
        reason="the CAD kernel does not import in this interpreter, so there "
               "is no real gp_Trsf to compare the fake against")
    for axis, direction in (("x", (1, 0, 0)), ("y", (0, 1, 0)), ("z", (0, 0, 1))):
        real = OCP_gp.gp_Trsf()
        real.SetMirror(OCP_gp.gp_Ax2(OCP_gp.gp_Pnt(0, 0, 0),
                                     OCP_gp.gp_Dir(*direction)))
        fake = mirrored(axis).wrapped.Transformation()
        assert real.IsNegative() is True
        assert fake.IsNegative() == real.IsNegative()
        for row in (1, 2, 3):
            for col in (1, 2, 3):
                # `+ 0.0` because OCC hands back -0.0 for a zero it negated,
                # and -0.0 == 0.0 already; this is only so a failure prints
                # readably.
                assert fake.Value(row, col) == real.Value(row, col) + 0.0
    # ...and the other direction: an honest turn about Z is not negative, so
    # the new check cannot refuse the layouts the gate exists to allow.
    turn = OCP_gp.gp_Trsf()
    turn.SetRotation(OCP_gp.gp_Ax1(OCP_gp.gp_Pnt(0, 0, 0),
                                   OCP_gp.gp_Dir(0, 0, 1)), 0.5)
    assert turn.IsNegative() is False
    assert turned(37, "z").wrapped.Transformation().IsNegative() is False


def test_the_smallest_tilt_anybody_could_mean_is_caught():
    """The tolerance sits far below every angle a person could type.

    A rotation of a ten-thousandth of a degree about X already puts 1.7e-6 into
    the row the gate reads -- above Z_ROTATION_TOL -- while an exact turn about
    Z composed by OCC leaves errors ten orders of magnitude below it.
    """
    prepared = [view("print", [node("body", part(0, 0), at=turned(0.0001, "x")),
                               node("lid", part(50, 0))])]
    with pytest.raises(BuildError):
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))
    assert Z_ROTATION_TOL < 1e-5


def test_an_at_that_is_not_a_location_is_named_rather_than_crashing():
    """prepare_views checks the type; this is what keeps that true for the next
    caller, and it has to be a BuildError rather than an AttributeError."""
    prepared = [view("print", [node("body", part(0, 0), at=object()),
                               node("lid", part(50, 0))])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared, catalogue(body="printable", lid="printable"))
    assert "cq.Location" in str(exc.value)


# --------------------------------------------------------------------------
# Coverage of the assembled view
# --------------------------------------------------------------------------

def test_every_printable_present_by_key_passes():
    check_assembled_coverage(
        [view("assembled", [node("body"), node("lid")])],
        catalogue(body="printable", lid="printable"))


def test_a_printable_missing_from_the_assembled_view_is_refused():
    with pytest.raises(BuildError) as exc:
        check_assembled_coverage(
            [view("assembled", [node("body")]),
             view("print", [node("body"), node("lid")])],
            catalogue(body="printable", lid="printable"))
    assert "does not show printable" in str(exc.value)
    assert "'lid'" in str(exc.value)


def test_hardware_and_mocks_need_not_be_in_the_assembled_view():
    """The gate is about what is PRINTED. A screw shown nowhere is fine."""
    check_assembled_coverage(
        [view("assembled", [node("body")])],
        catalogue(body="printable", screw="hardware", bearing="mock"))


def test_extra_parts_in_the_view_are_never_an_error():
    check_assembled_coverage(
        [view("assembled", [node("body"), node("motor")])],
        catalogue(body="printable", motor="mock"))


def test_several_references_to_one_printable_are_not_counted():
    """Five pins are five references and one part; nothing counts them."""
    check_assembled_coverage(
        [view("assembled", [node("pin"), node("pin"), node("pin")])],
        catalogue(pin="printable"))


def test_a_part_drawn_at_alpha_zero_does_not_count_as_shown():
    with pytest.raises(BuildError) as exc:
        check_assembled_coverage(
            [view("assembled", [node("body"), node("lid", alpha=0.0)])],
            catalogue(body="printable", lid="printable"))
    assert "'lid'" in str(exc.value)


def test_a_see_through_printable_is_warned_about_and_not_refused(capsys):
    """A defect of the picture, not of the part: an author may have meant it."""
    check_assembled_coverage(
        [view("assembled", [node("body", alpha=0.4)])],
        catalogue(body="printable"))
    out = capsys.readouterr().out
    assert "warning" in out and "alpha 0.4" in out


def test_a_see_through_mock_is_not_warned_about(capsys):
    """Looking through a mock is what mocks are for."""
    check_assembled_coverage(
        [view("assembled", [node("body"), node("case", alpha=0.3)])],
        catalogue(body="printable", case="mock"))
    assert "alpha" not in capsys.readouterr().out


def test_a_build_with_no_assembled_view_is_refused():
    """prepare_views refuses one; this is the defensive half of that rule."""
    with pytest.raises(BuildError) as exc:
        check_assembled_coverage([view("print", [node("body")])],
                                 catalogue(body="printable"))
    assert "no 'assembled' view" in str(exc.value)


# --------------------------------------------------------------------------
# Interference
# --------------------------------------------------------------------------

def solid(x, y=0.0, z=0.0, size=10.0):
    return Workplane(Shape(Box(x, y, z, x + size, y + size, z + size)))


def printables(*keys):
    """A catalogue where every one of these keys is a printed part."""
    return catalogue(**{key: "printable" for key in keys})


def test_parts_that_do_not_touch_pass():
    check_interference([view("assembled", [node("a", solid(0)),
                                           node("b", solid(50))])],
                       printables("a", "b"))


def test_parts_that_touch_pass():
    """Face to face is what an assembly IS; only shared volume is a finding."""
    check_interference([view("assembled", [node("a", solid(0)),
                                           node("b", solid(10))])],
                       printables("a", "b"))


def test_parts_occupying_the_same_space_are_refused():
    with pytest.raises(BuildError) as exc:
        check_interference([view("assembled", [node("a", solid(0)),
                                               node("b", solid(5))])],
                           printables("a", "b"))
    message = str(exc.value)
    assert "occupying the same space" in message
    assert "'a' and 'b' share" in message
    # 5 x 10 x 10 of overlap, and the number is in the message: a reader has to
    # be able to tell a press fit from a part standing in another one.
    assert "500.000 mm3" in message


def test_a_declared_overlap_passes_and_its_reason_is_printed(capsys):
    prepared = [view(
        "assembled", [node("nozzle", solid(0)), node("seat", solid(5))],
        interference_ok={frozenset(("nozzle", "seat")): "threaded joint"})]
    check_interference(prepared, printables("nozzle", "seat"))
    assert "threaded joint" in capsys.readouterr().out


def test_a_declared_overlap_is_printed_even_when_nothing_overlaps(capsys):
    """Every exemption a build ran with has to be visible in its log."""
    prepared = [view(
        "assembled", [node("a", solid(0)), node("b", solid(50))],
        interference_ok={frozenset(("a", "b")): "used to bite"})]
    check_interference(prepared, printables("a", "b"))
    assert "used to bite" in capsys.readouterr().out


def test_one_declaration_covers_every_instance_of_that_pair_of_keys():
    """An exemption names KEYS, so it comes off every reference to them.

    Five references to `pin` are ten pin-against-pin pairs, all of them
    standing in one another here. `("pin", "pin", ...)` is one declaration and
    it takes the check off all ten -- there is nothing to name a single
    reference by, so this is what "by catalogue key" has to mean. Written down
    because it is a decision and not an accident: it is generous, and the
    generosity is what the pin case buys.
    """
    pins = [node("pin", solid(0), label=f"'pin' #{n}") for n in range(1, 6)]
    with pytest.raises(BuildError) as exc:
        check_interference([view("assembled", pins)], printables("pin"))
    # Ten pairs, all reported, before the declaration goes in.
    assert str(exc.value).count("share") == 10
    check_interference(
        [view("assembled", pins,
              interference_ok={frozenset(("pin",)): "pressed into one another"})],
        printables("pin"))


def test_the_boolean_is_only_asked_about_pairs_the_boxes_could_not_settle(capsys):
    """The prefilter is what makes a twenty-part assembly finish."""
    check_interference([view("assembled", [node("a", solid(0)),
                                           node("b", solid(50)),
                                           node("c", solid(100))])],
                       printables("a", "b", "c"))
    assert "0 pair(s) needed a boolean" in capsys.readouterr().out


def test_the_log_says_what_the_gate_cost(capsys):
    """O(n^2) booleans hiding inside the `geometry` phase, with a number on it.

    Nothing else in a build points at this line: it is not a phase of its own,
    so a slow model shows one big `geometry` number and no way to tell whether
    the minutes went here. The shape is the one every other timing in this
    build prints in -- seconds to one decimal.
    """
    check_interference([view("assembled", [node("a", solid(0)),
                                           node("b", solid(50))])],
                       printables("a", "b"))
    out = capsys.readouterr().out
    assert re.search(
        r"0 pair\(s\) needed a boolean, 0 declared, \d+\.\ds", out), out


class Ghost(Shape):
    """Boxes that overlap around solids that do not -- two nesting L-shapes.

    The case the two-stage gate exists for: the cheap test says "maybe" and
    only the boolean can say no.
    """

    def intersect(self, other):
        return Shape(volume=0.0)


def test_a_pair_whose_boxes_overlap_reaches_the_boolean(capsys):
    first = Workplane(Ghost(Box(0, 0, 0, 10, 10, 10)))
    second = Workplane(Ghost(Box(5, 5, 0, 15, 15, 10)))
    check_interference([view("assembled", [node("a", first), node("b", second)])],
                       printables("a", "b"))
    assert "1 pair(s) needed a boolean" in capsys.readouterr().out


class Broken(Shape):
    """A solid OCC cannot intersect with anything."""

    def intersect(self, other):
        raise RuntimeError("BRepAlgoAPI_Common failed")


class Shell(Shape):
    """A boolean returning an open shell: a Volume() with no solid in it.

    What OCC can hand back where two faces touch tangentially. `Volume()` on a
    shell is the volume of the body OCC closes it into, which is a number of an
    entirely different kind from "how much material do these two share" -- and
    it can be as large as the parts are.
    """

    def intersect(self, other):
        return Shape(volume=500.0, solids=())


def test_a_placed_fake_is_still_the_fake_it_was():
    """A stand-in that stops being itself when it is moved is a green lie.

    `Shape.moved` used to construct a plain `Shape` and to drop `solids`, so
    `Broken(...).moved(at)` was an ordinary solid that intersects perfectly and
    a shell-shaped stand-in came back with a solid in it. Nothing in the gate
    tests gives a node an `at` today, which is exactly why this is pinned: the
    day one does, the test would pass for the wrong reason and say nothing.
    """
    at = Location(5.0, 0.0, 0.0)

    moved = Broken(Box(0, 0, 0, 10, 10, 10)).moved(at)
    assert isinstance(moved, Broken)
    with pytest.raises(RuntimeError):
        moved.intersect(moved)

    shell = Shape(Box(0, 0, 0, 10, 10, 10), volume=7.0, areas=(1.0,),
                  solids=()).moved(at)
    assert shell.Solids() == []
    assert shell.Volume() == 7.0
    assert [face.Area() for face in shell.Faces()] == [1.0]
    assert (shell.BoundingBox().xmin, shell.BoundingBox().xmax) == (5.0, 15.0)


def test_a_boolean_that_falls_over_is_a_warning_and_not_a_refusal(capsys):
    """An OCC failure says nothing about the model -- but it must not read as
    "no interference" either, because nothing looked."""
    first = Workplane(Broken(Box(0, 0, 0, 10, 10, 10)))
    check_interference([view("assembled", [node("a", first),
                                           node("b", solid(5))])],
                       printables("a", "b"))
    out = capsys.readouterr().out
    assert "warning" in out and "UNCHECKED" in out


class Counting(Shape):
    """A body that records every boolean the gate asked of it.

    What it answers is "nothing shared", so the count is the only thing under
    test: which pairs of BODIES reached a boolean at all.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.asked = []

    def intersect(self, other):
        self.asked.append(other)
        return Shape(volume=0.0)


def test_a_refused_boolean_stops_the_whole_part_pair(capsys):
    """One body pair the kernel drops makes the PART pair unanswerable.

    The multi-body case the single-body test above cannot reach, and the one
    that used to go wrong: the failure was warned about, the loop went on, and
    the verdict was then passed on the sum of the OTHER bodies. That partial sum
    understates the overlap and reads exactly like a verdict -- here it would
    have come to 0 mm3 and published a build nothing measured. It is what
    `checklib.pairwise_interference` decided in the same package, and the two
    now answer alike.

    THE BODY THAT FALLS OVER IS ONE WHOSE BOX OVERLAPS, and that is the half
    this test has to keep pinning: a body pair the boxes settle never reaches a
    boolean now, so it cannot bury anything (the test below is that half). What
    buries the pair is a boolean that was genuinely asked and genuinely refused.
    """
    two = Workplane(Broken(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(50, 0, 0, 60, 10, 10)))
    other = Workplane(Shape(Box(5, 0, 0, 15, 10, 10)),
                      Shape(Box(52, 2, 2, 58, 8, 8)))
    # The Broken body and `other`'s first body overlap by 5 x 10 x 10, so that
    # boolean is asked and refused. The second body pair overlaps by 6 x 6 x 6 =
    # 216 mm3 -- far over the tolerance -- so a gate that carried on would have
    # a verdict to pass. It must pass none.
    check_interference([view("assembled", [node("combo", two),
                                           node("lid", other)])],
                       printables("combo", "lid"))
    out = capsys.readouterr().out
    assert "UNCHECKED" in out
    assert "1 pair(s) needed a boolean" in out


def test_a_far_body_pair_inside_a_close_part_pair_never_reaches_the_boolean():
    """The box filter runs on the pairs of BODIES, and this is that one level.

    A far pair of bodies sitting inside a pair of PARTS that are close enough to
    need a boolean reaches none: `far` is asked nothing at all. There is no
    second, per-part hull level above it -- `checklib.pairwise_interference`
    keeps one and this gate deliberately does not, see `check_interference` --
    so this single comparison is what decides both which pairs of parts need a
    boolean and which of their bodies do.

    Ten bodies against ten is a hundred booleans without this, inside the phase
    the timing line beside it exists to measure -- and the boxes have already
    been taken. Counted rather than timed: what is under test is which pairs
    were asked, and a duration proves nothing about that.
    """
    near = Counting(Box(0, 0, 0, 10, 10, 10))
    far = Counting(Box(50, 0, 0, 60, 10, 10))
    check_interference(
        [view("assembled", [node("combo", Workplane(near, far)),
                            node("lid", Workplane(Shape(Box(5, 0, 0, 15, 10, 10))))])],
        printables("combo", "lid"))
    # Two body pairs, one boolean: `far` is nowhere near the other part.
    assert len(near.asked) == 1
    assert far.asked == []


class Resolved(Workplane):
    """A stack that records how often it was asked which bodies it holds."""

    def __init__(self, *shapes):
        super().__init__(*shapes)
        self.resolved = 0

    def vals(self):
        self.resolved += 1
        return super().vals()


def test_a_part_is_resolved_into_bodies_once_for_the_whole_gate(capsys):
    """The boxes and the booleans have to be about the SAME solids.

    A node with no `at` holds the model's own object verbatim, and a model is
    arbitrary python this build runs -- so a second `vals()` is a second answer,
    and nothing promises it matches the first. The gate used to take the boxes
    off one walk and resolve the bodies again per pair, addressing them by
    index into the walk that had been thrown away: a different order would have
    put the wrong two solids into the kernel and reported a verdict about
    neither, and a different length would have raised IndexError outside the
    `try`, as a bare traceback rather than a BuildError. Neither can be
    provoked with fakes, which is exactly why the property is pinned by COUNT
    instead: one resolution per node means there is no second answer to differ.

    Three parts whose boxes all overlap, on `Ghost` bodies that intersect in
    nothing -- so every pair really does reach a boolean and the pass runs to
    the end. Before this, each part was resolved once for its box and once more
    for each of the two pairs it is in.
    """
    stacks = [Resolved(Ghost(Box(0, 0, 0, 10, 10, 10))),
              Resolved(Ghost(Box(5, 0, 0, 15, 10, 10))),
              Resolved(Ghost(Box(2, 0, 0, 12, 10, 10)))]
    check_interference(
        [view("assembled", [node(key, stack)
                            for key, stack in zip(("a", "b", "c"), stacks)])],
        printables("a", "b", "c"))
    assert "3 pair(s) needed a boolean" in capsys.readouterr().out
    assert [stack.resolved for stack in stacks] == [1, 1, 1]


def test_a_far_body_cannot_take_the_verdict_on_a_real_overlap_away(capsys):
    """The correctness half of the same filter, and the reason it is not tidying.

    "The first refusal buries the whole part pair" and "every body is tested
    against every body" are safe apart and dangerous together: a body that could
    never overlap anything here is still a body the kernel can fall over on, and
    without the second-level filter its failure would silently withdraw the
    verdict on the 500 mm3 the two parts really do share.
    """
    combo = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                      Broken(Box(50, 0, 0, 60, 10, 10)))
    other = Workplane(Shape(Box(5, 0, 0, 15, 10, 10)))
    with pytest.raises(BuildError) as exc:
        check_interference([view("assembled", [node("combo", combo),
                                               node("lid", other)])],
                           printables("combo", "lid"))
    assert "500.000 mm3" in str(exc.value)
    # ...and nothing was warned about, because nothing was asked of the kernel
    # that it could not answer.
    assert "UNCHECKED" not in capsys.readouterr().out


def test_a_shell_with_no_solid_in_it_is_not_an_overlap(capsys):
    """Only Solids() count, as checklib.pairwise_interference counts them."""
    first = Workplane(Shell(Box(0, 0, 0, 10, 10, 10)))
    check_interference([view("assembled", [node("a", first),
                                           node("b", solid(5))])],
                       printables("a", "b"))
    assert "1 pair(s) needed a boolean" in capsys.readouterr().out


def test_every_body_of_a_multi_body_part_is_tested():
    """`val()` is the first body only -- the same trap as on the plate."""
    two = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(50, 0, 0, 60, 10, 10)))
    other = Workplane(Shape(Box(52, 2, 2, 58, 8, 8)))
    with pytest.raises(BuildError):
        check_interference([view("assembled", [node("combo", two),
                                               node("lid", other)])],
                           printables("combo", "lid"))


def test_a_project_with_one_part_has_no_pairs():
    check_interference([view("assembled", [node("body", solid(0))])],
                       printables("body"))


def test_dust_under_the_tolerance_is_not_a_finding():
    """A tangential boolean can hand back a sliver of numerical noise."""
    overlap = (INTERFERENCE_VOLUME_TOL / 2) / 100.0
    check_interference([view("assembled", [node("a", solid(0)),
                                           node("b", solid(10 - overlap))])],
                       printables("a", "b"))


# --------------------------------------------------------------------------
# Interference: a mock is scenery and is not asked about
# --------------------------------------------------------------------------

def test_a_mock_standing_inside_a_printable_needs_no_declaration(capsys):
    """The wall a bracket bolts to overlaps the bracket by construction.

    Requiring a reason for every one of those fills `interference_ok` with rows
    saying "the wall, because it is the wall" and buries the one declaration
    that is about a real joint. So the pair is not asked about at all -- the
    gate asks whether two things can both be there, and scenery is not there.
    """
    check_interference(
        [view("assembled", [node("body", solid(0)), node("wall", solid(5))])],
        catalogue(body="printable", wall="mock"))
    assert "0 pair(s) needed a boolean" in capsys.readouterr().out


class Weighed(Shape):
    """A body that records how often its bounding box was taken."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.measured = 0

    def BoundingBox(self):
        self.measured += 1
        return super().BoundingBox()


def test_no_bounding_box_is_taken_for_a_mock():
    """Scenery is decided BEFORE the boxes, and this is why it has to be.

    `Shape.BoundingBox()` is BRepBndLib.AddOptimal_s -- a search for the
    extremum of every surface, which is what the note on PRINT_OVERLAP_TOL is
    about -- and a mock is exactly the object that is heavy: an imported STEP of
    a barrel, a wall, a board. Nothing in this gate asks a mock anything, so
    measuring one is work with no reader.
    """
    wall = Weighed(Box(0, 0, 0, 100, 100, 100))
    body = Weighed(Box(0, 0, 0, 10, 10, 10))
    check_interference(
        [view("assembled", [node("body", Workplane(body)),
                            node("wall", Workplane(wall))])],
        catalogue(body="printable", wall="mock"))
    assert wall.measured == 0
    # ...and the printable beside it still is, so this measures the order and
    # not a gate that stopped looking at anything.
    assert body.measured == 1


def test_two_mocks_inside_each_other_need_no_declaration():
    check_interference(
        [view("assembled", [node("wall", solid(0)), node("floor", solid(5))])],
        catalogue(wall="mock", floor="mock"))


def test_hardware_in_the_same_place_still_has_to_be_declared():
    """The half that makes the exclusion a line and not a hole.

    A screw is material that is really there, and its thread biting into a
    printed hole is exactly the overlap the contract asks to be declared with a
    reason.
    """
    prepared = [view("assembled", [node("body", solid(0)),
                                   node("screw", solid(5))])]
    with pytest.raises(BuildError) as exc:
        check_interference(prepared, catalogue(body="printable",
                                               screw="hardware"))
    assert "'body' and 'screw' share" in str(exc.value)
    # ...and it is declarable, exactly as before.
    check_interference(
        [view("assembled", [node("body", solid(0)), node("screw", solid(5))],
              interference_ok={frozenset(("body", "screw")): "thread bites in"})],
        catalogue(body="printable", screw="hardware"))
