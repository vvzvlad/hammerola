/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Color } from "../../../base/color";
import { Angle, type Vec2 } from "../../../base/math";
import { Arc, Polyline } from "../../../graphics";
import type { SchematicTheme } from "../../../kicad";
import * as schematic_items from "../../../kicad/schematic";
import {
    dash_arc,
    dash_pattern,
    dash_polyline,
} from "../../../kicad/stroke-params";
import type { Project } from "../../../kicanvas/project";
import { DocumentPainter, ItemPainter } from "../../base/painter";
import { LayerNames, type ViewLayer } from "../layers";
import type { SchematicPainter } from "../painter";
import type { SymbolTransform } from "../../../kicad/symbol-transform";

export abstract class BaseSchematicPainter extends DocumentPainter {
    override theme: SchematicTheme;
    instance_context?: schematic_items.SchematicInstanceContext;
    current_instance_context?: schematic_items.SchematicInstanceContext;
    current_symbol?: schematic_items.SchematicSymbol;
    current_symbol_transform?: SymbolTransform;
    current_sheet?: schematic_items.SchematicSheet;

    get active_instance_context() {
        return this.current_instance_context ?? this.instance_context;
    }

    context_for_symbol(symbol: schematic_items.SchematicSymbol) {
        return (
            this.diff_presentation?.schematicContexts?.get(symbol.parent) ??
            this.instance_context
        );
    }
}

export abstract class SchematicItemPainter extends ItemPainter {
    override view_painter: SchematicPainter;

    override get theme(): SchematicTheme {
        return this.view_painter.theme;
    }

    protected get is_dimmed() {
        // KiCad passes the owner's effective DNP state down into every child
        // it draws — a symbol's fields and pins, a sheet's fields and sheet
        // pins. The state is resolved per occurrence under the active variant
        // (VAR-04/VAR-05); the base flag is only the fallback for a document
        // without a project.
        const painter = this.view_painter;
        if (painter.current_symbol) {
            const symbol = painter.current_symbol;
            return painter.active_instance_context?.dnp(symbol) ?? symbol.dnp;
        }
        if (painter.current_sheet) {
            const sheet = painter.current_sheet;
            return (
                painter.active_instance_context?.sheet_dnp(sheet) ?? sheet.dnp
            );
        }
        return false;
    }

    protected dim_color(color: Color) {
        // See SCH_PAINTER::getRenderColor, this desaturates the color and
        // mixes it 50% with the background color. While you might think 50%
        // alpha would be fine, it ends up showing the grid and other stuff
        // behind it.
        color = color.desaturate();
        return color.mix(this.theme.background, 0.5);
    }

    protected dim_if_needed(color: Color) {
        return this.is_dimmed ? this.dim_color(color) : color;
    }

    protected determine_stroke(
        layer: ViewLayer,
        item: schematic_items.GraphicItem,
    ) {
        const width = item.stroke?.width || this.gfx.state.stroke_width;

        if (width < 0) {
            return { width: 0, color: null };
        }

        const stroke_type = item.stroke?.type ?? "none";

        if (stroke_type == "none") {
            return { width: 0, color: null };
        }

        const default_stroke =
            layer.name == LayerNames.symbol_foreground
                ? this.theme.component_outline
                : this.theme.note;

        const color = this.dim_if_needed(item.stroke?.color ?? default_stroke);

        // The schematic's own dash and gap ratios, which kicad-cli draws
        // with (EESCHEMA_JOBS_HANDLER::InitRenderSettings).
        const project = this.view_painter.active_instance_context?.document
            .project as Project | undefined;
        const drawing = project?.settings.schematic.drawing;
        const dashes = dash_pattern(
            stroke_type,
            width,
            drawing?.dashed_lines_dash_length_ratio,
            drawing?.dashed_lines_gap_length_ratio,
        );

        return { width, color, dashes };
    }

    /**
     * Strokes `pts` solid, or with `dashes` (`dash_pattern`) restarting at
     * every vertex, as KiCad strokes a polygon's and a rectangle's sides
     * (EDA_SHAPE::makeEffectiveShapes); `chain` carries the pattern across
     * the vertices instead, as for a Bézier curve.
     */
    protected stroke_polyline(
        pts: Vec2[],
        width: number,
        color: Color,
        dashes: number[] | null,
        chain = false,
    ) {
        if (!dashes) {
            this.gfx.line(new Polyline(pts, width, color));
            return;
        }
        const marks = chain
            ? dash_polyline(pts, dashes)
            : pts
                  .slice(1)
                  .flatMap((pt, i) => dash_polyline([pts[i]!, pt], dashes));
        for (const mark of marks) {
            this.gfx.line(new Polyline(mark, width, color));
        }
    }

    /** Strokes an arc solid, or with `dashes` (`dash_pattern`). */
    protected stroke_arc(
        center: Vec2,
        radius: number,
        start: Angle,
        end: Angle,
        width: number,
        color: Color,
        dashes: number[] | null,
    ) {
        if (!dashes) {
            this.gfx.arc(new Arc(center, radius, start, end, width, color));
            return;
        }
        for (const [from, to] of dash_arc(
            radius,
            start.radians,
            end.radians,
            dashes,
        )) {
            this.gfx.arc(
                new Arc(
                    center,
                    radius,
                    new Angle(from),
                    new Angle(to),
                    width,
                    color,
                ),
            );
        }
    }

    protected determine_fill(
        layer: ViewLayer,
        item: schematic_items.GraphicItem,
    ) {
        const fill_type = item.fill?.type ?? "none";

        if (fill_type == "none") {
            return null;
        }

        if (
            fill_type == "background" &&
            layer.name != LayerNames.symbol_background
        ) {
            return null;
        }

        let color;

        switch (fill_type) {
            case "background":
                color = this.theme.component_body;
                break;
            case "outline":
                color = this.theme.component_outline;
                break;
            case "color":
                color = item.fill!.color;
                break;
        }

        return this.dim_if_needed(color);
    }
}
