/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { CrossHightAble } from "../../base/cross_highlight_able";
import { Logger } from "../../base/log";
import { BBox, Vec2 } from "../../base/math";
import { Color, Renderer } from "../../graphics";
import { WebGL2Renderer } from "../../graphics/webgl";
import type { BoardTheme } from "../../kicad";
import * as board_items from "../../kicad/board";
import { normalize_variant_name } from "../../kicad/board-variant-resolution";
import {
    BoardBBoxVisitor,
    type BoardInteractiveItem,
    Depth,
    type NetProperty,
} from "../../kicad/board_bbox_visitor";
import type { KCBoardLayersPanelElement } from "../../kicanvas/elements/kc-board/layers-panel";
import { DocumentViewer } from "../base/document-viewer";
import {
    KiCanvasFitterMenuEvent,
    KiCanvasProbeEvent,
    KiCanvasSelectEvent,
    select_modifiers,
} from "../base/events";
import type { VisibilityType } from "../base/view-layers";
import { ViewerType } from "../base/viewer";
import type {
    EcadOverlayAnchor,
    ResolvedOverlayAnchor,
} from "../base/overlay-scene";
import { LayerNames, LayerSet, ViewLayer } from "./layers";
import { NetLabelLayers } from "./net-label-layers";
import {
    DEFAULT_NET_LABEL_OPTIONS,
    type LabelLayout,
    type NetLabelOptions,
} from "./net-label-painter";
import { BoardPainter } from "./painter";
import {
    diff_selection_copper_layers,
    type BoardDiffSelectionEntry,
} from "./diff-layers";
import { OrderedMap } from "immutable";
const log = new Logger("pcb:viewer");

export const ZONE_DEFAULT_OPACITY = 0.6;

function same_set(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
}

/**
 * The one net every hit belongs to, or null when the hits disagree or none
 * of them carries a net. Unconnected items (net 0) do not count as a net.
 */
export function shared_net(
    items: readonly BoardInteractiveItem[],
): number | null {
    let net: number | null = null;
    for (const item of items) {
        if (!item.net) continue;
        if (net === null) net = item.net;
        else if (net !== item.net) return null;
    }
    return net;
}

/** Specificity order for overlapping hits: a pad beats the track under it. */
const PICK_ORDER: readonly Depth[] = [
    Depth.PAD,
    Depth.VIA,
    Depth.LINE_SEGMENTS,
    Depth.FOOT_PRINT,
    Depth.ZONE,
    Depth.GRAPHICS,
];

/** The item a click should select when several overlap under the cursor. */
export function pick_item(
    items: readonly BoardInteractiveItem[],
): BoardInteractiveItem | null {
    let best: BoardInteractiveItem | null = null;
    let best_rank = Number.POSITIVE_INFINITY;
    for (const item of items) {
        const rank = PICK_ORDER.indexOf(item.depth);
        if (rank === -1) continue;
        if (rank < best_rank) {
            best = item;
            best_rank = rank;
        }
    }
    return best ?? items[0] ?? null;
}

export type { BoardDiffSelectionEntry } from "./diff-layers";

export class BoardViewer extends DocumentViewer<
    board_items.KicadPCB,
    BoardPainter,
    LayerSet,
    BoardTheme
