/*
    Net-name and pad-number labels.

    A port of the label branches of KiCad's `PCB_PAINTER` (`draw( const PAD* )`,
    `renderNetNameForSegment`, `draw( const PCB_ARC* )`, `draw( const PCB_VIA* )`)
    and of the zoom gates in `PAD::ViewGetLOD`, `PCB_TRACK::ViewGetLOD` and
    `PCB_VIA::ViewGetLOD`. Everything here is a pure function of the item and
    the camera, so `NetLabelLayers` can rebuild the label layers on zoom
    without touching the retained board scene.

    Units: board millimetres throughout; the stroke font takes KiCad internal
    units (mm × 10000), which `draw_label` applies at the very end.
*/

import { Angle, Arc, BBox, Vec2 } from "../../base/math";
import { Color } from "../../base/color";
import { Renderer } from "../../graphics";
import { NullRenderer } from "../../graphics/null-renderer";
import * as board_items from "../../kicad/board";
import { StrokeFont, TextAttributes } from "../../kicad/text";
import {
    CopperVirtualLayerNames,
    LayerNames,
    virtual_layer_for,
} from "./layers";

export interface NetLabelOptions {
    /** Pad numbers on pads. KiCad: "Show pad numbers". */
    padNumbers: boolean;
    /** Net names on pads. KiCad: net names mode "pads" / "pads & tracks". */
    padNetNames: boolean;
    /** Net names along tracks, arcs and on vias. KiCad: "tracks" modes. */
    trackNetNames: boolean;
}

export const DEFAULT_NET_LABEL_OPTIONS: Readonly<NetLabelOptions> = {
    padNumbers: true,
    padNetNames: true,
    trackNetNames: true,
};

/**
 * Zoom gates, in screen pixels of the governing dimension.
 *
 * KiCad hides an item's labels while `size_iu * view_scale < threshold_iu`;
 * at its default 91 DPI one unit of view scale is 3.583 px/mm, so a
 * threshold of T mm is T × 3.583 px on screen. `Camera2.zoom` is CSS px per
 * mm, so the same test here is `size_mm * zoom < threshold_px`.
 */
export const PAD_LABEL_MIN_PX = 1.8; // 0.5 mm: min(bbox.w, bbox.h)
export const TRACK_LABEL_MIN_PX = 14.3; // 4 mm: track width
export const VIA_LABEL_MIN_PX = 35.8; // 10 mm: via diameter

/**
 * Below this many screen pixels of glyph height a label is a smudge. KiCad
 * still draws it; we skip it so a fit-to-board view of a dense board does not
 * tessellate thousands of unreadable labels.
 */
export const MIN_GLYPH_PX = 3;

/** `PCB_RENDER_SETTINGS::MAX_FONT_SIZE`. */
export const MAX_FONT_SIZE_MM = 10;

/** One line of label text, positioned relative to the label origin. */
export interface LabelLine {
    text: string;
    /** Glyph size (x, y) in mm. */
    size: Vec2;
    /** Stroke width in mm. */
    stroke: number;
    /**
     * Offset along the label's own y axis in mm, before rotation. Positive is
     * "below" in reading orientation, as in KiCad's y-down text frame.
     */
    y: number;
}

export interface LabelLayout {
    position: Vec2;
    angle: Angle;
    lines: LabelLine[];
}

/**
 * KiCad's `GetDisplayNetname`: the short name of a hierarchical net. The
 * ambiguity disambiguation it applies is not ported.
 */
export function display_net_name(name: string | undefined | null): string {
    if (!name) return "";
    const slash = name.lastIndexOf("/");
    return slash >= 0 ? name.slice(slash + 1) : name;
}

function char_count(text: string): number {
    return Math.max(1, text.length);
}

/* ---------------------------------------------------------------- pads */

export type PadNetLabelLayer =
    | LayerNames.pad_netnames
    | `:${string}:${CopperVirtualLayerNames.netnames}`;

/**
 * Which label layer a pad reports to, after `PAD::ViewGetLayers`: pads
 * flashed on more than one copper layer (and every through-hole pad) go to
 * the shared pad layer above the holes; a pad on a single copper layer is
 * labelled on that layer so it hides and dims with it.
 */
export function pad_label_layer(pad: board_items.Pad): PadNetLabelLayer | null {
    const copper = pad.layers.filter(
        (layer) => layer.endsWith(".Cu") || layer === "*.Cu",
    );
    if (copper.length === 0) return null;
    if (pad.type === "thru_hole" || pad.type === "np_thru_hole") {
        return LayerNames.pad_netnames;
    }
    if (copper.length > 1 || copper[0] === "*.Cu" || copper[0] === "F&B.Cu") {
        return LayerNames.pad_netnames;
    }
    return virtual_layer_for(
        copper[0]!,
        CopperVirtualLayerNames.netnames,
    ) as PadNetLabelLayer;
}

