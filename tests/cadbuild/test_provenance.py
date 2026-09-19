"""Where a model's numbers came from, and the rule that refuses a bare one.

NO CAD KERNEL ANYWHERE IN HERE, deliberately: the whole of this is a walk over
a module's globals and over the syntax tree of the file it came from, so it
runs in the CI container as well as on a workstation. That matters more than
usual here — the rule can refuse a push, and a refusal nobody can reproduce in
CI is one that gets loosened by whoever meets it first.

The models are real modules loaded off real files rather than namespaces built
by hand, because half of what is under test is read from the FILE: the line a
name is written on, and which names the file assigns at all.
"""

import ast
import contextlib
import json
import math
import pickle
import sys
import textwrap
import types
from pathlib import Path
import importlib.util

import pytest

# Imported for its side effect on sys.modules as much as for the name: the
# models below say `import checklib`, and `_loaded` sweeps away every module
# their import brought in FROM THE PROJECT DIRECTORY only. Having the real one
# already here keeps that sweep from ever being the first to meet it.
import checklib as _top_level_checklib  # noqa: F401
import modulesource
from src.cadbuild import checklib, modeltext, provenance
from src.cadbuild.errors import BuildError


# --------------------------------------------------------------------------
# Loading a model the way the build does
# --------------------------------------------------------------------------

@contextlib.contextmanager
def _importable(root):
    """`root` first on sys.path, and every module it supplied swept after.

    Only the modules whose CODE is INSIDE the scratch project are removed. A
    blanket sweep would also take `checklib` when a model's import happened to
    be the first one in the process, and a second import would then build a
    SECOND module object with a second `_INTERFERENCE` — which is the exact
    failure the shim and the conftest guard exist for.

    "WHERE ITS CODE IS" IS `modulesource.came_from` AND NOT `__file__`, which is
    what stood here: a namespace package — a directory with no `__init__.py`,
    which is what a project keeping its mocks in a `mocks/` directory has —
    carries `__file__ is None` and its location in `__path__` alone, so it
    walked through this sweep and stayed in `sys.modules` for the rest of the
    session. The two sweeps in `tests/test_template.py` had the same hole and
    now share the same answer.
    """
    before = set(sys.modules)
    sys.path.insert(0, str(root))
    try:
        yield
    finally:
        sys.path.remove(str(root))
        for name in set(sys.modules) - before:
            if modulesource.came_from(sys.modules[name], str(root)):
                del sys.modules[name]


def a_model(root, source, **beside):
    """Write a model.py (and anything beside it) and import it. -> the module.

    Never registered in `sys.modules`: this is a fixture, not a name anything
    else should be able to reach.
    """
    # The leading newline of a `\"\"\"` block goes, so line 1 of the file is the
    # first line WRITTEN in the test. Several tests below assert a line number,
    # and off-by-one there would be a test agreeing with an implementation
    # detail of how the source was quoted.
    for name, text in beside.items():
        path = root / f"{name}.py"
        path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")
    path = root / "model.py"
    path.write_text(textwrap.dedent(source).lstrip("\n"), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("model_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with _importable(root):
        spec.loader.exec_module(module)
    return module


def gate(root, source, **beside):
    """collect + unwrapped + check, exactly as `build()` calls them."""
    model = a_model(root, source, **beside)
    entries = provenance.collect(model)
    provenance.check(entries, provenance.unwrapped(model), Path(root))
    return entries


def journal(root, text="# Measurements\n\n## Lid fit\n\n0.25 mm\n"):
    (root / "ref").mkdir(exist_ok=True)
    (root / "ref" / "measurements.md").write_text(text, encoding="utf-8")


# --------------------------------------------------------------------------
# Number itself
# --------------------------------------------------------------------------

def test_a_measured_number_is_the_number_it_wraps():
    value = checklib.measured(0.25, "ref/measurements.md")
    assert value == 0.25
    assert float(value) == 0.25
    assert f"{value}" == "0.25"
    assert value.kind == checklib.MEASURED
    assert value.source == "ref/measurements.md"


def test_provenance_does_not_survive_arithmetic():
    """AN ACCEPTED DECISION, pinned so it is not "fixed" into propagation.

    `a * 2` is a plain float. A number worked out from other numbers has to say
    so with `derived()`, which is a sentence about WHICH numbers — and a rule
    that inferred provenance would be inventing that sentence.
    """
    value = checklib.measured(0.25, "ref/measurements.md")
    for computed in (value * 2, value + 1, value / 2, -value, abs(value),
                     round(value, 1)):
        assert isinstance(computed, float)
        assert not isinstance(computed, checklib.Number), (
            f"{computed!r} carried provenance out of an arithmetic operation")


def test_a_number_that_cannot_be_compared_is_not_a_measurement():
    for bad in (math.nan, math.inf, -math.inf, float("nan")):
        with pytest.raises(ValueError, match="finite"):
            checklib.measured(bad, "ref/measurements.md")
        with pytest.raises(ValueError, match="finite"):
            checklib.derived(bad, "from the others")
        with pytest.raises(ValueError, match="finite"):
            checklib.estimated(bad, "a print would settle it")


def test_a_declaration_with_nothing_to_say_is_refused():
    """The sentence IS the declaration; without it this is the bare constant."""
    with pytest.raises(ValueError, match="source"):
        checklib.measured(1.0, "")
    with pytest.raises(ValueError, match="note"):
        checklib.derived(1.0, "")
    with pytest.raises(ValueError, match="note"):
        checklib.estimated(1.0, "")


def test_a_kind_nobody_defined_is_refused():
    with pytest.raises(ValueError, match="guessed"):
        checklib.Number(1.0, "guessed")


def test_a_note_that_is_not_a_sentence_is_refused():
    with pytest.raises(TypeError, match="note"):
        checklib.estimated(1.0, 42)


def test_a_declared_number_does_not_change_after_it_is_declared():
    """The three fields are read-only, and what that closes is a CRASH.

    They were plain slots, so `n.kind = "guessed"` took -- and `report()`, which
    indexes its counts by kind, then raised a bare `KeyError`. A KeyError is not
    a `BuildError`, so the build ended in a traceback rather than in a message
    saying what was wrong. The value itself is already immutable, this being a
    float; making the provenance match it is what turns "a number's provenance
    is fixed at the point it is written" into something that holds.
    """
    value = checklib.measured(0.25, "ref/measurements.md#lid-fit", "caliper")
    for field in ("kind", "source", "note"):
        with pytest.raises(AttributeError):
            setattr(value, field, "guessed")
        with pytest.raises(AttributeError):
            delattr(value, field)
    assert (value.kind, value.source, value.note) == (
        checklib.MEASURED, "ref/measurements.md#lid-fit", "caliper")
    # The path that used to die: a kind report() has no counter for.
    assert provenance.report([provenance.Entry("GAP", value, 1)])["measured"] == 1


def test_a_number_survives_a_pickle_with_all_three_fields():
    """The build runs a model in a process of its own.

    A float subclass with `__slots__` and no `__reduce__` comes back as its
    VALUE alone — no kind, no source, no note, and nothing raised. That is data
    loss with no symptom, which is why the reducer is written out.
    """
    value = checklib.measured(0.25, "ref/measurements.md#lid-fit",
                              "caliper, 3 samples")
    back = pickle.loads(pickle.dumps(value))
    assert isinstance(back, checklib.Number)
    assert back == 0.25
    assert (back.kind, back.source, back.note) == (
        checklib.MEASURED, "ref/measurements.md#lid-fit", "caliper, 3 samples")


def test_every_kind_survives_a_pickle():
    for value in (checklib.derived(2.5, "SCREW_DIA less 0.5"),
                  checklib.estimated(2.4, "a print would settle it")):
        back = pickle.loads(pickle.dumps(value))
        assert (float(back), back.kind, back.source, back.note) == (
            float(value), value.kind, value.source, value.note)


# --------------------------------------------------------------------------
# collect() — the inventory
# --------------------------------------------------------------------------

def test_collect_finds_a_number_in_the_globals(isolated_project):
    journal(isolated_project)
    model = a_model(isolated_project, """
        import checklib

        GAP = checklib.measured(0.25, "ref/measurements.md#lid-fit")
    """)
    assert [(entry.name, float(entry.number))
            for entry in provenance.collect(model)] == [("GAP", 0.25)]


def test_collect_walks_one_level_into_a_dict_and_a_list(isolated_project):
    """A table of clearances is an ordinary way to hold them."""
    model = a_model(isolated_project, """
        import checklib

        CLEARANCES = {"lid": checklib.estimated(0.25, "print it")}
        SIZES = [checklib.estimated(10.0, "print it"),
                 checklib.estimated(20.0, "print it")]
        PAIR = (checklib.estimated(1.0, "print it"),)
    """)
    assert {entry.name for entry in provenance.collect(model)} == {
        "CLEARANCES['lid']", "SIZES[0]", "SIZES[1]", "PAIR[0]"}


def test_collect_does_not_walk_inside_an_arbitrary_object(isolated_project):
    """DOCUMENTED AS NOT WALKED: a walk that follows arbitrary objects is a
    walk into a CAD kernel, and one level of container is where it stops."""
    model = a_model(isolated_project, """
        import checklib


        class Box:
            def __init__(self):
                self.gap = checklib.estimated(0.25, "print it")


        BOX = Box()
        NESTED = [[checklib.estimated(0.5, "print it")]]
    """)
    assert provenance.collect(model) == []


def test_collect_is_not_limited_to_upper_snake(isolated_project):
    """The inventory is every Number there is; the RULE is what looks at case."""
    model = a_model(isolated_project, """
        import checklib

        gap = checklib.estimated(0.25, "print it")
    """)
    assert [entry.name for entry in provenance.collect(model)] == ["gap"]


# --------------------------------------------------------------------------
# The rule
# --------------------------------------------------------------------------

def test_a_bare_number_refuses_the_build(isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, "GAP = 0.2\n")
    assert "GAP" in str(exc.value)


def test_the_same_number_declared_builds(isolated_project):
    gate(isolated_project, """
        import checklib

        GAP = checklib.estimated(0.2, "a print would settle it")
    """)


def test_every_bare_number_is_listed_in_one_message_with_its_line(
        isolated_project):
    """Running the build one name at a time is the same hell as failing on the
    first unresolved source."""
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, """
            LENGTH = 60.0
            WIDTH = 40.0
            HEIGHT = 20.0
        """)
    message = str(exc.value)
    for name, line in (("LENGTH", 1), ("WIDTH", 2), ("HEIGHT", 3)):
        assert f"line {line}: {name} = " in message, message


def test_the_message_shows_all_three_ways_out_on_a_real_name(isolated_project):
    """`estimated` included, because it is the one that always builds."""
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, "GAP = 0.2\n")
    message = str(exc.value)
    assert "checklib.measured(0.2," in message
    assert "checklib.derived(0.2," in message
    assert "checklib.estimated(0.2," in message
    assert "GAP" in message


