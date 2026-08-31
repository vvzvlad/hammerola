#!/usr/bin/env python3
"""The gates that read a whole view: the print plate, and the assembly.

All of them run before anything is exported, and that ORDER is the point --
though it is the point for two DIFFERENT reasons, and only one of them is about
a verdict read off a box. An export meshes the shape in place: from then on the
box OCCT hands back is the mesh's box rather than the shape's, reading BIGGER
and never smaller (geometry.drop_mesh has the measurements and the caveats).
The PLATE judges extents outright, so an inflated box there can fail a layout
that is laid out correctly. `check_interference` uses boxes only as a FILTER,
and an inflated one flips no verdict by itself -- what it does is send a pair of
bodies to the boolean that had no business reaching one, and a boolean the
kernel refuses ends the WHOLE part pair (`_intersection_volume`), taking the
verdict on a real overlap elsewhere in that same pair with it. So both measure
before anything has been exported, whatever the size of the difference.

The size is worth stating honestly rather than dramatising: the inflation
measured so far sits BELOW `PRINT_OVERLAP_TOL` -- more than an order of
magnitude below it -- so on today's numbers this gate would not go red on a
correct plate. That is a coincidence of two independently chosen quantities,
not a design: the tolerance was picked against the accuracy of the boxes and
the physics of a first layer, and nothing about it was ever sized against a
triangulation. An inflation that grew past `PRINT_OVERLAP_TOL` would fail a
plate that is laid out correctly, and nobody promised it cannot.

WHAT THESE GATES NO LONGER DO is worth naming, because it was half this file.
Coverage used to be a GUESS: a fingerprint of each solid (volume, face count,
face areas) matched against `printables()` by a bipartite matching, plus a
whole-word match on part names as a courtesy. Both were reconstructions of an
identity nothing had stated, and both were wrong in ways a green build could
not show -- a decoy solid of a similar shape answered for a real part, and a
part renamed in a view ("base (print)") went on satisfying the check while
losing its own files. A view now REFERENCES a catalogue key, so coverage is a
set membership and nothing else.
"""

import time

from .artifacts import ASSEMBLED_VIEW_ID, PRINT_VIEW_ID
from .errors import BuildError
from .geometry import as_shapes
from .palette import INVISIBLE_ALPHA
from .parts import KIND_MOCK, KIND_PRINTABLE, printable_keys


# Millimetres of bounding-box overlap to shrug off in the print view.
#
# What the number has to clear is the accuracy of the boxes, not "nothing".
# The boxes come from cadquery's Shape.BoundingBox(), which is
# BRepBndLib.AddOptimal_s -- the exact box, found by searching each surface for
# its extremum. That is the right one and not a free choice: the cheap
# BRepBndLib.Add_s bounds a B-spline by the hull of its control points instead,
# and on a swept spline that was measured 3.6 mm too wide in Y -- two honestly
# laid out parts would then overlap on paper and go red with nothing to fix.
# AddOptimal is exact but not infinitely so: it pads by ~1e-7 and its extremum
# search on a swept B-spline was measured to land within ~1e-3 mm. At the old
# 1e-6 the tolerance was a thousand times tighter than the numbers it judged,
# so "laid out exactly edge to edge" was true only by luck.
#
# 0.05 mm is chosen to mean something instead: below it, two parts on a plate
# are not a layout mistake by any physical reading -- it is a twentieth of a
# nozzle, less than the first-layer squish, and under the slicer's own arc
# tolerance. What this check exists to catch is the forgotten layout, where
# parts sit at the origin inside one another and overlap by millimetres.
PRINT_OVERLAP_TOL = 0.05

# How far a rotation matrix may be from an exact turn about Z before the print
# gate calls it a tilt.
#
# The two ends this sits between are far apart, which is what makes the number
# easy to justify. Below it: a Location built from exact axes and composed by
# OCCT leaves errors around 1e-15, ten orders of magnitude under this. Above
# it: the smallest tilt anybody could mean is far bigger -- a rotation of
# 0.0001 degrees about X already puts 1.7e-6 into the row this checks, so every
# tilt a person could type is caught. Nothing in between is a real case.
Z_ROTATION_TOL = 1e-6

