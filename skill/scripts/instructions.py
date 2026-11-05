#!/usr/bin/env python3
"""IKEA-style assembly instructions of a project's `assembled` view, as a vector PDF.

usage: python instructions.py PROJECT_DIR OUT_PDF   (inside the hub image with PYTHONPATH=/app;
       instructions.sh runs it there)

The steps live in PROJECT_DIR/instructions.json, not in views(): a step is a page of a manual,
not something the hub builds or shows.

    {"title": "Impeller", "angle": [25, -60],
     "steps": [
       {"title": "Thread the nut onto the rod", "text": "Hand tight.",
        "add": ["rod", {"part": "nuts", "bodies": [0], "explode": [0, 0, 40]}]},
       {"title": "Fit the impeller", "angle": [35, 30],
        "add": [{"part": "impeller", "explode": [0, 0, 60]},
                {"part": "nuts", "count": 2, "explode": [0, 0, -30]}]}]}

AN INSTANCE IS A BODY. The bodies of every reference of a key in `assembled`, in view order,
are numbered 0..N-1, and every run prints that inventory for each key with more than one. An
`add` entry is a key (every body of it not added yet), `{"part": key, "count": N}` (the next
N), `{"part": key, "bodies": [i, ...]}` (exactly those) or `{"part": key}` (the rest); a dict
entry may carry `"explode": [dx, dy, dz]`, mm in the part's own frame (turned by the
reference's `at`). A reference whose bodies all differ (a motor) is one composite piece and is
added whole. `angle` is [ELEV, AZIM] in degrees, the camera of `hammerola snapshot --angle`;
a step with `"upside_down": true` is drawn with the assembly turned over about the drawing's
horizontal axis (the camera stays at `angle`), for the steps done with it that way up.

Page 1 is the title and every added body seated; then one page per step: earlier bodies as grey
ghosts, this step's black and exploded, each piece with a dashed line for the travel of its
leading end, and a callout of what the step uses, counted in pieces. Lines are OpenCASCADE
hidden-line removal, one run per drawing, so parts hide each other and the travel lines:
outlines and sharp edges only, an edge between faces at under 20 deg only on the silhouette.
"""

import json
import math
import os
import sys
import textwrap
from pathlib import Path

# The hub's own readers, imported while /app still leads sys.path: once load_model() puts the
# project first, a project's own `src/` would shadow them.
from src.cadbuild.artifacts import ASSEMBLED_VIEW_ID
from src.cadbuild.errors import BuildError
from src.cadbuild.geometry import as_shapes, load_model
from src.cadbuild.modelchecks import call_model
from src.cadbuild.parts import KIND_MOCK, read_catalogue
from src.cadbuild.preview_png import _basis
from src.cadbuild.views import prepare_views

import cadquery as cq
import matplotlib
import numpy as np
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.collections import LineCollection
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.patches import Rectangle
from matplotlib.textpath import TextToPath
from OCP.BRep import BRep_Builder
from OCP.BRepAdaptor import BRepAdaptor_Curve2d
from OCP.BRepGProp import BRepGProp_Face
from OCP.BRepLib import BRepLib
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.GeomAbs import GeomAbs_G1
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

INSTRUCTIONS_FILE = "instructions.json"
DOC_KEYS = frozenset({"title", "angle", "steps"})
STEP_KEYS = frozenset({"title", "text", "add", "angle", "upside_down"})
ENTRY_KEYS = frozenset({"part", "count", "bodies", "explode"})
DEFAULT_ANGLE = (25.0, -60.0)

# A4 landscape, inches.
PAGE = (11.69, 8.27)
# Where each drawing goes, as figure fractions [left, bottom, width, height].
COVER_BOX = (0.03, 0.04, 0.94, 0.80)
STEP_BOX = (0.03, 0.04, 0.63, 0.76)
CALLOUT = (0.69, 0.80, 0.28, 0.76)   # left, top, width, the most height it may take
CALLOUT_ROW = 0.19                   # the tallest one row of the callout may be
# Line styles: (colour, width, zorder).
NEW = ("black", 1.1, 3)
GHOST = ("#b4b4b4", 0.6, 1)
TRAVEL = ("black", 0.6, 2)
# Two faces meeting at less than this angle are one surface: the edge between them is drawn
# only where it is the silhouette (a faceted bowl would otherwise be a solid mass of lines).
SOFT_EDGE = math.radians(20)
# Curves are cut into chords this fraction of the drawing's 3D diagonal off the true curve.
DEFLECTION = 1 / 5000
# DejaVu Sans averages about this many ems per character; used to wrap text to a width.
CHAR_EM = 0.6

