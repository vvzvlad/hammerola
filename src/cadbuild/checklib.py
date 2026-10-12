"""Reusable geometry checks for the `checks()` in model.py.

Not part of the template: this module ships inside the hub's image and is
reached through the `checklib.py` shim at the repository root; `hammerola
create` unpacks `model_template/`, which contains none of it. A fix rolls out
with the image to every model at once. Authors call these and do not edit
them; a project's own `checklib.py` shadows this one (the model's directory
goes first on `sys.path`) rather than extending it.

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

`deviation` is not a check either: it returns a picture (catalogue entries for
`parts()`, one per colour band) and the figures behind it, because the
distance between a model and a scan of the real thing is something to look at.
Whether a number is a problem is the model's own `assert`.

`Number` and its three constructors are not checks: a check measures the solid
that came out, a `Number` says where the figure that went in came from. They
live here because `checklib` is what a model already imports; checking them
needs the project root and lives in `cadbuild.provenance`. The only function
here that opens a file is `unsupported_area`, which measures the mesh the gate
exported (print orientation is a property of that file); it is handed the path.
"""

import collections
import contextlib
# `@check` reads the decorated function's parameter names, so a `needs` naming
# something the check does not take is refused where it is written.
import inspect
import math
# `unsupported_area` measures the mesh the gate already wrote, so it must be
# able to say that nothing is at the path it was handed.
import os
import time
# `import types`, not `from types import SimpleNamespace`: a bare name
# imported here becomes a public name of this module, and the root shim then
# owes it a re-export (test_everything_a_model_calls_is_re_exported).
import types
import unicodedata

# Cubic millimetres. Volumes below this are boolean noise, not overlap.
#
# Calibrated for "did a boolean between two parts return real overlap"; also
# used by `is_empty` for a whole part. The two cannot disagree in practice: the
# smallest printable deposit (0.4 x 0.2 x 0.4 mm) is 0.032 mm3, four orders of
# magnitude above this. `is_empty` takes its own threshold if ever needed.
DEFAULT_VOLUME_TOL = 1e-6
# A face normal is "in the plane" when its Z component is under this. Pure
# geometry, not a fudge: a wall meeting the joint at a right angle gives 0.0,
# a 45 deg chamfer gives 0.707, a fillet tangent to the joint gives 1.0.
# DIMENSIONLESS -- it is a component of a unit vector, never a length.
NORMAL_TOL = 1e-3
# Millimetres. How close to `plane_z` a face or an edge has to be to count as
# reaching the joint. Separate from NORMAL_TOL: same value, different
# quantities, so widening one must not widen the other.
PLANE_TOL = 1e-3

# No wall-thickness check sweeps the whole part: ray-casting along surface
# normals gave false reds on spline geometry (lofts, sweeps, imported STEP).
# `thin_walls` measures only where the author named a plane, and errs one way:
# a wall oblique to a scan axis measures thicker, so it is missed rather than
# falsely accused (the 45-degree rib in
# tests/cadbuild/test_checklib_printability.py). What no plane names is checked
# by eye, on the preview and in the slicer.

# The nozzle a part is assumed to be printed through, in millimetres. A
# default, not a fact about the machine: a project with a different nozzle
# passes its own value and declares it with `measured()`.
NOZZLE_MM = 0.4
# Two extrusion widths. A thinner wall is printed as a single line at whatever
# width the slicer chooses, so its nominal thickness stops being a dimension.
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

# The three kinds of provenance, spelled once; `cadbuild.provenance` and the
# constructor below read them from here.
MEASURED = "measured"
DERIVED = "derived"
ESTIMATED = "estimated"
KINDS = (MEASURED, DERIVED, ESTIMATED)

# How long a `source` or a `note` may be. Written out rather than imported: the
# root `checklib.py` shim loads this file by path under a name outside `src`,
# so `from .hubspec import MAX_NOTE_CHARS` would fail for every model.py.
#
# A ceiling, not a style rule: the note goes into metrics.json, which is served
# publicly at /project/<pid>/<commit>/metrics.json and never deleted.
#
# The same 200 as `hubspec.MAX_NOTE_CHARS`, `render.MAX_TEXT` and
# `hammerola.limits.MAX_TEXT_CHARS`, kept equal so there is one ceiling on
# author-visible text (`render.MAX_TEXT` never applies to metrics.json, so the
# note is bounded only here). Narrowing it would refuse builds that pass
# today. `tests/cadbuild/test_checklib.py` ties the four copies together;
# `tests/test_template.py::test_every_note_in_the_template_fits_under_the_ceiling`
# checks the template's notes against it.
MAX_NOTE_CHARS = 200

# The two Unicode line separators outside category C (U+2028 is Zl, U+2029 is
# Zp). `str.splitlines()` splits on both, so one note would read as two lines.
# Every other character splitlines() breaks on is in category C and caught by
# the scan itself.
#
# Written as escapes: the characters are invisible, and an editor normalising
# them to spaces would silently disable the check.
#
# A separate rule on top of the category scan, which must keep matching
# `buildnames.first_nonprintable` (tests/cadbuild/test_checklib.py runs both
# over one corpus). Private, so the root shim owes it no re-export.
_LINE_SEPARATORS = "\u2028\u2029"

