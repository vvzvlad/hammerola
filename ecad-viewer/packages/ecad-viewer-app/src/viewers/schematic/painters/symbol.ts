/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Matrix3 } from "../../../base/math";
import type { SchematicTheme } from "../../../kicad";
import * as schematic_items from "../../../kicad/schematic";
import { get_symbol_transform } from "../../../kicad/symbol-transform";
import { dnp_marker_bbox, dnp_marker_color, paint_dnp_cross } from "../dnp";
import { LayerNames, ViewLayer } from "../layers";
import { SchematicMeasurer } from "../measure";
import { SchematicItemPainter } from "./base";

export class LibSymbolPainter extends SchematicItemPainter {
    classes = [schematic_items.LibSymbol];

    layers_for(item: schematic_items.LibSymbol) {
        return [
            LayerNames.symbol_background,
            LayerNames.symbol_foreground,
            LayerNames.symbol_field,
        ];
    }

    paint(layer: ViewLayer, s: schematic_items.LibSymbol, body_style = 1) {
        if (
            ![
                LayerNames.symbol_background,
                LayerNames.symbol_foreground,
                LayerNames.interactive,
            ].includes(layer.name as LayerNames)
        ) {
            return;
        }

        // Unit 0 has graphic common to all units. See LIB_SYMBOL::GetPins and
        // LIB_ITEM::m_unit.
        const common_unit = s.units.get(0);
        if (common_unit) {
            this.#paint_unit(layer, common_unit, body_style);
        }

        const si = this.view_painter.current_symbol;

        const symbol_unit = s.units.get(
            (si && this.view_painter.active_instance_context?.unit(si)) ||
                si?.unit ||
                1,
        );

        if (symbol_unit) {
            this.#paint_unit(layer, symbol_unit, body_style);
        }
    }

    #paint_unit(
        layer: ViewLayer,
        unit: schematic_items.LibSymbol[],
        body_style = 1,
    ) {
        for (const sym of unit) {
            if (sym.style > 0 && body_style != sym.style) {
                continue;
            }

            for (const g of sym.drawings) {
                this.view_painter.paint_item(layer, g);
            }
        }
    }
}

const visible_properties = new Set(["Reference", "Value"]);

export class SchematicSymbolPainter extends SchematicItemPainter {
    classes = [schematic_items.SchematicSymbol];

    layers_for(item: schematic_items.SchematicSymbol) {
        const layers = [
            LayerNames.interactive,
            LayerNames.symbol_foreground,
            LayerNames.symbol_background,
            LayerNames.symbol_field,
            // LayerNames.symbol_pin,
        ];

        // Resolve DNP through this symbol's instance context so a variant
        // record (and the ancestor sheet fold) decides the marker, not the
        // base attribute (packet 2.2). `context_for_symbol` is used rather
        // than the painter's current context because layer assignment runs
        // for every item before painting starts.
        const dnp =
            this.view_painter.context_for_symbol(item)?.dnp(item) ?? item.dnp;
        if (dnp) {
            layers.push(LayerNames.marks);
        }

        return layers;
    }

    paint(layer: ViewLayer, si: schematic_items.SchematicSymbol) {
        const transform = get_symbol_transform(si);

        this.view_painter.current_symbol = si;
        this.view_painter.current_instance_context =
            this.view_painter.context_for_symbol(si);
        this.view_painter.current_symbol_transform = transform;

        this.gfx.state.push();
        this.gfx.state.matrix = Matrix3.translation(
            si.at.position.x,
            si.at.position.y,
        );
        this.gfx.state.multiply(transform.matrix);

        const body_style = si.convert ?? 1;

        this.view_painter.paint_item(layer, si.lib_symbol, body_style);

        this.gfx.state.pop();

        const unit_pins =
            this.view_painter.active_instance_context?.unit_pins(si) ??
            si.unit_pins;
        for (const pin of unit_pins) {
            this.view_painter.pin_transform.set(pin, transform);
        }

        if (
            layer.name == LayerNames.symbol_field ||
            layer.name == LayerNames.interactive
        ) {
            for (const [_, p] of si.properties) {
                if (!visible_properties.has(p.name)) {
                    continue;
                }

                this.view_painter.paint_item(layer, p);
            }
        }

        if (
            (this.view_painter.active_instance_context?.dnp(si) ?? si.dnp) &&
            layer.name == LayerNames.marks
        ) {
            const { body, body_and_pins } = measure_symbol_bboxes(
                this.theme,
                si,
                this.view_painter.active_instance_context,
            );

            paint_dnp_cross(
                this.gfx,
                dnp_marker_bbox(body, body_and_pins),
                dnp_marker_color(this.theme),
            );
        }

        this.view_painter.current_symbol = undefined;
        this.view_painter.current_instance_context = undefined;
        this.view_painter.current_symbol_transform = undefined;
    }
}

/**
 * Measures the given symbol by painting it into a throwaway renderer.
 *
 * `body` covers the symbol graphics alone, `body_and_pins` adds the pins.
 * Neither includes fields or other text items. These are the two boxes KiCad's
 * SCH_SYMBOL::GetBodyBoundingBox and ::GetBodyAndPinsBoundingBox return, and
 * the DNP marker needs both to size its margins.
 */
export function measure_symbol_bboxes(
    theme: SchematicTheme,
    si: schematic_items.SchematicSymbol,
    instance_context?: schematic_items.SchematicInstanceContext,
): { body: BBox; body_and_pins: BBox } {
    const measurer = new SchematicMeasurer(theme, instance_context);

    const body = measurer.measure_all(
        [LayerNames.symbol_foreground, LayerNames.symbol_background],
        [si],
    );

    // LibSymbolPainter ignores the pin layer, so the pins have to be handed to
    // PinPainter directly. It reads the owning symbol's transform out of the
    // painter's cache, which only the regular paint pass populates.
    const pins = instance_context?.unit_pins(si) ?? si.unit_pins;
    const transform = get_symbol_transform(si);
    for (const pin of pins) {
        measurer.painter.pin_transform.set(pin, transform);
    }

    const body_and_pins = BBox.combine([
        body,
        measurer.measure(LayerNames.symbol_pin, pins),
    ]);

    return { body, body_and_pins };
}