matplotlib.rcParams["pdf.fonttype"] = 42


def refuse(message):
    raise SystemExit(f"instructions: {message}")


# --------------------------------------------------------------------------
# instructions.json
# --------------------------------------------------------------------------

def _known_keys(obj, known, where):
    if not isinstance(obj, dict):
        refuse(f"{where} is {type(obj).__name__}, not a JSON object")
    unknown = sorted(set(obj) - known)
    if unknown:
        refuse(f"{where} has unknown key(s) {', '.join(map(repr, unknown))}; "
               f"known: {', '.join(sorted(known))}")


def _text(obj, name, where, required):
    value = obj.get(name)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or not value.strip():
        refuse(f'{where}: "{name}" must be a non-empty string, got {value!r}')
    return value.strip()


def _numbers(value, count, what, where):
    if (not isinstance(value, list) or len(value) != count
            or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in value)):
        refuse(f"{where}: {what} must be a list of {count} numbers, got {value!r}")
    return tuple(float(v) for v in value)


def _whole(value, low, what, where):
    if isinstance(value, bool) or not isinstance(value, int) or value < low:
        refuse(f"{where}: {what} must be a whole number of at least {low}, got {value!r}")
    return value


def _entry(item, spot):
    """One `add` entry as `(key, how, explode)`: how is None (the rest), ("count", N) or
    ("bodies", [i, ...]); explode is (dx, dy, dz) or None."""
    if isinstance(item, str):
        return item, None, None
    _known_keys(item, ENTRY_KEYS, spot)
    key = item.get("part")
    if not isinstance(key, str):
        refuse(f'{spot}: "part" must be a catalogue key, got {key!r}')
    if "count" in item and "bodies" in item:
        refuse(f'{spot}: "count" and "bodies" both say which bodies; give one of them')
    how = None
    if "count" in item:
        how = ("count", _whole(item["count"], 1, '"count"', spot))
    if "bodies" in item:
        indices = item["bodies"]
        if not isinstance(indices, list) or not indices:
            refuse(f'{spot}: "bodies" must be a non-empty list of body indices, got {indices!r}')
        how = ("bodies", [_whole(i, 0, "a body index", spot) for i in indices])
    explode = None
    if "explode" in item:
        explode = _numbers(item["explode"], 3, '"explode" [dx, dy, dz]', spot)
        if not any(explode):
            refuse(f'{spot}: "explode" is [0, 0, 0], which does not move the part')
    return key, how, explode


