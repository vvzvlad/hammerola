// Scaffolding for a layer drawn over the canvas: the absolutely-positioned
// root, one rAF loop that keeps it in step with the moving camera, and the
// teardown that stops both. The measurement label (overlay.js) uses it;
// `scene3d.js` is the counterpart for widgets that live in the scene, where the
// render places them.
//
// A loop rather than the trackball's `change` event, which fires on camera
// moves but not on frames redrawn for a live swap, a visibility change or a
// drag of a scene widget. The loop stops by itself when there is nothing to
// draw.
//
// Invariant that makes `refresh` enough: while the layer shows anything a frame
// is always pending (only `place` shows things, and it runs from `draw`, which
// re-arms). So hiding needs no synchronous call: the queued frame runs `place`
// with `wanted` false and the loop stops.
//
// The gesture is not here: each layer handles its own presses and drag state;
// `drag.js` is the shared half.

/**
 * One layer over the canvas: `{root, refresh, destroy}`.
 *
 * `wanted` is whether there is anything to draw at all — read every frame
 * rather than remembered, which is what lets the loop stop by itself — and
 * `place` draws it. Neither is called until `refresh` starts the loop.
 *
 * `pointer-events: none` on the root, and back on for whatever inside it is
 * meant to be pressed: the layer covers the whole canvas and would otherwise
 * swallow every press meant for the model.
 *
 * No class name here: a class is a promise that the interface's stylesheet has
 * a rule for it (tests/test_ui_source.py checks that). The overlay sets its own
 * on the root it is handed.
 */
export function createLayer({ wanted, place }) {
  const root = document.createElement("div");
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  let frame = 0;

  const draw = () => {
    frame = 0;
    place();
    schedule();
  };

  const schedule = () => {
    if (frame) return;
    if (!wanted()) return;
    frame = requestAnimationFrame(draw);
  };

  return {
    root,
    refresh: schedule,
    destroy() {
      // `if (frame)` is safe because a browser rAF handle is non-zero by spec
      // (HTML §8.10), the same reading the view cube's teardown leans on.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      root.remove();
    },
  };
}
