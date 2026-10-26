/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Barrier } from "../../base/async";
import { Disposables, type IDisposable } from "../../base/disposable";
import { listen } from "../../base/events";
import { BBox, Vec2, type CameraViewportInsets } from "../../base/math";
import type {
    MoveAndZoomOptions,
    WheelNavigationMode,
} from "../../base/dom/move-and-zoom";
import { Renderer } from "../../graphics";
import {
    EcadCommentAreaEvent,
    EcadOverlayClickEvent,
    EcadOverlayHoverEvent,
    EcadOverlayLeaveEvent,
    KiCanvasLoadEvent,
    KiCanvasMouseMoveEvent,
    type KiCanvasEventMap,
} from "./events";
import {
    OverlaySceneManager,
    type EcadOverlayAnchor,
    type EcadOverlayScene,
    type OverlayHit,
    type ResolvedOverlayAnchor,
} from "./overlay-scene";
import { ViewLayerSet } from "./view-layers";
import { Viewport } from "./viewport";

export enum ViewerType {
    SCHEMATIC,
    PCB,
}

export type ViewerNavigationOptions = MoveAndZoomOptions;
export type ViewerWheelMode = WheelNavigationMode;
export type ProbeHighlightState = "hover" | "latched";

export interface ViewerInteractionOptions {
    selectable?: boolean;
    navigation?: Partial<ViewerNavigationOptions>;
}

export type ViewerInteraction = boolean | ViewerInteractionOptions;

const legacy_navigation: ViewerNavigationOptions = {
    wheel: "direct",
    pinch: true,
    touchPan: true,
    drag: true,
};

const disabled_navigation: ViewerNavigationOptions = {
    wheel: "disabled",
    pinch: false,
    touchPan: false,
    drag: false,
};

export function resolve_viewer_interaction(interaction: ViewerInteraction): {
    selectable: boolean;
    navigation: ViewerNavigationOptions;
} {
    if (typeof interaction === "boolean") {
        return {
            selectable: interaction,
            navigation: interaction
                ? { ...legacy_navigation }
                : { ...disabled_navigation },
        };
    }
    return {
        selectable: interaction.selectable ?? false,
        navigation: {
            ...disabled_navigation,
            ...interaction.navigation,
        },
    };
}

/** Whether any navigation gesture can move the camera. */
function navigation_enabled(navigation: ViewerNavigationOptions): boolean {
    return (
        navigation.wheel !== "disabled" ||
        navigation.pinch ||
        navigation.touchPan ||
        navigation.drag
    );
}

const LIBRARY_CROSS_PROBE_CHANNEL = "library-crossprobe";

const COMMENT_AREA_PREVIEW_CHANNEL = "__comment-area-preview__";
const MIN_COMMENT_AREA_SIZE = 0.5;

export abstract class Viewer extends EventTarget {
    public renderer: Renderer;
    public viewport: Viewport;
    public layers: ViewLayerSet;
    #mouse_position: Vec2 = new Vec2(0, 0);
    #mouse_client_pos: Vec2 = new Vec2(0, 0);
    #page_mouse_pos: Vec2 = new Vec2(0, 0);
    #active = true;
    #draw_frame: number | null = null;
    #hover_frame: number | null = null;
    #overlay_scenes: OverlaySceneManager | null = null;
    #overlay_hover: OverlayHit | null = null;
    #comment_mode = false;
    #comment_drag_start: Vec2 | null = null;

    get client_mouse_pos(): Vec2 {
        return this.#mouse_client_pos;
    }

    get page_mouse_pos(): Vec2 {
        return this.#page_mouse_pos;
    }

    public get active(): boolean {
        return this.#active;
    }

    public loaded = new Barrier();

    abstract type: ViewerType;

    public static MinZoom = 0.5;
    public static MaxZoom = 190;

    protected disposables = new Disposables();
    protected setup_finished = new Barrier();

