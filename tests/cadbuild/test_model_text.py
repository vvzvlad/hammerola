"""What `modeltext` promises about a value the model decides.

NOTHING HERE IS A DEFENCE, AND THERE IS NOBODY TO DEFEND AGAINST -- said first,
because a syntax-tree pin stood here for six review rounds on the opposite
belief and this file is where it would come back. model.py is the OWNER's own
code, pushed with the owner's own secret, from the owner's own repository; the
pin and the tests that treated it as an adversary went together on 2026-09-07,
and AGENTS.md and SPEC 7.9 carry the decision.

WHAT THE PIN WAS is worth knowing so it is not rebuilt: a walk over
`provenance.py`, `geometry.py`, `modelchecks.py` and `modeltext.py` requiring
every f-string interpolation in them to be a call of a `modeltext` function or
an entry on a list with a reason beside it, in service of the idea that the
build log's contents could be controlled. They are not meant to be. The log IS
the author's own output -- `print`, `sys.stderr.write` and `os.write(1, ...)`
all reach it, which
`test_the_build_log_is_the_models_own_output_unfiltered` below pins as the
feature it is -- and filtering at the stream would mangle every traceback and
every multi-line refusal the hub prints down those same two streams.

WHAT IS LEFT is what `modeltext` is actually for: the HUB's own messages staying
readable and staying messages when an ordinary mistake is in the way. Three
promises, and each one is about an author who did not mean it:

  * IT NEVER RAISES. A `__repr__` with a bug in it is an ordinary bug, and a
    raise from inside an `except` REPLACES the BuildError being built -- so one
    broken value among fifty ends the build in EXIT_CRASHED and costs the
    author the other forty-nine refusals.
  * IT IS BOUNDED. Nothing else bounds an identifier or a dict key, and both
    land in a public, immutable metrics.json.
  * IT KEEPS THE MESSAGE'S SHAPE. A refusal listing twenty numbers is read as
    one block, and a newline inside one value's rendering makes it look like
    twenty.

`SECOND_LINE` BELOW IS THE INSTRUMENT the shape tests interpolate: a newline
that survives is VISIBLE to an assertion where a lost character is not, so the
tests count lines.
"""

import pathlib
import textwrap
import types

import pytest

from src.buildproc import run_build
from src.buildproc.limits import DEFAULT_LIMITS, memory_limit_supported
from src.cadbuild import checklib, modelchecks, modeltext, provenance
from src.cadbuild.errors import BuildError

# RLIMIT_AS cannot be set on darwin, so the default memory ceiling makes the
# build refuse to start on a workstation and pass in CI. Same construct, and the
# same reason, as `tests/test_template.py::BUILD_LIMITS`.
BUILD_LIMITS = (DEFAULT_LIMITS if memory_limit_supported()
                else DEFAULT_LIMITS.replace(memory_bytes=None))

# What an author writes without thinking about it: a message laid out over two
# lines. Every "keeps the message's shape" test below interpolates this one and
# counts the lines that come out.
SECOND_LINE = "\nand the base is 2mm out"


def _log_lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


# --------------------------------------------------------------------------
# It never raises
# --------------------------------------------------------------------------

def test_a_render_that_raises_becomes_text_naming_the_exception():
    """A `__repr__` with a bug in it, which is an ordinary bug.

    It used to leave `provenance.check` as a bare RuntimeError, which the build
    process reports as EXIT_CRASHED (4) -- the HUB's own breakage -- for a class
    the model wrote. Two things answer that now and they are not
    interchangeable: `build._answers_for_the_model` fixes the exit code and
    loses the message, and this swallow keeps the refusal whole so that a walk
    over fifty numbers survives one broken value.

    The exception is NAMED because "<unprintable>" alone sends an author
    looking for a bug in the hub.
    """
    class Weird:
        def __repr__(self):
            raise ValueError("not saying")

    assert modeltext.shown(Weird()) == "<unprintable: ValueError>"


def test_a_render_that_answers_with_something_other_than_a_string():
    """`__repr__` is obliged to return a string by convention, not by the VM.

    A `__repr__` returning 17 makes `repr()` itself raise TypeError, so this
    arrives through the branch above; what the second guard is for is a
    `render` that is not one of `repr`/`str`/`format` -- the callers pass
    lambdas reading an attribute, and nothing checks what one of those answers
    with.

    The placeholder is not empty and is not the word "None": a message reading
    `WALL = ` or `WALL = None` says something false about the model, while this
    says that the hub asked and got no usable answer.
    """
    class Weird:
        def __repr__(self):
            return 17

    assert modeltext.shown(Weird()) == "<unprintable: TypeError>"
    assert modeltext.shown(object(), lambda _: 17) == "<unprintable>"


