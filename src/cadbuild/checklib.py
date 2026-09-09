"""Reusable geometry checks for the `checks()` in model.py.

NOT PART OF THE TEMPLATE, and this line used to say it was — "the shared half
of the template, like `scripts/` and the `Makefile`", which described a
directory in `cad_publish` that a project copied and that no longer exists.
This module ships INSIDE THE HUB'S IMAGE and is reached by the `checklib.py`
shim at the repository root; what `hammerola create` unpacks is `model_template/`,
and there is nothing of this file in it. A fix therefore rolls out with the
image, to every model at once, rather than being copied into projects — which is
the same rule read from the other end: the project author calls these and does
not edit them, and a `checklib.py` of one's own SHADOWS this one (the model's
directory goes first on `sys.path`) rather than extending it.

Every function measures the solids and returns a **list of problem strings**,
empty when nothing is wrong. That is the same shape `checks()` may return, so
a model composes them:

    import checklib

    def checks(out_dir):
        problems = []
        problems += checklib.pairwise_interference([body, lid], ["body", "lid"])
        problems += checklib.mating_face_flat(body, BOX_HEIGHT, name="body rim")
        return problems

Nothing here restates a constant from the model. Each function reads the shape
that actually came out of the modelling operations, which is the only way a
check can fail when the geometry drifts away from the numbers that drove it.

Axes are the model's own coordinates, and Z is up: `material_under_head`
probes along Z, `mating_face_flat` takes the height of the joint as `plane_z`.
A part modelled lying on its side has to be rotated before these two mean
anything.

ONE THING HERE IS NOT A CHECK: `Number` and the three constructors below it.
They are the other half of the same argument -- a check measures the solid that
came out, and a `Number` says where the figure that went in came from -- and
they live here because `checklib` is the name a model already imports. The
CHECKING of them is not here: it reads the project's files and has to know where
its root is, which is a different job from measuring a solid
(`cadbuild.provenance`). ONE function here does open a file -- `unsupported_area`,
which measures the mesh the gate already exported, because the orientation a part
is printed in is a property of that file and not of the solid -- and that is the
whole of this module's contact with a filesystem: it is handed the path and never
goes looking for one.
"""

import collections
import contextlib
# `@check` reads the decorated function's parameter names, so that a `needs`
# naming something the check does not take is refused where it is written
# rather than as a TypeError in a worker process twenty minutes later.
import inspect
import math
# For one existence check. `unsupported_area` measures the MESH the gate
# already wrote, so it is handed a path and has to be able to say that nothing
# is at it -- see the message there.
import os
import time
# `import types`, not `from types import SimpleNamespace`: a bare name
# imported here becomes a public name of this module, and the root shim then
# owes it a re-export (test_everything_a_model_calls_is_re_exported).
import types
import unicodedata

# CUBIC millimetres -- it is compared against volumes, and this line said
# "Millimetres" while `is_empty` said "cubic millimetres" a screenful below.
# Volumes below this are boolean noise, not overlap.
#
# IT WAS CALIBRATED FOR ONE QUESTION AND IS NOW USED FOR TWO. The question it
# was chosen for is "did this boolean BETWEEN TWO PARTS return real overlap or
# arithmetic dust"; `is_empty` asks it of a WHOLE PART, which is a different
# question with the same units and no measurement behind this value. It is
# reused rather than given a second constant because on this scale the two
# cannot disagree in practice: the smallest thing a printer can put down is a
# 0.4 mm extrusion at a 0.2 mm layer over 0.4 mm, i.e. 0.032 mm3, more than
# four orders of magnitude above this. A body that is real but under this
# threshold would have to be a sliver no process could make. Give `is_empty` a threshold
# of its own the day a caller has a reason to want a different one -- the
# parameter is already there.
DEFAULT_VOLUME_TOL = 1e-6
# A face normal is "in the plane" when its Z component is under this. Pure
# geometry, not a fudge: a wall meeting the joint at a right angle gives 0.0,
# a 45 deg chamfer gives 0.707, a fillet tangent to the joint gives 1.0.
# DIMENSIONLESS -- it is a component of a unit vector, never a length.
NORMAL_TOL = 1e-3
# Millimetres. How close to `plane_z` a face or an edge has to be to count as
# reaching the joint. A separate constant from NORMAL_TOL on purpose: the two
# happen to share a value and measure different things, and one parameter
# carrying both means a caller who widens the distance also, silently, widens
# what counts as a flat face.
PLANE_TOL = 1e-3

# There is no wall-thickness check that SWEEPS THE WHOLE PART here, and that is
# still on purpose. Measuring a wall by firing rays along surface normals gave a
# false red on ordinary spline geometry -- lofts, sweeps, imported STEP -- and no
# amount of filtering the artefacts made the number trustworthy. `thin_walls` is
# not that check and does not lift the ban: it measures only where the AUTHOR
# named a plane, and its error runs one way -- a wall oblique to a scan axis
# measures THICKER than it is, so it is missed rather than falsely accused.
# That last half is behaviour and therefore a test rather than this sentence
# (the 45-degree rib in tests/cadbuild/test_checklib_printability.py). What no
# plane names is still looked at by eye, on the preview and in the slicer.

# The nozzle a part is assumed to be printed through, in millimetres. A DEFAULT
# AND NOT A FACT, and the distinction is the whole reason it is written down
# once: it is one machine's number, and every caller that needed it would
# otherwise invent its own. A project printing through a different nozzle passes
# its own value and declares it with `measured()` (issue #56 "Provenance of
# numbers"); this constant is what stands in for a project that has not said,
# never a statement about the machine that will actually print the part.
NOZZLE_MM = 0.4
# Two extrusion widths. A wall thinner than that is printed as a single line,
# and a single line comes out at whatever width the slicer felt like: the
# nominal thickness stops being a dimension. This is the number a 0.5 mm thread
# crest on a 0.4 mm nozzle was under, and the 100 g of scrap that followed.
EXTRUSION_LINES = 2


def minimum_feature(nozzle_mm=NOZZLE_MM, lines=EXTRUSION_LINES):
    """The thinnest wall this machine prints as a dimension rather than a line.

    Millimetres. Under it the slicer stops laying the wall the model asked for
    and lays whatever single bead it can, so the dimension in the model and the
    dimension on the part stop being the same number. That is why this is a
    floor under a FEATURE and not a tolerance on one.
    """
    return nozzle_mm * lines


# --------------------------------------------------------------------------
# 0. Where a number came from
# --------------------------------------------------------------------------

# The three kinds of provenance, spelled once. `cadbuild.provenance` reads them
# off a Number rather than writing the words a second time, and the constructor
# below validates against KINDS rather than against a list of its own.
MEASURED = "measured"
DERIVED = "derived"
ESTIMATED = "estimated"
KINDS = (MEASURED, DERIVED, ESTIMATED)

# How long a `source` or a `note` may be. THE SAME 200 the hub holds every other
# displayed field to, and it is written out here rather than imported because of
# how this module is loaded: the root `checklib.py` shim loads this file BY PATH,
# under a name that never goes through `src`, so a `from .hubspec import
# MAX_NOTE_CHARS` here would fail on the one import path every model.py takes.
# `tests/cadbuild/test_checklib.py` is what ties the value to the others, the way
# `tests/client/test_limits.py` ties the client's copies -- the number is written
# twice and checked once, rather than written twice and hoped about.
#
# IT IS A CEILING RATHER THAN A STYLE RULE. The note travels into metrics.json,
# which is served at /project/<pid>/<commit>/metrics.json, is public, and is
# never deleted -- there is no retention. Nothing else bounded it: a 200 000
# character note made a 200 kB metrics.json, and the only ceiling underneath was
# the build process's RLIMIT_FSIZE of 256 MiB.
#
# THE FOUR COPIES OF 200 ARE ONE RULE ON PURPOSE, and that is a DECISION rather
# than a coincidence four files happen to agree on. They are this one,
# `hubspec.MAX_NOTE_CHARS`, `render.MAX_TEXT` and `hammerola.limits.MAX_TEXT_CHARS`,
# and nothing MECHANICALLY holds a note under the third: metrics.json is served
# as a file and never passes through `render._plain_text`, so a note is bounded
# here and nowhere else. The number is kept equal anyway, because one ceiling on
# author-visible text is something a person can hold in their head and four that
# drift is not -- and because narrowing this one later would retroactively
# refuse builds that used to pass, into immutable revisions nobody can rewrite.
# What that costs is a note ceiling that moves when somebody re-reasons about a
# heading: acceptable, and written down here so it is a choice the next reader
# can overturn deliberately.
#
# THERE IS ROOM OVER THE TEMPLATE, AND HOW MUCH IS NOT WRITTEN HERE. It was --
# "the longest note in `model_template/` is 130 characters of the 200" -- and
# the round that wrote the sentence added a 182-character note in the same
# breath, which left 130 the FOURTH longest note in that directory and the real
# room 18 characters rather than 70. A figure about another file, kept in a
# comment, has nothing to fail on. So the claim is a test instead:
# `tests/test_template.py::test_every_note_in_the_template_fits_under_the_ceiling`
# measures every string the template hands a constructor against this number,
# and the next note that outgrows it reddens there rather than rotting here.
# `tests/cadbuild/test_checklib.py` is what ties the four copies together.
MAX_NOTE_CHARS = 200

# The two characters Unicode calls line separators, which category C does NOT
# hold: U+2028 is Zl and U+2029 is Zp. `str.splitlines()` splits on both, so
# they do the one thing the category scan below exists to prevent: an
# `estimate: WALL = 2.4 -- ...` line comes back from splitlines() as TWO, and
# whatever follows the separator reads as a finding of its own. Every OTHER
# character splitlines() breaks on -- \v, \f, \x1c to \x1e and U+0085 -- is in
# category C and is caught by the scan itself, so these two are the whole of
# the gap.
#
# WRITTEN AS ESCAPES AND NOT AS THE CHARACTERS THEMSELVES. They are invisible,
# so a literal pair here is a line of source nobody can proofread -- and an
# editor that normalises them leaves this constant holding two spaces, which
# reads exactly the same and refuses nothing.
#
# Checked separately from the category scan rather than folded into it,
# deliberately: that scan has to keep answering exactly what
# `buildnames.first_nonprintable` answers (tests/cadbuild/test_checklib.py runs
# both over one corpus) and this is a second rule laid on top of it. Private,
# so the root shim owes it no re-export -- a model has no use for it.
_LINE_SEPARATORS = "\u2028\u2029"

# What to say about a string that is over the ceiling, and it differs by FIELD.
# One sentence written about a note used to be printed for both, and both halves
# of it are false of a `source`: `provenance.report()` publishes `notes` and
# nothing else, so a source never reaches metrics.json at all, and "put the
# working in the measurement journal" is not something anybody can do to a file
# path. Only the first sentence -- the count and the ceiling -- is in common.
#
# BY FIELD AND NOT BY KIND, which is why the note's advice names no single place
# to put the working. It used to end "put the working in the measurement
# journal", which is advice for `measured()` alone: `derived()` is explicitly for
# a figure that follows from other numbers -- a published standard among them --
# and has no journal behind it, so a note over the ceiling on a derivation was
# sent to a file that does not exist and need not.
#
# THE SENTENCE NAMES TWO OF THE THREE KINDS, and the third's absence is the
# point rather than an omission to be tidied up. A measurement's working goes in
# the journal it cites and a derivation's in the numbers it names, so each of
# those has somewhere to be sent; an ESTIMATE has nowhere -- the note is the
# whole of what is recorded about it -- so the advice tells its author to keep
# the one thing that settles the number and says nothing further, which is the
# only true thing there is to say. A sentence per kind is the obvious
# alternative and is not worth what it costs: `_text_problem` guards both fields
# and is given the field, so the kind would have to be threaded through it to
# add a clause for the kind that needs none.
_TOO_LONG_ADVICE = {
    "note": ("It is published in metrics.json and read by a person -- say the "
             "one thing that settles the number and leave the working out of "
             "it: a measurement's belongs in the journal it cites, a "
             "derivation's in the numbers it names"),
    "source": ("It is a path in this project with an optional #heading, not a "
               "sentence -- name the file the measurement is written down in "
               "and say the rest in the note"),
}