# Cubic millimetres of intersection to shrug off in the assembled view.
#
# The number is about the boolean and not about the design: OCC's `common` on
# two solids that merely touch returns an empty compound (measured: exactly
# 0.0), but a tangential contact can also come back as a sliver SOLID whose
# volume is numerical dust. 0.001 mm3 is a thousandth of a cubic millimetre --
# far under anything that could be a real overlap. A press fit of 0.05 mm on a
# 10 mm boss 5 mm deep is about 8 mm3, four orders of magnitude above this, and
# that one SHOULD be reported and declared.
#
# THE OTHER TANGENTIAL RESULT -- a sliver of an open SHELL -- is not what this
# number is for and never was, though it used to be the case named here. It is
# excluded rather than tolerated: `_intersection_volume` sums `Solids()`, so a
# result with no solid in it contributes nothing at all. Reading `Volume()` off
# the whole result would not have been dust to shrug off -- on an open shell
# that is the volume of the body OCC closes it into, which is bounded by the
# parts rather than by anything small.
INTERFERENCE_VOLUME_TOL = 1e-3


def _view(prepared, vid):
    """The prepared view with this id, or None."""
    for view in prepared:
        if view["id"] == vid:
            return view
    return None


def _bodies(node, vid):
    """A leaf's bodies and their bounding boxes -- resolved ONCE, side by side.

    Every body of every object, not the first body of each: an object assembled
    with `.add()` is several solids, and the one that ends up standing in a
    neighbour is as likely to be the second as the first.

    THE TWO ARE HANDED BACK TOGETHER because everything downstream needs them
    to be the same solids in the same order, and resolving the object once is
    the only way to get that rather than to assume it. A node without an `at`
    holds the MODEL's object verbatim -- `views._read_reference` stores
    `record["shape"]` as it was handed over and `_placed` gives it back
    untouched when `at` is None -- and a model is arbitrary python this build
    runs, so nothing promises that a second `vals()` answers like the first.
    Taking boxes here and resolving the bodies again where the booleans are
    asked was what this replaced: the boxes would describe one list of solids
    and the booleans ask about another. A different ORDER at the same length
    puts the wrong two bodies into the kernel and reports a verdict about
    neither; a different LENGTH raises IndexError outside the gate's own `try`,
    i.e. a bare traceback where a BuildError belongs. Neither is expressible
    once there is only one list.
    """
    shapes = as_shapes(node["shape"], f"view {vid!r} part {node['label']}")
    return shapes, [shape.BoundingBox() for shape in shapes]


def _overlap(a, b):
    """How far two boxes overlap on each axis; negative means a gap."""
    return (min(a.xmax, b.xmax) - max(a.xmin, b.xmin),
            min(a.ymax, b.ymax) - max(a.ymin, b.ymin),
            min(a.zmax, b.zmax) - max(a.zmin, b.zmin))


