/**
 * Point-to-point measurement on the board: snap targets and the arithmetic.
 *
 * Snap points come from the board model, not from the painted scene. A pad
 * or via snaps to its anchor (the hole, for a through pad), which is the
 * point KiCad's own measure tool and its pad properties report.
 *
 * Three kinds of target, ranked in this order:
 * - areas: a pad or via whose copper is under the pointer snaps to its
 *   anchor wherever on the copper the pointer is, so a large connector pad
 *   is as easy to hit as a small one;
 * - points within the snap radius, by kind (pad, via, track end, board
 *   edge corner) and then by distance;
 * - curves within the radius: the nearest point on a track's centreline or
 *   on the board edge, straight or arc, by kind and then by distance.
 * Nothing in reach is a free point.
 */
import { Angle, Arc as MathArc, Matrix3, Vec2 } from "../../base/math";
import {
    ArcSegment,
    GrArc,
    GrCircle,
    GrLine,
    GrPoly,
    GrRect,
    GraphicItem,
    LineSegment,
    Pad,
    Via,
    type KicadPCB,
} from "../../kicad/board";
import { LayerNames } from "./layers";

export type MeasureSnapKind =
    | "pad"
    | "via"
    | "track-end"
    | "edge-corner"
    | "track"
    | "edge"
    | "free";

/** Lower wins, among targets of the same rank. */
const PRIORITY: Record<MeasureSnapKind, number> = {
    pad: 0,
    via: 1,
    "track-end": 2,
    "edge-corner": 3,
    track: 4,
    edge: 5,
    free: 6,
};

export type MeasureUnits = "mm" | "mil";

export const MM_PER_MIL = 0.0254;

export interface MeasureSnap {
    kind: MeasureSnapKind;
    /** Board millimetres. */
    x: number;
    y: number;
    /** "U1 · 25", "via", "track", "board edge"; empty for a free point. */
    label: string;
    /** Net name, when the target has one. */
    net: string | null;
}

export interface Measurement {
    a: MeasureSnap;
    b: MeasureSnap;
    /** Board millimetres. */
    distance: number;
    /** Absolute horizontal and vertical extents, millimetres. */
    dx: number;
    dy: number;
    /** Angle of a→b above the board's horizontal, degrees, 0–90. */
    angle: number;
}

/** Anything the snap index can test for visibility. */
export type SnapItem = Pad | Via | LineSegment | ArcSegment | GraphicItem;

/** World-space box: x0, y0, x1, y1. */
type Box = [number, number, number, number];

interface Target {
    kind: Exclude<MeasureSnapKind, "free">;
    item: SnapItem;
    box: Box;
    /** The point this target offers for `at`. */
    nearest(at: Vec2): Vec2;
    /** Areas only: whether `at` is on the target's copper. */
    contains?(at: Vec2): boolean;
}

/** Grid cell size in millimetres. */
const CELL = 2;

