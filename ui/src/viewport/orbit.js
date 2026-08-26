// Orbit about the point under the cursor, on top of a trackball that orbits
// about the middle of the canvas.
//
// Fusion turns the model about the point you grabbed. This trackball turns it
// about `target`, and `target` is always in the middle of the canvas: its
// `update()` rebuilds the camera position as `target + eye` and, on the ortho
// camera this viewport uses, ends in `lookAt(target)`. So the pivot is not a
// setting left on the wrong value — it is where the axis of this trackball
// lives, and a reader inspecting a corner of a large part watches that corner
// swing off the screen while the middle of the canvas, which they were not
// looking at, stays put.
//
// SWAPPING THE TARGET FOR THE PICKED POINT DOES NOT WORK, and that is worth
// writing down because it is the obvious move. `lookAt(target)` is in the ortho
// branch too, so a target moved off the view axis is a camera turned to face it:
// the whole view swings the moment the press lands. This trackball's pivot has
// to stay on the axis of view, and the point under the cursor is, in general,
// not on it.
//
// So the same shape as the cursor zoom: LET THE LIBRARY ROTATE AS IT ALWAYS HAS,
// then slide the camera sideways so the grabbed point lands back on the pixel it
// was grabbed at. Write C for the camera, v for the unit view axis, P for the
// grabbed point and n for the pixel it was grabbed at, in NDC:
//
//     d = perp(P - C) - ndcOffset(n)
//
// and moving camera and target both by d puts it right. Recomputed from scratch
// on every frame the camera moves, so nothing accumulates and a dropped frame
// costs nothing.
//
// MEASURED IN A BROWSER, because the arithmetic being right is not the same as
// the point staying put. Chrome over CDP with trusted pointer events, ortho
// camera, a 1266x722 canvas and a 15-step drag of (+140, -70) px; the number is
// how far the grabbed point had moved off its pixel when the drag ended:
//
//     grabbed point                     before        after
//     edge, 430,563 (off centre)        148.7 px      0.70 px
//     vertex, 506,274 (off centre)      --            0.95 px
//     face at the canvas centre         137.4 px      0.71 px
//     background (nothing picked)       target unmoved, as before
//
// The residual 0.70 px is not drift and must not be "fixed": the picker reads a
// PIXEL, so the point it hands back is up to half a pixel off that pixel's
// centre, and the same 0.70 px is already there before the press. The gesture
// itself adds 0.00 px. Everything else was measured unchanged to the last digit
// with the correction in and out — wheel zoom to cursor 0.29 px, pinch 1.03 px
// on a x2.0000 gesture, swipe pan 480.0 px for 480 px of delta, right-button
// pan, the section click, the hold key and the comment anchor.
//
// THE LISTENER IS ADDED ON THE PRESS AND REMOVED ON THE RELEASE, not once at
// startup, and in React that is the trap rather than tidiness: `render()` builds
// a NEW controls object, and this viewport calls it on every view switch and
// every live reload. A `useEffect([])` that subscribed once would be a pivot
// that silently stopped working after the first swap, and the symptom a week
// later is "it worked yesterday". Between gestures this feature has nothing
// hooked into the library at all.

import { cameraBasis, ndcAt, ndcOffset, panCamera } from "./camera.js";
import { gestureInternals, internals } from "./internals.js";
import { dot3 } from "./math.js";