def _text_problem(text, field):
    """What is wrong with a `source` or a `note`, as a sentence, or None.

    FOUR THINGS, and every one of them is about where the string ENDS UP rather
    than about taste. It is written into metrics.json, printed into the build
    log, and served publicly at /project/<pid>/<commit>/metrics.json for as long
    as the revision exists:

      * a CEILING, because there was none. metrics.json is public, permanent and
        on a volume with no retention, and a note is author text of any length.
        `field` picks what to say about it -- the ADVICE differs, the count and
        the number do not;
      * NO CATEGORY-C CHARACTER. A note is printed as ONE line of the build
        log, so a `\\n` in it makes one estimate read as two -- and the
        invisible half of the category (U+202E and friends) reorders a sentence
        somebody is going to act on;
      * NO U+2028 OR U+2029 EITHER. They are Zl and Zp, so the category scan
        walks past both, and `str.splitlines()` splits on them -- one note, two
        lines, exactly as a `\\n` does. See LINE_SEPARATORS above;
      * IT HAS TO ENCODE. A surrogate arrives from
        `bytes.decode(errors="surrogateescape")`, and it does not reach a
        refusal: it reaches `print()` and `json.dumps(ensure_ascii=False)`,
        each raising UnicodeEncodeError -- not a BuildError, so the build ended
        in EXIT_CRASHED (4) rather than EXIT_BUILD_FAILED (3), i.e. reported as
        the hub's fault rather than the model's.

    WHY THE SCAN IS WRITTEN OUT HERE and not imported from `hammerola/buildnames.py`,
    which holds `first_nonprintable`: the root `checklib.py` shim loads this file
    by path, under a name that goes through no package at all, so this module
    makes no relative import and no first-party import either. Third copy of
    the scan is the cost, and `tests/cadbuild/test_checklib.py` is what makes it
    a shared rule rather than a second one -- it runs both over the same corpus.

    THE ENCODING BRANCH IS UNREACHABLE TODAY, and it is kept anyway. Every one of
    the 1114112 code points was enumerated: there is not one that fails to encode
    as UTF-8 and is not in category C, so the scan above always answers first --
    a lone surrogate comes back as a non-printable character and never as an
    encoding failure. It stands as the guard for the day that stops being true,
    which is the day somebody narrows the category scan to keep it equal to
    something else; it is not a second rule catching a case the first misses,
    and this paragraph used to claim it was.
    """
    if len(text) > MAX_NOTE_CHARS:
        return (f"is {len(text)} characters, and the ceiling is "
                f"{MAX_NOTE_CHARS}. {_TOO_LONG_ADVICE[field]}")
    for index, char in enumerate(text):
        if unicodedata.category(char).startswith("C"):
            return (f"has {char!r} at index {index}, which is not a printable "
                    f"character. It is printed as one line of the build log and "
                    f"served in metrics.json, so a newline makes it read as two "
                    f"and an invisible one reorders a sentence somebody acts on "
                    f"-- write it as one line of plain text")
        if char in _LINE_SEPARATORS:
            return (f"has {char!r} at index {index}, which splits a line. "
                    f"Unicode files it under Z and not C, so it looks printable "
                    f"and is not: str.splitlines() breaks on it, so the note "
                    f"reads as two lines exactly as a newline would -- write "
                    f"it as one line of plain text")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        return (f"cannot be encoded as UTF-8 ({error.reason} at index "
                f"{error.start}). It reached here from bytes decoded with "
                f"errors='surrogateescape' -- decode the source of it as UTF-8 "
                f"and the note will say what it was meant to say")
    return None


class Number(float):
    """A float that remembers where its value came from.

    A subclass of float, so it goes into cadquery arithmetic, into f-strings and
    into json exactly like the number it is -- a model that wraps a constant
    changes nothing about how the geometry is built.

    PROVENANCE DOES NOT PROPAGATE THROUGH ARITHMETIC, on purpose: `a * 2` is a
    plain float. A number worked out from other numbers has to say so with
    `derived()`, which is a sentence about WHICH numbers, and a rule that
    inferred it would be inventing that sentence.

    Built through `measured()`, `derived()` or `estimated()` -- those are what a
    model.py writes, and they are what says which of the three fields mean
    anything. This class is public because the check has to be able to
    recognise one, not because a model has a reason to call it.

    `__slots__` and no `__dict__`: this is a number, and a per-instance dict on
    something a model may hold thousands of is weight for nothing. That is also
    why `__reduce__` is spelled out below -- a float subclass with slots and no
    reducer pickles as a bare float, losing all three fields in silence, and
    the build runs the model in a process of its own.
    """

    __slots__ = ("kind", "source", "note")

    def __new__(cls, value, kind, source="", note=""):
        number = super().__new__(cls, value)
        if not math.isfinite(number):
            # A number that cannot be compared is not a measurement: every use
            # of one of these ends in an inequality, and nan loses every one of
            # them without failing any.
            raise ValueError(
                f"{kind}({value!r}) is not a finite number. A dimension that "
                "cannot be compared is not a measurement -- find the "
                "arithmetic that produced it rather than recording it")
        if kind not in KINDS:
            raise ValueError(
                f"a Number is one of {', '.join(KINDS)}, not {kind!r}")
        for field, text in (("source", source), ("note", note)):
            if not isinstance(text, str):
                raise TypeError(
                    f"{kind}(): {field} is {type(text).__name__}, and it is a "
                    "sentence for a person to read")
            # The field goes IN, not just into the prefix below: what to do
            # about a string over the ceiling is different advice for a path
            # than for a sentence (see _TOO_LONG_ADVICE).
            problem = _text_problem(text, field)
            if problem is not None:
                raise ValueError(f"{kind}(): {field} {problem}")
        # Through `object`, because `__setattr__` below refuses every other
        # write to these three for the life of the number.
        object.__setattr__(number, "kind", kind)
        object.__setattr__(number, "source", source)
        object.__setattr__(number, "note", note)
        return number

    def __setattr__(self, name, value):
        """A declared number does not change after it is declared.

        WHAT THIS CLOSES IS A CRASH, not a way of lying: the fields were plain
        slots, so `n.kind = "guessed"` took, and `provenance.report` then died
        on `counts[entry.number.kind]` with a bare `KeyError` -- which is not a
        `BuildError`, so the build ended in a traceback rather than in a
        message. The value itself is already immutable (this is a float), and
        making the three fields match it is what turns "a number's provenance
        is fixed at the point it is written" from a comment into something that
        holds.
        """
        raise AttributeError(
            f"a checklib.Number is fixed at the point it is declared, so "
            f"{name!r} cannot be set on one. Write a new number -- "
            f"measured(), derived() or estimated() -- rather than editing "
            f"where an existing one came from")

    def __delattr__(self, name):
        # Deleting a field is the same change as setting one, and it lands in
        # the same place: `report()` would raise AttributeError inside the
        # build instead of a BuildError.
        raise AttributeError(
            f"a checklib.Number is fixed at the point it is declared, so "
            f"{name!r} cannot be removed from one")

    def __reduce__(self):
        """Rebuild the whole thing, fields and all, on the far side of a pickle.

        Without this a float subclass carrying `__slots__` comes back as its
        VALUE and nothing else -- no kind, no source, no note, no error. The
        build already runs a model in a spawned process, and issue #76 pickles
        model-side objects across it, so the loss would be silent and remote.
        """
        return (self.__class__,
                (float(self), self.kind, self.source, self.note))


def measured(value, source, note=""):
    """A number somebody measured, and where the measurement is written down.

        SCREW_DIA = checklib.measured(3.0, "ref/measurements.md#screw",
                                      "caliper, 3 samples")

    `source` is `"<file>[#<heading>]"`, relative to the project root: a file in
    this project, and optionally the heading inside it. THE BUILD CHECKS THAT
    BOTH EXIST -- a source pointing at nothing refuses the build, because a
    measurement nobody can go and read is an estimate with better manners.
    """
    if not source:
        raise ValueError(
            "measured() needs the source of the measurement -- the file it is "
            "written down in, as \"ref/measurements.md#the-heading\". Use "
            "estimated(value, note) for a number nobody measured")
    return Number(value, MEASURED, source=source, note=note)


def derived(value, note):
    """A number worked out from other numbers. `note` says from which.

        TAP_DIA = checklib.derived(SCREW_DIA - 0.5, "the M3 tapping drill")

    Nothing about the derivation is verified, and nothing could be: demanding a
    formula would demand a second copy of the expression on the line above it.
    The note travels into metrics.json, where the next reader finds it.

    A FIGURE OFF A PUBLISHED STANDARD OR DATASHEET IS `derived`, AND THE NOTE
    NAMES THE STANDARD -- unless this project keeps a journal entry for it, in
    which case it is `measured` and points there. The rule is written down
    because the two worked examples of the contract classify the same kind of
    fact differently and both are right under it: README.md marks its ISO 4762
    head diameter `derived("... ISO 4762")`, having no journal, while
    `model_template/` marks its DIN 912 figures `measured` against
    `ref/measurements.md#screw`, where three samples out of the bag are written
    down. What decides is whether somebody here can go and READ the number's
    provenance -- which is the same question `measured()` is refused for
    failing.
    """
    if not note:
        raise ValueError(
            "derived() needs a note saying what the number follows from. "
            "Without it the declaration says only that somebody thought about "
            "it, which is what estimated() is for")
    return Number(value, DERIVED, note=note)


def estimated(value, note):
    """A number nobody measured. `note` says what would settle it.

        WALL = checklib.estimated(2.4, "four perimeters at a 0.6 mm nozzle; "
                                       "settled by printing one")

    IT BUILDS. This is the way out that always works, and it is not a defeat:
    most numbers in a first model are choices, and the point is that the build
    says so -- one `estimate:` line per number in the log, and a count in
    metrics.json -- rather than letting a guess pass for a figure somebody took.
    """
    if not note:
        raise ValueError(
            "estimated() needs a note saying what would settle the number. An "
            "estimate with no such sentence is the bare constant it replaced")
    return Number(value, ESTIMATED, note=note)


# Every pair pairwise_interference actually intersected, and the volume it
# measured -- including the zeroes, which are the ones worth keeping: a pair
# that reads 0.00 mm3 today and 4.10 mm3 tomorrow is a part that grew into its
# neighbour, and the build that reports it is the one where it happened.
#
# It is a RECORD OF WORK ALREADY DONE, not a second computation: the numbers are
# taken as the check goes, so cadbuild.metrics can put them in metrics.json
# single extra boolean. Pairs the cheap bounding-box reject skipped are not in
# here, because nothing measured them -- absence means "not computed", never
# "zero". Accumulates over the run: a model may call the check once per
# subassembly, and each call adds its own pairs.
_INTERFERENCE = {}


def recorded_interference():
    """`{"a|b": mm3}` for every pair pairwise_interference has measured so far."""
    return dict(_INTERFERENCE)


# What each `with section(...)` block of checks() cost, in seconds, summed by
# label. Written by `section` below; PRINTED BY THE CORE and not by the model
# (cadbuild.modelchecks.run_checks), so the table comes out on a failed build
# too -- which is the log somebody actually opens.
#
# The same shape as _INTERFERENCE above and for the same reason: a record of
# work already done, taken as the work goes, so reading it costs nothing and
# accumulates over the whole run. A label reused -- inside a loop, or in two
# places -- is ONE line whose seconds are the sum, which is the point: what a
# repeated stretch costs altogether is the number that decides anything.
#
# NESTED SECTIONS EACH MEASURE THEIR OWN WALL TIME, so an inner one is also
# inside its outer one's total and the column does not add up to the run.
# Left that way deliberately: subtracting inner time would make a label's number
# depend on where else it was used.
_SECTIONS = {}