# What to say about a string over the ceiling, by field. A `source` never
# reaches metrics.json (`provenance.report()` publishes only `notes`) and is a
# path, not a sentence, so the advice differs; only the count is shared.
#
# The note's advice names where a measurement's and a derivation's working go;
# an estimate has nowhere else to record it, so the advice is just to keep the
# one thing that settles the number.
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

    The string goes into metrics.json, the build log, and is served publicly
    for as long as the revision exists, so four rules:

      * a length ceiling, since metrics.json is public and permanent. `field`
        picks the advice;
      * no category-C character: a note is printed as one log line, so `\\n`
        makes it read as two, and invisible ones (U+202E etc.) reorder a
        sentence somebody acts on;
      * no U+2028 or U+2029, which the category scan misses but
        `str.splitlines()` splits on (see _LINE_SEPARATORS);
      * it must encode: a surrogate (from `errors="surrogateescape"`) would
        reach `print()`/`json.dumps` as UnicodeEncodeError, crashing the build
        as EXIT_CRASHED instead of failing it as the model's fault.

    The scan is copied rather than imported from `hammerola/buildnames.py`:
    the root shim loads this file by path, so it makes no first-party import.
    `tests/cadbuild/test_checklib.py` runs both over one corpus.

    The encoding branch is currently unreachable (every code point that fails
    to encode is in category C); it guards against the scan ever being
    narrowed.
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

    A subclass of float, so it behaves exactly like the number in cadquery
    arithmetic, f-strings and json.

    Provenance does not propagate through arithmetic: `a * 2` is a plain float.
    A worked-out number must say from which numbers with `derived()`.

    Built through `measured()`, `derived()` or `estimated()`; the class is
    public so the check can recognise one.

    `__slots__` and no `__dict__`: a model may hold thousands. Hence the
    explicit `__reduce__`: a float subclass with slots and no reducer pickles as
    a bare float, losing all three fields, and the build runs the model in its
    own process.
    """

    __slots__ = ("kind", "source", "note")

    def __new__(cls, value, kind, source="", note=""):
        number = super().__new__(cls, value)
        if not math.isfinite(number):
            # Every use of one of these ends in an inequality, and nan loses
            # all of them without failing any.
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
            # The field goes in, because the advice for an over-long string
            # differs for a path and a sentence (see _TOO_LONG_ADVICE).
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

        Mutable fields let `n.kind = "guessed"` through, and `provenance.report`
        then died on `counts[entry.number.kind]` with a bare `KeyError` (not a
        `BuildError`). The value is already immutable; this makes the fields
        match it.
        """
        raise AttributeError(
            f"a checklib.Number is fixed at the point it is declared, so "
            f"{name!r} cannot be set on one. Write a new number -- "
            f"measured(), derived() or estimated() -- rather than editing "
            f"where an existing one came from")

    def __delattr__(self, name):
        # Deleting a field would likewise make `report()` raise AttributeError
        # instead of a BuildError.
        raise AttributeError(
            f"a checklib.Number is fixed at the point it is declared, so "
            f"{name!r} cannot be removed from one")

    def __reduce__(self):
        """Rebuild the whole thing, fields and all, on the far side of a pickle.

        Without this a float subclass with `__slots__` unpickles as its value
        alone, silently. Model-side objects are pickled across to spawned
        processes (check units).
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

    A figure off a published standard or datasheet is `derived`, with the note
    naming the standard -- unless this project keeps a journal entry for it,
    in which case it is `measured` and points there. README.md marks its ISO
    4762 head diameter `derived("... ISO 4762")` (no journal), while
    `model_template/` marks its DIN 912 figures `measured` against
    `ref/measurements.md#screw` (three samples recorded). What decides is
    whether somebody here can go and read the number's provenance.
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

    It always builds. Most numbers in a first model are choices; the build says
    so -- one `estimate:` line per number in the log, and a count in
    metrics.json -- rather than letting a guess pass for a measurement.
    """
    if not note:
        raise ValueError(
            "estimated() needs a note saying what would settle the number. An "
            "estimate with no such sentence is the bare constant it replaced")
    return Number(value, ESTIMATED, note=note)


# Every pair pairwise_interference actually intersected, and the volume it
# measured, zeroes included: a pair going from 0.00 to 4.10 mm3 is a part that
# grew into its neighbour.
#
# A record taken as the check goes, so cadbuild.metrics can put it in
# metrics.json at no extra boolean. Pairs skipped by the bounding-box reject
# are absent: absence means "not computed", never "zero". Accumulates over the
# run, since a model may call the check once per subassembly.
_INTERFERENCE = {}


def recorded_interference():
    """`{"a|b": mm3}` for every pair pairwise_interference has measured so far."""
    return dict(_INTERFERENCE)


# What each `with section(...)` block of checks() cost, in seconds, summed by
# label. Printed by the core (cadbuild.modelchecks.run_checks), not the model,
# so it appears on a failed build too.
#
# A reused label is one line with the summed seconds. Nested sections each
# measure their own wall time, so the column does not add up to the run;
# subtracting inner time would make a label's number depend on where else it
# was used.
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

    A `with` block rather than decorated helpers: the hub counts checks by
    reading the source of `checks()` (modelchecks.count_checks), and a
    `checks()` with no check in its own body fails the build. A `with` block
    keeps every assert visible to the counter
    (`tests/cadbuild/test_modelchecks.py` counts asserts and `problems +=`
    lines inside one).

    Build phases are timed by build.py; this points at the loop inside the
    checks phase that a per-phase number cannot.

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
        # In `finally`, so a failing check still records its cost.
        _SECTIONS[label] = _SECTIONS.get(label, 0.0) + (time.monotonic() - started)


def recorded_sections():
    """`{label: seconds}` for every section() block that has finished so far."""
    return dict(_SECTIONS)


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

