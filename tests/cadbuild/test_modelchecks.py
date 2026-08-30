"""The model's own checks(), and the counting that makes an empty one fail.

The rule this module enforces is the awkward one: a checks() that asserts
nothing passes every build and prints that the model was checked. So the number
of checks is read out of the source, and zero is a failure -- while anything
the counter cannot read has to end at "unknown" and never at zero, because this
code is shared by every project and a wrong "empty checks()" would go red on
somebody's working model.
"""

import contextlib
import sys

import pytest

from src.cadbuild import checklib, modelchecks
from src.cadbuild.errors import BuildError
from src.cadbuild.modelchecks import (
    SECTION_FLOOR,
    checks_call_args,
    count_checks,
    describe_returned,
    print_check_sections,
    run_checks,
)


@pytest.fixture(autouse=True)
def clean_sections():
    """`checklib._SECTIONS` accumulates over a run, and run_checks prints it.

    Both ends, like the conftest guard one level up: a section left behind
    would come out in the log of every later test that runs checks(), attached
    to a build that never measured it.
    """
    checklib._SECTIONS.clear()
    yield
    checklib._SECTIONS.clear()


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


# --------------------------------------------------------------------------
# Counting through a `with` block
# --------------------------------------------------------------------------
#
# THIS IS WHY `checklib.section` IS A CONTEXT MANAGER AND NOT A DECORATOR. The
# count is read out of the SOURCE of checks(), and a checks() whose body holds
# no check fails the build outright -- so a decorator that moved the body into
# helpers would leave every model that marked its timings with an "empty
# checks()". A `with` leaves the asserts where they are. That was true of the
# counter as it stood, before section() existed, and these two tests are what
# keep it true: without them the template's own checks() could stop counting
# and take down every project made from it.

def test_asserts_inside_a_with_block_are_counted():
    def checks():
        with _timer("the joint"):
            assert 1 == 1, "one"
        with _timer("the plate"):
            assert 2 == 2, "two"

    assert count_checks(checks) == 2


def test_a_problem_list_filled_inside_a_with_block_is_counted():
    def checks():
        problems = []
        with _timer("interference"):
            problems += _helper()
        with _timer("faces"):
            problems.append("a face is not flat")
        return problems

    assert count_checks(checks) == 2


def test_a_with_block_holding_no_check_is_still_uncountable_not_empty():
    """A section around something this cannot read is "unknown", never zero --
    zero fails the build, and the body demonstrably does something."""
    def checks():
        with _timer("whatever"):
            _helper()

    assert count_checks(checks) is None


def test_the_real_section_manager_counts_the_same(out_dir):
    """Not `_timer` but `checklib.section` itself, run for real.

    The tests above use a stand-in so they say something about the COUNTER on a
    machine with no kernel. This one closes the gap between the stand-in and the
    thing a model actually writes.
    """
    def checks():
        with checklib.section("the joint"):
            assert 1 == 1, "one"

    assert run_checks(Model(checks), out_dir) == 1
    assert list(checklib.recorded_sections()) == ["the joint"]


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
# The table of section timings
# --------------------------------------------------------------------------
#
# Seconds are PLANTED rather than measured wherever the layout is what is being
# checked: a test that ran real work long enough to print `0.2s` would be a test
# of the machine's speed, and would fail on a fast one.

def test_nothing_is_printed_when_the_model_marked_no_sections(capsys):
    print_check_sections()
    assert capsys.readouterr().out == ""


def test_the_sections_are_printed_longest_first(capsys):
    checklib._SECTIONS.update({"quick": 0.5, "slow": 9.0, "middling": 2.0})
    print_check_sections()
    lines = capsys.readouterr().out.splitlines()
    assert lines[0] == "check sections:"
    assert lines[1:] == ["  slow: 9.0s", "  middling: 2.0s", "  quick: 0.5s"]


def test_everything_under_the_floor_collapses_into_one_line(capsys):
    """Twelve labels that each round to 0.0s would bury the one line the table
    is read for -- and their COUNT is the fact worth keeping."""
    checklib._SECTIONS["real"] = 4.0
    for index in range(12):
        checklib._SECTIONS[f"tiny {index}"] = SECTION_FLOOR / 4
    print_check_sections()
    lines = capsys.readouterr().out.splitlines()
    assert lines == ["check sections:", "  real: 4.0s", "  other 12 sections: 0.3s"]


def test_a_section_exactly_at_the_floor_gets_a_line_of_its_own(capsys):
    checklib._SECTIONS["borderline"] = SECTION_FLOOR
    print_check_sections()
    assert "borderline" in capsys.readouterr().out


@pytest.fixture
def no_floor(monkeypatch):
    """Print every section by name, however short.

    A section around a test's worth of work takes microseconds, so with the real
    floor these tests would be reading `other 1 sections: 0.0s` and could not
    say WHICH label got there. The floor itself is what the three tests above
    are about; these are about the label arriving at all.
    """
    monkeypatch.setattr(modelchecks, "SECTION_FLOOR", 0.0)


