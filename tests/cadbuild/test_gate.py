"""The geometry gate: the print plate, and coverage.

Both of these have caught real defects and both are cheap to get subtly wrong,
so they are pinned here on stand-in geometry (see fakes.py) rather than left to
whichever project happens to trip over them next.
"""

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.gate import (
    PRINT_OVERLAP_TOL,
    check_print_layout,
    check_printables_shown,
)

from fakes import Box, Shape, Workplane, part, view


# --------------------------------------------------------------------------
# The print plate
# --------------------------------------------------------------------------

def test_parts_laid_out_clear_of_each_other_pass():
    prepared = [view("print", [part(0, 0), part(50, 0)], ["body", "lid"])]
    check_print_layout(prepared)


def test_parts_left_at_the_origin_are_refused():
    """The defect this gate exists for: the layout step was forgotten."""
    prepared = [view("print", [part(0, 0), part(0, 0)], ["body", "lid"])]
    with pytest.raises(BuildError) as exc:
        check_print_layout(prepared)
    assert "standing inside each other" in str(exc.value)
    assert "'body'" in str(exc.value) and "'lid'" in str(exc.value)


def test_parts_touching_edge_to_edge_pass():
    """A gap of zero is a layout, not a mistake."""
    prepared = [view("print", [part(0, 0, size=10), part(10, 0, size=10)],
                     ["body", "lid"])]
    check_print_layout(prepared)


def test_overlap_under_the_tolerance_passes():
    nudge = PRINT_OVERLAP_TOL / 2
    prepared = [view("print", [part(0, 0, size=10), part(10 - nudge, 0, size=10)],
                     ["body", "lid"])]
    check_print_layout(prepared)


def test_overlap_over_the_tolerance_is_refused():
    nudge = PRINT_OVERLAP_TOL * 4
    prepared = [view("print", [part(0, 0, size=10), part(10 - nudge, 0, size=10)],
                     ["body", "lid"])]
    with pytest.raises(BuildError):
        check_print_layout(prepared)


def test_a_gap_on_one_axis_is_enough_to_be_clear():
    """Boxes intersect only when they overlap on all three axes."""
    low = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)))
    high = Workplane(Shape(Box(0, 0, 50, 10, 10, 60)))
    check_print_layout([view("print", [low, high], ["body", "lid"])])


def test_a_declared_nested_pair_is_allowed():
    prepared = [view("print", [part(0, 0), part(0, 0)], ["body", "insert"],
                     nested_ok={frozenset(("body", "insert"))})]
    check_print_layout(prepared)


def test_the_assembled_view_is_not_a_plate():
    """Parts touching in `assembled` is the point of it."""
    check_print_layout([view("assembled", [part(0, 0), part(0, 0)],
                             ["body", "lid"])])


def test_a_one_part_print_view_has_nothing_to_check():
    check_print_layout([view("print", [part(0, 0)], ["body"])])


def test_two_bodies_of_the_same_object_are_not_compared():
    """One object built with .add() is one part carrying one label.

    There would be no way to declare such a pair nested_ok, so overlapping
    bodies inside a single object must not be a finding.
    """
    both = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                     Shape(Box(1, 1, 1, 9, 9, 9)))
    check_print_layout([view("print", [both, part(50, 0)], ["combo", "lid"])])


def test_a_second_body_standing_in_a_neighbour_is_caught():
    """`val()` is the first body only, which is how this used to be missed."""
    two = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(50, 0, 0, 60, 10, 10)))
    other = Workplane(Shape(Box(52, 2, 2, 58, 8, 8)))
    with pytest.raises(BuildError):
        check_print_layout([view("print", [two, other], ["combo", "lid"])])


def test_one_line_per_pair_of_parts_not_per_pair_of_bodies():
    two = Workplane(Shape(Box(0, 0, 0, 10, 10, 10)),
                    Shape(Box(1, 1, 1, 9, 9, 9)))
    other = Workplane(Shape(Box(2, 2, 2, 8, 8, 8)))
    with pytest.raises(BuildError) as exc:
        check_print_layout([view("print", [two, other], ["combo", "lid"])])
    assert str(exc.value).count("overlap by") == 1


# --------------------------------------------------------------------------
# Coverage
# --------------------------------------------------------------------------

def test_a_printable_shown_by_its_own_solid_is_covered():
    body = part(volume=1000.0, areas=(100.0, 90.0))
    printables = {"body": body}
    check_printables_shown([view("assembled", [body], ["body"])], printables)


def test_a_printable_in_no_view_at_all_is_refused():
    body = part(volume=1000.0, areas=(100.0, 90.0))
    lid = part(volume=2000.0, areas=(200.0, 190.0))
    with pytest.raises(BuildError) as exc:
        check_printables_shown([view("assembled", [body], ["body"])],
                               {"body": body, "lid": lid})
    assert "'lid'" in str(exc.value)
    assert "appear in no view at all" in str(exc.value)


def test_a_moved_copy_of_a_printable_still_counts_as_that_printable():
    """The `print` view holds the same lid, translated. It is still the lid."""
    body = part(0, 0, volume=1000.0, areas=(100.0, 90.0))
    moved = part(200, 200, volume=1000.0, areas=(100.0, 90.0))
    check_printables_shown(
        [view("assembled", [body], ["something else"]),
         view("print", [moved], ["also something else"])],
        {"body": body},
    )


def test_a_printable_missing_from_the_assembled_view_is_refused():
    body = part(volume=1000.0, areas=(100.0, 90.0))
    lid = part(volume=2000.0, areas=(200.0, 190.0))
    with pytest.raises(BuildError) as exc:
        check_printables_shown(
            [view("assembled", [body], ["body"]),
             view("print", [body, lid], ["body", "lid"])],
            {"body": body, "lid": lid},
        )
    assert "does not show printable" in str(exc.value)


def test_a_name_alone_covers_a_printable_and_says_so(capsys):
    """A view showing a stand-in stays green, and the build says it is a name."""
    stand_in = part(volume=99.0, areas=(9.0,))
    real = part(volume=1000.0, areas=(100.0, 90.0))
    check_printables_shown([view("assembled", [stand_in], ["body"])],
                           {"body": real})
    assert "only matched by name" in capsys.readouterr().out


def test_extra_objects_in_a_view_are_never_an_error():
    """Mocks of bought hardware live in the views alongside the printables."""
    body = part(volume=1000.0, areas=(100.0, 90.0))
    motor = part(volume=5000.0, areas=(500.0,))
    check_printables_shown([view("assembled", [body, motor], ["body", "motor"])],
                           {"body": body})


def test_two_identical_printables_need_two_solids_in_the_view():
    """One solid may answer for one printable, which is what separates a
    mirrored pair that no cheap fingerprint can tell apart."""
    left = part(volume=1000.0, areas=(100.0, 90.0))
    right = part(volume=1000.0, areas=(100.0, 90.0))
    with pytest.raises(BuildError):
        check_printables_shown([view("assembled", [left], ["a", "b"])],
                               {"left": left, "right": right})
    check_printables_shown([view("assembled", [left, right], ["a", "b"])],
                           {"left": left, "right": right})


def test_a_part_drawn_at_alpha_zero_does_not_count_as_shown():
    body = part(volume=1000.0, areas=(100.0, 90.0))
    invisible = view("assembled", [body], ["body"])
    invisible["alphas"] = [0.0]
    invisible["names"] = ["not the name"]
    with pytest.raises(BuildError) as exc:
        check_printables_shown([invisible], {"body": body})
    assert "appear in no view at all" in str(exc.value)
