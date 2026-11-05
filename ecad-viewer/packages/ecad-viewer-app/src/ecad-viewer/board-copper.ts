/*
    The board's copper as triangles, for a host that draws the board in 3D
    itself (hammerola's 3D view of a board, ui/src/BoardView3D.jsx).

    KiCad's `.glb` merges all of a board's copper into three meshes (tracks
    and zones, pads, vias) that carry no net and no layer name, so a 3D view
    built on it can neither light a net nor pull the layers apart. This reads
    the board the viewer has parsed instead: every copper layer in stack order,
    where KiCad's 3D export puts it in height, its copper as a triangle soup
    with each vertex's net, and the barrels of the vias and plated holes.

    What is drawn is what the 2D board draws on that layer, the same shapes
    from the same data: zone fills as the loader triangulated them (or as the
    zone painter would), tracks as stroked lines with round ends (the pill
    the 2D renderer draws for each segment), SMD pads and copper graphics
    through the viewer's own painters into a renderer that only records the
    shapes (`NullRenderer`). Two things get a hole the 2D board paints over
    with its hole layers instead: a via is a ring, and a plated through pad is
    its outline less its drill, as KiCad's own 3D export cuts them. A track or
    a zone that runs over a drill is left whole: the host cuts the drills that
    go through the stack out of every layer as it draws them (`barrels`).
*/

import { Angle, Arc, Matrix3, Vec2 } from "../base/math";
import { Circle, Polygon, Polyline } from "../graphics";
import { NullRenderer } from "../graphics/null-renderer";
import { triangulate_flat } from "../graphics/webgl/triangulate";
import * as board_items from "../kicad/board";
import { BoardPainter } from "../viewers/board/painter";
import {
    CopperLayerNames,
    CopperVirtualLayerNames,
    LayerSet,
    copper_layers_between,
    virtual_layer_for,
} from "../viewers/board/layers";
import earcut from "../../third_party/earcut/earcut";

/** One copper layer: its triangles, three vertices each, as interleaved x, y
 *  in the board's millimetres, and the net (an index into `nets`) of each
 *  vertex; `bottom` and `top` are its faces' heights in millimetres. */
export interface BoardCopperLayer {
    name: string;
    bottom: number;
    top: number;
    triangles: Float32Array;
    nets: Uint32Array;
}

/** A plated barrel, a via's or a through pad's: its centre and radius in the
 *  board's millimetres, the indices into `layers` of the copper it joins
 *  (`from` above `to`), and its net. */
export interface BoardBarrel {
    x: number;
    y: number;
    radius: number;
    from: number;
    to: number;
    net: number;
}

/** A board's copper (`board_copper`). `nets` is indexed by the board's net
 *  codes; 0, no net, is the empty name. */
export interface BoardCopper {
    nets: string[];
    layers: BoardCopperLayer[];
    barrels: BoardBarrel[];
}

/** One item of a board's stack, top to bottom: a copper layer by its name,
 *  or a dielectric by its kind (`core`, `prepreg`); thicknesses in mm. */
export type StackItem =
    | { copper: string; thickness: number }
    | { dielectric: string; thickness: number };

/** KiCad's thicknesses for a stack the board does not describe
 *  (`BOARD_STACKUP_ITEM::GetCopperDefaultThickness`, `GetMaskDefaultThickness`). */
export const DEFAULT_COPPER_THICKNESS = 0.035;
export const DEFAULT_MASK_THICKNESS = 0.01;
const DEFAULT_BOARD_THICKNESS = 1.6;

/** The most a chord strays from the arc it stands for, in mm: KiCad's own
 *  default (`ARC_HIGH_DEF`), which its 3D export draws circles to. */
export const MAX_ERROR = 0.005;

/** The board's copper layers, top to bottom. */
export function copper_layer_names(board: board_items.KicadPCB): string[] {
    const present = new Set(board.layers.map((layer) => layer.canonical_name));
    return CopperLayerNames.filter((name) => present.has(name));
}

