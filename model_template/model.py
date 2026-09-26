"""A two-part box, its screws and the board it closes over -- one part of every
`kind` there is, so the whole catalogue contract is worked through here.

THIS FILE IS THE CONTRACT, and it is a working example of it rather than a
description. It is not the SMALLEST model the hub will build -- a catalogue
holding a single printable is that -- it is the one that works all three kinds
of part and both view ids that mean something. What it does NOT demonstrate is
described where each of them belongs, in the docstrings below, and used by
nothing here: a group, `deformed`, `alpha`, `color`, and the `print` view's
`nested_ok`. `hammerola build` on this directory publishes; replace the
geometry with your own and keep the three entry points:

    parts()       the catalogue: every part of the model, under the name it is
                  known by, and the one place its geometry lives
    views()       what the browser shows, one entry per tab -- each of them a
                  list of REFERENCES into the catalogue
    checks()      optional, and the only place project-specific rules live

`import checklib` is the fourth part of it. That module ships INSIDE the hub's
image, so it is not in this directory and there is nothing to install: the build
runs there, and the name resolves there. Do not put a checklib.py of your own at
the root of a project -- a model is imported with its own directory first on
`sys.path`, so your copy would win, and the interference volumes it records
would then be written into one copy and read out of the other. The build warns
and publishes anyway, with the numbers missing from metrics.json.

`ref/measurements.md` beside this file is the other half of the parameter block
below: every number written as `checklib.measured(...)` names a heading in it,
and the build refuses a source that points at no such file or no such heading.
A project that measures nothing needs no such file -- `estimated()` always
builds -- but every number still has to say which of the three it is.

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
#
# EVERY ONE OF THEM SAYS WHERE IT CAME FROM, and the build refuses one that
# does not: a module-level UPPER_SNAKE name bound to a bare float stops the
# push. Three ways to say it, and the third always builds --
#
#     checklib.measured(v, "ref/measurements.md#heading")  somebody measured it,
#                                                          and it is written
#                                                          down there
#     checklib.derived(v, "what it follows from")          it follows from
#                                                          other numbers
#     checklib.estimated(v, "what would settle it")        nobody measured it
#
# -- so most of a first model is honestly `estimated`, and the build says so in
# its log rather than letting a guess pass for a figure somebody took. A
# `measured` source that points at no file, or at no heading in one, is a
# refused build: a measurement nobody can go and read is an estimate with
# better manners.
#
# `MIN_STL_BYTES` at the end of this block is an `int` and is outside the rule
# entirely -- a count is not a dimension.
#
# TWO KINDS OF NUMBER CARRY A SUFFIX, and they are the pair that is easiest to
# mix up. `*_AVAILABLE` is room that EXISTS -- what a cavity, a slot or a
# clearance hole offers -- and `*_NEEDED` is what something DEMANDS of that
# room. Confusing the two is how a pocket comes out exactly the size of the
# thing that has to slide into it, which fits on the screen and not on the
# bench. The check is always `assert needed <= available`, and BOTH SIDES ARE
# READ OFF THE GEOMETRY rather than off these lines: two constants compared
# with each other hold however the solids came out, and go on holding after the
# model has drifted away from them. The suffix goes only where it says
# something -- a wall thickness is neither.
# --------------------------------------------------------------------------

# THE BOARD THE BOX CLOSES OVER, AND IT STANDS FIRST BECAUSE IT IS THE REAL
# OBJECT. It is a mock, so nothing is exported for it and nobody prints it: what
# it earns its place with is the FIT. It is cut round the posts, which is what
# says there is room inside for it, the viewer paints it as a mock rather than
# as something to make, and it is a leaf of the `assembled` tree you can look at
# on its own. It is NOT in assembled_preview.png -- that picture is of a shut,
# opaque box -- so it is something you open the viewer for.
#
# THE BOX IS DRAWN ROUND IT AND NOT THE OTHER WAY ROUND, which is why these four
# numbers come before the outer ones instead of after them. LENGTH and WIDTH
# below are `derived` from this block, a gap and a wall at a time. Written the
# other way -- an outer size picked by eye with the board fitted into it
# afterwards -- the file would state a dependency that never happened, and would
# go on stating it after somebody measured a different board.
BOARD_LENGTH = checklib.measured(
    45.0, "ref/measurements.md#board", "caliper, 3 samples")
BOARD_WIDTH = checklib.measured(
    28.0, "ref/measurements.md#board", "caliper, 3 samples")
BOARD_THICKNESS = checklib.measured(
    1.6, "ref/measurements.md#board", "caliper over the bare laminate, "
                                      "away from a pad, 3 samples")
BOARD_CLEARANCE = checklib.estimated(
    0.5, "per-side gap round the board: at the inner wall, and where it is cut "
         "round the posts. Settled by whether the board drops in without being "
         "pushed")

WALL = checklib.estimated(
    2.4, "wall and floor thickness: four perimeters at a 0.6 mm nozzle. "
         "Settled by printing one and pressing on it")

# What the board DEMANDS of the cavity: itself, plus its gap on both sides. No
# `CAVITY_LENGTH_AVAILABLE` stands beside it on purpose -- the room that exists
# is a property of the finished solid, and section 3 of `checks()` reads it off
# build_base() rather than off this line.
CAVITY_LENGTH_NEEDED = checklib.derived(
    BOARD_LENGTH + 2 * BOARD_CLEARANCE,
    "the board along X plus BOARD_CLEARANCE on each side")
CAVITY_WIDTH_NEEDED = checklib.derived(
    BOARD_WIDTH + 2 * BOARD_CLEARANCE,
    "the board along Y plus BOARD_CLEARANCE on each side")

LENGTH = checklib.derived(
    CAVITY_LENGTH_NEEDED + 2 * WALL,
    "outer X of both parts: the room the board needs, plus a wall on each side "
    "of it")
WIDTH = checklib.derived(
    CAVITY_WIDTH_NEEDED + 2 * WALL,
    "outer Y of both parts, arrived at the same way as LENGTH")
HEIGHT = checklib.estimated(
    20.0, "outer Z of the base; the lid sits on top of this. Settled by the "
          "tallest thing that has to go inside")
CORNER_RADIUS = checklib.estimated(
    3.0, "vertical corner fillet, outer. Chosen to look right; nothing but a "
         "printed part will settle it")

LID_THICKNESS = checklib.derived(
    WALL, "the flat plate of the lid is a wall -- the same thickness, arrived "
          "at the same way, so it moves when WALL moves")
LIP_HEIGHT = checklib.estimated(
    3.0, "how deep the lid plugs into the base. Settled by whether the box "
         "stays shut when it is picked up by the lid")
LIP_CLEARANCE = checklib.estimated(
    0.25, "per-side gap between the lip and the inner wall. Settled by "
          "printing the pair on the machine that will print them")

# The screw itself -- a bought part, drawn as a shank and a head. No thread:
# nothing is exported for it and nobody prints it. It is written BEFORE the
# posts below because they are drawn FROM it: TAP_DIA and CLEAR_DIA are
# expressions in SCREW_DIA, so moving this group down the file is a NameError
# on import rather than a matter of taste.
#
# The figures are the standard's, and the journal says so: three out of the bag
# were measured to check that the bag holds what the label claims, and the
# numbers here are the nominal ones rather than the mean of the three. The notes
# say that too -- "caliper, 3 samples" would be claiming the figure came out of
# the caliper.
SCREW_DIA = checklib.measured(
    3.0, "ref/measurements.md#screw",
    "DIN912 nominal; 3 samples across the shank confirm the bag")
SCREW_LENGTH = checklib.measured(
    8.0, "ref/measurements.md#screw",
    "DIN912 nominal, under the head, which is how a screw is measured; "
    "3 samples confirm the bag")
SCREW_HEAD_DIA = checklib.measured(
    5.5, "ref/measurements.md#screw",
    "DIN912 nominal; 3 samples confirm the bag")
SCREW_HEAD_HEIGHT = checklib.measured(
    3.0, "ref/measurements.md#screw",
    "DIN912 nominal; 3 samples confirm the bag")

# The four screw posts. They stand on the tray floor and reach the rim, so the
# screws pull the lid down onto something solid rather than onto the walls.
BOSS_INSET = checklib.estimated(
    8.0, "screw axis in from each outer face: far enough in that the post "
         "clears the corner fillet. Settled by looking at the assembled view")
TAP_DIA = checklib.derived(
    SCREW_DIA - 0.5, "the tapping drill for M3 -- the screw's own diameter "
                     "less 0.5 mm, so the screw cuts its own thread in this")
# THE DERIVATION RUNS THIS WAY ROUND ON PURPOSE, and it is worth a line because
# the other way round is the easy mistake. BOSS_DIA is the number somebody
# actually chose; the wall left round the tap hole is what FOLLOWS from it.
# Written the other way -- an estimated wall with the diameter derived from it --
# would state a dependency that never happened, and `derived` exists to say
# which number came from which.
BOSS_DIA = checklib.estimated(
    7.0, "outer diameter of a screw post: enough to leave wall all round an M3 "
         "tapping hole. Nobody measured how little would do -- settled by "
         "printing a post and tapping it")
BOSS_WALL = checklib.derived(
    (BOSS_DIA - TAP_DIA) / 2.0,
    "what BOSS_DIA leaves round the tapping hole, per side. Nothing draws with "
    "it: it is an expression so that the figure moves when either input does, "
    "instead of going stale in a comment")
BOSS_RELIEF = checklib.estimated(
    0.4, "per-side gap between a post and the hole in the lip. Settled by "
         "printing the pair")
TAP_DEPTH = checklib.estimated(
    7.0, "how far down a post the tapping hole runs: longer than the screw "
         "needs. Settled by the screw that ends up in it -- its length, less "
         "what the lid takes, plus a turn")
CLEAR_DIA = checklib.derived(
    SCREW_DIA + 0.4, "M3 clearance through the lid -- the screw's diameter "
                     "plus 0.4 mm, so the screw pulls the lid down rather "
                     "than threading into it")

PRINT_GAP = checklib.estimated(
    8.0, "space between the two parts in the `print` view: wide enough for a "
         "brim. Settled by the slicer, not by the design")

# What `checks()` holds the model to. These are limits rather than geometry.
FIT_MIN = checklib.estimated(
    0.15, "below this the lid becomes a press fit. Settled by printing the "
          "pair and trying it")
FIT_MAX = checklib.estimated(
    0.40, "above this the lid rattles. Settled the same way as FIT_MIN")

# How much downward surface with nothing under it this design tolerates on the
# lid. `checklib.unsupported_area` has no default for it, deliberately: some
# overhang is normal on most parts and a number picked in the library would be a
# number picked for somebody else's.
LID_OVERHANG_MM2 = checklib.estimated(
    0.0, "the lid prints flat face down, so every face of it is on the bed, "
         "vertical or pointing up, and none at all is the honest budget. "
         "Settled by turning the part over or by a feature that needs a bridge")

# NOT the bed of anybody's printer -- nobody named one. This is the size below
# which FDM printers essentially do not exist, so a part that fits inside it
# raises no question. A part that grows past it is the moment to ask which
# printer this is for and to put that machine's real build volume here.
MIN_PRINTER_MM = checklib.estimated(
    180.0, "settled by naming the printer this is for and putting its real "
           "build volume here")
# Slack on that ceiling: a bounding box carries the kernel's own numerical error
# (a fillet or a boolean leaves a micron or so), and without this a part drawn
# exactly 180 mm wide fails with the unanswerable "X (180 > 180 mm)".
PRINTER_TOL = checklib.estimated(
    0.05, "a rounding allowance rather than a dimension; nothing measures it")

# A "valid" solid that exports a stub file is a bug, and the export is the thing
# people actually print.
MIN_STL_BYTES = 1024


# --------------------------------------------------------------------------
# Geometry
#
# Each part is built by one function, and the views move copies of it into place
# with `at`. A PRINTABLE is built in the orientation it is PRINTED in, and that
# is deliberate: what `parts()` hands back is what lands in the STL somebody
# slices, so the orientation that matters is the one on the bed. Nothing prints
# a `hardware` or a `mock`, so neither has a bed to be oriented on -- build
# those wherever they are easiest to refer to, which is why the screw below
# stands with the underside of its head at the origin and the board lies where
# it actually lies.
# --------------------------------------------------------------------------

# @cache ON EVERY PART BUILDER, and it is not a micro-optimisation. `parts()`
# builds all four, and `parts()` itself is called twice over -- once by the
# build and once by section 7 of `checks()` below -- while `checks()` calls the
# builders again directly, from several places. Without this every one of those
# is a solid computed from scratch, which is about a fifth of the run on a model
# of any size. It is safe because these are pure functions of the constants
# above and CadQuery returns new objects rather than mutating in place; the one
# in-place change that happens (an STL export triangulates the shape) is undone
# by the hub after each export. Do not cache a builder whose result you then
# mutate.
#
# THE TWO FUNCTIONS DIRECTLY BELOW ARE NOT DECORATED, and neither is an
# oversight. `screw_axes()` hands back a mutable list, and a cached function
# that does hands the SAME list to every caller -- exactly the trap the line
# above warns about. `_columns()` could be cached, its arguments being numbers,
# and it would buy nothing: all five of its call sites sit INSIDE a builder that
# is already cached, so a second `parts()` never reaches it at all.

def screw_axes():
    """The (x, y) of the four screw axes, in the box's own coordinates."""
    x, y = LENGTH / 2.0 - BOSS_INSET, WIDTH / 2.0 - BOSS_INSET
    return [(sx * x, sy * y) for sx in (-1, 1) for sy in (-1, 1)]