export function pad_center(pad: Pad): Vec2 {
    const fp = pad.parent;
    const theta = (fp.at.rotation * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const { x, y } = pad.at.position;
    return new Vec2(
        fp.at.position.x + x * cos + y * sin,
        fp.at.position.y - x * sin + y * cos,
    );
}

export function measure(a: MeasureSnap, b: MeasureSnap): Measurement {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    return {
        a,
        b,
        distance: Math.hypot(dx, dy),
        dx,
        dy,
        angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    };
}

/** 3 decimals in millimetres, 1 in mils (P-VT-6). */
export function format_length(mm: number, units: MeasureUnits): string {
    return units === "mil"
        ? `${(mm / MM_PER_MIL).toFixed(1)} mil`
        : `${mm.toFixed(3)} mm`;
}

/**
 * Snap targets of one board, bucketed on a uniform grid by their extent so a
 * query touches only the cells around the pointer.
 */
export class SnapIndex {
    #cells = new Map<string, Target[]>();

    constructor(readonly board: KicadPCB) {
        for (const fp of board.footprints)
            for (const pad of fp.pads) this.#add(pad_target(pad));
        for (const via of board.vias) this.#add(via_target(via));
        for (const track of board.segments) {
            for (const end of [track.start, track.end])
                this.#add(point_target("track-end", track, end));
            this.#add(
                track instanceof LineSegment
                    ? line_target("track", track, track.start, track.end)
                    : arc_target(
                          "track",
                          track,
                          track.start,
                          track.mid,
                          track.end,
                      ),
            );
        }
        for (const drawing of board.drawings)
            if (
                drawing instanceof GraphicItem &&
                drawing.layer === LayerNames.edge_cuts
            )
                for (const target of edge_targets(drawing)) this.#add(target);
    }

    #add(target: Target) {
        const [x0, y0, x1, y1] = target.box;
        for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++)
            for (
                let cy = Math.floor(y0 / CELL);
                cy <= Math.floor(y1 / CELL);
                cy++
            ) {
                const key = `${cx}:${cy}`;
                const bucket = this.#cells.get(key);
                if (bucket) bucket.push(target);
                else this.#cells.set(key, [target]);
            }
    }

    /**
     * The best snap for `at` within `radius` millimetres, or a free point.
     * `visible` filters targets on hidden or non-isolated layers.
     */
    snap(
        at: Vec2,
        radius: number,
        visible: (item: SnapItem) => boolean,
    ): MeasureSnap {
        const r2 = radius * radius;
        const seen = new Set<Target>();
        let best: { target: Target; p: Vec2; rank: number[] } | null = null;
        for (
            let cx = Math.floor((at.x - radius) / CELL);
            cx <= Math.floor((at.x + radius) / CELL);
            cx++
        )
            for (
                let cy = Math.floor((at.y - radius) / CELL);
                cy <= Math.floor((at.y + radius) / CELL);
                cy++
            )
                for (const target of this.#cells.get(`${cx}:${cy}`) ?? []) {
                    if (seen.has(target)) continue;
                    seen.add(target);
                    const p = target.nearest(at);
                    const d2 = (p.x - at.x) ** 2 + (p.y - at.y) ** 2;
                    const inside = target.contains?.(at) ?? false;
                    if (!inside && d2 > r2) continue;
                    const rank = [inside ? 0 : 1, PRIORITY[target.kind], d2];
                    if (best && !ranks_before(rank, best.rank)) continue;
                    if (!visible(target.item)) continue;
                    best = { target, p, rank };
                }

        if (!best)
            return { kind: "free", x: at.x, y: at.y, label: "", net: null };
        const { target, p } = best;
        return {
            kind: target.kind,
            x: p.x,
            y: p.y,
            label: snap_label(target),
            net: this.#net(target.item),
        };
    }

    #net(item: SnapItem): string | null {
        if (item instanceof Pad) return item.net?.name || null;
        if (item instanceof GraphicItem) return null;
        return this.board.getNetName(item.net) || null;
    }
}

const ranks_before = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return false;
};

function snap_label(target: Target): string {
    const item = target.item;
    if (item instanceof Pad) {
        const ref = item.parent.reference;
        return item.number ? `${ref} · ${item.number}` : ref;
    }
    switch (target.kind) {
        case "via":
            return "via";
        case "track-end":
            return "track end";
        case "edge-corner":
            return "edge corner";
        case "edge":
            return "board edge";
        default:
            return "track";
    }
}

const box_around = (points: Vec2[], grow = 0): Box => [
    Math.min(...points.map((p) => p.x)) - grow,
    Math.min(...points.map((p) => p.y)) - grow,
    Math.max(...points.map((p) => p.x)) + grow,
    Math.max(...points.map((p) => p.y)) + grow,
];

function point_target(kind: Target["kind"], item: SnapItem, at: Vec2): Target {
    const p = new Vec2(at.x, at.y);
    return { kind, item, box: box_around([p]), nearest: () => p };
}

/**
 * A pad: its anchor, and its copper as the area that snaps to it. The shape
 * is tested in the pad's own frame, the transform its bbox uses; round pads
 * are discs, everything else its size rectangle.
 */
function pad_target(pad: Pad): Target {
    const center = pad_center(pad);
    const fp = pad.parent;
    // Pad.bbox maps its shape to the board as footprint(placement(shape));
    // undo both, footprint first.
    const footprint = Matrix3.translation(fp.at.position.x, fp.at.position.y)
        .rotate_self(Angle.deg_to_rad(fp.at.rotation))
        .inverse();
    const placement = Matrix3.translation(pad.at.position.x, pad.at.position.y)
        .rotate_self(-Angle.deg_to_rad(fp.at.rotation))
        .rotate_self(Angle.deg_to_rad(pad.at.rotation));
    if (pad.drill?.offset)
        placement.translate_self(pad.drill.offset.x, pad.drill.offset.y);
    const from_footprint = placement.inverse();
    const to_local = (at: Vec2) =>
        from_footprint.transform(footprint.transform(at));
    const w = pad.size.x / 2;
    const h = pad.size.y / 2;
    const reach =
        Math.hypot(w, h) +
        Math.hypot(pad.drill?.offset?.x ?? 0, pad.drill?.offset?.y ?? 0);
    return {
        kind: "pad",
        item: pad,
        box: box_around([center], reach),
        nearest: () => center,
        contains: (at) => {
            const local = to_local(at);
            return pad.shape === "circle"
                ? Math.hypot(local.x, local.y) <= w
                : Math.abs(local.x) <= w && Math.abs(local.y) <= h;
        },
    };
}

