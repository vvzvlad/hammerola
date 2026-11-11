// The joints a view document declares, and where a node a joint moves stands
// at a value: pure arithmetic on plain arrays, like math.js (three.js is not a
// dependency of this bundle).
//
// The document (built by the hub) carries, at its root,
//
//     "joints": [{"id", "type": "revolute", "origin", "axis", "limits"},
//                {"id", "type": "slider", "axis", "limits"}],
//     "poses":  [{"name", "values": {jointId: value}}]
//
// and `"joint": "<id>"` on each leaf or group node a joint moves. A revolute
// value is degrees about `axis` through `origin`, a slider value millimetres
// along `axis`; `axis` is a unit vector. Value 0 is the node's own `loc`. Both
// are in the frame the node's `loc` is in, its parent's, so a jointed node under
// a jointed group is a chain the library's parent groups compose.

import { after, clamp, cross3, dot3, turned, unit3 } from "./math.js";

const DEGREES = Math.PI / 180;

/** Where a node stands with nothing moving it, when its document says nothing:
 *  the library writes this same identity onto a group without a `loc`
 *  (`renderLoop`, viewer/src/scene/nestedgroup.ts). */
const IDENTITY = [[0, 0, 0], [0, 0, 0, 1]];

/** A turn of `degrees` about the unit vector `axis`, as `[x, y, z, w]`. */
function aboutAxis(axis, degrees) {
  const half = (degrees * DEGREES) / 2;
  const s = Math.sin(half);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}

/**
 * Where a node a joint moves stands at `value`: `M(value) ∘ loc`, as
 * `[position, quaternion]` for the node's group.
 *
 * A revolute `M` turns by `q` about the line through `origin`, so a point `x`
 * of the parent's frame goes to `origin + q·(x - origin)`. After `loc` (`x =
 * position + R·v`) a vertex `v` lands at
 * `origin + q·(position - origin) + (q⊗R)·v`, which is the pair below.
 * A slider `M` shifts by `value` along `axis`, and the facing stays.
 *
 * `loc` may be what the Move tool would show rather than the document's own
 * placement: the joint is composed after the reader's drag (`stand` in
 * parts.js), and its inverse is the same joint at `-value`.
 */
export function jointPose(joint, value, loc) {
  const [position, quaternion] = loc;
  const axis = joint.axis;
  if (joint.type === "revolute") {
    const q = aboutAxis(axis, value);
    const o = joint.origin;
    const back = turned(q, [position[0] - o[0], position[1] - o[1], position[2] - o[2]]);
    return [[o[0] + back[0], o[1] + back[1], o[2] + back[2]], after(q, quaternion)];
  }
  return [[position[0] + value * axis[0], position[1] + value * axis[1],
           position[2] + value * axis[2]], quaternion];
}

/**
 * Every node of `doc` a declared joint moves, by the node's `id` — the key the
 * library files its group under in `nestedGroup.groups` — as
 * `{joint, loc}`, `loc` the node's own placement (joint value 0).
 *
 * A node naming a joint the root does not declare moves with nothing.
 */
export function jointNodes(doc) {
  const nodes = new Map();
  const declared = new Map((doc && Array.isArray(doc.joints) ? doc.joints : [])
    .map((joint) => [joint.id, joint]));
  if (!declared.size) return nodes;
  const walk = (node) => {
    const joint = declared.get(node.joint);
    if (joint) nodes.set(node.id, { joint, loc: node.loc || IDENTITY });
    if (Array.isArray(node.parts)) node.parts.forEach(walk);
  };
  walk(doc);
  return nodes;
}

/**
 * Where a point of a body stands once the body's group goes from placement
 * `from` to placement `to` (each `[position, quaternion]`): `point` is in the
 * frame `from` is given in, and the answer in the frame of `to`.
 *
 * The Move tool turns a part about its centre in the frame its move is
 * recorded in, at joint value 0 (`pivot` in parts.js): the centre is read off
 * the scene in the world, `from` is where the group stands in the world, and
 * `to` is the part's own seat in that frame.
 */
