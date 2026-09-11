// What is under the cursor: the part, the exact point, and — the piece that had
// to be built — the NORMAL of the face.

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
 * `{ point, slope }` in world coordinates — or null.
 *
 * `distanceToPoint` TWICE rather than reading the plane's own components, and
 * that is not a flourish: it is the one method `internals()` guarantees the
 * plane still has, and its difference over a UNIT STEP along the ray is exactly
 * `normal . dir`. So the whole thing is done in the library's arithmetic, and it
 * does not care whether `plane.normal` is a `Vector3` or three numbers in an
 * array.
 *
 * `slope` IS THAT `normal . dir`, and it is handed back rather than kept because
 * it answers two questions, not one. It is the denominator of the intersection;
 * it is also the rate at which the signed distance grows as the ray advances,
 * i.e. WHICH SIDE THE RAY ENTERS THE PLANE FROM, which is what tells the cut-face
 * resolver whether anything can stand between the reader and the cap. Computing
 * it twice, or deriving it from the camera instead, is how those two drift apart.
 *
 * Null when the ray runs PARALLEL to the plane: there is no point on the plane
 * under that pixel, and `sectionAxis` already refuses to drag a plane in that
 * pose for the same reason.
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
 * Two separate answers, because the library gives them in two separate places.
 * `cull` (bundle :91364) turns a cap mesh off when its solid is too small on
 * screen, over the frame budget, or not straddled by that plane — so a cap that
 * is not `visible` is not being drawn. HIDING a part does not touch the cap: it
 * writes `material.visible = false` on the front face and on the solid's own
 * stencil meshes (`setShapeVisible`, :82562), and the cap quad then renders
 * against a stencil nothing wrote, painting nothing. Both look identical on
 * screen and neither can be read off the other.
 */
function capOnScreen(unit, solid) {
  if (!solid || solid.visible === false) return false;
  const front = solid.front;
  const face = front && front.material;
  if (face && face.visible === false) return false;
  const caps = unit.capMeshes;
  if (!Array.isArray(caps)) return false;
  // BY `index` AND NOT BY POSITION. `_createStencils` fills `capMeshes`
  // plane-major so the section plane's cap is at SECTION_INDEX today, but the
  // library writes the plane it belongs to onto the mesh, and a solid the loop
  // ever skipped for one plane would shift the rest along silently.
  const cap = caps.find((c) => c && c.index === SECTION_INDEX);
  return !!cap && cap.visible !== false;
}