# -- each boundary of the rule, one at a time --------------------------------

def test_an_integer_is_a_count_and_not_a_dimension(isolated_project):
    gate(isolated_project, "ANGLES = 24\nMIN_STL_BYTES = 1024\n")


def test_a_lowercase_name_is_outside_the_rule(isolated_project):
    gate(isolated_project, "gap = 0.2\n")


def test_an_import_binds_no_name_this_walk_reads(isolated_project):
    """RETITLED to what it pins. It used to be called "an imported LOWERCASE
    float is outside the rule", and it passed for a reason that had nothing to
    do with case: an `ImportFrom` puts nothing into `module_bindings` at
    all, so `pi` never reaches the UPPER_SNAKE filter and the test stayed green
    with `UPPER_SNAKE` deleted outright. The case half is
    `test_a_lowercase_name_is_outside_the_rule` above; this is the import half,
    and it says so by asserting the value really is there and really is a float.
    """
    model = a_model(isolated_project, "from math import pi\n")
    assert isinstance(model.pi, float) and not isinstance(model.pi,
                                                          checklib.Number)
    assert provenance.unwrapped(model) == []
    assert provenance.collect(model) == []


def test_a_bare_number_inside_a_list_is_refused(isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, "SIZES = [10.0, 20.0]\n")
    message = str(exc.value)
    assert "SIZES[0]" in message and "SIZES[1]" in message


def test_a_declared_number_inside_a_list_builds(isolated_project):
    gate(isolated_project, """
        import checklib

        SIZES = [checklib.estimated(10.0, "print it"),
                 checklib.estimated(20.0, "print it")]
    """)


def test_a_bare_number_inside_a_dict_value_is_refused(isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, "CLEARANCES = {'lid': 0.25}\n")
    assert "CLEARANCES['lid']" in str(exc.value)


def test_a_bool_is_neither_a_number_nor_a_bare_float(isolated_project):
    """A fact about python rather than a line of code: `bool` is not a subclass
    of `float`, so it enters neither branch of the walk. Nothing in the source
    can say that, so it is said here."""
    assert not isinstance(True, float)
    model = a_model(isolated_project, "DRAFT = True\n")
    assert provenance.collect(model) == []
    assert provenance.unwrapped(model) == []


def test_a_name_assigned_twice_reports_both_lines(isolated_project):
    """EVERY line that binds it, in the order they are written.

    It used to report the last one only, on the argument that python binds the
    name there. True of straight-line code -- this case -- and the three tests
    below are the ones where it is false.
    """
    model = a_model(isolated_project, """
        GAP = 0.2
        GAP = 0.4
    """)
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.4, (1, 2))
    with pytest.raises(BuildError) as exc:
        provenance.check([], [bare], Path(isolated_project))
    assert "lines 1, 2: GAP" in str(exc.value)


def test_one_set_of_lines_has_one_phrase():
    """`at_lines` sorts and deduplicates, so no caller has to.

    It used to do neither, and the only caller made up half the difference:
    `module_level_lines` runs its lines through `dict.fromkeys`, so duplicates
    were gone before the phrase was built while ORDER was whatever the walk
    found. That left a function whose answer depended on how it was called --
    `lines 2, 1` and `lines 1, 2` for the same two lines -- with the property
    the message needs living in a different module.
    """
    assert provenance.at_lines(3) == "line 3"
    assert provenance.at_lines([3]) == "line 3"
    assert provenance.at_lines([2, 1]) == "lines 1, 2"
    assert provenance.at_lines([1, 1]) == "line 1"
    assert provenance.at_lines([5, 1, 5]) == "lines 1, 5"


