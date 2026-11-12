// Where the target stands under the perspective camera: on what the reader sees.
//
// The trackball turns about its target, and the perspective zoom walks the eye
// towards it. Ortho has no depth, so its gestures leave the target anywhere on
// the view axis: a pan slides it across the axis, a turn about a picked point
// swings the axis about that point, and the target ends up behind the model or
// inside it. The perspective eye stands `camera_distance / zoom` in front of
// its target, and with such a target it stands inside the part. So under
// perspective the target goes on the surface the canvas centre shows, and
// where the centre shows nothing, to the depth of the bounding box's nearest
// corner, which leaves the whole model in front of the eye.
//
// Three moves, all along the view axis:
//   * `seatTarget` keeps the zoom: the eye stands `camera_distance / zoom` in
//     front of the new target (a frame taken under ortho, a cube click that
//     would put the eye inside the model);
//   * `keepEye` keeps the picture: the target alone moves, so the library's own
//     zoom (a touchscreen pinch, the middle button) walks the eye towards the
//     surface in the centre and not through it towards the middle of the model;
//   * `seatForPerspective`, under ortho before the switch, moves the target
//     alone too: ortho draws the same picture with the target at any depth.
//
// A pick reads the pick buffer, drawn with the camera's projection. A move
// made here without a render changes neither the planes nor the buffer, so
// each perspective move fits the planes to the eye (`Camera.fitPlanes`) and
// marks the buffer stale before it picks.

import { cameraBasis, standFrame, syncCameraTarget } from "./camera.js";
import { gestureInternals, internals } from "./internals.js";
import { dot3, finite3 } from "./math.js";
import { covers } from "./parts.js";
import { capOwnerAt, solidOf } from "./picking.js";

// The trackball's own state numbers (`_STATE` in three's TrackballControls):
// the middle button's drag, and two fingers on a touchscreen.
const TRACKBALL_ZOOM = 1;
const TRACKBALL_TOUCH_ZOOM_PAN = 4;

/** `p` moved `t` along the unit vector `dir`. */
const along = (p, dir, t) => [p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t];

/** How far ahead of the eye of `b` (`cameraBasis`) `p` is, along the view axis. */
export const depthOf = (b, p) => dot3([p[0] - b.C[0], p[1] - b.C[1], p[2] - b.C[2]], b.view);

/** The depth of the box's corner nearest the eye. */
const nearestDepth = (b, box) => Math.min(...box.corners.map((p) => depthOf(b, p)));

/** The canvas centre: `[x, y]` in CSS pixels on the canvas, and in NDC. */
function centreOf(g) {
  const rect = g.canvas.getBoundingClientRect();
  return [rect.width / 2, rect.height / 2, [0, 0]];
}

/**
 * The library's bounding box of the scene (`viewer.bbox`, a `Box3`) as
 * `{ centre, radius, corners }`, its bounding sphere and eight corners, or null.
 */
export function boxOf(viewer) {
  const bbox = viewer && viewer.bbox;
  if (!bbox || !bbox.min || !bbox.max) return null;
  const corners = [];
  for (const x of [bbox.min.x, bbox.max.x]) {
    for (const y of [bbox.min.y, bbox.max.y]) {
      for (const z of [bbox.min.z, bbox.max.z]) corners.push([x, y, z]);
    }
  }
  const centre = bbox.center();
  const radius = bbox.boundingSphere().radius;
  return finite3(centre) && Number.isFinite(radius) && corners.every(finite3)
    ? { centre, radius, corners } : null;
}

/**
 * How deep the canvas looks at the pixel `[x, y]` (CSS pixels on the canvas,
 * `ndc` the same place in NDC), seen from the eye of `b`: `{ depth, ghost }`,
 * the depth along the view axis and whether a ghosted part is what is seen,
 * or null for the background. Only a point ahead of the eye counts.
 *
 * A cut face first: the pick buffer does not hold it, and it hides what lies
 * behind it (`capOwnerAt`). Then the nearer of the pick buffer's point and a
 * printer bed's, which the buffer does not hold either. The buffer is read at
 * the one pixel with no topology filter: its passes are depth-tested, so a
 * face, an edge and a vertex alike answer with the surface seen there. A ghost
 * is in the buffer like any part; a hidden part is not.
 */
