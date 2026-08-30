"""A two-part box: the smallest model the hub will actually build.

THIS FILE IS THE CONTRACT, and it is a working example of it rather than a
description. `hammerola build` on this directory publishes; replace the geometry
with your own and keep the three entry points:

    views()       what the browser shows, one entry per tab
    printables()  what the download buttons hand out, one entry per part
    checks()      optional, and the only place project-specific rules live

`import checklib` is the fourth part of it. That module ships INSIDE the hub's
image, so it is not in this directory and there is nothing to install: the build
runs there, and the name resolves there. Do not put a checklib.py of your own at
the root of a project -- a model is imported with its own directory first on
`sys.path`, so your copy would win, and the interference volumes it records
would then be written into one copy and read out of the other. The build warns
and publishes anyway, with the numbers missing from metrics.json.

NOTHING IS INSTALLED FOR A MODEL. The image has cadquery, trimesh, numpy,
matplotlib and Pillow, plus the standard library, and a `requirements.txt` next
to this file is not read by anything -- that is a security decision and not an
omission (installing a package runs its code inside the build). Import what the
image has, and write the rest here. (This list and the one in the skill are the
same list, and a test says so: the skill sends its reader HERE for the contract,
so a shorter version of it here would understate what a model may import.)

EVERY PATH IN THIS DIRECTORY IS ASCII, starts with a letter or a digit, and
carries no leading underscore. A single file that breaks that rule is refused
along with the WHOLE push, so a `детали.py` next to this file stops the project
publishing at all. Paths may be at most 8 components deep and a push may carry
at most 1024 files.
"""

from functools import cache
from pathlib import Path

import cadquery as cq

import checklib

# --------------------------------------------------------------------------
# Parameters -- millimetres, and everything the geometry is driven by.
# --------------------------------------------------------------------------

LENGTH = 60.0            # outer X of both parts
WIDTH = 40.0             # outer Y of both parts
HEIGHT = 20.0            # outer Z of the base; the lid sits on top of this
WALL = 2.4               # wall and floor thickness
CORNER_RADIUS = 3.0      # vertical corner fillet, outer

LID_THICKNESS = 2.4      # the flat plate of the lid
LIP_HEIGHT = 3.0         # how deep the lid plugs into the base
LIP_CLEARANCE = 0.25     # per-side gap between the lip and the inner wall

PRINT_GAP = 8.0          # space between the two parts in the `print` view

# What `checks()` holds the model to. These are limits rather than geometry:
# below FIT_MIN the lid becomes a press fit, above FIT_MAX it rattles.
FIT_MIN = 0.15
FIT_MAX = 0.40

# NOT the bed of anybody's printer -- nobody named one. This is the size below
# which FDM printers essentially do not exist, so a part that fits inside it
# raises no question. A part that grows past it is the moment to ask which
# printer this is for and to put that machine's real build volume here.
MIN_PRINTER_MM = 180.0
# Slack on that ceiling: a bounding box carries the kernel's own numerical error
# (a fillet or a boolean leaves a micron or so), and without this a part drawn
# exactly 180 mm wide fails with the unanswerable "X (180 > 180 mm)".
PRINTER_TOL = 0.05

# A "valid" solid that exports a stub file is a bug, and the export is the thing
# people actually print.
MIN_STL_BYTES = 1024


# --------------------------------------------------------------------------
# Geometry
#
# Each part is built by one function, in the orientation it is PRINTED in, and
# the views move copies of it into place. That order is deliberate: what
# `printables()` hands back is what lands in the STL somebody slices, so the
# orientation that matters is the one on the bed.
# --------------------------------------------------------------------------

