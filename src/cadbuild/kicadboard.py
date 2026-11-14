#!/usr/bin/env python3
"""`import kicadboard` -- a KiCad board of the project, ready for model.py to place.

    board = kicadboard.load("kicad/amp.kicad_pcb")

    def parts():
        return {**board.records("amp", at=cq.Location((40, 0, 5))), ...}

`load` asks the hub's KiCad sidecar (`src/kicadcli.py`) for two exports of the
board, side by side, on every build, with nothing kept between builds:

  * a GLB of the board as KiCad renders it (`GLB_FLAGS`): every fitted part
    with its 3D model, named by reference, and the board's own layers -- solder
    mask, copper (tracks, zones, pads, vias) and silkscreen. KiCad's own board
    body in it is dropped: the laminate below replaces it;
  * a STEP of the bare laminate (`--board-only`), a solid the gates see. It is
    rebuilt from its top face (`_laminate`) with the drills of the fitted parts'
    plated pads closed and every other hole kept.

THE BOARD FRAME is KiCad's STEP frame, in mm: x = KiCad x, y = -KiCad y, z = 0
on the laminate's bottom face and `thickness` on its top. The GLB (metres, Y
up, glTF z = KiCad y) is turned into it; KiCad 10.0.6 puts the GLB's body on
exactly the STEP laminate and a part's model origin 0.085 mm outside its side's
face.

The layers are kept as the faces a viewer sees and no more (`_outer`,
`_merged`): KiCad writes copper, pads and vias as 35-40 um slabs whose inner
faces lie ON the laminate's, coplanar with it, and those inner faces and the
slabs' walls are dropped; mask and silkscreen are flat already. Each layer's
coincident vertices are then merged. The board's edge cuts the copper as
milling cuts a board (`_on_board`): what KiCad draws past the outline or in a
cut-out of it -- a pad in the air, the ring of a hole the edge goes through --
is dropped, cut along the edge where it crosses it; a drill is no edge. The
parts are kept as KiCad tessellated them, each CAD face with its own
vertices, grouped into one mesh a colour on 16 levels a channel
(`_quantised`), their colours turned from the linear light the GLB carries
them in to sRGB first (`_srgb`); the layers' are sRGB already.

`footprints` is read from the `.kicad_pcb` itself, so it holds every footprint,
those with no 3D model (a mounting hole) and DNP ones too; `bounds` is what says
whether its part is in the GLB.

A board that cannot be exported -- kicad-cli refuses it, the sidecar does not
answer, or no sidecar is named (`KICAD_URL`) -- fails the build with a
`BuildError` naming the board and why.

In a hub build the exports are kept for that build alone (`KICAD_EXPORT_CACHE`,
`kicadcli.export_cached`): the check units' workers import model.py again,
and a `load` there takes the build process's exports instead of asking again.
"""

import dataclasses
import json
import math
import os
import re
import struct
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .. import kicadcli
from .errors import BuildError
from .hubspec import MAX_PARTS, MEMBER_RE
from .paths import project_root

GLB_FLAGS = ("--subst-models", "--no-dnp", "--include-tracks", "--include-pads",
             "--include-zones", "--include-silkscreen", "--include-soldermask")
STEP_FLAGS = ("--board-only",)

# KiCad's default solder mask green, the colour a board is seen in, for the
# laminate solid, which the STEP carries no colour for.
PCB_COLOR = "#143324"

# What counts as ON a laminate face: the GLB is float32 metres, the STEP mm.
FACE_TOL = 1e-3
# A face is flat when its normal is this close to the board's: `_outer`.
FLAT = 0.9
# The grid a layer's vertices are merged on, in mm: 0.1 um, the step the view
# files round coordinates to.
MERGE_GRID = 1e-4
# How near a laminate hole is to a pad's drill to be that drill, in mm: the
# STEP and the board file give both to the micrometre.
HOLE_TOL = 0.01
# How closely the cut of the copper follows an arc of the board's edge, in mm
# (`_edge`): its straight lines it follows exactly.
EDGE_DEFLECTION = 1e-3
# The side of a cell of the grid that tells the copper's triangles well inside
# the board and well outside it from those near its edge, which alone are cut
# (`_on_board`), in mm.
EDGE_CELL = 0.5
# How far off a line, in mm, a point of the cut is still on it.
EDGE_EPS = 1e-9
# How many points or triangles near the edge are taken at once, sorted by y,
# against the segments of the edge their band reaches (`_within`,
# `_on_board`): the whole edge against each would cost seconds on a board of
# a few thousand segments.
EDGE_CHUNK = 256
# The parts are grouped by their sRGB colour on this many levels a channel:
# KiCad's models come in near-identical colours, and exact colours would give
# each a record of its own.
COLOR_LEVELS = 16