/** The text KiCad shows as a pad's net: `x` for no-connect, `*` for free pads. */
export function pad_net_text(pad: board_items.Pad): string {
    if (pad.pintype?.includes("no_connect")) return "x";
    if (pad.pintype === "free" && pad.net?.name.startsWith("unconnected-")) {
        return "*";
    }
    return display_net_name(pad.net?.name);
}

/** Minimum zoom (px/mm) at which a pad's labels are drawn. */
export function pad_label_min_zoom(pad: board_items.Pad): number {
    const bbox = pad.bbox;
    if (!bbox.valid) return Infinity;
    const min_side = Math.min(Math.abs(bbox.w), Math.abs(bbox.h));
    if (min_side <= 0) return Infinity;
    return PAD_LABEL_MIN_PX / min_side;
}

/**
 * Port of the `IsNetnameLayer` branch of `PCB_PAINTER::draw( const PAD* )`.
 * Returns null when nothing would be drawn.
 */
export function pad_label_layout(
    pad: board_items.Pad,
    show_number: boolean,
    show_net: boolean,
): LabelLayout | null {
    const number = show_number ? (pad.number ?? "") : "";
    const net = show_net ? pad_net_text(pad) : "";
    if (!number && !net) return null;

    const bbox = pad.bbox;
    if (!bbox.valid) return null;

    const position = bbox.center;
    let w = Math.abs(bbox.w);
    let h = Math.abs(bbox.h);

    // Don't allow a 45° rotation to bloat a pad's bounding box unnecessarily.
    const limit = Math.min(pad.size.x, pad.size.y) * 1.1;
    if (w > limit && h > limit) {
        w = limit;
        h = limit;
    }

    let size = h;
    let angle = Angle.from_degrees(0);

    // Keep the size ratio for the font, but make it smaller: tall pads read
    // bottom-to-top with the long side as the text's x axis.
    if (w < h * 0.95) {
        angle = Angle.from_degrees(90);
        size = w;
        [w, h] = [h, w];
    }

    size = Math.min(size, MAX_FONT_SIZE_MM);

    let y_offset_number = 0;
    let y_offset_net = 0;
    if (number && net) {
        // The magic numbers are defined experimentally for a better look.
        size = size / 2.5;
        y_offset_net = size / 1.4;
        y_offset_number = size / 1.7;
    }

    const x_scale_for_stroked_font = 0.9;
    const lines: LabelLine[] = [];

    if (net) {
        // We use a size for at least 5 chars, to give a good look even for
        // short names.
        let tsize = (1.5 * w) / Math.max(char_count(net) + 1, 5);
        tsize = Math.min(tsize, size);
        // Use a smaller text size to handle interline, pen size...
        tsize *= 0.85;
        // Round and oval pads have less room to display the net name.
        if (pad.shape === "circle" || pad.shape === "oval") {
            tsize *= 0.9;
        }
        const glyph = new Vec2(tsize * x_scale_for_stroked_font, tsize);
        lines.push({
            text: net,
            size: glyph,
            stroke: glyph.x / 6,
            y: Math.min(tsize * 1.4, y_offset_net),
        });
    }

    if (number) {
        // We use a size for at least 3 chars, to give a good look even for
        // short numbers.
        let tsize = (1.5 * w) / Math.max(char_count(number), 3);
        tsize = Math.min(tsize, size);
        tsize *= 0.85;
        const glyph = new Vec2(tsize * x_scale_for_stroked_font, tsize);
        lines.push({
            text: number,
            size: glyph,
            stroke: glyph.x / 6,
            y: -y_offset_number,
        });
    }

    return { position, angle, lines };
}

/* -------------------------------------------------------------- tracks */

/**
 * Fold an angle into (-90°, 90°] so text along a segment is never upside
 * down (`EDA_ANGLE::Normalize90`).
 */
export function fold_upright(angle: Angle): Angle {
    let deg = angle.normalize180().degrees;
    while (deg > 90) deg -= 180;
    while (deg <= -90) deg += 180;
    return Angle.from_degrees(deg);
}

/** Minimum zoom (px/mm) at which a track's net name is drawn. */
export function track_label_min_zoom(width: number): number {
    if (width <= 0) return Infinity;
    return TRACK_LABEL_MIN_PX / width;
}

function track_line(name: string, width: number): LabelLine {
    const text_size = width;
    return {
        text: name,
        size: new Vec2(text_size * 0.55, text_size * 0.55),
        stroke: text_size / 12,
        y: 0,
    };
}

