/*
    Render the board through an arbitrary camera into a 2D canvas.

    Insets show the board without a second GPU context or a second copy of
    its geometry: the board viewer's own WebGL context draws one frame with
    the inset's camera into the bottom-left corner of its drawing buffer, and
    the pixels are copied into the inset's canvas with drawImage in the same
    task (no preserveDrawingBuffer needed).

    Resizing the drawing buffer instead costs a reallocation per frame
    (measured 18-21 ms on EDA-04903), so the buffer is only grown when an
    inset is larger than the main canvas.
*/

import { BBox, Matrix3, Vec2 } from "../../base/math";
import type { WebGL2Renderer } from "../../graphics/webgl";
import type { ViewLayerSet } from "../base/view-layers";

/** The slice of BoardViewer this module needs; keeps it testable. */
export interface BoardViewHost {
    readonly canvas: HTMLCanvasElement;
    readonly renderer: unknown;
    readonly layers: ViewLayerSet;
    readonly active: boolean;
    render_layers(camera: Matrix3): void;
    draw_now(): void;
}

/** An inset's own labels (a NetLabelLayers fork). */
export interface BoardViewLabels {
    camera: { zoom: number; bbox: BBox };
    update(): void;
    with_graphics<T>(fn: () => T): T;
}

export interface BoardViewOptions {
    /**
     * Pad numbers and net names gated for this view's zoom and region, not
     * the main view's. `zoom` is the view's CSS pixels per world unit.
     */
    labels?: { view: BoardViewLabels; zoom: number };
    /**
     * Bottom-side view: draw the back layers above the front, dimming the
     * front, the way an isolated-layer highlight does. Skipped when the user
     * already isolated layers.
     */
    back_on_top?: boolean;
}

/** Cumulative timings, read by benchmarks. */
export const board_view_stats = {
    frames: 0,
    /** Whole call, main thread. */
    ms: 0,
    /** GPU completion, only measured when gpu sync is on. */
    gpu_ms: 0,
    /** Frames that had to grow the drawing buffer. */
    grown: 0,
    reset() {
        this.frames = 0;
        this.ms = 0;
        this.gpu_ms = 0;
        this.grown = 0;
    },
};

/**
 * Debug: wait for the GPU after each inset frame so `gpu_ms` measures real
 * GPU work. `gl.finish()` returns early in Chrome; a 1-pixel readPixels
 * cannot.
 */
export function set_board_view_gpu_sync(on: boolean) {
    gpu_sync = on;
}
let gpu_sync = false;

const BACK_LAYER = /^:?B\./;

/**
 * Draw `host`'s board into `target` through `camera(css_w, css_h)`.
 * Returns false when nothing could be drawn (no layers, no context, zero
 * size).
 */
export function render_board_view(
    host: BoardViewHost,
    target: HTMLCanvasElement,
    camera: (css_w: number, css_h: number) => Matrix3,
    options: BoardViewOptions = {},
): boolean {
    const renderer = host.renderer as WebGL2Renderer;
    const gl = renderer.gl;
    const ctx = target.getContext("2d");
    if (!gl || !ctx || !host.layers || gl.isContextLost()) return false;

    const dpr = window.devicePixelRatio || 1;
    const css_w = target.clientWidth;
    const css_h = target.clientHeight;
    if (css_w <= 0 || css_h <= 0) return false;
    const pw = Math.round(css_w * dpr);
    const ph = Math.round(css_h * dpr);
    if (target.width !== pw) target.width = pw;
    if (target.height !== ph) target.height = ph;

    const t0 = performance.now();
    const source = host.canvas;
    const saved_w = source.width;
    const saved_h = source.height;
    const saved_projection = renderer.projection_matrix;
    const fits = saved_w >= pw && saved_h >= ph;
    if (!fits) {
        source.width = Math.max(saved_w, pw);
        source.height = Math.max(saved_h, ph);
        board_view_stats.grown += 1;
    }
    const buffer_h = source.height;

    gl.viewport(0, 0, pw, ph);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, pw, ph);
    renderer.projection_matrix = Matrix3.orthographic(css_w, css_h);
    // Clear with the main view's own clear colour, left untouched: it is GL
    // state the main frame relies on, and an inset must match its background.
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const raised: { highlighted: boolean }[] = [];
    if (options.back_on_top && !host.layers.is_any_layer_highlighted()) {
        for (const layer of host.layers.in_display_order()) {
            if (BACK_LAYER.test(layer.name)) {
                layer.highlighted = true;
                raised.push(layer);
            }
        }
    }
    const matrix = camera(css_w, css_h);
    const labels = options.labels;
    if (labels) {
        // The world box this view shows (rotation and mirror included).
        const inverse = matrix.inverse();
        const corners = [
            new Vec2(0, 0),
            new Vec2(css_w, 0),
            new Vec2(css_w, css_h),
            new Vec2(0, css_h),
        ].map((corner) => inverse.transform(corner));
        labels.view.camera = {
            zoom: labels.zoom,
            bbox: BBox.from_points(corners),
        };
        labels.view.update();
    }
    try {
        if (labels) labels.view.with_graphics(() => host.render_layers(matrix));
        else host.render_layers(matrix);
    } finally {
        for (const layer of raised) layer.highlighted = false;
    }
    if (gpu_sync) {
        const t_gpu = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        board_view_stats.gpu_ms += performance.now() - t_gpu;
    }

    // GL's origin is bottom-left; the canvas image's is top-left.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(source, 0, buffer_h - ph, pw, ph, 0, 0, pw, ph);

    gl.disable(gl.SCISSOR_TEST);
    if (!fits) {
        source.width = saved_w;
        source.height = saved_h;
    }
    gl.viewport(0, 0, saved_w, saved_h);
    renderer.projection_matrix = saved_projection;

    // The corner of the main frame now holds the inset. A visible board must
    // be restored in this same task, before the browser presents it; a
    // hidden one redraws when it is reactivated (Viewer.set_active).
    if (host.active && source.clientWidth > 0) host.draw_now();

    board_view_stats.frames += 1;
    board_view_stats.ms += performance.now() - t0;
    return true;
}