/**
 * The board's stack, top to bottom: its `(stackup)` where it has one, else
 * the stack KiCad builds for a board without one
 * (`BOARD_STACKUP::BuildDefaultStackupList`): the board's thickness less the
 * copper and the solder masks, shared equally between the dielectrics, which
 * are core and prepreg by turns from the top. A stackup's copper items are
 * the board's copper layers in order: the parser reads no name off a stackup
 * layer (`parseStackupLayer` takes the word `layer` for it).
 */
export function board_stack(board: board_items.KicadPCB): StackItem[] {
    const described = board.setup?.stackup?.layers ?? [];
    const coppers = copper_layer_names(board);
    if (described.some((layer) => layer.type === "copper")) {
        let next = 0;
        return described.flatMap((layer): StackItem[] => {
            if (layer.type === "copper") {
                return [
                    {
                        copper: coppers[next++]!,
                        thickness: layer.thickness ?? DEFAULT_COPPER_THICKNESS,
                    },
                ];
            }
            if (layer.type === "core" || layer.type === "prepreg") {
                return [
                    { dielectric: layer.type, thickness: layer.thickness ?? 0 },
                ];
            }
            return [];
        });
    }
    const present = new Set(board.layers.map((layer) => layer.canonical_name));
    const masks = ["F.Mask", "B.Mask"].filter((name) => present.has(name));
    const dielectric =
        ((board.general?.thickness ?? DEFAULT_BOARD_THICKNESS) -
            DEFAULT_COPPER_THICKNESS * coppers.length -
            DEFAULT_MASK_THICKNESS * masks.length) /
        Math.max(1, coppers.length - 1);
    const stack: StackItem[] = [];
    coppers.forEach((name, index) => {
        stack.push({ copper: name, thickness: DEFAULT_COPPER_THICKNESS });
        if (index < coppers.length - 1) {
            stack.push({
                dielectric: index % 2 === 0 ? "core" : "prepreg",
                thickness: dielectric,
            });
        }
    });
    return stack;
}

/**
 * Where KiCad's 3D export puts the copper layer `layer` of `stack`:
 * `[bottom, top]` in mm, the board's body standing on 0 (B.Cu's top face).
 * `STEP_PCB_MODEL::getCopperLayerZPlacement` of KiCad 10, step for step,
 * walking the stack up from the bottom: an inner layer above a prepreg hangs
 * down from the dielectric above it, any other one stands on the one below,
 * so a `.glb`'s copper and this one are at one height.
 */
export function copper_z(stack: StackItem[], layer: string): [number, number] {
    let z = 0;
    let thickness = 0;
    let was_prepreg = false;
    for (let i = stack.length - 1; i >= 0; i--) {
        const item = stack[i]!;
        if ("copper" in item) {
            if (layer === "B.Cu") {
                thickness = -item.thickness;
                break;
            }
            if (was_prepreg && item.copper !== "F.Cu") {
                z += item.thickness;
                thickness = -item.thickness;
            } else {
                thickness = item.thickness;
            }
            if (item.copper === layer) break;
            if (!was_prepreg && item.copper !== "B.Cu") z += item.thickness;
        } else {
            was_prepreg = item.dielectric === "prepreg";
            thickness = item.thickness;
            z += thickness;
        }
    }
    return [Math.min(z, z + thickness), Math.max(z, z + thickness)];
}

/** How many chords a circle of `radius` is drawn with, none of them further
 *  than `MAX_ERROR` from it, and never fewer than eight. */
export function circle_segments(radius: number): number {
    if (radius <= MAX_ERROR) return 8;
    return Math.max(8, Math.ceil(Math.PI / Math.acos(1 - MAX_ERROR / radius)));
}

/** A triangle soup with a net for each vertex, grown as it is filled. */
class Soup {
    xy = new Float32Array(1 << 12);
    net = new Uint32Array(1 << 11);
    count = 0;

