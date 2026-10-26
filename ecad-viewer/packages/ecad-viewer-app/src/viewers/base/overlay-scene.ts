import { BBox, Vec2 } from "../../base/math";
import { Color, Polygon, Polyline, type Renderer } from "../../graphics";
import { StrokeFont, TextAttributes } from "../../kicad/text";
import type { ExtensionLayerPlacement, ViewLayerSet } from "./view-layers";

export type EcadOverlayContext = "SCH" | "PCB";
export type EcadOverlayPlacement = ExtensionLayerPlacement;

export type EcadOverlayAnchor =
    | { kind: "world"; x: number; y: number; page?: string }
    | { kind: "bbox"; bounds: [number, number, number, number]; page?: string }
    | {
          kind: "source-item";
          uuid: string;
          page?: string;
          relativePoint?: [number, number];
      }
    | {
          kind: "entity";
          reference?: string;
          net?: string;
          pin?: string;
          page?: string;
      };

export type EcadOverlayStyle = {
    sizing?: "world" | "screen";
    stroke?: string;
    fill?: string;
    opacity?: number;
    strokeWidth?: number;
    dash?: number[];
    dashOffset?: number;
    fitAdaptiveStroke?: boolean;
    blend?: GlobalCompositeOperation;
};

type OverlayPrimitiveBase = EcadOverlayStyle & {
    id: string;
    anchor: EcadOverlayAnchor;
    interactive?: boolean;
    metadata?: unknown;
    accessibilityLabel?: string;
};

export type MarkerPrimitive = OverlayPrimitiveBase & {
    kind: "marker";
    radius?: number;
    /**
     * Visual glyph used to render the marker. Defaults to "circle" for
     * backward compatibility. "comment" paints a translucent sticky-note
     * icon (no text/ID drawn) suitable for comment/annotation pins.
     */
    glyph?: "circle" | "comment";
};
export type BBoxPrimitive = OverlayPrimitiveBase & {
    kind: "bbox";
    padding?: number;
};
export type PolylinePrimitive = OverlayPrimitiveBase & {
    kind: "polyline";
    points: Array<[number, number]>;
};
export type PolygonPrimitive = OverlayPrimitiveBase & {
    kind: "polygon";
    points: Array<[number, number]>;
};
export type TextPrimitive = OverlayPrimitiveBase & {
    kind: "text";
    text: string;
    size?: number;
};

export type EcadOverlayPrimitive =
    | MarkerPrimitive
    | BBoxPrimitive
    | PolylinePrimitive
    | PolygonPrimitive
    | TextPrimitive;

export type EcadOverlayScene = {
    channelId: string;
    context: EcadOverlayContext;
    placement: EcadOverlayPlacement;
    visible: boolean;
    primitives: EcadOverlayPrimitive[];
};

export type ResolvedOverlayAnchor = {
    point: Vec2;
    bounds?: BBox;
    page?: string;
};

export type OverlayAnchorResolver = (
    anchor: EcadOverlayAnchor,
) => ResolvedOverlayAnchor | null;

export type OverlayHit = {
    channelId: string;
    primitiveId: string;
    resolvedAnchor: {
        x: number;
        y: number;
        bounds?: [number, number, number, number];
        page?: string;
    };
    context: EcadOverlayContext;
    metadata?: unknown;
};

type CompiledPrimitive = {
    scene: EcadOverlayScene;
    primitive: EcadOverlayPrimitive;
    anchor: ResolvedOverlayAnchor;
    bounds: BBox;
};

const GRID_SIZE = 20;

export function fit_adaptive_stroke_width(
    base_width: number,
    zoom: number,
    fit_zoom: number,
): number {
    const ratio = zoom / Math.max(fit_zoom, 0.0001);
    if (ratio <= 1) return 5;
    if (ratio >= 3) return base_width;
    return 5 - ((ratio - 1) / 2) * (5 - base_width);
}

export class OverlaySceneManager {
    #scenes = new Map<string, { signature: string; scene: EcadOverlayScene }>();
    #compiled = new Map<string, CompiledPrimitive[]>();
    #hit_grid = new Map<string, CompiledPrimitive[]>();
    #last_zoom = 0;

    constructor(
        private readonly renderer: Renderer,
        private layers: ViewLayerSet,
        private readonly resolve_anchor: OverlayAnchorResolver,
        private readonly get_zoom: () => number,
        private readonly get_fit_zoom: () => number,
    ) {}

