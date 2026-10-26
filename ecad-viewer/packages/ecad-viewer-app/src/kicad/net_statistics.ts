import type { KicadPCB } from "./board";

/**
 * Routing summary for one board net, the numbers KiCad's Net Inspector shows.
 * Lengths are millimetres along track centrelines; pads and via barrels are
 * not counted. `layers` is every copper layer a track of this net sits on,
 * in board stack order.
 */
export interface NetStatistics {
    net: string;
    netCode: number;
    routedLength: number;
    layers: string[];
    trackCount: number;
    viaCount: number;
}

export interface NetStatisticsRef {
    name?: string;
    netCode?: number;
}

/**
 * Resolves `ref` against the board's net table, by name first and net code as
 * the fallback (net codes are per-file and shift between saves, names do not),
 * and sums its tracks, arcs and vias. Net 0 is KiCad's "no net" and resolves
 * to nothing.
 */
export function net_statistics(
    board: KicadPCB,
    ref: NetStatisticsRef,
): NetStatistics | null {
    const net =
        (ref.name ? board.nets.find((n) => n.name === ref.name) : undefined) ??
        (ref.netCode !== undefined
            ? board.nets.find((n) => n.number === ref.netCode)
            : undefined);
    if (!net || !net.number) return null;

    let routedLength = 0;
    let trackCount = 0;
    const layers = new Set<string>();
    for (const track of board.segments) {
        if (track.net !== net.number) continue;
        routedLength += track.routed_length;
        trackCount += 1;
        layers.add(track.layer);
    }
    let viaCount = 0;
    for (const via of board.vias) {
        if (via.net === net.number) viaCount += 1;
    }

    const order = new Map(
        board.layers.map((layer, index) => [layer.canonical_name, index]),
    );
    const by_stack = (a: string, b: string) =>
        (order.get(a) ?? order.size) - (order.get(b) ?? order.size) ||
        a.localeCompare(b);

    return {
        net: net.name,
        netCode: net.number,
        routedLength,
        layers: [...layers].sort(by_stack),
        trackCount,
        viaCount,
    };
}
