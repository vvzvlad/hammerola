import { BBox } from "../base/math";

export type KiCadChangeKind =
    | "added"
    | "removed"
    | "modified"
    | "collision"
    | "duplicate_uuid";

export type KiCadDiffValue = {
    type: string;
    v?: unknown;
    label?: string;
};

export type KiCadPropertyDelta = {
    name: string;
    before: KiCadDiffValue;
    after: KiCadDiffValue;
};

/**
 * Browser representation of KICAD_DIFF::ITEM_CHANGE. Field names intentionally
 * match KiCad's JSON output so kicad-cli results require no presentation-layer
 * rewrite.
 */
export type NativeKiCadItemChange = {
    id: string;
    typeName: string;
    kind: KiCadChangeKind;
    properties: KiCadPropertyDelta[];
    bbox: [number, number, number, number];
    refdes?: string;
    sourceSide?: "reference" | "comparison";
    retainReference?: boolean;
    children: NativeKiCadItemChange[];
};

/**
 * Prism supplies native item identity and properties but deliberately leaves
 * geometry to the parsed scene. Unlike KiCad's native ITEM_CHANGE contract,
 * its bbox is optional.
 */
export type PrismItemChangeInput = Omit<
    NativeKiCadItemChange,
    "bbox" | "children"
> & {
    bbox?: [number, number, number, number];
    children: PrismItemChangeInput[];
};

/** Normalized comparison item used after either boundary has been validated. */
export type KiCadItemChange = PrismItemChangeInput;

/** Browser representation of KICAD_DIFF::DOCUMENT_DIFF. */
export type KiCadDocumentDiff = {
    path: string;
    docType: string;
    changes: KiCadItemChange[];
};

/** Browser representation of KICAD_DIFF::PROJECT_DIFF. */
export type KiCadProjectDiff = {
    documents: KiCadDocumentDiff[];
};

export type EcadDiffCategory = "added" | "removed" | "modified" | "conflict";

export type EcadDocumentUnits = "schematic-iu" | "pcb-iu";

export type EcadIndexedChange = {
    id: string;
    sourceId?: string;
    path: string[];
    change: KiCadItemChange;
    category: EcadDiffCategory;
    sourceSide: "reference" | "comparison";
    worldBounds?: BBox;
    parentId?: string;
    rootId: string;
};

export type EcadDiffGroup = {
    id: string;
    category: EcadDiffCategory;
    label: string;
    members: EcadIndexedChange[];
    worldBounds?: BBox;
};

export type EcadDocumentDiffIndex = {
    document: KiCadDocumentDiff;
    units: EcadDocumentUnits;
    changes: EcadIndexedChange[];
    byId: Map<string, EcadIndexedChange[]>;
    bySourceId: Map<string, EcadIndexedChange[]>;
    groups: EcadDiffGroup[];
    groupsById: Map<string, EcadDiffGroup>;
};

const CHANGE_KINDS = new Set<KiCadChangeKind>([
    "added",
    "removed",
    "modified",
    "collision",
    "duplicate_uuid",
]);

const PCB_DOC_TYPES = new Set([
    "kicad_pcb",
    "kicad_mod",
    "pretty",
    "pcb",
    "footprint",
]);

