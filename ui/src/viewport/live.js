// What a build swap carries across, and when it is allowed to happen.
//
// A new build arriving while somebody looks at the old one is picked up without
// losing the camera angle the reader set by hand.
//
// Polling is not here: the interface owns meta.json, the build picker and the
// "new build waiting" notice, and never substitutes a build silently. The
// viewport owns what only it can do: read the frame off a scene about to be torn
// down, put it back on the replacement, and say whether a gesture is in
// progress.

import { internals } from "./internals.js";
import { IDLE_MS } from "./options.js";
import { captureSection, restoreSection } from "./section.js";
import { statesOf } from "./parts.js";

/** The frame the reader is looking at, in the library's own terms, or null. */
export function cameraState(viewer) {
  try {
    if (!viewer) return null;
    if (typeof viewer.getCameraLocationSettings === "function") {
      const c = viewer.getCameraLocationSettings();
      return { position: c.position, quaternion: c.quaternion,
               target: c.target, zoom: c.zoom };
    }
    return {
      position: viewer.getCameraPosition(),
      quaternion: viewer.getCameraQuaternion(),
      target: viewer.getCameraTarget(),
      zoom: viewer.getCameraZoom(),
    };
  } catch (error) {
    // A comment without a camera is still a useful comment: the part name is
    // what leads to the code. Losing the frame must not lose it.
    console.warn("camera state", error);
    return null;
  }
}

/** Everything a swap carries across, read BEFORE the scene is cleared. */
export function captureLive(vp) {
  return {
    view: vp.view,
    tab: vp.tab,
    camera: cameraState(vp.viewer),
    // ONLY VISIBILITY (docs/viewer-api.md §4). Transparency and selection are
    // not in here and do not need to be: they are `state.ghost` and
    // `state.selected`, which the interface holds and re-sends after the swap.
    states: statesOf(vp.viewer),
    section: captureSection(vp),
  };
}

/**
 * Put back what `captureLive` took, on the freshly rendered scene.
 *
 * The order is fixed: states -> camera -> tab -> section.
 *
 * Tree first, because hiding a part runs its own update and the camera should
 * have the final say. The tab before the section, because switching into the
 * library's Clip tab turns local clipping on and switching out turns it off, so
 * a plane restored before the tab would be un-cut by the library.
 */
export function restoreLive(vp, keep) {
  const viewer = vp.viewer;
  if (!viewer || !keep) return;
  try {
    if (keep.states && typeof viewer.setStates === "function") {
      // A path the new build no longer has is a no-op inside the library
      // (`setState` looks the node up and returns when it is missing), so a part
      // that was renamed or removed simply comes back visible instead of
      // throwing away the rest of the tree state.
      viewer.setStates(keep.states);
    }
  } catch (error) {
    console.warn("live states", error);
  }
  const c = keep.camera;
  try {
    if (c && typeof viewer.setCameraLocationSettings === "function") {
      // notify: false — this is restoring the frame the reader already had, not
      // a camera move anything downstream should react to.
      viewer.setCameraLocationSettings(c.position, c.quaternion, c.target,
                                       c.zoom, false);
    }
  } catch (error) {
    console.warn("live camera", error);
  }
  try {
    if (keep.tab && typeof viewer.setActiveTab === "function") {
      viewer.setActiveTab(keep.tab);
    }
  } catch (error) {
    console.warn("live tab", error);
  }
  restoreSection(vp, keep.section);
}

/**
 * True while the viewport is in the reader's hands and must not be re-rendered.
 *
 * A stale model is a smaller loss than interrupting the reader. The interface
 * has its own reasons to defer a swap (a half-typed comment); this answers for
 * what only the viewport sees: a gesture on the canvas in progress, or one that
 * ended under IDLE_MS ago, since re-seating the camera between mousedown and
 * mouseup pulls the model out from under the pointer.
 *
 * Only canvas presses count (`lastTouch` records only those, see
 * `installIdleClock`); otherwise every click in the interface, including the
 * "Switch" button that asks for the swap, would defer it.
 */
export function isBusy(vp) {
  // A set of pointer ids, not a flag, to count fingers (see
  // `installIdleClock`). Read its size: an empty Set is truthy.
  if (vp.pointersDown.size > 0) return true;
  return performance.now() - vp.lastTouch < IDLE_MS;
}

