/*
    What an inset frames when it opens.

    A small part is framed whole, with its neighbourhood (fit_camera spans
    twice the box). A part far larger than the pin or pad that opened it --
    a BGA, an FPGA symbol -- would open with that pin a speck, so the inset
    frames a window around the pin instead.
*/

import { BBox } from "../../base/math";

/**
 * `part` when it is at most `limit` across, else a `window`-sized box
 * centred on `anchor` (kept inside the part).
 */
export function local_focus(
    part: BBox,
    anchor: BBox | undefined,
    limit: number,
    window: number,
): BBox {
    if (!anchor || Math.max(part.w, part.h) <= limit) return part;
    const cx = anchor.x + anchor.w / 2;
    const cy = anchor.y + anchor.h / 2;
    const w = Math.min(window, part.w);
    const h = Math.min(window, part.h);
    const x = Math.min(Math.max(cx - w / 2, part.x), part.x + part.w - w);
    const y = Math.min(Math.max(cy - h / 2, part.y), part.y + part.h - h);
    return new BBox(x, y, w, h);
}

/** Board parts larger than this (mm) open on their pad's neighbourhood. */
export const BOARD_FOCUS_LIMIT = 15;
export const BOARD_FOCUS_WINDOW = 8;
/** Schematic symbols larger than this (mm) open on their pin's neighbourhood. */
export const SCHEMATIC_FOCUS_LIMIT = 60;
export const SCHEMATIC_FOCUS_WINDOW = 30;