# Everything here goes through `_shapes`, never `Workplane.val()` (the first
# body): the checks take arbitrary assembly objects, and a first-body helper
# missed interference and mating faces on a part's second body.
def _shapes(obj, where):
    """Every body a Workplane holds, not just the first. A bare Shape is one.

    `val()` is the first object on the stack, so a Workplane built with
    `.add()` would be judged on its first body alone (cadquery 2.8.0: two
    boxes added into one Workplane give `vals()` of length 2).

    A local analogue of `geometry.as_shapes` rather than an import: the root
    shim loads this module by path as `src.cadbuild.checklib` without
    importing `src.cadbuild`, because a model project may own the name `src`
    (its root goes first on sys.path, see geometry.load_model). Importing
    `.geometry` would require the parent package
    (`test_the_shim_survives_a_model_project_that_has_a_src_of_its_own`), and
    an imported function would also become a public name the shim must
    re-export (`test_everything_a_model_calls_is_re_exported`).

    Errors differ too: as_shapes raises the hub's BuildError, while this file
    raises what an author's own code raises (ValueError/TypeError), which
    run_checks reports with the message and line like an assert.

    An empty stack returns an empty list; material_at gives one message for
    "no geometry" and "geometry with no solid", since they are the same
    mistake.
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

    Use this instead of intersecting with a small cube: a boolean on a complex
    solid costs milliseconds to tens of milliseconds, this costs microseconds.
    A few hundred boolean probes (a scan along a channel, a grid over a seat)
    cost seconds; on one real model they were the largest line of a
    495-second check run.

    They are not the same question. A cube asks "is there material within half
    a cube of here"; this asks about the point. They agree away from surfaces,
    but a point 0.2 mm outside the part is empty here and material to a 0.6 mm
    cube. So put the point where material is required -- half a millimetre
    inside the wall, not on its surface -- and they agree again.
    `tests/cadbuild/test_material_at.py` pins both the agreement and the
    disagreement.

    On counts as material: a point exactly on a face answers about the surface,
    another reason to keep probe points off faces.

    The probe is bound to the part as it was when created; take a fresh one
    after a transform or rebuild.

    Every body is probed: one classifier per solid, answering yes as soon as
    one does. Not one classifier over a compound: that is documented for a
    solid only, and over a compound the nearest face wins regardless of solid
    (it read "no material" inside the second of two touching boxes, and over
    most of a 20 mm box holding a 2 mm cube). The comment at the code has the
    points and the cost.

    A part with no solid is refused rather than probed (see the message).

    Anything with a solid in it works -- a Workplane, a Shape, a Compound.
    `name` only improves the error message.
    """
    # The type check comes before the kernel import: `_shapes` is plain Python,
    # and with the OCP import first a wrong argument would surface as
    # `ImportError: libGL.so.1` on a machine without OpenCASCADE, and the
    # refusal test could not run there.
    shapes = _shapes(part, name)

    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_OUT

    solids = [solid for shape in shapes for solid in shape.Solids()]
    if not solids:
        # Two different empties: an empty stack has no body at all, while a
        # boolean that removed everything leaves a body that still looks like
        # geometry until its volume is asked for.
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

    # One classifier per solid, answers OR'd. A single classifier over
    # `Compound.makeCompound(solids)` is wrong: BRepClass3d_SolidClassifier is
    # documented for a solid, and over a compound the nearest face of any
    # solid decides. Measured on cadquery 2.8.0 against an independent check:
    #
    #   two 10 mm boxes 50 mm apart   compound right   val() wrong
    #   the same two boxes TOUCHING   compound WRONG   val() wrong
    #   20 mm box, 2 mm cube INSIDE   compound WRONG   val() right
    #
    # (touching: "no material" at (7,0,0), (10,0,0), (12,0,0) inside the second
    # box; nested: at (4,0,0) and (8,0,0) inside the 20 mm box.)
    #
    # Cost is O(solids) per point; a hit short-circuits. ~11 us per classifier
    # consulted (20000 probes). An ordinary part is 1-3 solids. No bounding-box
    # prefilter: not shown to be needed, and another thing to get wrong.
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

    The honest answer to "did anything survive that boolean". `assert
    wp.vals()` cannot fail: on cadquery 2.8.0 a 10 mm box intersected with a
    1 mm box 100 mm away gives `.vals()` of one Compound -- truthy, no solids,
    volume 0.0.

    The bounding box is no alternative: `BoundingBox()` on that body raises
    `Standard_Failure: Bnd_Box is void`.

    Solids only: a sketch, wire or loose face contributes nothing. Accepts a
    Workplane, a Shape or a Compound, counting every body of a Workplane.
    """
    shapes = _shapes(obj, "volume")
    # 0.0 start: `sum([])` is the int 0, and this promises cubic millimetres.
    return sum((solid.Volume() for shape in shapes for solid in shape.Solids()),
               0.0)


def is_empty(obj, tol=DEFAULT_VOLUME_TOL):
    """True when nothing of substance is left -- the predicate over volume().

        assert not checklib.is_empty(body), "the pocket cut the whole part away"

    Write this where `assert body.vals()` suggests itself: that one is true for
    an emptied body (see volume), so it is an assert that cannot fail.

    `tol` is in cubic millimetres; the default DEFAULT_VOLUME_TOL was chosen
    for boolean noise between two parts and is far below anything printable
    (see the constant). Pass your own where that matters.
    """
    return volume(obj) <= tol


def _boxes_apart(a, b, tol):
    """True when two bounding boxes cannot possibly share a point."""
    return (a.xmin > b.xmax + tol or b.xmin > a.xmax + tol
            or a.ymin > b.ymax + tol or b.ymin > a.ymax + tol
            or a.zmin > b.zmax + tol or b.zmin > a.zmax + tol)


def _hull(boxes):
    """One box enclosing them all -- for rejecting a PART against a part.

    A prefilter must never reject a pair that does overlap, and a multi-body
    part has no single bounding box: with bodies at X -5..5 and X 25..35,
    `val().BoundingBox()` is -5..5 and misses a neighbour at X 27..37. The hull
    covers every body, so it can only be too generous; the per-body pass makes
    it tight again.
    """
    return types.SimpleNamespace(
        xmin=min(b.xmin for b in boxes), xmax=max(b.xmax for b in boxes),
        ymin=min(b.ymin for b in boxes), ymax=max(b.ymax for b in boxes),
        zmin=min(b.zmin for b in boxes), zmax=max(b.zmax for b in boxes))


def name_pairs(pairs, argument, where=""):
    """Validate a list of name pairs and return it as a set of frozensets.

    `allowed_touching=("body", "lid")` is the mistake this exists for: a flat
    tuple of two strings looks like one pair, iterates as two strings, and
    frozenset() turns each into a set of letters, so the exemption silently
    matches nothing. Every element must be a pair of strings.

    Shared with `cadbuild.views`, which validates a view's `nested_ok` with
    it, so both lists get one behaviour and one message.

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
        # Anything else that cannot be iterated (a number, None) would
        # otherwise raise a bare TypeError naming no option.
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

    A hand-written list of pairs misses exactly the pair nobody thought of
    (a rim passing through two neighbours), so every part is checked against
    every other.

    `objects` are the parts positioned as assembled (the same objects the
    `assembled` view shows), `names` their labels, one per object. Parts meant
    to share space -- a press fit, an insert sunk into its boss -- go into
    `allowed_touching` as name pairs and are skipped:

        allowed_touching=[("body", "brass_insert")]

    A list of pairs: a flat `("body", "brass_insert")` is two names and is
    rejected rather than ignored.

    Solids that only touch face to face intersect in zero volume, so seated
    parts pass without being listed. `tol` is in cubic millimetres and only
    swallows boolean noise.

    A part may be several bodies; all are checked against all of the other
    part's. One line per part pair: the summed volume of every overlapping body
    pair and the region enclosing them. If the kernel refuses one body pair,
    the part pair is reported as untestable rather than as a partial sum that
    understates the overlap.

    Returns a list of problem strings.
    """
    # Every body of every object: a part as assembled is routinely several
    # bodies (`.add()`, a lid and its lip).
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

    # Two levels of box: `hulls` rejects a part against a part in one
    # comparison, `boxes` rejects body pairs inside a surviving part pair.
    # Neither may reject an overlapping pair (see _hull).
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

    Catches a chamfer or fillet on "all edges" biting into the parting line:
    the halves then rest on their remaining flat rings and stand apart by the
    bevel (a 0.6 mm chamfer on each half is a 1.2 mm gap).

    Purely geometric: every face that reaches the plane z == `plane_z` must
    lie in it (the mating face) or leave it at a right angle (a wall). Any
    other angle is a bevel eating the joint. The reported angle is from the
    plane: a vertical wall 90 deg (not reported), a 45 deg chamfer 45, a
    tangent fillet 0. Vertical corner fillets and hole walls are fine.

    `plane_z` is the height of the joint in the part's own coordinates, so Z
    is the axis of the split.

    Two tolerances for two quantities: `tol` is millimetres (how close to
    `plane_z` a face or edge must be to reach the joint, and how thin in Z a
    face must be to lie in it); `normal_tol` is dimensionless (the Z component
    of a unit normal below which the face is upright).

    Every edge of a face in the plane is sampled, since a face can reach the
    joint along several (a shelf round three sides of a pocket); the worst
    edge is reported.

    Known gap: a face crossing the plane without an edge in it (a sloped wall
    or cone continuing through the joint height) is not covered; finding that
    crossing needs sectioning. Split the part at the joint, or check the
    section by eye.

    The faces of all bodies of a part are examined together.

    Returns a list of problem strings.
    """
    # Every body's faces, pooled: the joint need not be on the first body.
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

    Catches a screw boss near a rounded corner where part of the head
    footprint hangs over the edge, so the head bears on half a ring.

    Probes the outer rim of the footprint, where a head loses its seat first,
    at several depths from the seating plane down. The clearance hole in the
    middle is not probed.

    **The probe runs along Z, and only along Z.** `centre` is (x, y, z) of the
    middle of the seating face in the part's own coordinates, and `depth` is
    measured down the Z axis from it: positive probes downwards (a head on an
    upward-facing seat), negative upwards (a head seating from below). A
    sideways screw must be checked on a rotated copy of the part; there is no
    axis argument, because silently measuring the wrong direction would be
    worse than no check.

    `head_diameter` is the diameter of what bears on the seat: screw head,
    washer, or counterbore.

    `depth` may not be zero: every probe would then sit on the seating plane,
    which counts as material, and the check would always pass.

    The probe comes from `material_at`, so every body is probed and a part with
    no solid is refused.

    Returns a list of problem strings.
    """
    # Validated before material_at so a bad argument is reported as such on a
    # machine without OpenCASCADE (as in material_at). Nothing is kept; the
    # probe is built from `part` itself below.
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
            # Mid-cell sampling: a probe exactly on the seating plane or the
            # far face would say ON regardless of the material in between.
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

    Catches a screw that is modelled and seated but unreachable: a boss in the
    driver's way, a wall 3 mm from the head, a lid that must go on first.

    `origin` is (x, y, z) of the head's seat and `direction` a vector pointing
    the way the tool comes from; it is normalised and need not be Z (unlike
    `material_under_head`). `diameter` is what must be clear (the fattest of
    driver, socket, ratchet head) and `length` how far.

    `obstacles` are the parts that might be in the way, positioned as
    assembled, and `names` their labels, one per object. Parts allowed in the
    path (the one the screw goes through, a part fitted afterwards) go into
    `ignore` by name; an unknown name there is refused, as with
    `allowed_touching`.

    The cylinder is probed, not intersected: `around` points on each of
    `rings` radii, at a level every 0.5 mm along the axis, each asked of every
    obstacle's classifier (`material_at`). That is `rings x around x levels`
    calls per obstacle -- 2624 over a 20 mm reach at the defaults, about 25 ms
    per obstacle -- set by the reach, not the diameter. One cylinder
    intersection is cheaper (~7 ms), but sampling gives how much of the path is
    blocked and where the first blocked point is, which the message reports.

    Known gap: anything thinner than the probe spacing can slip through. Across
    the path (a lid) the spacing is the fixed 0.5 mm axial step; something
    thinner may be found or missed depending on where it sits. Along the path
    (a fin edge-on inside the cylinder) the spacing is `radius / rings`
    outwards (1 mm at the defaults for an 8 mm tool) and `2 pi radius / around`
    around (~1.6 mm on the outer ring); raise those two. The axis has no ring,
    so a rod thinner than `2 x radius / rings` on it is the same gap.

    Returns a list of problem strings, one per part found in the path.
    """
    # Plain Python over every obstacle before `material_at` imports the kernel,
    # so a bad argument is reported as such on a machine without OpenCASCADE.
    # Nothing is kept; the probes are built from the objects below.
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
    # The axial step is a fixed length, not a share of the radius: an
    # obstruction across the path (a lid) is thin along the axis, and `rings`
    # and `around` do not touch this axis. Half a millimetre is under
    # `minimum_feature()`, so any printable wall is thicker than one step (the
    # two `..._axial_step_...` tests in
    # tests/cadbuild/test_checklib_printability.py).
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
            # Mid-cell sampling, as in material_under_head: a point on the seat
            # answers about the part the screw goes into.
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

