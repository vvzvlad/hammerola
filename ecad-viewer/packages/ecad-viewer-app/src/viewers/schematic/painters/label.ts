/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../../../base/color";
import { Angle, BBox, Vec2 } from "../../../base/math";
import { intersheet_refs } from "../../../kicad/intersheet-refs";
import * as schematic_items from "../../../kicad/schematic";
import { EDAText, SchText, StrokeFont } from "../../../kicad/text";
import type { Project } from "../../../kicanvas/project";
import { LayerNames, ViewLayer } from "../layers";
import { SchematicItemPainter } from "./base";

/**
 * Implements KiCAD rendering logic for net, global, and hierarchical labels.
 *
 * This is similar in scope to the SymbolPin, EDAText class and its children,
 * it's designed to recreate KiCAD's behavior as closely as possible.
 *
 * This logic is adapted from:
 * - SCH_LABEL_BASE
 * - SCH_LABEL
 * - SCH_PAINTER::draw( const SCH_LABEL )
 * - SCH_PAINTER::draw( const SCH_HIERLABEL )
 * - SCH_PAINTER::draw( const SCH_TEXT )
 *
 */

export abstract class LabelPainter extends SchematicItemPainter {
    override layers_for(item: HierarchicalLabelPainter) {
        return [LayerNames.label];
    }
    override paint(layer: ViewLayer, l: schematic_items.Label) {
        if (l.effects.hide) {
            return;
        }

        const schtext = new SchText(l.shown_text);
        schtext.apply_at(l.at);
        schtext.apply_effects(l.effects);

        this.after_apply(l, schtext);

        if (l.at.rotation == 0 || l.at.rotation == 180) {
            schtext.text_angle.degrees = 0;
        } else if (l.at.rotation == 90 || l.at.rotation == 270) {
            schtext.text_angle.degrees = 90;
        }

        const pos = schtext.text_pos.add(
            this.get_schematic_text_offset(l, schtext),
        );

        const color = this.dim_if_needed(this.color);

        this.gfx.state.push();
        this.gfx.state.stroke = color;
        this.gfx.state.fill = color;

        StrokeFont.default().draw(
            this.gfx,
            schtext.shown_text,
            pos,
            schtext.attributes,
        );

        const shape_pts = this.create_shape(l, schtext);
        if (shape_pts) {
            this.gfx.line(shape_pts, schtext.attributes.stroke_width / 10000);
        }

        this.paint_fields(l, schtext, shape_pts);

        this.gfx.state.pop();
    }

    create_shape(l: schematic_items.Label, schtext: SchText): Vec2[] {
        return [];
    }

    /** Draws the label's fields, in the label's colour; `shape` is its body. */
    paint_fields(l: schematic_items.Label, schtext: SchText, shape: Vec2[]) {}

    get color() {
        return new Color(1, 0, 1, 1);
    }

    after_apply(l: schematic_items.Label, schtext: SchText) {}

    get_text_offset(schtext: SchText): number {
        // From SCH_TEXT::GetTextOffset, turns out SCH_LABEL is the only
        // subclass that uses it.
        return Math.round(
            schematic_items.DefaultValues.text_offset_ratio *
                schtext.text_size.x,
        );
    }

    get_box_expansion(schtext: SchText): number {
        // From SCH_LABEL_BASE::GetLabelBoxExpansion
        return Math.round(
            schematic_items.DefaultValues.label_size_ratio *
                schtext.text_size.y,
        );
    }

    /**
     * The offset between the schematic item's position and the actual text
     * position
     *
     * This takes into account orientation and any additional distance to make
     * the text readable (such as offsetting it from the top of a wire).
     */
    get_schematic_text_offset(
        l: schematic_items.Label,
        schtext: SchText,
    ): Vec2 {
        // From SCH_LABEL_BASE::GetSchematicTextOffset, although it is defined
        // on SCH_TEXT (which SCH_LABEL inherits from), but only SCH_LABEL
        // classes actually do anything with it.
        const dist = Math.round(
            this.get_text_offset(schtext) +
                schtext.get_effective_text_thickness(),
        );

        if (schtext.text_angle.is_vertical) {
            return new Vec2(-dist, 0);
        } else {
            return new Vec2(0, -dist);
        }
    }
}

export class NetLabelPainter extends LabelPainter {
    override classes: any[] = [schematic_items.NetLabel];