    /** Room for `vertices` more. */
    room(vertices: number) {
        const need = this.count + vertices;
        if (need <= this.net.length) return;
        let size = this.net.length;
        while (size < need) size *= 2;
        const xy = new Float32Array(size * 2);
        xy.set(this.xy.subarray(0, this.count * 2));
        const net = new Uint32Array(size);
        net.set(this.net.subarray(0, this.count));
        this.xy = xy;
        this.net = net;
    }

    /** One vertex, where `room` made room for it. */
    vertex(x: number, y: number, net: number) {
        this.xy[this.count * 2] = x;
        this.xy[this.count * 2 + 1] = y;
        this.net[this.count++] = net;
    }

    /** Triangles given as interleaved x, y. */
    add(xy: ArrayLike<number>, net: number) {
        const vertices = xy.length / 2;
        this.room(vertices);
        this.xy.set(xy, this.count * 2);
        this.net.fill(net, this.count, this.count + vertices);
        this.count += vertices;
    }

    /** A filled circle, as a fan. */
    disc(c: Vec2, r: number, net: number) {
        const n = circle_segments(r);
        this.room(n * 3);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * 2 * Math.PI;
            const b = ((i + 1) / n) * 2 * Math.PI;
            this.vertex(c.x, c.y, net);
            this.vertex(c.x + r * Math.cos(a), c.y + r * Math.sin(a), net);
            this.vertex(c.x + r * Math.cos(b), c.y + r * Math.sin(b), net);
        }
    }

    /** The band between two circles about one centre. */
    ring(c: Vec2, outer: number, inner: number, net: number) {
        const n = circle_segments(outer);
        this.room(n * 6);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * 2 * Math.PI;
            const b = ((i + 1) / n) * 2 * Math.PI;
            const [ca, sa, cb, sb] = [
                Math.cos(a),
                Math.sin(a),
                Math.cos(b),
                Math.sin(b),
            ];
            this.vertex(c.x + outer * ca, c.y + outer * sa, net);
            this.vertex(c.x + outer * cb, c.y + outer * sb, net);
            this.vertex(c.x + inner * ca, c.y + inner * sa, net);
            this.vertex(c.x + inner * ca, c.y + inner * sa, net);
            this.vertex(c.x + outer * cb, c.y + outer * sb, net);
            this.vertex(c.x + inner * cb, c.y + inner * sb, net);
        }
    }

    /** A stroked polyline as the 2D renderer draws one: every segment a
     *  rectangle `width` wide, every point a disc of half that, which gives
     *  the round ends and joins of the renderer's pills. */
    line(points: Vec2[], width: number, net: number) {
        const r = width / 2;
        if (!(r > 0)) return;
        this.room(Math.max(0, points.length - 1) * 6);
        for (let i = 0; i + 1 < points.length; i++) {
            const a = points[i]!;
            const b = points[i + 1]!;
            const length = Math.hypot(b.x - a.x, b.y - a.y);
            if (!length) continue;
            const nx = (-(b.y - a.y) / length) * r;
            const ny = ((b.x - a.x) / length) * r;
            this.vertex(a.x + nx, a.y + ny, net);
            this.vertex(b.x + nx, b.y + ny, net);
            this.vertex(a.x - nx, a.y - ny, net);
            this.vertex(a.x - nx, a.y - ny, net);
            this.vertex(b.x + nx, b.y + ny, net);
            this.vertex(b.x - nx, b.y - ny, net);
        }
        for (const point of points) this.disc(point, r, net);
    }

    /** The shapes a painter recorded (`NullRenderer`), in board space. An
     *  arc is recorded twice, as itself and as the polyline the renderer
     *  draws it as; the polyline is taken. */
    shapes(shapes: unknown[], net: number) {
        for (const shape of shapes) {
            if (shape instanceof Circle) {
                this.disc(shape.center, shape.radius, net);
            } else if (shape instanceof Polyline) {
                this.line(shape.points, shape.width, net);
            } else if (shape instanceof Polygon) {
                if (shape.vertices) this.add(shape.vertices, net);
                else this.add(triangulate_flat(flat(shape.points)), net);
            }
        }
    }

    /** An outline less the holes in it (earcut, which takes holes). */
    pierced(outline: Vec2[], holes: Vec2[][], net: number) {
        const coords: number[] = [];
        const starts: number[] = [];
        for (const ring of [outline, ...holes]) {
            if (ring !== outline) starts.push(coords.length / 2);
            for (const point of ring) coords.push(point.x, point.y);
        }
        const indices = earcut(coords, starts);
        const out = new Array<number>(indices.length * 2);
        for (let i = 0; i < indices.length; i++) {
            out[i * 2] = coords[indices[i]! * 2]!;
            out[i * 2 + 1] = coords[indices[i]! * 2 + 1]!;
        }
        this.add(out, net);
    }

    done() {
        return {
            triangles: this.xy.slice(0, this.count * 2),
            nets: this.net.slice(0, this.count),
        };
    }
}

