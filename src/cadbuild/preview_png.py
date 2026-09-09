#!/usr/bin/env python3
"""Render a preview PNG of one STL, for the build to ship next to the geometry.

Usage (the same command line as the parametric-3d-printing skill's preview.py,
so the two are interchangeable at the call site):

    python3 -m src.cadbuild.preview_png part.stl [out.png]
    python3 -m src.cadbuild.preview_png part.stl --views multi
    python3 -m src.cadbuild.preview_png part.stl --views iso --resolution 800

Exactly one STL per call, as there.

WHY THIS FILE EXISTS INSTEAD OF THE SKILL'S preview.py
------------------------------------------------------
The pictures have to be made where the geometry is made -- inside the hub's own
build process (`src/buildproc/`), which is the only place the CAD kernel and the
meshes exist -- so they land in the staging directory beside the geometry and
get published with it. That rules out both halves of the obvious answer:

  * the skill is not in the image, and shipping preview.py in the source
    tar does not help: it renders with pyrender on top of PyOpenGL, and the
    builder image has neither, nor the OSMesa/EGL context they need. Installing
    them per build costs ~20 s of apt+pip on every gate run and still does not
    work -- the PyPI PyOpenGL has no usable OSMesa binding on python 3.11 and
    the image has no EGL driver.
  * the image's own VTK cannot render either, for the same missing context.

What the image does have is matplotlib, and mplot3d is a real 3-D renderer:
it does the projection, the depth ordering and the drawing. This file feeds it
triangles and a camera; it does not rasterise anything itself. matplotlib,
trimesh, numpy and Pillow are all present in the builder image, and that is the
only place a model is built -- there is no local build path any more.

THE LIMITATION THAT COMES WITH THAT: mplot3d sorts polygons by depth and paints
them in order (painter's algorithm) -- there is no z-buffer. Back-face culling
plus silhouette edges gets an honest picture of a printable part, but a big
triangle in front of small detail can still lose the argument. This is a
smoke-test picture: "is that the part I meant, is it the right way up, is
anything obviously missing". For a considered look, open the viewer.
"""

import argparse
import math
import os
import sys

import numpy as np

import matplotlib
matplotlib.use("Agg")  # before pyplot: no display anywhere this runs
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Line3DCollection, Poly3DCollection

import trimesh
from PIL import Image, ImageDraw, ImageFont

# Pixels per view. `iso` renders one at 1.5x this, `multi` a 3x2 grid at 1x.
DEFAULT_VIEW_SIZE = 600
ISO_SCALE = 1.5

# The six views of the technical sheet, in reading order: (elev, azim, label).
MULTI_VIEWS = [
    (25.0, -60.0, "Isometric"),
    (5.0, -90.0, "Front (Y-)"),
    (5.0, 0.0, "Right (X+)"),
    (25.0, 120.0, "Back Isometric"),
    (89.0, -90.0, "Top (Z+)"),
    (-89.0, -90.0, "Bottom (Z-)"),
]
ISO_VIEW = (25.0, -60.0)

BACKGROUND = "#ececef"
PART_COLOR = np.array([0.40, 0.60, 0.90])
EDGE_COLOR = (0.13, 0.16, 0.20, 0.65)

# Grazing angle below which a face is treated as pointing away from the camera.
# Exactly 0 keeps the sliver of faces seen edge-on, which paint as noise.
FACING_TOL = 1e-3

