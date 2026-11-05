/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * Polygon triangulation for the WebGL tesselator.
 *
 * Two implementations of the same ear-clipping algorithm: the vendored JS
 * earcut, and the same library compiled to wasm. The wasm one is ~1.5x faster
 * on the zone fills of a large board, so it is preferred, but it has to be
 * instantiated asynchronously and instantiation can fail outright (a host page
 * whose CSP forbids `wasm-unsafe-eval`, say). The JS path therefore stays as
 * the fallback rather than being deleted, and `triangulate` picks whichever is
 * available at the moment it is called.
 *
 * Correctness note: the two produce *different* triangle sets for the same
 * ring -- same area, different ear order. Nothing downstream may assume a
 * particular triangulation.
 */

import earcut from "../../../third_party/earcut/earcut";
import type { Vec2 } from "../../base/math";
import init_earcut_wasm from "../../../third_party/earcut-wasm/earcut_wasm.mjs";

interface EarcutWasm {
    _ec_coords(n_doubles: number): number;
    _ec_run_one_f32(n_coords: number): number;
    _ec_verts(): number;
    HEAPF64: Float64Array;
    HEAPF32: Float32Array;
}

let wasm: EarcutWasm | null = null;

/**
 * Kicked off at module load. Nothing waits on it: until it settles,
 * `triangulate` uses the JS path, so a board that somehow paints within the
 * few milliseconds this takes is slower but never wrong.
 */
const wasm_ready: Promise<void> = (async () => {
    try {
        wasm = (await init_earcut_wasm()) as EarcutWasm;
    } catch (e) {
        console.warn(
            "[ecad-viewer] wasm triangulation unavailable, falling back to JS earcut",
            e,
        );
        wasm = null;
    }
})();

/**
 * Resolves once the wasm module has either loaded or failed. Only tests need
 * this -- production code just calls `triangulate` and gets whichever
 * implementation is ready.
 */
export function triangulation_ready(): Promise<void> {
    return wasm_ready;
}

/** Which implementation `triangulate` would use right now. */
export function triangulation_backend(): "wasm" | "js" {
    return wasm ? "wasm" : "js";
}

/**
 * Rings with at least this many points are cut into vertical strips and each
 * strip is triangulated on its own.
 *
 * KiCad stores a zone fill "fractured": every hole is joined to the outline
 * by a zero-width slit, so a ground plane with thousands of clearance holes
 * arrives as one ring of 100k+ points. Ear clipping slows down much faster
 * than linearly on such a ring -- on CERN's EDA-04903 the six inner planes
 * (123k-154k points each) took 600-760 ms apiece in wasm earcut, 3.4 s of a
 * 7.1 s load -- while the same ring cut into 8 strips triangulates in
 * 105-141 ms, all strips together, with the same total area and, on the GPU,
 * 1 differing pixel of 557,360 at fit and none zoomed in. The measurements are
 * in the pull request that added this.
 *
 * Below the threshold a ring is cheap enough whole, and cutting it would only
 * add triangles.
 */
const STRIP_MIN_POINTS = 50_000;
/** Target points per strip; 8 strips for the EDA-04903 planes measured best. */
const STRIP_TARGET_POINTS = 16_000;
const STRIP_MAX = 16;

/**
 * A strip whose triangles cover a different area than the strip itself is
 * not trusted: the whole ring is triangulated instead. Generous next to the
 * float32 residue (~1e-8), tiny next to a real defect (a missing ear).
 */
const STRIP_AREA_TOLERANCE = 1e-4;

/**
 * Triangulate a simple polygon into interleaved xy vertex positions, ready to
 * upload as a triangle list.
 */
export function triangulate(points: Vec2[]): Float32Array {
    const n = points.length;

    // A triangle is already a triangle. Handled before either backend so the
    // degenerate case never crosses the wasm boundary.
    if (n === 3) {
        return new Float32Array([
            points[0]!.x,
            points[0]!.y,
            points[1]!.x,
            points[1]!.y,
            points[2]!.x,
            points[2]!.y,
        ]);
    }

    return triangulate_flat(flatten(points));
}

