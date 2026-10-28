#!/usr/bin/env python3
"""How near two parts of a published view come, and how that was measured.

`hammerola measure` asks it (`buildproc.inspectchild`), of the leaves
`preview_png.load_scene` reads out of a view document. The owner chose "exact
where it can be" (SPEC §4):

  * BOTH PARTS PRINTABLE -- a `<key>.step` in the build, which the build
    exports for every printable -- are measured on their two STEP solids by the
    kernel's `BRepExtrema_DistShapeShape`, each placed as the view places it:
    the groups above the leaf, then the leaf's `at`. Not the leaf's `loc`,
    which also carries the solid's own location, already baked into the STEP
    (`views.export_views`, `comparescene`).
  * UNLESS THE VIEW DRAWS ANOTHER BODY THERE: a reference marked `deformed`
    stands in its view as a shape of its own, while `<key>.step` is the
    catalogue's body. The view document marks such a leaf
    (`views.shaped_document`), and it is measured on the mesh. As a second
    barrier every other placed STEP body is held against its leaf's own
    triangles by bounding box (`_stands_there`); a leaf it does not match is
    measured on the mesh too. A view published before leaves carried the mark
    has only that barrier: publish it again to have a reshaped part measured
    on the mesh.
  * ANY OTHER PAIR is measured on the view's own triangles, the only geometry a
    bought part is stored as. A tessellated face is a set of chords of the
    curved surface, up to the tessellation tolerance off it (`tolerance`) on
    either side of the true gap, and the answer gives that number.

A part name is a catalogue key and stands for every leaf of it in the view;
the answer is the nearest of all the pairs, named by the leaves' own names
(`pin(2)`). A part measured against itself is every pair of its leaves once.

The kernel is imported inside `_step_solid`, `_stands_there`, `_step_pair` and
`_moved` only: the mesh half is numpy and scipy, and runs and is tested without
it.
"""

from itertools import combinations
from pathlib import Path

import numpy as np

from .preview_png import _placed


__all__ = ["MESH", "STEP", "TOUCHING_MM", "describe", "measure", "tolerance"]


# The two methods, as `measure` reports them.
STEP = "step"
MESH = "mesh"

# Under this the two parts touch or overlap: OCCT's own confusion distance
# (`Precision::Confusion()`).
TOUCHING_MM = 1e-7

# ocp_tessellate meshes each part at a linear deflection of (x + y + z of its
# bounding box) / 300 * deviation, deviation 0.1 by default (`compute_quality`
# in its tessellator.py); the build calls it with the defaults.
TESSELLATION_DEVIATION = 0.1

# Added to a leaf's tessellation tolerance when its STEP body's bounding box is
# held against its triangles': the coordinates in a view file are rounded to
# 0.1 um, and the box of a curved face is not its tessellation's to the last
# digit either.
BOX_MARGIN_MM = 0.01

# How many triangle pairs `_pair_gaps` takes in one whole-array step, and how
# many triangles of the first part look for candidates at once. Ceilings on
# the temporaries; neither can change an answer.
PAIR_BUDGET = 50_000
ROW_BATCH = 256