function as_record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function as_string(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function as_bbox(
    value: unknown,
    label: string,
): [number, number, number, number] {
    if (
        !Array.isArray(value) ||
        value.length !== 4 ||
        value.some(
            (entry) => typeof entry !== "number" || !Number.isFinite(entry),
        )
    ) {
        throw new TypeError(`${label} must be four finite numbers`);
    }
    return value as [number, number, number, number];
}

function parse_diff_value(value: unknown, label: string): KiCadDiffValue {
    const record = as_record(value, label);
    return {
        type: as_string(record["type"], `${label}.type`),
        ...(Object.hasOwn(record, "v") ? { v: record["v"] } : {}),
        ...(record["label"] === undefined
            ? {}
            : { label: as_string(record["label"], `${label}.label`) }),
    };
}

function parse_change(
    value: unknown,
    label: string,
    bbox_required: boolean,
): KiCadItemChange {
    const record = as_record(value, label);
    const kind = as_string(record["kind"], `${label}.kind`);
    if (!CHANGE_KINDS.has(kind as KiCadChangeKind)) {
        throw new TypeError(`${label}.kind is not a KiCad change kind`);
    }
    if (!Array.isArray(record["properties"])) {
        throw new TypeError(`${label}.properties must be an array`);
    }
    if (!Array.isArray(record["children"])) {
        throw new TypeError(`${label}.children must be an array`);
    }

    const bbox =
        record["bbox"] === undefined && !bbox_required
            ? undefined
            : as_bbox(record["bbox"], `${label}.bbox`);
    return {
        id: as_string(record["id"], `${label}.id`),
        typeName: as_string(record["typeName"], `${label}.typeName`),
        kind: kind as KiCadChangeKind,
        properties: record["properties"].map((property, index) => {
            const property_record = as_record(
                property,
                `${label}.properties[${index}]`,
            );
            return {
                name: as_string(
                    property_record["name"],
                    `${label}.properties[${index}].name`,
                ),
                before: parse_diff_value(
                    property_record["before"],
                    `${label}.properties[${index}].before`,
                ),
                after: parse_diff_value(
                    property_record["after"],
                    `${label}.properties[${index}].after`,
                ),
            };
        }),
        ...(bbox === undefined ? {} : { bbox }),
        ...(record["refdes"] === undefined
            ? {}
            : { refdes: as_string(record["refdes"], `${label}.refdes`) }),
        ...(record["sourceSide"] === undefined
            ? {}
            : record["sourceSide"] === "reference" ||
                record["sourceSide"] === "comparison"
              ? { sourceSide: record["sourceSide"] }
              : (() => {
                    throw new TypeError(
                        `${label}.sourceSide must be reference or comparison`,
                    );
                })()),
        ...(record["retainReference"] === undefined
            ? {}
            : typeof record["retainReference"] === "boolean"
              ? { retainReference: record["retainReference"] }
              : (() => {
                    throw new TypeError(
                        `${label}.retainReference must be a boolean`,
                    );
                })()),
        children: record["children"].map((child, index) =>
            parse_change(child, `${label}.children[${index}]`, bbox_required),
        ),
    };
}

function parse_document_diff(
    value: unknown,
    bbox_required: boolean,
): KiCadDocumentDiff {
    const record = as_record(value, "DOCUMENT_DIFF");
    if (!Array.isArray(record["changes"])) {
        throw new TypeError("DOCUMENT_DIFF.changes must be an array");
    }
    return {
        path: as_string(record["path"], "DOCUMENT_DIFF.path"),
        docType: as_string(record["docType"], "DOCUMENT_DIFF.docType"),
        changes: record["changes"].map((change, index) =>
            parse_change(
                change,
                `DOCUMENT_DIFF.changes[${index}]`,
                bbox_required,
            ),
        ),
    };
}

/** Parse strict native KiCad DOCUMENT_DIFF JSON. Native bbox stays required. */
export function parseKiCadDocumentDiff(value: unknown): KiCadDocumentDiff {
    return parse_document_diff(value, true);
}

/** Parse Prism's identity-only DOCUMENT_DIFF input. */
export function parsePrismDocumentDiffInput(value: unknown): KiCadDocumentDiff {
    return parse_document_diff(value, false);
}

/** Parse and validate native KiCad PROJECT_DIFF JSON at the viewer boundary. */
export function parseKiCadProjectDiff(value: unknown): KiCadProjectDiff {
    const record = as_record(value, "PROJECT_DIFF");
    if (!Array.isArray(record["documents"])) {
        throw new TypeError("PROJECT_DIFF.documents must be an array");
    }
    return {
        documents: record["documents"].map((document) =>
            parseKiCadDocumentDiff(document),
        ),
    };
}

/** Parse Prism's identity-only PROJECT_DIFF input. */
export function parsePrismProjectDiffInput(value: unknown): KiCadProjectDiff {
    const record = as_record(value, "PROJECT_DIFF");
    if (!Array.isArray(record["documents"])) {
        throw new TypeError("PROJECT_DIFF.documents must be an array");
    }
    return {
        documents: record["documents"].map((document) =>
            parsePrismDocumentDiffInput(document),
        ),
    };
}

export function document_units(doc_type: string): EcadDocumentUnits {
    return PCB_DOC_TYPES.has(doc_type.toLowerCase())
        ? "pcb-iu"
        : "schematic-iu";
}

/**
 * KiCad serializes bboxes in native internal units. ecad-viewer's cameras use
 * millimetres, so native JSON cannot be focused correctly without this step.
 */
export function bbox_to_world(
    bbox: [number, number, number, number],
    units: EcadDocumentUnits,
): BBox {
    const mm_per_iu = units === "pcb-iu" ? 0.000001 : 0.0001;
    return new BBox(
        bbox[0] * mm_per_iu,
        bbox[1] * mm_per_iu,
        bbox[2] * mm_per_iu,
        bbox[3] * mm_per_iu,
    );
}

export function change_category(kind: KiCadChangeKind): EcadDiffCategory {
    if (kind === "collision" || kind === "duplicate_uuid") return "conflict";
    return kind;
}

/**
 * KIID_PATH::AsString() is slash-delimited. Keeping every segment preserves
 * sheet/footprint hierarchy while the last segment resolves the source item.
 */
export function split_kiid_path(path: string): string[] {
    return path
        .replace(/\\/g, "/")
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
}

function add_to_index<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
}

