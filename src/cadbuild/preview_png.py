#!/usr/bin/env python3
"""Render a preview PNG of one STL, for the build to ship next to the geometry.

Usage (the same command line as the parametric-3d-printing skill's preview.py,
so the two are interchangeable at the call site):

    python3 -m src.cadbuild.preview_png part.stl [out.png]
    python3 -m src.cadbuild.preview_png part.stl --views multi
    python3 -m src.cadbuild.preview_png part.stl --views iso --resolution 800

Exactly one STL per call, as there.

The pictures are made inside the hub's build process (`src/buildproc/`), the
only place the meshes exist. The builder image has no OpenGL context (no
OSMesa/EGL), so neither pyrender nor VTK can render there. The picture is
therefore rasterised in numpy: project the triangles orthographically, cull
back faces, and resolve the rest against a z-buffer. A z-buffer decides
occlusion per pixel, unlike painter's-algorithm renderers, and its cost is
dominated by pixels covered rather than triangle count.

What is drawn and what the footer describes are two different documents for a
picture of a whole scene. `assembled_preview.png` and `print_preview.png` are
drawn from the TESSELLATED VIEW FILE the browser itself loads (`scene=`), so
every part is in its catalogue colour, at its own alpha, standing where its
`loc` puts it -- literally what a reader sees in the viewer. The footer
underneath describes the STL that ships beside it: its bounding box, its volume,
its triangle count, whether it is watertight. A picture of the scene over the
facts about the mesh.

This is still a smoke-test picture: "is that the part I meant, is it the right
way up, is anything obviously missing". For a considered look, open the viewer.
"""

import argparse
import json
import math
import os
import sys

import numpy as np

# matplotlib is imported only so `_font()` can read DejaVuSans from its data
# directory: the builder image has no system fonts and PIL's default is a
# 6-pixel bitmap. requirements.txt and ci/smoke.py declare it for this.
import matplotlib

import trimesh
from PIL import Image, ImageDraw, ImageFont

# Pixels ACROSS one view -- the tile's width. `iso` renders one at 1.5x this,
# `multi` a 3x2 grid at 1x. The height follows from VIEW_ASPECT below.
DEFAULT_VIEW_SIZE = 600
ISO_SCALE = 1.5

# The shape of one rendered tile: width over height. It is the render's aspect,
# not the sheet's: `_compose` adds a title band and a footer.
#
# Landscape because the front page's wide cards fit the whole picture without
# cropping (`ui/src/HammerolaEntry.jsx`); a square render would be letterboxed.
# The card's own width is fluid, so there is no exact aspect to match.
VIEW_ASPECT = 16 / 9

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

# What one part is painted when nobody says: the picture of a single STL, and
# the CLI. A picture of a whole scene never reaches this -- every leaf of a view
# document carries its own colour, which is the point of drawing from one.
DEFAULT_PART_COLOR = "#4682b4"

# Grazing angle below which a face is treated as pointing away from the camera.
# Exactly 0 keeps the sliver of faces seen edge-on, which paint as noise.
FACING_TOL = 1e-3

# How many (triangle, scanline) pairs `_fragments` expands in one step.
#
# It bounds the (triangle, row) stage; the pixel stage is expanded from one
# chunk's rows, so it is bounded too. Measured on a 1,310,720-triangle mesh at
# 900 px, one part, as peak RSS over baseline and render time:
#
#     budget      peak RSS    render
#     4,000,000     514 MB     0.40 s
#       500,000     467 MB     0.36 s
#       100,000     357 MB     0.30 s
#
# Smaller chunks are leaner and slightly faster. 250,000 sits inside the
# measured bracket (not itself a measured row). The process ceiling is
# RLIMIT_AS = 6 GiB (`src/buildproc/limits.py`, `memory_bytes`).
#
# Chunking cannot move a pixel: every chunk is resolved against the same
# z-buffer (`test_where_a_chunk_boundary_falls_cannot_move_a_pixel`).
FRAGMENT_BUDGET = 250_000


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


# --------------------------------------------------------------------------
# The scene the viewer draws
# --------------------------------------------------------------------------

