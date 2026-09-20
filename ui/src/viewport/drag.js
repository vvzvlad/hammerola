// The two things every drag in this viewport does the same way: follow the
// pointer to wherever it is released, and decide whether it travelled far
// enough to be a drag at all.
//
// FOUR GESTURES SHARE THE FIRST — the canvas press (tools.js), the section grip
// (handle.js), the axis arrows and quads (gizmo.js) and the rotation handles
// (rings.js) — and three share the second. What is NOT here is any of the four
// endings: each caller keeps its own `finish`, its own report and its own
// button filter, because what a release MEANS differs in every one of them.

import { CLICK_PX } from "./options.js";

/**
 * The window listeners a live press is followed with: `{arm, disarm}`.
 *
 * ON THE WINDOW AND IN THE CAPTURE PHASE. The trackball captures the pointer,
 * and a drag that starts on the canvas — or on a widget that is a sibling of it
 * — can perfectly well end anywhere; a release missed here strands the gesture
 * forever.
 *
 * A HANDLER THAT IS NOT PASSED IS NOT LISTENED FOR, which is one caller's real
 * case rather than a convenience: `rings.js` keeps its `pointermove` on the
 * window for the whole life of the widget, because that handler answers where
 * the cursor is standing when there is no drag at all, so its press arms the
 * release and the cancel alone.
 */
export function watchDrag({ onMove, onUp, onCancel }) {
  return {
    arm() {
      if (onMove) addEventListener("pointermove", onMove, true);
      if (onUp) addEventListener("pointerup", onUp, true);
      if (onCancel) addEventListener("pointercancel", onCancel, true);
    },
    disarm() {
      if (onMove) removeEventListener("pointermove", onMove, true);
      if (onUp) removeEventListener("pointerup", onUp, true);
      if (onCancel) removeEventListener("pointercancel", onCancel, true);
    },
  };
}

/**
 * Whether this press has stopped being a click: `CLICK_PX` of travel from where
 * it landed, or a `moved` flag already set by an earlier event.
 *
 * A CLICK IS NOT A ONE-PIXEL DRAG. A hand that shifts two pixels between the
 * press and the release has said nothing, and on the canvas that press is still
 * a pick and still a menu. It matters MORE on the manipulator, where there is
 * no click at all: nothing selects, and the only thing a twitch can do is snap
 * the part one step or turn it a degree and file a node the reader never asked
 * for, which opens the panel on top of it.
 *
 * THE COMPARISON IS THE ONE THAT WAS WRITTEN OUT THREE TIMES, negated rather
 * than rewritten: `!(|dx| < CLICK_PX && |dy| < CLICK_PX)` and not
 * `|dx| >= CLICK_PX || ...`, so a coordinate that is not a number answers the
 * way it always did — every comparison against NaN is false, which used to mean
 * the press fell through to `moved` and still does.
 */
export function travelled(event, drag) {
  if (drag.moved) return true;
  return !(Math.abs(event.clientX - drag.startX) < CLICK_PX
           && Math.abs(event.clientY - drag.startY) < CLICK_PX);
}
