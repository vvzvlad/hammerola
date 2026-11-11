// The one description of how this camera moves sideways, and the projection
// maths every gesture is built out of.
//
// Three gestures — the cursor zoom, the swipe pan and the cursor pivot — all end
// in `panCamera` and compute its argument from `ndcOffset`, `ndcRay` and
// `pointAtDepth`. A second copy of any would let the model drift under the
// reader by a pixel per event.
//
// The camera is orthographic or perspective (Settings, element.js). Every
// function here answers for both; the branch is `isOrthographicCamera`.

import { dot3, finite3, sub3, unit3 } from "./math.js";

/**
 * Put the library's `Camera.target` on `target`, the controls' own target by
 * default.
 *
 * They are two objects (viewcube.js, `recentre`): a preset writes both, every
 * pan moves the controls' alone. Under perspective `Camera.getZoom` and
 * `setZoom` measure and walk the eye against `Camera.target`, so after a pan
 * they read a zoom the view does not have and walk the eye off the line
 * through the point the trackball turns about; `switchCamera` and every
 * camera write with a zoom go through them. Called before each of those.
 * Under ortho nothing reads it but a preset and `lookAtTarget`, which set it
 * first.
 */
export function syncCameraTarget(viewer, target = viewer.getCameraTarget()) {
  const kept = viewer.camera && viewer.camera.target;
  if (kept && typeof kept.set === "function" && finite3(target)) {
    kept.set(target[0], target[1], target[2]);
  }
}

/**
 * Stand the camera at a frame `{position, quaternion, target, zoom}` — a
 * stored one, or the one on screen carried across a switch — as the camera
 * now drawing shows it.
 *
 * A frame does not say which camera took it: Settings decides that, not the
 * link. Along the frame's own line from the target to the eye, the eye stands
 * `camera_distance / zoom` back under perspective, the library's meaning of
 * the zoom there, and `camera_distance` back under ortho, where the library
 * stands it, so a frame taken close in under perspective does not leave half
 * the model behind the ortho camera's near plane. The zoom itself is written
 * only under ortho; under perspective `setZoom` would walk the eye again.
 */
export function standFrame(viewer, c, notify) {
  const ortho = !!viewer.camera.getCamera().isOrthographicCamera;
  const D = viewer.camera.camera_distance;
  const zoom = Number.isFinite(c.zoom) && c.zoom > 0 ? c.zoom : null;
  let position = c.position || null;
  const off = finite3(position) && finite3(c.target)
    ? unit3(position.map((v, i) => v - c.target[i])) : null;
  if (off && D > 0 && (ortho || zoom)) {
    const back = ortho ? D : D / zoom;
    position = [0, 1, 2].map((i) => c.target[i] + off[i] * back);
  }
  syncCameraTarget(viewer, c.target || viewer.getCameraTarget());
  viewer.setCameraLocationSettings(position, c.quaternion || null, c.target || null,
                                   ortho ? zoom : null, notify);
}

/** Where an event sits on the canvas, in NDC (-1..1, y up), or null. */
export function ndcAt(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  return Number.isFinite(nx) && Number.isFinite(ny) ? [nx, ny] : null;
}

/** Canvas-relative pixel coordinates of an event, or null. */
export function canvasXY(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return [event.clientX - rect.left, event.clientY - rect.top];
}

/** Camera position, target and unit view axis, or null if any is unusable. */
export function cameraBasis(viewer, g) {
  const target = viewer.getCameraTarget();
  if (!Array.isArray(target) || !target.every(Number.isFinite)) return null;
  // `matrixWorld` is what `unproject` reads, and the renderer refreshes it every
  // frame — but only for a camera it drew with. Refreshing it here costs one
  // matrix compose and removes the assumption.
  if (typeof g.cam.updateMatrixWorld === "function") g.cam.updateMatrixWorld();
  const eye = g.camera.getPosition();
  if (!eye || !Number.isFinite(eye.x) || !Number.isFinite(eye.y)
      || !Number.isFinite(eye.z)) return null;
  const view = unit3(sub3({ x: target[0], y: target[1], z: target[2] }, eye));
  if (!view) return null;
  return { eye, C: [eye.x, eye.y, eye.z], target, view };
}