def _columns(diameter, z_from, z_to):
    """Four vertical cylinders on the screw axes: posts, holes and reliefs.

    One helper for all of them, because every one of those features is round,
    concentric with a screw and the full height of something -- and the day an
    axis moves, it moves in one place.
    """
    return (cq.Workplane("XY", origin=(0, 0, z_from))
            .pushPoints(screw_axes())
            .circle(diameter / 2.0)
            .extrude(z_to - z_from))


@cache
def build_base() -> cq.Workplane:
    """The open-topped tray with its four screw posts, printed as modelled."""
    tray = (
        cq.Workplane("XY")
        .box(LENGTH, WIDTH, HEIGHT, centered=(True, True, False))
        .edges("|Z")
        .fillet(CORNER_RADIUS)
        # Take the top face away and hollow out the rest. The floor comes out
        # WALL thick, like the walls, because a shell is uniform.
        .faces(">Z")
        .shell(-WALL)
    )
    # The posts stand clear of the inner walls rather than merging into them,
    # so the rim stays a plain ring and the fit check below can read the cavity
    # off its inner wire.
    return (tray.union(_columns(BOSS_DIA, 0.0, HEIGHT))
            .cut(_columns(TAP_DIA, HEIGHT - TAP_DEPTH, HEIGHT + 1.0)))


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
    return (plate.union(lip)
            # The lip would sit where the posts do, so it is opened up around
            # them; the plate behind it is what the post tops bear on.
            .cut(_columns(BOSS_DIA + 2 * BOSS_RELIEF, LID_THICKNESS,
                          LID_THICKNESS + LIP_HEIGHT + 1.0))
            .cut(_columns(CLEAR_DIA, -1.0, LID_THICKNESS + LIP_HEIGHT + 1.0)))