# The kind of a board layer is the end of its glTF mesh's name
# (`<board>_copper`).
LAYER_KIND = re.compile(r"_([A-Za-z]+)(?:_\d+)*$")
# Which record each kind of layer goes into; None is the body, dropped.
LAYER_RECORDS = {"soldermask": "mask", "copper": "copper", "pad": "copper",
                 "via": "copper", "silkscreen": "silk", "PCB": None}
# The kinds KiCad writes as slabs on the laminate, cut to their outer faces.
SLAB_KINDS = ("copper", "pad", "via")
# The kind whose colour a record takes: pads are grey in KiCad's GLB, and the
# copper record is painted as its tracks.
RECORD_COLOR_KIND = {"mask": "soldermask", "copper": "copper",
                     "silk": "silkscreen"}
# The name OCCT gives a shape KiCad left unnamed: a layer, not a part.
LABEL_TAG = re.compile(r"^=>\[[\d:]*\]$")

# A KiCad s-expression, token by token; a string escapes `"` and `\`.
TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')
ESCAPED = re.compile(r"\\(.)")

# kicad-cli's line for a part whose model it did not find.
MISSING_MODEL = "Could not add 3D model"

# A glTF accessor's numbers, by its componentType and type.
COMPONENT_TYPES = {5121: "<u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
# The keys of a glTF node that move it.
NODE_TRANSFORMS = frozenset(("matrix", "translation", "rotation", "scale"))


@dataclasses.dataclass(frozen=True)
class Pad:
    """A pad's centre in the board frame, and its net's name or None."""
    x: float
    y: float
    net: str | None


@dataclasses.dataclass(frozen=True)
class Footprint:
    """One footprint of the board.

    `x`, `y` in the board frame, `angle` KiCad's (degrees, counter-clockwise
    seen from the top), `side` "F" or "B". `location` takes the footprint's own
    frame -- its library drawing, Z out of the side it sits on, origin on that
    side's face of the laminate -- into the board frame. `pads` by pad number
    (a number several pads share keeps the first). `bounds` is the box of its
    part's 3D model in the board frame, (xmin, ymin, zmin, xmax, ymax, zmax),
    or None when the GLB has none (no model, or DNP).
    """
    reference: str
    x: float
    y: float
    angle: float
    side: str
    location: object
    pads: dict
    bounds: tuple | None


@dataclasses.dataclass(frozen=True)
class Board:
    """A loaded board. `records()` is what goes into parts()."""
    path: str
    thickness: float
    footprints: dict
    # The laminate (a cq.Shape) and the meshes, in the board frame:
    # {name: (vertices, faces, normals, "#rrggbb")}, `name` being
    # `parts_<rrggbb>` (the quantised colour), `mask`, `copper` or `silk`.
    laminate: object = dataclasses.field(repr=False)
    meshes: dict = dataclasses.field(repr=False)

    def records(self, prefix, at=None):
        """The catalogue entries of this board, all moved by `at` (a
        cq.Location, the identity by default):

          `<prefix>_pcb`             the laminate, `hardware`, solder mask green;
          `<prefix>_mask`, `<prefix>_copper`, `<prefix>_silk`
                                     the board's layers, `mock`, KiCad's colours;
          `<prefix>_parts_<rrggbb>`  the fitted parts, merged by colour, `mock`.

        The meshes are moved here because a view refuses `at` on a mesh record.
        """
        import cadquery as cq
        import numpy as np
        import trimesh

        at = cq.Location() if at is None else at
        trsf = at.wrapped.Transformation()
        rotation = np.array([[trsf.Value(i, j) for j in (1, 2, 3)]
                             for i in (1, 2, 3)])
        shift = np.array([trsf.Value(i, 4) for i in (1, 2, 3)])
        out = {f"{prefix}_pcb": {"shape": self.laminate.moved(at),
                                 "kind": "hardware", "color": PCB_COLOR}}
        for name, (vertices, faces, normals, color) in self.meshes.items():
            mesh = trimesh.Trimesh(vertices=vertices @ rotation.T + shift,
                                   faces=faces,
                                   vertex_normals=normals @ rotation.T,
                                   process=False)
            out[f"{prefix}_{name}"] = {"mesh": mesh, "kind": "mock",
                                       "color": color}
        bad = [key for key in out if not MEMBER_RE.match(key)]
        if bad:
            raise BuildError(
                f"kicadboard: {self.path}: records({prefix!r}) would name "
                f"parts {bad[0]!r}, which is not a catalogue key (letters, "
                f"digits, dot, dash and underscore, a letter or digit first, "
                f"up to 128 characters); choose another prefix")
        if len(out) > MAX_PARTS:
            raise BuildError(
                f"kicadboard: {self.path}: {len(out)} records, over the "
                f"{MAX_PARTS} the hub takes from one build")
        return out


def load(path):
    """The board at `path`, relative to the project root, exported now."""
    url = os.environ.get(kicadcli.URL_ENV)
    if not url:
        raise BuildError(
            f"kicadboard: {path}: a board is exported by the hub's KiCad "
            f"service, and none is configured here ({kicadcli.URL_ENV} is not set)")
    source = project_root() / path
    with ThreadPoolExecutor(max_workers=2) as pool:
        glb_job = pool.submit(_export, source, "glb", GLB_FLAGS, url)
        step_job = pool.submit(_export, source, "step", STEP_FLAGS, url)
        try:
            (glb, said, glb_seconds) = glb_job.result()
            (step, _, step_seconds) = step_job.result()
        except kicadcli.KicadError as error:
            raise BuildError(f"kicadboard: {path}: {error}") from None
    for line in said:
        if MISSING_MODEL in line:
            print(f"kicadboard: {path}: {line.strip()}")

    import cadquery as cq

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="kicadboard-") as scratch:
        (Path(scratch) / "board.step").write_bytes(step)
        laminate = cq.importers.importStep(str(Path(scratch) / "board.step")).val()
    thickness = laminate.BoundingBox().zlen
    meshes, bounds = _scene(glb, thickness)
    tree = _sexpr(source.read_text(encoding="utf-8", errors="replace"))
    footprints, filled, holes = {}, [], []
    for found in _footprints(tree):
        drills = found.pop("drills")
        holes += drills + found.pop("unplated")
        if bounds.get(found["reference"]) is not None:
            filled += drills
        footprints.setdefault(found["reference"], Footprint(
            location=_location(found, thickness),
            bounds=bounds.get(found["reference"]), **found))
    if "copper" in meshes:
        *copper, color = meshes["copper"]
        meshes["copper"] = (*_on_board(*copper, _edge(laminate, thickness, holes)), color)
    laminate = _laminate(laminate, thickness, filled)
    exported = ("GLB and STEP from this build's cache"
                if glb_seconds is None and step_seconds is None else
                f"GLB {_took(glb_seconds)} and STEP {_took(step_seconds)}, "
                f"exported side by side")
    print(f"kicadboard: {path}: {len(bounds)} parts; {exported}; processed in "
          f"{time.monotonic() - started:.1f} s")
    return Board(str(path), thickness, footprints, laminate, meshes)