function flat(points: Vec2[]): Float64Array {
    const out = new Float64Array(points.length * 2);
    points.forEach((point, i) => {
        out[i * 2] = point.x;
        out[i * 2 + 1] = point.y;
    });
    return out;
}

/** Points round an arc of `radius` about `c` from `start` to `end` radians,
 *  the end included. */
function arc_points(c: Vec2, radius: number, start: number, end: number) {
    const n = Math.max(
        1,
        Math.ceil(
            (circle_segments(radius) * Math.abs(end - start)) / (2 * Math.PI),
        ),
    );
    return Array.from(
        { length: n + 1 },
        (_, i) =>
            new Vec2(
                c.x + radius * Math.cos(start + ((end - start) * i) / n),
                c.y + radius * Math.sin(start + ((end - start) * i) / n),
            ),
    );
}

/** A slot of `width` round a segment from `a` to `b` (a circle where they
 *  meet), counter-clockwise. */
function stadium(a: Vec2, b: Vec2, width: number): Vec2[] {
    const r = width / 2;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (a.equals(b)) return arc_points(a, r, 0, 2 * Math.PI).slice(0, -1);
    return [
        ...arc_points(b, r, angle - Math.PI / 2, angle + Math.PI / 2),
        ...arc_points(a, r, angle + Math.PI / 2, angle + (3 * Math.PI) / 2),
    ];
}

/** A rectangle `w` by `h` about the origin with corners rounded by `r`,
 *  counter-clockwise. */
function rounded_rect(w: number, h: number, r: number): Vec2[] {
    const [x, y] = [w / 2 - r, h / 2 - r];
    if (!(r > 0)) {
        return [
            new Vec2(-w / 2, -h / 2),
            new Vec2(w / 2, -h / 2),
            new Vec2(w / 2, h / 2),
            new Vec2(-w / 2, h / 2),
        ];
    }
    return [
        ...arc_points(new Vec2(x, y), r, 0, Math.PI / 2),
        ...arc_points(new Vec2(-x, y), r, Math.PI / 2, Math.PI),
        ...arc_points(new Vec2(-x, -y), r, Math.PI, (3 * Math.PI) / 2),
        ...arc_points(new Vec2(x, -y), r, (3 * Math.PI) / 2, 2 * Math.PI),
    ];
}

/** The drill of a pad as a ring in the pad's frame: a circle, or a slot
 *  along the longer side of an oval one; at the drill's offset, where the 2D
 *  board paints it (`PadPainter`). */
function drill_ring(drill: board_items.PadDrill): Vec2[] {
    const at = drill.offset;
    if (!drill.oval) {
        return arc_points(at, drill.diameter / 2, 0, 2 * Math.PI).slice(0, -1);
    }
    const half = new Vec2(drill.diameter / 2, (drill.width ?? 0) / 2);
    const r = Math.min(half.x, half.y);
    const along = new Vec2(half.x - r, half.y - r);
    return stadium(at.sub(along), at.add(along), r * 2);
}

