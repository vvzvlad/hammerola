#!/usr/bin/env python3
"""Rendering a value the MODEL wrote, for a message of the HUB's.

WHAT THIS IS NOT, said first because the file claimed the opposite for most of
its life. It is not a barrier and there is nobody on the other side of one:
model.py is the OWNER's own code, pushed with the owner's own secret, from the
owner's own repository (AGENTS.md, "код владельца"; SPEC 7.9). Nothing here is
defending against the person who wrote the file it is rendering.

WHAT IT IS FOR is the hub's own messages staying readable when that person made
an ORDINARY MISTAKE, and there are three promises:

  * IT NEVER RAISES. `repr(x)`, `str(x)` and `format(x)` all run the model's
    code, and a `__repr__` with a bug in it is an ordinary bug. One value among
    fifty must not cost `provenance.check` the other forty-nine -- and a raise
    from inside an `except` REPLACES the BuildError being built, which ends the
    build in EXIT_CRASHED for a line the author wrote. Everything here answers
    with text whatever the value does.
  * IT IS BOUNDED, so that ONE value cannot crowd out the rest of a message. An
    assert message built over a whole dict, an exception carrying a parser's
    entire input: both are ordinary, both are unbounded, and both land in a
    build log and sometimes in metrics.json -- which is public, immutable and
    never deleted.
  * IT KEEPS THE MESSAGE'S SHAPE. A refusal listing twenty numbers is read as
    one block; a newline inside one value's rendering breaks it into what looks
    like twenty. So a rendering is escaped, and `shown_and_rewritten` is what
    lets a caller say out loud that it was -- because silently rearranging what
    an author wrote is worse than saying so.

THE UNIT IS A VALUE AND NOT A STRING, which is what the first two need: the
RENDERING happens here, so a caller holding an object never calls `repr` on it
itself.

IT IS A MODULE OF ITS OWN because the files that need it cannot host it.
`provenance` imports `geometry` and `geometry` imports `modelchecks`, so the
arrows already run one way, and `checklib` is loaded BY PATH by the root shim
and makes no relative import at all. This imports `checklib` and nothing else,
the same leaf position `checklib` sits in -- which is also why `checklib`'s own
refusals cannot route through here and do their own escaping.
"""

from . import checklib

# What a truncated string ends in. Three ASCII dots rather than U+2026, because
# this string is printed into the build log and written into metrics.json beside
# author text, and one that renders as a box in somebody's terminal is a worse
# answer than one that does not.
_TRUNCATED = "..."

# What stands in for a value that would not render. It is deliberately not empty
# and not the word "None": a message reading `WALL = ` or `WALL = None` says
# something false about the model, while this says that the hub asked and the
# model's own code did not answer.
_UNRENDERABLE = "<unprintable>"

# How much of one model-written string a REFUSAL may carry, as against a
# DOCUMENT. The default ceiling everywhere below is `checklib.MAX_NOTE_CHARS`,
# because most of what comes through here ends up in metrics.json -- a public,
# immutable file with no retention -- and 200 is the one ceiling this whole
# system holds author-visible text to.
#
# THE EXCEPTION IS WHOLE SENTENCES WRITTEN TO BE ACTED ON, and 200 measurably
# spoils those. `checklib._text_problem` answers a refused note in about 300
# characters, and the actionable half is the SECOND half: cut at 200, an author
# is told their note has an unprintable character in it and not what to do about
# it. What gets this ceiling is therefore every value of that shape -- an
# exception a model raised, and the problem strings `checks()` returns -- passed
# EXPLICITLY at each site rather than made the default, so that the wide ceiling
# is the case somebody had to justify and not the one they get by not thinking.
#
# WHAT IT IS FOR IS ONE VALUE'S SHARE OF THE LOG, not the log's size: the log is
# already capped twice downstream (`buildproc.limits.log_bytes`, then
# `jobs.MAX_LOG_BYTES` at 3 MiB), so nothing here decides how big it gets. What
# this decides is whether ONE `__str__` can crowd out the twenty other lines of
# a refusal, and at this size twenty of them is still a message a person scrolls
# rather than one that scrolls past them.
MAX_MESSAGE_CHARS = 2000