function combine_bounds(changes: EcadIndexedChange[]): BBox | undefined {
    const bounds = changes.flatMap((change) =>
        change.worldBounds ? [change.worldBounds] : [],
    );
    return bounds.length ? BBox.combine(bounds) : undefined;
}

function is_routing_change(change: KiCadItemChange): boolean {
    return (
        !!change.refdes &&
        ["PCB_TRACK", "PCB_ARC", "PCB_VIA"].includes(change.typeName)
    );
}

/**
 * Compile all navigation data once. Selection code consumes this index and
 * never walks the diff tree, converts units, or unions bounds during a click.
 */
export function buildDocumentDiffIndex(
    document: KiCadDocumentDiff,
): EcadDocumentDiffIndex {
    const units = document_units(document.docType);
    const changes: EcadIndexedChange[] = [];
    const byId = new Map<string, EcadIndexedChange[]>();
    const bySourceId = new Map<string, EcadIndexedChange[]>();

    const visit = (
        change: KiCadItemChange,
        parentId?: string,
        rootId = change.id,
    ) => {
        const path = split_kiid_path(change.id);
        const sourceId = path.at(-1);
        const indexed: EcadIndexedChange = {
            id: change.id,
            sourceId,
            path,
            change,
            category: change_category(change.kind),
            sourceSide:
                change.sourceSide ??
                (change.kind === "removed" ? "reference" : "comparison"),
            worldBounds:
                change.bbox === undefined
                    ? undefined
                    : bbox_to_world(change.bbox, units),
            parentId,
            rootId,
        };
        changes.push(indexed);
        add_to_index(byId, indexed.id, indexed);
        if (sourceId) add_to_index(bySourceId, sourceId, indexed);
        for (const child of change.children) visit(child, change.id, rootId);
    };

    for (const change of document.changes) visit(change);

    const groups: EcadDiffGroup[] = [];
    const routing = new Map<string, EcadIndexedChange[]>();
    for (const indexed of changes) {
        if (is_routing_change(indexed.change)) {
            const key = `${indexed.change.kind}:${indexed.change.refdes}`;
            add_to_index(routing, key, indexed);
            continue;
        }
        groups.push({
            id: indexed.id,
            category: indexed.category,
            label: indexed.change.refdes
                ? `${indexed.change.typeName} [${indexed.change.refdes}]`
                : indexed.change.typeName,
            members: [indexed],
            worldBounds: indexed.worldBounds,
        });
    }
    for (const [key, members] of routing) {
        const first = members[0]!;
        groups.push({
            id: `net:${key}`,
            category: first.category,
            label: `NET [${first.change.refdes}]`,
            members,
            worldBounds: combine_bounds(members),
        });
    }

    return {
        document,
        units,
        changes,
        byId,
        bySourceId,
        groups,
        groupsById: new Map(groups.map((group) => [group.id, group])),
    };
}