/** A plated through pad's outline in its frame, the shapes `PadPainter`
 *  draws, or null for a custom pad, whose primitives the painter draws. */
function pad_outline(pad: board_items.Pad): Vec2[] | null {
    const offset = pad.drill?.offset ?? new Vec2(0, 0);
    const moved = (points: Vec2[]) => points.map((point) => point.add(offset));
    switch (pad.shape) {
        case "circle":
            return moved(
                arc_points(new Vec2(0, 0), pad.size.x / 2, 0, 2 * Math.PI).slice(
                    0,
                    -1,
                ),
            );
        case "oval": {
            const half = new Vec2(pad.size.x / 2, pad.size.y / 2);
            const r = Math.min(half.x, half.y);
            const along = new Vec2(half.x - r, half.y - r);
            return moved(
                stadium(new Vec2(0, 0).sub(along), along, r * 2),
            );
        }
        case "rect":
            return moved(rounded_rect(pad.size.x, pad.size.y, 0));
        case "roundrect":
            return moved(
                rounded_rect(
                    pad.size.x,
                    pad.size.y,
                    Math.min(pad.size.x, pad.size.y) *
                        (pad.roundrect_rratio ?? 0),
                ),
            );
        case "trapezoid": {
            const half = new Vec2(pad.size.x / 2, pad.size.y / 2);
            const delta = (pad.rect_delta ?? new Vec2(0, 0)).multiply(0.5);
            return moved([
                new Vec2(-half.x - delta.y, half.y + delta.x),
                new Vec2(half.x + delta.y, half.y - delta.x),
                new Vec2(half.x - delta.y, -half.y + delta.x),
                new Vec2(-half.x + delta.y, -half.y - delta.x),
            ]);
        }
        default:
            return null;
    }
}

/** The copper layers `pad` is on, among `layers`. */
function pad_layers(pad: board_items.Pad, layers: string[]): string[] {
    if (pad.layers.includes("*.Cu")) return layers;
    const both = pad.layers.includes("F&B.Cu");
    return layers.filter(
        (name) =>
            pad.layers.includes(name) ||
            (both && (name === "F.Cu" || name === "B.Cu")),
    );
}

/** A footprint's placement, as its painter puts it on the board. */
function footprint_matrix(fp: board_items.Footprint): Matrix3 {
    return Matrix3.translation(fp.at.position.x, fp.at.position.y).rotate_self(
        Angle.deg_to_rad(fp.at.rotation),
    );
}

/** A pad's frame in its footprint's, as `PadPainter` builds it, the shape's
 *  offset included. */
function pad_matrix(pad: board_items.Pad): Matrix3 {
    const matrix = Matrix3.translation(pad.at.position.x, pad.at.position.y)
        .rotate_self(-Angle.deg_to_rad(pad.parent.at.rotation))
        .rotate_self(Angle.deg_to_rad(pad.at.rotation));
    return matrix;
}

/**
 * The copper of `board`, which a board viewer has loaded, with that viewer's
 * view layers (`layers`, which the painters look up by name).
 */
