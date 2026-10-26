/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../../base/color";
import { Angle, Matrix3, Vec2 } from "../../base/math";
import { RenderLayer, Renderer } from "../renderer";
import { Arc, Circle, Polygon, Polyline } from "../shapes";
import type { ShaderProgram } from "./helpers";
import {
    CircleSet,
    PolygonSet,
    PolylineSet,
    PrimitiveSet,
    ShaderTypes,
} from "./vector";

/**
 * WebGL2-based renderer
 */
export class WebGL2Renderer extends Renderer {
    override image(
        img: HTMLImageElement,
        x: number,
        y: number,
        scale: number,
    ): void {
        throw new Error("Method not implemented.");
    }
    /** Graphics layers */
    #layers: WebGL2RenderLayer[] = [];

    /** The layer currently being drawn to. */
    #active_layer: WebGL2RenderLayer | null;

    /** Projection matrix for clip -> screen */
    projection_matrix: Matrix3 = Matrix3.identity();

    /** WebGL backend */
    gl?: WebGL2RenderingContext;

    #shader_programs: Map<ShaderTypes, ShaderProgram> = new Map();

    /**
     * Create a new WebGL2Renderer
     */
    constructor(canvas: HTMLCanvasElement) {
        super(canvas);
    }

    /**
     * Create and configure the WebGL2 context.
     */
    override async setup() {
        const gl = this.canvas.getContext("webgl2", { alpha: false });

        if (gl == null) {
            throw new Error("Unable to create WebGL2 context");
        }

        this.gl = gl;

        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.GREATER);

