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

import { Angle, Arc, BBox, Matrix3, Vec2 } from "../../base/math";
import { Circle, Color, Polygon, Polyline, Renderer } from "../../graphics";
import * as board_items from "../../kicad/board";
import { EDAText, StrokeFont } from "../../kicad/text";
import { DocumentPainter } from "../base/painter";
import {
    diff_status_color,
    type EcadDiffPaintStatus,
} from "../base/diff-presentation";
import {
    CopperVirtualLayerNames,
    FabVirtualLayerNames,
    LayerNames,
    LayerSet,
    ViewLayer,
    copper_layers_between,
    virtual_layer_for,
} from "./layers";
import type { BoardTheme } from "../../kicad";
import {
    BoxInteractiveItem,
    LineInteractiveItem,
    type BoardInteractiveItem,
} from "../../kicad/board_bbox_visitor";
import { FootprintPainter } from "./footprint-painter";
import { BoardItemPainter } from "./painter-base";
import { PadPainter } from "./pad-painter";
import { ZonePainter } from "./zone-painter";

class LinePainter extends BoardItemPainter {
    classes = [board_items.GrLine, board_items.FpLine];

    layers_for(item: board_items.GrLine | board_items.FpLine) {
        return [item.layer];
    }

    paint(layer: ViewLayer, s: board_items.GrLine | board_items.FpLine) {
        const color = layer.color;

        const points = [s.start, s.end];
        this.gfx.line(new Polyline(points, s.width, color));
    }
}

class RectPainter extends BoardItemPainter {
    classes = [board_items.GrRect, board_items.FpRect];

    layers_for(item: board_items.GrRect | board_items.FpRect) {
        return [item.layer];
    }

    paint(layer: ViewLayer, r: board_items.GrRect | board_items.FpRect) {
        const color = layer.color;

        const points = [
            r.start,
            new Vec2(r.start.x, r.end.y),
            r.end,
            new Vec2(r.end.x, r.start.y),
            r.start,
        ];

        this.gfx.line(new Polyline(points, r.width, color));

        if (board_items.should_fill(r)) {
            this.gfx.polygon(new Polygon(points, color));
        }
    }
}

class PolyPainter extends BoardItemPainter {
    classes = [board_items.Poly, board_items.GrPoly, board_items.FpPoly];

    layers_for(
        item: board_items.Poly | board_items.GrPoly | board_items.FpPoly,
    ) {
        return [item.layer];
    }

    paint(
        layer: ViewLayer,
        p: board_items.Poly | board_items.GrPoly | board_items.FpPoly,
    ) {
        const color = layer.color;

        if (p.width) {
            this.gfx.line(
                // TODO paint the arc
                new Polyline([...p.points, p.points[0]!], p.width, color),
            );
        }

        if (board_items.should_fill(p)) {
            this.gfx.polygon(new Polygon(p.points, color));
        }
    }
}

class ArcPainter extends BoardItemPainter {
    classes = [board_items.GrArc, board_items.FpArc];

    layers_for(item: board_items.GrArc | board_items.FpArc) {
        return [item.layer];
    }

    paint(layer: ViewLayer, a: board_items.GrArc | board_items.FpArc) {
        const color = layer.color;
        const arc = a.arc;
        const points = arc.to_polyline();
        this.gfx.line(new Polyline(points, arc.width, color));
    }
}

class CirclePainter extends BoardItemPainter {
    classes = [board_items.GrCircle, board_items.FpCircle];

    layers_for(item: board_items.GrCircle | board_items.FpCircle) {
        return [item.layer];
    }

    paint(layer: ViewLayer, c: board_items.GrCircle | board_items.FpCircle) {
        const color = layer.color;

        const radius = c.center.sub(c.end).magnitude;
        const arc = new Arc(
            c.center,
            radius,
            new Angle(0),
            new Angle(2 * Math.PI),
            c.width,
        );

        if (board_items.should_fill(c)) {
            this.gfx.circle(
                new Circle(arc.center, arc.radius + (c.width ?? 0), color),
            );
        } else {
            const points = arc.to_polyline();
            this.gfx.line(new Polyline(points, arc.width, color));
        }
    }
}

class TraceSegmentPainter extends BoardItemPainter {
    classes = [board_items.LineSegment];

