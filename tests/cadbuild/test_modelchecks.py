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
    CheckReport,
    call_model,
    checks_call_args,
    count_checks,
    describe_returned,
    fail_site,
    model_site,
    print_check_sections,
    run_checks,
    static_asserts,
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
# Which line a failure is blamed on
# --------------------------------------------------------------------------
# TWO BRANCHES OF `fail_site` HAD NOTHING ON THEM, and both were found by
# mutation rather than by reading: `last = (outside or frames)[-1]` cut down to
# `outside[-1]`, and `if not frames: return ""` deleted outright, each left the
# whole suite green. Neither is decoration -- the regression they guard is an
# IndexError raised INSIDE the `except` handler of `call_model`, which REPLACES
# the BuildError being built and turns exit 3 (the model said no) into exit 4
# (the hub fell over).

def test_a_failure_with_no_frame_outside_the_package_still_names_a_file():
    """The fallback, reached the way it is really reached.

    `call_model` handed one of OUR functions is not a contrivance -- it is what
    a hub bug looks like from here -- and the traceback it catches then holds
    nothing but `modelchecks.py` and `checklib.py`. The test's own frame is not
    on it: a traceback accumulates only up to the frame that CATCHES, and that
    frame is inside `call_model`.

    Without the fallback this is an IndexError leaving the except handler, so
    `pytest.raises(BuildError)` is half of what is being asserted.
    """
    with pytest.raises(BuildError) as exc:
        call_model("parts()", checklib.estimated, 1.0, "")
    message = str(exc.value)
    assert "parts() raised ValueError" in message
    assert "checklib.py:" in message, (
        f"every frame of that traceback is the hub's, and the message names no "
        f"file at all: {message}")


def test_a_failure_with_no_frame_outside_the_package_names_no_model_line():
    """The other half: `model_site` says nothing rather than naming one of ours.

    This is the difference between the two functions, and it is what the IMPORT
    door needs -- a missing model.py leaves a traceback of nothing but hub
    frames, and `importing model.py failed (geometry.py:<line>)` would send the
    author of a missing file to a file of the hub's.
    """
    try:
        checklib.estimated(1.0, "")
    except ValueError as error:
        # Drop this test's own frame, which is the only one outside the package.
        error.__traceback__ = error.__traceback__.tb_next
        assert model_site(error) == "", (
            f"model_site named {model_site(error)!r} for a traceback holding "
            f"nothing but hub frames")
        assert fail_site(error).startswith(" (checklib.py:"), (
            "and fail_site, which is the one that falls back, still names ours")
    else:
        pytest.fail("estimated() with an empty note is supposed to refuse")


def test_an_exception_that_was_never_raised_names_no_site():
    """No traceback at all is `[]`, and `[][-1]` is an IndexError.

    An exception object that has never been raised carries no traceback, and
    both of these functions are called from inside an `except` that is
    assembling a refusal -- which is the one place a raise costs the most: it
    REPLACES that refusal, turning exit 3 into exit 4. The guard is one line and
    this is what says it is there.
    """
    assert fail_site(ValueError("never raised")) == ""
    assert model_site(ValueError("never raised")) == ""


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
            assert _helper() == [], "one"

    assert run_checks(Model(checks), out_dir) == CheckReport(1, 0)
    assert list(checklib.recorded_sections()) == ["the joint"]


def test_a_function_with_no_readable_source_is_uncountable():
    checks = eval(compile("lambda: None", "<string>", "eval"))
    assert count_checks(checks) is None


# --------------------------------------------------------------------------
# Running
# --------------------------------------------------------------------------

def test_a_model_without_checks_is_fine(out_dir):
    assert run_checks(Model(), out_dir) == CheckReport(0, 0)


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
        assert _helper() == [], "one"
        assert not _helper(), "two"

    assert run_checks(Model(checks), out_dir) == CheckReport(2, 0)


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

    assert run_checks(Model(checks), out_dir) == CheckReport(1, 0)


def test_a_verdict_nobody_can_count_passes_with_an_unknown_count(out_dir):
    def checks():
        return [problem for problem in [] if problem]

    assert run_checks(Model(checks), out_dir) == CheckReport(None, 0)


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


# --------------------------------------------------------------------------
# Asserts the constants settle on their own
# --------------------------------------------------------------------------
# What the analysis finds is a printed NOTE and never a refusal, so the failure
# that costs here is the false positive: `assert FIT_MIN < FIT_MAX` is a
# deliberate guard on the parameter table and has the identical shape to the
# tautology, and this file is shared by every project in the organisation. That
# is why the first test below is the working check that must NOT be flagged.
#
# The constants are module-level because a checks() written here is an ordinary
# nested function whose globals are this test module. In a real build the two
# are one thing -- checks() is defined in model.py and `vars(model)` is exactly
# what run_checks hands the analysis -- so the tests that RUN a checks() put
# the same names in both places.

FIT_MIN = 0.1
FIT_MAX = 0.4
GAP = 0.2
LIP_CLEARANCE = 0.2
WALL = 1.2
SIZES = (10.0, 20.0)