@contextlib.contextmanager
def section(label):
    """Mark a stretch of checks() so the build log can say what it cost.

        def checks(out_dir):
            problems = []
            with checklib.section("interference"):
                problems += checklib.pairwise_interference(parts, names)
            with checklib.section("probe grid"):
                for x, y in grid:
                    assert solid(x, y, 2.0), f"no material at {x},{y}"
            return problems

    Seconds per label, longest first, printed by the build after checks() ends
    -- including when it ends by failing.

    WHY THIS AND NOT A DECORATOR ON A HELPER. The hub counts the checks in a
    model by reading the SOURCE of `checks()` (modelchecks.count_checks), and a
    `checks()` with no check in its own body fails the build outright -- "an
    empty checks() is worse than none". Splitting the body into decorated
    helpers would leave exactly that: a `checks()` that only calls things. A
    `with` block leaves every assert where the counter can see it, which is
    measured rather than assumed -- `tests/cadbuild/test_modelchecks.py` counts
    asserts and `problems +=` lines sitting inside one.

    WHY IT IS WORTH MARKING ANYTHING AT ALL. Phases of a build are timed by
    build.py, and on a real model measured 2026-08-29 that was not enough: the
    checks phase was 495 seconds and 52% of it sat in a single loop inside it,
    which no per-phase number can point at.

    The label is a string and is refused if it is not one -- it is a table
    heading, and a stray tuple or Path would come out as one.
    """
    if not isinstance(label, str):
        raise TypeError(
            f"section() takes a label to print, got {type(label).__name__}. "
            "Write it as `with checklib.section('the joint'):`.")
    started = time.monotonic()
    try:
        yield
    finally:
        # In `finally`, so a check that fails inside a section still leaves its
        # cost behind: the failed build is the one whose timing is read.
        _SECTIONS[label] = _SECTIONS.get(label, 0.0) + (time.monotonic() - started)


def recorded_sections():
    """`{label: seconds}` for every section() block that has finished so far."""
    return dict(_SECTIONS)


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

# There is no `_shape` helper here any more, and its absence is deliberate.
# It returned `Workplane.val()` -- the FIRST body -- under the justification
# "fine where one body is all there can be (a printable is one part)". Both of
# its callers took arbitrary assembly objects rather than printables, so the
# sentence excused nothing while reading like it had been checked: measured on
# cadquery 2.8.0, `pairwise_interference` missed 800.00 mm3 of interference
# because the overlap was with the SECOND body of a part, and
# `mating_face_flat` reported "there is no flat mating face there at all" for a
# joint that lay on the second body. Everything here goes through `_shapes`.
# Bring a first-body helper back only for a caller that can say why one body is
# all there can be -- and none of the callers here can.
def _shapes(obj, where):
    """Every body a Workplane holds, not just the first. A bare Shape is one.

    `val()` is the first object on the stack, so a Workplane put together with
    `.add()` gets judged on its first body alone. Measured on cadquery 2.8.0:
    two 10 mm boxes 50 mm apart, added into one Workplane, give `vals()` of
    length 2 -- and a classifier built on `val()` answers OUT at the centre of
    the second box.

    A LOCAL ANALOGUE OF `geometry.as_shapes` RATHER THAN AN IMPORT OF IT, and
    the reason is the same one that made `checklib.py` at the repository root
    resolve this file by PATH. That shim loads this module with
    `spec_from_file_location` under the name `src.cadbuild.checklib` without
    importing `src.cadbuild` at all, precisely because a model project owns the
    name `src` (its root goes on sys.path first, see geometry.load_model). A
    `from .geometry import as_shapes` here would ask for that parent package
    anyway and put the whole shim back behind the name it was taken out from
    behind. That is not a prediction: the import was tried, and it turns
    `test_the_shim_survives_a_model_project_that_has_a_src_of_its_own` red --
    the test asserts the name `src` is never touched at all -- along with
    `test_everything_a_model_calls_is_re_exported`, since an imported function
    is a public name of this module and the root shim would then owe it a
    re-export.

    The error discipline differs too, and it is not cosmetic: as_shapes raises
    BuildError, which belongs to the hub, while everything in this file raises
    what a model author's own code raises -- run_checks turns a ValueError or a
    TypeError out of checks() into a failed build with the message and the line,
    which is the same treatment an assert gets.

    An empty stack comes back as an empty list rather than as a refusal here:
    the caller that cares (material_at) has one message for "no geometry" and
    "geometry with no solid in it", because they are the same mistake.
    """
    shapes = list(obj.vals()) if hasattr(obj, "vals") else [obj]
    for shape in shapes:
        if not hasattr(shape, "BoundingBox"):
            raise TypeError(
                f"{where}: expected CadQuery geometry, got {type(shape).__name__}")
    return shapes


def material_at(part, name="part"):
    """A fast "is there material at this point" probe for one part.

    Returns a function `probe(x, y, z) -> bool`, built once and reusable for as
    many points as you like:

        solid = checklib.material_at(body)
        if not solid(0, 0, 12.5):
            problems.append("the boss is hollow where the screw seats")

    USE THIS INSTEAD OF INTERSECTING WITH A SMALL CUBE. Asking the question
    with a boolean -- `body.intersect(cq.Workplane().box(0.6, 0.6, 0.6)
    .translate(p))` and looking at the volume -- is the obvious way and it is
    the reason builds take minutes: a boolean on a complex solid costs
    milliseconds to tens of milliseconds and this costs microseconds. A model
    doing a few hundred of them (a scan along a channel, a probe grid over a
    seat) pays seconds against nothing. Measured on a real model, 2026-08-29:
    point probes done with booleans were the single largest line of a
    495-second check run.

    BUT THEY ARE NOT THE SAME QUESTION, and anybody replacing one with the
    other has to know where they part. A cube asks "is there material within
    half a cube of here"; this asks about the POINT. Away from surfaces they
    agree exactly. Within half the cube's diagonal of a face they need not: a
    point sitting 0.2 mm OUTSIDE the part is empty here and material to a
    0.6 mm cube, which reaches 0.3 mm in every direction. So a probe grid
    ported across without moving its points can flip exactly the answers that
    sit near a boundary -- which, in a check written to ask "is there material
    right up against this face", is most of them.

    The fix is to say what you mean rather than to tune a cube: put the point
    where material is REQUIRED -- half a millimetre inside the wall, not on its
    surface -- and the two agree again. `tests/cadbuild/test_material_at.py`
    pins both halves of this, the agreement and the disagreement.

    ON COUNTS AS MATERIAL. A probe landing exactly on a face is touching the
    part rather than hanging off it, which means a point that sits on a surface
    answers about the surface and not about what is behind it -- another reason
    to keep probe points off the faces.

    THE PROBE IS BOUND TO THE PART AS IT WAS WHEN YOU ASKED FOR IT. It holds a
    classifier over that shape; moving or rebuilding the part afterwards does
    not update it. Take a fresh probe after a transform, and do not cache one
    across a rebuild.

    EVERY BODY IS PROBED, not the first one. A Workplane put together with
    `.add()` holds several, and the probe covers all of them: it holds ONE
    CLASSIFIER PER SOLID and answers yes as soon as one of them says yes.
    Measured on cadquery 2.8.0 -- on two 10 mm boxes 50 mm apart added into one
    Workplane, a classifier built the old way (on `val()`) answered OUT at the
    centre of the second box.

    Per solid, and not over a compound of them, because a classifier built over
    a compound answers WRONGLY on bodies that touch or nest -- it is documented
    for a solid, and over a compound the nearest face wins whichever solid it
    belongs to. On two touching 10 mm boxes it read "no material" inside the
    second one; on a 20 mm box holding a 2 mm cube it read "no material" over
    most of the box. The comment at the code has the points and the cost.

    A PART WITH NO SOLID IN IT IS REFUSED rather than probed. That is what a
    boolean which removed everything leaves behind, and the reason for the
    refusal is that the alternatives lie -- see the message itself.

    Anything with a solid in it works -- a Workplane, a Shape, a Compound --
    exactly like the other checks here. `name` only improves the error message
    when it is handed something that is not geometry, or geometry with nothing
    in it.
    """
    # THE TYPE CHECK COMES FIRST, BEFORE THE KERNEL IS IMPORTED, and the order
    # is the whole point rather than style. `_shapes` is plain Python; the OCP
    # import below needs the native OpenCASCADE libraries, which exist in the
    # hub's image and in very few other places. With the import first, handing
    # this a string answered `ImportError: libGL.so.1` on any machine without
    # them -- an error about the environment, for a mistake in the argument,
    # and one that made a test of the refusal impossible to run anywhere the
    # kernel is absent. That is exactly how it was caught: CI went red on the
    # test that asserts the refusal, in a container that has no OpenCASCADE.
    shapes = _shapes(part, name)

    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    solids = [solid for shape in shapes for solid in shape.Solids()]
    if not solids:
        # TWO DIFFERENT EMPTIES, and one message describing both would be false
        # about one of them: a Workplane with an empty stack has no body at all,
        # while a boolean that removed everything leaves a body that still looks
        # like geometry. The second is the one worth explaining at length --
        # nothing about it says "empty" until the volume is asked for.
        if not shapes:
            what = (
                "there is nothing here at all -- `.vals()` is empty, so not "
                "even a body came through. An empty Workplane, or a stack that "
                "every operation dropped.")
        else:
            what = (
                f"{len(shapes)} object(s) came through, not one of them with a "
                "solid in it. A boolean that removed everything leaves exactly "
                "this, and it does not look empty: `.vals()` is still a list "
                "holding one Compound, so it is still truthy, and only the "
                "VOLUME says the material is gone (checklib.is_empty is how to "
                "ask). It is refused instead of probed because both ways of "
                "asking about such a body lie, measured on cadquery 2.8.0. "
                "Probed: BRepClass3d_SolidClassifier built on it answers IN at "
                "EVERY point -- (0, 0, 0), (1000, 1000, 1000) and "
                "(-50000, 30000, 7000) all read as material -- so every `assert "
                "solid(...)` written against it passes and the part is "
                "certified solid everywhere in the universe. Intersected: it "
                "answers as its PREVIOUS version, because Workplane.intersect "
                "resolves its operand with findSolid(searchParents=True), which "
                "walks back up the chain to the solid that was there before the "
                "boolean emptied it -- a 4 mm probe cube against an emptied "
                "10 mm box measured 64.00 mm3, the whole cube.")
        raise ValueError(
            f"material_at({name}): there is no solid here to probe -- {what} "
            "Find the operation that came back empty; the geometry is what is "
            "wrong, not the check.")

    # ONE CLASSIFIER PER SOLID, and the answers OR'd together. The obvious
    # alternative -- `Compound.makeCompound(solids)` and one classifier over it
    # -- is WRONG, and wrong quietly: BRepClass3d_SolidClassifier is documented
    # for a SOLID, and over a compound it resolves a point against the nearest
    # face among all of them, so a face belonging to a different solid decides
    # the verdict. Measured on cadquery 2.8.0, against per-solid classifiers and
    # against an independent check (a 0.2 mm cube intersected solid by solid),
    # which agreed with each other everywhere:
    #
    #   two 10 mm boxes 50 mm apart   compound right   val() wrong
    #   the same two boxes TOUCHING   compound WRONG   val() wrong
    #   20 mm box, 2 mm cube INSIDE   compound WRONG   val() right
    #
    # On the touching pair the compound answered "no material" at (7, 0, 0),
    # (10, 0, 0) and (12, 0, 0), all of which are inside the second box; on the
    # nested pair it answered "no material" at (4, 0, 0) and (8, 0, 0), which
    # are inside the 20 mm box -- so a model that added an insert with `.add()`
    # would have read as hollow over most of its own body. Note the third row:
    # there the compound is worse than the single-body classifier this replaced.
    #
    # THE COST IS O(number of solids) PER POINT rather than O(1), and the short
    # circuit only helps when the answer is yes. Measured on this machine,
    # 20000 probes: ~11 us per classifier consulted, so a miss over 3 solids is
    # 33 us against 11 us for one, while a hit on the first solid stays at ~11 us
    # whatever the count. An ordinary part is 1-3 solids. There is deliberately
    # no bounding-box prefilter in front of this: it has not been measured to be
    # needed, and it would be a second, subtler thing to get wrong.
    classifiers = [BRepClass3d_SolidClassifier(solid.wrapped) for solid in solids]

    def probe(x, y, z):
        # The point is built once and handed to each classifier in turn.
        point = gp_Pnt(float(x), float(y), float(z))
        for classifier in classifiers:
            classifier.Perform(point, 1e-7)
            if classifier.State() != TopAbs_OUT:
                return True
        return False

    return probe


