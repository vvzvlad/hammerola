/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { TabKind } from "../../ecad-viewer/constraint";
import type { ComponentERCResult } from "../../proto/component_erc_result";
import type { ProjectErcResult } from "../../proto/project_erc_result";
import type { OverlayHit } from "./overlay-scene";

class KiCanvasEvent<T> extends CustomEvent<T> {
    constructor(name: string, detail: T, bubbles = false) {
        super(name, { detail: detail, composed: true, bubbles: bubbles });
    }
}

export class KiCanvasLoadEvent extends KiCanvasEvent<null> {
    static readonly type = "kicanvas:load";

    constructor() {
        super(KiCanvasLoadEvent.type, null);
    }
}

export type KiCanvasSelectIntent = "select" | "crossprobe";

/** Modifier keys observed on the click that produced a selection. */
export interface SelectModifiers {
    shift: boolean;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
}

/**
 * What the gesture asks the highlight set to do. `toggle` is a shift-click on
 * a net-bearing item; plain clicks and double-clicks are `replace`.
 */
export type KiCanvasSelectOperation = "replace" | "toggle";

interface SelectDetails {
    item: unknown;
    previous: unknown;
    /** Host policy: panel-only select vs full cross-probe. Defaults to select. */
    intent?: KiCanvasSelectIntent;
    operation?: KiCanvasSelectOperation;
    modifiers?: SelectModifiers;
}

export function select_modifiers(
    event?: MouseEvent | KeyboardEvent,
): SelectModifiers | undefined {
    if (!event) return undefined;
    return {
        shift: event.shiftKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
    };
}

interface SelectedItems {
    text: string;
    apiId: number;
}

export class KiCanvasAiSelectEvent extends KiCanvasEvent<SelectedItems> {
    static readonly type = "kicanvas:ai-select";

    constructor(detail: SelectedItems) {
        super(KiCanvasAiSelectEvent.type, detail, true);
    }
}

export class KiCanvasSelectEvent extends KiCanvasEvent<SelectDetails> {
    static readonly type = "kicanvas:select";

    constructor(detail: SelectDetails) {
        super(KiCanvasSelectEvent.type, detail, true);
    }
}

export type KiCanvasProbePhase = "hover" | "leave" | "activate" | "clear";
export type KiCanvasProbeSource = "pin" | "pad";

export type KiCanvasProbeDetail =
    | {
          phase: Exclude<KiCanvasProbePhase, "clear">;
          source: KiCanvasProbeSource;
          number: string;
          index: string;
          crossIndex: string;
      }
    | {
          phase: "clear";
      };

/** Structured pin/pad interaction used by lightweight library render hosts. */
export class KiCanvasProbeEvent extends KiCanvasEvent<KiCanvasProbeDetail> {
    static readonly type = "kicanvas:probe";

    constructor(detail: KiCanvasProbeDetail) {
        super(KiCanvasProbeEvent.type, detail, true);
    }
}

export class EcadOverlayClickEvent extends KiCanvasEvent<OverlayHit> {
    static readonly type = "ecad-viewer:overlay-click";

    constructor(detail: OverlayHit) {
        super(EcadOverlayClickEvent.type, detail, true);
    }
}

export class EcadOverlayHoverEvent extends KiCanvasEvent<OverlayHit> {
    static readonly type = "ecad-viewer:overlay-hover";

    constructor(detail: OverlayHit) {
        super(EcadOverlayHoverEvent.type, detail, true);
    }
}

export class EcadOverlayLeaveEvent extends KiCanvasEvent<OverlayHit> {
    static readonly type = "ecad-viewer:overlay-leave";

    constructor(detail: OverlayHit) {
        super(EcadOverlayLeaveEvent.type, detail, true);
    }
}

export interface EcadCommentAreaEventDetail {
    context: "SCH" | "PCB";
    x: number;
    y: number;
    bounds: [number, number, number, number];
    page?: string;
    layer?: string;
}

/**
 * Dispatched when a user finishes drawing a rubber-band area while a
 * viewer's comment mode is enabled (see `Viewer.set_comment_mode`).
 */
export class EcadCommentAreaEvent extends KiCanvasEvent<EcadCommentAreaEventDetail> {
    static readonly type = "ecad-viewer:comment-area";

    constructor(detail: EcadCommentAreaEventDetail) {
        super(EcadCommentAreaEvent.type, detail, true);
    }
}

interface FitterSelections {
    items: unknown[];
    /** Currently selected label uuid for sch label instance navigation. */
    activeUuid?: string;
}

