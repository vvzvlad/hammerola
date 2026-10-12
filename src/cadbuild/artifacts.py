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
# `assembled` is the whole product: every printable must be in it, and it is
# the only view interference is gated in.
#
# Here rather than in views.py: `parts.py` reserves the stems these name
# (`assembled.stl`, `print.stl`) against catalogue keys, and views imports
# parts, so parts cannot import views. ASSEMBLED_VIEW_ID equals
# ASSEMBLED_STEM but is kept separate: one is a view id, the other a file stem.
PRINT_VIEW_ID = "print"
ASSEMBLED_VIEW_ID = "assembled"

# Mesh quality for the STL download and for the watertightness gate.
STL_TOLERANCE = 0.01
STL_ANGULAR_TOLERANCE = 0.1