def volume(obj):
    """Cubic millimetres of material, over every body and every solid in it.

    The one honest answer to "did anything survive that boolean". `assert
    wp.vals()` is the answer people write instead, and IT CANNOT FAIL: measured
    on cadquery 2.8.0, a 10 mm box intersected with a 1 mm box 100 mm away
    hands back a Workplane whose `.vals()` is a list of ONE Compound -- truthy,
    length 1, no solids inside it, total volume 0.0. In the model that produced
    this function an `assert wp.vals()` had stood for months over the line
    beneath it, which read a bounding box off exactly that empty compound.

    THE BOUNDING BOX IS NOT AN ALTERNATIVE either: `BoundingBox()` on that body
    raises `Standard_Failure: Bnd_Box is void`, so a check reaching for extents
    to see whether anything is left dies with a message about a box.

    Solids only, like everywhere else here -- a sketch, a wire or a loose face
    is not material and contributes nothing. A Workplane, a Shape and a Compound
    are all accepted, and every body of a Workplane is counted (`.add()` puts
    several on the stack).
    """
    shapes = _shapes(obj, "volume")
    # The 0.0 start is not decoration: `sum([])` is the int 0, and this function
    # promises cubic millimetres for every input including the empty one.
    return sum((solid.Volume() for shape in shapes for solid in shape.Solids()),
               0.0)


def is_empty(obj, tol=DEFAULT_VOLUME_TOL):
    """True when nothing of substance is left -- the predicate over volume().

        assert not checklib.is_empty(body), "the pocket cut the whole part away"

    Write this where `assert body.vals()` suggests itself: that one is true for
    an emptied body (see volume), so it is an assert that cannot fail.

    `tol` is in cubic millimetres. Its default is DEFAULT_VOLUME_TOL, which was
    chosen for a different question -- boolean noise between two parts, not
    emptiness of one -- and is reused because nothing printable comes anywhere
    near it; the reasoning is written out at the constant. Pass your own where
    that matters.
    """
    return volume(obj) <= tol


def _boxes_apart(a, b, tol):
    """True when two bounding boxes cannot possibly share a point."""
    return (a.xmin > b.xmax + tol or b.xmin > a.xmax + tol
            or a.ymin > b.ymax + tol or b.ymin > a.ymax + tol
            or a.zmin > b.zmax + tol or b.zmin > a.zmax + tol)


def _hull(boxes):
    """One box enclosing them all -- for rejecting a PART against a part.

    A multi-body part has no single bounding box of its own, and the one thing
    a prefilter may never do is reject a pair that does overlap. Measured on
    cadquery 2.8.0: a part whose bodies sit at X -5..5 and X 25..35 has a
    `val().BoundingBox()` of -5..5, so a neighbour at X 27..37 was rejected as
    "nowhere near" while sharing 800.00 mm3 with the second body. The hull is
    a superset of every body, so it can only ever be too generous -- and the
    per-body pair below is what makes it tight again.
    """
    return types.SimpleNamespace(
        xmin=min(b.xmin for b in boxes), xmax=max(b.xmax for b in boxes),
        ymin=min(b.ymin for b in boxes), ymax=max(b.ymax for b in boxes),
        zmin=min(b.zmin for b in boxes), zmax=max(b.zmax for b in boxes))


def name_pairs(pairs, argument, where=""):
    """Validate a list of name pairs and return it as a set of frozensets.

    `allowed_touching=("body", "lid")` is the mistake this exists for. It is a
    tuple of two strings, so it looks exactly like one pair -- and iterating it
    yields two *strings*, each of which frozenset() happily turns into a set of
    letters. Nothing raises, nothing matches, and the exemption the author
    wrote is silently not there. So: every element has to be a pair of strings,
    and anything else stops the check with a message that says which.

    Public, and shared: `cadbuild.views` validates a view's `nested_ok`
    with this same function. The two lists mean the same thing to two different
    checks, and when each file had its own copy of this the copies drifted --
    one of them ended up iterating the pair twice, which for a generator is
    once too many: the second pass sees nothing, `all()` over nothing is True,
    and a pair of non-strings walked straight through. One implementation, one
    behaviour, one message.

    `argument` names the option in the message ("allowed_touching",
    "nested_ok"); `where` is an optional prefix for the caller's context, e.g.
    "view 'print': ".

    Every element is consumed exactly once, so a generator of pairs -- and a
    generator *as* a pair -- is validated the same as a list.
    """
    if isinstance(pairs, str):
        raise ValueError(
            f"{where}{argument} must be a list of name PAIRS, got the string "
            f"{pairs!r}. Write it as [('a', 'b')]."
        )
    if not hasattr(pairs, "__iter__"):
        # The string above is the mistake somebody actually makes; this is
        # every OTHER thing that cannot be walked. Without it a number or a
        # None comes out of `for ... in pairs` as a bare TypeError from inside
        # a library, with nothing naming the option it came from -- and every
        # other refusal in this file names one.
        raise ValueError(
            f"{where}{argument} must be a list of name pairs, got "
            f"{pairs!r}, which cannot be iterated at all. Write it as "
            "[('a', 'b')]."
        )
    out = set()
    for index, pair in enumerate(pairs):
        if isinstance(pair, str) or not hasattr(pair, "__iter__"):
            raise ValueError(
                f"{where}{argument}[{index}] is {pair!r}, not a pair of names. "
                f"A flat {argument}=('body', 'lid') is two names, not one "
                "pair -- it matches nothing. Write "
                f"{argument}=[('body', 'lid')]."
            )
        # Once. `pair` may be a generator, and a second pass over it is empty.
        items = list(pair)
        if len(items) != 2 or not all(isinstance(x, str) for x in items):
            raise ValueError(
                f"{where}{argument}[{index}] is {pair!r}: a pair is exactly two "
                "part names, both strings."
            )
        out.add(frozenset(items))
    return out


# --------------------------------------------------------------------------
# 1. Interference between parts
# --------------------------------------------------------------------------

def pairwise_interference(objects, names, allowed_touching=(), tol=DEFAULT_VOLUME_TOL):
    """Every pair of parts, checked for shared volume. No hand-written list.

    Catches: a rim modelled a touch too generously passing straight through
    two neighbours, because the hand-written list of pairs to check happened
    to name neither of them. Enumerating pairs by hand is the bug -- the pair
    nobody thought of is exactly the pair that breaks -- so this takes every
    part in the assembly and checks all of them against each other.

    `objects` are the parts positioned as assembled (the same objects the
    `assembled` view shows), `names` their labels, one per object. Parts that
    are *meant* to share space -- a press fit, an insert modelled sunk into
    its boss -- go into `allowed_touching` as name pairs and are skipped:

        allowed_touching=[("body", "brass_insert")]

    A list of PAIRS, note: a flat `("body", "brass_insert")` is two names and
    exempts nothing, so it is rejected rather than ignored.

    Solids that only touch face to face intersect in zero volume, so seated
    parts pass without being listed. `tol` is in cubic millimetres and exists
    to swallow boolean noise, nothing more.

    A PART MAY BE SEVERAL BODIES and all of them are checked, against all of
    the other part's. What is reported is one line per PART pair: the volumes
    of every overlapping body pair added up, and the region enclosing them.
    That is the pair a person can act on -- "which two parts collide" -- and it
    keeps `allowed_touching`, which names parts, meaning what it says. When the
    kernel refuses one body pair the whole part pair is reported as untestable
    rather than answered from the rest: a partial sum understates the overlap
    while reading exactly like a verdict.

    Returns a list of problem strings.
    """
    # EVERY BODY OF EVERY OBJECT. An object here is a part as assembled, which
    # is routinely several bodies -- `.add()`, a helper returning a lid and its
    # lip -- and judging one of them was not a simplification but a hole: see
    # the note where `_shape` used to be for the 800.00 mm3 it measured through.
    bodies = [_shapes(obj, f"object #{i}") for i, obj in enumerate(objects)]
    names = list(names)
    if len(names) != len(bodies):
        raise ValueError(
            f"pairwise_interference got {len(bodies)} objects but {len(names)} names"
        )

    skip = name_pairs(allowed_touching, "allowed_touching")
    known = set(names)
    for pair in skip:
        unknown = sorted(pair - known)
        if unknown:
            raise ValueError(
                "allowed_touching names "
                f"{', '.join(repr(x) for x in unknown)}, which is not among "
                f"the parts handed in ({', '.join(repr(n) for n in names)}). "
                "An exemption for a part that is not there exempts nothing."
            )

    # Two levels of box, and they do different jobs. `hulls` rejects a PART
    # against a part in one comparison; `boxes` is per body, and rejects the
    # body pairs inside a part pair that survived. Neither may reject a pair
    # that overlaps, which is why the outer one is a hull rather than the first
    # body's box (see _hull).
    boxes = [[body.BoundingBox() for body in group] for group in bodies]
    hulls = [_hull(group) if group else None for group in boxes]
    problems = []

    for i in range(len(bodies)):
        for j in range(i + 1, len(bodies)):
            if frozenset((names[i], names[j])) in skip:
                continue
            # Cheap reject first: most pairs in an assembly are nowhere near
            # each other, and a boolean on a complex solid is not free.
            if hulls[i] is None or hulls[j] is None:
                continue  # an object with no bodies cannot overlap anything
            if _boxes_apart(hulls[i], hulls[j], 0.0):
                continue

            volume = 0.0
            region = []
            failure = None
            for bi, left in enumerate(bodies[i]):
                for bj, right in enumerate(bodies[j]):
                    if _boxes_apart(boxes[i][bi], boxes[j][bj], 0.0):
                        continue
                    try:
                        common = left.intersect(right)
                    except Exception as exc:  # OCCT gives up on some pairs
                        failure = exc
                        break
                    shared = sum(solid.Volume() for solid in common.Solids())
                    if shared > 0.0:
                        volume += shared
                        region.append(common.BoundingBox())
                if failure is not None:
                    break

            if failure is not None:
                # One body pair the kernel could not do makes the whole part
                # pair unanswerable: a partial sum would understate the overlap
                # and read like a verdict.
                problems.append(
                    f"cannot test {names[i]!r} against {names[j]!r}: the "
                    f"intersection failed ({type(failure).__name__}: {failure}). "
                    "Check that pair by eye."
                )
                continue

            # Recorded whether it is a problem or not -- see _INTERFERENCE.
            _INTERFERENCE["|".join(sorted((names[i], names[j])))] = volume
            if volume > tol:
                box = _hull(region)
                problems.append(
                    f"{names[i]!r} and {names[j]!r} share {volume:.2f} mm3 of "
                    f"space, in the region "
                    f"X {box.xmin:.1f}..{box.xmax:.1f}, "
                    f"Y {box.ymin:.1f}..{box.ymax:.1f}, "
                    f"Z {box.zmin:.1f}..{box.zmax:.1f}. "
                    "Parts cannot occupy the same volume; if this pair is a "
                    "press fit, list it in allowed_touching."
                )
    return problems


# --------------------------------------------------------------------------
# 2. The joint between two parts has to stay flat
# --------------------------------------------------------------------------