@pytest.mark.parametrize("source, phrase", [
    # OUT OF ORDER. The walk records a statement's walruses BEFORE its own
    # targets -- which is the order python binds them -- so this bound line 2
    # and then line 1, and the message said `lines 2, 1`.
    ("GAP = (\n    GAP := 0.5\n)\n", "lines 1, 2"),
    # TWICE OVER, on one line. `dict.fromkeys` in `module_level_lines` is what
    # kept this reading `line 1` while `at_lines` itself answered `lines 1, 1`.
    ("GAP, GAP = 1.0, 2.0\n", "line 1"),
])
def test_a_name_bound_out_of_order_or_twice_over_reads_as_one_place(
        isolated_project, source, phrase):
    """What the two halves of the fix look like from where an author stands."""
    model = a_model(isolated_project, source)
    bare, = provenance.unwrapped(model)
    with pytest.raises(BuildError) as exc:
        provenance.check([], [bare], Path(isolated_project))
    assert f"{phrase}: GAP" in str(exc.value)


@pytest.mark.parametrize("source, lines", [
    # A BRANCH. Which arm ran is not in the tree, and naming the textually last
    # one sent the author to the `else` of an `if` that took the other arm.
    ("DEBUG = True\nif DEBUG:\n    GAP = 0.2\nelse:\n    GAP = 0.4\n", (3, 5)),
    # The everyday optional-import idiom, where the last line is the one that
    # runs only when the import FAILED -- i.e. usually not the one that ran.
    ("try:\n    import json\n    GAP = 0.2\nexcept ImportError:\n"
     "    GAP = 0.9\n", (3, 5)),
])
def test_a_name_bound_in_two_arms_names_both(isolated_project, source, lines):
    """The claim `line` used to make, falsified by a five-line model.

    No walk over a syntax tree can say which arm ran, so all the lines are named
    and none of them is claimed. The message says `lines 3, 5`, and both are
    lines the author can look at.
    """
    model = a_model(isolated_project, source)
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.line) == ("GAP", lines)


def test_a_bare_annotation_does_not_overwrite_the_line_that_binds(
        isolated_project):
    """`GAP: float` after `GAP = 0.2` is an annotation, not a binding.

    Nothing is evaluated, `vars(model)` never grows the name from it -- and
    recording it as a binding replaced the one line holding a number with a line
    holding none, which is the worst version of the message.
    """
    model = a_model(isolated_project, "GAP = 0.2\nGAP: float\n")
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.2, (1,))


def test_an_annotated_assignment_that_has_a_value_does_bind(isolated_project):
    """The other half of the line above: `GAP: float = 0.2` binds normally."""
    model = a_model(isolated_project, "GAP: float = 0.2\n")
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.2, (1,))


def test_an_imported_upper_snake_float_is_not_refused(isolated_project):
    """A DECISION, not a gap in the walk. The rule is about the numbers written
    in model.py: the refusal names a line, and a line in a file the author is
    not being shown is one they cannot act on."""
    gate(isolated_project, "from helpers import MAX_WIDTH\n",
         helpers="MAX_WIDTH = 10.0\n")


def test_a_number_a_helper_module_declares_is_neither_refused_nor_reported(
        isolated_project):
    """THE PRICE OF THE TEST ABOVE, paid on both halves rather than on one.

    `collect()` used to sweep every name in `vars(model)` while `unwrapped()`
    read the tree, so one rule was about two sets of names: a helper's BARE
    float was deliberately let through (the test above), and the same helper's
    `measured(10.0, "ref/gone.md")` refused the build with a message naming no
    line and no file the author could open. Both halves now read the one walk,
    and what follows from that is this test: a helper's numbers are outside the
    rule entirely -- not refused, and not counted in metrics.json either.
    """
    model = a_model(isolated_project, "from helpers import MAX_WIDTH, LIP\n",
                    helpers="""
        import checklib

        MAX_WIDTH = checklib.measured(10.0, "ref/nowhere.md")
        LIP = 0.5
    """)
    assert provenance.collect(model) == []
    assert provenance.unwrapped(model) == []
    # So it builds: the unresolvable source in the helper is not the model's to
    # answer for, and there is no line here to send anybody to.
    provenance.check(provenance.collect(model), provenance.unwrapped(model),
                     Path(isolated_project))
    assert float(model.MAX_WIDTH) == 10.0, (
        "the helper's number is still bound in the model -- what this test is "
        "about is which names the RULE reads, not what the module holds")


@pytest.mark.parametrize("source, line", [
    # `if`, which is all this used to cover, and its `else`.
    ("if True:\n    GAP = 0.2\n", 2),
    ("if False:\n    pass\nelse:\n    GAP = 0.2\n", 4),
    ("for _ in range(1):\n    GAP = 0.2\n", 2),
    ("while True:\n    GAP = 0.2\n    break\n", 2),
    ("try:\n    GAP = 0.2\nexcept ValueError:\n    pass\n", 2),
    # THE ONE THAT WAS ACTUALLY BROKEN, and the shape it broke on is the
    # everyday optional-import idiom: `except ImportError: GAP = 0.2`. An
    # `ast.ExceptHandler` is not an `ast.stmt` (see the test below), so a walk
    # that gathered children by that test never entered a single handler and
    # `unwrapped()` came back empty on a bare, module-level, UPPER_SNAKE float.
    ("try:\n    raise ValueError\nexcept ValueError:\n    GAP = 0.2\n", 4),
    ("try:\n    pass\nexcept ValueError:\n    pass\nelse:\n    GAP = 0.2\n", 6),
    ("try:\n    pass\nfinally:\n    GAP = 0.2\n", 4),
    ("import contextlib\nwith contextlib.nullcontext():\n    GAP = 0.2\n", 3),
    # And a `match` case, the other body that is not an `ast.stmt`.
    ("match 1:\n    case 1:\n        GAP = 0.2\n", 3),
])
def test_a_name_bound_inside_a_module_level_block_is_still_module_level(
        isolated_project, source, line):
    """Every block form `module_bindings` claims to walk into, one per case.

    The docstring there has always named `if`, `for`, `try` and `with`; only
    `if` was ever tested, and two of the others did not work. A claim that has
    to stay true belongs in a test, so the parametrize list is the claim now.
    """
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, source)
    assert f"line {line}: GAP" in str(exc.value)


def test_the_two_nodes_that_carry_statements_are_not_statements():
    """The fact the walk is built on, and it is not obvious enough to assume.

    `ast.ExceptHandler` and `ast.match_case` hold a body of statements without
    being statements, so `isinstance(child, ast.stmt)` -- the obvious way to
    gather the children worth descending into, and the way this used to do it --
    silently skips both. Said here because nothing in the grammar documentation
    says it in one line, and because the day it stops being true the walk is
    doing extra work rather than missing something.
    """
    for node_type in provenance._CARRIES_STATEMENTS:
        assert not issubclass(node_type, ast.stmt), (
            f"{node_type.__name__} is an ast.stmt now, so the walk no longer "
            f"needs to name it")
        assert issubclass(node_type, ast.AST)


