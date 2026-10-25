// ui/src/viewport/coplanar.js — a stable winner where two parts share a plane.
//
// A driver's flange flush with the panel it sits in, a magnet flush with its
// pocket: planar faces of two parts lying in one plane and facing the same way
// paint the same pixels at the same depth. Which one the depth test keeps is
// then decided by rasterizer rounding, pixel by pixel, and the overlap shows as
// stripes. Every such pair gets a winner here that does not change from pixel
// to pixel: the smaller part (by its bounding-box diagonal) is drawn over the
// larger one, whose faces get a polygon offset a little deeper than the +1/+1
// every face already has (viewer/src/rendering/material-factory.ts).
//
// Only parts that really share a plane are touched. One global order over all
// parts would also separate surfaces that are merely close — a KiCad board's
// mask lies tens of microns over its copper — and at a grazing angle a single
// step of offset is deeper than that.
//
// The step was measured in Chrome on an Apple M4 (ANGLE over Metal), counting
// panel-coloured pixels on the rim of a woofer flange flush with its panel:
// +0.05 factor with +16 units cleared the rim at every view from face-on to 85
// degrees. Factor alone fails near face-on, where the depth slope vanishes;
// units alone fail at oblique views. Twice that is used.

const PLANE = 0; // GeomAbs_Plane, as a shape's `face_types` codes it
const STEP_FACTOR = 0.1;
const STEP_UNITS = 32;
// Two faces are in one plane when their unit normals agree to 1e-4 and their
// distances from the origin to a micron (model units are millimetres).
const NORMAL_GRID = 1e4;
const DISTANCE_GRID = 1e3;
// Boxes that only touch along an edge do not overlap: panels butted side by
// side share their outer plane without covering each other.
const TOUCH = 1e-3;

/** Every leaf of the payload that carries CAD faces. A mesh (a scan) carries
 *  no face codes — its `face_types` is empty — so it yields no planar faces
 *  and is never paired. */
function leaves(node, out = []) {
  if (node.shape && node.shape.face_types && node.shape.triangles_per_face) out.push(node);
  for (const child of node.parts || []) leaves(child, out);
  return out;
}

/** One leaf's planar faces in world space — each as its plane key and its box
 *  in that plane — and the diagonal of the whole leaf's box. */
function planarFaces(shape, matrix) {
  const { vertices: V, normals: N, triangles: T, face_types, triangles_per_face } = shape;
  const e = matrix.elements;
  const world = (i) => {
    const x = V[3 * i], y = V[3 * i + 1], z = V[3 * i + 2];
    return [e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14]];
  };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length / 3; i++) {
    const p = world(i);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  }
  const faces = [];
  let t = 0;
  for (let f = 0; f < face_types.length; t += triangles_per_face[f], f++) {
    if (face_types[f] !== PLANE || !triangles_per_face[f]) continue;
    // A planar face carries its own normal at every vertex.
    const i0 = T[3 * t];
    const nx = N[3 * i0], ny = N[3 * i0 + 1], nz = N[3 * i0 + 2];
    const n = [e[0] * nx + e[4] * ny + e[8] * nz,
               e[1] * nx + e[5] * ny + e[9] * nz,
               e[2] * nx + e[6] * ny + e[10] * nz];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len) continue;
    for (let k = 0; k < 3; k++) n[k] /= len;
    const p0 = world(i0);
    const d = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
    const q = n.map((c) => Math.round(c * NORMAL_GRID));
    const key = [...q, Math.round(d * DISTANCE_GRID)].join(",");
    // The box in the plane: drop the axis the normal leans on most, read off
    // the rounded normal of the key, so every face of one plane drops the same
    // axis even at 45 degrees, where the raw components tie.
    const drop = [0, 1, 2].reduce((a, b) => (Math.abs(q[b]) > Math.abs(q[a]) ? b : a));
    const [u, v] = [(drop + 1) % 3, (drop + 2) % 3];
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let j = 3 * t; j < 3 * (t + triangles_per_face[f]); j++) {
      const p = world(T[j]);
      box[0] = Math.min(box[0], p[u]); box[1] = Math.min(box[1], p[v]);
      box[2] = Math.max(box[2], p[u]); box[3] = Math.max(box[3], p[v]);
    }
    faces.push({ key, box });
  }
  return { faces, diagonal: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
}

const overlap = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > TOUCH
  && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > TOUCH;

/**
 * Push back, by a few steps of polygon offset, every part that shares a plane
 * with a smaller one. Called once per `viewer.render()`, which builds fresh
 * materials. Returns each paired part's depth in steps, 0 for one that stays.
 *
 * Never throws: the caller is `show()`, whose catch replaces the model with the
 * error panel, and stripes are the worst a failure here can leave.
 */
export function settleCoplanar(nestedGroup, doc) {
  const levels = new Map();
  try {
    const planes = new Map();
    const size = new Map();
    for (const node of leaves(doc)) {
      const group = nestedGroup.groups[node.id];
      if (!group || !group.front) continue;
      group.front.updateWorldMatrix(true, false);
      const { faces, diagonal } = planarFaces(node.shape, group.front.matrixWorld);
      size.set(node.id, diagonal);
      for (const face of faces) {
        if (!planes.has(face.key)) planes.set(face.key, []);
        planes.get(face.key).push({ id: node.id, box: face.box });
      }
    }
    const partners = new Map();
    const link = (a, b) => {
      if (!partners.has(a)) partners.set(a, new Set());
      partners.get(a).add(b);
    };
    for (const faces of planes.values()) {
      for (let i = 0; i < faces.length; i++) {
        for (let j = i + 1; j < faces.length; j++) {
          const a = faces[i], b = faces[j];
          if (a.id === b.id || !overlap(a.box, b.box)) continue;
          link(a.id, b.id);
          link(b.id, a.id);
        }
      }
    }
    // Smallest first, so each part lands one step behind the deepest of its
    // smaller partners. Two of a size are told apart the same way.
    const order = [...partners.keys()].sort((p, q) => size.get(p) - size.get(q));
    for (const id of order) {
      let level = 0;
      for (const other of partners.get(id)) {
        if (levels.has(other)) level = Math.max(level, levels.get(other) + 1);
      }
      levels.set(id, level);
    }
    for (const [id, level] of levels) {
      const material = nestedGroup.groups[id].front.material;
      material.polygonOffsetFactor += STEP_FACTOR * level;
      material.polygonOffsetUnits += STEP_UNITS * level;
    }
  } catch (error) {
    console.warn("coplanar faces", error);
  }
  return levels;
}
