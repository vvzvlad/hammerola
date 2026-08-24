"""The model's own checks(), and the counting that makes an empty one fail.

The rule this module enforces is the awkward one: a checks() that asserts
nothing passes every build and prints that the model was checked. So the number
of checks is read out of the source, and zero is a failure -- while anything
the counter cannot read has to end at "unknown" and never at zero, because this
code is shared by every project and a wrong "empty checks()" would go red on
somebody's working model.
"""

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.modelchecks import (
    checks_call_args,
    count_checks,
    describe_returned,
    run_checks,
)


class Model:
    """A stand-in for model.py carrying only the attribute under test."""

    def __init__(self, checks=None):
        if checks is not None:
            self.checks = checks


# --------------------------------------------------------------------------
# Counting
# --------------------------------------------------------------------------

def test_asserts_are_counted():
    def checks():
        assert 1 == 1, "one"
        assert 2 == 2, "two"

    assert count_checks(checks) == 2


def test_raises_are_counted():
    def checks():
        if False:
            raise ValueError("nope")
        assert True, "one"

    assert count_checks(checks) == 2


def test_a_reraise_inside_except_is_not_a_check():
    def checks():
        try:
            pass
        except ValueError as exc:
            raise RuntimeError("wrapped") from exc

    # Not a check, and not proof of an empty body either.
    assert count_checks(checks) is None


def test_appending_to_the_returned_list_counts():
    def checks():
        problems = []
        problems.append("a")
        problems.append("b")
        return problems

    assert count_checks(checks) == 2


def test_augmented_assignment_into_the_returned_list_counts():
    def checks():
        problems = []
        problems += _helper()
        return problems

    assert count_checks(checks) == 1


def test_a_plain_assignment_from_a_call_counts():
    """The spelling that used to count zero and go red on a working model."""
    def checks():
        problems = _helper()
        return problems

    assert count_checks(checks) == 1


def test_a_body_with_no_check_at_all_counts_zero():
    def checks():
        x = 1
        y = x + 1
        return None

    assert count_checks(checks) == 0


def test_a_comprehension_standing_in_for_the_list_is_uncountable():
    def checks():
        problems = []
        return [p for p in problems if p]

    assert count_checks(checks) is None


def test_a_conditional_expression_verdict_is_uncountable():
    def checks(strict=False):
        problems = []
        return problems if strict else []

    assert count_checks(checks) is None


def test_a_literal_verdict_is_uncountable():
    def checks():
        return ["the wall is too thin"]

    assert count_checks(checks) is None


def test_a_body_that_only_calls_something_is_uncountable_not_empty():
    def checks():
        _helper()

    assert count_checks(checks) is None


def test_a_function_with_no_readable_source_is_uncountable():
    checks = eval(compile("lambda: None", "<string>", "eval"))
    assert count_checks(checks) is None


# --------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------

def test_a_model_without_checks_is_fine(out_dir):
    assert run_checks(Model(), out_dir) == 0


def test_checks_that_is_not_callable_is_refused(out_dir):
    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks="not a function"), out_dir)
    assert "not a function" in str(exc.value)


def test_an_empty_checks_fails_the_build(out_dir):
    def checks():
        x = 1
        return None

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "contains no check" in str(exc.value)


def test_passing_checks_report_their_count(out_dir):
    def checks():
        assert True, "one"
        assert True, "two"

    assert run_checks(Model(checks), out_dir) == 2


def test_a_failed_assert_becomes_a_build_error_naming_the_line(out_dir):
    def checks():
        assert False, "the wall is 0.4 mm and the nozzle is 0.4 mm"

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "the wall is 0.4 mm" in str(exc.value)
    assert "test_modelchecks.py:" in str(exc.value)


def test_a_returned_list_of_problems_fails_the_build(out_dir):
    def checks():
        problems = []
        problems.append("boss is not on the plate")
        return problems

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "boss is not on the plate" in str(exc.value)


def test_an_empty_returned_list_passes(out_dir):
    def checks():
        problems = []
        if False:
            problems.append("never")
        return problems

    assert run_checks(Model(checks), out_dir) == 1


def test_a_verdict_nobody_can_count_passes_with_an_unknown_count(out_dir):
    def checks():
        return [problem for problem in [] if problem]

    assert run_checks(Model(checks), out_dir) is None


def test_sys_exit_inside_checks_is_turned_into_a_failure(out_dir):
    """Left alone it unwinds past the publish and leaves the build green."""
    def checks():
        import sys

        assert True, "one"
        sys.exit(0)

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "sys.exit" in str(exc.value)


def test_any_other_exception_becomes_a_build_error(out_dir):
    def checks():
        assert True, "one"
        raise KeyError("nozzle")

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "KeyError" in str(exc.value)


def test_a_verdict_that_is_not_strings_is_refused(out_dir):
    def checks():
        problems = []
        problems.append("real")
        return [1, 2]

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "int" in str(exc.value)


# --------------------------------------------------------------------------
# The signature
# --------------------------------------------------------------------------

def test_checks_taking_nothing_is_called_with_nothing(out_dir):
    assert checks_call_args(lambda: None, out_dir) == ()


def test_checks_taking_one_argument_gets_the_build_directory(out_dir):
    def checks(build_dir):
        return None

    assert checks_call_args(checks, out_dir) == (out_dir,)


def test_checks_taking_two_arguments_is_refused(out_dir):
    def checks(a, b):
        return None

    with pytest.raises(BuildError) as exc:
        checks_call_args(checks, out_dir)
    assert "either\nnone, or exactly one" in str(exc.value).replace(" \n", "\n") \
        or "none, or exactly one" in str(exc.value)


def test_a_keyword_only_argument_is_refused_with_a_hint(out_dir):
    def checks(*, out):
        return None

    with pytest.raises(BuildError) as exc:
        checks_call_args(checks, out_dir)
    assert "keyword-only" in str(exc.value)


def test_describe_returned_names_the_element_that_spoils_a_list():
    assert describe_returned(["a", 1]) == "a list containing int"
    assert describe_returned("text") == "str"
    assert describe_returned(["a"]) == "list"


def _helper():
    return []
