#!/usr/bin/env python3
"""Reading the model's geometry: what a Workplane hands back, and what to do
with the triangulation an export leaves behind."""

import sys

from .errors import BuildError
from .paths import project_root


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------

def load_model():
    """Import the project's model.py. The contract is views() and printables().

    The project root goes on sys.path here rather than at import time, and it
    goes on FIRST. First, because `import mocks` in a model.py has to find the
    project's own mocks.py and nothing else called mocks that happens to be
    installed. Here, because this package is installed once per machine while
    the project is whichever one the run is in -- and a path pinned at import
    would be the wrong project's the moment anything imported this module
    before the root was known.
    """
    root_path = project_root()
    root = str(root_path)
    if root in sys.path:
        sys.path.remove(root)
    sys.path.insert(0, root)

    try:
        import model
    except Exception as exc:
        raise BuildError(
            f"importing model.py failed: {exc}"
            f"{_shadowed_src_hint(root_path, exc)}") from exc
    for name in ("views", "printables"):
        if not callable(getattr(model, name, None)):
            raise BuildError(f"model.py does not define {name}()")
    _warn_if_checklib_shadowed()
    # checks() is the optional third of the contract -- run_checks() below
    # deals with a model that has none.
    return model


def _shadowed_src_hint(root, exc):
    """Name the cause when the project's own `src/` is what broke the import.

    The other half of _warn_if_checklib_shadowed below, for the case where the
    import did not survive at all. The root goes on sys.path FIRST, on purpose,
    so a project that carries a directory called `src` -- about the most
    ordinary name a repository has -- owns the name `src` for the rest of the
    process, and any `import src....` made after that point resolves into the
    model project rather than into the hub. Raised through a model.py, the
    message is `No module named 'src.cadbuild'` and it reads as if the MODEL
    asked for something that does not exist: the search starts in the model,
    which is the one place the cause is not.

    `import checklib` is deliberately immune to this -- checklib.py at the
    repository root resolves its implementation by file path and never mentions
    the name `src`, precisely so a model project may keep a `src/` of its own.
    So this hint fires on a build where that immunity is gone: the shim
    reverted to importing by name, or a project's own checklib.py reaching for
    `src.` directly. Appended to the real error rather than replacing it, and a
    hint rather than a refusal -- a project is entitled to a `src/`, and this
    function's only job is to point at it.
    """
    if not isinstance(exc, ImportError):
        return ""
    blamed = getattr(exc, "name", None) or ""
    if not (blamed == "src" or blamed.startswith("src.")
            or "'src" in str(exc) or "checklib" in str(exc)):
        return ""
    if not ((root / "src").is_dir() or (root / "src.py").is_file()):
        return ""
    return (
        " -- and the project root carries a `src` of its own, which goes on "
        "sys.path FIRST (see load_model) and therefore owns that name for the "
        "rest of this process. Every `import src....` made after the model is "
        "loaded resolves into the project, not into the hub. `import checklib` "
        "does not go through the name `src` at all (checklib.py resolves its "
        "implementation by file path), so if that is the import that failed, "
        "the shim has been changed back to importing it by name."
    )


def _warn_if_checklib_shadowed():
    """Say so when the model's `import checklib` found the project's own copy.

    A project that still carries checklib.py at its root shadows the one this
    package installs -- the project root goes on sys.path first, deliberately,
    so a project can override anything it needs to. For checklib that override
    is silent and lossy in one specific way: pairwise_interference RECORDS the
    volumes it measured, and metrics.json reads that record back out of the
    package's copy. Two copies means the model fills one and the build reads
    the other, so the interference numbers come out empty on a build that
    measured them. Nothing goes red; the numbers are just gone.

    A warning and not an error: the project's copy is the older one, but it
    works, and a build must not fail over a half-finished migration. Deleting
    checklib.py from the project is the whole of the fix.
    """
    import sys

    shadow = sys.modules.get("checklib")
    if shadow is None:
        return
    from . import checklib as ours

    if getattr(shadow, "recorded_interference", None) is ours.recorded_interference:
        return
    print(
        f"warning: model.py imported checklib from {getattr(shadow, '__file__', '?')}, "
        "not the one in cadbuild. The project's own copy shadows it, and "
        "the interference volumes checklib records will not reach "
        "metrics.json -- the build measures them and writes none. Delete "
        "checklib.py from the project root; `import checklib` keeps working."
    )


def as_shape(obj, where):
    """Accept a Workplane or a bare Shape, return something with isValid().

    THE FIRST body only. Use it where one body is all there can be, and
    as_shapes() everywhere completeness matters -- see there.
    """
    shape = obj.val() if hasattr(obj, "val") else obj
    if not hasattr(shape, "isValid"):
        raise BuildError(f"{where}: expected a CadQuery object, got {type(obj).__name__}")
    return shape