def mating_face_flat(part, plane_z, tol=PLANE_TOL, name="part",
                     normal_tol=NORMAL_TOL):
    """The face a split part mates on must be flat all the way to its edge.

    Catches: a chamfer or fillet applied to "all edges" biting into the
    parting line. The two halves then rest on their remaining flat rings and
    stand apart by the size of the bevel -- a 0.6 mm chamfer on each half is a
    1.2 mm gap in the assembled box. It reads as a modelling detail and costs
    a run of one-line fixes, each of which moves the problem to another edge.

    Purely geometric, no constants involved: every face that reaches the plane
    z == `plane_z` must either lie *in* it (the mating face itself) or leave
    it at a right angle (a wall). A face that departs at any other angle is a
    bevel eating the joint. The reported angle is measured from the plane: an
    honest vertical wall leaves at 90 deg (and is not reported), a 45 deg
    chamfer at 45, a fillet running tangent to the joint at 0. Vertical corner
    fillets and the walls of holes are all fine and are not reported.

    `plane_z` is the height of the joint in the part's own coordinates, so Z
    is the axis of the split.

    TWO TOLERANCES, because two different things are being measured and one
    parameter used to carry both. `tol` is MILLIMETRES: how close to `plane_z`
    a face or an edge has to be to count as reaching the joint, and how thin a
    face has to be in Z to count as lying in it. `normal_tol` is
    DIMENSIONLESS: the Z component of a unit normal below which the face is
    called upright. Passing a millimetre figure as `tol` used to also move the
    verdict, because the decisive comparison read the module constant instead
    of the argument -- so a caller who widened the search by a tenth of a
    millimetre got a mixture: a wider search and, still, the default verdict.

    Every edge of a face that lies in the plane is sampled, not just the first
    one: a single face can reach the joint along several edges -- a shelf that
    runs round three sides of a pocket, a chamfer broken by a hole -- and the
    bevel is as likely to be on the third edge as on the first. The worst edge
    of each face is the one reported.

    KNOWN GAP: a face that crosses the plane *transversally without having an
    edge in it* -- a sloped wall passing straight through the joint height, a
    cone whose surface simply continues past it -- is not covered. There is no
    edge to sample the normal at, and finding where such a face meets the
    plane means sectioning it, which costs more than this check is worth.
    Where that matters, split the part at the joint so the plane becomes a real
    edge, or check the section by eye.

    A part may be several bodies; the faces of all of them are examined
    together, so a joint carried by the second body counts exactly like one on
    the first.

    Returns a list of problem strings.
    """
    # EVERY BODY, and the faces of all of them pooled: a part is often several
    # bodies and the joint does not have to be on the first. Judging one body
    # gave a false RED, which is the worse direction -- measured on cadquery
    # 2.8.0, a two-body part whose second body carries the face at z=2 was told
    # "there is no flat mating face there at all".
    problems = []
    flat_area = 0.0
    seen_faces = 0

    for face in [f for shape in _shapes(part, name) for f in shape.Faces()]:
        box = face.BoundingBox()
        if box.zmin > plane_z + tol or box.zmax < plane_z - tol:
            continue  # nowhere near the joint
        seen_faces += 1

        if box.zlen <= tol:
            # Lies in the plane: this is the mating surface (or a piece of it).
            flat_area += face.Area()
            continue

        # Reaches the plane and leaves it. Sample the normal exactly where it
        # touches -- at the middle of an edge lying in the plane -- because
        # the middle of the face says nothing about the angle at the contact.
        # All such edges, worst one wins.
        worst = None
        for edge in face.Edges():
            ebox = edge.BoundingBox()
            if ebox.zlen > tol or abs(ebox.zmin - plane_z) > tol:
                continue
            point = edge.positionAt(0.5)
            try:
                normal = face.normalAt(point)
            except Exception:
                continue  # cannot sample this one; the others still count
            out_of_plane = abs(normal.z)
            if worst is None or out_of_plane > worst[0]:
                worst = (out_of_plane, point)

        if worst is None or worst[0] <= normal_tol:
            continue

        out_of_plane, point = worst
        # Angle from the plane: acos, not asin. The normal is perpendicular to
        # the face, so a normal fully out of plane (|nz| == 1) is a face lying
        # flat *along* it -- 0 deg, a tangent fillet -- and a normal lying in
        # the plane is an upright wall at 90.
        angle = math.degrees(math.acos(min(1.0, out_of_plane)))
        bite = max(box.zmax - plane_z, plane_z - box.zmin)
        problems.append(
            f"{name}: the mating face at z={plane_z:g} is cut by a "
            f"{face.geomType().lower()} face at "
            f"({point.x:.1f}, {point.y:.1f}) that leaves the plane at "
            f"{angle:.0f} deg and reaches {bite:.2f} mm past it. "
            "The joint is no longer flat: assembled, the halves stand "
            "apart by that much. Chamfer and fillet the other edges, "
            "not this one."
        )

    if seen_faces == 0 or flat_area <= 0.0:
        problems.append(
            f"{name}: nothing lies in the plane z={plane_z:g} -- there is no "
            "flat mating face there at all. Wrong height, or the joint was "
            "modelled away."
        )
    return problems


# --------------------------------------------------------------------------
# 3. Material under a screw head
# --------------------------------------------------------------------------

def material_under_head(part, centre, head_diameter, depth, name="part", angles=24):
    """A screw head (or counterbore) needs material under all of it.

    Catches: a screw boss placed close to a rounded corner, where part of the
    head footprint hangs over the edge. The hole is there, the screw goes in,
    and the head bears on half a ring -- visible only once the part is in your
    hand, or in a section view nobody took.

    Probes the outer rim of the footprint, which is where a head running off
    an edge loses its seat first, at several depths from the seating plane
    down. The clearance hole in the middle is deliberately not probed: it is
    supposed to be empty.

    **The probe runs along Z, and only along Z.** `centre` is (x, y, z) of the
    middle of the seating face in the part's own coordinates, and `depth` is
    measured down the Z axis from it: positive probes downwards (a head
    pressing on an upward-facing seat), negative probes upwards (a head
    seating from below). A screw going in sideways has to be checked on a
    rotated copy of the part -- there is no axis argument, because a check
    that quietly measured the wrong direction would be worse than none.

    `head_diameter` is the diameter of what bears on the seat: screw head,
    washer, or counterbore.

    `depth` may not be zero. With no depth every probe lands on the seating
    plane itself, where the classifier counts ON as material and the check
    passes for every part ever handed to it, hole or no hole.

    The probe comes from `material_at`, so this inherits both of its rules:
    every body of a Workplane is probed rather than the first, and a part with
    no solid left in it is refused instead of answering "material" everywhere.

    Returns a list of problem strings.
    """
    # Validated here as well as inside material_at below, and the point is the
    # ORDER: this is plain Python, the classifier needs the native kernel, and a
    # bad argument has to answer about the argument on a machine that has no
    # OpenCASCADE (the same reason material_at checks its type before importing
    # OCP). Nothing is kept -- the probe is built from `part` itself further
    # down, because collapsing it to one body here is the defect this call fixed.
    _shapes(part, name)

    try:
        cx, cy, cz = centre
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"material_under_head({name}): centre must be (x, y, z) of the "
            f"seating face, got {centre!r}"
        ) from exc

    if abs(depth) < 1e-9:
        raise ValueError(
            f"material_under_head({name}): depth is {depth!r}. With zero depth "
            "every probe sits on the seating plane itself, which counts as "
            "material, and the check passes for anything. Pass how deep the "
            "material has to run below the seat -- the plate thickness, the "
            "boss height -- or negative for a head seating from below."
        )

    inside = material_at(part, name)
    radius = head_diameter / 2.0
    levels = max(3, int(abs(depth) / 0.5) + 1)
    misses = []

    for i in range(angles):
        theta = 2.0 * math.pi * i / angles
        px = cx + radius * math.cos(theta)
        py = cy + radius * math.sin(theta)
        for k in range(levels):
            # Mid-cell sampling: the seating plane itself and the far face are
            # boundaries, and a probe sitting exactly on one says ON for a
            # reason that has nothing to do with the material in between.
            pz = cz - depth * (k + 0.5) / levels
            if not inside(px, py, pz):
                misses.append((px, py, pz, math.degrees(theta)))
                break

    if misses:
        px, py, pz, theta = misses[0]
        return [
            f"{name}: no material under the {head_diameter:g} mm head at "
            f"({cx:g}, {cy:g}, {cz:g}) -- {len(misses)} of {angles} points "
            f"around its rim sit over air, the first at "
            f"({px:.1f}, {py:.1f}, {pz:.1f}), {theta:.0f} deg round. "
            f"The head has no seat for the full {abs(depth):g} mm along Z: "
            "move the screw inwards, or grow the boss."
        ]
    return []


# --------------------------------------------------------------------------
# 4. Room for the tool that drives a fastener
# --------------------------------------------------------------------------

def tool_access(obstacles, names, *, origin, direction, diameter, length,
                name="fastener", rings=4, around=16, ignore=()):
    """A straight cylinder from a fastener head must be empty.

    Catches: a screw that is modelled, seated and unreachable -- a boss in the
    driver's way, a wall 3 mm from the head, a lid that has to go on before the
    screw can. Every view of the assembly looks right and the thing cannot be
    put together.

    `origin` is (x, y, z) of the head's seat and `direction` a vector pointing
    the way the tool comes FROM. It is normalised here and is NOT required to
    be Z, which is what separates this from `material_under_head`: a screw
    going in sideways is checked where it is, not on a rotated copy of the
    part. `diameter` is what has to be clear -- the driver, the socket, the
    ratchet head, whichever of them is fattest -- and `length` how far it has
    to stay clear for.

    `obstacles` are the parts that might be in the way, positioned as
    assembled, and `names` their labels, one per object. Parts that are allowed
    to sit in the path -- the one the screw goes through, a part fitted after
    the fastener is already in -- go into `ignore` by name. A name there that
    is not among `names` is refused rather than passed over, on the same
    reasoning as `pairwise_interference`'s `allowed_touching`: an exemption for
    a part that is not there exempts nothing.

    THE CYLINDER IS PROBED, NOT INTERSECTED: `around` points on each of `rings`
    radii, at a level every 0.5 mm along the axis, each point asked of every
    obstacle's classifier (`material_at`). The cost is `rings x around x levels`
    classifier calls per obstacle -- 2624 of them over a 20 mm reach at the
    default `rings` and `around`, measured at about 25 ms per obstacle on one
    workstation. The count follows from the REACH alone now and no longer from
    the diameter, so a thinner tool is not a cheaper one. That is NOT the
    cheaper of the two ways of asking, and the
    reason for it is therefore not the one at `material_at`: intersecting one
    cylinder with the same obstacle measured about 7 ms. What the sampling buys
    is the ANSWER -- how much of the path is blocked and how far along it the
    first blocked point sits, which is what the problem string below is written
    out of and what one intersection volume does not say.

    KNOWN GAP, and it follows from the sampling rather than from an oversight:
    something thinner than the spacing between two probe points slips between
    them unseen. THE THREE AXES ARE SPACED DIFFERENTLY, so which dial helps
    depends on how the thin thing lies. ACROSS the path -- the lid again -- the
    spacing is the 0.5 mm axial step above, which `rings` and `around` do not
    touch at all and which nothing here exposes. Anything one step thick or
    more meets a level wherever it sits; anything THINNER fits between two of
    them, and then whether it is seen depends on WHERE along the reach it
    happens to sit -- a 0.4 mm blade is found at some heights and missed at
    others, so there is no miss rate to quote, only that boundary. ALONG the
    path -- a fin standing edge-on inside the cylinder -- the spacing is
    `radius / rings` outwards (1 mm at the defaults for an 8 mm tool) and
    `2 pi radius / around` around (about 1.6 mm on the outermost ring), and
    THOSE are the two to raise. The axis itself carries no ring, so a rod
    thinner than `2 x radius / rings` standing on it is the same gap.

    Returns a list of problem strings, one per part found in the path.
    """
    # Plain Python first, over EVERY obstacle, before `material_at` below
    # reaches for the kernel. Same order and same reason as material_at's own
    # type check: leaving each object to be checked by its own material_at call
    # would answer about the argument for the first obstacle and about
    # libGL.so.1 for the second, on a machine with no OpenCASCADE. Nothing is
    # kept -- the probes are built from the objects themselves further down.
    obstacles = list(obstacles)
    for index, obstacle in enumerate(obstacles):
        _shapes(obstacle, f"obstacle #{index}")
    names = list(names)
    if len(names) != len(obstacles):
        raise ValueError(
            f"tool_access({name}) got {len(obstacles)} obstacles but "
            f"{len(names)} names")

    if diameter <= 0 or length <= 0:
        raise ValueError(
            f"tool_access({name}): diameter is {diameter!r} and length is "
            f"{length!r}, and both are sizes of the space the tool needs. With "
            "either at zero or below there is no cylinder to probe and the "
            "check passes for every assembly ever handed to it.")

    if rings <= 0 or around <= 0:
        raise ValueError(
            f"tool_access({name}): rings is {rings!r} and around is "
            f"{around!r}, and they are how densely that cylinder is sampled. "
            "With either at zero or below not one point is probed, so the "
            "check passes for every assembly ever handed to it -- the same "
            "silence a diameter of zero buys. Pass positive counts: the "
            "defaults are rings=4 and around=16.")

    unknown = sorted(set(ignore) - set(names))
    if unknown:
        raise ValueError(
            f"tool_access({name}): ignore names "
            f"{', '.join(repr(x) for x in unknown)}, which is not among the "
            f"obstacles handed in ({', '.join(repr(n) for n in names)}). "
            "A part that is not there is not in the way of anything.")

    ox, oy, oz = origin
    dx, dy, dz = direction
    span = math.sqrt(dx * dx + dy * dy + dz * dz)
    if span == 0:
        raise ValueError(
            f"tool_access({name}): direction is {tuple(direction)!r}, which "
            "names no axis -- a tool goes in ALONG something. Unguarded this "
            "divides by zero deep inside checklib and reports a line number "
            "that has nothing to do with the model.")
    ux, uy, uz = dx / span, dy / span, dz / span

    # Two unit vectors across the axis, to spread the ring points on. The
    # helper is picked away from the axis itself, so the cross product is never
    # the zero vector and the frame never collapses.
    hx, hy, hz = (0.0, 0.0, 1.0) if abs(uz) < 0.9 else (1.0, 0.0, 0.0)
    ax, ay, az = uy * hz - uz * hy, uz * hx - ux * hz, ux * hy - uy * hx
    scale = math.sqrt(ax * ax + ay * ay + az * az)
    ax, ay, az = ax / scale, ay / scale, az / scale
    bx, by, bz = uy * az - uz * ay, uz * ax - ux * az, ux * ay - uy * ax

    radius = diameter / 2.0
    # THE AXIAL STEP IS A LENGTH, not a share of the tool's radius, and that is
    # a correction rather than a preference. A step of one radius is 2.86 mm for
    # an 8 mm tool over a 20 mm reach, and an obstruction ACROSS the path -- the
    # lid at the top of the Catches list -- is thin along the axis and wide
    # across it: a 2 mm lid was walked straight over at 8 of the 30 heights it
    # was tried at, and raising `rings` and `around` did nothing about it,
    # because neither touches this axis. WHY HALF A MILLIMETRE: it is under
    # `minimum_feature()`, so a wall thick enough for this nozzle to print is
    # thicker than one step and cannot fall between two levels. Both halves of
    # that are behaviour rather than taste, so both are tests instead of this
    # sentence -- see the two named `..._axial_step_...` in
    # tests/cadbuild/test_checklib_printability.py.
    levels = max(3, int(length / 0.5) + 1)
    total = levels * rings * around
    problems = []

    for index, label in enumerate(names):
        if label in ignore:
            continue
        inside = material_at(obstacles[index], label)
        hits = 0
        first = None
        for k in range(levels):
            # Mid-cell sampling, for the reason material_under_head gives: the
            # seat is a boundary and a point sitting on it answers about the
            # part the screw goes into, not about the way to it.
            travel = length * (k + 0.5) / levels
            cx, cy, cz = ox + ux * travel, oy + uy * travel, oz + uz * travel
            for ring in range(rings):
                offset = radius * (ring + 1) / rings
                for step in range(around):
                    theta = 2.0 * math.pi * step / around
                    across, along = math.cos(theta), math.sin(theta)
                    px = cx + offset * (ax * across + bx * along)
                    py = cy + offset * (ay * across + by * along)
                    pz = cz + offset * (az * across + bz * along)
                    if inside(px, py, pz):
                        hits += 1
                        if first is None:
                            first = (px, py, pz, travel)
        if first is not None:
            px, py, pz, travel = first
            problems.append(
                f"{name}: {label!r} is in the way of the tool -- {hits} of "
                f"{total} points in the {diameter:g} mm cylinder running "
                f"{length:g} mm from ({ox:g}, {oy:g}, {oz:g}) sit inside it, "
                f"the first {travel:.1f} mm out at "
                f"({px:.1f}, {py:.1f}, {pz:.1f}). Nothing can reach the head "
                "past it: move the fastener, cut the obstruction back, or name "
                "the part in ignore if the tool goes in before that part does."
            )
    return problems


