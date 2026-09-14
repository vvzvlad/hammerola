#!/usr/bin/env python3
"""What a build writes next to the geometry, and how finely it is meshed."""


# The pictures and the glued-together assembly the build leaves in _out/.
ASSEMBLED_STEM = "assembled"
PREVIEW_SUFFIX = "_preview.png"

# The SECOND picture of a whole view, and the front page is the whole of why it
# exists: a project card fits the picture it is given rather than cropping it,
# so a sheet with a title band above it and a footer under it would be shown
# bands and all, shrunk to fit them in. This one is the bare rendered tile --
# the part and nothing else -- written beside the sheet under the same stem.
# Only the whole-view stems get one, because a card never shows a single part.
CARD_SUFFIX = "_card.png"

# The two view ids the build knows the meaning of. Everything else a model
# writes is just a tab: `print` is a bed and its parts may not overlap or be
# anything but printable, `assembled` is the whole product -- every printable
# has to be in it, and it is the only view interference is gated in.
#
# THEY LIVE HERE RATHER THAN IN views.py, and the move is structural rather
# than cosmetic. `parts.py` has to reserve the two stems these name
# (`assembled.stl`, `print.stl`) against the catalogue's keys, and `views.py`
# resolves a view's references INTO that catalogue -- so views imports parts,
# and parts may not import views back. This module is what both may see: it
# already owns `ASSEMBLED_STEM`, which is the same string as ASSEMBLED_VIEW_ID
# for the same reason (`assembled.json` and `assembled.stl` are one view's two
# artefacts). The two names are kept apart deliberately: one is a view id, the
# other a file stem, and a rename of either must not silently move the other.
PRINT_VIEW_ID = "print"
ASSEMBLED_VIEW_ID = "assembled"

# Mesh quality for the STL download and for the watertightness gate.
STL_TOLERANCE = 0.01
STL_ANGULAR_TOLERANCE = 0.1