/**
 * `triangulate` on a ring given as interleaved xy, for callers that already
 * hold flat coordinates -- the parser worker, which triangulates large zone
 * fills off the main thread.
 */
export function triangulate_flat(ring: Float64Array): Float32Array {
    const coords = drop_repeats(ring);
    if (coords.length < 6) return new Float32Array(0);
    if (coords.length / 2 >= STRIP_MIN_POINTS) {
        return triangulate_strips(coords) ?? triangulate_coords(coords);
    }
    return triangulate_coords(coords);
}

/**
 * The ring without points identical to the one before them (the last point
 * is compared with the first, too). A repeated point adds no geometry -- the
 * polygon is exactly the same shape without it -- but earcut still pays for
 * it. KiCad's fractured zone fills are full of them: they are 23% of the
 * points in EDA-04903's large fills, and dropping them cut those fills'
 * triangulation from 454 ms to 279 ms. Only exact repeats are dropped, so
 * nothing about the outline changes. Returns the input itself when it has
 * none.
 */
function drop_repeats(coords: Float64Array): Float64Array {
    const n = coords.length / 2;
    let first = -1;
    for (let i = 1; i <= n; i++) {
        const j = i === n ? 0 : i;
        if (
            coords[j * 2] === coords[(i - 1) * 2] &&
            coords[j * 2 + 1] === coords[(i - 1) * 2 + 1]
        ) {
            first = i;
            break;
        }
    }
    if (first < 0 || n < 2) return coords;

    const out = new Float64Array(coords.length);
    let o = 0;
    for (let i = 0; i < n; i++) {
        const x = coords[i * 2]!;
        const y = coords[i * 2 + 1]!;
        if (o >= 2 && x === out[o - 2] && y === out[o - 1]) continue;
        out[o++] = x;
        out[o++] = y;
    }
    // Closing repeat: last point equal to the first.
    while (o >= 4 && out[o - 2] === out[0] && out[o - 1] === out[1]) o -= 2;
    return out.subarray(0, o);
}

/** How many strips `triangulate` cuts a ring of `n` points into (1 = none). */
export function strip_count(n: number): number {
    if (n < STRIP_MIN_POINTS) return 1;
    return Math.min(STRIP_MAX, Math.ceil(n / STRIP_TARGET_POINTS));
}

/**
 * The implementations, exposed so the fallback and the strip path can be
 * tested. Production code calls `triangulate`, which picks between them;
 * nothing else should reach for these directly.
 */
export const __impl = {
    js: (points: Vec2[]) => triangulate_js(flatten(points)),
    wasm: (points: Vec2[]) =>
        wasm ? triangulate_wasm(wasm, flatten(points)) : null,
    /** The strip path alone, or null where it declined. */
    strips: (points: Vec2[]) => triangulate_strips(flatten(points)),
};

function flatten(points: Vec2[]): Float64Array {
    const coords = new Float64Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
        const pt = points[i]!;
        coords[i * 2] = pt.x;
        coords[i * 2 + 1] = pt.y;
    }
    return coords;
}

/** Whichever backend is live, on interleaved xy. */
function triangulate_coords(coords: Float64Array): Float32Array {
    return wasm ? triangulate_wasm(wasm, coords) : triangulate_js(coords);
}

/**
 * Cut the ring into vertical bands, triangulate each, and concatenate. Each
 * band is the ring clipped to `lo <= x <= hi` by Sutherland-Hodgman, which
 * accepts any number of crossings -- a straight cut through a fractured plane
 * crosses it a hundred times -- and joins the pieces of a band with
 * zero-width runs along the cut. Earcut tolerates those as it tolerates the
 * fracture slits themselves; the area check below is what makes sure.
 *
 * Returns null if any band's triangles do not cover that band's area, and
 * the caller triangulates the ring whole.
 */