def read_instructions(path):
    """instructions.json, checked and normalised: every key, type and count, no geometry."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except ValueError as exc:
        refuse(f"{INSTRUCTIONS_FILE} is not valid JSON: {exc}")
    _known_keys(doc, DOC_KEYS, INSTRUCTIONS_FILE)
    title = _text(doc, "title", INSTRUCTIONS_FILE, required=True)
    angle = _numbers(doc.get("angle", list(DEFAULT_ANGLE)), 2, '"angle" [ELEV, AZIM]',
                     INSTRUCTIONS_FILE)
    steps = doc.get("steps")
    if not isinstance(steps, list) or not steps:
        refuse(f'{INSTRUCTIONS_FILE}: "steps" must be a non-empty list')

    read = []
    for number, step in enumerate(steps, 1):
        where = f"{INSTRUCTIONS_FILE} step {number}"
        _known_keys(step, STEP_KEYS, where)
        add = step.get("add")
        if not isinstance(add, list) or not add:
            refuse(f'{where}: "add" must be a non-empty list of catalogue keys')
        upside_down = step.get("upside_down", False)
        if not isinstance(upside_down, bool):
            refuse(f'{where}: "upside_down" must be true or false, got {upside_down!r}')
        read.append({"title": _text(step, "title", where, required=True),
                     "text": _text(step, "text", where, required=False),
                     "angle": angle if step.get("angle") is None else _numbers(
                         step["angle"], 2, '"angle" [ELEV, AZIM]', where),
                     "upside_down": upside_down,
                     "add": [_entry(item, f"{where} add entry #{index}")
                             for index, item in enumerate(add, 1)]})
    return {"title": title, "angle": angle, "steps": read}


# --------------------------------------------------------------------------
# The model, its bodies, and the steps resolved onto them
# --------------------------------------------------------------------------

def congruence(shape):
    """Volume and area, rounded: the same for two copies of a piece however they are turned."""
    return round(shape.Volume(), 2), round(shape.Area(), 2)


def load_assembled(project_dir):
    """`(catalogue, bodies)`: the hub's own reading of parts() and of the `assembled` view,
    split into bodies.

    Each body is `{"key", "index", "reference", "at", "shape", "class", "composite"}`: `index`
    counts the bodies of one key over all its references in view order, `shape` stands where
    the view puts it, and `composite` says its reference is one piece made of different bodies.
    A mesh has no bodies here.
    """
    os.chdir(project_dir)
    try:
        model = load_model()
        catalogue = read_catalogue(model)
        prepared = prepare_views(call_model("views()", model.views), catalogue)
    except BuildError as exc:
        refuse(str(exc))
    nodes = next(v for v in prepared if v["id"] == ASSEMBLED_VIEW_ID)["nodes"]
    bodies, counted = [], {}
    for reference, node in enumerate(nodes):
        if node["shape"] is None:
            continue
        shapes = as_shapes(node["shape"], node["label"])
        solids = [solid for shape in shapes for solid in (shape.Solids() or [shape])]
        classes = [congruence(solid) for solid in solids]
        composite = len(solids) > 1 and len(set(classes)) == len(classes)
        for solid, cls in zip(solids, classes):
            index = counted.get(node["key"], 0)
            counted[node["key"]] = index + 1
            bodies.append({"key": node["key"], "index": index, "reference": reference,
                           "at": node["at"], "shape": solid, "class": cls,
                           "composite": composite})
    return catalogue, bodies


def _class_id(n):
    """0 -> A, 25 -> Z, 26 -> AA: a short name for the n-th class of one key."""
    name, n = "", n + 1
    while n:
        n, r = divmod(n - 1, 26)
        name = chr(65 + r) + name
    return name


def print_inventory(bodies):
    """Every key with more than one body: per body its index, class, size and centre, so that
    `bodies` can be written without guessing which index is which nut."""
    by_key = {}
    for one in bodies:
        by_key.setdefault(one["key"], []).append(one)
    for key, group in by_key.items():
        if len(group) < 2:
            continue
        whole = " (a composite piece: it is added whole)" if group[0]["composite"] else ""
        print(f"{key}: {len(group)} bodies{whole}")
        names = {}
        for one in group:
            name = names.setdefault(one["class"], _class_id(len(names)))
            box = one["shape"].BoundingBox()
            size = " x ".join(f"{e:.1f}" for e in sorted((box.xlen, box.ylen, box.zlen)))
            centre = ", ".join(f"{c:.1f}" for c in box.center.toTuple())
            print(f"  #{one['index']:<3} class {name:<3} {one['shape'].Volume():10.1f} mm3  "
                  f"{size} mm  at ({centre})")


def along_own_axes(at, vector):
    """`vector`, given in the part's own frame, turned into the world by the reference's `at`.

    gp_Vec.Transformed applies the rotation only: a vector has no position to translate.
    """
    v = cq.Vector(*vector)
    if at is None:
        return v
    return cq.Vector(v.wrapped.Transformed(at.wrapped.Transformation()))


def _indices(numbers):
    return ", ".join(map(str, numbers))


def resolve_steps(doc, catalogue, bodies):
    """Each step as `{"title", "text", "angle", "upside_down", "added": [body],
    "offset": {body: Vector}}`, where a body is its position in `bodies`.

    Refuses a key the catalogue or the view lacks, a mesh, more bodies than are left, a body
    index out of range or already added, part of a composite piece, and a printable or
    hardware body no step adds.
    """
    added = set()
    resolved = []
    for number, step in enumerate(doc["steps"], 1):
        spot = f"step {number} ({step['title']!r})"
        taken, offset = [], {}
        for index, (key, how, explode) in enumerate(step["add"], 1):
            where = f"{spot} add entry #{index}"
            if key not in catalogue:
                refuse(f"{where}: {key!r} is not in the catalogue "
                       f"({', '.join(map(repr, catalogue))})")
            if catalogue[key]["mesh"] is not None:
                refuse(f"{where}: {key!r} is a mesh, which has no edges to draw")
            mine = [b for b, one in enumerate(bodies) if one["key"] == key]
            if not mine:
                refuse(f"{where}: {key!r} is not in the {ASSEMBLED_VIEW_ID!r} view")
            left = [b for b in mine if b not in added]
            if how is not None and how[0] == "bodies":
                chosen = []
                for i in how[1]:
                    if i >= len(mine):
                        refuse(f"{where}: {key!r} has bodies 0..{len(mine) - 1}, not {i}")
                    if mine[i] in added or mine[i] in chosen:
                        refuse(f"{where}: body {i} of {key!r} is already added")
                    chosen.append(mine[i])
            else:
                wanted = len(left) if how is None else how[1]
                if not left or wanted > len(left):
                    refuse(f"{where}: asks for {wanted or 'the rest'} of {key!r}, and "
                           f"{len(left)} of its {len(mine)} bodies are left")
                chosen = left[:wanted]
            added.update(chosen)
            taken.extend(chosen)
            if explode is not None:
                for b in chosen:
                    offset[b] = along_own_axes(bodies[b]["at"], explode)
        for b in taken:
            one = bodies[b]
            piece = [c for c, other in enumerate(bodies) if other["reference"] == one["reference"]]
            if one["composite"] and not set(piece) <= set(taken):
                refuse(f"{spot}: {one['key']!r} is one piece made of different bodies "
                       f"({_indices(bodies[c]['index'] for c in piece)}); a step adds all of "
                       f"it, and this one adds "
                       f"{_indices(bodies[c]['index'] for c in piece if c in taken)}")
        resolved.append({"title": step["title"], "text": step["text"], "angle": step["angle"],
                         "upside_down": step["upside_down"], "added": taken, "offset": offset})

    missing = {}
    for b, one in enumerate(bodies):
        if b not in added and catalogue[one["key"]]["kind"] != KIND_MOCK:
            missing.setdefault(one["key"], []).append(one["index"])
    if missing:
        named = "; ".join(f"{key!r} {'body' if len(ix) == 1 else 'bodies'} {_indices(ix)}"
                          for key, ix in missing.items())
        refuse(f"no step adds {named} of the {ASSEMBLED_VIEW_ID!r} view; every printable and "
               "hardware body needs a step (only a mock may stay out)")
    return resolved


# --------------------------------------------------------------------------
# Hidden-line drawings
# --------------------------------------------------------------------------

def travel(shape, offset):
    """The path of the piece's leading end, as its two points: from the middle of that end
    seated to the same point exploded.

    The leading end is what of the piece lies furthest back along the explode direction u, the
    side that goes in first: the mean of its tessellation points within a thin slab at their
    minimum along u -- a tube's end, a screw's tip, a nut's bottom face. That point is on the
    piece itself, which the centre of a box face is not for a bent hose or a clamp with a screw
    boss. The line stops at the exploded piece, so none of it runs through it.
    """
    u = offset.normalized()
    points, _ = shape.tessellate(shape.BoundingBox().DiagonalLength / 1000)
    along = [p.dot(u) for p in points]
    low = min(along)
    slab = 0.5 + 0.01 * (max(along) - low)
    end = [p for p, d in zip(points, along) if d <= low + slab]
    start = sum(end, cq.Vector()) * (1 / len(end))
    return start, start + offset


def exploded_pieces(step, bodies):
    """The step's exploded pieces as `[(shape, offset)]`, seated: a composite piece (a motor and
    its terminal box) is one, whole, so it gets one travel line and not one per body."""
    pieces = {}
    for b, offset in step["offset"].items():
        one = bodies[b]
        piece = ("reference", one["reference"]) if one["composite"] else ("body", b)
        pieces.setdefault(piece, ([], offset))[0].append(one["shape"])
    return [(shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes), offset)
            for shapes, offset in pieces.values()]


def _polylines(compound, deflection):
    """The edges of one HLR result as lists of (x, y) on the page, as cadquery's SVG export
    discretises them."""
    if compound.IsNull():
        return []
    # HLR edges carry 2D curves only; cadquery's own exporter builds the 3D ones the same way.
    BRepLib.BuildCurves3d_s(compound, cq.occ_impl.shapes.TOLERANCE)
    lines = []
    for edge in cq.Shape(compound).Edges():
        curve = edge._geomAdaptor()
        points = GCPnts_QuasiUniformDeflection(curve, deflection, curve.FirstParameter(),
                                               curve.LastParameter())
        if points.IsDone():
            lines.append([(points.Value(i).X(), points.Value(i).Y())
                          for i in range(1, points.NbPoints() + 1)])
    return lines


def _outward_normal(edge, face, surface):
    """The face's outward unit normal at the middle of `edge`, or None where it has none.
    `surface` is the face's BRepGProp_Face, which turns the normal over for a REVERSED face."""
    curve = BRepAdaptor_Curve2d(edge, face)
    uv = curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2)
    point, normal = gp_Pnt(), gp_Vec()
    surface.Normal(uv.X(), uv.Y(), point, normal)
    length = normal.Magnitude()
    return None if length < 1e-12 else np.array([normal.X(), normal.Y(), normal.Z()]) / length


