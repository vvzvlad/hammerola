// The one description of how this camera moves sideways, and the projection
// maths every gesture is built out of.
//
// Three gestures — the cursor zoom, the swipe pan and the cursor pivot — all end
// in `panCamera` and compute its argument from `ndcOffset`. A second copy of
// either would let the model drift under the reader by a pixel per event.

import { dot3, sub3, unit3 } from "./math.js";

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
 * The one place where a position on the canvas becomes a position in the world.
 * The cursor zoom takes the offset of the point under the cursor; the swipe pan
 * takes the DIFFERENCE of two offsets, which is exactly the world vector a
 * screen displacement spans. Under ortho neither has to pick anything — every
 * point on the ray through a pixel has the same perpendicular offset.
 *
 * `unproject` rather than the frustum numbers by hand: it goes through the
 * projection matrix the camera is actually drawing with, so an off-centre or
 * offset frustum needs no separate handling. z = 0 puts the point midway between
 * near and far, and under ortho the depth along the ray does not enter the
 * answer anyway.
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
 * unit vector — or null, ORTHO ONLY.
 *
 * The companion of `ndcOffset`, from the same single `unproject` call. Under
 * ortho every point of a pixel's ray has the same offset from the camera, so
 * the unprojected point is on the ray and the direction is the view axis.
 * (Taking the eye as origin would send every ray down the screen's centre.)
 *
 * A non-orthographic camera is declined, like `gestureInternals`
 * (internals.js): the viewport is ortho by construction (options.js), so a
 * perspective branch would be unreachable.
 */
export function ndcRay(g, eye, view, nx, ny) {
  if (!g.cam.isOrthographicCamera) return null;
  const p = eye.clone().set(nx, ny, 0).unproject(g.cam);
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || !Number.isFinite(p.z)) return null;
  return view && view.every(Number.isFinite)
    ? { origin: [p.x, p.y, p.z], dir: view } : null;
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
 * reader, which happens as the model rotates through the frustum's back.
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
