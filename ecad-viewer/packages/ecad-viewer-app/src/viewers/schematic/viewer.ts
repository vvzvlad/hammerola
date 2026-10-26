/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { BBox, Vec2 } from "../../base/math";
import { Color, Polygon, Polyline, Renderer } from "../../graphics";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import { NullRenderer } from "../../graphics/null-renderer";
import { type SchematicTheme } from "../../kicad";
import {
    HierarchicalSheetPin,
    KicadSch,
    Label,
    PinInstance,
    SchematicInstanceContext,
} from "../../kicad/schematic";
import { DocumentViewer } from "../base/document-viewer";
import {
    HierarchicalSheetPinClickEvent,
    KiCanvasProbeEvent,
    KiCanvasSelectEvent,
    select_modifiers,
    LabelClickEvent,
    SheetChangeEvent,
    SheetLoadEvent,
} from "../base/events";
import { ViewerType } from "../base/viewer";
import { LayerNames, LayerSet } from "./layers";
import { SchematicPainter } from "./painter";
import { get_symbol_transform } from "../../kicad/symbol-transform";
import { apply_schematic_render_defaults } from "./render-state";
import { StrokeFont, TextAttributes } from "../../kicad/text";
import type { PinCheckResult } from "../../proto/component_erc_result";
import type {
    EcadOverlayAnchor,
    ResolvedOverlayAnchor,
} from "../base/overlay-scene";
import { normalize_variant_name } from "../../kicanvas/project";

export function get_sch_bbox(
    theme: SchematicTheme,
    sch: KicadSch,
    instance_context?: SchematicInstanceContext,
): BBox {
    const gfx = new NullRenderer();
    apply_schematic_render_defaults(gfx, theme);
    const layerset = new LayerSet(theme);
    const painter = new SchematicPainter(
        gfx,
        layerset,
        theme,
        instance_context,
    );

    const layer_names = [
        LayerNames.symbol_foreground,
        LayerNames.symbol_background,
        LayerNames.symbol_pin,
        LayerNames.wire,
        LayerNames.label,
        LayerNames.junction,
        LayerNames.notes,
    ];

    const bboxes = [];

    for (const layer_name of layer_names) {
        const layer = layerset.by_name(layer_name)!;
        for (const it of sch.items()) layer.items.push(it);
        painter.paint_layer(layer);
        bboxes.push(layer.bbox);
    }

    return BBox.combine(bboxes);
}

export class SchematicViewer extends DocumentViewer<
    KicadSch,
    SchematicPainter,
    LayerSet,
    SchematicTheme
