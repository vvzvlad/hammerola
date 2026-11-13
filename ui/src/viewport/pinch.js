// Two fingers on the canvas: stop them rotating the model.
//
// A pinch rotates the model, by the wrong amount. `CADTrackballControls
// .update()` gates rotation on `noRotate` alone, never on `state`, and neither
// `_onHolroydPointerDown` nor `_onHolroydPointerMove` filters by `pointerId`,
// so a second finger overwrites `_holroydStart`/`_holroydEnd` and the rotation
// delta becomes the distance between the fingers, with alternating sign: the
// zoom jitters. The fix is the flag the library honours: `noRotate` on while
// two pointers are down. The zoom stays the library's.
//
// Not fixed here: lifting one of two fingers leaves the other rotating nothing,
// because the library clears `_holroydActive` on any pointerup
// (`_onHolroydPointerUp`). Fixing it means teaching the vendored handlers about
// pointer ids.

import { internals } from "./internals.js";

/**
 * The three.js trackball inside the library's controls wrapper, or null.
 *
 * `viewer.controls` is the wrapper; `controls.controls` is the
 * `CADTrackballControls` instance that owns `noRotate` and the holroyd state.
 * Resolved at each event, never cached: `render()` builds a new controls object
 * on every view switch and live reload.
 */
function trackballOf(g) {
  const tb = g && g.controls && g.controls.controls;
  return tb || null;
}

export function installPinchGuard(vp) {
  // The ids of pointers down on the canvas, separate from `vp.pointersDown`
  // (live.js), which also counts wheels and serves the IDLE_MS swap deferral;
  // a wheel has no fingers to guard.
  const down = new Set();

  // What we did to the trackball, so that only our change is undone. `onDown`
  // never takes a trackball whose `noRotate` is already on (somebody else's),
  // so `previous` is always false today; it is stored so the restore stays
  // correct if that condition is widened. The instance is stored too: a scene
  // rebuilt mid-gesture leaves a new trackball, and the flag to put back is on
  // the old one.
  let held = null;              // { tb, previous }

  /**
   * Give rotation back, squaring up the holroyd state first.
   *
   * `_holroydStart` advances only inside `_rotateCamera`, which `update()` skips
   * while `noRotate` is set, so it freezes when the second finger lands while
   * `_holroydEnd` keeps following the finger. Clearing `noRotate` first would
   * apply the whole accumulated delta in one jump on the next frame. Copying end
   * to start first makes `_rotateCamera`'s "start equals end" exit turn that
   * frame into a no-op.
   */
  const restore = () => {
    const was = held;
    held = null;
    if (!was) return;
    const { tb } = was;
    try {
      if (tb._holroydStart && tb._holroydEnd
          && typeof tb._holroydStart.copy === "function") {
        tb._holroydStart.copy(tb._holroydEnd);
      }
    } catch (error) {
      // Rotation still has to come back on: a viewport that cannot be turned is
      // a worse failure than one that jumps once.
      console.warn("pinch holroyd", error);
    }
    tb.noRotate = was.previous;
  };

  const onDown = (event) => {
    const g = internals(vp.viewer);
    if (!g) return;
    // On the canvas, not merely inside the container, which also holds the
    // library's own DOM (the same rule `gestureInternals` applies).
    if (event.target !== g.canvas) return;
    down.add(event.pointerId);
    if (down.size < 2 || held) return;
    const tb = trackballOf(g);
    if (!tb) return;
    // A `noRotate` that is already on is somebody else's — the library's own
    // option, or a viewport that ships with rotation off. Not ours to clear.
    if (tb.noRotate) return;
    held = { tb, previous: tb.noRotate };
    tb.noRotate = true;
  };

  const onUp = (event) => {
    // Only a release that ends a press we recorded: this hears every release
    // on the page, and `delete` checks and removes in one call.
    if (!down.delete(event.pointerId)) return;
    if (down.size < 2) restore();
  };

  // Capture on the container, an ancestor of the canvas, so this runs before
  // every library handler for the event and the second finger is guarded before
  // the trackball sees it. No preventDefault or stopPropagation: the pinch is
  // still the library's to zoom with.
  vp.box.addEventListener("pointerdown", onDown, true);
  // On the window: the trackball captures the pointer, so a finger can lift
  // outside the canvas, and a missed release would leave rotation off.
  addEventListener("pointerup", onUp, true);
  addEventListener("pointercancel", onUp, true);

  return () => {
    vp.box.removeEventListener("pointerdown", onDown, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onUp, true);
    down.clear();
    // Rotation goes back on the way out: an element unmounted mid-pinch would
    // otherwise leave a trackball that cannot turn.
    restore();
  };
}