def _smoothed(shape, forward):
    """A copy of `shape` whose soft edges off this view's silhouette are coded G1.

    HLR then reports them as smooth lines, which are not drawn. On the silhouette (one face
    turned to the camera, the other away) an edge is the outline and stays. A copy, because the
    coding is per view and the catalogue's shapes are shared by every drawing.
    """
    copy = shape.copy()
    ancestors = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(copy.wrapped, TopAbs_EDGE, TopAbs_FACE, ancestors)
    faces = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(copy.wrapped, TopAbs_FACE, faces)
    surfaces = {}   # face index -> its BRepGProp_Face, built once: building one is the slow part
    builder = BRep_Builder()
    for index in range(1, ancestors.Extent() + 1):
        # First()/Last() rather than iterating: iterating an OCP list costs ~0.4 ms an edge
        pair = ancestors.FindFromIndex(index)
        if pair.Size() != 2 or pair.First().IsSame(pair.Last()):
            continue
        edge = TopoDS.Edge_s(ancestors.FindKey(index))
        first, second = TopoDS.Face_s(pair.First()), TopoDS.Face_s(pair.Last())
        normals = []
        for face in (first, second):
            key = faces.FindIndex(face)
            if key not in surfaces:
                surfaces[key] = BRepGProp_Face(face)
            normals.append(_outward_normal(edge, face, surfaces[key]))
        if any(n is None for n in normals) or (normals[0] @ forward) * (normals[1] @ forward) < 0:
            continue
        if normals[0] @ normals[1] > math.cos(SOFT_EDGE):
            builder.Continuity(edge, first, second, GeomAbs_G1)
    return copy


