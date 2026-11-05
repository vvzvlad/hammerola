/*
    View culling for large WebGL layers.

    A layer's primitives are tessellated into one vertex buffer per primitive
    kind and drawn with one drawArrays. For a large layer, commit() first
    orders its primitives by a coarse grid cell, so each cell is a contiguous
    vertex range of that same buffer, and records each cell's world bounds.
    Rendering then draws only the ranges whose bounds meet the view, merging
    neighbours into as few draw calls as possible.

    Nothing is added on the GPU: the buffers are the same size and count as
    before. The grid is bounded (at most MAX_GRID² cells per layer), and small
    layers are left exactly as they were.
*/

export interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface CullRange extends Box {
    /** First vertex of the range in the set's buffer. */
    first: number;
    /** Vertex count. */
    count: number;
}

/**
 * A layer is culled when it holds at least MIN_PRIMITIVES primitives or at
 * least MIN_POINTS points (vertices before tessellation). Points catch layers
 * of a few huge polygons, such as zone fills; primitives catch layers of
 * many small ones, such as vias.
 */
export const MIN_PRIMITIVES = 256;
export const MIN_POINTS = 4096;
/** The grid is the finer of: about this many primitives per cell... */
export const TARGET_PER_CELL = 64;
/** ...or about this many points per cell... */
export const TARGET_POINTS_PER_CELL = 2048;
/** ...but never fewer than this many primitives per cell. */
export const MIN_PRIMITIVES_PER_CELL = 4;
/** At most MAX_GRID × MAX_GRID cells per layer. */
export const MAX_GRID = 16;

/** Global switch, for tests and benchmarks (A/B against the old path). */
export const cull_settings = { enabled: true };

export const cull_stats = {
    /** Vertices submitted to drawArrays by culled sets. */
    drawn: 0,
    /** Vertices those sets hold in total. */
    held: 0,
    /** drawArrays calls issued by culled sets. */
    calls: 0,
    reset() {
        this.drawn = 0;
        this.held = 0;
        this.calls = 0;
    },
};

export interface CellPlan<T> {
    /** The items, stably ordered by cell. */
    order: T[];
    /** Cell index of each item in `order`. */
    cells: number[];
    /** World box of each item in `order`. */
    boxes: Box[];
}

/**
 * Order `items` by grid cell (the cell holding each item's box centre), or
 * return null when the layer is too small to be worth culling.
 */
export function plan_cells<T>(
    items: readonly T[],
    box_of: (item: T) => Box,
    points_of: (item: T) => number = () => 1,
): CellPlan<T> | null {
    if (!cull_settings.enabled || items.length < 2 * MIN_PRIMITIVES_PER_CELL)
        return null;
    let points = 0;
    for (const item of items) points += points_of(item);
    if (items.length < MIN_PRIMITIVES && points < MIN_POINTS) return null;
    const boxes = items.map(box_of);
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (const b of boxes) {
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    const grid = Math.min(
        MAX_GRID,
        Math.max(
            Math.ceil(Math.sqrt(items.length / TARGET_PER_CELL)),
            Math.ceil(Math.sqrt(points / TARGET_POINTS_PER_CELL)),
        ),
        Math.floor(Math.sqrt(items.length / MIN_PRIMITIVES_PER_CELL)),
    );
    if (grid <= 1) return null;
    const sx = grid / (x1 - x0);
    const sy = grid / (y1 - y0);
    const cell_of = (b: Box) => {
        const cx = Math.min(
            grid - 1,
            Math.floor(((b.x0 + b.x1) / 2 - x0) * sx),
        );
        const cy = Math.min(
            grid - 1,
            Math.floor(((b.y0 + b.y1) / 2 - y0) * sy),
        );
        return Math.max(0, cy) * grid + Math.max(0, cx);
    };
    const index = items.map((_, i) => i);
    const cells = boxes.map(cell_of);
    // Stable: items keep their paint order within a cell.
    index.sort((a, b) => cells[a]! - cells[b]! || a - b);
    return {
        order: index.map((i) => items[i]!),
        cells: index.map((i) => cells[i]!),
        boxes: index.map((i) => boxes[i]!),
    };
}

/**
 * Turn per-item vertex offsets (`starts`, length n + 1, from the set's
 * tessellation) into one range per cell, bounded by its members' boxes.
 */
export function build_ranges<T>(
    plan: CellPlan<T>,
    starts: number[],
): CullRange[] {
    const ranges: CullRange[] = [];
    let current: CullRange | null = null;
    let cell = -1;
    for (let i = 0; i < plan.order.length; i++) {
        const b = plan.boxes[i]!;
        if (plan.cells[i] !== cell || !current) {
            cell = plan.cells[i]!;
            current = { first: starts[i]!, count: 0, ...b };
            ranges.push(current);
        } else {
            if (b.x0 < current.x0) current.x0 = b.x0;
            if (b.y0 < current.y0) current.y0 = b.y0;
            if (b.x1 > current.x1) current.x1 = b.x1;
            if (b.y1 > current.y1) current.y1 = b.y1;
        }
        current.count = starts[i + 1]! - current.first;
    }
    return ranges.filter((r) => r.count > 0);
}

const meets = (a: Box, b: Box) =>
    a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;

/**
 * Visible ranges as [first, count] draw calls, adjacent ones merged.
 */
export function visible_draws(
    ranges: readonly CullRange[],
    view: Box,
): [number, number][] {
    const draws: [number, number][] = [];
    for (const r of ranges) {
        if (!meets(r, view)) continue;
        const last = draws[draws.length - 1];
        if (last && last[0] + last[1] === r.first) last[1] += r.count;
        else draws.push([r.first, r.count]);
    }
    return draws;
}

/** World box seen through a full (projection × camera) matrix. */
export function view_box(inverse: {
    transform(v: { x: number; y: number }): { x: number; y: number };
}): Box {
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (const [x, y] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
    ] as const) {
        const p = inverse.transform({ x, y });
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
    }
    return { x0, y0, x1, y1 };
}