def _export(source, fmt, flags, url):
    """One export, timed: (bytes, kicad-cli's lines, seconds, or None when
    this build had it already)."""
    started = time.monotonic()
    data, said, cached = kicadcli.export_cached(
        source, fmt, flags, url=url, cache=os.environ.get(kicadcli.CACHE_ENV))
    return data, said, None if cached else time.monotonic() - started


def _took(seconds):
    return "from this build's cache" if seconds is None else f"{seconds:.1f} s"


def _location(found, thickness):
    """The footprint's own frame into the board frame (see `Footprint`)."""
    import cadquery as cq

    turn = cq.Location(cq.Vector(), cq.Vector(0, 0, 1), found["angle"])
    if found["side"] == "F":
        return cq.Location(cq.Vector(found["x"], found["y"], thickness)) * turn
    # Flipped to the bottom: KiCad mirrors the drawing top to bottom, which
    # with Z turned down is half a turn about X.
    return (cq.Location(cq.Vector(found["x"], found["y"], 0)) * turn
            * cq.Location(cq.Vector(), cq.Vector(1, 0, 0), 180))


def _laminate(step, thickness, filled):
    """The laminate the build keeps: the STEP's top face, its outline and the
    holes that stay open, extruded down through the thickness.

    The STEP has every plated hole; the drill of a plated pad whose footprint
    has its 3D model in the GLB (`filled`) is closed -- its part's leads fill
    it -- because on a board of a hundred such holes their walls are most of
    the laminate's faces, its view and its clearance checks. Every other hole
    stays: an unplated one, a cut-out of the outline, and a plated one of a
    footprint with no model (a mounting hole, a DNP part), which a screw or a
    wire may pass through."""
    import cadquery as cq

    solids = []
    for face in step.Faces():
        if face.geomType() != "PLANE" or abs(face.Center().z - thickness) > FACE_TOL:
            continue
        kept = [wire for wire in face.innerWires() if not _filled(wire, filled)]
        solids.append(cq.Solid.extrudeLinear(face.outerWire(), kept,
                                             cq.Vector(0, 0, -thickness)))
    if not solids:
        return step
    return solids[0] if len(solids) == 1 else cq.Compound.makeCompound(solids)


def _filled(wire, filled):
    """Whether the hole `wire` is one of the `filled` drills: on its centre,
    and no larger."""
    box = wire.BoundingBox()
    return any(abs(box.center.x - x) < HOLE_TOL and abs(box.center.y - y) < HOLE_TOL
               and max(box.xlen, box.ylen) <= size + HOLE_TOL for x, y, size in filled)


