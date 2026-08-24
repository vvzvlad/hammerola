#!/usr/bin/env python3
"""Which object in a view is which printable -- and the colour that follows.

Rigid-transform invariant on purpose: the `print` view holds the same lid,
rotated and moved, and it is still the lid. One implementation, used both by
the coverage gate and by the automatic colours, so the picture and the gate
cannot disagree about what is in the view.
"""

from .geometry import as_shapes
from .palette import DEFAULT_ALPHA, INVISIBLE_ALPHA, MOCK_COLOR, palette_colors


# Relative tolerance for every number two parts have to agree on to count as
# the same part: volume, total face area, and the areas of the largest faces.
# Rigid-transform invariant on purpose: the `print` view holds the same lid,
# rotated and moved, and it is still the lid.
SAME_PART_VOLUME_TOL = 1e-6
# How many of the biggest faces go into the fingerprint, largest first. Enough
# that moving a hole shows up; few enough that it stays a cheap tuple compare.
LARGEST_FACES = 8


def auto_colors(objects, printables, cache, alphas=None):
    """A colour for every view object: the palette for printables, grey for the rest.

    "Which printable is this object?" is not answered again here. It is the
    same matching check_printables_shown is gated on -- literally the same
    call, _match_solids -- so the picture and the gate cannot disagree about
    what is in the view. That claim used to be made in this docstring while the
    code did something else: a greedy walk over the keys that tested the
    fingerprint before the identity and the name of the keys after it. On a
    mirrored pair `{"left": A, "right": B}` -- indistinguishable by
    fingerprint, which is exactly why the matching exists -- the object that IS
    `printables["right"]` was painted as `left`, and both halves of the pair
    came out the same colour.

    The name is deliberately NOT part of this. It still counts for coverage,
    where it is a courtesy to a view that shows a stand-in, but a courtesy is
    the wrong thing to paint with: a mock called "lid blank" mentions `lid`
    under the whole-word match and came out in the lid's colour, in a picture
    whose whole promise is that everything not printed is grey. Grey now means
    what it says -- if it is not the printable's own solid, moved and turned as
    much as you like, it is scenery.

    An object built out of two printables with `.add()` is one drawable thing
    with one colour, and it takes the colour of whichever of them sorts first
    by key.
    """
    solids, taken = _match_solids(objects, printables, cache, alphas)
    palette = palette_colors(printables)

    matched = {}
    for index, key in sorted(taken.items(), key=lambda item: str(item[1])):
        matched.setdefault(id(solids[index][0]), key)
    return [palette[matched[id(obj)]] if id(obj) in matched else MOCK_COLOR
            for obj in objects]


def _shape_fingerprint(shape):
    """Numbers that identify one solid and survive being moved and turned.

    Volume and face count alone were too coarse, and coarse in a way that hit
    the exact case this check exists for. They do not change when a hole moves
    to the other end of a plate, so a bracket and the same bracket with the
    hole somewhere else are one part as far as the gate is concerned -- and
    when a project holds both, each one answers for the other and neither is
    ever missed.

    So the areas of the faces come too: their sum, and the largest few of them
    in order. Moving a hole changes which faces it cuts and by how much, so the
    areas move even when the volume and the count do not. Everything here is
    invariant under a rigid motion, exactly like the two numbers before it -- a
    part turned over for printing still matches itself.

    NOT invariant under a mirror, because nothing cheap is: a left bracket and
    its right-hand twin have the same volume, the same faces and the same
    areas, and telling them apart needs a signed quantity that is unstable on
    any symmetric part. What separates those is that a solid may answer for
    only one printable -- see _match_solids.
    """
    volume = float(shape.Volume())
    areas = sorted((float(f.Area()) for f in shape.Faces()), reverse=True)
    return (volume, len(areas), sum(areas), tuple(areas[:LARGEST_FACES]))


def _fingerprints(obj, cache):
    """One fingerprint per body of a view object, or None if it cannot be read.

    Per body, because `Workplane.val()` is the first body only: a printable
    that happens to sit second on the stack of a view object was invisible to
    this check, and the build then said a part shown in the picture appears in
    no view at all.
    """
    key = id(obj)
    if key not in cache:
        try:
            cache[key] = [_shape_fingerprint(shape)
                          for shape in as_shapes(obj, "view object")]
        except Exception:
            cache[key] = None
    return cache[key]


