#!/usr/bin/env python3
"""Rendering a value the model wrote, for a message of the hub's.

Not a security barrier: model.py is the owner's own code (SPEC 7.9). The goal
is keeping hub messages readable when the model has an ordinary bug:

  * It never raises. `repr`/`str`/`format` run the model's code, and a raise
    inside an `except` replaces the BuildError being built (EXIT_CRASHED).
  * It is bounded, so one value cannot crowd out a message. Output lands in the
    build log and sometimes in metrics.json, which is public and immutable.
  * It keeps the message's shape: renderings are escaped so a newline in one
    value does not split a refusal; `shown_and_rewritten` reports when it did.

Callers pass values, not strings: rendering happens here.

A leaf module importing only `checklib`, so `provenance` and `modelchecks` can
both use it; `checklib` (loaded by path by the root shim) does its own escaping.
"""

from . import checklib

# What a truncated string ends in. ASCII rather than U+2026, which may render
# as a box in a terminal.
_TRUNCATED = "..."

# What stands in for a value that would not render. Not empty and not "None",
# which would say something false about the model.
_UNRENDERABLE = "<unprintable>"

# How much of one model-written string a refusal may carry. The default
# ceiling below is `checklib.MAX_NOTE_CHARS` (200), since most of this ends up
# in metrics.json. Whole sentences meant to be acted on (a model's exception
# text, problem strings from `checks()`) need more: `checklib._text_problem`
# explains a refused note in about 300 characters. Callers pass this explicitly.
# It bounds one value's share of a message; the log itself is capped by
# `buildproc.limits.log_bytes` and `jobs.MAX_LOG_BYTES`.
MAX_MESSAGE_CHARS = 2000


def _escaped_char(char):
    """One character of a string, escaped if it would spoil a message."""
    if checklib._text_problem(char, "note") is None:
        return char
    return (f"\\u{ord(char):04x}" if ord(char) < 0x10000
            else f"\\U{ord(char):08x}")


def _verbatim(text):
    """The other escape: none at all.

    `shown_and_rewritten` runs the same capping with this and compares.
    """
    return text


def escaped(text):
    """`text` with everything that could break a hub message's shape escaped.

    Unsafe means what `checklib._text_problem` flags, asked per character.
    `str.isprintable()` is only a fast path: it is False for category C and for
    the line/paragraph separators, so a printable string needs no escaping.

    Escaped rather than refused: this is the hub's rendering of a model's
    object (e.g. a dict key in `GAPS['lid']`), and refusing would stop a build
    over the spelling of a key. It is about legibility only; a model's own
    `print` reaches the build log unfiltered.

    A `note` and a `source` are refused separately, by
    `checklib._text_problem` when a `Number` is constructed.
    """
    if text.isprintable():
        return text
    return "".join(_escaped_char(char) for char in text)


def _fit(text, limit, escape):
    """A string escaped by `escape` and cut to `limit`. The shared body.

    Escape first, cap second: escaping widens a string, and the cap must
    hold on the result. Only the first `limit` characters can survive, so only
    they are escaped.

    Whether it was cut is decided before the slice: a string is over the
    ceiling if the original was longer or the escape made it longer, and both
    end in the `...` marker.
    """
    cut = len(text) > limit
    text = escape(text[:limit])
    if not cut and len(text) <= limit:
        return text
    return text[:limit - len(_TRUNCATED)] + _TRUNCATED


def shown_text(text, limit=checklib.MAX_NOTE_CHARS):
    """One string the model controls, as a message may carry it: safe and capped.

    These strings are unbounded (e.g. `provenance` names a number after a
    model's dict key, `f"{name}[{key!r}]"`), and copies land in metrics.json.

    Takes a string only; for a value that ought to be one, use
    `shown(value, str)`. See MAX_MESSAGE_CHARS for when to widen `limit`.
    """
    return _fit(text, limit, escaped)


def _rendered(value, render):
    """`render(value)` as text -- always text, whatever the model's code does.

    Both failure modes end in a string:

      * it raises (a buggy `__repr__`); swallowing it here keeps the refusal
        whole and the exit code EXIT_BUILD_FAILED;
      * it returns something that is not a string.
    """
    try:
        text = render(value)
    except Exception as error:  # never raises: see above
        text = _refused(error)
    return text if isinstance(text, str) else _UNRENDERABLE


def shown_and_rewritten(value, render=repr, limit=checklib.MAX_NOTE_CHARS):
    """`shown(...)`, and whether the escape changed what it hands back.

    One render answers both, so a `__str__` that answers differently on two
    calls cannot desynchronise them. The boolean is about the characters
    returned: the same capping is run without escaping and the results
    compared, so an escape in the part cut away does not count.
    """
    text = _rendered(value, render)
    displayed = _fit(text, limit, escaped)
    return displayed, displayed != _fit(text, limit, _verbatim)


def shown(value, render=repr, limit=checklib.MAX_NOTE_CHARS):
    """One value the model controls, as a message may carry it.

    `repr` by default; `format` for a number displayed as one, `str` for a
    value that ought to be a string. The render is called here so that any
    failure ends in text (see `_rendered`); this never raises.
    """
    return shown_and_rewritten(value, render, limit)[0]


def _refused(error):
    """What stands in for a value whose own rendering raised.

    Names the exception, so the author sees that their own `__repr__` raised.
    """
    return f"<unprintable: {type(error).__name__}>"