# --------------------------------------------------------------------------
# 5. A mating pair along its degree of freedom
# --------------------------------------------------------------------------

# Every pair swept_clearance has run and what the run measured: how many stops,
# the tightest gap seen and the stop it was at.
#
# The same kind of record as _INTERFERENCE above, and kept for the same reason
# -- the numbers are taken as the check goes, so cadbuild.metrics can put them
# in metrics.json without a single extra boolean, and a gap that reads 0.40 mm
# today and 0.05 mm tomorrow is a pair that grew together. Accumulates over the
# run: a model may sweep several pairs, and each call adds its own. Keyed by
# `label`, and a SECOND sweep under the same label writes over the first rather
# than keeping the tighter of the two -- a pair run along two degrees of freedom
# (a lid that drops and then slides) wants a `label=` of its own for each.
# Nothing is lost by that but the number: the problem strings come back per
# call either way. WHICH sweep is "second" stops being a fact about the file the
# moment the two sweeps sit in different check units: they run in parallel
# workers and the winner is whichever reported last, which is nothing anybody
# chose (`_merge_records`). A pair whose every stop the kernel refused is absent
# rather than zero -- absence means "not measured", never "touching".
_CLEARANCE = {}


def recorded_clearance():
    """`{label: {...}}` for every pair swept_clearance has measured so far."""
    # Copied one level deeper than recorded_interference, which hands back
    # floats: the values here are dicts, and a shallow copy would hand the
    # caller the very record the build reports.
    return {label: dict(record) for label, record in _CLEARANCE.items()}


def swept_clearance(moving_positions, fixed, *, names=("moving", "fixed"),
                    min_gap=None, tol=DEFAULT_VOLUME_TOL, label=None):
    """One mating pair, run along its degree of freedom, measured at every stop.

    Catches: a lid that fits where it ends up and fouls the rim halfway down; a
    hinge that clears at both ends of its travel and not in the middle.
    `pairwise_interference` looks at the assembly AS ASSEMBLED, which is
    exactly the one position such a pair is clean in.

    `moving_positions` is the moving part ALREADY PLACED at each stop -- a list
    the model builds, because only the model knows the kinematics. Ten to
    twenty stops is the useful range; fewer than two is not a sweep at all and
    is refused.

    Both numbers are taken at every stop: the volume the two share -- an
    interference is a hard problem string, the same rule pairwise_interference
    applies, and `tol` is the same boolean-noise tolerance -- and the minimum
    distance between the two solids. `min_gap` is optional: given, a stop
    closer than that is a problem; omitted, the gap is only measured and
    recorded, and nothing is judged by it.

    WHAT IS RECORDED, under `label`: `{"positions": n, "min_gap_mm": x,
    "at": i}` -- how many stops were run, the tightest gap seen and the stop it
    was at. `recorded_clearance()` reads it back and `cadbuild.metrics` puts it
    into metrics.json as `assembly.clearance`, beside the volumes
    pairwise_interference records -- so the gap is COMPARED between two builds,
    and a pair that reads 0.40 mm today and 0.05 mm tomorrow says so on the
    build where it happened.
    `label` defaults to `"moving|fixed"` from `names`, in the order
    they were given: unlike a pair of neighbours those two names are not
    interchangeable -- one of them is the part that moves -- so they are not
    sorted into the key the way pairwise_interference sorts its pair.

    Cost: a bounding-box reject, then one boolean and one distance per body
    pair per stop. A boolean on a real part is tens of milliseconds and a
    distance about the same, so eighteen stops is well under a second against a
    build ceiling of 900 seconds (buildproc.limits.DEFAULT_WALL_SECONDS).

    Returns a list of problem strings.
    """
    moving_name, fixed_name = names
    # The count is answered before any geometry is touched. It is a statement
    # about the LIST that was handed in rather than about a solid, and it has
    # to answer on a machine with no kernel for the same reason the type check
    # below runs before the OCP import.
    positions = list(moving_positions)
    if len(positions) < 2:
        raise ValueError(
            f"swept_clearance({moving_name}|{fixed_name}) got "
            f"{len(positions)} position(s). A sweep is the moving part at "
            "several stops along its travel; one position is the assembly as "
            "assembled, which is what pairwise_interference already checks. "
            "Ten to twenty stops is the useful range.")

    moving = [_shapes(obj, f"{moving_name} at position #{index}")
              for index, obj in enumerate(positions)]
    still = _shapes(fixed, fixed_name)

    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    if label is None:
        label = f"{moving_name}|{fixed_name}"
    fixed_boxes = [body.BoundingBox() for body in still]
    problems = []
    closest = None  # (gap, stop) -- the tightest approach measured so far

    for index, bodies in enumerate(moving):
        shared = 0.0
        gap = None
        failure = None
        for left in bodies:
            left_box = left.BoundingBox()
            for right, right_box in zip(still, fixed_boxes):
                # The reject skips the BOOLEAN and nothing else: boxes that
                # cannot touch cannot share volume, but the distance between
                # them is the very number this check exists to take.
                if not _boxes_apart(left_box, right_box, 0.0):
                    try:
                        common = left.intersect(right)
                    except Exception as exc:  # OCCT gives up on some pairs
                        failure = f"{type(exc).__name__}: {exc}"
                        break
                    shared += sum(solid.Volume() for solid in common.Solids())
                try:
                    measure = BRepExtrema_DistShapeShape(left.wrapped,
                                                         right.wrapped)
                except Exception as exc:
                    failure = f"{type(exc).__name__}: {exc}"
                    break
                if not measure.IsDone():
                    failure = "BRepExtrema_DistShapeShape came back not done"
                    break
                distance = measure.Value()
                if gap is None or distance < gap:
                    gap = distance
            if failure is not None:
                break

        if failure is not None:
            # One stop the kernel could not do is reported and the sweep goes
            # on: the stops around it are still worth measuring, and raising
            # here would take a whole build down over one degenerate pair.
            problems.append(
                f"cannot measure {moving_name!r} against {fixed_name!r} at "
                f"position {index} of {len(moving)}: the measurement failed "
                f"({failure}). Check this pair by eye.")
            continue

        if shared > tol:
            problems.append(
                f"{moving_name!r} runs into {fixed_name!r} at position "
                f"{index} of {len(moving)}, where they share {shared:.2f} mm3. "
                "Two parts cannot occupy the same volume anywhere along the "
                "travel, not only where they end up.")
        if gap is not None and (closest is None or gap < closest[0]):
            closest = (gap, index)

    if closest is not None:
        # Recorded whether it is a problem or not -- see _CLEARANCE.
        _CLEARANCE[label] = {"positions": len(moving),
                             "min_gap_mm": closest[0], "at": closest[1]}
        if min_gap is not None and closest[0] < min_gap:
            problems.append(
                f"{moving_name!r} comes within {closest[0]:.2f} mm of "
                f"{fixed_name!r} at position {closest[1]} of {len(moving)}, "
                f"closer than the {min_gap:g} mm this pair asked for.")
    return problems


# --------------------------------------------------------------------------
# 6. Downward surface with nothing under it
# --------------------------------------------------------------------------