/**
 * Port of `PCB_PAINTER::renderNetNameForSegment`. Long segments get one
 * label per `region` extent so a track crossing the view is labelled
 * wherever the user looks; only positions inside `region` are returned.
 */
export function segment_label_layouts(
    start: Vec2,
    end: Vec2,
    width: number,
    name: string,
    region: BBox,
): LabelLayout[] {
    if (!name || width <= 0) return [];

    const seg = end.sub(start);
    const length = seg.magnitude;

    // Check if the track is long enough to have a netname displayed.
    const min_length = width * char_count(name);
    if (length < min_length) return [];

    let angle: Angle;
    let num_names = 1;

    if (end.y === start.y) {
        angle = Angle.from_degrees(0);
        num_names = Math.max(num_names, Math.round(length / region.w));
    } else if (end.x === start.x) {
        angle = Angle.from_degrees(90);
        num_names = Math.max(num_names, Math.round(length / region.h));
    } else {
        angle = fold_upright(new Angle(-seg.angle.radians));
        const min_size = Math.min(region.w, region.h);
        num_names = Math.max(
            num_names,
            Math.round(length / (Math.SQRT2 * min_size)),
        );
    }

    const line = track_line(name, width);
    const layouts: LabelLayout[] = [];
    const divisions = num_names + 1;
    for (let ii = 1; ii < divisions; ii++) {
        const position = start.add(seg.multiply(ii / divisions));
        if (region.contains_point(position)) {
            layouts.push({ position, angle, lines: [line] });
        }
    }
    return layouts;
}

/**
 * Port of the netname branch of `PCB_PAINTER::draw( const PCB_ARC* )`: one
 * label at the arc's midpoint, along the tangent.
 */
export function arc_label_layout(
    arc: board_items.ArcSegment,
    name: string,
    region: BBox,
): LabelLayout[] {
    if (!name || arc.width <= 0) return [];

    const geometry = Arc.from_three_points(
        arc.start,
        arc.mid,
        arc.end,
        arc.width,
    );
    const radius = geometry.radius;
    const arc_length = Math.abs(radius * geometry.arc_angle.radians);

    if (!(arc_length > 0) || !Number.isFinite(arc_length)) {
        // Degenerate: treat the chord as a segment.
        return segment_label_layouts(
            arc.start,
            arc.end,
            arc.width,
            name,
            region,
        );
    }

    if (arc_length < arc.width * char_count(name)) return [];

    const mid = arc.mid;
    if (!region.contains_point(mid)) return [];

    const radial = mid.sub(geometry.center);
    const tangent = new Vec2(-radial.y, radial.x);
    const angle = fold_upright(new Angle(-tangent.angle.radians));

    return [{ position: mid, angle, lines: [track_line(name, arc.width)] }];
}

/* ---------------------------------------------------------------- vias */

/** Minimum zoom (px/mm) at which a via's labels are drawn. */
export function via_label_min_zoom(via: board_items.Via): number {
    if (!(via.size > 0)) return Infinity;
    return VIA_LABEL_MIN_PX / via.size;
}

/**
 * 1-based copper index as KiCad prints it in a via's layer-pair line: F.Cu
 * is 1, B.Cu is the copper count, In<n>.Cu is n + 1.
 */
export function copper_layer_index(name: string, copper_count: number): number {
    if (name === "F.Cu") return 1;
    if (name === "B.Cu") return copper_count;
    const inner = /^In(\d+)\.Cu$/.exec(name);
    if (inner) return Number(inner[1]) + 1;
    return 0;
}

/**
 * Port of the netname branch of `PCB_PAINTER::draw( const PCB_VIA* )`. A
 * through via shows its net name; a blind/buried/micro via also shows the
 * layer pair above it.
 */
export function via_label_layout(
    via: board_items.Via,
    name: string,
    copper_count: number,
    show_net: boolean,
): LabelLayout | null {
    const net = show_net ? name : "";
    const show_layers = via.type !== "through-hole";
    if (!net && !show_layers) return null;

    const size = Math.min(via.size, MAX_FONT_SIZE_MM);

    // A good size is set room for at least 6 chars, to be able to print 2
    // lines of text, or at least 3 chars for only the netname.
    const min_char_count = show_layers ? 6 : 3;
    let tsize = (1.5 * size) / Math.max(char_count(net), min_char_count);
    tsize = Math.min(tsize, size);
    // Use a smaller text size to handle interline, pen size...
    tsize *= 0.75;

    const glyph = new Vec2(tsize, tsize);
    const stroke = glyph.x / 10;
    const lines: LabelLine[] = [];

    let y = 0;
    if (show_layers && net) {
        y += (tsize * 1.3) / 2;
    }
    if (net) {
        lines.push({ text: net, size: glyph, stroke, y });
    }
    if (show_layers) {
        if (net) y -= tsize * 1.3;
        const top = copper_layer_index(via.layers[0] ?? "", copper_count);
        const bottom = copper_layer_index(
            via.layers[via.layers.length - 1] ?? "",
            copper_count,
        );
        lines.push({ text: `${top}-${bottom}`, size: glyph, stroke, y });
    }

    return { position: via.at.position, angle: Angle.from_degrees(0), lines };
}

