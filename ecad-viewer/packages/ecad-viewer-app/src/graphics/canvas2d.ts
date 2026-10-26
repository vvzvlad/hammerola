/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../base/color";
import { Angle, BBox, Matrix3, Vec2 } from "../base/math";
import { Renderer, RenderLayer, RenderStateStack } from "./renderer";
import { Arc, Circle, Polygon, Polyline } from "./shapes";

/**
 * Canvas2d-based renderer.
 *
 * This renderer works by turning draw calls into DrawCommands - basically
 * serializing them as Path2D + state. These DrawCommands are combined into
 * multiple Layers. When the layers are later drawn, the draw commands are
 * stepped through and draw onto the canvas.
 *
 * This is similar to generating old-school display lists.
 *
 */

export class Canvas2DRenderer extends Renderer {
    override image(
        img: HTMLImageElement,
        x: number,
        y: number,
        scale: number,
        ppi?: number,
    ): void {
        const image_primitive = super.prep_image(img, x, y, scale, ppi);

        this.#active_layer?.commands.push(
            new ImageCommand(
                img,
                image_primitive.src_bbox,
                image_primitive.target_bbox,
            ),
        );
    }

    /** Graphics layers */
    #layers: Canvas2dRenderLayer[] = [];

    /** The layer currently being drawn to. */
    #active_layer: Canvas2dRenderLayer | null;

    #bboxes: Map<string, BBox> = new Map();

    //The scene bounding box containing all items.
    #scene_bbox: BBox = new BBox();

    get scene_bbox() {
        return this.#scene_bbox;
    }

    reset_scene_bbox() {
        this.#scene_bbox = new BBox();
    }

    get_item_bbox(uuid: string) {
        return this.#bboxes.get(uuid);
    }

    /** State */
    override state: RenderStateStack = new RenderStateStack();

    ctx2d?: CanvasRenderingContext2D;

    /** Base (devicePixelRatio) transform, refreshed by clear_canvas. */
    base_transform: Matrix3 = Matrix3.identity();

    /**
     * Create a new Canvas2DRenderer
     */
    constructor(canvas: HTMLCanvasElement) {
        super(canvas);
    }

    /**
     * Create and configure the 2D Canvas context.
     */
    override async setup() {
        const ctx2d = this.canvas.getContext("2d");

        if (ctx2d == null) {
            throw new Error("Unable to create Canvas2d context");
        }

        this.ctx2d = ctx2d;

        // Only marks the cached rect stale. Deliberately does NOT call
        // `on_resize`: the WebGL renderer fires that, the 2d one never has, and
        // starting to would newly put DocumentViewer.on_canvas_resize's
        // sync_from_canvas() + draw() on every resize tick for schematics --
        // a behaviour change that does not belong in a perf fix.
        this.#size_observer = new ResizeObserver(() => {
            this.#rect_dirty = true;
        });
        this.#size_observer.observe(this.canvas);

        this.update_canvas_size();
    }

    override dispose() {
        this.#size_observer?.disconnect();
        this.#size_observer = undefined;
        this.ctx2d = undefined;
        for (const layer of this.#layers) {
            layer.dispose();
        }
    }

    override end_bbox(context: any): BBox {
        const bb = super.end_bbox(context);
        if ("uuid" in context && typeof context.uuid === "string") {
            this.#bboxes.set(context.uuid, bb);
        }
        this.#scene_bbox = BBox.combine([this.#scene_bbox, bb]);
        return bb;
    }

    #size_observer?: ResizeObserver;
    #rect_dirty = true;

    /**
     * Re-measure and re-size the backing store. Always measures: every caller
     * outside the frame loop -- DocumentViewer's resize and paint paths, and
     * the host's pane-resize and tab-settle hooks -- calls in precisely because
     * it believes the layout box just changed, and may well run before the
     * ResizeObserver has ticked. The per-frame path does not come through here;
     * see clear_canvas.
     */
    override update_canvas_size() {
        // Size the backing store to physical pixels. The camera and every draw
        // command work in CSS-pixel space; the devicePixelRatio scale that
        // bridges the two is applied to the context in clear_canvas. Without it
        // the buffer was one CSS pixel per device pixel and the browser
        // upscaled it, blurring the whole schematic on any HiDPI display.
        const dpr = window.devicePixelRatio || 1;

        this.#rect_dirty = false;
        const rect = this.canvas.getBoundingClientRect();
        const pixel_w = Math.round(rect.width * dpr);
        const pixel_h = Math.round(rect.height * dpr);

        if (this.canvas.width != pixel_w || this.canvas.height != pixel_h) {
            this.canvas.width = pixel_w;
            this.canvas.height = pixel_h;
        }
    }

    override clear_canvas() {
        const ctx2d = this.ctx2d;
        if (!ctx2d) return;

        // getBoundingClientRect() forces layout, and this runs on every single
        // frame. Once the box has settled the observer is the only thing that
        // can invalidate it, so a steady-state frame does no layout work at
        // all. A zero-width backing store is always wrong regardless of the
        // flag, and canvas.width is a property read, not a layout read.
        if (this.#rect_dirty || this.canvas.width === 0) {
            this.update_canvas_size();
        }

        // Reset to the identity, then scale by devicePixelRatio so drawing in
        // CSS-pixel coordinates fills the physical-pixel backing store. Layer
        // rendering reads this as its base transform and composes the camera on
        // top, so the whole scene renders at full device resolution.
        const dpr = window.devicePixelRatio || 1;
        ctx2d.setTransform();
        ctx2d.scale(dpr, dpr);

        // Every layer brackets its own work in save()/restore(), so the
        // transform each one starts from is always exactly this. Publishing it
        // here saves a getTransform() round trip per layer per frame.
        this.base_transform = Matrix3.scaling(dpr, dpr);

        const css_w = this.canvas.width / dpr;
        const css_h = this.canvas.height / dpr;
        ctx2d.fillStyle = this.background_color.to_css();
        ctx2d.fillRect(0, 0, css_w, css_h);
        ctx2d.lineCap = "round";
        ctx2d.lineJoin = "round";
    }

    override start_layer(name: string) {
        this.#active_layer = new Canvas2dRenderLayer(this, name);
    }

    override end_layer(): RenderLayer {
        if (!this.#active_layer) {
            throw new Error("No active layer");
        }

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

        if (!circle.color || circle.color.is_transparent_black) {
            return;
        }

        const css_color = (circle.color as Color).to_css();

        const path = new Path2D();
        path.arc(
            circle.center.x,
            circle.center.y,
            circle.radius,
            0,
            Math.PI * 2,
        );

        this.#active_layer!.commands.push(
            new DrawCommand(path, css_color, null, 0),
        );
    }

    override line(
        line_or_points: Polyline | Vec2[],
        width?: number,
        color?: Color,
    ): void {
        const line = super.prep_line(line_or_points, width, color);

        if (!line.color || line.color.is_transparent_black) {
            return;
        }

        const css_color = (line.color as Color).to_css();

        const path = new Path2D();
        let started = false;

        for (const point of line.points) {
            if (!started) {
                path.moveTo(point.x, point.y);
                started = true;
            } else {
                path.lineTo(point.x, point.y);
            }
        }

        this.#active_layer!.commands.push(
            new DrawCommand(path, null, css_color, line.width),
        );
    }

    override polygon(polygon_or_points: Polygon | Vec2[], color?: Color): void {
        const polygon = super.prep_polygon(polygon_or_points, color);

        if (!polygon.color || polygon.color.is_transparent_black) {
            return;
        }

        const css_color = (polygon.color as Color).to_css();

        const path = new Path2D();
        let started = false;

        for (const point of polygon.points) {
            if (!started) {
                path.moveTo(point.x, point.y);
                started = true;
            } else {
                path.lineTo(point.x, point.y);
            }
        }
        path.closePath();

        this.#active_layer!.commands.push(
            new DrawCommand(path, css_color, null, 0),
        );
    }

    override polylines(lines: Vec2[][], width?: number, color?: Color): void {
        const path = new Path2D();
        let stroke: string | null = null;
        let stroke_width = 0;

        for (const points of lines) {
            const line = super.prep_line(points, width, color);
            if (!line.color || line.color.is_transparent_black) {
                continue;
            }

            stroke = (line.color as Color).to_css();
            stroke_width = line.width;

            let started = false;
            for (const point of line.points) {
                if (!started) {
                    path.moveTo(point.x, point.y);
                    started = true;
                } else {
                    path.lineTo(point.x, point.y);
                }
            }
        }

        if (!stroke) {
            return;
        }

        this.#active_layer!.commands.push(
            new DrawCommand(path, null, stroke, stroke_width),
        );
    }

    override get layers() {
        const layers = this.#layers;
        return {
            *[Symbol.iterator]() {
                for (const layer of layers) {
                    yield layer;
                }
            },
        };
    }

    override remove_layer(layer: Canvas2dRenderLayer) {
        const idx = this.#layers.indexOf(layer);
        if (idx == -1) {
            return;
        }
        this.#layers.splice(idx, 1);
    }
}