export function restPoint(point, from, to) {
  const [p, q] = from;
  const local = turned([-q[0], -q[1], -q[2], q[3]],
                       [point[0] - p[0], point[1] - p[1], point[2] - p[2]]);
  const there = turned(to[1], local);
  return [to[0][0] + there[0], to[0][1] + there[1], to[0][2] + there[2]];
}

/** Does any joint stand away from 0 in `values` (`{jointId: value}`)? */
export const posed = (values) => Object.values(values).some((value) => value !== 0);

// -- dragging a joint in the scene (tools.js) ---------------------------------

/**
 * The node a press on the part at `path` drags: the nearest one up the tree a
 * joint moves, as `{path, node}` with `node` from `jointNodes`, or null.
 *
 * Longest prefix first, so a latch inside a door group moves the latch's own
 * joint and not the door's.
 */
export function jointAbove(nodes, path) {
  const steps = String(path || "").split("/");
  for (let n = steps.length; n > 0; n -= 1) {
    const prefix = steps.slice(0, n).join("/");
    const node = nodes.get(prefix);
    if (node) return { path: prefix, node };
  }
  return null;
}

/**
 * A joint's line carried into the world: `{origin, axis}`, `origin` null for a
 * slider and `axis` a unit vector (null if it has none).
 *
 * `e` is the world matrix of the frame the joint is declared in, its node's
 * parent group, as three keeps `matrixWorld.elements` (column-major).
 */
export function jointInWorld(joint, e) {
  const [x, y, z] = joint.axis;
  const axis = unit3([e[0] * x + e[4] * y + e[8] * z,
                      e[1] * x + e[5] * y + e[9] * z,
                      e[2] * x + e[6] * y + e[10] * z]);
  if (joint.type !== "revolute") return { origin: null, axis };
  const [a, b, c] = joint.origin;
  return {
    origin: [e[0] * a + e[4] * b + e[8] * c + e[12],
             e[1] * a + e[5] * b + e[9] * c + e[13],
             e[2] * a + e[6] * b + e[10] * c + e[14]],
    axis,
  };
}

/**
 * Where a world ray `{origin, dir}` meets the plane through `centre` normal to
 * the unit `axis`, as an angle in degrees about `axis`; null for a ray lying in
 * the plane.
 *
 * `ringAngle` in rings.js for any axis: `atan2` in a pair `u`, `v` of the plane
 * with `u × v = axis`, so the angle grows the way a revolute value does. `u`
 * depends on `axis` alone, so every call of one gesture measures from one zero.
 */
export function rayAngle(ray, centre, axis) {
  const along = dot3(ray.dir, axis);
  if (!along) return null;
  const t = (dot3(axis, centre) - dot3(axis, ray.origin)) / along;
  // Behind the eye of a perspective camera the plane is not on screen.
  if (ray.fromEye && !(t > 0)) return null;
  const on = [ray.origin[0] + t * ray.dir[0] - centre[0],
              ray.origin[1] + t * ray.dir[1] - centre[1],
              ray.origin[2] + t * ray.dir[2] - centre[2]];
  // The world axis least along `axis`, so the cross product is never short.
  const [ax, ay, az] = axis.map(Math.abs);
  const seed = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  const u = unit3(cross3(seed, axis));
  const v = cross3(axis, u);
  const theta = Math.atan2(dot3(on, v), dot3(on, u)) / DEGREES;
  return Number.isFinite(theta) ? theta : null;
}

/** A step of a dragged angle in degrees, brought into (-180, 180]: summed step
 *  by step, a sweep past the half turn keeps counting instead of jumping back. */
export const unwrapped = (step) => step - 360 * Math.ceil((step - 180) / 360);

/** `value` held to the joint's limits. */
export const withinLimits = (joint, value) => clamp(value, joint.limits[0], joint.limits[1]);
