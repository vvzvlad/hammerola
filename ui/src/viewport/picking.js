// What is under the cursor: the part, the exact point, and the normal of the
// face.

import { cameraBasis, ndcRay } from "./camera.js";
import { cross3, len3, sub3, unit3, vec3 } from "./math.js";
import { insideSection, sectionSegments } from "./outline.js";
import { MIN_SPREAD, PROBE_PX, SECTION_INDEX } from "./options.js";

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

/**
 * Where the view ray through NDC `[nx, ny]` meets the section plane, as
 * `{ point, slope }` in world coordinates, or null.
 *
 * Uses `distanceToPoint` twice instead of the plane's components: it is the
 * method `internals()` guarantees, and its difference over a unit step along
 * the ray is `normal . dir`, whatever form `plane.normal` takes.
 *
 * `slope` is that `normal . dir`: the denominator of the intersection, and the
 * side the ray enters the plane from, which the cut-face resolver needs. It is
 * returned so both come from one computation.
 *
 * Null when the ray is parallel to the plane (as `sectionAxis` refuses to drag
 * in that pose).
 */
export function planePointAt(vp, g, ndc) {
  const b = cameraBasis(vp.viewer, g);
  if (!b) return null;
  const ray = ndcRay(g, b.eye, b.view, ndc[0], ndc[1]);
  if (!ray) return null;
  const at0 = ray.origin;
  const d0 = g.plane.distanceToPoint(vec3(at0));
  const d1 = g.plane.distanceToPoint(vec3([at0[0] + ray.dir[0],
                                           at0[1] + ray.dir[1],
                                           at0[2] + ray.dir[2]]));
  const slope = d1 - d0;
  if (!Number.isFinite(d0) || !Number.isFinite(slope) || slope === 0) return null;
  const t = -d0 / slope;
  const point = [at0[0] + t * ray.dir[0],
                 at0[1] + t * ray.dir[1],
                 at0[2] + t * ray.dir[2]];
  return point.every(Number.isFinite) ? { point, slope } : null;
}

/**
 * Is this solid's cut face on screen at all?
 *
 * Two separate answers in two places in the library. `cull`
 * (viewer/src/scene/clipping.ts:694) hides a cap mesh when its solid is too
 * small on screen, over the frame budget, or not straddled by the plane. Hiding
 * a part does not touch the cap: `setShapeVisible`
 * (viewer/src/scene/objectgroup.ts:549) sets `material.visible = false` on the
 * front face and the solid's stencil meshes, and the cap then renders against an
 * empty stencil, painting nothing. Neither can be read off the other.
 */
function capOnScreen(unit, solid) {
  if (!solid || solid.visible === false) return false;
  const front = solid.front;
  const face = front && front.material;
  if (face && face.visible === false) return false;
  const caps = unit.capMeshes;
  if (!Array.isArray(caps)) return false;
  // By `index`, not position: `_createStencils` fills `capMeshes` plane-major,
  // but the library writes each mesh's plane onto it, and a skipped solid would
  // shift positions silently.
  const cap = caps.find((c) => c && c.index === SECTION_INDEX);
  return !!cap && cap.visible !== false;
}