_CONSTANTS = {"FIT_MIN": FIT_MIN, "FIT_MAX": FIT_MAX, "GAP": GAP,
              "LIP_CLEARANCE": LIP_CLEARANCE, "WALL": WALL, "SIZES": SIZES}


def test_a_check_that_measures_is_not_static_for_naming_two_constants():
    """FIRST, because a false red on a working model is what this costs.

    `gap` is what the loop measured, so the constants on either side of it
    settle nothing -- and the namespace here deliberately holds a `gap` of its
    own, which is the module constant this would read if it did not know the
    body binds the name first.
    """
    def checks():
        for face, gap in _helper():
            assert FIT_MIN <= gap <= FIT_MAX, f"{face}: {gap}"

    assert static_asserts(checks, dict(_CONSTANTS, gap=0.25)) == []


def test_both_asserts_the_constants_settle_are_found_with_their_own_lines():
    """The line numbers are the ones in the file, so an author can open them."""
    import inspect

    def checks():
        assert FIT_MIN < FIT_MAX
        assert abs((LIP_CLEARANCE - GAP) - 0.0) < 1e-9

    found = static_asserts(checks, _CONSTANTS)
    start = inspect.getsourcelines(checks)[1]
    assert found == [
        (start + 1, "assert FIT_MIN < FIT_MAX"),
        (start + 2, "assert abs((LIP_CLEARANCE - GAP) - 0.0) < 1e-9"),
    ]


def test_a_name_the_body_assigns_is_not_a_constant():
    def checks():
        WALL = len(_helper())
        assert WALL < 1.2

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_name_the_body_adds_to_is_not_a_constant():
    """`+=` binds the name as surely as `=` does.

    These bodies are parsed and never run, which is what lets the augmented
    assignment be the ONLY binding of the name here -- the form under test.
    """
    def checks():
        WALL += len(_helper())
        assert WALL < 1.2

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_loop_target_is_not_a_constant():
    def checks():
        for GAP in _helper():
            assert GAP > 0.0

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_with_target_is_not_a_constant():
    def checks():
        with _timer("the joint") as WALL:
            assert WALL == 1.2

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_walrus_target_is_not_a_constant():
    def checks():
        if (GAP := len(_helper())) >= 0:
            assert GAP < 0.4

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_nested_function_name_is_not_a_constant():
    """A bare `assert WALL` on a name the module holds 1.2 under is decided.

    On a name the body defines a function under it is not, and the two are the
    same three characters of source.
    """
    def checks():
        def WALL():
            return _helper()

        assert WALL

    assert static_asserts(checks, _CONSTANTS) == []


# ONE CASE PER BINDING FORM `local_names` CLAIMS, and they are all the same
# test: a name the body binds is not the module constant of the same spelling.
# They pin the ONE direction that must never be wrong -- missing a tautology
# costs an unprinted note, calling a working check a tautology prints a false
# accusation and quietly lowers the number beside it. Every body below is parsed
# and never run, which is what lets each hold exactly the one form under test.

def test_a_match_capture_is_not_a_constant():
    """All three binders a pattern can carry, because all three had to be added.

    `case (WALL,)` is a MatchAs, `*GAP` a MatchStar, `**SIZES` a MatchMapping
    rest -- three node types, none of them an Assign, and every one of them a
    name this module holds a number under. Before they were listed, `case (WALL,
    other):` bound nothing as far as the analysis could see and the assert below
    was read against the module's 1.2.
    """
    def checks():
        match _helper():
            case (WALL,):
                assert WALL > 1.0
            case [_, *GAP]:
                assert GAP > 0.1
            case {"face": _, **SIZES}:
                assert len(SIZES) == 2

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_comprehension_target_is_not_a_constant():
    def checks():
        measured = [face for WALL, face in _helper()]
        assert WALL < 2.0, measured

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_parameter_of_checks_itself_is_not_a_constant():
    """The build directory arrives this way, and so does any name beside it."""
    def checks(WALL):
        assert WALL > 1.0

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_name_declared_global_is_not_a_constant():
    """`global` alone, with no assignment under it -- the form on its own.

    What the module holds under the name at import time says nothing about what
    a body that declares it global put there.
    """
    def checks():
        global WALL
        assert WALL > 1.0

    assert static_asserts(checks, _CONSTANTS) == []


def test_an_except_alias_is_not_a_constant():
    def checks():
        try:
            _helper()
        except ValueError as WALL:
            assert WALL

    assert static_asserts(checks, _CONSTANTS) == []


def test_an_import_alias_is_not_a_constant():
    def checks():
        import contextlib as WALL
        from math import pi as GAP

        assert WALL
        assert GAP > 0.1

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_nested_class_name_is_not_a_constant():
    """The same three characters of source as `assert WALL` on the constant."""
    def checks():
        class WALL:
            pass

        assert WALL

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_name_holding_something_other_than_a_number_settles_nothing():
    """A module's namespace holds its functions and its solids too.

    Neither has a value this can reason about, and treating one as a constant
    would be the analysis inventing a fact rather than finding one.
    """
    def checks():
        assert measure
        assert TABLE == {}

    assert static_asserts(checks, {"measure": _helper, "TABLE": {}}) == []


