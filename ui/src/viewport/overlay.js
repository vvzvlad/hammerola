// The things drawn OVER the canvas at a place on the model: comment pins, and
// the label on a finished measurement.
//
// They live in the viewport rather than in React because their position is a
// projection of a world point through a camera that moves sixty times a second,
// and routing that through a state update per frame would make the interface
// re-render on every mouse move. What crosses the boundary instead is the DATA
// (`state.pins`) and the CLICK (`hmr:pin`).
//
// Only the POSITION is set here. Everything about how a pin looks is a class
// name the interface's own stylesheet owns — `.hmr_pin`, plus `.is_active` and
// `.is_resolved` — because the mock-up's colours are the designer's business and
// baking them in would mean two places to change them.

import { EVENT_PIN, emit } from "./events.js";
import { spot } from "./camera.js";
import { internals } from "./internals.js";
import { createLayer } from "./layer.js";
import { finite3 } from "./math.js";

export function createOverlay(vp) {
  // The root, the rAF loop and the teardown are `layer.js`'s, which three other
  // layers are built out of as well. `wanted` and `place` are the declarations
  // below, so the root exists before anything is put on it.
  const layer = createLayer({ wanted, place });
  const { root } = layer;
  // THE ONE LAYER WITH A CLASS NAME, for the reason at the head of this file:
  // the pins' looks are the designer's and the stylesheet owns them.
  root.className = "hmr_overlay";

  const label = document.createElement("div");
  label.className = "hmr_measure_label";
  label.style.cssText = "position:absolute;left:0;top:0;display:none;"
    + "transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none";
  root.appendChild(label);

  const pins = new Map();

  /** Whether there is anything to place at all — a pin, or a measurement. */
  function wanted() {
    return !!(pins.size || vp.measureLabel);
  }

  /** Put one absolutely-positioned child at a world point, or hide it.
   *
   * THE TWO RECTS ARE PASSED IN rather than measured here, and `spot` in
   * camera.js says why: `place` calls this in a loop and every iteration WRITES
   * styles, so a `getBoundingClientRect()` at the top of the next one forces
   * the browser to flush the layout the previous one invalidated.
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
    // READ EVERYTHING FIRST, THEN WRITE — one measurement per frame instead of
    // one per pin. Nothing is read when the library is not there: `put` hides
    // its element without looking at a rect, so the rects are not taken either.
    const g = internals(vp.viewer);
    const rect = g ? g.canvas.getBoundingClientRect() : null;
    const box = g ? vp.box.getBoundingClientRect() : null;
    for (const [, entry] of pins) put(entry.el, entry.point, g, rect, box);
    if (vp.measureLabel) {
      label.textContent = vp.measureLabel.text;
      put(label, vp.measureLabel.point, g, rect, box);
    } else {
      label.style.display = "none";
    }
  }

  /** Reconcile the pin elements against `state.pins`. */
  const setPins = (list) => {
    const wanted = Array.isArray(list) ? list : [];
    const seen = new Set();
    for (const pin of wanted) {
      if (!pin || pin.id === undefined || !finite3(pin.p)) continue;
      const key = String(pin.id);
      seen.add(key);
      let entry = pins.get(key);
      if (!entry) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "hmr_pin";
        el.style.cssText = "position:absolute;left:0;top:0;pointer-events:auto";
        // The press must not reach the canvas, or clicking a pin would also
        // start a rotation under it.
        el.addEventListener("pointerdown", (event) => event.stopPropagation());
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          emit(vp, EVENT_PIN, { id: pin.id });
        });
        root.appendChild(el);
        entry = { el, point: pin.p };
        pins.set(key, entry);
      }
      entry.point = pin.p;
      entry.el.textContent = pin.label === undefined ? "" : String(pin.label);
      entry.el.classList.toggle("is_active", !!pin.active);
      entry.el.classList.toggle("is_resolved", !!pin.resolved);
    }
    for (const [key, entry] of [...pins]) {
      if (seen.has(key)) continue;
      entry.el.remove();
      pins.delete(key);
    }
    layer.refresh();
  };

  return {
    root,
    setPins,
    refresh: layer.refresh,
    destroy() {
      pins.clear();
      layer.destroy();
    },
  };
}
