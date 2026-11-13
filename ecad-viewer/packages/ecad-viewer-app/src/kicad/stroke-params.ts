/*
    Dashed and dotted strokes, cut into marks as KiCad's
    STROKE_PARAMS::Stroke cuts them (common/stroke_params.cpp).
*/

import type { Vec2 } from "../base/math";

/**
 * The lengths of a line style's marks and gaps, alternating and starting with
 * a mark, for a line `width` wide; null for a solid line. The lengths are
 * RENDER_SETTINGS::GetDashLength, GetDotLength and GetGapLength with their
 * ISO 128-2 correction of 1, from the schematic's dash and gap ratios.
 */
export function dash_pattern(
    style: string,
    width: number,
    dash_ratio = 12,
    gap_ratio = 3,
): number[] | null {
    const dash = Math.max(dash_ratio - 1, 1) * width;
    const gap = Math.max(gap_ratio + 1, 1) * width;
    const dot = 0.2 * width;
    switch (style) {
        case "dash":
            return [dash, gap];
        case "dot":
            return [dot, gap];
        case "dash_dot":
            return [dash, gap, dot, gap];
        case "dash_dot_dot":
            return [dash, gap, dot, gap, dot, gap];
        default:
            return null;
    }
}

/**
 * The marks of `pattern` along the polyline `points`, each a polyline of its
 * own. The pattern carries across the vertices, as for KiCad's line chain; a
 * single segment is KiCad's SHAPE_SEGMENT, cut the same way.
 */
export function dash_polyline(points: Vec2[], pattern: number[]): Vec2[][] {
    const marks: Vec2[][] = [];
    if (pattern.reduce((sum, length) => sum + length, 0) <= 0) {
        return marks;
    }

    let element = 0;
    let remaining = pattern[0]!;
    let mark: Vec2[] | null = null;

    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const segment = points[i]!.sub(a);
        const length = segment.magnitude;
        if (length == 0) {
            continue;
        }
        const step = segment.multiply(1 / length);
        let walked = 0;
        let start = a;

        while (walked < length) {
            const part = Math.min(remaining, length - walked);
            const next = start.add(step.multiply(part));

            if (element % 2 == 0) {
                mark ??= [start];
                mark.push(next);
            }

            walked += part;
            remaining -= part;
            start = next;

            if (remaining <= 0) {
                if (mark) {
                    marks.push(mark);
                    mark = null;
                }
                element++;
                remaining = pattern[element % pattern.length]!;
            }
        }
    }

    if (mark) {
        marks.push(mark);
    }
    return marks;
}

/**
 * The marks of `pattern` along an arc of `radius` from the angle `start` to
 * `end` (radians, either way round), as [from, to] angle pairs.
 */
export function dash_arc(
    radius: number,
    start: number,
    end: number,
    pattern: number[],
): [number, number][] {
    const marks: [number, number][] = [];
    const sweep = Math.abs(end - start);
    const direction = Math.sign(end - start);
    if (radius <= 0 || sweep == 0) {
        return marks;
    }

    let walked = 0;
    // KiCad's own bound on the marks of one arc.
    for (let i = 0; i < 10000 && walked < sweep; i++) {
        const next = Math.min(
            walked + pattern[i % pattern.length]! / radius,
            sweep,
        );
        if (i % 2 == 0) {
            marks.push([
                start + direction * walked,
                start + direction * next,
            ]);
        }
        walked = next;
    }
    return marks;
}