def test_the_permitted_builtins_are_worked_out_and_nothing_else_is():
    """abs/min/max are pure, total and cheap; a call to anything else is not."""
    def checks():
        assert abs(GAP - LIP_CLEARANCE) < 1e-9
        assert min(FIT_MIN, FIT_MAX) == FIT_MIN
        assert max(SIZES) == 20.0
        assert open("model.py")

    found = [text for _, text in static_asserts(checks, _CONSTANTS)]
    assert len(found) == 3
    assert not any("open(" in text for text in found)


def test_a_huge_exponent_is_neither_worked_out_nor_called_static():
    """`2 ** 10 ** 10` is a legal expression and a build hung on an analysis.

    The number is never built: the exponent is over MAX_STATIC_POW, so the
    expression is undecidable and the assert is left alone. That this test
    finishes at all -- rather than in an hour, or in the OOM killer -- is half
    of what it asserts.
    """
    def checks():
        assert 2 ** 10 ** 10 > 0

    assert static_asserts(checks, _CONSTANTS) == []


def test_a_checks_with_no_readable_source_yields_nothing_and_does_not_raise():
    """This runs on a build whose checks have all passed already.

    Nothing about a printed note is worth failing that build over, so a source
    that cannot be read is silence rather than an exception.
    """
    compiled = eval(compile("lambda: None", "<string>", "eval"))
    assert static_asserts(compiled, _CONSTANTS) == []
    assert static_asserts(len, _CONSTANTS) == []


def test_an_assert_too_deep_to_analyse_does_not_take_the_build_down_with_it(
        tmp_path):
    """The same promise, on the path that used to break it.

    `static_value` recurses by expression DEPTH, so a long enough chain of terms
    raises RecursionError -- which is not one of the three the reading used to
    catch, and which escaped into `run_checks` AFTER every check of the model
    had already passed. A green build then crashed over a printed note.

    IT NEEDS A REAL FILE ON DISK: `inspect.getsourcelines` is the first thing
    `static_asserts` does, and a function compiled from a string fails there
    instead -- which is the test above, and would pass here whatever the
    analysis did afterwards. What is asserted is that the call RETURNS rather
    than what it returns, because whether this particular body reaches the limit
    is a property of the interpreter's recursion limit and not of this file: a
    python that works it out reports one static assert, entirely correctly.
    """
    import inspect

    module = tmp_path / "deep_model.py"
    source = "def checks():\n    assert 1 " + "+ 1 " * 2000 + "> 0\n"
    module.write_text(source, encoding="utf-8")
    namespace = {}
    exec(compile(source, str(module), "exec"), namespace)
    # The source really is readable, so the answer below comes from the
    # analysis and not from the reading giving up before it starts.
    assert inspect.getsourcelines(namespace["checks"])[0][0].startswith("def ")

    assert isinstance(static_asserts(namespace["checks"], namespace), list)


def test_run_checks_warns_about_a_constant_assert_and_takes_it_off_the_count(
        out_dir, capsys):
    def checks():
        assert FIT_MIN < FIT_MAX
        assert _helper() == [], "the one that reads the shape"

    model = Model(checks)
    vars(model).update(_CONSTANTS)
    assert run_checks(model, out_dir) == CheckReport(1, 1)
    out = capsys.readouterr().out
    # "1 more", not "1 of them": the static assert is NOT one of the 1 that
    # passed -- it was subtracted out of that number a line earlier.
    assert "checks: 1 passed (1 more decided by the constants alone)" in out
    assert "`assert FIT_MIN < FIT_MAX` is decided by the constants" in out


def test_a_checks_made_only_of_constant_asserts_still_builds(out_dir, capsys):
    """`passed` goes to None -- "count unknown" -- and NEVER to 0.

    DO NOT "FIX" THIS INTO A REFUSAL. 0 is what the refusal above is written
    against ("checks() is defined but contains no check"), and this is
    deliberately not one: `assert FIT_MIN < FIT_MAX` is a guard on the
    parameter table with the identical shape, this file is shared by every
    project in the organisation, and a false red on somebody's working model
    costs far more than an unprinted number. The build goes through and the log
    says what it noticed.
    """
    def checks():
        assert FIT_MIN < FIT_MAX
        assert FIT_MAX < WALL

    model = Model(checks)
    vars(model).update(_CONSTANTS)
    assert run_checks(model, out_dir) == CheckReport(None, 2)
    assert ("checks: passed (count unknown, 2 decided by the constants alone)"
            in capsys.readouterr().out)


def _helper():
    return []


@contextlib.contextmanager
def _timer(label):
    """A stand-in for `checklib.section`, so the counting tests above say
    something about the COUNTER rather than about that function."""
    yield label