def test_a_base_exception_out_of_a_render_is_not_swallowed():
    """The width of the catch is `Exception`, deliberately, and it is pinned.

    A `KeyboardInterrupt` or a `SystemExit` is the process being asked to stop,
    and swallowing one here would turn "stop" into a placeholder in a message.
    `buildproc.child` catches BaseException at the top and ends the build as
    EXIT_CRASHED, which is the right answer to both.
    """
    class Impatient:
        def __repr__(self):
            raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        modeltext.shown(Impatient())


def test_one_broken_number_does_not_cost_the_others_their_refusal(
        isolated_project):
    """What "never raises" buys, at the door it was written for.

    `provenance.check` exists to list EVERY undeclared number in one refusal --
    the author fixes the file once rather than in five red builds -- and before
    this it listed none of them the moment one value would not render.
    """
    class Awkward(float):
        def __repr__(self):
            raise ValueError("this number declines to be printed")

    with pytest.raises(BuildError) as caught:
        provenance.check(
            [],
            [provenance.Bare(name="WALL", value=Awkward(1.0), line=1),
             provenance.Bare(name="GAP", value=2.0, line=2)],
            pathlib.Path(isolated_project))

    message = str(caught.value)
    assert "2 number(s)" in message
    assert "GAP" in message and "WALL" in message


# --------------------------------------------------------------------------
# It is bounded
# --------------------------------------------------------------------------

def test_the_cap_is_the_note_ceiling_unless_a_caller_says_otherwise():
    """Two ceilings, and the wide one is opt-in on purpose.

    Most of what comes through here lands in metrics.json -- public, immutable,
    never deleted -- and 200 is the one ceiling this system holds author-visible
    text to. An exception's own message is the value that ceiling measurably
    spoils: `checklib._text_problem` answers a refused note in about 300
    characters and the ACTIONABLE half is the second half.
    """
    long = "x" * 5000

    assert len(modeltext.shown(long, str)) == checklib.MAX_NOTE_CHARS
    assert modeltext.shown(long, str).endswith("...")
    assert len(modeltext.shown(
        long, str, limit=modeltext.MAX_MESSAGE_CHARS)) == \
        modeltext.MAX_MESSAGE_CHARS
    assert checklib.MAX_NOTE_CHARS < modeltext.MAX_MESSAGE_CHARS


def test_a_string_over_the_ceiling_says_so():
    """The marker is owed for both ways of being over it.

    A value longer than the ceiling, and a value under it that the escape pushes
    over. Deciding "was it cut" AFTER the slice answers no to the first, so a
    500-character key came back at exactly 200 characters reading like a model
    that really has a 200-character key.
    """
    limit = 50

    long = modeltext.shown_text("k" * 500, limit=limit)
    assert len(long) == limit and long.endswith("..."), long

    widened = modeltext.shown_text("\n" * limit, limit=limit)
    assert len(widened) == limit and widened.endswith("..."), widened


# --------------------------------------------------------------------------
# It keeps the message's shape
# --------------------------------------------------------------------------

def test_a_model_exception_stays_on_the_line_that_reports_it():
    """One refusal, one line -- for the ordinary multi-line assert message.

    An author writing `raise ValueError("the lid is 2mm out\\nand the base
    with it")` has written one fault, and the door reports it as one. Left
    alone, the second half arrives at column 0 of the build log looking like a
    finding of its own. `call_model` is what `MODEL_DOORS` routes through, so
    this one line covers parts(), views() and the two shape doors.
    """
    def door():
        raise ValueError(f"it broke{SECOND_LINE}")

    with pytest.raises(BuildError) as caught:
        modelchecks.call_model("views()", door)

    assert len(_log_lines(str(caught.value))) == 1
    assert str(caught.value).startswith("views() raised ValueError")


