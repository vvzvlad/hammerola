/*
    How the schematic plane's marks look: chains, the labels they join,
    sheet titles, and the hover and selection boxes. Everything here draws
    in screen space (CSS pixels) into a 2D context.
*/

import type { BBox, Vec2 } from "../../base/math";

/** The first chain's colour, then each added chain's in turn. */
export const CHAIN_COLORS = [
    "#ffb020",
    "#22d3ee",
    "#c084fc",
    "#34d399",
    "#f472b6",
    "#fb923c",
];

/** The line is as wide as a trace this many mm across, never under 2.5 px. */
const LINE_MM = 0.8;
const MIN_LINE_PX = 2.5;

/** The line's width at a camera zoom (px per mm). */
export const line_width = (zoom: number) =>
    Math.max(MIN_LINE_PX, LINE_MM * zoom);

/** Prism's theme, from the CSS variables it sets on the viewer. */
export interface Tokens {
    card: string;
    border: string;
    muted: string;
    font: string;
}

export function read_tokens(el: HTMLElement): Tokens {
    const style = getComputedStyle(el);
    const read = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
    return {
        card: read("--inset-bg", "#ffffff"),
        border: read("--inset-border", "#e2e8f0"),
        muted: read("--inset-muted", "#64748b"),
        font: read("--inset-font", "system-ui, sans-serif"),
    };
}

/**
 * One connection, whole and still: a straight, solid, trace-wide line from
 * `a` to `b` over a soft glow.
 */
export function paint_connection(
    ctx: CanvasRenderingContext2D,
    a: Vec2,
    b: Vec2,
    color: string,
    zoom: number,
) {
    const width = line_width(zoom);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = width + 6;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
}

/** A label a chain starts from (`start`) or reaches: a dot in a ring. */
export function paint_endpoint(
    ctx: CanvasRenderingContext2D,
    at: Vec2,
    color: string,
    start: boolean,
) {
    const radius = start ? 8 : 6;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = start ? 2.5 : 2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(at.x, at.y, start ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

/** A sheet title's height, and the gap under it to its sheet (CSS px). */
export const TITLE_HEIGHT = 18;
export const TITLE_GAP = 6;
/** How far above its sheet a title reaches on screen. */
export const TITLE_SPACE = TITLE_HEIGHT + TITLE_GAP;

/** A sheet's name above its frame, in Prism's badge style. */
export function paint_title(
    ctx: CanvasRenderingContext2D,
    tokens: Tokens,
    text: string,
    at: Vec2,
) {
    ctx.font = `500 11px ${tokens.font}`;
    const w = ctx.measureText(text).width + 12;
    const h = TITLE_HEIGHT;
    ctx.fillStyle = tokens.card;
    ctx.strokeStyle = tokens.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(at.x, at.y - h, w, h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tokens.muted;
    ctx.textAlign = "start";
    ctx.textBaseline = "middle";
    ctx.fillText(text, at.x + 6, at.y - h / 2 + 0.5);
}

/** The same hover and selection marks the sheet view draws. */
export function paint_hover(ctx: CanvasRenderingContext2D, box: BBox) {
    ctx.strokeStyle = "rgb(0, 255, 255)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
}

export function paint_selection(ctx: CanvasRenderingContext2D, box: BBox) {
    ctx.fillStyle = "rgba(26, 51, 255, 0.18)";
    ctx.fillRect(box.x, box.y, box.w, box.h);
}
