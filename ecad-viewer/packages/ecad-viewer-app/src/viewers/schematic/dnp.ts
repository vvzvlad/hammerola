/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Color } from "../../base/color";
import { BBox } from "../../base/math";
import type { Renderer } from "../../graphics";
import type { SchematicTheme } from "../../kicad";
import { DefaultValues } from "../../kicad/schematic";

/**
 * The "do not populate" cross KiCad overplots on DNP symbols and DNP
 * hierarchical sheets.
 *
 * Symbols and sheets use identical geometry in KiCad — see the two blocks in
 * SCH_PAINTER::draw( const SCH_SYMBOL* ) and SCH_PAINTER::draw( const
 * SCH_SHEET* ) — so both callers share this module.
 */

/** SCH_PAINTER uses `3 * DEFAULT_LINE_WIDTH_MILS` for both diagonals. */
export const DNP_MARKER_STROKE_WIDTH = DefaultValues.line_width * 3;

/**
 * Grow a body bounding box into the box the cross is drawn across.
 *
 * KiCad derives the margin from how far the pins (or, for a sheet, the pins
 * and fields) stick out past the body, then squares that margin up so a wide,
 * short symbol still gets a cross with some vertical presence. The second
 * assignment deliberately reads the margin the first one just wrote — keep the
 * order.
 */
export function dnp_marker_bbox(body: BBox, body_and_pins: BBox): BBox {
    if (!body.valid) {
        return body;
    }

    const outer = body_and_pins.valid ? body_and_pins : body;

    let margin_x = Math.max(body.x - outer.x, outer.x2 - body.x2);
    let margin_y = Math.max(body.y - outer.y, outer.y2 - body.y2);

    margin_x = Math.max(margin_x * 0.6, margin_y * 0.3);
    margin_y = Math.max(margin_y * 0.6, margin_x * 0.3);

    return body.grow(margin_x, margin_y);
}

/** The DNP marker color, falling back for themes predating `dnp_marker`. */
export function dnp_marker_color(theme: SchematicTheme): Color {
    return theme.dnp_marker ?? theme.erc_error;
}

/** Draw both diagonals of the cross across `bbox`. */
export function paint_dnp_cross(gfx: Renderer, bbox: BBox, color: Color) {
    if (!bbox.valid) {
        return;
    }

    gfx.line(
        [bbox.top_left, bbox.bottom_right],
        DNP_MARKER_STROKE_WIDTH,
        color,
    );
    gfx.line(
        [bbox.bottom_left, bbox.top_right],
        DNP_MARKER_STROKE_WIDTH,
        color,
    );
}