    layers_for(item: board_items.LineSegment) {
        return [item.layer];
    }

    paint(layer: ViewLayer, s: board_items.LineSegment) {
        const color = this.emphasis_color(layer, s.layer);
        const points = [s.start, s.end];
        this.gfx.line(new Polyline(points, s.width, color));
    }
}

class TraceArcPainter extends BoardItemPainter {
    classes = [board_items.ArcSegment];

    layers_for(item: board_items.ArcSegment) {
        return [item.layer];
    }

    paint(layer: ViewLayer, a: board_items.ArcSegment) {
        const color = this.emphasis_color(layer, a.layer);
        const arc = Arc.from_three_points(a.start, a.mid, a.end, a.width);
        const points = arc.to_polyline();
        this.gfx.line(new Polyline(points, arc.width, color));
    }
}

class ViaPainter extends BoardItemPainter {
    classes = [board_items.Via];

    layers_for(v: board_items.Via): string[] {
        if (v.layers) {
            // blind/buried vias have two layers - the start and end layer,
            // and should only be drawn on the layers they're actually on.
            const layers = [];

            for (const cu_layer of copper_layers_between(
                v.layers[0]!,
                v.layers[1]!,
            )) {
                layers.push(
                    virtual_layer_for(
                        cu_layer,
                        CopperVirtualLayerNames.bb_via_holes,
                    ),
                );
                layers.push(
                    virtual_layer_for(
                        cu_layer,
                        CopperVirtualLayerNames.bb_via_hole_walls,
                    ),
                );
            }
            return layers;
        } else {
            return [LayerNames.via_holes, LayerNames.via_holewalls];
        }
    }

    paint(layer: ViewLayer, v: board_items.Via) {
        const color = this.emphasis_color(layer, LayerNames.via_holewalls);

        if (
            layer.name.endsWith("HoleWalls") ||
            BoardItemPainter.is_interactive_layer(layer.name)
        ) {
            this.gfx.circle(new Circle(v.at.position, v.size / 2, color));
        } else if (layer.name.endsWith("Holes")) {
            this.gfx.circle(new Circle(v.at.position, v.drill / 2, color));

            // Draw start and end layer markers
            if ((v.type == "blind" || v.type == "micro") && v.layers) {
                this.gfx.arc(
                    v.at.position,
                    v.size / 2 - v.size / 8,
                    Angle.from_degrees(180 + 70),
                    Angle.from_degrees(360 - 70),
                    v.size / 4,
                    layer.layer_set.by_name(v.layers[0]!)?.color ??
                        Color.transparent_black,
                );
                this.gfx.arc(
                    v.at.position,
                    v.size / 2 - v.size / 8,
                    Angle.from_degrees(70),
                    Angle.from_degrees(180 - 70),
                    v.size / 4,
                    layer.layer_set.by_name(v.layers[1]!)?.color ??
                        Color.transparent_black,
                );
            }
        }
    }
}

class GrTextPainter extends BoardItemPainter {
    classes = [board_items.GrText];

    layers_for(t: board_items.GrText) {
        return [t.layer.name];
    }

    paint(layer: ViewLayer, t: board_items.GrText) {
        if (t.hide || !t.shown_text) {
            return;
        }

        if (t.render_cache) {
            for (const poly of t.render_cache.polygons) {
                this.view_painter.paint_item(layer, poly);
            }
            return;
        }

        const edatext = new EDAText(t.shown_text);

        edatext.apply_effects(t.effects);
        edatext.apply_at(t.at);

        edatext.attributes.color = layer.color;

        this.gfx.state.push();
        StrokeFont.default().draw(
            this.gfx,
            edatext.shown_text,
            edatext.text_pos,
            edatext.attributes,
        );
        this.gfx.state.pop();
    }
}

class FpTextPainter extends BoardItemPainter {
    classes = [board_items.FpText, board_items.Property_Kicad_8];

    layers_for(t: board_items.FpText | board_items.Property_Kicad_8) {
        const layer_name =
            t instanceof board_items.FpText ? t.layer.name : t.layer;

        switch (t.type) {
            case "reference":
                return [
                    virtual_layer_for(layer_name, FabVirtualLayerNames.fp_ref),
                ];
            case "value":
                return [
                    virtual_layer_for(
                        layer_name,
                        FabVirtualLayerNames.fp_value,
                    ),
                ];
            case "user":
                return [
                    virtual_layer_for(
                        layer_name,
                        FabVirtualLayerNames.hidden_text,
                    ),
                ];
        }
    }

