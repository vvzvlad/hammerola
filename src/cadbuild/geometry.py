#!/usr/bin/env python3
"""Reading the model's geometry: what a Workplane hands back, and what to do
with the triangulation an export leaves behind."""

import sys

from .errors import BuildError
from .modelchecks import call_model, model_site
# Rendering a value the model decides. `shown` calls `str()` INSIDE itself,
# which is what a handler already building a refusal needs: an `__str__` with a
# bug in it would otherwise raise out of the `except` and replace the message.
# See `modeltext` for what these promise -- and, just as much, for what they do
# not.
from .modeltext import MAX_MESSAGE_CHARS, shown
from .paths import project_root


# --------------------------------------------------------------------------
# Building
# --------------------------------------------------------------------------

def load_model():
    """Import the project's model.py. The contract is parts() and views().

    parts() is the catalogue -- every piece of geometry the model has, each
    under the key that IS its identity -- and views() selects from it. There is
    no printables() any more: a second dict of geometry beside the catalogue is
    what forced everything downstream to guess which entry of one was which
    entry of the other.

    The project root goes on sys.path here rather than at import time, and it
    goes on FIRST. First, because `import mocks` in a model.py has to find the
    project's own mocks.py and nothing else called mocks that happens to be
    installed. Here, because this package is installed once per machine while
    the project is whichever one the run is in -- and a path pinned at import
    would be the wrong project's the moment anything imported this module
    before the root was known.

    THE MESSAGE NAMES THE LINE, and this is the door where that matters most.
    `provenance` looks only at module-level names, so a note with a newline in
    it is almost always written at the top level of model.py -- and it is then
    raised HERE, during the import, rather than at any of the doors
    `modelchecks.call_model` guards (`MODEL_DOORS` is the list). Those answer
    `(model.py:5)`; this one
    answered with no file and no line at all, leaving an author with forty
    constants to find the one that is wrong by reading.

    `model_site` AND NOT `fail_site`, deliberately: with no model.py to import
    there is no model frame in the traceback, and `fail_site` would fall back to
    naming a file of the hub's -- `importing model.py failed (geometry.py:<line>)`
    for a file that is not there. Saying nothing is the right answer to "which
    line of the model" when the model does not exist.
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
    """Say the contract CHANGED, when the model was written against the old one.

    A model from before the catalogue opened with `printables()` beside
    `views()`, and its author, told only "model.py does not define parts()",
    goes looking for a typo in a file that has no typo in it — the name is not
    missing, it was renamed out from under them, and nothing they can read from
    here says so.

    THIS IS A DIAGNOSIS AND NOT A COMPATIBILITY LAYER. The translator for the
    old shape was written, then deleted deliberately (`legacy.py`, commit
    d84056e): fixing an old model is the author's work, and a hub that quietly
    accepted both shapes would keep every model in the older one forever. So
    this adds a sentence to a refusal and changes nothing about what is
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
    all. Otherwise the path of the copy it did import, as a string -- `'?'` for
    a module with no `__file__`, because the caller is building a sentence and
    "somewhere" is still worth saying.

    PUBLIC BECAUSE TWO REFUSALS NEED THE SAME ANSWER, and the second one arrived
    long after this: `provenance.check` refuses a model whose numbers do not
    declare themselves, and a project with its own checklib is told exactly that
    about numbers it DID declare -- through the shadowing copy, whose `Number`
    is a different class. Naming the cause is the difference between a message
    the author can act on and one that sends them to rewrite correct lines. The
    detection is one function rather than two because the ONE thing it turns on
    -- which attribute identity distinguishes our module from an older copy --
    is exactly the sort of fact a second implementation gets subtly wrong.
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


# What a message calls the doors below. They share a sentence because they are
# one question asked of the same object -- "give me the geometry you are" -- and
# the author cannot act on which spelling of it the hub happened to use.
A_SHAPE = "reading a shape model.py handed over"


def _first_body(obj):
    """`obj.val()`, or `obj` where there is no stack.

    A FUNCTION SO THAT IT CAN BE A DOOR, which is the whole reason it is not
    written inline: `val()` runs inside the CAD kernel, and the kernel's frames
    are not the model's, so `raised_by_the_model` cannot answer for what happens
    in here (see `modelchecks.MODEL_DOORS`). Everything in the expression is
    guarded rather than the call alone: `hasattr` swallows AttributeError and
    nothing else, so a `val` PROPERTY that raises raises here too.
    """
    return obj.val() if hasattr(obj, "val") else obj


def _every_body(obj):
    """`obj.vals()` as a list, or `[obj]`. The other half of `_first_body`."""
    return list(obj.vals()) if hasattr(obj, "vals") else [obj]


def as_shape(obj, where):
    """Accept a Workplane or a bare Shape, return something with isValid().

    THE FIRST body only. Use it where one body is all there can be, and
    as_shapes() everywhere completeness matters -- see there.

    A DOOR INTO THE MODEL, and one of a PAIR with `as_shapes` below
    (`modelchecks.MODEL_DOORS` lists both). THESE TWO ARE THE DOORS THAT BUY
    THE EXIT CODE rather than only the message, which is what earns them their
    place on a list otherwise made of calls into model.py: the object is the
    author's, but the code that raises is the CAD KERNEL's, in site-packages,
    so nothing on the traceback sits under the project root and
    `raised_by_the_model` answers False for a fault that is entirely theirs.
    Measured before the guard existed: a `val()` that raises left the build
    process as a bare exception, i.e. EXIT_CRASHED, and the hub told whoever
    pushed that it had fallen over.

    THE GUARD IS INSIDE THESE TWO FUNCTIONS rather than at the call sites.
    Which of the two a caller reaches does not follow from anything -- parts
    arrive HERE, views, the gate and the assembly arrive THERE -- and both are
    called from several modules; a rule applied at the sites somebody thought
    about is the failure this whole area keeps repeating.
    """
    shape = call_model(A_SHAPE, _first_body, obj)
    if not hasattr(shape, "isValid"):
        raise BuildError(f"{where}: expected a CadQuery object, "
                         f"got {type(obj).__name__}")
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

    A DOOR, for the reason `as_shape` above gives at length.
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
