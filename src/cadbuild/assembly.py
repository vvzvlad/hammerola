#!/usr/bin/env python3
"""The whole product as one file, and the pictures that go next to it.

Made in the same process that computed the geometry -- the fenced build process
the hub spawns -- and what comes back from it is the staging directory it wrote.
"""

import time

from .artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID, CARD_SUFFIX,
                        PREVIEW_SUFFIX, PRINT_VIEW_ID, STL_ANGULAR_TOLERANCE,
                        STL_TOLERANCE, plate_file)
from .errors import BuildError
from .geometry import as_shapes, drop_mesh
from .parts import KIND_MOCK
from .threemf import write_3mf


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

    `None` when the view holds only mocks: a catalogue with no printable, or
    one whose printables the view declares absent. `collect_metrics` then
    writes no `bbox_mm`.
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
    `print.stl`, the glued bed `print_preview.png` is drawn from -- the picture
    an agent looks at to catch a part lying face down. A slicer gets a 3MF per
    bed instead (`export_plate_3mfs`).

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


def export_plate_3mfs(prepared, out_dir):
    """Write a 3MF per bed of the `print` view, for a slicer.

    Returns `(plates, bed)`, or None without a `print` view. `plates` is
    `{"1": "print.3mf", "2": "print-2.3mf", ...}` -- the bed number as
    meta.json keys it, in bed order, for every bed some reference is on. `bed`
    is None unless the view declares the printer's bed (`"bed": (x, y)`), and
    then `{"size_mm": [x, y], "centres": {"1": [cx, cy, zmin], ...}}`, keyed as
    `plates` is: the page draws a bed of that size under each bed's parts,
    centred on the box round them as the view places them, at their lowest
    point. Centred because Bambu Studio puts a file's objects in the middle of
    its bed as one group (below), so the drawn bed stands where the slicer's
    will. Measured on the same meshes and the reference's whole `at`, its
    height included, not the lift the file gets: the bed is drawn in the view.

    A reference names its bed with `"plate": N` and is on bed 1 without one
    (`views._read_reference`); bed N is written to `artifacts.plate_file(N)`.
    A file per bed, because a slicer reads no beds out of a 3MF it did not
    write.

    Each part on a bed is an object of its own where the view put it, so the
    bed opens in a slicer laid out. Built from the `<key>.stl` files
    `export_printables` already wrote and gated (closed, one body) rather than
    by meshing the shapes again, so a bed holds the very mesh each part's own
    download holds. One object per catalogue key on the bed and one build item
    per reference: five references to `pin` are one object placed five times,
    and a slicer loads them as five instances of one part.

    Every item stands on z = 0: the turn and the X and Y of the shift are the
    reference's `at`, and Z lifts the lowest point of the key's mesh onto the
    bed. `gate.check_print_layout` lets `at` only translate and turn about Z,
    so the turn moves no point up or down. One height, because Bambu Studio
    offers to merge objects whose lowest points differ into one multi-part
    object (`Model::looks_like_multipart_object`); X and Y as the view has
    them, because it centres the objects of a file it did not write on its bed
    as one group (`center_instances_around_point`), keeping where they stand
    relative to each other -- and beds laid side by side in the view each land
    in the middle of their own.

    Every leaf here is a printable with a solid shape of the catalogue's
    (`gate.check_print_layout`, `views._refuse_deformed_on_the_plate`), so its
    key's STL is on disk.
    """
    view = next((view for view in prepared if view["id"] == PRINT_VIEW_ID),
                None)
    if view is None:
        return None
    # Imported at the point of use: the no-view path needs no mesh library.
    import numpy
    import trimesh

    meshes, beds, boxes = {}, {}, {}
    for node in view["nodes"]:
        key = node["key"]
        if key not in meshes:
            meshes[key] = trimesh.load(str(out_dir / f"{key}.stl"),
                                       force="mesh")
        lift = -float(meshes[key].bounds[0][2])
        beds.setdefault(node["plate"], []).append(
            (key, _placement(node["at"], lift)))
        # Where the part stands in the view: corners [low, high] of the box
        # round every part on this bed so far.
        placed = trimesh.transform_points(meshes[key].vertices,
                                          _placement(node["at"]))
        low, high = placed.min(axis=0), placed.max(axis=0)
        box = boxes.get(node["plate"])
        boxes[node["plate"]] = (low, high) if box is None else (
            numpy.minimum(box[0], low), numpy.maximum(box[1], high))

    written = {}
    for number in sorted(beds):
        items = beds[number]
        objects = {key: (meshes[key].vertices, meshes[key].faces)
                   for key, _matrix in items}
        path = out_dir / plate_file(number)
        write_3mf(path, objects, items)
        print(f"  {path.name}: {len(items)} parts, {len(objects)} objects, "
              f"{path.stat().st_size / 1e6:.2f} MB")
        written[str(number)] = path.name
    if view["bed"] is None:
        return written, None
    centres = {str(number): [float(low[0] + high[0]) / 2,
                             float(low[1] + high[1]) / 2, float(low[2])]
               for number, (low, high) in sorted(boxes.items())}
    return written, {"size_mm": list(view["bed"]), "centres": centres}


def _placement(at, lift=None):
    """`[R | t]` acting on a column vector: a reference's `at`, Z set to `lift`
    when one is given.

    Read off the `gp_Trsf` as `gate._turns_about_z_only` reads it, 3 rows by 4
    columns, the fourth the shift. On the `print` view that gate has already
    refused an `at` that is not a `cq.Location` (or None) turning about Z.
    """
    if at is None:
        rows = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0]]
    else:
        trsf = at.wrapped.Transformation()
        rows = [[float(trsf.Value(row, col)) for col in (1, 2, 3, 4)]
                for row in (1, 2, 3)]
    if lift is not None:
        rows[2][3] = lift
    return rows + [[0.0, 0.0, 0.0, 1.0]]


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
