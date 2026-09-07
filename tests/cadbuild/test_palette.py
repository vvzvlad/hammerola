"""The palette, and the bug it exists to prevent.

This is the regression that started the whole extraction: the colour of a part
used to come from its POSITION in `printables()`, so inserting one part at the
top renumbered every part below it and the next publish came back with the
whole model repainted -- for an edit that changed none of them. The fix (colour
from a hash of the key) shipped only in the newest copy of publish.py, so half
the fleet still had colours that moved and half did not.

Every test here is about that: same key, same colour, no matter what happens
around it.
"""

import hashlib
import itertools
import math

import pytest

from src.cadbuild.palette import (
    HARDWARE_COLOR,
    MOCK_COLOR,
    PART_PALETTE,
    _palette_slot,
    palette_colors,
)


def test_slot_is_a_hash_of_the_name_not_a_position():
    assert _palette_slot("body") == (
        int(hashlib.md5(b"body").hexdigest(), 16) % len(PART_PALETTE)
    )


def test_slot_is_stable_across_processes():
    """md5, never hash(): str hashing is salted per process by PYTHONHASHSEED.

    Recomputing the digest here would only restate _palette_slot. The value is
    written out instead, so a change of algorithm has to be a deliberate edit
    to this file -- and every model in the fleet repainting is exactly the kind
    of change that must not slip through as an implementation detail.
    """
    assert _palette_slot("body") == 4
    assert _palette_slot("lid") == 4
    assert _palette_slot("bracket") == 7


def test_colour_does_not_move_when_a_part_is_inserted_before_it():
    before = palette_colors(["body", "lid"])
    after = palette_colors(["adapter", "body", "lid"])
    assert after["body"] == before["body"]
    assert after["lid"] == before["lid"]


def test_colour_does_not_move_when_the_dict_is_reordered():
    assert palette_colors(["body", "lid", "spacer"]) == \
           palette_colors(["spacer", "body", "lid"])


def test_colour_does_not_move_when_a_neighbour_is_renamed():
    before = palette_colors(["body", "lid"])
    after = palette_colors(["body", "cover"])
    assert after["body"] == before["body"]


def test_every_part_gets_a_palette_entry():
    colours = palette_colors(["body", "lid", "spacer"])
    assert set(colours) == {"body", "lid", "spacer"}
    assert all(c in PART_PALETTE for c in colours.values())


def test_no_printable_is_ever_painted_the_mock_colour():
    """Grey means "not printed". A printable that came out grey would be a lie."""
    colours = palette_colors([f"part{i}" for i in range(len(PART_PALETTE))])
    assert MOCK_COLOR not in colours.values()


def test_collisions_are_resolved_within_the_palette():
    keys = [f"part{i}" for i in range(len(PART_PALETTE))]
    colours = palette_colors(keys)
    assert len(set(colours.values())) == len(PART_PALETTE)


def test_the_alphabetically_first_key_keeps_a_contested_slot():
    """Two passes, and this is the visible half of why -- see palette_colors.

    A pair of keys that hash to one slot is resolved by name, so which of the
    two moves does not depend on the order they arrived in.
    """
    contested = _find_colliding_pair()
    if contested is None:
        pytest.skip("no two short keys collide in this palette size")
    first, second = sorted(contested)
    forwards = palette_colors([first, second])
    backwards = palette_colors([second, first])
    assert forwards == backwards
    assert forwards[first] == PART_PALETTE[_palette_slot(first)]
    assert forwards[second] != forwards[first]


def test_past_the_palette_size_colours_repeat_rather_than_fail():
    keys = [f"part{i}" for i in range(len(PART_PALETTE) * 2)]
    colours = palette_colors(keys)
    assert len(colours) == len(keys)
    assert set(colours.values()) <= set(PART_PALETTE)


def test_empty_input_is_an_empty_map():
    assert palette_colors([]) == {}


def test_keys_that_are_not_strings_still_get_a_colour():
    """Catalogue keys are validated elsewhere; this must not be the crash."""
    colours = palette_colors([1, 2])
    assert set(colours) == {1, 2}


# --------------------------------------------------------------------------
# The three kinds, and the one thing the picture promises
# --------------------------------------------------------------------------

def _rgb(color):
    return tuple(int(color[i:i + 2], 16) for i in (1, 3, 5))


def _apart(first, second):
    """Plain RGB distance. Not a perceptual metric, and it does not need to be:
    the question is whether two colours can be confused at a glance, and the
    gap this checks is an order of magnitude wider than any disagreement
    between distance measures."""
    return math.dist(_rgb(first), _rgb(second))


def test_every_colour_this_paints_with_is_a_different_one():
    every = list(PART_PALETTE) + [MOCK_COLOR, HARDWARE_COLOR]
    assert len(set(every)) == len(every)


def test_hardware_is_as_distinct_as_the_palette_is_from_itself():
    """The one colour that had to be INVENTED, checked rather than eyeballed.

    `hardware` is bought and goes into the product; `mock` is only there so the
    picture makes sense. Two greys a reader cannot tell apart would say
    "context" about a part that is in the bill of materials -- and the whole
    value of colouring by kind is that a glance answers the question.

    The floor is computed from the palette rather than written down, so the
    rule keeps meaning the same thing after a repaint: this colour has to sit
    at least as far from every colour the build already uses as the two CLOSEST
    of those sit from each other. Today that floor is about 37 and this colour
    clears it at about 79, so there is room for an edit that reaches for
    another grey to be caught without every repaint tripping the check.
    """
    others = list(PART_PALETTE) + [MOCK_COLOR]
    floor = min(_apart(a, b) for a, b in itertools.combinations(others, 2))
    nearest = min(_apart(HARDWARE_COLOR, other) for other in others)
    assert nearest >= floor


def _find_colliding_pair():
    seen = {}
    for i in range(500):
        key = f"k{i}"
        slot = _palette_slot(key)
        if slot in seen:
            return seen[slot], key
        seen[slot] = key
    return None