    paint(
        layer: ViewLayer,
        t: board_items.FpText | board_items.Property_Kicad_8,
    ) {
        if (t.hide || !t.shown_text) {
            return;
        }

        if (t.render_cache) {
            this.gfx.state.push();
            this.gfx.state.matrix = Matrix3.identity();
            for (const poly of t.render_cache.polygons) {
                this.view_painter.paint_item(layer, poly);
            }
            this.gfx.state.pop();
            return;
        }

        const edatext = new EDAText(t.shown_text);

        edatext.apply_effects(t.effects);
        edatext.apply_at(t.at);

        edatext.attributes.keep_upright = !t.at.unlocked;
        edatext.attributes.color = layer.color;

        if (t.parent) {
            const rot = Angle.from_degrees(t.parent.at.rotation);
            let pos = edatext.text_pos;
            pos = rot.rotate_point(pos, new Vec2(0, 0));
            pos = pos.add(t.parent.at.position.multiply(10000));
            edatext.text_pos.set(pos);
        }

        if (edatext.attributes.keep_upright) {
            while (edatext.text_angle.degrees > 90) {
                edatext.text_angle.degrees -= 180;
            }
            while (edatext.text_angle.degrees <= -90) {
                edatext.text_angle.degrees += 180;
            }
        }

        this.gfx.state.push();
        this.gfx.state.matrix = Matrix3.identity();

        StrokeFont.default().draw(
            this.gfx,
            edatext.shown_text,
            edatext.text_pos,
            edatext.attributes,
        );
        this.gfx.state.pop();
    }
}

class DimensionPainter extends BoardItemPainter {
    classes = [board_items.Dimension];

    layers_for(d: board_items.Dimension): string[] {
        return [d.layer];
    }

    paint(layer: ViewLayer, d: board_items.Dimension) {
        switch (d.type) {
            case "orthogonal":
            case "aligned":
                this.paint_linear(layer, d);
                break;
            case "center":
                this.paint_center(layer, d);
                break;
            case "radial":
                this.paint_radial(layer, d);
                break;
            case "leader":
                this.paint_leader(layer, d);
                break;
        }
    }

    paint_center(layer: ViewLayer, d: board_items.Dimension) {
        const thickness = d.style.thickness ?? 0.2;

        let arm = d.end.sub(d.start);
        this.gfx.line(
            [d.start.sub(arm), d.start.add(arm)],
            thickness,
            layer.color,
        );

        arm = Angle.from_degrees(90).rotate_point(arm);
        this.gfx.line(
            [d.start.sub(arm), d.start.add(arm)],
            thickness,
            layer.color,
        );
    }

    paint_radial(layer: ViewLayer, d: board_items.Dimension) {
        const thickness = d.style.thickness ?? 0.2;

        const center = d.start.copy();
        let center_arm = new Vec2(0, d.style.arrow_length);

        // Cross shape
        this.gfx.line(
            [center.sub(center_arm), center.add(center_arm)],
            thickness,
            layer.color,
        );

        center_arm = Angle.from_degrees(90).rotate_point(center_arm);
        this.gfx.line(
            [center.sub(center_arm), center.add(center_arm)],
            thickness,
            layer.color,
        );

        // Line from center to text.
        let radial = d.end.sub(d.start);
        radial = radial.resize(d.leader_length);

        const text = this.make_text(layer, d);
        const text_bbox = text.get_text_box().scale(1 / 10000);

        const line_segs = [d.end, d.end.add(radial), d.gr_text.at.position];

        const textbox_pt = text_bbox.intersect_segment(
            line_segs[1]!,
            line_segs[2]!,
        );

        if (textbox_pt) {
            line_segs[2] = textbox_pt;
        }

        this.gfx.line(line_segs, thickness, layer.color);

        // Arrows
        const arrow_angle = Angle.from_degrees(27.5);
        const inv_radial_angle = radial.angle.negative();
        const arrow_seg = new Vec2(d.style.arrow_length, 0);
        const arrow_end_pos = inv_radial_angle
            .add(arrow_angle)
            .rotate_point(arrow_seg);
        const arrow_end_neg = inv_radial_angle
            .sub(arrow_angle)
            .rotate_point(arrow_seg);

        this.gfx.line(
            [d.end.add(arrow_end_neg), d.end, d.end.add(arrow_end_pos)],
            thickness,
            layer.color,
        );

        // Text
        this.paint_text(text);
    }

