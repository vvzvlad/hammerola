#!/usr/bin/env python3
"""The whole product as one file, and the pictures that go next to it.

Made in the same process that computed the geometry -- the fenced build process
the hub spawns -- and what comes back from it is the staging directory it wrote.
"""

import time

from .artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID, CARD_SUFFIX,
                        PREVIEW_SUFFIX, PRINT_VIEW_ID, STL_ANGULAR_TOLERANCE,
                        STL_TOLERANCE)
from .errors import BuildError
from .geometry import as_shapes, drop_mesh
from .parts import KIND_MOCK


# --------------------------------------------------------------------------
# Pictures, and the assembly as one file
# --------------------------------------------------------------------------
#
# Made here, in the fenced build process that computed the geometry: rendering
# later in the hub would mean re-reading the STLs and putting the CAD stack on
# the request path.

def _view_nodes(prepared, vid):
    """The leaves a prepared view draws, in order, or None if there is no such view.

    The LEAVES rather than their shapes, because a leaf carries its catalogue
    key as well -- and the key is the only thing that says whether what stands
    here is the product or the scenery around it (see `_product_bbox`).
    """
    for view in prepared:
        if view["id"] == vid:
            return view["nodes"]
    return None


def _view_objects(prepared, vid):
    """The shapes a prepared view draws, in order, or None if there is no such view.

    Each leaf already stands where the view puts it (`at` was applied when the
    view was prepared).

    Mesh leaves are skipped: a `mesh` entry holds a trimesh (`parts.py`) and its
    leaf's `shape` is None, so there is nothing to glue or export. A mesh is in
    every view the browser loads and in none of the STLs written here. Only a
    `mock` may be a mesh and the plate refuses mocks, so this affects only the
    assembly.
    """
    nodes = _view_nodes(prepared, vid)
    return None if nodes is None else [node["shape"] for node in nodes
                                       if node["mesh"] is None]


def _product_bbox(prepared, catalogue):
    """The box round the PRODUCT: every leaf of the assembled view but the mocks.

    A mock is scenery (the wall a bracket bolts to) and overlaps the product by
    construction (see `parts.KIND_MOCK`), so including it would report changes
    to the scenery as size changes and mask a part moved inside the assembly.

    `None` when the view holds only mocks. Defensive: `read_catalogue` and
    `check_assembled_coverage` already refuse such a model before this runs.
    """
    shapes = [shape
              for node in _view_nodes(prepared, ASSEMBLED_VIEW_ID)
              if catalogue[node["key"]]["kind"] != KIND_MOCK
              for shape in as_shapes(node["shape"], ASSEMBLED_VIEW_ID)]
    if not shapes:
        return None
    if len(shapes) == 1:
        return shapes[0].BoundingBox()
    # Glued only to be measured (never exported or meshed). Imported at the
    # point of use so the single-body path needs no kernel.
    from cadquery.occ_impl.shapes import Compound
    return Compound.makeCompound(shapes).BoundingBox()


# Twin of print_plate_shape below: same walk, same glue. The code differs in:
#
#   1. the view id, in both places (the walk and `as_shapes`):
#      ASSEMBLED_VIEW_ID here, PRINT_VIEW_ID there;
#   2. no matching view: this one raises, that one returns None, because an
#      `assembled` view is mandatory and a `print` view is optional.
#
# Both import `Compound` at the point of use, so the no-view and single-body
# paths work without CadQuery (tests/cadbuild/test_assembly.py relies on it).
def assembled_shape(prepared):
    """The whole product as one shape: the assembled view, glued.

    The `assembled` view is the authority on where the parts stand, and every
    model has one (prepare_views refuses one that does not).

    Glued, not fused: a compound is one file and instant, where a boolean union
    of an assembly takes minutes and can fail. It is for looking at, not
    slicing.
    """
    objects = _view_objects(prepared, ASSEMBLED_VIEW_ID)
    if objects is None:
        # Defensive half of prepare_views' rule: gluing something else would
        # publish an `assembled.stl` that is not the assembly.
        raise BuildError(f"there is no {ASSEMBLED_VIEW_ID!r} view to export")

    # Every body of every object: an object put together with .add() would
    # otherwise contribute its first solid only, and assembled.stl would be
    # missing parts that the viewer shows.
    shapes = [shape for obj in objects
              for shape in as_shapes(obj, ASSEMBLED_VIEW_ID)]
    if len(shapes) == 1:
        return shapes[0], objects
    # Imported at the point of use rather than at the top of the function: the
    # two paths above need no kernel at all, and this way the no-view and
    # single-body cases stay answerable on a python that has no CadQuery in it.
    from cadquery.occ_impl.shapes import Compound
    return Compound.makeCompound(shapes), objects