        gl.clearColor(...this.background_color.to_array());
        gl.clearDepth(0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        this.update_canvas_size();

        this.#shader_programs.set(
            ShaderTypes.PolygonSet,
            await PolygonSet.load_shader(gl),
        );
        this.#shader_programs.set(
            ShaderTypes.PolylineSet,
            await PolylineSet.load_shader(gl),
        );
        this.#shader_programs.set(
            ShaderTypes.CircleSet,
            await CircleSet.load_shader(gl),
        );
    }

    override dispose() {
        this.#size_observer?.disconnect();
        this.#size_observer = undefined;
        for (const layer of this.layers) {
            layer.dispose();
        }
        this.gl = undefined;
        this.#shader_programs.clear();
    }

    #size_dirty = true;
    #size_observer?: ResizeObserver;

    override update_canvas_size() {
        if (!this.gl) {
            return;
        }

        // Avoid getBoundingClientRect() every frame — it forces layout.
        if (!this.#size_observer) {
            this.#size_observer = new ResizeObserver(() => {
                this.#size_dirty = true;
                // Resize the GL backing store before notifying listeners so a
                // re-paint (document comparison) does not run at 0×0 / 300×150.
                this.update_canvas_size();
                this.on_resize?.();
            });
            this.#size_observer.observe(this.canvas);
        }

        const dpr = window.devicePixelRatio;
        const rect = this.canvas.getBoundingClientRect();
        const logical_w = rect.width;
        const logical_h = rect.height;
        const pixel_w = Math.round(rect.width * dpr);
        const pixel_h = Math.round(rect.height * dpr);

        // Always sync when the backing store disagrees with layout — do not
        // trust size_dirty alone (a prior 0×0 pass can clear the flag and leave
        // the default 300×150 buffer while clientWidth is already real).
        if (
            !this.#size_dirty &&
            this.canvas.width === pixel_w &&
            this.canvas.height === pixel_h
        ) {
            return;
        }
        this.#size_dirty = false;

        if (
            this.canvas_size.x == pixel_w &&
            this.canvas_size.y == pixel_h &&
            this.canvas.width === pixel_w &&
            this.canvas.height === pixel_h
        ) {
            return;
        }
        this.canvas_size.set(pixel_w, pixel_h);

        this.canvas.width = pixel_w;
        this.canvas.height = pixel_h;

        this.gl.viewport(0, 0, pixel_w, pixel_h);
        this.projection_matrix = Matrix3.orthographic(logical_w, logical_h);
    }

    override clear_canvas() {
        if (this.gl == null) throw new Error("Uninitialized");

        // Update canvas size and projection matrix if needed. The measurement
        // inside forces layout, so a settled frame must not reach it: the
        // observer is what marks the box stale, and a zero-width backing store
        // is wrong whatever the flag says (a property read, not a layout read).
        if (this.#size_dirty || this.canvas.width === 0) {
            this.update_canvas_size();
        }

        this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT);
    }

    override start_layer(name: string, depth = 0) {
        if (this.gl == null) throw new Error("Uninitialized");
        this.#active_layer = new WebGL2RenderLayer(
            this,
            name,
            new PrimitiveSet(this.gl, this.#shader_programs),
        );
    }

    override end_layer(): RenderLayer {
        if (this.#active_layer == null) throw new Error("No active layer");

        this.#active_layer.geometry.commit();
        this.#layers.push(this.#active_layer);
        this.#active_layer = null;

        return this.#layers.at(-1)!;
    }

    override arc(
        arc_or_center: Arc | Vec2,
        radius?: number,
        start_angle?: Angle,
        end_angle?: Angle,
        width?: number,
        color?: Color,
    ): void {
        super.prep_arc(
            arc_or_center,
            radius,
            start_angle,
            end_angle,
            width,
            color,
        );
    }

    override circle(
        circle_or_center: Circle | Vec2,
        radius?: number,
        color?: Color,
    ): void {
        const circle = super.prep_circle(circle_or_center, radius, color);

        if (!circle.color) {
            return;
        }

        this.#active_layer!.geometry.add_circle(circle);
    }

    override line(
        line_or_points: Polyline | Vec2[],
        width?: number,
        color?: Color,
    ): void {
        const line = super.prep_line(line_or_points, width, color);

        if (!line.color) {
            return;
        }

        this.#active_layer!.geometry.add_line(line);
    }

    override polylines(lines: Vec2[][], width?: number, color?: Color): void {
        // Bulk text (net labels, board text) is stroked by the thousand on
        // layers that never track bboxes, usually at an identity state
        // matrix. In that case skip prep_line's per-stroke copy, matrix pass
        // and bbox bookkeeping: at that volume it costs more than the
        // tessellation it feeds.
        if (this.tracking_bbox || !this.state.matrix.is_identity) {
            super.polylines(lines, width, color);
            return;
        }

        let stroke_color =
            color ?? this.state.stroke ?? Color.transparent_black;
        if (stroke_color.is_transparent_black) {
            stroke_color = this.state.stroke ?? Color.transparent_black;
        }
        if (this.color_transform) {
            stroke_color = this.color_transform(stroke_color);
        }

        const stroke_width = width ?? this.state.stroke_width;
        const geometry = this.#active_layer!.geometry;
        for (const points of lines) {
            geometry.add_line(new Polyline(points, stroke_width, stroke_color));
        }
    }

    override polygon(polygon_or_points: Polygon | Vec2[], color?: Color): void {
        const polygon = super.prep_polygon(polygon_or_points, color);

        if (!polygon.color) {
            return;
        }

        this.#active_layer!.geometry.add_polygon(polygon);
    }

    override get layers(): Iterable<RenderLayer> {
        const layers = this.#layers;
        return {
            *[Symbol.iterator]() {
                for (const layer of layers) {
                    yield layer;
                }
            },
        };
    }

    override remove_layer(layer: WebGL2RenderLayer) {
        const idx = this.#layers.indexOf(layer);
        if (idx == -1) {
            return;
        }
        this.#layers.splice(idx, 1);
    }
}

class WebGL2RenderLayer extends RenderLayer {
    constructor(
        public override readonly renderer: WebGL2Renderer,
        public override readonly name: string,
        public geometry: PrimitiveSet,
    ) {
        super(renderer, name);
    }

    override dispose(): void {
        this.clear();
        // Drop the renderer's reference too. Dynamic layers (grid, net
        // labels) are rebuilt many times per session; without this every
        // rebuild left a dead layer in the renderer's list.
        this.renderer.remove_layer(this);
    }

    clear() {
        this.geometry?.dispose();
    }

    render(transform: Matrix3, depth: number, global_alpha = 1) {
        const gl = this.renderer.gl!;
        const total_transform =
            this.renderer.projection_matrix.multiply(transform);

        if (this.composite_operation != "source-over") {
            gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        }

        this.geometry.render(total_transform, depth, global_alpha);

        if (this.composite_operation != "source-over") {
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        }
    }
}