    paint_leader(layer: ViewLayer, d: board_items.Dimension) {
        const thickness = d.style.thickness ?? 0.2;

        // Line from center to text.
        const text = this.make_text(layer, d);
        const text_bbox = text
            .get_text_box()
            .grow(text.text_width / 2, text.get_effective_text_thickness() * 2)
            .scale(1 / 10000);

        const start = d.start.add(
            d.end.sub(d.start).resize(d.style.extension_offset),
        );
        const line_segs = [start, d.end, d.gr_text.at.position];

        const textbox_pt = text_bbox.intersect_segment(
            line_segs[1]!,
            line_segs[2]!,
        );

        if (textbox_pt) {
            line_segs[2] = textbox_pt;
        }

        this.gfx.line(line_segs, thickness, layer.color);

        // Outline
        if (d.style.text_frame == 1) {
            this.gfx.line(
                Polyline.from_BBox(text_bbox, thickness, layer.color),
            );
        }
        if (d.style.text_frame == 2) {
            const radius =
                text_bbox.w / 2 -
                text.get_effective_text_thickness() / 10000 / 2;
            this.gfx.arc(
                text_bbox.center,
                radius,
                Angle.from_degrees(0),
                Angle.from_degrees(360),
                thickness,
                layer.color,
            );
        }

        // Arrows
        const radial = d.end.sub(d.start);
        const arrow_angle = Angle.from_degrees(27.5);
        const inv_radial_angle = radial.angle.negative();
        const arrow_seg = new Vec2(d.style.arrow_length, 0);
        const arrow_end_pos = inv_radial_angle
            .add(arrow_angle)
            .rotate_point(arrow_seg);
        const arrow_end_neg = inv_radial_angle
            .sub(arrow_angle)
            .rotate_point(arrow_seg);

        this.gfx.line(
            [start.add(arrow_end_neg), start, start.add(arrow_end_pos)],
            thickness,
            layer.color,
        );

        // Text
        this.paint_text(text);
    }

    paint_linear(layer: ViewLayer, d: board_items.Dimension) {
        const thickness = d.style.thickness ?? 0.2;

        let extension = new Vec2();
        let xbar_start = new Vec2();
        let xbar_end = new Vec2();

        // See PCB_DIM_ORTHOGONAL::updateGeometry
        if (d.type == "orthogonal") {
            if (d.orientation == 0) {
                extension = new Vec2(0, d.height);
                xbar_start = d.start.add(extension);
                xbar_end = new Vec2(d.end.x, xbar_start.y);
            } else {
                extension = new Vec2(d.height, 0);
                xbar_start = d.start.add(extension);
                xbar_end = new Vec2(xbar_start.x, d.end.y);
            }
        }
        // See PCB_DIM_ALIGNED::updateGeometry
        else {
            const dimension = d.end.sub(d.start);
            if (d.height > 0) {
                extension = new Vec2(-dimension.y, dimension.x);
            } else {
                extension = new Vec2(dimension.y, -dimension.x);
            }

            const xbar_distance = extension
                .resize(d.height)
                .multiply(Math.sign(d.height));

            xbar_start = d.start.add(xbar_distance);
            xbar_end = d.end.add(xbar_distance);
        }

        // Draw extensions
        const extension_height =
            Math.abs(d.height) -
            d.style.extension_offset +
            d.style.extension_height;

        // First extension line
        let ext_start = d.start.add(extension.resize(d.style.extension_offset));
        let ext_end = ext_start.add(extension.resize(extension_height));
        this.gfx.line([ext_start, ext_end], thickness, layer.color);

        // Second extension line
        ext_start = d.end.add(extension.resize(d.style.extension_offset));
        ext_end = ext_start.add(extension.resize(extension_height));
        this.gfx.line([ext_start, ext_end], thickness, layer.color);

        // Draw crossbar
        // TODO: KiCAD checks to see if the text overlaps the crossbar and
        // conditionally splits or hides the crossbar.
        this.gfx.line([xbar_start, xbar_end], thickness, layer.color);

        // Arrows
        const xbar_angle = xbar_end.sub(xbar_start).angle.negative();
        const arrow_angle = Angle.from_degrees(27.5);
        const arrow_end_pos = xbar_angle
            .add(arrow_angle)
            .rotate_point(new Vec2(d.style.arrow_length, 0));
        const arrow_end_neg = xbar_angle
            .sub(arrow_angle)
            .rotate_point(new Vec2(d.style.arrow_length, 0));

        this.gfx.line(
            [
                xbar_start.add(arrow_end_neg),
                xbar_start,
                xbar_start.add(arrow_end_pos),
            ],
            thickness,
            layer.color,
        );
        this.gfx.line(
            [
                xbar_end.sub(arrow_end_neg),
                xbar_end,
                xbar_end.sub(arrow_end_pos),
            ],
            thickness,
            layer.color,
        );

        // Text
        this.paint_text(this.make_text(layer, d));
    }

