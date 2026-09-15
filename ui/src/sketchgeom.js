// ui/src/sketchgeom.js — the sketch document turned into something show() takes.
//
// The kernel half of the sketch panel, kept away from sketch.js so the document
// stays testable with no geometry computed. Everything here is pure: a document
// in, one payload out, no state between calls.
//
// THE PAYLOAD CARRIES TWO THINGS, and that is the whole point of the display.
// One part is `result` — every solid fused and every hole cut out of it — which
// is the body the person is claiming. The others are the HOLES THEMSELVES, one
// part each, drawn at low alpha on top of it. A hole that is only ever
// subtracted is invisible the moment it is inside the body, so the person cannot
// see what they have asked for, cannot point at it and cannot tell a hole that
// missed from a hole that was never added. Showing the subtraction tool beside
// the result is OpenSCAD's `#` modifier idiom and it is here for its reason.
//
// THE HEX VALUES LIVE HERE. They are the colours of MODEL parts — the same kind
// of value as the part colours the hub pushes in a view file — rather than
// interface chrome, and tests/test_ui_source.py forbids a colour literal in
// HammerolaViewer.jsx precisely so that nobody paints a panel by hand; a part
// colour has to be somewhere, and the module that builds the parts is it.
import {
  booleans, extrusions, geometries, measurements, primitives, transforms,
} from '@jscad/modeling'

import { resolveValue } from './sketch.js'

// The body the person is claiming: a neutral grey that is nobody's real part.
const RESULT_COLOR = '#9aa3ad'
// The subtraction tool, in the colour and the transparency OpenSCAD's `#` uses.
const HOLE_COLOR = '#d64545'
const HOLE_ALPHA = 0.25

// The one group every part hangs under WHILE THIS PAYLOAD STANDS ALONE. Over a
// model the viewport re-roots the whole list under a group of its own (`staged`
// in viewport/element.js), because the ids the library keys `nestedGroup.groups`
// and its picking registry by have to agree with the tree it builds out of
// wherever a part SITS — and that is under the model's root, not this one.
const ROOT = 'sketch'

// THE NAME THE PAYLOAD KEEPS FOR ITSELF. The fused body is always a part called
// this, so a body the reader names `result` would be a second part under one id:
// one entry in the library's groups map, one row in the tree, and no way to tell
// which of the two the eye belongs to. The panel mints names around it.
export const RESULT_NAME = 'result'

const DEGREES = Math.PI / 180

/** A fresh identity placement — position and quaternion, the shape a part's `loc` is. */
const origin = () => [[0, 0, 0], [0, 0, 0, 1]]

// ONE ENTRY PER OP, keyed the way `DIMS` in sketch.js is keyed. Each builds the
// op at the origin in its own natural orientation; `placed` below does the
// rotation and the move. A box, a cylinder and a sphere come back CENTRED on the
// origin, so `at` is their centre — an extrusion does not, because its profile
// already says where it sits in the plane, so `at` is the corner of its own
// coordinate system and the extrusion runs up from there.
const SHAPES = {
  box: (dim, node) => primitives.cuboid({ size: node.size.map(dim) }),
  cylinder: (dim, node) => primitives.cylinder({
    radius: dim(node.d) / 2, height: dim(node.h),
  }),
  sphere: (dim, node) => primitives.sphere({ radius: dim(node.d) / 2 }),
  extrude: (dim, node) => extrusions.extrudeLinear(
    { height: dim(node.h) }, primitives.polygon({ points: node.profile }),
  ),
}

// The ops this table answers for — the other half of the pair `DIM_OPS` in
// sketch.js explains, and derived the same way so neither list can go stale
// without the table it is taken from going with it.
export const SHAPE_OPS = Object.freeze(Object.keys(SHAPES))

/** One node as geometry, rotated and moved to where the document puts it. */
function placed(doc, node) {
  const dim = (value) => resolveValue(doc, value)
  const shape = SHAPES[node.op](dim, node)
  const turned = transforms.rotate(node.rot.map((angle) => angle * DEGREES), shape)
  return transforms.translate(node.at, turned)
}

// Fusing a list that may be EMPTY, which every sketch is at least once: a
// document with no holes, and a panel the moment it opens. `booleans.union`
// refuses to be called with nothing, so the fold starts from an empty geometry
// instead — and `subtract(x, empty)` is `x`, so the result expression below needs
// no case of its own either.
const fuse = (geoms) => booleans.union(geometries.geom3.create(), ...geoms)

