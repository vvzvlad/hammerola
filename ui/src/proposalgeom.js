// ui/src/proposalgeom.js — the proposal document turned into something show()
// takes.
//
// The kernel half of the proposal panel, kept away from proposal.js so the
// document stays testable with no geometry computed. Everything here is pure: a
// document in, one payload out, no state between calls.
//
// ONE PART PER BODY. Every solid is its own part — placed by the document, with
// every hole cut out of it — so the Move tool can drag one body away from the
// others. Overlapping solids are two surfaces in one place rather than one
// welded body; that is accepted.
//
// THE HOLES ARE PARTS TOO, drawn at low alpha over the solids, so the person can
// see and point at what they asked for (OpenSCAD's `#` modifier idiom).
//
// THE HEX VALUES LIVE HERE because they are MODEL part colours, not interface
// chrome. tests/test_ui_source.py forbids colour literals on the build page and
// names this module in one of its two exemptions (the other is `DIFF_COLOURS`
// in hub.js).
import {
  booleans, geometries, measurements, primitives, transforms,
} from '@jscad/modeling'

// The bodies the person is claiming: a neutral grey that is nobody's real part.
const RESULT_COLOR = '#9aa3ad'
// The subtraction tool, in the colour and the transparency OpenSCAD's `#` uses.
const HOLE_COLOR = '#d64545'
const HOLE_ALPHA = 0.25

// The group every part hangs under while this payload stands alone. Over a
// model the viewport re-roots the list under its own group (`staged` in
// viewport/element.js), because the library's group and picking ids must match
// where a part sits in the tree.
const ROOT = 'proposal'

const DEGREES = Math.PI / 180

/** A fresh identity placement — position and quaternion, the shape a part's `loc` is. */
const origin = () => [[0, 0, 0], [0, 0, 0, 1]]

// One entry per op, keyed like `DIMS` in proposal.js. Each builds the op at the
// origin; `placed` rotates and moves it. Every op here is centred on the
// origin, so `at` is the body's centre.
const SHAPES = {
  box: (node) => primitives.cuboid({ size: node.size }),
  cylinder: (node) => primitives.cylinder({
    radius: node.d / 2, height: node.h,
  }),
  sphere: (node) => primitives.sphere({ radius: node.d / 2 }),
}

// The ops this table answers for — see `DIM_OPS` in proposal.js.
export const SHAPE_OPS = Object.freeze(Object.keys(SHAPES))

/** One node as geometry, rotated and moved to where the document puts it. */
function placed(node) {
  const shape = SHAPES[node.op](node)
  const turned = transforms.rotate(node.rot.map((angle) => angle * DEGREES), shape)
  return transforms.translate(node.at, turned)
}

// `booleans.union` refuses an empty list (a document with no holes, a panel just
// opened), so the fold starts from an empty geometry; `subtract(x, empty)` is
// `x`.
const fuse = (geoms) => booleans.union(geometries.geom3.create(), ...geoms)

// `bb` belongs to the shape `show()` accepts, but only `parts` leaves this
// module (`setProposal` takes `buildProposal(doc).parts`); nothing in `ui/src`
// reads it. A document with no solids — a panel just opened — gets an empty
// envelope here, since the kernel refuses an empty list.
function envelope(geoms) {
  if (!geoms.length) return [[0, 0, 0], [0, 0, 0]]
  const boxes = geoms.map((geom) => measurements.measureBoundingBox(geom))
  const axes = [0, 1, 2]
  return [
    axes.map((axis) => Math.min(...boxes.map(([min]) => min[axis]))),
    axes.map((axis) => Math.max(...boxes.map(([, max]) => max[axis]))),
  ]
}

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
 * not emitted: they are OCCT enumerations, and the library guards every read
 * (`hasTrianglesPerFace` / `hasSegmentsPerEdge` in three-cad-viewer.esm.js),
 * treating the tessellation as one face and one edge.
 *
 * `edges` and `obj_vertices` go out EMPTY on purpose. A mesh has facet
 * boundaries, not edges, and which were real corners is information the kernel
 * discarded. Every rule tried for guessing them drew something false: all
 * boundaries gave a wire ball (160 lines on a d12 cylinder, 992 on a d16
 * sphere); an angle filter was exact on primitives (12 edges on a box, 64 on a
 * cylinder, 0 on a sphere) but broke on boolean results, whose T-junctions leave
 * edges with no partner; splitting those junctions first removed debris but
 * still invented edges. A line across a flat face is a feature nobody asked
 * for, so nothing is drawn; flat per-face normals keep the form readable.
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

// No `key`: it is the catalogue key into `meta.parts` (`treeFromShapes` in
// viewport/parts.js), and a proposal body is in no catalogue. Filled with the
// name, it would let a note be stored under a real key the name collides with.
//
// `origin` is not read by the viewer. `placed` rotates a body in its own
// coordinates and then moves it to `at`, and the mesh bakes that into its
// vertices under an identity `loc`, so the scene cannot recover the body's
// origin. The viewport needs it to turn a body about the point the document
// will (`bodyOrigin` in viewport/rings.js); the bounding box centre would be
// wrong by tens of millimetres on a long extrusion.
function part(name, geom, color, alpha, at) {
  return {
    id: `/${ROOT}/${name}`,
    type: 'shapes',
    subtype: 'solid',
    name,
    color,
    alpha,
    state: [1, 1],
    loc: origin(),
    origin: [...at],
    shape: mesh(geom),
  }
}

/**
 * The whole document as one payload the viewport's `show()` accepts.
 *
 * A move is not geometry: the viewport shifts the part already in the model.
 * The filters name the roles that ARE drawn rather than exclude the one that is
 * not, so a future role is not drawn by accident.
 */
export function buildProposal(doc) {
  const solids = doc.nodes.filter((node) => node.role === 'solid')
  const holes = doc.nodes.filter((node) => node.role === 'hole')
  const holeGeoms = holes.map(placed)
  // Every hole is cut out of every solid: a hole belongs to the proposal, not to
  // the body it sits inside.
  const cutter = fuse(holeGeoms)
  const solidGeoms = solids.map((node) => booleans.subtract(placed(node), cutter))
  const [min, max] = envelope(solidGeoms)

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
      ...solids.map((node, index) => part(
        node.name, solidGeoms[index], RESULT_COLOR, 1, node.at,
      )),
      ...holes.map((node, index) => part(
        node.name, holeGeoms[index], HOLE_COLOR, HOLE_ALPHA, node.at,
      )),
    ],
  }
}