# Triangles above which the picture is drawn from a downsampled copy.
#
# There was no ceiling at all, and mplot3d turns every triangle into a polygon
# patch, so the cost of a preview rose with the mesh and nothing stopped it.
# `assembled.stl` is written at the shipping tolerance of 0.01 mm, and on a
# real assembly that is hundreds of thousands of triangles -- measured here on
# a plate with 361 filleted holes: 184k triangles, 0.59 s for one view and
# 3.97 s for the six-view sheet, and a 1.3M-triangle mesh 1.86 s and 11 s. Per
# part, after every edit. That is not the minutes it was reported as, but it is
# unbounded, and the gate runs on a loop.
#
# 80k is where the cap goes: one view stays around a quarter of a second and a
# whole `multi` sheet inside two, whatever comes in. It is also comfortably
# more detail than this renderer can show -- there is no z-buffer here (see
# below), the picture is 600 to 900 pixels across, and a smoke-test view of a
# part does not improve past the point where triangles are smaller than a pixel.
#
# Decimation is vertex clustering, done here with numpy, because it must work
# with nothing installed beyond what the builder image already has: neither
# fast_simplification nor open3d is there, so trimesh's quadric decimation is
# not available. Clustering is cruder than quadrics and entirely good enough
# for a silhouette at this size.
MAX_RENDER_FACES = 80_000


def load_mesh(path):
    """Load an STL through trimesh, refusing the ways it can be empty.

    Same guards as the skill's mesh_io.load_mesh, and for the same reason: the
    tessellator emits zero-area triangles at the poles of spherical faces, and
    their zero-length edges make a closed mesh read as open.
    """
    try:
        mesh = trimesh.load(path, force="mesh")
    except Exception as exc:
        raise ValueError(f"failed to load {path}: {exc}") from exc
    if not hasattr(mesh, "vertices") or len(mesh.vertices) == 0:
        raise ValueError(f"{path} contains no vertices")
    if not hasattr(mesh, "faces") or len(mesh.faces) == 0:
        raise ValueError(f"{path} contains no triangles")
    if not np.isfinite(mesh.vertices).all():
        raise ValueError(f"{path} has non-finite vertex coordinates (NaN or inf)")
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.merge_vertices()
    return mesh


def _cluster(mesh, cell):
    """Weld every vertex onto a cubic grid of `cell` mm. Returns a new mesh.

    Vertex clustering: quantise the coordinates, merge everything that lands in
    one cell into its average, and drop the triangles that collapse to a line
    or a point when their corners merge. Crude next to a quadric decimation and
    with two properties that matter more here -- it needs nothing but numpy,
    and it keeps the silhouette, which is most of what this picture is.
    """
    low = mesh.bounds[0]
    keys = np.floor((mesh.vertices - low) / cell).astype(np.int64)
    _, first, inverse = np.unique(keys, axis=0, return_index=True,
                                  return_inverse=True)
    inverse = inverse.reshape(-1)

    # The cell's average vertex, not its centre: averaging keeps a flat face
    # flat instead of making it a staircase of the grid.
    count = np.bincount(inverse, minlength=len(first))
    vertices = np.zeros((len(first), 3))
    for axis in range(3):
        vertices[:, axis] = (np.bincount(inverse, weights=mesh.vertices[:, axis],
                                         minlength=len(first)) / count)

    faces = inverse[mesh.faces]
    keep = ((faces[:, 0] != faces[:, 1])
            & (faces[:, 1] != faces[:, 2])
            & (faces[:, 0] != faces[:, 2]))
    return vertices, faces[keep]


def _downsample(mesh, target):
    """A copy of `mesh` with at most about `target` triangles, plus a note.

    The grid size is found by bisection -- there is no formula from cell size
    to triangle count for an arbitrary mesh -- and a handful of steps is plenty
    because the answer only has to be in the right neighbourhood.
    """
    span = float(np.max(mesh.bounds[1] - mesh.bounds[0]))
    if span <= 0:
        return mesh, None

    low, high = span / 4096.0, span / 4.0
    best = None
    for _ in range(14):
        cell = math.sqrt(low * high)          # bisect in log space
        vertices, faces = _cluster(mesh, cell)
        if len(faces) > target:
            low = cell                        # too fine, coarsen
        else:
            best = (vertices, faces)
            high = cell                       # fits, try for more detail
        if high / low < 1.05:
            break

    if best is None:
        return mesh, None
    vertices, faces = best
    if len(faces) == 0 or len(faces) >= len(mesh.faces):
        return mesh, None

    # process=False: no welding, no repair, no reordering. The arrays are
    # already what we want drawn, and trimesh's cleanup on a clustered mesh
    # costs more than the rendering it is feeding.
    drawn = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    note = (f"drawn downsampled: {len(faces):,} of {len(mesh.faces):,} triangles")
    return drawn, note


