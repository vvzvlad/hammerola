#!/usr/bin/env python3
"""The whole product as one file, and the pictures that go next to it.

Made in the same process that computed the geometry: on a `make build` that is
a container on the build node, and `_out/` is the only thing that comes back.
"""

import time

from .artifacts import ASSEMBLED_STEM, PREVIEW_SUFFIX, STL_ANGULAR_TOLERANCE, STL_TOLERANCE
from .errors import BuildError
from .geometry import as_shapes, drop_mesh
from .views import ASSEMBLED_VIEW_ID, PRINT_VIEW_ID


# --------------------------------------------------------------------------
# Pictures, and the assembly as one file
# --------------------------------------------------------------------------
#
# These are made here, in the same process that computed the geometry, and for
# one reason: on a `make build` that geometry is computed inside a container on
# the build node, and `_out/` is the only thing that comes back. Rendering on
# this side afterwards would mean shipping the STLs back and re-reading them,
# and rendering in CI would mean the pictures existed only for pushes to main.

# TWIN of print_plate_shape below, near enough line for line: same walk, same
# glue. FOUR things differ IN THE CODE, beyond the function name, the docstring
# and the wording of the comments, which differ throughout and are not counted
# here. The list is meant to be exhaustive within that scope -- it exists so the
# next editor can check the two against it, and a short list defeats that more
# quietly than no list at all:
#
#   1. the view id, in both places it appears -- the one the walk looks for and
#      the one `as_shapes` is told to blame. This one said `"assembled"` as a
#      literal where the twin says PRINT_VIEW_ID; it is ASSEMBLED_VIEW_ID now,
#      which turns a latent divergence back into the same difference twice;
#   2. what it does when no view carries that id -- this one falls back to the
#      printables, that one returns None;
#   3. the signature, which follows from 2: this one needs `printables` for that
#      fallback, that one takes `prepared` alone;
#   4. WHERE `Compound` is imported. This one takes it at the top of the
#      function, that one at the point of use, and there that placement is
#      load-bearing rather than a style choice -- the comment at that import
#      says so: the no-view and single-body paths stay importable and
#      answerable on a python with no CadQuery installed, and tests in
#      tests/cadbuild/test_assembly.py rely on exactly that, which is why they
#      are written with no kernel planted at all. No count is written here: it
#      is a property of those tests and not a number anything checks. Here every
#      call needs the kernel, the single-body path included.
def assembled_shape(prepared, printables):
    """The whole product as one shape: the assembled view, glued.

    The `assembled` view is the authority on where the parts stand, so that is
    what gets written. Without one, the printables as they are -- for a
    single-part project that is the part, and for the rest it is at least
    everything that will be printed, in the coordinates the model handed over.

    Glued, not fused: a compound is one file and one download, and it is
    instant, where a boolean union of an assembly is minutes and can fail. The
    result is for looking at, not for slicing.
    """
    from cadquery.occ_impl.shapes import Compound

    objects = None
    for view in prepared:
        if view["id"] == ASSEMBLED_VIEW_ID:
            objects = view["objects"]
            break
    if objects is None:
        objects = list(printables.values())

    # Every body of every object: an object put together with .add() would
    # otherwise contribute its first solid only, and assembled.stl would be
    # missing parts that the viewer shows.
    shapes = [shape for obj in objects
              for shape in as_shapes(obj, ASSEMBLED_VIEW_ID)]
    if len(shapes) == 1:
        return shapes[0], objects
    return Compound.makeCompound(shapes), objects


