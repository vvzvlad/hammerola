#!/usr/bin/env python3
"""The two gates that read a whole view: the print plate, and coverage.

Both run before anything is exported. They read bounding boxes and names only,
and an export meshes the shape in place -- from then on OCCT measures bounding
boxes off the mesh (see geometry.drop_mesh).
"""

from .errors import BuildError
from .geometry import as_shapes
from .matching import _shape_coverage
from .views import ASSEMBLED_VIEW_ID, PRINT_VIEW_ID, names_mention, visible_names


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


def check_print_layout(prepared):
    """The `print` view has to be a plate, not a pile.

    Helpers that orient a part for printing each hand it back standing at the
    origin, and laying the parts out is a separate step that is easy to forget.
    Forget it and the view still renders, still tessellates, still publishes --
    as parts modelled inside one another, which is what anyone opening that tab
    is looking at.

    Bounding boxes, not booleans: parts on a bed need clear air between them,
    and two boxes that overlap is already the answer. Touching -- a gap of zero
    -- passes. Only `print` is checked. In `assembled` the parts are supposed to
    touch; that is the point of it. A one-part print view has nothing to check,
    and a project with no print view is not made to have one.
    """
    for view in prepared:
        if view["id"] != PRINT_VIEW_ID or len(view["objects"]) < 2:
            continue
        allowed = view["nested_ok"]

        # Every body of every object, not the first body of each: an object
        # assembled with .add() is several solids, and the one that ends up
        # standing in a neighbour is as likely to be the second as the first.
        # Bodies of the SAME object are not compared with each other -- they
        # are one part as far as the view is concerned, they carry one label,
        # and so there would be no way to declare such a pair nested_ok.
        entries = []
        for index, obj in enumerate(view["objects"]):
            label = view["names"][index]
            for shape in as_shapes(obj, f"view {view['id']!r} part {label!r}"):
                entries.append((index, label, shape.BoundingBox()))
        labels = [entry[1] for entry in entries]
        boxes = [entry[2] for entry in entries]
        owners = [entry[0] for entry in entries]

        problems = []
        seen_pairs = set()
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                if owners[i] == owners[j]:
                    continue
                if frozenset((labels[i], labels[j])) in allowed:
                    continue
                a, b = boxes[i], boxes[j]
                over = (min(a.xmax, b.xmax) - max(a.xmin, b.xmin),
                        min(a.ymax, b.ymax) - max(a.ymin, b.ymin),
                        min(a.zmax, b.zmax) - max(a.zmin, b.zmin))
                # Boxes intersect only when they overlap on all three axes;
                # a gap on any one of them means the parts are clear.
                if min(over) <= PRINT_OVERLAP_TOL:
                    continue
                # One line per pair of parts, not per pair of bodies: a
                # two-body object standing in a neighbour would otherwise say
                # the same thing twice under the same two names.
                pair = frozenset((owners[i], owners[j]))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                problems.append(
                    f"  - {labels[i]!r} and {labels[j]!r} overlap by "
                    f"X {over[0]:.2f}, Y {over[1]:.2f}, Z {over[2]:.2f} mm"
                )
        if problems:
            listed = "\n".join(problems)
            raise BuildError(
                f"view {view['id']!r} has parts standing inside each other:\n"
                f"{listed}\n"
                "The print view is the bed: every part needs its own patch of "
                "it. Orienting a part for printing leaves it at the origin -- "
                "translate each one clear of the others before putting it in "
                "the view. A pair that really is nested on purpose goes in the "
                "view's \"nested_ok\": [(\"a\", \"b\")]."
            )


def check_printables_shown(prepared, printables):
    """Everything printable has to be visible somewhere.

    A part can be modelled, exported, downloadable and checked, and still be
    missing from every view -- add the fasteners to printables() and to
    checks(), forget views(), and the picture people look at is an assembly
    without them. Nothing else in the run notices: the part is perfectly valid,
    it is just invisible.

    Two ways of being shown count: the view holds the part itself (or a moved
    copy of it -- same volume, same faces, same face areas, and no other solid
    in that view already spoken for), or a part's `name` says the part is
    there. Views may hold more than printables -- a mock of the bought
    hardware, a phantom of the panel the bracket bolts to -- and extras are
    never an error; only missing printables are.

    The shape half of that question is the same code that decides the colour a
    part is drawn in -- one matching, _match_solids, read from here and from
    auto_colors. The name half is NOT: it counts here and nowhere else. A name
    is a claim by the author, good enough to keep a build green when the view
    shows a stand-in, and not good enough to paint a part in a printable's
    colour -- the mock called "lid blank" would come out the colour of the lid
    in a picture whose promise is that everything not printed is grey.

    The name half is a courtesy in the other direction too, and it can be
    abused by accident: an object called "lid mock" answers for the printable
    `lid` under the whole-word match, and if there is no real `lid` in any view
    the coverage check is satisfied by a stand-in. That is not made an error --
    naming a mock after the part it stands in for is normal -- but it is said
    out loud, because the alternative is a build that quietly certifies a part
    nobody can see. The same courtesy is the one hole left in the shape half:
    two mirrored parts both named after their printables still cover each
    other, because the names say they are both there and nothing here reads the
    picture.

    A part at alpha 0 is not drawn, so neither half counts it: not its solid,
    and not its name. It is warned about where it is read (prepare_views), and
    a printable whose only appearance is an invisible one is reported here as
    appearing in no view -- which is what the person looking at the picture
    sees.
    """
    keys = list(printables)
    by_name = {key: False for key in keys}
    by_shape = {key: False for key in keys}
    assembled = None
    assembled_names = []
    assembled_shapes = set()
    cache = {}

    for view in prepared:
        shown = _shape_coverage(view, printables, cache)
        drawn = visible_names(view)
        if view["id"] == ASSEMBLED_VIEW_ID:
            assembled = view
            assembled_names = drawn
            assembled_shapes = shown
        for key in keys:
            if names_mention(drawn, key):
                by_name[key] = True
            if key in shown:
                by_shape[key] = True

    problems = []
    missing = [k for k in keys if not (by_name[k] or by_shape[k])]
    if missing:
        problems.append(
            f"printable(s) {', '.join(repr(k) for k in missing)} appear in no "
            "view at all. Every printable is a part somebody prints, so it has "
            "to be visible before it is printed -- add "
            '{"shape": <the part>, "name": "<its name>"} to a view\'s `parts`.'
        )

    if assembled is not None:
        gone = []
        for key in keys:
            if names_mention(assembled_names, key):
                continue
            if key in assembled_shapes:
                continue
            gone.append(key)
        if gone:
            problems.append(
                f"view {ASSEMBLED_VIEW_ID!r} does not show printable(s) "
                f"{', '.join(repr(k) for k in gone)}. The assembled view is "
                "what the design is judged by, and a part missing from it "
                "reads as a design without that part. Mock-ups of bought "
                "hardware alongside are fine -- printables are what must be "
                "there."
            )

    if problems:
        raise BuildError("\n".join(problems))

    for key in keys:
        if by_name[key] and not by_shape[key]:
            print(
                f"warning: printable {key!r} is only matched by name in the "
                f"views -- no object in any view is that solid. If the thing "
                f"named after it is a mock, the real {key!r} is in no picture. "
                f"The match is on whole words, so any name with {key!r} in it "
                f"counts -- {key + ' mock'!r} and {key + ' blank'!r} alike. "
                "Name the mock without the printable's word at all "
                "(\"blank\", \"bought part\") and this check can tell them "
                "apart. Note the colour cannot: a mock is grey whatever it is "
                "called, because the palette goes by shape only."
            )
