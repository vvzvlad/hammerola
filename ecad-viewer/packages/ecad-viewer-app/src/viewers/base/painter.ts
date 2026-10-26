/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Logger } from "../../base/log";
import { Renderer } from "../../graphics";
import { ecadPerfLog, isEcadPerfLogEnabled } from "../../kicanvas/perf_log";
import type { BaseTheme } from "../../kicad";
import {
    apply_diff_color,
    type EcadDiffPaintStatus,
    type EcadDiffPresentation,
} from "./diff-presentation";
import { ViewLayer, ViewLayerSet } from "./view-layers";

const log = new Logger("kicanvas:project");
const DIFF_COLOR_BYPASS_LAYERS = new Set([
    ":Overlay",
    ":SelectionBG",
    ":SelectionFG",
    ":SelectionMask",
    ":Grid",
    // Keep schematic paper white so muted unchanged geometry stays readable.
    ":DrawingSheet:Background",
    // Keep board outline authoritative on PCB composite reviews.
    "Edge.Cuts",
    "Edge.Cuts.User",
    "Margin",
]);

/**
 * Base class for all painters responsible for drawing a view items.
 */
export abstract class ItemPainter {
    /**
     * List of item classes this painter can draw
     */
    abstract classes: unknown[];

    constructor(
        protected view_painter: DocumentPainter,
        protected gfx: Renderer,
    ) {}

    abstract layers_for(item: unknown): string[];

    abstract paint(layer: ViewLayer, item: unknown, ...rest: any[]): void;

    public get theme(): BaseTheme {
        return this.view_painter.theme;
    }
}

export interface PaintableDocument {
    items(): Generator<unknown, void, void>;
}

/**
 * Base class for painting a complete document, for example, an entire schematic or board.
 */
export class DocumentPainter {
    #painters: Map<unknown, ItemPainter> = new Map();
    #paint_status_stack: EcadDiffPaintStatus[] = [];
    public diff_presentation: EcadDiffPresentation | null = null;

    /**
     * Create a ViewPainter.
     */
    constructor(
        public gfx: Renderer,
        public layers: ViewLayerSet,
        public theme: BaseTheme,
    ) {}

    protected set painter_list(painters: ItemPainter[]) {
        for (const painter of painters) {
            for (const type of painter.classes) {
                this.#painters.set(type, painter);
            }
        }
    }

    get painters(): Map<unknown, ItemPainter> {
        return this.#painters;
    }

    paint(document: PaintableDocument, extra_items: readonly object[] = []) {
        log.debug("Painting");
        log.debug("Sorting paintable items into layers");

        const perf = isEcadPerfLogEnabled();
        const t0 = perf ? performance.now() : 0;

        for (const item of this.#items(document, extra_items)) {
            const painter = this.painter_for(item);

            if (!painter) {
                log.warn(`No painter found for ${item?.constructor.name}`);
                continue;
            }

            for (const layer_name of painter.layers_for(item)) {
                this.layers.by_name(layer_name)?.items.push(item);
            }
        }

        const sort_ms = perf ? performance.now() - t0 : 0;
        let tessellate_ms = 0;
        let bbox_ms = 0;
        let item_count = 0;
        const layer_rows: {
            name: string;
            items: number;
            tessellate_ms: number;
            bbox_ms: number;
        }[] = [];

        for (const layer of this.paintable_layers()) {
            log.debug(
                `Painting layer ${layer.name} with ${layer.items.length} items`,
            );
            const stats = this.paint_layer(layer, perf);
            if (perf && stats) {
                tessellate_ms += stats.tessellate_ms;
                bbox_ms += stats.bbox_ms;
                item_count += stats.items;
                if (stats.items > 0) {
                    layer_rows.push({
                        name: layer.name,
                        items: stats.items,
                        tessellate_ms: stats.tessellate_ms,
                        bbox_ms: stats.bbox_ms,
                    });
                }
            }
        }

        if (perf) {
            const total_ms = performance.now() - t0;
            ecadPerfLog(
                `paint sort=${sort_ms.toFixed(1)}ms tessellate=${tessellate_ms.toFixed(1)}ms bbox=${bbox_ms.toFixed(1)}ms total=${total_ms.toFixed(1)}ms layers=${layer_rows.length} items=${item_count}`,
            );
            layer_rows.sort((a, b) => b.tessellate_ms - a.tessellate_ms);
            for (const row of layer_rows.slice(0, 16)) {
                if (row.tessellate_ms < 1) continue;
                ecadPerfLog(
                    `  layer ${row.name} items=${row.items} tessellate=${row.tessellate_ms.toFixed(1)}ms bbox=${row.bbox_ms.toFixed(1)}ms`,
                );
            }
        }

        log.debug("Painting complete");
    }

    *#items(document: PaintableDocument, extra_items: readonly object[]) {
        const seen = new Set<unknown>();
        for (const item of this.items_for(document)) {
            if (seen.has(item)) continue;
            seen.add(item);
            yield item;
        }
        for (const item of extra_items) {
            if (seen.has(item)) continue;
            seen.add(item);
            yield item;
        }
    }

    protected items_for(
        document: PaintableDocument,
    ): Generator<unknown, void, void> {
        return document.items();
    }

    *paintable_layers() {
        yield* this.layers.in_display_order();
    }

    paint_layer(layer: ViewLayer, time = false) {
        const bboxes = new Map();
        const t0 = time ? performance.now() : 0;
        let bbox_ms = 0;

        this.gfx.start_layer(layer.name);

        for (const item of layer.items) {
            const bbox_t0 = time ? performance.now() : 0;
            this.gfx.start_bbox();
            if (time) bbox_ms += performance.now() - bbox_t0;

            this.paint_item(layer, item);

            const bbox_t1 = time ? performance.now() : 0;
            const bbox = this.gfx.end_bbox(item);
            bboxes.set(item, bbox);
            if (time) bbox_ms += performance.now() - bbox_t1;
        }

        layer.graphics = this.gfx.end_layer();
        layer.bboxes = bboxes;

        if (!time) return;
        return {
            items: layer.items.length,
            tessellate_ms: performance.now() - t0,
            bbox_ms,
        };
    }

    paint_item(layer: ViewLayer, item: unknown, ...rest: any[]) {
        const painter = this.painter_for(item);
        if (!painter) {
            log.error(`Cannot find painter for ${item}}`);
        }
        if (!painter) return;

        const presentation = this.diff_presentation;
        const parent_status = this.#paint_status_stack.at(-1);
        const direct_status =
            item && typeof item === "object"
                ? presentation?.statusByItem.get(item)
                : undefined;
        const status = direct_status ?? parent_status ?? "unchanged";
        const previous_transform = this.gfx.color_transform;
        const bypass = DocumentPainter.#bypass_diff_color(layer.name);

        this.#paint_status_stack.push(status);
        if (presentation?.colorizeChanges && !bypass) {
            this.gfx.color_transform = (color) =>
                apply_diff_color(color, status, this.theme.background);
        }
        try {
            painter.paint(layer, item, ...rest);
        } finally {
            this.#paint_status_stack.pop();
            this.gfx.color_transform = previous_transform;
        }
    }

    static #bypass_diff_color(layer_name: string): boolean {
        return DIFF_COLOR_BYPASS_LAYERS.has(layer_name);
    }

    painter_for(item: any): ItemPainter | undefined {
        if (!item) {
            return;
        }
        return this.painters.get(item.constructor);
    }

    layers_for(item: any): string[] {
        return this.painters.get(item.constructor)?.layers_for(item) || [];
    }
}
