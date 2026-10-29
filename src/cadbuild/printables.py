#!/usr/bin/env python3
"""Export every printable catalogue entry to STEP/STL/3MF, gating its geometry.

What a part is is decided by the catalogue (parts.py); this reads the entries
whose kind says they go on a bed.
"""

import math

from .artifacts import (ASSEMBLED_STEM, PREVIEW_SUFFIX, PRINT_VIEW_ID,
                        STL_ANGULAR_TOLERANCE, STL_TOLERANCE)
from .checklib import minimum_feature
from .errors import BuildError
from .geometry import as_shape, drop_mesh
from .parts import check_stem, printable_keys


# The three formats every printable is published in, and the order they are
# written in. STEP is the exact solid for whoever wants to edit it, STL is what
# a slicer eats, 3MF carries units and is what a modern slicer prefers.
EXPORT_FORMATS = ("step", "stl", "3mf")


def overview_meshes(plate):
    """`{stem: filename}` for the MESHES that are about the WHOLE build.

    Two at most, the glued assembly and the print plate, and neither is a
    download button: the assembly is already on the page in 3D, and the plate
    is offered to a slicer as a 3MF per bed (`assembly.export_plate_3mfs`),
    each part an object of its own. Not in the parts map, because these
    stems are not catalogue keys (parts.RESERVED_STEMS). Separate from
    `previews` because both are keyed by stem and `assembled` names a file in
    each.

    Only files actually written are declared (`plate` says whether
    `export_print_plate` wrote one; `export_assembled` writes or raises): the
    hub accepts only names that are keys of the output hash
    (`render.build_meta`), so a missing file would refuse the publication.
    """
    meshes = {}
    for stem, exported in ((ASSEMBLED_STEM, True), (PRINT_VIEW_ID, plate)):
        if not exported:
            continue
        name = f"{stem}.stl"
        meshes[check_stem(stem, f"the mesh {name}")] = name
    return meshes


def preview_files(written):
    """`{stem: filename}` for the pictures -- every one that was rendered.

    None of them is a download button, but all are declared so clients need
    not assemble URLs by hand. Keyed by the stem the picture is of (a catalogue
    key, or `assembled`/`print`, which parts.RESERVED_STEMS keeps unambiguous),
    so a reader can pick one out: the assembled frame for a project card, a
    part's own picture for its tree row.

    `written` is what `render_previews` returned: the PNGs it actually wrote,
    `[]` without a rendering stack (see overview_meshes for why).
    """
    previews = {}
    for name in written:
        # A picture is written as `<stem>{PREVIEW_SUFFIX}` by render_previews and
        # there is no other writer; a name of any other shape has no stem to be
        # declared under, and the empty string check_stem then refuses is the
        # same failure as an illegal one.
        stem = name[:-len(PREVIEW_SUFFIX)] if name.endswith(PREVIEW_SUFFIX) else ""
        previews[check_stem(stem, f"the picture {name!r}")] = name
    return previews


def first_layer_area(mesh):
    """Contact area with the bed, in square millimetres.

    The bed is wherever the part's own lowest point is: `mesh.bounds[0][2]`.
    "No first layer" means no flat bottom of its own (a pyramid on its apex),
    not a zmin other than zero; a centred box must pass.

    A triangle is on the bed when all three of its vertices sit within
    STL_TOLERANCE of that lowest point AND its normal points down. The normal
    is what keeps a thin wall's TOP face out of the sum when it happens to land
    in the same band.

    A flat face meshes exactly; what the band admits is the bottom row of
    facets of a curved surface. Measured with STL_TOLERANCE: a 40 mm cylinder
    on its side gives 9.97-35.65 mm2 for r=5..20, a sphere 0.1371 mm2 at r=3
    and 0 at r=10. So a part resting on a line passes, deliberately: a slicer
    lays down roughly that strip and the part prints. The check is for a part
    that touches at nothing.
    """
    lowest = float(mesh.bounds[0][2])
    on_bed = mesh.triangles[:, :, 2].max(axis=1) - lowest <= STL_TOLERANCE
    return float(mesh.area_faces[on_bed & (mesh.face_normals[:, 2] < 0)].sum())


def overhang_area(mesh):
    """Steeply downward surface off the bed, in square millimetres.

    A metric, not a check (unlike `checklib.unsupported_area`): it refuses
    nothing and is there to be compared between revisions.

    A triangle counts when it points more than 45 degrees below horizontal --
    the angle a slicer stops bridging at -- and is not in the first-layer band,
    which is the same `on_bed` reading `first_layer_area` makes: the plate holds
    those triangles up, so they are contact rather than overhang.

    Zero-area triangles are dropped first. They contribute no area, but a
    `nan` area would reach metrics.json as a bare `NaN`, which is not JSON.
    (Degenerate pole triangles keep the steep normal OCC wrote in the STL,
    since trimesh's binary loader passes normals through.)
    """
    real = mesh.area_faces > 0
    lowest = float(mesh.bounds[0][2])
    on_bed = mesh.triangles[:, :, 2].max(axis=1) - lowest <= STL_TOLERANCE
    steep = mesh.face_normals[:, 2] < -math.cos(math.radians(45.0))
    return float(mesh.area_faces[real & steep & ~on_bed].sum())


