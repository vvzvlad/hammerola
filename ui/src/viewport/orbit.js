// Orbit about the point under the cursor, on top of a trackball that orbits
// about the middle of the canvas.
//
// The trackball turns the model about `target`, which is always at the canvas
// centre: `update()` rebuilds the camera as `target + eye` and, on the ortho
// camera, ends in `lookAt(target)`. Moving the target to the picked point does
// not work, because `lookAt` would turn the camera to face it and the view would
// swing on press; the pivot must stay on the view axis.
//
// So, like the cursor zoom: let the library rotate, then slide the camera
// sideways so the grabbed point lands back on the pixel it was grabbed at. With
// C the camera, v the unit view axis, P the grabbed point and n its pixel in
// NDC:
//
//     d = perp(P - C) - ndcOffset(n)
//
// and moving camera and target both by d puts it right. Recomputed from scratch
// every frame, so nothing accumulates.
//
// Measured in Chrome over CDP with trusted pointer events (ortho, 1266x722
// canvas, 15-step drag of (+140, -70) px), distance of the grabbed point from
// its pixel at the end of the drag:
//
//     grabbed point                     without       with
//     edge, 430,563 (off centre)        148.7 px      0.70 px
//     vertex, 506,274 (off centre)      --            0.95 px
//     face at the canvas centre         137.4 px      0.71 px
//     background (nothing picked)       target unmoved
//
// The residual ~0.7 px is not drift: the picker reads a pixel, so its point is up
// to half a pixel off the pixel centre before the press; the gesture adds 0.00.
//
// The listener is added on the press and removed on release, not once at
// startup: `render()` builds a new controls object on every view switch and live
// reload, so a one-time subscription would stop working after the first swap.

import { cameraBasis, ndcAt, ndcOffset, panCamera } from "./camera.js";
import { gestureInternals, internals } from "./internals.js";
import { dot3 } from "./math.js";

// The trackball's own state numbers (`STATE` in the bundle: NONE -1, ROTATE 0,
// ZOOM 1, PAN 2). Read rather than derived from the event, because the library
// decides which press rotates: `KeyMapper` permutes the modifiers (the panning
// drag holds CTRL, spelled `shift` in the bundle), and the keyboard can put the
// controls in pan or zoom with no modifier on the event.
const TRACKBALL_NONE = -1;
const TRACKBALL_ROTATE = 0;

/** The trackball itself, or null if the library has moved under us.
 *
 * `viewer.controls` is the library's wrapper; the object that carries the state
 * and the "change" event is the three.js `TrackballControls` inside it.
 */
function trackball(g) {
  const tb = g && g.controls && g.controls.controls;
  if (!tb) return null;
  if (typeof tb.addEventListener !== "function") return null;
  if (typeof tb.removeEventListener !== "function") return null;
  if (typeof tb.update !== "function") return null;
  return tb;
}