# Twin of export_print_plate below: the `if not path.is_file()` guard and the
# drop_mesh loop are identical in the two. The code differs in:
#
#   1. the shape function: assembled_shape here, print_plate_shape there;
#   2. the view id passed to `as_shapes` and the file stem: ASSEMBLED_VIEW_ID
#      and ASSEMBLED_STEM here, PRINT_VIEW_ID for both there;
#   3. this one always writes; that one returns None without a matching view;
#   4. what is measured, and so the signature: the plate measures the shape it
#      exports, this one `_product_bbox` (the non-mock leaves), which needs the
#      catalogue.
def export_assembled(prepared, out_dir, catalogue):
    """Write `assembled.stl` -- the whole thing in one mesh.

    Returns `(parts, bbox)`. `parts` is how many bodies went into it: the
    preview cannot get it from the file, because touching parts weld into one
    (non-watertight) body when the mesh is loaded. `bbox` is the product's own
    envelope (the non-mock leaves), published as `assembly.bbox_mm`; the OCC
    `BoundingBox`, or None when the view holds only scenery.

    The file is the whole scene, the number is not: the wall a bracket bolts to
    belongs in the picture, but a box including mocks would measure the
    scenery. Mesh leaves are in neither (`_view_objects`); the browser's view
    still shows them.

    Measured before the export: exportStl meshes the shape in place, and a box
    taken afterwards is the mesh's, tenths of a millimetre bigger on anything
    filleted. `test_the_assembly_is_measured_before_it_is_meshed` pins the
    order.
    """
    shape, objects = assembled_shape(prepared)
    path = out_dir / f"{ASSEMBLED_STEM}.stl"
    # Measured before the export (see the docstring), off the product rather
    # than `shape`, which includes the mocks.
    bbox = _product_bbox(prepared, catalogue)
    # relative=False for the same reason as the printables above: OCC's
    # default scales the deflection per face and cracks the mesh where faces
    # of very different size meet.
    shape.exportStl(str(path), tolerance=STL_TOLERANCE,
                    angularTolerance=STL_ANGULAR_TOLERANCE,
                    ascii=False, relative=False)
    if not path.is_file():
        raise BuildError(f"{path.name} was not written")

    # Meshing happened in place on shapes the model still owns, and `.moved()`
    # or `.located()` copies share that triangulation through the TShape, which
    # inflates BoundingBox() on the others. drop_mesh cleans only the object it
    # is handed (a `.translate()` copy has its own TShape), so every object gets
    # its own pass.
    for obj in objects:
        drop_mesh(obj)
    # Bodies, not view objects: one object built with .add() is several parts.
    parts = sum(len(as_shapes(obj, ASSEMBLED_VIEW_ID)) for obj in objects)
    print(f"  {path.name}: {parts} parts, {path.stat().st_size / 1e6:.2f} MB")
    return parts, bbox


# Twin of assembled_shape above; the differences are listed there.
def print_plate_shape(prepared):
    """The bed as one shape: the `print` view, glued. `None` when there is none.

    The `print` view shows what is laid out on the bed, in print orientation.
    It is tessellated for the viewer (`print.json`); this shape is behind
    `print.stl` (for a slicer) and `print_preview.png`, the picture an agent
    looks at to catch a part lying face down.

    `None`, not an error, without such a view: it is optional, and a
    single-part model already in print orientation has none.

    Glued, not fused, for the reason `assembled_shape` gives.
    """
    objects = _view_objects(prepared, PRINT_VIEW_ID)
    if objects is None:
        return None

    # Every body of every object, as in assembled_shape: an object built with
    # .add() would otherwise contribute only its first solid.
    shapes = [shape for obj in objects
              for shape in as_shapes(obj, PRINT_VIEW_ID)]
    if len(shapes) == 1:
        return shapes[0], objects
    # Imported at the point of use: the paths above need no kernel.
    from cadquery.occ_impl.shapes import Compound
    return Compound.makeCompound(shapes), objects