/**
 * World offset of the point the canvas shows at NDC (nx, ny), measured from the
 * camera and with the component ALONG the view axis removed — the part an ortho
 * projection throws away, and the part that must not move the camera. Null when
 * anything in it is not finite.
 *
 * The ORTHO cursor zoom takes the offset of the point under the cursor. Under
 * ortho it needs no depth — every point on the ray through a pixel has the same
 * perpendicular offset — so `pointAtDepth` builds its ortho answer on it. Under
 * perspective the offset depends on the depth `unproject` happened to choose,
 * and nothing reads it there.
 *
 * `unproject` rather than the frustum numbers by hand: it goes through the
 * projection matrix the camera is actually drawing with, so an off-centre or
 * offset frustum needs no separate handling. z = 0 puts the point midway between
 * near and far.
 *
 * `eye.clone()` is how a `Vector3` is obtained at all: the bundle exports none,
 * so the one the library just handed back is borrowed and overwritten.
 */
export function ndcOffset(g, eye, view, nx, ny) {
  const p = eye.clone().set(nx, ny, 0).unproject(g.cam);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || !Number.isFinite(p.z)) return null;
  const rel = [p.x - eye.x, p.y - eye.y, p.z - eye.z];
  const along = dot3(rel, view);
  if (!Number.isFinite(along)) return null;
  const off = [rel[0] - along * view[0],
               rel[1] - along * view[1],
               rel[2] - along * view[2]];
  return off.every(Number.isFinite) ? off : null;
}

/**
 * The world ray a canvas pixel looks along, as `{ origin, dir }` with `dir` a
 * unit vector, or null.
 *
 * One `unproject` call. Under ORTHO every point of a pixel's ray has the same
 * offset from the camera, so the unprojected point is on the ray and the
 * direction is the view axis (taking the eye as origin would send every ray down
 * the screen's centre). Under PERSPECTIVE every ray starts at the eye, and the
 * unprojected point is any second point on it; z = 0.5 keeps it off the eye at
 * any near plane. Such a ray says so (`fromEye`): nothing behind its origin is
 * on screen.
 */
export function ndcRay(g, eye, view, nx, ny) {
  const ortho = !!g.cam.isOrthographicCamera;
  const p = eye.clone().set(nx, ny, ortho ? 0 : 0.5).unproject(g.cam);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || !Number.isFinite(p.z)) return null;
  if (ortho) {
    return view && view.every(Number.isFinite)
      ? { origin: [p.x, p.y, p.z], dir: view } : null;
  }
  const dir = unit3([p.x - eye.x, p.y - eye.y, p.z - eye.z]);
  return finite3(dir) ? { origin: [eye.x, eye.y, eye.z], dir, fromEye: true } : null;
}

/**
 * The point on the ray through NDC (nx, ny) whose distance from the eye ALONG
 * THE VIEW AXIS is `depth` — `b` is `cameraBasis` — or null.
 *
 * Ortho: `C + ndcOffset + depth * view`. Perspective: `C + dir * depth / (dir .
 * view)`, a ray that does not run forwards being no ray to a visible point.
 *
 * The cursor pivot, the swipe pan and the perspective cursor zoom hold a point
 * at a depth: the depth is what a pan keeps, so a point taken at the same depth
 * on two pixels spans the world vector of the screen displacement there.
 */
export function pointAtDepth(g, b, nx, ny, depth) {
  let p = null;
  if (g.cam.isOrthographicCamera) {
    const off = ndcOffset(g, b.eye, b.view, nx, ny);
    if (!off) return null;
    p = [b.C[0] + off[0] + depth * b.view[0],
         b.C[1] + off[1] + depth * b.view[1],
         b.C[2] + off[2] + depth * b.view[2]];
  } else {
    const ray = ndcRay(g, b.eye, b.view, nx, ny);
    const along = ray ? dot3(ray.dir, b.view) : 0;
    if (!(along > 0)) return null;
    const t = depth / along;
    p = [ray.origin[0] + t * ray.dir[0],
         ray.origin[1] + t * ray.dir[1],
         ray.origin[2] + t * ray.dir[2]];
  }
  return finite3(p) ? p : null;
}

/**
 * The unit direction the camera sees `point` along: the view axis under ortho,
 * where every pixel looks one way, and the ray from the eye under perspective.
 * Null for a point on the eye or unmeasurable numbers.
 *
 * What a widget's foreshortening is measured against at its anchor: how much of
 * an arrow survives, whether a ring is edge-on, which side of a face the reader
 * is on.
 */
