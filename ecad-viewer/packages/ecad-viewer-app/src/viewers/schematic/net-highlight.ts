/*
    Schematic net highlight and local trace: overlay scenes drawn over a sheet.

    A highlighted net is drawn as light on the sheet: every wire and pin of
    the net gets a soft halo, a glow and a crisp core in the net's colour,
    junctions a dot with a halo, and labels and sheet entries a thin outline
    over a faint wash. The sheet underneath is dimmed by the viewer
    (`content_dim`), so the net reads as the one thing lit.

    Both scenes take an `intensity` (0 to 1) so the viewer can fade them in
    and out, and a highlight takes the names of nets that were just added,
    which swell briefly as they arrive.
*/

import type { BBox, Vec2 } from "../../base/math";
import { NetLabel, type KicadSch } from "../../kicad/schematic";
import type {
    EcadOverlayPrimitive,
    EcadOverlayScene,
} from "../base/overlay-scene";

/**
 * One highlighted net, as the host knows it: the items it owns on each sheet
 * instance. The viewer has no netlist of its own, so membership comes from the
 * host (Prism's semantic index lists a net's wires, labels, junctions, sheet
 * entries and pins per sheet instance).
 */
export type SchematicNetMembers = {
    name: string;
    /** CSS colour of the overlay; a bright default when absent. */
    color?: string;
    pages: Array<{ sheetPath: string; uuids: string[] }>;
};

export const NET_HIGHLIGHT_CHANNEL = "schematic-net-highlight";
export const LOCAL_TRACE_CHANNEL = "schematic-local-trace";

/** Document layers are drawn at this opacity under a full net highlight. */
export const NET_HIGHLIGHT_DIM = 0.24;

const DEFAULT_COLORS = ["#ffb020", "#22d3ee", "#f472b6", "#a3e635", "#c084fc"];

/** Halo, glow and core of a lit segment: width (mm) and opacity. */
const HALO = { width: 2.2, opacity: 0.1 };
const GLOW = { width: 0.95, opacity: 0.32 };
const CORE = { width: 0.32, opacity: 1 };

/** The colour of the n-th highlighted net, unless the host gave one. */
export function net_color(net: SchematicNetMembers, index: number): string {
    return net.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!;
}

/** The uuids each net owns on one sheet instance. */
export function members_on_page(
    nets: readonly SchematicNetMembers[],
    sheet_path: string,
): Array<{ net: SchematicNetMembers; index: number; uuids: Set<string> }> {
    const found = [];
    for (const [index, net] of nets.entries()) {
        const uuids = new Set<string>();
        for (const page of net.pages) {
            if (page.sheetPath !== sheet_path) continue;
            for (const uuid of page.uuids) uuids.add(uuid);
        }
        if (uuids.size) found.push({ net, index, uuids });
    }
    return found;
}

/** What a scene needs from the sheet it is drawn over. */
export interface SheetGeometry {
    /** An item's painted bounds. */
    bbox(uuid: string): BBox | undefined;
    /** A pin's line, from the symbol body to its connection point. */
    pin_stem(uuid: string): [Vec2, Vec2] | undefined;
}

export interface HighlightMotion {
    /** How lit the scene is: 0 is not drawn, 1 is fully lit. */
    intensity: number;
    /** Nets just added and how far they still swell (1 at arrival, then 0). */
    swell?: ReadonlyMap<string, number>;
}

const origin = { kind: "world" as const, x: 0, y: 0 };

/** A lit run of points: halo, glow and core. */
function lit_run(
    id: string,
    points: Array<[number, number]>,
    color: string,
    intensity: number,
    swell: number,
): EcadOverlayPrimitive[] {
    const grow = 1 + 0.6 * swell;
    return [
        {
            id: `halo:${id}`,
            kind: "polyline",
            anchor: origin,
            points,
            stroke: color,
            strokeWidth: HALO.width * grow,
            opacity: HALO.opacity * intensity,
        },
        {
            id: `glow:${id}`,
            kind: "polyline",
            anchor: origin,
            points,
            stroke: color,
            strokeWidth: GLOW.width * grow,
            opacity: (GLOW.opacity + 0.2 * swell) * intensity,
        },
        {
            id: `core:${id}`,
            kind: "polyline",
            anchor: origin,
            points,
            stroke: color,
            strokeWidth: CORE.width,
            opacity: CORE.opacity * intensity,
        },
    ];
}