// The trackball's own state numbers (`STATE` in the bundle: NONE -1, ROTATE 0,
// ZOOM 1, PAN 2). Read rather than re-derived from the event, because WHICH
// PRESS ROTATES is the library's to decide and its rule is not the obvious one:
// `KeyMapper` permutes the modifiers, so the drag that pans is the one with the
// CTRL key held — spelled `shift` inside the bundle — and the keyboard can put
// the controls in a pan or zoom state with no modifier on the event at all. A
// second copy of that rule here would be one upgrade away from anchoring a pan.
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
  // The correction moves the camera, which makes the trackball dispatch "change"
  // again from inside our own handler. One flag rather than a debounce: what has
  // to be stopped is re-entry, not repetition.
  let busy = false;

  /** The camera has moved: slide the grabbed point back onto its pixel. */
  const onChange = () => {
    const a = vp.orbitAnchor;
    if (!a || busy) return;
    const viewer = vp.viewer;
    if (!viewer) return;
    const g = internals(viewer);
    if (!g) return;
    // The scene was rebuilt under the gesture — a view switch, or a live reload
    // landing mid-drag. The pivot was measured against a camera that no longer
    // exists, so the gesture is over as far as this is concerned.
    if (trackball(g) !== a.tb) return;
    // The controls are still rotating. A release can go missing — Cmd+Tab in the
    // middle of a drag is enough — and an anchor that outlived its gesture would
    // otherwise turn the reader's next WHEEL into a zoom that holds a point they
    // grabbed minutes ago.
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
      // The first frame of every gesture, and any frame the trackball reported a
      // change that was not a rotation. Nothing to put right, and the call below
      // would be a render for nothing.
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
   * The flush is not decoration. The trackball records the pointer where it
   * lands and turns it into a rotation in a LATER `update()`; with holroyd on
   * that update runs in the pointermove handler and nothing is ever pending, but
   * the library reads `holroyd` from its own state and the plain trackball
   * rotates in the animation loop instead. A release arriving between the last
   * move and the next frame would then leave one rotation with no correction
   * after it — the grabbed point jumping off the cursor at the very end of the
   * gesture, which is the one moment the reader is looking at it.
   *
   * Applying a rotation that has already been applied is a no-op (`_rotateCamera`
   * copies its end state onto its start state), so this costs nothing when there
   * is nothing owed.
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
   * Take the pivot ONCE, at the moment of the press.
   *
   * Once and not per frame, and that is the whole difference between a pivot and
   * a point that crawls: re-picking mid-gesture would read whatever the rotation
   * has just brought under the cursor, and the model would slide out from under
   * the finger.
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
    // Is this press a rotation? This listener is on the CONTAINER in the bubble
    // phase and the trackball's own pointerdown handler is on the canvas, so by
    // the time the event arrives the press has been classified and `state` is
    // this press's own answer.
    if (tb.state !== TRACKBALL_ROTATE || tb.keyState !== TRACKBALL_NONE) return;
    const ndc = ndcAt(g.canvas, event);
    if (!ndc) return;
    let point = null;
    try {
      const rect = g.canvas.getBoundingClientRect();
      // The picker's default priority is vertex > edge > face, which is the snap
      // this wants and did not have to be built: aim near a corner and the
      // corner is what the model turns about, the way it does in a CAD package.
      const hit = g.picker.pickAt(event.clientX - rect.left,
                                  event.clientY - rect.top);
      if (hit && hit.point) point = hit.point;
    } catch (error) {
      console.warn("orbit pick", error);
      return;
    }
    // Nothing under the cursor. NOT a failure and not a case for an invented
    // point: a press on the background rotates about `target`, which is what the
    // reader who pressed there is used to.
    if (!point) return;
    const b = cameraBasis(viewer, g);
    if (!b) return;
    const off = ndcOffset(g, b.eye, b.view, ndc[0], ndc[1]);
    if (!off) return;
    const rel = [point.x - b.C[0], point.y - b.C[1], point.z - b.C[2]];
    const along = dot3(rel, b.view);
    if (!Number.isFinite(along)) return;
    // The picked point SNAPPED ONTO THE RAY THROUGH THE CURSOR: same point, at
    // the depth the picker read it, but with its sideways position taken from
    // the projection rather than from the picker's own buffer. The two disagree
    // by a fraction of a pixel, and that fraction would be a correction applied
    // on the first frame of every gesture — a visible twitch before anything has
    // turned. This makes the correction identically zero until the model moves.
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

  // Bubble phase, deliberately: this listener does not want the event, it wants
  // the trackball's verdict on it, and that only exists once the canvas's own
  // handler has run. Nothing here calls preventDefault or stopPropagation — the
  // rotation stays entirely the library's, and a tool that DOES stop the press
  // in the capture phase keeps the canvas to itself.
  vp.box.addEventListener("pointerdown", onDown);

  return () => {
    vp.box.removeEventListener("pointerdown", onDown);
    release();
  };
}