export function surfaceDepth(vp, g, b, x, y, ndc) {
  const cap = capOwnerAt(vp, g, ndc);
  const capDepth = cap ? depthOf(b, cap.point) : NaN;
  if (capDepth > 0) return { depth: capDepth, ghost: false };
  let seen = null;
  try {
    const hit = g.picker.pickAt(x, y, { windowSize: 1 });
    const at = hit && hit.point;
    const depth = at ? depthOf(b, [at.x, at.y, at.z]) : NaN;
    if (depth > 0) {
      const path = solidOf(hit.info);
      seen = { depth, ghost: !!path && vp.state.ghost.some((entry) => covers(entry, path)) };
    }
  } catch (error) {
    console.warn("surface pick", error);
  }
  const bed = vp.beds.pointAt(ndc);
  const bedDepth = bed ? depthOf(b, bed) : NaN;
  if (bedDepth > 0 && !(seen && seen.depth <= bedDepth)) {
    seen = { depth: bedDepth, ghost: false };
  }
  return seen;
}

/**
 * Under perspective: the target onto the surface the canvas centre shows, the
 * eye `camera_distance / z` in front of it, the view axis kept; one render.
 * False, with nothing drawn, when the camera or the model's box cannot be read.
 *
 * The eye first stands `camera_distance` in front of the box's nearest corner
 * on the same axis, without a render: the whole model is then ahead of it and
 * past its near plane, so the pick sees the model from outside whatever zoom
 * the eye ends at. Where the centre shows nothing, the target goes to that
 * corner's depth.
 *
 * The trackball's damped zoom is spent before the move:
 * `setCameraLocationSettings` ends in `controls.update()`, which applies what a
 * middle-button drag left of it and would walk the eye off `camera_distance / z`.
 */
export function seatTarget(vp, g, z, notify) {
  const viewer = vp.viewer;
  const b = cameraBasis(viewer, g);
  const box = boxOf(viewer);
  const cd = g.camera.camera_distance;
  if (!b || !box || !(cd > 0) || !(z > 0)) return false;
  const outside = along(b.C, b.view, nearestDepth(b, box) - cd);
  const ahead = along(outside, b.view, cd);
  g.camera.setPosition(outside, false);
  g.controls.getTarget().set(ahead[0], ahead[1], ahead[2]);
  g.cam.updateMatrixWorld();
  g.camera.fitPlanes(ahead, box.centre, box.radius);
  g.picker.setDirty();
  const [x, y, ndc] = centreOf(g);
  const from = { eye: g.camera.getPosition(), C: outside, target: ahead, view: b.view };
  const hit = surfaceDepth(vp, g, from, x, y, ndc);
  const T = along(outside, b.view, hit ? hit.depth : cd);
  const tb = g.controls.controls;
  if (tb && tb._zoomStart && tb._zoomEnd) tb._zoomStart.copy(tb._zoomEnd);
  syncCameraTarget(viewer, T);
  viewer.setCameraLocationSettings(along(T, b.view, -cd / z), null, T, null, notify);
  return true;
}

/**
 * Under perspective: the target alone onto the surface the canvas centre
 * shows, along the view axis. True when it moved; over the background it
 * stays. Written in place, with no `controls.update()`, which would apply the
 * trackball's damped zoom once more, and no render: the picture is the same.
 */
export function keepEye(vp, g) {
  const viewer = vp.viewer;
  const b = cameraBasis(viewer, g);
  const box = boxOf(viewer);
  if (!b || !box) return false;
  g.camera.fitPlanes(b.target, box.centre, box.radius);
  g.picker.setDirty();
  const [x, y, ndc] = centreOf(g);
  const hit = surfaceDepth(vp, g, b, x, y, ndc);
  if (!hit) return false;
  const T = along(b.C, b.view, hit.depth);
  g.controls.getTarget().set(T[0], T[1], T[2]);
  syncCameraTarget(viewer, T);
  return true;
}

/**
 * Under ortho, right before the switch to perspective: the target along the
 * view axis to the depth of what the canvas centre shows, else of the box's
 * nearest corner, the eye where it is; no render. Over nothing ahead of the
 * eye the target stays.
 *
 * `switchCamera` then stands the perspective eye `camera_distance / zoom` in
 * front of that target, where the field of view frames the target's plane as
 * ortho did (`Camera._perspectiveFov` in the fork): the surface in the centre
 * keeps its place and its size, nearer things grow and farther ones shrink.
 */
export function seatForPerspective(vp, g) {
  const viewer = vp.viewer;
  const b = cameraBasis(viewer, g);
  if (!b) return;
  const [x, y, ndc] = centreOf(g);
  const hit = surfaceDepth(vp, g, b, x, y, ndc);
  const box = hit ? null : boxOf(viewer);
  const depth = hit ? hit.depth : box ? nearestDepth(b, box) : NaN;
  if (!(depth > 0)) return;
  const T = along(b.C, b.view, depth);
  g.controls.getTarget().set(T[0], T[1], T[2]);
  syncCameraTarget(viewer, T);
}

