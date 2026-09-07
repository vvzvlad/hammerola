"""The checks a model.py calls, and the top-level name it calls them under.

`import checklib` is a contract with nine repositories, exactly like `views()`
and `printables()`. It has to keep working after the code moved into a package,
and it has to be the SAME module -- `pairwise_interference` records what it
measured, and metrics.json reads that record back. Two copies of the module
would be two records, one of which nobody reads.
"""

import contextlib
import importlib
import sys
import types
from pathlib import Path

import pytest

import checklib as top_level
from src.cadbuild import checklib
from src.cadbuild.errors import BuildError

IMPLEMENTATION = Path(checklib.__file__).resolve()


@pytest.fixture(autouse=True)
def clean_record():
    """Both accumulators, both ends -- the conftest guard checks the same two."""
    checklib._INTERFERENCE.clear()
    checklib._SECTIONS.clear()
    yield
    checklib._INTERFERENCE.clear()
    checklib._SECTIONS.clear()


def _ours(name):
    """Module names this file is allowed to forget and put back."""
    return name == "checklib" or name == "src" or name.startswith("src.")


@contextlib.contextmanager
def a_process_that_has_imported_neither(first_on_the_path=None):
    """`checklib` and everything `src`-shaped forgotten, restored exactly after.

    The interesting orderings all happen once per process and are therefore
    invisible to a suite that imported both modules before the first test ran.
    This puts sys.modules back to before either was imported, so an
    `importlib.import_module` inside the block really does execute the shim.

    `first_on_the_path` stands in for the model project: geometry.load_model
    puts the project root at sys.path[0] before importing model.py, and the
    contents of that directory are the model author's, not ours.

    EVERY name is saved and put back, not just the four this file names. The
    modules under src.cadbuild carry module-level state that other tests hold
    references to -- paths._root, checklib._INTERFERENCE -- and restoring a
    subset would leave those tests running against one module object while the
    conftest guard inspects another.
    """
    saved_modules = {name: module for name, module in sys.modules.items() if _ours(name)}
    saved_path = list(sys.path)
    for name in saved_modules:
        del sys.modules[name]
    if first_on_the_path is not None:
        sys.path.insert(0, str(first_on_the_path))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name in [name for name in sys.modules if _ours(name)]:
            del sys.modules[name]
        sys.modules.update(saved_modules)


# --------------------------------------------------------------------------
# The compatibility name
# --------------------------------------------------------------------------

def test_the_top_level_name_is_the_same_module_not_a_copy():
    assert top_level.pairwise_interference is checklib.pairwise_interference
    assert top_level.recorded_interference is checklib.recorded_interference


def test_the_record_is_shared_between_the_two_names():
    checklib._INTERFERENCE["a|b"] = 1.5
    assert top_level.recorded_interference() == {"a|b": 1.5}


def test_a_model_declares_its_numbers_through_the_top_level_name():
    """The three constructors and the class, reached the way a model reaches
    them. The generic re-export test above already requires them to BE there;
    this is about them being the same objects, which `provenance` depends on:
    it asks `isinstance(value, checklib.Number)` against the implementation's
    class, and a second class would make every declared number look bare.
    """
    assert top_level.Number is checklib.Number
    for name in ("measured", "derived", "estimated"):
        assert getattr(top_level, name) is getattr(checklib, name)
    assert isinstance(top_level.measured(1.0, "ref/m.md"), checklib.Number)
    assert top_level.KINDS == (top_level.MEASURED, top_level.DERIVED,
                               top_level.ESTIMATED)


def test_the_note_ceiling_is_the_one_the_rest_of_the_system_holds_text_to():
    """One number, written in four files that cannot import each other.

    This module is loaded BY PATH by the root shim, under a name that never goes
    through `src`, so it may not import `hubspec` or the serving half -- exactly
    the situation `tests/client/test_limits.py` is in and answers the same way.
    The value is transcribed and the test is what makes it a shared rule.

    THEY ARE ONE RULE BY DECISION AND NOT BY CONSEQUENCE, which is worth being
    exact about because three of the four are enforced somewhere and this one is
    not: nothing mechanically holds a NOTE under `render.MAX_TEXT`, since
    metrics.json is served as a file and never passes through `_plain_text`. So
    a note is bounded here and nowhere else, and this equality is a choice --
    one ceiling on author-visible text rather than four that drift. The cost is
    that re-reasoning about the heading ceiling silently moves the note's, and
    the reason it is worth paying is that narrowing this one later would
    retroactively refuse builds that used to pass, into revisions that are
    immutable. Overturn it deliberately or not at all; the argument is written
    out at MAX_NOTE_CHARS.
    """
    from src import render
    from src.cadbuild import hubspec
    from src.client.limits import MAX_TEXT_CHARS

    assert checklib.MAX_NOTE_CHARS == hubspec.MAX_NOTE_CHARS
    assert checklib.MAX_NOTE_CHARS == render.MAX_TEXT
    # The fourth copy, on the other side of the wire. `tests/client/test_limits.py`
    # ties it to the serving half; this ties it to the build half, so the four
    # are one chain rather than two pairs.
    assert checklib.MAX_NOTE_CHARS == MAX_TEXT_CHARS