def _edge(step, thickness, drills):
    """The board's edge in the board plane as straight segments, an (n, 4)
    array of x0, y0, x1, y1: the outline and the cut-outs of the STEP's top
    faces, an arc followed to `EDGE_DEFLECTION`. A hole that is one of the
    pads' `drills` (`_filled`, plated or not) is no edge: the copper round a
    drill stays as KiCad drew it. A drill the outline runs through, a plated
    half-hole's or a mouse bite's, is the outline's own."""
    import numpy as np
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_QuasiUniformDeflection
    from OCP.TopExp import TopExp

    segments = []
    for face in step.Faces():
        if face.geomType() != "PLANE" or abs(face.Center().z - thickness) > FACE_TOL:
            continue
        cut = [wire for wire in face.innerWires() if not _filled(wire, drills)]
        for wire in (face.outerWire(), *cut):
            for edge in wire.Edges():
                points = GCPnts_QuasiUniformDeflection(BRepAdaptor_Curve(edge.wrapped),
                                                       EDGE_DEFLECTION)
                xy = [(points.Value(i).X(), points.Value(i).Y())
                      for i in range(1, points.NbPoints() + 1)]
                # The ends are the edge's vertices, which the next edge of the
                # wire shares, so every ring closes exactly: the curve's own
                # ends may miss them by OCCT's tolerance, and a gap there would
                # miscount `_within` for a point level with it.
                for at, vertex in ((0, TopExp.FirstVertex_s(edge.wrapped)),
                                   (-1, TopExp.LastVertex_s(edge.wrapped))):
                    point = BRep_Tool.Pnt_s(vertex)
                    xy[at] = (point.X(), point.Y())
                segments += [(*a, *b) for a, b in zip(xy, xy[1:])]
    return np.array(segments, dtype=float).reshape(-1, 4)