# @cache ON EVERY BUILDER, and it is not a micro-optimisation. `views()`,
# `printables()` and `checks()` each call these, and `checks()` usually calls
# them from several places -- without this the whole assembly is rebuilt a dozen
# times per build, which is about a fifth of the run on a model of any size. It
# is safe because these are pure functions of the constants above and CadQuery
# returns new objects rather than mutating in place; the one in-place change
# that happens (an STL export triangulates the shape) is undone by the hub after
# each export. Do not cache a builder whose result you then mutate.
@cache
def build_base() -> cq.Workplane:
    """The open-topped tray, printed exactly as modelled."""
    return (
        cq.Workplane("XY")
        .box(LENGTH, WIDTH, HEIGHT, centered=(True, True, False))
        .edges("|Z")
        .fillet(CORNER_RADIUS)
        # Take the top face away and hollow out the rest. The floor comes out
        # WALL thick, like the walls, because a shell is uniform.
        .faces(">Z")
        .shell(-WALL)
    )


@cache
def build_lid() -> cq.Workplane:
    """The plate plus the lip that drops into the tray, flat face down.

    Printed this way up: the outer face is on the bed and the lip points at the
    ceiling, so nothing overhangs and the visible face is the one the bed
    finishes.
    """
    plate = (
        cq.Workplane("XY")
        .box(LENGTH, WIDTH, LID_THICKNESS, centered=(True, True, False))
        .edges("|Z")
        .fillet(CORNER_RADIUS)
    )
    # The lip is the cavity's size less a gap on every side. The gap is what
    # `checks()` measures off the two finished solids afterwards -- this line is
    # the intent, that check is the evidence.
    lip_length = LENGTH - 2 * WALL - 2 * LIP_CLEARANCE
    lip_width = WIDTH - 2 * WALL - 2 * LIP_CLEARANCE
    lip = (
        cq.Workplane("XY")
        .workplane(offset=LID_THICKNESS)
        .box(lip_length, lip_width, LIP_HEIGHT, centered=(True, True, False))
        .edges("|Z")
        .fillet(max(CORNER_RADIUS - WALL - LIP_CLEARANCE, 0.5))
    )
    # One solid, not two bodies sitting on each other: the gate refuses a
    # printable that exports as several disconnected shells, because a slicer
    # would just get loose parts.
    return plate.union(lip)


def lid_as_assembled() -> cq.Workplane:
    """The lid turned over and seated on the base's rim.

    A view is allowed to move a part; `printables()` is not. Rotating here keeps
    the exported STL in its print orientation while the picture still shows the
    box the way it goes together.
    """
    return (build_lid()
            .rotate((0, 0, 0), (1, 0, 0), 180)
            .translate((0, 0, HEIGHT + LID_THICKNESS)))


# --------------------------------------------------------------------------
# The contract
# --------------------------------------------------------------------------

def views():
    """The tabs the browser shows. Every entry is a list of parts.

    Two ids mean something to the gate and the rest are just tabs:

      * `assembled` is the product, and every printable has to be visible in it
        -- a part missing from this view reads as a design without that part.
      * `print` is the bed: parts may not stand inside one another there. A pair
        that really is nested on purpose goes in that view's
        `"nested_ok": [("a", "b")]`.

    A part is `{"shape": ..., "name": ...}`; `color`, `alpha` and `note` are
    optional. A part that names no colour is painted by the palette when the
    gate can match it to a printable, and grey when it cannot -- which is what
    makes a mock of bought hardware look like one. A `note` is text for whoever
    OPENS the model: what to buy, what a number was chosen for, what to watch
    out for when assembling it.
    """
    base = build_base()
    return [
        {
            "id": "assembled",
            "name": "assembled",
            "parts": [
                {"shape": base, "name": "base"},
                # The one transparent part here, and the reason is this view:
                # the lid is what hides the inside. 0.6 rather than 0.9 -- above
                # 0.85 the viewer already draws a part blended while it still
                # looks solid, and parts then flicker as the model is turned.
                # The note is addressed to whoever opens this in the browser,
                # which is why it says what the picture cannot: the lid goes on
                # this way up, and the gap it needs is a printer setting rather
                # than a number in the model.
                {"shape": lid_as_assembled(), "name": "lid", "alpha": 0.6,
                 "note": "lip down into the tray; if it binds, print it with "
                         "horizontal expansion -0.05 mm rather than editing "
                         "LIP_CLEARANCE"},
            ],
        },
        {
            "id": "print",
            "name": "as printed",
            "parts": [
                {"shape": base, "name": "base (print)"},
                # Laid clear of the base along Y. Orienting a part for printing
                # leaves it standing at the origin, and forgetting this
                # translate is what the layout gate exists to catch.
                {"shape": build_lid().translate(
                    (0, WIDTH + PRINT_GAP, 0)), "name": "lid (print)"},
            ],
        },
    ]