/** Triangle-level culling for polygon sets: at least this many triangles. */
export const MIN_TRIANGLES = 1024;
/** About this many triangles per cell. */
export const TARGET_TRIANGLES_PER_CELL = 512;

/**
 * Reorder a triangle list (2 floats per vertex, 3 vertices per triangle,
 * `stride` floats of colour per vertex) by grid cell of each triangle's
 * centroid, in place of the input arrays, and return the per-cell ranges.
 *
 * Triangles of one polygon never overlap, so their order does not matter;
 * the sort is stable, so overlapping polygons keep their relative order
 * within a cell. A plane fill that covers the whole board becomes many small
 * ranges, of which a zoomed view draws a few.
 */
export function cull_triangles(
    positions: Float32Array,
    colors: Float32Array,
    color_stride: number,
): CullRange[] | null {
    const triangles = positions.length / 6;
    if (!cull_settings.enabled || triangles < MIN_TRIANGLES) return null;
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (let i = 0; i < positions.length; i += 2) {
        const x = positions[i]!,
            y = positions[i + 1]!;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
    }
    if (!(x1 > x0) || !(y1 > y0)) return null;
    const grid = Math.min(
        MAX_GRID,
        Math.ceil(Math.sqrt(triangles / TARGET_TRIANGLES_PER_CELL)),
    );
    if (grid <= 1) return null;
    const sx = grid / (x1 - x0);
    const sy = grid / (y1 - y0);
    const cells = new Uint16Array(triangles);
    const counts = new Uint32Array(grid * grid + 1);
    for (let t = 0; t < triangles; t++) {
        const o = t * 6;
        const cx = (positions[o]! + positions[o + 2]! + positions[o + 4]!) / 3;
        const cy =
            (positions[o + 1]! + positions[o + 3]! + positions[o + 5]!) / 3;
        const gx = Math.min(grid - 1, Math.max(0, Math.floor((cx - x0) * sx)));
        const gy = Math.min(grid - 1, Math.max(0, Math.floor((cy - y0) * sy)));
        const c = gy * grid + gx;
        cells[t] = c;
        counts[c + 1]! += 1;
    }
    // Counting sort: stable, O(n).
    for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
    const starts = counts.slice(0, grid * grid);
    const next = starts.slice();
    const pos = positions.slice();
    const col = colors.slice();
    const cstride = color_stride * 3;
    for (let t = 0; t < triangles; t++) {
        const d = next[cells[t]!]!++;
        positions.set(pos.subarray(t * 6, t * 6 + 6), d * 6);
        colors.set(
            col.subarray(t * cstride, t * cstride + cstride),
            d * cstride,
        );
    }
    const ranges: CullRange[] = [];
    for (let c = 0; c < grid * grid; c++) {
        const first = starts[c]!;
        const end = c + 1 < grid * grid ? starts[c + 1]! : triangles;
        if (end === first) continue;
        let bx0 = Infinity,
            by0 = Infinity,
            bx1 = -Infinity,
            by1 = -Infinity;
        for (let i = first * 6; i < end * 6; i += 2) {
            const x = positions[i]!,
                y = positions[i + 1]!;
            if (x < bx0) bx0 = x;
            if (y < by0) by0 = y;
            if (x > bx1) bx1 = x;
            if (y > by1) by1 = y;
        }
        ranges.push({
            first: first * 3,
            count: (end - first) * 3,
            x0: bx0,
            y0: by0,
            x1: bx1,
            y1: by1,
        });
    }
    return ranges;
}