def hidden_line_view(bodies, angle, upside_down=False):
    """One HLR run over all `bodies` from camera `angle`: per body, the visible outlines and
    sharp edges as polylines. Smooth (G1) edges are not drawn, as in an IKEA drawing, and soft
    edges off the silhouette count as smooth (`_smoothed`). A free edge among `bodies` (a travel
    line) comes back as the part of it no face hides.

    `upside_down` turns the bodies over about the drawing's horizontal axis before the camera
    sees them. Turning them by 180 deg about `right` is the same as looking from `-forward`
    with `right` kept, and the projector's up (forward x right) then comes out as `-up`."""
    right, _, forward = _basis(*angle)
    if upside_down:
        forward = -forward
    bodies = [_smoothed(one, forward) for one in bodies]
    algo = HLRBRep_Algo()
    for one in bodies:
        algo.Add(one.wrapped)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*forward), gp_Dir(*right))))
    algo.Update()
    algo.Hide()
    result = HLRBRep_HLRToShape(algo)
    deflection = cq.Compound.makeCompound(bodies).BoundingBox().DiagonalLength * DEFLECTION
    return [_polylines(result.VCompound(one.wrapped), deflection)
            + _polylines(result.OutLineVCompound(one.wrapped), deflection)
            for one in bodies]


