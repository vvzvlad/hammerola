// Two fingers on the glass — what they must not do; and, while ANY pointer is
// down on the canvas, how often the scene is allowed to be repainted. The two
// halves have different triggers on purpose: the rotation guard needs a SECOND
// finger to have anything to guard against, while the repaint budget is worth
// having for a one-finger drag and a mouse orbit just as much.
//
// TWO DEFECTS, ONE GESTURE, and they compound: the shake makes the reader move
// their fingers more, and every extra move is another full frame.
//
// 1. A PINCH ROTATES THE MODEL, and by the wrong number. `CADTrackballControls
//    .update()` gates rotation on `noRotate` alone and never on `state`, so
//    rotation keeps running through a pinch; and neither `_onHolroydPointerDown`
//    nor `_onHolroydPointerMove` filters by `pointerId`, so a second finger
//    overwrites `_holroydStart`/`_holroydEnd` and the rotation delta becomes the
//    distance BETWEEN the fingers, with the sign alternating as the two are
//    sampled. What the reader sees is a zoom that jitters.
//
//    The fix is one flag the library already honours: `noRotate` ON — which is
//    rotation OFF — for as long as two pointers are down. Nothing here touches
//    the pinch itself; the zoom stays the library's.
//
// 2. ONE POINTERMOVE IS ONE COMPLETE RENDER. `hasAnimationLoop` is false in this
//    viewport and the library renders from a change listener, so every move
//    event pays for ambient occlusion, tone mapping, SMAA and a second pass.
//    While a gesture is in flight the calls are coalesced into one
//    `requestAnimationFrame`; outside one they pass straight through,
//    synchronously, and nothing changes at all.
//
// WHY THE COALESCING IS CONFINED TO A GESTURE: `viewer.update` marks the
// id-picker dirty, and `pickAt` re-renders its buffer only when it is dirty, so
// a deferred update opens a window in which a pick reads the buffer from the
// previous camera. Picks happen on pointerdown and on pointerup, and the flush
// on the last release closes that window before the release's own pick runs.
//
// KNOWN AND NOT FIXED HERE: lifting one of two fingers leaves the remaining
// finger rotating nothing, because the library kills `_holroydActive` on ANY
// pointerup (`_onHolroydPointerUp`) rather than on the last one. That is already
// what happens today with no guard installed, so it is not a regression this
// introduces — and un-doing it means teaching the library's own handlers about
// pointer ids, which is the vendored bundle's business and not ours.

import { internals } from "./internals.js";

/**
 * The three.js trackball inside the library's controls wrapper, or null.
 *
 * `viewer.controls` is the wrapper; `controls.controls` is the
 * `CADTrackballControls` instance that owns `noRotate` and the holroyd state.
 * RESOLVED AT THE MOMENT OF THE EVENT and never cached at install time:
 * `render()` builds a new controls object, and this viewport calls it on every
 * view switch and every live reload — a reference taken once would guard a
 * trackball nobody is turning any more, and the one on screen would shake.
 */
function trackballOf(g) {
  const tb = g && g.controls && g.controls.controls;
  return tb || null;
}

export function installPinchGuard(vp) {
  // THE IDS OF THE POINTERS DOWN ON THE CANVAS, and a set of its own rather than
  // `vp.pointersDown`. That one is the idle clock's (live.js): it counts wheels
  // in the same field, because a wheel is a gesture for the purpose it serves,
  // and it carries the IDLE_MS tail a build swap is deferred by. Neither is true
  // here — a wheel has no fingers to guard and no frames to coalesce — so a
  // second reader would couple two jobs that only look alike.
  const down = new Set();

  // What we did to the trackball, so that only what WE did is ever undone. The
  // library sets `noRotate` itself, and a guard that cleared it on the way out
  // of a pinch would switch rotation back on behind somebody's back.
  //
  // WHAT ACTUALLY ENFORCES THAT IS `onDown`'s `if (tb.noRotate) return` and not
  // this saved value, which the guard therefore pins to false every time it is
  // written — a flag already up belongs to somebody else and we never take the
  // trackball at all. `previous` is kept as the literal thing to put back rather
  // than a hard `false`, so that the restore stays correct on its own terms if
  // that entry condition is ever widened.
  //
  // The INSTANCE is remembered with it: a scene rebuilt mid-gesture leaves a new
  // trackball behind, and the flag we have to put back is on the old one.
  let held = null;              // { tb, previous }

  // The wrapped `update` and the original to put back. `viewer.update` is an OWN
  // arrow property assigned in the Viewer constructor rather than a prototype
  // method, so assigning over it on the instance intercepts every internal
  // `this.update(...)` as well, and survives `render()` and `clear()`.
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
    // A viewer that was replaced took our wrapper with it, and a frame deferred
    // against it would repaint a scene that is gone: there is nothing to restore
    // and nothing to flush. The element builds ONE viewer and keeps it across
    // scene reloads, so in practice this runs once.
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    patched = null;
    if (!viewer || typeof viewer.update !== "function") return;
    const original = viewer.update;
    const wrapper = (updateMarker, notify) => {
      if (down.size === 0) return original.call(viewer, updateMarker, notify);
      // THE STRONGEST ARGUMENTS SEEN WHILE A CALL IS PENDING, so a coalesced
      // batch never does less than the calls it replaced. `notify` is spelled
      // out rather than left undefined because the library declares it
      // `notify = true` — an omitted one is the STRONG value, and `||` would
      // have let a later explicit `false` win over it.
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
   * Give rotation back, and SQUARE THE HOLROYD STATE UP FIRST.
   *
   * The order is the whole point of this function. `_holroydStart` is only ever
   * advanced inside `_rotateCamera`, which `update()` does not call while
   * `noRotate` is set, so it freezes at the point the second finger landed while
   * `_holroydEnd` goes on following the finger every `pointermove`. Clearing
   * `noRotate` first would let the very next frame apply the whole accumulated
   * delta in one jump — the model spinning away the instant a finger lifts.
   * Copied the other way round, `_rotateCamera`'s own "start equals end" early
   * exit makes that frame a no-op, which is what a release should be.
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
    // ON THE CANVAS and not merely inside the container: the library's own DOM
    // is in there too, and a press on it is not somebody holding the model —
    // the same qualifier `gestureInternals` applies to every camera gesture.
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
    // ONLY A RELEASE THAT ENDS A PRESS OF OUR OWN. This listener hears every
    // release on the page, and `delete` says whether the id was one we recorded
    // and removes it in the same call.
    if (!down.delete(event.pointerId)) return;
    if (down.size < 2) restore();
    if (down.size === 0) flush();
  };

  // CAPTURE ON THE CONTAINER, which is an ancestor of the canvas the library
  // listens on: a capture listener here runs before every library handler in the
  // same event, so the second finger is guarded before the trackball has looked
  // at it. Nothing here calls preventDefault or stopPropagation — the pinch is
  // still the library's to zoom with.
  vp.box.addEventListener("pointerdown", onDown, true);
  // On the WINDOW, like the tool drags and the orbit release: the trackball
  // captures the pointer, so a finger that came down on the canvas can perfectly
  // well lift outside it, and a release missed here would leave rotation off for
  // good.
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
    // NOT FLUSHED, deliberately: the viewport is going away and the element
    // disposes the viewer right after this runs, so the deferred frame would
    // repaint a scene on its way out.
    pending = null;
    if (patched && patched.viewer.update === patched.wrapper) {
      patched.viewer.update = patched.original;
    }
    patched = null;
  };
}