export class KiCanvasContextMenuEvent extends KiCanvasEvent<FitterSelections> {
    static readonly type = "kicanvas:context-selection";

    constructor(detail: FitterSelections) {
        super(KiCanvasContextMenuEvent.type, detail, true);
    }
}

export class KiCanvasSchContextMenuEvent extends KiCanvasEvent<string> {
    static readonly type = "kicanvas:sch-context-selection";

    constructor(detail: string) {
        super(KiCanvasSchContextMenuEvent.type, detail, true);
    }
}

export class KiCanvasFitterMenuEvent extends KiCanvasEvent<FitterSelections> {
    static readonly type = "kicanvas:fitter-selection";

    constructor(detail: FitterSelections) {
        super(KiCanvasFitterMenuEvent.type, detail, true);
    }
}

interface MouseMoveDetails {
    x: number;
    y: number;
}

export interface LabelIndex {
    name: string;
    uuid: string;
}

export interface NetItemIndex {
    sheet: string;
    uuid: string;
}

export interface DesignatorIndex {
    sheet: string;
    designator: string;
}

export class KiCanvasMouseMoveEvent extends KiCanvasEvent<MouseMoveDetails> {
    static readonly type = "kicanvas:mousemove";

    constructor(detail: MouseMoveDetails) {
        super(KiCanvasMouseMoveEvent.type, detail, true);
    }
}

export class KicadSyncHoverEvent extends KiCanvasEvent<string | null> {
    static readonly type = "kicanvas:sync_hover";

    constructor(index: string | null) {
        super(KicadSyncHoverEvent.type, index, true);
    }
}

export interface TabIndexChange {
    current: TabKind;
    previous?: TabKind;
    userInitiated?: boolean;
}

export class TabActivateEvent extends CustomEvent<TabIndexChange> {
    static readonly type = "kicanvas:tab:activate";

    constructor(current: TabIndexChange) {
        super(TabActivateEvent.type, { detail: current });
    }
}

export class TabMenuVisibleChangeEvent extends CustomEvent<boolean> {
    static readonly type = "kicanvas:tab:menu:visible";

    constructor(v: boolean) {
        super(TabMenuVisibleChangeEvent.type, { detail: v });
    }
}

export class TabMenuChangeEvent extends CustomEvent<string> {
    static readonly type = "file:tab:menu:change";

    constructor(v: string) {
        super(TabMenuChangeEvent.type, { detail: v });
    }
}

export class TabMenuClickEvent extends CustomEvent<TabKind> {
    static readonly type = "kicanvas:tab:menu:click";

    constructor(tab: TabKind) {
        super(TabMenuClickEvent.type, { detail: tab });
    }
}

export interface SheetChangeDetail {
    filename: string;
    uuid: string;
}

export class SheetChangeEvent extends CustomEvent<SheetChangeDetail> {
    static readonly type = "kicanvas:sheet:change";

    constructor(detail: SheetChangeDetail) {
        super(SheetChangeEvent.type, { detail });
    }
}

export class SheetLoadEvent extends CustomEvent<string> {
    static readonly type = "kicanvas:sheet:loaded";

    constructor(sheet_name: string) {
        super(SheetLoadEvent.type, { detail: sheet_name });
    }
}

export class Online3dViewerUrlReady extends CustomEvent<string> {
    static readonly type = "3d:url:ready";

    constructor(url: string) {
        super(Online3dViewerUrlReady.type, { detail: url });
    }
}

export class Online3dViewerLoaded extends CustomEvent<void> {
    static readonly type = "3d:viewer:loaded";

    constructor() {
        super(Online3dViewerLoaded.type);
    }
}

export class SchViewerLoaded extends CustomEvent<void> {
    static readonly type = "sch:viewer:loaded";

    constructor() {
        super(SchViewerLoaded.type);
    }
}

export class PCBViewerLoaded extends CustomEvent<void> {
    static readonly type = "pcb:viewer:loaded";

    constructor() {
        super(PCBViewerLoaded.type);
    }
}

export class BoardContentReady extends CustomEvent<string> {
    static readonly type = "pcb:board_content:ready";

    constructor(content: string) {
        super(BoardContentReady.type, { detail: content });
    }
}

export class AdBoardContentReady extends CustomEvent<string> {
    static readonly type = "ad:board_content:ready";

    constructor(url: string) {
        super(AdBoardContentReady.type, { detail: url });
    }
}

export class LabelClickEvent extends CustomEvent<LabelIndex> {
    static readonly type = "sch:label:click";