/** A label or entry: a faint wash under a thin outline. */
function lit_box(
    id: string,
    box: BBox,
    color: string,
    intensity: number,
): EcadOverlayPrimitive[] {
    const anchor = {
        kind: "bbox" as const,
        bounds: [box.x, box.y, box.w, box.h] as [
            number,
            number,
            number,
            number,
        ],
    };
    return [
        {
            id: `wash:${id}`,
            kind: "bbox",
            anchor,
            padding: 0.35,
            fill: color,
            stroke: color,
            strokeWidth: 0.01,
            opacity: 0.16 * intensity,
        },
        {
            id: `edge:${id}`,
            kind: "bbox",
            anchor,
            padding: 0.35,
            stroke: color,
            strokeWidth: 0.2,
            opacity: 0.95 * intensity,
        },
    ];
}

/** The overlay that lights each net's members on the open sheet. */
export function net_highlight_scene(
    nets: readonly SchematicNetMembers[],
    sheet_path: string,
    document: KicadSch,
    sheet: SheetGeometry,
    motion: HighlightMotion = { intensity: 1 },
): EcadOverlayScene {
    const primitives: EcadOverlayPrimitive[] = [];
    const intensity = motion.intensity;
    for (const { net, index, uuids } of members_on_page(nets, sheet_path)) {
        const color = net_color(net, index);
        const swell = motion.swell?.get(net.name) ?? 0;
        const seen = new Set<string>();
        for (const wire of document.wires) {
            if (!uuids.has(wire.uuid) || wire.pts.length < 2) continue;
            seen.add(wire.uuid);
            primitives.push(
                ...lit_run(
                    wire.uuid,
                    wire.pts.map((pt) => [pt.x, pt.y]),
                    color,
                    intensity,
                    swell,
                ),
            );
        }
        for (const junction of document.junctions) {
            if (!uuids.has(junction.uuid)) continue;
            seen.add(junction.uuid);
            const at = junction.at.position;
            const anchor = { kind: "world" as const, x: at.x, y: at.y };
            primitives.push(
                {
                    id: `halo:${junction.uuid}`,
                    kind: "marker",
                    anchor,
                    radius: 1.1 * (1 + 0.6 * swell),
                    fill: color,
                    opacity: 0.22 * intensity,
                },
                {
                    id: `dot:${junction.uuid}`,
                    kind: "marker",
                    anchor,
                    radius: 0.5,
                    fill: color,
                    opacity: intensity,
                },
            );
        }
        for (const uuid of uuids) {
            if (seen.has(uuid)) continue;
            const stem = sheet.pin_stem(uuid);
            if (stem) {
                primitives.push(
                    ...lit_run(
                        uuid,
                        stem.map((p) => [p.x, p.y] as [number, number]),
                        color,
                        intensity,
                        swell,
                    ),
                );
                continue;
            }
            const box = sheet.bbox(uuid);
            if (box) primitives.push(...lit_box(uuid, box, color, intensity));
        }
    }
    return {
        channelId: NET_HIGHLIGHT_CHANNEL,
        context: "SCH",
        placement: "foreground",
        visible: primitives.length > 0 && intensity > 0,
        primitives,
    };
}

/**
 * The open sheet's local labels named `name`, joined in a chain: each label
 * lit like a highlighted one, and a dashed line from each to the next.
 */
export function local_trace_scene(
    name: string,
    document: KicadSch,
    sheet: Pick<SheetGeometry, "bbox">,
    intensity = 1,
    color = DEFAULT_COLORS[0]!,
): EcadOverlayScene {
    const boxes: BBox[] = [];
    for (const label of document.labels) {
        if (!(label instanceof NetLabel) || label.text !== name || !label.uuid)
            continue;
        const box = sheet.bbox(label.uuid);
        if (box) boxes.push(box);
    }
    boxes.sort((a, b) => a.x - b.x || a.y - b.y);
    const primitives: EcadOverlayPrimitive[] = [];
    boxes.forEach((box, i) => {
        primitives.push(...lit_box(`label:${i}`, box, color, intensity));
        if (!i) return;
        const a = boxes[i - 1]!.center;
        const b = box.center;
        const points: Array<[number, number]> = [
            [a.x, a.y],
            [b.x, b.y],
        ];
        primitives.push(
            {
                id: `glow:${i}`,
                kind: "polyline",
                anchor: origin,
                points,
                stroke: color,
                strokeWidth: GLOW.width,
                opacity: 0.18 * intensity,
            },
            {
                id: `line:${i}`,
                kind: "polyline",
                anchor: origin,
                points,
                stroke: color,
                strokeWidth: CORE.width,
                dash: [1.5, 1],
                opacity: intensity,
            },
        );
    });
    return {
        channelId: LOCAL_TRACE_CHANNEL,
        context: "SCH",
        placement: "foreground",
        visible: primitives.length > 0 && intensity > 0,
        primitives,
    };
}
