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

    return wasm ? triangulate_wasm(wasm, points, n) : triangulate_js(points, n);
}

/**
 * The two implementations, exposed so the fallback can be tested. Production
 * code calls `triangulate`, which picks between them; nothing else should
 * reach for these directly.
 */
export const __impl = {
    js: (points: Vec2[]) => triangulate_js(points, points.length),
    wasm: (points: Vec2[]) =>
        wasm ? triangulate_wasm(wasm, points, points.length) : null,
};

function triangulate_wasm(
    m: EarcutWasm,
    points: Vec2[],
    n: number,
): Float32Array {
    // ec_coords may grow the arena, which can detach the heap views, so read
    // HEAPF64 only after the call that resizes.
    const coords_ptr = m._ec_coords(n * 2);
    const heap = m.HEAPF64;
    const base = coords_ptr >>> 3;

    for (let i = 0; i < n; i++) {
        const pt = points[i]!;
        heap[base + i * 2] = pt.x;
        heap[base + i * 2 + 1] = pt.y;
    }

    // The wasm side expands indices to positions itself, so there is no
    // 2M-iteration index walk left on this thread.
    const count = m._ec_run_one_f32(n * 2);
    const verts = m._ec_verts() >>> 2;

    return m.HEAPF32.slice(verts, verts + count * 2);
}

function triangulate_js(points: Vec2[], n: number): Float32Array {
    const points_flattened = new Array(n * 2);
    for (let i = 0; i < n; i++) {
        const pt = points[i]!;
        points_flattened[i * 2] = pt.x;
        points_flattened[i * 2 + 1] = pt.y;
    }

    const triangle_indexes = earcut(points_flattened);
    const vertices = new Float32Array(triangle_indexes.length * 2);

    for (let i = 0; i < triangle_indexes.length; i++) {
        const index = triangle_indexes[i];
        vertices[i * 2] = points_flattened[index * 2];
        vertices[i * 2 + 1] = points_flattened[index * 2 + 1];
    }

    return vertices;
}
