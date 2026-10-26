/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox } from "../../base/math";
import { NullRenderer } from "../../graphics/null-renderer";
import type { SchematicTheme } from "../../kicad";
import type { SchematicInstanceContext } from "../../kicad/schematic";
import { LayerNames, LayerSet } from "./layers";
import { SchematicPainter } from "./painter";
import { apply_schematic_render_defaults } from "./render-state";

/**
 * Measures schematic items by painting them into a throwaway renderer.
 *
 * There is no geometry model to query — the painters *are* the geometry, so
 * anything that needs a bounding box has to run them. The renderer is seeded
 * exactly like the on-screen one; skipping that silently drops every graphic
 * drawn with KiCad's "default width" stroke.
 */
export class SchematicMeasurer {
    readonly gfx = new NullRenderer();
    readonly layers: LayerSet;
    readonly painter: SchematicPainter;

    constructor(
        theme: SchematicTheme,
        instance_context?: SchematicInstanceContext,
    ) {
        apply_schematic_render_defaults(this.gfx, theme);
        this.layers = new LayerSet(theme);
        this.painter = new SchematicPainter(
            this.gfx,
            this.layers,
            theme,
            instance_context,
        );
    }

    /** Paint `items` onto `layer_name` and return what they covered. */
    measure(layer_name: LayerNames, items: readonly unknown[]): BBox {
        const layer = this.layers.by_name(layer_name)!;
        layer.items.push(...items);
        this.painter.paint_layer(layer);
        return layer.bbox;
    }

    /** Paint the same items onto several layers and combine the result. */
    measure_all(
        layer_names: readonly LayerNames[],
        items: readonly unknown[],
    ): BBox {
        return BBox.combine(
            layer_names.map((layer_name) => this.measure(layer_name, items)),
        );
    }
}