def test_the_note_rule_agrees_with_what_the_hub_would_accept():
    """The scan here and `first_nonprintable` are a third and a first copy.

    Written out separately because of the import rule above, so the two are run
    over one corpus and required to agree -- a rule tightened on one side fails
    here instead of drifting.

    TWO DELIBERATE DIFFERENCES, both kept out of the corpus because requiring
    agreement on them would be requiring the wrong thing:

      * ANGLE BRACKETS. The hub bans them in a TITLE and not in a note
        (`hub_text_problem(..., angle_brackets_ok=True)` is how a note is
        checked), so this module says nothing about them.
      * U+2028 and U+2029. This module refuses them and `first_nonprintable`
        does not, because they are Zl and Zp rather than category C. That is a
        rule laid ON TOP of the shared scan and not a drift in it: a note is
        printed into a build log that is read a line at a time, and
        `str.splitlines()` breaks on both -- see `_LINE_SEPARATORS`. Whether
        `buildnames` should learn the same is a separate question with a wider
        blast radius (a file name, a project title) and is not answered here.
    """
    from src.buildnames import first_nonprintable

    corpus = [
        "an ordinary note",
        "",
        "two\nlines",
        "a\ttab",
        "a\x7fdelete",
        "anext-line, which is C1 and not C0",
        "a‮reordering override",
        "a\ud800lone surrogate",
        "é accented, which is fine",
        "x" * checklib.MAX_NOTE_CHARS,
    ]
    for text in corpus:
        ours = checklib._text_problem(text, "note")
        theirs = first_nonprintable(text)
        assert (ours is None) == (theirs is None), (
            f"{text!r}: this module says {ours!r} and buildnames says "
            f"{theirs!r} -- the two scans have drifted apart")


@pytest.mark.parametrize("separator", ["\u2028", "\u2029"])
def test_a_note_cannot_split_a_line_of_the_build_log(separator):
    """U+2028 and U+2029 pass every printability test and still split a line.

    They are the two characters that get into a note by accident and cannot be
    seen afterwards: an editor or a paste from a PDF puts one in, it renders as
    nothing, and `_text_problem`'s category-C scan walks past it -- Zl and Zp are
    Separator, not C. `str.splitlines()`, which is how a build log is read back,
    breaks on both, so one line of the author's note becomes two and the second
    one has no label on it. The first assertion is that mechanism, written out so
    the test does not rest on the reader remembering it.
    """
    two_lines = f"estimate: WALL = 2.4 -- ok{separator}measured on the v2 body"
    assert len(two_lines.splitlines()) == 2, (
        "the premise: python really does split a line here")

    with pytest.raises(ValueError) as exc:
        checklib.estimated(2.4, two_lines)
    assert "splits a line" in str(exc.value)
    # And in a source, which is printed by the same build and read by the same
    # scan -- the refusal is about the string, not about which field holds it.
    with pytest.raises(ValueError) as exc:
        checklib.measured(2.4, f"ref/m.md{separator}x")
    assert "splits a line" in str(exc.value)


def test_the_ceiling_says_something_different_about_a_path_and_a_sentence():
    """One advice sentence used to be written about a note and printed for both.

    Both halves of it are false of a `source`: `provenance.report()` publishes
    `notes` and nothing else, so a source never reaches metrics.json at all, and
    "put the working in the measurement journal" is not something anybody can do
    to a file path. What the two share is the count and the number.
    """
    over = "x" * (checklib.MAX_NOTE_CHARS + 1)
    note = checklib._text_problem(over, "note")
    source = checklib._text_problem(over, "source")

    for message in (note, source):
        assert message.startswith(f"is {len(over)} characters, and the ceiling "
                                  f"is {checklib.MAX_NOTE_CHARS}.")
    assert "metrics.json" in note and "journal" in note
    assert "metrics.json" not in source and "journal" not in source
    assert "#heading" in source, "it says what a source is instead"