    constructor(label: LabelIndex) {
        super(LabelClickEvent.type, { detail: label });
    }
}

export class HierarchicalSheetPinClickEvent extends CustomEvent<LabelIndex> {
    static readonly type = "sch:hierarchical_sheet_pin:click";

    constructor(pin: LabelIndex) {
        super(HierarchicalSheetPinClickEvent.type, { detail: pin });
    }
}

export class SelectDesignatorEvent extends CustomEvent<DesignatorIndex> {
    static readonly type = "sch:select:designator";

    constructor(d: DesignatorIndex) {
        super(SelectDesignatorEvent.type, { detail: d });
    }
}

export class ComponentERCResultEvent extends CustomEvent<ComponentERCResult> {
    static readonly type = "sch:erc:component";

    constructor(d: ComponentERCResult) {
        super(ComponentERCResultEvent.type, { detail: d });
    }
}

export class ProjectERCResultEvent extends CustomEvent<ProjectErcResult> {
    static readonly type = "sch:erc:project";

    constructor(detail: ProjectErcResult) {
        super(ProjectERCResultEvent.type, { detail });
    }
}

export class NetItemSelectEvent extends CustomEvent<NetItemIndex> {
    static readonly type = "net:select_item";

    constructor(net: NetItemIndex) {
        super(NetItemSelectEvent.type, { detail: net });
    }
}

export class OpenBarrierEvent extends CustomEvent<undefined> {
    static readonly type = "ecad-viewer:open_barrier";

    constructor() {
        super(OpenBarrierEvent.type);
    }
}

export class ShowBarrierEvent extends CustomEvent<undefined> {
    static readonly type = "ecad-viewer:show_barrier";
    constructor() {
        super(ShowBarrierEvent.type);
    }
}

export class PresetChangeEvent extends CustomEvent<string> {
    static readonly type = "ecad-viewer:preset:change";

    constructor(preset: string) {
        super(PresetChangeEvent.type, { detail: preset });
    }
}

export class PresetUnsetEvent extends CustomEvent<undefined> {
    static readonly type = "ecad-viewer:preset:unset";

    constructor() {
        super(PresetUnsetEvent.type);
    }
}

export interface ImageExportRequestDetails {
    viewType?: "SCH" | "PCB" | "3D" | "BOM";
}

export interface ImageExportDetails {
    viewType: "SCH" | "PCB" | "3D" | "BOM";
    imageData: string;
    width: number;
    height: number;
    timestamp: number;
}

export class ImageExportRequestEvent extends CustomEvent<
    ImageExportRequestDetails | "SCH" | "PCB" | "3D" | "BOM"
> {
    static readonly type = "ecad-viewer:image:export-request";

    constructor(
        detail: ImageExportRequestDetails | "SCH" | "PCB" | "3D" | "BOM",
    ) {
        super(ImageExportRequestEvent.type, { detail });
    }
}

export class ImageExportResultEvent extends CustomEvent<ImageExportDetails> {
    static readonly type = "ecad-viewer:image:export-result";

    constructor(detail: ImageExportDetails) {
        super(ImageExportResultEvent.type, { detail });
    }
}

/**
 * Message type for loading ZIP via postMessage
 */
export const LOAD_ZIP_MESSAGE_TYPE = "ecad-viewer/load-zip";

/**
 * Message type for ready notification
 */
export const READY_MESSAGE_TYPE = "ecad-viewer/ready";

/**
 * Message type for error reporting
 */
export const ERROR_MESSAGE_TYPE = "ecad-viewer/error";

/**
 * Event dispatched when a ZIP is loaded via postMessage
 */
export class LoadZipEvent extends CustomEvent<Blob> {
    static readonly type = "ecad-viewer:zip:loaded";

    constructor(blob: Blob) {
        super(LoadZipEvent.type, { detail: blob });
    }
}

/**
 * Event dispatched when ZIP loading via postMessage fails
 */
export class LoadZipErrorEvent extends CustomEvent<string> {
    static readonly type = "ecad-viewer:zip:error";

    constructor(message: string) {
        super(LoadZipErrorEvent.type, { detail: message });
    }
}