export function installIdleClock(vp) {
  // These only ever write a timestamp or a pointer id. PASSIVE, so they can
  // never call preventDefault, and they must stay that way: the trackball and
  // the tools own these same events and neither may notice this exists.
  // `stopPropagation` in a tool does not silence them either — it stops the
  // bubble phase, not the other listeners on the element it was called on.
  const opts = { capture: true, passive: true };
  const touched = () => { vp.lastTouch = performance.now(); };

  // Whether `onBlur` emptied the set while presses were still outstanding — see
  // the two comments that use it. Kept in this closure and not on `vp`: it is
  // one clock's bookkeeping about its own recovery, and nothing outside asks.
  let clearedMidGesture = false;

  // Ids rather than a flag because one bit cannot count fingers: with two down,
  // the first `pointerup` would clear the flag while the second was still on
  // the glass, and since `pointermove` does not refresh the IDLE_MS window a
  // long pinch or drag would read as idle and a swap would re-seat the camera
  // under it.
  const onDown = (event) => {
    vp.pointersDown.add(event.pointerId);
    touched();
  };

  // Only a release that ends a press recorded by this clock: `delete` checks
  // and removes in one call. The listener is on the window and hears every
  // release on the page, including the press on "Switch" (which reaches the
  // window before React dispatches the click, and would otherwise defer the swap
  // it asks for) and, on a touchscreen, a finger lifting from the interface
  // while one of ours is still down.
  //
  // Exception: exactly one unpaired release is accepted after a blur that found
  // presses outstanding (see `onBlur`).
  const onUp = (event) => {
    if (!vp.pointersDown.delete(event.pointerId)) {
      if (!clearedMidGesture) return;
      clearedMidGesture = false;
      touched();
      return;
    }
    touched();
  };

  // Recovery for a press whose release never arrives: a drag let go over
  // another window, a tab that lost focus mid-press. A touch gets a fresh id per
  // touch, so nothing would ever name the stranded id again. The interface's
  // BUSY_WAIT_MS deadline is the backstop; this is the cheap way out.
  //
  // `blur` is the only event that fires for both cases: a backgrounded tab
  // blurs the window, and so does another window taking focus while this page
  // stays visible (which `visibilitychange` does not report).
  // `lostpointercapture` cannot help, since the capture is released by the very
  // `pointerup` that went missing.
  //
  // Not registered with `opts`: `blur` does not bubble but does propagate in
  // the capture phase, so a capturing window listener would also hear the
  // element-level blur an ordinary press causes and clear the press at its start.
  //
  // No `lastTouch` stamp here: the release this stands in for may have happened
  // long before the focus moved. But focus can also leave while the gesture is
  // still running (alt-tab with a button held, a notification, devtools); then
  // the set empties, the drag goes on, and the final `pointerup` matches no id.
  // So `clearedMidGesture` records that a press was lost, and the next unpaired
  // release stamps and clears it (`onUp`). The residue is one IDLE_MS delay in
  // "blur mid-press, come back, press something in the interface".
  const blurOpts = { passive: true };
  const onBlur = () => {
    if (vp.pointersDown.size > 0) clearedMidGesture = true;
    vp.pointersDown.clear();
  };

  vp.box.addEventListener("pointerdown", onDown, opts);
  vp.box.addEventListener("wheel", touched, opts);
  // On the WINDOW: the trackball captures the pointer, so a drag that starts on
  // the canvas can perfectly well end outside it, and a pointerup missed here
  // would leave the viewport "busy" for good.
  addEventListener("pointerup", onUp, opts);
  addEventListener("pointercancel", onUp, opts);
  addEventListener("blur", onBlur, blurOpts);
  return () => {
    vp.box.removeEventListener("pointerdown", onDown, opts);
    vp.box.removeEventListener("wheel", touched, opts);
    removeEventListener("pointerup", onUp, opts);
    removeEventListener("pointercancel", onUp, opts);
    removeEventListener("blur", onBlur, blurOpts);
  };
}

/** The library's own render of the current frame, as a PNG blob, or null.
 *
 * `getImage` and NOT `pinAsPng`: pinAsPng builds an `<img>` and, when a
 * pinAsPngCallback is set, does nothing else with it — the callback is only ever
 * read as a null check in the vendored bundle, so it never delivers the data
 * URL. `getImage` is the public API pinAsPng itself calls to produce exactly the
 * same screenshot.
 *
 * Decoded by hand rather than with `fetch(dataUrl)`: the page's CSP is
 * `default-src 'self'`, connect-src inherits it, and a `data:` URL is not 'self'.
 */
export async function snapshot(vp, label) {
  const prefix = "data:image/png;base64,";
  try {
    if (!vp.viewer || !internals(vp.viewer)) return null;
    const data = await vp.viewer.getImage(label || "snapshot");
    const url = data && data.dataUrl;
    if (typeof url !== "string" || !url.startsWith(prefix)) return null;
    const raw = atob(url.slice(prefix.length));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], { type: "image/png" });
  } catch (error) {
    console.warn("snapshot", error);
    return null;
  }
}