function triangulate_strips(coords: Float64Array): Float32Array | null {
    const n = coords.length / 2;
    const k = strip_count(n);
    if (k < 2) return null;

    let min_x = Infinity;
    let max_x = -Infinity;
    for (let i = 0; i < n; i++) {
        const x = coords[i * 2]!;
        if (x < min_x) min_x = x;
        if (x > max_x) max_x = x;
    }
    if (!(max_x > min_x)) return null;

    const pieces: Float32Array[] = [];
    let total = 0;
    for (let s = 0; s < k; s++) {
        const lo = s === 0 ? min_x : min_x + ((max_x - min_x) * s) / k;
        const hi =
            s === k - 1 ? max_x : min_x + ((max_x - min_x) * (s + 1)) / k;
        const band = clip_band(coords, lo, hi);
        if (band.length < 6) continue;

        const verts = triangulate_coords(band);
        const area = ring_area(band);
        if (Math.abs(soup_area(verts) - area) > area * STRIP_AREA_TOLERANCE) {
            return null;
        }
        pieces.push(verts);
        total += verts.length;
    }

    const out = new Float32Array(total);
    let offset = 0;
    for (const piece of pieces) {
        out.set(piece, offset);
        offset += piece.length;
    }
    return out;
}

/** The ring clipped to the band lo <= x <= hi, as interleaved xy. */
function clip_band(coords: Float64Array, lo: number, hi: number): Float64Array {
    const left = clip_half(coords, lo, true);
    return clip_half(left, hi, false);
}

/** One Sutherland-Hodgman pass against the vertical line x = cut. */
function clip_half(
    coords: Float64Array,
    cut: number,
    keep_right: boolean,
): Float64Array {
    const n = coords.length / 2;
    const out = new Float64Array(n * 4);
    let o = 0;
    for (let i = 0; i < n; i++) {
        const ax = coords[i * 2]!;
        const ay = coords[i * 2 + 1]!;
        const j = i + 1 === n ? 0 : i + 1;
        const bx = coords[j * 2]!;
        const by = coords[j * 2 + 1]!;
        const a_in = keep_right ? ax >= cut : ax <= cut;
        const b_in = keep_right ? bx >= cut : bx <= cut;
        if (a_in) {
            out[o++] = ax;
            out[o++] = ay;
        }
        if (a_in !== b_in) {
            out[o++] = cut;
            out[o++] = ay + ((cut - ax) / (bx - ax)) * (by - ay);
        }
    }
    return out.subarray(0, o);
}

function ring_area(coords: Float64Array): number {
    const n = coords.length / 2;
    let sum = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        sum +=
            coords[j * 2]! * coords[i * 2 + 1]! -
            coords[i * 2]! * coords[j * 2 + 1]!;
    }
    return Math.abs(sum / 2);
}

function soup_area(verts: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < verts.length; i += 6) {
        const ax = verts[i]!;
        const ay = verts[i + 1]!;
        sum += Math.abs(
            (verts[i + 2]! - ax) * (verts[i + 5]! - ay) -
                (verts[i + 4]! - ax) * (verts[i + 3]! - ay),
        );
    }
    return sum / 2;
}

function triangulate_wasm(m: EarcutWasm, coords: Float64Array): Float32Array {
    const n = coords.length / 2;
    // ec_coords may grow the arena, which can detach the heap views, so read
    // HEAPF64 only after the call that resizes.
    const coords_ptr = m._ec_coords(n * 2);
    m.HEAPF64.set(coords, coords_ptr >>> 3);

    // The wasm side expands indices to positions itself, so there is no
    // 2M-iteration index walk left on this thread.
    const count = m._ec_run_one_f32(n * 2);
    const verts = m._ec_verts() >>> 2;

    return m.HEAPF32.slice(verts, verts + count * 2);
}

function triangulate_js(coords: Float64Array): Float32Array {
    const triangle_indexes = earcut(coords as unknown as number[]);
    const vertices = new Float32Array(triangle_indexes.length * 2);

    for (let i = 0; i < triangle_indexes.length; i++) {
        const index = triangle_indexes[i];
        vertices[i * 2] = coords[index * 2]!;
        vertices[i * 2 + 1] = coords[index * 2 + 1]!;
    }

    return vertices;
}