    replace_layers(
        layers: ViewLayerSet,
        retained_channels: ReadonlySet<string> = new Set(),
    ) {
        if (this.layers === layers) return;
        this.layers = layers;
        for (const { scene } of this.#scenes.values()) {
            if (!retained_channels.has(scene.channelId)) {
                this.#compile(scene);
            }
        }
        this.#rebuild_hit_grid();
    }

    set_scene(scene: EcadOverlayScene, compile = true): boolean {
        const signature = JSON.stringify(scene);
        if (this.#scenes.get(scene.channelId)?.signature === signature)
            return false;
        if (compile) this.layers.clear_extension_layer(scene.channelId);
        this.#scenes.set(scene.channelId, { signature, scene });
        if (compile) this.#compile(scene);
        this.#rebuild_hit_grid();
        return true;
    }

    clear_scene(channel_id: string): boolean {
        if (!this.#scenes.delete(channel_id)) return false;
        this.#compiled.delete(channel_id);
        this.layers.clear_extension_layer(channel_id);
        this.#rebuild_hit_grid();
        return true;
    }

    refresh_screen_sized(): boolean {
        const zoom = this.get_zoom() || 1;
        if (Math.abs(zoom - this.#last_zoom) < 0.0001) return false;
        this.#last_zoom = zoom;
        let changed = false;
        for (const { scene } of this.#scenes.values()) {
            if (
                !scene.primitives.some(
                    (primitive) => primitive.sizing === "screen",
                )
            )
                continue;
            this.layers.clear_extension_layer(scene.channelId);
            this.#compile(scene);
            changed = true;
        }
        if (changed) this.#rebuild_hit_grid();
        return changed;
    }

    hit_test(point: Vec2): OverlayHit | null {
        const candidates = this.#hit_grid.get(this.#grid_key(point)) ?? [];
        for (let index = candidates.length - 1; index >= 0; index--) {
            const hit = candidates[index]!;
            if (!hit.bounds.contains_point(point)) continue;
            return this.#event_payload(hit);
        }
        return null;
    }

    #compile(scene: EcadOverlayScene) {
        const compiled: CompiledPrimitive[] = [];
        if (!scene.visible) {
            this.#compiled.set(scene.channelId, compiled);
            return;
        }
        const layer = this.layers.extension_layer(
            scene.channelId,
            scene.placement,
        );
        this.renderer.start_layer(layer.name);
        for (const primitive of scene.primitives) {
            const anchor = this.#resolve(primitive.anchor);
            if (!anchor) continue;
            const bounds = this.#paint(primitive, anchor);
            if (primitive.interactive)
                compiled.push({ scene, primitive, anchor, bounds });
        }
        layer.graphics = this.renderer.end_layer();
        layer.graphics.composite_operation =
            scene.primitives.find((primitive) => primitive.blend)?.blend ??
            "source-over";
        this.#compiled.set(scene.channelId, compiled);
    }

    #resolve(anchor: EcadOverlayAnchor): ResolvedOverlayAnchor | null {
        if (anchor.kind === "world") {
            return { point: new Vec2(anchor.x, anchor.y), page: anchor.page };
        }
        if (anchor.kind === "bbox") {
            const bounds = new BBox(...anchor.bounds);
            return { point: bounds.center, bounds, page: anchor.page };
        }
        return this.resolve_anchor(anchor);
    }

    #paint(
        primitive: EcadOverlayPrimitive,
        anchor: ResolvedOverlayAnchor,
    ): BBox {
        const zoom = Math.max(this.get_zoom() || 1, 0.0001);
        const scale = primitive.sizing === "screen" ? 1 / zoom : 1;
        const opacity = primitive.opacity ?? 1;
        const stroke = Color.from_css(
            primitive.stroke && primitive.stroke.trim()
                ? primitive.stroke
                : "#3388ffff",
        ).with_alpha(opacity);
        const fill = Color.from_css(
            primitive.fill && primitive.fill.trim()
                ? primitive.fill
                : "#3388ff33",
        ).with_alpha(opacity);
        const base_width = primitive.strokeWidth ?? 0.25;
        const fit_zoom = Math.max(this.get_fit_zoom() || zoom, 0.0001);
        const adaptive_width = primitive.fitAdaptiveStroke
            ? fit_adaptive_stroke_width(base_width, zoom, fit_zoom)
            : base_width;
        const width = adaptive_width * scale;
        if (primitive.kind === "marker") {
            const radius = (primitive.radius ?? 4) * scale;
            if (primitive.glyph === "comment") {
                this.#paint_comment_glyph(
                    anchor.point,
                    radius,
                    primitive,
                    opacity,
                );
            } else {
                this.renderer.circle(anchor.point, radius, fill);
            }
            return new BBox(
                anchor.point.x - radius,
                anchor.point.y - radius,
                radius * 2,
                radius * 2,
            );
        }
        if (primitive.kind === "bbox") {
            const padding = (primitive.padding ?? 0) * scale;
            const bounds = (
                anchor.bounds ?? new BBox(anchor.point.x, anchor.point.y, 0, 0)
            ).grow(padding);
            if (primitive.fill && primitive.fill.trim()) {
                this.renderer.polygon(Polygon.from_BBox(bounds, fill));
            }
            if (primitive.dash && primitive.dash.length) {
                this.#paint_dashed_rect(
                    bounds,
                    primitive.dash.map((segment) =>
                        Math.max(segment * scale, 0.01),
                    ),
                    width,
                    stroke,
                    (primitive.dashOffset ?? 0) * scale,
                );
            } else {
                this.renderer.line(Polyline.from_BBox(bounds, width, stroke));
            }
            return bounds.grow(width);
        }
        if (primitive.kind === "polyline") {
            const points = primitive.points.map(([x, y]) =>
                anchor.point.add(new Vec2(x, y)),
            );
            if (primitive.dash && primitive.dash.length) {
                this.#paint_dashed_polyline(
                    points,
                    primitive.dash.map((segment) =>
                        Math.max(segment * scale, 0.01),
                    ),
                    width,
                    stroke,
                    (primitive.dashOffset ?? 0) * scale,
                );
            } else {
                this.renderer.line(new Polyline(points, width, stroke));
            }
            return BBox.from_points(points).grow(width);
        }
        if (primitive.kind === "polygon") {
            const points = primitive.points.map(([x, y]) =>
                anchor.point.add(new Vec2(x, y)),
            );
            this.renderer.polygon(new Polygon(points, fill));
            if (points.length)
                this.renderer.line(
                    new Polyline([...points, points[0]!], width, stroke),
                );
            return BBox.from_points(points).grow(width);
        }
        const size = (primitive.size ?? 2) * scale;
        const attributes = new TextAttributes();
        attributes.size = new Vec2(size, size);
        attributes.stroke_width = Math.max(width, size * 0.08);
        attributes.color = stroke;
        StrokeFont.default().draw(
            this.renderer,
            primitive.text,
            anchor.point,
            attributes,
        );
        return new BBox(
            anchor.point.x - size,
            anchor.point.y - size,
            size * Math.max(2, primitive.text.length),
            size * 2,
        );
    }

    /**
     * Paints a rectangular outline as a dashed stroke by drawing short
     * solid polyline segments following the given on/off dash pattern
     * continuously around the perimeter (corners included).
     */
    #paint_dashed_rect(
        bounds: BBox,
        dash: number[],
        width: number,
        color: Color,
        offset = 0,
    ) {
        const corners = [
            bounds.top_left,
            bounds.top_right,
            bounds.bottom_right,
            bounds.bottom_left,
            bounds.top_left,
        ];
        this.#paint_dashed_polyline(corners, dash, width, color, offset);
    }

    #paint_dashed_polyline(
        points: Vec2[],
        dash: number[],
        width: number,
        color: Color,
        offset = 0,
    ) {
        const pattern = dash.length ? dash : [width * 4, width * 2];
        let pattern_index = 0;
        let remaining = pattern[0] ?? 1;
        let drawing = true;
        const cycle = pattern.reduce((sum, value) => sum + value, 0);
        let phase = cycle > 0 ? ((offset % cycle) + cycle) % cycle : 0;
        while (phase > 0 && pattern.length) {
            if (phase < remaining) {
                remaining -= phase;
                phase = 0;
            } else {
                phase -= remaining;
                pattern_index = (pattern_index + 1) % pattern.length;
                remaining = pattern[pattern_index] ?? 1;
                drawing = !drawing;
            }
        }
        for (let i = 0; i < points.length - 1; i++) {
            const start = points[i]!;
            const end = points[i + 1]!;
            const segment = end.sub(start);
            const segment_length = segment.magnitude;
            if (segment_length === 0) continue;
            const direction = segment.multiply(1 / segment_length);
            let travelled = 0;
            while (travelled < segment_length) {
                const step = Math.min(remaining, segment_length - travelled);
                if (drawing && step > 0) {
                    const seg_start = start.add(direction.multiply(travelled));
                    const seg_end = start.add(
                        direction.multiply(travelled + step),
                    );
                    this.renderer.line(
                        new Polyline([seg_start, seg_end], width, color),
                    );
                }
                travelled += step;
                remaining -= step;
                if (remaining <= 1e-6) {
                    pattern_index = (pattern_index + 1) % pattern.length;
                    remaining = pattern[pattern_index] ?? 1;
                    drawing = !drawing;
                }
            }
        }
    }

    /**
     * Paints a translucent sticky-note style icon: a rounded body with a
     * folded top-right corner and 2-3 horizontal "text" lines. Intentionally
     * never renders any text/ID inside the glyph.
     */
    #paint_comment_glyph(
        center: Vec2,
        size: number,
        primitive: MarkerPrimitive,
        opacity: number,
    ) {
        const fill = Color.from_css(primitive.fill ?? "#facc1580");
        fill.a *= opacity;
        const stroke = Color.from_css(primitive.stroke ?? "#ca8a04");
        stroke.a *= opacity;

        const half_w = size;
        const half_h = size * 0.85;
        const fold = size * 0.45;
        const line_width = Math.max(size * 0.08, 0.05);

        const top_left = new Vec2(center.x - half_w, center.y - half_h);
        const top_right = new Vec2(center.x + half_w, center.y - half_h);
        const bottom_right = new Vec2(center.x + half_w, center.y + half_h);
        const bottom_left = new Vec2(center.x - half_w, center.y + half_h);

        const fold_top = new Vec2(top_right.x - fold, top_right.y);
        const fold_side = new Vec2(top_right.x, top_right.y + fold);

        const body_points = [
            top_left,
            fold_top,
            fold_side,
            bottom_right,
            bottom_left,
        ];

        this.renderer.polygon(new Polygon(body_points, fill));
        this.renderer.line(
            new Polyline([...body_points, top_left], line_width, stroke),
        );

        // Folded corner flap.
        this.renderer.polygon(
            new Polygon(
                [fold_top, top_right, fold_side],
                stroke.with_alpha(stroke.a * 0.35),
            ),
        );
        this.renderer.line(
            new Polyline([fold_top, fold_side], line_width, stroke),
        );

        // 2-3 horizontal "text" lines. No actual text/ID is drawn.
        const line_count = 3;
        const inner_left = center.x - half_w * 0.55;
        const inner_right = center.x + half_w * 0.55;
        const top_y = center.y - half_h * 0.25;
        const spacing = half_h * 0.4;
        for (let i = 0; i < line_count; i++) {
            const y = top_y + i * spacing;
            this.renderer.line(
                new Polyline(
                    [new Vec2(inner_left, y), new Vec2(inner_right, y)],
                    line_width * 0.8,
                    stroke,
                ),
            );
        }
    }

    #grid_key(point: Vec2) {
        return `${Math.floor(point.x / GRID_SIZE)}:${Math.floor(point.y / GRID_SIZE)}`;
    }

    #rebuild_hit_grid() {
        this.#hit_grid.clear();
        for (const compiled of this.#compiled.values()) {
            for (const hit of compiled) {
                const min_x = Math.floor(hit.bounds.x / GRID_SIZE);
                const max_x = Math.floor(hit.bounds.x2 / GRID_SIZE);
                const min_y = Math.floor(hit.bounds.y / GRID_SIZE);
                const max_y = Math.floor(hit.bounds.y2 / GRID_SIZE);
                for (let x = min_x; x <= max_x; x++) {
                    for (let y = min_y; y <= max_y; y++) {
                        const key = `${x}:${y}`;
                        const bucket = this.#hit_grid.get(key) ?? [];
                        bucket.push(hit);
                        this.#hit_grid.set(key, bucket);
                    }
                }
            }
        }
    }

    #event_payload(hit: CompiledPrimitive): OverlayHit {
        const bounds = hit.anchor.bounds;
        return {
            channelId: hit.scene.channelId,
            primitiveId: hit.primitive.id,
            context: hit.scene.context,
            metadata: hit.primitive.metadata,
            resolvedAnchor: {
                x: hit.anchor.point.x,
                y: hit.anchor.point.y,
                bounds: bounds
                    ? [bounds.x, bounds.y, bounds.w, bounds.h]
                    : undefined,
                page: hit.anchor.page,
            },
        };
    }
}
