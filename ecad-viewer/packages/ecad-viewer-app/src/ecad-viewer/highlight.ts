/*
    Highlighted-net set at the host boundary.

    A host (or the standalone element) names nets by their board net name;
    KiCad net codes are load-local and only ever a hint. The board viewer
    keeps the set as codes and paints it; this module resolves between the
    two and carries the change event hosts subscribe to.
*/

import type { KicadPCB } from "../kicad/board";

/** A board net as hosts refer to it. `name` is the board net name. */
export type EcadNetRef = {
    name: string;
    /** Board-local code, valid only for the loaded board. Optional hint. */
    netCode?: number;
    /** Copper item uuids of the net, for hosts whose net names differ. */
    uuids?: readonly string[];
};

export type EcadHighlightChangeDetail = {
    /** The resulting set, in insertion order. */
    nets: EcadNetRef[];
    /**
     * Why the element changed the set itself: a standalone shift-click, a
     * double-click / requestCrossProbe replace-of-one, or a clear.
     */
    source: "gesture" | "crossprobe" | "clear";
};

/**
 * Emitted whenever the element changes the highlighted set on its own, so a
 * host that mirrors it stays in step. Not emitted for `setHighlightedNets`,
 * whose caller already knows.
 */
export class EcadHighlightChangeEvent extends CustomEvent<EcadHighlightChangeDetail> {
    static readonly type = "ecad-viewer:highlight-change";

    constructor(detail: EcadHighlightChangeDetail) {
        super(EcadHighlightChangeEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

/**
 * Resolve a host net reference to a board net code. The name wins (KiCad 10
 * boards synthesise codes from names, and a 3D viewer's ids are not board
 * codes); the code is used only when the name is absent or unknown. Copper
 * uuids from a semantic index are the last resort. Net 0 is "no net".
 */
export function resolve_board_net(
    board: KicadPCB,
    ref:
        | (EcadNetRef & { uuids?: readonly string[] })
        | { name?: string; netCode?: number; uuids?: readonly string[] },
): number | undefined {
    const name = ref.name?.trim();
    if (name) {
        const by_name = board.nets.find((net) => net.name === name);
        if (by_name?.number) return by_name.number;
        // Boards that list no net table still name nets on their pads.
        for (const fp of board.footprints) {
            for (const pad of fp.pads ?? []) {
                if (pad.net?.name === name && pad.net.number)
                    return pad.net.number;
            }
        }
    }
    if (ref.netCode) {
        const by_code = board.nets.find((net) => net.number === ref.netCode);
        if (by_code?.number) return by_code.number;
    }
    if (ref.uuids?.length) {
        const ids = new Set(ref.uuids);
        for (const segment of board.segments) {
            const id = segment.uuid || segment.tstamp;
            if (id && ids.has(id) && segment.net) return segment.net;
        }
        for (const via of board.vias) {
            const id = via.uuid || via.tstamp;
            if (id && ids.has(id) && via.net) return via.net;
        }
    }
    return undefined;
}