/**
 * Whether a frame `{position, target, zoom}` was taken under ortho, for a
 * library whose `camera_distance` is `cd`.
 *
 * A frame does not say which camera took it; the eye's distance to the target
 * does. The ortho gestures never move the eye along the axis, so an ortho frame
 * has `|position - target| = cd`; under perspective that distance is the zoom,
 * `|position - target| * zoom = cd`. The nearer of the two on a log scale wins,
 * so a frame from a revision whose `cd` was `rho` times this one is told right
 * unless `|log zoom| < 2 |log rho|`, near zoom 1, where the two cameras stand
 * the eye nearly alike.
 */
export function orthoFrame(c, cd) {
  const gap = Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1],
                         c.position[2] - c.target[2]);
  return Math.abs(Math.log(gap / cd)) < Math.abs(Math.log((gap * c.zoom) / cd));
}

/**
 * Stand a frame as `standFrame` does, except that under perspective a frame
 * taken under ortho with a zoom other than 1 keeps its turn and its zoom and
 * gets its target on the surface the centre shows (`seatTarget`): an ortho
 * target may be at any depth, and the eye `camera_distance / zoom` in front of
 * it inside the part. Such a frame is not stood as it is first, so nothing is
 * drawn from inside the model. At zoom 1 both cameras stand the eye
 * `camera_distance` back, and the frame is stood as it is.
 */
export function seatFrame(vp, c, notify) {
  const viewer = vp.viewer;
  const g = internals(viewer);
  if (g && !g.cam.isOrthographicCamera && finite3(c.position) && finite3(c.target)
      && Number.isFinite(c.zoom) && c.zoom > 0 && c.zoom !== 1
      && orthoFrame(c, g.camera.camera_distance)) {
    if (c.quaternion) g.camera.setQuaternion(c.quaternion);
    g.camera.setPosition(c.position, false);
    g.controls.getTarget().set(c.target[0], c.target[1], c.target[2]);
    if (seatTarget(vp, g, c.zoom, notify)) return;
  }
  standFrame(viewer, c, notify);
}

/**
 * Under perspective, `keepEye` on every step of the library's own zoom: while
 * the trackball zooms (the middle button, two fingers on a touchscreen), each
 * of its changes puts the target back on the surface the centre shows, so the
 * next step walks the eye to that surface. A two-finger pan moves eye and
 * target together, and the next step seats the target on what the centre now
 * shows.
 *
 * Hooked on the press and unhooked on the release, as orbit.js is: `render()`
 * builds a new trackball on every view switch and live reload. The flag stops
 * a change raised from inside the handler from re-entering it, as orbit.js's.
 */
export function installZoomSeat(vp) {
  let tb = null;
  let busy = false;

  const onChange = () => {
    if (busy || !tb) return;
    if (tb.state !== TRACKBALL_ZOOM && tb.state !== TRACKBALL_TOUCH_ZOOM_PAN) return;
    const g = internals(vp.viewer);
    // The scene was rebuilt under the gesture, or the camera switched.
    if (!g || g.cam.isOrthographicCamera || g.controls.controls !== tb) return;
    busy = true;
    try {
      keepEye(vp, g);
    } catch (error) {
      console.warn("zoom seat", error);
    } finally {
      busy = false;
    }
  };

  /** Forget the gesture and unhook. Safe to call at any time. */
  const release = () => {
    removeEventListener("pointerup", release, true);
    removeEventListener("pointercancel", release, true);
    if (tb) tb.removeEventListener("change", onChange);
    tb = null;
  };

  // Bubble phase on the container, as orbit.js: the trackball's own press
  // handler on the canvas has run. A second finger finds its trackball hooked.
  const onDown = (event) => {
    const g = gestureInternals(vp.viewer, event);
    const controls = g && !g.cam.isOrthographicCamera && g.controls
      && g.controls.controls;
    if (!controls || controls === tb) return;
    release();
    tb = controls;
    tb.addEventListener("change", onChange);
    // On the window in the capture phase, as the other drags: a release over
    // the interface's chrome or outside the canvas still ends the gesture.
    addEventListener("pointerup", release, true);
    addEventListener("pointercancel", release, true);
  };

  vp.box.addEventListener("pointerdown", onDown);
  return () => {
    vp.box.removeEventListener("pointerdown", onDown);
    release();
  };
}