def _on_board(vertices, faces, normals, edge):
    """The copper record (`_merged`'s) without what lies off the board, past
    the outline or in a cut-out (`edge`, `_edge`): a triangle wholly off it
    dropped, one the edge crosses cut along it, its pieces on the board kept
    on the triangle's height, with its turn and its normal, and merged again.
    The very arrays given when nothing lies off the board.

    Only the triangles near the edge pay for the cut. A grid of `EDGE_CELL`
    marks the cells the edge passes through and those around them; the other
    cells fall into regions the edge bounds, each wholly on or off the board,
    as one point of it is. A triangle whose box meets no marked cell lies in
    one such region and is kept or dropped whole; of the rest, those a
    segment of the edge meets are cut (`_cut`), the others go as their
    centre does."""
    import numpy as np
    from scipy import ndimage

    if not len(faces) or not len(edge):
        return vertices, faces, normals
    corners = vertices[:, :2][faces]
    ends = edge.reshape(-1, 2)
    low = np.minimum(corners.min(axis=(0, 1)), ends.min(axis=0)) - EDGE_CELL
    high = np.maximum(corners.max(axis=(0, 1)), ends.max(axis=0)) + EDGE_CELL
    size = tuple(np.ceil((high - low) / EDGE_CELL).astype(np.int64) + 1)

    def cell(points):
        return np.floor((points - low) / EDGE_CELL).astype(np.int64)

    # The edge walked in steps no longer than a cell, so it passes through no
    # cell but those of its steps and their neighbours.
    steps = np.maximum(1, np.ceil(np.hypot(*(edge[:, 2:] - edge[:, :2]).T)
                                  / EDGE_CELL)).astype(np.int64)
    which = np.repeat(np.arange(len(edge)), steps + 1)
    fraction = ((np.arange(len(which)) - np.repeat(np.cumsum(steps + 1) - steps - 1, steps + 1))
                / np.repeat(steps, steps + 1))[:, None]
    near = np.zeros(size, dtype=bool)
    near[tuple(cell(edge[which, :2] + (edge[which, 2:] - edge[which, :2]) * fraction).T)] = True
    near = ndimage.binary_dilation(near, np.ones((3, 3), dtype=bool))
    regions, _ = ndimage.label(~near)
    labels, first = np.unique(regions, return_index=True)
    on = np.zeros(labels.max() + 1, dtype=bool)
    on[labels] = _within(low + (np.column_stack(np.unravel_index(first, size)) + 0.5)
                         * EDGE_CELL, edge)
    lo, hi = cell(corners.min(axis=1)), cell(corners.max(axis=1)) + 1
    table = np.zeros((size[0] + 1, size[1] + 1), dtype=np.int64)
    table[1:, 1:] = near.cumsum(0).cumsum(1)
    marked = (table[hi[:, 0], hi[:, 1]] - table[lo[:, 0], hi[:, 1]]
              - table[hi[:, 0], lo[:, 1]] + table[lo[:, 0], lo[:, 1]])
    keep = (marked == 0) & on[regions[lo[:, 0], lo[:, 1]]]

    # Each triangle near the edge against the segments whose box meets its
    # own, found a band of y at a time (`EDGE_CHUNK`). Those no segment meets
    # (`_meets`) lie on one side of the edge, as their centre does; only the
    # rest are cut.
    candidates = np.flatnonzero(marked)
    triangles = corners[candidates]
    tri_low, tri_high = triangles.min(axis=1) - EDGE_EPS, triangles.max(axis=1) + EDGE_EPS
    seg_low = np.minimum(edge[:, :2], edge[:, 2:])
    seg_high = np.maximum(edge[:, :2], edge[:, 2:])
    order = np.argsort(tri_low[:, 1], kind="stable")
    pairs = [np.zeros((0, 2), dtype=np.int64)]
    for start in range(0, len(order), EDGE_CHUNK):
        chunk = order[start:start + EDGE_CHUNK]
        reach = np.flatnonzero(np.all((seg_low <= tri_high[chunk].max(axis=0))
                                      & (seg_high >= tri_low[chunk].min(axis=0)), axis=1))
        hit = np.argwhere(np.all((seg_low[reach] <= tri_high[chunk, None])
                                 & (seg_high[reach] >= tri_low[chunk, None]), axis=2))
        pairs.append(np.column_stack([chunk[hit[:, 0]], reach[hit[:, 1]]]))
    pairs = np.vstack(pairs)
    pairs = pairs[np.lexsort((pairs[:, 1], pairs[:, 0]))]
    pairs = pairs[_meets(triangles[pairs[:, 0]], edge[pairs[:, 1]])]
    crossed = np.zeros(len(candidates), dtype=bool)
    crossed[pairs[:, 0]] = True
    keep[candidates[~crossed]] = _within(triangles[~crossed].mean(axis=1), edge)

    rows, firsts = np.unique(pairs[:, 0], return_index=True)
    pieces, owners = [], []
    for row, segments in zip(rows, np.split(pairs[:, 1], firsts[1:])):
        split = _cut(triangles[row].tolist(), edge[segments].tolist())
        pieces += split
        owners += [row] * len(split)
    owners = np.array(owners, dtype=np.int64)
    inside = _within(np.array([[sum(c) / len(piece) for c in zip(*piece)]
                               for piece in pieces]).reshape(-1, 2), edge)
    # A triangle all of whose pieces are on the board is kept whole, one with
    # none dropped, and one with some gives way to those.
    count = np.bincount(owners, minlength=len(candidates))
    held = np.bincount(owners, weights=inside, minlength=len(candidates))
    keep[candidates[(count > 0) & (held == count)]] = True
    if keep.all():
        return vertices, faces, normals
    new_vertices, new_faces, new_normals = [], [], []
    start = len(vertices)
    for piece, row, kept in zip(pieces, owners, inside):
        if not kept or held[row] == count[row]:
            continue
        corner = faces[candidates[row], 0]
        new_vertices += [(x, y, vertices[corner, 2]) for x, y in piece]
        new_normals += [normals[corner]] * len(piece)
        new_faces += [(start, start + i, start + i + 1) for i in range(1, len(piece) - 1)]
        start += len(piece)
    return _merged(np.vstack([vertices, np.array(new_vertices).reshape(-1, 3)]),
                   np.vstack([faces[keep], np.array(new_faces, dtype=np.int64).reshape(-1, 3)]),
                   np.vstack([normals, np.array(new_normals).reshape(-1, 3)]))


def _cut(triangle, segments):
    """`triangle` ([x, y] three times) in convex pieces no segment of the
    edge ([x0, y0, x1, y1] each) crosses, so each lies wholly on the board or
    off it: a piece is split along the line of every segment that runs
    through its inside. The pieces keep the triangle's turn; it comes back
    alone when no segment crosses it. In plain floats: a triangle and its few
    segments are too small for numpy's per-call cost to pay."""
    pieces = [triangle]
    for x0, y0, x1, y1 in segments:
        length = math.hypot(x1 - x0, y1 - y0)
        if length <= EDGE_EPS:
            continue
        ax, ay = (x1 - x0) / length, (y1 - y0) / length
        out = []
        for piece in pieces:
            side = [(y - y0) * ax - (x - x0) * ay for x, y in piece]
            if min(side) > -EDGE_EPS or max(side) < EDGE_EPS:
                out.append(piece)
                continue
            # Split only if the segment itself runs where the line goes
            # through the piece: its chord, along the segment.
            left, right, line = _halves(piece, side)
            chord = [(x - x0) * ax + (y - y0) * ay for x, y in line]
            if min(max(chord), length) - max(min(chord), 0.0) <= EDGE_EPS:
                out.append(piece)
            else:
                out += [left, right]
        pieces = out
    return pieces