@cache
def build_screw() -> cq.Workplane:
    """One M3x8 socket cap: a shank and a head, and no thread.

    Built with the underside of the head at the origin and the shank pointing
    down, which is how it goes in -- a reference in a view then only has to say
    where the head lands.
    """
    shank = cq.Workplane("XY").circle(SCREW_DIA / 2.0).extrude(-SCREW_LENGTH)
    head = (cq.Workplane("XY").circle(SCREW_HEAD_DIA / 2.0)
            .extrude(SCREW_HEAD_HEIGHT))
    return shank.union(head)


@cache
def build_board() -> cq.Workplane:
    """The board the box closes over, lying on the tray floor.

    Cut round the posts: a mock that ran through them would draw a picture
    nobody can build from.
    """
    return (cq.Workplane("XY", origin=(0, 0, WALL))
            .box(BOARD_LENGTH, BOARD_WIDTH, BOARD_THICKNESS,
                 centered=(True, True, False))
            .cut(_columns(BOSS_DIA + 2 * BOARD_CLEARANCE,
                          WALL - 1.0, WALL + BOARD_THICKNESS + 1.0)))


# Where the lid goes once the box is shut: turned over and dropped onto the
# rim. WRITTEN ONCE AND APPLIED WHEREVER THE SEATED LID IS WANTED -- the
# `assembled` view hands it over as its `at`, and lid_as_assembled() applies the
# same one -- so the check that measures the seated lid and the picture that
# shows it cannot disagree.
LID_SEATED = cq.Location(cq.Vector(0, 0, HEIGHT + LID_THICKNESS),
                         cq.Vector(1, 0, 0), 180)