export function installOrbit(vp) {
  // The correction moves the camera, which makes the trackball dispatch
  // "change" again from inside this handler. A flag stops the re-entry.
  let busy = false;

  /** The camera has moved: slide the grabbed point back onto its pixel. */
  const onChange = () => {
    const a = vp.orbitAnchor;
    if (!a || busy) return;
    const viewer = vp.viewer;
    if (!viewer) return;
    const g = internals(viewer);
    if (!g) return;
    // The scene was rebuilt under the gesture (view switch, live reload): the
    // pivot belongs to a camera that no longer exists.
    if (trackball(g) !== a.tb) return;
    // Not rotating any more. A release can go missing (Cmd+Tab mid-drag), and a
    // stale anchor must not affect the next wheel zoom.
    if (a.tb.state !== TRACKBALL_ROTATE) return;
    try {
      const b = cameraBasis(viewer, g);
      if (!b) return;
      const off = ndcOffset(g, b.eye, b.view, a.ndc[0], a.ndc[1]);
      if (!off) return;
      const rel = [a.pivot[0] - b.C[0], a.pivot[1] - b.C[1], a.pivot[2] - b.C[2]];
      const along = dot3(rel, b.view);
      if (!Number.isFinite(along)) return;
      const d = [rel[0] - along * b.view[0] - off[0],
                 rel[1] - along * b.view[1] - off[1],
                 rel[2] - along * b.view[2] - off[2]];
      if (!d.every(Number.isFinite)) return;
      // The first frame of every gesture, or a change that was not a rotation:
      // nothing to correct, and panning would render for nothing.
      if (d[0] === 0 && d[1] === 0 && d[2] === 0) return;
      busy = true;
      panCamera(viewer, b, d);
    } catch (error) {
      console.warn("orbit pivot", error);
    } finally {
      busy = false;
    }
  };

  /** Forget the gesture and unhook. Safe to call at any time. */
  const release = () => {
    const a = vp.orbitAnchor;
    vp.orbitAnchor = null;
    removeEventListener("pointerup", onEnd, true);
    removeEventListener("pointercancel", onEnd, true);
    if (!a) return;
    try {
      a.tb.removeEventListener("change", onChange);
    } catch (error) {
      console.warn("orbit release", error);
    }
  };

  /** The release. Flush whatever rotation is still owed, then unhook.
   *
   * The trackball turns a recorded pointer position into a rotation in a later
   * `update()`. With holroyd on that runs in the pointermove handler, but the
   * plain trackball rotates in the animation loop, so a release between the last
   * move and the next frame would leave one uncorrected rotation and the point
   * would jump off the cursor at the end.
   *
   * Re-applying an applied rotation is a no-op (`_rotateCamera` copies its end
   * state onto its start state).
   */
  function onEnd() {
    const a = vp.orbitAnchor;
    if (!a) return;
    try {
      a.tb.update();
    } catch (error) {
      console.warn("orbit flush", error);
    }
    release();
  }

  /**
   * Take the pivot once, at the moment of the press. Re-picking mid-gesture
   * would read whatever the rotation brought under the cursor, and the model
   * would slide out from under the finger.
   */
  const onDown = (event) => {
    // A press with the last gesture still hooked up means its release went
    // astray (a pointerup outside the window, say). Start clean.
    release();
    const viewer = vp.viewer;
    if (!viewer) return;
    const g = gestureInternals(viewer, event);
    if (!g) return;
    const tb = trackball(g);
    if (!tb) return;
    // Is this press a rotation? This listener is on the container in the bubble
    // phase and the trackball's pointerdown handler is on the canvas, so `state`
    // already holds this press's classification.
    if (tb.state !== TRACKBALL_ROTATE || tb.keyState !== TRACKBALL_NONE) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    let point = null;
    try {
      const rect = g.canvas.getBoundingClientRect();
      // The picker's default priority is vertex > edge > face, so aiming near a
      // corner pivots about the corner.
      const hit = g.picker.pickAt(event.clientX - rect.left,
                                  event.clientY - rect.top);
      if (hit && hit.point) point = hit.point;
    } catch (error) {
      console.warn("orbit pick", error);
      return;
    }
    // Nothing under the cursor: a press on the background rotates about
    // `target`, as usual.
    if (!point) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!off) return;
    const rel = [point.x - b.C[0], point.y - b.C[1], point.z - b.C[2]];
    const along = dot3(rel, b.view);
    if (!Number.isFinite(along)) return;
    // The picked point snapped onto the ray through the cursor: its depth from
    // the picker, its sideways position from the projection. The two differ by a
    // fraction of a pixel, which would otherwise be a twitch on the first frame;
    // this keeps the correction zero until the model moves.
    const pivot = [b.C[0] + off[0] + along * b.view[0],
                   b.C[1] + off[1] + along * b.view[1],
                   b.C[2] + off[2] + along * b.view[2]];
    if (!pivot.every(Number.isFinite)) return;
    vp.orbitAnchor = { pivot, ndc, tb };
    tb.addEventListener("change", onChange);
    // On the window and in the capture phase, for the same reason the tool drags
    // listen there: a release over the interface's own chrome, or outside the
    // canvas entirely, is still the end of this gesture.
    addEventListener("pointerup", onEnd, true);
    addEventListener("pointercancel", onEnd, true);
  };

  // Bubble phase: this wants the trackball's verdict on the press, which exists
  // only after the canvas's own handler ran. Nothing here calls preventDefault
  // or stopPropagation; a tool that stops the press in the capture phase keeps
  // the canvas to itself.
  vp.box.addEventListener("pointerdown", onDown);

  return () => {
    vp.box.removeEventListener("pointerdown", onDown);
    release();
  };
}
