#!/usr/bin/env python3
"""What a build writes next to the geometry, and how finely it is meshed."""


# The pictures and the glued-together assembly the build leaves in _out/.
ASSEMBLED_STEM = "assembled"
PREVIEW_SUFFIX = "_preview.png"

# The second picture of a whole view, for the project card: a card fits the
# picture rather than cropping it, so the sheet's title band and footer would
# be shown too. This is the bare rendered tile, written beside the sheet under
# the same stem; only whole-view stems get one.
CARD_SUFFIX = "_card.png"

# The two view ids the build knows the meaning of; every other view is just a
# tab. `print` is a bed: its parts may not overlap and must be printable.
# `assembled` is the whole product: every printable must be in it unless the
# view declares it absent (`absent_ok`, an assembly jig), and it is the only
# view interference is gated in.
#
# Here rather than in views.py: `parts.py` reserves the stems these name
# (`assembled.stl`, `print.stl`) against catalogue keys, and views imports
# parts, so parts cannot import views. ASSEMBLED_VIEW_ID equals
# ASSEMBLED_STEM but is kept separate: one is a view id, the other a file stem.
PRINT_VIEW_ID = "print"
ASSEMBLED_VIEW_ID = "assembled"

# The `print` view is split into beds by `"plate": N` on a reference, and the
# bed a reference names nothing about is this one. Each bed is a 3MF of its own
# (`assembly.export_plate_3mfs`), because a slicer reads no beds out of a 3MF
# it did not write: bed 1 is `print.3mf`, bed N `print-N.3mf`.
FIRST_PLATE = 1


def plate_file(number):
    """The 3MF a bed of the `print` view is written to."""
    if number == FIRST_PLATE:
        return f"{PRINT_VIEW_ID}.3mf"
    return f"{PRINT_VIEW_ID}-{number}.3mf"

# Mesh quality for the STL download and for the watertightness gate.
STL_TOLERANCE = 0.01
STL_ANGULAR_TOLERANCE = 0.1