def test_a_section_label_stays_on_its_row_of_the_timing_table(capsys,
                                                              monkeypatch):
    """The table is a ranking, and a label with a newline in it is two rows.

    `checklib.section` refuses a non-string and scans it for nothing else, so
    the label is the one field of this table the author writes. It is printed
    from a `finally`, i.e. on the build that already failed -- the log somebody
    is reading to find out what went wrong.

    THE FLOOR IS LOWERED because a `with` block that does nothing takes no
    measurable time, and a section under `SECTION_FLOOR` is counted rather than
    named -- so the first draft of this test asserted on a table its label was
    never in, and passed with the escape removed. Sleeping for a tenth of a
    second would be the other way to reach the same line, and slower for
    nothing.
    """
    monkeypatch.setattr(modelchecks, "SECTION_FLOOR", 0.0)
    try:
        with checklib.section(f"the joint{SECOND_LINE}"):
            pass
        modelchecks.print_check_sections()
    finally:
        checklib._SECTIONS.clear()

    printed = _log_lines(capsys.readouterr().out)
    assert any("the joint" in line for line in printed), printed
    assert len(printed) == 2, printed  # the heading and one row


def test_the_flag_is_about_the_characters_that_come_back():
    """A rewrite the reader cannot see must not be announced.

    The escape WIDENS a string, so what `shown_text` hands back is the first
    `limit` characters escaped and then cut again to make room for the `...`.
    A newline in the part cut away is escaped by a scan nobody reads the output
    of -- and the caller printed "the hub rewrote this" over text it had not
    rewritten. The first spelling of the flag compared `escaped(text[:limit])`
    against `text[:limit]`, which is exactly that scan.
    """
    limit = 200
    tail_only = "a" * (limit - 3) + "\n" + "b" * 50

    text, rewritten = modeltext.shown_and_rewritten(tail_only, str, limit=limit)
    assert not rewritten, (
        f"announced a rewrite of characters that are not in {text!r}")
    assert "\\u" not in text

    text, rewritten = modeltext.shown_and_rewritten("\nab", str, limit=limit)
    assert rewritten, "the escape is visible in the answer and was not reported"


# --------------------------------------------------------------------------
# The trade: escaped AND said so
# --------------------------------------------------------------------------

def test_a_failed_check_is_reported_as_one_problem_per_line(isolated_project,
                                                            out_dir):
    """The one trade this boundary makes, pinned as a decision.

    A problem string is prose the author WROTE to be read, so escaping it
    changes what a legitimate multi-line message looks like. It is escaped
    anyway, because the refusal around it is a numbered list -- `3 check(s)
    failed` followed by one line each -- and a newline inside any of them makes
    three problems read as five. If this test is ever deleted, the sentence in
    `modeltext`'s docstring about the trade goes with it.
    """
    model = types.SimpleNamespace(
        checks=lambda: [f"the lid does not fit{SECOND_LINE}",
                        "the base is 2mm out"])

    with pytest.raises(BuildError) as caught:
        modelchecks.run_checks(model, out_dir)

    listed = [line for line in _log_lines(str(caught.value))
              if line.startswith("- ")]
    assert len(listed) == 2, str(caught.value)


def test_a_check_whose_own_words_were_rewritten_is_told_so(isolated_project,
                                                           out_dir):
    """The other half of that trade, and the half that was missing.

    The escape is right and stays; what was wrong was the SILENCE. An author who
    writes a four-line problem message gets one line of `\\u000a`s back and no
    word anywhere about who did that or how to avoid it -- while the comparison
    the docstring used to make in its defence, a refused `note`, comes with
    several hundred characters of explanation and advice. That is a refusal WITH
    instructions against a mangling with none, which is not the trade it was
    presented as.

    REFUSING WAS THE OTHER OPTION AND WAS NOT TAKEN. A refusal here is a new way
    for a model that publishes today to stop publishing, over the formatting of
    a message that is already reporting a failure -- and the build is going red
    on this check either way, so the author is reading the text regardless. What
    they were missing was the sentence, not the veto.

    THE NOTE IS ATTACHED TO THE LIST AND NOT TO THE PROBLEM, and it is
    deliberately not prefixed `warning:`: the build is already failing on the
    check itself, and a second prefix in a refusal reads as a second verdict.
    """
    multiline = types.SimpleNamespace(
        checks=lambda: ["the lid does not fit\nand the base is 2mm out"])

    with pytest.raises(BuildError) as caught:
        modelchecks.run_checks(multiline, out_dir)

    message = str(caught.value)
    assert "\\u000a" in message, "the escape itself is what is being traded"
    assert "the hub rewrote a line break" in message
    assert "write the message as one line" in message

    # AND NOT OTHERWISE: a note printed under every failed check would be noise
    # under the ninety-nine that were written on one line to begin with.
    plain = types.SimpleNamespace(checks=lambda: ["the lid does not fit"])

    with pytest.raises(BuildError) as caught:
        modelchecks.run_checks(plain, out_dir)

    assert "the hub rewrote" not in str(caught.value)


