// Zoom to the cursor, on top of a trackball that zooms to the centre.
//
// `TrackballControls._zoomCamera` scales `camera.zoom` (ortho) or walks the
// camera along its axis to the target (perspective) and moves nothing
// sideways, with no option to change it. OrbitControls has `zoomToCursor`, but
// it clamps the polar angle, which is why options.js picks the trackball.
//
// UNDER ORTHO the correction is not just exact but DEPTH-FREE. Every world point
// on the ray through the cursor lands on the same pixel, and zoom scales the
// frustum without touching the view axis, so all of them stay on that pixel
// together. There is nothing to pick: whether the cursor is over a face, an edge
// or empty background cannot change the answer.
//
// THE ORTHO CORRECTION. Write R and U for the camera's screen axes, C for its position
// and take any point P on the cursor ray. three.js divides the frustum by `zoom`
// in `OrthographicCamera.updateProjectionMatrix`, so P's horizontal NDC is
//
//     n = ((P - C) . R - cx) / (halfW / zoom)
//
// Holding n fixed while zoom goes z0 -> z1 and the camera moves by d gives
//
//     d . R = ((P - C0) . R - cx) * (1 - z0/z1)
//
// and the same in U. halfW and cx cancel, and what is left is exactly the part
// of `P - C0` PERPENDICULAR to the view axis, scaled by `1 - z0/z1` — which is
// what `ndcOffset` returns. Zooming in makes the factor positive and walks the
// camera towards the cursor; zooming out walks it back by the same law, so a
// scroll down undoes a scroll up.
//
// UNDER PERSPECTIVE the zoom is `camera_distance / |C - T|` and the controls
// scale `C - T` by `s = z0/z1`: a homothety of the camera about the target T.
// The same homothety about a point P of the cursor ray keeps that ray on its
// pixel (it moves the eye along the ray and turns nothing), and the two differ
// by a pan of
//
//     d = (1 - z0/z1) * (P - T0)
//
// Any P of the ray holds the pixel; what P sets is how near the eye comes, since
// the homothety scales the eye's distance to P by s. So P is taken at the depth
// of what the cursor is over (`surfaceDepth` in seat.js): the part there grows
// by exactly the zoom and no notch walks the eye through it. Over the background
// P stands at the target's depth, and over a ghost no nearer than the model's
// middle, so the zoom flies through it. P stays where it is in the world under
// this zoom, so it is picked again only when the cursor stands on another pixel
// or something else moved the camera.
//
// TWO LISTENERS, not one, and that is the subtle half: the anchor has to be
// measured against the camera the reader was LOOKING at. By the time the event
// bubbles back out of the canvas the controls have already changed `zoom`
// underneath it.

import {
  cameraBasis, ndcAt, ndcOffset, panCamera, pointAtDepth, syncCameraTarget,
} from "./camera.js";
import { gestureInternals } from "./internals.js";
import { dot3 } from "./math.js";
import { boxOf, depthOf, surfaceDepth } from "./seat.js";

/** Whether two camera poses are one, to a billionth of the distance to the
 *  target: the library writes a position back as `target + (position -
 *  target)`, which may move its last bit. */
const samePose = (was, b) => {
  const scale = Math.hypot(b.target[0] - b.C[0], b.target[1] - b.C[1],
                           b.target[2] - b.C[2]) * 1e-9;
  return [0, 1, 2].every((i) => Math.abs(was.C[i] - b.C[i]) <= scale
    && Math.abs(was.target[i] - b.target[i]) <= scale);
};

/**
 * The world point a perspective zoom is held about, or null: the point of the
 * cursor ray at the depth of what the cursor is over (`surfaceDepth`: a cut
 * face, a part, an edge or a vertex of one, a printer bed), so the eye comes
 * to that surface and never through it. Over the background, at the target's
 * depth. Over a ghost, at the farther of its depth and the model's middle: a
 * ghost is seen through, and the zoom passes it.
 *
 * `vp.zoomPoint` remembers the last answer with the pixel it was taken at and
 * the camera it holds for (the one it was picked under, then the one each
 * correction leaves): the same pixel under that same camera shows the same
 * point, and a pick costs a render of the pick buffer.
 */