# Every pair swept_clearance has run: how many stops, the tightest gap and the
# stop it was at.
#
# Like _INTERFERENCE: taken as the check goes so cadbuild.metrics can put it in
# metrics.json, and a gap going from 0.40 to 0.05 mm is a pair that grew
# together. Accumulates over the run, keyed by `label`; a second sweep under
# the same label overwrites the first, so a pair swept along two degrees of
# freedom needs a `label=` for each. Across check units the survivor is
# whichever reported last (`_merge_records`). A pair whose every stop the
# kernel refused is absent: "not measured", never "touching".
_CLEARANCE = {}


def recorded_clearance():
    """`{label: {...}}` for every pair swept_clearance has measured so far."""
    # One level deeper than recorded_interference: the values are dicts, and a
    # shallow copy would hand out the build's own records.
    return {label: dict(record) for label, record in _CLEARANCE.items()}


def swept_clearance(moving_positions, fixed, *, names=("moving", "fixed"),
                    min_gap=None, tol=DEFAULT_VOLUME_TOL, label=None):
    """One mating pair, run along its degree of freedom, measured at every stop.

    Catches a lid that fits where it ends up but fouls the rim halfway down,
    or a hinge clear at both ends and not in the middle --
    `pairwise_interference` only sees the assembled position.

    `moving_positions` is the moving part already placed at each stop, a list
    the model builds because only it knows the kinematics. Ten to twenty stops
    is the useful range; fewer than two is refused.

    At every stop: the shared volume (an interference is a problem, as in
    pairwise_interference, with the same `tol`) and the minimum distance
    between the solids. With `min_gap`, a closer stop is a problem; without
    it, the gap is only recorded.

    Recorded under `label`: `{"positions": n, "min_gap_mm": x, "at": i}`.
    `recorded_clearance()` reads it back and `cadbuild.metrics` publishes it
    as `assembly.clearance`, so the gap is compared between builds. `label`
    defaults to `"moving|fixed"` from `names` in the given order (unsorted,
    since one of them is the part that moves).

    Cost: a bounding-box reject, then one boolean and one distance per body
    pair per stop, tens of milliseconds each, so eighteen stops is under a
    second against the 300 s build ceiling
    (buildproc.limits.DEFAULT_WALL_SECONDS).

    Returns a list of problem strings.
    """
    moving_name, fixed_name = names
    # The count is checked before any geometry, so it answers on a machine
    # without the kernel.
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
                # The reject skips only the boolean: the distance between them
                # is still needed.
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
            # Report the stop and continue: the neighbouring stops are still
            # worth measuring, and one degenerate pair must not end the build.
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

    A triangle counts when its normal points below -cos(max_angle_deg), a ray
    dropped from its centroid hits nothing else in the mesh, and it is not on
    the bed (within `bed_tol` of the mesh's lowest point, which the plate
    supports).

    It measures the mesh, not the solid: `stl_path` is the file the gate
    exported, so the orientation is the one the slicer gets. `checks(out_dir)`
    is handed the directory those files are in, each named after its part in
    `parts()`.

    `max_area_mm2` has no default: some unsupported area is normal (a chamfer
    under a rim, a short bridge), and how much this design tolerates is the
    author's decision.

    The number is a floor: only the `max_rays` largest downward triangles are
    cast from. Raise `max_rays` and pay for it.

    The ray drop is plain numpy, not trimesh: every `trimesh.ray` entry point
    needs `rtree` (or `pyembree`), which is not in requirements.txt, so
    `mesh.ray.intersects_any` raises ModuleNotFoundError here (trimesh 4.12.2).
    Instead: a point-in-triangle test in XY plus the plane's height there,
    over every triangle whose XY box contains the centroid.

    Cost: `rays x triangles`, vectorised per ray with an XY box reject, bounded
    by `max_rays`; 512 rays against a 586k-triangle mesh took 1.1 s.

    Returns a list of problem strings.
    """
    # The path is checked before any import, so the refusal works on a machine
    # with neither the kernel nor trimesh (where its test runs).
    path = str(stl_path)
    if not os.path.exists(path):
        raise ValueError(
            f"unsupported_area({name}): there is no mesh at {path!r}. "
            "`checks(out_dir)` is handed the directory the build wrote its "
            "artefacts into, and the mesh of a part is named after the part "
            "in `parts()`: out_dir / (part + '.stl'). A name that is not a "
            "printable, or a path assembled from somewhere else, lands here.")

    # A negative budget can never be met (a part with no overhang measures 0.0,
    # which is not <= -1, and there would be no patch to name). Zero is allowed:
    # "this part tolerates none" is a real decision.
    if max_area_mm2 < 0:
        raise ValueError(
            f"unsupported_area({name}): max_area_mm2 is {max_area_mm2!r}. Area "
            "is never negative, so this budget cannot be met by any part, not "
            "even one with no overhang at all. Pass 0 to tolerate none.")

    import numpy
    import trimesh

    mesh = trimesh.load(path)
    # As in printables.first_layer_area, with `bed_tol` for STL_TOLERANCE: a
    # triangle whose highest vertex is within the band above the part's lowest
    # point is held up by the plate.
    lowest = float(mesh.bounds[0][2])
    on_bed = mesh.triangles[:, :, 2].max(axis=1) - lowest <= bed_tol
    down = mesh.face_normals[:, 2] < -math.cos(math.radians(max_angle_deg))
    candidates = numpy.flatnonzero(down & ~on_bed)
    if candidates.size == 0:
        # A measured zero: nothing steep and downward off the bed.
        return []

    areas = mesh.area_faces
    # Largest first, and only `max_rays` of them (the number is a floor).
    cast = candidates[numpy.argsort(-areas[candidates])][:max_rays]

    triangles = mesh.triangles
    corner = triangles[:, 0]
    edge1 = triangles[:, 1] - corner
    edge2 = triangles[:, 2] - corner
    # XY determinant of the two edges. A triangle standing on edge projects to
    # a line (zero determinant) and can never be under a point; dropping it
    # keeps the division below safe.
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
            # below, so a coplanar triangle does not count as under it.
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

    `planes` are heights in the part's own coordinates; Z is the section
    normal. Named, not swept: the author says where the load-bearing and mating
    walls are (see the note at the top of this module on why there is no
    whole-part sweep).

    On each plane the part is scanned with lines `pitch` apart, sampled `step`
    apart, along four directions (X, Y, the two diagonals). A continuous run of
    points inside material is a wall crossing, and its length is the wall's
    thickness there. `pitch` defaults to `min_thickness`, `step` to
    `min_thickness / 4`. A hand-passed `step` must divide `min_thickness` a
    whole number of times, at least twice: runs are counted in whole steps, so
    an indivisible step shifts the threshold (a wall of exactly the minimum
    reported thin, or a threshold silently under the minimum), and a single
    division can never report anything.

    One-sided error: a wall oblique to a scan axis measures thicker than it
    is, so this misses and never falsely accuses. Four axes bound the worst
    case at ~1.08x. Narrowing `axes` voids that: on `("x", "y")` a 45-degree
    wall measures sqrt(2) times its thickness. Each axis costs a full scan;
    an unknown key raises KeyError.

    A short run counts only if there is material `min_thickness / 2` to
    either side along the wall at its midpoint: every convex corner tapers to
    nothing (the diagonals cut a 20 x 1.6 mm rib's corner into 0.2 mm runs),
    and a corner is short in both directions while a wall is long in one. A
    feature tapering to a sharp point is still reported where it really is
    thinner than the minimum (on a 20 mm gusset at a 0.8 mm minimum: a
    45-degree point is clean, 31 degrees reports 0.60 mm, 8.5 degrees 0.20 mm);
    whether that spike matters is the author's call. A feature thin in every
    direction is missed rather than named.

    One problem string per plane: the thinnest run, where it is, and how many
    runs came out under the threshold.

    `min_thickness` must be positive, or every run passes.

    Cost: `(span / pitch) x (span / step)` classifier calls per axis per
    plane. A 60 mm part at a 0.8 mm minimum is ~137k probes, about 1.1 s;
    linear in the number of planes, so name the heights that matter.

    Returns a list of problem strings.
    """
    # Before the geometry and the kernel, so it answers on a machine without
    # OpenCASCADE (as in `material_at`).
    if min_thickness <= 0:
        raise ValueError(
            f"thin_walls({name}): min_thickness is {min_thickness!r}. Every "
            "run this can measure is longer than that, so the check would "
            "pass for every part ever handed to it -- which is worse than "
            "having no check, because it reads like one (issue #55). Pass the "
            "thinnest wall this part is allowed to have; "
            "checklib.minimum_feature() is the floor the nozzle sets, and a "
            "wall that carries anything is well above it.")

    # Runs are counted in whole steps, so `step` must divide `min_thickness`.
    # A wall of exactly the minimum is crossed by floor(min / step) samples or
    # one more, compared against `divisions` (the ratio rounded). If it rounds
    # up, a wall of exactly the minimum is named thin (min 0.8, step 0.3
    # reports 0.60 mm); if down, the threshold drops (0.15 measures against
    # 0.75 mm).
    #
    # Comparing integer sample counts against `divisions` also avoids float
    # error: `3 * 0.3 < 0.9` is true in double.
    if step is None:
        # One number, with the step derived from it, so the threshold has a
        # single definition.
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
        # A single division divides cleanly but measures nothing: no run can be
        # shorter than one step, so every part would pass.
        if divisions == 1:
            raise ValueError(
                f"thin_walls({name}): step is {step!r}, the whole of "
                f"min_thickness {min_thickness!r}. A run is counted in whole "
                "steps, so nothing can come out under one step and this check "
                "would pass every part ever handed to it -- which is worse "
                "than having no check, because it reads like one. Pass a step "
                "that divides the minimum at least twice: min_thickness / 4 is "
                "the default, or leave step out.")

    # A string iterates by character, and both characters of "xy" are keys, so
    # `axes="xy"` would silently scan X and Y and the worst case would go from
    # 1.08x to 1.41x. Same shape as the `allowed_touching=("body", "lid")`
    # mistake `name_pairs` refuses.
    if isinstance(axes, str):
        raise ValueError(
            f"thin_walls({name}): axes is the string {axes!r}, which iterates "
            f"by character -- it asks for the axes {tuple(axes)!r}. Pass a "
            f"tuple of axis names: axes=({axes!r},).")

    shapes = _shapes(part, name)
    if pitch is None:
        pitch = min_thickness

    # One classifier for the whole call, however many planes and axes.
    inside = material_at(part, name)
    # The extent to scan, over every body (see `_hull`).
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
            # Lines run along (dx, dy) and are laid out along the
            # perpendicular, which is also "sideways along the wall" below.
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
                # the far side of the extent.
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
# 8. How far the model is from a scan of the real thing
# --------------------------------------------------------------------------

