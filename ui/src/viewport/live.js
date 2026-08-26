// What a build swap has to carry across, and when it is allowed to happen.
//
// The feature this serves is ui-brief block 11: a new build arrives while
// somebody is looking at the old one, and the page picks it up WITHOUT losing
// the angle. That last part is the whole thing — somebody aims the camera at
// what they are complaining about, and a swap that puts them back at the default
// iso view has taken away the one piece of state they set by hand.
//
// The POLLING is not here. The interface owns meta.json, the build picker and
// the "new build waiting" notice, and block 11 is explicit that an arriving
// build must not be substituted silently. What the viewport owns is the pair of
// operations only it can perform — read the frame off a scene about to be torn
// down, and put it back on the one that replaced it — plus the one question the
// interface cannot answer for it: is a gesture in progress right now.

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
 * THE ORDER IS FIXED, and each step is where it is for a reason:
 *
 *   states -> camera -> tab -> section
 *
 * Tree first, because hiding a part runs an update of its own and the camera
 * should have the final say on what the frame looks like. The tab before the
 * section, because switching INTO the library's Clip tab turns local clipping on
 * and switching OUT of it turns clipping off — so a plane put back before the
 * tab moved would be a plane the library then un-cuts.
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
 * The rule this encodes: a stale model is a smaller loss than anything the
 * person in front of it is in the middle of. The interface has reasons of its
 * own to defer a swap — a half-typed comment is the clearest — and asks this for
 * the ones only the viewport can see: a gesture ON THE CANVAS in progress, and
 * the moment just after one, because a swap re-seats the camera and doing that
 * between a mousedown and the mouseup pulls the model out from under the
 * pointer.
 *
 * ON THE CANVAS is the whole qualifier, and `lastTouch` only ever records one of
 * those — see `installIdleClock`. A click anywhere else on the page is not the
 * reader holding the model, and counting it here made this answer true for
 * IDLE_MS after EVERY click in the interface, the press on the "Switch" button
 * that asks for the swap included.
 */
export function isBusy(vp) {
  if (vp.pointerHeld) return true;
  return performance.now() - vp.lastTouch < IDLE_MS;
}

export function installIdleClock(vp) {
  // These only ever write a timestamp or a flag. PASSIVE, so they can never call
  // preventDefault, and they must stay that way: the trackball and the tools own
  // these same events and neither may notice this exists. `stopPropagation` in a
  // tool does not silence them either — it stops the bubble phase, not the other
  // listeners on the element it was called on.
  const opts = { capture: true, passive: true };
  const touched = () => { vp.lastTouch = performance.now(); };
  const onDown = () => { vp.pointerHeld = true; touched(); };
  // ONLY A RELEASE THAT ENDS A PRESS OF OUR OWN, which is what `pointerHeld`
  // says: this listener is on the window (see below) and therefore hears every
  // release on the page, and a stamp for one of those would make `isBusy` mean
  // "somebody clicked something recently" instead of "the model is being held".
  // The reader's press on "Switch" is such a release, and it reaches the window
  // BEFORE React dispatches the click that acts on it — so the swap the button
  // asks for found the viewport busy every single time and deferred for the
  // whole of IDLE_MS, on a page nobody had touched the model on.
  //
  // The guard costs the flag nothing, and that matters: ANY release still
  // clears it, because the only case it skips is the one where there is nothing
  // to clear. A press whose release went to another window leaves the flag
  // standing with nobody left to clear it, and the reader's next click
  // anywhere — on the page, not necessarily on the model — is what recovers it.
  const onUp = () => {
    if (!vp.pointerHeld) return;
    vp.pointerHeld = false;
    touched();
  };
  vp.box.addEventListener("pointerdown", onDown, opts);
  vp.box.addEventListener("wheel", touched, opts);
  // On the WINDOW: the trackball captures the pointer, so a drag that starts on
  // the canvas can perfectly well end outside it, and a pointerup missed here
  // would leave the viewport "busy" for good.
  addEventListener("pointerup", onUp, opts);
  addEventListener("pointercancel", onUp, opts);
  return () => {
    vp.box.removeEventListener("pointerdown", onDown, opts);
    vp.box.removeEventListener("wheel", touched, opts);
    removeEventListener("pointerup", onUp, opts);
    removeEventListener("pointercancel", onUp, opts);
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