def _draw(ax, views, style, linestyle="solid"):
    color, width, zorder = style
    for lines in views:
        ax.add_collection(LineCollection(lines, colors=color, linewidths=width,
                                         linestyles=linestyle, capstyle="round",
                                         joinstyle="round", zorder=zorder))


def drawing_axes(fig, box, views):
    """Axes at `box` (figure fractions), framed so the drawing fills it at equal scale."""
    ax = fig.add_axes(box)
    ax.set_axis_off()
    points = np.concatenate([np.asarray(line) for lines in views for line in lines])
    low, high = points.min(axis=0), points.max(axis=0)
    centre, size = (low + high) / 2, (high - low) * 1.06
    width, height = box[2] * PAGE[0], box[3] * PAGE[1]
    scale = max(size[0] / width, size[1] / height, 1e-9)
    ax.set_xlim(centre[0] - scale * width / 2, centre[0] + scale * width / 2)
    ax.set_ylim(centre[1] - scale * height / 2, centre[1] + scale * height / 2)
    return ax


def _text_line(fontsize):
    """The height one line of text at `fontsize` takes, as a fraction of the page height."""
    return fontsize * 1.25 / 72 / PAGE[1]


def wrapped(text, fontsize, width_fraction):
    """`text` broken into lines that fit `width_fraction` of the page width."""
    chars = int(width_fraction * PAGE[0] * 72 / (fontsize * CHAR_EM))
    return "\n".join(textwrap.fill(line, max(chars, 8)) for line in text.splitlines())


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------

def cover_page(doc, steps, bodies):
    fig = Figure(figsize=PAGE)
    fig.text(0.04, 0.95, wrapped(doc["title"], 26, 0.92), fontsize=26, fontweight="bold",
             va="top")
    seated = [bodies[b]["shape"] for step in steps for b in step["added"]]
    views = hidden_line_view(seated, doc["angle"])
    _draw(drawing_axes(fig, COVER_BOX, views), views, NEW)
    return fig


def step_page(number, step, earlier, bodies, catalogue):
    fig = Figure(figsize=PAGE)
    fig.text(0.04, 0.955, str(number), fontsize=48, fontweight="bold", va="top")
    # the title starts after the number, however many digits it has
    width = TextToPath().get_text_width_height_descent(
        str(number), FontProperties(size=48, weight="bold"), ismath=False)[0]
    title_left = 0.04 + width / (PAGE[0] * 72) + 0.025
    fig.text(title_left, 0.945, wrapped(step["title"], 20, 0.97 - title_left), fontsize=20,
             fontweight="bold", va="top")
    if step["text"]:
        fig.text(title_left, 0.885, wrapped(step["text"], 12, 0.97 - title_left), fontsize=12,
                 va="top")

    ghosts = [bodies[b]["shape"] for b in earlier]
    new = []
    for b in step["added"]:
        shape, offset = bodies[b]["shape"], step["offset"].get(b)
        new.append(shape if offset is None else shape.moved(cq.Location(offset)))
    # the travel lines go into the same HLR run as edges, so parts in front of them hide them
    travels = [cq.Edge.makeLine(*travel(shape, offset))
               for shape, offset in exploded_pieces(step, bodies)]
    views = hidden_line_view(ghosts + new + travels, step["angle"], step["upside_down"])
    ax = drawing_axes(fig, STEP_BOX, views)
    _draw(ax, views[:len(ghosts)], GHOST)
    _draw(ax, views[len(ghosts):len(ghosts) + len(new)], NEW)
    _draw(ax, views[len(ghosts) + len(new):], TRAVEL, linestyle=(0, (4, 3)))

    callout(fig, step, bodies, catalogue)
    return fig