def unsupported_area(stl_path, max_area_mm2, *, name="part",
                     max_angle_deg=45.0, bed_tol=0.2, max_rays=512):
    """Downward-facing surface with nothing under it, in square millimetres.

    Catches the overhang the author would otherwise have to find by eye on a
    preview. A triangle counts when its normal points below -cos(max_angle_deg)
    AND a ray dropped from its centroid hits nothing else in the mesh AND it is
    not sitting on the bed (within `bed_tol` of the mesh's lowest point, which
    is the first layer and is supported by the plate).

    THE MESH, NOT THE SOLID, and that is what makes this a check of the part AS
    IT WILL BE PRINTED: `stl_path` is the file the gate exported, so the
    orientation measured here is the orientation the slicer gets. The same
    shape lying the other way up is a different answer, which is the point.
    `checks(out_dir)` is handed the directory those files were written into and
    each of them is named after its part in `parts()`.

    `max_area_mm2` HAS NO DEFAULT on purpose. Some unsupported area is normal --
    a chamfer under a rim, a short bridge -- and a number picked here would be a
    number picked for somebody else's part. Saying how much this design tolerates
    is the author's decision, and writing it down is the point.

    THE NUMBER IS A FLOOR. Only the `max_rays` largest downward triangles are
    cast from, so a mesh with more overhang than that reports the part of it
    that was measured and never more. Raise `max_rays` and pay for it.

    THE RAY DROP IS WRITTEN HERE, IN NUMPY, and does not come from trimesh --
    which is a fact about this image rather than a preference. Every entry
    point of `trimesh.ray` walks a bounding-volume tree built by
    `trimesh.util.bounds_tree`, which imports `rtree`; `rtree` is not in
    requirements.txt and neither is `pyembree`, so `mesh.ray.intersects_any`
    raises ModuleNotFoundError in this interpreter. Measured 2026-09-08 on
    trimesh 4.12.2. What is here instead is the same test done directly: a
    point-in-triangle test in XY, plus the plane's height at that point, over
    every triangle whose XY box contains the centroid.

    Cost: the mesh is already on disk (the gate wrote it); loading is
    milliseconds. The drop is vectorised over triangles per ray, so it is
    `rays x triangles`, with an XY bounding-box reject in front of the
    arithmetic. Only downward triangles are cast from and only the `max_rays`
    largest of them, so the worst case is bounded: measured 2026-09-08, 512 rays
    against a 586k-triangle mesh took 1.1 s.

    Returns a list of problem strings.
    """
    # The path is answered BEFORE anything is imported, for the reason
    # `material_at` gives at its own type check: this is plain Python, and a
    # path with no mesh at it has to say so on a machine that has neither the
    # kernel nor trimesh -- which is where the test of this refusal runs.
    path = str(stl_path)
    if not os.path.exists(path):
        raise ValueError(
            f"unsupported_area({name}): there is no mesh at {path!r}. "
            "`checks(out_dir)` is handed the directory the build wrote its "
            "artefacts into, and the mesh of a part is named after the part "
            "in `parts()`: out_dir / (part + '.stl'). A name that is not a "
            "printable, or a path assembled from somewhere else, lands here.")

    # A NEGATIVE BUDGET IS REFUSED HERE rather than survived further down: it is
    # a number no part can meet, and the arithmetic below quietly stops making
    # sense at it -- a part with no overhang at all measures 0.0, which is not
    # `<= -1`, so the check would report a problem it has no patch to name.
    # Zero is a different matter and is allowed: "this part tolerates none" is
    # a decision an author can mean.
    if max_area_mm2 < 0:
        raise ValueError(
            f"unsupported_area({name}): max_area_mm2 is {max_area_mm2!r}. Area "
            "is never negative, so this budget cannot be met by any part, not "
            "even one with no overhang at all. Pass 0 to tolerate none.")

    import numpy
    import trimesh

    mesh = trimesh.load(path)
    # The same reading printables.first_layer_area makes, with `bed_tol` where
    # it has STL_TOLERANCE: the bed is the part's OWN lowest point, and a
    # triangle is on it when its HIGHEST vertex is still in the band. The plate
    # holds that triangle up, so it is not an overhang however it points.
    lowest = float(mesh.bounds[0][2])
    on_bed = mesh.triangles[:, :, 2].max(axis=1) - lowest <= bed_tol
    down = mesh.face_normals[:, 2] < -math.cos(math.radians(max_angle_deg))
    candidates = numpy.flatnonzero(down & ~on_bed)
    if candidates.size == 0:
        # A measured zero, not a refusal: a part with no steep downward face
        # off the bed is a part with nothing to support.
        return []

    areas = mesh.area_faces
    # Largest first, and only so many of them -- see THE NUMBER IS A FLOOR.
    cast = candidates[numpy.argsort(-areas[candidates])][:max_rays]

    triangles = mesh.triangles
    corner = triangles[:, 0]
    edge1 = triangles[:, 1] - corner
    edge2 = triangles[:, 2] - corner
    # The XY determinant of the two edges. A triangle standing on edge projects
    # to a line, has a determinant of zero and can never be under a point; it
    # is dropped here so the division below never sees one.
    det = edge1[:, 0] * edge2[:, 1] - edge2[:, 0] * edge1[:, 1]
    projects = numpy.abs(det) > 1e-12
    xmin = triangles[:, :, 0].min(axis=1)
    xmax = triangles[:, :, 0].max(axis=1)
    ymin = triangles[:, :, 1].min(axis=1)
    ymax = triangles[:, :, 1].max(axis=1)
    centres = mesh.triangles_center

    total = 0.0
    largest = None  # (area, centroid) of the biggest patch with nothing under it
    for index in cast:
        px, py, pz = (float(v) for v in centres[index])
        near = projects & (xmin <= px) & (xmax >= px) & (ymin <= py) & (ymax >= py)
        # The triangle the ray starts from is not something it can land on.
        near[index] = False
        under = numpy.flatnonzero(near)
        if under.size:
            dx = px - corner[under, 0]
            dy = py - corner[under, 1]
            # Barycentric coordinates of the centroid in each triangle's own XY
            # projection: P = A + u*E1 + v*E2, solved for u and v.
            u = (dx * edge2[under, 1] - dy * edge2[under, 0]) / det[under]
            v = (edge1[under, 0] * dy - edge1[under, 1] * dx) / det[under]
            hit = (u >= -1e-9) & (v >= -1e-9) & (u + v <= 1.0 + 1e-9)
            # The height of each triangle's plane at that XY point. Strictly
            # below, so a triangle sharing the plane the ray starts in is not a
            # thing standing under it.
            height = corner[under, 2] + u * edge1[under, 2] + v * edge2[under, 2]
            if numpy.any(hit & (height < pz - 1e-6)):
                continue
        area = float(areas[index])
        total += area
        if largest is None or area > largest[0]:
            largest = (area, (px, py, pz))

    if total <= max_area_mm2:
        return []

    if max_area_mm2 > 0:
        share = (f"{total / max_area_mm2:.1f}x the {max_area_mm2:g} mm2 this "
                 "part allows")
    else:
        # A budget of nothing has no ratio to be a multiple of.
        share = "against a budget of nothing"
    patch, (px, py, pz) = largest
    return [
        f"{name}: {total:.1f} mm2 of downward surface has nothing under it, "
        f"{share}. The largest such patch is {patch:.1f} mm2 at "
        f"({px:.1f}, {py:.1f}, {pz:.1f}) -- that is where to look. Turn the "
        "part over, add support, or raise the area this design tolerates and "
        "say why."
    ]


# --------------------------------------------------------------------------
# 7. Walls thinner than the part says they are
# --------------------------------------------------------------------------

def thin_walls(part, planes, min_thickness, *, name="part", pitch=None,
               step=None, axes=("x", "y", "xy", "yx")):
    """Walls thinner than `min_thickness`, measured on named sections.

    `planes` are heights in the part's own coordinates -- Z is the section
    normal, so a part modelled on its side is sectioned on its side. NAMED, not
    swept: the author says where the load-bearing and mating walls are, which is
    the difference between a check that can be trusted and the one this file
    refuses to have (see the note at the top of this module).

    On each plane the part is scanned with lines `pitch` apart, sampled `step`
    apart along each line, along four directions -- X, Y and the two diagonals.
    A continuous run of points inside the material is a crossing of a wall, and
    its length is how thick the wall is where that line crossed it. `pitch`
    defaults to `min_thickness` (a wall cannot hide between two scan lines that
    close), `step` to `min_thickness / 4`. A `step` PASSED BY HAND HAS TO DIVIDE
    `min_thickness` a whole number of times, AT LEAST TWICE, and is refused
    otherwise: a run is counted in whole steps, so an indivisible step moves the
    threshold off the number named -- a wall of exactly the minimum reported as
    thin where the ratio rounds up, a threshold quietly under the minimum where
    it rounds down -- while a single division leaves no run that can be short at
    all and passes every part there will ever be.

    ONE-SIDED ERROR BY CONSTRUCTION: a wall oblique to a scan axis measures
    thicker than it is, so this misses and never falsely accuses. Four axes cut
    the worst case to about 1.08x. `axes` names them, and NARROWING IT IS WHAT
    VOIDS THAT FIGURE: on `("x", "y")` alone a wall at 45 degrees measures
    sqrt(2) times its thickness, so the number to compare against is 1.41x and
    a wall a third over the minimum passes. Widening it costs a full scan per
    axis. The four keys above are the ones there are; anything else raises
    KeyError on the name that was passed.

    A SHORT RUN IS ONLY A WALL IF IT IS A WALL SIDEWAYS TOO, and that second
    probe is what keeps the sentence above true. Every convex corner tapers to
    nothing, so a scan line clipping one measures a fraction of a millimetre on
    a part with no thin wall anywhere -- measured on a 20 x 1.6 mm rib, where
    the diagonal axes cut the far corner into runs of 0.2 mm. So the midpoint of
    a short run is probed `min_thickness / 2` to either side ALONG the wall, and
    the run counts only if there is material at both: a wall is thin in one
    direction and long in the other, while an ordinary corner is short in both
    and is dropped. A FEATURE THAT TAPERS TO A SHARP POINT IS NOT DROPPED, and
    the sentence used to claim every corner was: measured 2026-09-08 on a 20 mm
    gusset at a 0.8 mm minimum, a 45-degree point still comes back clean, a
    31-degree one is named at 0.60 mm and an 8.5-degree one at 0.20 mm, because
    the material really is thinner than the minimum there and the probe to
    either side still lands in it. That is the truthful direction and it is
    left alone -- the check names
    what it measured, and whether the spike of a gusset is a wall is the
    author's call. A feature thinner than the minimum in EVERY direction is
    still missed rather than named, which is the direction this file errs in
    everywhere else.

    ONE PROBLEM STRING PER PLANE, naming the thinnest run found there, where it
    is, and how many runs came out under the threshold. A wall crossed by forty
    scan lines is one wall, and forty lines about it would bury the next one.

    `min_thickness` may not be zero or less: every run is longer than that, so
    the check would pass for every part ever handed to it.

    Cost: `(span / pitch) x (span / step)` classifier calls per axis per plane.
    For a 60 mm part at a 0.8 mm minimum that is ~76 lines x ~301 samples on the
    two straight axes and ~107 x ~425 on the two diagonals, which scan the
    bounding box corner to corner -- 137k probes, measured at 1.1 s on this
    machine (2026-09-08). It is linear in the number of planes, so a model
    naming twenty heights pays twenty times -- name the heights that matter.

    Returns a list of problem strings.
    """
    # Before the geometry and before the kernel: this is a statement about the
    # ARGUMENT, and it has to answer on a machine with no OpenCASCADE for the
    # same reason `material_at` checks its type before importing OCP.
    if min_thickness <= 0:
        raise ValueError(
            f"thin_walls({name}): min_thickness is {min_thickness!r}. Every "
            "run this can measure is longer than that, so the check would "
            "pass for every part ever handed to it -- which is worse than "
            "having no check, because it reads like one (issue #55). Pass the "
            "thinnest wall this part is allowed to have; "
            "checklib.minimum_feature() is the floor the nozzle sets, and a "
            "wall that carries anything is well above it.")

    # WHOLE STEPS ARE WHAT A RUN IS COUNTED IN, so `step` has to divide
    # `min_thickness` -- this is the condition the one-sided error above rests
    # on, and it is an argument check rather than a taste. A wall of exactly the
    # minimum is crossed by floor(min / step) samples or one more, and the scan
    # compares that count against `divisions`, the same ratio ROUNDED. An
    # indivisible step therefore moves the threshold off the number the author
    # named, and WHICH WAY IT MOVES depends on which way the ratio rounds.
    # Rounded up, a wall of exactly the minimum comes out one step short and is
    # named thin: measured, min 0.8 with step 0.3 reports a wall of exactly
    # 0.8 mm as 0.60 mm, which is the false red this check promises never to
    # give. Rounded down, nothing is falsely accused and the threshold quietly
    # becomes divisions * step instead -- 0.15 at the same minimum measures
    # against 0.75 mm. Neither is the number the author asked for.
    #
    # `divisions` IS ALSO WHAT THE SCAN COMPARES AGAINST, and that is the second
    # half of the same argument: `run * step < min_thickness` is arithmetic in
    # double, so 3 * 0.3 is 0.8999999999999999 and a wall of 1.1 mm at a 0.9 mm
    # minimum was named thin -- by a step this very check accepts, since the
    # division IS whole to 1e-9. Counting samples instead compares two integers
    # and loses nothing.
    if step is None:
        # ONE NUMBER, and the step derived from it: written twice, an edit to
        # either alone moves the detection threshold and nothing says so.
        divisions = 4
        step = min_thickness / divisions
    else:
        divisions = round(min_thickness / step) if step > 0 else 0
        if divisions < 1 or abs(divisions * step - min_thickness) > 1e-9:
            raise ValueError(
                f"thin_walls({name}): step is {step!r}, which does not divide "
                f"min_thickness {min_thickness!r} a whole number of times. A "
                "run is measured in whole steps, so an indivisible step moves "
                "the threshold off the number you named, one way or the other: "
                "0.3 at a 0.8 minimum measures a wall of exactly 0.8 mm as "
                "0.60 mm and calls it thin -- the false red this check promises "
                "never to give -- while 0.15 lowers the threshold to 0.75 mm "
                f"and misses everything between. Pass a divisor of "
                f"{min_thickness!r} (the default, min_thickness / 4, is one), "
                "or leave it out.")
        # A SINGLE DIVISION DIVIDES CLEANLY AND MEASURES NOTHING, so it needs
        # its own refusal: the message above would be a lie about it. With one
        # division no run can be shorter than one step, `run < divisions` is
        # never true, and the check returns nothing for every part there will
        # ever be -- including a rib eight times under the minimum, measured.
        # That is the failure the min_thickness refusal above is named after.
        if divisions == 1:
            raise ValueError(
                f"thin_walls({name}): step is {step!r}, the whole of "
                f"min_thickness {min_thickness!r}. A run is counted in whole "
                "steps, so nothing can come out under one step and this check "
                "would pass every part ever handed to it -- which is worse "
                "than having no check, because it reads like one. Pass a step "
                "that divides the minimum at least twice: min_thickness / 4 is "
                "the default, or leave step out.")

    # A STRING ITERATES BY CHARACTER, and both characters of "xy" are keys of
    # `directions` -- so the one axis the author named silently becomes the two
    # straight ones, no KeyError anywhere, and the worst case the docstring
    # promises goes from 1.08x to 1.41x. An unknown key does raise and names
    # itself, which is why there is no check for one; this input raises nothing
    # at all. Same shape as the `allowed_touching=("body", "lid")` mistake
    # `name_pairs` refuses.
    if isinstance(axes, str):
        raise ValueError(
            f"thin_walls({name}): axes is the string {axes!r}, which iterates "
            f"by character -- it asks for the axes {tuple(axes)!r}. Pass a "
            f"tuple of axis names: axes=({axes!r},).")

    shapes = _shapes(part, name)
    if pitch is None:
        pitch = min_thickness

    # ONE classifier for the whole call, however many planes and axes are
    # scanned: it is bound to the part as it was when it was asked for, and
    # building a second one per plane would pay for the same solids again.
    inside = material_at(part, name)
    # The extent to scan. Every body of the part, for the reason `_hull` gives:
    # a part is often several bodies and the wall does not have to be on the
    # first one.
    box = _hull([shape.BoundingBox() for shape in shapes])
    diagonal = math.sqrt(0.5)
    directions = {"x": (1.0, 0.0), "y": (0.0, 1.0),
                  "xy": (diagonal, diagonal), "yx": (diagonal, -diagonal)}
    corners = [(box.xmin, box.ymin), (box.xmin, box.ymax),
               (box.xmax, box.ymin), (box.xmax, box.ymax)]
    reach = min_thickness / 2.0

    problems = []
    for plane_z in planes:
        thin = []  # (length, x, y) for every run that is a wall and too thin
        seen_material = False

        for axis in axes:
            dx, dy = directions[axis]
            # The line runs along (dx, dy) and the lines are laid out along the
            # perpendicular, which is also the direction "sideways along the
            # wall" is measured in below.
            sx, sy = -dy, dx
            along = [x * dx + y * dy for x, y in corners]
            across = [x * sx + y * sy for x, y in corners]
            tmin, tmax = min(along), max(along)
            smin, smax = min(across), max(across)
            samples = int((tmax - tmin) / step) + 1

            for line in range(int((smax - smin) / pitch) + 1):
                s = smin + line * pitch
                run = 0
                # One pass past the end: the sentinel closes a run that reaches
                # the far side of the extent, which is the same code path as a
                # run that ends on material.
                for sample in range(samples + 1):
                    if sample < samples:
                        t = tmin + sample * step
                        x = t * dx + s * sx
                        y = t * dy + s * sy
                        if inside(x, y, plane_z):
                            run += 1
                            seen_material = True
                            continue
                    if run and run < divisions:
                        # The middle of the run, which is where the wall is.
                        middle = tmin + (sample - 1 - (run - 1) / 2.0) * step
                        mx = middle * dx + s * sx
                        my = middle * dy + s * sy
                        if (inside(mx + sx * reach, my + sy * reach, plane_z)
                                and inside(mx - sx * reach, my - sy * reach,
                                           plane_z)):
                            thin.append((run * step, mx, my))
                    run = 0

        if not seen_material:
            problems.append(
                f"{name}: nothing lies in the plane z={plane_z:g} -- the scan "
                "found no material anywhere in it, so there is no wall there "
                "to measure. Wrong height, or the part is modelled somewhere "
                "else.")
            continue

        if thin:
            length, mx, my = min(thin)
            problems.append(
                f"{name}: the thinnest wall in the plane z={plane_z:g} "
                f"measures {length:.2f} mm, at ({mx:.1f}, {my:.1f}, "
                f"{plane_z:g}) -- under the {min_thickness:g} mm this part "
                f"asked for, and {len(thin)} of the scan runs there came out "
                "under it. Thicken the wall, or say the smaller number here "
                "if the part is meant to be that thin.")
    return problems