def test_the_note_ceiling_says_the_same_thing_to_every_kind():
    """The advice is chosen by FIELD, so it has to be true of all three kinds.

    It ended "put the working in the measurement journal", which is advice for
    `measured()` alone -- `derived()` is explicitly for a figure that follows
    from other numbers, a published standard among them, and has no journal
    behind it, so a derivation with an over-long note was sent to a file that
    does not exist and need not. One sentence reaches all three because
    `_text_problem` is handed the field and not the kind, which is what this
    holds: whatever it says has to hold for whichever kind tripped it.
    """
    over = "x" * (checklib.MAX_NOTE_CHARS + 1)
    advice = checklib._TOO_LONG_ADVICE["note"]
    for kind, call in (
            ("measured", lambda: checklib.measured(2.4, "ref/m.md", over)),
            ("derived", lambda: checklib.derived(2.4, over)),
            ("estimated", lambda: checklib.estimated(2.4, over))):
        with pytest.raises(ValueError) as exc:
            call()
        assert advice in str(exc.value), (
            f"{kind}() is told something else about a note over the ceiling, "
            f"so the one sentence is no longer the one sentence")
    assert "measurement journal" not in advice, (
        "that clause is advice for measured() alone, and this sentence is "
        "printed for derived() and estimated() as well -- a derivation has no "
        "journal behind it, which is the whole point of the kind")


@pytest.mark.parametrize("note, expected", [
    ("x" * 201, "201 characters"),
    ("a note\nover two lines", "not a printable character"),
    ("‮reordered", "not a printable character"),
    ("\ud800 decoded with surrogateescape", "not a printable character"),
])
def test_a_note_that_cannot_be_published_is_refused_where_it_is_written(
        note, expected):
    """A ValueError at the declaration, not a UnicodeEncodeError three files on.

    Both of these used to be accepted by the constructor and then kill the
    build: `print(f"estimate: ...")` and `json.dumps(..., ensure_ascii=False)`
    each raise UnicodeEncodeError on a surrogate, and neither is a BuildError,
    so the build ended in EXIT_CRASHED -- the hub reporting its own fault for a
    string the model wrote. A ValueError raised while model.py is being imported
    is wrapped by `geometry.load_model` into a BuildError, i.e. EXIT_BUILD_FAILED.
    """
    with pytest.raises(ValueError) as exc:
        checklib.estimated(1.0, note)
    assert expected in str(exc.value)
    assert "estimated()" in str(exc.value), "the message names the call"


def test_the_ceiling_holds_the_source_as_well_as_the_note():
    """`measured()`'s source is author text on the same journey, so the same
    rule. It is the one that appears in the refusal message, too."""
    with pytest.raises(ValueError) as exc:
        checklib.measured(1.0, "x" * 201)
    assert "source" in str(exc.value)


def test_a_note_exactly_at_the_ceiling_is_accepted():
    """The boundary, from the side that has to keep working: an off-by-one here
    refuses a note that is exactly at the ceiling, and the starter template
    every project copies runs close to it.

    HOW CLOSE IS NOT WRITTEN HERE, and that is the correction rather than a
    vagueness. The sentence used to give a figure -- "the template's longest
    note is 130 characters" -- which was wrong when it was written (130 was the
    fourth longest; the longest was 182) and had nothing to fail on either way.
    `tests/test_template.py::test_every_note_in_the_template_fits_under_the_ceiling`
    measures it instead.
    """
    number = checklib.estimated(1.0, "x" * checklib.MAX_NOTE_CHARS)
    assert len(number.note) == checklib.MAX_NOTE_CHARS


def test_everything_a_model_calls_is_re_exported():
    """The shim carries every public name the implementation defines.

    DERIVED, not listed. This used to name five functions by hand, and a
    hand-written list of what to check is the defect it is meant to catch: add
    a helper to the implementation, forget the shim, and `import checklib;
    checklib.the_new_one` fails in a model repository while this test stays
    green -- the list simply never mentioned it. `material_at` was added on
    2026-08-30 and would have gone exactly that way.

    Public means "defined here and not underscored". Imported modules are
    excluded, or the shim would be required to re-export `math`.
    """
    public = {
        name for name, value in vars(checklib).items()
        if not name.startswith("_") and not isinstance(value, types.ModuleType)
    }
    assert public, "no public names found: the derivation itself is broken"
    missing = sorted(name for name in public if not hasattr(top_level, name))
    assert not missing, (
        f"the implementation defines {missing} and the root checklib.py does "
        f"not re-export them, so `import checklib` in a model cannot reach "
        f"them. Add them to the assignments and to __all__ there.")