    override get color() {
        return this.theme.label_local;
    }
    override get_schematic_text_offset(
        l: schematic_items.Label,
        schtext: SchText,
    ): Vec2 {
        const dist = Math.round(
            this.get_text_offset(schtext) + schtext.text_width,
        );

        switch (l.at.rotation) {
            case 0:
                return new Vec2(dist, 0);
            case 90:
                return new Vec2(0, -dist);
            case 180:
                return new Vec2(-dist, 0);
            case 270:
                return new Vec2(0, dist);
            default:
                throw new Error(`Unexpected label rotation ${l.at.rotation}`);
        }
    }
    override create_shape(
        label: schematic_items.Label,
        schtext: SchText,
    ): Vec2[] {
        const pos = schtext.text_pos;
        const angle = Angle.from_degrees(label.at.rotation);
        let pts: Vec2[];

        // FIXME AH HOC to get the bbox of net label
        pts = [new Vec2(0, 0)];

        pts = pts.map((pt) => {
            return pt
                .rotate(angle)
                .add(pos)
                .multiply(1 / 10000);
        });

        return pts;
    }
}

export class GlobalLabelPainter extends LabelPainter {
    override classes: any[] = [schematic_items.GlobalLabel];

    override get color() {
        return this.theme.label_global;
    }

    override get_schematic_text_offset(
        l: schematic_items.Label,
        schtext: SchText,
    ): Vec2 {
        const label = l as schematic_items.GlobalLabel;
        const text_height = schtext.text_size.y;
        let horz = this.get_box_expansion(schtext);

        // Magic number from SCH_GLOBALLABEL::GetSchematicTextOffset,
        // offsets the center of the text to accomodate overbars.
        let vert = text_height * 0.0715;

        if (["input", "bidirectional", "tri_state"].includes(label.shape)) {
            // accommodate triangular shaped tail
            horz += text_height * 0.75;
        }

        horz = Math.round(horz);
        vert = Math.round(vert);

        switch (l.at.rotation) {
            case 0:
                return new Vec2(horz, vert);
            case 90:
                return new Vec2(vert, -horz);
            case 180:
                return new Vec2(-horz, vert);
            case 270:
                return new Vec2(vert, horz);
            default:
                throw new Error(`Unexpected label rotation ${l.at.rotation}`);
        }
    }

    /**
     * Creates the label's outline shape
     * Adapted from SCH_GLOBALLABEL::CreateGraphicShape
     */
    override create_shape(l: schematic_items.Label, schtext: SchText): Vec2[] {
        const label = l as schematic_items.GlobalLabel;
        const pos = schtext.text_pos;
        const angle = Angle.from_degrees(l.at.rotation + 180);
        const text_height = schtext.text_size.y;
        const margin = this.get_box_expansion(schtext);
        const half_size = text_height / 2 + margin;
        const symbol_length = schtext.get_text_box().w + 2 * margin;
        const stroke_width = schtext.attributes.stroke_width;

        const x = symbol_length + stroke_width + 3;
        const y = half_size + stroke_width + 3;

        let pts = [
            new Vec2(0, 0),
            new Vec2(0, -y),
            new Vec2(-x, -y),
            new Vec2(-x, 0),
            new Vec2(-x, y),
            new Vec2(0, y),
            new Vec2(0, 0),
        ];

        const offset = new Vec2();

        switch (label.shape) {
            case "input":
                offset.x = -half_size;
                pts[0]!.x += half_size;
                pts[6]!.x += half_size;
                break;
            case "output":
                pts[3]!.x -= half_size;
                break;
            case "bidirectional":
            case "tri_state":
                offset.x = -half_size;
                pts[0]!.x += half_size;
                pts[6]!.x += half_size;
                pts[3]!.x -= half_size;
                break;
            default:
                break;
        }

        pts = pts.map((pt) => {
            return pt
                .add(offset)
                .rotate(angle)
                .add(pos)
                .multiply(1 / 10000);
        });

        return pts;
    }