# TWIN of export_print_plate below: the `if not path.is_file()` guard and the
# drop_mesh loop are byte-identical in the two, so an edit to either is an edit
# to consider here. FOUR things differ IN THE CODE, beyond the function name,
# the docstring, the name of the local holding the body count (`parts` here,
# `bodies` there) and the wording of the comments -- those differ throughout and
# are not counted here. Within that scope the list is meant to be exhaustive,
# for the reason the list above assembled_shape gives: a list that names three
# of four defeats the checking it exists for more quietly than no list at all:
#
#   1. which shape function is called, and with it the signature: this one needs
#      `printables` for the fallback that one has no equivalent of;
#   2. the view id `as_shapes` is told to blame, and the stem the file is
#      written under, which split the same way: ASSEMBLED_VIEW_ID and
#      ASSEMBLED_STEM here, PRINT_VIEW_ID for both there. The count line below
#      said `"assembled"` as a LITERAL until 2026-08-31 -- behaving identically,
#      because the constant is that string, which is exactly what made it the
#      latent divergence the list above already claimed to have closed;
#   3. this one always writes; that one returns None when no view carries the
#      id it looks for;
#   4. that one measures a bounding box before the export and hands it back
#      beside the count. This one has no reason to take one, so it returns the
#      count alone.
def export_assembled(prepared, printables, out_dir):
    """Write `assembled.stl` -- the whole thing in one mesh.

    Returns how many bodies went into it. The preview needs that number and
    cannot get it from the file: parts that touch are welded into one body
    when the mesh is loaded, so a two-part assembly reads back as a single
    body that is not watertight.
    """
    shape, objects = assembled_shape(prepared, printables)
    path = out_dir / f"{ASSEMBLED_STEM}.stl"
    # relative=False for the same reason as the printables above: OCC's
    # default scales the deflection per face and cracks the mesh where faces
    # of very different size meet.
    shape.exportStl(str(path), tolerance=STL_TOLERANCE,
                    angularTolerance=STL_ANGULAR_TOLERANCE,
                    ascii=False, relative=False)
    if not path.is_file():
        raise BuildError(f"{path.name} was not written")

    # Meshing happened in place on shapes the model still owns, and a `.moved()`
    # or `.located()` copy shares that triangulation through the TShape -- so
    # meshing one shape silently changes what BoundingBox() answers on another.
    # The error INFLATES the box, by an amount that follows the deflection the
    # export asked for, which reads as a real measurement and not as a fault.
    # EVERY OBJECT GETS ITS OWN PASS: drop_mesh cleans the bodies of the object
    # it is handed and no others, and a `.translate()` copy carries a TShape of
    # its own that would keep its triangulation. Which copies share is not
    # visible from here, so the mesh is dropped from each rather than reasoned
    # about.
    for obj in objects:
        drop_mesh(obj)
    # Bodies, not view objects: one object built with .add() is several parts.
    parts = sum(len(as_shapes(obj, ASSEMBLED_VIEW_ID)) for obj in objects)
    print(f"  {path.name}: {parts} parts, {path.stat().st_size / 1e6:.2f} MB")
    return parts