def test_an_augmented_assignment_rebinds_the_name_at_its_own_line(
        isolated_project):
    """The one whose absence produced a WRONG message rather than a miss.

    Provenance deliberately does not survive arithmetic, so `WALL += 0.5` turns
    a declared number into a bare one. With the target not rebound, the refusal
    pointed at the line of the PREVIOUS assignment -- a line holding a perfectly
    correct `checklib.estimated(...)` -- so the author was sent to read code
    that was right.
    """
    model = a_model(isolated_project, """
        import checklib

        WALL = checklib.estimated(2.5, "a guess")
        WALL += 0.5
    """)
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("WALL", 3.0, (3, 4))
    # And it is no longer a declared number at all, which is the other half of
    # why the old message was wrong.
    assert provenance.collect(model) == []


def test_the_expression_an_augmented_assignment_records_is_a_legal_expression():
    """`WALL += 0.5` is recorded as `WALL + 0.5`, and that has to EVALUATE.

    The BinOp is synthesized, and the obvious way to build it -- reuse the
    statement's own target as the left operand -- gives it a `ctx=Store` name.
    It unparses correctly and its positions are right, so nothing shows: the
    node is simply not a legal expression, and `compile` says so. No consumer
    compiles one today, which is exactly why this needs a test rather than a
    comment.
    """
    tree = ast.parse("WALL = 2.0\nWALL += 0.5\n")
    binding = provenance.module_bindings(tree)["WALL"][1]
    assert ast.unparse(binding.value) == "WALL + 0.5"
    code = compile(ast.Expression(body=binding.value), "<synthesized>", "eval")
    assert eval(code, {"WALL": 2.0}) == 2.5


def test_an_augmented_assignment_to_something_that_is_not_a_name_binds_nothing():
    """`SIZES[0] += 0.5` and `obj.gap += 0.5` bind no module-level name.

    Beside the test above because that is the branch the Load-context node is
    built in, and this is the input it must not be built for: there is no `id`
    on a subscript or an attribute target.
    """
    tree = ast.parse("SIZES[0] += 0.5\nCFG.gap += 0.5\n")
    assert provenance.module_bindings(tree) == {}


def test_a_for_loop_binds_its_own_variable(isolated_project):
    """`for GAP in ...` leaves GAP holding the last item, at module level."""
    model = a_model(isolated_project, "for GAP in (0.2,):\n    pass\n")
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.2, (1,))


def test_a_with_binds_what_it_names_after_as(isolated_project):
    model = a_model(isolated_project, """
        import contextlib

        with contextlib.nullcontext(0.2) as GAP:
            pass
    """)
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.2, (3,))


def test_a_walrus_binds_where_it_is_written(isolated_project):
    """`:=` binds in the enclosing scope, which at module level is the module.

    Written inside the `if`'s test rather than as a statement of its own,
    because that is the whole point of the form and the reason a walk over
    assignment targets alone does not see it.
    """
    model = a_model(isolated_project, "if (GAP := 0.2) > 0:\n    pass\n")
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.2, (1,))


def test_a_walrus_is_bound_before_the_body_it_guards(isolated_project):
    """The order the walk visits the three parts of a statement in.

    `if (GAP := 0.2) > 0:` with a `GAP = 0.4` inside it binds line 1 and THEN
    line 2, which is the order python runs them in. The walrus pass used to run
    after the descent, so the lines came out `(2, 1)` -- and while the last one
    won, that was a message pointing at the line that ran FIRST.
    """
    model = a_model(isolated_project, "if (GAP := 0.2) > 0:\n    GAP = 0.4\n")
    bare, = provenance.unwrapped(model)
    assert (bare.name, bare.value, bare.line) == ("GAP", 0.4, (1, 2))


def test_a_walrus_in_a_scope_header_is_a_known_gap(isolated_project):
    """DOCUMENTED, not fixed -- and here so the next reader knows which it is.

    `def f(x=(GAP := 0.2))` really does bind GAP at module level: the default is
    evaluated where the `def` is written. The walk skips a `def` whole, so the
    header goes with it, and the number is neither refused nor counted. Left
    alone because the shape appears in no model anybody has written and entering
    the header of a scope this otherwise never enters is a second boundary to
    keep right. The day that changes, this test is what says so.
    """
    model = a_model(isolated_project, "def f(x=(GAP := 0.2)):\n    return x\n")
    assert model.GAP == 0.2, "python really did bind it at module level"
    assert provenance.unwrapped(model) == []


def test_a_walrus_in_a_lambda_body_binds_nothing_here(isolated_project):
    """The other half of that boundary, and this one REFUSES a good model without it.

    `_bind_walruses` returns at `ast.Lambda`, and the gap above says why: a
    lambda is a scope, so a `:=` in its BODY binds a local of that lambda and
    not a module global. Nothing pinned the line, and `if False:` in its place
    left the whole suite green -- because a walrus in a lambda body appears in
    no test above, and the shapes that do appear are all bound somewhere else
    too, so the extra binding it invents changes no verdict.

    IT CHANGES ONE HERE, and that is what makes this the mutation's witness
    rather than a restatement of the code. `MAX_WIDTH` is bound by a `global`
    inside a function -- deliberately outside the rule (`module_bindings` names
    it), so `vars(model)` holds a bare 4.0 that the walk is not supposed to see
    a line for. Let the lambda's walrus bind the name, and the walk suddenly has
    one: line 6, where nothing of the sort is written, and a model that publishes
    is refused with a message pointing at a lambda.
    """
    model = a_model(isolated_project, """
        def setup():
            global MAX_WIDTH
            MAX_WIDTH = 4.0

        setup()
        PICK = lambda: (MAX_WIDTH := 1.0)
    """)
    assert model.MAX_WIDTH == 4.0, "the `global` really did bind it"
    assert provenance.unwrapped(model) == []
    # And therefore the build is not refused, which is the half a reader cares
    # about: `check` raises on anything `unwrapped` hands it.
    provenance.check([], provenance.unwrapped(model), Path(isolated_project))


def bound_expressions(source):
    """`{name: ['0.4', ...]}` -- what `module_bindings` says each name is bound TO.

    The AST node each `Binding` carries, printed back out. `unwrapped()` cannot
    show it: that half reads the RUNTIME value off `vars(model)`, so it answers
    the same whatever expression the walk recorded -- which is exactly how the
    pairing below came to be pinned by nothing.
    """
    tree = ast.parse(textwrap.dedent(source).lstrip("\n"))
    return {name: [ast.unparse(binding.value) for binding in found]
            for name, found in provenance.module_bindings(tree).items()}


def test_a_tuple_assignment_binds_every_name_it_names(isolated_project):
    """`A, B = 0.4, 0.3` is two bare numbers, at one line, with their OWN values.

    THE EXPRESSION IS THE HALF THAT WAS ASSERTED BY NOTHING. `_paired` is what
    hands each target element the element of the value beside it, and replacing
    it with `[value] * len(elements)` -- i.e. giving both names the whole tuple
    -- left the entire suite green, because everything else here reads the
    runtime value. So the binding is read directly and printed back: with the
    pairing, `BOSS_CHAMFER` is bound to `0.4`; without it, to `(0.4, 0.3)`.
    """
    source = "BOSS_CHAMFER, LIP_CHAMFER = 0.4, 0.3\n"
    model = a_model(isolated_project, source)
    found = {bare.name: bare for bare in provenance.unwrapped(model)}
    assert set(found) == {"BOSS_CHAMFER", "LIP_CHAMFER"}
    assert found["BOSS_CHAMFER"].value == 0.4
    assert found["LIP_CHAMFER"].value == 0.3
    assert found["LIP_CHAMFER"].line == (1,)

    assert bound_expressions(source) == {"BOSS_CHAMFER": ["0.4"],
                                         "LIP_CHAMFER": ["0.3"]}


