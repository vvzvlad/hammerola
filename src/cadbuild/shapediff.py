#!/usr/bin/env python3
"""What changed between two revisions of ONE part, read off its two STEP files.

Issue #10 asks the hub what is different between two revisions, and for a part
the honest answer is a volume: what the newer revision cut away, what it added,
and what the two have in common. That is a boolean operation on two solids, and
this module is the whole of it -- there is no route here, no job, no
subprocess, no tessellation and no CLI. Those are the caller's, and they are a
later slice.

THE SPLIT IN THIS FILE IS THE KERNEL'S. `measure` is the only half that needs
OCCT: it reads the two files, fuses them and returns numbers. `check` decides
whether those numbers may be believed and is arithmetic over the dict --
nothing imported, nothing measured -- which is what lets the rule that gates
every answer be tested in CI, where the kernel is deliberately absent (issue
#27) and `measure` cannot run at all. `step_digest` is stdlib and answers the
one question that needs no kernel: whether there is anything to measure.

READING IS `STEPControl_Reader` AND NOT cadquery's `importStep`. importStep
picks its units by writing `Interface_Static`, which is process-global state,
and leaves it written for whatever the process does next -- in a hub that also
builds models, that is somebody else's geometry silently rescaled.

Every OCP import below is inside the function that needs it, like
`geometry.py` and `views.py` do it: importing `src.cadbuild` must not drag in
the CAD kernel.
"""

import hashlib
import io

# THE ONE IMPORT FROM THE HUB HALF, and it is a leaf: `safeio` imports nothing
# from `src/` itself, deliberately, so that the build side can use it too. What
# it buys here is the FIRST touch of each file being the one that refuses a
# fifo: `data/` is one volume every build can write anywhere in, so a `lid.step`
# that is a fifo rather than a file is an ordinary `model.py` mistake -- and a
# plain open on one never returns, while OCCT's own `ReadFile` a few lines later
# would block in C++ with no way back at all.
from src.safeio import open_regular


__all__ = [
    "EPS_RELATIVE",
    "SLIVER_THICKNESS_MM",
    "check",
    "drop_slivers",
    "measure",
    "step_digest",
]


# How far the gate's identities may miss before the measurement is refused.
#
# RELATIVE AND NEVER ABSOLUTE. A threshold in mm3 is a different statement at
# every scale: 1e-3 mm3 is nothing on a 100 mm bracket and is a visible feature
# on a 2 mm pin, so an absolute number would refuse small parts and wave large
# ones through. The residual measured on the identity -- one solid fused with
# itself, where the answer is exactly its own volume -- is 1.4e-8 relative, so
# this sits two orders above the noise it has to clear.
EPS_RELATIVE = 1e-6

# The characteristic thickness, 2V/S, under which a reported piece is an
# artefact of the fuse rather than a difference between two revisions.
#
# The kernel's own confusion is 1e-7 mm (its default fuzzy value), and the
# smallest change this must never hide is 10 um -- a layer. So the threshold is
# put two orders above the noise and three below the signal, which is the whole
# of the reasoning: anything thinner than this cannot be a design change,
# anything a person meant to make is far above it.
SLIVER_THICKNESS_MM = 1e-5