def test_the_note_is_decided_by_the_very_text_it_is_attached_to(isolated_project,
                                                                out_dir):
    """The note and the line it explains have to come from ONE render.

    They did not: the line shown came from `shown(p, str, ...)` while the note
    was decided by a second, separate look at the value -- so the two were about
    two renderings, and any object that does not render identically twice makes
    them disagree. Below the difference is between `str.__str__` and the class's
    own; a `__str__` that interpolates a counter or a timestamp does the same
    thing without meaning to.

    THE FIX IS NOT A SECOND RENDER THAT AGREES, it is one render that answers
    both questions: `shown_and_rewritten` returns the text and the flag from the
    same pass, so there is no second string for them to disagree about. A test
    that asserted "both calls render the same way" would pass on the day
    somebody adds a third caller that does not.

    A `str` SUBCLASS IS THE VEHICLE because `run_checks` accepts nothing else --
    it refuses a problem list whose elements are not strings -- and `strip` is
    overridden for the same reason: without it the subclass is gone before the
    render under test happens.
    """
    class Restated(str):
        def strip(self, *args):
            return self

        def __str__(self):
            return "the lid does not fit\nand the base is 2mm out"

    model = types.SimpleNamespace(checks=lambda: [Restated("one line, honest")])

    with pytest.raises(BuildError) as caught:
        modelchecks.run_checks(model, out_dir)

    message = str(caught.value)
    assert "\\u000a" in message, "the escape is what the note is about"
    assert "the hub rewrote a line break" in message


# --------------------------------------------------------------------------
# Why there is no syntax-tree pin here any more
# --------------------------------------------------------------------------

def test_the_build_log_is_the_models_own_output_unfiltered(tmp_path):
    """The build log is what the model printed, verbatim -- pinned as a feature.

    THREE WRITES AND NOT ONE, because they are three different ways an author
    reaches the log and all three have to keep working. `print` is the ordinary
    one. `sys.stderr.write` is the one a library does, and it lands in the same
    log because the runner merges the streams (`stderr=subprocess.STDOUT`) --
    so a `logging` config writing to stderr is not lost. `os.write(1, ...)` is
    what a subprocess or a C extension does, past any writer object python has
    installed, and it lands there too.

    THIS IS ALSO THE MEASUREMENT THAT RETIRED A SYNTAX-TREE PIN, and it is kept
    partly so that is not rediscovered. The pin stood here for six review
    rounds requiring every f-string in four files to route a model's value
    through `modeltext`, defending a rule that the log's contents could be
    controlled. They cannot, they are not meant to be, and filtering at the
    stream would be actively harmful: the hub prints its own tracebacks and
    multi-line refusals down these same two streams.

    WHAT FOLLOWS FOR `modeltext` is that its subject is the hub's OWN messages
    -- which it must not let a value break, truncate past a ceiling, or turn
    into a raise. Those are what the tests above hold it to.
    """
    project = tmp_path / "loud-model"
    project.mkdir()
    (project / "project.json").write_text(
        '{"id": "abc123def456", "project": "loud-model", "title": "Loud model"}',
        encoding="utf-8")
    (project / "model.py").write_text(textwrap.dedent("""
        import os
        import sys

        print("said by a plain print")
        sys.stderr.write("said on stderr\\n")
        os.write(1, b"said straight at the file descriptor\\n")
        sys.stdout.flush()
        sys.stderr.flush()
    """), encoding="utf-8")

    outcome = run_build(project, tmp_path / "out", pid="abc123def456",
                        limits=BUILD_LIMITS)

    said = [line for line in outcome.log.splitlines()
            if line.startswith("said ")]
    assert len(said) == 3, (
        "a road into the build log closed. All three are the author's own way "
        f"of saying something to themselves. Log:\n{outcome.log}")