def export_printables(catalogue, out_dir):
    """Export STEP/STL/3MF for every printable, gating each one on geometry.

    Returns `(files, metrics)` -- `{key: {ext: filename}}` for what was written,
    and the numbers the gate measured on the way past, one entry per part. The
    metrics are a by-product and cost nothing: every one of them is a value this
    function already had in a local variable.

    The file map is keyed by catalogue key, then format, so no reader has to
    parse the part out of a filename (a key may contain dots).
    """
    import cadquery as cq
    from cadquery import exporters
    import trimesh

    files = {}
    metrics = {}

    for name in printable_keys(catalogue):
        obj = catalogue[name]["shape"]
        shape = as_shape(obj, f"printable {name!r}")

        # Gate part 1 -- topology and volume, before anything is written.
        if not shape.isValid():
            raise BuildError(f"printable {name!r} is not a valid solid (isValid() == False)")
        volume = shape.Volume()
        if volume <= 0:
            raise BuildError(f"printable {name!r} has non-positive volume ({volume})")

        # Measured before the export: exportStl meshes the shape in place, and
        # after that BoundingBox() is the mesh's box, which reads bigger (see
        # geometry.drop_mesh). All counts come off the same unmeshed shape.
        box = shape.BoundingBox()
        measured = {
            "volume_mm3": volume,
            "bbox_mm": [box.xlen, box.ylen, box.zlen],
            "faces": len(shape.Faces()),
            "edges": len(shape.Edges()),
            "solids": len(shape.Solids()),
        }

        # Gate part 1b -- the whole part has to be thicker than one extrusion
        # width, or it prints as a line or nothing. `minimum_feature()` is the
        # nozzle default; a model that knows its machine checks in checks().
        thinnest = min(measured["bbox_mm"])
        if thinnest < minimum_feature():
            raise BuildError(
                f"printable {name!r} measures {measured['bbox_mm']} mm, so its "
                f"smallest dimension is {thinnest:.3f} mm -- under the "
                f"{minimum_feature():.3f} mm this nozzle can lay down. The "
                "whole part is thinner than the thread it would be printed "
                "with; refusing to publish."
            )

        assembly = cq.Assembly(obj, name=name)
        step_path = out_dir / f"{name}.step"
        stl_path = out_dir / f"{name}.stl"
        mf_path = out_dir / f"{name}.3mf"

        assembly.export(str(step_path), exportType="STEP")
        # exportStl directly, NOT assembly.export/exporters.export: both of
        # those leave OCC's `relative` flag at its default True, which scales
        # the linear deflection by each face's own size. A part whose faces
        # differ wildly in area -- a 1000 mm2 plate meeting a 12 mm2 chamfer
        # patch -- then gets those faces meshed to different deflections,
        # their shared edge polygons disagree, and the STL comes out with a
        # crack along it. relative=False meshes everything to the same
        # STL_TOLERANCE and makes that number mean what it says.
        shape.exportStl(
            str(stl_path), tolerance=STL_TOLERANCE,
            angularTolerance=STL_ANGULAR_TOLERANCE, ascii=False, relative=False,
        )
        # 3MF is not reachable through Assembly -- the extension is not
        # recognised there. Only exporters.export on a Workplane/Shape works.
        exporters.export(obj, str(mf_path), exportType=exporters.ExportTypes.THREEMF)

        # Gate part 2 -- the mesh people actually print must be closed.
        mesh = trimesh.load(str(stl_path))
        watertight = getattr(mesh, "is_watertight", False)
        if not watertight:
            raise BuildError(
                f"printable {name!r} exports a mesh that is not watertight. "
                "It would slice with holes; refusing to publish."
            )

        # Gate part 3 -- and that mesh must be one body. Two shells that never
        # touch are each valid, each closed, and add up to a positive volume,
        # so nothing above notices; the slicer would just get loose parts.
        pieces = len(mesh.split(only_watertight=False))
        if pieces != 1:
            raise BuildError(
                f"printable {name!r} is {pieces} disconnected pieces, not one "
                "body. Fuse them into one solid, or give each piece a "
                "catalogue entry of its own."
            )

        # Gate part 4 -- and it has to stand on something. A part whose lowest
        # face is a point or a line has nothing for the first layer to stick
        # to: it is printed on supports or it is not printed at all, and
        # neither is a decision this build gets to make silently.
        bed_area = first_layer_area(mesh)
        if bed_area <= 0:
            lowest = mesh.vertices[mesh.vertices[:, 2].argmin()]
            raise BuildError(
                f"printable {name!r} touches the bed at nothing: its lowest "
                f"point is ({float(lowest[0]):.3f}, {float(lowest[1]):.3f}, "
                f"{float(lowest[2]):.3f}) and no face lies flat there. Rest "
                "it on a face, or split it so each piece has one."
            )

        print(f"  {name}: valid, volume {volume / 1000.0:.2f} cm3, watertight, "
              f"one body, {mesh.faces.shape[0]} triangles")

        measured["watertight"] = bool(watertight)
        measured["triangles"] = int(mesh.faces.shape[0])
        # Both come off the mesh loaded above. The first layer is always
        # positive here; it is kept to be compared between revisions.
        measured["first_layer_mm2"] = bed_area
        measured["overhang_mm2"] = overhang_area(mesh)
        metrics[name] = measured
        files[name] = {ext: f"{name}.{ext}" for ext in EXPORT_FORMATS}

        # Hand the shape back the way the model built it, exact and unmeshed.
        drop_mesh(obj)

    return files, metrics