# TWIN of assembled_shape above, near enough line for line: same walk, same
# glue. The four differences are enumerated in full above THAT one and
# deliberately not restated here, for the reason `export_print_plate` gives
# below -- two lists of the same four are two things to keep true, and a second
# copy of this one had already drifted into naming three of them.
#
# This is the end that takes `prepared` alone, that looks for PRINT_VIEW_ID,
# where None is a legal answer when no view carries that id, and where
# `Compound` is imported at the point of use rather than at the top of the
# function -- that last one load-bearing rather than a style choice, for the
# reason the comment at the import itself gives.
def print_plate_shape(prepared):
    """The bed as one shape: the `print` view, glued. `None` when there is none.

    The `print` view is the only one where the bed itself is visible -- what is
    laid out on it, in the orientation it will be printed in -- and of the TWO
    views the gate knows the meaning of it is the one whose geometry nothing
    exported as a MESH. Scoped to those two on purpose, because the claim is not
    absolute: `views.py` says everything else is just a tab, and a tab a project
    adds goes unexported exactly the same way. It was always tessellated:
    `export_views` writes `print.json` and the viewer loads it. What was missing
    is a file a slicer can open and a picture a reader can look at. This is the
    shape behind `print.stl` and, through it, behind `print_preview.png`: the
    picture an agent looks at to catch a part lying face down.

    `None`, not an error, when no view carries the id: a project is not obliged
    to have a `print` view, and a single-part model whose one part is already in
    print orientation legitimately has none.

    Glued, not fused, for the reason `assembled_shape` gives: a compound is one
    file, one download and instant, where a boolean union of a plate is minutes
    and can fail. The result is for looking at, not for slicing.
    """
    objects = None
    for view in prepared:
        if view["id"] == PRINT_VIEW_ID:
            objects = view["objects"]
            break
    if objects is None:
        return None

    # Every body of every object, for the reason assembled_shape walks them:
    # an object put together with .add() would otherwise contribute its first
    # solid only, and the plate would be missing what the viewer shows.
    shapes = [shape for obj in objects
              for shape in as_shapes(obj, PRINT_VIEW_ID)]
    if len(shapes) == 1:
        return shapes[0], objects
    # Imported at the point of use rather than at the top of the function: the
    # two paths above need no kernel at all, and this way the no-view and
    # single-body cases stay answerable on a python that has no CadQuery in it.
    from cadquery.occ_impl.shapes import Compound
    return Compound.makeCompound(shapes), objects


# TWIN of export_assembled above: the `if not path.is_file()` guard and the
# drop_mesh loop are byte-identical in the two, so an edit to either is an edit
# to consider here. The four differences are enumerated in full above THAT one
# and deliberately not restated here, because two lists of the same four are two
# things to keep true: this is the end where the shape function takes `prepared`
# alone, where PRINT_VIEW_ID is both the view id and the stem, where None is a
# legal answer, and where the bounding box below is measured.
def export_print_plate(prepared, out_dir):
    """Write `print.stl` -- the bed as it is laid out. `None` without a plate.

    Returns `(bodies, bbox)`. `bodies` is how many bodies went onto the plate,
    and the preview needs it for the same reason `export_assembled` hands one
    back: parts that touch weld into one body when the mesh is loaded, so a
    picture told nothing would print "watertight" about a plate.

    `bbox` HAS NO READER TODAY, and that is deliberate rather than an oversight
    -- its reader is issue #58, the one that puts physical numbers into
    metrics.json and needs `assembly.print_bbox_mm`: how much of the bed this
    build occupies. It comes back as the `BoundingBox` object OCC measured,
    with no tuple invented around it, because #58 is what decides the shape it
    is written in.

    IT IS MEASURED BEFORE THE EXPORT, AND THAT ORDER IS THE MEASUREMENT.
    exportStl meshes the shape in place, so a BoundingBox() taken after it
    answers the box of the MESH: not an error and not a failure, but a plausible
    number out by tenths of a millimetre on anything filleted -- which is what
    #58 would then publish as a fact about how much bed this build occupies.
    That is why the line sits where it sits, and it would sit there for the same
    reason with no test in the repository at all.
    `test_the_plate_is_measured_before_it_is_meshed` is HOW the order is kept,
    not why: moving the line breaks nothing else visible, so the test records
    the calls made on the shape and pins their order.

    AND THE ORDER COSTS SOMETHING, which is worth writing down rather than
    rediscovering: `Shape.BoundingBox()` in the pinned cadquery reaches
    `BRepBndLib.AddOptimal_s`, the variant CADQUERY's own comment calls exact
    but expensive (`cadquery/occ_impl/geom.py`, `BoundBox._fromTopoDS`; the
    remark is cadquery's own, not OCCT's, which is worth being exact about
    because the two are different projects to go looking in), and it runs over
    the WHOLE plate compound on every single build
    for a number nothing reads yet. The price is accepted deliberately -- the
    measure-before-mesh ordering is the thing that gets broken silently later,
    and having the test already standing when #58 arrives is worth one bounding
    box per build -- but #58 inherits the fact rather than measuring it again.
    """
    plate = print_plate_shape(prepared)
    if plate is None:
        return None
    shape, objects = plate

    path = out_dir / f"{PRINT_VIEW_ID}.stl"
    # Measured HERE, before the export, and that is not tidiness: exportStl
    # meshes the shape in place, and from then on BoundingBox() is the box of
    # the MESH, out by tenths of a millimetre on anything filleted (the same
    # trap drop_mesh exists for).
    bbox = shape.BoundingBox()
    # relative=False for the same reason as the printables: OCC's default
    # scales the deflection per face and cracks the mesh where faces of very
    # different size meet.
    shape.exportStl(str(path), tolerance=STL_TOLERANCE,
                    angularTolerance=STL_ANGULAR_TOLERANCE,
                    ascii=False, relative=False)
    if not path.is_file():
        raise BuildError(f"{path.name} was not written")

    # Meshing happened in place on shapes the model still owns, and a `.moved()`
    # or `.located()` copy shares that triangulation through the TShape -- so
    # meshing one shape silently changes what BoundingBox() answers on another.
    # The error INFLATES the box, by an amount that follows the deflection the
    # export asked for, which reads as a real measurement and not as a fault.
    # EVERY OBJECT GETS ITS OWN PASS: drop_mesh cleans the bodies of the object
    # it is handed and no others, and a `.translate()` copy carries a TShape of
    # its own that would keep its triangulation. Which copies share is not
    # visible from here, so the mesh is dropped from each rather than reasoned
    # about.
    for obj in objects:
        drop_mesh(obj)
    # Bodies, not view objects: one object built with .add() is several parts.
    bodies = sum(len(as_shapes(obj, PRINT_VIEW_ID)) for obj in objects)
    print(f"  {path.name}: {bodies} parts, {path.stat().st_size / 1e6:.2f} MB")
    return bodies, bbox