def lid_as_assembled() -> cq.Workplane:
    """The lid where the `assembled` view puts it, for a check to measure.

    A VIEW MOVES A PART AND THE CATALOGUE NEVER DOES: `parts()` holds the lid
    in the orientation it prints in, because that is what lands in lid.stl, and
    a reference says where it stands with `at`. This applies LID_SEATED to
    every body, the way an `at` is applied.
    """
    lid = build_lid()
    return lid.newObject([shape.moved(LID_SEATED) for shape in lid.vals()])


# --------------------------------------------------------------------------
# The contract
# --------------------------------------------------------------------------

def parts():
    """The catalogue: every part of this model, under the name it is known by.

    THE KEY IS THE PART'S IDENTITY. It is the file stem a printable is exported
    under -- `base` becomes base.stl, base.step and base.3mf -- and the name
    every view points at. Letters, digits, dot, dash and underscore, starting
    with a letter or a digit. There is no display name: a second name would be a
    second identity to keep in step with the first.

    IT IS NOT A LABEL, and this model is the first one that shows the
    difference, because it is the first that points at one key four times. The
    exported tree names the repeats apart -- `screw`, `screw(2)`, `screw(3)`,
    `screw(4)` -- because a path has to be unique and a pick in the 3D scene
    reports one of them; the tree the reader is shown then puts those four
    adjacent siblings back into a single `screw` row with the count beside it.
    Both are built FROM the key, and neither is a second name to keep in step
    with it.

    TWO STEMS ARE TAKEN: `assembled` and `print`. The build writes an
    assembled.stl (the whole product glued together) and a print.stl (the bed
    as your `print` view lays it out) of its own next to the part files, so a
    part called either would be exported and then overwritten. The build
    refuses the name rather than letting that happen -- `print` in particular
    is an ordinary name for a single printed part, which is why it is spelled
    out here. They are `RESERVED_STEMS` in the hub's `cadbuild.parts`, and the
    hub's own suite checks that this paragraph still names every one of them.

    An entry is `{"shape": ..., "kind": ...}`; `color` and `note` are optional.
    In place of `shape` it may carry `mesh` -- a `trimesh.Trimesh` this file
    loaded itself, `trimesh.load("ref/scan.stl", force="mesh")` -- which is how
    somebody else's geometry (a scan, a part downloaded to fit against) gets
    into the scene. A mesh entry must be `mock`, nothing is exported from it,
    and `at` is refused on it: move it with `mesh.apply_transform(...)` here.
    `kind` is one of three and has NO DEFAULT, deliberately: `printable` is
    exported and gets download buttons, `hardware` is bought and goes into the
    product, `mock` is neither -- it is what the design has to fit, and nothing
    is exported for it either -- and defaulting to the first would offer a
    bought bearing for printing. At least one entry has to be `printable`.

    A part that names no colour is painted by what it IS: the palette for a
    printable, dark grey for hardware, a paler grey for a mock. So the picture
    says by itself what goes on the bed and what was bought.

    A `note` is one line for whoever OPENS the model: what to buy, what a number
    was chosen for, what to watch out for when assembling it.
    """
    return {
        "base": {"shape": build_base(), "kind": "printable"},
        "lid": {
            "shape": build_lid(), "kind": "printable",
            # Addressed to whoever opens this in the browser, which is why it
            # says what the picture cannot: the lid goes on this way up, and
            # the gap it needs is a printer setting rather than a number here.
            "note": "lip down into the tray; if it binds, print it with "
                    "horizontal expansion -0.05 mm rather than editing "
                    "LIP_CLEARANCE",
        },
        # Bought, so nothing is exported for it -- but it is in the product and
        # somebody has to buy four of them, which is what the note is for.
        "screw": {"shape": build_screw(), "kind": "hardware",
                  "note": "M3x8 DIN912, one per corner"},
        # Scenery: it is not part of this design, it is what the design is
        # built around.
        "board": {"shape": build_board(), "kind": "mock",
                  "note": "the board the box closes over, drawn for fit only"},
    }