def step_digest(path):
    """sha256 of the file's bytes, so a caller can skip the kernel entirely.

    SOUND IN EXACTLY ONE DIRECTION. Equal digests mean equal bytes and
    therefore identical geometry: there is nothing to measure and no reason to
    start OCCT. Different digests mean NOTHING about the geometry -- a STEP
    file carries a timestamp and a producer string in its header, so two
    exports of one unchanged shape differ in bytes every time. Read this as a
    fast path INTO "no difference" and never as evidence OF one.

    RAISES `OSError` when the path is not a regular file it can read, and that
    is the contract the caller walks on: this runs before `measure` on every
    part, so it is where a directory, a fifo or a missing file becomes an
    exception the walk can turn into one part's line instead of OCCT hanging on
    it.
    """
    with open_regular(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def measure(step_a, step_b):
    """Fuse the two parts and split the result into common, removed and added.

    Returns a dict, always with a `reason`: None when the numbers below are
    there to be read, and a sentence when the kernel could not be asked. A file
    that will not read, or one holding anything other than a single solid, is
    NOT an exception here -- a printable is gated to be one body, so a second
    solid says the input is not the thing this compares, which is a refusal to
    measure and not a crash. `check` hands that reason straight on, so a caller
    has one place to ask whether it may believe what it got.

    The numbers, in mm3 and mm2: `volume_a`, `volume_b`, `common_mm3`,
    `removed_mm3`, `added_mm3`, a `removed` and an `added` list of
    `{"volume_mm3", "area_mm2"}` per piece, and `bboxes_overlap`.
    """
    from OCP.BOPAlgo import BOPAlgo_Builder

    solid_a, reason = _one_solid(step_a)
    if reason is not None:
        return {"reason": reason}
    solid_b, reason = _one_solid(step_b)
    if reason is not None:
        return {"reason": reason}

    # SetFuzzyValue is left alone deliberately. The default is 1e-7 mm, which is
    # the number SLIVER_THICKNESS_MM is reasoned against, and SetFuzzyValue(0.0)
    # is silently ignored rather than making the fuse exact.
    builder = BOPAlgo_Builder()
    builder.AddArgument(solid_a)
    builder.AddArgument(solid_b)
    # PARALLEL because this runs in the compare child, whose OCCT pool is
    # already held down by `buildproc.child._cap_occt_threads` before anything
    # touches the kernel -- the fuse may use that pool, it cannot widen it.
    builder.SetRunParallel(True)
    # NON-DESTRUCTIVE is load-bearing rather than polite: `volume_a`,
    # `volume_b` and the bounding boxes below are all read off the two
    # ARGUMENTS after `Perform`, and a fuse allowed to modify its inputs in
    # place would have this measure the pieces against shapes it had itself
    # already changed.
    builder.SetNonDestructive(True)
    builder.Perform()
    if builder.HasErrors():
        errors = io.BytesIO()
        builder.DumpErrors(errors)
        return {"reason": "the two solids could not be fused: "
                          + errors.getvalue().decode("utf-8", "replace").strip()}

    pieces_a = _pieces_of(builder, solid_a)
    pieces_b = _pieces_of(builder, solid_b)
    common = [piece for piece in pieces_a if _holds(pieces_b, piece)]
    removed = [piece for piece in pieces_a if not _holds(pieces_b, piece)]
    added = [piece for piece in pieces_b if not _holds(pieces_a, piece)]

    return {
        "reason": None,
        "volume_a": _volume(solid_a),
        "volume_b": _volume(solid_b),
        "common_mm3": sum((_volume(piece) for piece in common), 0.0),
        "removed_mm3": sum((_volume(piece) for piece in removed), 0.0),
        "added_mm3": sum((_volume(piece) for piece in added), 0.0),
        "removed": [_described(piece) for piece in removed],
        "added": [_described(piece) for piece in added],
        "bboxes_overlap": _bboxes_overlap(solid_a, solid_b),
    }


def check(measurement):
    """None if the measurement may be shown, else the reason it may not be.

    Arithmetic over the dict and nothing else -- no kernel, no OCP import --
    because this is the half that has to run where `measure` cannot: in CI, and
    in any test of what the hub will and will not publish.

    Every rule below is a failure that was measured rather than imagined, and
    each is written relative to the volume it is about, for the reason
    EPS_RELATIVE gives.
    """
    if measurement["reason"] is not None:
        return measurement["reason"]

    volume_a = measurement["volume_a"]
    volume_b = measurement["volume_b"]
    if volume_a <= 0 or volume_b <= 0:
        return (f"a revision measures no volume (a = {volume_a} mm3, "
                f"b = {volume_b} mm3), so there is nothing to compare")

    common = measurement["common_mm3"]
    removed = measurement["removed_mm3"]
    added = measurement["added_mm3"]

    # The two halves of A, and then of B, have to add back up to it: every
    # piece of A is either shared with B or was removed by B, with nothing in
    # between and nothing counted twice.
    if abs(common + removed - volume_a) / volume_a > EPS_RELATIVE:
        return (f"the pieces of A do not add up to A: {common} mm3 common plus "
                f"{removed} mm3 removed is not {volume_a} mm3")
    if abs(common + added - volume_b) / volume_b > EPS_RELATIVE:
        return (f"the pieces of B do not add up to B: {common} mm3 common plus "
                f"{added} mm3 added is not {volume_b} mm3")
    # The net change has to be the change in volume. It follows from the two
    # identities above only up to their own residuals, so it is the rule that
    # catches the case where each of them sits just inside the tolerance and
    # they lean in opposite directions -- which is exactly when the total is
    # wrong by more than either half admits.
    net = (added - removed) - (volume_b - volume_a)
    if abs(net) / max(volume_a, volume_b) > EPS_RELATIVE:
        return (f"the net change does not match the change in volume: "
                f"{added} mm3 added less {removed} mm3 removed is not "
                f"{volume_b} mm3 less {volume_a} mm3")

    # THE BOOLEAN'S SILENT LIE, and the reason this rule is not a precaution: a
    # part moved 0.1 mm was measured to intersect its own copy in exactly
    # nothing, with HasErrors() false and two valid-looking solids to show for
    # it. The zone is not monotonic either -- 0.05 mm works, 0.1 mm does not,
    # 0.5 mm works again -- so there is no offset at which the answer can be
    # trusted just because the last one was. Two revisions of one part CAN
    # genuinely share no volume, and refusing to measure that is still right:
    # never report "no difference" where the kernel may simply have lied.
    if common == 0 and measurement["bboxes_overlap"]:
        return ("the two revisions share no volume at all while their bounding "
                "boxes overlap: either the part moved wholly clear of itself, "
                "or this kernel's boolean quietly failed, and nothing here can "
                "tell those two apart -- so this refuses rather than report a "
                "difference that may not be one")
    return None


def drop_slivers(measurement):
    """The same measurement with the pieces too thin to be a change taken out.

    AFTER `check` AND NEVER BEFORE, and the reason is the input rather than the
    arithmetic: a measurement `measure` refused carries ONLY `reason` -- there
    are no lists on it to filter -- so calling this first raises KeyError on
    exactly the pairs the gate exists to catch, which is every pair whose STEP
    would not read or did not hold one solid.

    The totals are left as `measure` counted them and only the reported lists
    shrink. That is what keeps the two safe to combine in either order once the
    gate has passed: the gate's identities are the sum of EVERY piece, so a
    filtered `removed_mm3` would miss "the pieces of A add up to A" by exactly
    the volume thrown away and break the identity it is checked by. What left
    the lists is added up in `removed_slivers_mm3` and `added_slivers_mm3`, so
    nothing disappears without saying so.
    """
    filtered = dict(measurement)
    for side in ("removed", "added"):
        pieces = measurement[side]
        filtered[side] = [piece for piece in pieces if not _is_sliver(piece)]
        filtered[side + "_slivers_mm3"] = sum(
            (piece["volume_mm3"] for piece in pieces if _is_sliver(piece)), 0.0)
    return filtered


def _is_sliver(piece):
    """2V/S: the thickness a piece would have if it were a flat plate."""
    return 2 * piece["volume_mm3"] / piece["area_mm2"] < SLIVER_THICKNESS_MM


def _one_solid(path):
    """`(solid, None)`, or `(None, reason)` when the file does not hold one."""
    from OCP.IFSelect import IFSelect_ReturnStatus
    from OCP.STEPControl import STEPControl_Reader
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopExp import TopExp_Explorer

    reader = STEPControl_Reader()
    if reader.ReadFile(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        return None, f"{path} is not a STEP file this kernel can read"
    if reader.TransferRoots() == 0:
        return None, f"{path} is a STEP file with no shape in it"
    shape = reader.OneShape()
    if shape.IsNull():
        return None, f"{path} read as an empty shape"

    # TopExp_Explorer is not a python iterator, and there is no protocol on it
    # to make it one -- More/Current/Next by hand is the whole API.
    solids = []
    explorer = TopExp_Explorer(shape, TopAbs_ShapeEnum.TopAbs_SOLID)
    while explorer.More():
        solids.append(explorer.Current())
        explorer.Next()
    if len(solids) != 1:
        return None, (f"{path} holds {len(solids)} solids and this compares one "
                      "part with one part -- a printable is gated to be a single "
                      "body, so anything else is not the thing to measure")
    return solids[0], None


def _pieces_of(builder, argument):
    """What one argument of the fuse turned into, as the fuse sees it.

    THE TWO OBVIOUS WAYS ARE BOTH WRONG, and both wrong quietly. `Origins()`
    attributes a piece to the argument it came from and gets it backwards for
    the interesting case: with a 3 mm cube fully inside a 10 mm one it names
    the 27 mm3 piece as the big cube's alone, so the volume the two share comes
    out 0 instead of 27. `Modified()` is empty for an argument that nothing
    cut, so two solids that differ only in one place lose everything about the
    places they do not differ.

    What OCCT documents instead is the rule below -- the image of a shape if
    the fuse made one, otherwise the shape itself -- followed by the
    same-domain map. ShapesSD is the half that makes two identical inputs come
    out wholly common: without it the two copies of one face are two different
    shapes and every piece looks unique to its own side.
    """
    images, same_domain = builder.Images(), builder.ShapesSD()
    raw = list(images.Find(argument)) if images.IsBound(argument) else [argument]
    return [same_domain.Find(piece) if same_domain.IsBound(piece) else piece
            for piece in raw]


def _holds(pieces, wanted):
    """Whether `wanted` is one of `pieces` -- by identity, not by equality."""
    return any(piece.IsSame(wanted) for piece in pieces)


def _described(piece):
    return {"volume_mm3": _volume(piece), "area_mm2": _area(piece)}


def _volume(shape):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    # The static methods carry a `_s` suffix in OCP; without it this is an
    # AttributeError rather than a wrong number.
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def _area(shape):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, props)
    return props.Mass()


def _bboxes_overlap(solid_a, solid_b):
    """Do the two inputs' bounding boxes touch at all?

    `Add_s` and not the exact `AddOptimal_s` (see `gate.PRINT_OVERLAP_TOL` for
    the difference) because the cheap box only ever errs by being too big, and
    too big can only turn a disjoint pair into an overlapping one -- which
    turns into a refusal to measure, the safe direction for the only rule that
    reads this.
    """
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box_a, box_b = Bnd_Box(), Bnd_Box()
    BRepBndLib.Add_s(solid_a, box_a)
    BRepBndLib.Add_s(solid_b, box_b)
    return not box_a.IsOut(box_b)
