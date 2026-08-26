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
import { projectPoint } from "./camera.js";
import { internals } from "./internals.js";
import { finite3 } from "./math.js";

export function createOverlay(vp) {
  const root = document.createElement("div");
  root.className = "hmr_overlay";
  // `pointer-events: none` on the layer and back on for the pins: the layer
  // covers the whole canvas, so without this it would swallow every press meant
  // for the model — rotation included.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  const label = document.createElement("div");
  label.className = "hmr_measure_label";
  label.style.cssText = "position:absolute;left:0;top:0;display:none;"
    + "transform:translate(-50%,-50%);white-space:nowrap;pointer-events:none";
  root.appendChild(label);

  const pins = new Map();
  let frame = 0;

  /** Place one absolutely-positioned child at a world point, or hide it. */
  const place = (el, point) => {
    const g = internals(vp.viewer);
    if (!g || !finite3(point)) {
      el.style.display = "none";
      return;
    }
    const ndc = projectPoint(g, point);
    // z > 1 is behind the camera's far plane, i.e. behind the reader. Under an
    // ortho projection that is a real case rather than a curiosity: the frustum
    // has a back and the model rotates through it.
    if (!ndc || ndc[2] > 1) {
      el.style.display = "none";
      return;
    }
    const rect = g.canvas.getBoundingClientRect();
    const box = vp.box.getBoundingClientRect();
    el.style.display = "";
    el.style.left = `${(ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left)}px`;
    el.style.top = `${(-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top)}px`;
  };

  const draw = () => {
    frame = 0;
    for (const [, entry] of pins) place(entry.el, entry.point);
    if (vp.measureLabel) {
      label.textContent = vp.measureLabel.text;
      place(label, vp.measureLabel.point);
    } else {
      label.style.display = "none";
    }
    schedule();
  };

  /**
   * One rAF loop, and only while there is something to place.
   *
   * The library owns the render loop and offers no post-render hook, so the
   * alternative would be re-projecting from the trackball's `change` event —
   * which fires on camera moves and NOT on the frames a live swap or a
   * visibility change redraws. A loop that stops on its own when the overlay is
   * empty costs nothing on the ordinary page, which has no pins.
   */
  const schedule = () => {
    if (frame) return;
    if (!pins.size && !vp.measureLabel) return;
    frame = requestAnimationFrame(draw);
  };

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
    schedule();
  };

  return {
    root,
    setPins,
    refresh: schedule,
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      pins.clear();
      root.remove();
    },
  };
}
