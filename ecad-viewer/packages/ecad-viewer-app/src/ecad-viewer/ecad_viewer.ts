import { later } from "../base/async";
import { listen } from "../base/events";
import { BBox, Vec2 } from "../base/math";
import {
    CSS,
    CustomElement,
    attribute,
    css,
    html,
} from "../base/web-components";
import { KCUIElement } from "../kc-ui";
import kc_ui_styles from "../kc-ui/kc-ui.css";
import {
    AssertType,
    Project,
    type ProjectPage,
    getParserPerfSnapshot,
    normalize_variant_name,
    resolve_variant_request,
} from "../kicanvas/project";
import type { NetRef } from "../kicad/net_ref";
import {
    EcadHighlightChangeEvent,
    resolve_board_net,
    type EcadHighlightChangeDetail,
    type EcadNetRef,
} from "./highlight";
import {
    net_statistics,
    type NetStatistics,
    type NetStatisticsRef,
} from "../kicad/net_statistics";
import { type EcadBlob, type EcadSources } from "../kicanvas/services/vfs";
import { KCBoardAppElement } from "../kicanvas/elements/kc-board/app";
import { KCSchematicAppElement } from "../kicanvas/elements/kc-schematic/app";
import { BomApp } from "../kicanvas/elements/bom/app";
import { KicadPCB, KicadSch } from "../kicad";
import type { SchematicInstanceContext } from "../kicad/schematic";

import { is_3d_model, is_kicad, TabHeaderElement } from "./tab_header";
import {
    BoardContentReady,
    EcadCommentAreaEvent,
    EcadOverlayClickEvent,
    ImageExportRequestEvent,
    ImageExportResultEvent,
    KiCanvasLoadEvent,
    KiCanvasSelectEvent,
    LoadZipEvent,
    LoadZipErrorEvent,
    Online3dViewerLoaded,
    Online3dViewerUrlReady,
    OpenBarrierEvent,
    SheetLoadEvent,
    TabActivateEvent,
    TabMenuClickEvent,
    TabMenuVisibleChangeEvent,
} from "../viewers/base/events";
import type {
    EcadOverlayContext,
    EcadOverlayPrimitive,
    EcadOverlayScene,
} from "../viewers/base/overlay-scene";
import {
    COMMENT_OVERLAY_CHANNELS,
    EcadCommentOverlayClickEvent,
    comment_id_from_primitive,
    comment_overlay_scene,
    resolve_comment_overlays,
    type EcadCommentContext,
    type EcadCommentOverlayHitDetail,
    type EcadCommentOverlaySet,
    type EcadCommentAnchorResolution,
} from "./comment-overlay";
import {
    EcadCrossProbeEvent,
    EcadSemanticSelectionEvent,
    normalize_board_selection,
    normalize_schematic_selection,
    promote_pad_to_net_detail,
    type EcadCrossProbeRequest,
    type EcadSemanticSelectionDetail,
    type EcadSourceUpdate,
} from "./host-adapter";
import {
    EcadDocumentComparisonFrameEvent,
    EcadDocumentComparisonReadyEvent,
    EcadTransitionTraceEvent,
    prepareComparisonDocument,
    type EcadDocumentComparisonPreparation,
    type EcadDocumentComparisonRequest,
    type EcadDocumentComparisonSelection,
    type EcadDocumentComparisonSelectionResult,
    type EcadPendingDiffTarget,
    type EcadPreparedDiffTarget,
    type EcadTransitionTraceDetail,
} from "./document-comparison";
import {
    build_diff_focus_presentation,
    build_diff_presentation,
    build_diff_side_presentation,
    diff_context_primitives,
} from "../viewers/base/diff-presentation";
import { merge_bounds_resolution } from "../viewers/base/diff-presentation";
import type {
    EcadDiffBoundsResolution,
    EcadDiffPresentation,
    EcadDiffResolutionDiagnostic,
} from "../viewers/base/diff-presentation";
import type { PaintableDocument } from "../viewers/base/painter";
import type { DocumentViewer } from "../viewers/base/document-viewer";
import { ecadPerfLog } from "../kicanvas/perf_log";

export type {
    EcadCrossProbeRequest,
    EcadHostContext,
    EcadSelectionModifiers,
    EcadSelectionOperation,
    EcadSemanticSelectionDetail,
    EcadSourceUpdate,
} from "./host-adapter";
export type { EcadNetRef, EcadHighlightChangeDetail } from "./highlight";
export { EcadHighlightChangeEvent } from "./highlight";
export type { NetStatistics, NetStatisticsRef } from "../kicad/net_statistics";
export {
    EcadCrossProbeEvent,
    EcadSemanticSelectionEvent,
} from "./host-adapter";
export type {
    EcadCommentAnchor,
    EcadCommentContext,
    EcadCommentOverlay,
    EcadCommentOverlayHitDetail,
    EcadCommentOverlaySet,
    EcadCommentAnchorResolution,
} from "./comment-overlay";
export { EcadCommentOverlayClickEvent } from "./comment-overlay";
export type {
    EcadDocumentComparisonPreparation,
    EcadDocumentComparisonRequest,
    EcadDocumentComparisonSelection,
    EcadDocumentComparisonSelectionResult,
    EcadPendingDiffTarget,
    EcadPreparedDiffTarget,
    EcadTransitionTraceDetail,
} from "./document-comparison";
export {
    EcadDocumentComparisonFrameEvent,
    EcadDocumentComparisonReadyEvent,
    EcadTransitionTraceEvent,
    buildDocumentComparisonTargets,
    prepareComparisonDocument,
    selectComparisonDocument,
} from "./document-comparison";
export type {
    EcadDocumentDiffIndex,
    EcadDiffCategory,
    EcadDiffGroup,
    EcadIndexedChange,
    KiCadChangeKind,
    KiCadDiffValue,
    KiCadDocumentDiff,
    KiCadItemChange,
    KiCadProjectDiff,
    KiCadPropertyDelta,
    NativeKiCadItemChange,
    PrismItemChangeInput,
} from "./document-diff";
export {
    bbox_to_world,
    buildDocumentDiffIndex,
    change_category,
    document_units,
    parseKiCadDocumentDiff,
    parseKiCadProjectDiff,
    parsePrismDocumentDiffInput,
    parsePrismProjectDiffInput,
    split_kiid_path,
} from "./document-diff";

export interface EcadSchematicPageState {
    projectPath: string;
    sheetPath: string;
    filename: string;
    parentProjectPath?: string;
    name?: string;
    page?: string;
    depth: number;
    active: boolean;
}

export interface EcadComparisonSchematicPages {
    reference: EcadSchematicPageState[];
    comparison: EcadSchematicPageState[];
}

export interface EcadPcbLayerState {
    name: string;
    color: string;
    visible: boolean;
    highlighted: boolean;
}

export interface EcadViewportInsets {
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

const DIFF_STATUS_COLORS = {
    added: "#2BE481",
    removed: "#FF4D67",
    modified: "#FFC928",
    conflict: "#D76BFF",
} as const;

/**
 * Object kinds a host can show or hide on the board. The first four are
 * footprint text layers; the label kinds drive the zoom-gated pad-number and
 * net-name overlays (KiCad's "Show pad numbers" / "Show net names").
 */
export type EcadPcbObjectVisibilityKind =
    | "references"
    | "values"
    | "footprintText"
    | "hiddenText"
    | "padNumbers"
    | "padNetNames"
    | "trackNetNames";

export interface EcadPcbViewState {
    layers: EcadPcbLayerState[];
    objectOpacity: Record<"tracks" | "vias" | "pads" | "zones", number>;
    objectVisibility: Record<EcadPcbObjectVisibilityKind, boolean>;
    highlightTracks: boolean;
}

/**
 * Value-based camera state exposed by <ecad-viewer>. Plain POD so consumers
 * never depend on the internal Camera2/Vec2/Angle types. `x`/`y` are the world
 * center, `zoom` the scale factor, `rotation` in radians.
 */
export interface CameraState {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
}

export type EcadComparisonPresentation =
    | "composite"
    | "reference"
    | "comparison";

export interface EcadComparisonPresentationResult {
    presentation: EcadComparisonPresentation;
    preparation: EcadDocumentComparisonPreparation;
    switchMs: number;
    parserCount: number;
    paintCount: number;
}

export interface EcadComparisonSessionMetrics {
    prepareMs: number;
    parserCount: number;
    switchCount: number;
    lastSwitchMs: number;
    maxSwitchMs: number;
    lastSwitchParserCount: number;
    retainedViewports: number;
    retainedScenes: number;
    sourceBytes: number;
    heapBytesAtPrepare?: number;
    heapBytesCurrent?: number;
}

/**
 * One immutable comparison pair and its prepared document presentation.
 * Multiple <ecad-viewer> viewports may attach to the same session without
 * reparsing either revision.
 */
export interface EcadComparisonSession {
    readonly comparisonKey: string;
    readonly preparation: EcadDocumentComparisonPreparation;
    setPresentation(
        presentation: EcadComparisonPresentation,
        viewport?: ECadViewer,
    ): Promise<EcadComparisonPresentationResult>;
    getPreparation(
        viewport?: ECadViewer,
    ): EcadDocumentComparisonPreparation | null;
    getSchematicPages(): EcadComparisonSchematicPages;
    getMetrics(): EcadComparisonSessionMetrics;
    dispose(): void;
}

/** The retained scene shown in a pane, and its selection-focus twin. */
type EcadDiffScenePair = {
    scene: EcadDiffPresentation;
    focus: EcadDiffPresentation;
};

type EcadComparisonSessionDocument = {
    preparation: EcadDocumentComparisonPreparation;
    presentation: EcadDiffPresentation;
    focusPresentation: EcadDiffPresentation;
    /** Single-revision scenes for the Side by Side and Old/New panes. */
    sideScenes: Record<"reference" | "comparison", EcadDiffScenePair>;
    referenceDocument: PaintableDocument & { filename: string };
    comparisonDocument: PaintableDocument & { filename: string };
    pendingTargets: ReadonlyMap<string, EcadPendingDiffTarget>;
};

type EcadComparisonSessionState = {
    owner: ECadViewer;
    request: EcadDocumentComparisonRequest;
    referenceProject: Project;
    comparisonProject: Project;
    document: EcadComparisonSessionDocument;
    preparations: Map<ECadViewer, EcadDocumentComparisonPreparation>;
    preparedPresentations: Map<
        ECadViewer,
        Map<EcadComparisonPresentation, EcadDocumentComparisonPreparation>
    >;
    presentations: Map<ECadViewer, EcadComparisonPresentation>;
    disposed: boolean;
    metrics: EcadComparisonSessionMetrics;
};

function schematic_page_states(project: Project): EcadSchematicPageState[] {
    const active = project.active_sch_name;
    return project.pages.map((page) => ({
        projectPath: page.project_path,
        sheetPath: page.sheet_path,
        filename: page.filename,
        parentProjectPath: page.parent_project_path,
        name: page.name,
        page: page.page,
        depth: Math.max(
            0,
            page.sheet_path.split("/").filter(Boolean).length - 1,
        ),
        active: page.project_path === active,
    }));
}

function requested_comparison_sheet(
    request: EcadDocumentComparisonRequest,
    side: "reference" | "comparison",
    fallback: string,
): string {
    return (
        (side === "reference"
            ? request.referenceSheetPath
            : request.comparisonSheetPath) ??
        request.activeSheetPath ??
        fallback
    );
}

function comparison_heap_bytes(): number | undefined {
    const memory = (
        performance as Performance & {
            memory?: { usedJSHeapSize?: number };
        }
    ).memory;
    return Number.isFinite(memory?.usedJSHeapSize)
        ? memory!.usedJSHeapSize
        : undefined;
}

function comparison_source_bytes(
    request: EcadDocumentComparisonRequest,
): number {
    const bytes = (update: EcadSourceUpdate) =>
        update.sources.reduce(
            (total, source) =>
                total + source.filename.length + source.content.length,
            0,
        );
    return bytes(request.reference) + bytes(request.comparison);
}

/**
 * Stand-in for a sheet/board that exists on only one side of a revision pair.
 * Comparison remains the paint authority; an empty reference just means there
 * are no removals to inject for that path.
 */
function empty_diff_document(
    context: "SCH" | "PCB",
    path: string,
): KicadSch | KicadPCB {
    if (context === "SCH") {
        return new KicadSch(path, {
            version: 20231120,
            uuid: "00000000-0000-0000-0000-000000000000",
            generator: "ecad-viewer-empty-diff",
            generator_version: "0",
        });
    }
    return new KicadPCB(path, {
        version: 20240108,
        generator: "ecad-viewer-empty-diff",
        paper: { size: "A4", portrait: false },
        title_block: {
            title: "",
            date: "",
            rev: "",
            company: "",
            comment: {},
        },
        layers: [],
        nets: [],
        footprints: [],
        zones: [],
        segments: [],
        vias: [],
        drawings: [],
        groups: [],
    });
}

export { TabActivateEvent, SheetLoadEvent } from "../viewers/base/events";

import { TabKind } from "./constraint";
import type { InputContainer } from "./input_container";
import type { Online3dViewer } from "../3d-viewer/online_3d_viewer";
import "../kc-ui/spinner";
import { show_ecad_viewer } from "../eda_host/show_ecad_viewer";
import "./ecad_viewer_global";
import { ZipUtils } from "../utils/zip_utils";
import { length } from "../base/iterator";
import { PRISM_LOGO } from "../kc-ui/prism_logo";
import type { BoardViewer } from "../viewers/board/viewer";
import { SchematicViewer } from "../viewers/schematic/viewer";

export class ECadViewer extends KCUIElement implements InputContainer {
    static override styles = [
        ...KCUIElement.styles,
        new CSS(kc_ui_styles),
        css`
            :host(.full-window) {
                width: 100vw; /* Full width of the viewport */
                height: 100vh; /* Full height of the viewport */
                top: 0px;
                left: 0px;
                position: fixed;
            }

            :host {
                margin: 0;
                display: flex;
                position: relative;
                width: 100%;
                height: 100%;
                background-color: white;
                color: var(--fg);
                contain: layout paint;
            }

            /* Opt-in A4 letterbox for standalone embeds. Forced aspect-ratio on
               :host shrinks the viewer in sized Prism panes and desyncs the
               first camera fit from the final layout. */
            :host(.aspect-a4) {
                height: auto;
                max-height: 100%;
                aspect-ratio: 1.414;
            }

            .vertical {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                /* :host is a flex row; content must own full width or it shares
                   space with the spinner sibling and collapses. */
                flex: 1 1 100%;
                min-width: 0;
                overflow: hidden;
            }

            /* Spinner overlays; must not consume flex width beside content. */
            ecad-spinner {
                position: absolute;
                inset: 0;
            }

            .tab-content {
                height: 100%;
                width: 100%;
                flex: 1;
                display: none;
            }

            .tab-content.active {
                display: inherit;
            }

            .bottom-left-icon {
                position: absolute;
                bottom: 16px;
                left: 16px; /* Adjusted to place it on the bottom-left */
                display: flex;
                align-items: center;
                justify-content: center;
                width: 40px;
                height: 40px;
                background-color: transparent;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                text-decoration: none;
                color: var(--fg);
                transition:
                    transform 0.2s ease-in-out,
                    box-shadow 0.2s ease-in-out;
            }

            .bottom-left-icon:hover {
                transform: scale(1.1);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
        `,
    ];