function zoomPoint(vp, g, b, event, ndc) {
  const was = vp.zoomPoint;
  if (was && was.x === event.clientX && was.y === event.clientY
      && samePose(was, b)) return was.P;
  let depth = dot3([b.target[0] - b.C[0], b.target[1] - b.C[1],
                    b.target[2] - b.C[2]], b.view);
  const rect = g.canvas.getBoundingClientRect();
  const hit = surfaceDepth(vp, g, b, event.clientX - rect.left,
                           event.clientY - rect.top, ndc);
  if (hit) {
    const box = hit.ghost ? boxOf(vp.viewer) : null;
    depth = box ? Math.max(hit.depth, depthOf(b, box.centre)) : hit.depth;
  }
  const P = pointAtDepth(g, b, ndc[0], ndc[1], depth);
  vp.zoomPoint = P ? { x: event.clientX, y: event.clientY, P, C: b.C, target: b.target }
    : null;
  return P;
}

/** Capture phase: remember the camera the wheel is about to zoom. */
export function zoomWheelBefore(vp, event) {
  vp.zoomAnchor = null;
  const viewer = vp.viewer;
  if (!viewer) return;
  const g = gestureInternals(viewer, event);
  if (!g) return;
  const ndc = ndcAt(g.canvas, event);
  if (!ndc) return;
  try {
    // Under perspective the zoom is the eye's distance to `Camera.target`.
    if (!g.cam.isOrthographicCamera) syncCameraTarget(viewer);
    const z0 = viewer.getCameraZoom();
    if (!Number.isFinite(z0) || z0 <= 0) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    if (!g.cam.isOrthographicCamera) {
      const P = zoomPoint(vp, g, b, event, ndc);
      if (P) vp.zoomAnchor = { z0, P, g, target: b.target };
      return;
    }
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!off) return;
    vp.zoomAnchor = { z0, off, C: b.C, target: b.target };
  } catch (error) {
    console.warn("zoom anchor", error);
    vp.zoomAnchor = null;
  }
}

/** Bubble phase: the controls have zoomed, now slide the cursor point back. */
export function zoomWheelAfter(vp) {
  const a = vp.zoomAnchor;
  vp.zoomAnchor = null;
  const viewer = vp.viewer;
  if (!a || !viewer) return;
  try {
    const z1 = viewer.getCameraZoom();
    if (!Number.isFinite(z1) || z1 <= 0) return;
    // ZERO when the wheel changed nothing — a horizontal scroll, or a zoom the
    // controls clamped at minZoom/maxZoom. Nothing to compensate for, and moving
    // the camera anyway would drift the model sideways at the end of the travel.
    const k = 1 - a.z0 / z1;
    if (!Number.isFinite(k) || k === 0) return;
    if (a.P) {
      // From the camera the controls left: a perspective zoom moved it.
      const b = cameraBasis(viewer, a.g);
      if (!b) return;
      const d = [(a.P[0] - a.target[0]) * k, (a.P[1] - a.target[1]) * k,
                 (a.P[2] - a.target[2]) * k];
      if (!d.every(Number.isFinite)) return;
      panCamera(viewer, b, d);
      const after = vp.zoomPoint && cameraBasis(viewer, a.g);
      if (after) Object.assign(vp.zoomPoint, { C: after.C, target: after.target });
      return;
    }
    const d = [a.off[0] * k, a.off[1] * k, a.off[2] * k];
    if (!d.every(Number.isFinite)) return;
    panCamera(viewer, a, d);
  } catch (error) {
    console.warn("zoom to cursor", error);
  }
}