def measure(build_dir, leaves, key_a, key_b):
    """The nearest approach of part `key_a` to part `key_b` in one view. -> dict

    `{"method", "distance", "a", "b", "point_a", "point_b", "pairs",
    "stepless", "reshaped", "tolerance"}`: the method and leaf names of the
    nearest pair, their two closest points in the view's coordinates, how many
    pairs were measured, which of the two keys has no STEP, which leaves of the
    nearest pair the view draws as a shape of their own, and for the mesh
    method each of the two leaves' tessellation tolerance.

    ValueError, carrying the sentence the refusal prints, for a key the view
    does not show and for a part named twice that stands in the view once.
    """
    keys = sorted({leaf["key"] for leaf in leaves if leaf["key"] is not None})
    chosen = {key: [leaf for leaf in leaves if leaf["key"] == key]
              for key in (key_a, key_b)}
    for key, found in chosen.items():
        if not found:
            raise ValueError(f"this view shows no part {key!r}; its parts are "
                             f"{', '.join(keys)}")
    if key_a == key_b:
        pairs = list(combinations(chosen[key_a], 2))
    else:
        pairs = [(a, b) for a in chosen[key_a] for b in chosen[key_b]]
    if not pairs:
        raise ValueError(f"{key_a!r} stands in this view once, so there is "
                         f"no second {key_a!r} to measure it against")

    steps = {key: Path(build_dir) / f"{key}.step" for key in (key_a, key_b)}
    stepless = [key for key in dict.fromkeys((key_a, key_b))
                if not steps[key].is_file()]
    # Each leaf's STEP body where the view puts it, for the leaves the view
    # draws as that body.
    placed = {}
    if not stepless:
        solids = {key: _step_solid(path) for key, path in steps.items()}
        involved = {id(leaf): leaf for pair in pairs for leaf in pair}
        for leaf in involved.values():
            if leaf["deformed"]:
                continue
            body = _moved(solids[leaf["key"]], leaf)
            if _stands_there(body, leaf):
                placed[id(leaf)] = body
    found = []
    for a, b in pairs:
        if id(a) in placed and id(b) in placed:
            found.append((STEP, *_step_pair(placed[id(a)], placed[id(b)],
                                            a, b), a, b))
        else:
            found.append((MESH, *_mesh_pair(a, b), a, b))
    method, distance, point_a, point_b, leaf_a, leaf_b = min(
        found, key=lambda entry: entry[1])
    return {
        "method": method,
        "distance": distance,
        "a": _leaf_name(leaf_a),
        "b": _leaf_name(leaf_b),
        "point_a": [float(value) for value in point_a],
        "point_b": [float(value) for value in point_b],
        "pairs": len(pairs),
        "stepless": stepless,
        "reshaped": ([] if stepless else
                     [_leaf_name(leaf) for leaf in (leaf_a, leaf_b)
                      if id(leaf) not in placed]),
        "tolerance": (None if method == STEP else
                      {_leaf_name(leaf_a): tolerance(leaf_a),
                       _leaf_name(leaf_b): tolerance(leaf_b)}),
    }


def describe(found):
    """The lines `hammerola measure` prints for one `measure` result."""
    a, b = found["a"], found["b"]
    mesh = found["method"] == MESH
    if not mesh:
        lines = ["method: exact, on the two parts' STEP solids placed as the "
                 "view places them"]
    else:
        missing, reshaped = found["stepless"], found["reshaped"]
        why = []
        if missing:
            why.append(f"{' and '.join(missing)} "
                       f"{'is' if len(missing) == 1 else 'are'} not printable, "
                       f"so the revision holds no STEP of "
                       f"{'it' if len(missing) == 1 else 'them'}")
        if reshaped:
            why.append(f"the view draws {' and '.join(reshaped)} as a shape "
                       f"of {'its' if len(reshaped) == 1 else 'their'} own, so "
                       f"{'its' if len(reshaped) == 1 else 'their'} STEP is "
                       f"not what stands there")
        lines = [f"method: the view's mesh -- {'; '.join(why)}"]
        each = found["tolerance"]
        allowance = f"{sum(each.values()):.3g} mm"
    nearest = (f" (the nearest of {found['pairs']} pairs)"
               if found["pairs"] > 1 else "")
    if found["distance"] <= TOUCHING_MM:
        contact = (f"touch, overlap, or are within {allowance} of each other"
                   if mesh else "touch or overlap")
        lines.append(f"distance: 0 mm -- {a} and {b} {contact}{nearest}, at "
                     f"{_point(found['point_a'])}")
    else:
        lines.append(f"distance: {found['distance']:.3f} mm, between {a} and "
                     f"{b}{nearest}")
        lines.append(f"closest points, in the view's coordinates: {a} at "
                     f"{_point(found['point_a'])}, {b} at "
                     f"{_point(found['point_b'])}")
    if mesh:
        named = ", ".join(f"{name} {value:.3g} mm"
                          for name, value in each.items())
        lines.append(
            f"the mesh can differ from the true gap by up to {allowance} "
            f"either way: larger on convex faces, smaller on concave ones such "
            f"as a hole (the two parts' tessellation tolerances: {named})")
        lines.append("on the mesh a part wholly inside the other reads as the "
                     "gap between their surfaces, not as 0")
    return lines


