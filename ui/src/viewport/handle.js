// The grip on the section plane: a double-headed arrow drawn over the canvas at
// the point where the plane meets the face that was clicked, and dragged to
// slide the plane along its own normal.
//
// WHY IT EXISTS. The drag has worked from the start — tools.js, the `cut` branch
// of `onMove` — and nothing on screen ever said so, so the only readers who
// found it were the ones who had been told. A gesture with no handle is a
// gesture that is not there for most people.
//
// A DOM OVERLAY AND NOT AN OBJECT IN THE SCENE, for two reasons that are both
// about the library rather than about taste. `viewer.clear()` deep-disposes
// everything in the scene, so a gizmo living in it would have to be rebuilt
// after every render, on a path that already has enough to get right; and its
// hit testing would have to be written by hand against the picker, where the
// browser does it here for nothing and throws in a cursor with it.
//
// A MODULE OF ITS OWN AND NOT PART OF overlay.js, though the rAF loop is the
// same shape and is deliberately written the same way. Two things differ and
// both are load-bearing: what this draws comes from the SECTION rather than
// from `state.pins`, and it carries a live drag, which the overlay's pins — a
// press, a click, nothing in between — do not.
//
// DRAWN OUT OF DIVS rather than out of an SVG, which is the one place this
// departs from the view cube. The reason is a TEST and not the page's policy:
// `tests/test_ui_source.py` scans the interface for absolute URLs, waves the SVG
// namespace through as an identifier that merely looks like one — nothing ever
// dereferences it, so the CSP has nothing to say about it either way — and then
// pins that exemption to the single `const SVG_NS` in viewcube.js. A shaft and
// two CSS border triangles need no namespace, and the shape is three
// rectangles' worth of styling whichever way it is built.

import { internals } from "./internals.js";
import { projectPoint } from "./camera.js";
import { dragSection, sectionGripAxis, sectionOffset } from "./section.js";
import { reportCut } from "./tools.js";
import {
  HANDLE_HEAD_PX, HANDLE_HIT_PX, HANDLE_PX, HANDLE_SHAFT_PX,
} from "./options.js";

/** The arrow's ink.
 *
 * ONE COLOUR FOR BOTH THEMES, and the halo below is what makes that honest —
 * the same trade the view cube makes and for the same reason: the canvas under
 * this widget is white or near-black depending on the reader's answer
 * (`readTheme` in ui/src/store.js), so the handle has to bring its own contrast
 * rather than borrow the page's. Dark ink reads on the light canvas directly and
 * on the dark one against the white halo, which is a single filter over the
 * whole shape and therefore follows the triangles as well as the shaft.
 */
const INK = "#2f353d";
const HALO = "drop-shadow(0 0 1px #fff) drop-shadow(0 1px 2px rgba(20,24,28,.45))";