# The three bands of a deviation map: catalogue-key suffix, colour, meaning.
# The colours are the metrology convention: blue where the real thing has less
# material than the model, red where it has more, green within tolerance.
#
# One band per catalogue entry, because an entry is one colour (views.py writes
# `node["color"]` onto the whole leaf); a per-vertex colour has nowhere to live
# between here and the viewer.
_DEVIATION_BANDS = (
    ("inside", "#2f6fd0", "scan inside the model: the model is thicker here"),
    ("within", "#3aa65b", "scan within tolerance of the model"),
    ("outside", "#d1432f", "scan outside the model: the model is missing material"),
)

# The angular tolerance the model is tessellated at, in radians. The millimetre
# argument of `Shape.tessellate` cannot be relied on: cadquery asks OCCT for a
# relative deflection (`BRepMesh_IncrementalMesh(..., isRelative=True)`), so the
# figure only binds below a threshold that moves with the part (radius-50
# sphere at this angle: 0.2, 0.02 and 0.002 mm all gave 8 002 facets and
# 0.108 mm sag; 0.0002 mm gave 50 424 facets and 0.017 mm). The angle means
# the same on every part.
#
# Sag (0.22 * R * angle^2; see `deviation`) affects the answer; facet count,
# going as the inverse square, affects the time. Same value as
# artifacts.STL_ANGULAR_TOLERANCE.
_TESSELLATION_ANGLE = 0.1