@pytest.mark.parametrize("source, expected", [
    # A value that is not written out as a tuple cannot be taken apart at all,
    # so both names get the whole expression -- a superset of what each really
    # holds, which never claims less than the truth.
    ("A, B = measure()\n", {"A": ["measure()"], "B": ["measure()"]}),
    # Nor can it when the shapes do not line up.
    ("A, B = 0.4, 0.3, 0.5\n",
     {"A": ["(0.4, 0.3, 0.5)"], "B": ["(0.4, 0.3, 0.5)"]}),
])
def test_a_tuple_that_cannot_be_taken_apart_gives_every_name_the_whole_value(
        source, expected):
    """The fallback `_paired` promises, which is the other half of the pairing.

    Pinned beside it because the two are one decision: pair where the shapes are
    decidable, hand over the whole expression where they are not.
    """
    assert bound_expressions(source) == expected


def test_a_starred_target_binds_the_name_that_collects_the_rest(
        isolated_project):
    """`A, *REST = ...` -- the `ast.Starred` branch of `_bind`, which nothing hit.

    Deleting that branch left the whole suite green while the answer really
    changed: REST is bound by no other form, so it simply vanished from the
    walk, and the two bare floats it holds went unrefused. A starred target also
    makes the element-by-element pairing undecidable -- it consumes an unknown
    number of them -- so every name gets the whole tuple, which is a superset
    and never claims less than the truth.
    """
    source = "A, *REST = 0.4, 0.3, 0.5\n"
    model = a_model(isolated_project, source)
    found = sorted((bare.name, bare.value) for bare in provenance.unwrapped(model))
    assert found == [("A", 0.4), ("REST[0]", 0.3), ("REST[1]", 0.5)]
    assert bound_expressions(source) == {"A": ["(0.4, 0.3, 0.5)"],
                                         "REST": ["(0.4, 0.3, 0.5)"]}


@contextlib.contextmanager
def _a_project_with_its_own_checklib(path):
    """`sys.modules['checklib']` as a project's own older copy would leave it.

    Shaped rather than written to disk, because what the detection turns on is
    the IDENTITY of `recorded_interference` and not where the file sits; a copy
    on disk that imported the same objects would not be a shadow at all.
    """
    import types as _types

    shadow = _types.ModuleType("checklib")
    shadow.__file__ = path
    shadow.recorded_interference = lambda: {}
    saved = sys.modules.get("checklib")
    sys.modules["checklib"] = shadow
    try:
        yield
    finally:
        if saved is None:
            del sys.modules["checklib"]
        else:
            sys.modules["checklib"] = saved


def test_the_refusal_names_a_shadowing_checklib_as_the_cause(isolated_project):
    """A project with its own checklib.py is otherwise told to write what it
    already wrote.

    Shadowing is SUPPORTED -- `geometry._warn_if_checklib_shadowed` warns and
    the build publishes, and the skill says nothing goes red -- so the numbers
    such a project declares are real declarations through a real, older
    `Number`. This rule recognises only the image's class, so they list as bare,
    and the message then reads "these do not say where they came from" about
    lines that plainly do. The refusal stands (there is nothing else it can do
    with a class it cannot recognise); what changes is that it names the cause
    and says what to do instead of the advice that would not help.
    """
    with _a_project_with_its_own_checklib("/models/thing/checklib.py"):
        with pytest.raises(BuildError) as exc:
            gate(isolated_project, "GAP = 0.2\n")
    message = str(exc.value)
    assert "/models/thing/checklib.py" in message, "it names the file to delete"
    assert "delete" in message
    assert "AttributeError" in message, (
        "and warns that the ordinary advice can fail against an older copy")


def test_the_refusal_says_nothing_about_shadowing_when_there_is_none(
        isolated_project):
    """The other half: an ordinary project's message is not carrying a paragraph
    about a file it does not have."""
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, "GAP = 0.2\n")
    assert "checklib.py" not in str(exc.value)


def test_the_shadow_detection_is_geometrys_and_is_called_not_repeated():
    """One implementation, and this is what says so.

    The question -- which attribute identity distinguishes the image's checklib
    from an older copy -- is exactly the sort a second implementation gets
    subtly wrong, and there are two callers now: the warning `geometry` prints
    and the sentence `provenance` appends to its refusal.
    """
    from src.cadbuild import geometry

    assert provenance.checklib_shadow is geometry.checklib_shadow
    assert geometry.checklib_shadow() is None, (
        "the real one is imported in this process, so nothing is shadowed")
    with _a_project_with_its_own_checklib("/elsewhere/checklib.py"):
        assert geometry.checklib_shadow() == "/elsewhere/checklib.py"


def test_a_float_two_containers_deep_is_not_seen(isolated_project):
    """THE GAP IN THE RULE, tested from the side a reader has to know about.

    `collect()` walks one level into a dict, list or tuple and no further, and
    the test next door says a declared Number two levels down is not counted.
    This is the same boundary read the other way: a BARE float nested twice is
    not refused either, so `TABLE = {'m3': {'dia': 3.0}}` builds. A set is the
    same gap by a different route -- `_one_level` knows dict, list and tuple,
    so `SIZES = {10.0, 20.0}` is not looked into at all.

    Both are deliberate: a walk that follows arbitrary objects is a walk into a
    CAD kernel. Written down as a test rather than a comment because it is the
    one way an author can put a number in a model and have the rule say nothing.
    """
    gate(isolated_project, "TABLE = {'m3': {'dia': 3.0}}\nSIZES = {10.0, 20.0}\n")
    model = a_model(isolated_project,
                    "TABLE = {'m3': {'dia': 3.0}}\nSIZES = {10.0, 20.0}\n")
    assert provenance.unwrapped(model) == []


def test_a_local_inside_a_function_is_not_a_module_level_name(isolated_project):
    gate(isolated_project, """
        def build():
            GAP = 0.2
            return GAP
    """)


# --------------------------------------------------------------------------
# Resolving a measurement's source
# --------------------------------------------------------------------------

def measured_model(source):
    """A model whose one number is measured against `source`.

    The project root is not a parameter and never was one: this returns TEXT,
    and it is `gate(root, ...)` that decides which directory the source is
    resolved against. The root used to be passed here and dropped on the floor
    by all eleven callers, which reads as if the two were connected.
    """
    return """
        import checklib

        GAP = checklib.measured(0.25, "%s")
    """ % source


def test_a_source_naming_a_file_that_is_there_resolves(isolated_project):
    journal(isolated_project)
    gate(isolated_project, measured_model("ref/measurements.md"))


def test_a_source_naming_a_file_that_is_not_there_is_refused(isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, measured_model("ref/measurements.md"))
    assert "no ref/measurements.md" in str(exc.value)


def test_an_anchor_that_names_a_heading_resolves(isolated_project):
    journal(isolated_project)
    gate(isolated_project, measured_model("ref/measurements.md#lid-fit"))