> {
    #zones_visibility = new Map<string, VisibilityType>();

    /**
     * The highlighted net set, in insertion order. Painted as a dim pass
     * plus emphasised members; the native layers are never touched, so the
     * user's layer map survives any highlight and clear.
     */
    #highlighted_nets = new Set<number>();
    #layer_visibility_ctrl: KCBoardLayersPanelElement;

    /**
     * The selected board variant; `null` is the default design. Footprint
     * painters resolve their effective flags against it (VAR-06).
     */
    #variant: string | null = null;

    /**
     * Net-name / pad-number label toggles. They outlive scenes: a repaint
     * for a variant or a cached-scene swap keeps the user's choice.
     */
    #net_label_options: NetLabelOptions = { ...DEFAULT_NET_LABEL_OPTIONS };

    /**
     * One label manager per layer set. The presentation-scene cache swaps
     * whole layer sets in and out without repainting, so the manager (and
     * its cached region) has to travel with the layers it painted into.
     */
    #net_labels_by_scene = new WeakMap<LayerSet, NetLabelLayers>();

    #net_labels_for_current_scene(): NetLabelLayers | null {
        if (!this.document || !this.layers || !this.painter) return null;
        // Comparison presentations recolour the board; labels would be noise.
        if (this.diff_presentation) return null;
        const layers = this.layers as LayerSet;
        let labels = this.#net_labels_by_scene.get(layers);
        if (!labels) {
            labels = new NetLabelLayers(
                this.renderer,
                this.viewport.camera,
                this.board,
                layers,
            );
            this.#net_labels_by_scene.set(layers, labels);
        }
        return labels;
    }

    public override draw(): void {
        if (!this.viewport) {
            return;
        }
        const labels = this.#net_labels_for_current_scene();
        if (labels) {
            labels.options = this.#net_label_options;
            labels.update();
        }
        super.draw();
    }

    public get net_label_options(): Readonly<NetLabelOptions> {
        return this.#net_label_options;
    }

    /**
     * The labels the current camera and toggles would draw, keyed by label
     * layer name. Diagnostic: hosts and tests can check what is shown without
     * reading GPU buffers.
     */
    public net_label_layouts(): Map<string, LabelLayout[]> {
        const labels = this.#net_labels_for_current_scene();
        if (!labels) return new Map();
        labels.options = this.#net_label_options;
        return labels.layouts();
    }

    public set_net_label_option(
        kind: keyof NetLabelOptions,
        enabled: boolean,
    ): boolean {
        if (this.#net_label_options[kind] === enabled) return false;
        this.#net_label_options = {
            ...this.#net_label_options,
            [kind]: enabled,
        };
        this.draw();
        return true;
    }

    /**
     * Select the board variant. `null`, the empty string and the
     * `< Default >` sentinel select the default design; an unknown name
     * resolves the base state silently, as native does (packet N17/N18).
     * Returns whether the selection changed.
     *
     * The public `setVariant` wrapper that validates against the catalog
     * belongs to the ecad-viewer element (VAR-05).
     */
    set_variant(name: string | null): boolean {
        const normalized = normalize_variant_name(name);
        if (normalized === this.#variant) return false;
        this.#variant = normalized;
        if (this.document && this.painter) {
            this.painter.active_variant = normalized;
            this.paint();
            this.draw();
        }
        return true;
    }

    get_variant(): string | null {
        return this.#variant;
    }

    /**
     * Scenes are variant-specific: a warm cache entry for the default design
     * must never be restored for a named variant.
     */
    protected override get scene_cache_context(): unknown {
        return this.#variant;
    }

    set layer_visibility_ctrl(ctr: KCBoardLayersPanelElement) {
        this.#layer_visibility_ctrl = ctr;
    }

    #restore_zone_layers() {
        for (const layer of this.layers.zone_layers()) {
            const visible = this.#zones_visibility.get(layer.name);
            if (visible !== undefined) layer.visible = visible;
        }
        this.#zones_visibility.clear();
    }

    /**
     * A sticky emphasis that survives document clicks and tab switches:
     * a cross-probed footprint, or the highlighted net set.
     */
    #crossprobe: { kind: "fp"; fp: board_items.Footprint } | null = null;

    // The layer the user isolated from the layer menu, if any. Layer isolation
    // and net cross-probe both drive layers.highlight(), so clearing a
    // selection would otherwise wipe the user's isolation as a side effect.
    // Tracking it lets clear_selection restore isolation after clearing a probe.
    #isolated_layer: string | null = null;

    /** Net codes currently highlighted, in insertion order. */
    public get highlighted_nets(): ReadonlySet<number> {
        return this.#highlighted_nets;
    }

    /**
     * Replace the highlighted set. Unknown or zero net codes are dropped.
     * Returns whether the set changed; repaints either way when non-empty so
     * a re-applied set rebuilds selection layers a hidden canvas lost.
     */
    public set_highlighted_nets(nets: Iterable<number>): boolean {
        const next = new Set<number>();
        for (const num of nets) {
            if (num && this.board.getNetName(num) !== undefined) next.add(num);
        }
        const changed = !same_set(this.#highlighted_nets, next);
        this.#highlighted_nets = next;
        this.#paint_highlight();
        return changed;
    }

    public add_highlighted_net(num: number): boolean {
        if (!num || this.#highlighted_nets.has(num)) return false;
        return this.set_highlighted_nets([...this.#highlighted_nets, num]);
    }

    public remove_highlighted_net(num: number): boolean {
        if (!this.#highlighted_nets.has(num)) return false;
        const next = new Set(this.#highlighted_nets);
        next.delete(num);
        return this.set_highlighted_nets(next);
    }

    public toggle_highlighted_net(num: number): boolean {
        return this.#highlighted_nets.has(num)
            ? this.remove_highlighted_net(num)
            : this.add_highlighted_net(num);
    }

    public clear_highlighted_nets(): boolean {
        return this.set_highlighted_nets([]);
    }

    /** Fit the camera to the highlighted copper. False when there is none. */
    public focus_highlighted_nets(): boolean {
        const bbox = this.painter.highlight_bbox;
        if (!bbox || !bbox.valid) return false;
        this.viewport.camera.bbox = bbox.grow(
            Math.max(bbox.w * 0.5, 4),
            Math.max(bbox.h * 0.5, 4),
        );
        this.draw();
        return true;
    }

    #paint_highlight() {
        if (this.#crossprobe) {
            this.#crossprobe = null;
            this.#restore_zone_layers();
        }
        const nets = this.#highlighted_nets;
        this.painter.paint_highlight(this.board, nets, (name) =>
            this.#layer_visible(name),
        );
        const labels = this.#net_labels_for_current_scene();
        if (labels) labels.emphasized_nets = nets.size ? nets : null;
        this.draw();
    }

    #layer_visible(name: string): boolean {
        const configured = this.layer_visibility?.get(name);
        if (configured !== undefined) return configured;
        return this.layers.by_name(name)?.visible ?? false;
    }

    /**
     * Replace the highlighted set with one net and, when asked, tell the
     * host which net that is. Kept for the single-net cross-probe callers.
     */
    public highlight_net(num: number | null, emit_selection = true) {
        this.set_highlighted_nets(num ? [num] : []);
        if (num && emit_selection) {
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: {
                        net: this.board.getNetName(num),
                        ...this.#net_info.get(num),
                    },
                    previous: null,
                }),
            );
        }
    }

    protected override on_document_clicked(): void {
        // Highlights and cross-probes are sticky until Esc or an explicit
        // clear_selection. Document clicks (tab UI, 3D/SCH canvas) must not
        // wipe a probe that was just applied from another view.
        if (this.#crossprobe || this.#highlighted_nets.size) return;

        if (this.#zones_visibility.size) {
            this.painter.clear_interactive();
            for (const layer of this.layers.zone_layers()) {
                layer.visible = this.#zones_visibility.get(layer.name)!;
            }
            this.#zones_visibility.clear();
            this.draw();
        }
    }

    public highlight_fp(fp: board_items.Footprint) {
        // A footprint cross-probe replaces the net emphasis.
        this.#highlighted_nets = new Set();
        const labels = this.#net_labels_for_current_scene();
        if (labels) labels.emphasized_nets = null;
        this.#crossprobe = { kind: "fp", fp };
        if (!this.#zones_visibility.size)
            for (const layer of this.layers.zone_layers()) {
                this.#zones_visibility.set(layer.name, layer.visibility);
                layer.visible = false;
            }
        this.painter.paint_footprint(fp);
        this.draw();
    }

    /** Single-click selection: green outline only (no hatch / zone hide). */
    public outline_fp(fp: board_items.Footprint) {
        // An outline is an inspection, not an emphasis: keep the net set.
        if (this.#highlighted_nets.size) return;
        this.#crossprobe = null;
        this.#restore_zone_layers();
        this.painter.outline_footprint(fp);
        this.draw();
    }

    /** Replace the highlight with one net and frame it. */
    public focus_net(num: number | null, emit_selection = true) {
        this.highlight_net(num, emit_selection);
        if (num) this.focus_highlighted_nets();
    }

    /**
     * Drop the inspected object and footprint probe. The highlighted nets go
     * too unless `keep_highlights` is set, which a host uses when only its
     * inspected selection changed and its net set still stands.
     */
    public clear_selection(keep_highlights = false) {
        this.#crossprobe = null;
        this.#restore_zone_layers();
        if (keep_highlights && this.#highlighted_nets.size) {
            this.painter?.clear_interactive();
            this.#paint_highlight();
            this.#restore_layer_isolation();
            return;
        }
        this.#highlighted_nets = new Set();
        if (this.painter && this.board) {
            this.painter.paint_highlight(
                this.board,
                this.#highlighted_nets,
                () => false,
            );
        }
        const labels = this.#net_labels_for_current_scene();
        if (labels) labels.emphasized_nets = null;
        this.painter?.clear_interactive();
        this.#restore_layer_isolation();
        this.draw();
    }

    // Clearing a selection or net probe must not undo the user's layer
    // isolation, which is an independent view choice made from the layer
    // menu. Re-apply it after clearing rather than dropping to no highlight.
    #restore_layer_isolation() {
        const isolated = this.#isolated_layer
            ? this.layers?.by_name(this.#isolated_layer)
            : null;
        this.layers?.highlight(isolated ?? null);
        this.#layer_visibility_ctrl?.update_item_states();
    }

    public capture_diff_layer_visibility(): Map<string, boolean> {
        return new Map(
            Array.from(this.layers.in_ui_order(), (layer) => [
                layer.name,
                layer.visible,
            ]),
        );
    }

    /**
     * Render the selected native footprint or routing geometry over the
     * retained monochrome comparison scene. Routing focus exposes only the
     * copper layers actually used by the selected segments/vias.
     */
    public paint_diff_selection(
        entries: ReadonlyArray<BoardDiffSelectionEntry>,
        base_visibility: ReadonlyMap<string, boolean>,
    ): void {
        const routing_type_ids = new Set(["LineSegment", "ArcSegment", "Via"]);
        const routing = entries.some(
            (entry) =>
                entry.routing ||
                routing_type_ids.has(
                    (entry.item as { typeId?: string }).typeId ?? "",
                ),
        );
        const selected_layers = routing
            ? diff_selection_copper_layers(entries)
            : new Set<string>();

        for (const layer of this.layers.in_ui_order()) {
            layer.visible =
                routing && selected_layers.size
                    ? selected_layers.has(layer.name)
                    : (base_visibility.get(layer.name) ?? layer.visible);
        }
        this.#layer_visibility_ctrl?.clear_highlight();
        this.#layer_visibility_ctrl?.update_item_states();
        this.painter.paint_diff_selection(entries);
        this.draw();
    }

    /**
     * Hidden Prism tabs still receive cross-probe paints, but WebGL layers can
     * be empty until the canvas is visible. Re-bake the last probe on activate.
     */
    public override set_active(active: boolean) {
        super.set_active(active);
        if (!active) return;
        if (!this.#crossprobe && !this.#highlighted_nets.size) return;
        // Defer one frame so any document-click handlers from the tab switch
        // run first; then re-bake the emphasis on a visible canvas. The
        // camera is left alone: re-showing a tab is not a fit request.
        const probe = this.#crossprobe;
        const nets = this.#highlighted_nets;
        requestAnimationFrame(() => {
            if (probe) {
                if (this.#crossprobe === probe) this.highlight_fp(probe.fp);
                return;
            }
            if (this.#highlighted_nets === nets) this.#paint_highlight();
        });
    }

    #resolve_footprint(item: unknown): board_items.Footprint | null {
        let node = item as
            | { typeId?: string; parent?: unknown }
            | null
            | undefined;
        for (let i = 0; node && i < 8; i++) {
            if (node.typeId === "Footprint")
                return node as unknown as board_items.Footprint;
            node = node.parent as typeof node;
        }
        return null;
    }

    override on_click(pos: Vec2, event?: MouseEvent): void {
        const items = this.find_items_under_pos(pos);
        const modifiers = select_modifiers(event);
        const pad = items.find(
            (entry) =>
                entry.depth === Depth.PAD &&
                entry.item instanceof board_items.Pad &&
                entry.item.number.trim(),
        )?.item;
        if (pad instanceof board_items.Pad) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "activate",
                    source: "pad",
                    number: pad.number,
                    index: pad.index,
                    crossIndex: pad.cross_index,
                }),
            );
        } else {
            this.dispatchEvent(new KiCanvasProbeEvent({ phase: "clear" }));
        }

        // Shift-click toggles the net of the most specific item under the
        // cursor: the pad the user aimed at, not the other-layer track that
        // happens to run beneath it. An unconnected pick falls back to the
        // net its neighbours share, so a hole over one net still counts.
        if (modifiers?.shift) {
            const target = pick_item(items);
            const net = target?.net || shared_net(items);
            if (net && target) {
                this.dispatchEvent(
                    new KiCanvasSelectEvent({
                        item: target.item,
                        previous: null,
                        intent: "select",
                        operation: "toggle",
                        modifiers,
                    }),
                );
            }
            // A shift-click on nothing (or on an unconnected item) is a
            // no-op: it must not clear what the user is building up.
            return;
        }

        // Plain click: the most specific item wins (pad over via over track
        // over footprint), never a pop-up asking the user to choose.
        const target = pick_item(items);
        if (target?.item) {
            if ((target.item as { typeId?: string }).typeId === "Footprint") {
                this.outline_fp(target.item as board_items.Footprint);
            }
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: target.item,
                    previous: null,
                    intent: "select",
                    operation: "replace",
                    modifiers,
                }),
            );
        } else {
            // Truly empty click (nothing under the cursor): emit an empty
            // selection so the host can deselect. Previously nothing was
            // dispatched here, so a click on bare board left the selection stuck.
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: null,
                    previous: null,
                    intent: "select",
                    operation: "replace",
                    modifiers,
                }),
            );
        }
        this.dispatchEvent(new KiCanvasFitterMenuEvent({ items: [] }));
    }

    get layer_visibility() {
        return this.#layer_visibility_ctrl?.visibilities ?? null;
    }

    find_items_under_pos(pos: Vec2) {
        const items: BoardInteractiveItem[] = [];

        // When one or more layers are isolated (highlighted from the layer
        // menu), only items on those layers are selectable. Otherwise a click
        // could still land on a dimmed trace on another layer, e.g. picking an
        // F.Cu trace while B.Cu is isolated. Fall back to plain layer
        // visibility when nothing is isolated.
        const highlighted_layers = new Set(
            this.layers.highlighted_layer_names(),
        );

        const visible_layers = this.#visible_layer_names();

        const is_item_visible = (item: BoardInteractiveItem) => {
            // Isolation restricts selection to items that actually live on an
            // isolated layer. This uses the true layer set (on_layers), not the
            // loose is_on_layer, so a footprint or pad on the opposite side is
            // not selectable just because is_on_layer answers permissively.
            if (highlighted_layers.size) {
                for (const layer of item.on_layers())
                    if (highlighted_layers.has(layer)) return true;
                return false;
            }
            // No isolation: unchanged permissive picking against visible layers.
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;
            return false;
        };

        const check_depth = (depth: Depth) => {
            const layer_items = this.#interactive.get(depth) ?? [];
            if (layer_items.length)
                for (const i of layer_items) {
                    if (i.contains(pos) && is_item_visible(i)) {
                        items.push(i);
                    }
                }
        };

        for (const [depth] of this.#interactive) {
            switch (depth) {
                case Depth.GRAPHICS:
                    break;
                case Depth.VIA:
                case Depth.PAD:
                case Depth.LINE_SEGMENTS:
                    check_depth(depth);
                    break;
                case Depth.FOOT_PRINT:
                case Depth.ZONE:
                    break;
            }
        }

        // look up the footprints then
        if (!items.length) check_depth(Depth.FOOT_PRINT);

        // look up the zones finally
        if (!items.length) check_depth(Depth.ZONE);

        return items;
    }

    override on_dblclick(pos: Vec2): void {
        const items = this.find_items_under_pos(pos);
        if (items.length === 0) return;
        const it = items[0]!;

        // Pad / track / via / zone → net cross-probe (dimmed copper + host event).
        if (it.net) {
            this.focus_net(it.net, false);
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: {
                        net: this.board.getNetName(it.net),
                        ...this.#net_info.get(it.net),
                    },
                    previous: null,
                    intent: "crossprobe",
                }),
            );
            return;
        }

        const fp = this.#resolve_footprint(it.item);
        if (fp) {
            this.highlight_fp(fp);
            const b = fp.bbox;
            this.viewport.camera.bbox = b.grow(
                Math.max(b.w * 0.5, 4),
                Math.max(b.h * 0.5, 4),
            );
            this.draw();
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: fp,
                    previous: null,
                    intent: "crossprobe",
                }),
            );
        }
    }
    override type: ViewerType = ViewerType.PCB;

    #interactive: OrderedMap<Depth, BoardInteractiveItem[]> = OrderedMap();

    #net_info: Map<number, NetProperty>;

    #last_hover: BoardInteractiveItem | null = null;
    #last_probe: board_items.Pad | null = null;

    #highlighted_track = true;
    #overlay_item_bounds = new Map<string, BBox>();

    set_highlighted_track(val: boolean) {
        this.#highlighted_track = val;
    }

    /**
     * Returns the bounding box for an interactive board item by uuid/tstamp,
     * as captured while loading the board. Useful for host adapters that
     * need to enrich selection or overlay data with world-space bounds.
     */
    public overlay_item_bounds(uuid: string): BBox | undefined {
        return this.#overlay_item_bounds.get(uuid);
    }

    public get_host_view_state() {
        const layers = this.layers as LayerSet;
        const first_opacity = (items: Generator<ViewLayer>) =>
            items.next().value?.opacity ?? 1;
        const any_visible = (items: Generator<ViewLayer>) =>
            Array.from(items).some((layer) => (layer.opacity ?? 1) > 0);
        return {
            layers: Array.from(layers.in_ui_order()).map((layer) => ({
                name: layer.name,
                color: layer.color.to_css(),
                visible: layer.visible,
                highlighted: layer.highlighted,
            })),
            objectOpacity: {
                tracks: first_opacity(layers.copper_layers()),
                vias: first_opacity(layers.via_layers()),
                pads: first_opacity(layers.pad_layers()),
                zones: first_opacity(layers.zone_layers()),
            },
            objectVisibility: {
                references: any_visible(layers.fp_reference_txt_layers()),
                values: any_visible(layers.fp_value_txt_layers()),
                footprintText: any_visible(layers.fp_txt_layers()),
                hiddenText: any_visible(layers.hidden_txt_layers()),
                padNumbers: this.#net_label_options.padNumbers,
                padNetNames: this.#net_label_options.padNetNames,
                trackNetNames: this.#net_label_options.trackNetNames,
            },
            highlightTracks: this.#highlighted_track,
        };
    }

    public set_host_layer_visibility(name: string, visible: boolean) {
        const layer = this.layers.by_name(name);
        if (!layer || !Array.from(this.layers.in_ui_order()).includes(layer))
            return false;
        layer.visible = visible;
        if (!visible && layer.highlighted) {
            this.layers.highlight(null);
            if (this.#isolated_layer === name) this.#isolated_layer = null;
        }
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
        return true;
    }

    public set_host_layer_highlight(name: string | null) {
        if (!name) {
            this.layers.highlight(null);
            this.#isolated_layer = null;
            this.#layer_visibility_ctrl?.update_item_states();
            this.draw();
            return true;
        }
        const layer = this.layers.by_name(name);
        if (!layer || !Array.from(this.layers.in_ui_order()).includes(layer))
            return false;
        const next = layer.highlighted ? null : layer;
        this.layers.highlight(next);
        this.#isolated_layer = next ? name : null;
        if (next) next.visible = true;
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
        return true;
    }

    public apply_host_layer_preset(
        preset:
            | "front"
            | "back"
            | "copper"
            | "outer-copper"
            | "inner-copper"
            | "drawings"
            | "all"
            | "none",
    ) {
        for (const layer of this.layers.in_ui_order()) {
            switch (preset) {
                case "front":
                    layer.visible =
                        layer.name.startsWith("F.") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "back":
                    layer.visible =
                        layer.name.startsWith("B.") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "copper":
                    layer.visible =
                        layer.name.endsWith(".Cu") ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "outer-copper":
                    layer.visible =
                        layer.name === LayerNames.f_cu ||
                        layer.name === LayerNames.b_cu ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "inner-copper":
                    layer.visible =
                        (layer.name.endsWith(".Cu") &&
                            layer.name !== LayerNames.f_cu &&
                            layer.name !== LayerNames.b_cu) ||
                        layer.name === LayerNames.edge_cuts;
                    break;
                case "drawings":
                    layer.visible =
                        !layer.name.endsWith(".Cu") &&
                        !layer.name.endsWith(".Mask") &&
                        !layer.name.endsWith(".Paste") &&
                        !layer.name.endsWith(".Adhes");
                    break;
                case "all":
                    layer.visible = true;
                    break;
                case "none":
                    layer.visible = false;
                    break;
            }
        }
        this.layers.highlight(null);
        this.#layer_visibility_ctrl?.update_item_states();
        this.draw();
    }

    public set_host_object_opacity(
        kind: "tracks" | "vias" | "pads" | "zones",
        opacity: number,
    ) {
        const value = Math.max(0, Math.min(1, opacity));
        switch (kind) {
            case "tracks":
                this.track_opacity = value;
                break;
            case "vias":
                this.via_opacity = value;
                break;
            case "pads":
                this.pad_opacity = value;
                break;
            case "zones":
                this.zone_opacity = value;
                break;
        }
    }

    public set_host_object_visibility(
        kind:
            | "references"
            | "values"
            | "footprintText"
            | "hiddenText"
            | keyof NetLabelOptions,
        visible: boolean,
    ) {
        switch (kind) {
            case "padNumbers":
            case "padNetNames":
            case "trackNetNames":
                this.set_net_label_option(kind, visible);
                return;
        }
        const layers = this.layers as LayerSet;
        const opacity = visible ? 1 : 0;
        const set = (items: Generator<ViewLayer>) => {
            for (const layer of items) layer.opacity = opacity;
        };
        switch (kind) {
            case "references":
                set(layers.fp_reference_txt_layers());
                break;
            case "values":
                set(layers.fp_value_txt_layers());
                break;
            case "footprintText":
                set(layers.fp_txt_layers());
                break;
            case "hiddenText":
                set(layers.hidden_txt_layers());
                break;
        }
        this.draw();
    }

    public set_host_track_highlight(enabled: boolean) {
        this.set_highlighted_track(enabled);
        this.draw();
    }

    get board(): board_items.KicadPCB {
        return this.document;
    }

    override async load(src: board_items.KicadPCB) {
        try {
            const visitor = new BoardBBoxVisitor();
            visitor.visit(src);
            this.#overlay_item_bounds.clear();

            for (let k = Depth.START; k < Depth.END; k++)
                this.#interactive = this.#interactive.set(k, []);

            for (const e of visitor.interactive_items) {
                this.#interactive.get(e.depth)?.push(e);
                const uuid =
                    e.item && "uuid" in e.item
                        ? e.item.uuid
                        : e.item && "tstamp" in e.item
                          ? e.item.tstamp
                          : undefined;
                if (uuid) this.#overlay_item_bounds.set(uuid, e.item!.bbox);
            }
            this.#net_info = visitor.net_info;
        } catch (e) {
            log.warn(`BoardBBoxVisitor error :${e}`);
        }
        await super.load(src);
    }

    protected override resolve_overlay_anchor(
        anchor: EcadOverlayAnchor,
    ): ResolvedOverlayAnchor | null {
        if (anchor.kind === "source-item") {
            const bounds = this.#overlay_item_bounds.get(anchor.uuid);
            return bounds
                ? {
                      point: anchor.relativePoint
                          ? new Vec2(
                                bounds.x + bounds.w * anchor.relativePoint[0],
                                bounds.y + bounds.h * anchor.relativePoint[1],
                            )
                          : bounds.center,
                      bounds,
                      page: anchor.page,
                  }
                : null;
        }
        if (anchor.kind === "entity" && anchor.reference) {
            const footprint = this.board.find_footprint(anchor.reference);
            const bounds = footprint?.bbox;
            return bounds
                ? { point: bounds.center, bounds, page: anchor.page }
                : null;
        }
        return null;
    }

    protected override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new WebGL2Renderer(canvas);
        renderer.background_color = Color.gray;
        return renderer;
    }

    protected override create_painter() {
        const painter = new BoardPainter(
            this.renderer,
            this.layers,
            this.theme,
        );
        painter.active_variant = this.#variant;
        return painter;
    }

    protected override create_layer_set() {
        const layers = new LayerSet(this.board, this.theme);

        for (const zone of layers.zone_layers())
            zone.opacity = ZONE_DEFAULT_OPACITY;

        for (const it of layers.hidden_txt_layers()) {
            it.opacity = 0;
        }

        return layers;
    }

    protected override get grid_origin() {
        return new Vec2(0, 0);
    }

    private set_layers_opacity(layers: Generator<ViewLayer>, opacity: number) {
        for (const layer of layers) {
            layer.opacity = opacity;
        }
        this.draw();
    }

    set track_opacity(value: number) {
        this.set_layers_opacity(
            (this.layers as LayerSet).copper_layers(),
            value,
        );
    }

    set via_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).via_layers(), value);
    }

    set zone_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).zone_layers(), value);
    }

    set pad_opacity(value: number) {
        const st = this.layers as LayerSet;

        for (const it of [st.pad_layers(), st.pad_hole_layers()])
            this.set_layers_opacity(it, value);
    }

    set grid_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).grid_layers(), value);
    }

    set page_opacity(value: number) {
        this.layers.by_name(LayerNames.drawing_sheet)!.opacity = value;
        this.draw();
    }

    zoom_to_board() {
        const edge_cuts = this.layers.by_name(LayerNames.edge_cuts)!;
        const board_bbox = edge_cuts.bbox;
        this.viewport.camera.bbox = board_bbox.grow(board_bbox.w * 0.1);
    }

    findHighlightItem(pos: Vec2): CrossHightAble | null {
        return null;
    }

    findInteractive(pos: Vec2) {
        const visible_layers = this.#visible_layer_names();

        const is_item_visible = (item: BoardInteractiveItem) => {
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;

            return false;
        };

        for (const [, v] of this.#interactive) {
            for (const e of v) {
                if (e.contains(pos) && is_item_visible(e)) {
                    return e;
                }
            }
        }
        return null;
    }

    #visible_layer_names(): Set<string> {
        const visible = new Set<string>();
        const configured = this.layer_visibility;
        if (configured) {
            for (const [name, shown] of configured) {
                if (shown) visible.add(name);
            }
            return visible;
        }
        for (const layer of this.layers.in_ui_order()) {
            if (layer.visible) visible.add(layer.name);
        }
        return visible;
    }

    override on_hover(_pos: Vec2) {
        const hover_item = this.findInteractive(_pos);

        this.#update_probe_hover(
            hover_item?.depth === Depth.PAD &&
                hover_item.item instanceof board_items.Pad &&
                hover_item.item.number.trim()
                ? hover_item.item
                : null,
        );

        if (hover_item === this.#last_hover) return;

        this.#last_hover = hover_item;

        if (
            !this.#highlighted_track &&
            hover_item?.depth === Depth.LINE_SEGMENTS
        )
            return;

        this.painter.highlight(hover_item);
        this.draw();
    }

    protected override on_pointer_leave(): void {
        this.#update_probe_hover(null);
        this.#last_hover = null;
        this.painter.highlight(null);
        this.draw();
    }

    #update_probe_hover(next: board_items.Pad | null) {
        if (next === this.#last_probe) return;
        const previous = this.#last_probe;
        this.#last_probe = next;
        if (previous) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "leave",
                    source: "pad",
                    number: previous.number,
                    index: previous.index,
                    crossIndex: previous.cross_index,
                }),
            );
        }
        if (next) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "hover",
                    source: "pad",
                    number: next.number,
                    index: next.index,
                    crossIndex: next.cross_index,
                }),
            );
        }
    }

    protected override probe_bounds(index: string): BBox[] {
        const matches: BBox[] = [];
        for (const item of this.#interactive.get(Depth.PAD) ?? []) {
            if (
                item.item instanceof board_items.Pad &&
                item.item.index === index
            ) {
                matches.push(item.item.bbox);
            }
        }
        return matches;
    }
}
