import type { EcadSourceUpdate } from "./host-adapter";
import type {
    EcadDiffResolutionDiagnostic,
    EcadDiffResolutionSummary,
} from "../viewers/base/diff-presentation";
import { BBox } from "../base/math";
import {
    buildDocumentDiffIndex,
    parseKiCadDocumentDiff,
    parseKiCadProjectDiff,
    parsePrismDocumentDiffInput,
    parsePrismProjectDiffInput,
    type EcadDiffCategory,
    type EcadDiffGroup,
    type EcadDocumentDiffIndex,
    type EcadIndexedChange,
    type KiCadDocumentDiff,
} from "./document-diff";

export type EcadDocumentComparisonRequest = {
    comparisonKey: string;
    reference: EcadSourceUpdate;
    comparison: EcadSourceUpdate;
    /**
     * Native KiCad DOCUMENT_DIFF / PROJECT_DIFF JSON. The value is validated
     * at the custom-element boundary even when TypeScript callers pre-type it.
     */
    diff: unknown;
    /** Native KiCad requires bbox; Prism deliberately resolves it after paint. */
    diffFormat?: "native-kicad" | "prism";
    /** Required when a PROJECT_DIFF contains more than one matching document. */
    documentPath?: string;
    /** Exact hierarchical schematic project path for the reference revision. */
    referenceSheetPath?: string;
    /** Exact hierarchical schematic project path for the comparison revision. */
    comparisonSheetPath?: string;
    /**
     * Compatibility alias used for either side when its revision-specific path
     * is absent. New hosts should send referenceSheetPath/comparisonSheetPath.
     */
    activeSheetPath?: string;
};

export type EcadDocumentComparisonSelection =
    | { kind: "change"; id: string }
    | { kind: "group"; id: string }
    | { kind: "changes"; ids: string[] };

export type EcadPendingDiffTarget = {
    id: string;
    kind: "change" | "group";
    category: EcadDiffCategory;
    label: string;
    memberIds: string[];
    sourceIds: string[];
    bounds?: [number, number, number, number];
    sourceSide: "reference" | "comparison";
    routing: boolean;
    overlayLines: Array<Array<[number, number]>>;
    visuals: Array<{
        sourceId: string;
        typeName?: string;
        category: EcadDiffCategory;
        sourceSide: "reference" | "comparison";
        routing: boolean;
        bounds?: [number, number, number, number];
        overlayLines: Array<Array<[number, number]>>;
    }>;
};

export type EcadPreparedDiffTarget = Omit<
    EcadPendingDiffTarget,
    "bounds" | "visuals" | "kind"
> & {
    kind: "change" | "group" | "changes";
    bounds: [number, number, number, number];
    visuals: Array<
        Omit<EcadPendingDiffTarget["visuals"][number], "bounds"> & {
            bounds: [number, number, number, number];
        }
    >;
};

export type EcadDocumentComparisonPreparation = {
    comparisonKey: string;
    context: "SCH" | "PCB";
    document: KiCadDocumentDiff;
    targets: ReadonlyMap<string, EcadPreparedDiffTarget>;
    diagnostics: readonly EcadDiffResolutionDiagnostic[];
    /**
     * Identity- and bounds-resolution counters for this comparison. Hosts that
     * supply their own bboxes should watch `targetsUsingProvidedBounds`: it is
     * the number of selection targets the viewer could not measure from the
     * painted scene, and therefore the number still focusing host geometry.
     */
    resolution: EcadDiffResolutionSummary;
    prepareMs: number;
    sourceCacheHit: boolean;
    /** True when the reference revision has no matching document file. */
    missingReference: boolean;
    /** True when the comparison revision has no matching document file. */
    missingComparison: boolean;
};

export type EcadDocumentComparisonSelectionResult = {
    status: "applied" | "missing" | "superseded";
    requestId: number;
    target?: EcadPreparedDiffTarget;
    clickToFrameMs: number;
    paintCount: number;
    parserCount: number;
};

export type EcadTransitionTraceDetail = {
    sequence: number;
    timestamp: string;
    event: string;
    status?: "start" | "ready" | "missing" | "superseded" | "error";
    generation?: number;
    revisionKey?: string | null;
    requestedPage?: string | null;
    resolvedPage?: {
        projectPath: string;
        sheetPath: string;
        filename: string;
        name?: string;
        page?: string;
    } | null;
    activePage?: string | null;
    detail?: Record<string, unknown>;
};

export class EcadTransitionTraceEvent extends CustomEvent<EcadTransitionTraceDetail> {
    static readonly type = "ecad-viewer:transition-trace";

