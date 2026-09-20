// The scaffolding every layer drawn OVER the canvas is built out of: the
// absolutely-positioned root, the one rAF loop that keeps what is on it in step
// with a camera that moves sixty times a second, and the teardown that stops
// both.
//
// TWO LAYERS SHARE IT — the pin overlay (overlay.js) and the axis arrows and
// plane quads (gizmo.js) — and they shared it by transcription until this
// module existed: the same `cssText`, the same `frame` variable, the same
// `draw`, the same `schedule` and the same `cancelAnimationFrame` written out
// in four files. Two of those four have left for the scene since — the section
// grip and the rotation handles — and `scene3d.js` is this module's twin for
// widgets that live there, where it is the RENDER that places them rather than
// a loop.
//
// WHY THE LOOP IS A LOOP AT ALL, which is the one decision that lives here
// rather than in a caller. The two layers above are divs over the canvas
// rather than objects in the scene, and they are still driven from here; the
// alternative for them would be re-projecting from the trackball's `change`
// event — which fires on camera moves and NOT on the frames a live swap, a
// visibility change or a drag of one of these very widgets redraws. A loop that
// stops by itself when there is nothing to draw costs nothing on the ordinary
// page, which has no pins, no cut and no tool armed.
//
// AND THE INVARIANT THAT MAKES `refresh` ENOUGH: while a layer has anything on
// screen a frame is always pending, because the only thing that shows one is
// that layer's own `place`, which runs from `draw`, which re-arms. So a cut
// going away, or a selection, needs no synchronous hide — the frame already
// queued runs `place`, `wanted` is false by then, and the same call takes the
// drawing off and lets the loop stop. That reading is this module's alone:
// `refresh` in `scene3d.js` asks the library for a frame instead.
//
// WHAT IS NOT HERE IS THE GESTURE. Each layer keeps its own presses, its own
// drag state and its own ending, because what a press MEANS is the whole of
// what makes them separate modules; `drag.js` is the other half they share, and
// they share it with the grip in the scene as well.

/** The ink's halo: one filter over a whole shape, drawn on either canvas.
 *
 * ONE COLOUR FOR BOTH THEMES, and this is what makes that honest — the trade
 * the view cube makes and for the same reason: the canvas under these widgets
 * is white or near-black depending on the reader's answer (`readTheme` in
 * ui/src/store.js), so a widget has to bring its own contrast rather than borrow
 * the page's. Dark ink reads on the light canvas directly and on the dark one
 * against the white glow, and because this is a single filter over the whole
 * shape it follows a border triangle as well as a shaft.
 *
 * AN EDGE TREATMENT AND NOTHING ELSE, which is why the quads and the origin dot
 * decline it: a 1 px glow is contrast on a 2 px shaft, where the ink is nearly
 * all edge, and a hairline round a filled block ten pixels across. `gizmo.js`
 * (`CASING`) carries the rest of that argument, and the two widgets in the
 * scene answer it with geometry instead (`HANDLE_CASE_PX`, `RING_CASE_PX`).
 */
export const HALO =
  "drop-shadow(0 0 1px #fff) drop-shadow(0 1px 2px rgba(20,24,28,.45))";

/** One absolutely-positioned piece of a widget, appended to `parent`.
 *
 * A VERB IN THE NAME so it cannot be shadowed by what it builds: `gizmo.js`
 * calls the seven things it takes a press on `piece`, one of them being the
 * parameter of its own `onDown`.
 */
export function addPiece(parent, css) {
  const el = document.createElement("div");
  el.style.cssText = `position:absolute;${css}`;
  parent.appendChild(el);
}

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
 * exactly that), and the arrows are a legibility requirement over two canvases
 * rather than a palette the designer owns. The overlay, whose pins ARE the
 * designer's, sets its own on the root it is handed.
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