    make_text(layer: ViewLayer, d: board_items.Dimension) {
        const pcbtext = new EDAText(d.gr_text.shown_text);
        pcbtext.apply_effects(d.gr_text.effects);
        pcbtext.apply_at(d.gr_text.at);
        pcbtext.attributes.color = layer.color;

        return pcbtext;
    }

    paint_text(text: EDAText) {
        this.gfx.state.push();
        StrokeFont.default().draw(
            this.gfx,
            text.shown_text,
            text.text_pos,
            text.attributes,
        );
        this.gfx.state.pop();
    }
}

/** Alpha of the dim pass drawn over the board while nets are highlighted. */
export const HIGHLIGHT_DIM_OPACITY = 0.72;

/**
 * Opacity of highlighted zone fills. Below the zone layers' own 0.6 because
 * the emphasis sits above every native layer, and a pour of the highlighted
 * net would otherwise hide the dimmed tracks of other nets crossing it.
 */
export const ZONE_EMPHASIS_OPACITY = 0.45;

export class BoardPainter extends DocumentPainter {
    override theme: BoardTheme;

    constructor(gfx: Renderer, layers: LayerSet, theme: BoardTheme) {
        super(gfx, layers, theme);
        this.painter_list = [
            new LinePainter(this, gfx),
            new RectPainter(this, gfx),
            new PolyPainter(this, gfx),
            new ArcPainter(this, gfx),
            new CirclePainter(this, gfx),
            new TraceSegmentPainter(this, gfx),
            new TraceArcPainter(this, gfx),
            new ViaPainter(this, gfx),
            new ZonePainter(this, gfx),
            new PadPainter(this, gfx),
            new FootprintPainter(this, gfx),
            new GrTextPainter(this, gfx),
            new FpTextPainter(this, gfx),
            new DimensionPainter(this, gfx),
        ];
    }

    /**
     * Net codes currently emphasised, or null when no highlight is active.
     * Item painters never consult this: the board keeps painting normally and
     * {@link paint_highlight} repaints the members on top of a dim pass.
     */
    #highlight_nets: ReadonlySet<number> | null = null;

    get highlight_nets(): ReadonlySet<number> | null {
        return this.#highlight_nets;
    }

    /**
     * The board variant the footprint painters resolve against; `null` is the
     * default design. The board viewer sets it before repainting.
     */
    active_variant: string | null = null;

    #highlight_bbox: BBox | null = null;

    /**
     * World-space bounds of the highlighted nets' pads, tracks, arcs and vias
     * (zones only when a net has nothing else), for "fit highlighted".
     */
    get highlight_bbox() {
        return this.#highlight_bbox;
    }

    paint_footprint(fp: board_items.Footprint) {
        this.clear_interactive();

        const mask = this.layers.selection_mask;
        mask.color = new Color(0, 0.85, 1, 0.55);
        this.gfx.start_layer(mask.name);
        this.paint_item(mask, fp);
        mask.graphics = this.gfx.end_layer();
        mask.graphics.composite_operation = "source-over";

        const outline = this.layers.selection_fg;
        this.gfx.start_layer(outline.name);
        this.gfx.line(Polyline.from_BBox(fp.bbox.grow(0.15), 0.25, Color.cyan));
        outline.graphics = this.gfx.end_layer();
        outline.graphics.composite_operation = "source-over";
    }