def _escaped_char(char):
    """One character of a string, escaped if it would spoil a message."""
    if checklib._text_problem(char, "note") is None:
        return char
    return (f"\\u{ord(char):04x}" if ord(char) < 0x10000
            else f"\\U{ord(char):08x}")


def _verbatim(text):
    """The other escape: none at all.

    `shown_and_rewritten` needs to know whether the escape changed what it is
    about to SHOW, and the only exact way to answer that is to run the same
    capping without it and compare. See there.
    """
    return text


def escaped(text):
    """`text` with everything that could break a hub message's shape escaped.

    WHAT COUNTS AS UNSAFE IS `checklib._text_problem` ITSELF, asked one character
    at a time, rather than a fourth spelling of a scan this repository already
    holds three copies of. `str.isprintable()` is a fast path and only a fast
    path: it is False for every character in category C and for both line
    separators (they are Zl and Zp, i.e. Separator), so a string it calls
    printable holds nothing this would escape -- it can only ever send more
    strings down the slow path than are strictly necessary.

    ESCAPED RATHER THAN REFUSED, which is the decision and not the cheaper
    option. What comes through here is not prose an author wrote, it is the
    hub's own rendering of a model's object -- the inventory's pointer at a
    number (`GAPS['lid']`), the value in a refusal -- so a refusal would stop a
    build over the spelling of a dict key, and would have to quote that key in
    its message, which is the same problem one layer up. The treatment of these
    strings is already "make it fit" and not "refuse": the ceiling in
    `shown_text` truncates rather than raising.

    IT IS ABOUT LEGIBILITY AND NOTHING ELSE. A model that wants a line of the
    build log writes `print` and gets one -- the build log is the owner's own
    output, unfiltered, and `tests/cadbuild/test_model_text.py` measures that.
    What this keeps whole is the hub's own message that a value is sitting in
    the middle of.

    A `note` and a `source` are refused where they are WRITTEN, and that is a
    different rule at a different door: `checklib._text_problem` scans both at
    the point a `Number` is constructed. This one is about everything the hub
    itself assembles out of a model's objects afterwards.
    """
    if text.isprintable():
        return text
    return "".join(_escaped_char(char) for char in text)


def _fit(text, limit, escape):
    """A string escaped by `escape` and cut to `limit`. The shared body.

    ESCAPING FIRST AND CAPPING SECOND, because the ceiling is the promise a
    reader of metrics.json is given and an escape is what widens a string.
    Escaping a name and then cutting it leaves something under the ceiling;
    cutting and then escaping does not, and a `\\uXXXX` cut in half is still
    printable characters, so nothing is lost by the order that keeps the number
    true. Only the first `limit` characters can survive the cut, so that is all
    the escaping walks -- a bound that matters on a 500 000-character dict key
    and nowhere else.

    WHETHER IT WAS CUT IS DECIDED BEFORE THAT SLICE and not after, and this is
    where the first version was wrong: it sliced, escaped, and then asked
    whether what it held was over the ceiling -- which it never was, because the
    slice had just made sure of it. So a 500-character key came back at exactly
    200 characters with no `...` on the end, indistinguishable from a model that
    really has a 200-character key. There are two ways to be over the ceiling
    and both have to end in the marker: the original was longer, or the escape
    made it longer.
    """
    cut = len(text) > limit
    text = escape(text[:limit])
    if not cut and len(text) <= limit:
        return text
    return text[:limit - len(_TRUNCATED)] + _TRUNCATED


