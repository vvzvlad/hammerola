/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Vec2 } from "./vec2";
import { Matrix3 } from "./matrix3";
import { Angle, type AngleLike } from "./angle";
import { BBox } from "./bbox";

export interface CameraViewportInsets {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

const empty_viewport_insets = (): CameraViewportInsets => ({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
});

/**
 * A camera in 2d space.
 *
 * This manages the minimal state required to pan, zoom, and rotate. It's
 * abstract and isn't integrated into any specific graphics backend. Use
 * .matrix to get the complete transformation matrix to pass to whichever
 * graphics backend you're using.
 */
export class Camera2 {
    #fit_insets = empty_viewport_insets();

    /**
     * Create a camera
     * @param {Vec2} viewport_size - The width and height of the viewport
     * @param {Vec2} center - The point at which the camera's view is centered
     * @param {number} zoom - Scale factor, increasing numbers zoom the camera in.
     * @param {number|Angle} rotation - Rotation (roll) in radians.
     */
    constructor(
        public viewport_size: Vec2 = new Vec2(0, 0),
        public center: Vec2 = new Vec2(0, 0),
        public zoom: number = 1,
        public rotation: Angle = new Angle(0),
    ) {}

    public get fit_insets(): CameraViewportInsets {
        return { ...this.#fit_insets };
    }

    public set fit_insets(value: Partial<CameraViewportInsets> | null) {
        const non_negative = (candidate: number | undefined) =>
            Math.max(0, Number.isFinite(candidate) ? (candidate ?? 0) : 0);
        this.#fit_insets = {
            left: non_negative(value?.left),
            right: non_negative(value?.right),
            top: non_negative(value?.top),
            bottom: non_negative(value?.bottom),
        };
    }

    /** Screen-space center of the unobscured viewport used by bbox fitting. */
    public get fit_viewport_center(): Vec2 {
        const available = this.fit_viewport_size;
        return new Vec2(
            this.#fit_insets.left + available.x / 2,
            this.#fit_insets.top + available.y / 2,
        );
    }

    /** Unobscured viewport size after host-owned overlay rails are removed. */
    public get fit_viewport_size(): Vec2 {
        return new Vec2(
            Math.max(
                1,
                this.viewport_size.x -
                    this.#fit_insets.left -
                    this.#fit_insets.right,
            ),
            Math.max(
                1,
                this.viewport_size.y -
                    this.#fit_insets.top -
                    this.#fit_insets.bottom,
            ),
        );
    }

    public zoom_for_bbox(bbox: BBox): number {
        const available = this.fit_viewport_size;
        return Math.min(available.x / bbox.w, available.y / bbox.h);
    }

    /**
     * Relative translation
     * @param v
     */
    translate(v: Vec2) {
        this.center.x += v.x;
        this.center.y += v.y;
    }

    /**
     * Relative rotation
     * @param {Angle|number} a - rotation in radians
     */
    rotate(a: AngleLike) {
        this.rotation = this.rotation.add(a);
    }

    /**
     * Complete transformation matrix.
     */
    get matrix(): Matrix3 {
        const mx = this.viewport_size.x / 2;
        const my = this.viewport_size.y / 2;
        const dx = this.center.x - this.center.x * this.zoom;
        const dy = this.center.y - this.center.y * this.zoom;
        const left = -(this.center.x - mx) + dx;
        const top = -(this.center.y - my) + dy;
        return Matrix3.translation(left, top)
            .rotate_self(this.rotation)
            .scale_self(this.zoom, this.zoom);
    }

    /**
     * Bounding box representing the camera's view
     * */
    get bbox(): BBox {
        const m = this.matrix.inverse();
        const start = m.transform(new Vec2(0, 0));
        const end = m.transform(
            new Vec2(this.viewport_size.x, this.viewport_size.y),
        );
        return new BBox(start.x, start.y, end.x - start.x, end.y - start.y);
    }

    /**
     * Move the camera and adjust zoom so that the given bounding box is in
     * view.
     */
    set bbox(bbox: BBox) {
        // Fitting before the canvas has a real layout box yields zoom=0
        // (0/bbox) and permanently blank draws until something fits again.
        if (
            this.viewport_size.x <= 0 ||
            this.viewport_size.y <= 0 ||
            !Number.isFinite(bbox.w) ||
            !Number.isFinite(bbox.h) ||
            bbox.w <= 0 ||
            bbox.h <= 0
        ) {
            return;
        }
        const fit_center = this.fit_viewport_center;
        const center_x = bbox.x + bbox.w / 2;
        const center_y = bbox.y + bbox.h / 2;
        this.zoom = this.zoom_for_bbox(bbox);
        // The camera matrix still spans the full canvas. Offset its world
        // center so the fitted object lands in the visible region between
        // host-owned overlay rails rather than underneath them.
        this.center.set(
            center_x + (this.viewport_size.x / 2 - fit_center.x) / this.zoom,
            center_y + (this.viewport_size.y / 2 - fit_center.y) / this.zoom,
        );
    }

    get top() {
        return this.bbox.y;
    }

    get bottom() {
        return this.bbox.y2;
    }

    get left() {
        return this.bbox.x;
    }

    get right() {
        return this.bbox.x2;
    }

    /**
     * Apply this camera to a 2d canvas
     *
     * A simple convenience method that sets the canvas's transform to
     * the camera's transformation matrix.
     */
    apply_to_canvas(ctx: CanvasRenderingContext2D) {
        this.viewport_size.set(ctx.canvas.clientWidth, ctx.canvas.clientHeight);
        const m = Matrix3.from_DOMMatrix(ctx.getTransform());
        m.multiply_self(this.matrix);
        ctx.setTransform(m.to_DOMMatrix());
    }

    /**
     * Transform screen coordinates to world coordinates
     */
    screen_to_world(v: Vec2): Vec2 {
        return this.matrix.inverse().transform(v);
    }

    /**
     * Transform world coordinates to screen coordinates
     */
    world_to_screen(v: Vec2): Vec2 {
        return this.matrix.transform(v);
    }
}
