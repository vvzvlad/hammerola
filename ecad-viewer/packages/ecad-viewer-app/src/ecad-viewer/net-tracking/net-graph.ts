/*
    The schematic's net graph, as far as names and wires tell it: where a
    label, sheet entry or power symbol leads.

    One hop (`net_instances`):
    - a global label leads to every global label of its name, on every sheet
      instance;
    - a hierarchical label leads up, to the entry on the sheet symbol that
      instantiates its page; an entry leads down, to the matching
      hierarchical label in each page it instantiates;
    - a power symbol leads to one symbol of its rail on each other sheet (a
      rail is on most sheets many times over); PWR_FLAG names no rail;
    - a local label leads to its namesakes on its own sheet.

    On one sheet, wires join labels, entries and power symbols into one net
    (`wired_instances`), and `net_closure` walks both until nothing new turns
    up: the reach a chain on the schematic plane draws.

    The viewer has no netlist; a host with one can refine membership.
*/

import { Vec2 } from "../../base/math";
import {
    GlobalLabel,
    HierarchicalLabel,
    Label,
    NetLabel,
    PinInstance,
    SchematicSymbol,
    type KicadSch,
    type SchematicInstanceContext,
} from "../../kicad/schematic";

export interface NetInstancePage {
    key: string;
    name: string;
    document: KicadSch;
    /** The page this one was instantiated from, and by which sheet symbol. */
    parent_key?: string;
    sheet_uuid?: string;
    /** The instance path (`/root/sheet`), as hosts name sheets in net members. */
    sheet_path?: string;
    /** KiCad's page number of this instance, as its sheet symbol places it. */
    number?: string;
    /** Per-instance values (a power symbol's rail name). */
    context?: SchematicInstanceContext;
}

export type NetInstanceKind =
    | "global"
    | "hierarchical"
    | "sheet-pin"
    | "local"
    | "power";

export interface NetInstance {
    page: string;
    uuid: string;
    name: string;
    kind: NetInstanceKind;
}

/**
 * What a double-click traces from: a label or sheet entry, or a power symbol
 * (clicked on the symbol or on its pin). Null otherwise; a wire is not traced.
 * Here so the schematic viewers can ask it without importing the plane's
 * scenes, which import the viewer.
 */
export function traceable_uuid(item: unknown): string | null {
    if (item instanceof Label && item.uuid) return item.uuid;
    const symbol =
        item instanceof PinInstance
            ? item.parent
            : item instanceof SchematicSymbol
              ? item
              : null;
    return symbol && is_power(symbol) ? symbol.uuid : null;
}

/** What the label `uuid` on page `page_key` is, if it is one. */
export function net_instance_at(
    pages: readonly NetInstancePage[],
    page_key: string,
    uuid: string,
): NetInstance | null {
    const page = pages.find((candidate) => candidate.key === page_key);
    if (!page) return null;
    for (const label of page.document.labels) {
        if (label.uuid !== uuid) continue;
        const kind: NetInstanceKind | null =
            label instanceof GlobalLabel
                ? "global"
                : label instanceof HierarchicalLabel
                  ? "hierarchical"
                  : label instanceof NetLabel
                    ? "local"
                    : null;
        return kind ? { page: page_key, uuid, name: label.text, kind } : null;
    }
    const symbol = page.document.symbols.get(uuid);
    if (symbol && is_power(symbol))
        return {
            page: page_key,
            uuid,
            name: power_name(symbol, page),
            kind: "power",
        };
    for (const sheet of page.document.sheets) {
        for (const pin of sheet.pins) {
            if (pin.uuid === uuid)
                return {
                    page: page_key,
                    uuid,
                    name: pin.name,
                    kind: "sheet-pin",
                };
        }
    }
    return null;
}

