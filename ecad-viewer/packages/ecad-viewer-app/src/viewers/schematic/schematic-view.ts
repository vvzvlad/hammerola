/*
    Render a schematic scene through an arbitrary camera into a 2D canvas.

    The schematic renderer records Canvas2D commands per layer. An inset
    replays them into its own context, so nothing is copied and nothing is
    drawn twice: the viewer's context and base transform are swapped for the
    duration of the call and put back.
*/

import { Matrix3 } from "../../base/math";
import type { Canvas2DRenderer } from "../../graphics/canvas2d";

export interface SchematicViewHost {
    readonly renderer: unknown;
    readonly layers: unknown;
    render_layers(camera: Matrix3): void;
}

export const schematic_view_stats = {
    frames: 0,
    ms: 0,
    reset() {
        this.frames = 0;
        this.ms = 0;
    },
};

/** Returns false when nothing could be drawn. */
export function render_schematic_view(
    host: SchematicViewHost,
    target: HTMLCanvasElement,
    camera: (css_w: number, css_h: number) => Matrix3,
): boolean {
    const renderer = host.renderer as Canvas2DRenderer;
    const ctx = target.getContext("2d");
    if (!ctx || !host.layers) return false;
    const css_w = target.clientWidth;
    const css_h = target.clientHeight;
    if (css_w <= 0 || css_h <= 0) return false;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(css_w * dpr);
    const ph = Math.round(css_h * dpr);
    if (target.width !== pw) target.width = pw;
    if (target.height !== ph) target.height = ph;

    const t0 = performance.now();
    const saved_ctx = renderer.ctx2d;
    const saved_base = renderer.base_transform;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = renderer.background_color.to_css();
    ctx.fillRect(0, 0, css_w, css_h);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    renderer.ctx2d = ctx;
    renderer.base_transform = Matrix3.scaling(dpr, dpr);
    try {
        host.render_layers(camera(css_w, css_h));
    } finally {
        renderer.ctx2d = saved_ctx;
        renderer.base_transform = saved_base;
    }
    schematic_view_stats.frames += 1;
    schematic_view_stats.ms += performance.now() - t0;
    return true;
}

/**
 * Draw the scene through `matrix` (world → CSS pixels) into `ctx` without
 * clearing it, so several sheets can share one canvas (the schematic plane).
 * The caller sets any clip on `ctx` first.
 */
export function render_schematic_into(
    host: SchematicViewHost,
    ctx: CanvasRenderingContext2D,
    matrix: Matrix3,
    dpr: number,
) {
    const renderer = host.renderer as Canvas2DRenderer;
    if (!host.layers) return;
    const saved_ctx = renderer.ctx2d;
    const saved_base = renderer.base_transform;
    renderer.ctx2d = ctx;
    renderer.base_transform = Matrix3.scaling(dpr, dpr);
    try {
        host.render_layers(matrix);
    } finally {
        renderer.ctx2d = saved_ctx;
        renderer.base_transform = saved_base;
    }
}