/**
 * The part whose cut face is under NDC `[nx, ny]`, in the shape `pickEntity`
 * answers with, or null when no cut stands or the cursor is not over one.
 *
 * The stencil cap is invisible to the id picker: `Clipping._createStencils`
 * (viewer/src/scene/clipping.ts:478) builds it from a quad with no component id
 * in no pick layer or registry. Giving it one does not work: the pick pass
 * replaces every material (`scene.overrideMaterial`,
 * viewer/src/rendering/id-picking.ts:1221), losing the stencil that trims the
 * quad to the silhouette, so the id would cover the whole clipping rectangle.
 * Without this, a click on a cut face names whatever lies behind it.
 *
 * Geometry replaces the pick. No depth comparison is needed, but the ray must
 * reach the plane from the clipped side: `slope > 0`.
 *
 * Along the ray `d(t) = d0 + t * slope` with `slope = normal . dir`, and the cap
 * is at zero. Whatever is nearer the reader is at `d < 0` exactly when
 * `slope > 0`, and three.js discards negative signed distance, so nothing in
 * front of the cap survives. The sign, from static/_v/three.module.js:
 * `clipping_planes_vertex` sets `vClipPosition = -mvPosition.xyz`,
 * `projectPlanes` packs the view-space constant into `plane.w`, and the fragment
 * discards on `dot(vClipPosition, plane.xyz) > plane.w`, i.e. on
 * `n . p + c < 0`.
 *
 * With `slope < 0` the near part of the ray is in the kept half; the plane point
 * is interior to the solid, so the ray crosses that solid's own surface first
 * and the picker already answers with the right solid (a ghosted part too). That
 * pose is one Flip or one orbit away.
 *
 * The ray, not the eye: an ortho ray starts at its own laterally offset point,
 * not at the eye. Near edge-on they disagree: a 2-unit cube cut at z = 1.895
 * with the camera 4.6 degrees off edge-on gives `normal . dir = +0.08` (looking
 * into the cut) while the eye's signed distance is `+0.202`. The band is about
 * `arcsin(d / 5R)` wide (`d` the plane's distance from the camera target, `R`
 * the model's bounding radius, `Camera.DISTANCE_FACTOR` 5), wider when the model
 * is panned off centre.
 *
 * No `t > 0` test: under ortho `unproject` puts the ray origin at mid depth, so
 * a visible cut face can sit at negative `t`.
 *
 * The path is found by identity: `nestedGroup.groups` is keyed by the slash
 * path, while `unit.solid.name` is the library's pipe form
 * (`path.replaceAll("/", this.delim)`, viewer/src/scene/nestedgroup.ts:606), and
 * reversing that is unsafe on names that may contain the delimiter.
 *
 * The answer has `pickEntity`'s shape, but `path` is the solid's own path (same
 * as `id`; a cap is no registered face) and `topo` is a synthetic "face".
 * `tools.js` reads `id` and `name` and passes `point` through in the pick event,
 * where it is a point on the cap's plane, not on a model surface. The comment
 * tool stands its arrow on that point, and `pins.js` reads it as the depth of
 * what hides an arrow; measure and move use `pickEntity`.
 */
export function capOwnerAt(vp, g, ndc) {
  // A cut on screen needs a seed and the renderer's clipping flag:
  // `suspendSectionCut` keeps the seed while the cut is off.
  if (!vp || !vp.sectionSeed || !g) return null;
  const viewer = vp.viewer;
  const renderer = viewer && viewer.renderer;
  if (!renderer || renderer.localClippingEnabled !== true) return null;
  try {
    // `_capUnits` is a private library field, read defensively (as the hatch
    // does); if it moves, the menu loses only this correction.
    const units = g.clipping && g.clipping._capUnits;
    const groups = g.nestedGroup && g.nestedGroup.groups;
    if (!Array.isArray(units) || !units.length || !groups) return null;
    const hit = planePointAt(vp, g, ndc);
    // Checked before any per-solid work: from the kept side every cap is behind
    // its own solid, and the picker is right.
    if (!hit || !(hit.slope > 0)) return null;
    const at = hit.point;
    for (const unit of units) {
      const solid = unit && unit.solid;
      if (!capOnScreen(unit, solid)) continue;
      const segments = sectionSegments(
        solid.front, g.plane.normal, g.plane.constant);
      if (!segments || !insideSection(segments, at, g.plane.normal)) continue;
      const path = Object.keys(groups).find((key) => groups[key] === solid);
      if (!path) continue;
      return { id: path, name: nameOf(path), path, topo: "face", point: at };
    }
    return null;
  } catch (error) {
    console.warn("cut face owner", error);
    return null;
  }
}

/** One face pixel: its component id and its world position, or null. */
function probeFace(picker, x, y, single) {
  // `topoFilter` keeps this on a face: the picker prefers vertex > edge > face,
  // so a click near an edge would return the edge, whose position lies on
  // another surface. `windowSize: 1` reads the exact pixel; the centre probe
  // keeps the default 3x3 window for the reader's aim.
  const opts = single ? { topoFilter: ["face"], windowSize: 1 }
                      : { topoFilter: ["face"] };
  const hit = picker.pickAt(x, y, opts);
  if (!hit || !hit.point) return null;
  return { id: hit.id, info: hit.info, point: hit.point };
}

/**
 * World normal + world point of the face under a canvas pixel, or null.
 *
 * No raycaster: three.js is not a dependency of this bundle. The picker's
 * render target carries world position beside the id, so three pixels of the
 * same face give the normal as a cross product. The result is already in world
 * space (no normal matrix to get wrong), and the samples honour clipping like
 * the screen, so a surface exposed by an earlier cut reads as that surface.
 *
 * On a curved face this is the local tangent plane, which is the plane the cut
 * will follow at that spot.
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