def _meets(triangles, segments):
    """Which of `segments` (n x 4) meet their `triangles` (n x 3 x 2), give
    or take EDGE_EPS: corners of the triangle on both sides of the segment's
    line, and no edge of the triangle with both ends of the segment beyond
    it. A segment that does not meet a triangle runs through no piece of it
    (`_cut`)."""
    import numpy as np

    starts, ends = segments[:, :2], segments[:, 2:]
    along = ends - starts
    across = (np.column_stack([-along[:, 1], along[:, 0]])
              / np.maximum(np.hypot(*along.T), EDGE_EPS)[:, None])
    side = ((triangles - starts[:, None]) * across[:, None]).sum(axis=2)
    meets = (side.min(axis=1) <= -EDGE_EPS) & (side.max(axis=1) >= EDGE_EPS)
    turned = np.roll(triangles, -1, axis=1) - triangles
    inner = np.stack([-turned[..., 1], turned[..., 0]], axis=2)
    inner *= np.sign(((np.roll(triangles, 1, axis=1) - triangles) * inner).sum(axis=2))[..., None]
    margin = -EDGE_EPS * np.hypot(inner[..., 0], inner[..., 1])
    beyond = [((end[:, None] - triangles) * inner).sum(axis=2) < margin for end in (starts, ends)]
    return meets & ~(beyond[0] & beyond[1]).any(axis=1)


def _halves(piece, side):
    """The convex `piece` split by a line it crosses, `side` each corner's
    signed distance from it: (the half on the left, the half on the right,
    the points on the line), the halves in the piece's turn, each with the
    points on the line. A corner within EDGE_EPS of the line is on it."""
    left, right, line = [], [], []
    for (x, y), here, (u, v), there in zip(piece, side, piece[1:] + piece[:1],
                                           side[1:] + side[:1]):
        if here >= -EDGE_EPS:
            left.append((x, y))
        if here <= EDGE_EPS:
            right.append((x, y))
        if abs(here) <= EDGE_EPS:
            line.append((x, y))
        elif here * there < 0 and abs(there) > EDGE_EPS:
            t = here / (here - there)
            crossing = (x + (u - x) * t, y + (v - y) * t)
            left.append(crossing)
            right.append(crossing)
            line.append(crossing)
    return left, right, line


def _within(points, edge):
    """Which of `points` (n x 2) lie on the board: inside an odd number of
    the edge's rings, the outline's and the cut-outs', so crossing an odd
    number of its segments on the way to +x. Taken a band of y at a time
    (`EDGE_CHUNK`), against the segments that reach the band."""
    import numpy as np

    inside = np.zeros(len(points), dtype=bool)
    order = np.argsort(points[:, 1], kind="stable")
    low, high = np.minimum(edge[:, 1], edge[:, 3]), np.maximum(edge[:, 1], edge[:, 3])
    for start in range(0, len(order), EDGE_CHUNK):
        rows = order[start:start + EDGE_CHUNK]
        x, y = points[rows, :1], points[rows, 1:]
        x0, y0, x1, y1 = edge[(high >= y.min()) & (low <= y.max())].T
        crosses = (y0 > y) != (y1 > y)
        with np.errstate(divide="ignore", invalid="ignore"):
            at = x0 + (y - y0) * (x1 - x0) / (y1 - y0)
        inside[rows] = (crosses & (x < at)).sum(axis=1) % 2 == 1
    return inside