def _close(left, right, tol=SAME_PART_VOLUME_TOL):
    """Two measurements of the same thing, up to a relative tolerance."""
    return abs(left - right) <= tol * max(1.0, abs(left), abs(right))


def _same_solid(left, right):
    """Do two fingerprints describe the same solid?"""
    if left[1] != right[1] or len(left[3]) != len(right[3]):
        return False
    if not _close(left[0], right[0]) or not _close(left[2], right[2]):
        return False
    return all(_close(a, b) for a, b in zip(left[3], right[3]))


def _match_solids(objects, printables, cache, alphas=None):
    """Match the bodies drawn in a view to printables, one solid answering for one.

    The one place in this file that answers "which printable is this object?".
    The coverage gate reads it through _shape_coverage and the palette reads it
    through auto_colors, so the picture and the gate cannot come to different
    conclusions about the same view -- they used to, because the palette had a
    second, greedier implementation of the same idea.

    The counting is the point. Volume, faces and areas cannot tell a left
    bracket from its mirrored twin, and nothing cheap can -- so two printables
    that are each other's mirror image match the same solid, and a view holding
    only one of them used to cover both. Each of them certified the other and
    the part missing from the picture was never reported: a hole in exactly the
    check that was written to find it. The same happened, for the same reason,
    with two genuinely identical parts filed under different keys.

    A solid is one part, so it may answer for one printable. With that rule a
    view showing one bracket covers one bracket, whichever of the two it is
    matched to, and the other is reported missing. A view holding both covers
    both. A view holding four identical legs covers all four `leg*` keys.

    Which printable gets which solid is not always free -- one solid may fit
    several keys -- so this is a bipartite matching (Kuhn's algorithm) and not
    a greedy pass: greedy can spend the only solid a strict key could have used
    on a loose one and report a part missing that is right there. The graph is
    a handful of parts against a handful of solids.

    IDENTITY IS TRIED FIRST, and that ordering is load-bearing now that the
    palette reads the result. A matching is free to hand either half of a
    mirrored pair to either key -- the coverage answer is the same both ways --
    but the colours are not: the object that IS `printables["right"]` being
    painted as `left` is simply wrong on the picture. Listing each key's
    identity hit ahead of its look-alikes costs nothing, changes no coverage
    answer (Kuhn's cardinality does not depend on the order), and makes the
    obvious assignment the one that comes out.

    Bodies are counted individually, so an object built with `.add()` out of
    two printables covers both of them. A part at alpha 0 is not drawn, so it
    is left out entirely and answers for nothing.

    Returns (solids, taken): `solids[i]` is `(view object, fingerprint or
    None)` and `taken` maps a solid's index to the printable key it answers
    for.
    """
    keys = list(printables)
    if alphas is None:
        alphas = [DEFAULT_ALPHA] * len(objects)
    # One entry per BODY, not per view object: an object assembled with .add()
    # out of two printables has to be able to answer for both of them.
    solids = []          # (owning view object, that body's fingerprint or None)
    for obj, alpha in zip(objects, alphas):
        if alpha <= INVISIBLE_ALPHA:
            # Invisible, so it shows nothing. Letting it match meant a build
            # could certify "this printable is visible" about a part that is
            # not drawn at all.
            continue
        prints = _fingerprints(obj, cache)
        if not prints:
            solids.append((obj, None))
            continue
        for print_ in prints:
            solids.append((obj, print_))

    # candidates[key] = indices of the solids that could be this printable,
    # the ones that ARE it first (see the docstring).
    candidates = {}
    for key in keys:
        wanted = _fingerprints(printables[key], cache)
        same, alike = [], []
        for index, (obj, print_) in enumerate(solids):
            if obj is printables[key]:
                same.append(index)
            elif print_ is not None and wanted is not None and any(
                    _same_solid(print_, other) for other in wanted):
                alike.append(index)
        candidates[key] = same + alike

    taken = {}           # solid index -> the key holding it

    def assign(key, visited):
        for index in candidates[key]:
            if index in visited:
                continue
            visited.add(index)
            if index not in taken or assign(taken[index], visited):
                taken[index] = key
                return True
        return False

    for key in keys:
        assign(key, set())
    return solids, taken


def _shape_coverage(view, printables, cache):
    """Which printables this view really shows. See _match_solids."""
    _solids, taken = _match_solids(view["objects"], printables, cache,
                                   view.get("alphas"))
    return set(taken.values())