def _fit_for_render(mesh, max_faces=MAX_RENDER_FACES):
    """The mesh to draw and the note to print, given the ceiling."""
    if max_faces is None or len(mesh.faces) <= max_faces:
        return mesh, None
    try:
        return _downsample(mesh, max_faces)
    except Exception as exc:
        # A picture from the full mesh is slow; no picture at all is a failed
        # build. Draw it and say the cap did not apply.
        print(f"warning: could not downsample for rendering "
              f"({type(exc).__name__}: {exc}); drawing all "
              f"{len(mesh.faces):,} triangles", file=sys.stderr)
        return mesh, None


def _eye(elev, azim):
    """Unit vector from the model towards the camera."""
    e, a = math.radians(elev), math.radians(azim)
    return np.array([math.cos(e) * math.cos(a),
                     math.cos(e) * math.sin(a),
                     math.sin(e)])


def _shading(normals, eye):
    """Lambert on a key light and a fill light, plus ambient.

    Three lights, not one: with a single source every face turned away from it
    goes to the ambient floor and the part reads as a flat blue cut-out. The
    fill comes from the other side at a third of the strength, and the third
    one points up -- without it the Bottom (Z-) view of the six-view sheet is
    a black rectangle, which is exactly the view a first-layer problem shows
    up in.
    """
    key = np.array([0.40, -0.70, 0.60])
    fill = np.array([-0.60, 0.30, 0.40])
    under = np.array([0.10, 0.30, -0.95])
    key /= np.linalg.norm(key)
    fill /= np.linalg.norm(fill)
    under /= np.linalg.norm(under)
    level = (0.28
             + 0.58 * np.clip(normals @ key, 0.0, 1.0)
             + 0.22 * np.clip(normals @ fill, 0.0, 1.0)
             + 0.30 * np.clip(normals @ under, 0.0, 1.0))
    return np.clip(PART_COLOR[None, :] * level[:, None], 0.0, 1.0)


def _silhouette(mesh, facing):
    """Segments where a front-facing triangle meets a back-facing one.

    The outline of the part and of every hole in it, and nothing else. Sharp
    interior creases were tried and dropped: mplot3d draws a line collection
    over the whole surface regardless of depth, so creases on the far side
    show through the near wall and the part reads as glass. A silhouette edge
    is, by construction, on the boundary of what is drawn.
    """
    pairs = mesh.face_adjacency
    if len(pairs) == 0:
        return np.zeros((0, 2, 3))
    on_edge = facing[pairs[:, 0]] != facing[pairs[:, 1]]
    return mesh.vertices[mesh.face_adjacency_edges[on_edge]]


