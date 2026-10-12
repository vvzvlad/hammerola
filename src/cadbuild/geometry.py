#!/usr/bin/env python3
"""Reading the model's geometry: what a Workplane hands back, and what to do
with the triangulation an export leaves behind."""

import sys

from .errors import BuildError
from .modelchecks import call_model, model_site
# `shown` calls `str()` inside itself, so a buggy `__str__` cannot raise out of
# a handler that is building a refusal. See `modeltext` for what these promise
# and what they do not.
from .modeltext import MAX_MESSAGE_CHARS, shown
from .paths import project_root


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------

def load_model():
    """Import the project's model.py. The contract is parts() and views().

    parts() is the catalogue -- every piece of geometry the model has, each
    under the key that is its identity -- and views() selects from it.

    The project root goes first on sys.path, here rather than at import time:
    first, so `import mocks` finds the project's own mocks.py; here, because
    this package is installed once while the project is whichever one the run
    is in.

    The message names the model's line: a bad module-level constant (e.g. a
    note with a newline, caught by `provenance`) raises here during import,
    not at one of the doors `modelchecks.call_model` guards (`MODEL_DOORS`).

    `model_site`, not `fail_site`: with no model.py there is no model frame,
    and `fail_site` would name a hub file instead.
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
            f"importing model.py failed{model_site(exc)}: "
            f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}"
            f"{_shadowed_src_hint(root_path, exc)}") from exc
    for name in ("parts", "views"):
        if not callable(getattr(model, name, None)):
            raise BuildError(
                f"model.py does not define {name}(){_contract_moved(model)}")
    _warn_if_checklib_shadowed()
    # checks() is the optional third of the contract -- `modelchecks.run_checks`
    # deals with a model that has none.
    return model


def _contract_moved(model):
    """Say the contract changed, when the model was written against the old one.

    A model from before the catalogue defines `printables()` beside `views()`;
    told only "model.py does not define parts()", its author would look for a
    typo.

    A diagnosis, not a compatibility layer: fixing an old model is the
    author's work, and accepting both shapes would keep models in the old one.
    This adds a sentence to the refusal and changes nothing about what is
    refused.
    """
    if not callable(getattr(model, "printables", None)):
        return ""
    return (" -- this model was written against the older contract, where "
            "printables() sat beside views() as a second dict of geometry. It "
            "is gone: parts() is now the whole catalogue, each entry keyed by "
            "what identifies the piece, and views() selects from it. Nothing "
            "translates the old form; rewrite parts() and drop printables()")


def _shadowed_src_hint(root, exc):
    """Name the cause when the project's own `src/` is what broke the import.

    The project root goes first on sys.path, so a project with a `src`
    directory owns the name `src` for the rest of the process, and any later
    `import src....` resolves into the project. The resulting `No module named
    'src.cadbuild'` reads as if the model asked for something missing.

    `import checklib` is immune: the root shim resolves its implementation by
    file path. So this fires when that immunity is gone (the shim importing by
    name, or a project's checklib.py reaching for `src.`). Appended to the real
    error as a hint: a project is entitled to a `src/`.
    """
    if not isinstance(exc, ImportError):
        return ""
    blamed = getattr(exc, "name", None) or ""
    said = str(exc)
    if not (blamed == "src" or blamed.startswith("src.")
            or "'src" in said or "checklib" in said):
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


def checklib_shadow():
    """Where the model's `import checklib` landed, when it was not ours.

    `None` when the model imported the package's own copy, or imported none at
    all. Otherwise the path of the copy it did import -- `'?'` for a module
    with no `__file__`.

    Public because two refusals need it: this warning, and `provenance.check`,
    which would otherwise tell a project with its own checklib that numbers it
    did declare are undeclared (the shadowing copy's `Number` is a different
    class). One implementation, because the attribute-identity test that tells
    the copies apart is easy to get subtly wrong twice.
    """
    import sys

    shadow = sys.modules.get("checklib")
    if shadow is None:
        return None
    from . import checklib as ours

    if getattr(shadow, "recorded_interference", None) is ours.recorded_interference:
        return None
    return getattr(shadow, "__file__", "?")


def _warn_if_checklib_shadowed():
    """Say so when the model's `import checklib` found the project's own copy.

    The project root goes first on sys.path, so a project's checklib.py
    shadows this package's. pairwise_interference records the volumes it
    measured and metrics.json reads that record from the package's copy, so
    with two copies the interference numbers come out empty and nothing goes
    red.

    A warning, not an error: the old copy works. Deleting checklib.py from the
    project is the fix.
    """
    shadow = checklib_shadow()
    if shadow is None:
        return
    print(
        f"warning: model.py imported checklib from {shadow}, "
        "not the one in cadbuild. The project's own copy shadows it, and "
        "the interference volumes checklib records will not reach "
        "metrics.json -- the build measures them and writes none. Delete "
        "checklib.py from the project root; `import checklib` keeps working."
    )


# What a message calls the doors below: one question ("give me the geometry
# you are") whichever spelling the hub used.
A_SHAPE = "reading a shape model.py handed over"


def _first_body(obj):
    """`obj.val()`, or `obj` where there is no stack.

    A function so it can be a door: `val()` runs inside the CAD kernel, whose
    frames are not the model's, so `raised_by_the_model` cannot answer for it
    (see `modelchecks.MODEL_DOORS`). The whole expression is guarded, since
    `hasattr` only swallows AttributeError and a raising `val` property raises
    here too.
    """
    return obj.val() if hasattr(obj, "val") else obj


def _every_body(obj):
    """`obj.vals()` as a list, or `[obj]`. The other half of `_first_body`."""
    return list(obj.vals()) if hasattr(obj, "vals") else [obj]


def as_shape(obj, where):
    """Accept a Workplane or a bare Shape, return something with isValid().

    The first body only. Use it where one body is all there can be, and
    as_shapes() everywhere completeness matters.

    A door into the model, paired with `as_shapes` (`modelchecks.MODEL_DOORS`
    lists both). These two decide the exit code, not just the message: the
    object is the author's but the raising code is the CAD kernel's, so no
    traceback frame is under the project root and `raised_by_the_model` would
    answer False, reporting the author's fault as a hub crash (EXIT_CRASHED).

    The guard is inside these functions rather than at call sites, because
    both are called from several modules (parts here; views, the gate and the
    assembly via `as_shapes`).
    """
    shape = call_model(A_SHAPE, _first_body, obj)
    if not hasattr(shape, "isValid"):
        raise BuildError(f"{where}: expected a CadQuery object, "
                         f"got {type(obj).__name__}")
    return shape


def as_shapes(obj, where):
    """Every body in a Workplane, not just the first. Always a non-empty list.

    `Workplane.val()` returns only the first object on the stack, so a view
    built with `.add()` would be judged on its first body alone: overlaps of
    later bodies unseen, parts missing from `assembled.stl`. drop_mesh() walks
    `vals()` the same way.

    A bare Shape has no stack and stands for itself. A Compound is one object
    with several bodies and `vals()` returns it whole, as the one thing the
    model handed over.

    A door, for the reason `as_shape` gives.
    """
    shapes = call_model(A_SHAPE, _every_body, obj)
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

    The box reads bigger, never smaller (an axis may not move, none shrinks).
    Cadquery 2.8.0, `mesh(0.1)`:

        cylinder r=5 h=10            Z 10.000000 -> 10.003108
        box 30x20x10, 3 mm fillets   X 30.000000 -> 30.001807 (all three axes)
        sphere r=5                   Z 10.000000 -> 10.026316

    At this build's export settings (artifacts.STL_TOLERANCE 0.01,
    STL_ANGULAR_TOLERANCE 0.1) the cylinder reads the same 10.003108 via
    `Shape.exportStl`, `exporters.export` or `mesh()`. Clean_s, which this
    calls, restores 10.000000 exactly.

    The amount depends on the angular tolerance (cylinder Z at linear 0.01:
    10.000031 at 0.01, 10.000498 at 0.04, 10.003108 at 0.1; figures past 0.1
    did not reproduce across machines) and on the axis (at 0.1 Y did not move
    while X and Z grew; at 0.04 X 10.000249, Y 10.000373, Z 10.000498). So a
    meshed box is only quotable with the shape, both tolerances and the axis;
    only the sign carries on its own.

    It is not a chord effect (which would shrink the box): the cylinder's Z is
    bounded by flat faces and still grew.

    What the sign costs:
      * "does this fit the printer" reads every extent over, so a part that
        clears the bed by less than the inflation goes red -- wrong, but loud;
      * a clearance between two solids reads tighter than it is;
      * an inequality whose grown side is the weak one passes silently:
        `assert box.zlen >= MINIMUM` goes green for a part short by less than
        the inflation.
    """
    from OCP.BRepTools import BRepTools

    shapes = obj.vals() if hasattr(obj, "vals") else [obj]
    for shape in shapes:
        wrapped = getattr(shape, "wrapped", None)
        if wrapped is not None:
            BRepTools.Clean_s(wrapped)