# How far a facet may reach from its own centre, as a fraction of the model's
# bounding-box diagonal, so the facet count is size-independent.
#
# It trades time against memory only; results were identical to six decimals
# across the values tried. `_signed_distance` excludes on each facet's own
# radius, so this only changes how many candidates the ball query returns
# before exclusion. Filleted bracket vs a 197 600-vertex scan: 22.9 s /
# 1.32 GiB at 1/100, 14.2 s / 2.07 GiB here, 12.3 s / 2.95 GiB at 1/300.
_FACET_PER_DIAGONAL = 200

# How many candidate rows -- (point, facet) pairs -- are held at once. The rows
# are the memory, not the meshes, and a budget in points bounds nothing (20 000
# points against a model with 70 mm facets was an OOM kill). ~70 bytes per row,
# so under 100 MB, leaving the build's 6 GiB address space (buildproc.limits)
# to the kernel's mappings. Three million rows measured no faster.
_DEVIATION_ROWS = 1_000_000

# A ceiling on the bisection below, not a target: longest-edge bisection
# terminates on its own (17 rounds at worst, measured); this stops a
# pathological facet looping. Hitting it costs speed, not correctness: the
# search radius is read off the facets that came out.
_BISECTION_ROUNDS = 64


def _reach(soup):
    """How far each facet's rim lies from its own centre.

    The radius in `_signed_distance`'s exclusion argument. Taken at the
    vertices, since a triangle's farthest point from any fixed point is a
    corner.
    """
    import numpy
    return numpy.linalg.norm(soup - soup.mean(axis=1)[:, None, :], axis=2).max(axis=1)


def _bisected(soup, limit):
    """The same surface again, with no facet reaching further than `limit`.

    Split at the midpoint of the longest edge, two ways, rather than four ways
    (`trimesh.remesh.subdivide_to_size`): a tessellated fillet arrives as
    slivers (34 x 0.4 mm), and the four-way split narrows them too, producing
    3.8 M facets against 346 k here on one bracket and a five times slower
    search.

    The result is a triangle soup with T-junctions, which is fine: it covers
    the same surface, and is only asked point-to-facet distances and facet
    orientation.

    Finished facets are set aside rather than carried round the loop, which is
    what makes this fit in a build: carrying them re-measured and re-copied the
    largest array every round. On the bracket `deviation` quotes, 2 078 122
    facets come out in 0.7 s and 0.74 GiB; carrying them exceeded 4 GiB.
    """
    import numpy
    settled = []
    for _ in range(_BISECTION_ROUNDS):
        wide = _reach(soup) > limit
        if not wide.any():
            break
        settled.append(soup[~wide])
        big = soup[wide]
        sides = numpy.stack([big[:, 1] - big[:, 0], big[:, 2] - big[:, 1],
                             big[:, 0] - big[:, 2]], axis=1)
        longest = numpy.linalg.norm(sides, axis=2).argmax(axis=1)
        # Turned so that the edge to split is the one from corner 0 to corner 1,
        # whichever of the three it was.
        turned = big[numpy.arange(len(big))[:, None],
                     (numpy.arange(3) + longest[:, None]) % 3]
        middle = (turned[:, 0] + turned[:, 1]) / 2.0
        soup = numpy.concatenate([
            numpy.stack([turned[:, 0], middle, turned[:, 2]], axis=1),
            numpy.stack([middle, turned[:, 1], turned[:, 2]], axis=1)])
    settled.append(soup)
    return numpy.concatenate(settled)


def _tessellated(shape, tolerance):
    """One shape's facets, meshed here rather than taken off whatever it carries.

    `Shape.mesh` remeshes only when `BRepTools.Triangulation_s(shape, tol)` says
    there is no triangulation at that linear tolerance, so an already-meshed
    shape (by an earlier STL export, or a `@cache` builder's shared object)
    returns its old mesh and ignores the angle asked for (radius-50 sphere:
    8 002 facets instead of 201 558).

    So the triangulation is cleaned before (so the answer is this call's own)
    and after (so the next BoundingBox() is not our mesh's box, as
    `geometry.drop_mesh` does).
    """
    from OCP.BRepTools import BRepTools

    BRepTools.Clean_s(shape.wrapped)
    try:
        # The linear argument is a fraction of the face's size, not a length
        # (see _TESSELLATION_ANGLE); at the bands a printed part is judged by
        # the angle decides, and the linear one starts to bind under ~0.01 mm.
        # The angle is fixed here so every reading in a build comes off the
        # same triangulation.
        return shape.tessellate(tolerance / 5.0, _TESSELLATION_ANGLE)
    finally:
        BRepTools.Clean_s(shape.wrapped)


