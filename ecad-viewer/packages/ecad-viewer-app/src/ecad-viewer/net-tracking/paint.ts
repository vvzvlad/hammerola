/*
    How the world view's marks look: connections, their names, arrowheads,
    the labels they join, sheet titles, and the hover and selection boxes.
    Everything here draws in screen space (CSS pixels) into a 2D context.
*/

import type { BBox, Vec2 } from "../../base/math";
import { flow_starts, overbar_text, type Curve } from "./geometry";

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
/** Zoomed out, the line is plain dashes this long with these gaps (px). */
const DASH = 10;
const SPACE = 6;
/** The name is this fraction of the line's width, like a net name on a trace. */
const NAME_SCALE = 0.72;
/** Below this many pixels the name is not drawn: the dashes are plain. */
const MIN_NAME_PX = 5;
const NAME_FAMILY = "ui-monospace, SFMono-Regular, Menlo, monospace";
const NAME_INK = "rgba(255, 255, 255, 0.88)";

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
 * One connection, whole and still: a soft glow under a trace-wide line in
 * dashes from its start. Zoomed in far enough, each dash is as long as the
 * net's name and the name is written on it, the way a net name sits on a
 * board trace.
 */
export function paint_connection(
    ctx: CanvasRenderingContext2D,
    curve: Curve,
    options: {
        color: string;
        name: string;
        zoom: number;
    },
) {
    const { color, name, zoom } = options;
    const width = line_width(zoom);
    const font_px = width * NAME_SCALE;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = width + 6;
    ctx.beginPath();
    curve.trace(ctx, 0, curve.length);
    ctx.stroke();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = width;
    const label = overbar_text(name);
    const named = font_px >= MIN_NAME_PX;
    ctx.font = `600 ${font_px}px ${NAME_FAMILY}`;
    const text = named ? ctx.measureText(label.text).width : 0;
    const dash = named ? text : DASH;
    const space = named ? Math.max(SPACE, width * 1.6) : SPACE;
    const starts = flow_starts(curve.length, dash + space, 0);
    const dashes = new Path2D();
    for (const s of starts) curve.trace(dashes, s, s + dash);
    ctx.stroke(dashes);
    if (named) paint_names(ctx, curve, starts, dash, label, font_px);
    ctx.restore();
}

/** The name on every whole dash, upright whichever way the line runs. */
function paint_names(
    ctx: CanvasRenderingContext2D,
    curve: Curve,
    starts: readonly number[],
    dash: number,
    label: ReturnType<typeof overbar_text>,
    font_px: number,
) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = NAME_INK;
    ctx.strokeStyle = NAME_INK;
    ctx.lineWidth = Math.max(0.6, font_px / 12);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const left = -dash / 2;
    for (const s of starts) {
        if (s < 0 || s + dash > curve.length) continue;
        const { point, angle } = curve.at(s + dash / 2);
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(Math.cos(angle) < 0 ? angle + Math.PI : angle);
        ctx.fillText(label.text, left, font_px * 0.06);
        // KiCad's ~{…}: a line over the inverted part.
        for (const [from, to] of label.over) {
            const x0 = left + ctx.measureText(label.text.slice(0, from)).width;
            const x1 = left + ctx.measureText(label.text.slice(0, to)).width;
            ctx.beginPath();
            ctx.moveTo(x0, -font_px * 0.5);
            ctx.lineTo(x1, -font_px * 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }
}

export function paint_arrowhead(
    ctx: CanvasRenderingContext2D,
    tip: Vec2,
    angle: number,
    color: string,
    zoom: number,
) {
    const size = Math.max(10, line_width(zoom) * 2.4);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
        tip.x - size * Math.cos(angle - 0.45),
        tip.y - size * Math.sin(angle - 0.45),
    );
    ctx.lineTo(
        tip.x - size * Math.cos(angle + 0.45),
        tip.y - size * Math.sin(angle + 0.45),
    );
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
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

/** A sheet's name above its frame, in Prism's badge style. */
export function paint_title(
    ctx: CanvasRenderingContext2D,
    tokens: Tokens,
    text: string,
    at: Vec2,
) {
    ctx.font = `500 11px ${tokens.font}`;
    const w = ctx.measureText(text).width + 12;
    const h = 18;
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