def render_view(mesh, elev, azim, size):
    """One camera angle of one mesh, as a PIL image."""
    eye = _eye(elev, azim)
    facing = (mesh.face_normals @ eye) > FACING_TOL
    triangles = mesh.vertices[mesh.faces][facing]

    figure = plt.figure(figsize=(size / 100.0, size / 100.0), dpi=100)
    try:
        axes = figure.add_subplot(projection="3d")
        # Orthographic: a printable part is judged on whether edges line up,
        # and perspective bends exactly that.
        axes.set_proj_type("ortho")
        if len(triangles):
            axes.add_collection3d(Poly3DCollection(
                triangles, facecolors=_shading(mesh.face_normals[facing], eye),
                edgecolors="none", zsort="average",
            ))
        segments = _silhouette(mesh, facing)
        if len(segments):
            axes.add_collection3d(Line3DCollection(
                segments, colors=EDGE_COLOR, linewidths=0.5))

        # One cube around the part on all three axes, so the aspect is true and
        # the six views of a sheet are all at the same scale.
        low, high = mesh.bounds
        centre = (low + high) / 2.0
        half = max(float(np.max(high - low)) / 2.0, 1e-6) * 1.02
        axes.set_xlim(centre[0] - half, centre[0] + half)
        axes.set_ylim(centre[1] - half, centre[1] + half)
        axes.set_zlim(centre[2] - half, centre[2] + half)
        axes.set_box_aspect((1, 1, 1))
        axes.view_init(elev=elev, azim=azim)
        axes.set_axis_off()
        figure.subplots_adjust(0, 0, 1, 1)
        # mplot3d keeps a wide margin around the axes for tick labels that were
        # turned off above. Overflowing the axes past the figure reclaims it;
        # the cube set above is what keeps the part inside the frame.
        axes.set_position((-0.14, -0.14, 1.28, 1.28))

        figure.canvas.draw()
        image = Image.frombytes(
            "RGBA", figure.canvas.get_width_height(),
            bytes(figure.canvas.buffer_rgba()),
        ).convert("RGB")
    finally:
        plt.close(figure)
    return image


# --------------------------------------------------------------------------
# Composition
# --------------------------------------------------------------------------