# A `loc` that moves nothing: the identity of the composition below, and what a
# node with no placement of its own contributes.
IDENTITY_LOC = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def _rotation(quaternion):
    """The 3x3 rotation matrix of a `loc`'s `[qx, qy, qz, qw]`.

    Normalised first: the tessellator writes a unit quaternion, and a rounded
    one would scale the part it turns rather than only turning it.
    """
    x, y, z, w = quaternion
    length = math.sqrt(x * x + y * y + z * z + w * w) or 1.0
    x, y, z, w = x / length, y / length, z / length, w / length
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def _placed(parent, loc):
    """`loc` composed onto the placement `parent`, as `(rotation, offset)`.

    The parent's rotation turns the child's own translation as well as the
    child's rotation -- that is what makes a group that is moved carry the
    parts inside it, and it is why the composition cannot be a sum of offsets.
    """
    translation, quaternion = loc
    rotation, offset = parent
    return (rotation @ _rotation(quaternion),
            rotation @ np.asarray(translation, dtype=np.float64) + offset)


def _collect(node, placement, into):
    """Append every drawable leaf under `node` to `into`, placed where it stands.

    A node with a `parts` list is a group and carries nothing of its own; a node
    with a `shape` is a leaf. The recursion is the document's own nesting, and
    the placement composes down through it.
    """
    here = _placed(placement, node.get("loc") or IDENTITY_LOC)
    children = node.get("parts")
    if isinstance(children, list):
        for child in children:
            _collect(child, here, into)
        return
    shape = node.get("shape") or {}
    if "vertices" not in shape:
        return
    vertices = np.asarray(shape["vertices"], dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(shape["triangles"], dtype=np.int64).reshape(-1, 3)
    rotation, offset = here
    into.append({"vertices": vertices @ rotation.T + offset,
                 "faces": faces,
                 "color": node["color"],
                 "alpha": float(node["alpha"])})


def load_scene(path):
    """The leaves of a tessellated view document, in the shape `render_view` takes.

    `path` is one of the files the build writes for the browser --
    `assembled.json`, `print.json` -- and reading THAT rather than the STL is
    what makes the picture match the viewer: the document carries a colour, an
    alpha and a placement per part, and the mesh beside it carries none of the
    three.

    Every leaf comes back as `{"vertices", "faces", "color", "alpha"}` with its
    `loc` already applied, composed from the root down. The vertices in the
    document are the part's OWN coordinates and the `loc` is where the view puts
    it, so a picture drawn without this step is every part piled on the origin.
    """
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    parts = []
    _collect(document, (np.eye(3), np.zeros(3)), parts)
    return parts


# --------------------------------------------------------------------------
# The rasteriser
# --------------------------------------------------------------------------

def _hex_rgb(text):
    """`"#4682b4"` as three floats in 0..1."""
    text = text.lstrip("#")
    return np.array([int(text[at:at + 2], 16) / 255.0 for at in (0, 2, 4)])


def _basis(elev, azim):
    """The camera's `(right, up, forward)` for one elevation and azimuth.

    `forward` is the unit vector from the model TOWARDS the camera, so a point
    with a larger `@ forward` is nearer; `right` and `up` span the image plane.
    The hint the frame is built from is +Z, swapped for +Y when the camera is
    within about two and a half degrees of straight down the Z axis -- the
    `0.999` below is an elevation past 87.4, not past 89. Which is not a corner
    case here but two of the six views of the sheet, Top (Z+) and Bottom (Z-),
    where `cross(+Z, forward)` is zero and there would be no frame at all.
    """
    e, a = math.radians(elev), math.radians(azim)
    forward = np.array([math.cos(e) * math.cos(a),
                        math.cos(e) * math.sin(a),
                        math.sin(e)])
    hint = np.array([0.0, 0.0, 1.0])
    if abs(forward @ hint) > 0.999:
        hint = np.array([0.0, 1.0, 0.0])
    right = np.cross(hint, forward)
    right /= np.linalg.norm(right)
    return right, np.cross(forward, right), forward


def _shading(normals, base):
    """Lambert on a key light and a fill light, plus ambient, over `base`.

    Three lights, not one: with a single source every face turned away from it
    goes to the ambient floor and the part reads as a flat cut-out. The fill
    comes from the other side at a third of the strength, and the third one
    points up -- without it the Bottom (Z-) view of the six-view sheet is a
    black rectangle, which is exactly the view a first-layer problem shows up in.

    `base` is the part's own colour; the levels are tuned for which faces read
    as lit, independent of hue.
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
    return np.clip(base[None, :] * level[:, None], 0.0, 1.0)


def _fragments(tris, width, height):
    """Every pixel each triangle covers: `(pixel index, depth, triangle index)`.

    A scanline rasteriser done in whole-array steps rather than pixel by pixel.
    For each triangle, the rows its vertical span touches; for each of those
    rows, where the three edges cross the row's centre line, which bounds the
    run of pixels the triangle covers there; for each pixel of the run, the
    depth interpolated from the three corners by barycentric weights. The only
    python loops are over the three edges and over the chunks.

    PIXEL CENTRES ARE AT +0.5 and every bound is taken at one: a pixel belongs
    to the triangle covering its CENTRE. Half a pixel out in either direction
    and neighbouring triangles either overlap or leave a seam of background
    between them, all over the surface.

    `tris` is `(n, 3, 3)` in screen space -- x, y in pixels, z the depth the
    caller's z-buffer compares. The tile is `width x height` and the two are
    separate everywhere: rows clip against `height`, columns against `width`,
    and a pixel's index into the caller's flat buffer is `row * width + col`.
    Yielded in chunks of about FRAGMENT_BUDGET rows; see that constant for why.
    """
    ax, ay = tris[:, 0, 0], tris[:, 0, 1]
    bx, by = tris[:, 1, 0], tris[:, 1, 1]
    cx, cy = tris[:, 2, 0], tris[:, 2, 1]

    # The rows whose centre line falls inside the triangle's vertical span,
    # clipped to the frame. A triangle that spans no row centre -- thinner than
    # a pixel, or entirely off the top or bottom -- covers nothing.
    top = np.maximum(np.ceil(np.minimum.reduce([ay, by, cy]) - 0.5), 0)
    bottom = np.minimum(np.floor(np.maximum.reduce([ay, by, cy]) - 0.5),
                        height - 1)
    rows = np.maximum((bottom - top + 1).astype(np.int64), 0)
    kept = np.flatnonzero(rows > 0)
    if not len(kept):
        return

    # Chunk boundaries: the triangle at which the running total of rows passes
    # each multiple of the budget.
    running = np.cumsum(rows[kept])
    cuts = np.searchsorted(running,
                           np.arange(FRAGMENT_BUDGET, running[-1],
                                     FRAGMENT_BUDGET))
    bounds = [0, *dict.fromkeys(int(cut) for cut in cuts if 0 < cut < len(kept)),
              len(kept)]

    for start, stop in zip(bounds, bounds[1:]):
        index = kept[start:stop]
        count = rows[index]
        # One entry per (triangle, row) pair: which triangle it belongs to, and
        # how far into that triangle's own run of rows it is.
        tri = np.repeat(index, count)
        within = (np.arange(int(count.sum()))
                  - np.repeat(np.cumsum(count) - count, count))
        row = top[tri] + within
        line = row + 0.5

        # Where the three edges cross this row's centre line. The span between
        # the leftmost and the rightmost crossing is what the triangle covers
        # on that row. A horizontal edge is skipped -- it has no single
        # crossing, and its two neighbours give the same two ends anyway.
        xmin = np.full(len(tri), np.inf)
        xmax = np.full(len(tri), -np.inf)
        for (px, py), (qx, qy) in (((ax, ay), (bx, by)),
                                   ((bx, by), (cx, cy)),
                                   ((cx, cy), (ax, ay))):
            y0, y1 = py[tri], qy[tri]
            crosses = ((line >= np.minimum(y0, y1))
                       & (line <= np.maximum(y0, y1)) & (y0 != y1))
            with np.errstate(invalid="ignore", divide="ignore"):
                x = px[tri] + (qx[tri] - px[tri]) * (line - y0) / (y1 - y0)
            # NaN where the edge does not cross, which fmin/fmax ignore --
            # that is the difference between fmin and minimum here.
            x = np.where(crosses, x, np.nan)
            xmin = np.fmin(xmin, x)
            xmax = np.fmax(xmax, x)

        first = np.maximum(np.ceil(xmin - 0.5), 0)
        last = np.minimum(np.floor(xmax - 0.5), width - 1)
        cols = np.maximum(last - first + 1, 0).astype(np.int64)
        covered = cols > 0
        tri, row, first, cols = (tri[covered], row[covered], first[covered],
                                 cols[covered])
        if not len(tri):
            continue

        # One entry per pixel of every run, expanded the way the rows were.
        run = np.repeat(np.arange(len(tri)), cols)
        offset = (np.arange(int(cols.sum()))
                  - np.repeat(np.cumsum(cols) - cols, cols))
        at = tri[run]
        cx_pixel = first[run] + offset + 0.5
        cy_pixel = row[run] + 0.5

        # Barycentric weights of the pixel centre, and the depth they carry.
        # The determinant is zero only for a triangle with no area on screen,
        # which covers no pixel centre and is thrown away above; the guard keeps
        # the divide from warning rather than changing any answer.
        area = ((by[at] - cy[at]) * (ax[at] - cx[at])
                + (cx[at] - bx[at]) * (ay[at] - cy[at]))
        area = np.where(area == 0, 1.0, area)
        wa = ((by[at] - cy[at]) * (cx_pixel - cx[at])
              + (cx[at] - bx[at]) * (cy_pixel - cy[at])) / area
        wb = ((cy[at] - ay[at]) * (cx_pixel - cx[at])
              + (ax[at] - cx[at]) * (cy_pixel - cy[at])) / area
        z = (wa * tris[at, 0, 2] + wb * tris[at, 1, 2]
             + (1.0 - wa - wb) * tris[at, 2, 2])
        pixels = (row[run] * width + first[run] + offset).astype(np.int64)
        yield pixels, z, at


def _project(part, centre, scale, width, height, right, up, forward):
    """One part's front-facing triangles in screen space, and their colours.

    Screen space is x right, y DOWN (which is how a raster is addressed) and z
    away from the camera, so a smaller z is nearer. Orthographic and not
    perspective: a printable part is judged on whether edges line up, and
    perspective bends exactly that.

    Normals are taken from the triangles themselves rather than from the view
    document's `normals`, which are per vertex where this shades per face -- and
    which would have to be turned by the part's own rotation to still be true
    after `load_scene` has placed it.
    """
    vertices = part["vertices"]
    faces = part["faces"]
    relative = vertices - centre
    sx = (relative @ right) * scale + width / 2.0
    sy = height / 2.0 - (relative @ up) * scale
    sz = -(relative @ forward)

    normals = np.cross(vertices[faces[:, 1]] - vertices[faces[:, 0]],
                       vertices[faces[:, 2]] - vertices[faces[:, 0]])
    lengths = np.linalg.norm(normals, axis=1)
    # A zero-area triangle keeps its zero normal, faces nothing and is culled
    # with the back faces below -- which is what the tessellator's poles want.
    nonzero = lengths > 0
    normals[nonzero] /= lengths[nonzero][:, None]
    facing = (normals @ forward) > FACING_TOL

    triangles = np.stack([sx, sy, sz], axis=1)[faces][facing]
    return triangles, _shading(normals[facing], _hex_rgb(part["color"]))


def framing(parts, views):
    """Where to look and how wide: `(centre, half_w, half_h)` for a sheet of views.

    `half_w` and `half_h` are the half-extents, in millimetres, that the picture
    has to show either way from `centre` -- across the screen and up it -- so
    `scale = min(width / (2 * half_w), height / (2 * half_h))` and nothing
    outside them is in frame.

    The two axes are measured separately because a tile is VIEW_ASPECT, not
    square. Each carries its own 1.02 margin.

    It is measured on the projection, not the bounding box: a box of half-edge
    h seen corner-on is h*sqrt(3) across, so scaling by h would crop isometric
    views.

    One frame for every view, which is why the views are passed in together
    rather than each picture measuring itself: the six tiles of a sheet are read
    against each other and a part that changed size between them would say
    something false about the part. So each axis is the largest extent any of
    them projects onto it -- the widest view fits exactly and the rest have room
    to spare.

    `centre` is the middle of the scene's bounding box, not of each view's own
    silhouette: it is one point for every view, for the same reason.

    No part at all yields an empty frame rather than an error: a view whose
    every leaf is at alpha 0 is legal (`prepare_views` only warns).
    """
    if not parts:
        return np.zeros(3), 1.0, 1.0
    everything = np.vstack([part["vertices"] for part in parts])
    centre = (everything.min(0) + everything.max(0)) / 2.0
    relative = everything - centre
    half_w = half_h = 0.0
    for elev, azim in views:
        right, up, _forward = _basis(elev, azim)
        half_w = max(half_w, float(np.abs(relative @ right).max()))
        half_h = max(half_h, float(np.abs(relative @ up).max()))
    # The 1.02 keeps the silhouette off the edge of the frame.
    return centre, max(half_w, 1e-6) * 1.02, max(half_h, 1e-6) * 1.02


def render_view(parts, elev, azim, width, height, frame_at=None):
    """One camera angle of one scene, as a PIL image `width x height`.

    `parts` is a list of `{"vertices", "faces", "color", "alpha"}` -- what
    `load_scene` returns, or the one entry `render` builds from an STL.

    `frame_at` is the `(centre, half_w, half_h)` of `framing`, shared with the
    other views of the same sheet; on its own this picture measures its own.

    A LEAF AT ALPHA 0 IS NOT DRAWN AT ALL, and it is dropped before the framing
    rather than after: it is hidden in the viewer, so it is hidden here, and an
    invisible part left in the framing would push the visible ones into a corner
    of a picture with apparently nothing in the rest of it.

    THE OPAQUE PARTS SHARE ONE Z-BUFFER and are drawn in any order; the
    see-through ones are then blended back to front by centroid depth and write
    no depth of their own. That is what three.js does in the viewer, and it is
    why a transparent part shows what is behind it, including other transparent
    parts, instead of hiding them.
    """
    right, up, forward = _basis(elev, azim)
    solid = [part for part in parts if part["alpha"] >= 1.0]
    clear = [part for part in parts if 0.0 < part["alpha"] < 1.0]
    # Back to front: the farthest centroid first, so a nearer see-through part
    # blends over what is behind it and not the other way round.
    clear.sort(key=lambda part: float(part["vertices"].mean(0) @ forward))

    centre, half_w, half_h = (frame_at if frame_at is not None
                              else framing(solid + clear, [(elev, azim)]))
    # ONE SCALE FOR BOTH AXES: pixels stay square -- a scale per axis would
    # stretch the part to fill the tile -- and the smaller of the two is the one
    # on which nothing runs off its own edge. Taking the per-axis MAXIMA over the
    # sheet's views first (in `framing`) and then the smaller ratio here is
    # exactly equal to taking the smallest scale any single view would ask for,
    # so every tile of a sheet is still drawn at one and the same scale.
    scale = min(width / (2.0 * half_w), height / (2.0 * half_h))

    depth = np.full(width * height, np.inf)
    frame = np.tile(_hex_rgb(BACKGROUND), (width * height, 1))

    for part in solid:
        triangles, colors = _project(part, centre, scale, width, height,
                                     right, up, forward)
        for pixels, z, at in _fragments(triangles, width, height):
            # The depth resolve, in two steps because a chunk can hold several
            # fragments for one pixel: `minimum.at` accumulates them all (plain
            # fancy indexing would keep whichever landed last), and the
            # comparison afterwards paints only the fragments that are still the
            # nearest anything has offered for that pixel.
            np.minimum.at(depth, pixels, z)
            won = z <= depth[pixels]
            frame[pixels[won]] = colors[at[won]]

    for part in clear:
        triangles, colors = _project(part, centre, scale, width, height,
                                     right, up, forward)
        # This part alone, into a buffer of its own: its own near surface is
        # what gets blended, so its far wall does not show through its near one.
        nearest = np.full(width * height, np.inf)
        surface = np.zeros((width * height, 3))
        for pixels, z, at in _fragments(triangles, width, height):
            np.minimum.at(nearest, pixels, z)
            won = z <= nearest[pixels]
            surface[pixels[won]] = colors[at[won]]
        # Behind an opaque surface it is not seen at all; in front of one it is
        # mixed with whatever is already there -- which may be another
        # see-through part, drawn earlier because it is farther away.
        seen = np.isfinite(nearest) & (nearest <= depth)
        alpha = part["alpha"]
        frame[seen] = frame[seen] * (1.0 - alpha) + surface[seen] * alpha

    pixels = (np.clip(frame, 0.0, 1.0) * 255).astype(np.uint8)
    return Image.fromarray(pixels.reshape(height, width, 3))


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
    `merge_vertices` welds touching parts into one body, so the mesh cannot
    count them, and an assembly would always read "NOT watertight".
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
    # Both dimensions of a tile, separately: a tile is landscape (VIEW_ASPECT),
    # so its width says nothing about how tall it is.
    tile_width, tile_height = tiles[0][0].size
    rows = (len(tiles) + columns - 1) // columns

    width = tile_width * columns + gap * (columns - 1)
    height = (tile_height * rows + gap * (rows - 1) + header + footer
              + label_height * rows)
    canvas = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(canvas)

    draw.text((width // 2, 12), title, fill="black", font=_font(20), anchor="mt")
    if subtitle:
        draw.text((width // 2, 34), subtitle, fill="#666666",
                  font=_font(14), anchor="mt")

    for index, (tile, label) in enumerate(tiles):
        column, row = index % columns, index // columns
        x = column * (tile_width + gap)
        y = header + label_height + row * (tile_height + gap + label_height)
        canvas.paste(tile, (x, y))
        if label:
            draw.text((x + tile_width // 2, y - 4), label, fill="#444444",
                      font=_font(14), anchor="mb")

    first, second = _info_lines(mesh, parts)
    info = _font(13)
    draw.text((width // 2, height - 30), first, fill="gray", font=info, anchor="mb")
    draw.text((width // 2, height - 10), second, fill="gray", font=info, anchor="mb")
    return canvas


def render(stl_path, output_path, views="iso", title=None, subtitle=None,
           resolution=DEFAULT_VIEW_SIZE, parts=None, color=None, scene=None,
           card_path=None):
    """Render `stl_path` to `output_path`. Returns the path written.

    `views` is "iso" (one isometric, the build default) or "multi" (the six-view
    sheet). Importable so a build can render several parts without paying for
    a fresh import of the stack per part; the CLI below is the same call.

    `scene` IS WHAT IS DRAWN WHEN IT IS GIVEN: the path to a tessellated view
    document -- `assembled.json`, `print.json`, the very file the browser loads
    -- so the picture shows every part in its own catalogue colour, at its own
    alpha, standing where the view puts it. Without one, the STL is drawn as a
    single part in `color` (DEFAULT_PART_COLOR when nobody says), which is what
    a picture of one printable is.

    `stl_path` IS READ EITHER WAY, because the footer describes the mesh that
    ships: its bounding box, its volume, its triangle count, whether it is
    watertight. Those are facts about the file somebody downloads, and they stay
    true of it whatever the picture above them was drawn from.

    `parts` is how many parts the file holds (see `_info_lines`). Leave it
    None for a single-part file.

    `card_path` saves the bare tile, before `_compose` adds the title and
    footer, for the front page's cards; nothing is re-rendered. For
    `views="multi"` it is the first tile, the isometric one (MULTI_VIEWS opens
    on ISO_VIEW's angle).
    """
    mesh = load_mesh(stl_path)
    drawn = (load_scene(scene) if scene else
             [{"vertices": np.asarray(mesh.vertices, dtype=np.float64),
               "faces": np.asarray(mesh.faces, dtype=np.int64),
               "color": color or DEFAULT_PART_COLOR, "alpha": 1.0}])
    if title is None:
        stem = os.path.splitext(os.path.basename(stl_path))[0]
        title = stem.replace("_", " ").title()

    # Measured once and handed to every tile: a sheet whose six views were each
    # framed on their own would draw the part at six sizes. What is measured is
    # what is DRAWN, so an alpha-0 leaf is out of it here as it is out of the
    # picture (see render_view).
    visible = [part for part in drawn if part["alpha"] > 0.0]
    # `resolution` is the tile's WIDTH and the height is derived from it, here
    # and nowhere else, so the two modes cannot drift into different shapes.
    width = resolution if views == "multi" else int(resolution * ISO_SCALE)
    height = round(width / VIEW_ASPECT)
    if views == "multi":
        frame_at = framing(visible, [(elev, azim) for elev, azim, _ in MULTI_VIEWS])
        tiles = [(render_view(drawn, elev, azim, width, height, frame_at), label)
                 for elev, azim, label in MULTI_VIEWS]
        columns = 3
    else:
        elev, azim = ISO_VIEW
        frame_at = framing(visible, [ISO_VIEW])
        tiles = [(render_view(drawn, elev, azim, width, height, frame_at), "")]
        columns = 1

    # `_compose` leaves the tiles untouched, so the order of these lines is free.
    if card_path is not None:
        tiles[0][0].save(card_path)
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
                        help=f"WIDTH of one view in pixels; the height follows "
                             f"from the {VIEW_ASPECT:.2f}:1 frame "
                             f"(default: {DEFAULT_VIEW_SIZE})")
    parser.add_argument("--parts", type=int, default=None,
                        help="how many parts the file holds; the footer says "
                             "watertight or not only for a single part")
    parser.add_argument("--color", default=None,
                        help=f"hex colour to draw the part in "
                             f"(default: {DEFAULT_PART_COLOR})")
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
           parts=args.parts, color=args.color)
    print(f"preview: {output} ({os.path.getsize(output)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