def as_shapes(obj, where):
    """Every body in a Workplane, not just the first. Always a non-empty list.

    `Workplane.val()` hands back the first object on the stack, so a view built
    up with `.add()` used to be judged on its first body alone: the second
    body's overlap went unseen on the print plate, a printable that happened to
    be second in the stack could not be recognised in a view, and
    `assembled.stl` was written without it. The model half of the template has
    always known better -- drop_mesh() walks `vals()` -- and this is the same
    walk for the gate half.

    A bare Shape has no stack and stands for itself. A Compound is one object
    with several bodies inside it and `vals()` returns it whole, which is
    right: it is handled as the one thing the model handed over.
    """
    shapes = list(obj.vals()) if hasattr(obj, "vals") else [obj]
    if not shapes:
        raise BuildError(f"{where}: holds no geometry at all (an empty stack)")
    for shape in shapes:
        if not hasattr(shape, "isValid"):
            raise BuildError(
                f"{where}: expected CadQuery geometry, got "
                f"{type(shape).__name__}"
            )
    return shapes


def drop_mesh(obj):
    """Throw away the triangulation an export left on a shape.

    Exporting to STL/3MF meshes the shape in place, and from then on OCCT
    computes bounding boxes off that mesh. checks() runs after the export, so
    without this every BoundingBox() a model measures would be quietly wrong.

    THE BOX READS BIGGER, NEVER SMALLER -- a given axis may not move at all,
    but none of them moves down -- and the direction is what this note is for:
    everything below follows from the sign. Measured here on cadquery 2.8.0,
    `mesh(0.1)` on three shapes, every axis:

        cylinder r=5 h=10            Z 10.000000 -> 10.003108
        box 30x20x10, 3 mm fillets   X 30.000000 -> 30.001807 (all three axes)
        sphere r=5                   Z 10.000000 -> 10.026316

    Not one axis of the three came back smaller. Exported the way this build
    exports (artifacts.STL_TOLERANCE 0.01, STL_ANGULAR_TOLERANCE 0.1) the
    cylinder reads that same 10.003108 -- through `Shape.exportStl`,
    `exporters.export` and a bare `mesh()` alike, and it is the one figure two
    independent runs of this agreed on. Clean_s, which is what this function
    calls, puts it back to 10.000000 exactly.

    HOW FAR IT MOVES REPRODUCES ONLY SO FAR, and the boundary is known rather
    than vague. Two of us swept the angular tolerance on this cylinder under
    the same cadquery 2.8.0: at 0.01, 0.04 and 0.1 the two benches agreed to
    the last digit on all three axes -- the stationary Y below included -- and
    at 0.2 they did not. Neither run explained the other. So the figures here
    are quoted up to 0.1, and past it a number is whoever's bench produced it.

    What held on both, at linear 0.01, on Z: angular 0.01 gives 10.000031, 0.04
    gives 10.000498, 0.1 gives 10.003108. The angular tolerance moves the
    result a long way and moves it predictably.

    IT ALSO DEPENDS ON THE AXIS, on that one cylinder, which is the part most
    likely to catch somebody out: at angular 0.1 the Y extent did not move at
    all (10.000000) while X and Z both grew to 10.003108, and at 0.04 all three
    differ (X 10.000249, Y 10.000373, Z 10.000498). The axes do not scale with
    one another, so what one extent did says nothing about the next.

    A bounding box off a meshed shape is therefore only worth quoting together
    with the shape, BOTH tolerances and the AXIS -- and that is the signature
    every figure above carries. The SIGN is the only part that carries on its
    own.

    IT IS NOT A CHORD EFFECT, which is the guess that makes it sound harmless
    and points the sign the other way ("a curve cut into straight segments falls
    INSIDE itself, so the box must shrink"). The cylinder's Z is bounded by two
    flat faces, where nothing is being approximated at all, and Z grew anyway.

    WHAT THE SIGN COSTS, in the order the damage gets worse:
      * "does this fit the printer" reads every extent over, so a part that
        clears the bed by less than the inflation goes RED. Wrong, but loud, and
        the number in the message looks odd enough to be questioned.
      * a clearance measured between two solids reads TIGHTER than it is, both
        sides having grown towards each other.
      * and the one to watch: an inequality whose GROWN side is the weak one
        buys itself slack and passes IN SILENCE. `assert box.zlen >= MINIMUM` is
        exactly that shape, and a part short of the minimum by less than the
        inflation goes green on the mesh's numbers -- however small that band
        is, the failure inside it is the quiet one.
    """
    from OCP.BRepTools import BRepTools

    shapes = obj.vals() if hasattr(obj, "vals") else [obj]
    for shape in shapes:
        wrapped = getattr(shape, "wrapped", None)
        if wrapped is not None:
            BRepTools.Clean_s(wrapped)