def render_previews(out_dir, stems, mode, parts=None):
    """One PNG per stem, rendered from the STL already written next to it.

    `mode` is "iso" (one isometric) or "multi" (the six-view sheet). The gate
    runs after every edit, so the default is the cheap one and the sheet is
    asked for: `make build VIEWS=multi`.

    `parts` maps a stem to how many parts its file holds; anything not in it
    is one part. The footer of a single-part picture says whether the mesh is
    watertight, which is the interesting fact about a part and a meaningless
    one about an assembly -- and the picture cannot work out which it is
    looking at, because touching parts weld into one body on load.

    A missing rendering stack is a warning, not a failure -- the geometry and
    the gate are what a build is for, and a python without matplotlib should
    still be able to publish one. A renderer that is there and then falls over
    is a real failure: silently shipping a build without the pictures it says
    it makes is how you end up looking at yesterday's.
    """
    # Imported here and not at the top of the module: `render` pulls in
    # matplotlib, numpy, trimesh and Pillow, and a python that has none of them
    # must still be able to import this package and publish a build.
    try:
        from . import preview_png as render_preview
    except Exception as exc:
        print(f"warning: no previews -- cadbuild.preview_png will not import "
              f"({type(exc).__name__}: {exc}). The geometry is unaffected.")
        return []

    written = []
    for stem in stems:
        stl = out_dir / f"{stem}.stl"
        if not stl.is_file():
            raise BuildError(f"cannot render {stem}: {stl.name} is missing")
        png = out_dir / f"{stem}{PREVIEW_SUFFIX}"
        started = time.monotonic()
        try:
            render_preview.render(str(stl), str(png), views=mode, title=stem,
                                  parts=(parts or {}).get(stem))
        except Exception as exc:
            raise BuildError(
                f"rendering {png.name} from {stl.name} failed "
                f"({type(exc).__name__}: {exc})"
            ) from exc
        print(f"  {png.name}: {png.stat().st_size / 1000:.0f} kB, "
              f"{time.monotonic() - started:.1f}s")
        written.append(png.name)
    return written
