import type { BBox } from "../base/math";
import {
    ArcSegment,
    Footprint,
    LineSegment,
    Via,
    type KicadPCB,
} from "../kicad/board";
import {
    Label,
    SchematicSymbol,
    type SchematicInstanceContext,
} from "../kicad/schematic";

/**
 * The document a comment's area is on: a schematic sheet, with the instance
 * of it on screen when there is one (a sheet used twice names its parts per
 * use), or a board.
 */
export type AreaDocument =
    | { context: "SCH"; instance?: SchematicInstanceContext }
    | { context: "PCB"; board: KicadPCB };

/**
 * What a comment's area holds, as its words: the designators of the symbols
 * or footprints whose painted box (`painted`, each item with its box, once per
 * layer it is drawn on) meets `bounds` (`[x, y, w, h]` in the document's
 * millimetres), power symbols and flags (`#…`) left out, and the names of the
 * nets there — the schematic's labels and the net a power symbol (`#PWR…`)
 * names by its value, the board's pads, tracks and vias, without the names
 * KiCad makes up for an unnamed net (`Net-(…)`, `unconnected-(…)`). Sorted as
 * people sort designators (R2 before R10), each once.
 *
 * A pad is painted inside its footprint and has no painted box of its own,
 * so a footprint met by the area gives the nets of those of its pads whose
 * box on the board (`Pad.bbox`, what a click on a pad tests) meets it; each
 * footprint's pads are walked once, however many layers it is drawn on.
 * `Pad.bbox` turns two corners of the pad's box, which is the exact box at
 * multiples of 90° and a smaller one between them. It is left so: the owner's
 * only board (dionis, pid 0708f574b5e1) has 251 footprints and 983 pads, none
 * of them turned off a multiple of 90°.
 */
export function area_items(
    document: AreaDocument,
    bounds: [number, number, number, number],
    painted: Iterable<[unknown, BBox]>,
): string[] {
    const [x, y, w, h] = bounds;
    const meets = (box: BBox) =>
        Math.min(box.x, box.x2) <= x + w &&
        Math.max(box.x, box.x2) >= x &&
        Math.min(box.y, box.y2) <= y + h &&
        Math.max(box.y, box.y2) >= y;
    const found = new Set<string>();
    const designator = (reference: string | undefined) => {
        if (reference && !reference.startsWith("#")) found.add(reference);
    };
    const net = (name: string | undefined) => {
        if (name && !/^(Net|unconnected)-\(/.test(name)) found.add(name);
    };
    const walked = new Set<Footprint>();
    for (const [item, box] of painted) {
        if (!meets(box)) continue;
        if (document.context === "SCH") {
            const { instance } = document;
            if (item instanceof SchematicSymbol) {
                const reference = instance?.reference(item) ?? item.reference;
                if (reference.startsWith("#PWR")) {
                    net(instance?.value(item) ?? item.value);
                } else {
                    designator(reference);
                }
            } else if (item instanceof Label) {
                net(item.shown_text);
            }
        } else if (item instanceof Footprint) {
            designator(item.reference);
            if (walked.has(item)) continue;
            walked.add(item);
            for (const pad of item.pads) {
                if (meets(pad.bbox)) net(pad.net?.name);
            }
        } else if (
            item instanceof LineSegment ||
            item instanceof ArcSegment ||
            item instanceof Via
        ) {
            net(document.board.getNetName(item.net));
        }
    }
    return [...found].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
    );
}
