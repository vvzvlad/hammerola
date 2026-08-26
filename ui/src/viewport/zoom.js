// Zoom to the cursor, on top of a trackball that zooms to the centre.
//
// `TrackballControls._zoomCamera` scales `camera.zoom` and moves nothing
// sideways, and there is no option to change that. OrbitControls DOES have one
// (`zoomToCursor`), but switching back to orbit to get it is not on the table —
// orbit clamps the polar angle, which is precisely why options.js picks the
// trackball. So the behaviour is built here instead.
//
// THE CAMERA IS ORTHOGRAPHIC, and that makes the correction not just exact but
// DEPTH-FREE. Every world point on the ray through the cursor lands on the same
// pixel, and zoom scales the frustum without touching the view axis, so all of
// them stay on that pixel together. There is nothing to pick: whether the cursor
// is over a face, an edge or empty background cannot change the answer, which is
// also why this has no "cursor over the background" special case to get wrong.
//
// THE CORRECTION. Write R and U for the camera's screen axes, C for its position
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
// TWO LISTENERS, not one, and that is the subtle half: the anchor has to be
// measured against the camera the reader was LOOKING at. By the time the event
// bubbles back out of the canvas the controls have already changed `zoom`
// underneath it.

import { cameraBasis, ndcAt, ndcOffset, panCamera } from "./camera.js";
import { gestureInternals } from "./internals.js";

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
    const z0 = viewer.getCameraZoom();
    if (!Number.isFinite(z0) || z0 <= 0) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
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
    const d = [a.off[0] * k, a.off[1] * k, a.off[2] * k];
    if (!d.every(Number.isFinite)) return;
    panCamera(viewer, a, d);
  } catch (error) {
    console.warn("zoom to cursor", error);
  }
}