/* ------------------------------------------------------------- drawing */

/**
 * The screen height of a layout's smallest line, used with `MIN_GLYPH_PX`
 * to skip labels that would be illegible at the given zoom.
 */
export function min_glyph_height(layout: LabelLayout): number {
    let min = Infinity;
    for (const line of layout.lines) {
        min = Math.min(min, line.size.y);
    }
    return min;
}

/** Origin-relative strokes of one shaped label line, in board millimetres. */
interface ShapedLine {
    sx: number;
    sy: number;
    degrees: number;
    strokes: Vec2[][];
}

/**
 * Collects the polylines `Font.draw` emits instead of rendering them, so a
 * line can be shaped once through the normal font path (same alignment and
 * rotation maths as any other board text) and replayed at many positions.
 */
class StrokeCapture extends NullRenderer {
    strokes: Vec2[][] = [];

    override polylines(lines: Vec2[][]): void {
        this.strokes.push(...lines);
    }
}

/**
 * Shaped lines keyed by text. A label rebuild replays thousands of lines,
 * most of them the same few hundred net names at the same few pad sizes, so
 * this turns the per-line cost into a map lookup and a translation. Keyed on
 * the text alone with a short linear scan over sizes and angles: float keys
 * would need string building on every hit. Not an LRU: when it fills up it
 * is simply dropped, which costs one reshape per line on the next rebuild.
 */
const SHAPED_LINE_CACHE_MAX = 8192;
let shaped_lines = new Map<string, ShapedLine[]>();
let shaped_line_count = 0;

/** Drop every cached shaped line. Exposed for tests. */
export function clear_shaped_line_cache(): void {
    shaped_lines = new Map();
    shaped_line_count = 0;
}

function shape_line(text: string, size: Vec2, angle: Angle): Vec2[][] {
    const attrs = new TextAttributes();
    attrs.h_align = "center";
    attrs.v_align = "center";
    attrs.angle = angle;
    attrs.size = size.multiply(10000);
    attrs.multiline = false;

    const capture = new StrokeCapture();
    StrokeFont.default().draw(capture, text, new Vec2(0, 0), attrs);
    return capture.strokes;
}

function shaped_line(text: string, size: Vec2, angle: Angle): Vec2[][] {
    const degrees = angle.degrees;
    let entries = shaped_lines.get(text);
    if (entries) {
        for (const entry of entries) {
            if (
                entry.sx === size.x &&
                entry.sy === size.y &&
                entry.degrees === degrees
            ) {
                return entry.strokes;
            }
        }
    }

    const strokes = shape_line(text, size, angle);

    if (shaped_line_count >= SHAPED_LINE_CACHE_MAX) {
        clear_shaped_line_cache();
        entries = undefined;
    }
    if (!entries) {
        entries = [];
        shaped_lines.set(text, entries);
    }
    entries.push({ sx: size.x, sy: size.y, degrees, strokes });
    shaped_line_count++;
    return strokes;
}

/**
 * Stroke a label into the renderer's current layer. Each line's y offset is
 * applied in the label's own frame and then rotated with the label.
 *
 * Lines are shaped at the origin once (see `shaped_line`) and translated
 * here; the font rotates about the text origin, so translating the shaped
 * strokes is exactly what drawing at `position` would produce.
 */
export function draw_label(
    gfx: Renderer,
    layout: LabelLayout,
    color: Color,
): void {
    for (const line of layout.lines) {
        if (!line.text) continue;
        const offset = layout.angle.rotate_point(new Vec2(0, line.y));
        const px = layout.position.x + offset.x;
        const py = layout.position.y + offset.y;

        const strokes = shaped_line(line.text, line.size, layout.angle);
        const placed = new Array<Vec2[]>(strokes.length);
        for (let i = 0; i < strokes.length; i++) {
            const stroke = strokes[i]!;
            const points = new Array<Vec2>(stroke.length);
            for (let j = 0; j < stroke.length; j++) {
                const p = stroke[j]!;
                points[j] = new Vec2(p.x + px, p.y + py);
            }
            placed[i] = points;
        }
        gfx.polylines(placed, line.stroke, color);
    }
}