def check_print_layout(prepared, catalogue):
    """The `print` view has to be a plate: printable parts, upright, laid out.

    Three rules, and each of them catches a different way of publishing a
    picture of a bed nobody could print.

    ONLY PRINTABLES. The plate is what goes on the printer, and `print.stl` is
    a file somebody may hand to a slicer. A mock of a bought bearing on it is
    an invitation to print the bearing; hardware on it is the same thing said
    about a screw.

    NO TILT. Which way up a part is printed is a property of the PART, so the
    catalogue holds it that way and the `print` view moves it into place --
    `at` may translate and it may turn about Z, because that is what laying out
    a bed is. A rotation about any other axis is re-orienting the part, and the
    part that then gets printed is not the one the catalogue holds.

    NOTHING STANDING INSIDE ANYTHING. Helpers that orient a part for printing
    each hand it back standing at the origin, and laying the parts out is a
    separate step that is easy to forget. Forget it and the view still renders,
    still tessellates, still publishes -- as parts modelled inside one another,
    which is what anyone opening that tab is looking at.

    Bounding boxes, not booleans, for that last one: parts on a bed need clear
    air between them, and two boxes that overlap is already the answer.
    Touching -- a gap of zero -- passes. A one-part print view has nothing to
    lay out, and a project with no print view is not made to have one.
    """
    view = _view(prepared, PRINT_VIEW_ID)
    if view is None:
        return
    nodes = view["nodes"]

    not_printed = [node for node in nodes
                   if catalogue[node["key"]]["kind"] != KIND_PRINTABLE]
    if not_printed:
        listed = "\n".join(
            f"  - {node['label']} is {catalogue[node['key']]['kind']}"
            for node in not_printed)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} holds parts that are not printed:\n"
            f"{listed}\n"
            f"The {PRINT_VIEW_ID!r} view is the bed, and {PRINT_VIEW_ID}.stl "
            "is a file somebody may open in a slicer -- a bought part on it is "
            "an offer to print the thing that was bought. Show it in "
            f"{ASSEMBLED_VIEW_ID!r}, where it belongs, and leave the plate to "
            "what comes off the printer."
        )

    tilted = [node for node in nodes if not _turns_about_z_only(node["at"])]
    if tilted:
        listed = "\n".join(f"  - {node['label']}" for node in tilted)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} turns parts off the bed:\n{listed}\n"
            'On the plate "at" may move a part and turn it about Z, and that '
            "is all: which way up a part prints is a property of the part, so "
            "the catalogue holds it in its print orientation and the view only "
            "lays it out. Rotate it where it is built, not where it is shown. "
            "A MIRROR is refused by the same line and for a stronger reason: "
            "reflecting a chiral part produces a different part, and the file "
            "published under this key would hold the other one."
        )

    if len(nodes) < 2:
        return
    allowed = view["nested_ok"]

    entries = []
    for index, node in enumerate(nodes):
        # The plate judges EXTENTS and nothing else, so the bodies themselves
        # go nowhere from here -- but this is the FIRST place a catalogue
        # entry's stack is checked WHOLE, which is the whole reason as_shapes
        # exists ("every body in a Workplane, not just the first"). The entry
        # was admitted by `parts.read_catalogue` through `as_shape`, which looks
        # at `obj.val()` and nothing else, and `views._placed` runs it through
        # `as_shapes` only when the reference carries an `at`. So a BARE
        # reference to an entry whose stack is [a solid, something that is not
        # geometry] arrives here checked on its first body alone, and the
        # message as_shapes raises about the second names the part.
        _, boxes = _bodies(node, PRINT_VIEW_ID)
        for box in boxes:
            entries.append((index, node, box))

    problems = []
    seen_pairs = set()
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            owner_i, node_i, box_i = entries[i]
            owner_j, node_j, box_j = entries[j]
            # Bodies of the SAME object are not compared with each other --
            # they are one part as far as the view is concerned, they carry one
            # label, and so there would be no way to declare such a pair
            # nested_ok.
            if owner_i == owner_j:
                continue
            if frozenset((node_i["key"], node_j["key"])) in allowed:
                continue
            over = _overlap(box_i, box_j)
            # Boxes intersect only when they overlap on all three axes; a gap
            # on any one of them means the parts are clear.
            if min(over) <= PRINT_OVERLAP_TOL:
                continue
            # One line per pair of parts, not per pair of bodies: a two-body
            # object standing in a neighbour would otherwise say the same thing
            # twice under the same two labels.
            pair = frozenset((owner_i, owner_j))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            problems.append(
                f"  - {node_i['label']} and {node_j['label']} overlap by "
                f"X {over[0]:.2f}, Y {over[1]:.2f}, Z {over[2]:.2f} mm"
            )
    if problems:
        listed = "\n".join(problems)
        raise BuildError(
            f"view {PRINT_VIEW_ID!r} has parts standing inside each other:\n"
            f"{listed}\n"
            "The print view is the bed: every part needs its own patch of it. "
            'Give each reference an "at" that moves it clear of the others. A '
            "pair that really is nested on purpose goes in the view's "
            '"nested_ok": [("a", "b")], by catalogue key.'
        )