/** The other instances `from` connects to, nearest hop only. */
export function net_instances(
    pages: readonly NetInstancePage[],
    from: NetInstance,
): NetInstance[] {
    const found: NetInstance[] = [];
    const page = pages.find((candidate) => candidate.key === from.page);
    if (!page) return found;
    const labels = (
        candidate: NetInstancePage,
        type: typeof GlobalLabel | typeof HierarchicalLabel | typeof NetLabel,
    ) =>
        candidate.document.labels.filter(
            (label) => label instanceof type && label.text === from.name,
        );

    if (from.kind === "power") {
        // A rail is on most sheets many times over: one symbol per other
        // sheet stands for it there.
        for (const candidate of pages) {
            if (candidate.key === from.page) continue;
            const symbol = power_symbols(candidate).find(
                (it) => power_name(it, candidate) === from.name,
            );
            if (symbol)
                found.push({
                    page: candidate.key,
                    uuid: symbol.uuid,
                    name: from.name,
                    kind: "power",
                });
        }
    } else if (from.kind === "global") {
        for (const candidate of pages)
            for (const label of labels(candidate, GlobalLabel))
                if (
                    label.uuid &&
                    !(candidate.key === from.page && label.uuid === from.uuid)
                )
                    found.push({
                        page: candidate.key,
                        uuid: label.uuid,
                        name: label.text,
                        kind: "global",
                    });
    } else if (from.kind === "hierarchical") {
        const parent = pages.find(
            (candidate) => candidate.key === page.parent_key,
        );
        const sheet = parent?.document.sheets.find(
            (candidate) => candidate.uuid === page.sheet_uuid,
        );
        for (const pin of sheet?.pins ?? [])
            if (pin.name === from.name && pin.uuid)
                found.push({
                    page: parent!.key,
                    uuid: pin.uuid,
                    name: pin.name,
                    kind: "sheet-pin",
                });
    } else if (from.kind === "sheet-pin") {
        const sheet = page.document.sheets.find((candidate) =>
            candidate.pins.some((pin) => pin.uuid === from.uuid),
        );
        for (const child of pages) {
            if (
                child.parent_key !== page.key ||
                child.sheet_uuid !== sheet?.uuid
            )
                continue;
            for (const label of labels(child, HierarchicalLabel))
                if (label.uuid)
                    found.push({
                        page: child.key,
                        uuid: label.uuid,
                        name: label.text,
                        kind: "hierarchical",
                    });
        }
    } else {
        for (const label of labels(page, NetLabel))
            if (label.uuid && label.uuid !== from.uuid)
                found.push({
                    page: page.key,
                    uuid: label.uuid,
                    name: label.text,
                    kind: "local",
                });
    }
    return found;
}

/** A label's whole reach across sheets: every instance and the hops between. */
export interface NetClosure {
    instances: NetInstance[];
    /** Each hop, from the side nearer the starting label to the farther. */
    links: Array<[NetInstance, NetInstance]>;
    /** Hops from the starting label, by `page#uuid`. */
    depth: Map<string, number>;
}

export const instance_key = (it: NetInstance) => `${it.page}#${it.uuid}`;

/**
 * Follow `from` across sheets until nothing new turns up: global labels by
 * name, sheet entries down and hierarchical labels up, local labels to their
 * namesakes on their sheet. Every link points away from `from`. Global
 * labels of one name fan out from the first of them reached, and local
 * labels of one name on one sheet from the first of them reached there; the
 * plane joins the places they reach by a tree of its own (`spanning_pairs`).
 */
export function net_closure(
    pages: readonly NetInstancePage[],
    from: NetInstance,
): NetClosure {
    const key = instance_key;
    const found = new Map<string, NetInstance>([[key(from), from]]);
    const depth = new Map<string, number>([[key(from), 0]]);
    const links: Array<[NetInstance, NetInstance]> = [];
    const linked = new Set<string>();
    const queue = [from];
    const rails = new Set<string>();
    while (queue.length) {
        const at = queue.shift()!;
        // The same sheet's wires carry the net to other labels and entries;
        // that hop is not drawn and does not count as a step away.
        for (const other of wired_instances(pages, at)) {
            if (found.has(key(other))) continue;
            found.set(key(other), other);
            depth.set(key(other), depth.get(key(at))!);
            queue.unshift(other);
        }
        // A rail fans out once, from the first of its symbols reached: the
        // symbols it reaches on other sheets are already that rail.
        if (at.kind === "power") {
            if (rails.has(at.name)) continue;
            rails.add(at.name);
        }
        for (const other of net_instances(pages, at)) {
            const id = [key(at), key(other)].sort().join("|");
            if (found.has(key(other))) continue;
            found.set(key(other), other);
            depth.set(key(other), depth.get(key(at))! + 1);
            queue.push(other);
            if (!linked.has(id)) {
                linked.add(id);
                links.push([at, other]);
            }
        }
    }
    return { instances: [...found.values()], links, depth };
}

const EPS = 0.01;

