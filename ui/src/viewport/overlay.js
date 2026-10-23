// The thing drawn OVER the canvas at a place on the model: the label on a
// finished measurement. (Comments are arrows in the scene, pins.js.)
//
// It lives in the viewport rather than in React because its position is a
// projection of a world point through a camera that moves sixty times a second,
// and routing that through a state update per frame would make the interface
// re-render on every mouse move.
//
// Only the POSITION is set here. Everything about how the label looks is a
// class name the interface's own stylesheet owns — `.hmr_measure_label` —
// because the mock-up's colours are the designer's business and baking them in
// would mean two places to change them.

import { spot } from "./camera.js";
import { internals } from "./internals.js";
import { createLayer } from "./layer.js";
import { finite3 } from "./math.js";

export function createOverlay(vp) {
  // The root, the rAF loop and the teardown are `layer.js`'s. `wanted` and
  // `place` are the declarations below, so the root exists before anything is
  // put on it.
  const layer = createLayer({ wanted, place });
  const { root } = layer;
  // THE ONE LAYER WITH A CLASS NAME, for the reason at the head of this file:
  // the label's looks are the designer's and the stylesheet owns them.
  root.className = "hmr_overlay";

  const label = document.createElement("div");
  label.className = "hmr_measure_label";
  label.style.cssText = "position:absolute;left:0;top:0;display:none;"
    + "transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none";
  root.appendChild(label);

  /** Whether there is anything to place at all: a measurement. */
  function wanted() {
    return !!vp.measureLabel;
  }

  /** Put one absolutely-positioned child at a world point, or hide it.
   *
   * The two rects are passed in rather than measured here, read by `place`
   * before anything is written (see `spot` in camera.js).
   */
  const put = (el, point, g, rect, box) => {
    if (!g || !finite3(point)) {
      el.style.display = "none";
      return;
    }
    const at = spot(g, rect, box, point);
    // z > 1 is behind the camera's far plane, i.e. behind the reader. Under an
    // ortho projection that is a real case rather than a curiosity: the frustum
    // has a back and the model rotates through it.
    if (!at || at[2] > 1) {
      el.style.display = "none";
      return;
    }
    el.style.display = "";
    el.style.left = `${at[0]}px`;
    el.style.top = `${at[1]}px`;
  };

  function place() {
    // READ FIRST, THEN WRITE. Nothing is read when the library is not there:
    // `put` hides its element without looking at a rect, so the rects are not
    // taken either.
    const g = internals(vp.viewer);
    const rect = g ? g.canvas.getBoundingClientRect() : null;
    const box = g ? vp.box.getBoundingClientRect() : null;
    if (vp.measureLabel) {
      label.textContent = vp.measureLabel.text;
      put(label, vp.measureLabel.point, g, rect, box);
    } else {
      label.style.display = "none";
    }
  }

  return {
    root,
    refresh: layer.refresh,
    destroy: layer.destroy,
  };
}