    /**
     * Light single-click selection: green bounding outline only (no hatch).
     * Cross-probe uses {@link paint_footprint} for the stronger cyan hatch.
     */
    outline_footprint(fp: board_items.Footprint) {
        this.clear_interactive();
        const outline = this.layers.selection_fg;
        this.gfx.start_layer(outline.name);
        this.gfx.line(
            Polyline.from_BBox(fp.bbox.grow(0.35), 0.25, Color.green),
        );
        outline.graphics = this.gfx.end_layer();
        outline.graphics.composite_operation = "source-over";
    }

    /**
     * Empty the interactive layers and forget any highlight. The highlight
     * pass drives these layers' opacity; a later outline, hatch or diff
     * paint expects them opaque again.
     */
    clear_interactive() {
        for (const layer of [
            this.layers.selection_bg,
            this.layers.selection_fg,
            this.layers.selection_mask,
        ]) {
            layer.clear();
            layer.opacity = 1;
        }
        this.#highlight_bbox = null;
        this.#highlight_nets = null;
    }

    /**
     * Replay selected native board objects into one foreground layer. Passing
     * the interactive layer to FootprintPainter paints the complete footprint;
     * tracks, arcs, and vias retain their exact native geometry.
     */
    paint_diff_selection(
        entries: ReadonlyArray<{
            item: object;
            status: Exclude<EcadDiffPaintStatus, "unchanged">;
        }>,
    ) {
        this.clear_interactive();
        const layer = this.layers.selection_fg;
        this.gfx.start_layer(layer.name);
        for (const { item, status } of entries) {
            const previous_transform = this.gfx.color_transform;
            const status_color = diff_status_color(status);
            this.gfx.color_transform = (color) =>
                status_color.with_alpha(Math.max(color.a, 0.82));
            try {
                if (item instanceof board_items.Footprint) {
                    const matrix = Matrix3.translation(
                        item.at.position.x,
                        item.at.position.y,
                    ).rotate_self(Angle.deg_to_rad(item.at.rotation));
                    this.gfx.state.push();
                    this.gfx.state.multiply(matrix);
                    try {
                        // getChildren deliberately excludes reference/value
                        // text (including KiCad 8 property text), while
                        // retaining pads, footprint graphics, and zones.
                        for (const child of item.getChildren()) {
                            this.paint_item(layer, child);
                        }
                    } finally {
                        this.gfx.state.pop();
                    }
                } else {
                    this.paint_item(layer, item);
                }
            } finally {
                this.gfx.color_transform = previous_transform;
            }
        }
        layer.graphics = this.gfx.end_layer();
        layer.graphics.composite_operation = "source-over";
    }