def shown_text(text, limit=checklib.MAX_NOTE_CHARS):
    """One string the model controls, as a message may carry it: safe and capped.

    THE CEILING IS THERE BECAUSE THESE STRINGS ARE UNBOUNDED and nothing else
    bounds them. `provenance` builds the inventory's name for a number out of a
    model's own dict KEY (`f"{name}[{key!r}]"`), and python puts no limit on a
    dict key or on an identifier; the same is true of an exception's own text,
    which is whatever f-string an author wrote. One of those in the middle of a
    refusal listing twenty numbers is the whole refusal, and a copy of it lands
    in metrics.json -- public, immutable, never deleted.

    `checklib.MAX_NOTE_CHARS` and not a number of this file's own: it is the
    same question about the same document -- how much author text one
    declaration may put in metrics.json -- and a fifth copy of 200 would be a
    fifth thing to keep in step (see the comment on that constant).

    IT TAKES A STRING AND ONLY A STRING. Where the value merely OUGHT to be one
    -- an exception's text, a note off an object -- the caller wants
    `shown(value, str)`, which renders it as well.

    `limit` IS THE ONE THING A CALLER CHOOSES: see MAX_MESSAGE_CHARS above for
    what earns the wide one.
    """
    return _fit(text, limit, escaped)


def _rendered(value, render):
    """`render(value)` as text -- always text, whatever the model's code does.

    TWO THINGS CAN GO WRONG WITH THAT CALL and both end in a string:

      * it raises. A `__repr__` that raises is an ordinary bug in a model, and
        it used to leave `provenance.check` as a bare `RuntimeError` -- not a
        `BuildError`, so the build process ended in EXIT_CRASHED (4) instead of
        EXIT_BUILD_FAILED (3), i.e. the hub reported its own breakage for a
        class the author wrote. Swallowing it HERE keeps the refusal whole,
        which the handler on `build.build` cannot do: that one fixes the exit
        code and loses the message;
      * it hands back something that is not a string at all. `__repr__` is
        obliged to return one by convention and not by the interpreter.

    A rendering that breaks the message's SHAPE is the third thing, and
    `escaped` above is what answers it.
    """
    try:
        text = render(value)
    except Exception as error:  # never raises: see above
        text = _refused(error)
    return text if isinstance(text, str) else _UNRENDERABLE


def shown_and_rewritten(value, render=repr, limit=checklib.MAX_NOTE_CHARS):
    """`shown(...)`, and whether the escape changed what it hands back.

    ONE RENDER ANSWERS BOTH HALVES, and that is the whole reason this is one
    function rather than a boolean a caller asks for separately. The sentence
    `modelchecks.run_checks` prints when the hub rewrote a check's own words
    used to be decided by rendering the value a SECOND time and escaping that,
    so a `__str__` answering differently on the two calls showed one string and
    reported about another.

    THE BOOLEAN IS ABOUT THE CHARACTERS THAT COME BACK, which took two goes to
    get right. It used to be `escaped(text[:limit]) != text[:limit]`, i.e. about
    the slice the escape WALKS -- but the escape widens a string, so what is
    returned is that slice cut again to `limit - 3`, and a newline sitting in
    the part cut away set the flag for a rewrite nobody can see. The exact
    question is answered by asking it exactly: run the same capping with no
    escape at all and compare the two results.
    """
    text = _rendered(value, render)
    displayed = _fit(text, limit, escaped)
    return displayed, displayed != _fit(text, limit, _verbatim)


def shown(value, render=repr, limit=checklib.MAX_NOTE_CHARS):
    """One value the model controls, as a message may carry it.

    THE RENDERING IS THE POINT. `repr(x)` by default, because that is what a
    message quoting a value wants; `format` where the value is a number being
    displayed as one, `str` where it is a string that may not be one. Whichever
    it is, it is CALLED HERE rather than in the f-string that needs it -- the
    call runs the model's own code, and every way it can go wrong ends in text
    (see `_rendered`). What it never does is raise, which is what lets a refusal
    listing twenty numbers survive one broken `__repr__` among them.
    """
    return shown_and_rewritten(value, render, limit)[0]


def _refused(error):
    """What stands in for a value whose own rendering raised.

    It NAMES THE EXCEPTION, because "<unprintable>" on its own sends the author
    looking for a hub bug: the sentence they need is that their own `__repr__`
    raised, and which exception it was is the whole of the lead.
    """
    return f"<unprintable: {type(error).__name__}>"