/**
 * Canvas style last written within one layer's render pass.
 *
 * Scoped to the layer, not the frame: Canvas2dRenderLayer.render brackets each
 * layer in save()/restore(), which resets the context, so frame-wide tracking
 * would go stale at every layer boundary.
 */
type CanvasStyleState = {
    fill: string | null;
    stroke: string | null;
    line_width: number | null;
};

class DrawCommand {
    public path_count = 1;

    constructor(
        public path: Path2D,
        public fill: string | null,
        public stroke: string | null,
        public stroke_width: number,
    ) {}

    render(ctx: CanvasRenderingContext2D, state?: CanvasStyleState) {
        // Only touch the context state that this command actually uses, and
        // only when it differs from what the layer last set. Runs of same-
        // coloured geometry are the common case in both schematics and boards.
        if (this.fill) {
            if (!state || state.fill !== this.fill) {
                ctx.fillStyle = this.fill;
                if (state) state.fill = this.fill;
            }
            ctx.fill(this.path);
        }
        if (this.stroke) {
            if (!state || state.stroke !== this.stroke) {
                ctx.strokeStyle = this.stroke;
                if (state) state.stroke = this.stroke;
            }
            if (!state || state.line_width !== this.stroke_width) {
                ctx.lineWidth = this.stroke_width;
                if (state) state.line_width = this.stroke_width;
            }
            ctx.stroke(this.path);
        }
    }
}