def _font(size):
    """A real sans font if one is reachable, else PIL's bitmap default.

    matplotlib ships DejaVuSans with itself, which is the only one of these
    guaranteed to exist inside the builder image -- it has no system fonts at
    all, and PIL's default is a 6-pixel bitmap that makes the footer unreadable.
    """
    candidates = [
        os.path.join(os.path.dirname(matplotlib.__file__),
                     "mpl-data", "fonts", "ttf", "DejaVuSans.ttf"),
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _info_lines(mesh, parts=None):
    """The two footer lines: what the part is, and whether the mesh is sane.

    `parts` is how many parts went into the file, and the caller has to say:
    it is a fact about the build, not about the mesh. Counting the mesh's own
    bodies was tried and is wrong. `merge_vertices` welds the seam where two
    parts touch, an assembly of touching parts comes back as ONE body, and the
    footer then says "NOT watertight" -- which for an assembly is both true and
    meaningless. Every assembly of every project was signed that way, including
    the template's own, and a flag that is always on is a flag nobody reads by
    the time a real part is open in front of them.
    """
    extents = mesh.bounding_box.extents
    first = (f"Bounding box: {extents[0]:.1f} x {extents[1]:.1f} x "
             f"{extents[2]:.1f} mm")
    second = f"Triangles: {len(mesh.faces):,}"
    if parts is None:
        # Nobody said, so fall back to the mesh -- which can only see the
        # bodies it can separate, and undercounts a welded assembly.
        parts = int(getattr(mesh, "body_count", 1) or 1)
    if parts > 1:
        second += f"  |  {parts} parts"
    else:
        second += f"  |  {'watertight' if mesh.is_watertight else 'NOT watertight'}"
    try:
        volume = abs(float(mesh.volume))
        first += f"  |  Volume: {volume / 1000.0:.1f} cm³"
        # PLA at 1.24 g/cm3, solid. A number to sanity-check the scale by, not
        # a slicer estimate -- infill and walls are not in it.
        second += f"  |  PLA solid: ~{volume / 1000.0 * 1.24:.0f} g"
    except Exception:
        pass
    return first, second


def _compose(tiles, mesh, title, subtitle, columns, parts=None):
    """Lay rendered tiles out in a grid under a title and over a footer."""
    gap = 4
    label_height = 24 if len(tiles) > 1 else 0
    header = 40 + (20 if subtitle else 0)
    footer = 55
    size = tiles[0][0].width
    rows = (len(tiles) + columns - 1) // columns

    width = size * columns + gap * (columns - 1)
    height = (size * rows + gap * (rows - 1) + header + footer
              + label_height * rows)
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    draw.text((width // 2, 12), title, fill="black", font=_font(20), anchor="mt")
    if subtitle:
        draw.text((width // 2, 34), subtitle, fill="#666666",
                  font=_font(14), anchor="mt")

    for index, (tile, label) in enumerate(tiles):
        column, row = index % columns, index // columns
        x = column * (size + gap)
        y = header + label_height + row * (size + gap + label_height)
        canvas.paste(tile, (x, y))
        if label:
            draw.text((x + size // 2, y - 4), label, fill="#444444",
                      font=_font(14), anchor="mb")

    first, second = _info_lines(mesh, parts)
    info = _font(13)
    draw.text((width // 2, height - 30), first, fill="gray", font=info, anchor="mb")
    draw.text((width // 2, height - 10), second, fill="gray", font=info, anchor="mb")
    return canvas


def render(stl_path, output_path, views="iso", title=None, subtitle=None,
           resolution=DEFAULT_VIEW_SIZE, max_faces=MAX_RENDER_FACES,
           parts=None):
    """Render `stl_path` to `output_path`. Returns the path written.

    `views` is "iso" (one isometric, the build default) or "multi" (the six-view
    sheet). Importable so a build can render several parts without paying for
    a fresh matplotlib import per part; the CLI below is the same call.

    `parts` is how many parts the file holds. The caller knows -- the build
    wrote the file and counted them -- and the footer needs it, because a mesh
    cannot be asked: touching parts weld into one body when the vertices are
    merged, and every assembly then reports itself as one body that is not
    watertight. Leave it None for a file that is one part, or when there is
    genuinely nobody to ask.

    A mesh over `max_faces` triangles is drawn from a downsampled copy, and the
    picture says so. The footer always describes the REAL mesh -- its triangle
    count, its volume, whether it is watertight -- because those are facts about
    the part and the downsampling is a fact about the drawing.
    """
    mesh = load_mesh(stl_path)
    drawn, note = _fit_for_render(mesh, max_faces)
    if title is None:
        stem = os.path.splitext(os.path.basename(stl_path))[0]
        title = stem.replace("_", " ").title()
    if note:
        subtitle = f"{subtitle} · {note}" if subtitle else note

    if views == "multi":
        tiles = [(render_view(drawn, elev, azim, resolution), label)
                 for elev, azim, label in MULTI_VIEWS]
        columns = 3
    else:
        elev, azim = ISO_VIEW
        tiles = [(render_view(drawn, elev, azim, int(resolution * ISO_SCALE)), "")]
        columns = 1

    _compose(tiles, mesh, title, subtitle, columns, parts).save(output_path)
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Render a preview PNG of one STL")
    parser.add_argument("stl_file", help="path to the STL to render")
    parser.add_argument("output", nargs="?", default=None,
                        help="output PNG (default: <stl>_preview.png)")
    parser.add_argument("--views", choices=["iso", "multi"], default="iso",
                        help="one isometric (default) or the six-view sheet")
    parser.add_argument("--title", default=None, help="title above the picture")
    parser.add_argument("--subtitle", default=None, help="line under the title")
    parser.add_argument("--resolution", type=int, default=DEFAULT_VIEW_SIZE,
                        help=f"pixels per view (default: {DEFAULT_VIEW_SIZE})")
    parser.add_argument("--parts", type=int, default=None,
                        help="how many parts the file holds; the footer says "
                             "watertight or not only for a single part")
    parser.add_argument("--strict", action="store_true",
                        help="exit 2 if the mesh is not watertight")
    args = parser.parse_args()

    output = args.output or (os.path.splitext(args.stl_file)[0] + "_preview.png")

    try:
        mesh = load_mesh(args.stl_file)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.strict and not mesh.is_watertight:
        print(f"ERROR: {args.stl_file} is not watertight and --strict is set",
              file=sys.stderr)
        return 2

    render(args.stl_file, output, views=args.views, title=args.title,
           subtitle=args.subtitle, resolution=args.resolution,
           parts=args.parts)
    print(f"preview: {output} ({os.path.getsize(output)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