def tolerance(leaf):
    """The linear deflection the tessellator meshed this leaf at, in mm.

    From the leaf's `extent`, the size of its own vertices in its own frame,
    as the tessellator measured the solid before the view placed it.
    """
    return leaf["extent"] / 300.0 * TESSELLATION_DEVIATION


def _leaf_name(leaf):
    return leaf["name"] or leaf["key"]


def _point(point):
    return "(" + ", ".join(f"{value:.3f}" for value in point) + ")"


# -- exact: two STEP solids -------------------------------------------------
def _step_solid(path):
    """The one solid a printable's STEP holds, read the way the comparison
    reads it (`shapediff._one_solid`, which explains why not `importStep`)."""
    from .shapediff import _one_solid

    solid, reason = _one_solid(path)
    if reason is not None:
        raise ValueError(reason)
    return solid


def _stands_there(body, leaf):
    """Is the placed STEP body the one the view draws for this leaf?

    Held by bounding box against the leaf's placed triangles, which lie on the
    surface they were cut from: the two boxes differ by at most the leaf's
    tessellation tolerance, and a body that is not the one drawn there
    mostly by more. A shape that keeps the body's box passes, which is why
    a `deformed` leaf never reaches this check.
    """
    from OCP.BRepBndLib import BRepBndLib
    from OCP.Bnd import Bnd_Box

    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(body, box, False, False)
    corners = np.array([box.CornerMin().Coord(), box.CornerMax().Coord()])
    drawn = np.array([leaf["vertices"].min(axis=0),
                      leaf["vertices"].max(axis=0)])
    return bool(np.abs(corners - drawn).max()
                <= tolerance(leaf) + BOX_MARGIN_MM)


def _step_pair(body_a, body_b, leaf_a, leaf_b):
    """`(distance, point_a, point_b)` between two placed STEP bodies. Zero when
    one lies inside the other: the kernel says so with `InnerSolution` and
    points at a vertex inside."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    tool = BRepExtrema_DistShapeShape(body_a, body_b)
    if not tool.IsDone():
        raise ValueError(f"the kernel could not measure {_leaf_name(leaf_a)} "
                         f"against {_leaf_name(leaf_b)}")
    distance = 0.0 if tool.InnerSolution() else tool.Value()
    points = (tool.PointOnShape1(1), tool.PointOnShape2(1))
    return (distance, *(np.array([point.X(), point.Y(), point.Z()])
                        for point in points))


def _moved(solid, leaf):
    """The STEP solid where the view puts it: the leaf's groups, then its `at`."""
    from OCP.TopLoc import TopLoc_Location
    from OCP.gp import gp_Trsf

    at = leaf["at"]
    if not at:
        raise ValueError(
            f"the view records no `at` for {_leaf_name(leaf)}: it was built "
            f"before views recorded where each part is placed, so the part's "
            f"STEP cannot be placed in it. Publish the model again to measure "
            f"it")
    rotation, offset = _placed(leaf["parent"], at)
    trsf = gp_Trsf()
    trsf.SetValues(*rotation[0], offset[0], *rotation[1], offset[1],
                   *rotation[2], offset[2])
    return solid.Moved(TopLoc_Location(trsf))