export interface KiCanvasEventMap {
    [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
    [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
    [KiCanvasProbeEvent.type]: KiCanvasProbeEvent;
    [EcadOverlayClickEvent.type]: EcadOverlayClickEvent;
    [EcadOverlayHoverEvent.type]: EcadOverlayHoverEvent;
    [EcadOverlayLeaveEvent.type]: EcadOverlayLeaveEvent;
    [EcadCommentAreaEvent.type]: EcadCommentAreaEvent;
    [KiCanvasAiSelectEvent.type]: KiCanvasAiSelectEvent;
    [KiCanvasMouseMoveEvent.type]: KiCanvasMouseMoveEvent;
    [KicadSyncHoverEvent.type]: KicadSyncHoverEvent;
    [TabActivateEvent.type]: TabActivateEvent;
    [TabMenuVisibleChangeEvent.type]: TabMenuVisibleChangeEvent;
    [TabMenuChangeEvent.type]: TabMenuChangeEvent;
    [KiCanvasFitterMenuEvent.type]: KiCanvasFitterMenuEvent;
    [KiCanvasContextMenuEvent.type]: KiCanvasContextMenuEvent;
    [KiCanvasSchContextMenuEvent.type]: KiCanvasSchContextMenuEvent;
    [SheetChangeEvent.type]: SheetChangeEvent;
    [SheetLoadEvent.type]: SheetLoadEvent;
    [Online3dViewerUrlReady.type]: Online3dViewerUrlReady;
    [Online3dViewerLoaded.type]: Online3dViewerLoaded;
    [LabelClickEvent.type]: LabelClickEvent;
    [HierarchicalSheetPinClickEvent.type]: HierarchicalSheetPinClickEvent;
    [NetItemSelectEvent.type]: NetItemSelectEvent;
    [OpenBarrierEvent.type]: OpenBarrierEvent;
    [ShowBarrierEvent.type]: ShowBarrierEvent;
    [SelectDesignatorEvent.type]: SelectDesignatorEvent;
    [PresetChangeEvent.type]: PresetChangeEvent;
    [PresetUnsetEvent.type]: PresetUnsetEvent;
    [ComponentERCResultEvent.type]: ComponentERCResultEvent;
    [ProjectERCResultEvent.type]: ProjectERCResultEvent;
}

declare global {
    interface WindowEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
        [TabMenuVisibleChangeEvent.type]: TabMenuVisibleChangeEvent;
        [SheetChangeEvent.type]: SheetChangeEvent;
        [SheetLoadEvent.type]: SheetLoadEvent;
        [Online3dViewerUrlReady.type]: Online3dViewerUrlReady;
        [Online3dViewerLoaded.type]: Online3dViewerLoaded;
        [LabelClickEvent.type]: LabelClickEvent;
        [HierarchicalSheetPinClickEvent.type]: HierarchicalSheetPinClickEvent;
        [KiCanvasFitterMenuEvent.type]: KiCanvasFitterMenuEvent;
        [OpenBarrierEvent.type]: OpenBarrierEvent;
        [SelectDesignatorEvent.type]: SelectDesignatorEvent;
        [BoardContentReady.type]: BoardContentReady;
        [ComponentERCResultEvent.type]: ComponentERCResultEvent;
        [ProjectERCResultEvent.type]: ProjectERCResultEvent;
    }

    interface HTMLElementEventMap {
        [KiCanvasLoadEvent.type]: KiCanvasLoadEvent;
        [KiCanvasSelectEvent.type]: KiCanvasSelectEvent;
        [TabMenuVisibleChangeEvent.type]: TabMenuVisibleChangeEvent;
        [SheetChangeEvent.type]: SheetChangeEvent;
        [SheetLoadEvent.type]: SheetLoadEvent;
        [Online3dViewerUrlReady.type]: Online3dViewerUrlReady;
        [Online3dViewerLoaded.type]: Online3dViewerLoaded;
        [LabelClickEvent.type]: LabelClickEvent;
        [HierarchicalSheetPinClickEvent.type]: HierarchicalSheetPinClickEvent;
        [KiCanvasFitterMenuEvent.type]: KiCanvasFitterMenuEvent;
        [OpenBarrierEvent.type]: OpenBarrierEvent;
        [SelectDesignatorEvent.type]: SelectDesignatorEvent;
        [BoardContentReady.type]: BoardContentReady;
        [ComponentERCResultEvent.type]: ComponentERCResultEvent;
        [ProjectERCResultEvent.type]: ProjectERCResultEvent;
        [EcadOverlayClickEvent.type]: EcadOverlayClickEvent;
        [EcadOverlayHoverEvent.type]: EcadOverlayHoverEvent;
        [EcadOverlayLeaveEvent.type]: EcadOverlayLeaveEvent;
        [EcadCommentAreaEvent.type]: EcadCommentAreaEvent;
    }
}
