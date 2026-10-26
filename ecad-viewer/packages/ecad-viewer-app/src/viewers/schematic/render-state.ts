/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { Renderer } from "../../graphics";
import type { SchematicTheme } from "../../kicad";
import { DefaultValues } from "../../kicad/schematic";

/**
 * Seed a renderer with the defaults every schematic painter assumes.
 *
 * KiCad symbol graphics encode "use the document default" as `(stroke (width
 * 0))`, and the painters resolve that against `gfx.state.stroke_width`. A
 * renderer left at `RenderState`'s zero default therefore drops those strokes
 * entirely — invisible on a real canvas, and silently missing geometry when a
 * `NullRenderer` is used to measure a bounding box. Every schematic renderer,
 * on-screen or off, has to start from the same state.
 */
export function apply_schematic_render_defaults(
    renderer: Renderer,
    theme: SchematicTheme,
) {
    renderer.state.fill = theme.note;
    renderer.state.stroke = theme.note;
    renderer.state.stroke_width = DefaultValues.line_width;
}