# -- on the view's mesh -----------------------------------------------------
def _mesh_pair(a, b):
    """`(distance, point_a, point_b)` between two leaves' placed triangles.

    Exact for the triangles: every pair that could come nearer than the best
    found so far is measured by `_pair_gaps`. What keeps that from being every
    pair is a bound on each triangle -- its centroid and the sphere round it --
    searched in k-d trees, nearest candidates first, so the search stops as
    soon as nothing left can beat what it has.
    """
    from scipy.spatial import cKDTree

    tri_a = a["vertices"][a["faces"]]
    tri_b = b["vertices"][b["faces"]]
    # A first answer to search under: the two nearest vertices.
    gaps, nearest = cKDTree(b["vertices"]).query(a["vertices"])
    first = int(np.argmin(gaps))
    best = (float(gaps[first]), a["vertices"][first],
            b["vertices"][nearest[first]])

    centre_a, radius_a = _spheres(tri_a)
    centre_b, radius_b = _spheres(tri_b)
    groups = _by_radius(centre_b, radius_b, cKDTree)
    # Nothing of `b` comes nearer to a triangle of `a` than its floor.
    floor = np.full(len(tri_a), np.inf)
    for tree, _members, reach in groups:
        apart, _ = tree.query(centre_a)
        floor = np.minimum(floor, apart - reach)
    floor -= radius_a
    order = np.argsort(floor, kind="stable")

    for start in range(0, len(order), ROW_BATCH):
        rows = order[start:start + ROW_BATCH]
        rows = rows[floor[rows] < best[0]]
        if not len(rows):
            break
        i, j = _candidates(rows, centre_a, radius_a, groups, best[0])
        bound = (np.linalg.norm(centre_a[i] - centre_b[j], axis=1)
                 - radius_a[i] - radius_b[j])
        ranked = np.argsort(bound, kind="stable")
        for at in range(0, len(ranked), PAIR_BUDGET):
            chunk = ranked[at:at + PAIR_BUDGET]
            chunk = chunk[bound[chunk] < best[0]]
            if not len(chunk):
                break
            gap, on_a, on_b = _pair_gaps(tri_a[i[chunk]], tri_b[j[chunk]])
            k = int(np.argmin(gap))
            if gap[k] < best[0]:
                best = (float(gap[k]), on_a[k], on_b[k])
    return best


def _spheres(triangles):
    """Each triangle's centroid, and the radius round it that holds all three."""
    centre = triangles.mean(axis=1)
    radius = np.linalg.norm(triangles - centre[:, None, :], axis=2).max(axis=1)
    return centre, radius


def _by_radius(centre, radius, tree_class):
    """`[(tree, members, largest radius)]`, one per power of two of radius.

    A ball query has to reach as far as the largest triangle it may meet, so
    one tree over every triangle would make the few large faces of a box widen
    the search round every small one.
    """
    level = np.floor(np.log2(np.maximum(radius, 1e-9)))
    groups = []
    for value in np.unique(level):
        members = np.flatnonzero(level == value)
        groups.append((tree_class(centre[members]), members,
                       float(radius[members].max())))
    return groups


def _candidates(rows, centre_a, radius_a, groups, reach):
    """`(i, j)`: the triangles of `b` whose sphere comes within `reach` of the
    sphere of each triangle `rows` names in `a`."""
    found_i, found_j = [], []
    for tree, members, largest in groups:
        hits = tree.query_ball_point(centre_a[rows],
                                     radius_a[rows] + largest + reach)
        counts = np.fromiter((len(hit) for hit in hits), dtype=np.intp,
                             count=len(rows))
        if counts.sum():
            found_i.append(np.repeat(rows, counts))
            found_j.append(members[np.concatenate(
                [np.asarray(hit, dtype=np.intp) for hit in hits if hit])])
    if not found_i:
        return np.empty(0, dtype=np.intp), np.empty(0, dtype=np.intp)
    return np.concatenate(found_i), np.concatenate(found_j)