# Twin of export_assembled above; the differences are listed there.
def export_print_plate(prepared, out_dir):
    """Write `print.stl` -- the bed as it is laid out. `None` without a plate.

    Returns `(bodies, bbox)`. `bodies` is how many bodies went onto the plate;
    the preview needs it because touching parts weld into one body on load.

    `bbox` is published as `assembly.print_bbox_mm` (how much of the bed this
    build occupies), returned as the OCC `BoundingBox`;
    `cadbuild.metrics.collect_metrics` turns it into numbers.

    Measured before the export: exportStl meshes the shape in place, and a box
    taken afterwards is the mesh's, tenths of a millimetre off on anything
    filleted. `test_the_plate_is_measured_before_it_is_meshed` pins the order.

    Cost: `Shape.BoundingBox()` in the pinned cadquery uses
    `BRepBndLib.AddOptimal_s`, which cadquery's own comment calls exact but
    expensive (`cadquery/occ_impl/geom.py`, `BoundBox._fromTopoDS`), over the
    whole plate compound on every build. Accepted: it is the number that says
    whether the plate fits on a bed.
    """
    plate = print_plate_shape(prepared)
    if plate is None:
        return None
    shape, objects = plate

    path = out_dir / f"{PRINT_VIEW_ID}.stl"
    # Measured before the export (see the docstring).
    bbox = shape.BoundingBox()
    # relative=False for the same reason as the printables: OCC's default
    # scales the deflection per face and cracks the mesh where faces of very
    # different size meet.
    shape.exportStl(str(path), tolerance=STL_TOLERANCE,
                    angularTolerance=STL_ANGULAR_TOLERANCE,
                    ascii=False, relative=False)
    if not path.is_file():
        raise BuildError(f"{path.name} was not written")

    # Meshing happened in place on shapes the model still owns, and `.moved()`
    # or `.located()` copies share that triangulation through the TShape, which
    # inflates BoundingBox() on the others. drop_mesh cleans only the object it
    # is handed (a `.translate()` copy has its own TShape), so every object gets
    # its own pass.
    for obj in objects:
        drop_mesh(obj)
    # Bodies, not view objects: one object built with .add() is several parts.
    bodies = sum(len(as_shapes(obj, PRINT_VIEW_ID)) for obj in objects)
    print(f"  {path.name}: {bodies} parts, {path.stat().st_size / 1e6:.2f} MB")
    return bodies, bbox


def render_previews(out_dir, stems, mode, parts=None, colors=None, scenes=None):
    """One PNG per stem, rendered from the STL already written next to it.

    Returns `(written, cards)`. `written` is the sheets actually rendered, in
    order; `cards` maps a stem to its second picture, the bare tile without
    title band or footer that the front page's project card shows
    (`artifacts.CARD_SUFFIX`).

    `mode` is "iso" (one isometric) or "multi" (the six-view sheet). The push
    path uses the cheap default; `--preview-mode multi` is carried to the build
    process by `buildproc/runner.py`, and
    `python -m src.cadbuild.preview_png --views multi` asks for it.

    `parts` maps a stem to how many parts its file holds (default one). A
    single-part footer says whether the mesh is watertight; the picture cannot
    tell itself, because touching parts weld into one body on load.

    `colors` maps a stem to the part's catalogue colour, so a part looks the
    same alone and in the assembly.

    `scenes` maps a whole-view stem (assembly, plate) to a tessellated view
    document in this directory, drawn instead of the STL so the picture has the
    viewer's colours, alpha and placement; the STL still feeds the footer. A
    card is written for exactly these stems, since a card pictures a project.
    A missing named scene is a BuildError, like a missing STL.

    A missing rendering stack is a warning, not a failure: a python without it
    can still publish. A renderer that is present and then fails is a failure,
    so a build never silently ships without its pictures.
    """
    # Imported here and not at the top of the module: `render` pulls in
    # matplotlib, numpy, trimesh and Pillow, and a python that has none of them
    # must still be able to import this package and publish a build.
    try:
        from . import preview_png as render_preview
    except Exception as exc:
        print(f"warning: no previews -- cadbuild.preview_png will not import "
              f"({type(exc).__name__}: {exc}). The geometry is unaffected.")
        return [], {}

    written = []
    cards = {}
    for stem in stems:
        stl = out_dir / f"{stem}.stl"
        if not stl.is_file():
            raise BuildError(f"cannot render {stem}: {stl.name} is missing")
        scene = (scenes or {}).get(stem)
        if scene is not None:
            scene = out_dir / scene
            if not scene.is_file():
                raise BuildError(f"cannot render {stem}: {scene.name} is missing")
        png = out_dir / f"{stem}{PREVIEW_SUFFIX}"
        # Only a whole view gets one, which `scene` is already the answer to.
        card = None if scene is None else out_dir / f"{stem}{CARD_SUFFIX}"
        started = time.monotonic()
        try:
            render_preview.render(str(stl), str(png), views=mode, title=stem,
                                  parts=(parts or {}).get(stem),
                                  color=(colors or {}).get(stem),
                                  scene=None if scene is None else str(scene),
                                  card_path=None if card is None else str(card))
        except Exception as exc:
            raise BuildError(
                f"rendering {png.name} from {stl.name} failed "
                f"({type(exc).__name__}: {exc})"
            ) from exc
        print(f"  {png.name}: {png.stat().st_size / 1000:.0f} kB, "
              f"{time.monotonic() - started:.1f}s")
        written.append(png.name)
        if card is not None:
            print(f"  {card.name}: {card.stat().st_size / 1000:.0f} kB")
            cards[stem] = card.name
    return written, cards
