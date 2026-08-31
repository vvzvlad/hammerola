#!/usr/bin/env python3
"""Export every printable to STEP/STL/3MF, gating each one on its geometry."""

from .artifacts import (ASSEMBLED_STEM, PREVIEW_SUFFIX, STL_ANGULAR_TOLERANCE,
                        STL_TOLERANCE)
from .errors import BuildError
from .geometry import as_shape, drop_mesh
from .hubspec import LABEL_RE, MEMBER_RE
from .views import PRINT_VIEW_ID


# The stems this build keeps for ITSELF, next to the parts, and what each one is.
# A printable landing on one of them is worse than an awkward name: it is
# exported to `<stem>.stl` by the loop below, the whole-build artefact
# overwrites that file afterwards, and the hub hashes the result later still --
# so the published `print.stl` would be the plate rather than the part, under
# the part's own download button, with nothing anywhere saying so.
#
# THE HAZARD IS CONDITIONAL AND THE RESERVATION IS NOT, and that asymmetry is the
# half a reader will not work out alone. `assembled.stl` is written by every
# build, so for that stem the collision above is certain; `print.stl` is written
# only by a project that HAS a `print` view, and a project without one would come
# to no harm from a part called `print`. The name is refused there too, because a
# reservation that came and went with a view in model.py could not be relied on
# -- and the day that view is added is long after the part was named. So nothing
# here promises the file, which is why the refusal below is worded as a
# reservation rather than as a collision.
RESERVED_STEMS = {
    ASSEMBLED_STEM: "the glued-together assembly",
    PRINT_VIEW_ID: "the print plate",
}


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


def _check_stem(stem, made):
    """The key of a whole-build map, or a BuildError naming the rename.

    MEMBER_RE AND NOT LABEL_RE, and the two differ in the place that matters
    here: LABEL_RE caps a button caption at 32 characters, and nothing below is
    a caption. A part name has a ceiling of its own -- MEMBER_RE's 128
    characters -- and it is four times the caption's, which is what makes the
    difference reachable: a name of 48 characters is legal here and refused
    there. Such a project publishes TODAY on a single printable, because its
    download labels degenerate to `stl`/`step`/`3mf` with the name gone from
    them (see download_labels), so nothing about it ever met the caption rule.
    Holding this key to a caption's ceiling would stop it publishing, with the
    picture of its one part as the reason.

    MEMBER_RE is the rule every printable name already passed in
    collect_printables, so what this can actually catch is the other source of
    stems: a rename of ASSEMBLED_STEM or PREVIEW_SUFFIX in cadbuild.artifacts,
    or of PRINT_VIEW_ID in cadbuild.views. Unchecked, that reaches the hub as an
    opaque 422 on the push with the build itself reporting success.
    """
    if not MEMBER_RE.match(stem):
        raise BuildError(
            f"{made} would be declared under the key {stem!r}, which is not a "
            "filename stem: letters, digits, dot, dash and underscore, "
            "starting with a letter or a digit. Every part name passed that "
            "rule already, so a rename is what reaches this -- of "
            "ASSEMBLED_STEM or PREVIEW_SUFFIX in cadbuild.artifacts, or of "
            "PRINT_VIEW_ID in cadbuild.views."
        )
    return stem


def overview_meshes(plate):
    """`{stem: filename}` for the MESHES that are about the WHOLE build.

    Two at most -- the glued assembly and the print plate -- and NEITHER IS A
    BUTTON. The only argument that ever put them on one was that `downloads` was
    the single channel through which a client could be told a file exists; this
    map is that channel now, so the argument is gone with it. What is left is the
    case against: `assembled.stl` has been written and served for this hub's
    whole life with nobody asking for a button, and the assembly is already on
    the page in 3D. `print.stl` is worse than unnecessary -- the plate is
    whatever the `print` view holds, nothing requires that to be printable parts
    only, and a button on a public build page invites somebody to slice a plate
    with a mock of a purchased bearing on it. The plate's job is the PICTURE, the
    one thing that catches a part lying face down.

    KEPT OUT OF `downloads` FOR A SECOND REASON that holds whatever the buttons
    do: that map is read as PER PART, cut up by splitting `<part>.<ext>` off each
    file name (`filesByPart` in ui/src/HammerolaViewer.jsx). `assembled.stl` has
    that shape exactly, so a whole-build file left in there is filed under a part
    called `assembled` -- a name a view part may legally carry and no printable
    can have, so the row it lands on is guaranteed to be the wrong one.

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
        meshes[_check_stem(stem, f"the mesh {name}")] = name
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
    own picture for its tree row. Those readers hold a part name, and the stem is
    that name. Nothing in the keyspace is ambiguous, because `RESERVED_STEMS`
    refuses a printable called `assembled` or `print`.

    `written` is what `render_previews` returned -- the PNGs it truly wrote,
    which is `[]` on a python with no rendering stack, a degradation this build
    supports on purpose -- for the reason overview_meshes takes its evidence
    rather than assuming it.
    """
    previews = {}
    for name in written:
        # A picture is written as `<stem>{PREVIEW_SUFFIX}` by render_previews and
        # there is no other writer; a name of any other shape has no stem to be
        # declared under, and the empty string _check_stem then refuses is the
        # same failure as an illegal one.
        stem = name[:-len(PREVIEW_SUFFIX)] if name.endswith(PREVIEW_SUFFIX) else ""
        previews[_check_stem(stem, f"the picture {name!r}")] = name
    return previews


def collect_printables(model):
    """printables(), with the names checked before any work is done on them.

    Split out from the export so the view gates below can run first: they only
    read names and bounding boxes, and a bounding box is only the shape's own
    until something tessellates it -- after that it reads BIGGER, in the one
    direction, which is what makes the order matter rather than merely tidy
    (see drop_mesh for the measurements and for what the sign costs).

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
        if name in RESERVED_STEMS:
            # A RESERVATION, worded as one. Whether this build would really
            # write `<stem>.stl` depends on the project -- there is no
            # `print.stl` without a `print` view -- so a message saying it does
            # would be telling an author about a file their own build does not
            # produce, and `print` is an entirely ordinary name for a single
            # printed part.
            raise BuildError(
                f"printable name {name!r} is reserved: {name}.stl is the name "
                f"this build keeps for {RESERVED_STEMS[name]}. Call the part "
                "something else."
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
                "body. Fuse them into one solid, or hand each piece back from "
                "printables() as a printable of its own."
            )

        print(f"  {name}: valid, volume {volume / 1000.0:.2f} cm3, watertight, "
              f"one body, {mesh.faces.shape[0]} triangles")

        measured["watertight"] = bool(watertight)
        measured["triangles"] = int(mesh.faces.shape[0])
        metrics[name] = measured

        # Hand the shape back the way the model built it, exact and unmeshed.
        drop_mesh(obj)

    return downloads, metrics