def _scene(glb, thickness):
    """The GLB's parts and layers in the board frame.

    -> ({name: (vertices, faces, normals, "#rrggbb")}, {reference: bounds}).
    A layer's colour is its material's as KiCad wrote it, which is what its
    own 3D viewer shows; a part's is its material's turned from linear light
    to sRGB (`_srgb`) and put on `COLOR_LEVELS`, so the parts of
    near-identical colours share one record. The GLB is read straight from its buffer (`_gltf`): a board
    is tens of thousands of small meshes, and building an object for each is
    what took the time.
    """
    import numpy as np

    gltf, blob = _gltf(glb)
    nodes = gltf.get("nodes", [])
    tops = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    above = np.eye(4)
    while len(tops) == 1:
        only = nodes[tops[0]]
        if LABEL_TAG.match(only.get("name", "")) or not only.get("children"):
            break
        above = _placed(above, only)
        tops = only["children"]
    # glTF to the board frame: x stays, y = -glTF z, z = glTF y; mm.
    axes = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])
    layers, parts, extent, colors = {}, {}, {}, {}
    materials = [_color(material) for material in gltf.get("materials", [])]
    stack = [(index, nodes[index].get("name", ""), _placed(above, nodes[index]))
             for index in tops]
    while stack:
        index, top, matrix = stack.pop()
        node = nodes[index]
        stack.extend((child, top, _placed(matrix, nodes[child]))
                     for child in node.get("children", ()))
        if "mesh" not in node:
            continue
        mesh = gltf["meshes"][node["mesh"]]
        name = mesh.get("name", "")
        kind = None
        if LABEL_TAG.match(top):
            kind = LAYER_KIND.search(name)
            kind = kind.group(1) if kind else name
            if kind not in LAYER_RECORDS:
                raise BuildError(
                    f"kicadboard: the board's GLB has a layer {name!r} of a "
                    f"kind this does not know ({', '.join(LAYER_RECORDS)})")
            if LAYER_RECORDS[kind] is None:
                continue
        turn = axes @ matrix[:3, :3]
        shift = axes @ matrix[:3, 3]
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            vertices = (_accessor(gltf, blob, attributes["POSITION"]) @ turn.T
                        + shift) * 1000.0
            normals = _accessor(gltf, blob, attributes["NORMAL"]) @ turn.T
            faces = (_accessor(gltf, blob, primitive["indices"]).reshape(-1, 3)
                     if "indices" in primitive
                     else np.arange(len(vertices)).reshape(-1, 3)).astype(np.int64)
            color = (materials[primitive["material"]]
                     if "material" in primitive else _color({}))
            piece = (vertices, faces, normals)
            if kind is not None:
                colors.setdefault(kind, color)
                layers.setdefault(kind, []).append(piece)
                continue
            color = _quantised(_srgb(color))
            record = f"parts_{color[1:]}"
            colors[record] = color
            parts.setdefault(record, []).append(piece)
            low, high = vertices.min(axis=0), vertices.max(axis=0)
            if top in extent:
                low = np.minimum(low, extent[top][0])
                high = np.maximum(high, extent[top][1])
            extent[top] = (low, high)
    meshes = {record: (*_joined(found), colors[record])
              for record, found in parts.items()}
    joined, kinds = {}, {}
    for kind, found in layers.items():
        record = LAYER_RECORDS[kind]
        piece = _joined(found)
        joined.setdefault(record, []).append(
            _outer(*piece, thickness) if kind in SLAB_KINDS else piece)
        kinds.setdefault(record, []).append(kind)
    for record, found in joined.items():
        color = colors.get(RECORD_COLOR_KIND[record], colors[kinds[record][0]])
        meshes[record] = (*_merged(*_joined(found)), color)
    bounds = {reference: tuple(float(c) for c in (*low, *high))
              for reference, (low, high) in extent.items()}
    return meshes, bounds


def _srgb(color):
    """A part's "#rrggbb" from linear light to sRGB. kicad-cli writes the
    board's layers in KiCad's sRGB colours but a part's STEP colour in linear
    light, as glTF has it; shown as it is, a connector's grey body (linear
    0.07) comes out black and gold comes out brown."""
    out = []
    for i in (1, 3, 5):
        c = int(color[i:i + 2], 16) / 255
        c = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        out.append("%02x" % int(round(min(max(c, 0.0), 1.0) * 255)))
    return "#" + "".join(out)


def _quantised(color):
    """"#rrggbb" on `COLOR_LEVELS`: each channel to the nearest multiple of 17."""
    step = 255 // (COLOR_LEVELS - 1)
    return "#" + "".join("%02x" % (round(int(color[i:i + 2], 16) / step) * step)
                         for i in (1, 3, 5))


def _joined(pieces):
    """(vertices, faces, normals) pieces as one, the faces renumbered."""
    import numpy as np

    counts = np.array([len(v) for v, _, _ in pieces])
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    faces = np.vstack([f for _, f, _ in pieces])
    faces = faces + np.repeat(starts, [len(f) for _, f, _ in pieces])[:, None]
    return (np.vstack([v for v, _, _ in pieces]), faces,
            np.vstack([n for _, _, n in pieces]))


def _outer(vertices, faces, normals, thickness):
    """A slab layer cut to its outer faces: the flat faces off the laminate.
    Its inner faces lie on the laminate's, and its walls stand on them."""
    import numpy as np

    corners = vertices[faces]
    normal = np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0])
    z = corners[:, :, 2].mean(axis=1)
    keep = ((np.abs(normal[:, 2]) > FLAT * np.linalg.norm(normal, axis=1))
            & ((z > thickness + FACE_TOL) | (z < -FACE_TOL)))
    return vertices, faces[keep], normals


def _merged(vertices, faces, normals):
    """A flat layer with its coincident vertices made one, on `MERGE_GRID`,
    and no vertex no face uses; a face merged to a line is dropped."""
    import numpy as np

    used = faces.reshape(-1)
    grid = np.round(vertices[used] / MERGE_GRID).astype(np.int64)
    # np.unique(axis=0) sorts rows as records, several times slower than this.
    order = np.lexsort(grid.T[::-1])
    ranked = grid[order]
    new = np.ones(len(order), dtype=bool)
    new[1:] = (ranked[1:] != ranked[:-1]).any(axis=1)
    inverse = np.empty(len(order), dtype=np.int64)
    inverse[order] = np.cumsum(new) - 1
    faces = inverse.reshape(-1, 3)
    whole = ((faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2])
             & (faces[:, 0] != faces[:, 2]))
    return ranked[new] * MERGE_GRID, faces[whole], normals[used[order[new]]]


