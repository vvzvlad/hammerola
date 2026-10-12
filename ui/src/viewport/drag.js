// The two things every drag in this viewport does the same way: follow the
// pointer to wherever it is released, and decide whether it travelled far
// enough to be a drag at all.
//
// Four gestures share the first — the canvas press (tools.js), the section grip
// (handle.js), the axis arrows and quads (gizmo.js) and the rotation handles
// (rings.js) — and three share the second. Each caller keeps its own `finish`,
// report and button filter, because a release means something different in
// each.

import { CLICK_PX } from "./options.js";

/**
 * The window listeners a live press is followed with: `{arm, disarm}`.
 *
 * On the window, in the capture phase: the trackball captures the pointer, and
 * a drag can end anywhere; a missed release strands the gesture.
 *
 * A handler not passed is not listened for: `rings.js` keeps its own window
 * `pointermove` for the widget's whole life (it tracks hover without a drag),
 * so it arms only the release and the cancel.
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
 * A click is not a one-pixel drag: a two-pixel shift is still a pick and a
 * menu on the canvas. On the manipulator, where there is no click, a twitch
 * would otherwise snap the part a step and file a node nobody asked for.
 *
 * Written as `!(|dx| < CLICK_PX && |dy| < CLICK_PX)` rather than
 * `|dx| >= CLICK_PX || ...`, so a NaN coordinate counts as travelled.
 */
export function travelled(event, drag) {
  if (drag.moved) return true;
  return !(Math.abs(event.clientX - drag.startX) < CLICK_PX
           && Math.abs(event.clientY - drag.startY) < CLICK_PX);
}
