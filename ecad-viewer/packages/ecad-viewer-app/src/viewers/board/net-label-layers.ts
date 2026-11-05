/*
    Zoom-driven net-name / pad-number label layers.

    The board scene is retained: `DocumentPainter` tessellates every layer once
    and `on_draw` only re-renders them with the camera matrix. Labels are the
    one board element with per-item zoom gates (KiCad's `ViewGetLOD`), so they
    get their own small dynamic layers, rebuilt the way `Grid` rebuilds the
    grid: only when the camera leaves the last cached region, the zoom leaves
    the band around the last rebuild, or an option changes. Panning inside
    the region and zooming inside the band cost nothing.
*/

import { BBox } from "../../base/math";
import { Color, Renderer, type RenderLayer } from "../../graphics";
import { KicadPCB } from "../../kicad";
import * as board_items from "../../kicad/board";
import { CopperLayerNames, LayerNames, LayerSet, ViewLayer } from "./layers";
import {
    DEFAULT_NET_LABEL_OPTIONS,
    MIN_GLYPH_PX,
    arc_label_layout,
    display_net_name,
    draw_label,
    min_glyph_height,
    pad_label_layer,
    pad_label_layout,
    pad_label_min_zoom,
    segment_label_layouts,
    track_label_min_zoom,
    via_label_layout,
    via_label_min_zoom,
    type LabelLayout,
    type NetLabelOptions,
} from "./net-label-painter";

type Candidate = {
    layer: string;
    min_zoom: number;
    bbox: BBox;
    net: number;
} & (
    | { kind: "pad"; pad: board_items.Pad }
    | { kind: "segment"; segment: board_items.LineSegment; name: string }
    | { kind: "arc"; arc: board_items.ArcSegment; name: string }
    | { kind: "via"; via: board_items.Via; name: string }
);

/** Extension layer that carries highlighted nets' labels above the dim pass. */
export const EMPHASIS_LABEL_CHANNEL = "net-label-emphasis";

function segment_bbox(
    a: { x: number; y: number },
    b: { x: number; y: number },
    width: number,
) {
    const r = width / 2;
    return new BBox(
        Math.min(a.x, b.x) - r,
        Math.min(a.y, b.y) - r,
        Math.abs(b.x - a.x) + width,
        Math.abs(b.y - a.y) + width,
    );
}

function bbox_intersects(a: BBox, b: BBox): boolean {
    return a.x <= b.x2 && a.x2 >= b.x && a.y <= b.y2 && a.y2 >= b.y;
}

/** What labels need from a camera: its zoom and the world box it shows. */
export interface LabelCamera {
    readonly zoom: number;
    readonly bbox: BBox;
}

export class NetLabelLayers {
    /**
     * The cache's zoom quantum. `min_zoom` is a continuous per-item value,
     * so comparing the global visible count (the old key) made almost every
     * wheel tick rebuild every label layer. Rebuilding only when the camera
     * leaves a zoom band costs at most one rebuild per band; labels pop in
     * at band boundaries, which is how KiCad's own LOD thresholds behave.
     */
    static readonly ZOOM_REBUILD_BAND = 1.25;

    #candidates: Candidate[] = [];
    #layers: ViewLayer[] = [];
    #copper_count = 0;
    #built = false;

    #last_region: BBox | null = null;
    #last_zoom: number | null = null;
    #last_options: NetLabelOptions | null = null;
    #last_copper_visible = false;
    #last_emphasis: string | null = null;

    #options: NetLabelOptions = { ...DEFAULT_NET_LABEL_OPTIONS };

    /**
     * Net codes whose labels are repeated on the foreground emphasis layer
     * while a highlight dims the board (issue #306). Null when no highlight
     * is active; the emphasis layer is then empty.
     */
    #emphasized_nets: ReadonlySet<number> | null = null;

    /**
     * A fork (an inset's labels) shares its parent's candidates, options and
     * emphasis, but keeps its own graphics instead of writing them into the
     * shared label layers.
     */
    #parent: NetLabelLayers | null = null;
    #detached = new Map<ViewLayer, RenderLayer>();

    constructor(
        public gfx: Renderer,
        public camera: LabelCamera,
        public board: KicadPCB,
        public layer_set: LayerSet,
    ) {}

