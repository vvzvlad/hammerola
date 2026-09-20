// The scaffolding the one layer drawn OVER the canvas is built out of: the
// absolutely-positioned root, the one rAF loop that keeps what is on it in step
// with a camera that moves sixty times a second, and the teardown that stops
// both.
//
// ONE LAYER IS LEFT USING IT — the pin overlay (overlay.js) — and it is a
// shared module because four of them shared it by transcription until this one
// existed: the same `cssText`, the same `frame` variable, the same `draw`, the
// same `schedule` and the same `cancelAnimationFrame` written out in four
// files. The other three have left for the scene since — the section grip, the
// rotation handles and the move tool's arrows, quads and origin dot — and
// `scene3d.js` is this module's twin for widgets that live there, where it is
// the RENDER that places them rather than a loop.
//
// WHY THE LOOP IS A LOOP AT ALL, which is the one decision that lives here
// rather than in the caller. The pins are divs over the canvas rather than
// objects in the scene, and they are still driven from here; the alternative
// for them would be re-projecting from the trackball's `change` event — which
// fires on camera moves and NOT on the frames a live swap, a visibility change
// or a drag of one of the widgets in the scene redraws. A loop that stops by
// itself when there is nothing to draw costs nothing on the ordinary page,
// which has no pins on it at all.
//
// AND THE INVARIANT THAT MAKES `refresh` ENOUGH: while the layer has anything
// on screen a frame is always pending, because the only thing that shows one is
// its own `place`, which runs from `draw`, which re-arms. So a pin going away
// needs no synchronous hide — the frame already queued runs `place`, `wanted`
// is false by then, and the same call takes the drawing off and lets the loop
// stop. That reading is this module's alone: `refresh` in `scene3d.js` asks the
// library for a frame instead.
//
// WHAT IS NOT HERE IS THE GESTURE. The layer keeps its own presses, its own
// drag state and its own ending, because what a press MEANS is the whole of
// what makes a widget its own module; `drag.js` is the other half they share,
// and the three widgets in the scene share it too.

/**
 * One layer over the canvas: `{root, refresh, destroy}`.
 *
 * `wanted` is whether there is anything to draw at all — read every frame
 * rather than remembered, which is what lets the loop stop by itself — and
 * `place` draws it. Neither is called until `refresh` starts the loop.
 *
 * `pointer-events: none` ON THE ROOT, and back on for whatever inside it is
 * meant to be pressed: the layer covers the whole canvas, so without this it
 * would swallow every press meant for the model — rotation included.
 *
 * NO CLASS NAME HERE, for the view cube's reason: a class is a promise the
 * interface's stylesheet keeps a rule for it (tests/test_ui_source.py checks
 * exactly that), and a layer that brings its own look over two canvases is not
 * making one. The overlay, whose pins ARE the designer's, sets its own on the
 * root it is handed.
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
