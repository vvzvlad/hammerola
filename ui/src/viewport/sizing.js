// How big the widget is, and the one-shot measurement behind it.
//
// Ported from the page viewer this interface replaced, with one change of
// shape: every number here
// is per-VIEWPORT state rather than a module-level pair, because the interface
// can hold more than one (the diff view of ui-brief block 9 is two builds side
// by side) and a chrome measurement taken from one is not the other's.

import { displayOptions } from "./options.js";

/**
 * `cadWidth`/`height` describe the CANVAS, but the viewer wraps it in chrome of
 * its own — a margin on its root, margins and padding on the toolbar and view
 * rows. Handing it the raw container size therefore builds a widget wider and
 * taller than the container, and the container clips the difference: the bottom
 * of the canvas simply disappears.
 *
 * Measured off the DOM rather than hardcoded, so restyled chrome in a viewer
 * upgrade cannot quietly put the numbers out of date. ONE SHOT — after the first
 * correction the root is `requested + chrome`, so measuring again reads back
 * zero.
 */
export function measureChrome(vp, reqW, reqH) {
  const root = vp.box.querySelector(".tcv_cad_viewer");
  if (!root || vp.chromeKnown) return;
  const cs = getComputedStyle(root);
  const mx = parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
  const my = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  vp.chrome = [Math.max(0, root.offsetWidth + mx - reqW),
               Math.max(0, root.offsetHeight + my - reqH)];
  vp.chromeKnown = true;
}

/** Size from the CONTAINER, never from the window: an assumed header height puts
 *  the header off-screen the moment it is wrong. */
export function sized(vp) {
  return [Math.max(320, vp.box.clientWidth - vp.chrome[0]),
          Math.max(240, vp.box.clientHeight - vp.chrome[1])];
}

/**
 * The library's tree is hidden at `tools: false`, but `resizeCadView` still
 * wants a width for it and still lays the widget out around one. Kept at the
 * ceiling `displayOptions.treeWidth` declares — the width the page viewer this
 * interface replaced ran with — and allowed to shrink with the canvas, so a
 * narrow screen does not end up with the model behind a column nobody can see.
 */
export const treeWidth = (w) =>
  Math.max(120, Math.min(displayOptions.treeWidth, Math.round(w * 0.4)));

/** Re-fit the widget to the container. */
export function refit(vp) {
  if (!vp.viewer) return;
  const [w, h] = sized(vp);
  // The 4th argument is `glass`, and it DEFAULTS TO FALSE. Leaving it out means
  // the viewer silently drops out of glass mode and the layout jumps.
  vp.viewer.resizeCadView(w, treeWidth(w), h, displayOptions.glass);
}
