// Two fingers on the canvas: stop them rotating the model; and while any
// pointer is down on the canvas, limit repaints to one per frame. The rotation
// guard needs a second finger; the repaint budget helps a one-finger drag and a
// mouse orbit too.
//
// 1. A pinch rotates the model, by the wrong amount. `CADTrackballControls
//    .update()` gates rotation on `noRotate` alone, never on `state`, and
//    neither `_onHolroydPointerDown` nor `_onHolroydPointerMove` filters by
//    `pointerId`, so a second finger overwrites `_holroydStart`/`_holroydEnd`
//    and the rotation delta becomes the distance between the fingers, with
//    alternating sign: the zoom jitters. The fix is the flag the library
//    honours: `noRotate` on while two pointers are down. The zoom stays the
//    library's.
//
// 2. One pointermove is one complete render: `hasAnimationLoop` is false and
//    the library renders from a change listener, so every move pays for ambient
//    occlusion, tone mapping, SMAA and a second pass. During a gesture the calls
//    are coalesced into one `requestAnimationFrame`; otherwise they pass
//    straight through.
//
// Coalescing is confined to a gesture because `viewer.update` marks the
// id-picker dirty and `pickAt` re-renders its buffer only when dirty, so a
// deferred update lets a pick read the previous camera's buffer. Picks happen
// on pointerdown and pointerup, and the flush on the last release runs before
// the release's pick.
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
  // a wheel has no fingers to guard and no frames to coalesce here.
  const down = new Set();

  // What we did to the trackball, so that only our change is undone. `onDown`
  // never takes a trackball whose `noRotate` is already on (somebody else's),
  // so `previous` is always false today; it is stored so the restore stays
  // correct if that condition is widened. The instance is stored too: a scene
  // rebuilt mid-gesture leaves a new trackball, and the flag to put back is on
  // the old one.
  let held = null;              // { tb, previous }

  // The wrapped `update` and the original to put back. `viewer.update` is an
  // own arrow property assigned in the Viewer constructor, so assigning over it
  // on the instance intercepts internal `this.update(...)` calls too and
  // survives `render()` and `clear()`.
  let patched = null;           // { viewer, original, wrapper }
  let pending = null;           // { updateMarker, notify }
  let frame = 0;

  /** Run whatever the gesture deferred, right now. */
  const flush = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const args = pending;
    pending = null;
    if (!args || !patched) return;
    try {
      patched.original.call(patched.viewer, args.updateMarker, args.notify);
    } catch (error) {
      console.warn("pinch update", error);
    }
  };

  /** Put our wrapper on this viewer's `update`, once per viewer. */
  const wrapUpdate = (viewer) => {
    if (patched && patched.viewer === viewer) return;
    // A replaced viewer took our wrapper with it, and a deferred frame would
    // repaint a scene that is gone, so nothing is restored or flushed. The
    // element keeps one viewer across scene reloads, so this runs once.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    patched = null;
    if (!viewer || typeof viewer.update !== "function") return;
    const original = viewer.update;
    const wrapper = (updateMarker, notify) => {
      if (down.size === 0) return original.call(viewer, updateMarker, notify);
      // Keep the strongest arguments seen while a call is pending, so a batch
      // never does less than the calls it replaced. The library declares
      // `notify = true`, so an omitted `notify` is the strong value; `||` alone
      // would let a later explicit `false` win.
      const wanted = notify === undefined ? true : notify;
      pending = pending
        ? { updateMarker: pending.updateMarker || updateMarker,
            notify: pending.notify || wanted }
        : { updateMarker, notify: wanted };
      if (!frame) {
        frame = requestAnimationFrame(() => { frame = 0; flush(); });
      }
      return undefined;
    };
    viewer.update = wrapper;
    patched = { viewer, original, wrapper };
  };

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
    wrapUpdate(vp.viewer);
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
    if (down.size === 0) flush();
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
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    // Not flushed: the element disposes the viewer right after this runs.
    pending = null;
    if (patched && patched.viewer.update === patched.wrapper) {
      patched.viewer.update = patched.original;
    }
    patched = null;
  };
}
