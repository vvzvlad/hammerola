// The model's renders, at most one per animation frame.
//
// The library draws on demand: `Viewer.update` renders the scene at once, and
// every state setter and the controls' change listener call it. A wheel zoom to
// the cursor (zoom.js) ends in `setCameraLocationSettings`, which renders on
// the change event of its `controls.update()` (zoomed, not yet panned to the
// cursor) and then once more itself, and a trackpad sends several wheel events
// a frame; at retina a render costs ~18 ms of GPU (depth peeling). Routed
// through here, every render asked for in a frame folds into one, drawn on the
// next animation frame from the state as it is by then.
//
// A hidden tab gets no animation frames, so a render asked for there is drawn
// when the tab is shown again.

/**
 * Route `viewer.update` through one render per animation frame. What it
 * answers leads back to the library's own, synchronous one:
 *
 * - `now(fn)` runs `fn` with every render it asks for drawn at once, a pending
 *   one folded in: for what has to be drawn before the browser presents the
 *   canvas (a resize resets the drawing buffer, which shows blank until drawn)
 *   or read back (`getImage`).
 * - `flush()` draws a pending render at once: for what reads what a render
 *   computes (the pick buffer, the camera's near and far planes).
 * - `cancel()` drops it, for a viewer being disposed.
 */
export function coalesceRenders(viewer) {
  const render = viewer.update;
  let marker = false;
  let notify = false;
  let frame = 0;
  let immediate = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    const args = [marker, notify];
    marker = false;
    notify = false;
    render(...args);
  };
  // `notify` defaults to true, as the library's own does.
  viewer.update = (updateMarker, notifyArg = true) => {
    marker = marker || !!updateMarker;
    notify = notify || !!notifyArg;
    if (immediate) run();
    else if (!frame) frame = requestAnimationFrame(run);
  };
  return {
    // A promise `fn` returns holds the synchronous renders until it settles:
    // `getImage` reads the canvas with `toBlob` a frame later, and without a
    // preserved drawing buffer only one drawn in that frame has the picture,
    // which the library's animation loop, running meanwhile, is there to draw.
    now(fn) {
      immediate += 1;
      let result;
      try {
        result = fn();
      } catch (error) {
        immediate -= 1;
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.finally(() => { immediate -= 1; });
      }
      immediate -= 1;
      return result;
    },
    flush() {
      if (frame) run();
    },
    cancel() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/** `fn` under `now`, or as it is on a viewport whose renders are not routed. */
export const synchronously = (vp, fn) => (vp.frames ? vp.frames.now(fn) : fn());
