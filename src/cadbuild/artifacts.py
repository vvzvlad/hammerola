#!/usr/bin/env python3
"""What a build writes next to the geometry, and how finely it is meshed."""


# The pictures and the glued-together assembly the build leaves in _out/.
ASSEMBLED_STEM = "assembled"
PREVIEW_SUFFIX = "_preview.png"

# Mesh quality for the STL download and for the watertightness gate.
STL_TOLERANCE = 0.01
STL_ANGULAR_TOLERANCE = 0.1