def test_a_source_with_no_anchor_asks_nothing_of_the_headings(isolated_project):
    """THE ANCHOR IS OPTIONAL, and README.md said it was not.

    "its source has to name a file in the project, AND A HEADING IN IT, that
    exist" -- a sentence about a rule that would refuse `measured(3.0,
    "ref/measurements.md")`, which builds. `_source_problem` returns None the
    moment `anchor` is empty, before `_heading_slugs` is ever called.

    The second half is the one worth having as a test rather than as a
    correction: a file WITH NO HEADINGS AT ALL is a legal journal, so the
    heading walk must not be reached to find that out. A page of measurements
    with a paragraph at the top and no `#` anywhere is an ordinary thing for
    somebody to write first.
    """
    journal(isolated_project, "0.25 mm at the lid, taken with calipers\n")
    gate(isolated_project, measured_model("ref/measurements.md"))


def test_an_anchor_that_names_no_heading_is_refused(isolated_project):
    journal(isolated_project)
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, measured_model("ref/measurements.md#board"))
    message = str(exc.value)
    assert "'board'" in message
    # And it says which slugs the file DOES have, which is what unsticks
    # somebody who mistyped one.
    assert "lid-fit" in message


def test_the_error_offers_both_ways_out_of_an_unresolved_source(
        isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, measured_model("ref/j.md"))
    message = str(exc.value)
    assert "Write the measurement down" in message
    assert "checklib.estimated(" in message


@pytest.mark.parametrize("heading, slug", [
    ("## Lid fit", "lid-fit"),
    ("# Measurements", "measurements"),
    ("###### M3x8 (DIN912)", "m3x8-din912"),
    ("  ## Indented three", "indented-three"),
    ("## Closed ##", "closed"),
    # THE CASE `str.isalnum()` WAS CHOSEN FOR, and until this line the whole
    # parametrisation was ASCII -- so replacing that call with an ASCII class
    # left the suite green while a journal written in Russian lost every
    # heading it has (`замер-стенки` becomes a run of dashes, which strips to
    # the empty string and is discarded). A measurement journal is written by
    # whoever took the measurement, in whatever language they took it in.
    ("## Замер стенки", "замер-стенки"),
])
def test_a_heading_is_matched_by_its_slug(isolated_project, heading, slug):
    journal(isolated_project, f"{heading}\n\ntext\n")
    gate(isolated_project,
         measured_model(f"ref/measurements.md#{slug}"))


@pytest.mark.parametrize("source", [
    "../secrets.md",
    "/etc/passwd",
    "ref/../../secrets.md",
    "ref/measurements.md/#x",
    "",
])
def test_a_source_that_is_not_a_relative_path_in_the_project_is_refused(
        isolated_project, source):
    """The same alphabet a pushed archive's members are held to, componentwise.

    A source is a file the PUSH carries, and only a relative path inside the
    project is one: `/etc/passwd` and `../secrets.md` resolve on the laptop that
    wrote them and are simply not there on the hub, so a build that followed
    them would resolve locally and fail remotely -- for a reason the author is
    told here instead of after a push.
    """
    if source == "":
        # An empty source never becomes a Number at all — the constructor
        # refuses it, which is a better place to say so.
        with pytest.raises(ValueError):
            checklib.measured(0.25, source)
        return
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, measured_model(source))
    assert "not a path this build will follow" in str(exc.value)


def test_an_unresolved_source_is_pointed_at_the_line_that_wrote_it(
        isolated_project):
    """The same `line N:` the bare-number half gives, for the same file.

    The line was known all along -- it is where model.py binds the name -- and
    saying it for one half of the message and not the other reads as if it
    could not be worked out for this one.
    """
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, """
            import checklib

            GAP = checklib.measured(0.25, "ref/gone.md")
        """)
    assert "line 3: GAP: 'ref/gone.md'" in str(exc.value)


def test_a_journal_over_the_ceiling_is_refused(isolated_project):
    (isolated_project / "ref").mkdir()
    (isolated_project / "ref" / "measurements.md").write_text(
        "x" * (provenance.SOURCE_FILE_MAX_BYTES + 1), encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, measured_model("ref/measurements.md"))
    assert "over the" in str(exc.value)


def test_five_constants_under_one_heading_are_ordinary(isolated_project):
    """Flagged nowhere: five measurements in one journal is how a journal is
    written."""
    journal(isolated_project)
    entries = gate(isolated_project, """
        import checklib

        A = checklib.measured(1.0, "ref/measurements.md#lid-fit")
        B = checklib.measured(2.0, "ref/measurements.md#lid-fit")
        C = checklib.measured(3.0, "ref/measurements.md#lid-fit")
        D = checklib.measured(4.0, "ref/measurements.md#lid-fit")
        E = checklib.measured(5.0, "ref/measurements.md#lid-fit")
    """)
    assert len(entries) == 5


def test_every_unresolved_source_is_gathered_into_one_message(isolated_project):
    """The author fixes a journal once, not four times."""
    journal(isolated_project)
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, """
            import checklib

            A = checklib.measured(1.0, "ref/missing.md")
            B = checklib.measured(2.0, "ref/measurements.md#nowhere")
            C = checklib.measured(3.0, "ref/also-missing.md#x")
        """)
    message = str(exc.value)
    for name in ("A", "B", "C"):
        assert f"{name}: " in message, message


def test_both_kinds_of_failure_arrive_in_the_same_message(isolated_project):
    with pytest.raises(BuildError) as exc:
        gate(isolated_project, """
            import checklib

            GAP = 0.2
            WALL = checklib.measured(2.4, "ref/missing.md")
        """)
    message = str(exc.value)
    assert "line 3: GAP" in message
    assert "no ref/missing.md" in message


def test_a_derived_number_is_checked_against_nothing(isolated_project):
    """Verifying a derivation by machine is impossible, and demanding a formula
    would demand a second copy of the expression on the line above."""
    entries = gate(isolated_project, """
        import checklib

        SCREW_DIA = checklib.estimated(3.0, "off a screw")
        TAP_DIA = checklib.derived(SCREW_DIA - 0.5, "the M3 tapping drill")
    """)
    tap = next(entry for entry in entries if entry.name == "TAP_DIA")
    assert float(tap.number) == 2.5
    assert tap.number.note == "the M3 tapping drill"
    assert tap.number.kind == checklib.DERIVED


# --------------------------------------------------------------------------
# report() — the log lines and the summary
# --------------------------------------------------------------------------

def test_every_estimate_is_printed_and_none_of_them_is_a_warning(
        isolated_project, capsys):
    """`estimate:` and not `warning:`. `tests/test_template.py` turns every
    `warning:` line of a build log into a failure, and the template has to be
    able to carry an honest estimate."""
    journal(isolated_project)
    entries = gate(isolated_project, """
        import checklib

        WALL = checklib.estimated(2.4, "four perimeters at 0.6 mm")
        GAP = checklib.estimated(0.25, "print the pair")
        SCREW_DIA = checklib.measured(3.0, "ref/measurements.md#lid-fit")
        TAP_DIA = checklib.derived(2.5, "the M3 tapping drill")
    """)
    provenance.report(entries)

    lines = capsys.readouterr().out.splitlines()
    assert [line for line in lines if line.startswith("warning:")] == []
    estimates = [line for line in lines if line.startswith("estimate:")]
    assert len(estimates) == 2
    assert "estimate: WALL = 2.4 -- four perimeters at 0.6 mm" in estimates
    assert "estimate: GAP = 0.25 -- print the pair" in estimates
    # Nothing is said about the two that were not guessed at.
    assert not [line for line in lines if "SCREW_DIA" in line or "TAP_DIA" in line]