def _pair_gaps(ta, tb):
    """`(gap, on_a, on_b)` for each pair of triangles `ta[k]`, `tb[k]`.

    Two triangles that do not cross are nearest at a vertex of one against the
    other or at an edge of each, so those fifteen are measured; an edge passing
    through the other triangle is a crossing, at distance zero. A degenerate
    triangle gives NaN on some of them, which never wins.
    """
    from trimesh.triangles import closest_point

    best = np.full(len(ta), np.inf)
    on_a = np.zeros((len(ta), 3))
    on_b = np.zeros((len(ta), 3))

    def take(gap, point_a, point_b):
        better = gap < best
        best[better] = gap[better]
        on_a[better] = point_a[better]
        on_b[better] = point_b[better]

    with np.errstate(all="ignore"):
        for k in range(3):
            near = closest_point(tb, ta[:, k])
            take(np.linalg.norm(ta[:, k] - near, axis=1), ta[:, k], near)
            near = closest_point(ta, tb[:, k])
            take(np.linalg.norm(tb[:, k] - near, axis=1), near, tb[:, k])
        for k in range(3):
            start_a, end_a = ta[:, k], ta[:, (k + 1) % 3]
            start_b, end_b = tb[:, k], tb[:, (k + 1) % 3]
            hit, where = _pierces(start_a, end_a, tb)
            take(np.where(hit, 0.0, np.inf), where, where)
            hit, where = _pierces(start_b, end_b, ta)
            take(np.where(hit, 0.0, np.inf), where, where)
            for m in range(3):
                near_a, near_b = _segments(start_a, end_a, tb[:, m],
                                           tb[:, (m + 1) % 3])
                take(np.linalg.norm(near_a - near_b, axis=1), near_a, near_b)
    return best, on_a, on_b


def _dot(u, v):
    return np.einsum("ij,ij->i", u, v)


def _segments(p1, q1, p2, q2):
    """The closest points of each pair of segments `p1-q1`, `p2-q2`.

    Ericson, Real-Time Collision Detection, 5.1.9, over whole arrays: a segment
    of no length is a point, and parallel segments take any nearest pair.
    """
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a, e, f = _dot(d1, d1), _dot(d2, d2), _dot(d2, r)
    c, b = _dot(d1, r), _dot(d1, d2)
    denom = a * e - b * b
    s = np.where(denom > 1e-12 * a * e, np.clip((b * f - c * e) / denom, 0, 1),
                 0.0)
    t = (b * s + f) / e
    s = np.where(t < 0, np.clip(-c / a, 0, 1),
                 np.where(t > 1, np.clip((b - c) / a, 0, 1), s))
    t = np.clip(t, 0, 1)
    first_is_point, second_is_point = a <= 1e-24, e <= 1e-24
    s = np.where(first_is_point, 0.0,
                 np.where(second_is_point, np.clip(-c / a, 0, 1), s))
    t = np.where(second_is_point, 0.0,
                 np.where(first_is_point, np.clip(f / e, 0, 1), t))
    return p1 + d1 * s[:, None], p2 + d2 * t[:, None]


def _pierces(start, end, triangles):
    """`(hit, point)`: where each segment passes through its triangle.

    Möller-Trumbore, held to the segment; a segment in the triangle's plane is
    no hit here, and the vertex and edge distances catch it at zero.
    """
    direction = end - start
    e1 = triangles[:, 1] - triangles[:, 0]
    e2 = triangles[:, 2] - triangles[:, 0]
    h = np.cross(direction, e2)
    det = _dot(e1, h)
    scale = (np.linalg.norm(direction, axis=1) * np.linalg.norm(e1, axis=1)
             * np.linalg.norm(e2, axis=1))
    s = start - triangles[:, 0]
    u = _dot(s, h) / det
    q = np.cross(s, e1)
    v = _dot(direction, q) / det
    t = _dot(e2, q) / det
    hit = ((np.abs(det) > 1e-12 * scale) & (u >= 0) & (v >= 0) & (u + v <= 1)
           & (t >= 0) & (t <= 1))
    return hit, start + direction * np.where(hit, t, 0.0)[:, None]