def _facets(model, tolerance, facet, where):
    """The model's surface as a triangle soup, ready to be searched.

    `(soup, normals, tree, reach)`: the facets as an (n, 3, 3) array, their unit
    normals, a KD-tree over their centres and each facet's own radius.

    Every body is included. Normals point away from the material:
    `Shape.tessellate` reverses the winding of a reversed face (the mesh's
    signed volume matches `Shape.Volume()` to three decimals on a shell, a
    fillet and a holed part, cadquery 2.8.0).

    Zero-area facets (OCCT leaves some at the poles of a revolved face) are
    dropped: no normal for a sign, no surface to be nearest to.
    """
    import numpy
    from scipy.spatial import cKDTree

    soup = numpy.concatenate([
        numpy.array([(v.x, v.y, v.z) for v in vertices], dtype=float)[
            numpy.array(faces, dtype=numpy.int64)]
        for vertices, faces in (_tessellated(shape, tolerance)
                                for shape in _shapes(model, where))])
    if facet is None:
        corners = soup.reshape(-1, 3)
        facet = float(numpy.linalg.norm(
            corners.max(axis=0) - corners.min(axis=0))) / _FACET_PER_DIAGONAL
    soup = _bisected(soup, facet)

    cross = numpy.cross(soup[:, 1] - soup[:, 0], soup[:, 2] - soup[:, 0])
    twice_area = numpy.linalg.norm(cross, axis=1)
    real = twice_area > 0.0
    soup, cross, twice_area = soup[real], cross[real], twice_area[real]
    return (soup, cross / twice_area[:, None], cKDTree(soup.mean(axis=1)),
            _reach(soup))


def _passes(counts, budget):
    """The runs of points to measure one at a time, each at most `budget` rows.

    A point that brings more rows than the budget on its own is a run of one: the
    budget is what the passes are SIZED by, not a ceiling this could honour by
    splitting a point in half.
    """
    import numpy
    carried = numpy.concatenate(([0], numpy.cumsum(counts)))
    start = 0
    while start < len(counts):
        stop = max(start + 1, int(numpy.searchsorted(
            carried, carried[start] + budget, side="right")) - 1)
        yield start, stop
        start = stop


def _signed_distance(points, soup, normals, tree, reach):
    """Each point's distance to the nearest facet, signed by that facet's normal.

    Exact, by one inequality per facet: every point of facet `j` lies within
    `reach[j]` of its centre `c`, so for any `q` on it `|p - q| >= |p - c| -
    reach[j]`. A facet whose centre is further than `bound + reach[j]` from
    `p` has nothing closer than `bound`, where `bound` is the exact distance to
    the facet with the nearest centre. Every kept facet is measured with
    `trimesh.triangles.closest_point`.

    Each facet's own radius, not the widest: facets are very uneven (median
    0.11 mm, widest 69.6 mm, capped at 0.73 mm by the bisection on the
    `deviation` bracket), and the cost goes with the square. The ball query
    still uses one radius (all scipy offers); the per-facet test then cuts its
    answer down (475 candidates per point, 39 survive).

    Written out because `rtree`, `pyembree` and `embreex` are absent from the
    image, so `trimesh.proximity.signed_distance` and
    `ProximityQuery.on_surface` raise ModuleNotFoundError, and
    `closest_point_naive` is brute force (36.9 s for 41 k points against
    5 120 facets). A KD-tree over surface samples was off by 40-450 um on a
    2 mm wall even at k=16, the size of the band being measured.

    Passes are sized by candidate rows, not points: one row per (point, facet)
    pair is held, and the rows per point depend on where it sits.
    `query_ball_point(..., return_length=True)` counts rows without building
    them.

    The sign is the nearest facet's. A point nearest an edge or corner can lie
    exactly in that facet's plane; the dot product is then zero and the sign
    positive, and the magnitude (what the report quotes) is unaffected.
    """
    import numpy
    import trimesh

    centres = soup.mean(axis=1)
    nearest = tree.query(points, workers=-1)[1]
    bound = numpy.linalg.norm(
        points - trimesh.triangles.closest_point(soup[nearest], points), axis=1)
    ball = bound + float(reach.max())
    counts = tree.query_ball_point(points, ball, workers=-1, return_length=True)

    out = numpy.empty(len(points))
    for start, stop in _passes(counts, _DEVIATION_ROWS):
        here, wide = points[start:stop], counts[start:stop]
        groups = tree.query_ball_point(here, ball[start:stop], workers=-1,
                                       return_sorted=False)
        candidates = numpy.fromiter((j for g in groups for j in g), numpy.int64,
                                    int(wide.sum()))
        owner = numpy.repeat(numpy.arange(len(here)), wide)
        near = (numpy.linalg.norm(centres[candidates] - here[owner], axis=1)
                - reach[candidates]) <= bound[start:stop][owner]
        candidates, owner = candidates[near], owner[near]
        away = here[owner] - trimesh.triangles.closest_point(soup[candidates],
                                                             here[owner])
        span = numpy.linalg.norm(away, axis=1)
        # Ordered by point then distance, so the first row of each point's run
        # is its nearest facet. Every point has a run: the facet `bound` was
        # measured against passes the test by construction.
        order = numpy.lexsort((span, owner))
        kept = numpy.bincount(owner, minlength=len(here))
        best = order[numpy.concatenate(([0], numpy.cumsum(kept)[:-1]))]
        out[start:stop] = numpy.copysign(
            span[best],
            numpy.einsum("ij,ij->i", away[best], normals[candidates[best]]))
    return out


def _weighted_median(values, weight):
    """The value half the SURFACE is under, rather than half the points.

    A scan is denser where the scanner spent longer, so a median over vertices is
    a median over the scanner's attention and not over the part.
    """
    import numpy
    order = numpy.argsort(values)
    carried = numpy.cumsum(weight[order])
    return float(values[order][
        min(int(numpy.searchsorted(carried, carried[-1] / 2.0)), len(order) - 1)])


