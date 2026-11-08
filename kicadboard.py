#!/usr/bin/env python3
"""`import kicadboard` -- the top-level name a model.py imports to place a KiCad board.

The code lives in `src/cadbuild/kicadboard.py`; this shim re-exports it, by the
same mechanics as checklib.py beside it, whose docstring says why: it sits at
the repository root (/app in the image) because a model is imported with its own
directory first on sys.path, and the implementation is loaded by file path and
registered under its canonical name because a project's own `src/` would shadow
that name.
"""

import importlib.util
import os
import sys

# The canonical name of the implementation. Used to REGISTER it, never to look
# it up on the path.
_CANONICAL_NAME = "src.cadbuild.kicadboard"

# /app/kicadboard.py -> /app/src/cadbuild/kicadboard.py (`COPY kicadboard.py .`
# and `COPY src/ src/` in the Dockerfile); the same two paths in a checkout.
_IMPLEMENTATION = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "src", "cadbuild", "kicadboard.py")


def _already_loaded():
    """The implementation if an earlier import loaded it from this file, else None."""
    module = sys.modules.get(_CANONICAL_NAME)
    origin = getattr(module, "__file__", None)
    if origin is None:
        return None
    if os.path.realpath(origin) != os.path.realpath(_IMPLEMENTATION):
        return None
    return module


def _implementation():
    """`src/cadbuild/kicadboard.py`, loaded once per process and shared,
    registered under its canonical name before it is executed."""
    module = _already_loaded()
    if module is not None:
        return module

    spec = importlib.util.spec_from_file_location(_CANONICAL_NAME, _IMPLEMENTATION)
    if spec is None or spec.loader is None:
        raise ImportError(
            f"kicadboard: its implementation is not at {_IMPLEMENTATION}. That "
            f"file is copied into the image beside this one; a build that lost "
            f"it is the likeliest cause.")
    module = importlib.util.module_from_spec(spec)
    displaced = sys.modules.get(_CANONICAL_NAME)
    sys.modules[_CANONICAL_NAME] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        # Put back exactly what was there: a half-executed module left under
        # the canonical name would be found by the next importer and used.
        if displaced is None:
            sys.modules.pop(_CANONICAL_NAME, None)
        else:
            sys.modules[_CANONICAL_NAME] = displaced
        raise

    parent = sys.modules.get("src.cadbuild")
    if parent is not None:
        setattr(parent, "kicadboard", module)
    return module


_impl = _implementation()

Board = _impl.Board
Footprint = _impl.Footprint
Pad = _impl.Pad
load = _impl.load

__all__ = [
    "Board",
    "Footprint",
    "Pad",
    "load",
]