def views():
    """The tabs the browser shows. Every entry is a list of REFERENCES.

    A view carries no geometry -- it points at catalogue keys -- so there is no
    second copy of a part to disagree with the first. Three forms of reference:

      * `"base"` -- the part exactly as the catalogue holds it;
      * `{"part": "screw", "at": <a cq.Location>}` -- the same part, placed.
        `alpha` goes in the same dict, for a part meant to be seen through;
      * `{"part": ..., "shape": ..., "deformed": "why"}` -- the one way geometry
        gets into a view, for a part that is genuinely a different shape in
        place. Not used here, and not allowed in `print`.

    A reference is not the only thing a `parts` list may hold, though: an entry
    can also be a GROUP, `{"group": "housing", "parts": [...]}`, nested, which
    is presentation and nothing else -- the hub's `cadbuild.views` is where its
    rules are written down. Not used here, and nothing needs one.

    One key may be referenced as many times as it is used: the screws below are
    one catalogue entry referenced once per axis.

    Two ids mean something and the rest are just tabs:

      * `assembled` is the product, and every printable has to be visible in it
        -- a part missing from this view reads as a design without that part.
        Parts may not share space there -- a `mock` excepted, which is never
        asked -- so an overlap that is the JOINT is declared with the reason it
        happens, by catalogue key.
      * `print` is the bed: only printables go on it, `at` may move them and
        turn them about Z, and they may not stand inside one another. A pair
        that really is nested on purpose goes in that view's
        `"nested_ok": [("a", "b")]`.
    """
    return [
        {
            "id": "assembled",
            "name": "assembled",
            "parts": [
                "base",
                {"part": "lid", "at": LID_SEATED},
                # One reference per screw, each placed with the underside of
                # its head on the lid's outer face.
                *[{"part": "screw",
                   "at": cq.Location((x, y, HEIGHT + LID_THICKNESS))}
                  for x, y in screw_axes()],
                "board",
            ],
            # The declaration this view exists to demonstrate. The shank is
            # 3.0 across and the printed hole 2.5, so the two really do occupy
            # the same space -- which is the joint working, not a mistake, and
            # the reason is printed in the build log. The board needs no entry
            # here: a mock is scenery and is never asked about.
            "interference_ok": [
                ("screw", "base", "the screw cuts its own thread in the "
                                  "printed hole"),
            ],
        },
        {
            "id": "print",
            "name": "as printed",
            "parts": [
                "base",
                # Laid clear of the base along Y. Orienting a part for printing
                # leaves it standing at the origin, and forgetting this move is
                # what the layout gate exists to catch.
                {"part": "lid", "at": cq.Location((0, WIDTH + PRINT_GAP, 0))},
            ],
        },
    ]