def test_the_summary_has_the_shape_metrics_json_carries(isolated_project):
    """FORM, not content: issue #58 is what reads it and it is not written yet.

    Held to being JSON, because that is where it goes — `write_metrics` dumps
    it and nothing else converts it on the way.
    """
    journal(isolated_project)
    entries = gate(isolated_project, """
        import checklib

        WALL = checklib.estimated(2.4, "four perimeters at 0.6 mm")
        SCREW_DIA = checklib.measured(3.0, "ref/measurements.md#lid-fit")
        TAP_DIA = checklib.derived(2.5, "the M3 tapping drill")
    """)
    summary = provenance.report(entries)

    assert set(summary) == {"measured", "derived", "estimated", "estimates",
                            "notes"}
    assert summary["measured"] == 1
    assert summary["derived"] == 1
    assert summary["estimated"] == 1
    assert summary["estimates"] == ["WALL"]
    assert json.loads(json.dumps(summary)) == summary


def test_the_summary_carries_the_notes_the_declarations_promise(
        isolated_project):
    """`derived()` tells the author the note travels into metrics.json.

    It did not. The summary carried three counts and a list of names, and the
    entire output of `derived()` -- the sentence saying which numbers a number
    follows from -- had no reader anywhere. Issue #58 is what will read these.

    EVERY KIND'S NOTE, not only `derived`'s: it is one field written for one
    reader. And only where there is one, since `note` is optional on
    `measured()` and an empty string asserts nothing about where a figure came
    from.
    """
    journal(isolated_project)
    entries = gate(isolated_project, """
        import checklib

        WALL = checklib.estimated(2.4, "four perimeters at 0.6 mm")
        TAP_DIA = checklib.derived(2.5, "the M3 tapping drill")
        SCREW_DIA = checklib.measured(3.0, "ref/measurements.md#lid-fit",
                                      "caliper, 3 samples")
        BOARD = checklib.measured(1.6, "ref/measurements.md#lid-fit")
    """)
    notes = provenance.report(entries)["notes"]

    assert notes == {
        "WALL": "four perimeters at 0.6 mm",
        "TAP_DIA": "the M3 tapping drill",
        "SCREW_DIA": "caliper, 3 samples",
    }
    assert list(notes) == sorted(notes), (
        "two builds of one source have to write one file, so the notes are "
        "sorted rather than left in whatever order the walk found them")


def test_a_name_out_of_a_dict_key_is_held_to_the_note_ceiling(isolated_project):
    """The name is AUTHOR TEXT too, and it used to be the unbounded half.

    `MAX_NOTE_CHARS` was justified by the size of metrics.json ("a 200 000
    character note made a 200 kB metrics.json") and bounded only the note.
    `_one_level` builds the name out of the model's own dict KEY, so eighteen
    characters of note under a 500 000-character key measured a 500 128-byte
    `provenance` block in a file that is public, immutable and never deleted.
    That figure is OF THE FILE: `metrics.write_metrics` dumps with `indent=2`,
    which is 20 bytes wider here than the same block dumped compact (500 108).
    """
    key = "k" * 500
    entries = provenance.collect(a_model(
        isolated_project,
        'import checklib\n\nTABLE = {"' + key +
        '": checklib.derived(1.0, "one note")}\n'))

    entry, = entries
    assert len(entry.name) == checklib.MAX_NOTE_CHARS
    assert entry.name.startswith("TABLE['kkk")
    assert entry.name.endswith("..."), (
        "a name that was cut has to say so, or a reader cannot tell it from a "
        "model that really has a 200-character key")
    # The point of the cap: what SHIPS is bounded, not just what is in memory.
    assert list(provenance.report(entries)["notes"]) == [entry.name]


def test_a_module_global_of_any_length_is_capped_in_the_refusal_too(
        isolated_project):
    """The other way an unbounded name arrives, and it reaches a different page.

    python puts no ceiling on an identifier, so `A * 500 = 4.0` is a legal line
    of a model. It arrives at `modeltext.shown_text` through `unwrapped()` rather
    than
    `collect()`, and what it lands in is the REFUSAL rather than metrics.json --
    which is why the cap sits at the one point every name in the inventory
    passes through instead of inside `_one_level`.
    """
    name = "A" * 500
    model = a_model(isolated_project, name + " = 4.0\n")
    item, = provenance.unwrapped(model)

    assert len(item.name) == checklib.MAX_NOTE_CHARS
    assert item.name.endswith("...")
    with pytest.raises(BuildError) as caught:
        provenance.check([], [item], Path(isolated_project))
    assert item.name in str(caught.value)
    assert name not in str(caught.value)


def test_the_summary_lists_no_more_than_the_ceiling_and_says_how_many_it_dropped(
        isolated_project, capsys):
    """The NUMBER of declarations was unbounded as well, and it is the worse half.

    Seventy-five characters of source -- a dict comprehension of 50 000
    estimates -- measured
    a 12 477 875-byte `provenance` block in metrics.json as `write_metrics`
    dumps it, with `indent=2` (12 077 855 dumped compact). Three claims here, and
    the third is
    what makes the cut safe to make: the two author-text lists are cut, the
    COUNTS are exact (they are totalled before anything is dropped), and what
    was dropped is said out loud rather than left for a reader to infer from a
    list shorter than the count beside it.

    THE LOG IS NOT CUT, and the last assertion is that asymmetry rather than an
    afterthought: a log has a ceiling of its own on the way to the job (SPEC
    §7.4) and is prose, while metrics.json is served as a file, is immutable and
    is never deleted.
    """
    over = provenance.MAX_LISTED + 44
    entries = provenance.collect(a_model(
        isolated_project,
        "import checklib\n\n"
        'TABLE = {f"k{i}": checklib.estimated(1.0, f"settle {i}")\n'
        f"         for i in range({over})}}\n"))
    assert len(entries) == over

    summary = provenance.report(entries)

    assert summary["estimated"] == over, (
        "the counts are what a reader compares the list against, so they are "
        "totalled before anything is dropped")
    assert len(summary["estimates"]) == provenance.MAX_LISTED
    assert len(summary["notes"]) == provenance.MAX_LISTED
    assert summary["estimates_omitted"] == 44
    assert summary["notes_omitted"] == 44
    # Sorted BEFORE the cut, so which names survive is a property of the source
    # and not of the order this walk happened to find them in.
    assert summary["estimates"] == sorted(
        entry.name for entry in entries)[:provenance.MAX_LISTED]
    assert json.loads(json.dumps(summary)) == summary

    printed = [line for line in capsys.readouterr().out.splitlines()
               if line.startswith("estimate:")]
    assert len(printed) == over


def test_a_model_that_declares_nothing_says_nothing(isolated_project, capsys):
    """No fractional UPPER_SNAKE at all: it builds, the summary is empty and
    the log stays silent."""
    entries = gate(isolated_project, """
        ANGLES = 24


        def build():
            return ANGLES
    """)
    assert provenance.report(entries) == {}
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------
# A name that will not print
# --------------------------------------------------------------------------

