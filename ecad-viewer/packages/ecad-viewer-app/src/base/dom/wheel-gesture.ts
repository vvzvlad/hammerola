/**
 * Zoom per pixel of a pinch, or of Control and the wheel: a zoom of `by`
 * pixels multiplies the zoom by exp(-by · WHEEL_ZOOM_RATE).
 */
export const WHEEL_ZOOM_RATE = 0.01;

/**
 * What a wheel event asks of a flat drawing, as a touchpad means it: with
 * Control held, which is how a pinch arrives, a zoom about the pointer by
 * `by` pixels, clamped to 40; else, a two-finger swipe, a pan by the wheel's
 * own deltas (`dx`, `dy`), which moves the camera that way so that the
 * drawing follows the fingers. The clamp, the rate and the 16 px of a line
 * are the hub's Gerber view's (`wheelMove` in ui/src/gerber.js), which has no
 * page step; a page is the fork's 24 px. The board, the schematic
 * (`MoveAndZoom`) and their insets all take them from here.
 */
export function wheel_gesture(
    e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">,
): { kind: "zoom"; by: number } | { kind: "pan"; dx: number; dy: number } {
    const step =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? 24
              : 1;
    if (e.ctrlKey)
        return {
            kind: "zoom",
            by: Math.max(-40, Math.min(40, e.deltaY * step)),
        };
    return { kind: "pan", dx: e.deltaX * step, dy: e.deltaY * step };
}