    constructor(
        public canvas: HTMLCanvasElement,
        interaction: ViewerInteraction = true,
    ) {
        super();
        this.interaction = resolve_viewer_interaction(interaction);
    }

    protected readonly interaction: {
        selectable: boolean;
        navigation: ViewerNavigationOptions;
    };

    dispose() {
        this.#active = false;
        if (this.#draw_frame !== null) cancelAnimationFrame(this.#draw_frame);
        if (this.#hover_frame !== null) cancelAnimationFrame(this.#hover_frame);
        this.#draw_frame = null;
        this.#hover_frame = null;
        this.disposables.dispose();
    }

    public set_active(active: boolean) {
        if (this.#active === active) return;
        this.#active = active;
        if (!active) {
            if (this.#draw_frame !== null)
                cancelAnimationFrame(this.#draw_frame);
            if (this.#hover_frame !== null)
                cancelAnimationFrame(this.#hover_frame);
            this.#draw_frame = null;
            this.#hover_frame = null;
            return;
        }
        this.draw();
    }

    override addEventListener<K extends keyof KiCanvasEventMap>(
        type: K,
        listener:
            | ((this: Viewer, ev: KiCanvasEventMap[K]) => void)
            | { handleEvent: (ev: KiCanvasEventMap[K]) => void }
            | null,
        options?: boolean | AddEventListenerOptions,
    ): IDisposable;
    override addEventListener(
        type: string,
        listener: EventListener | null,
        options?: boolean | AddEventListenerOptions,
    ): IDisposable {
        super.addEventListener(type, listener, options);
        return {
            dispose: () => {
                this.removeEventListener(type, listener, options);
            },
        };
    }

    protected abstract create_renderer(canvas: HTMLCanvasElement): Renderer;

    async setup() {
        this.renderer = this.disposables.add(this.create_renderer(this.canvas));

        // When the canvas resizes (ResizeObserver, async), rebuild the scene if
        // needed then redraw. Cold loads often paint before the host layout box
        // is known (canvas 0×0 or default 300×150); draw-only leaves a blank
        // or wrong-resolution scene after the first real resize.
        this.renderer.on_resize = () => this.on_canvas_resize();

        await this.renderer.setup();

        this.viewport = this.disposables.add(
            new Viewport(this.renderer, () => {
                this.on_viewport_change();
            }),
        );

        const navigation = this.interaction.navigation;
        if (navigation_enabled(navigation)) {
            this.viewport.enable_pan_and_zoom(
                Viewer.MinZoom,
                Viewer.MaxZoom,
                () => this.#active,
                navigation,
            );
            // Comment mode draws its rubber band with the left button, so only
            // that button is withheld from panning while it is on.
            this.viewport.drag_filter = (e) =>
                !(this.#comment_mode && e.button === 0);
        }

        if (this.interaction.selectable) {
            this.disposables.add(
                listen(this.canvas, "mousemove", (e) => {
                    this.on_mouse_change(e);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "mouseleave", () => {
                    if (this.#hover_frame !== null) {
                        cancelAnimationFrame(this.#hover_frame);
                        this.#hover_frame = null;
                    }
                    this.on_pointer_leave();
                }),
            );

            this.disposables.add(
                listen(this.canvas, "panzoom", (e) => {
                    this.on_mouse_change(e as MouseEvent);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "click", (e) => {
                    if (!this.#active) return;
                    if (this.#comment_mode) return;
                    const overlay = this.#overlay_scenes?.hit_test(
                        this.#mouse_position,
                    );
                    if (overlay) {
                        this.dispatchEvent(new EcadOverlayClickEvent(overlay));
                        return;
                    }
                    this.on_click(this.#mouse_position, e);
                }),
            );

            this.disposables.add(
                listen(this.canvas, "dblclick", (e) => {
                    if (!this.#active) return;
                    if (this.#comment_mode) return;
                    this.on_dblclick(this.#mouse_position);
                }),
            );
            this.disposables.add(
                listen(document, "click", () => {
                    if (this.#active) this.on_document_clicked();
                }),
            );

            this.disposables.add(
                listen(this.canvas, "mousedown", (e) => {
                    if (!this.#active || !this.#comment_mode) return;
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Refresh world position from this event before capturing
                    // the drag start, in case the pointer hasn't moved yet.
                    this.on_mouse_change(e);
                    this.#comment_drag_start = this.#mouse_position.copy();
                    this.#update_comment_area_preview();
                }),
            );

            this.disposables.add(
                listen(window, "mouseup", (e) => {
                    if (!this.#comment_mode || !this.#comment_drag_start)
                        return;
                    if (e instanceof MouseEvent) {
                        this.on_mouse_change(e);
                    }
                    this.#finish_comment_area();
                }),
            );
        }

        this.setup_finished.open();
    }

    protected on_viewport_change() {
        // SizeObserver updates camera.viewport_size but does not fire window
        // resize — drop the cached hit-test rect so mouse mapping stays aligned.
        this.#cached_rect = null;
        if (!this.#active) return;
        this.#overlay_scenes?.refresh_screen_sized();
        if (navigation_enabled(this.interaction.navigation)) {
            this.draw();
        }
    }

    public zoom_by(factor: number): void {
        if (!Number.isFinite(factor) || factor <= 0 || !this.viewport) return;
        this.viewport.camera.zoom = Math.min(
            Viewer.MaxZoom,
            Math.max(Viewer.MinZoom, this.viewport.camera.zoom * factor),
        );
        this.draw();
    }

    public reset_view(): void {
        this.zoom_fit_top_item();
    }

    protected probe_bounds(_index: string): BBox[] {
        return [];
    }

    public set_probe_highlight(
        index: string,
        state: ProbeHighlightState,
    ): number {
        const bounds = this.probe_bounds(index);
        if (!bounds.length) {
            this.clear_probe_highlight();
            return 0;
        }
        this.set_overlay_scene({
            channelId: LIBRARY_CROSS_PROBE_CHANNEL,
            context: this.type === ViewerType.SCHEMATIC ? "SCH" : "PCB",
            placement: "foreground",
            visible: true,
            primitives: bounds.map((bbox, position) => ({
                id: `${index}:${position}`,
                kind: "bbox" as const,
                anchor: {
                    kind: "bbox" as const,
                    bounds: [bbox.x, bbox.y, bbox.w, bbox.h] as [
                        number,
                        number,
                        number,
                        number,
                    ],
                },
                sizing: "screen" as const,
                stroke: state === "latched" ? "#0891b2" : "#22d3ee",
                opacity: state === "latched" ? 1 : 0.82,
                strokeWidth: state === "latched" ? 3 : 2,
                dash: state === "hover" ? [5, 3] : undefined,
                padding: 3,
            })),
        });
        return bounds.length;
    }

    public clear_probe_highlight(): void {
        this.clear_overlay_scene(LIBRARY_CROSS_PROBE_CHANNEL);
    }

    public notify_viewport_change(): void {
        this.on_viewport_change();
    }

    /**
     * Reserve screen-space edges for host-owned overlay rails without
     * changing the canvas layout box. The current visible focal point is kept
     * centered in the remaining safe area and the retained scene is redrawn.
     */
    public set_viewport_insets(
        insets: Partial<CameraViewportInsets> | null,
    ): void {
        const camera = this.viewport?.camera;
        if (!camera) return;
        const normalized = {
            left: Math.max(0, insets?.left ?? 0),
            right: Math.max(0, insets?.right ?? 0),
            top: Math.max(0, insets?.top ?? 0),
            bottom: Math.max(0, insets?.bottom ?? 0),
        };
        const current = camera.fit_insets;
        if (
            current.left === normalized.left &&
            current.right === normalized.right &&
            current.top === normalized.top &&
            current.bottom === normalized.bottom
        ) {
            return;
        }
        const viewport = camera.viewport_size;
        const can_preserve =
            viewport.x > 0 &&
            viewport.y > 0 &&
            Number.isFinite(camera.zoom) &&
            camera.zoom > 0;
        const focal = can_preserve
            ? camera.screen_to_world(camera.fit_viewport_center)
            : null;

        camera.fit_insets = normalized;
        if (focal) {
            const safe_center = camera.fit_viewport_center;
            camera.center.set(
                focal.x + (viewport.x / 2 - safe_center.x) / camera.zoom,
                focal.y + (viewport.y / 2 - safe_center.y) / camera.zoom,
            );
        }
        this.#cached_rect = null;
        this.draw();
    }

    #cached_rect: DOMRect | null = null;
    #rect_invalidator_installed = false;

    #get_canvas_rect(): DOMRect {
        if (!this.#rect_invalidator_installed) {
            this.#rect_invalidator_installed = true;
            const inval = () => {
                this.#cached_rect = null;
            };
            window.addEventListener("scroll", inval, {
                passive: true,
                capture: true,
            });
            window.addEventListener("resize", inval, { passive: true });
        }
        if (this.#cached_rect === null) {
            this.#cached_rect = this.canvas.getBoundingClientRect();
        }
        return this.#cached_rect;
    }

    protected on_mouse_change(e: MouseEvent) {
        if (!this.#active) return;
        const rect = this.#get_canvas_rect();
        this.#mouse_client_pos = new Vec2(e.clientX, e.clientY);
        this.#page_mouse_pos = new Vec2(e.pageX, e.pageY);
        const new_position = this.viewport.camera.screen_to_world(
            new Vec2(e.clientX - rect.left, e.clientY - rect.top),
        );
        if (
            this.#mouse_position.x != new_position.x ||
            this.#mouse_position.y != new_position.y
        ) {
            this.#mouse_position.set(new_position);
            if (this.#comment_mode && this.#comment_drag_start) {
                this.#update_comment_area_preview();
            } else {
                this.#update_overlay_hover();
            }
            this.dispatchEvent(
                new KiCanvasMouseMoveEvent(this.#mouse_position),
            );
            // Skip hover hit-test while dragging/panning; coalesce to one/frame.
            const is_dragging = e.buttons !== 0;
            if (!is_dragging && this.#hover_frame === null) {
                this.#hover_frame = requestAnimationFrame(() => {
                    this.#hover_frame = null;
                    if (this.#active) this.on_hover(this.#mouse_position);
                });
            }
        }
    }

    #update_overlay_hover() {
        const next =
            this.#overlay_scenes?.hit_test(this.#mouse_position) ?? null;
        if (
            next?.channelId === this.#overlay_hover?.channelId &&
            next?.primitiveId === this.#overlay_hover?.primitiveId
        ) {
            return;
        }
        if (this.#overlay_hover) {
            this.dispatchEvent(new EcadOverlayLeaveEvent(this.#overlay_hover));
        }
        this.#overlay_hover = next;
        if (next) this.dispatchEvent(new EcadOverlayHoverEvent(next));
    }

    protected resolve_overlay_anchor(
        _anchor: EcadOverlayAnchor,
    ): ResolvedOverlayAnchor | null {
        return null;
    }

    /** Allow the host's narrow comment API to report missing source anchors. */
    public resolve_overlay_anchor_for_host(
        anchor: EcadOverlayAnchor,
    ): ResolvedOverlayAnchor | null {
        return this.resolve_overlay_anchor(anchor);
    }

    protected rebind_overlay_layers(
        retained_channels: ReadonlySet<string> = new Set(),
    ) {
        this.#overlay_scenes?.replace_layers(this.layers, retained_channels);
    }

    /** Zoom used by fit-normalized screen-space comparison emphasis. */
    public get fit_zoom(): number {
        return this.viewport?.camera.zoom ?? 1;
    }

    public set_overlay_scene(
        scene: EcadOverlayScene,
        draw = true,
        compile = true,
    ) {
        if (!this.layers) return false;
        this.#overlay_scenes ??= new OverlaySceneManager(
            this.renderer,
            this.layers,
            (anchor) => this.resolve_overlay_anchor(anchor),
            () => this.viewport?.camera.zoom ?? 1,
            () => this.fit_zoom,
        );
        const changed = this.#overlay_scenes.set_scene(scene, compile);
        if (changed && draw) this.draw();
        return changed;
    }

    public clear_overlay_scene(channel_id: string) {
        const changed = this.#overlay_scenes?.clear_scene(channel_id) ?? false;
        if (changed) this.draw();
        return changed;
    }

    public get comment_mode(): boolean {
        return this.#comment_mode;
    }

    /**
     * Enable or disable comment mode. While enabled, dragging on the
     * canvas draws a rubber-band selection and emits an
     * `EcadCommentAreaEvent` on mouseup instead of performing normal
     * item selection.
     */
    public set_comment_mode(enabled: boolean): void {
        if (this.#comment_mode === enabled) return;
        this.#comment_mode = enabled;
        if (this.canvas) {
            this.canvas.style.cursor = enabled ? "crosshair" : "";
        }
        if (!enabled) {
            this.#comment_drag_start = null;
            this.clear_overlay_scene(COMMENT_AREA_PREVIEW_CHANNEL);
        }
    }

    #update_comment_area_preview() {
        if (!this.#comment_drag_start) return;
        const start = this.#comment_drag_start;
        const end = this.#mouse_position;
        const bounds: [number, number, number, number] = [
            Math.min(start.x, end.x),
            Math.min(start.y, end.y),
            Math.abs(end.x - start.x),
            Math.abs(end.y - start.y),
        ];
        this.set_overlay_scene({
            channelId: COMMENT_AREA_PREVIEW_CHANNEL,
            context: this.type === ViewerType.SCHEMATIC ? "SCH" : "PCB",
            placement: "foreground",
            visible: true,
            primitives: [
                {
                    id: "comment-area-preview",
                    kind: "bbox",
                    anchor: { kind: "bbox", bounds },
                    stroke: "#ca8a04",
                    fill: "#facc1533",
                    strokeWidth: 0.25,
                    dash: [2, 1.2],
                },
            ],
        });
    }

    #finish_comment_area() {
        const start = this.#comment_drag_start;
        this.#comment_drag_start = null;
        this.clear_overlay_scene(COMMENT_AREA_PREVIEW_CHANNEL);
        if (!start) return;
        const end = this.#mouse_position;
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        if (w < MIN_COMMENT_AREA_SIZE || h < MIN_COMMENT_AREA_SIZE) return;
        const bounds: [number, number, number, number] = [
            Math.min(start.x, end.x),
            Math.min(start.y, end.y),
            w,
            h,
        ];
        this.dispatchEvent(
            new EcadCommentAreaEvent({
                context: this.type === ViewerType.SCHEMATIC ? "SCH" : "PCB",
                x: bounds[0] + w / 2,
                y: bounds[1] + h / 2,
                bounds,
            }),
        );
    }

    public abstract load(src: any): Promise<void>;

    protected resolve_loaded(value: boolean) {
        if (value) {
            this.loaded.open();
            this.dispatchEvent(new KiCanvasLoadEvent());
        }
    }

    public abstract paint(): void;

    /**
     * Canvas backing-store size changed. Default is draw-only; DocumentViewer
     * re-paints so cold loads that raced layout still settle correctly.
     */
    protected on_canvas_resize(): void {
        if (this.disposables.isDisposed) return;
        this.draw();
    }

    protected on_document_clicked(): void {}

    protected on_draw() {
        this.renderer.clear_canvas();

        if (!this.layers) {
            return;
        }

        // Render all layers in display order (back to front). Allocate the
        // available clip-space depth across the layers that will actually be
        // drawn. A fixed increment overflows once zoom-dependent label layers
        // take a dense board past 100 drawable layers, clipping late overlays
        // such as the selected-net pass while leaving its dim pass visible.
        const display_layers = Array.from(this.layers.in_display_order());
        const drawable_layer_count = display_layers.reduce(
            (count, layer) => count + (layer.visible && layer.graphics ? 1 : 0),
            0,
        );
        const depth_step = 0.98 / Math.max(1, drawable_layer_count);
        let depth = depth_step;
        const camera = this.viewport.camera.matrix;
        const should_dim = this.layers.is_any_layer_highlighted();

        // Skip blending for fully-opaque layers (same visual, less GPU work).
        const gl = (this.renderer as unknown as { gl?: WebGL2RenderingContext })
            .gl;
        let blend_off = false;

        for (const layer of display_layers) {
            if (layer.visible && layer.graphics) {
                let alpha = layer.opacity;

                if (should_dim && !layer.highlighted) {
                    alpha = 0.25;
                }

                if (gl) {
                    const is_opaque = alpha >= 0.999;
                    if (is_opaque && !blend_off) {
                        gl.disable(gl.BLEND);
                        blend_off = true;
                    } else if (!is_opaque && blend_off) {
                        gl.enable(gl.BLEND);
                        blend_off = false;
                    }
                }

                layer.graphics.render(camera, depth, alpha);
                depth += depth_step;
            }
        }
        if (blend_off && gl) {
            gl.enable(gl.BLEND);
        }
    }

    /**
     * Schedule a repaint. Cross-probe and host selection updates must paint even
     * when the viewer is host-inactive (hidden Prism tab); otherwise camera
     * state updates while highlight layers never reach the canvas.
     */
    public draw() {
        if (
            this.disposables.isDisposed ||
            !this.viewport ||
            this.#draw_frame !== null
        ) {
            return;
        }
        this.#draw_frame = window.requestAnimationFrame(() => {
            this.#draw_frame = null;
            if (this.disposables.isDisposed) return;
            this.on_draw();
        });
    }

    /** Immediate draw — used after unhide + zoom-fit so the first frame is not zoom=0. */
    public draw_now() {
        if (this.disposables.isDisposed || !this.viewport) return;
        if (this.#draw_frame !== null) {
            cancelAnimationFrame(this.#draw_frame);
            this.#draw_frame = null;
        }
        if (this.disposables.isDisposed) return;
        this.on_draw();
    }

    abstract zoom_fit_top_item(): void;

    abstract zoom_in(): void;

    abstract zoom_out(): void;

    abstract move(pos: Vec2): void;

    abstract on_hover(pos: Vec2): void;
    protected on_pointer_leave(): void {}

    abstract on_click(pos: Vec2, event?: MouseEvent): void;

    abstract on_dblclick(pos: Vec2): void;

    /**
     * Convert screen coordinates to world (board) coordinates.
     * Useful for external overlay positioning.
     */
    public screenToWorld(screenX: number, screenY: number): Vec2 {
        const rect = this.canvas.getBoundingClientRect();
        return this.viewport.camera.screen_to_world(
            new Vec2(screenX - rect.left, screenY - rect.top),
        );
    }

    /**
     * Convert world (board) coordinates to screen coordinates.
     * Useful for positioning overlays at specific board locations.
     */
    public worldToScreen(worldX: number, worldY: number): Vec2 {
        const rect = this.canvas.getBoundingClientRect();
        const screenPos = this.viewport.camera.world_to_screen(
            new Vec2(worldX, worldY),
        );
        return new Vec2(screenPos.x + rect.left, screenPos.y + rect.top);
    }
}
