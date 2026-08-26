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
  // A SET OF POINTER IDS AND NOT A FLAG, because one bit cannot count fingers —
  // `installIdleClock` carries the whole story. Read for its SIZE and never for
  // its truthiness: an EMPTY Set is truthy, so the boolean-shaped test this line
  // used to be would report "busy" for ever. The field was renamed along with
  // its shape for that reason alone — the old name resolves nowhere now, so no
  // such test can survive the change unnoticed.
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

  // THE ID AND NOT A FLAG, because one bit cannot count fingers. With two down,
  // the FIRST `pointerup` cleared the flag while the second was still on the
  // glass, and the answer fell through to the IDLE_MS window — which
  // `pointermove` does not refresh, only a press or a wheel does. A pinch or a
  // drag that ran on for longer than IDLE_MS past that first lift therefore
  // reported "not busy", and the swap it let through re-seated the camera under
  // the fingers still doing it. A mouse never showed it: one pointer, and a set
  // of one is a flag.
  const onDown = (event) => {
    vp.pointersDown.add(event.pointerId);
    touched();
  };

  // ONLY A RELEASE THAT ENDS A PRESS OF OUR OWN, which is now "an id this clock
  // recorded" — `delete` says whether it was one and removes it in the same
  // call. This listener is on the window (see below) and therefore hears every
  // release on the page, and TWO different things arrive here as an id nobody
  // pressed the canvas with. The reader's press on "Switch" is the first: it
  // reaches the window BEFORE React dispatches the click that acts on it, so a
  // stamp for it made `isBusy` mean "somebody clicked something recently" and
  // the swap the button asks for deferred for the whole of IDLE_MS on a page
  // nobody had touched the model on. The second exists only on a touchscreen — a
  // finger that came down on the interface rather than the canvas, lifting while
  // a finger of ours is still down — and it is the one the id buys: under the
  // flag it took our finger's press with it.
  //
  // AND ONE UNPAIRED RELEASE IS LET BACK IN, exactly one, and only after a blur
  // that found presses outstanding. That is the tail `onBlur` would otherwise
  // take away in the middle of a gesture — read its comment for the sequence.
  // The id guard still holds for everything else, the "Switch" button included:
  // no blur, no exemption.
  const onUp = (event) => {
    if (!vp.pointersDown.delete(event.pointerId)) {
      if (!clearedMidGesture) return;
      clearedMidGesture = false;
      touched();
      return;
    }
    touched();
  };

  // THE RECOVERY FOR A PRESS WHOSE RELEASE NEVER ARRIVES — a drag let go of over
  // another window, a tab that lost focus mid-press. It used to be free: the
  // flag was global, so any release anywhere cleared it. Ids take that away
  // exactly where it was worth having, because a finger is given a FRESH id per
  // touch and nothing on the page ever names the stranded one again. (A mouse
  // keeps one id for the life of the page and so still clears itself on the next
  // click, but a mouse is not what strands a press for long.) The interface's
  // BUSY_WAIT_MS deadline is still the backstop; this is the cheap way out.
  //
  // `blur` ALONE of the candidates, because it is the only one that fires for
  // both cases above: a tab sent to the background blurs the window, and so does
  // another window taking the focus while this page stays perfectly visible —
  // which is precisely what `visibilitychange` would NOT report.
  // `lostpointercapture` cannot help by construction, since the capture is
  // released by the very `pointerup` that went missing.
  //
  // NOT REGISTERED WITH `opts`, and that is the trap: `blur` does not bubble,
  // but it does propagate in the CAPTURE phase, so a capturing listener on the
  // window would also hear the element-level blur that an ordinary press causes
  // when focus leaves whatever had it — clearing the press at the start of the
  // gesture this exists to protect. Passive it stays, like everything else here.
  //
  // NO `lastTouch` STAMP HERE, AND THAT IS A TRADE RATHER THAN A PURE WIN. The
  // reason for it stands: this is the clock admitting it lost track of a press,
  // not a gesture ending, and the release it stands in for may have happened
  // long before the focus moved. What it costs is the case where the focus left
  // WHILE THE GESTURE WAS STILL RUNNING — alt-tab with a button held, an OS
  // notification, devtools opening. The set empties, the drag carries on,
  // `pointermove` refreshes nothing, and `isBusy()` answers false for the rest
  // of it; the final `pointerup` then matches no recorded id, so under the id
  // guard alone it made no stamp either. A live swap arriving in that window
  // re-seats the camera under fingers still dragging it — the very failure the
  // set was introduced to remove, reached through a focus change instead of a
  // second finger.
  //
  // So the two cases are told apart rather than merged: the flag says the clock
  // lost a press it had, and the next UNPAIRED release — the missing half of
  // that gesture — stamps after all and forgets the flag (`onUp`). The residue
  // is one deferred swap of IDLE_MS in the sequence "blur mid-press, come back,
  // press something in the interface", which is a delay rather than a camera
  // pulled out from under a hand.
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
