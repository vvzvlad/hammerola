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

import { Color } from "../../graphics";
import { ItemPainter } from "../base/painter";
import { ViewLayerNames, type ViewLayer } from "../base/view-layers";
import { LayerNames } from "./layers";
import type { BoardTheme } from "../../kicad";
export abstract class BoardItemPainter extends ItemPainter {
    override get theme(): BoardTheme {
        return (this.view_painter as any).theme;
    }

    /**
     * Emphasis colour for a board item painted into a selection layer: the
     * item's own copper (or hole) colour rather than the selection layer's.
     * Highlighted nets are repainted above the dimmed board in their native
     * colours, so a track on B.Cu still reads as B.Cu.
     */
    emphasis_color(layer: ViewLayer, own_layer_name: string): Color {
        return BoardItemPainter.is_interactive_layer(layer.name)
            ? this.color_for(own_layer_name)
            : layer.color;
    }

    /** Alias for BoardPainter.active_variant (null = default design). */
    get active_variant(): string | null {
        return (this.view_painter as any).active_variant ?? null;
    }

    static is_interactive_layer(layer_name: string): boolean {
        return BoardItemPainter.interactive_layers.has(layer_name);
    }

    static interactive_layers: Set<string> = new Set([
        ViewLayerNames.overlay,
        ViewLayerNames.selection_bg,
        ViewLayerNames.selection_fg,
        ViewLayerNames.selection_mask,
    ]);

    color_for(layer_name: string): Color {
        switch (layer_name) {
            case LayerNames.drawing_sheet:
                return (this.theme["worksheet"] as Color) ?? Color.white;
            case LayerNames.non_plated_holes:
                return (this.theme["non_plated_hole"] as Color) ?? Color.white;
            case LayerNames.via_holes:
                return (this.theme["via_hole"] as Color) ?? Color.white;
            case LayerNames.via_holewalls:
                return (this.theme["via_through"] as Color) ?? Color.white;
            case LayerNames.pad_holes:
                return (this.theme["background"] as Color) ?? Color.white;
            case LayerNames.pad_holewalls:
                return (this.theme["pad_through_hole"] as Color) ?? Color.white;
        }

        let name = layer_name;

        name = name.replace(":Zones:", "").replace(".", "_").toLowerCase();

        if (name.endsWith("_cu")) {
            name = name.replace("_cu", "");
            const copper_theme = this.theme.copper;
            return (
                copper_theme[name as keyof typeof copper_theme] ?? Color.white
            );
        }

        type KeyType = keyof Omit<BoardTheme, "copper">;

        return this.theme[name as KeyType] ?? Color.white;
    }
}
