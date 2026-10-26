import {
    Footprint,
    LineSegment,
    Pad,
    Via,
    Zone,
    type KicadPCB,
} from "../kicad/board";
import {
    GlobalLabel,
    HierarchicalLabel,
    Junction,
    Label,
    NoConnect,
    PinInstance,
    SchematicSheet,
    SchematicSheetPin,
    SchematicSymbol,
    Wire,
    type KicadSch,
    type SchematicInstanceContext,
} from "../kicad/schematic";
import type { EcadBlob } from "../kicanvas/services/vfs";

export type EcadHostContext = "SCH" | "PCB" | "3D" | "BOM";

/** Modifier keys held during the click, as observed by the viewer. */
export type EcadSelectionModifiers = {
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
};

/**
 * What the gesture means for the highlighted-net set: a shift-click on a
 * net-bearing item is `toggle`; everything else is `replace`. Hosts act on
 * this field rather than reading the keyboard state later.
 */
export type EcadSelectionOperation = "replace" | "toggle";

export type EcadSemanticSelectionDetail = {
    sourceContext: "SCH" | "PCB";
    itemType: string;
    operation?: EcadSelectionOperation;
    modifiers?: EcadSelectionModifiers;
    uuid?: string;
    reference?: string;
    pin?: string;
    net?: string;
    netCode?: number;
    sheet?: string;
    page?: string;
    layer?: string;
    /** World-space center point of the selected item, when resolvable. */
    x?: number;
    y?: number;
    /** World-space bounding box [x, y, w, h] of the selected item. */
    bounds?: [number, number, number, number];
};

export type EcadSourceUpdate = {
    revisionKey: string;
    sources: EcadBlob[];
};

export type EcadCrossProbeRequest = {
    sourceContext: EcadHostContext;
    targetContext?: EcadHostContext;
    mode: "hover" | "select" | "focus";
    kind: "designator" | "net" | "crossIndex" | "uuid";
    value: string;
    sheet?: string;
    page?: string;
    designator?: string;
    net?: string;
    netCode?: number;
    crossIndex?: string;
    uuid?: string;
    /** Additional SCH net item uuids (wires/labels) for deterministic focus. */
    uuids?: string[];
    pin?: string;
};

export class EcadSemanticSelectionEvent extends CustomEvent<EcadSemanticSelectionDetail> {
    static readonly type = "ecad-viewer:selection";

    constructor(detail: EcadSemanticSelectionDetail) {
        super(EcadSemanticSelectionEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

/**
 * Dispatched for intentional cross-probe (SCH/PCB double-click). Hosts should
 * mirror this into other viewers; plain `ecad-viewer:selection` is panel-only.
 */
export class EcadCrossProbeEvent extends CustomEvent<EcadSemanticSelectionDetail> {
    static readonly type = "ecad-viewer:crossprobe";

    constructor(detail: EcadSemanticSelectionDetail) {
        super(EcadCrossProbeEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

/** Promote pad/track/via/zone selections to a net detail for cross-probe. */
export function promote_pad_to_net_detail(
    detail: EcadSemanticSelectionDetail,
): EcadSemanticSelectionDetail {
    if (!detail.net) return detail;
    const net_items = new Set(["pad", "track", "via", "zone", "terminal"]);
    if (!net_items.has(detail.itemType)) return detail;
    return {
        sourceContext: detail.sourceContext,
        itemType: "net",
        net: detail.net,
        netCode: detail.netCode,
        uuid: detail.uuid,
        sheet: detail.sheet,
        page: detail.page,
        layer: detail.layer,
        x: detail.x,
        y: detail.y,
        bounds: detail.bounds,
    };
}

const source_uuid = (item: object): string | undefined => {
    if ("uuid" in item && typeof item.uuid === "string" && item.uuid) {
        return item.uuid;
    }
    if ("tstamp" in item && typeof item.tstamp === "string" && item.tstamp) {
        return item.tstamp;
    }
    return undefined;
};

export function normalize_schematic_selection(
    item: unknown,
    schematic: KicadSch,
    context?: SchematicInstanceContext,
): EcadSemanticSelectionDetail | null {
    if (!item || typeof item !== "object") return null;
    const base = {
        sourceContext: "SCH" as const,
        uuid: source_uuid(item),
        sheet: context?.project_path ?? schematic.filename,
        page: context?.project_path ?? schematic.filename,
    };
    if (item instanceof SchematicSymbol) {
        return {
            ...base,
            itemType: "symbol",
            reference: context?.reference(item) ?? item.reference,
        };
    }
    if (item instanceof PinInstance) {
        return {
            ...base,
            itemType: "pin",
            reference: context?.reference(item.parent) ?? item.parent.reference,
            pin: item.number,
        };
    }
    if (item instanceof Wire) return { ...base, itemType: "wire" };
    if (item instanceof GlobalLabel) {
        return { ...base, itemType: "global-label", net: item.text };
    }
    if (item instanceof HierarchicalLabel) {
        return { ...base, itemType: "hierarchical-label", net: item.text };
    }
    if (item instanceof Label) {
        return { ...base, itemType: "label", net: item.text };
    }
    if (item instanceof Junction) return { ...base, itemType: "junction" };
    if (item instanceof NoConnect) return { ...base, itemType: "no-connect" };
    if (item instanceof SchematicSheetPin) {
        return { ...base, itemType: "sheet-pin", net: item.name };
    }
    if (item instanceof SchematicSheet) {
        return { ...base, itemType: "sheet", page: item.sheetfile };
    }
    return { ...base, itemType: item.constructor.name || "schematic-item" };
}

export function normalize_board_selection(
    item: unknown,
    board: KicadPCB,
): EcadSemanticSelectionDetail | null {
    if (!item || typeof item !== "object") return null;
    const uuid = source_uuid(item);
    if ("net" in item && typeof item.net === "string" && item.net.trim()) {
        return {
            sourceContext: "PCB",
            itemType: "net",
            net: item.net,
            netCode:
                "number" in item && typeof item.number === "number"
                    ? item.number
                    : undefined,
            page: board.filename,
        };
    }
    if (item instanceof Footprint) {
        return {
            sourceContext: "PCB",
            itemType: "footprint",
            uuid,
            reference: item.reference,
            layer: item.layer,
            page: board.filename,
        };
    }
    if (item instanceof Pad) {
        return {
            sourceContext: "PCB",
            itemType: "pad",
            uuid,
            reference: item.parent.reference,
            pin: item.number,
            net: item.net?.name,
            netCode: item.net?.number,
            layer: item.layers.join(","),
            page: board.filename,
        };
    }
    if (item instanceof LineSegment || item instanceof Via) {
        return {
            sourceContext: "PCB",
            itemType: item instanceof Via ? "via" : "track",
            uuid,
            net: board.getNetName(item.net),
            netCode: item.net,
            layer: item instanceof Via ? item.layers.join(",") : item.layer,
            page: board.filename,
        };
    }
    if (item instanceof Zone) {
        return {
            sourceContext: "PCB",
            itemType: "zone",
            uuid,
            net: item.net_name || board.getNetName(item.net),
            netCode: item.net,
            layer: item.layers.join(","),
            page: board.filename,
        };
    }
    return {
        sourceContext: "PCB",
        itemType:
            "typeId" in item && typeof item.typeId === "string"
                ? item.typeId
                : item.constructor.name || "pcb-item",
        uuid,
        page: board.filename,
    };
}