class ImageCommand {
    constructor(
        public img: HTMLImageElement,
        public src_bbox: BBox,
        public dest_bbox: BBox,
    ) {}
    render(ctx: CanvasRenderingContext2D, _state?: CanvasStyleState) {
        ctx.drawImage(
            this.img,
            this.src_bbox.x,
            this.src_bbox.y,
            this.src_bbox.w,
            this.src_bbox.h,
            this.dest_bbox.x,
            this.dest_bbox.y,
            this.dest_bbox.w,
            this.dest_bbox.h,
        );
    }
}

class Canvas2dRenderLayer extends RenderLayer {
    constructor(
        public override readonly renderer: Renderer,
        public override readonly name: string,
        public commands: {
            render: (
                ctx: CanvasRenderingContext2D,
                state?: CanvasStyleState,
            ) => void;
        }[] = [],
    ) {
        super(renderer, name);
    }

    override dispose(): void {
        this.clear();
    }

    clear() {
        this.commands = [];
    }

    render(transform: Matrix3, depth: number, global_alpha = 1) {
        const ctx = (this.renderer as Canvas2DRenderer).ctx2d;

        if (!ctx) {
            throw new Error("No CanvasRenderingContext2D!");
        }

        ctx.save();

        ctx.globalCompositeOperation = this.composite_operation;
        ctx.globalAlpha = global_alpha;

        const accumulated_transform = (
            this.renderer as Canvas2DRenderer
        ).base_transform.copy();
        accumulated_transform.multiply_self(transform);
        ctx.setTransform(accumulated_transform.to_DOMMatrix());

        const style: CanvasStyleState = {
            fill: null,
            stroke: null,
            line_width: null,
        };
        for (const command of this.commands) {
            command.render(ctx, style);
        }

        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.restore();
    }
}
