// The pointing device: trackpad or mouse, and everything the wheel does.
//
// The library pans on the RIGHT button, or on the left with ctrl/meta/shift. It
// knows nothing about a two-finger swipe, and on a Mac that is how everything
// else on the machine is moved around — so the model is the one thing on screen
// that will not follow the fingers.
//
// There is no touch event for this: a trackpad in a browser is a mouse, and a
// swipe and a wheel notch arrive as the same event with the same fields. Every
// published heuristic guesses from the shape of the deltas, and a free-spinning
// mouse wheel defeats all of them.
//
// So nothing here looks at delta size. The question is what the reader points
// with: a trackpad has swipe and pinch and no wheel, a mouse the reverse, so
// the whole wheel behaviour follows from that one answer.
//
//   * TRACKPAD. macOS turns a two-finger PINCH into `wheel` WITH a synthetic
//     `ctrlKey` — a convention, not a real key — and a two-finger SWIPE into
//     `wheel` without it. So ctrlKey zooms at the gesture's own scale and
//     everything else pans. Nothing zooms on a notch, because there are no
//     notches.
//   * MOUSE. The wheel zooms, at the library's speed, and `ctrlKey` is left to
//     the browser (on Windows and Linux it is the browser's own page zoom).
//
// Neither is detectable (a Mac with a mouse, a Windows laptop with a trackpad),
// so the platform supplies the default and the reader can change it. The mouse
// setting must stay reachable on a Mac, where a plain mouse would otherwise
// have no zoom.

import { cameraBasis, ndcOffset, panCamera } from "./camera.js";
import { gestureInternals } from "./internals.js";
import { INPUT_KEY, PINCH_DELTA_PER_E_FOLD } from "./options.js";
import { zoomWheelAfter, zoomWheelBefore } from "./zoom.js";

/**
 * Is this a Mac, i.e. is the pinch/swipe split above the right rule here?
 *
 * Fragile: `navigator.platform` is deprecated and frozen by browsers, and
 * `navigator.userAgentData` is Chromium-only, so both are read. If neither
 * answers, this returns false, the wheel zooms, and the reader has a setting.
 */
function isMacPlatform() {
  try {
    const hinted = navigator.userAgentData && navigator.userAgentData.platform;
    const name = (typeof hinted === "string" && hinted) || navigator.platform;
    return typeof name === "string" && /mac/i.test(name);
  } catch (error) {
    console.warn("platform", error);
    return false;
  }
}

/** The remembered answer, or the platform's, without touching the viewport. */
export function initialPointingDevice() {
  let saved = null;
  try {
    saved = localStorage.getItem(INPUT_KEY);
  } catch (error) {
    console.warn("pointing device", error);
  }
  // A reader who has answered keeps their answer on either platform.
  return saved === "trackpad" || (saved !== "mouse" && isMacPlatform());
}

/** Say what the reader is pointing with. `persist` is false while booting, so
 *  reading the setting never writes it back. */
export function setPointingDevice(vp, on, persist = true) {
  vp.trackpad = !!on;
  if (!persist) return;
  try {
    localStorage.setItem(INPUT_KEY, on ? "trackpad" : "mouse");
  } catch (error) {
    // Private mode, or storage turned off. The setting still holds for this
    // page; it just will not be remembered for the next one.
    console.warn("pointing device", error);
  }
}

/**
 * Pan on a two-finger swipe, which on a trackpad means every wheel event that is
 * not a pinch. True when the event was spent on a pan and must not reach the
 * controls; false leaves it alone, which is what every failure in here degrades
 * to.
 *
 * DIRECTION. The model follows the fingers — drag down, the model goes down. A
 * wheel delta is the negative of the finger movement (that is what "natural
 * scrolling" means) and the camera moves opposite to the model, so the two
 * negations cancel: the camera moves by the world vector of the displacement
 * taken literally. Hence the NDC y below is negated once, for NDC y pointing up
 * while deltaY, like every screen coordinate, points down — and no more.
 */