def test_the_shims_declared_list_matches_what_it_actually_exports():
    """__all__ and the assignments above it are two lists that can disagree.

    `from checklib import *` reads __all__; `checklib.x` reads the assignment.
    A name in one and not the other works through one door and not the other,
    which is worse than being absent from both.

    BOTH DIRECTIONS, AND ONLY ONE OF THEM USED TO BE CHECKED. `bound` was built
    by filtering `__all__` itself -- `{name for name in declared if
    hasattr(...)}` -- so it could never hold a name `declared` did not, and the
    equality was `declared >= bound` wearing a `==`. Delete `"Number",` from
    __all__ and keep the assignment, and this passed: `checklib.Number` went on
    working while `from checklib import *` stopped binding the class both halves
    of the provenance rule test with `isinstance`. So `bound` is read off the
    MODULE now, the same way `test_everything_a_model_calls_is_re_exported`
    above reads the implementation, and the two directions have separate
    messages because they want opposite fixes.
    """
    declared = set(top_level.__all__)
    bound = {
        name for name, value in vars(top_level).items()
        if not name.startswith("_") and not isinstance(value, types.ModuleType)
    }
    assert bound, "no public names found on the shim: the derivation is broken"
    assert not declared - bound, (
        f"__all__ names {sorted(declared - bound)}, which the shim does not "
        f"bind, so `from checklib import *` raises AttributeError on it")
    assert not bound - declared, (
        f"the shim binds {sorted(bound - declared)} and __all__ does not name "
        f"them, so `checklib.<name>` reaches them and `from checklib import *` "
        f"does not")


def test_the_shim_survives_a_model_project_that_has_a_src_of_its_own(tmp_path):
    """The shim must not resolve its implementation through the name `src`.

    `src` is about the most ordinary directory name a repository has, and
    load_model puts the model project's root on sys.path FIRST on purpose, so a
    project carrying one owns that name for the rest of the process. A shim
    written as `from src.cadbuild.checklib import ...` therefore raises
    ModuleNotFoundError on `import checklib` -- in a process where the package
    half has not been imported yet, which is the process SPEC 8A.2 step 4
    spawns to run a model in.

    The decoy here is what a model project's src/ looks like from the import
    system's side: a package by that name with no `cadbuild` in it.
    """
    project = tmp_path / "model-project"
    (project / "src").mkdir(parents=True)
    (project / "src" / "__init__.py").write_text("", encoding="utf-8")

    with a_process_that_has_imported_neither(first_on_the_path=project):
        shim = importlib.import_module("checklib")
        implementation = sys.modules["src.cadbuild.checklib"]
        assert Path(implementation.__file__).resolve() == IMPLEMENTATION
        assert shim.pairwise_interference is implementation.pairwise_interference
        # The name that would have been consulted was never touched at all.
        assert "src" not in sys.modules


def test_a_shim_imported_before_the_package_still_shares_the_one_record():
    """The whole point of the shim, in the order step 4 will meet it.

    The model runs first, and its `import checklib` is what brings the
    implementation into the process; `collect_metrics` reaches it later,
    through the package, and has to arrive at the SAME module. Two module
    objects means two `_INTERFERENCE` dicts -- the model fills one, metrics.json
    reads the other, and a build that measured its overlaps publishes none of
    them without anything going red.

    Loading a file under a name whose parent package is not imported is exactly
    where that could break, so it is checked in that order rather than in the
    one this suite happens to import in.
    """
    with a_process_that_has_imported_neither():
        shim = importlib.import_module("checklib")
        # `from . import checklib`, made by the module that writes metrics.json.
        metrics = importlib.import_module("src.cadbuild.metrics")
        assert metrics.checklib is sys.modules["src.cadbuild.checklib"]

        metrics.checklib._INTERFERENCE["body|lid"] = 4.10
        assert shim.recorded_interference() == {"body|lid": 4.10}


# --------------------------------------------------------------------------
# name_pairs -- shared with the view validator on purpose
# --------------------------------------------------------------------------

def test_a_list_of_pairs_comes_back_as_frozensets():
    assert checklib.name_pairs([("a", "b")], "allowed_touching") == \
           {frozenset(("a", "b"))}


def test_a_pair_that_is_not_two_strings_is_refused():
    """The copies drifted and the one in publish.py let this through."""
    for bad in ([("a", 1)], [("a",)], ["ab"], [("a", "b", "c")]):
        with pytest.raises(ValueError):
            checklib.name_pairs(bad, "allowed_touching")


def test_a_flat_tuple_of_two_names_is_refused_by_name():
    """`allowed_touching=("body", "lid")` -- the mistake this exists for."""
    with pytest.raises(ValueError) as exc:
        checklib.name_pairs(("body", "lid"), "allowed_touching")
    assert "not a pair of names" in str(exc.value)