def test_the_table_comes_out_on_a_build_that_failed_its_checks(capsys, out_dir,
                                                               no_floor):
    """THE REASON IT IS PRINTED IN A `finally`. The log of the failed build is
    the one somebody opens, and it is the run whose timing is wanted."""
    def checks():
        with checklib.section("the joint"):
            assert False, "the joint is not flat"

    with pytest.raises(BuildError):
        run_checks(Model(checks), out_dir)
    out = capsys.readouterr().out
    assert "check sections:" in out and "the joint" in out


def test_the_table_comes_out_when_checks_raised_something_else(capsys, out_dir,
                                                              no_floor):
    def checks():
        with checklib.section("probes"):
            raise KeyError("nozzle")

    with pytest.raises(BuildError):
        run_checks(Model(checks), out_dir)
    assert "probes" in capsys.readouterr().out


def test_a_broken_table_cannot_mask_the_check_that_failed(capsys, out_dir,
                                                          monkeypatch):
    """An exception out of a `finally` REPLACES the one on its way out.

    Without the blanket catch inside it, a bug in the printing would take the
    place of the BuildError naming the failed check -- the build would still go
    red, for the wrong reason, and the real one would be gone. Provoked rather
    than trusted, because the whole point is that it happens on the failure
    path, which is where nobody looks.
    """
    def exploding():
        raise RuntimeError("the printer is on fire")

    monkeypatch.setattr(modelchecks, "print_check_sections", exploding)

    def checks():
        assert False, "the wall is 0.4 mm and the nozzle is 0.4 mm"

    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)
    assert "the wall is 0.4 mm" in str(exc.value), (
        "the verdict has to survive a printing failure")
    assert "the printer is on fire" in capsys.readouterr().out, (
        "and the printing failure itself has to be said out loud, not swallowed")


class _ClosedStdout:
    """A stdout that raises on write, the way a closed one does.

    Not a mock of a bug: this is the ONE realistic failure of a function whose
    whole job is printing. The handler above reports the failure by printing,
    so on this stream the handler raises the same error the handler exists to
    contain -- out of the `finally`, replacing the verdict.

    Every attempted write is recorded BEFORE it raises, which is what lets a
    test tell "the finally leaked" from "a later print failed": both surface as
    the same ValueError, but only one of them ever reaches the line after.
    """

    def __init__(self):
        self.attempts = []

    def write(self, text):
        self.attempts.append(text)
        raise ValueError("I/O operation on closed file")

    def flush(self):
        raise ValueError("I/O operation on closed file")


def test_a_stdout_that_cannot_be_written_to_does_not_replace_the_verdict(
        out_dir, monkeypatch):
    """The failure the RESCUE print introduces, on the run that went red.

    Reproduced before the inner guard: the build reported `ValueError: I/O
    operation on closed file` and the assert that actually failed was gone.

    The section is load-bearing, not decoration: with nothing recorded
    `print_check_sections` returns before printing anything, so a table that
    was never printed cannot fail and this test would pass on the broken code.
    """
    def checks():
        with checklib.section("the part that goes wrong"):
            assert False, "the wall is 0.4 mm and the nozzle is 0.4 mm"

    monkeypatch.setattr(sys, "stdout", _ClosedStdout())
    with pytest.raises(BuildError) as exc:
        run_checks(Model(checks), out_dir)

    assert "the wall is 0.4 mm" in str(exc.value), (
        "a stdout that cannot be written to must not become the verdict")


def test_a_stdout_that_cannot_be_written_to_does_not_fail_a_green_build(
        out_dir, monkeypatch):
    """And the worse half: with every check passing there is no verdict to
    replace, so the substitution turns a build with nothing wrong in it red.

    Every print in this function fails on this stream, the `checks: N passed`
    one included, so the ValueError is expected -- what is asserted is WHERE it
    got to. Reaching that last line at all is only possible by coming out of
    the `finally` normally; a leak stops inside the timing table, and the only
    write ever attempted is its header.
    """
    def checks():
        with checklib.section("everything is fine"):
            assert True, "one"

    stdout = _ClosedStdout()
    monkeypatch.setattr(sys, "stdout", stdout)
    with pytest.raises(ValueError):
        run_checks(Model(checks), out_dir)

    assert any("passed" in text for text in stdout.attempts), (
        "run_checks never got past the timing table -- the printing error "
        f"escaped the finally. Writes attempted: {stdout.attempts}")


def test_the_table_reaches_the_module_the_model_filled(out_dir, capsys, no_floor):
    """The model's `import checklib` and the core's are one module or the table
    is empty for a run that measured itself -- the same trap
    `geometry._warn_if_checklib_shadowed` exists for."""
    import checklib as top_level

    def checks():
        with top_level.section("through the shim"):
            assert True, "one"

    run_checks(Model(checks), out_dir)
    assert "through the shim" in capsys.readouterr().out


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


@contextlib.contextmanager
def _timer(label):
    """A stand-in for `checklib.section`, so the counting tests above say
    something about the COUNTER rather than about that function."""
    yield label