    /** Labels for another view of the same scene (an inset). */
    fork(camera: LabelCamera): NetLabelLayers {
        if (!this.#built) this.#build_candidates();
        const fork = new NetLabelLayers(
            this.gfx,
            camera,
            this.board,
            this.layer_set,
        );
        fork.#parent = this;
        fork.#built = true;
        fork.#candidates = this.#candidates;
        fork.#layers = this.#layers;
        fork.#copper_count = this.#copper_count;
        return fork;
    }

    /**
     * Run `fn` with this fork's label graphics in the shared label layers,
     * then put the main view's back.
     */
    with_graphics<T>(fn: () => T): T {
        const layers = [...this.#layers, this.#emphasis_layer()];
        const saved = layers.map((layer) => layer.graphics);
        layers.forEach((layer) => (layer.graphics = this.#detached.get(layer)));
        try {
            return fn();
        } finally {
            layers.forEach((layer, i) => (layer.graphics = saved[i]));
        }
    }

    /** Free a fork's graphics. */
    dispose(): void {
        for (const graphics of this.#detached.values()) graphics.dispose();
        this.#detached.clear();
    }

    get options(): Readonly<NetLabelOptions> {
        return this.#parent?.options ?? this.#options;
    }

    set options(value: NetLabelOptions) {
        this.#options = { ...value };
    }

    get emphasized_nets(): ReadonlySet<number> | null {
        return this.#parent
            ? this.#parent.emphasized_nets
            : this.#emphasized_nets;
    }

    set emphasized_nets(nets: ReadonlySet<number> | null) {
        this.#emphasized_nets = nets && nets.size ? new Set(nets) : null;
    }

    /**
     * Rebuild key for the emphasis copy: the net set plus the label layers'
     * visibility, since the copy is painted once per rebuild and must follow
     * a layer the user hides or shows mid-highlight.
     */
    #emphasis_key(): string {
        const emphasized = this.emphasized_nets;
        if (!emphasized) return "";
        const nets = Array.from(emphasized).sort().join(",");
        const visible = this.#layers
            .map((layer) => (layer.visible ? "1" : "0"))
            .join("");
        return `${nets}|${visible}`;
    }

    #emphasis_layer(): ViewLayer {
        return this.layer_set.extension_layer(
            EMPHASIS_LABEL_CHANNEL,
            "foreground",
        );
    }

    /** Drop every label layer's graphics and force the next update to rebuild. */
    reset(): void {
        for (const layer of [...this.#layers, this.#emphasis_layer()])
            this.#set_graphics(layer, undefined);
        this.#last_region = null;
        this.#last_zoom = null;
        this.#last_options = null;
        this.#last_emphasis = null;
    }

    /**
     * Bring the label layers up to date with the camera and options. Cheap
     * when nothing relevant changed; call it before every draw.
     */
    update(): void {
        if (!this.#built) this.#build_candidates();

        const copper_visible = this.layer_set.is_any_copper_layer_visible();
        if (!copper_visible) {
            if (this.#last_copper_visible) this.reset();
            this.#last_copper_visible = false;
            return;
        }
        this.#last_copper_visible = true;

        const zoom = this.camera.zoom;
        const viewport = this.camera.bbox;
        const options = this.options;
        const band = NetLabelLayers.ZOOM_REBUILD_BAND;
        const emphasis = this.#emphasis_key();
        const options_changed =
            !this.#last_options ||
            this.#last_options.padNumbers !== options.padNumbers ||
            this.#last_options.padNetNames !== options.padNetNames ||
            this.#last_options.trackNetNames !== options.trackNetNames ||
            this.#last_emphasis !== emphasis;

        if (
            this.#last_region &&
            this.#last_zoom !== null &&
            zoom > this.#last_zoom / band &&
            zoom < this.#last_zoom * band &&
            this.#last_region.contains(viewport) &&
            !options_changed
        ) {
            return;
        }

        // Grow the region well beyond the viewport so panning stays inside
        // the cached labels and does not re-tessellate every frame. It is
        // recomputed on every rebuild: keeping an old (larger) region would
        // include every label on the board once zoomed in.
        const region = viewport.grow(viewport.w * 1.5, viewport.h * 1.5);
        this.#last_region = region;
        this.#last_zoom = zoom;
        this.#last_options = { ...options };
        this.#last_emphasis = emphasis;

        this.#repaint(zoom, region, this.#visible_count(zoom), options);
    }

    /**
     * Layout every label whose zoom gate passes right now, for tests and
     * tools. Exact per-item gating: inside a rebuild band the drawn layers
     * can lag this by up to `ZOOM_REBUILD_BAND`.
     */
    layouts(): Map<string, LabelLayout[]> {
        if (!this.#built) this.#build_candidates();
        const zoom = this.camera.zoom;
        const viewport = this.camera.bbox;
        const region = viewport.grow(viewport.w * 1.5, viewport.h * 1.5);
        const out = new Map<string, LabelLayout[]>();
        const count = this.#visible_count(zoom);
        for (let i = 0; i < count; i++) {
            const candidate = this.#candidates[i]!;
            if (!bbox_intersects(candidate.bbox, region)) continue;
            const layouts = this.#layouts_for(
                candidate,
                zoom,
                region,
                this.options,
            );
            if (layouts.length === 0) continue;
            const list = out.get(candidate.layer) ?? [];
            list.push(...layouts);
            out.set(candidate.layer, list);
        }
        return out;
    }

    #build_candidates(): void {
        this.#built = true;
        this.#layers = Array.from(this.layer_set.netname_layers()).filter(
            (layer) => layer !== undefined,
        );
        const layer_names = new Set(this.#layers.map((layer) => layer.name));

        this.#copper_count = this.board.layers.filter((layer) =>
            CopperLayerNames.includes(layer.canonical_name as LayerNames),
        ).length;

        const candidates: Candidate[] = [];

        for (const fp of this.board.footprints) {
            for (const pad of fp.pads) {
                if (!pad.number && !pad.net?.name) continue;
                const layer = pad_label_layer(pad);
                if (!layer || !layer_names.has(layer)) continue;
                const bbox = pad.bbox;
                if (!bbox.valid) continue;
                const layout = pad_label_layout(pad, true, true);
                if (!layout) continue;
                candidates.push({
                    kind: "pad",
                    layer,
                    min_zoom: Math.max(
                        pad_label_min_zoom(pad),
                        MIN_GLYPH_PX / min_glyph_height(layout),
                    ),
                    bbox,
                    net: pad.net?.number ?? 0,
                    pad,
                });
            }
        }

        const copper_label_layer = (layer: string) => `:${layer}:NetNames`;

        for (const item of this.board.segments) {
            const name = this.#net_name(item.net);
            if (!name) continue;
            const layer = copper_label_layer(item.layer);
            if (!layer_names.has(layer)) continue;
            const min_zoom = Math.max(
                track_label_min_zoom(item.width),
                MIN_GLYPH_PX / (item.width * 0.55),
            );
            if (item instanceof board_items.ArcSegment) {
                candidates.push({
                    kind: "arc",
                    layer,
                    min_zoom,
                    bbox: BBox.from_points([
                        item.start,
                        item.mid,
                        item.end,
                    ]).grow(item.width),
                    net: item.net,
                    arc: item,
                    name,
                });
            } else {
                candidates.push({
                    kind: "segment",
                    layer,
                    min_zoom,
                    bbox: segment_bbox(item.start, item.end, item.width),
                    net: item.net,
                    segment: item,
                    name,
                });
            }
        }

        if (layer_names.has(LayerNames.via_netnames)) {
            for (const via of this.board.vias) {
                const name = this.#net_name(via.net);
                if (!name && via.type === "through-hole") continue;
                const layout = via_label_layout(
                    via,
                    name,
                    this.#copper_count,
                    true,
                );
                if (!layout) continue;
                candidates.push({
                    kind: "via",
                    layer: LayerNames.via_netnames,
                    min_zoom: Math.max(
                        via_label_min_zoom(via),
                        MIN_GLYPH_PX / min_glyph_height(layout),
                    ),
                    bbox: new BBox(
                        via.at.position.x - via.size / 2,
                        via.at.position.y - via.size / 2,
                        via.size,
                        via.size,
                    ),
                    net: via.net,
                    via,
                    name,
                });
            }
        }

        candidates.sort((a, b) => a.min_zoom - b.min_zoom);
        this.#candidates = candidates;
    }

    #net_name(net: number | undefined): string {
        if (!net || net <= 0) return "";
        return display_net_name(this.board.getNetName(net));
    }

    /** Number of leading candidates whose zoom gate passes (sorted ascending). */
    #visible_count(zoom: number): number {
        let lo = 0;
        let hi = this.#candidates.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.#candidates[mid]!.min_zoom <= zoom) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    #layouts_for(
        candidate: Candidate,
        zoom: number,
        region: BBox,
        options: NetLabelOptions,
    ): LabelLayout[] {
        switch (candidate.kind) {
            case "pad": {
                if (!options.padNumbers && !options.padNetNames) return [];
                const layout = pad_label_layout(
                    candidate.pad,
                    options.padNumbers,
                    options.padNetNames,
                );
                if (!layout) return [];
                // With one string hidden the other grows; re-check legibility.
                if (min_glyph_height(layout) * zoom < MIN_GLYPH_PX) return [];
                return [layout];
            }
            case "segment":
                if (!options.trackNetNames) return [];
                return segment_label_layouts(
                    candidate.segment.start,
                    candidate.segment.end,
                    candidate.segment.width,
                    candidate.name,
                    region,
                );
            case "arc":
                if (!options.trackNetNames) return [];
                return arc_label_layout(candidate.arc, candidate.name, region);
            case "via": {
                const show_layers = candidate.via.type !== "through-hole";
                if (!options.trackNetNames && !show_layers) return [];
                const layout = via_label_layout(
                    candidate.via,
                    candidate.name,
                    this.#copper_count,
                    options.trackNetNames,
                );
                if (!layout) return [];
                if (min_glyph_height(layout) * zoom < MIN_GLYPH_PX) return [];
                return [layout];
            }
        }
    }

    #repaint(
        zoom: number,
        region: BBox,
        visible_count: number,
        options: NetLabelOptions,
    ): void {
        const by_layer = new Map<string, LabelLayout[]>();
        const emphasized: { layout: LabelLayout; color: Color }[] = [];
        const nets = this.emphasized_nets;
        for (let i = 0; i < visible_count; i++) {
            const candidate = this.#candidates[i]!;
            if (!bbox_intersects(candidate.bbox, region)) continue;
            const layouts = this.#layouts_for(candidate, zoom, region, options);
            if (layouts.length === 0) continue;
            let list = by_layer.get(candidate.layer);
            if (!list) {
                list = [];
                by_layer.set(candidate.layer, list);
            }
            list.push(...layouts);
            // The per-layer copy hides with its layer at draw time; the
            // emphasis copy is one layer, so filter hidden copper here.
            if (nets?.has(candidate.net)) {
                const layer = this.layer_set.by_name(candidate.layer);
                if (!layer?.visible) continue;
                for (const layout of layouts)
                    emphasized.push({ layout, color: layer.color });
            }
        }

        for (const layer of this.#layers) {
            this.#set_graphics(layer, undefined);

            const layouts = by_layer.get(layer.name);
            if (!layouts || layouts.length === 0) continue;

            this.gfx.start_layer(layer.name);
            for (const layout of layouts) {
                draw_label(this.gfx, layout, layer.color);
            }
            this.#set_graphics(layer, this.gfx.end_layer());
        }

        const emphasis = this.#emphasis_layer();
        this.#set_graphics(emphasis, undefined);
        if (emphasized.length) {
            this.gfx.start_layer(emphasis.name);
            for (const { layout, color } of emphasized) {
                draw_label(this.gfx, layout, color);
            }
            this.#set_graphics(emphasis, this.gfx.end_layer());
        }
    }

    /** Replace (and free) a layer's label graphics: shared, or this fork's. */
    #set_graphics(layer: ViewLayer, graphics: RenderLayer | undefined) {
        if (this.#parent) {
            this.#detached.get(layer)?.dispose();
            if (graphics) this.#detached.set(layer, graphics);
            else this.#detached.delete(layer);
            return;
        }
        layer.graphics?.dispose();
        layer.graphics = graphics;
    }
}