def test_a_bare_string_is_refused_with_the_right_message():
    with pytest.raises(ValueError) as exc:
        checklib.name_pairs("body", "allowed_touching")
    assert "list of name PAIRS" in str(exc.value)


def test_something_that_cannot_be_iterated_at_all_is_named_not_crashed():
    """A ValueError naming the option, not a bare TypeError from the loop.

    The string above is the mistake somebody actually makes; a number or a None
    is every other way of getting it wrong, and it used to come out of the walk
    as `'int' object is not iterable` -- from a library, with nothing saying
    which option it was about. `cadbuild.views.interference_pairs` answers the
    same way about its own list, so the two halves of the contract read alike.
    """
    for bad in (5, None, object()):
        with pytest.raises(ValueError) as exc:
            checklib.name_pairs(bad, "allowed_touching")
        assert "cannot be iterated" in str(exc.value)
        assert "allowed_touching" in str(exc.value)


def test_a_pair_given_as_a_generator_is_consumed_exactly_once():
    """Iterating a pair twice is once too many: the second pass sees nothing,
    `all()` over nothing is True, and non-strings walk through."""
    assert checklib.name_pairs([(x for x in ("a", "b"))], "nested_ok") == \
           {frozenset(("a", "b"))}


def test_nothing_declared_is_an_empty_set():
    assert checklib.name_pairs((), "allowed_touching") == set()


# --------------------------------------------------------------------------
# The record metrics.json carries
# --------------------------------------------------------------------------

def test_the_record_starts_empty():
    assert checklib.recorded_interference() == {}


def test_the_record_is_a_copy_callers_cannot_corrupt():
    checklib._INTERFERENCE["a|b"] = 1.0
    taken = checklib.recorded_interference()
    taken["a|b"] = 99.0
    assert checklib.recorded_interference() == {"a|b": 1.0}


# --------------------------------------------------------------------------
# section() -- what a stretch of checks() cost
# --------------------------------------------------------------------------
#
# Wall time, so nothing here asserts a DURATION: a test that pins "this took
# more than 10 ms" fails on a fast machine or a slow one sooner or later, and
# would be pinning the clock rather than the bookkeeping. What is asserted is
# which labels exist, that a repeat adds up, and that a failure still leaves the
# cost behind.

def test_a_section_records_its_label():
    with checklib.section("the joint"):
        pass
    assert list(checklib.recorded_sections()) == ["the joint"]


def test_the_record_starts_with_no_sections():
    assert checklib.recorded_sections() == {}


def test_a_label_used_twice_is_one_line_and_the_seconds_add_up():
    """A section inside a loop is the case this exists for."""
    for _ in range(3):
        with checklib.section("probe grid"):
            pass
    assert list(checklib.recorded_sections()) == ["probe grid"]
    assert checklib._SECTIONS["probe grid"] == pytest.approx(
        sum(checklib._SECTIONS.values()))


def test_a_section_whose_body_raises_still_records_what_it_cost():
    """The failed build is the one whose timings get read."""
    with pytest.raises(ValueError):
        with checklib.section("interference"):
            raise ValueError("the check blew up")
    assert "interference" in checklib.recorded_sections()


def test_nested_sections_are_both_recorded():
    """Each measures its own wall time; the inner one is inside the outer one's
    total, which is documented rather than corrected."""
    with checklib.section("outer"):
        with checklib.section("inner"):
            pass
    assert set(checklib.recorded_sections()) == {"outer", "inner"}


def test_a_label_that_is_not_a_string_is_refused():
    """It is a table heading. A Path or a tuple would be printed as one."""
    with pytest.raises(TypeError, match="label"):
        with checklib.section(("the", "joint")):
            pass


def test_the_sections_record_is_a_copy_callers_cannot_corrupt():
    with checklib.section("a"):
        pass
    taken = checklib.recorded_sections()
    taken["a"] = 99.0
    assert checklib.recorded_sections()["a"] != 99.0


# --------------------------------------------------------------------------
# volume() / is_empty() -- the refusal that needs no kernel
# --------------------------------------------------------------------------
#
# What they answer about real geometry is in test_material_at.py, where the CAD
# kernel is. This is the half that has to work in the CI container.

def test_volume_refuses_something_that_is_not_geometry():
    with pytest.raises(TypeError, match="volume"):
        checklib.volume("not a solid")


def test_is_empty_refuses_something_that_is_not_geometry():
    with pytest.raises(TypeError):
        checklib.is_empty(42)