def callout_items(step, bodies):
    """What the step uses, as `[(key, count, piece)]`, one item per kind of piece.

    A composite piece (a reference whose bodies all differ, a motor) counts once, whole. Any
    other body is a piece of its own, and the pieces of one key are counted by congruence:
    four rods in one record are 4x, four references of a screw are 4x. `piece` is one of
    them, seated, to draw alone.
    """
    items, counted = {}, set()
    for b in step["added"]:
        one = bodies[b]
        if one["composite"]:
            if one["reference"] in counted:
                continue
            counted.add(one["reference"])
            piece = cq.Compound.makeCompound(
                [other["shape"] for other in bodies if other["reference"] == one["reference"]])
            cls = congruence(piece)
        else:
            piece, cls = one["shape"], one["class"]
        items.setdefault((one["key"], cls), [0, piece])[0] += 1
    return [(key, count, piece) for (key, _), (count, piece) in items.items()]


def callout(fig, step, bodies, catalogue):
    """Top right: per kind of piece the step uses, one piece alone, `N×`, the key and its note."""
    items = callout_items(step, bodies)
    left, top, width, room = CALLOUT
    row = min(CALLOUT_ROW, room / len(items))
    fig.add_artist(Rectangle((left, top - row * len(items)), width, row * len(items),
                             transform=fig.transFigure, fill=False, linewidth=1.0))
    for n, (key, count, piece) in enumerate(items):
        y = top - row * (n + 1)
        if n:
            fig.add_artist(Rectangle((left, y + row), width, 0, transform=fig.transFigure,
                                     fill=False, linewidth=0.4, edgecolor="#808080"))
        views = hidden_line_view([piece], step["angle"])
        _draw(drawing_axes(fig, (left + 0.008, y + 0.008, 0.10, row - 0.016), views), views, NEW)
        text_left = left + 0.12
        text_width = width - 0.13
        # the text is laid down from the row's top and the note keeps only the lines that fit
        # above its bottom, so a low row (many items) never runs into the next one
        count_size = 18 if row >= CALLOUT_ROW * 0.6 else 12
        cursor = y + row - 0.01
        fig.text(text_left, cursor, f"{count}×", fontsize=count_size, fontweight="bold",
                 va="top")
        cursor -= _text_line(count_size)
        name = wrapped(key, 9, text_width)
        fig.text(text_left, cursor, name, fontsize=9, fontweight="bold", va="top",
                 linespacing=1.0)
        cursor -= _text_line(9) * (name.count("\n") + 1)
        lines = wrapped(catalogue[key]["note"] or "", 7, text_width).splitlines()
        fit = int((cursor - y - 0.004) / _text_line(7))
        if lines and fit > 0:
            if len(lines) > fit:
                lines = lines[:fit]
                lines[-1] = lines[-1][:-1].rstrip() + "…"
            fig.text(text_left, cursor, "\n".join(lines), fontsize=7, va="top",
                     linespacing=1.0)


def write_pdf(doc, steps, bodies, catalogue, out_pdf):
    # no CreationDate: an unchanged guide is then the same bytes, and a committed PDF does not
    # change on every run
    with PdfPages(out_pdf, metadata={"CreationDate": None}) as pdf:
        pdf.savefig(cover_page(doc, steps, bodies))
        earlier = []
        for number, step in enumerate(steps, 1):
            pdf.savefig(step_page(number, step, earlier, bodies, catalogue))
            earlier = earlier + step["added"]


def main(argv):
    if len(argv) != 3:
        refuse("usage: python instructions.py PROJECT_DIR OUT_PDF")
    project_dir, out_pdf = Path(argv[1]).resolve(), Path(argv[2]).resolve()
    doc = read_instructions(project_dir / INSTRUCTIONS_FILE)
    catalogue, bodies = load_assembled(project_dir)
    print_inventory(bodies)
    steps = resolve_steps(doc, catalogue, bodies)
    write_pdf(doc, steps, bodies, catalogue, out_pdf)


if __name__ == "__main__":
    main(sys.argv)