def _turns_about_z_only(at):
    """Is this Location a translation and a turn about Z, and nothing else?

    Read off the rotation matrix rather than off Euler angles, because the
    question is about the matrix: a rotation is about Z exactly when it leaves
    Z alone, i.e. when the third row and the third column are both (0, 0, 1).
    Euler angles would have to be decomposed first, and a decomposition has
    conventions and gimbal cases; this has neither.

    TWO LINES ARE NOT THE WHOLE ANSWER, and the missing half is a MIRROR. The
    third row and column say the matrix leaves Z alone; they do not say it is a
    rotation. A reflection in a PLANE THAT CONTAINS Z leaves Z exactly where it
    was, so both lines read (0, 0, 1) and every comparison below passes.
    Measured on cadquery 2.8.0: `gp_Trsf.SetMirror(gp_Ax2(origin, X))` --
    reflection in the YZ plane, i.e. the plane whose NORMAL is X -- gives
    [[-1,0,0],[0,1,0],[0,0,1]], which this used to call an ordinary turn.

    The `gp_Ax1` overload of `SetMirror` is a different transformation and is
    not what this line is about: a mirror about an AXIS is axial symmetry, a
    half turn around it, determinant +1. About X that is diag(1, -1, -1), which
    moves Z -- so the two lines caught it on their own, before any determinant.

    That is not a pedantic case on a print bed. A mirrored chiral part -- a
    left-hand bracket against a right-hand one -- is a DIFFERENT part from the
    one the catalogue holds, and it is the part that would be printed while
    `<key>.stl` next to it holds the other one. So the sign of the determinant
    is asked first: `IsNegative()` is true exactly when the vectorial part has a
    negative determinant, which is what separates a rotation from a rotation
    composed with a reflection.
    """
    if at is None:
        return True
    try:
        trsf = at.wrapped.Transformation()
        mirrored = bool(trsf.IsNegative())
        rows = [[float(trsf.Value(row, col)) for col in (1, 2, 3)]
                for row in (1, 2, 3)]
    except Exception as exc:
        raise BuildError(
            f'"at" is {at!r}, and the build could not read a rotation out of '
            f"it ({type(exc).__name__}: {exc}). It has to be a cq.Location."
        ) from exc
    if mirrored:
        return False
    third_row = rows[2]
    third_column = [rows[0][2], rows[1][2], rows[2][2]]
    return all(abs(value - want) <= Z_ROTATION_TOL
               for line in (third_row, third_column)
               for value, want in zip(line, (0.0, 0.0, 1.0)))


def check_assembled_coverage(prepared, catalogue):
    """Every printable has to be IN the assembled view, by name.

    A part can be modelled, exported, downloadable and checked, and still be
    missing from the one picture the product is judged by -- and a design
    missing a part reads as a design without it. This is now an exact
    question -- is this catalogue key one of the keys this view references --
    where it used to be a guess about shapes and about words in a label.

    A reference at alpha 0 is not drawn, so it does not count: certifying "this
    printable is visible" about a part nobody can see is the same failure with
    an extra step. It is warned about where the alpha is read (prepare_views).
    """
    view = _view(prepared, ASSEMBLED_VIEW_ID)
    if view is None:
        # prepare_views refuses a model without one, so this is the defensive
        # half of that rule rather than a second policy.
        raise BuildError(f"there is no {ASSEMBLED_VIEW_ID!r} view to judge")

    shown = {node["key"] for node in view["nodes"]
             if node["alpha"] > INVISIBLE_ALPHA}
    missing = [key for key in printable_keys(catalogue) if key not in shown]
    if missing:
        raise BuildError(
            f"view {ASSEMBLED_VIEW_ID!r} does not show printable(s) "
            f"{', '.join(repr(k) for k in missing)}. The assembled view is "
            "what the design is judged by and the only place the build counts "
            "parts from, so every printed part is in it -- add the key to its "
            '"parts". Hardware and mocks alongside are fine; printables are '
            "what must be there."
        )

    for node in view["nodes"]:
        if (catalogue[node["key"]]["kind"] == KIND_PRINTABLE
                and node["alpha"] < 1.0):
            # A WARNING and not a refusal, deliberately: the asymmetry is that
            # an agent has to act on what the build says and a person may
            # decide they meant it. A see-through printed part in the picture
            # the product is judged by is usually a leftover from looking
            # inside the assembly once.
            print(
                f"warning: view {ASSEMBLED_VIEW_ID!r} draws printable "
                f"{node['label']} at alpha {node['alpha']:g}. This is the view "
                "the product is judged by, and a part that is printed solid is "
                "drawn solid in it -- look through the mocks instead, or take "
                "the alpha off once you have seen inside."
            )


