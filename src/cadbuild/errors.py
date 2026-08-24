#!/usr/bin/env python3
"""The one exception a run is allowed to end on."""


class BuildError(Exception):
    """Anything that must stop the run with a readable message."""
