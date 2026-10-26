/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * Painters for drawing board items.
 *
 * Each item class has a corresponding Painter implementation.
 */

import { Angle, BBox, Matrix3, Vec2 } from "../../base/math";
import { Color, Polygon, Polyline } from "../../graphics";
import * as board_items from "../../kicad/board";
import { ViewLayerNames } from "../base/view-layers";
import { LayerNames, ViewLayer } from "./layers";
import { BoardItemPainter } from "./painter-base";

export class FootprintPainter extends BoardItemPainter {
    classes = [board_items.Footprint];

    layers_for(fp: board_items.Footprint): string[] {
        const layers = new Set();
        for (const item of fp.items()) {
            const item_layers = this.view_painter.layers_for(item);
            for (const layer of item_layers) {
                layers.add(layer);
            }
        }
        // Footprint-effective DNP adds the isolated hatch layer (VAR-06).
        // Resolution is by UUID and never by reference, and an unknown
        // variant name resolves the base flags (packet 2.4).
        if (fp.effective_dnp(this.active_variant)) {
            layers.add(LayerNames.dnp);
        }
        return Array.from(layers.values()) as string[];
    }

    paint(layer: ViewLayer, fp: board_items.Footprint) {
        if (layer.name === ViewLayerNames.selection_mask) {
            this.paint_hatch(fp.bbox, layer.color, true);
            return;
        }

        if (layer.name === LayerNames.dnp) {
            this.paint_hatch(fp.bbox, layer.color, false);
            return;
        }

        const matrix = Matrix3.translation(
            fp.at.position.x,
            fp.at.position.y,
        ).rotate_self(Angle.deg_to_rad(fp.at.rotation));

        this.gfx.state.push();
        this.gfx.state.multiply(matrix);

        const its = fp.items();

        for (const item of its) {
            const item_layers = this.view_painter.layers_for(item);
            if (
                BoardItemPainter.is_interactive_layer(layer.name) ||
                item_layers.includes(layer.name)
            ) {
                this.view_painter.paint_item(layer, item);
            }
        }

        this.gfx.state.pop();
    }

    /**
     * 45° diagonals clipped to `bbox` (offset = x-relative − y-relative).
     * The selection mask also fills the box; the DNP hatch stays lines-only
     * so pads, copper and silkscreen below remain readable.
     */
    paint_hatch(bbox: BBox, color: Color, fill: boolean) {
        if (fill) {
            this.gfx.polygon(Polygon.from_BBox(bbox, color));
        }
        const step = Math.max(0.4, Math.min(bbox.w, bbox.h) / 12);
        for (let offset = -bbox.h; offset <= bbox.w; offset += step) {
            const t0 = Math.max(0, offset);
            const t1 = Math.min(bbox.w, offset + bbox.h);
            if (t1 <= t0) continue;
            this.gfx.line(
                new Polyline(
                    [
                        new Vec2(bbox.x + t0, bbox.y + t0 - offset),
                        new Vec2(bbox.x + t1, bbox.y + t1 - offset),
                    ],
                    0.1,
                    color,
                ),
            );
        }
    }
}