# What a dict key's `__repr__` can hand back without anybody meaning anything by
# it. `_one_level` builds the inventory's name for a nested number by rendering
# the key, so these are the shapes that reach a printed line -- and each one
# used to end the build in a way that blamed the hub.
UNPRINTABLE_KEYS = [
    # A key whose repr runs onto a second line, which is what a multi-line
    # string key looks like: the inventory prints one estimate per line, and the
    # tail of this one arrives with no name in front of it.
    "m3]\nfrom the drawing",
    # The same from a carriage return, which a terminal also breaks on.
    "m3]\rfrom the drawing",
    # U+2028: not category C, and `str.splitlines()` breaks on it anyway.
    "m3]\u2028from the drawing",
    # U+0085 NEL, the C1 half of the scan.
    "m3]\u0085from the drawing",
    # A lone surrogate, which is what `bytes.decode(errors="surrogateescape")`
    # hands back for a byte that is not UTF-8. It splits no line at all: `print`
    # raises UnicodeEncodeError on it, which leaves the build process as a bare
    # exception and reports the HUB as the one that fell over.
    "m3]\ud800",
]


@pytest.mark.parametrize("key", UNPRINTABLE_KEYS, ids=range(len(UNPRINTABLE_KEYS)))
def test_a_key_that_will_not_print_still_leaves_one_readable_line(
        isolated_project, capsys, key):
    """The inventory's name is author text and it reaches the log unquoted.

    THE ASSERTION IS ON THE RENDERED LINE and not on the name, because that is
    the claim: whatever `modeltext.escaped` does to the string, what `report()`
    prints has to be ONE line and has to be printable. Asserting the name is
    escaped would pass on an escape that is complete and on one that is not.
    """
    model = a_model(isolated_project, textwrap.dedent('''
        import checklib


        class Weird:
            def __repr__(self):
                return {key!r}


        TABLE = {{Weird(): checklib.estimated(1.0, "settled by eye")}}
    ''').lstrip("\n").format(key=key))

    provenance.report(provenance.collect(model))

    printed = capsys.readouterr().out
    lines = printed.splitlines()
    assert len(lines) == 1, (
        "one estimate came out as two lines, and the second of them has no "
        "name in front of it")
    assert lines[0].startswith("estimate: ")
    assert checklib._text_problem(lines[0], "note") is None, (
        "the rendered line has to survive the same scan a note is held to")


def test_the_name_is_escaped_for_exactly_what_a_note_is_refused_for(
        isolated_project):
    """One rule, asked two ways -- and this is what keeps them one rule.

    `modeltext.escaped` could have grown a scan of its own; instead it asks
    `checklib._text_problem` per character, so the note rule and the log rule
    cannot drift apart. That is a claim about the implementation, and it is
    worth a test because the cheap version of this function -- a hand-written
    list of `\\n`, `\\r` and U+2028 -- passes every rendered-line test above
    while leaving the rest of category C through.

    Only strings under the note ceiling, because `_text_problem` also refuses on
    LENGTH and `escaped` deliberately says nothing about it: capping is the
    next step, and `modeltext.shown_text` is where the two meet.

    IT IS ASKED OF `modeltext` DIRECTLY even though this file is about
    `provenance`: the escape moved out of here when the boundary became one
    module, and the rule it is being held to -- the note scan -- is the thing
    this suite has the corpus for.
    """
    corpus = [chr(code) for code in range(0, 0x2100)] + [
        "plain", "мм", "0.25 mm", "ok\u2028", "ok\u2029",
        "\ud800", "\U0001F600",
    ]
    for text in corpus:
        assert len(text) <= checklib.MAX_NOTE_CHARS
        refused = checklib._text_problem(text, "note") is not None
        assert (modeltext.escaped(text) != text) == refused, (
            f"the two rules disagree about {text!r}")
        assert checklib._text_problem(
            modeltext.escaped(text), "note") is None, (
            f"what came out of the escape is still refused: {text!r}")


# --------------------------------------------------------------------------
# Where the source file comes from
# --------------------------------------------------------------------------

def test_a_project_with_no_model_py_is_refused_in_words_rather_than_by_a_crash(
        isolated_project):
    """Nothing to parse is a REFUSAL, and it stays one now the path is derived.

    `_model_source` asks the import system what `import model` resolves to under
    the project root, and a root with no model.py in it has no answer --
    `PathFinder.find_spec` returns None, and `Path(None)` a line later is a
    TypeError the `except` below it does not catch. So the guard is still a
    guard, and `pytest.raises(BuildError)` is what says so: a TypeError fails
    this test rather than satisfying it.

    IT USED TO BE ASKED THE OTHER WAY ROUND -- a module with no `__file__`,
    which is what an exec'd or a synthesized one is -- and that premise went
    away with the attribute: the walks no longer read anything off the module to
    find the file, so a module built by hand is judged against whatever the
    project root holds, exactly like an imported one.

    BOTH DOORS, because both walks call `module_level_lines` and only one of
    them is on the path a reader would guess.
    """
    model = types.ModuleType("model_with_no_file")
    model.WALL = 2.4
    assert not (isolated_project / "model.py").exists()

    for walk in (provenance.collect, provenance.unwrapped):
        with pytest.raises(BuildError) as caught:
            walk(model)
        assert "no model.py in this project" in str(caught.value)


def test_the_source_is_the_package_model_when_that_is_what_import_finds(
        isolated_project):
    """`import model` also resolves to `model/__init__.py`, so the walk must.

    A project whose model is a PACKAGE is why the path is asked of
    `PathFinder.find_spec` rather than spelled `root / "model.py"`: that
    spelling finds nothing here, and "nothing" is the refusal above rather than
    the rule running -- a whole shape of project in which no number is ever
    checked.
    """
    package = isolated_project / "model"
    package.mkdir()
    (package / "__init__.py").write_text("WALL = 2.4\n", encoding="utf-8")
    assert not (isolated_project / "model.py").exists()

    module = types.ModuleType("model")
    module.WALL = 2.4
    bare, = provenance.unwrapped(module)
    assert (bare.name, bare.value, bare.line) == ("WALL", 2.4, (1,))


def test_a_namespace_package_the_model_imported_is_swept_after_it(
        isolated_project):
    """The fixture's own hygiene, and it used to have a hole exactly here.

    `geometry.load_model` puts a model's directory FIRST on sys.path so that
    `import mocks` finds the project's own, and a project whose mocks are a
    DIRECTORY rather than a file gives a namespace package: `__file__ is None`,
    location in `__path__` alone. The sweep asked `__file__` and nothing else,
    so this module survived every test in the file and answered the next
    `import mocks` from a directory that had been deleted.

    A FIXTURE TEST RATHER THAN A PRODUCTION ONE, deliberately: what leaks is
    `sys.modules` inside this suite, and the failure it causes lands on some
    later test in an order nobody chose.
    """
    (isolated_project / "mocks").mkdir()
    (isolated_project / "mocks" / "sizes.py").write_text(
        "WIDTH = 4.0\n", encoding="utf-8")
    assert not (isolated_project / "mocks" / "__init__.py").exists()

    model = a_model(isolated_project, """
        import checklib
        import mocks.sizes

        WALL = checklib.estimated(mocks.sizes.WIDTH, "settled by printing one")
    """)
    assert model.WALL == 4.0

    assert "mocks" not in sys.modules, (
        "the namespace package the model imported outlived the model")
    assert "mocks.sizes" not in sys.modules