export function createHandle(vp) {
  const root = document.createElement("div");
  // `pointer-events: none` on the layer and back on for the arrow, exactly as
  // the overlay and the view cube do it: the layer covers the whole canvas, so
  // without this it would swallow every press meant for the model — rotation
  // included.
  //
  // NO CLASS NAME, for the view cube's reason: a class is a promise the
  // interface's stylesheet keeps a rule for it (tests/test_ui_source.py checks
  // exactly that), and everything about how this looks is a legibility
  // requirement over two canvases rather than a palette the designer owns.
  root.style.cssText =
    "position:absolute;inset:0;overflow:hidden;pointer-events:none";

  // THE BOX IS THE TARGET AND THE INK INSIDE IT IS THINNER, which is the whole
  // of the "fat enough to hit" requirement: the arrow is `HANDLE_HIT_PX` tall
  // and takes presses over all of it, while what is drawn is a shaft of
  // `HANDLE_SHAFT_PX`.
  const arrow = document.createElement("div");
  arrow.style.cssText = "position:absolute;left:0;top:0;display:none;"
    + `width:${HANDLE_PX}px;height:${HANDLE_HIT_PX}px;`
    + `pointer-events:auto;cursor:grab;filter:${HALO}`;
  root.appendChild(arrow);

  /** One absolutely-positioned piece of the arrow. */
  const piece = (css) => {
    const el = document.createElement("div");
    el.style.cssText = `position:absolute;${css}`;
    arrow.appendChild(el);
  };

  // The shaft, between the two heads.
  piece(`left:${HANDLE_HEAD_PX}px;right:${HANDLE_HEAD_PX}px;top:50%;`
    + `height:${HANDLE_SHAFT_PX}px;margin-top:${-HANDLE_SHAFT_PX / 2}px;`
    + `background:${INK}`);
  // The two heads, as CSS border triangles: a box of zero size whose remaining
  // border is a wedge. As long as it is wide, so the arrow reads the same at
  // every angle the model can be turned to.
  //
  // THE BORDER AND THE EDGE ARE OPPOSITE SIDES, which is why they are two names:
  // the border that is left standing is the one AWAY from the point, so a wedge
  // made of `border-right` points LEFT and belongs at the left edge.
  for (const border of ["right", "left"]) {
    const edge = border === "right" ? "left" : "right";
    piece(`${edge}:0;top:50%;`
      + `margin-top:${-HANDLE_HEAD_PX / 2}px;width:0;height:0;`
      + `border-top:${HANDLE_HEAD_PX / 2}px solid transparent;`
      + `border-bottom:${HANDLE_HEAD_PX / 2}px solid transparent;`
      + `border-${border}:${HANDLE_HEAD_PX}px solid ${INK}`);
  }

  let frame = 0;
  // The gesture in progress: the screen axis measured at its start, and where
  // the pointer was at the previous event. Null between gestures.
  let drag = null;

  /**
   * Where the plane meets the face the reader clicked, in world coordinates.
   *
   * WITHOUT THE RENDER SLIVER — see `sectionBias` in section.js, which is the
   * one function that adds it and says why every reader takes it back out. This
   * is a reading of where the plane stands, so it is in the same frame as
   * `state.cutOffset` and `captureSection`, not in the library's.
   *
   * READ OFF THE PLANE EVERY FRAME, NOT OUT OF `state.cutOffset`, and the
   * difference is the whole of whether this is a handle at all. The two agree
   * everywhere except during a drag of this very arrow: `state.cutOffset` is
   * written once, by `reportCut` at the RELEASE, so an anchor taken from it
   * would sit still while the plane slid out from under the hand and then jump
   * to catch up when the hand came off. `sectionOffset` measures the plane
   * itself, so the arrow stays under the cursor — which is the one thing direct
   * manipulation has to get right.
   */
  const anchor = () => {
    const seed = vp.sectionSeed;
    const offset = sectionOffset(vp);
    return [seed.point[0] + seed.normal[0] * offset,
            seed.point[1] + seed.normal[1] * offset,
            seed.point[2] + seed.normal[2] * offset];
  };

  /** Whether there is a cut to put a handle on at all.
   *
   * THE OTHER WAY THE HANDLE HIDES IS NOT IN HERE, on purpose: an anchor behind
   * the camera is an answer about THIS FRAME, and it comes back the moment the
   * model is turned. Stopping the loop on it would mean the handle never
   * returned, since nothing outside calls `refresh` when the camera moves.
   */
  const wanted = () => !!(vp.sectionSeed && vp.state.cut);

  const hide = () => { arrow.style.display = "none"; };

  /** Put the arrow where the plane is, or take it off the screen. */
  const place = () => {
    if (!wanted()) {
      hide();
      return;
    }
    const g = internals(vp.viewer);
    if (!g) {
      hide();
      return;
    }
    const at = anchor();
    // `sectionGripAxis` AND NOT `sectionAxis`, which is the whole of why the
    // arrow no longer goes away under the reader. `sectionAxis` declines in the
    // degenerate zone — the plane's normal pointing nearly AT or AWAY FROM the
    // camera, i.e. the reader turned to look straight at the cut face — where
    // the projected normal is a stub; the grip takes that function's vertical
    // fallback there instead. Crossing the boundary SNAPS the arrow from its
    // projected angle to vertical, once, and that is the whole of the trade:
    // one snap at the boundary in place of an arrow that simply disappeared
    // past it.
    //
    // Null is left, and it is no longer about the view at all: it means the
    // scene cannot be measured — no clip plane, no eye, a canvas of no size —
    // which is the `internals` case above arriving one function later.
    const axis = sectionGripAxis(vp.viewer, g, at);
    if (!axis) {
      hide();
      return;
    }
    const ndc = projectPoint(g, at);
    // z > 1 is behind the camera's far plane, i.e. behind the reader — under an
    // ortho projection a real case rather than a curiosity, exactly as the
    // overlay's `place` says.
    if (!ndc || ndc[2] > 1) {
      hide();
      return;
    }
    const rect = g.canvas.getBoundingClientRect();
    const box = vp.box.getBoundingClientRect();
    arrow.style.display = "";
    arrow.style.left =
      `${(ndc[0] * 0.5 + 0.5) * rect.width + (rect.left - box.left)}px`;
    arrow.style.top =
      `${(-ndc[1] * 0.5 + 0.5) * rect.height + (rect.top - box.top)}px`;
    // `sectionGripAxis` answers in canvas pixels per world unit along the clip
    // normal, with `sy` counted DOWNWARDS — which is the direction CSS rotates
    // in as well, so the angle of that vector is the angle of the arrow with
    // nothing to flip. In the degenerate zone that vector is `{sx: 0, sy: +px}`,
    // i.e. 90 degrees: a stable vertical arrow, dragged down to push the plane
    // along its own normal. The arrow is centred on the anchor because the plane
    // moves BOTH ways from there.
    arrow.style.transform = "translate(-50%,-50%) "
      + `rotate(${(Math.atan2(axis.sy, axis.sx) * 180) / Math.PI}deg)`;
  };

  const draw = () => {
    frame = 0;
    place();
    schedule();
  };

  /**
   * One rAF loop, and only while a cut stands.
   *
   * The library owns the render loop and offers no post-render hook, so the
   * alternative would be re-projecting from the trackball's `change` event —
   * which fires on camera moves and NOT on the frames a live swap or a
   * visibility change redraws. A loop that stops on its own costs nothing on
   * the ordinary page, which has no cut.
   *
   * THE INVARIANT THAT MAKES `refresh` ENOUGH: while the arrow is on screen a
   * frame is always pending, because the only thing that shows it is `place`,
   * which runs from `draw`, which re-arms. So a cut going away needs no
   * synchronous hide here — the frame already queued runs `place`, `wanted` is
   * false by then, and the same call takes the arrow off and lets the loop stop.
   */
  const schedule = () => {
    if (frame) return;
    if (!wanted()) return;
    frame = requestAnimationFrame(draw);
  };

  /** Let go of the gesture, wherever it ended.
   *
   * The listeners are on the WINDOW and in the capture phase for the reason
   * tools.js's `watch` gives: a drag that starts on the arrow can perfectly well
   * end anywhere, and a release missed here strands the gesture forever.
   */
  const finish = () => {
    drag = null;
    arrow.style.cursor = "grab";
    removeEventListener("pointermove", onMove, true);
    removeEventListener("pointerup", onUp, true);
    removeEventListener("pointercancel", onCancel, true);
  };

  function onMove(event) {
    if (!drag) return;
    const g = internals(vp.viewer);
    if (!g) return;
    // Since the PREVIOUS event, exactly as `onMove` in tools.js counts it: the
    // plane moves by what the hand did between two frames, not by where the
    // gesture started.
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = true;
    dragSection(vp, g, drag.axis, dx, dy);
  }

  function onUp() {
    const held = drag;
    finish();
    // ONLY IF IT ACTUALLY MOVED, which is the same rule the canvas drag applies
    // (`tools.js`, `if (p.moved)`) and it is not tidiness. `reportCut` emits
    // `hmr:face`, and the interface answers that by disarming whatever tool is
    // up (`tool: null`, HammerolaViewer.jsx) — so a bare click on the arrow, or
    // a press that missed the model and landed in this 56x18 box, would silently
    // put down the measure or comment tool the reader was holding.
    //
    // Once, at the end: the drag moves the library's slider sixty times a second
    // and the interface would re-render with it. Through the same function the
    // canvas drag ends in, so `state.cutOffset` and the number the interface
    // prints keep their one writer.
    if (held && held.moved) reportCut(vp);
  }

  function onCancel() {
    finish();
  }

  const onDown = (event) => {
    // THE PRIMARY BUTTON AND NOTHING ELSE, and it is worth being exact about
    // what that buys. A press on the arrow never reaches `vp.box` or the canvas
    // in the first place — this layer is a SIBLING of the box — so neither the
    // part menu nor the library's pan is reachable over these 56x18 px whatever
    // this line does. What the filter buys is that a right-drag the reader
    // meant as a pan, and a middle click, no longer move the plane. The native
    // context menu still comes up over the grip, exactly as it does over the
    // view cube: that is the price of any sibling layer, not a regression here.
    if (event.button !== 0) return;
    // A previous gesture is concluded before a new one begins, as `onDown` in
    // tools.js does it: a second pointer landing on the same arrow would
    // otherwise overwrite the anchor with its own position, and the first
    // finger's next move would read as a jump the width of the gap between them.
    finish();
    // `stopPropagation` is belt and braces and nothing more, because this layer
    // is a sibling of `vp.box`: no listener on that element — tools, orbit,
    // pinch, the idle clock — is on this event's path at all, which is the same
    // reading `viewcube.js` writes out for its own root. It stays for the day
    // the layer moves inside the box. `preventDefault` is the half that matters
    // on its own: it suppresses the compatibility mouse events, so this press
    // cannot turn into a double-click somewhere else.
    event.stopPropagation();
    event.preventDefault();
    if (!wanted()) return;
    const g = internals(vp.viewer);
    if (!g) return;
    // MEASURED ONCE AND HELD FOR THE WHOLE GESTURE, exactly as tools.js does it:
    // the camera cannot move under a press this one owns, and re-measuring per
    // frame would let the plane drift away from the hand.
    //
    // THROUGH THE SAME FUNCTION `place` DRAWS FROM, so the arrow that is on
    // screen is the arrow that drags: measured with `sectionAxis` instead, a
    // press in the degenerate zone would land on a visible grip and then do
    // nothing at all.
    const axis = sectionGripAxis(vp.viewer, g, anchor());
    if (!axis) return;
    drag = { axis, x: event.clientX, y: event.clientY, moved: false };
    arrow.style.cursor = "grabbing";
    addEventListener("pointermove", onMove, true);
    addEventListener("pointerup", onUp, true);
    addEventListener("pointercancel", onCancel, true);
  };

  arrow.addEventListener("pointerdown", onDown);

  /** End a drag the reader has not let go of, because the scene is going away.
   *
   * THE TWIN OF `vp.endGesture`, and it exists for the same failure that one was
   * written for: everything a live press holds — here the plane's screen axis —
   * was measured against a scene that is being replaced, and the release that
   * would have concluded the gesture never comes.
   *
   * IT CONCLUDES RATHER THAN ABANDONS. A swap can arrive mid-drag: the interface
   * waits for the hand to come off the model but gives up after a deadline, and
   * that wait does not see this press at all — the idle clock listens on
   * `vp.box`, and this layer is a sibling of it. So without this, `restoreSection`
   * would subtract a `state.cutOffset` from before the drag out of a point the
   * drag had already moved, and the seed would come back off the face that was
   * clicked, with the interface printing a depth the plane has not been at since.
   */
  const endDrag = () => {
    const held = drag;
    finish();
    if (held && held.moved) reportCut(vp);
  };

  return {
    root,
    refresh: schedule,
    endDrag,
    destroy() {
      // `if (frame)` is safe because a browser rAF handle is non-zero by spec
      // (HTML §8.10), the same reading the view cube's teardown leans on.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // A viewport unmounted mid-drag would otherwise leave three capture-phase
      // listeners on the window holding a scene that is gone.
      finish();
      root.remove();
    },
  };
}