export function board_copper(
    board: board_items.KicadPCB,
    layers: LayerSet,
): BoardCopper {
    const names = copper_layer_names(board);
    const stack = board_stack(board);
    const soups = new Map(names.map((name) => [name, new Soup()]));
    const gfx = new NullRenderer();
    const painter = new BoardPainter(gfx, layers, layers.theme);
    /** What a painter draws of `item` on the view layer `layer`. */
    const painted = (
        layer: string,
        item: unknown,
        matrix: Matrix3 | null,
    ): unknown[] => {
        const view = layers.by_name(layer);
        if (!view) return [];
        gfx.start_layer(layer);
        if (matrix) {
            gfx.state.push();
            gfx.state.multiply(matrix);
        }
        try {
            painter.paint_item(view, item);
        } finally {
            if (matrix) gfx.state.pop();
        }
        return gfx.end_layer().shapes;
    };

    // Zone fills: the triangles the loader made in its worker, or the ones the
    // 2D renderer would make of the outline.
    for (const zone of [
        ...board.zones,
        ...board.footprints.flatMap((fp) => fp.zones),
    ]) {
        for (const fill of zone.filled_polygons ?? []) {
            const soup = soups.get(fill.layer);
            if (!soup) continue;
            soup.add(fill.triangles ?? triangulate_flat(fill.coords), zone.net);
        }
    }

    for (const track of board.segments) {
        const soup = soups.get(track.layer);
        if (!soup) continue;
        const points =
            track instanceof board_items.ArcSegment
                ? Arc.from_three_points(
                      track.start,
                      track.mid,
                      track.end,
                      track.width,
                  ).to_polyline()
                : [track.start, track.end];
        soup.line(points, track.width, track.net);
    }

    // Copper graphics, the board's and the footprints', which have no net.
    for (const name of names) {
        const soup = soups.get(name)!;
        for (const drawing of board.drawings) {
            if (painter.layers_for(drawing).includes(name)) {
                soup.shapes(painted(name, drawing, null), 0);
            }
        }
        for (const fp of board.footprints) {
            soup.shapes(painted(name, fp, null), 0);
        }
    }

    const barrels: BoardBarrel[] = [];
    const last = names.length - 1;

    for (const fp of board.footprints) {
        const placed = footprint_matrix(fp);
        for (const pad of fp.pads) {
            if (pad.type === "np_thru_hole") continue;
            const net = pad.net?.number ?? 0;
            const on = pad_layers(pad, names);
            const outline =
                pad.type === "thru_hole" && pad.drill
                    ? pad_outline(pad)
                    : null;
            if (outline && pad.drill) {
                const to_board = placed.multiply(pad_matrix(pad));
                const board_points = (ring: Vec2[]) =>
                    ring.map((point) => to_board.transform(point));
                const hole = board_points(drill_ring(pad.drill));
                for (const name of on) {
                    soups
                        .get(name)!
                        .pierced(board_points(outline), [hole], net);
                }
                const centre = to_board.transform(pad.drill.offset);
                barrels.push({
                    x: centre.x,
                    y: centre.y,
                    radius:
                        (pad.drill.oval
                            ? Math.min(pad.drill.diameter, pad.drill.width ?? 0)
                            : pad.drill.diameter) / 2,
                    from: 0,
                    to: last,
                    net,
                });
                continue;
            }
            for (const name of on) {
                soups
                    .get(name)!
                    .shapes(
                        painted(
                            virtual_layer_for(name, CopperVirtualLayerNames.pads),
                            pad,
                            placed,
                        ),
                        net,
                    );
            }
            if (pad.type === "thru_hole" && pad.drill) {
                const centre = placed
                    .multiply(pad_matrix(pad))
                    .transform(pad.drill.offset);
                barrels.push({
                    x: centre.x,
                    y: centre.y,
                    radius: pad.drill.diameter / 2,
                    from: 0,
                    to: last,
                    net,
                });
            }
        }
    }

    for (const via of board.vias) {
        const span = via.layers
            ? [...copper_layers_between(via.layers[0]!, via.layers[1]!)].filter(
                  (name) => soups.has(name),
              )
            : names;
        if (!span.length) continue;
        for (const name of span) {
            soups
                .get(name)!
                .ring(via.at.position, via.size / 2, via.drill / 2, via.net);
        }
        barrels.push({
            x: via.at.position.x,
            y: via.at.position.y,
            radius: via.drill / 2,
            from: names.indexOf(span[0]!),
            to: names.indexOf(span[span.length - 1]!),
            net: via.net,
        });
    }

    const nets: string[] = [""];
    for (const net of board.nets) {
        if (net.number > 0) nets[net.number] = net.name;
    }
    for (let i = 0; i < nets.length; i++) nets[i] ??= "";

    return {
        nets,
        layers: names.map((name) => {
            const [bottom, top] = copper_z(stack, name);
            return { name, bottom, top, ...soups.get(name)!.done() };
        }),
        barrels,
    };
}
