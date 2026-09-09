#!/usr/bin/env python3
"""`import checklib` -- the name nine model.py files are already written to.

The checks themselves live in `src/cadbuild/checklib.py`; this is the top-level
name they are reachable under. It exists for exactly one reason: every project
in the fleet has `import checklib` at the top of its model.py, next to
`import mocks`, and that line is a contract with nine repositories the same way
`parts()` and `views()` are.

WHY IT SITS AT THE REPOSITORY ROOT rather than inside the package. A model is
imported with its own directory first on sys.path (geometry.load_model), and
`import checklib` then has to resolve to something on the path AFTER it. In
`cad_publish` that was site-packages, because the distribution installed this
file as a top-level module of its own. Here it is /app -- the working directory
of the image, the directory `main.py` is started from, and the one pytest.ini
puts on the path -- so the same file at the root reproduces the same lookup
with nothing to install. The ordering is load-bearing in both directions: a
project may still shadow this with a checklib.py of its own, and
geometry._warn_if_checklib_shadowed exists to say so out loud when it does.

WHY THE IMPLEMENTATION IS FOUND BY PATH AND NOT BY THE NAME `src`. This file
used to say `from src.cadbuild.checklib import ...`, and that put the whole
shim behind the most shadowable name in the process. The project root goes on
sys.path FIRST, deliberately, and `src/` is about the likeliest directory name
a model project has -- at which point `import src.cadbuild.checklib` finds the
model's own `src` and raises `ModuleNotFoundError: No module named
'src.cadbuild'`, from a line that has nothing to do with the model. In
`cad_publish` the name behind the shim was the distribution's own top-level
`cad_publish`, which a project could not shadow by accident; naming `src` here
gave that property away. `spec_from_file_location` off this file's `__file__`
takes it back: the answer is a location on disk and the name `src` never
participates. Nothing in the current process reaches that failure -- by the
time a model runs, `src.cadbuild.checklib` is already in sys.modules and the
statement short-circuits -- but step 4 of SPEC 8A.2 gives the build a spawned
process of its own, whose entry point may reach the model before it reaches
this package, and there the old spelling breaks.

WHAT MUST NOT CHANGE, whichever way the implementation is reached: `checklib`
and `src.cadbuild.checklib` have to be ONE module. `pairwise_interference`
RECORDS the volumes it measured in module-level state, and
`cadbuild.metrics.collect_metrics` reads that record back out of the package
half. Two module objects means two records: the model fills one, metrics.json
reads the other, and the interference numbers come out empty on a build that
measured them, with nothing going red. Hence the sys.modules registration under
the canonical name below, and the test that holds it down
(tests/cadbuild/test_checklib.py).

Written as explicit re-exports and not `from ... import *`: a star import would
also drag in `_INTERFERENCE` and whatever private helper gets added next, and
would make `checklib.recorded_interference()` and
`src.cadbuild.checklib.recorded_interference()` two names for state that must
be one. They are the same objects here -- the functions are rebound, not
copied.
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

# One import form to avoid elsewhere in this repository. When this shim has run
# first, `sys.modules` carries "src.cadbuild.checklib" without its parents, so the
# dotted statement `import src.cadbuild.checklib` fails with "cannot import name
# 'cadbuild' from 'src'" — that form walks attributes on the parent package, which
# nothing has created yet. `from src.cadbuild import checklib` and
# `importlib.import_module(...)` both work, and both are what the code here uses.
# Worth knowing at steps 4 and 6, where a separate process starts importing the
# package from a new entry point.
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
