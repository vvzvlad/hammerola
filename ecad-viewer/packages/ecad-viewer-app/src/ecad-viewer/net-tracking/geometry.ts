/*
    The world view's geometry: where sheets go, the curves between them, where
    the dashes fall along a curve, and how the camera eases between views.
    Screen-independent maths only; drawing is in paint.ts.
*/

import { BBox, Vec2 } from "../../base/math";

/** Space between sheets, in world units (mm). */
export const SHEET_GAP = 50;

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
export const ease_out = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
export const ease_in_out = (t: number) => {
    const x = clamp01(t);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/**
 * Rows of `cols` sheets, left to right. With `cols` fixed, adding sheets at
 * the end never moves the ones before them.
 */
export function world_layout(
    bounds: readonly BBox[],
    gap = SHEET_GAP,
    cols = Math.max(1, Math.ceil(Math.sqrt(bounds.length))),
): Vec2[] {
    const offsets: Vec2[] = [];
    let y = 0;
    for (let row = 0; row * cols < bounds.length; row++) {
        const slice = bounds.slice(row * cols, row * cols + cols);
        let x = 0;
        for (const box of slice) {
            offsets.push(new Vec2(x, y));
            x += box.w + gap;
        }
        y += Math.max(...slice.map((box) => box.h)) + gap;
    }
    return offsets;
}

/** Where a pattern of `period` repeats along a run of `length`, shifted by `offset`. */
export function flow_starts(length: number, period: number, offset: number) {
    const starts: number[] = [];
    if (period <= 0) return starts;
    for (let s = (offset % period) - period; s < length; s += period)
        starts.push(s);
    return starts;
}

/** A cubic Bézier sampled by arc length. */
export class Curve {
    readonly points: Vec2[] = [];
    readonly lengths: number[] = [0];

    constructor(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, samples = 64) {
        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const u = 1 - t;
            this.points.push(
                new Vec2(
                    u * u * u * a.x +
                        3 * u * u * t * c1.x +
                        3 * u * t * t * c2.x +
                        t * t * t * b.x,
                    u * u * u * a.y +
                        3 * u * u * t * c1.y +
                        3 * u * t * t * c2.y +
                        t * t * t * b.y,
                ),
            );
            if (i)
                this.lengths.push(
                    this.lengths[i - 1]! +
                        this.points[i]!.sub(this.points[i - 1]!).magnitude,
                );
        }
    }

    get length() {
        return this.lengths.at(-1)!;
    }

    #index(s: number) {
        let i = 1;
        while (i < this.lengths.length - 1 && this.lengths[i]! < s) i++;
        return i;
    }

    /** The point at arc length `s` and the curve's direction there. */
    at(s: number): { point: Vec2; angle: number } {
        const clamped = Math.min(Math.max(s, 0), this.length);
        const i = this.#index(clamped);
        const a = this.points[i - 1]!;
        const b = this.points[i]!;
        const span = this.lengths[i]! - this.lengths[i - 1]!;
        const t = span ? (clamped - this.lengths[i - 1]!) / span : 0;
        return {
            point: new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
            angle: Math.atan2(b.y - a.y, b.x - a.x),
        };
    }

    /** Trace the part between arc lengths `from` and `to` into a path. */
    trace(
        path: Pick<CanvasRenderingContext2D, "moveTo" | "lineTo">,
        from: number,
        to: number,
    ) {
        const s0 = Math.max(0, from);
        const s1 = Math.min(this.length, to);
        if (s1 <= s0) return;
        const start = this.at(s0).point;
        path.moveTo(start.x, start.y);
        for (let i = 1; i < this.points.length; i++) {
            const s = this.lengths[i]!;
            if (s <= s0) continue;
            if (s >= s1) break;
            path.lineTo(this.points[i]!.x, this.points[i]!.y);
        }
        const end = this.at(s1).point;
        path.lineTo(end.x, end.y);
    }
}

/** A connection's curve: out of `a` sideways, into `b` from the side. */
export function connection_curve(a: Vec2, b: Vec2) {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const bend = Math.max(60, span * 0.3);
    const dir = b.x >= a.x ? 1 : -1;
    return new Curve(
        a,
        new Vec2(a.x + dir * bend, a.y),
        new Vec2(b.x - dir * bend, b.y),
        b,
    );
}

/**
 * A net name as drawn: KiCad's `~{…}` overbar markup removed, with the
 * character ranges the bar spans.
 */
export function overbar_text(name: string): {
    text: string;
    over: Array<[number, number]>;
} {
    let text = "";
    const over: Array<[number, number]> = [];
    const pattern = /~\{([^}]*)\}/g;
    let last = 0;
    for (const match of name.matchAll(pattern)) {
        text += name.slice(last, match.index);
        const start = text.length;
        text += match[1];
        over.push([start, text.length]);
        last = match.index! + match[0].length;
    }
    text += name.slice(last);
    return { text, over };
}

/** A camera position: the world point at the centre and the zoom. */
export interface CameraPose {
    center: Vec2;
    zoom: number;
}

/**
 * The pose `t` of the way from `a` to `b`. Zoom is interpolated on a log
 * scale so zooming out and in feel equally paced.
 */
export function blend_pose(
    a: CameraPose,
    b: CameraPose,
    t: number,
): CameraPose {
    const k = ease_in_out(t);
    return {
        center: new Vec2(
            a.center.x + (b.center.x - a.center.x) * k,
            a.center.y + (b.center.y - a.center.y) * k,
        ),
        zoom: Math.exp(
            Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * k,
        ),
    };
}