function panWheel(vp, event) {
  if (!vp.trackpad) return false;
  // The pinch, and the only branch in this feature that reads a field of the
  // event to decide anything. macOS sets `ctrlKey` on a pinch and on nothing
  // else here, so this is a fact rather than a guess.
  if (event.ctrlKey) return false;
  const viewer = vp.viewer;
  if (!viewer) return false;
  const g = gestureInternals(viewer, event);
  if (!g) return false;
  try {
    const rect = g.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    const nx = (2 * event.deltaX) / rect.width;
    const ny = -(2 * event.deltaY) / rect.height;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return false;
    const b = cameraBasis(viewer, g);
    if (!b) return false;
    // BOTH ENDS of the displacement, not one: the centre of the canvas is only
    // the camera's own axis on a symmetric frustum, and the difference is right
    // whatever the projection matrix turns out to be.
    const far = ndcOffset(g, b.eye, b.view, nx, ny);
    const near = ndcOffset(g, b.eye, b.view, 0, 0);
    if (!far || !near) return false;
    const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    if (!d.every(Number.isFinite)) return false;
    // A gesture that resolves to no movement is still the reader's gesture and
    // still must not reach the controls, or a slow swipe would zoom in fits.
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) return true;
    panCamera(viewer, b, d);
    return true;
  } catch (error) {
    console.warn("swipe pan", error);
    return false;
  }
}

/**
 * Zoom on a pinch, at the browser's own gesture scale. True when the event was
 * spent here and must not reach the controls.
 *
 * Only on the trackpad setting: a mouse has no pinch, and ctrl+wheel there
 * means whatever the browser makes of it.
 *
 * `PINCH_DELTA_PER_E_FOLD` says what the delta means. The cursor correction is
 * the wheel's: anchor on the current camera, set the zoom, slide the point
 * under the cursor back. Called by hand because `onCapture` stops this event
 * before the bubble phase, or the controls would zoom twice.
 *
 * No clamp: `TrackballControls` clamps to `minZoom`/`maxZoom`, which the
 * library leaves at three.js's 0 and Infinity.
 */
function pinchWheel(vp, event) {
  if (!vp.trackpad) return false;
  if (!event.ctrlKey) return false;
  // Pixels. The pinch is always deltaMode 0 (measured); a ctrl+wheel in lines
  // or pages is another device, which keeps the library's own zoom.
  if (event.deltaMode !== 0) return false;
  const viewer = vp.viewer;
  if (!viewer) return false;
  if (!gestureInternals(viewer, event)) return false;
  let z1;
  try {
    const z0 = viewer.getCameraZoom();
    if (!Number.isFinite(z0) || z0 <= 0) return false;
    z1 = z0 * Math.exp(-event.deltaY / PINCH_DELTA_PER_E_FOLD);
    if (!Number.isFinite(z1) || z1 <= 0) return false;
  } catch (error) {
    // Nothing has moved yet, so the cheapest honest answer is to let the
    // controls have the gesture: slow is still better than dead.
    console.warn("pinch zoom", error);
    return false;
  }
  zoomWheelBefore(vp, event);
  try {
    viewer.setCameraZoom(z1);
  } catch (error) {
    // Past the point of no return: the controls must not now zoom on top of
    // whatever this did, so the gesture stays spent.
    console.warn("pinch zoom", error);
    vp.zoomAnchor = null;
    return true;
  }
  zoomWheelAfter(vp);
  return true;
}

export function installWheel(vp) {
  /**
   * One capture listener for the whole wheel, because pan and zoom are three
   * answers to the same event and the choice has to be made in one place, before
   * the controls see it.
   *
   * Order is not free: `panWheel` declines a pinch and `pinchWheel` takes only a
   * pinch, so the two never both want an event and the wheel is what is left.
   */
  const onCapture = (event) => {
    if (panWheel(vp, event) || pinchWheel(vp, event)) {
      // Either no zoom is coming, or the one that came has already had its
      // cursor correction applied; a stale anchor would be spent on the next
      // gesture.
      vp.zoomAnchor = null;
      // preventDefault because the trackball's handler will not run: otherwise
      // a horizontal swipe navigates back/forward and a pinch zooms the page.
      event.preventDefault();
      // Keeps the event off the canvas and its controls. Other listeners on
      // this element (the idle clock) still see it; the bubble phase, and so
      // `onAfter`, does not.
      event.stopPropagation();
      return;
    }
    zoomWheelBefore(vp, event);
  };
  const onAfter = () => zoomWheelAfter(vp);

  // Capture on the CONTAINER runs before any listener on the canvas, bubble runs
  // after all of them, so the pair brackets the controls' zoom without depending
  // on the order the library registered its own listeners in.
  //
  // The capture half is NOT passive, and cannot be: on a swipe it is the one
  // that calls preventDefault, and a passive listener may not. It only ever does
  // so on a gesture it has already decided to spend.
  vp.box.addEventListener("wheel", onCapture, { capture: true, passive: false });
  vp.box.addEventListener("wheel", onAfter, { capture: false, passive: true });

  return () => {
    vp.box.removeEventListener("wheel", onCapture, { capture: true });
    vp.box.removeEventListener("wheel", onAfter, { capture: false });
  };
}
