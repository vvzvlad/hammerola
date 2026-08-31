#!/usr/bin/env python3
"""Export every printable catalogue entry to STEP/STL/3MF, gating its geometry.

WHAT A PART IS is not decided here any more and never was decided well: this
file used to open with `printables()`, a second dict of geometry beside the one
the views drew, and everything downstream spent its time working out which
entry of one was which entry of the other. There is one catalogue now
(parts.py) and this reads the entries of it whose kind says they go on a bed.
"""

from .artifacts import (ASSEMBLED_STEM, PREVIEW_SUFFIX, PRINT_VIEW_ID,
                        STL_ANGULAR_TOLERANCE, STL_TOLERANCE)
from .errors import BuildError
from .geometry import as_shape, drop_mesh
from .parts import check_stem, printable_keys


# The three formats every printable is published in, and the order they are
# written in. STEP is the exact solid for whoever wants to edit it, STL is what
# a slicer eats, 3MF carries units and is what a modern slicer prefers.
EXPORT_FORMATS = ("step", "stl", "3mf")


def overview_meshes(plate):
    """`{stem: filename}` for the MESHES that are about the WHOLE build.

    Two at most -- the glued assembly and the print plate -- and NEITHER IS A
    BUTTON. The only argument that ever put them on one was that `downloads` was
    the single channel through which a client could be told a file exists; this
    map is that channel now, so the argument is gone with it. What is left is the
    case against: `assembled.stl` has been written and served for this hub's
    whole life with nobody asking for a button, and the assembly is already on
    the page in 3D. `print.stl` is worse than unnecessary -- it is a plate, and a
    button on a public build page invites somebody to slice it. The plate's job
    is the PICTURE, the one thing that catches a part lying face down.

    KEPT OUT OF THE PARTS MAP FOR A SECOND REASON that holds whatever the
    buttons do: a file filed under a part is filed under a CATALOGUE KEY, and
    `assembled` is not one -- it cannot be, because parts.RESERVED_STEMS
    refuses it. So there is no part for either of these files to belong to, and
    the map they belong to is this one.

    SEPARATE FROM `previews` FOR ONE REASON, and it is the whole reason: both are
    keyed by the stem, and `assembled` names two files -- `assembled.stl` here,
    `assembled_preview.png` there. One map keyed that way loses one of them.

    ONLY WHAT WAS ACTUALLY WRITTEN GETS DECLARED, which is why the evidence is
    passed in rather than assumed: `plate` says whether `export_print_plate`
    wrote one, and a project need not have a `print` view at all.
    `assembled.stl` is unconditional because `export_assembled` either writes it
    or raises. An entry pointing at a file that is not there is not a cosmetic
    problem: the hub only accepts names that are keys of the output hash
    (`render.build_meta`), so declaring an INTENTION instead of a FACT turns a
    soft degradation into a refused publication.
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

    ALL OF THEM, the per-part ones included, and none of them a button either. A
    preview is looked at rather than downloaded, and ten parts would be ten
    buttons under a menu whose other rows are things you print. DECLARED all the
    same, and that is the half this map exists for: an undeclared file can only
    be reached by assembling its URL by hand, and an instruction that rests on a
    hand-assembled URL breaks silently the day a name moves.

    KEYED BY THE STEM THE PICTURE IS OF, because the reader that follows wants to
    pick ONE out: the assembled frame for a project card (issue #34), a part's
    own picture for its tree row. Those readers hold a catalogue key, and the
    stem is that key. Nothing in the keyspace is ambiguous, because
    `parts.RESERVED_STEMS` refuses a part called `assembled` or `print`.

    `written` is what `render_previews` returned -- the PNGs it truly wrote,
    which is `[]` on a python with no rendering stack, a degradation this build
    supports on purpose -- for the reason overview_meshes takes its evidence
    rather than assuming it.
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


def export_printables(catalogue, out_dir):
    """Export STEP/STL/3MF for every printable, gating each one on geometry.

    Returns `(files, metrics)` -- `{key: {ext: filename}}` for what was written,
    and the numbers the gate measured on the way past, one entry per part. The
    metrics are a by-product and cost nothing: every one of them is a value this
    function already had in a local variable.

    THE FILE MAP IS KEYED BY THE CATALOGUE KEY and its inner keys are the
    formats, which is a change of shape rather than of content: it used to be
    `{label: filename}` with the label being `<part>.<ext>` (or a bare `stl` on
    a single-part project), and every reader then had to split the part back out
    of the label -- `filesByPart` in the viewer did exactly that, by cutting at
    the last dot, so a part with a dot in its name landed on the wrong row. The
    ownership is now stated instead of parsed, which also takes the hub's
    32-character label ceiling out of the build: there is no label.
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

        # Measured HERE, before the export, and that is not tidiness: exportStl
        # meshes the shape in place, and from then on BoundingBox() is the box
        # of the MESH, which reads BIGGER than the shape and never smaller. The
        # SIGN is the whole of what matters here; how much bigger depends on the
        # shape, on both tolerances and on the axis, so the figures live in one
        # place with the whole signature attached -- geometry.drop_mesh, which
        # also has what the sign costs. Face, edge and solid counts are
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
                "body. Fuse them into one solid, or give each piece a "
                "catalogue entry of its own."
            )

        print(f"  {name}: valid, volume {volume / 1000.0:.2f} cm3, watertight, "
              f"one body, {mesh.faces.shape[0]} triangles")

        measured["watertight"] = bool(watertight)
        measured["triangles"] = int(mesh.faces.shape[0])
        metrics[name] = measured
        files[name] = {ext: f"{name}.{ext}" for ext in EXPORT_FORMATS}

        # Hand the shape back the way the model built it, exact and unmeshed.
        drop_mesh(obj)

    return files, metrics