def check_interference(prepared, catalogue):
    """Nothing in the assembled view may overlap unless the view says why.

    THIS IS WHAT REPLACED THE DECOY. Coverage by shape used to accept any solid
    that measured like the part, so a second, similar body standing in the
    assembly answered for the real one; now every solid in the view IS a
    catalogue part, and the remaining way to publish an impossible assembly is
    to let two of them occupy the same space. Interference that is meant --
    a printed thread biting into its seat, a barb in a tube, an insert melting
    into its hole -- is DECLARED with a reason, and the reason is printed here.

    A `mock` IS NOT MATERIAL AND IS NOT ASKED ABOUT. The catalogue is what makes
    that a question this gate can answer at all, and the answer is a decision:
    a pair with a mock on either side is skipped entirely. The gate asks "can
    these two things both be there", and a mock is scenery -- the wall a bracket
    bolts to, the barrel a frame stands in -- which is not there in the first
    place. Those objects overlap the product BY CONSTRUCTION, so requiring a
    declaration with a reason for each would fill `interference_ok` with rows
    reading "the wall, because it is the wall" and drown the one real
    declaration among them. `hardware` STAYS UNDER THE GATE, and that half is
    the point of splitting the kinds here: a screw's thread biting into a
    printed hole is exactly the overlap the contract asks to be declared with a
    reason.

    The cost is why the boxes come first: pairs grow with the square of the
    references, and a boolean on every pair of a twenty-part assembly is
    minutes. Bounding boxes answer nearly all of them for nothing -- two parts
    whose boxes are clear cannot intersect -- so the boolean is only asked
    about pairs that survive the box test.

    THE FILTER RUNS AT ONE LEVEL, ON THE PAIRS OF BODIES, and the pair of PARTS
    is answered by that same comparison: this pair needs a boolean exactly when
    some pair of their bodies survived it. That derived condition is STRICTER
    than a test on a hull round each part -- two parts whose hulls overlap in
    the air between their bodies survive a hull and are dropped here -- so it
    can never let through a pair a hull would have caught.

    `checklib.pairwise_interference` DOES keep both levels: a hull per part,
    and a far pair rejected in one comparison before any per-body box is looked
    at. It is named here because it is otherwise this gate's model -- three of
    its decisions are copied deliberately, see `_intersection_volume` -- so
    which of them are NOT copied has to be said out loud. This is one: a hull
    level here would buy nothing measurable, because the per-body boxes are
    taken either way (a hull is derived from them) and what a far pair of two
    ten-body parts then costs is a hundred `_overlap` calls on floats already
    in hand, against booleans measured in seconds. The price would be a second
    condition to keep true forever.

    The one level is not only arithmetic -- see `_intersection_volume` for why
    a body pair that cannot overlap must never reach a boolean.

    AN EXEMPTION IS BY CATALOGUE KEY, so it covers EVERY instance of that pair
    of keys. Five references to `pin` are ten pin-against-pin pairs and one
    declaration takes the check off all ten. That follows from a declaration
    naming parts rather than references -- there is nothing to name a single
    reference by -- and it is the same reading `nested_ok` has on the plate.
    """
    view = _view(prepared, ASSEMBLED_VIEW_ID)
    if view is None or len(view["nodes"]) < 2:
        return
    nodes = view["nodes"]
    allowed = view["interference_ok"]
    for pair, reason in sorted(allowed.items(), key=lambda item: sorted(item[0])):
        # Printed whether or not the pair turns out to overlap: a declaration
        # that stopped being needed is worth seeing in the log, and a reader of
        # the log must be able to see every exemption this build ran with.
        listed = " and ".join(repr(key) for key in sorted(pair))
        print(f"  {ASSEMBLED_VIEW_ID}: {listed} may overlap -- {reason}")

    started = time.monotonic()
    # WHAT IS SCENERY IS DECIDED BEFORE ANY BOX IS TAKEN, and the order is the
    # whole saving: `Shape.BoundingBox()` is BRepBndLib.AddOptimal_s, a search
    # for the extremum of every surface (see PRINT_OVERLAP_TOL), and a mock is
    # exactly the object that is heavy -- an imported STEP of a barrel, a wall,
    # a board. Nothing below asks a mock anything, so nothing here measures one.
    scenery = [catalogue[node["key"]]["kind"] == KIND_MOCK for node in nodes]
    # ONE RESOLUTION PER NODE, and it is what the whole pass below is built on
    # (see `_bodies`). A mock is not resolved here at all, because nothing below
    # asks a mock anything; the geometry of one is still validated where it is
    # used -- `assembly.assembled_shape` walks every leaf of this view through
    # `as_shapes`, and `views.export_views` tessellates every one of them.
    resolved = [None if is_scenery else _bodies(node, ASSEMBLED_VIEW_ID)
                for node, is_scenery in zip(nodes, scenery)]
    problems = []
    tested = 0
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if scenery[i] or scenery[j]:
                continue
            if frozenset((nodes[i]["key"], nodes[j]["key"])) in allowed:
                continue
            # STRICTLY GREATER THAN ZERO, with no tolerance of its own, and
            # that is deliberate rather than an oversight: a positive slack
            # here would reject pairs that really do share volume. Overlap
            # depth and overlap VOLUME are different quantities -- a tenth of a
            # millimetre across a 30 x 30 mm face is 90 mm3, five orders of
            # magnitude over INTERFERENCE_VOLUME_TOL -- so a box filter loose
            # enough to speed anything up is loose enough to hide a real
            # finding, silently and for good. Cheapness here comes from pairs
            # that are nowhere near each other, which is nearly all of them.
            #
            # THE SURVIVORS ARE CARRIED, not recomputed and not thrown away.
            # The same comparison decides two things at once: whether this pair
            # of PARTS needs a boolean at all, and which pairs of BODIES inside
            # it do -- ten bodies against ten is as many booleans as the boxes
            # could not settle, not a hundred. And it is not only cost:
            # `_intersection_volume`
            # ends the whole part pair on the first boolean the kernel refuses,
            # so a body pair that could never overlap must not be able to reach a
            # boolean and take away the verdict on a real overlap elsewhere in
            # the same pair.
            #
            # WHAT IS CARRIED IS THE BODIES THEMSELVES, never an index into a
            # list somebody downstream would have to rebuild: a box and the
            # boolean about it are then the same object by construction, and
            # not by two walks of a model's object agreeing (see `_bodies`).
            left_bodies, left_boxes = resolved[i]
            right_bodies, right_boxes = resolved[j]
            pairs = [(left, right)
                     for left, left_box in zip(left_bodies, left_boxes)
                     for right, right_box in zip(right_bodies, right_boxes)
                     if min(_overlap(left_box, right_box)) > 0.0]
            if not pairs:
                continue
            tested += 1
            volume = _intersection_volume(nodes[i]["label"], nodes[j]["label"],
                                          pairs)
            # None is "the kernel would not answer", not "nothing overlaps":
            # it has already been said out loud, and no verdict is passed on a
            # pair nothing measured.
            if volume is not None and volume > INTERFERENCE_VOLUME_TOL:
                problems.append(
                    f"  - {nodes[i]['label']} and {nodes[j]['label']} share "
                    f"{volume:.3f} mm3"
                )
    # WITH THE TIME IT TOOK, in the shape every other timing in this build is
    # printed in (`1.2s`, one decimal). This is O(n^2) booleans hiding inside
    # the `geometry` phase, and on a real model measured 2026-08-29 the phase
    # next door was 495 seconds against a 900-second process ceiling
    # (buildproc.limits.DEFAULT_WALL_SECONDS) -- so a slow build needs some way
    # to see whether this is where the minutes went. Measured with
    # time.monotonic() rather than with `checklib.section`, which measures the
    # same way but files its total into the table run_checks prints for the
    # MODEL's own checks(): this is a gate, it runs before checks() is called at
    # all, and a row for it there would read as a check the model wrote.
    print(f"  {ASSEMBLED_VIEW_ID}: {tested} pair(s) needed a boolean, "
          f"{len(allowed)} declared, {time.monotonic() - started:.1f}s")
    if problems:
        listed = "\n".join(problems)
        raise BuildError(
            f"view {ASSEMBLED_VIEW_ID!r} has parts occupying the same space:\n"
            f"{listed}\n"
            "Two solids cannot both be there, so one of two things is true: "
            "the parts do not fit and the model says so, or the overlap is the "
            "joint -- a printed thread, a barb, an insert. Say which, by "
            'catalogue key, in the view\'s "interference_ok": [("a", "b", "why '
            'they overlap")]. The reason is required and it is printed in this '
            "log."
        )