> {
    static InterActiveBBoxLineWidth = 0.265;

    #focus_net_item?: string;
    #selected_bbox: BBox | null = null;
    #last_probe: PinInstance | null = null;
    // The bbox the overlay highlight was last built for. `find_item` hands back
    // the recorded BBox instance straight out of `layer.bboxes`, and
    // DocumentPainter.paint_layer assigns a fresh Map of fresh BBoxes on every
    // paint, so identity is stable between repaints and a repaint invalidates
    // this for free.
    #last_hover_bbox: BBox | null = null;
    #instance_context?: SchematicInstanceContext;

    /**
     * Explicitly requested variant; `undefined` follows the project's
     * `active_variant`, `null` is the default design.
     */
    #variant: string | null | undefined = undefined;

    get instance_context(): SchematicInstanceContext | undefined {
        return this.#instance_context;
    }

    /**
     * Select the design variant this viewer renders. `null`, the empty string
     * and the `< Default >` sentinel select the default design. Returns
     * whether the selection changed; an unknown name is still selected here
     * and resolves the base state (the public element validates names
     * against the catalog).
     */
    set_variant(name: string | null): boolean {
        const normalized = normalize_variant_name(name);
        // Compare against the selection this viewer applied itself, never
        // `get_variant()`: the element stores the new variant on the project
        // before calling here, so the getter -- which falls back to
        // `project.active_variant` -- already reports the new name and an
        // early return would leave the previously painted scene on screen.
        // BoardViewer compares its own field for the same reason.
        const applied =
            this.#variant !== undefined
                ? this.#variant
                : this.#instance_context?.variant;
        if (applied !== undefined && normalized === applied) return false;
        this.#variant = normalized;
        if (this.#instance_context) {
            this.#instance_context.variant = normalized;
        }
        if (this.document && this.painter) {
            this.paint();
            this.draw();
        }
        return true;
    }

    /** The variant this viewer renders; `null` is the default design. */
    get_variant(): string | null {
        if (this.#variant !== undefined) return this.#variant;
        return this.#instance_context?.active_variant ?? null;
    }

    public set_instance_context(context: SchematicInstanceContext): boolean {
        if (
            this.#instance_context?.document === context.document &&
            this.#instance_context.sheet_path === context.sheet_path &&
            this.#instance_context.active_variant === context.active_variant
        ) {
            return false;
        }
        this.#instance_context = context;
        if (this.#variant !== undefined) context.variant = this.#variant;
        return true;
    }

    protected override get scene_cache_context(): unknown {
        // A warm scene belongs to one (page, variant) pair; restoring a
        // default-design scene for a named variant would silently show the
        // wrong assembly state.
        return `${this.#instance_context?.sheet_path ?? ""}\u0000${this.get_variant() ?? ""}`;
    }

    get sch_name() {
        return this.document.filename;
    }

    set focus_net_item(ref: string | undefined) {
        this.#focus_net_item = ref;
    }

    override async load(src: KicadSch) {
        if (this.#instance_context?.document !== src) {
            const first_symbol = src.symbols.values().next().value;
            const first_instance_path = first_symbol?.instances
                .keys()
                .next().value;
            this.#instance_context = new SchematicInstanceContext(
                src,
                first_instance_path ?? (src.uuid ? `/${src.uuid}` : "/"),
            );
        }
        if (this.#variant !== undefined && this.#instance_context) {
            this.#instance_context.variant = this.#variant;
        }
        this.schematic_renderer.reset_scene_bbox();
        const context_changed =
            this.document === src &&
            this.painter?.instance_context?.sheet_path !==
                this.#instance_context?.sheet_path;
        if (context_changed) {
            await this.load_plain_document(src);
        } else {
            await super.load(src);
        }
        this.dispatchEvent(new SheetLoadEvent(src.filename));
    }

    find_item(pos: Vec2) {
        let selected: BBox | null = null;
        const items = this.layers.query_point_in_order(pos);
        for (const it of items) {
            if (it.bbox.context) {
                selected = it.bbox;
                return {
                    item: it.bbox.context,
                    bbox: selected,
                };
            }
        }

        return {
            item: null,
            bbox: null,
        };
    }

    override on_click(pos: Vec2, event?: MouseEvent): void {
        const ct = this.find_item(pos);
        const modifiers = select_modifiers(event);
        // Shift-click asks the host to toggle the item's net in its
        // highlight set (issue #305); on empty canvas it is a no-op so it
        // never clears what the user is building up.
        if (modifiers?.shift && !ct.item) return;
        const operation = modifiers?.shift ? "toggle" : "replace";

        if (ct.item instanceof PinInstance && ct.item.number.trim()) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "activate",
                    source: "pin",
                    number: ct.item.number,
                    index: ct.item.index,
                    crossIndex: ct.item.cross_index,
                }),
            );
        } else {
            this.dispatchEvent(new KiCanvasProbeEvent({ phase: "clear" }));
        }

        if (ct.item) {
            const it = ct.item;
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: it,
                    previous: null,
                    intent: "select",
                    operation,
                    modifiers,
                }),
            );

            if (it instanceof Label) {
                if (it.uuid) {
                    const index = {
                        name: it.text,
                        uuid: it.uuid,
                    };

                    if (it instanceof HierarchicalSheetPin) {
                        this.dispatchEvent(
                            new HierarchicalSheetPinClickEvent(index),
                        );
                    } else {
                        this.dispatchEvent(new LabelClickEvent(index));
                    }
                }
            }
        } else {
            // Background click: emit an empty selection so the host can deselect,
            // matching the board viewer. Without this the schematic only cleared
            // its own paint and the host kept the stale selection.
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: null,
                    previous: null,
                    intent: "select",
                    operation,
                    modifiers,
                }),
            );
        }
        this.paint_selected(ct.bbox);
    }
    override on_dblclick(pos: Vec2): void {
        // Hierarchical sheet symbols still navigate into the sheet.
        if (this.document.sheets)
            for (const item of this.document.sheets) {
                if (item.bbox.contains_point(pos) && item.sheetfile) {
                    this.dispatchEvent(
                        new SheetChangeEvent({
                            filename: item.sheetfile,
                            uuid: item.uuid,
                        }),
                    );
                    return;
                }
            }

        const ct = this.find_item(pos);
        if (!ct.item) return;
        this.paint_selected(ct.bbox);
        const uuid = (ct.item as { uuid?: string }).uuid;
        if (uuid) this.zoom_fit_item(uuid);
        this.dispatchEvent(
            new KiCanvasSelectEvent({
                item: ct.item,
                previous: null,
                intent: "crossprobe",
            }),
        );
    }

    protected override resolve_loaded(value: boolean) {
        super.resolve_loaded(value);

        if (value && this.#focus_net_item) {
            this.zoom_fit_item(this.#focus_net_item);
        }

        this.#focus_net_item = undefined;
    }

    override on_hover(pos: Vec2): void {
        const it = this.find_item(pos);
        const layer = this.layers.overlay;

        this.#update_probe_hover(
            it.item instanceof PinInstance && it.item.number.trim()
                ? it.item
                : null,
        );

        // Moving the pointer within the same item -- or across empty sheet --
        // leaves the overlay exactly as it already is. Rebuilding it anyway
        // costs a full display-list replay per mousemove frame, which on a
        // large sheet is the whole schematic. The board viewer already guards
        // its hover this way; this is the same guard.
        if (it.bbox === this.#last_hover_bbox) return;
        this.#last_hover_bbox = it.bbox;

        layer.clear();

        if (it.bbox) {
            const color = Color.cyan;
            this.renderer.start_layer(layer.name);

            this.renderer.line(
                Polyline.from_BBox(
                    it.bbox,
                    SchematicViewer.InterActiveBBoxLineWidth,
                    color,
                ),
            );

            layer.graphics = this.renderer.end_layer();

            layer.graphics.composite_operation = "source-over";
        }

        this.draw();
    }

    protected override on_pointer_leave(): void {
        this.#update_probe_hover(null);
        this.#last_hover_bbox = null;
        this.layers.overlay.clear();
        this.draw();
    }

    #update_probe_hover(next: PinInstance | null) {
        if (next === this.#last_probe) return;
        const previous = this.#last_probe;
        this.#last_probe = next;
        if (previous) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "leave",
                    source: "pin",
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
                    source: "pin",
                    number: next.number,
                    index: next.index,
                    crossIndex: next.cross_index,
                }),
            );
        }
    }

    /**
     * Where to draw a pin's cross-probe highlight.
     *
     * Measured from the painted geometry, which is also what picking searches.
     * A highlight that disagreed with picking would mark a pin the reader did
     * not point at, so the two read the same boxes by construction rather than
     * by two computations that have to be kept in step.
     */
    protected override probe_bounds(index: string): BBox[] {
        const matches: BBox[] = [];
        for (const symbol of this.schematic.symbols.values()) {
            const pins =
                this.instance_context?.unit_pins(symbol) ?? symbol.unit_pins;
            for (const pin of pins) {
                if (pin.index !== index) continue;
                const [painted] = this.layers.query_item_bboxes(pin);
                if (painted) matches.push(painted);
            }
        }
        return matches;
    }
    override type: ViewerType = ViewerType.SCHEMATIC;

    get schematic(): KicadSch {
        return this.document;
    }

    get schematic_renderer() {
        return this.renderer as Canvas2DRenderer;
    }

    protected override resolve_overlay_anchor(
        anchor: EcadOverlayAnchor,
    ): ResolvedOverlayAnchor | null {
        let uuid: string | undefined;
        if (anchor.kind === "source-item") {
            uuid = anchor.uuid;
        } else if (anchor.kind === "entity") {
            if (anchor.reference) {
                uuid = this.#instance_context?.find_symbol(
                    anchor.reference,
                )?.uuid;
            } else if (anchor.net) {
                for (const item of this.schematic.items()) {
                    if (item instanceof Label && item.text === anchor.net) {
                        uuid = item.uuid;
                        break;
                    }
                }
            }
        }
        if (!uuid) return null;
        const bounds = this.schematic_renderer.get_item_bbox(uuid);
        return bounds
            ? {
                  point:
                      anchor.kind === "source-item" && anchor.relativePoint
                          ? new Vec2(
                                bounds.x + bounds.w * anchor.relativePoint[0],
                                bounds.y + bounds.h * anchor.relativePoint[1],
                            )
                          : bounds.center,
                  bounds,
                  page: anchor.page ?? this.sch_name,
              }
            : null;
    }

    override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new Canvas2DRenderer(canvas);
        apply_schematic_render_defaults(renderer, this.theme);
        renderer.background_color = Color.gray;
        return renderer;
    }
    public override zoom_fit_top_item() {
        const layer_names = [
            LayerNames.symbol_foreground,
            LayerNames.symbol_background,
            LayerNames.symbol_pin,
            LayerNames.wire,
            LayerNames.label,
            LayerNames.junction,
            LayerNames.notes,
        ];

        const bboxes: BBox[] = [];
        for (const layer_name of layer_names) {
            const layer = this.layers.by_name(layer_name);
            if (layer && layer.bboxes.size > 0) {
                bboxes.push(layer.bbox);
            }
        }

        if (bboxes.length > 0) {
            this.viewport.camera.bbox = BBox.combine(bboxes).grow(10);
        } else if (!this.document.is_converted_from_ad) {
            this.viewport.camera.bbox = get_sch_bbox(
                this.theme,
                this.document,
                this.#instance_context,
            ).grow(10);
        } else {
            this.viewport.camera.bbox =
                this.schematic_renderer.scene_bbox.grow(10);
        }
        this.draw();
    }

    public zoom_fit_item(uuid: string) {
        const bbox = this.schematic_renderer.get_item_bbox(uuid);
        if (bbox) {
            this.viewport.camera.bbox = bbox.grow(20);
            this.draw();
            this.paint_selected(bbox);
        }
    }

    public override set_active(active: boolean) {
        super.set_active(active);
        if (active && this.#selected_bbox) {
            this.paint_selected(this.#selected_bbox);
        }
    }

    protected override create_painter() {
        return new SchematicPainter(
            this.renderer,
            this.layers,
            this.theme,
            this.#instance_context,
        );
    }

    protected override create_layer_set() {
        return new LayerSet(this.theme);
    }

    protected paint_selected(selected: BBox | null) {
        this.#selected_bbox = selected;
        const layer = this.layers.selection_bg;

        layer.clear();

        if (selected) {
            const color = new Color(0.1, 0.2, 1, 0.2);
            this.renderer.start_layer(layer.name);

            this.renderer.line(
                Polyline.from_BBox(
                    selected,
                    SchematicViewer.InterActiveBBoxLineWidth,
                    color,
                ),
            );

            this.renderer.polygon(Polygon.from_BBox(selected, color));

            layer.graphics = this.renderer.end_layer();

            layer.graphics.composite_operation = "source-over";
        }

        this.paint_erc();

        this.draw();
    }

    public clear_selection() {
        this.paint_selected(null);
    }

    #erc_data?: Array<{ uuid: string; pins: PinCheckResult[] }>;

    public show_erc(uuid: string, pins: PinCheckResult[]) {
        this.#erc_data = [{ uuid, pins }];
        this.zoom_fit_item(uuid);
        // zoom_fit_item calls paint_selected, which now calls paint_erc
    }

    public show_erc_multi(
        erc_items: Array<{ uuid: string; pins: PinCheckResult[] }>,
    ) {
        if (erc_items.length === 0) {
            return;
        }
        this.#erc_data = erc_items;

        const bboxes: BBox[] = [];
        for (const erc_item of erc_items) {
            const bbox = this.schematic_renderer.get_item_bbox(erc_item.uuid);
            if (bbox) {
                bboxes.push(bbox);
            }
        }

        if (bboxes.length > 0) {
            const combined_bbox = BBox.combine(bboxes);
            this.viewport.camera.bbox = combined_bbox.grow(20);
            this.draw();
            this.paint_selected(combined_bbox);
        }
    }

    protected paint_erc() {
        const layer = this.layers.by_name(LayerNames.erc)!;
        layer.clear();

        if (!this.#erc_data || this.#erc_data.length === 0) {
            return;
        }

        this.renderer.start_layer(layer.name);

        const font = StrokeFont.default();

        for (const erc_item of this.#erc_data) {
            const { uuid, pins } = erc_item;
            // Verify the item is still in the document
            const symbol = this.#instance_context?.find_symbol(uuid);
            if (!symbol) {
                continue;
            }

            const transform = get_symbol_transform(symbol);
            const matrix = transform.matrix;
            const symbol_pos = symbol.at.position;

            for (const pin_err of pins) {
                // Find pin in symbol
                // symbol.pins contains PinInstance
                const pin_inst = symbol.pins.find(
                    (p) => p.number == pin_err.pin_num,
                );
                if (!pin_inst) continue;

                // pin_inst.definition returns PinDefinition directly (from LibSymbol.pin_by_number)
                const pin_def = pin_inst.definition;
                const pin_pos = symbol_pos.add(
                    matrix.transform(pin_def.at.position),
                );

                const severity_color =
                    pin_err.severity == "error"
                        ? (this.theme.erc_error ?? new Color(1, 0, 0))
                        : (this.theme.erc_warning ?? new Color(1, 0.6, 0));

                // Draw marker polygon (KiCad's distinctive arrow-like shape)
                // Shape coordinates from KiCad's marker_base.cpp MarkerShapeCorners
                // Scaled to fit schematic units
                const markerScale = 0.2;
                const markerShapeCorners = [
                    new Vec2(0, 0),
                    new Vec2(8, 1),
                    new Vec2(4, 3),
                    new Vec2(13, 8),
                    new Vec2(9, 9),
                    new Vec2(8, 13),
                    new Vec2(3, 4),
                    new Vec2(1, 8),
                    new Vec2(0, 0),
                ];

                // Scale and translate the marker shape to pin position
                const markerPoints = markerShapeCorners.map((corner) =>
                    pin_pos.add(corner.mul(markerScale)),
                );

                this.renderer.polygon(
                    new Polygon(markerPoints, severity_color),
                );

                if (pin_err.message) {
                    // Draw text
                    this.renderer.state.push();
                    // Position text slightly offset from pin
                    const text_pos = pin_pos.add(new Vec2(1, -1));

                    const attrs = new TextAttributes();
                    // KiCad StrokeFont expects units in 10000 scale (1mm = 10000IU approx for these internal calcs)
                    // StrokeFont.draw applies a 0.0001 scale transform.
                    // So 1.27mm should be passed as 12700.
                    attrs.size = new Vec2(1.27 * 10000, 1.27 * 10000);
                    attrs.stroke_width = 0.15 * 10000;
                    attrs.color = severity_color;
                    attrs.h_align = "left";
                    attrs.v_align = "bottom";

                    font.draw(
                        this.renderer,
                        pin_err.message,
                        new Vec2(text_pos.x * 10000, text_pos.y * 10000),
                        attrs,
                    );
                    this.renderer.state.pop();
                }
            }
        }

        layer.graphics = this.renderer.end_layer();
        layer.graphics.composite_operation = "source-over";
    }
}