    /**
     * Emphasise a set of nets: a translucent dim pass over the whole board
     * (the native layers stay exactly as the user left them) and the members
     * repainted above it in their own layer colours. Items on hidden layers
     * are not repainted, so hidden copper stays hidden. Pads and vias are
     * multi-layer: they show while any of their copper layers is visible.
     *
     * Returns false and clears both passes when `nets` is empty.
     */
    paint_highlight(
        board: board_items.KicadPCB,
        nets: ReadonlySet<number>,
        layer_visible: (layer_name: string) => boolean,
    ): boolean {
        this.clear_interactive();
        if (nets.size === 0) return false;
        this.#highlight_nets = new Set(nets);

        const any_copper_visible = (layers: string[]) =>
            layers.some(
                (name) =>
                    name === "*.Cu" ||
                    (name.endsWith(".Cu") && layer_visible(name)),
            );

        // Dim pass: one board-sized quad. Its opacity is the layer's, so the
        // renderer blends it over the copper below.
        {
            const layer = this.layers.selection_bg;
            layer.opacity = HIGHLIGHT_DIM_OPACITY;
            const extent = this.#board_extent(board);
            this.gfx.start_layer(layer.name);
            this.gfx.polygon(
                Polygon.from_BBox(extent, this.theme.background ?? Color.black),
            );
            layer.graphics = this.gfx.end_layer();
            layer.graphics.composite_operation = "source-over";
        }

        // Emphasis pass, split over two layers so a highlighted pour sits
        // under the tracks and at its own translucency: zone fills on the
        // foreground layer, tracks / vias / pads on the mask layer above it.
        // Vertex alpha is not blended by the renderer; layer opacity is.
        let bbox: BBox | null = null;
        let zone_bbox: BBox | null = null;
        const grow = (box: BBox) => {
            bbox = bbox ? BBox.combine([bbox, box]) : box;
        };
        {
            const layer = this.layers.selection_fg;
            layer.opacity = ZONE_EMPHASIS_OPACITY;
            this.gfx.start_layer(layer.name);
            for (const zone of board.zones) {
                if (!nets.has(zone.net) || !zone.filled_polygons) continue;
                const zone_layers = zone.layers ?? [zone.layer];
                if (!zone_layers.some((name) => layer_visible(name))) continue;
                this.paint_item(layer, zone);
                const box = zone.bbox;
                if (box?.valid)
                    zone_bbox = zone_bbox
                        ? BBox.combine([zone_bbox, box])
                        : box;
            }
            layer.graphics = this.gfx.end_layer();
            layer.graphics.composite_operation = "source-over";
        }
        {
            const layer = this.layers.selection_mask;
            layer.opacity = 1;
            this.gfx.start_layer(layer.name);
            for (const track of board.segments) {
                if (!nets.has(track.net) || !layer_visible(track.layer))
                    continue;
                this.paint_item(layer, track);
                grow(track.bbox.grow(track.width / 2));
            }
            for (const via of board.vias) {
                if (!nets.has(via.net)) continue;
                if (!any_copper_visible(via.layers)) continue;
                this.paint_item(layer, via);
                grow(via.bbox);
            }
            for (const fp of board.footprints) {
                for (const pad of fp.pads) {
                    if (!pad.net || !nets.has(pad.net.number)) continue;
                    if (!any_copper_visible(pad.layers)) continue;
                    this.#paint_pad_in_place(layer, fp, pad);
                    const box = pad.bbox;
                    if (box?.valid) grow(box);
                }
            }
            layer.graphics = this.gfx.end_layer();
            layer.graphics.composite_operation = "source-over";
        }
        this.#highlight_bbox = bbox ?? zone_bbox;

        return true;
    }

    /** Pads are painted in footprint space; apply the footprint transform. */
    #paint_pad_in_place(
        layer: ViewLayer,
        fp: board_items.Footprint,
        pad: board_items.Pad,
    ) {
        const matrix = Matrix3.translation(
            fp.at.position.x,
            fp.at.position.y,
        ).rotate_self(Angle.deg_to_rad(fp.at.rotation));
        this.gfx.state.push();
        this.gfx.state.multiply(matrix);
        try {
            this.paint_item(layer, pad);
        } finally {
            this.gfx.state.pop();
        }
    }

    /** Board outline bounds, or the union of everything when there is none. */
    #board_extent(board: board_items.KicadPCB): BBox {
        const edge = this.layers.by_name(LayerNames.edge_cuts)?.bbox;
        let extent = edge?.valid ? edge : null;
        if (!extent) {
            for (const layer of this.layers.in_order()) {
                const box = layer.bbox;
                if (!box?.valid) continue;
                extent = extent ? BBox.combine([extent, box]) : box;
            }
        }
        if (!extent) extent = new BBox(0, 0, 1, 1);
        // Grow past the outline so the dim reaches drawings around the board.
        return extent.grow(Math.max(extent.w, extent.h) * 0.25 + 5);
    }

    highlight(item: BoardInteractiveItem | null) {
        const layer = this.layers.overlay;
        layer.clear();
        this.gfx.start_layer(layer.name);
        if (item) {
            if (item instanceof LineInteractiveItem)
                this.gfx.line(
                    [item.line.start, item.line.end],
                    item.line.width,
                    Color.cyan,
                );
            else if (item instanceof BoxInteractiveItem)
                this.gfx.line(
                    [
                        item.bbox.top_left,
                        item.bbox.top_right,
                        item.bbox.bottom_right,
                        item.bbox.bottom_left,
                        item.bbox.top_left,
                    ],
                    0.2,
                    Color.cyan,
                );
        }
        layer.graphics = this.gfx.end_layer();
        layer.graphics.composite_operation = "source-over";
    }
}