    constructor() {
        super();
        this.addDisposable(this.#project);
        this.addDisposable(this.#reference_project);
        this.provideContext("project", this.#project);
        this.addDisposable(
            listen(this.#project, "change", () => {
                const active = this.#project.active_sch_name;
                if (
                    active &&
                    this.#project.pages.some(
                        (page) => page.project_path === active,
                    )
                ) {
                    this.#active_schematic_project_path = active;
                }
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:view-state-change", {
                        bubbles: false,
                    }),
                );
            }),
        );
        this.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });
        this.addDisposable(
            listen(window, "keydown", (event) => {
                this.#handle_host_keydown(event as KeyboardEvent);
            }),
        );
    }

    get input() {
        return this.#file_input;
    }
    public get target() {
        return this;
    }

    #tab_contents: Record<string, HTMLElement> = {};
    #active_tab: TabKind = TabKind.pcb;
    #user_selected_tab = false;
    #initial_tab_set = false;
    #project: Project = new Project();
    #reference_project: Project = new Project();
    #adopted_comparison_project: Project | null = null;
    #schematic_app: KCSchematicAppElement | undefined;
    #ov_d_app: Online3dViewer;
    #board_app: KCBoardAppElement | undefined;
    #bom_app: BomApp | undefined;
    #tab_header: TabHeaderElement;
    #file_input: HTMLInputElement;
    #spinner: HTMLElement;
    #content: HTMLElement;
    #step_viewer_placeholder: HTMLElement | undefined;
    #viewers_container: HTMLDivElement;
    #is_full_screen = false;
    #host_active = true;
    #revision_key: string | null = null;
    #source_manifest_key: string | null = null;
    #source_names = new Set<string>();
    #comment_overlay_scenes = new Map<EcadCommentContext, EcadOverlayScene>();
    #active_schematic_project_path: string | null = null;
    #document_comparison: EcadDocumentComparisonPreparation | null = null;
    #document_comparison_key: string | null = null;
    #document_comparison_revision_keys: {
        reference: string;
        comparison: string;
    } | null = null;
    #document_comparison_cache = new Map<
        string,
        EcadComparisonSessionDocument
    >();
    #document_comparison_request_id = 0;
    #document_comparison_load_generation = 0;
    #document_comparison_load_tail: Promise<void> = Promise.resolve();
    #source_replace_generation = 0;
    #source_replace_tail: Promise<void> = Promise.resolve();
    #visible_ready: Promise<void> = Promise.resolve();
    #transition_trace_sequence = 0;
    static readonly #DIFF_SELECTION_CHANNEL = ":document-diff:selection";
    /** Solid extent of the selection, painted beneath the status outline. */
    static readonly #DIFF_CONTEXT_CHANNEL = ":document-diff:context";
    /** On/off dash lengths, in screen pixels, of the selection outline. */
    static readonly #DIFF_EMPHASIS_DASH = [10, 7];
    /**
     * Deliberately hairline. The outline marks where the change is; the
     * composite scene's own status colour is what shows the change itself, so
     * a heavy stroke only hides the geometry the reviewer came to look at.
     */
    static readonly #DIFF_EMPHASIS_STROKE_WIDTH = 1.5;
    static readonly #DIFF_EMPHASIS_PADDING = 3;
    /** Dash travel along the outline, in screen pixels per second. */
    static readonly #DIFF_EMPHASIS_DASH_SPEED = 36;
    #selected_document_diff: EcadDocumentComparisonSelection | null = null;
    #preview_document_diff: EcadDocumentComparisonSelection | null = null;
    #base_diff_layer_visibility: Map<string, boolean> | null = null;
    /**
     * Which retained scene pair is installed in *this* viewport. A session
     * spreads one comparison over several viewports, each showing a different
     * revision, so the scenes to swap between on selection cannot be read off
     * the shared document — only off the pane.
     */
    #active_diff_scenes: EcadDiffScenePair | null = null;
    #diff_animation_frame: number | null = null;
    #diff_animation_started = 0;
    #diff_emphasis_painted = false;
    #viewport_insets: Required<EcadViewportInsets> = {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    };

    /**
     * The requested design variant; `null` is the default design. The
     * attribute is the durable copy, so a reconnect or source replacement
     * replays it.
     */
    #requested_variant: string | null = null;
    /** Guards `setAttribute` from re-entering the attribute callback. */
    #reflecting_variant = false;

    static get observedAttributes(): string[] {
        return ["variant"];
    }

    attributeChangedCallback(
        name: string,
        _old: string | null,
        value: string | null,
    ): void {
        if (name !== "variant" || this.#reflecting_variant) return;
        this.#requested_variant = normalize_variant_name(value);
        this.#apply_variant_request();
    }

    /**
     * Select the design variant rendered by the schematic and board viewers.
     * `null`/the empty string selects the default design. Returns `false` and
     * selects the default when `name` is not in `getVariants()`; a selection
     * made before the catalog is loaded is applied when the sources settle.
     */
    public setVariant(name: string | null): boolean {
        const resolution = resolve_variant_request(
            this.#project,
            name,
            this.loaded,
        );
        this.#requested_variant = resolution.requested;
        this.#reflect_variant(resolution.requested);
        this.#apply_variant_request();
        return resolution.known;
    }

    /** The variant currently applied to the loaded revision. */
    public getVariant(): string | null {
        return this.#project.active_variant;
    }

    /**
     * The catalog of the loaded revision, in discovery order (packet 2.1).
     * Empty until sources are loaded.
     */
    public getVariants(): Array<{ name: string; description: string | null }> {
        return this.#project.variant_catalog();
    }

    #reflect_variant(name: string | null): void {
        this.#reflecting_variant = true;
        try {
            if (name === null) this.removeAttribute("variant");
            else this.setAttribute("variant", name);
        } finally {
            this.#reflecting_variant = false;
        }
    }

    /**
     * Re-validate the requested variant against the loaded catalog and apply
     * it to the project and both viewers. Called after sources settle, page
     * switches and appends so the selection survives all of them; a name the
     * revision no longer has falls back to the default design.
     */
    #apply_variant_request(): void {
        const resolution = resolve_variant_request(
            this.#project,
            this.#requested_variant,
            this.loaded,
        );
        if (resolution.requested !== this.#requested_variant) {
            this.#requested_variant = resolution.requested;
            this.#reflect_variant(resolution.requested);
        }
        if (!this.loaded) return;
        this.#project.set_active_variant(resolution.effective);
        this.#safe_schematic_viewer()?.set_variant(resolution.effective);
        this.#safe_board_viewer()?.set_variant(resolution.effective);
    }

    #apply_viewport_insets(): void {
        this.#safe_board_viewer()?.set_viewport_insets(this.#viewport_insets);
        this.#safe_schematic_viewer()?.set_viewport_insets(
            this.#viewport_insets,
        );
    }

    /**
     * Reserve host-owned overlay rails while retaining a full-size canvas.
     * This is camera-only: it never reparses or repaints the document.
     */
    public setViewportInsets(insets: EcadViewportInsets | null): void {
        const non_negative = (value: number | undefined) =>
            Math.max(0, Number.isFinite(value) ? (value ?? 0) : 0);
        this.#viewport_insets = {
            left: non_negative(insets?.left),
            right: non_negative(insets?.right),
            top: non_negative(insets?.top),
            bottom: non_negative(insets?.bottom),
        };
        this.#apply_viewport_insets();
    }

    #trace_transition(
        event: string,
        detail: Omit<
            EcadTransitionTraceDetail,
            "sequence" | "timestamp" | "event"
        > = {},
    ): void {
        this.dispatchEvent(
            new EcadTransitionTraceEvent({
                sequence: this.#transition_trace_sequence++,
                timestamp: new Date().toISOString(),
                event,
                revisionKey: this.#revision_key,
                activePage: this.#active_schematic_project_path,
                ...detail,
            }),
        );
    }

    #page_trace(page: ProjectPage | undefined | null) {
        return page
            ? {
                  projectPath: page.project_path,
                  sheetPath: page.sheet_path,
                  filename: page.filename,
                  parentProjectPath: page.parent_project_path,
                  name: page.name,
                  page: page.page,
              }
            : null;
    }

    get project() {
        return this.#project;
    }

    get showHeader() {
        return this.getAttribute("show-header") !== "false";
    }

    get showSelectionPanel() {
        return this.getAttribute("show-selection-panel") !== "false";
    }

    public async replaceSources(update: EcadSourceUpdate): Promise<void> {
        this.#trace_transition("sources.replace.request", {
            status: "start",
            revisionKey: update.revisionKey,
            detail: {
                sourceCount: update.sources.length,
                sourceNames: update.sources.map((source) => source.filename),
            },
        });
        const source_manifest_key = update.sources
            .map((source) => `${source.filename}\0${source.content.length}`)
            .sort()
            .join("\0");
        if (
            this.#revision_key === update.revisionKey &&
            this.#source_manifest_key === source_manifest_key &&
            this.loaded
        ) {
            this.#trace_transition("sources.replace.cached", {
                status: "ready",
                revisionKey: update.revisionKey,
            });
            return this.#visible_ready;
        }
        const generation = ++this.#source_replace_generation;
        const previous = this.#source_replace_tail;
        const operation = previous
            .catch(() => undefined)
            .then(() =>
                this.#perform_source_replacement(
                    update,
                    source_manifest_key,
                    generation,
                ),
            );
        const traced = operation
            .then(() => {
                this.#trace_transition("sources.replace.complete", {
                    status: "ready",
                    generation,
                    revisionKey: update.revisionKey,
                    resolvedPage: this.#page_trace(
                        this.#active_schematic_page(),
                    ),
                });
            })
            .catch((error: unknown) => {
                this.#trace_transition("sources.replace.failed", {
                    status:
                        error instanceof DOMException &&
                        error.name === "AbortError"
                            ? "superseded"
                            : "error",
                    generation,
                    revisionKey: update.revisionKey,
                    detail: {
                        error:
                            error instanceof Error
                                ? { name: error.name, message: error.message }
                                : String(error),
                    },
                });
                throw error;
            });
        this.#source_replace_tail = traced.catch(() => undefined);
        this.#visible_ready = traced;
        return traced;
    }

    async #perform_source_replacement(
        update: EcadSourceUpdate,
        source_manifest_key: string,
        generation: number,
    ): Promise<void> {
        this.#adopted_comparison_project = null;
        const assert_current = () => {
            if (generation !== this.#source_replace_generation) {
                throw new DOMException(
                    "Source replacement was superseded",
                    "AbortError",
                );
            }
        };
        assert_current();

        if (!this.loaded) {
            this.#project.reset();
            await this.#setup_project({ urls: [], blobs: update.sources });
            assert_current();
        } else {
            const preferred_page =
                this.#desired_page ??
                this.#active_schematic_project_path ??
                this.#project.active_sch_name;
            const previous_shape = {
                sch: this.has_sch,
                pcb: this.has_pcb,
                bom: this.has_bom,
            };
            this.loading = true;
            try {
                this.#project.reset();
                await this.#project.load({ urls: [], blobs: update.sources });
                assert_current();
                const shape_changed =
                    previous_shape.sch !== this.has_sch ||
                    previous_shape.pcb !== this.has_pcb ||
                    previous_shape.bom !== this.has_bom;
                if (shape_changed) {
                    await this.update();
                    assert_current();
                }
                await this.#settle_project_apps(preferred_page);
                assert_current();
            } finally {
                this.loading = false;
            }
        }

        this.#revision_key = update.revisionKey;
        this.#source_manifest_key = source_manifest_key;
        this.#source_names = new Set(
            update.sources.map((source) => source.filename),
        );
        this.#document_comparison_cache.clear();
        this.#ensure_camera_hook(this.#safe_board_viewer());
        this.#ensure_camera_hook(this.#safe_schematic_viewer());
        this.#apply_viewport_insets();
        this.#emit_view_state_change();
        this.#emit_camera_change();
    }

    public async appendSources(update: EcadSourceUpdate): Promise<void> {
        if (
            this.#revision_key !== null &&
            this.#revision_key !== update.revisionKey
        ) {
            await this.replaceSources(update);
            return;
        }
        this.#revision_key = update.revisionKey;
        const additions = update.sources.filter(
            (source) => !this.#source_names.has(source.filename),
        );
        if (!additions.length) return;
        for (const source of additions) this.#source_names.add(source.filename);
        await this.#add_files_to_project(additions);
    }

    /**
     * Parse both immutable revisions concurrently, retain the comparison
     * document as the only normal scene, inject removed native reference
     * objects, and install the fixed KiCad-style A/R/M paint presentation.
     */
    public async loadDocumentComparison(
        request: EcadDocumentComparisonRequest,
    ): Promise<EcadDocumentComparisonPreparation> {
        const load_generation = ++this.#document_comparison_load_generation;
        this.#trace_transition("comparison.load.request", {
            status: "start",
            generation: load_generation,
            requestedPage: request.documentPath ?? null,
            detail: {
                comparisonKey: request.comparisonKey,
                activeSheetPath: request.activeSheetPath ?? null,
                referenceSheetPath: request.referenceSheetPath ?? null,
                comparisonSheetPath: request.comparisonSheetPath ?? null,
                referenceRevision: request.reference.revisionKey,
                comparisonRevision: request.comparison.revisionKey,
            },
        });
        const previous_load = this.#document_comparison_load_tail;
        let release_load!: () => void;
        this.#document_comparison_load_tail = new Promise<void>((resolve) => {
            release_load = resolve;
        });
        await previous_load.catch(() => undefined);
        try {
            if (load_generation !== this.#document_comparison_load_generation) {
                throw new DOMException(
                    "Document comparison load was superseded",
                    "AbortError",
                );
            }
            const result = await this.#perform_document_comparison_load(
                request,
                load_generation,
            );
            this.#trace_transition("comparison.load.complete", {
                status: "ready",
                generation: load_generation,
                requestedPage: request.documentPath ?? null,
                resolvedPage: this.#page_trace(this.#active_schematic_page()),
                detail: {
                    documentPath: result.document.path,
                    context: result.context,
                    missingReference: result.missingReference,
                    missingComparison: result.missingComparison,
                    targetCount: result.targets.size,
                },
            });
            return result;
        } catch (error) {
            this.#trace_transition("comparison.load.failed", {
                status:
                    error instanceof DOMException && error.name === "AbortError"
                        ? "superseded"
                        : "error",
                generation: load_generation,
                requestedPage: request.documentPath ?? null,
                detail: {
                    activeSheetPath: request.activeSheetPath ?? null,
                    referenceSheetPath: request.referenceSheetPath ?? null,
                    comparisonSheetPath: request.comparisonSheetPath ?? null,
                    error:
                        error instanceof Error
                            ? { name: error.name, message: error.message }
                            : String(error),
                },
            });
            throw error;
        } finally {
            release_load();
        }
    }

    /**
     * Prepare one immutable comparison pair and expose it as a shareable
     * session. The first viewport is Composite; additional viewports adopt the
     * already-parsed projects and never invoke the parser again.
     */
    public async prepareComparison(
        request: EcadDocumentComparisonRequest,
    ): Promise<EcadComparisonSession> {
        const parser_before = getParserPerfSnapshot().parserInvocations;
        const preparation = await this.loadDocumentComparison(request);
        const document = this.#document_comparison_cache.get(
            preparation.document.path,
        );
        if (!document) {
            throw new Error(
                `Prepared comparison cache is missing ${preparation.document.path}`,
            );
        }
        const comparison_project = new Project();
        comparison_project.adopt(this.#project);
        const state: EcadComparisonSessionState = {
            owner: this,
            request,
            referenceProject: this.#reference_project,
            comparisonProject: comparison_project,
            document,
            preparations: new Map([[this, preparation]]),
            preparedPresentations: new Map([
                [this, new Map([["composite", preparation]])],
            ]),
            presentations: new Map([[this, "composite"]]),
            disposed: false,
            metrics: {
                prepareMs: preparation.prepareMs,
                parserCount:
                    getParserPerfSnapshot().parserInvocations - parser_before,
                switchCount: 0,
                lastSwitchMs: 0,
                maxSwitchMs: 0,
                lastSwitchParserCount: 0,
                retainedViewports: 1,
                retainedScenes: 1,
                sourceBytes: comparison_source_bytes(request),
                heapBytesAtPrepare: comparison_heap_bytes(),
                heapBytesCurrent: comparison_heap_bytes(),
            },
        };
        const owner_viewer = this.#viewer_for_context(preparation.context);
        owner_viewer?.enable_presentation_cache(
            new Set([ECadViewer.#DIFF_SELECTION_CHANNEL]),
        );
        if (preparation.context === "PCB" && owner_viewer) {
            // Build the monochrome focus scene once while preparing the
            // comparison. Selection then swaps retained display lists and
            // replays only the chosen native geometry.
            await owner_viewer.load_diff_document(
                document.comparisonDocument as never,
                document.focusPresentation,
            );
            await owner_viewer.load_diff_document(
                document.comparisonDocument as never,
                document.presentation,
            );
            state.metrics.retainedScenes = owner_viewer.presentation_cache_size;
        }
        const session: EcadComparisonSession = {
            comparisonKey: request.comparisonKey,
            get preparation() {
                return state.document.preparation;
            },
            setPresentation: (presentation, viewport = state.owner) =>
                state.owner.#set_comparison_session_presentation(
                    state,
                    viewport,
                    presentation,
                ),
            getPreparation: (viewport = state.owner) =>
                state.preparations.get(viewport) ?? null,
            getSchematicPages: () => ({
                reference: schematic_page_states(state.referenceProject),
                comparison: schematic_page_states(state.comparisonProject),
            }),
            getMetrics: () => ({
                ...state.metrics,
                heapBytesCurrent: comparison_heap_bytes(),
            }),
            dispose: () => {
                if (state.disposed) return;
                state.disposed = true;
                if (
                    state.owner.#adopted_comparison_project !==
                    state.comparisonProject
                ) {
                    // Restore the comparison project synchronously. A host may
                    // prepare the next selected page immediately after dispose,
                    // and its warm-cache resolution must not inspect the
                    // reference revision left behind by an Old view.
                    state.owner.#project.adopt(state.comparisonProject);
                    state.owner.#adopted_comparison_project =
                        state.comparisonProject;
                    state.owner.#revision_key =
                        state.request.comparison.revisionKey;
                }
                for (const viewport of state.presentations.keys()) {
                    viewport
                        .#viewer_for_context(state.document.preparation.context)
                        ?.disable_presentation_cache();
                }
                state.preparations.clear();
                state.preparedPresentations.clear();
                state.presentations.clear();
                state.metrics.retainedViewports = 0;
                state.metrics.retainedScenes = 0;
                state.metrics.heapBytesCurrent = comparison_heap_bytes();
                state.comparisonProject.dispose();
            },
        };
        return session;
    }

    async #adopt_comparison_project(
        project: Project,
        revision_key: string,
        refresh_shell = true,
    ): Promise<void> {
        if (this.#adopted_comparison_project === project && this.loaded) return;
        const previous_capabilities = {
            schematic: this.has_sch,
            board: this.has_pcb,
            bom: this.has_bom,
        };
        this.#source_replace_generation += 1;
        this.#project.adopt(project);
        this.#adopted_comparison_project = project;
        this.#revision_key = revision_key;
        this.#source_manifest_key = null;
        this.#source_names.clear();
        this.loaded = true;
        const shell_capabilities_changed =
            previous_capabilities.schematic !== this.has_sch ||
            previous_capabilities.board !== this.has_pcb ||
            previous_capabilities.bom !== this.has_bom;
        if (!refresh_shell || !shell_capabilities_changed) {
            // The rendered app shell depends on document capabilities, not on
            // the adopted revision object. Re-rendering an unchanged shell
            // disconnects and later reuses its nested custom elements; their
            // one-shot disposable stacks then receive duplicate dispose calls.
            this.#ensure_camera_hook(this.#safe_board_viewer());
            this.#ensure_camera_hook(this.#safe_schematic_viewer());
            this.#apply_viewport_insets();
            return;
        }
        this.loading = true;
        try {
            await this.update();
            await Promise.all(
                [this.#schematic_app, this.#board_app].flatMap((app) =>
                    app ? [app.viewerReady] : [],
                ),
            );
        } finally {
            this.loading = false;
        }
        this.#ensure_camera_hook(this.#safe_board_viewer());
        this.#ensure_camera_hook(this.#safe_schematic_viewer());
        this.#apply_viewport_insets();
    }

    async #set_comparison_session_presentation(
        state: EcadComparisonSessionState,
        viewport: ECadViewer,
        presentation_mode: EcadComparisonPresentation,
    ): Promise<EcadComparisonPresentationResult> {
        if (state.disposed) {
            throw new DOMException(
                "Comparison session has been disposed",
                "InvalidStateError",
            );
        }
        const started = performance.now();
        const parser_before = getParserPerfSnapshot().parserInvocations;
        const existing = state.presentations.get(viewport);
        const existing_preparation = state.preparations.get(viewport);
        if (existing === presentation_mode && existing_preparation) {
            return {
                presentation: presentation_mode,
                preparation: existing_preparation,
                switchMs: performance.now() - started,
                parserCount: 0,
                paintCount: 0,
            };
        }

        const project =
            presentation_mode === "reference"
                ? state.referenceProject
                : state.comparisonProject;
        const revision_key =
            presentation_mode === "reference"
                ? state.request.reference.revisionKey
                : state.request.comparison.revisionKey;
        await viewport.#adopt_comparison_project(
            project,
            revision_key,
            viewport !== state.owner,
        );

        const context = state.document.preparation.context;
        if (context === "SCH" && viewport.#active_tab !== TabKind.sch) {
            await viewport.#switchToTab(TabKind.sch);
        } else if (context === "PCB" && viewport.#active_tab !== TabKind.pcb) {
            await viewport.#switchToTab(TabKind.pcb);
        }
        const document =
            presentation_mode === "reference"
                ? state.document.referenceDocument
                : state.document.comparisonDocument;
        if (context === "SCH" && document.filename) {
            await viewport.#activate_comparison_sheet(
                requested_comparison_sheet(
                    state.request,
                    presentation_mode === "reference"
                        ? "reference"
                        : "comparison",
                    document.filename,
                ),
                document,
            );
        }
        const viewer = viewport.#viewer_for_context(context);
        if (!viewer) {
            throw new Error(`The ${context} comparison viewport is not ready`);
        }
        viewer.enable_presentation_cache(
            new Set([ECadViewer.#DIFF_SELECTION_CHANNEL]),
        );
        const paint_before = viewer.paint_count;
        // Every pane paints its revision through a diff scene, not plain.
        // A base pane showing raw full-colour geometry cannot say which of
        // its objects the review is about; the side scene subdues everything
        // untouched and leaves the changed objects in their status colour,
        // reading exactly like Composite.
        const scenes =
            presentation_mode === "composite"
                ? {
                      scene: state.document.presentation,
                      focus: state.document.focusPresentation,
                  }
                : state.document.sideScenes[presentation_mode];
        if (context === "PCB") {
            // Warm the focus twin first so selection is a display-list swap
            // rather than a repaint, then land on the scene actually shown.
            await viewer.load_diff_document(document as never, scenes.focus);
        }
        await viewer.load_diff_document(document as never, scenes.scene);
        // Adopting a revision plain-loads it first. That scene is dead for the
        // life of the comparison — a whole display list per pane retained for a
        // presentation the pane will never return to.
        viewer.release_cached_presentation(null);
        viewport.#active_diff_scenes = scenes;
        await viewport.#reveal_comparison_shell(
            context,
            document,
            viewer,
            /* alreadyPainted */ true,
        );

        const cached_preparation = state.preparedPresentations
            .get(viewport)
            ?.get(presentation_mode);
        const hydrated = cached_preparation
            ? null
            : viewport.#hydrate_document_diff_targets(
                  // Every target on every pane. Filtering by sourceSide left
                  // the base pane able to focus removals only: a modified
                  // track's single change carries sourceSide "comparison", so
                  // the base pane dropped it entirely and clicking it did
                  // nothing. Hydration against this pane's own scene resolves
                  // tight native bounds where the object exists here and falls
                  // back to the diff's supplied bbox where it does not.
                  state.document.pendingTargets,
                  scenes.scene,
                  viewer,
              );
        const targets = cached_preparation?.targets ?? hydrated!.targets;
        const side =
            presentation_mode === "composite" ? null : presentation_mode;
        const identity_diagnostics =
            state.document.presentation.diagnostics.filter(
                (diagnostic) => side === null || diagnostic.side === side,
            );
        const preparation: EcadDocumentComparisonPreparation =
            cached_preparation ?? {
                ...state.document.preparation,
                targets,
                diagnostics: [
                    ...identity_diagnostics,
                    ...hydrated!.resolution.diagnostics,
                ],
                resolution: merge_bounds_resolution(
                    state.document.presentation.resolution,
                    hydrated!.resolution,
                ),
                sourceCacheHit: true,
            };
        viewport.#document_comparison = preparation;
        viewport.#selected_document_diff = null;
        viewport.#preview_document_diff = null;
        viewport.#restart_diff_animation();
        viewport.#emit_view_state_change();

        const switch_ms = performance.now() - started;
        const parser_count =
            getParserPerfSnapshot().parserInvocations - parser_before;
        const result: EcadComparisonPresentationResult = {
            presentation: presentation_mode,
            preparation,
            switchMs: switch_ms,
            parserCount: parser_count,
            paintCount: viewer.paint_count - paint_before,
        };
        state.preparations.set(viewport, preparation);
        let prepared_presentations = state.preparedPresentations.get(viewport);
        if (!prepared_presentations) {
            prepared_presentations = new Map();
            state.preparedPresentations.set(viewport, prepared_presentations);
        }
        prepared_presentations.set(presentation_mode, preparation);
        state.presentations.set(viewport, presentation_mode);
        state.metrics.switchCount += 1;
        state.metrics.lastSwitchMs = switch_ms;
        state.metrics.maxSwitchMs = Math.max(
            state.metrics.maxSwitchMs,
            switch_ms,
        );
        state.metrics.lastSwitchParserCount = parser_count;
        state.metrics.retainedViewports = state.presentations.size;
        state.metrics.retainedScenes = [...state.presentations.keys()].reduce(
            (total, retained_viewport) =>
                total +
                (retained_viewport.#viewer_for_context(context)
                    ?.presentation_cache_size ?? 0),
            0,
        );
        state.metrics.heapBytesCurrent = comparison_heap_bytes();
        ecadPerfLog(
            `comparison presentation=${presentation_mode} switch=${switch_ms.toFixed(1)}ms paint=${result.paintCount} parse=${parser_count} viewports=${state.metrics.retainedViewports}`,
        );
        viewport.#trace_transition("comparison.presentation.complete", {
            status: "ready",
            detail: {
                presentation: presentation_mode,
                switchMs: switch_ms,
                paintCount: result.paintCount,
                parserCount: parser_count,
                retainedViewports: state.metrics.retainedViewports,
            },
        });
        return result;
    }

    async #perform_document_comparison_load(
        request: EcadDocumentComparisonRequest,
        load_generation: number,
    ): Promise<EcadDocumentComparisonPreparation> {
        const started = performance.now();
        const assert_current = () => {
            if (load_generation !== this.#document_comparison_load_generation) {
                throw new DOMException(
                    "Document comparison load was superseded",
                    "AbortError",
                );
            }
        };
        const prepared = prepareComparisonDocument(
            request.diff,
            request.documentPath,
            request.diffFormat ?? "native-kicad",
        );
        this.#document_comparison_request_id += 1;
        this.#cancel_diff_animation();
        this.#selected_document_diff = null;
        this.#preview_document_diff = null;
        this.#base_diff_layer_visibility = null;
        this.#active_diff_scenes = null;
        this.#document_comparison = null;
        const same_sources =
            this.#document_comparison_key === request.comparisonKey &&
            this.#document_comparison_revision_keys?.reference ===
                request.reference.revisionKey &&
            this.#document_comparison_revision_keys?.comparison ===
                request.comparison.revisionKey;
        const cached = same_sources
            ? this.#document_comparison_cache.get(prepared.document.path)
            : undefined;
        if (cached) {
            const viewer = this.#viewer_for_context(cached.preparation.context);
            if (!viewer) {
                throw new Error(
                    `The ${cached.preparation.context} comparison viewer is not ready`,
                );
            }
            if (
                cached.preparation.context === "SCH" &&
                this.#active_tab !== TabKind.sch
            ) {
                await this.#switchToTab(TabKind.sch);
            } else if (
                cached.preparation.context === "PCB" &&
                this.#active_tab !== TabKind.pcb
            ) {
                await this.#switchToTab(TabKind.pcb);
            }
            if (
                cached.preparation.context === "SCH" &&
                (request.comparisonSheetPath || request.activeSheetPath)
            ) {
                await this.#activate_comparison_sheet(
                    requested_comparison_sheet(
                        request,
                        "comparison",
                        cached.comparisonDocument.filename,
                    ),
                    cached.comparisonDocument as { filename?: string },
                );
            }
            // Warm path: same prepared presentation — overlay/camera only when
            // the document+presentation are already installed.
            await viewer.load_diff_document(
                cached.comparisonDocument as never,
                cached.presentation,
            );
            this.#active_diff_scenes = {
                scene: cached.presentation,
                focus: cached.focusPresentation,
            };
            assert_current();
            const hydrated = this.#hydrate_document_diff_targets(
                cached.pendingTargets,
                cached.presentation,
                viewer,
            );
            await this.#reveal_comparison_shell(
                cached.preparation.context,
                cached.comparisonDocument,
                viewer,
                /* alreadyPainted */ true,
            );
            // Hydration re-runs on the warm path, so its diagnostics have to be
            // recomputed rather than inherited from the cached preparation.
            const result = {
                ...cached.preparation,
                targets: hydrated.targets,
                diagnostics: [
                    ...cached.presentation.diagnostics,
                    ...hydrated.resolution.diagnostics,
                ],
                resolution: merge_bounds_resolution(
                    cached.presentation.resolution,
                    hydrated.resolution,
                ),
                prepareMs: performance.now() - started,
                sourceCacheHit: true,
            };
            this.#document_comparison = result;
            this.dispatchEvent(new EcadDocumentComparisonReadyEvent(result));
            this.#emit_view_state_change();
            return result;
        }

        if (!same_sources) {
            this.#reference_project.reset();
            this.#document_comparison_cache.clear();
            await Promise.all([
                this.#reference_project.load({
                    urls: [],
                    blobs: request.reference.sources,
                }),
                this.replaceSources(request.comparison),
            ]);
            assert_current();
            this.#document_comparison_key = request.comparisonKey;
            this.#document_comparison_revision_keys = {
                reference: request.reference.revisionKey,
                comparison: request.comparison.revisionKey,
            };
        }

        const path = prepared.document.path.replace(/^\.?\//, "");
        const expected_type = prepared.context === "SCH" ? KicadSch : KicadPCB;
        const resolve_typed = (project: Project) => {
            const candidate =
                project.file_by_name(path) ??
                project.file_by_name(path.split("/").at(-1) ?? path);
            return candidate instanceof expected_type ? candidate : null;
        };
        // Added/renamed sheets exist on only one side. Comparison remains the
        // paint authority; the missing side becomes an empty stub so removals
        // (or an empty reference) still compile without failing the click path.
        const reference_resolved = resolve_typed(this.#reference_project);
        const comparison_resolved = resolve_typed(this.#project);
        if (!reference_resolved && !comparison_resolved) {
            const describe = (project: Project) =>
                [...project.files()]
                    .map((file) => `${file.filename}:${file.constructor.name}`)
                    .join(", ");
            throw new TypeError(
                `Neither revision could resolve ${prepared.document.path}. ` +
                    `Reference files: [${describe(this.#reference_project)}]. ` +
                    `Comparison files: [${describe(this.#project)}].`,
            );
        }
        const reference_document =
            reference_resolved ?? empty_diff_document(prepared.context, path);
        const comparison_document =
            comparison_resolved ?? empty_diff_document(prepared.context, path);
        const missingReference = !reference_resolved;
        const missingComparison = !comparison_resolved;
        let reference_schematic_context: SchematicInstanceContext | undefined;
        let comparison_schematic_context: SchematicInstanceContext | undefined;

        if (prepared.context === "SCH" && reference_resolved) {
            const requested_reference = requested_comparison_sheet(
                request,
                "reference",
                reference_document.filename,
            );
            const reference_page = this.#resolve_schematic_page_in(
                this.#reference_project,
                requested_reference,
            );
            if (reference_page) {
                reference_schematic_context = reference_page.schematic_context;
                this.#reference_project.activate_sch(
                    reference_page.project_path,
                );
            }
        }

        // Activate tab/sheet without a pre-load paint. Cold path settles once
        // via load_diff_document + reveal (not showPage/app.load round-trips).
        if (prepared.context === "SCH") {
            if (this.#active_tab !== TabKind.sch && this.has_sch) {
                await this.#switchToTab(TabKind.sch);
            }
            if (comparison_resolved) {
                const requested_comparison = requested_comparison_sheet(
                    request,
                    "comparison",
                    comparison_document.filename,
                );
                await this.#activate_comparison_sheet(
                    requested_comparison,
                    comparison_document,
                );
                comparison_schematic_context =
                    this.#resolve_schematic_page(
                        requested_comparison,
                    )?.schematic_context;
            }
        } else if (this.#active_tab !== TabKind.pcb) {
            await this.#switchToTab(TabKind.pcb);
        }
        assert_current();

        const viewer = this.#viewer_for_context(prepared.context);
        if (!viewer) {
            throw new Error(
                `The ${prepared.context} comparison viewer is not ready`,
            );
        }
        const presentation = build_diff_presentation(
            prepared.index,
            reference_document,
            comparison_document,
        );
        const schematic_contexts = new Map<object, SchematicInstanceContext>();
        if (reference_schematic_context) {
            schematic_contexts.set(
                reference_document,
                reference_schematic_context,
            );
        }
        if (comparison_schematic_context) {
            schematic_contexts.set(
                comparison_document,
                comparison_schematic_context,
            );
        }
        if (schematic_contexts.size) {
            presentation.schematicContexts = schematic_contexts;
        }
        const focus_presentation = build_diff_focus_presentation(presentation);
        const side_scene = (
            document: PaintableDocument,
            side: "reference" | "comparison",
        ): EcadDiffScenePair => {
            const scene = build_diff_side_presentation(
                prepared.index,
                document,
                side,
            );
            const context =
                side === "reference"
                    ? reference_schematic_context
                    : comparison_schematic_context;
            if (context) {
                scene.schematicContexts = new Map([[document, context]]);
            }
            return { scene, focus: build_diff_focus_presentation(scene) };
        };
        const side_scenes = {
            reference: side_scene(reference_document, "reference"),
            comparison: side_scene(comparison_document, "comparison"),
        };
        await viewer.load_diff_document(
            comparison_document as never,
            presentation,
        );
        this.#active_diff_scenes = {
            scene: presentation,
            focus: focus_presentation,
        };
        assert_current();
        await this.#reveal_comparison_shell(
            prepared.context,
            comparison_document,
            viewer,
            /* alreadyPainted */ true,
        );
        assert_current();
        const hydrated = this.#hydrate_document_diff_targets(
            prepared.targets,
            presentation,
            viewer,
        );

        const result: EcadDocumentComparisonPreparation = {
            comparisonKey: request.comparisonKey,
            context: prepared.context,
            document: prepared.document,
            targets: hydrated.targets,
            diagnostics: [
                ...presentation.diagnostics,
                ...hydrated.resolution.diagnostics,
            ],
            resolution: merge_bounds_resolution(
                presentation.resolution,
                hydrated.resolution,
            ),
            prepareMs: performance.now() - started,
            sourceCacheHit: same_sources,
            missingReference,
            missingComparison,
        };
        this.#document_comparison_cache.set(prepared.document.path, {
            preparation: result,
            presentation,
            focusPresentation: focus_presentation,
            sideScenes: side_scenes,
            referenceDocument: reference_document,
            comparisonDocument: comparison_document,
            pendingTargets: prepared.targets,
        });
        this.#document_comparison = result;
        ecadPerfLog(
            `document comparison ready context=${result.context} changes=${prepared.index.changes.length} targets=${result.targets.size} prepare=${result.prepareMs.toFixed(1)}ms diagnostics=${result.diagnostics.length} ` +
                `sourceResolved=${result.resolution.sourceResolved}/${result.resolution.changes} ` +
                `paintedBounds=${result.resolution.targetsWithPaintedBounds}/${result.resolution.targets} ` +
                `providedBounds=${result.resolution.targetsUsingProvidedBounds} ` +
                `ambiguous=${result.resolution.ambiguousSourceIds} ` +
                `duplicateTargets=${result.resolution.duplicateChangeTargets}`,
        );
        this.dispatchEvent(new EcadDocumentComparisonReadyEvent(result));
        this.#emit_view_state_change();
        return result;
    }

    /**
     * Prefer hierarchical sheet identity when present; fall back to filename.
     * Does not await a full app.load — comparison settle owns the paint.
     */
    async #activate_comparison_sheet(
        pageId: string,
        fallbackDocument: { filename?: string },
    ): Promise<void> {
        if (!this.#schematic_app) {
            this.#trace_transition("page.comparison.missing-app", {
                status: "missing",
                requestedPage: pageId,
            });
            return;
        }
        this.#desired_page = pageId;
        const page =
            this.#resolve_schematic_page(pageId) ??
            (fallbackDocument.filename
                ? this.#resolve_schematic_page(fallbackDocument.filename)
                : null);
        if (!page) {
            this.#trace_transition("page.comparison.unresolved", {
                status: "missing",
                requestedPage: pageId,
                detail: {
                    fallbackFilename: fallbackDocument.filename ?? null,
                    availablePages: this.#project.pages.map((candidate) => ({
                        projectPath: candidate.project_path,
                        sheetPath: candidate.sheet_path,
                        filename: candidate.filename,
                        name: candidate.name,
                        page: candidate.page,
                    })),
                },
            });
            return;
        }
        if (this.#active_schematic_project_path !== page.project_path) {
            // Comparison owns the following diff-scene paint. Updating the
            // instance selection directly avoids Project.change scheduling a
            // plain app.load that can race the retained presentation and leave
            // an unused full-colour scene cached behind it.
            this.#active_schematic_project_path = page.project_path;
            this.#project.active_sch_name = page.project_path;
        }
        const context = page.schematic_context;
        if (context) {
            this.#schematic_app.sch_viewer.set_instance_context(context);
        }
        this.#trace_transition("page.comparison.activated", {
            status: "ready",
            requestedPage: pageId,
            resolvedPage: this.#page_trace(page),
        });
    }

    /**
     * Unhide the SCH/PCB shell and fit the camera once. When alreadyPainted,
     * skips DocumentViewer.load / app.load so the comparison cold path does
     * not multi-paint the same retained scene.
     */
    async #reveal_comparison_shell(
        context: "SCH" | "PCB",
        document: unknown,
        viewer: {
            document?: unknown;
            paint?: () => void;
            draw?: () => void;
            draw_now?: () => void;
            zoom_fit_top_item?: () => void;
            renderer?: { update_canvas_size?: () => void };
            viewport?: {
                ready?: PromiseLike<unknown>;
                sync_from_canvas?: () => boolean;
            };
        },
        alreadyPainted: boolean,
    ): Promise<void> {
        const app = context === "SCH" ? this.#schematic_app : this.#board_app;
        if (!app) return;
        if (!alreadyPainted || viewer.document !== document) {
            await app.load(document as never);
            return;
        }
        // Same document already painted by load_diff_document — reveal only.
        const shell = app as {
            revealLoadedContent?: () => void;
        };
        if (typeof shell.revealLoadedContent === "function") {
            shell.revealLoadedContent();
        } else {
            await app.load(document as never);
            return;
        }
        await viewer.viewport?.ready;
        viewer.renderer?.update_canvas_size?.();
        const sized = viewer.viewport?.sync_from_canvas?.() ?? false;
        if (sized) {
            viewer.zoom_fit_top_item?.();
        }
        viewer.draw_now?.() ?? viewer.draw?.();
    }

    /**
     * Apply one precomputed selection frame. This method never parses, repaints
     * the document, or walks the diff tree.
     */
    #cancel_diff_animation(): void {
        if (this.#diff_animation_frame !== null) {
            cancelAnimationFrame(this.#diff_animation_frame);
            this.#diff_animation_frame = null;
        }
    }

    #active_diff_target(): {
        context: "SCH" | "PCB";
        target: EcadPreparedDiffTarget;
    } | null {
        const selection =
            this.#preview_document_diff ?? this.#selected_document_diff;
        const comparison = this.#document_comparison;
        if (!selection || !comparison) return null;
        let target: EcadPreparedDiffTarget | undefined;
        if (selection.kind !== "changes") {
            target = comparison.targets.get(
                `${selection.kind}:${selection.id}`,
            );
        } else {
            const selected_ids = new Set(selection.ids);
            const available = [...comparison.targets.values()];
            const routing_groups = available.filter(
                (candidate) =>
                    candidate.kind === "group" &&
                    candidate.routing &&
                    candidate.memberIds.some((id) => selected_ids.has(id)),
            );
            const direct = selection.ids.flatMap((id) => {
                const exact = comparison.targets.get(`change:${id}`);
                if (exact) return [exact];
                const containing = available.find(
                    (candidate) =>
                        candidate.kind === "change" &&
                        candidate.memberIds.includes(id),
                );
                return containing ? [containing] : [];
            });
            const members = routing_groups.length ? routing_groups : direct;
            const visual_keys = new Set<string>();
            const member_visuals = members.flatMap((member) =>
                member.visuals.filter((visual) => {
                    const key = `${visual.sourceSide}:${visual.sourceId}:${visual.category}`;
                    if (visual_keys.has(key)) return false;
                    visual_keys.add(key);
                    return true;
                }),
            );
            // Host net groups can include endpoint pad deltas beside routing
            // deltas. Prefer the native route when it exists; otherwise a pad
            // promotes to its full footprint and obscures the selected trace.
            const visuals = member_visuals.some((visual) => visual.routing)
                ? member_visuals.filter((visual) => visual.routing)
                : member_visuals;
            if (members.length && visuals.length) {
                const bounds = BBox.combine(
                    visuals.map((visual) => new BBox(...visual.bounds)),
                );
                const categories = new Set(
                    visuals.map((visual) => visual.category),
                );
                target = {
                    id: selection.ids.join("|"),
                    kind: "changes",
                    category:
                        categories.size === 1
                            ? visuals[0]!.category
                            : "modified",
                    label: "Selected changes",
                    memberIds: [
                        ...new Set(
                            members.flatMap((member) => member.memberIds),
                        ),
                    ],
                    sourceIds: visuals.map((visual) => visual.sourceId),
                    bounds: [bounds.x, bounds.y, bounds.w, bounds.h],
                    sourceSide: visuals[0]!.sourceSide,
                    routing: visuals.some((visual) => visual.routing),
                    overlayLines: visuals.flatMap(
                        (visual) => visual.overlayLines,
                    ),
                    visuals,
                };
            }
        }
        return target ? { context: comparison.context, target } : null;
    }

    #paint_diff_emphasis(offset = 0): EcadPreparedDiffTarget | null {
        const active = this.#active_diff_target();
        const viewer = active ? this.#viewer_for_context(active.context) : null;
        if (!active || !viewer) {
            const scenes = this.#active_diff_scenes;
            const board_viewer = this.#safe_board_viewer();
            if (
                board_viewer &&
                scenes &&
                board_viewer.diff_presentation === scenes.focus
            ) {
                board_viewer.activate_cached_diff_presentation(scenes.scene);
            }
            this.#base_diff_layer_visibility = null;
            for (const channel of [
                ECadViewer.#DIFF_SELECTION_CHANNEL,
                ECadViewer.#DIFF_CONTEXT_CHANNEL,
            ]) {
                this.#safe_schematic_viewer()?.clear_overlay_scene(channel);
                board_viewer?.clear_overlay_scene(channel);
            }
            return null;
        }
        let { target } = active;
        const scenes = this.#active_diff_scenes;
        const board_viewer =
            active.context === "PCB" ? this.#safe_board_viewer() : null;
        if (
            board_viewer &&
            scenes &&
            (board_viewer.diff_presentation === scenes.scene ||
                board_viewer.diff_presentation === scenes.focus)
        ) {
            if (board_viewer.diff_presentation === scenes.scene) {
                this.#base_diff_layer_visibility =
                    board_viewer.capture_diff_layer_visibility();
            }
            if (board_viewer.activate_cached_diff_presentation(scenes.focus)) {
                const entries = new Map<
                    object,
                    {
                        item: object;
                        status: EcadPreparedDiffTarget["category"];
                        routing: boolean;
                    }
                >();
                for (const visual of target.visuals) {
                    // Resolve against *this pane's* scene. A side pane indexes
                    // its own revision's objects under its own side key, so a
                    // modified track resolves on both panes even though the
                    // change itself names only one side.
                    const items =
                        scenes.scene.itemsBySideAndSourceId.get(
                            `${visual.sourceSide}:${visual.sourceId}`,
                        ) ??
                        scenes.scene.itemsBySourceId.get(visual.sourceId) ??
                        [];
                    for (const item of items) {
                        entries.set(item, {
                            item,
                            status: visual.category,
                            routing: visual.routing,
                        });
                    }
                }
                const native_entries = [...entries.values()];
                const routing_type_ids = new Set([
                    "LineSegment",
                    "ArcSegment",
                    "Via",
                ]);
                const has_native_routing = native_entries.some((entry) =>
                    routing_type_ids.has(
                        (entry.item as { typeId?: string }).typeId ?? "",
                    ),
                );
                const paint_entries = has_native_routing
                    ? native_entries.filter((entry) =>
                          routing_type_ids.has(
                              (entry.item as { typeId?: string }).typeId ?? "",
                          ),
                      )
                    : native_entries;
                const selected_bounds = paint_entries.flatMap((entry) => [
                    ...board_viewer.layers.query_item_bboxes(entry.item),
                ]);
                board_viewer.clear_overlay_scene(
                    ECadViewer.#DIFF_SELECTION_CHANNEL,
                );
                board_viewer.paint_diff_selection(
                    paint_entries,
                    this.#base_diff_layer_visibility ?? new Map(),
                );
                if (selected_bounds.length) {
                    const combined = BBox.combine(selected_bounds);
                    target = {
                        ...target,
                        bounds: [
                            combined.x,
                            combined.y,
                            combined.w,
                            combined.h,
                        ],
                    };
                    this.#emit_view_state_change();
                    return target;
                }
                // Nothing native to paint here: an added object selected on the
                // base pane, or a removed one on the compare pane. The scene
                // stays subdued (paint_diff_selection with no entries cleared
                // the previous highlight and restored layer visibility) and the
                // dashed outline below marks where the object lands, so the two
                // panes still point at the same place on the board.
            }
        }

        const primitives: EcadOverlayPrimitive[] = [];
        target.visuals.forEach((visual, visualIndex) => {
            const color = DIFF_STATUS_COLORS[visual.category];
            if (visual.routing && visual.overlayLines.length) {
                visual.overlayLines.forEach((points, index) => {
                    primitives.push({
                        id: `emphasis:${target.id}:${visualIndex}:${index}`,
                        kind: "polyline",
                        anchor: { kind: "world", x: 0, y: 0 },
                        points,
                        stroke: color,
                        opacity: 1,
                        strokeWidth: ECadViewer.#DIFF_EMPHASIS_STROKE_WIDTH,
                        fitAdaptiveStroke: true,
                        sizing: "screen",
                        dash: ECadViewer.#DIFF_EMPHASIS_DASH,
                        dashOffset: offset,
                    });
                });
            } else {
                // Every target dashes, not just routing. The marching outline
                // is what says "this is the change under review" as opposed to
                // any other coloured geometry in the composite scene, and that
                // reading is needed most on the schematic, where nothing is
                // routing.
                primitives.push({
                    id: `emphasis:${target.id}:${visualIndex}`,
                    kind: "bbox",
                    anchor: { kind: "bbox", bounds: visual.bounds },
                    stroke: color,
                    opacity: 1,
                    strokeWidth: ECadViewer.#DIFF_EMPHASIS_STROKE_WIDTH,
                    padding: ECadViewer.#DIFF_EMPHASIS_PADDING,
                    sizing: "screen",
                    dash: ECadViewer.#DIFF_EMPHASIS_DASH,
                    dashOffset: offset,
                    fitAdaptiveStroke: visual.routing,
                });
            }
        });
        this.#diff_emphasis_painted = primitives.length > 0;
        // Context first, then status: both sit in the foreground, so the order
        // of these two calls is what puts the status outline on top of the
        // selection halo rather than inside it.
        this.#paint_diff_channel(
            viewer,
            ECadViewer.#DIFF_CONTEXT_CHANNEL,
            active.context,
            diff_context_primitives(target.id, target.visuals),
        );
        this.#paint_diff_channel(
            viewer,
            ECadViewer.#DIFF_SELECTION_CHANNEL,
            active.context,
            primitives,
        );
        viewer.draw();
        return target;
    }

    /** Replace one diff channel's contents, leaving the other untouched. */
    #paint_diff_channel(
        viewer: {
            set_overlay_scene: (
                scene: EcadOverlayScene,
                redraw: boolean,
            ) => void;
        },
        channelId: string,
        context: EcadOverlayContext,
        primitives: EcadOverlayPrimitive[],
    ): void {
        viewer.set_overlay_scene(
            {
                channelId,
                context,
                placement: "foreground",
                visible: true,
                primitives,
            },
            false,
        );
    }

    #diff_animation_suspended(): boolean {
        return (
            !this.#host_active ||
            document.hidden ||
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
    }

    #restart_diff_animation(): EcadPreparedDiffTarget | null {
        this.#cancel_diff_animation();
        this.#diff_emphasis_painted = false;
        const target = this.#paint_diff_emphasis();
        // The board's native-replay path repaints the selection into a real
        // layer and never reaches the overlay, so there is no dash to march
        // and no reason to hold a frame loop open for it.
        if (!this.#diff_emphasis_painted || this.#diff_animation_suspended()) {
            return target;
        }
        this.#diff_animation_started = performance.now();
        const tick = (time: number) => {
            if (this.#diff_animation_suspended()) {
                this.#diff_animation_frame = null;
                return;
            }
            this.#paint_diff_emphasis(
                -((time - this.#diff_animation_started) / 1000) *
                    ECadViewer.#DIFF_EMPHASIS_DASH_SPEED,
            );
            this.#diff_animation_frame = requestAnimationFrame(tick);
        };
        this.#diff_animation_frame = requestAnimationFrame(tick);
        return target;
    }

    /** Preview a change without moving the camera; null restores selection. */
    public previewDocumentDiff(
        selection: EcadDocumentComparisonSelection | null,
    ): void {
        this.#preview_document_diff = selection;
        this.#restart_diff_animation();
    }

    public clearDocumentDiffSelection(): void {
        this.#selected_document_diff = null;
        this.#preview_document_diff = null;
        this.#restart_diff_animation();
    }

    public async selectDocumentDiff(
        selection: EcadDocumentComparisonSelection,
    ): Promise<EcadDocumentComparisonSelectionResult> {
        const started = performance.now();
        const requestId = ++this.#document_comparison_request_id;
        this.#trace_transition("selection.composite.request", {
            status: "start",
            generation: requestId,
            detail: selection,
        });
        const parserBefore = getParserPerfSnapshot().parserInvocations;
        const comparison = this.#document_comparison;
        this.#selected_document_diff = selection;
        this.#preview_document_diff = null;
        let target = this.#active_diff_target()?.target;
        const viewer = comparison
            ? this.#viewer_for_context(comparison.context)
            : null;
        if (!comparison || !target || !viewer) {
            this.#selected_document_diff = null;
            this.#trace_transition("selection.composite.missing", {
                status: "missing",
                generation: requestId,
                detail: {
                    ...selection,
                    hasComparison: Boolean(comparison),
                    hasTarget: Boolean(target),
                    hasViewer: Boolean(viewer),
                },
            });
            return {
                status: "missing",
                requestId,
                clickToFrameMs: performance.now() - started,
                paintCount: viewer?.paint_count ?? 0,
                parserCount:
                    getParserPerfSnapshot().parserInvocations - parserBefore,
            };
        }

        const paintBefore = viewer.paint_count;
        target = this.#restart_diff_animation() ?? target;
        const [x, y, w, h] = target.bounds;
        const padding = Math.max(Math.max(w, h) * 0.35, 2);
        viewer.viewport.camera.bbox = new BBox(
            x - padding,
            y - padding,
            w + padding * 2,
            h + padding * 2,
        );
        viewer.draw();

        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
        const result: EcadDocumentComparisonSelectionResult = {
            status:
                requestId === this.#document_comparison_request_id
                    ? "applied"
                    : "superseded",
            requestId,
            target,
            clickToFrameMs: performance.now() - started,
            paintCount: viewer.paint_count - paintBefore,
            parserCount:
                getParserPerfSnapshot().parserInvocations - parserBefore,
        };
        ecadPerfLog(
            `document diff frame request=${requestId} status=${result.status} target=${target.kind}:${target.id} clickToFrame=${result.clickToFrameMs.toFixed(1)}ms paint=${result.paintCount} parse=${result.parserCount}`,
        );
        this.dispatchEvent(new EcadDocumentComparisonFrameEvent(result));
        this.#trace_transition("selection.composite.complete", {
            status: result.status === "applied" ? "ready" : result.status,
            generation: requestId,
            detail: {
                ...selection,
                targetId: target.id,
                memberIds: target.memberIds,
                sourceIds: target.sourceIds,
                bounds: target.bounds,
                clickToFrameMs: result.clickToFrameMs,
                paintCount: result.paintCount,
            },
        });
        return result;
    }

    /**
     * Prefer bounds from the retained native display list over adapter
     * geometry. This runs once after the comparison document is painted, so a
     * click only consumes the already-normalized target rectangle.
     */
    static #overlay_line_for_item(
        item: object,
    ): Array<[number, number]> | null {
        const point = (value: unknown): [number, number] | null => {
            if (
                value &&
                typeof value === "object" &&
                "x" in value &&
                "y" in value &&
                typeof value.x === "number" &&
                typeof value.y === "number"
            ) {
                return [value.x, value.y];
            }
            return null;
        };
        if ("pts" in item && Array.isArray(item.pts)) {
            const points = item.pts
                .map(point)
                .filter((value) => value !== null);
            return points.length >= 2 ? points : null;
        }
        if ("start" in item && "end" in item) {
            const start = point(item.start);
            const middle = "mid" in item ? point(item.mid) : null;
            const end = point(item.end);
            const points = [start, middle, end].filter(
                (value): value is [number, number] => value !== null,
            );
            return points.length >= 2 ? points : null;
        }
        return null;
    }

    /**
     * Finalize focusable targets only after the parsed scene has painted.
     * Native KiCad callers may retain their strict bbox as a fallback. Prism
     * supplies no bbox: an unresolved seed remains visible in the host change
     * list through its diagnostic, but never becomes an origin target.
     */
    #hydrate_document_diff_targets(
        pending_targets: ReadonlyMap<string, EcadPendingDiffTarget>,
        presentation: EcadDiffPresentation,
        viewer: DocumentViewer<any, any, any, any>,
    ): {
        targets: ReadonlyMap<string, EcadPreparedDiffTarget>;
        resolution: EcadDiffBoundsResolution;
    } {
        const targets = new Map<string, EcadPreparedDiffTarget>();
        const diagnostics: EcadDiffResolutionDiagnostic[] = [];
        let targets_with_painted_bounds = 0;
        let targets_using_provided_bounds = 0;
        let targets_non_focusable = 0;
        let visuals_total = 0;
        let visuals_with_painted_bounds = 0;
        let visuals_using_provided_bounds = 0;
        let visuals_non_focusable = 0;
        const valid_bounds = (
            value?: [number, number, number, number],
        ): value is [number, number, number, number] =>
            Boolean(
                value &&
                value.every(Number.isFinite) &&
                (value[2] > 0 || value[3] > 0),
            );

        for (const [target_key, target] of pending_targets) {
            const native_bounds: BBox[] = [];
            const focus_bounds: BBox[] = [];
            const overlay_lines: Array<Array<[number, number]>> = [];
            const visuals: EcadPreparedDiffTarget["visuals"] = [];
            for (const visual of target.visuals) {
                visuals_total += 1;
                const visual_bounds: BBox[] = [];
                const visual_lines: Array<Array<[number, number]>> = [];
                const source_id = visual.sourceId;
                const visual_items =
                    presentation.itemsBySideAndSourceId.get(
                        `${visual.sourceSide}:${source_id}`,
                    ) ??
                    presentation.itemsBySourceId.get(source_id) ??
                    [];
                for (const item of visual_items) {
                    const line = ECadViewer.#overlay_line_for_item(item);
                    if (line) {
                        overlay_lines.push(line);
                        visual_lines.push(line);
                    }
                    // query_item_bboxes is a generator. Spreading it twice
                    // fed the second consumer an exhausted iterator, so
                    // visual.bounds silently kept whatever the caller
                    // supplied while target.bounds got the real painted
                    // extent. Materialize once and share.
                    const item_bounds = [
                        ...viewer.layers.query_item_bboxes(item),
                    ];
                    native_bounds.push(...item_bounds);
                    visual_bounds.push(...item_bounds);
                }
                if (visual_bounds.length) {
                    visuals_with_painted_bounds += 1;
                    const combined = BBox.combine(visual_bounds);
                    const bounds: [number, number, number, number] = [
                        combined.x,
                        combined.y,
                        combined.w,
                        combined.h,
                    ];
                    focus_bounds.push(combined);
                    visuals.push({
                        ...visual,
                        bounds,
                        overlayLines: visual_lines,
                    });
                } else if (valid_bounds(visual.bounds)) {
                    visuals_using_provided_bounds += 1;
                    const fallback = new BBox(...visual.bounds);
                    focus_bounds.push(fallback);
                    visuals.push({
                        ...visual,
                        bounds: visual.bounds,
                        overlayLines: visual_lines,
                    });
                } else {
                    visuals_non_focusable += 1;
                    // Identity misses already carry an item-not-found
                    // diagnostic from presentation build. Add a bounds
                    // diagnostic only when identity resolved but did not paint.
                    if (visual_items.length) {
                        diagnostics.push({
                            changeId: target.id,
                            sourceId: source_id,
                            side: visual.sourceSide,
                            reason: "paint-bounds-not-found",
                            matchCount: visual_items.length,
                            typeName: visual.typeName,
                        });
                    }
                }
            }
            const combined = native_bounds.length
                ? BBox.combine(native_bounds)
                : focus_bounds.length
                  ? BBox.combine(focus_bounds)
                  : null;
            if (
                combined &&
                Number.isFinite(combined.x) &&
                Number.isFinite(combined.y) &&
                Number.isFinite(combined.w) &&
                Number.isFinite(combined.h)
            ) {
                if (native_bounds.length) {
                    targets_with_painted_bounds += 1;
                } else {
                    targets_using_provided_bounds += 1;
                }
                targets.set(target_key, {
                    ...target,
                    bounds: [combined.x, combined.y, combined.w, combined.h],
                    overlayLines: overlay_lines,
                    visuals,
                });
            } else {
                targets_non_focusable += 1;
                if (!target.visuals.length) {
                    // No visual carried the failure, so record it on the target
                    // or it disappears from the count entirely.
                    diagnostics.push({
                        changeId: target.id,
                        side: target.sourceSide,
                        reason: "paint-bounds-not-found",
                        matchCount: 0,
                        typeName: target.label.split(" ")[0],
                    });
                }
            }
        }
        return {
            targets,
            resolution: {
                diagnostics,
                targets: pending_targets.size,
                targetsWithPaintedBounds: targets_with_painted_bounds,
                targetsUsingProvidedBounds: targets_using_provided_bounds,
                targetsNonFocusable: targets_non_focusable,
                visuals: visuals_total,
                visualsWithPaintedBounds: visuals_with_painted_bounds,
                visualsUsingProvidedBounds: visuals_using_provided_bounds,
                visualsNonFocusable: visuals_non_focusable,
            },
        };
    }

    /**
     * Supersede in-flight comparison loads without clearing the installed
     * A/R/M presentation. Hosts use this on effect cleanup / mode hide so a
     * retained composite scene is not forced back to full theme colors.
     */
    public abortDocumentComparisonLoad(): void {
        this.#document_comparison_load_generation += 1;
        this.#document_comparison_request_id += 1;
    }

    public clearDocumentComparison(): void {
        this.abortDocumentComparisonLoad();
        this.#cancel_diff_animation();
        this.#selected_document_diff = null;
        this.#preview_document_diff = null;
        this.#base_diff_layer_visibility = null;
        this.#active_diff_scenes = null;
        this.#document_comparison = null;
        this.#document_comparison_key = null;
        this.#document_comparison_revision_keys = null;
        this.#document_comparison_cache.clear();
        for (const context of ["SCH", "PCB"] as const) {
            const viewer = this.#viewer_for_context(context);
            viewer?.clear_overlay_scene(ECadViewer.#DIFF_SELECTION_CHANNEL);
            viewer?.set_diff_presentation(null);
        }
        this.#reference_project.reset();
        for (const page of Object.values(this.#tab_contents)) {
            page.classList.remove("active");
        }
        this.#safe_board_viewer()?.set_active(false);
        this.#safe_schematic_viewer()?.set_active(false);
        this.#apply_viewer_activity();
    }

    #activate_tab_content(tabKind: TabKind): void {
        const previous = this.#active_tab;
        this.#active_tab = tabKind;
        if (previous === TabKind.pcb && this.#board_app) {
            this.#board_app.tabMenuHidden = true;
        } else if (previous === TabKind.sch && this.#schematic_app) {
            this.#schematic_app.tabMenuHidden = true;
        }
        for (const page of Object.values(this.#tab_contents)) {
            page.classList.remove("active");
        }
        this.#tab_contents[tabKind]?.classList.add("active");
        this.#apply_viewer_activity();
        this.#ensure_camera_hook(this.#safe_board_viewer());
        this.#ensure_camera_hook(this.#safe_schematic_viewer());
        this.#emit_camera_change();
    }

    public setActive(active: boolean): void {
        this.#host_active = active;
        this.#apply_viewer_activity();
        if (active) this.#restart_diff_animation();
        else this.#cancel_diff_animation();
    }

    /**
     * Enable or disable comment mode on both the schematic and board
     * viewers. While enabled, dragging on a viewer's canvas draws a
     * rubber-band area and emits an `EcadCommentAreaEvent` on mouseup
     * instead of performing normal item selection.
     */
    public setCommentMode(enabled: boolean): void {
        if (enabled) {
            this.setAttribute("comment-mode", "");
        } else {
            this.removeAttribute("comment-mode");
        }
        this.#safe_board_viewer()?.set_comment_mode(enabled);
        this.#safe_schematic_viewer()?.set_comment_mode(enabled);
    }

    /**
     * Drop the inspected object in both viewers. The highlighted nets are
     * dropped too unless `keepHighlights` is set: a host that owns the set
     * passes it when only its inspected selection changed.
     */
    public clearSelection(options: { keepHighlights?: boolean } = {}): void {
        this.#probe_generation += 1;
        const board_viewer = this.#safe_board_viewer();
        const had_nets = (board_viewer?.highlighted_nets.size ?? 0) > 0;
        board_viewer?.clear_selection(options.keepHighlights === true);
        this.#safe_schematic_viewer()?.clear_selection();
        if (had_nets && !options.keepHighlights)
            this.#emit_highlight_change("clear");
    }

    /**
     * Replace the highlighted nets on the board. Nets resolve by name first
     * (stable across saves), then by code; unresolved refs are reported, not
     * guessed. Never moves the camera unless `focus` is set. The host owns
     * this set, so no `ecad-viewer:highlight-change` is emitted for it.
     */
    public setHighlightedNets(
        nets: readonly EcadNetRef[],
        options: { focus?: boolean } = {},
    ): { applied: EcadNetRef[]; unresolved: EcadNetRef[] } {
        const board_viewer = this.#safe_board_viewer();
        const board = board_viewer?.board;
        if (!board_viewer || !board)
            return { applied: [], unresolved: [...nets] };
        const applied: EcadNetRef[] = [];
        const unresolved: EcadNetRef[] = [];
        const codes: number[] = [];
        for (const ref of nets) {
            const code = resolve_board_net(board, ref);
            if (code === undefined) {
                unresolved.push(ref);
                continue;
            }
            codes.push(code);
            applied.push({
                name: board.getNetName(code) ?? ref.name,
                netCode: code,
            });
        }
        board_viewer.set_highlighted_nets(codes);
        if (options.focus) board_viewer.focus_highlighted_nets();
        return { applied, unresolved };
    }

    /** The board's highlighted nets, in the order they were added. */
    public getHighlightedNets(): EcadNetRef[] {
        const board_viewer = this.#safe_board_viewer();
        const board = board_viewer?.board;
        if (!board_viewer || !board) return [];
        return Array.from(board_viewer.highlighted_nets, (code) => ({
            name: board.getNetName(code) ?? "",
            netCode: code,
        }));
    }

    /** Fit the board camera to the highlighted copper. False when empty. */
    public focusHighlightedNets(): boolean {
        return this.#safe_board_viewer()?.focus_highlighted_nets() ?? false;
    }

    #emit_highlight_change(source: EcadHighlightChangeDetail["source"]) {
        this.dispatchEvent(
            new EcadHighlightChangeEvent({
                nets: this.getHighlightedNets(),
                source,
            }),
        );
    }

    /**
     * Publish comment markers and optional comment areas. Arbitrary graphics
     * are intentionally not exposed at the host boundary.
     */
    public setCommentOverlays(
        request: EcadCommentOverlaySet,
    ): EcadCommentAnchorResolution[] {
        const scene = comment_overlay_scene(request);
        this.#comment_overlay_scenes.set(request.context, scene);
        const viewer = this.#viewer_for_context(request.context);
        viewer?.set_overlay_scene(scene);
        if (!viewer)
            return request.comments.map(({ id }) => ({
                id,
                state: "not-loaded",
            }));
        return resolve_comment_overlays(request, (anchor) =>
            viewer.resolve_overlay_anchor_for_host(anchor),
        );
    }

    public clearCommentOverlays(context?: EcadCommentContext): void {
        const contexts: EcadCommentContext[] = context
            ? [context]
            : ["SCH", "PCB"];
        for (const target of contexts) {
            this.#comment_overlay_scenes.delete(target);
            this.#viewer_for_context(target)?.clear_overlay_scene(
                COMMENT_OVERLAY_CHANNELS[target],
            );
        }
    }

    public requestCrossProbe(request: EcadCrossProbeRequest): boolean {
        const value = request.value.trim();
        if (!value) return false;
        const target = request.targetContext;
        if (target === "PCB" || (!target && this.has_pcb)) {
            const board_viewer = this.#safe_board_viewer();
            if (board_viewer) {
                if (request.kind === "net") {
                    const net_code = resolve_board_net(board_viewer.board, {
                        name: request.net ?? value,
                        netCode: request.netCode,
                        uuids: request.uuids,
                    });
                    if (net_code !== undefined) {
                        // A cross-probe is a replace-of-one; tell the host so
                        // a multi-net collection can follow.
                        board_viewer.focus_net(net_code, false);
                        this.#emit_highlight_change("crossprobe");
                        return true;
                    }
                } else {
                    // Prefer designator — semantic footprint UUIDs are not always
                    // present, and a schematic symbol UUID must not win the lookup.
                    const by_ref = board_viewer.board.find_footprint(
                        request.designator ?? value,
                    );
                    const by_uuid = request.uuid
                        ? board_viewer.board.find_footprint(request.uuid)
                        : null;
                    const footprint = by_ref ?? by_uuid;
                    if (footprint) {
                        board_viewer.highlight_fp(footprint);
                        if (request.mode !== "hover") {
                            const bounds = footprint.bbox;
                            board_viewer.viewport.camera.bbox = bounds.grow(
                                Math.max(bounds.w * 0.8, 4),
                                Math.max(bounds.h * 0.8, 4),
                            );
                        }
                        board_viewer.draw();
                        return true;
                    }
                }
            }
        }
        if (target === "SCH" || (!target && this.has_sch)) {
            return this.#apply_schematic_cross_probe(request, value);
        }
        return false;
    }

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    /**
     * When set, the viewer suppresses its own built-in chrome — the
     * properties/objects/nets panels, the layer "fitter" tab-view, and the
     * bottom-left badge — leaving just the canvas. This lets a host application
     * render its own UI over a bare viewer without fighting the built-in panels.
     */
    @attribute({ type: Boolean })
    public "hide-chrome": boolean;

    // The page the host last requested via showPage()/switchPage(). Re-applied
    // after the project finishes loading so a post-init auto-load can't override
    // the caller's choice.
    #desired_page?: string;
    /** Bumped on clearSelection / new probe so late load().then focus is dropped. */
    #probe_generation = 0;

    /**
     * Move the camera to a specific location (in world coordinates)
     */
    public zoomToLocation(x: number, y: number): void {
        const pos = new Vec2(x, y);
        // Helper to move camera on a viewer
        const moveCamera = (viewer: any) => {
            if (viewer?.viewport?.camera) {
                const camera = viewer.viewport.camera;
                const safeCenter = camera.fit_viewport_center;
                const viewport = camera.viewport_size;
                camera.center.set(
                    pos.x + (viewport.x / 2 - safeCenter.x) / camera.zoom,
                    pos.y + (viewport.y / 2 - safeCenter.y) / camera.zoom,
                );
                viewer.draw();
            }
        };

        moveCamera(this.#safe_board_viewer());
        moveCamera(this.#safe_schematic_viewer());
        this.#emit_camera_change();
    }

    // ------------------------------------------------------------------
    // Focus API
    // ------------------------------------------------------------------

    /**
     * Fit the active viewer's camera to a world-space bbox and resolve with the
     * settled camera (the bbox setter defers the zoom/center computation to the
     * next paint, so we sample it a frame later).
     */
    public async focusBBox(
        x: number,
        y: number,
        w: number,
        h: number,
    ): Promise<CameraState | null> {
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return null;
        cam.bbox = new BBox(x, y, w, h);
        v.draw?.();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        this.#emit_camera_change();
        return this.camera;
    }

    /**
     * Focus an item by uuid: resolve its bbox inside the active viewer, fit the
     * camera to it (grown a little), and optionally select/highlight it.
     * Resolves with the settled camera, or null if the item can't be resolved.
     */
    public async focusItem(
        uuid: string,
        opts?: { select?: boolean; pad?: number },
    ): Promise<CameraState | null> {
        const v: any = this.#active_inner_viewer();
        if (!v) return null;
        const pad = opts?.pad ?? 20;
        const bbox =
            v.schematic_renderer?.get_item_bbox?.(uuid) ??
            v.get_item_bbox?.(uuid) ??
            null;
        if (!bbox) return null;
        v.viewport.camera.bbox = bbox.grow(pad);
        if (opts?.select && typeof v.paint_selected === "function") {
            v.paint_selected(bbox);
        }
        v.draw?.();
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        this.#emit_camera_change();
        return this.camera;
    }

    /**
     * List schematic label / global-label / hierarchical-label instances that
     * share the given text. Used by Prism's Selection inspector for Next/Prev.
     * Accepts either bare label text or a hierarchical net path (uses the
     * final path segment).
     */
    public findLabelInstances(name: string): Array<{
        uuid: string;
        sheet: string;
        name: string;
        kind?: "global" | "net" | "hierarchical";
    }> {
        const candidates = [name];
        if (name.includes("/")) {
            const bare = name.split("/").filter(Boolean).at(-1);
            if (bare && bare !== name) candidates.push(bare);
        }
        for (const candidate of candidates) {
            const refs = this.#project.find_labels_by_name(candidate) ?? [];
            if (refs.length) {
                return refs.map((ref) => ({
                    uuid: ref.uuid,
                    sheet: ref.sheet_name,
                    name: ref.name,
                    kind: ref.kind,
                }));
            }
        }
        return [];
    }

    /**
     * Switch to the sheet containing a label instance (by uuid) and frame it.
     * Emits `ecad-viewer:selection` so hosts can update their inspector.
     */
    public async focusLabelInstance(uuid: string): Promise<boolean> {
        await this.ready;
        const ref = this.#project.find_net_item(uuid);
        if (!ref) return false;
        const sch = this.#project.file_by_name(ref.sheet_name);
        if (!(sch instanceof KicadSch)) return false;

        if (this.#active_tab !== TabKind.sch && this.has_sch) {
            await this.#switchToTab(TabKind.sch);
        }

        const page = this.#resolve_schematic_page(ref.sheet_name);
        if (page) {
            this.#desired_page = page.project_path;
            this.#activate_schematic_page(page.project_path);
        }

        const sch_viewer = this.#safe_schematic_viewer();
        if (!sch_viewer) return false;

        if (sch_viewer.sch_name !== ref.sheet_name) {
            sch_viewer.focus_net_item = uuid;
            await sch_viewer.load(sch);
        } else {
            sch_viewer.zoom_fit_item(uuid);
        }

        await new Promise<void>((r) => requestAnimationFrame(() => r()));

        const schematic = sch_viewer.schematic;
        if (schematic) {
            const item =
                schematic.global_labels.find((l) => l.uuid === uuid) ??
                schematic.net_labels.find((l) => l.uuid === uuid) ??
                schematic.hierarchical_labels.find((l) => l.uuid === uuid);
            if (item) {
                const detail = normalize_schematic_selection(
                    item,
                    schematic,
                    sch_viewer.instance_context,
                );
                if (detail) {
                    this.#attach_item_bounds_sch(detail, item, sch_viewer);
                    this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
                }
            }
        }

        this.#emit_camera_change();
        this.#emit_view_state_change();
        return true;
    }

    /**
     * Convenience cross-probe: focus + highlight by designator/uuid in the
     * ACTIVE viewer. Structured hosts should prefer requestCrossProbe().
     */
    public async crossProbe(reference: string): Promise<CameraState | null> {
        const v: any = this.#active_inner_viewer();
        if (!v) return null;

        const board = v.board as
            | {
                  find_footprint?: (
                      r: string,
                  ) => { uuid?: string; bbox?: BBox } | null;
              }
            | undefined;
        if (board?.find_footprint) {
            const fp = board.find_footprint(reference);
            if (!fp?.bbox) return null;
            if (typeof v.highlight_fp === "function") v.highlight_fp(fp);
            const b = fp.bbox;
            v.viewport.camera.bbox = b.grow(b.w * 0.5, b.h * 0.5);
            v.draw?.();
            await new Promise<void>((r) => requestAnimationFrame(() => r()));
            this.#emit_camera_change();
            return this.camera;
        }

        const doc = v.document as
            | { find_symbol?: (r: string) => { uuid?: string } | null }
            | undefined;
        if (doc?.find_symbol) {
            const sym =
                v instanceof SchematicViewer
                    ? v.instance_context?.find_symbol(reference)
                    : doc.find_symbol(reference);
            if (!sym?.uuid) return null;
            return this.focusItem(sym.uuid, { select: true });
        }

        return null;
    }

    // ------------------------------------------------------------------
    // Camera API (value-based seam)
    // ------------------------------------------------------------------

    /** The inner viewer for the currently-active tab (or the only loaded one). */
    #active_inner_viewer(): any | null {
        const board_viewer = this.#safe_board_viewer();
        const schematic_viewer = this.#safe_schematic_viewer();
        const v =
            this.#active_tab === TabKind.pcb && board_viewer
                ? board_viewer
                : this.#active_tab === TabKind.sch && schematic_viewer
                  ? schematic_viewer
                  : (board_viewer ?? schematic_viewer);
        this.#ensure_camera_hook(board_viewer);
        this.#ensure_camera_hook(schematic_viewer);
        return v;
    }

    /**
     * Idempotently wrap a viewer's `on_viewport_change` so any camera move
     * (user pan/zoom included) re-emits a `camerachange` event on the host.
     */
    #ensure_camera_hook(viewer: any | undefined): void {
        if (!viewer || viewer.__camerachange_hooked) return;
        if (typeof viewer.on_viewport_change !== "function") return;
        const orig = viewer.on_viewport_change.bind(viewer);
        viewer.on_viewport_change = () => {
            orig();
            if (viewer.active) this.#emit_camera_change();
        };
        viewer.__camerachange_hooked = true;
    }

    public get camera(): CameraState | null {
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return null;
        return {
            x: cam.center.x,
            y: cam.center.y,
            zoom: cam.zoom,
            rotation: cam.rotation?.radians ?? 0,
        };
    }

    public set camera(state: CameraState | null) {
        if (!state) return;
        const v = this.#active_inner_viewer();
        const cam = v?.viewport?.camera;
        if (!cam) return;
        cam.center.set(state.x, state.y);
        cam.zoom = state.zoom;
        if (state.rotation != null && cam.rotation)
            cam.rotation.radians = state.rotation;
        v.draw?.();
        this.#emit_camera_change();
    }

    /** Dispatch a composed `camerachange` event carrying the current camera. */
    #emit_camera_change = () => {
        const detail = this.camera;
        if (!detail) return;
        this.dispatchEvent(
            new CustomEvent("camerachange", {
                detail,
                bubbles: true,
                composed: true,
            }),
        );
    };

    /**
     * Resolves once the project has finished loading (parse + first paint).
     */
    public get ready(): Promise<void> {
        return this.#visible_ready;
    }

    /**
     * Settle the active canvas after a host-side flex/grid resize. Keeping this
     * synchronous avoids a frame where the GL projection has the new size but
     * the camera still uses the previous pane's aspect ratio.
     */
    public resize(): void {
        this.#apply_viewport_insets();
        for (const viewer of [
            this.#safe_board_viewer(),
            this.#safe_schematic_viewer(),
        ]) {
            if (!viewer) continue;
            viewer.renderer?.update_canvas_size?.();
            viewer.viewport?.sync_from_canvas?.();
            if (viewer.active) viewer.draw?.();
        }
    }

    #resolve_schematic_page_in(project: Project, pageId: string) {
        if (!pageId || pageId === "/") return undefined;
        const pages = project.pages;
        const normalize = (value: string) =>
            value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
        const requested = normalize(pageId);
        const same = (value?: string) =>
            Boolean(value && normalize(value) === requested);

        const by_project_path = pages.find((candidate) =>
            same(candidate.project_path),
        );
        if (by_project_path) return by_project_path;

        const by_sheet_path = pages.find((candidate) =>
            same(candidate.sheet_path),
        );
        if (by_sheet_path) return by_sheet_path;

        // Composite "filename:sheet_path" (Prism / semantic index project paths).
        if (requested.includes(":")) {
            const colon = requested.indexOf(":");
            const filename = requested.slice(0, colon);
            const sheet_path = requested.slice(colon + 1);
            const composite = pages.find(
                (candidate) =>
                    same(candidate.project_path) ||
                    (normalize(candidate.filename) === filename &&
                        normalize(candidate.sheet_path) === sheet_path) ||
                    (normalize(candidate.filename).endsWith(filename) &&
                        normalize(candidate.sheet_path) === sheet_path),
            );
            if (composite) return composite;
        }

        const by_label = pages.filter(
            (candidate) => same(candidate.name) || same(candidate.page),
        );
        if (by_label.length === 1) return by_label[0];

        // A sheet file may be instantiated more than once in the hierarchy.
        // A filename request is document-scoped, so every such instance has
        // the same paintable contents and native UUIDs. Prefer the active
        // instance when possible, then use project traversal order instead of
        // failing a valid cross-probe solely because the filename is reused.
        const by_filename = pages.filter(
            (candidate) =>
                same(candidate.filename) ||
                normalize(candidate.filename).endsWith(`/${requested}`) ||
                requested.endsWith(`/${normalize(candidate.filename)}`),
        );
        if (by_filename.length) {
            return (
                by_filename.find(
                    (candidate) =>
                        candidate.project_path ===
                        (project === this.#project
                            ? this.#active_schematic_project_path
                            : project.active_sch_name),
                ) ?? by_filename[0]
            );
        }

        // Human hierarchy paths are not native KiCad sheet-instance UUID
        // paths. Match their final named segment only when it is unique; the
        // native filename remains the preferred unambiguous identity.
        const label = requested.split("/").filter(Boolean).at(-1);
        const by_hierarchy_label = label
            ? pages.filter(
                  (candidate) =>
                      normalize(candidate.name ?? "") === label ||
                      normalize(candidate.page ?? "") === label,
              )
            : [];
        return by_hierarchy_label.length === 1
            ? by_hierarchy_label[0]
            : undefined;
    }

    #resolve_schematic_page(pageId: string) {
        return this.#resolve_schematic_page_in(this.#project, pageId);
    }

    #find_schematic_page_for_symbol(
        designator?: string,
        uuid?: string,
    ): { page: ProjectPage; uuid: string } | null {
        if (!designator && !uuid) return null;
        if (uuid) {
            const net_ref = this.#project.find_net_item(uuid);
            if (net_ref?.sheet_name) {
                const page = this.#resolve_schematic_page(net_ref.sheet_name);
                if (page) return { page, uuid: net_ref.uuid || uuid };
            }
        }
        for (const page of this.#project.pages) {
            const document = page.document;
            if (!(document instanceof KicadSch)) continue;
            const context = page.schematic_context;
            if (designator) {
                const by_ref = context?.find_symbol(designator);
                if (by_ref?.uuid && (!uuid || by_ref.uuid === uuid)) {
                    return { page, uuid: by_ref.uuid };
                }
            } else if (uuid) {
                const by_uuid = context?.find_symbol(uuid);
                if (by_uuid?.uuid) return { page, uuid: by_uuid.uuid };
            }
        }
        return null;
    }

    /**
     * Switch the schematic view to a specific page and resolve once applied.
     * Awaits project readiness first. Uses the instance-tree page model.
     */
    public async showPage(pageId: string): Promise<void> {
        this.#trace_transition("page.show.request", {
            status: "start",
            requestedPage: pageId,
        });
        this.#desired_page = pageId;
        try {
            await this.ready;
            await this.#apply_desired_page();
            this.#trace_transition("page.show.complete", {
                status: "ready",
                requestedPage: pageId,
                resolvedPage: this.#page_trace(this.#active_schematic_page()),
            });
        } catch (error) {
            this.#trace_transition("page.show.failed", {
                status: "error",
                requestedPage: pageId,
                detail: {
                    error:
                        error instanceof Error
                            ? { name: error.name, message: error.message }
                            : String(error),
                    availablePages: this.#project.pages.map((page) => ({
                        projectPath: page.project_path,
                        sheetPath: page.sheet_path,
                        filename: page.filename,
                        name: page.name,
                        page: page.page,
                    })),
                },
            });
            throw error;
        }
    }

    async #apply_desired_page(): Promise<void> {
        const pageId = this.#desired_page;
        if (!pageId || !this.#schematic_app) return;
        if (/\.kicad_pcb$/i.test(pageId)) {
            throw new TypeError(`showPage cannot activate PCB path ${pageId}`);
        }
        const page = this.#resolve_schematic_page(pageId);
        if (!page) {
            throw new TypeError(`Could not resolve schematic page ${pageId}`);
        }
        if (this.#active_tab !== TabKind.sch && this.has_sch) {
            await this.#switchToTab(TabKind.sch);
        }
        this.#activate_schematic_page(page.project_path);
        // activate_sch only dispatches "change"; hosts must await the app
        // load so content_container is unhidden before they mark ready.
        if (page.document instanceof KicadSch) {
            await this.#schematic_app.load(page.document);
        }
    }

    /**
     * Switch to a specific schematic page (by filename or sheet path).
     * Synchronous path used by Prism today; also records the desired page for
     * post-load reconcile.
     */
    public switchPage(pageId: string): boolean {
        this.#desired_page = pageId;
        if (!this.#schematic_app) return false;
        const page = this.#resolve_schematic_page(pageId);
        if (!page) {
            console.warn(`switchPage: Could not find page with ID ${pageId}`);
            return false;
        }
        return this.#activate_schematic_page(page.project_path);
    }

    public navigateSchematicPage(direction: -1 | 1): boolean {
        const pages = this.#project.pages;
        if (!pages.length) return false;
        const current = this.#active_schematic_page();
        const index = pages.findIndex(
            (page) => page.project_path === current?.project_path,
        );
        const next =
            pages[
                ((index >= 0 ? index : 0) + direction + pages.length) %
                    pages.length
            ];
        return next ? this.#activate_schematic_page(next.project_path) : false;
    }

    public navigateSchematicParent(): boolean {
        const current = this.#active_schematic_page();
        if (!current?.parent_project_path) return false;
        const parent = this.#project.pages.find(
            (page) => page.project_path === current.parent_project_path,
        );
        return parent
            ? this.#activate_schematic_page(parent.project_path)
            : false;
    }

    #handle_host_keydown(event: KeyboardEvent) {
        if (!this.#host_active || !this.has_sch || event.defaultPrevented)
            return;
        if (document.querySelector('[role="dialog"][data-state="open"]'))
            return;
        const target = event.composedPath()[0];
        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
        )
            return;

        const direction =
            event.key === "[" || event.code === "BracketLeft"
                ? -1
                : event.key === "]" || event.code === "BracketRight"
                  ? 1
                  : null;
        if (direction) {
            if (this.navigateSchematicPage(direction)) event.preventDefault();
            return;
        }
        if (
            event.altKey &&
            (event.key === "Backspace" ||
                event.key === "Delete" ||
                event.code === "Backspace" ||
                event.code === "Delete") &&
            this.navigateSchematicParent()
        ) {
            event.preventDefault();
        }
    }

    public getActiveSchematicPage() {
        const page = this.#active_schematic_page();
        return page
            ? {
                  projectPath: page.project_path,
                  sheetPath: page.sheet_path,
                  filename: page.filename,
                  parentProjectPath: page.parent_project_path,
                  name: page.name,
                  page: page.page,
              }
            : null;
    }

    public getSchematicPages(): EcadSchematicPageState[] {
        // The project owns page activation; prefer its explicit active path so
        // host controls update synchronously, even while the canvas is loading
        // the new schematic document.
        const active =
            this.#project.active_sch_name ??
            this.#active_schematic_page()?.project_path;
        return schematic_page_states(this.#project).map((page) => ({
            ...page,
            active: page.projectPath === active,
        }));
    }

    public getPcbViewState(): EcadPcbViewState | null {
        try {
            return this.#safe_board_viewer()?.get_host_view_state() ?? null;
        } catch {
            // Board canvas may not have painted layers yet during early project
            // change events — treat as "not ready" instead of throwing.
            return null;
        }
    }

    /**
     * Routing summary for a board net (length, layers, track and via counts).
     * Resolves by net name first, then net code. `null` until the board has
     * loaded or when the net is not on it.
     */
    public getNetStatistics(ref: NetStatisticsRef): NetStatistics | null {
        const board = this.#safe_board_viewer()?.board;
        if (!board) return null;
        return net_statistics(board, ref);
    }

    public setPcbLayerVisibility(name: string, visible: boolean): boolean {
        const changed =
            this.#safe_board_viewer()?.set_host_layer_visibility(
                name,
                visible,
            ) ?? false;
        if (changed) this.#emit_view_state_change();
        return changed;
    }

    public setPcbLayerHighlight(name: string | null): boolean {
        const changed =
            this.#safe_board_viewer()?.set_host_layer_highlight(name) ?? false;
        if (changed) this.#emit_view_state_change();
        return changed;
    }

    public applyPcbLayerPreset(
        preset:
            | "front"
            | "back"
            | "copper"
            | "outer-copper"
            | "inner-copper"
            | "drawings"
            | "all"
            | "none",
    ): void {
        this.#safe_board_viewer()?.apply_host_layer_preset(preset);
        this.#emit_view_state_change();
    }

    public setPcbObjectOpacity(
        kind: "tracks" | "vias" | "pads" | "zones",
        opacity: number,
    ): void {
        this.#safe_board_viewer()?.set_host_object_opacity(kind, opacity);
        this.#emit_view_state_change();
    }

    public setPcbObjectVisibility(
        kind: EcadPcbObjectVisibilityKind,
        visible: boolean,
    ): void {
        this.#safe_board_viewer()?.set_host_object_visibility(kind, visible);
        this.#emit_view_state_change();
    }

    public setPcbTrackHighlight(enabled: boolean): void {
        this.#safe_board_viewer()?.set_host_track_highlight(enabled);
        this.#emit_view_state_change();
    }

    #emit_view_state_change() {
        this.dispatchEvent(
            new CustomEvent("ecad-viewer:view-state-change", {
                bubbles: false,
            }),
        );
    }

    #active_schematic_page() {
        const exact = this.#project.pages.find(
            (page) => page.project_path === this.#active_schematic_project_path,
        );
        if (exact) return exact;
        const filename = this.#safe_schematic_viewer()?.schematic?.filename;
        return this.#project.pages
            .filter((page) => !filename || page.filename === filename)
            .sort(
                (a, b) =>
                    a.sheet_path.split("/").filter(Boolean).length -
                    b.sheet_path.split("/").filter(Boolean).length,
            )[0];
    }

    #activate_schematic_page(project_path: string): boolean {
        const page = this.#project.pages.find(
            (candidate) => candidate.project_path === project_path,
        );
        const viewer = this.#safe_schematic_viewer();
        if (!page || !viewer || !(page.document instanceof KicadSch))
            return false;
        const context = page.schematic_context;
        if (context) viewer.set_instance_context(context);
        this.#active_schematic_project_path = page.project_path;
        this.#project.activate_sch(page.project_path);
        return true;
    }

    /**
     * Get screen coordinates from world coordinates
     */
    public getScreenLocation(
        x: number,
        y: number,
    ): { x: number; y: number } | null {
        const pos = new Vec2(x, y);

        const board_viewer = this.#safe_board_viewer();
        const schematic_viewer = this.#safe_schematic_viewer();
        const viewer =
            this.#active_tab === TabKind.pcb
                ? board_viewer
                : this.#active_tab === TabKind.sch
                  ? schematic_viewer
                  : (board_viewer ?? schematic_viewer);

        if (viewer?.viewport?.camera) {
            // Note: Camera2 uses snake_case world_to_screen
            const screenPos = viewer.viewport.camera.world_to_screen(pos);
            return { x: screenPos.x, y: screenPos.y };
        }
        return null;
    }

    public async exportImage(
        viewType: "SCH" | "PCB" | "3D" | "BOM" = this.#active_tab as
            | "SCH"
            | "PCB"
            | "3D"
            | "BOM",
    ): Promise<{ image: string; width: number; height: number } | null> {
        await this.loaded;

        const tabKind = this.#viewTypeToTabKind(viewType);
        const currentTab = this.#active_tab;
        const needSwitch = currentTab !== tabKind;

        if (needSwitch) {
            await this.#switchToTab(tabKind);
        }

        let result: { image: string; width: number; height: number } | null =
            null;

        switch (viewType) {
            case "PCB": {
                const boardViewer = this.#board_app?.viewer;
                if (boardViewer?.canvas) {
                    const canvas = boardViewer.canvas as HTMLCanvasElement;

                    if (canvas.width === 0 || canvas.height === 0) {
                        return null;
                    }

                    if (typeof boardViewer.draw === "function") {
                        boardViewer.draw();
                    }

                    await new Promise((resolve) =>
                        requestAnimationFrame(resolve),
                    );

                    result = {
                        image: canvas.toDataURL("image/png"),
                        width: canvas.width,
                        height: canvas.height,
                    };
                }
                break;
            }
            case "SCH": {
                const schematicApp = this.#schematic_app;
                const schViewer = schematicApp?.viewer;
                if (schematicApp && schViewer?.canvas) {
                    const schematics = Array.from(
                        this.#project?.schematics() || [],
                    );

                    if (schematics.length > 1) {
                        const images: Array<{
                            image: string;
                            width: number;
                            height: number;
                            name: string;
                        }> = [];
                        const originalSheet = (schViewer as any).sch_name;

                        for (const sch of schematics) {
                            if (sch instanceof KicadSch) {
                                await schematicApp.viewer.load(sch);
                                await new Promise((resolve) =>
                                    requestAnimationFrame(resolve),
                                );

                                const canvas =
                                    schViewer.canvas as HTMLCanvasElement;
                                images.push({
                                    image: canvas.toDataURL("image/png"),
                                    width: canvas.width,
                                    height: canvas.height,
                                    name: sch.filename,
                                });
                            }
                        }

                        if (originalSheet) {
                            const originalSch =
                                this.#project.file_by_name(originalSheet);
                            if (originalSch instanceof KicadSch) {
                                await schematicApp.viewer.load(originalSch);
                            }
                        }

                        result = {
                            image: JSON.stringify(images),
                            width: 0,
                            height: 0,
                        };
                    } else {
                        const canvas = schViewer.canvas as HTMLCanvasElement;
                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
            case "3D": {
                const viewer3d = this.#ov_d_app;
                if (viewer3d?._viewer_container) {
                    const renderer = viewer3d._viewer_container.renderer;
                    if (renderer) {
                        renderer.render(
                            viewer3d._viewer_container.scene,
                            viewer3d._viewer_container.activeCamera,
                        );

                        const canvas = renderer.domElement;
                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
            case "BOM": {
                const bomItems = this.#project?.bom_items;
                if (bomItems && bomItems.length > 0) {
                    const padding = 20;
                    const rowHeight = 28;
                    const headerHeight = 32;
                    const colWidths = [50, 140, 350, 160, 200, 70];
                    const totalWidth =
                        colWidths.reduce((a, b) => a + b, 0) + padding * 2;
                    const totalHeight =
                        headerHeight +
                        (bomItems.length + 1) * rowHeight +
                        padding * 2;

                    const canvas = document.createElement("canvas");
                    const dpr = window.devicePixelRatio || 1;
                    canvas.width = totalWidth * dpr;
                    canvas.height = totalHeight * dpr;
                    const ctx = canvas.getContext("2d");

                    if (ctx) {
                        ctx.scale(dpr, dpr);

                        ctx.fillStyle = "#ffffff";
                        ctx.fillRect(0, 0, totalWidth, totalHeight);

                        ctx.fillStyle = "#666";
                        ctx.fillRect(
                            padding,
                            padding,
                            totalWidth - padding * 2,
                            headerHeight,
                        );

                        ctx.fillStyle = "#ffffff";
                        ctx.font = "bold 12px sans-serif";
                        ctx.textAlign = "left";
                        ctx.textBaseline = "middle";

                        const headers = [
                            "No",
                            "Value",
                            "Description",
                            "Footprint",
                            "Designator",
                            "Quantity",
                        ];
                        let x = padding + 8;
                        headers.forEach((header, index) => {
                            ctx.fillText(header, x, padding + headerHeight / 2);
                            x += colWidths[index] ?? 0;
                        });

                        ctx.fillStyle = "#333";
                        ctx.font = "11px sans-serif";
                        ctx.textAlign = "left";
                        ctx.textBaseline = "middle";

                        let y = padding + headerHeight;
                        bomItems.forEach((item, index) => {
                            if (index % 2 === 0) {
                                ctx.fillStyle = "#f9f9f9";
                                ctx.fillRect(
                                    padding,
                                    y,
                                    totalWidth - padding * 2,
                                    rowHeight,
                                );
                            }

                            ctx.fillStyle = "#333";
                            let x = padding + 8;

                            ctx.fillText(
                                String(index + 1),
                                x,
                                y + rowHeight / 2,
                            );
                            x += colWidths[0] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[1] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(item.Name || "", x, y + rowHeight / 2);
                            ctx.restore();
                            x += colWidths[1] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[2] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Description || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[2] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[3] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Footprint || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[3] ?? 0;

                            ctx.save();
                            ctx.beginPath();
                            ctx.rect(x - 8, y, colWidths[4] ?? 0, rowHeight);
                            ctx.clip();
                            ctx.fillText(
                                item.Reference || "",
                                x,
                                y + rowHeight / 2,
                            );
                            ctx.restore();
                            x += colWidths[4] ?? 0;

                            ctx.fillText(
                                String(item.Qty),
                                x,
                                y + rowHeight / 2,
                            );

                            y += rowHeight;
                        });

                        const totalQty = bomItems.reduce(
                            (sum, item) => sum + item.Qty,
                            0,
                        );
                        ctx.fillStyle = "#666";
                        ctx.fillRect(
                            padding,
                            y,
                            totalWidth - padding * 2,
                            rowHeight,
                        );
                        ctx.fillStyle = "#ffffff";
                        ctx.font = "bold 12px sans-serif";
                        ctx.textAlign = "right";
                        ctx.fillText(
                            `Total: ${totalQty} Price: N/A`,
                            totalWidth - padding - 8,
                            y + rowHeight / 2,
                        );

                        result = {
                            image: canvas.toDataURL("image/png"),
                            width: canvas.width,
                            height: canvas.height,
                        };
                    }
                }
                break;
            }
        }

        if (needSwitch && currentTab !== tabKind) {
            await this.#switchToTab(currentTab);
        }

        return result;
    }

    #viewTypeToTabKind(viewType: "SCH" | "PCB" | "3D" | "BOM"): TabKind {
        switch (viewType) {
            case "PCB":
                return TabKind.pcb;
            case "SCH":
                return TabKind.sch;
            case "3D":
                return TabKind.step;
            case "BOM":
                return TabKind.bom;
            default:
                return TabKind.pcb;
        }
    }

    async #switchToTab(tabKind: TabKind): Promise<void> {
        if (this.#active_tab === tabKind && this.#tab_contents[tabKind]) {
            this.#activate_tab_content(tabKind);
            return;
        }

        // Prefer direct activation so headless hosts (show-header=false) do not
        // depend on clicking hidden tab-header buttons.
        if (this.#tab_contents[tabKind]) {
            this.#activate_tab_content(tabKind);
            this.#user_selected_tab = true;
            this.#initial_tab_set = true;
            return;
        }

        const tabButtons =
            this.#tab_header?.shadowRoot?.querySelectorAll("tab-button");
        if (tabButtons) {
            tabButtons.forEach((btn) => {
                if (btn.textContent?.trim().toUpperCase() === tabKind) {
                    (btn as HTMLElement).click();
                }
            });
        }

        const deadline = Date.now() + 2000;
        await new Promise<void>((resolve, reject) => {
            const checkTab = () => {
                if (this.#active_tab === tabKind) {
                    resolve();
                    return;
                }
                if (Date.now() >= deadline) {
                    reject(
                        new Error(
                            `Timed out switching ecad-viewer tab to ${tabKind}`,
                        ),
                    );
                    return;
                }
                setTimeout(checkTab, 50);
            };
            setTimeout(checkTab, 50);
        });
    }

    override initialContentCallback() {
        this.#setup_events();
        // Prism supplies immutable in-memory sources through replaceSources().
        // Do not race that transaction with the legacy window/child-source
        // auto-loader, which otherwise performs a second empty project render.
        if (this.getAttribute("source-mode") === "host") {
            return;
        }
        later(() => {
            this.#visible_ready = Promise.resolve(this.load_src()).then(
                () => undefined,
            );
        });
    }

    async #setup_events() {
        this.addDisposable(
            listen(document, "visibilitychange", () => {
                if (document.hidden) this.#cancel_diff_animation();
                else this.#restart_diff_animation();
            }),
        );
        // Listen for ZIP blob received via postMessage
        this.addDisposable(
            listen(window, LoadZipEvent.type, async (event) => {
                await this.load_zip((event as LoadZipEvent).detail);
            }),
        );

        this.addDisposable(
            listen(window, ImageExportRequestEvent.type, async (e) => {
                const event = e as ImageExportRequestEvent;
                let viewType: "SCH" | "PCB" | "3D" | "BOM" = this
                    .#active_tab as "SCH" | "PCB" | "3D" | "BOM";

                if (typeof event.detail === "string") {
                    viewType = event.detail as "SCH" | "PCB" | "3D" | "BOM";
                } else if (
                    event.detail &&
                    typeof event.detail === "object" &&
                    "viewType" in event.detail &&
                    event.detail.viewType
                ) {
                    viewType = event.detail.viewType;
                }

                const result = await this.exportImage(viewType);
                if (result) {
                    window.parent.postMessage(
                        {
                            type: ImageExportResultEvent.type,
                            detail: {
                                viewType: viewType,
                                imageData: result.image,
                                width: result.width,
                                height: result.height,
                                timestamp: Date.now(),
                            },
                        },
                        "*",
                    );
                }
            }),
        );
    }

    async load_zip(file: Blob) {
        // Dispose current project (queueing: newest wins)
        this.#project.reset();

        try {
            const files = await ZipUtils.unzipFile(file);
            const readFilePromises = Array.from(files).map((file) =>
                this.readFile(file),
            );

            const blobs: EcadBlob[] = [];

            const results = await Promise.all(readFilePromises);

            let idx = -1;
            results.forEach(({ name, content }) => {
                idx = idx + 1;
                const names = name.split("/");
                name = names[names.length - 1]!;

                if (is_kicad(name)) {
                    blobs.push({ filename: name, content });
                } else if (is_3d_model(name)) {
                    this.#project.ov_3d_url = URL.createObjectURL(files[idx]!);
                }
            });

            await this.#setup_project({ urls: [], blobs });
        } catch (error) {
            console.error("Error while loading ZIP:", error);
            // Dispatch error event for iframe bridge to handle
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error while loading ZIP";
            window.dispatchEvent(new LoadZipErrorEvent(errorMessage));
        }
    }

    private readFile(file: File): Promise<{ name: string; content: string }> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) =>
                resolve({
                    name: file.name,
                    content: e.target!.result as string,
                });
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
        });
    }

    async load_window_zip_url(url: string) {
        return this.load_zip(await (await fetch(url)).blob());
    }

    async load_src() {
        console.log(
            "[ECadViewer] load_src() called, design_urls:",
            window.design_urls,
        );
        if (window.zip_url) {
            return this.load_window_zip_url(window.zip_url);
        }
        if (window.design_urls) {
            const extract_zip_blobs = async (
                url: string,
                label: string,
            ): Promise<EcadBlob[]> => {
                console.log("[ECadViewer] Loading", label + ":", url);
                const blob = await (await fetch(url)).blob();
                const files = await ZipUtils.unzipFile(blob);
                const readFilePromises = Array.from(files).map((file) =>
                    this.readFile(file),
                );
                const results = await Promise.all(readFilePromises);
                const blobs: EcadBlob[] = [];
                let idx = -1;
                results.forEach(({ name, content }) => {
                    idx = idx + 1;
                    const names = name.split("/");
                    name = names[names.length - 1]!;
                    if (is_kicad(name)) {
                        blobs.push({ filename: name, content });
                    } else if (is_3d_model(name)) {
                        this.#project.ov_3d_url = URL.createObjectURL(
                            files[idx]!,
                        );
                        console.log(
                            "[ECadViewer] 3D model found in zip:",
                            name,
                        );
                    }
                });
                console.log(
                    "[ECadViewer]",
                    label,
                    "loaded,",
                    blobs.length,
                    "kicad files",
                );
                return blobs;
            };

            let initial_loaded = false;

            if (window.design_urls.sch_url) {
                const sch_blobs = await extract_zip_blobs(
                    window.design_urls.sch_url,
                    "SCH",
                );
                await this.#setup_project({ urls: [], blobs: sch_blobs });
                initial_loaded = true;
            }

            if (window.design_urls.pcb_url) {
                const pcb_blobs = await extract_zip_blobs(
                    window.design_urls.pcb_url,
                    "PCB",
                );
                if (!initial_loaded) {
                    await this.#setup_project({ urls: [], blobs: pcb_blobs });
                    initial_loaded = true;
                } else {
                    await this.#add_files_to_project(pcb_blobs);
                }
            }

            if (window.design_urls.glb_url) {
                const glb_blobs = await extract_zip_blobs(
                    window.design_urls.glb_url,
                    "GLB",
                );
                if (!initial_loaded) {
                    await this.#setup_project({ urls: [], blobs: glb_blobs });
                    initial_loaded = true;
                } else if (glb_blobs.length > 0) {
                    await this.#add_files_to_project(glb_blobs);
                }
                if (this.#project.ov_3d_url) {
                    console.log(
                        "[ECadViewer] GLB URL ready, dispatching Online3dViewerUrlReady",
                    );
                    window.dispatchEvent(
                        new Online3dViewerUrlReady(this.#project.ov_3d_url),
                    );
                }
            }

            return;
        }

        const urls = [];
        const blobs: EcadBlob[] = [];

        for (const src_elm of this.querySelectorAll<EcadSourceElement>(
            "ecad-source",
        )) {
            if (src_elm.src) {
                urls.push(src_elm.src);
            }
        }

        for (const blob_elm of this.querySelectorAll<EcadBlobElement>(
            "ecad-blob",
        )) {
            blobs.push({
                filename: blob_elm.filename,
                content: blob_elm.content,
            });
        }

        for (const src of this.querySelectorAll<Ov3dElement>(
            "ecad-3d-source",
        )) {
            if (src.src) {
                this.#project.ov_3d_url = src.src;
                break;
            }
        }

        await this.#setup_project({ urls, blobs });
    }

    async #settle_project_apps(preferredPage?: string): Promise<void> {
        const loads: Promise<unknown>[] = [];
        if (this.has_sch && this.#schematic_app) {
            const page =
                (preferredPage
                    ? this.#resolve_schematic_page(preferredPage)
                    : undefined) ??
                this.#project.root_schematic_page ??
                this.#project.pages[0];
            if (page?.document instanceof KicadSch) {
                this.#active_schematic_project_path = page.project_path;
                this.#desired_page = page.project_path;
                this.#project.active_sch_name = page.project_path;
                loads.push(this.#schematic_app.load(page.document));
            }
        } else {
            this.#active_schematic_project_path = null;
        }
        if (this.has_pcb && this.#board_app) {
            const board = this.#project.get_first_page(AssertType.PCB);
            if (board instanceof KicadPCB) {
                loads.push(this.#board_app.load(board));
            }
        }
        await Promise.all(loads);
        // Apply the requested variant before the ready notification so the
        // first visible scene of a new revision is already the right one.
        this.#apply_variant_request();
        // Notify panels and any secondary consumers after the authoritative
        // awaited loads. Same-document app loads are a fast reveal-only path.
        this.#project.on_loaded();
        await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
        );
        const viewer = this.#active_inner_viewer();
        viewer?.renderer?.update_canvas_size?.();
        viewer?.viewport?.sync_from_canvas?.();
        viewer?.draw_now?.() ?? viewer?.draw?.();
    }

    async #setup_project(sources: EcadSources) {
        console.log(
            "[ECadViewer] #setup_project() called, has_sch:",
            this.has_sch,
            "has_pcb:",
            this.has_pcb,
        );
        this.loaded = false;
        this.loading = true;

        try {
            await this.#project.load(sources);

            this.loaded = true;
            console.log(
                "[ECadViewer] Project loaded, has_sch:",
                this.has_sch,
                "has_pcb:",
                this.has_pcb,
                "active_tab:",
                this.#active_tab,
            );
            await this.update();
            await this.#settle_project_apps(this.#desired_page);
            this.#ensure_camera_hook(this.#safe_board_viewer());
            this.#ensure_camera_hook(this.#safe_schematic_viewer());
            // Post-load autofit / first paint should notify camera consumers.
            this.#emit_camera_change();
        } catch (error) {
            console.error(
                "[ECadViewer] Error while setting up project:",
                error,
            );
            // Dispatch error event for iframe bridge to handle
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error while setting up project";
            window.dispatchEvent(new LoadZipErrorEvent(errorMessage));
        } finally {
            this.loading = false;
        }
    }

    async #add_files_to_project(blobs: EcadBlob[]) {
        console.log(
            "[ECadViewer] #add_files_to_project() called, adding",
            blobs.length,
            "files",
        );
        this.loading = true;
        // Snapshot before the load: `Project.load` replaces `settings`
        // wholesale, so afterwards there is nothing left to compare against.
        const text_vars_before = this.#text_vars_snapshot();
        try {
            await this.#project.load({ urls: [], blobs });
            console.log(
                "[ECadViewer] Files added, has_sch:",
                this.has_sch,
                "has_pcb:",
                this.has_pcb,
            );
            // Notify existing viewers of the updated project without re-rendering
            this.#project.on_loaded();
            if (
                blobs.some((blob) => blob.filename.endsWith(".kicad_pro")) &&
                this.#text_vars_changed(text_vars_before)
            ) {
                this.#repaint_for_new_project_settings();
            }
            // A late board or schematic can change the catalog; replay the
            // selection so a requested name is validated against it.
            this.#apply_variant_request();
        } catch (error) {
            console.error(
                "[ECadViewer] Error while adding files to project:",
                error,
            );
        } finally {
            this.loading = false;
        }
    }

    /**
     * Repaint the mounted documents after project settings arrive late.
     *
     * A host need not have every file at once: Prism paints the root sheet
     * first and appends the `.kicad_pro` when it arrives. Text variables are
     * resolved during painting, so a document painted before its project had
     * settings drew `${VAR}` verbatim -- and kept drawing it, because adding
     * files deliberately does not re-render and re-issuing the same document
     * to a DocumentViewer returns early. Only navigating away and back forced
     * the repaint that made the values appear.
     *
     * Documents hold a reference to the project rather than a copy of its
     * variables, so repainting is all that is needed. Both viewers are
     * repainted: a board consults the project before falling back to the
     * `(property ...)` copy KiCad writes into it, so it is stale in the same
     * way whenever the two disagree, or shows nothing at all when the board
     * carries no copy.
     *
     * Only a `.kicad_pro` triggers this, and only when it actually changed the
     * project's text variables. Subsheets arrive on the same path and are far
     * more numerous; repainting for each would rebuild the scene once per
     * sheet on every load. The variables check matters just as much: most
     * designs define none, and repainting for a project file that could not
     * have changed anything cost about two seconds on a large board.
     */
    /**
     * The project's text variables, flattened to a comparable string.
     *
     * Sorted so key order cannot make an unchanged map look changed --
     * `ProjectSettings.load` rebuilds the object from JSON on every append, so
     * the map is a different object each time even when its contents are
     * identical.
     */
    #text_vars_snapshot(): string {
        const vars = this.#project.settings.text_variables ?? {};
        return JSON.stringify(
            Object.keys(vars)
                .sort()
                .map((k) => [k, vars[k]]),
        );
    }

    #text_vars_changed(before: string): boolean {
        return this.#text_vars_snapshot() !== before;
    }

    #repaint_for_new_project_settings() {
        for (const viewer of [
            this.#safe_schematic_viewer(),
            this.#safe_board_viewer(),
        ]) {
            if (!viewer?.document) continue;
            try {
                viewer.paint();
                viewer.draw();
            } catch (error) {
                // A repaint is a correction, not the operation the caller
                // asked for; failing it must not fail the append.
                console.error(
                    "[ECadViewer] Could not repaint for settings",
                    error,
                );
            }
        }
    }

    #safe_board_viewer(): BoardViewer | null {
        try {
            return (this.#board_app?.viewer as BoardViewer | undefined) ?? null;
        } catch {
            return null;
        }
    }

    #safe_schematic_viewer(): SchematicViewer | null {
        try {
            return (
                (this.#schematic_app?.viewer as SchematicViewer | undefined) ??
                null
            );
        } catch {
            return null;
        }
    }

    #viewer_for_context(context: "SCH" | "PCB") {
        return context === "SCH"
            ? this.#safe_schematic_viewer()
            : this.#safe_board_viewer();
    }

    #apply_viewer_activity() {
        const board_active =
            this.#host_active &&
            (this.#active_tab === TabKind.pcb || !this.has_sch);
        const schematic_active =
            this.#host_active &&
            (this.#active_tab === TabKind.sch || !this.has_pcb);
        this.#safe_board_viewer()?.set_active(board_active);
        this.#safe_schematic_viewer()?.set_active(schematic_active);
    }

    #restore_comment_overlay_scenes() {
        for (const scene of this.#comment_overlay_scenes.values()) {
            this.#viewer_for_context(scene.context)?.set_overlay_scene(scene);
        }
    }

    #relay_board_selection(event: Event) {
        event.stopPropagation();
        const select = event as KiCanvasSelectEvent;
        const item = select.detail.item;
        // A click on empty canvas: tell the host so it can deselect, rather than
        // swallowing it and leaving the previous selection stuck.
        if (!item) {
            this.dispatchEvent(
                new EcadSemanticSelectionEvent({
                    sourceContext: "PCB",
                    itemType: "",
                }),
            );
            return;
        }
        const viewer = this.#safe_board_viewer();
        const board = viewer?.board;
        if (!board) return;
        let detail = normalize_board_selection(item, board);
        if (!detail) return;
        this.#attach_item_bounds_pcb(detail, item, viewer!);
        detail.operation = select.detail.operation ?? "replace";
        if (select.detail.modifiers) detail.modifiers = select.detail.modifiers;
        const intent = select.detail.intent ?? "select";
        if (intent === "crossprobe") {
            detail = promote_pad_to_net_detail(detail);
            this.dispatchEvent(new EcadCrossProbeEvent(detail));
            // The viewer already replaced its set with this net.
            this.#emit_highlight_change("crossprobe");
            return;
        }
        // Without a host the element is the only owner of the set, so a
        // shift-click toggles here. A host (source-mode="host") owns it and
        // answers the relayed gesture with setHighlightedNets().
        if (
            detail.operation === "toggle" &&
            detail.netCode &&
            !this.#host_owns_highlights()
        ) {
            viewer!.toggle_highlighted_net(detail.netCode);
            this.#emit_highlight_change("gesture");
        }
        this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
    }

    #host_owns_highlights(): boolean {
        return this.getAttribute("source-mode") === "host";
    }

    #relay_schematic_selection(event: Event) {
        event.stopPropagation();
        const select = event as KiCanvasSelectEvent;
        const item = select.detail.item;
        // A click on empty canvas: tell the host so it can deselect, rather than
        // swallowing it and leaving the previous selection stuck.
        if (!item) {
            this.dispatchEvent(
                new EcadSemanticSelectionEvent({
                    sourceContext: "SCH",
                    itemType: "",
                }),
            );
            return;
        }
        const viewer = this.#safe_schematic_viewer();
        const schematic = viewer?.schematic;
        if (!schematic) return;
        const detail = normalize_schematic_selection(
            item,
            schematic,
            viewer?.instance_context,
        );
        if (!detail) return;
        this.#attach_item_bounds_sch(detail, item, viewer!);
        detail.operation = select.detail.operation ?? "replace";
        if (select.detail.modifiers) detail.modifiers = select.detail.modifiers;
        const intent = select.detail.intent ?? "select";
        if (intent === "crossprobe") {
            this.dispatchEvent(new EcadCrossProbeEvent(detail));
            return;
        }
        this.dispatchEvent(new EcadSemanticSelectionEvent(detail));
    }

    /** Best-effort item bbox lookup for the given world coordinate systems. */
    static #item_bbox(item: unknown): BBox | undefined {
        if (
            item &&
            typeof item === "object" &&
            "bbox" in item &&
            (item as { bbox?: unknown }).bbox instanceof BBox
        ) {
            return (item as { bbox: BBox }).bbox;
        }
        return undefined;
    }

    #attach_item_bounds_sch(
        detail: EcadSemanticSelectionDetail,
        item: unknown,
        viewer: SchematicViewer,
    ) {
        let bbox = ECadViewer.#item_bbox(item);
        if (!bbox && detail.uuid) {
            bbox = viewer.schematic_renderer.get_item_bbox(detail.uuid);
        }
        ECadViewer.#apply_bounds(detail, bbox);
    }

    #attach_item_bounds_pcb(
        detail: EcadSemanticSelectionDetail,
        item: unknown,
        viewer: BoardViewer,
    ) {
        let bbox = ECadViewer.#item_bbox(item);
        if (!bbox && detail.uuid) {
            bbox = viewer.overlay_item_bounds(detail.uuid);
        }
        if (!bbox && detail.reference) {
            bbox = viewer.board.find_footprint(detail.reference)?.bbox;
        }
        ECadViewer.#apply_bounds(detail, bbox);
    }

    static #apply_bounds(
        detail: EcadSemanticSelectionDetail,
        bbox: BBox | undefined,
    ) {
        if (!bbox) return;
        detail.x = bbox.center.x;
        detail.y = bbox.center.y;
        detail.bounds = [bbox.x, bbox.y, bbox.w, bbox.h];
    }

    #relay_comment_overlay_click(event: Event): void {
        event.stopPropagation();
        const hit = (event as EcadOverlayClickEvent).detail;
        const expected = COMMENT_OVERLAY_CHANNELS[hit.context];
        if (hit.channelId !== expected) return;
        const detail: EcadCommentOverlayHitDetail = {
            commentId: comment_id_from_primitive(hit.primitiveId),
            context: hit.context,
            x: hit.resolvedAnchor.x,
            y: hit.resolvedAnchor.y,
            bounds: hit.resolvedAnchor.bounds,
            page: hit.resolvedAnchor.page,
            metadata: hit.metadata,
        };
        this.dispatchEvent(new EcadCommentOverlayClickEvent(detail));
    }

    #relay_comment_area_event(event: Event) {
        event.stopPropagation();
        const detail = { ...(event as EcadCommentAreaEvent).detail };
        if (detail.context === "SCH" && !detail.page) {
            detail.page = this.#safe_schematic_viewer()?.schematic?.filename;
        }
        this.dispatchEvent(new EcadCommentAreaEvent(detail));
    }

    #apply_schematic_cross_probe(
        request: EcadCrossProbeRequest,
        value: string,
    ): boolean {
        const viewer = this.#safe_schematic_viewer();
        if (!viewer) return false;

        const probe_gen = ++this.#probe_generation;

        let sheet = request.sheet ?? request.page;
        // Semantic indexes sometimes use "/" as a root sentinel — that is not
        // a loadable schematic filename. PCB anchors must never be treated as
        // schematic pages (host used to pass "board.kicad_pcb").
        if (
            sheet === "/" ||
            sheet === "" ||
            (sheet != null && /\.kicad_pcb$/i.test(sheet))
        ) {
            sheet = undefined;
        }
        let uuid = request.uuid ?? request.uuids?.[0];
        if (request.kind === "net") {
            const net_name = request.net ?? value;
            const bare = net_name.includes("/")
                ? net_name.split("/").filter(Boolean).at(-1)
                : undefined;
            const name_candidates = [net_name, bare].filter(
                (name): name is string => Boolean(name),
            );
            let refs: NetRef[] = [];
            for (const name of name_candidates) {
                refs = this.#project.find_labels_by_name(name) ?? [];
                if (refs.length) break;
            }
            // Deterministic: prefer requested sheet, else first by sheet name.
            const preferred = sheet;
            const sorted = [...refs].sort((a, b) =>
                (a.sheet_name || "").localeCompare(b.sheet_name || ""),
            );
            const ref =
                (preferred
                    ? sorted.find((entry) => entry.sheet_name === preferred)
                    : undefined) ?? sorted[0];
            sheet ??= ref?.sheet_name;
            if (
                sheet === "/" ||
                sheet === "" ||
                (sheet != null && /\.kicad_pcb$/i.test(sheet))
            ) {
                sheet = undefined;
            }
            uuid ??= ref?.uuid;
            // Fall back to any provided wire/label uuid list from the host.
            uuid ??= request.uuids?.find(Boolean);
        } else if (!uuid) {
            const located = this.#find_schematic_page_for_symbol(
                request.designator ?? value,
            );
            if (located) {
                sheet ??= located.page.project_path;
                uuid = located.uuid;
            }
        }
        if (!uuid && !request.designator && !value) {
            return false;
        }

        const focus = (target_uuid: string): boolean => {
            const candidates = [
                target_uuid,
                ...(request.uuids ?? []).filter(
                    (id) => id && id !== target_uuid,
                ),
            ];
            if (request.designator) {
                const by_ref = viewer.instance_context?.find_symbol(
                    request.designator,
                );
                if (by_ref?.uuid) candidates.push(by_ref.uuid);
            }
            for (const id of candidates) {
                const bbox = viewer.schematic_renderer.get_item_bbox(id);
                if (bbox) {
                    viewer.zoom_fit_item(id);
                    return true;
                }
            }
            return false;
        };

        // Resolve the hierarchical instance page. Filename equality with the
        // currently loaded document is not enough — the same .kicad_sch can be
        // instantiated multiple times.
        let page = sheet ? this.#resolve_schematic_page(sheet) : undefined;
        if (!page) {
            const located = this.#find_schematic_page_for_symbol(
                request.designator ?? value,
                uuid,
            );
            if (located) {
                page = located.page;
                uuid = located.uuid;
            }
        } else if (!uuid) {
            const located = this.#find_schematic_page_for_symbol(
                request.designator ?? value,
                undefined,
            );
            if (located) uuid = located.uuid;
        }

        if (!uuid) {
            return false;
        }

        if (page) {
            const active_path = this.#active_schematic_project_path;
            if (page.project_path !== active_path) {
                this.#activate_schematic_page(page.project_path);
            }
            const target =
                page.document instanceof KicadSch ? page.document : null;
            if (target) {
                // Prefer the viewer's post-load focus hook — bbox maps are not
                // always ready in the same turn as load() resolves.
                viewer.focus_net_item = uuid;
                void viewer.load(target).then(() => {
                    if (probe_gen !== this.#probe_generation) return;
                    focus(uuid!);
                });
                return true;
            }
        }

        focus(uuid);
        return true;
    }
    get has_3d() {
        return this.#project.has_boards || this.#project.has_3d;
    }
    get has_pcb() {
        return this.#project.has_boards;
    }
    get has_sch() {
        return this.#project.has_schematics;
    }

    get sch_count() {
        return length(this.#project.schematics());
    }
    get has_bom() {
        return this.has_pcb || this.has_sch;
    }
    on_full_windows() {
        if (window.is_module_lib) {
            console.log("is_module_lib " + window.is_module_lib);
            return show_ecad_viewer();
        }

        if (!this.#is_full_screen) {
            window.document.documentElement.requestFullscreen();
            this.#is_full_screen = true;
        } else {
            window.document.exitFullscreen();
            this.#is_full_screen = false;
        }
        if (this.#ov_d_app) this.#ov_d_app.on_show();
    }

    override render() {
        this.#file_input = html` <input
            type="file"
            id="fileInput"
            style="display: none"
            multiple />` as HTMLInputElement;
        this.#spinner = html`<ecad-spinner></ecad-spinner>` as HTMLElement;
        if (!this.loaded) return this.#spinner;
        this.#spinner.hidden = true;
        this.#tab_contents = {};
        // Drop stale apps from a previous project shape so SCH-only and PCB-only
        // loads never keep both canvases stacked in .vertical.
        if (!this.has_pcb) this.#board_app = undefined;
        if (!this.has_sch) this.#schematic_app = undefined;
        if (!this.has_3d) this.#step_viewer_placeholder = undefined;
        if (!this.has_bom) this.#bom_app = undefined;

        this.#tab_header = new TabHeaderElement({
            has_3d: this.has_3d,
            has_pcb: this.has_pcb,
            sch_count: this.sch_count,
            has_bom: this.has_bom,
            active_tab: this.#user_selected_tab ? this.#active_tab : undefined,
        });

        if (window.hide_header || !this.showHeader) {
            this.#tab_header.hidden = true;
        }

        this.#tab_header.input_container = this;
        this.#tab_header.addEventListener(TabActivateEvent.type, (event) => {
            const tab = (event as TabActivateEvent).detail;
            console.log(
                "[ECadViewer] TabActivateEvent received: previous=",
                tab.previous,
                "current=",
                tab.current,
                "userInitiated=",
                tab.userInitiated,
                "initial_tab_set=",
                this.#initial_tab_set,
            );
            if (tab.userInitiated) {
                this.#user_selected_tab = true;
                this.#initial_tab_set = true;
            } else if (!this.#initial_tab_set) {
                this.#initial_tab_set = true;
                this.#user_selected_tab = true;
                console.log(
                    "[ECadViewer] First automatic tab activation recorded - future renders will preserve tab:",
                    tab.current,
                );
            }
            this.#active_tab = tab.current;
            this.dispatchEvent(new TabActivateEvent(tab));
            if (tab.previous) {
                switch (tab.previous) {
                    case TabKind.pcb:
                        if (this.#board_app)
                            this.#board_app.tabMenuHidden = true;
                        break;
                    case TabKind.sch:
                        if (this.#schematic_app)
                            this.#schematic_app.tabMenuHidden = true;
                        break;
                    case TabKind.bom:
                        break;
                    case TabKind.step:
                        break;
                }
            }

            Object.values(this.#tab_contents).forEach((i) => {
                i.classList.remove("active");
            });
            this.#tab_contents[tab.current]?.classList.add("active");
            this.#apply_viewer_activity();
            this.#ensure_camera_hook(this.#safe_board_viewer());
            this.#ensure_camera_hook(this.#safe_schematic_viewer());
            this.#emit_camera_change();

            if (tab.current === TabKind.step) {
                if (this.#ov_d_app) {
                    // Only resize if the viewer is actually visible (model loaded)
                    if (this.#ov_d_app.style.display !== "none") {
                        this.#ov_d_app.on_show();
                    }
                } else {
                    (async () => {
                        // Resolved by the host import map. Keeping this
                        // non-literal also lets browser-unit transforms load
                        // the custom element without bundling the optional 3D app.
                        const onlineViewerModule =
                            (
                                window as Window & {
                                    ecad3dModuleName?: string;
                                }
                            ).ecad3dModuleName ?? "3d-viewer";
                        await import(onlineViewerModule);
                        const onlineViewer =
                            html`<ecad-3d-viewer></ecad-3d-viewer>` as Online3dViewer;
                        this.#ov_d_app = onlineViewer;
                        this.#viewers_container.appendChild(onlineViewer);
                        const page = embed_to_tab(onlineViewer, TabKind.step);
                        page.classList.add("active");
                        page.style.display = "none";
                        const onLoaded = () => {
                            console.log(
                                "[ECadViewer] Online3dViewerLoaded received, showing 3D viewer",
                            );
                            if (this.#step_viewer_placeholder) {
                                this.#step_viewer_placeholder.hidden = true;
                            }
                            onlineViewer.style.display = "";
                            onlineViewer.on_show();
                            this.project.removeEventListener(
                                Online3dViewerLoaded.type,
                                onLoaded,
                            );
                        };
                        this.project.addEventListener(
                            Online3dViewerLoaded.type,
                            onLoaded,
                        );
                    })();
                }
            }
        });

        this.#tab_header.addEventListener(TabMenuClickEvent.type, (event) => {
            const tab = (event as TabMenuClickEvent).detail;
            switch (tab) {
                case TabKind.pcb:
                    if (this.#board_app) {
                        this.#board_app.tabMenuHidden =
                            !this.#board_app.tabMenuHidden;
                    }
                    break;
                case TabKind.sch:
                    if (this.#schematic_app) {
                        this.#schematic_app.tabMenuHidden =
                            !this.#schematic_app.tabMenuHidden;
                    }
                    break;
                case TabKind.bom:
                    break;
            }
        });

        this.#tab_header.addEventListener(OpenBarrierEvent.type, (event) => {
            if (this.#spinner) {
                this.#spinner.hidden = false;
                this.#content.hidden = true;
            }
        });

        const embed_to_tab = (page: HTMLElement, index: TabKind) => {
            this.#tab_contents[index] = page;
            page.classList.add("tab-content");
            page.addEventListener(TabMenuVisibleChangeEvent.type, (event) => {
                const visible = (event as TabMenuVisibleChangeEvent).detail;
                this.#tab_header.tabMenuChecked = visible;
            });
            return page;
        };

        if (this.has_pcb) {
            if (!this.#board_app) {
                this.#board_app = html`<kc-board-app>
                </kc-board-app>` as KCBoardAppElement;
                this.#board_app.addEventListener(
                    KiCanvasSelectEvent.type,
                    (event) => this.#relay_board_selection(event),
                );
                this.#board_app.addEventListener(
                    EcadOverlayClickEvent.type,
                    (event) => this.#relay_comment_overlay_click(event),
                );
                this.#board_app.addEventListener(
                    EcadCommentAreaEvent.type,
                    (event) => this.#relay_comment_area_event(event),
                );
                // Host layer/object panels need a refresh once the board paints —
                // project "change" can fire before layers exist.
                this.#board_app.addEventListener(KiCanvasLoadEvent.type, () => {
                    this.#emit_view_state_change();
                });
            }
            this.#board_app.showPropertyPanel = this.showSelectionPanel;
            embed_to_tab(this.#board_app, TabKind.pcb);
            if (!this.#project.has_3d) {
                try {
                    this.#project
                        .get_file_text(
                            this.#project.get_first_page(AssertType.PCB)!
                                .filename,
                        )
                        .then((v) => {
                            if (v)
                                window.dispatchEvent(new BoardContentReady(v));
                        });
                } catch (e) {
                    alert(e);
                }
            }
        }

        if (this.has_sch) {
            if (!this.#schematic_app) {
                this.#schematic_app = html`<kc-schematic-app>
                </kc-schematic-app>` as KCSchematicAppElement;
                this.#schematic_app.addEventListener(
                    KiCanvasSelectEvent.type,
                    (event) => this.#relay_schematic_selection(event),
                );
                this.#schematic_app.addEventListener(
                    EcadOverlayClickEvent.type,
                    (event) => this.#relay_comment_overlay_click(event),
                );
                this.#schematic_app.addEventListener(
                    EcadCommentAreaEvent.type,
                    (event) => this.#relay_comment_area_event(event),
                );
                this.#schematic_app.addEventListener(
                    SheetLoadEvent.type,
                    (e) => {
                        this.#tab_header.dispatchEvent(
                            new SheetLoadEvent(e.detail),
                        );
                        // Re-dispatch from viewer so visualizer can track active sheet
                        this.dispatchEvent(new SheetLoadEvent(e.detail));
                    },
                );
            }
            this.#schematic_app.showPropertyPanel = this.showSelectionPanel;
            this.#tab_contents[TabKind.sch] = this.#schematic_app;
            embed_to_tab(this.#schematic_app, TabKind.sch);
        }

        if (this.has_3d) {
            if (!this.#step_viewer_placeholder) {
                this.#step_viewer_placeholder =
                    html`<ecad-spinner></ecad-spinner>` as HTMLElement;
            }
            embed_to_tab(this.#step_viewer_placeholder, TabKind.step);
        }
        if (this.has_bom) {
            if (!this.#bom_app) {
                this.#bom_app = new BomApp();
            }
            embed_to_tab(this.#bom_app, TabKind.bom);
        }

        this.#viewers_container = html` <div class="vertical">
            ${this.#board_app} ${this.#schematic_app} ${this.#bom_app}
            ${this.#step_viewer_placeholder}
        </div>` as HTMLDivElement;

        // Only a link when the host actually configured a destination.
        // `href=${undefined}` rendered a literal href="undefined", giving a
        // focusable control that navigated to a bogus relative path.
        const corner_mark = window.ai_url
            ? (html`<a
                  href=${window.ai_url}
                  class="bottom-left-icon"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="KiCAD Prism">
                  ${PRISM_LOGO}
              </a>` as HTMLElement)
            : (html`<div class="bottom-left-icon" aria-hidden="true">
                  ${PRISM_LOGO}
              </div>` as HTMLElement);

        this.#content = html` <div class="vertical">
            ${this.#tab_header} ${this.#viewers_container} ${corner_mark}
        </div>` as HTMLElement;

        // Optional headless mode: suppress the viewer's own built-in chrome so a
        // host app can render its own UI over a bare canvas. Nested shadow-root
        // chrome is toggled via the `headless` flag on inner apps.
        const chrome_style = this["hide-chrome"]
            ? (html`<style>
                  tab-header,
                  .bottom-left-icon {
                      display: none !important;
                  }
              </style>` as HTMLStyleElement)
            : "";
        if (this["hide-chrome"]) {
            if (this.#board_app)
                (
                    this.#board_app as unknown as { headless?: boolean }
                ).headless = true;
            if (this.#schematic_app)
                (
                    this.#schematic_app as unknown as { headless?: boolean }
                ).headless = true;
        }
        return html` ${chrome_style} ${this.#content} ${this.#spinner} `;
    }

    override renderedCallback() {
        window.requestAnimationFrame(() => {
            this.#apply_viewer_activity();
            this.#apply_viewport_insets();
            this.#restore_comment_overlay_scenes();
            this.#ensure_camera_hook(this.#safe_board_viewer());
            this.#ensure_camera_hook(this.#safe_schematic_viewer());
        });
    }
}

window.customElements.define("ecad-viewer", ECadViewer);

class EcadSourceElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}

window.customElements.define("ecad-source", EcadSourceElement);

class EcadBlobElement extends CustomElement {
    // Attributes must not be set in the constructor — React's
    // document.createElement("ecad-blob") throws NotSupportedError otherwise.
    override connectedCallback() {
        super.connectedCallback?.();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    filename: string;

    @attribute({ type: String })
    content: string;
}

window.customElements.define("ecad-blob", EcadBlobElement);

class Ov3dElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}
window.customElements.define("ecad-3d-source", Ov3dElement);
