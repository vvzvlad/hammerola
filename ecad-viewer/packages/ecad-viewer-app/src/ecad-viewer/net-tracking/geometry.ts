/*
    The schematic plane's geometry: where sheets go and which places of a
    net a line joins. Screen-independent maths only; drawing is in paint.ts.
*/

import { BBox, Vec2 } from "../../base/math";

/** Space between sheets, in world units (mm). */
export const SHEET_GAP = 50;

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

/**
 * The shortest set of segments that joins every point (a minimum spanning
 * tree, by Prim's algorithm), as pairs of indices into `points`: each place
 * of a net is joined to a near one, not every place to the label traced.
 */
export function spanning_pairs(points: readonly Vec2[]): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    const near = points.map(() => Infinity);
    const via = points.map(() => 0);
    const joined = points.map(() => false);
    let at = 0;
    for (let step = 1; step < points.length; step++) {
        joined[at] = true;
        let next = -1;
        for (let i = 0; i < points.length; i++) {
            if (joined[i]) continue;
            const d = points[at]!.sub(points[i]!).magnitude;
            if (d < near[i]!) {
                near[i] = d;
                via[i] = at;
            }
            if (next < 0 || near[i]! < near[next]!) next = i;
        }
        pairs.push([via[next]!, next]);
        at = next;
    }
    return pairs;
}
