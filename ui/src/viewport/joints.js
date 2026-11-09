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

import { after, turned } from "./math.js";

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
