"""`artifacts._brief`: somebody else's document, cut down to one terminal line.

IT HAD NO TEST AT ALL, and the one case that reaches it
(`test_a_document_shaped_wrong_is_refused_rather_than_walked_past` in
test_fetching.py) reads only the words around it — the field named and the
closing sentence — so every ceiling on this function could have been deleted
without a red run. What it is FOR is the reason that matters: the value is a
refused fragment of a reply, i.e. untrusted text of up to `MAX_REPLY_BYTES`,
printed straight into a terminal by `_not_from_the_hub`. Both halves of that
are checked here — WHAT THE CEILINGS ACTUALLY BOUND, which is the whole
rendering on a string and one pointer per key on a dict, and that nothing
unprintable reaches the line.

NO HUB AND NO MODEL DIRECTORY: this is a pure function of one value, and driving
it through a real push would only put a second set of rules between the input
and the output. The autouse fixture in conftest.py still applies and is still
wanted — it keeps the developer's own environment out of the run.
"""

import tracemalloc

from src.client import artifacts

# RIGHT-TO-LEFT OVERRIDE, the same character `test_fetching.py` plants in a file
# name: it reverses the run of text after it, so a terminal printing it raw
# shows the refusal in an order nobody wrote. Written as an escape rather than
# pasted, for the reason `test_fetching.py` and `artifacts.py` both give beside
# their own copies: a literal one reverses this very source line in every
# editor that reads it — including, here, the file that tests the escaping.
BIDI = "\u202e"

# What `hub.MAX_REPLY_BYTES` allows is tens of megabytes; four is enough to be
# unmistakable in the meter below and small enough to build in a test.
HUGE = 4 * 1024 * 1024

# The dict the other meter is about. 200 000 keys puts the per-key term two
# orders of magnitude above everything else in the measurement and still builds
# in well under a second.
KEYS = 200_000


def test_a_value_too_long_to_read_is_cut_to_one_line():
    """The ceiling, on both shapes a refused field arrives in."""
    assert len(artifacts._brief("y" * 5000)) == 120
    catalogue = {f"part{i:03d}": {"kind": "printable"} for i in range(500)}
    line = artifacts._brief(catalogue)
    assert len(line) <= 120, line
    assert "..." in line, line


def test_a_value_nested_deeper_than_the_document_can_be_is_collapsed():
    """`maxlevel`, and the cut has to be the LEVEL rather than the length.

    A buried value that is merely off the end of a long line would come back the
    day the ceiling above moved, so the case is written short enough that the
    120-character cut cannot be what removed it.
    """
    line = artifacts._brief({"a": {"b": {"c": {"d": {"e": "BURIED"}}}}})
    assert "BURIED" not in line, line
    assert "..." in line, line
    assert len(line) < 100, line


def test_the_deepest_shape_this_document_has_still_prints_whole():
    """The bracket on the other side: four levels is one more than `parts` needs.

    `parts` -> a record -> `files` -> a name is every level this document has,
    so a `maxlevel` set one tighter would elide the very value a refusal is
    about while every other test here went on passing.
    """
    line = artifacts._brief(
        {"lid": {"kind": "printable", "files": {"stl": "lid.stl"}}})
    assert "lid.stl" in line, line


def test_a_bidi_override_is_escaped_rather_than_printed():
    """The reason this is a `repr` at all and not a `str`.

    `reprlib` calls `repr` on the leaves, so a control character arrives as its
    escape. Checked on a KEY as well as on a string, because a hostile catalogue
    is likelier to carry one in the name of a part than in a value.
    """
    for value in (f"lid{BIDI}gnp.stl", {f"lid{BIDI}gnp.stl": "x"},
                  ["ok", f"{BIDI}evil"]):
        line = artifacts._brief(value)
        assert BIDI not in line, line
        assert "\\u202e" in line, line


def test_a_dict_is_printed_in_sorted_key_order_and_not_the_document_s():
    """The side effect of `reprlib`'s own `_possibly_sorted`, pinned deliberately.

    Nothing here reads the order, and the refusal names the field it is about
    anyway — but the line looks like a quotation of the document and is not one,
    so the difference is written down where somebody comparing the two will hit
    it rather than left as a surprise.
    """
    line = artifacts._brief({"zeta": 1, "alpha": 2})
    assert line.index("'alpha'") < line.index("'zeta'"), line


def test_a_reply_sized_value_is_never_materialized():
    """The whole reason this is `reprlib` and not `repr(value)[:120]`.

    MEASURED RATHER THAN REASONED, and the meter is checked against the spelling
    this replaced in the same run: `repr` of a four-megabyte string builds a
    four-megabyte string, which is what the second half asserts is visible here
    at all. Without it a threshold of 64 KB would pass just as happily against
    an instrument that was reporting nothing.

    `tracemalloc` is global state, so it is stopped in a `finally` — a test that
    left it running would meter every test after it — and the peak is reset
    inside the `start()`, the way `tests/test_archive_security.py` does it.

    WHAT THAT RESET BUYS IS NARROWER THAN IT LOOKS, and is written down because
    the generous reading is wrong: it drops a HISTORICAL peak left by earlier
    work in this process, and nothing else. `start()` on a stopped tracer
    already does that, so on an ordinary run the line changes nothing; on a
    tracer that was already running — `PYTHONTRACEMALLOC=1` — it sets the peak
    to the LIVE heap rather than to zero, so an absolute threshold like the one
    below is read against the forty-odd megabytes pytest is holding and fails
    anyway. `tests/test_archive_security.py` fails under that variable for the
    same reason. The line is here to match the pattern, not to survive it.
    """
    huge = "y" * HUGE

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        line = artifacts._brief(huge)
        _, cheap = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        naive = repr(huge)[:120]
        _, expensive = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert len(line) == 120
    assert len(naive) == 120
    assert expensive > HUGE, expensive
    assert cheap < 64 * 1024, cheap


def test_a_dict_still_costs_one_pointer_per_key_under_the_same_ceilings():
    """The other shape, where the ceilings buy a FACTOR and not the string.

    The test above is about a string, and the property it measures does not
    generalise — which is the whole reason this one is here. `repr_dict` cuts
    with `islice(_possibly_sorted(x), maxdict)` and `_possibly_sorted` is
    `sorted(x)` over EVERY key, so the list of pointers is built whole and only
    then cut: the megabyte a string never builds IS built here, as one pointer
    per key. `_brief` says so in as many words, and this is what that sentence
    is measured against.

    TWO-SIDED ON PURPOSE, and the two sides fail for different reasons. The
    floor is what fails when the meter stops measuring — a peak near zero
    passes any ceiling, which is the failure the string test guards against by
    metering the naive spelling beside it. The roof is what fails when the cost
    grows past a pointer per key; it sits below the cost of the RENDERING,
    whose one entry is eighteen characters on its own here, so a `reprlib` that
    stopped cutting before it built would land above it.
    """
    catalogue = {f"part{i:07d}": 1 for i in range(KEYS)}

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        line = artifacts._brief(catalogue)
        _, pointers = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert len(line) <= 120, line
    assert pointers > KEYS * 4, pointers
    assert pointers < KEYS * 12, pointers