    constructor(detail: EcadTransitionTraceDetail) {
        super(EcadTransitionTraceEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

export class EcadDocumentComparisonReadyEvent extends CustomEvent<EcadDocumentComparisonPreparation> {
    static readonly type = "ecad-viewer:document-comparison-ready";

    constructor(detail: EcadDocumentComparisonPreparation) {
        super(EcadDocumentComparisonReadyEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

export class EcadDocumentComparisonFrameEvent extends CustomEvent<EcadDocumentComparisonSelectionResult> {
    static readonly type = "ecad-viewer:document-comparison-frame";

    constructor(detail: EcadDocumentComparisonSelectionResult) {
        super(EcadDocumentComparisonFrameEvent.type, {
            detail,
            bubbles: true,
            composed: true,
        });
    }
}

function normalize_path(path: string): string {
    return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function parse_documents(
    value: unknown,
    format: "native-kicad" | "prism",
): KiCadDocumentDiff[] {
    if (value && typeof value === "object" && "documents" in value) {
        return format === "prism"
            ? parsePrismProjectDiffInput(value).documents
            : parseKiCadProjectDiff(value).documents;
    }
    return [
        format === "prism"
            ? parsePrismDocumentDiffInput(value)
            : parseKiCadDocumentDiff(value),
    ];
}

export function selectComparisonDocument(
    value: unknown,
    requestedPath?: string,
    format: "native-kicad" | "prism" = "native-kicad",
): KiCadDocumentDiff {
    const documents = parse_documents(value, format);
    if (!documents.length) {
        throw new TypeError("PROJECT_DIFF.documents must not be empty");
    }
    if (!requestedPath) {
        if (documents.length > 1) {
            throw new TypeError(
                "documentPath is required for a multi-document PROJECT_DIFF",
            );
        }
        return documents[0]!;
    }

    const requested = normalize_path(requestedPath);
    const exact = documents.find(
        (document) => normalize_path(document.path) === requested,
    );
    if (exact) return exact;

    const suffixMatches = documents.filter((document) => {
        const candidate = normalize_path(document.path);
        return (
            candidate.endsWith(`/${requested}`) ||
            requested.endsWith(`/${candidate}`)
        );
    });
    if (suffixMatches.length === 1) return suffixMatches[0]!;
    throw new TypeError(
        `Could not uniquely resolve documentPath "${requestedPath}"`,
    );
}

function bounds_tuple(
    bounds: EcadIndexedChange["worldBounds"],
): [number, number, number, number] | undefined {
    return bounds ? [bounds.x, bounds.y, bounds.w, bounds.h] : undefined;
}

function visual_target(change: EcadIndexedChange) {
    return {
        sourceId: change.sourceId ?? "",
        typeName: change.change.typeName,
        category: change.category,
        sourceSide: change.sourceSide,
        routing: ["SCH_LINE", "PCB_TRACK", "PCB_ARC", "PCB_VIA"].includes(
            change.change.typeName,
        ),
        bounds: bounds_tuple(change.worldBounds),
        overlayLines: [] as Array<Array<[number, number]>>,
    };
}

function change_target(
    change: EcadIndexedChange,
    members: EcadIndexedChange[] = [change],
): EcadPendingDiffTarget {
    const visuals = members
        .map(visual_target)
        .filter((entry) => entry.sourceId);
    const member_bounds = members.flatMap((entry) =>
        entry.worldBounds ? [entry.worldBounds] : [],
    );
    const bounds = member_bounds.length
        ? BBox.combine(member_bounds)
        : undefined;
    return {
        id: change.id,
        kind: "change",
        category: change.category,
        label: change.change.refdes
            ? `${change.change.typeName} [${change.change.refdes}]`
            : change.change.typeName,
        memberIds: members.map((entry) => entry.id),
        sourceIds: visuals.map((entry) => entry.sourceId),
        bounds: bounds_tuple(bounds),
        sourceSide: change.sourceSide,
        routing: visuals.some((entry) => entry.routing),
        overlayLines: [],
        visuals,
    };
}

function group_target(group: EcadDiffGroup): EcadPendingDiffTarget {
    const visuals = group.members
        .map(visual_target)
        .filter((entry) => entry.sourceId);
    return {
        id: group.id,
        kind: "group",
        category: group.category,
        label: group.label,
        memberIds: group.members.map((member) => member.id),
        sourceIds: group.members.flatMap((member) =>
            member.sourceId ? [member.sourceId] : [],
        ),
        bounds: bounds_tuple(group.worldBounds),
        sourceSide: group.members[0]?.sourceSide ?? "comparison",
        routing: group.members.some((member) =>
            ["SCH_LINE", "PCB_TRACK", "PCB_ARC", "PCB_VIA"].includes(
                member.change.typeName,
            ),
        ),
        overlayLines: [],
        visuals,
    };
}

/**
 * Compile all click-path data once. Prefixing keys prevents a group and a
 * change with the same native ID from overwriting each other.
 */
export function buildDocumentComparisonTargets(
    index: EcadDocumentDiffIndex,
): ReadonlyMap<string, EcadPendingDiffTarget> {
    const targets = new Map<string, EcadPendingDiffTarget>();
    for (const change of index.changes.filter((entry) => !entry.parentId)) {
        const members = index.changes.filter(
            (entry) => entry === change || entry.rootId === change.id,
        );
        targets.set(`change:${change.id}`, change_target(change, members));
    }
    for (const group of index.groups) {
        targets.set(`group:${group.id}`, group_target(group));
    }
    return targets;
}

export function prepareComparisonDocument(
    value: unknown,
    requestedPath?: string,
    format: "native-kicad" | "prism" = "native-kicad",
): {
    document: KiCadDocumentDiff;
    index: EcadDocumentDiffIndex;
    targets: ReadonlyMap<string, EcadPendingDiffTarget>;
    context: "SCH" | "PCB";
} {
    const document = selectComparisonDocument(value, requestedPath, format);
    const index = buildDocumentDiffIndex(document);
    return {
        document,
        index,
        targets: buildDocumentComparisonTargets(index),
        context: index.units === "pcb-iu" ? "PCB" : "SCH",
    };
}
