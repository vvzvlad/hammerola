// How big the widget is, and the one-shot measurement behind it.
//
// Every number here is per-viewport state, not module-level: the interface can
// hold more than one viewport (the diff view shows two builds side by side),
// and one's chrome measurement is not the other's.

import { synchronously } from "./frames.js";
import { internals } from "./internals.js";
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

/**
 * The least time between two canvas resizes a `ResizeObserver` drives, in ms.
 *
 * Every 3D canvas here is multisampled (`antialias`), and a resize reallocates
 * its multisampled drawing buffer: 17 ms at 2860x1674 and 29 ms at 3840x2160
 * on an Apple M4, against 3.4 and 5.5 ms without MSAA. The observer ticks on
 * every frame of a window drag, so a resize per tick keeps the main thread busy
 * for the whole drag.
 */
export const RESIZE_MS = 100;

/**
 * `fn` at most once per `ms`. A call at least `ms` after the last run runs at
 * once; calls inside the window fold into ONE run at its end, which reads the
 * container as it is by then, so the canvas always ends at the final size.
 * `cancel()` drops that pending run.
 */
export function throttled(fn, ms = RESIZE_MS) {
  // -Infinity, not 0: `performance.now()` counts from the start of the
  // navigation, so 0 would hold back a resize in the page's first `ms`.
  let last = -Infinity;
  let timer = null;
  const run = () => {
    timer = null;
    last = performance.now();
    fn();
  };
  const call = () => {
    if (timer !== null) return;
    const wait = last + ms - performance.now();
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return call;
}

/** Re-fit the widget to the container. */
export function refit(vp) {
  if (!vp.viewer) return;
  const [w, h] = sized(vp);
  // The 4th argument is `glass`, and it DEFAULTS TO FALSE. Leaving it out means
  // the viewer silently drops out of glass mode and the layout jumps. Drawn in
  // this task: the resize resets the drawing buffer.
  synchronously(vp, () => vp.viewer.resizeCadView(w, treeWidth(w), h, displayOptions.glass));
  fitPanSpeed(vp);
}

/**
 * The model kept under the container between two refits, by CSS alone: the
 * canvas stretched to the container's size over its old drawing buffer, the
 * camera at the new shape, and one frame. three fixes the canvas's CSS size in
 * px, so without this the model stands still for up to RESIZE_MS and then
 * jumps. The buffer and the viewer's sizes stay at the last refit's, the
 * viewport `viewer.update` draws into among them: it is in CSS px times the
 * pixel ratio and has to cover the old buffer exactly. The next refit sets
 * them all. A canvas already at the container's size, as a refit leaves it,
 * is left alone.
 *
 * The widget's boxes follow too (`Display.setSizes`, the same call
 * `resizeCadView` makes): the canvas is transparent, and the colour behind it
 * is `.tcv_cad_viewer`'s, a box only as large as `.tcv_cad_body`'s px size, so
 * past the old size a grown canvas would show the page's colour instead.
 */
export function follow(vp) {
  const g = internals(vp.viewer);
  if (!g) return;
  const [w, h] = sized(vp);
  const style = g.canvas.style;
  if (style.width === `${w}px` && style.height === `${h}px`) return;
  style.width = `${w}px`;
  style.height = `${h}px`;
  g.display.setSizes({
    cadWidth: w, height: h, glass: displayOptions.glass, tools: displayOptions.tools,
  });
  // The pick target at the new size, as `resizeCadView` sets it: a pick maps a
  // pixel of the canvas as it is shown now.
  g.picker.setSize(w, h);
  g.camera.changeDimensions(vp.viewer.bb_radius, w, h);
  g.controls.handleResize();
  // In this task, the one that stretched the canvas.
  synchronously(vp, () => vp.viewer.update(true, false));
}

/**
 * The right-button pan's speed for the camera on screen and the canvas's
 * shape, so the model follows the cursor alike under both cameras.
 *
 * The trackball's ortho pan moves the model by a fixed share of the cursor's
 * travel. Its perspective pan (`CADTrackballControls`) counts the travel in
 * canvas heights and scales it by the eye's distance to the target. With the
 * fork's field of view (`Camera._perspectiveFov`) that is the same share on a
 * canvas wider than tall, and `aspect` times it on a taller one, where the
 * field of view widens to keep the ortho frame's width. The trackball is
 * shared with the board's 3D view, so the model's viewer makes up the
 * difference with its own pan speed, which the library keeps across a
 * `render()`.
 */
export function fitPanSpeed(vp) {
  const [w, h] = sized(vp);
  const aspect = w / h;
  const g = internals(vp.viewer);
  const perspective = !!g && !g.cam.isOrthographicCamera;
  vp.viewer.setPanSpeed(perspective && aspect < 1 ? 1 / aspect : 1, false);
}