export function sightAt(g, b, point) {
  if (g.cam.isOrthographicCamera) return b.view;
  const dir = finite3(point) ? unit3([point[0] - b.C[0], point[1] - b.C[1],
                                      point[2] - b.C[2]]) : null;
  return finite3(dir) ? dir : null;
}

/**
 * Where a ray comes closest to the line `at + t * axis` (`axis` a unit vector),
 * as `t`, or null for a ray parallel to the line or one from the eye whose
 * nearest point is behind the eye.
 *
 * The answer a drag along a line takes from the pixel under the hand: a line
 * and a ray miss each other in 3D. Under ortho the difference of two answers is
 * the screen displacement's world vector along `axis` over `sine^2`
 * (`alongAxis` in gizmo.js), exactly.
 */
export function rayLineParam(ray, at, axis) {
  const b = dot3(ray.dir, axis);
  const w = [at[0] - ray.origin[0], at[1] - ray.origin[1],
             at[2] - ray.origin[2]];
  const denominator = 1 - b * b;
  if (!(denominator > 0)) return null;
  const t = (b * dot3(ray.dir, w) - dot3(axis, w)) / denominator;
  if (ray.fromEye && !(dot3(ray.dir, w) + t * b > 0)) return null;
  return Number.isFinite(t) ? t : null;
}

/** Where a ray meets the plane through `at` normal to `normal`, or null for a
 *  ray lying in it or one from the eye meeting it behind the eye. Behind the
 *  origin of an ortho ray is kept: that origin is at mid depth, and a visible
 *  point can lie behind it. */
export function rayPlanePoint(ray, at, normal) {
  const into = dot3(ray.dir, normal);
  if (!into) return null;
  const t = (dot3(normal, at) - dot3(normal, ray.origin)) / into;
  if (ray.fromEye && !(t > 0)) return null;
  const p = [ray.origin[0] + t * ray.dir[0], ray.origin[1] + t * ray.dir[1],
             ray.origin[2] + t * ray.dir[2]];
  return finite3(p) ? p : null;
}

/**
 * Move camera and target by the SAME world vector — a pure pan.
 *
 * The view direction and the distance along it are untouched and the trackball
 * keeps no state in either, so these corrections ride on top of the controls
 * and rotation keeps the library's holroyd projection and feel.
 *
 * `setCameraLocationSettings` is the library's entry point for placing the
 * camera and ends in `controls.update()` + `update()`, keeping the trackball's
 * eye vector and the render in step. Quaternion and zoom stay null.
 */
export function panCamera(viewer, b, d) {
  viewer.setCameraLocationSettings(
    [b.C[0] + d[0], b.C[1] + d[1], b.C[2] + d[2]], null,
    [b.target[0] + d[0], b.target[1] + d[1], b.target[2] + d[2]], null, true);
}

/**
 * A world point in NDC, or null — for anything the interface draws OVER the
 * canvas at a place on the model (a measurement label).
 *
 * Same borrowed-`Vector3` trick as `ndcOffset`. The library's `project` reads
 * the matrix in use, rather than hard-coding three.js's column-major layout.
 */
export function projectPoint(g, point) {
  const eye = g.camera.getPosition();
  if (!eye || typeof eye.clone !== "function") return null;
  const p = eye.clone().set(point[0], point[1], point[2]).project(g.cam);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return [p.x, p.y, p.z];
}

/**
 * Where a world point lands on a LAYER over the canvas, in CSS pixels, with the
 * NDC depth alongside — `[x, y, z]`, or null for a point the projection cannot
 * place.
 *
 * The two rects are passed in rather than measured here: a layer WRITES styles
 * between projections, so a `getBoundingClientRect()` per point would force a
 * reflow each time inside a rAF loop. Neither rect changes within one frame
 * (nothing here writes the canvas or the layer's container).
 *
 * The canvas rect gives the pixel size of the NDC cube and the container rect is
 * what an absolutely-positioned child is placed against, so the corner
 * difference is the offset. The measurement label's layer (overlay.js) uses
 * this sum.
 *
 * `z > 1` is for the caller to read: behind the far plane, i.e. behind the
 * reader, which happens as the model rotates through the frustum's back. Under
 * perspective a point behind the eye reads `z > 1` as well, and one between the
 * eye and the near plane `z < -1`.
 */
export function spot(g, rect, box, point) {
  const ndc = projectPoint(g, point);
  if (!ndc) return null;
  return [
    (ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left),
    (-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top),
    ndc[2],
  ];
}