def deviation(scan, model, tolerance, *, name="deviation", thresholds=None):
    """How far a scan of the real part is from the model, in colour and in figures.

        @cache
        def measured():
            scan = trimesh.load("ref/scan.stl", force="mesh")
            return checklib.deviation(scan, bracket(), tolerance=0.1)

        def parts():
            bands, _ = measured()
            return {"bracket": {"shape": bracket(), "kind": "printable"}, **bands}

        def views():
            return [{"id": "assembled", "parts": ["bracket"]},
                    {"id": "deviation", "parts": list(measured()[0])}]

    Behind a builder, not at module level: each check worker imports the model
    afresh (`checkunits._work`), so a module-level measurement would run in
    every one.

    One entry per colour band, keyed `<name>_inside`, `<name>_within`,
    `<name>_outside`; an empty band is absent, so iterate `bands` rather than
    spelling the keys out. Each is a `mock` carrying a piece of the scan's own
    mesh and an explicit colour, which overrides a mock's grey
    (`parts.catalogue_colors`).

    For every scan vertex: the distance to the nearest point of the model's
    surface, positive when the scan lies outside the model (material the model
    does not account for) and negative inside (the model is thicker). The side
    is decided by the nearest facet's normal. `tolerance` is the half-width of
    the green band in millimetres, with no default: how close is close enough
    is a fact about this part.

    `report` carries the numbers, because colour answers "where" and half of the
    question is "by how much":

        report.median_signed     mm, WHICH WAY the surface sits: the bias
        report.median_absolute   mm, HOW FAR off it is: the typical error
        report.minimum           mm, the most negative -- deepest into the model
        report.maximum           mm, the most positive -- furthest outside it
        report.within            {threshold: fraction of the surface inside it}
        report.points            how many scan vertices were measured

    Both medians are weighted by surface, not vertex, and they are not
    interchangeable: on a part a third 0.6 mm thin, a third 0.05 mm proud and a
    third 0.5 mm proud, the signed median is 0.05 mm while the absolute median
    is 0.5 mm. The signed one answers "is the print big or small", the absolute
    one "is the print right"; the latter goes with `within`.

    `thresholds` is what `within` is keyed by and defaults to `(tolerance,)`;
    pass several -- `(0.05, 0.1, 0.2)` -- to see the shape of the distribution
    rather than one number off it.

    A face is drawn in the band of its worst corner, so the picture errs
    towards showing a deviation; the figures are measured at the points and
    are the ones to quote.

    Nothing here moves the scan: aligning it is the author's decision. Load it
    where it belongs (`mesh.apply_transform`) and pass it in place.

    Sized for ~200 000 scan vertices: a 120x80x20 bracket with 8 mm fillets,
    twelve holes and 0.8 mm edge rounds (217 k facets, 0.11-70 mm) against a
    197 600-vertex scan of its fillets took 14.2 s and 2.1 GiB on a laptop. The
    hub is ~4x slower and a build has 300 s and 6 GiB for everything
    (`buildproc.limits`), so past roughly half a million vertices thin the scan
    (`scan.simplify_quadric_decimation(...)`, or a submesh of the zone); time
    grows linearly, memory only with the pass held.

    The tessellation is a floor under every reading: at the fixed angular
    tolerance (`_TESSELLATION_ANGLE`) a triangulation sits inside a convex
    surface by ~0.22 * R * angle^2 -- 22 um at R 10 mm, 110 um at 50 mm, 1.1 mm
    at half a metre -- added in one direction to every reading there. Read
    tight bands on large radii against it.
    """
    if tolerance <= 0:
        raise ValueError(
            f"deviation({name}): tolerance is {tolerance!r}. It is the "
            "half-width of the band that counts as agreement, in millimetres, "
            "and at zero or less there is no such band: every face lands in blue "
            "or red on the sign of arithmetic noise, and the picture says "
            "nothing about the part.")

    import numpy
    import trimesh

    vertices = numpy.asarray(scan.vertices, dtype=float)
    at_point = _signed_distance(
        vertices, *_facets(model, tolerance, None, f"deviation({name})"))

    faces = numpy.asarray(scan.faces)
    corners = at_point[faces]
    worst = numpy.take_along_axis(
        corners, numpy.abs(corners).argmax(axis=1)[:, None], axis=1)[:, 0]
    area = numpy.asarray(scan.area_faces, dtype=float)

    bands = {}
    for (suffix, colour, phrase), belongs in zip(
            _DEVIATION_BANDS,
            (worst < -tolerance, numpy.abs(worst) <= tolerance, worst > tolerance)):
        picked = numpy.flatnonzero(belongs)
        if picked.size == 0:
            continue
        # Renumbered onto the vertices this band uses, or every band's leaf
        # would widen the scene's bounding box to the whole scan
        # (views._widen_bb).
        used, renumbered = numpy.unique(faces[picked], return_inverse=True)
        # `"mock"` spelled out: this module imports no first-party name (see
        # `_shapes`). A test ties the literal to `parts.KIND_MOCK`.
        bands[f"{name}_{suffix}"] = {
            "mesh": trimesh.Trimesh(vertices=vertices[used],
                                    faces=renumbered.reshape(-1, 3),
                                    process=False),
            "kind": "mock",
            "color": colour,
            "note": f"{phrase}, {area[picked].sum() / area.sum():.0%} of the area",
        }

    weight = numpy.bincount(faces.reshape(-1), weights=numpy.repeat(area, 3) / 3.0,
                            minlength=len(at_point))
    return bands, types.SimpleNamespace(
        median_signed=_weighted_median(at_point, weight),
        median_absolute=_weighted_median(numpy.abs(at_point), weight),
        minimum=float(at_point.min()),
        maximum=float(at_point.max()),
        within={float(edge): float(weight[numpy.abs(at_point) <= edge].sum()
                                   / weight.sum())
                for edge in ((tolerance,) if thresholds is None else thresholds)},
        points=len(at_point))


# --------------------------------------------------------------------------
# Check units: one check, named, with the builders it needs
# --------------------------------------------------------------------------
#
# `checks()` is one function, so one process's work, and on the hub it is
# 47-95% of a build's wall clock. A unit is one check pulled out under its own
# name with the builders it needs, so the build can run several in parallel
# processes, each with a budget. `cadbuild.checkunits` runs them; registration
# and record keeping live here because they are this module's state.
#
# `needs` maps the check's own parameter names to top-level builders, never to
# keys of parts(): the catalogue is computed whole, so taking one part out of
# it builds all of them. The builders are the `@cache` functions a model
# already writes (`model_template/model.py`: `build_base`, `build_lid`), and a
# worker's cache makes them cheap across its units.


# One registered unit. A namedtuple so a field typo is an AttributeError, not
# a silent None; private, since a model never constructs one.
_Unit = collections.namedtuple("_Unit", "name func needs")

# Every unit `check` has registered, by name, in registration order. Cleaned,
# like the three records above, by an autouse fixture
# (tests/cadbuild/conftest.py): a unit left by one test would run in the next
# test's build against a model that never defined it.
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

    Everything is validated at the `@`, not at the call, because the call
    happens in another process: a mismatched `needs` key would otherwise be a
    bare TypeError from a worker after the geometry phase.
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

    Private: the root shim re-exports every public name, and a public one
    would let a model wipe the interference and clearance numbers from its own
    metrics.json.

    Called once per unit in a worker, so it returns that unit's own
    contribution; resending the accumulated record would make the parent add
    sections' seconds again for every later unit.
    """
    taken = (dict(_INTERFERENCE), dict(_SECTIONS),
             {label: dict(record) for label, record in _CLEARANCE.items()})
    _INTERFERENCE.clear()
    _SECTIONS.clear()
    _CLEARANCE.clear()
    return taken


def _merge_records(interference, sections, clearance):
    """Fold one worker's records into this process's, each by its OWN rule.

    Interference is keyed by pair (a pair measured twice measures the same),
    clearance by label (the last to arrive replaces earlier ones), and sections
    sum (a label in two units is one row with the total, as in a single-process
    run).

    "Last" is whichever worker reported last, which is nondeterministic: two
    sweeps under one label may leave either number. Give each sweep its own
    label.

    Without this the records stay in the worker, and metrics.json has empty
    `interference_mm3` and `clearance` with nothing going red.
    """
    _INTERFERENCE.update(interference)
    for label, seconds in sections.items():
        _SECTIONS[label] = _SECTIONS.get(label, 0.0) + seconds
    _CLEARANCE.update(clearance)