function via_target(via: Via): Target {
    const center = new Vec2(via.at.position.x, via.at.position.y);
    const r = via.size / 2;
    return {
        kind: "via",
        item: via,
        box: box_around([center], r),
        nearest: () => center,
        contains: (at) => Math.hypot(at.x - center.x, at.y - center.y) <= r,
    };
}

function line_target(
    kind: Target["kind"],
    item: SnapItem,
    a: Vec2,
    b: Vec2,
): Target {
    return {
        kind,
        item,
        box: box_around([a, b]),
        nearest: (at) => nearest_on_segment(at, a, b),
    };
}

/** An arc through `start`, `mid` and `end`; its nearest point stays on the swept part. */
function arc_target(
    kind: Target["kind"],
    item: SnapItem,
    start: Vec2,
    mid: Vec2,
    end: Vec2,
): Target {
    const arc = MathArc.from_three_points(start, mid, end);
    const center = arc.center;
    const from = arc.start_angle.radians;
    const sweep = arc.end_angle.radians - from;
    return {
        kind,
        item,
        box: box_around([center], arc.radius),
        nearest: (at) => {
            const angle = Math.atan2(at.y - center.y, at.x - center.x);
            const turn = 2 * Math.PI;
            const along =
                ((((angle - from) * Math.sign(sweep)) % turn) + turn) % turn;
            if (along <= Math.abs(sweep))
                return new Vec2(
                    center.x + arc.radius * Math.cos(angle),
                    center.y + arc.radius * Math.sin(angle),
                );
            const ds = Math.hypot(at.x - start.x, at.y - start.y);
            const de = Math.hypot(at.x - end.x, at.y - end.y);
            return ds <= de ? start : end;
        },
    };
}

function circle_target(item: SnapItem, center: Vec2, radius: number): Target {
    return {
        kind: "edge",
        item,
        box: box_around([center], radius),
        nearest: (at) => {
            const d = Math.hypot(at.x - center.x, at.y - center.y);
            if (d === 0) return new Vec2(center.x + radius, center.y);
            return new Vec2(
                center.x + ((at.x - center.x) / d) * radius,
                center.y + ((at.y - center.y) / d) * radius,
            );
        },
    };
}

/**
 * The board outline: every edge as a curve, every vertex as a corner, and a
 * circle's centre as a corner (a mounting hole drawn on Edge.Cuts).
 */
function edge_targets(drawing: GraphicItem): Target[] {
    const corner = (p: Vec2) => point_target("edge-corner", drawing, p);
    const polyline = (points: Vec2[], closed: boolean) => {
        const targets = points.map(corner);
        const last = closed ? points.length : points.length - 1;
        for (let i = 0; i < last; i++)
            targets.push(
                line_target(
                    "edge",
                    drawing,
                    points[i]!,
                    points[(i + 1) % points.length]!,
                ),
            );
        return targets;
    };
    if (drawing instanceof GrLine)
        return polyline([drawing.start, drawing.end], false);
    if (drawing instanceof GrRect) {
        const { start: a, end: b } = drawing;
        return polyline([a, new Vec2(b.x, a.y), b, new Vec2(a.x, b.y)], true);
    }
    if (drawing instanceof GrArc)
        return [
            corner(drawing.start),
            corner(drawing.end),
            arc_target(
                "edge",
                drawing,
                drawing.start,
                drawing.mid,
                drawing.end,
            ),
        ];
    if (drawing instanceof GrCircle) {
        const radius = Math.hypot(
            drawing.end.x - drawing.center.x,
            drawing.end.y - drawing.center.y,
        );
        return [
            corner(drawing.center),
            circle_target(drawing, drawing.center, radius),
        ];
    }
    if (drawing instanceof GrPoly) {
        const points = drawing.pts.flatMap((pt) =>
            pt instanceof Vec2 ? [pt] : [],
        );
        return polyline(points, true);
    }
    return [];
}

function nearest_on_segment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t =
        len2 === 0
            ? 0
            : Math.max(
                  0,
                  Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2),
              );
    return new Vec2(a.x + vx * t, a.y + vy * t);
}