def checks(out_dir):
    """The rules that are true of THIS box, run after the geometry gate.

    Optional: delete the function and the build still works. What belongs here
    is everything a review or a printed part taught you -- one more assert per
    lesson. What does not belong here is anything the shared gate already does
    (valid solid, watertight, one body, printables not standing inside one
    another on the bed, and -- since the catalogue -- two parts of the
    `assembled` view sharing space unless that view declares why).

    A MOCK IS EXEMPT FROM THAT LAST ONE ENTIRELY, with no declaration and no
    line in the log: the gate skips every pair with a `mock` on either side
    before it measures anything, because a mock is scenery. So "does this fit
    inside the thing it is built around" is a question nothing shared answers --
    a bracket drawn straight through the wall it mounts on publishes clean --
    and it is exactly the kind of rule this function is for. Section 3 below is
    this model's one, and it is worth copying the SHAPE of: the room is read off
    the finished base and the demand off the mock, so neither side of it can be
    answered by the constants that drew them. The lines at the top of this file
    say the cavity is the board plus a gap; that section is what says it still
    IS, after the shell, the fillets and the posts have had their say.

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

    # 1. BOTH PRINTED PARTS SURVIVED THE OPERATIONS THAT MADE THEM, and this
    #    goes first because everything below reads faces off them. An emptied
    #    result is NOT falsy -- `.vals()` on it is a list holding one empty
    #    Compound, so `assert base.vals()` is an assert that cannot fail -- and
    #    the volume is what tells the two apart.
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
    #    LENGTH/WIDTH does not empty the base -- it grows towards solid and then
    #    the kernel refuses outright. Measured on cadquery 2.8.0, as the volume
    #    of what build_base() RETURNS rather than of the tray before the posts
    #    go on: WALL 2.4 -> 16225 mm3, 10.0 -> 39725, 19.9 -> 47708, and at 20.0
    #    the kernel raises `Standard_Failure: BRep_API: command not done`.
    #    The lid's line is here for the edit that turns one of its booleans into
    #    a cut that takes everything, and so that each part is named by a check
    #    of its own.
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
    #
    #    THE LARGEST FACE OF THE SELECTION ON BOTH SIDES, never the first one.
    #    `>Z` hands back every face at the top, and how many that is depends on
    #    the geometry: five on the base today (the rim and the four post tops),
    #    one on the lid. `.val()` would take whichever of them came back first,
    #    which is an arbitrary choice the moment there is more than one -- and
    #    on the lid there nearly is: the lip top is only 1.45 mm wide beside
    #    each relief hole, so a bigger boss or a smaller inset splits it.
    with checklib.section("lid fit"):
        rim = max(base.faces(">Z").vals(), key=lambda face: face.Area())
        cavity = min((wire.BoundingBox() for wire in rim.Wires()),
                     key=lambda box: box.xlen)
        lip = max(lid.faces(">Z").vals(),
                  key=lambda face: face.Area()).BoundingBox()
        for axis, gap in (("X", (cavity.xlen - lip.xlen) / 2.0),
                          ("Y", (cavity.ylen - lip.ylen) / 2.0)):
            assert FIT_MIN <= gap <= FIT_MAX, (
                f"the lid-to-base gap along {axis} is {gap:.2f} mm per side, "
                f"outside {FIT_MIN}..{FIT_MAX} mm")

    # 3. THE CAVITY STILL HOLDS THE THING THE BOX WAS DRAWN AROUND. Nothing
    #    shared asks this: the gate skips every pair with a `mock` on either
    #    side, so a board standing through the wall publishes without a word.
    #
    #    NEEDED AGAINST AVAILABLE, and BOTH SIDES OFF THE SOLIDS. The room is
    #    `cavity` -- the inner wire of the rim, read off build_base() two
    #    sections up, so it is what the shell and the fillets actually left --
    #    and the demand is the mock's own bounding box out of build_board().
    #    Neither is CAVITY_LENGTH_NEEDED or BOARD_LENGTH: those are the lines
    #    that DREW this, and comparing a line with itself passes on the day the
    #    shell eats the cavity.
    #
    #    THE BOUNDING BOX IS THE HONEST QUESTION FOR THIS BOARD and would not
    #    be for every mock: a rectangle cut round the posts sits inside its own
    #    box, so what the box says is what the board asks of the walls. A mock
    #    with an arm reaching out of its footprint needs the arm measured where
    #    it goes, not a box drawn round the whole of it.
    with checklib.section("the board fits"):
        needed_box = build_board().val().BoundingBox()
        for axis, needed, available in (("X", needed_box.xlen, cavity.xlen),
                                        ("Y", needed_box.ylen, cavity.ylen)):
            assert needed <= available, (
                f"the board needs {needed:.2f} mm along {axis} and the cavity "
                f"offers {available:.2f} mm. The box is drawn round the board, "
                f"so this is the box having drifted away from what it is for")

    # 4. The two printed parts have to go together without sharing space.
    #
    #    THE SHARED GATE ALREADY REFUSES THAT, and this section stays anyway --
    #    do not delete it as a duplicate. The gate returns a VERDICT and records
    #    no number: it is silent about every pair it passes, it allows anything
    #    under its own 1e-3 mm3 tolerance, and a pair listed in
    #    `interference_ok` it never measures at all. This records the VOLUME
    #    into metrics.json (`assembly.interference_mm3`, `base|lid`, 0.0 today),
    #    which is the only thing that can say this joint MOVED between two
    #    revisions: a seat that has begun to share volume UNDER that tolerance
    #    passes the gate in the same silence as one that merely touches, and is
    #    a changed number here.
    #
    #    IT MEASURES THE PAIR IT NAMES, which is a real limit and not an
    #    implementation detail. The pair this model DECLARES -- screw against
    #    base -- is measured by neither side: the gate skips it because it is
    #    declared, and this list does not hold the screw, so a declared overlap
    #    that quietly doubled is invisible in both places. Putting it under a
    #    number means adding it here, positioned the way the `assembled` view
    #    places it, because the catalogue holds it at the origin.
    #
    #    Asked of the pair from checklib rather than by hand: it walks every
    #    body of each object. Parts that only touch face to face intersect in
    #    zero volume, so a seated lid passes.
    #
    #    This is the section that grows: it is one boolean per pair of parts,
    #    and the number of pairs grows with the square of the part count.
    with checklib.section("interference"):
        problems += checklib.pairwise_interference(
            [base, lid_as_assembled()], ["base", "lid"])

    # 5. The shell has to have left a floor and a hollow. Asked as two POINTS,
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

    # 6. Both sides of the joint have to stay flat all the way to the edge. One
    #    chamfer there and the box stands open by the size of the bevel -- and
    #    it reads as a modelling detail rather than as a fault.
    with checklib.section("mating faces"):
        problems += checklib.mating_face_flat(base, HEIGHT, name="base rim")
        problems += checklib.mating_face_flat(lid, LID_THICKNESS,
                                              name="lid underside")

    # 7. Every printed part fits a printer that exists, in the orientation it is
    #    exported in, and the mesh that came out of it is a real one. The
    #    catalogue is walked rather than a list written out here, so a PRINTABLE
    #    added to parts() is a part this section measures -- and only a
    #    printable: the loop three lines down steps over what is bought and what
    #    is scenery, because nothing is exported for either.
    with checklib.section("printability"):
        for name, record in parts().items():
            if record["kind"] != "printable":
                # Nothing is exported for what is bought or for what is only
                # there to make the picture readable, so there is no file
                # beside this one to measure.
                continue
            box = record["shape"].val().BoundingBox()
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

    # 8. And the lid prints with nothing hanging in the air. build_lid() says in
    #    its docstring that this is why it is modelled flat face down; this is
    #    what holds it to that, and it asks the MESH the build already exported
    #    rather than the solid -- so the orientation measured is the one the
    #    slicer gets, and the same shape lying the other way up is a different
    #    answer.
    #
    #    WHERE THE BUDGET CAME FROM: LID_OVERHANG_MM2 is 0.0 because this part
    #    has no downward face off the bed at all -- a plate, a lip on top of it
    #    and vertical holes through both. `unsupported_area` has no default for
    #    it deliberately, since some overhang is normal on most parts, so a
    #    design that tolerates a chamfer under a rim or a short bridge names the
    #    area it tolerates here and says what that number came from.
    with checklib.section("overhangs"):
        problems += checklib.unsupported_area(
            Path(out_dir) / "lid.stl", LID_OVERHANG_MM2, name="lid")

    return problems