/**
 * A jscad geometry as the flat arrays the viewer's `shape` is made of.
 *
 * Its polygons are convex and carry no shared vertex pool, so each one is
 * triangulated as a fan and gets its own copy of every vertex, with the
 * polygon's plane normal repeated across them. That is what makes the faces read
 * as flat rather than smoothed, and it is also what the viewer's face picking
 * wants: no vertex belongs to two faces.
 *
 * `face_types`, `edge_types`, `triangles_per_face` and `segments_per_edge` are
 * NOT emitted. They are OCCT's own enumerations, which a mesh kernel has nothing
 * to say about, and the library guards every read of them —
 * `hasTrianglesPerFace` / `hasSegmentsPerEdge` in three-cad-viewer.esm.js, whose
 * absent branches treat the tessellation as one face and one edge.
 *
 * `edges` AND `obj_vertices` GO OUT EMPTY, and that is the decision this comment
 * exists for, because the obvious thing to do is fill them. A mesh has no edges.
 * It has facet boundaries, and which of those were a real corner and which were
 * a circle cut into segments is information the kernel threw away. Three rules
 * for guessing it back were measured here and every one of them drew something
 * false: all boundaries put 160 lines on a d12 cylinder and 992 on a d16 sphere,
 * a wire ball rather than a body; filtering by the angle between the two faces
 * fixed the primitives exactly (12 on a box, 64 on a cylinder, 0 on a sphere) and
 * then broke on anything cut, because a boolean leaves T-junctions and an edge
 * whose partner was split differently has nothing to compare against; splitting
 * those junctions first cut the debris but not the guessing. A line drawn across
 * a face that is flat is a feature the person never asked for, shown to somebody
 * whose whole job here is to judge a shape — so nothing is drawn rather than
 * something invented. Flat per-face normals are what makes the form readable,
 * and they come from the loop above.
 */
function mesh(geom) {
  const vertices = []
  const normals = []
  const triangles = []

  for (const polygon of geometries.geom3.toPolygons(geom)) {
    const plane = geometries.poly3.plane(polygon)
    const points = polygon.vertices
    const base = vertices.length / 3

    for (const point of points) {
      vertices.push(point[0], point[1], point[2])
      normals.push(plane[0], plane[1], plane[2])
    }
    for (let corner = 1; corner + 1 < points.length; corner += 1) {
      triangles.push(base, base + corner, base + corner + 1)
    }
  }

  return { vertices, triangles, normals, edges: [], obj_vertices: [] }
}

// NO `key`, and that absence is the decision. `key` is the CATALOGUE key — the
// entry in `meta.parts` a row looks its files, its note and its kind up by
// (`treeFromShapes` in viewport/parts.js says why a row has two names) — and a
// sketch body is in no catalogue at all. Filled in with the name, it made the
// row offer a reader's note, stored under whatever real catalogue key the name
// happened to collide with.
function part(name, geom, color, alpha) {
  return {
    id: `/${ROOT}/${name}`,
    type: 'shapes',
    subtype: 'solid',
    name,
    color,
    alpha,
    state: [1, 1],
    loc: origin(),
    shape: mesh(geom),
  }
}

/** The whole document as one payload the viewport's `show()` accepts. */
export function buildSketch(doc) {
  const solids = doc.nodes.filter((node) => node.role === 'solid')
  const holes = doc.nodes.filter((node) => node.role === 'hole')
  const holeGeoms = holes.map((node) => placed(doc, node))
  const result = booleans.subtract(
    fuse(solids.map((node) => placed(doc, node))), fuse(holeGeoms),
  )
  const [min, max] = measurements.measureBoundingBox(result)

  return {
    version: 3,
    name: ROOT,
    id: `/${ROOT}`,
    loc: origin(),
    bb: {
      xmin: min[0], xmax: max[0],
      ymin: min[1], ymax: max[1],
      zmin: min[2], zmax: max[2],
    },
    normal_len: 0,
    parts: [
      part(RESULT_NAME, result, RESULT_COLOR, 1),
      ...holes.map((node, index) => part(
        node.name, holeGeoms[index], HOLE_COLOR, HOLE_ALPHA,
      )),
    ],
  }
}