def printables():
    """What is exported and downloaded. The key is the file name stem.

    `base` becomes base.stl, base.step and base.3mf. Letters, digits, dot, dash
    and underscore only, and `assembled` is taken -- the build writes an
    assembled.stl of its own next to these.
    """
    return {
        "base": build_base(),
        "lid": build_lid(),
    }


def checks(out_dir):
    """The rules that are true of THIS box, run after the geometry gate.

    Optional: delete the function and the build still works. What belongs here
    is everything a review or a printed part taught you -- one more assert per
    lesson. What does not belong here is anything the shared gate already does
    (valid solid, watertight, one body, parts not overlapping on the bed).

    MEASURE THE SOLIDS, do not restate the constants at the top of this file. A
    check that repeats the arithmetic passes for the wrong reason and goes on
    passing after the geometry has drifted away from it.

    `out_dir` is the build directory and already holds the exported files, so a
    check can look at those too. The parameter is optional -- `def checks():`
    is equally valid.

    Two reporting styles, both in use below: `assert cond, "why"` for a
    one-line fact, and a list of problem strings for the checklib calls, so one
    run reports everything that is wrong rather than the first thing.

    `checklib.section(...)` marks the stretches, and the build prints what each
    one cost -- on a failed run as well as a passing one. It is worth doing from
    the first model rather than added when something gets slow: a check that
    probes a grid or scans a channel can quietly become most of the build, and
    the per-phase seconds the build prints on its own cannot point inside a
    phase. Sections are ordinary `with` blocks on purpose -- the hub counts the
    checks by reading this function's source, so a check has to stay in this
    body rather than move into a decorated helper.
    """
    base = build_base()
    lid = build_lid()
    problems = []

    # 1. BOTH PARTS SURVIVED THE OPERATIONS THAT MADE THEM, and this goes first
    #    because everything below reads faces off them. An emptied result is NOT
    #    falsy -- `.vals()` on it is a list holding one empty Compound, so
    #    `assert base.vals()` is an assert that cannot fail -- and the volume is
    #    what tells the two apart.
    #
    #    WHAT IT BUYS IS THE MESSAGE. Without it an emptied base dies below in
    #    `base.faces(">Z")` with `ValueError: Can not return the Nth element of
    #    an empty list` (measured on cadquery 2.8.0), which names neither the
    #    part nor the operation that emptied it.
    #
    #    IT STANDS AGAINST AN OPERATION, NOT A SCENARIO, and that distinction is
    #    worth keeping when you copy this: `shell` and the booleans CAN return a
    #    body with nothing in it, which is reason enough to check. It is not
    #    guarding a case reproduced on these two parts. A WALL too thick for
    #    LENGTH/WIDTH does not empty the base -- measured, it grows towards solid
    #    and then the kernel refuses outright: WALL 2.4 -> 13653 mm3, 10.0 ->
    #    39845, 19.9 -> 47845, 20.0 -> `Standard_Failure: BRep_API: command not
    #    done`. And the lid as written cannot come back empty at all, being the
    #    union of two boxes that are each non-empty; its line is here for the
    #    edit that makes that union a cut, and so that each part is named by a
    #    check of its own.
    with checklib.section("solids survived"):
        assert not checklib.is_empty(base), (
            "the base came back empty: the shell left no solid behind. Look at "
            "the shell and the face it was taken from, not at the checks")
        assert not checklib.is_empty(lid), (
            "the lid came back empty: an operation in build_lid() returned no "
            "solid")

    # 2. The lid has to drop into the tray with a real gap. Both numbers are
    #    read off the finished solids: the cavity is the inner wire of the rim
    #    face, the lip is the topmost face of the lid in print orientation.
    with checklib.section("lid fit"):
        rim = max(base.faces(">Z").vals(), key=lambda face: face.Area())
        cavity = min((wire.BoundingBox() for wire in rim.Wires()),
                     key=lambda box: box.xlen)
        lip = lid.faces(">Z").val().BoundingBox()
        for axis, gap in (("X", (cavity.xlen - lip.xlen) / 2.0),
                          ("Y", (cavity.ylen - lip.ylen) / 2.0)):
            assert FIT_MIN <= gap <= FIT_MAX, (
                f"the lid-to-base gap along {axis} is {gap:.2f} mm per side, "
                f"outside {FIT_MIN}..{FIT_MAX} mm")

    # 3. Nothing may share space with anything else once it is assembled. Every
    #    pair, from checklib, rather than a hand-written list: the pair nobody
    #    thought of is exactly the pair that breaks. Parts that only touch face
    #    to face intersect in zero volume, so a seated lid passes.
    #
    #    This is the section that grows: it is one boolean per pair of parts,
    #    and the number of pairs grows with the square of the part count.
    with checklib.section("interference"):
        problems += checklib.pairwise_interference(
            [base, lid_as_assembled()], ["base", "lid"])

    # 4. The shell has to have left a floor and a hollow. Asked as two POINTS,
    #    with checklib.material_at -- never as a boolean against a small cube.
    #    The point probe costs microseconds where the boolean costs
    #    milliseconds, and a model that scans a channel or grids a face does
    #    hundreds of them; on a real model that was the single largest line of
    #    a 495-second check run.
    #
    #    Both points sit half a wall INSIDE what they ask about, never on a
    #    face. `material_at` answers about the POINT, so a probe sitting on a
    #    surface answers about the surface -- and a cube, which answers about a
    #    small NEIGHBOURHOOD, would give a different answer there. Put the point
    #    where material is required and the two questions become the same one.
    with checklib.section("material probes"):
        solid = checklib.material_at(base)
        assert solid(0.0, 0.0, WALL / 2.0), (
            "the tray has no floor at its centre: the shell took it away")
        assert not solid(0.0, 0.0, HEIGHT - WALL / 2.0), (
            "the tray is solid where the cavity should be")

    # 5. Both sides of the joint have to stay flat all the way to the edge. One
    #    chamfer there and the box stands open by the size of the bevel -- and
    #    it reads as a modelling detail rather than as a fault.
    with checklib.section("mating faces"):
        problems += checklib.mating_face_flat(base, HEIGHT, name="base rim")
        problems += checklib.mating_face_flat(lid, LID_THICKNESS,
                                              name="lid underside")

    # 6. Every part fits a printer that exists, in the orientation it is
    #    exported in, and the mesh that came out of it is a real one.
    with checklib.section("printability"):
        for name, part in printables().items():
            box = part.val().BoundingBox()
            over = [f"{axis} ({length:.2f} mm)"
                    for axis, length in (("X", box.xlen), ("Y", box.ylen),
                                         ("Z", box.zlen))
                    if length > MIN_PRINTER_MM + PRINTER_TOL]
            assert not over, (
                f"{name} measures {box.xlen:.1f}x{box.ylen:.1f}x{box.zlen:.1f} "
                f"mm and is over {MIN_PRINTER_MM:.0f} mm along "
                f"{', '.join(over)}. That ceiling is not anyone's bed -- it is "
                f"the size below which printers essentially do not exist. Ask "
                f"which printer this is for and put its real build volume in "
                f"MIN_PRINTER_MM.")

            stl = Path(out_dir) / f"{name}.stl"
            size = stl.stat().st_size if stl.exists() else 0
            assert size >= MIN_STL_BYTES, (
                f"{stl.name} is {size} bytes, which is not a printable mesh")

    return problems