const on_segment = (p: Vec2, a: Vec2, b: Vec2) => {
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) > EPS * Math.max(1, a.sub(b).magnitude)) return false;
    return (
        p.x >= Math.min(a.x, b.x) - EPS &&
        p.x <= Math.max(a.x, b.x) + EPS &&
        p.y >= Math.min(a.y, b.y) - EPS &&
        p.y <= Math.max(a.y, b.y) + EPS
    );
};

/** The labels and sheet entries on a page, with where they connect. */
function connection_points(
    pages: readonly NetInstancePage[],
    page: NetInstancePage,
) {
    const points: Array<{ instance: NetInstance; at: Vec2 }> = [];
    for (const label of page.document.labels) {
        if (!label.uuid) continue;
        const found = net_instance_at(pages, page.key, label.uuid);
        if (found) points.push({ instance: found, at: label.at.position });
    }
    // A power symbol's one pin sits at the symbol's origin.
    for (const symbol of power_symbols(page))
        points.push({
            instance: {
                page: page.key,
                uuid: symbol.uuid,
                name: power_name(symbol, page),
                kind: "power",
            },
            at: symbol.at.position,
        });
    for (const sheet of page.document.sheets)
        for (const pin of sheet.pins)
            if (pin.uuid)
                points.push({
                    instance: {
                        page: page.key,
                        uuid: pin.uuid,
                        name: pin.name,
                        kind: "sheet-pin",
                    },
                    at: pin.at.position,
                });
    return points;
}

/**
 * The labels and sheet entries wires join to the segments `seed` picks:
 * wires touching end to end, or an end on another's run, form one net.
 */
function wired_from(
    pages: readonly NetInstancePage[],
    page: NetInstancePage,
    seed: (segment: readonly [Vec2, Vec2]) => boolean,
): NetInstance[] {
    const segments = page.document.wires.flatMap((wire) =>
        wire.pts.slice(1).map((end, i) => ({
            ends: [wire.pts[i]!, end] as const,
        })),
    );
    const touches = (p: Vec2, [a, b]: readonly [Vec2, Vec2]) =>
        on_segment(p, a, b);
    const reached = new Set<number>();
    const queue: number[] = [];
    segments.forEach((segment, i) => {
        if (seed(segment.ends)) {
            reached.add(i);
            queue.push(i);
        }
    });
    while (queue.length) {
        const [a, b] = segments[queue.shift()!]!.ends;
        segments.forEach(({ ends }, i) => {
            if (reached.has(i)) return;
            const [c, d] = ends;
            if (
                touches(c, [a, b]) ||
                touches(d, [a, b]) ||
                touches(a, ends) ||
                touches(b, ends)
            ) {
                reached.add(i);
                queue.push(i);
            }
        });
    }
    return connection_points(pages, page)
        .filter((point) =>
            [...reached].some((i) => touches(point.at, segments[i]!.ends)),
        )
        .map((point) => point.instance);
}

/** The labels and sheet entries on `at`'s own sheet that wires join it to. */
export function wired_instances(
    pages: readonly NetInstancePage[],
    at: NetInstance,
): NetInstance[] {
    const page = pages.find((candidate) => candidate.key === at.page);
    if (!page) return [];
    const start = connection_points(pages, page).find(
        (point) => point.instance.uuid === at.uuid,
    );
    if (!start) return [];
    return wired_from(pages, page, (ends) =>
        on_segment(start.at, ends[0], ends[1]),
    ).filter((it) => it.uuid !== at.uuid);
}

/**
 * A power symbol that names a rail. KiCad's PWR_FLAG is a power symbol too,
 * but it only tells ERC a rail is driven and sits on many rails at once, so
 * it names no net and joins nothing.
 */
export function is_power(symbol: SchematicSymbol) {
    try {
        if (symbol.lib_symbol?.power !== true) return false;
    } catch {
        return false;
    }
    return !is_pwr_flag(symbol);
}

function is_pwr_flag(symbol: SchematicSymbol) {
    const lib = symbol.lib_name ?? symbol.lib_id ?? "";
    return (
        lib === "PWR_FLAG" ||
        lib.endsWith(":PWR_FLAG") ||
        symbol.value === "PWR_FLAG"
    );
}

function power_symbols(page: NetInstancePage): SchematicSymbol[] {
    return [...page.document.symbols.values()].filter(is_power);
}

/** The rail a power symbol names: its value on this sheet instance. */
function power_name(symbol: SchematicSymbol, page: NetInstancePage) {
    return page.context?.value(symbol) ?? symbol.value;
}
