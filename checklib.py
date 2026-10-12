#!/usr/bin/env python3
"""`import checklib` -- the top-level name every model.py imports.

The checks live in `src/cadbuild/checklib.py`; this shim re-exports them. It sits
at the repository root (/app in the image) because a model is imported with its
own directory first on sys.path (geometry.load_model), so `import checklib` must
resolve on the path behind it. A project may still shadow it with its own
checklib.py; geometry._warn_if_checklib_shadowed reports that.

The implementation is loaded by file path, not as `src.cadbuild.checklib`,
because a model project's own `src/` directory would shadow that name.

`checklib` and `src.cadbuild.checklib` must be ONE module: `pairwise_interference`
records measured volumes in module-level state that
`cadbuild.metrics.collect_metrics` reads back, and two module objects would leave
the interference numbers silently empty. Hence the sys.modules registration under
the canonical name (tests/cadbuild/test_checklib.py). Explicit re-exports rather
than a star import keep private state such as `_INTERFERENCE` out; the functions
are rebound, not copied.
"""

import importlib.util
import os
import sys

# The canonical name of the implementation. Used to REGISTER it, never to look
# it up on the path -- see the docstring.
_CANONICAL_NAME = "src.cadbuild.checklib"

# The implementation, addressed as a file. Derived from this file's own
# location, so the pair moves together: in the image that is
# /app/checklib.py -> /app/src/cadbuild/checklib.py (`COPY checklib.py .` and
# `COPY src/ src/` in the Dockerfile), and in a checkout it is the same two
# paths relative to the repository root.
_IMPLEMENTATION = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "src", "cadbuild", "checklib.py")


def _already_loaded():
    """The implementation if some earlier import already loaded it, else None.

    Identified by the FILE it was loaded from and not by the fact that
    something is sitting under the canonical name -- the whole point of this
    module is that the name can belong to somebody else. `realpath` on both
    sides so a symlinked /app, or a checkout reached through one, still
    recognises its own module instead of loading a second copy of it.
    """
    module = sys.modules.get(_CANONICAL_NAME)
    origin = getattr(module, "__file__", None)
    if origin is None:
        return None
    if os.path.realpath(origin) != os.path.realpath(_IMPLEMENTATION):
        return None
    return module


def _implementation():
    """`src/cadbuild/checklib.py`, loaded once per process and shared.

    Registered under `src.cadbuild.checklib` before it is executed. Before,
    because an import of that name arriving while this one is still running has
    to find this module rather than start a second one; under that name,
    because `from . import checklib` inside the package half must end up on the
    SAME object -- it finds it in sys.modules without importing `src` at all.
    """
    module = _already_loaded()
    if module is not None:
        return module

    spec = importlib.util.spec_from_file_location(_CANONICAL_NAME, _IMPLEMENTATION)
    if spec is None or spec.loader is None:
        raise ImportError(
            f"checklib: its implementation is not at {_IMPLEMENTATION}. That file "
            f"is copied into the image beside this one; a build that lost it is "
            f"the likeliest cause.")
    module = importlib.util.module_from_spec(spec)
    displaced = sys.modules.get(_CANONICAL_NAME)
    sys.modules[_CANONICAL_NAME] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        # Put back exactly what was there. A half-executed module left under
        # the canonical name would be found by the next importer and used.
        if displaced is None:
            sys.modules.pop(_CANONICAL_NAME, None)
        else:
            sys.modules[_CANONICAL_NAME] = displaced
        raise

    # If the package half is already imported, hang the module off it too, so
    # `src.cadbuild.checklib` is reachable as an attribute the way a normally
    # imported submodule would be. When it is NOT yet imported there is nothing
    # to hang it on and nothing to do: a later `from src.cadbuild import
    # checklib` finds the sys.modules entry above.
    parent = sys.modules.get("src.cadbuild")
    if parent is not None:
        setattr(parent, "checklib", module)
    return module


_impl = _implementation()

DEFAULT_VOLUME_TOL = _impl.DEFAULT_VOLUME_TOL
DERIVED = _impl.DERIVED
ESTIMATED = _impl.ESTIMATED
EXTRUSION_LINES = _impl.EXTRUSION_LINES
KINDS = _impl.KINDS
MAX_NOTE_CHARS = _impl.MAX_NOTE_CHARS
MEASURED = _impl.MEASURED
NORMAL_TOL = _impl.NORMAL_TOL
NOZZLE_MM = _impl.NOZZLE_MM
Number = _impl.Number
PLANE_TOL = _impl.PLANE_TOL
check = _impl.check
derived = _impl.derived
deviation = _impl.deviation
estimated = _impl.estimated
is_empty = _impl.is_empty
measured = _impl.measured
material_at = _impl.material_at
mating_face_flat = _impl.mating_face_flat
material_under_head = _impl.material_under_head
minimum_feature = _impl.minimum_feature
name_pairs = _impl.name_pairs
pairwise_interference = _impl.pairwise_interference
recorded_clearance = _impl.recorded_clearance
recorded_interference = _impl.recorded_interference
recorded_sections = _impl.recorded_sections
registered_units = _impl.registered_units
section = _impl.section
swept_clearance = _impl.swept_clearance
thin_walls = _impl.thin_walls
tool_access = _impl.tool_access
unsupported_area = _impl.unsupported_area
volume = _impl.volume

# Avoid `import src.cadbuild.checklib` elsewhere: once this shim has run,
# sys.modules holds that name without its parent packages, and the dotted form
# fails with "cannot import name 'cadbuild' from 'src'". Use
# `from src.cadbuild import checklib` or `importlib.import_module(...)`.
__all__ = [
    "DEFAULT_VOLUME_TOL",
    "DERIVED",
    "ESTIMATED",
    "EXTRUSION_LINES",
    "KINDS",
    "MAX_NOTE_CHARS",
    "MEASURED",
    "NORMAL_TOL",
    "NOZZLE_MM",
    "Number",
    "PLANE_TOL",
    "check",
    "derived",
    "deviation",
    "estimated",
    "is_empty",
    "material_at",
    "measured",
    "mating_face_flat",
    "material_under_head",
    "minimum_feature",
    "name_pairs",
    "pairwise_interference",
    "recorded_clearance",
    "recorded_interference",
    "recorded_sections",
    "registered_units",
    "section",
    "swept_clearance",
    "thin_walls",
    "tool_access",
    "unsupported_area",
    "volume",
]