def _gltf(data):
    """A GLB's JSON and its binary chunk."""
    _, _, length = struct.unpack_from("<4sII", data, 0)
    found, offset = {}, 12
    while offset < length:
        size, kind = struct.unpack_from("<I4s", data, offset)
        found[kind] = data[offset + 8:offset + 8 + size]
        offset += 8 + size
    return json.loads(found[b"JSON"]), found.get(b"BIN\x00", b"")


def _accessor(gltf, blob, index):
    """A glTF accessor as an (count, width) array, read in place."""
    import numpy as np

    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    dtype = np.dtype(COMPONENT_TYPES[accessor["componentType"]])
    width = WIDTHS[accessor["type"]]
    return np.ndarray(
        (accessor["count"], width), dtype, blob,
        view.get("byteOffset", 0) + accessor.get("byteOffset", 0),
        (view.get("byteStride", dtype.itemsize * width), dtype.itemsize))


def _color(material):
    """A glTF material's base colour as "#rrggbb", white when it has none."""
    rgba = material.get("pbrMetallicRoughness", {}).get(
        "baseColorFactor", (1.0, 1.0, 1.0, 1.0))
    return "#%02x%02x%02x" % tuple(
        int(round(min(max(c, 0.0), 1.0) * 255)) for c in rgba[:3])


def _placed(parent, node):
    """`parent`, the transform above `node`, times the node's own: most of a
    board's nodes have none, and are spared the product."""
    if not NODE_TRANSFORMS.intersection(node):
        return parent
    return parent @ _matrix(node)


def _matrix(node):
    """A glTF node's own transform, 4 x 4: `matrix`, or T * R * S."""
    import numpy as np

    if "matrix" in node:
        return np.array(node["matrix"], dtype=float).reshape(4, 4).T
    x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    rotation = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    matrix = np.eye(4)
    matrix[:3, :3] = rotation * np.asarray(node.get("scale", (1.0, 1.0, 1.0)))
    matrix[:3, 3] = node.get("translation", (0.0, 0.0, 0.0))
    return matrix


def _sexpr(text):
    """A KiCad s-expression file as nested lists of strings, unquoted."""
    stack, current = [], []
    for token in TOKEN.findall(text):
        if token == "(":
            stack.append(current)
            current = []
        elif token == ")":
            done, current = current, stack.pop()
            current.append(done)
        else:
            current.append(ESCAPED.sub(r"\1", token[1:-1])
                           if token.startswith('"') else token)
    return current[0]


def _children(node, name):
    return [item for item in node
            if isinstance(item, list) and item and item[0] == name]


def _footprints(tree):
    """Each footprint of a parsed board as the fields of a `Footprint`, minus
    `location` and `bounds`, plus `drills`, its plated holes as (x, y, the
    drill's larger size) in the board frame, and `unplated`, its unplated ones
    alike; the reference is the `Reference` property, or the `fp_text
    reference` of a KiCad 6/7 file."""
    for node in _children(tree, "footprint"):
        at = _children(node, "at")[0]
        x, y = float(at[1]), float(at[2])
        angle = float(at[3]) if len(at) > 3 else 0.0
        layer = _children(node, "layer")[0][1]
        reference = ([item[2] for item in _children(node, "property")
                      if item[1] == "Reference"]
                     + [item[2] for item in _children(node, "fp_text")
                        if item[1] == "reference"])[0]
        # A pad's offset is in the footprint's unturned frame, KiCad's y down.
        cos, sin = math.cos(math.radians(angle)), math.sin(math.radians(angle))
        pads, drills, unplated = {}, [], []
        for pad in _children(node, "pad"):
            local = _children(pad, "at")[0]
            px, py = float(local[1]), float(local[2])
            net = _children(pad, "net")
            centre = (x + px * cos + py * sin, -(y - px * sin + py * cos))
            pads.setdefault(pad[1], Pad(*centre, (net[0][-1] or None) if net else None))
            drill = _children(pad, "drill")
            if pad[2] in ("thru_hole", "np_thru_hole") and drill:
                # `(drill 1)` or `(drill oval 1.2 2)`, and maybe an `(offset ...)`.
                (drills if pad[2] == "thru_hole" else unplated).append(
                    (*centre, max(float(atom) for atom in drill[0][1:]
                                  if isinstance(atom, str) and atom != "oval")))
        yield {"reference": reference, "x": x, "y": -y, "angle": angle,
               "side": "B" if layer.startswith("B.") else "F", "pads": pads,
               "drills": drills, "unplated": unplated}