def _intersection_volume(first_label, second_label, body_pairs):
    """How much space two leaves really share, in mm3, or None if unanswerable.

    `body_pairs` holds THE BODIES -- `(a body of the first part, a body of the
    second)` -- for every pair of them whose BOXES overlap. An object built with
    `.add()` is several solids and it is as likely to be the second of them
    standing inside the neighbour as the first, so every body is considered and
    the caller has already dropped the pairs that are nowhere near each other.
    The solids arrive rather than indices into two lists this would have to
    resolve for itself, and that is the point: a second walk of a model's own
    object is a second answer nothing promises will match the first, so the
    boxes that chose these pairs and the booleans asked about them are the same
    objects by construction (`_bodies` has the reasoning). The labels come in
    for the warning below and are all this needs of the nodes.

    THE FIRST BOOLEAN THE KERNEL REFUSES ENDS THE PAIR, and the return is None
    rather than a number. Going on with the other body pairs and adding what
    they gave would produce a PARTIAL SUM that understates the overlap while
    reading exactly like a verdict -- and a partial sum landing under
    INTERFERENCE_VOLUME_TOL publishes a build on evidence nobody has. The
    warning printed here is what the pair gets instead, and it is only true
    because nothing is returned: it says the pair went unchecked.

    THOSE TWO DECISIONS ARE WHY THE BOX FILTER HAS TO BE ON THIS SIDE OF THE
    LOOP TOO. A body pair whose boxes are clear cannot overlap, but it can still
    make the kernel fall over -- and one that did would end the part pair and
    take the verdict on a REAL overlap between two OTHER bodies of the same two
    parts with it, quietly, on the strength of geometry nobody was asking about.
    Filtering before the `try` is what keeps "the first refusal buries the pair"
    from being a way to lose a finding.

    ONLY SOLIDS ARE COUNTED. `intersect` on two solids that merely touch
    tangentially can hand back a sliver of a SHELL, and `Volume()` on an open
    shell is not dust -- it is the volume of the closed body OCC completes it
    into, a number of a different kind that can be arbitrarily large. Summing
    `Solids()` asks the question the gate means: how much solid material do
    these two both claim.

    ALL THREE OF THOSE ARE `checklib.pairwise_interference`'s ANSWERS, taken
    deliberately, and the duplication is what is left after them. That function
    is not called here because it has a different contract: it RETURNS problem
    strings named after a model's own labels for `checks()` to collect, and it
    writes every pair it measured into `checklib._INTERFERENCE`, which is where
    the model's metrics.json comes from. This one RAISES BuildError, names
    catalogue keys, and must not put a gate's measurements into the model's own
    record. What the two must agree on is how a boolean is read -- so those two
    decisions are copied and named here rather than diverging quietly.
    """
    total = 0.0
    for left, right in body_pairs:
        try:
            common = left.intersect(right)
            volume = sum(float(solid.Volume()) for solid in common.Solids())
        except Exception as exc:
            # A boolean that falls over says nothing about the model, and a
            # build must not be refused over an OCC failure -- but it must not
            # report "no interference" either, because it did not look. So it
            # is said out loud and no verdict is passed.
            print(
                f"warning: could not test {first_label} against "
                f"{second_label} for interference "
                f"({type(exc).__name__}: {exc}). Their bounding boxes "
                "overlap, so this pair went UNCHECKED."
            )
            return None
        if volume > 0.0:
            total += volume
    return total
