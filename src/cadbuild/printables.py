#!/usr/bin/env python3
"""Export every printable to STEP/STL/3MF, gating each one on its geometry."""

from .artifacts import ASSEMBLED_STEM, STL_ANGULAR_TOLERANCE, STL_TOLERANCE
from .errors import BuildError
from .geometry import as_shape, drop_mesh
from .hubspec import LABEL_RE, MEMBER_RE


def download_labels(printables):
    """`{label: filename}` for the download buttons, worked out from names alone.

    The label is what the hub puts on the button, and the hub caps it at 32
    characters (SPEC 7.1). Nothing about that needs a solid -- it is a rule
    about a string -- so it is checked with the rest of the names, before the
    build computes or writes anything.

    It used to live inside the export loop, one part at a time, which meant a
    name two characters over the limit went red only after every part before it
    had been built, gated, exported to STEP/STL/3MF and meshed for the
    watertightness check. The answer was knowable from the source alone, and
    the build spent minutes arriving at it.
    """
    single = len(printables) == 1
    labels = {}
    for name in printables:
        for ext in ("step", "stl", "3mf"):
            label = ext if single else f"{name}.{ext}"
            if not LABEL_RE.match(label):
                raise BuildError(
                    f"printable {name!r} makes the download label {label!r}, "
                    f"which the hub will not take: a label is 1 to 32 "
                    f"characters of letters, digits, dot, dash and underscore, "
                    f"and this one is {len(label)}. Shorten the printable name."
                )
            labels[label] = f"{name}.{ext}"
    return labels


def collect_printables(model):
    """printables(), with the names checked before any work is done on them.

    Split out from the export so the view gates below can run first: they only
    read names and bounding boxes, and a bounding box is only the shape's own
    until something tessellates it (see drop_mesh).

    Every name rule lives here, including the hub's limit on the download
    labels the names turn into -- see download_labels for why that one is not
    left to the export.
    """
    printables = model.printables()
    if not isinstance(printables, dict) or not printables:
        raise BuildError("printables() must return a non-empty dict")

    for name, obj in printables.items():
        if not MEMBER_RE.match(name):
            raise BuildError(
                f"printable name {name!r} is not usable as a filename stem "
                "(allowed: letters, digits, dot, dash, underscore)"
            )
        if name == ASSEMBLED_STEM:
            raise BuildError(
                f"printable {name!r} collides with {ASSEMBLED_STEM}.stl, the "
                "glued-together assembly this build writes next to the parts. "
                "Call the part something else."
            )
        as_shape(obj, f"printable {name!r}")

    # The download labels are made out of these names, so their rule is a name
    # rule and belongs with the others -- before anything is computed.
    download_labels(printables)
    return printables


def export_printables(printables, out_dir):
    """Export STEP/STL/3MF per printable and gate each one on geometry.

    Returns `(downloads, metrics)` -- the download map, and the numbers the
    gate measured on the way past, one entry per part. The metrics are a
    by-product and cost nothing: every one of them is a value this function
    already had in a local variable.
    """
    import cadquery as cq
    from cadquery import exporters
    import trimesh

    # Already validated by collect_printables, before any of this ran.
    downloads = download_labels(printables)
    metrics = {}

    for name, obj in printables.items():
        shape = as_shape(obj, f"printable {name!r}")

        # Gate part 1 -- topology and volume, before anything is written.
        if not shape.isValid():
            raise BuildError(f"printable {name!r} is not a valid solid (isValid() == False)")
        volume = shape.Volume()
        if volume <= 0:
            raise BuildError(f"printable {name!r} has non-positive volume ({volume})")

        # Measured HERE, before the export, and that is not tidiness: exportStl
        # meshes the shape in place, and from then on BoundingBox() is the
        # box of the MESH, out by tenths of a millimetre on anything filleted
        # (the same trap drop_mesh exists for). Face, edge and solid counts are
        # topology and do not care, but they are taken here too so the whole
        # measurement comes off one unmeshed shape.
        box = shape.BoundingBox()
        measured = {
            "volume_mm3": volume,
            "bbox_mm": [box.xlen, box.ylen, box.zlen],
            "faces": len(shape.Faces()),
            "edges": len(shape.Edges()),
            "solids": len(shape.Solids()),
        }

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
                "body. Fuse them into one solid, or hand each piece back from "
                "printables() as a printable of its own."
            )

        print(f"  {name}: valid, volume {volume / 1000.0:.2f} cm3, watertight, "
              f"one body, {mesh.faces.shape[0]} faces")

        measured["watertight"] = bool(watertight)
        measured["triangles"] = int(mesh.faces.shape[0])
        metrics[name] = measured

        # Hand the shape back the way the model built it, exact and unmeshed.
        drop_mesh(obj)

    return downloads, metrics
