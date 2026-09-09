#!/usr/bin/env python3
"""Colours parts are drawn in, and the rule that keeps them still.

Which entry a printable gets is decided by its KEY in the catalogue, not by its
position in it and never by its position in a view. So the same part is the
same colour in every view, and it stays that colour across builds while the
catalogue around it is edited.
"""

import hashlib


# Colours for parts that do not name one, and the rule is not decoration. A
# catalogue entry of kind `printable` gets one of these; a `mock` -- of a
# bought motor, of the wall the bracket bolts to, of a barrel the frame stands
# in -- is drawn in MOCK_COLOR, and a `hardware` entry in HARDWARE_COLOR. So a
# glance at the picture says what is going on the bed, what is bought and what
# is only there for context.
#
# Which entry a printable gets is decided by its KEY, not by its position in
# the catalogue and never by its position in a view -- see palette_colors. So
# the same part is the same colour in `assembled` and in `print`, and it stays
# that colour across builds while the catalogue around it is edited.
PART_PALETTE = (
    "#4682b4",  # steel blue
    "#c85a3c",  # terracotta
    "#5b8c5a",  # moss
    "#9a6fb0",  # violet
    "#c9a227",  # brass
    "#4f9d9d",  # teal
    "#b0567c",  # plum
    "#7f8c4a",  # olive
)
# Not printed and not bought: light, grey and unsaturated enough that no
# palette entry reads as "the same sort of thing".
MOCK_COLOR = "#8a8d91"
# Bought, and going into the product rather than standing beside it for scale:
# a screw, a bearing, a heat-set insert. A DARK metallic grey, and the distance
# from MOCK_COLOR is the whole point of the value -- two greys a reader cannot
# tell apart would say "context" about a part that is in the bill of materials.
#
# The number is checkable rather than a matter of taste, and
# tests/cadbuild/test_palette.py is where it is checked: this colour has to sit
# at least as far (in plain RGB distance) from every colour above as the two
# CLOSEST of those sit from each other. That floor is 36.6 today and this value
# clears it at 78.7 -- more than twice over -- so the check has room to catch a
# future edit that reaches for another grey without being so tight that any
# repaint of the palette trips it.
HARDWARE_COLOR = "#3f444b"

# Opaque unless the part says otherwise. The default is 1.0 and not something
# slightly under it for the reason NEARLY_OPAQUE_MIN exists.
DEFAULT_ALPHA = 1.0
# Where "looks opaque, behaves transparent" starts. Everything from here up to
# but not including 1.0 is warned about rather than refused: it is a defect of
# the picture, not of the part, and a part that prints correctly must not fail
# a build over how it is drawn.
#
# What happens at 0.9: the viewer switches the material to blend mode and turns
# depth writing off, so the part no longer occupies the depth buffer. three.js
# then sorts transparent objects by the distance from the camera to their
# centres -- and on two large flat parts whose centres nearly coincide, that
# order flips as the model is turned. The front wall of the box appears and
# disappears depending on the angle, for a transparency nobody can see anyway.
#
# The band is open at the top and has no second constant. It used to stop at
# 0.99, which left 0.995 and 0.999 unwarned -- the very worst of the range, all
# of the flicker and none of the visible transparency. Anything under 1.0 is
# drawn blended; only exactly 1.0 is opaque.
NEARLY_OPAQUE_MIN = 0.85
# A part at alpha 0 is not drawn at all. Legal, warned about, and not counted
# as showing anything -- the warning is in `views.prepare_views`, and what
# refuses to count it is `gate.check_assembled_coverage`.
INVISIBLE_ALPHA = 0.0


def _palette_slot(key):
    """The palette entry a catalogue key asks for, before any collision."""
    # md5 and not hash(): str hashing is salted per process by PYTHONHASHSEED,
    # so hash() would repaint the whole model between two runs on the same
    # machine -- the very thing this is here to stop.
    digest = hashlib.md5(str(key).encode("utf-8")).hexdigest()
    return int(digest, 16) % len(PART_PALETTE)


def palette_colors(keys):
    """A palette entry per printable key, chosen by the key and not by its place.

    The old rule was the position in the catalogue, and a position is not a
    property of the part. Inserting one part at the top of that dict renumbered
    everything below it, so the next publish came back with every part in a
    different colour in every view -- for an edit that changed none of them.
    The value of an automatic colour is that it is the same one as last week;
    a colour that moves is worth less than no colour at all.

    So the slot comes from the key's own name (_palette_slot). Reordering the
    catalogue, or renaming anything else in it, cannot move a part's colour.

    Two keys can hash to one slot, and two parts drawn in the same colour is
    the defect this palette exists to avoid, so collisions are resolved -- in
    two passes, and the second pass is why:

      * everything that asked for a free slot gets it, and where several keys
        asked for the same one the alphabetically first keeps it;
      * only the keys that lost then walk forward to a slot nobody asked for.

    A single pass with the same probing looked simpler and quietly reintroduced
    the original defect in a smaller form: a bumped key would land on the slot
    of a key not yet placed, bump that one in turn, and adding one printable
    could repaint three. With the natural slots settled first, adding a
    printable to a four-part model moves nothing at all in most cases, and at
    worst the key it collides with plus one already-bumped key whose slot it
    took. Measured over twelve insertions: six colours moved out of
    forty-eight, where the positional index moved all forty-eight.

    Past len(PART_PALETTE) printables there is nothing left to move to and the
    colours repeat -- this is a reading aid, not an identity.
    """
    keys = list(keys)
    size = len(PART_PALETTE)

    asked = {}
    for key in keys:
        asked.setdefault(_palette_slot(key), []).append(key)

    slots, taken, bumped = {}, set(), []
    for slot in sorted(asked):
        winner, *losers = sorted(asked[slot], key=str)
        slots[winner] = slot
        taken.add(slot)
        bumped.extend(losers)

    for key in sorted(bumped, key=str):
        start = _palette_slot(key)
        slot = start
        for step in range(1, size + 1):
            candidate = (start + step) % size
            if candidate not in taken:
                slot = candidate
                break
        slots[key] = slot
        taken.add(slot)

    return {key: PART_PALETTE[slots[key]] for key in keys}
