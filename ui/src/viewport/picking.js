// What is under the cursor: the part, the exact point, and — the piece that had
// to be built — the NORMAL of the face.

import { cross3, len3, sub3, unit3 } from "./math.js";
import { MIN_SPREAD, PROBE_PX } from "./options.js";

/** The solid that owns a picked face/edge/vertex, as a path.
 *
 * The same rule the library uses internally, spelled out here because its helper
 * is not exported.
 */
export function solidOf(info) {
  if (!info) return null;
  return info.solidPath
    || String(info.path).replace(/\/(faces|edges|vertices)\/[^/]+$/, "");
}

/** The last component of a path — what a person calls the part. */
export const nameOf = (path) => String(path || "").split("/").filter(Boolean).pop() || null;

/**
 * Resolve a canvas pixel into `{ id, name, path, topo, point }`, or null.
 *
 * `id` is the SOLID PATH and not a number: it is the key `getStates()`,
 * `nestedGroup.groups` and the measurement backend all take, so handing the
 * interface anything else would mean a translation table somewhere. `path` is
 * the finer one — down to `/faces/faces_12` — which is what a measurement needs.
 */
export function pickEntity(g, x, y, options) {
  let hit = null;
  try {
    hit = g.picker.pickAt(x, y, options || {});
  } catch (error) {
    console.warn("pick", error);
    return null;
  }
  if (!hit || !hit.info) return null;
  const id = solidOf(hit.info);
  if (!id) return null;
  return {
    id,
    name: nameOf(id),
    path: hit.info.path,
    topo: hit.info.topo,
    point: hit.point
      ? [hit.point.x, hit.point.y, hit.point.z]
      : null,
  };
}

/** One face pixel: its component id and its world position, or null. */
function probeFace(picker, x, y, single) {
  // `topoFilter` is what keeps this on a FACE. The picker resolves
  // vertex > edge > face by priority, so a click a few pixels from an edge would
  // otherwise come back as that edge — whose "normal" is meaningless and whose
  // position sits on a different surface than the one that was aimed at.
  // `windowSize: 1` reads the exact pixel; the centre probe keeps the default
  // 3x3 window so the reader's aim gets the same tolerance as anywhere else.
  const opts = single ? { topoFilter: ["face"], windowSize: 1 }
                      : { topoFilter: ["face"] };
  const hit = picker.pickAt(x, y, opts);
  if (!hit || !hit.point) return null;
  return { id: hit.id, info: hit.info, point: hit.point };
}

/**
 * World normal + world point of the face under a canvas pixel, or null.
 *
 * THERE IS NO RAYCASTER HERE, and that is the interesting part. The vendored
 * bundle exports `Viewer` and `Display` and nothing else — no `Raycaster`, no
 * `Ray`, no `Vector3` — and shipping a second copy of three.js to read one
 * normal is not a trade worth making.
 *
 * The picker itself has what is needed. Its render target carries WORLD POSITION
 * next to the id, so three pixels of the SAME face read off that buffer give the
 * normal as a cross product. Two things fall out of that for free: the result is
 * already in world space, so there is no object matrix and no normal matrix to
 * get wrong (a normal does not transform by the same matrix as a point, and that
 * is a classic way to end up with a plane that is subtly skew); and the samples
 * honour clipping exactly the way the pixels on screen do, so clicking a surface
 * an earlier cut exposed reads THAT surface and not the one that was cut away.
 *
 * On a curved face this returns the local tangent plane, which is the useful
 * answer: it is the plane the cut will actually follow at that spot.
 */
export function faceNormalAt(picker, x, y) {
  const centre = probeFace(picker, x, y, false);
  if (!centre) return null;
  const ring = [[1, 0], [0, 1], [-1, 0], [0, -1],
                [1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (const r of PROBE_PX) {
    const pts = [];
    for (const [dx, dy] of ring) {
      const s = probeFace(picker, x + dx * r, y + dy * r, true);
      // Same component id, or the sample belongs to another face and the cross
      // product would describe an edge between two surfaces rather than one.
      if (s && s.id === centre.id) pts.push(s.point);
    }
    let best = null;
    let bestSine = 0;
    for (let i = 0; i < pts.length; i += 1) {
      for (let j = i + 1; j < pts.length; j += 1) {
        const a = sub3(pts[i], centre.point);
        const b = sub3(pts[j], centre.point);
        const n = cross3(a, b);
        const scale = len3(a) * len3(b);
        if (scale <= 0) continue;
        // |a x b| / (|a||b|) is the sine of the angle between the two samples:
        // scale-free, so a nearly collinear pair is rejected the same way on a
        // 2 mm part and a 2 m one.
        const sine = len3(n) / scale;
        if (sine > bestSine) {
          bestSine = sine;
          best = unit3(n);
        }
      }
    }
    if (best && bestSine > MIN_SPREAD) {
      return { normal: best, point: centre.point, info: centre.info };
    }
  }
  return null;
}