# --------------------------------------------------------------------------
# Check units: one check, named, with the builders it needs
# --------------------------------------------------------------------------
#
# `checks()` is ONE function, so it is one process's worth of work however many
# cores are idle beside it -- and on the hub that is most of the build:
# measured on prod, checks() is 47-95% of a build's wall clock (ford-cup-4: 160
# of 169 seconds). A UNIT is one check pulled out of that function under a name
# of its own, together with the builders it needs, so the build can run several
# at once in processes of their own and put a budget on each. What runs them is
# `cadbuild.checkunits`; what is here is the registration and the record
# keeping, because both are state of THIS module and a second copy of either
# would be the bug the shim at the repository root exists to prevent.
#
# `needs` MAPS THE CHECK'S OWN PARAMETER NAMES TO TOP-LEVEL BUILDERS, never to
# keys of parts(). The catalogue is computed whole, so "take one part out of
# parts()" means "build all of them" -- which is exactly the cost a unit is
# meant to avoid paying more than once. The builders are the `@cache`-decorated
# functions a model already writes (`model_template/model.py`: `build_base`,
# `build_lid`), and a worker's own cache is what makes them cheap across every
# unit it draws.


# One registered unit. A namedtuple and not a dict so a typo in a field name is
# an AttributeError rather than a silent None; PRIVATE, because it is the shape
# `registered_units()` hands back and not something a model constructs.
_Unit = collections.namedtuple("_Unit", "name func needs")

# Every unit `check` has registered, keyed by the name it was registered under,
# in registration order. Module-level mutable state, like the three records
# below it, and cleaned by the same autouse fixture
# (tests/cadbuild/conftest.py): a unit left behind by one test is a unit the
# next test's build tries to run, in a worker process, against a model that
# never defined it.
_UNITS = {}


def check(name, needs=None):
    """Register one check as a UNIT the build may run in a process of its own.

        @checklib.check("lip joint", needs={"body": build_body, "lid": build_lid})
        def check_lip_joint(body, lid):
            assert lip_overlap(body, lid) > MIN_LIP, "lip joint too shallow"

    `name` is what the build log calls it -- in the timings table, and in the
    refusal when it fails. `needs` maps this check's OWN PARAMETER NAMES to the
    top-level builders that produce those arguments; the two lines a `checks()`
    opens with --

        base = build_base()
        lid = build_lid()

    -- are literally what becomes one `needs`. It is not a selection out of
    parts(): the catalogue is computed whole, so naming a part of it would
    build every part of the model.

    The function is returned UNCHANGED, so a model can still call it directly.

    A unit reports by RAISING -- an `assert` with a message is the intended way.
    Its budget is per unit and is enforced by killing the worker running it
    (`cadbuild.checkunits`), so a check that never returns costs minutes and one
    worker instead of the build's whole wall clock.

    EVERYTHING IS CHECKED HERE, at the `@` and not at the call, because the call
    happens in another process: a `needs` key that names no parameter of this
    function would otherwise surface as a bare TypeError out of a worker, on a
    build that has already spent its geometry phase.
    """
    if not isinstance(name, str) or not name.strip():
        got = "a blank string" if isinstance(name, str) else type(name).__name__
        raise TypeError(
            f"checklib.check() takes the name the build log will call this "
            f"check by, got {got}. It is a heading in the timings table and "
            f"the subject of the refusal when the check fails. Write it as "
            f"`@checklib.check('lip joint', needs={{...}})`.")
    mapping = {} if needs is None else needs
    if not isinstance(mapping, dict):
        raise TypeError(
            f"checklib.check({name!r}) takes `needs` as a dict mapping this "
            f"check's own parameter names to the builders that produce them, "
            f"got {type(needs).__name__}.")

    def register(func):
        if name in _UNITS:
            raise ValueError(
                f"checklib.check({name!r}) is registered twice. The name is "
                f"what the timings table and the refusal call this check, so "
                f"two of them would report as one -- give each its own name.")
        try:
            parameters = list(inspect.signature(func).parameters)
        except (TypeError, ValueError) as exc:
            raise TypeError(
                f"checklib.check({name!r}) cannot read the parameters of "
                f"{getattr(func, '__name__', func)!r}, so it cannot say "
                f"whether `needs` fills them: {exc}") from exc
        expected, given = set(parameters), set(mapping)
        if expected != given:
            missing = sorted(expected - given)
            extra = sorted(given - expected)
            raise ValueError(
                f"checklib.check({name!r}): `needs` and the parameters of "
                f"{getattr(func, '__name__', func)!r} do not match. "
                + (f"No builder is given for {missing}. " if missing else "")
                + (f"{extra} is in `needs` and is not a parameter of the "
                   f"check -- `needs` names the check's OWN arguments, not "
                   f"keys of parts(). " if extra else "")
                + f"The check takes {parameters or 'nothing'} and `needs` "
                  f"names {sorted(given) or 'nothing'}.")
        not_callable = sorted(key for key, value in mapping.items()
                              if not callable(value))
        if not_callable:
            raise TypeError(
                f"checklib.check({name!r}): {not_callable} in `needs` "
                f"is not callable. A value there is the BUILDER -- the "
                f"function itself, `build_lid` and not `build_lid()` -- "
                f"because the build calls it in the worker that runs this "
                f"check, once per worker rather than once per model.")
        _UNITS[name] = _Unit(name, func, dict(mapping))
        return func

    return register


def registered_units():
    """`{name: unit}` for every unit `check` has registered so far.

    A copy, for `recorded_sections()`'s reason: the caller must not be handed
    the registry the build is about to run out of.
    """
    return dict(_UNITS)


def _take_records():
    """The three records as they stand, EMPTIED -- the worker's half of a merge.

    PRIVATE, and that is a decision rather than a naming habit: the root shim
    re-exports every public name here, so a public spelling of this would hand
    a model a one-line way to wipe the interference and clearance numbers out
    of its own metrics.json. Reading them (`recorded_*`) is a model's business;
    emptying them is the build's.

    Called once per unit in a worker, so what comes back is that unit's OWN
    contribution rather than everything the worker has done since it started.
    Sending the whole accumulated record after each unit would make the parent
    add every section's seconds again for every later unit on the same worker.
    """
    taken = (dict(_INTERFERENCE), dict(_SECTIONS),
             {label: dict(record) for label, record in _CLEARANCE.items()})
    _INTERFERENCE.clear()
    _SECTIONS.clear()
    _CLEARANCE.clear()
    return taken


def _merge_records(interference, sections, clearance):
    """Fold one worker's records into this process's, each by its OWN rule.

    THE THREE RULES ARE NOT THE SAME and are each written where the record is
    declared: interference is keyed by pair and a pair measured twice measures
    the same, clearance is keyed by label and the record that arrives LAST
    replaces the ones before it, and sections SUM -- a label used in two units is
    one row whose seconds are the total, which is the same answer a
    single-process run gives for a label used twice in `checks()`.

    "LAST" IS NOT AN ORDER THE MODEL CHOOSES ANY MORE, and this sentence used to
    say it was: inside one `checks()` a second sweep under one label replaced the
    first, which is a rule an author can read off their own file top to bottom.
    Under K workers it is whichever worker REPORTED second, and nothing decides
    that -- the same two units can leave either number behind on two runs of the
    same build. Two sweeps under one label are therefore a coin toss rather than
    a replacement: give each sweep a label of its own and there is nothing for
    the race to pick between.

    Without this the records stay in the worker that filled them: metrics.json
    comes out with empty `interference_mm3` and `clearance` on a build that
    measured both, with nothing going red -- the exact failure the shim's
    docstring is about, one process further out.
    """
    _INTERFERENCE.update(interference)
    for label, seconds in sections.items():
        _SECTIONS[label] = _SECTIONS.get(label, 0.0) + seconds
    _CLEARANCE.update(clearance)