    /**
     * Draws the inter-sheet references when the project shows them: KiCad
     * sets the field's visibility from `intersheets_ref_show`, whatever the
     * file's `hide` says (SCH_SHEET_PATH::UpdateAllScreenReferences). Placed
     * as SCH_FIELD::Plot places it: the field's position moved by the label's
     * text offset, in the field's justification and angle.
     */
    override paint_fields(
        l: schematic_items.Label,
        schtext: SchText,
        shape: Vec2[],
    ) {
        const label = l as schematic_items.GlobalLabel;
        const context = this.view_painter.active_instance_context;
        const project = context?.document.project as Project | undefined;
        // KiCad 6 names the field "Intersheet References", 7 on "Intersheetrefs".
        const field = label.properties.find(
            (property) =>
                property.name == "Intersheetrefs" ||
                property.name == "Intersheet References",
        );
        if (
            !context ||
            !field ||
            !project?.settings.schematic.drawing.intersheets_ref_show
        ) {
            return;
        }

        const text = intersheet_refs(project, label.text, context.project_path);
        if (!text) {
            return;
        }

        const refs = new EDAText(text);
        refs.apply_effects(field.effects);
        refs.apply_at(field.at);

        // SCHEMATIC::RecomputeIntersheetRefs autoplaces a lone field still on
        // the label's own position, whether or not `fields_autoplaced` is set;
        // any other field stays where the file put it.
        if (
            label.properties.length == 1 &&
            field.at.position.equals(label.at.position)
        ) {
            // SCH_LABEL_BASE::AutoplaceFields: beyond the body, along the
            // label, by the body's longer side (inflated by the pen) plus twice
            // the text offset.
            const body = BBox.from_points(shape);
            const distance =
                Math.max(body.w, body.h) * 10000 +
                schtext.attributes.stroke_width +
                2 * this.get_text_offset(schtext);
            const along: Record<number, Vec2> = {
                0: new Vec2(distance, 0),
                90: new Vec2(0, -distance),
                180: new Vec2(-distance, 0),
                270: new Vec2(0, distance),
            };
            refs.text_pos = schtext.text_pos.add(along[l.at.rotation]!);
            refs.text_angle = Angle.from_degrees(
                l.at.rotation == 90 || l.at.rotation == 270 ? 90 : 0,
            );
            refs.h_align =
                l.at.rotation == 0 || l.at.rotation == 90 ? "left" : "right";
        }

        StrokeFont.default().draw(
            this.gfx,
            text,
            refs.text_pos.add(this.get_schematic_text_offset(l, schtext)),
            refs.attributes,
        );
    }
}

export class HierarchicalLabelPainter extends LabelPainter {
    override classes: any[] = [schematic_items.HierarchicalLabel];

    override get color() {
        return this.theme.label_hier;
    }

    override after_apply(
        l: schematic_items.HierarchicalLabel,
        schtext: SchText,
    ) {
        schtext.v_align = "center";
    }

    override get_schematic_text_offset(
        l: schematic_items.Label,
        schtext: SchText,
    ): Vec2 {
        const dist = Math.round(
            this.get_text_offset(schtext) + schtext.text_width,
        );

        switch (l.at.rotation) {
            case 0:
                return new Vec2(dist, 0);
            case 90:
                return new Vec2(0, -dist);
            case 180:
                return new Vec2(-dist, 0);
            case 270:
                return new Vec2(0, dist);
            default:
                throw new Error(`Unexpected label rotation ${l.at.rotation}`);
        }
    }

    /**
     * Creates the label's outline shape
     * Adapted from SCH_HIERLABEL::CreateGraphicShape and TemplateShape.
     */
    override create_shape(
        label: schematic_items.HierarchicalLabel,
        schtext: SchText,
    ): Vec2[] {
        const pos = schtext.text_pos;
        const angle = Angle.from_degrees(label.at.rotation);
        const s = schtext.text_width;

        let pts: Vec2[];

        switch (label.shape) {
            case "output":
                pts = [
                    new Vec2(0, s / 2),
                    new Vec2(s / 2, s / 2),
                    new Vec2(s, 0),
                    new Vec2(s / 2, -s / 2),
                    new Vec2(0, -s / 2),
                    new Vec2(0, s / 2),
                ];
                break;

            case "input":
                pts = [
                    new Vec2(s, s / 2),
                    new Vec2(s / 2, s / 2),
                    new Vec2(0, 0),
                    new Vec2(s / 2, -s / 2),
                    new Vec2(s, -s / 2),
                    new Vec2(s, s / 2),
                ];
                break;

            case "bidirectional":
            case "tri_state":
                pts = [
                    new Vec2(s / 2, s / 2),
                    new Vec2(s, 0),
                    new Vec2(s / 2, -s / 2),
                    new Vec2(0, 0),
                    new Vec2(s / 2, s / 2),
                ];
                break;

            case "passive":
            default:
                pts = [
                    new Vec2(0, s / 2),
                    new Vec2(s, s / 2),
                    new Vec2(s, -s / 2),
                    new Vec2(0, -s / 2),
                    new Vec2(0, s / 2),
                ];
                break;
        }

        pts = pts.map((pt) => {
            return pt
                .rotate(angle)
                .add(pos)
                .multiply(1 / 10000);
        });

        return pts;
    }
}

export class HierarchicalSheetPinPainter extends HierarchicalLabelPainter {
    override classes: any[] = [schematic_items.HierarchicalSheetPin];

    override paint(layer: ViewLayer, l: schematic_items.HierarchicalSheetPin) {
        // Sheet pins are painted as free-standing items, outside the sheet's
        // own paint pass, so the sheet has to be published here for them to
        // inherit its DNP dimming the way KiCad's do.
        this.view_painter.current_sheet = l.sheet;

        try {
            super.paint(layer, l);
        } finally {
            this.view_painter.current_sheet = undefined;
        }
    }
}
