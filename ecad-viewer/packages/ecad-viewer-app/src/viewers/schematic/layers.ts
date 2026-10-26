/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import {
    ViewLayerNames as BaseLayerNames,
    ViewLayerSet as BaseLayerSet,
    ViewLayer,
} from "../base/view-layers";
import { Color } from "../../base/color";
import type { SchematicTheme } from "../../kicad";
import { DefaultValues } from "../../kicad/schematic";
export { ViewLayer };

export enum LayerNames {
    // Bounding boxes for clickable items
    interactive = ":Interactive",
    // DNP and other marks.
    marks = ":Marks",
    // ERC markers and text
    erc = ":ERC",
    // reference, value, other symbol fields
    symbol_field = ":Symbol:Field",
    // hierarchical, global, and local labels
    sheet = ":Sheet",
    // hierarchical, global, and local labels
    label = ":Label",
    // regular junctions, bus junctions, no connects
    junction = ":Junction",
    // wires and buses
    wire = ":Wire",
    // symbol outlines, pin names, pin numbers
    symbol_foreground = ":Symbol:Foreground",
    // Text, rectangles, etc. not inside of symbols.
    notes = ":Notes",
    bitmap = ":Bitmap",
    // symbol pins
    symbol_pin = ":Symbol:Pin",

    // symbol body fill
    symbol_background = ":Symbol:Background",
    drawing_sheet = BaseLayerNames.drawing_sheet,
    grid = BaseLayerNames.grid,
    drawing_sheet_bg = ":DrawingSheet:Background",
}

/**
 * Represents the complete set of layers used by a View to draw a schematic.
 *
 * While a schematic doesn't have physical layers like a board, it still has
 * "virtual" layers used to make sure things are drawn in the right order.
 */
export class LayerSet extends BaseLayerSet {
    constructor(public theme: SchematicTheme) {
        super();

        for (const name of Object.values(LayerNames)) {
            this.add(new ViewLayer(this, name));
        }

        this.by_name(LayerNames.interactive)!.visible = false;
        this.by_name(LayerNames.interactive)!.interactive = true;

        // A pin is drawn as one stroked line, so its painted box is a hair
        // under 0.31mm wide -- about three screen pixels on a fitted preview,
        // and a miss there selects nothing at all, since the pin sticks out
        // past the symbol body that would otherwise catch the click. KiCad
        // sizes its own pin target with this same constant.
        this.by_name(LayerNames.symbol_pin)!.hit_margin =
            DefaultValues.target_pin_radius;
        this.by_name(LayerNames.drawing_sheet)!.color =
            (this.theme["worksheet"] as Color) ?? Color.white;
    }

    override *interactive_layers(): Generator<ViewLayer, void, unknown> {
        // Only the top interactive layer is clickable for schematics
        yield this.by_name(LayerNames.interactive)!;
    }

    override *interactive_items_in_order(): Generator<
        ViewLayer,
        void,
        unknown
    > {
        yield this.by_name(LayerNames.wire)!;
        yield this.by_name(LayerNames.symbol_pin)!;
        yield this.by_name(LayerNames.label)!;
        yield this.by_name(LayerNames.erc)!;
        yield this.by_name(LayerNames.interactive)!;
    }
}