/**
 * The part whose CUT FACE is under NDC `[nx, ny]`, in the shape `pickEntity`
 * answers with — or null when no cut stands, or when the cursor is not over one.
 *
 * The stencil cap that closes a cut off is the one thing on screen the id picker
 * cannot see. It is built by `Clipping._createStencils` (bundle :91254) out of a
 * quad with no component id on it, it joins no pick layer and it is in no
 * registry — and the route of giving it one is closed, because the pick pass
 * replaces every material with its own (`scene.overrideMaterial`, :84897), which
 * kills the stencil that trims the quad to the part's silhouette and would paint
 * that id across the whole clipping rectangle. So a right-click on a cut face
 * used to open the menu for whatever lay BEHIND it — measured in a browser: the
 * cut face of `plate` answered `reference_spacer`, which sits flush underneath.
 *
 * WHAT REPLACES THE PICK IS GEOMETRY, and it needs no depth comparison against
 * the pick result — but it does need the ray to REACH the plane from the side
 * the renderer threw away, and the line that enforces that is `slope > 0`.
 *
 * Along the ray the signed distance is a straight line, `d(t) = d0 + t * slope`
 * with `slope = normal . dir`, and the cap sits where it crosses zero. Whatever
 * is nearer the reader than the cap is therefore at `d < 0` exactly when
 * `slope > 0` — and three.js discards on a NEGATIVE signed distance, so that is
 * exactly the case where nothing between the reader and the cap survives the
 * clip. The sign is read off the vendored bundle rather than remembered, because
 * getting it backwards is silent: `clipping_planes_vertex` sets
 * `vClipPosition = -mvPosition.xyz`, `projectPlanes` packs the view-space
 * constant into `plane.w`, and the fragment chunk discards on
 * `dot(vClipPosition, plane.xyz) > plane.w`, i.e. on `-(n . p) > c`, i.e. on
 * `n . p + c < 0`.
 *
 * With `slope < 0` the near part of the ray is in the KEPT half instead, and
 * since the plane point is INTERIOR to the solid the ray must cross that solid's
 * own surface on its way in. The cap is then behind that part's own surface, so
 * the picker answers with the same solid either way and this stands aside —
 * which holds for a ghosted part too, where the surface shows the cap
 * through it rather than hiding it. That pose is one
 * Flip button or one orbit away, so it is not a corner: without the test the
 * menu opens on a part that is not under the cursor, which is issue #73 again
 * from the other side.
 *
 * WHY THE RAY AND NOT THE EYE. "The eye is in the clipped half" sounds like the
 * same statement and is a different one, because AN ORTHO RAY DOES NOT START AT
 * THE EYE — every pixel's ray begins at its own laterally offset point. The two
 * agree only while the camera's standoff dominates, and they come apart near
 * edge-on: measured on this project's fakes, a 2-unit cube cut at z = 1.895 and
 * the camera orbited to 4.6 degrees off edge-on gives `normal . dir = +0.08` —
 * the reader is genuinely looking into the cut — while the eye's own signed
 * distance is `+0.202`, which would refuse. The band is about `arcsin(d / 5R)`
 * wide, where `d` is how far the plane stands from the camera's target — the
 * slider's own value — and `R` the model's bounding radius, the library's
 * `Camera.DISTANCE_FACTOR` being 5. It widens again when the model has been
 * panned towards the edge of the screen.
 *
 * AND NO `t > 0` TEST. Under ortho `unproject` puts the ray's origin at MID
 * DEPTH between the near and far planes, so a perfectly visible cut face can sit
 * at a negative parameter along it. `t` says nothing about visibility here.
 *
 * THE PATH COMES BACK BY IDENTITY. `nestedGroup.groups` is keyed by the SLASH
 * path — the string the menu, the tree and `getStates` all agree on — while
 * `unit.solid.name` is the PIPE form the library writes for its own scene graph
 * (`path.replaceAll("/", this.delim)`, :87880). Reversing that spelling is
 * string surgery on a name a model is free to contain, so the key is found by
 * matching the group OBJECT instead.
 *
 * THE ANSWER'S SHAPE IS `pickEntity`'S, AND TWO OF ITS FIELDS MEAN LESS HERE.
 * `id`, `name` and `point` mean exactly what they mean there. `path` does NOT:
 * there it is the topological path of the entity that was hit, down to
 * `/model/plate/faces/faces_12`, and here it is the SOLID's own path, the same
 * string as `id`, because a cap is not a registered face — it is a quad the
 * library synthesised and there is no finer entity to name. `topo` is
 * synthetic for the same reason: nothing was looked up to produce it, and
 * "face" is written because a cut face is what the reader clicked. Both are
 * kept so the two resolvers hand the interface one shape; `tools.js` reads only
 * `id` and `name`, and a caller that ever wants to MEASURE what is under the
 * cursor must go to `pickEntity`, which is what the menu's four sibling callers
 * already do.
 */
export function capOwnerAt(vp, g, ndc) {
  // A cut on screen is a seed AND the renderer's clipping flag: `suspendSectionCut`
  // deliberately keeps the seed when the cut is switched off, so that turning it
  // back on needs no second click, which makes a seed alone "a cut was placed
  // once". With no cut standing this whole function must not run at all.
  if (!vp || !vp.sectionSeed || !g) return null;
  const viewer = vp.viewer;
  const renderer = viewer && viewer.renderer;
  if (!renderer || renderer.localClippingEnabled !== true) return null;
  try {
    // `_capUnits` is the library's own private field, asked for defensively and
    // given up on quietly — exactly as the hatch asks for it. A viewer that has
    // moved it costs the menu this correction and nothing else.
    const units = g.clipping && g.clipping._capUnits;
    const groups = g.nestedGroup && g.nestedGroup.groups;
    if (!Array.isArray(units) || !units.length || !groups) return null;
    const hit = planePointAt(vp, g, ndc);
    // BEFORE ANY PER-SOLID WORK, because it is about the ray and not about any
    // one part: reaching the plane from the kept side puts every cap behind its
    // own solid, and the picker was right all along.
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
