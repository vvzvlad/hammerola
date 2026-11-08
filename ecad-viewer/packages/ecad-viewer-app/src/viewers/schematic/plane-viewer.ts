/*
    The schematic tab's viewer: every sheet instance of the project on one
    plane, drawn through one camera.

    Each instance is a scene of its own, a hidden schematic viewer framed by
    the project's drawing sheet with that instance's number and path, built
    once and held for the plane's life (`SchematicInsetProvider`), so a file
    used twice shows each instance's own references. The sheets stand in
    rows by their paper (`plane.ts`), so the layout, and the camera Fit sets,
    are known before any scene is built; scenes are built one after another,
    and a sheet still being built is an empty cell under its name.

    A frame draws, over the background, every sheet whose cell is on
    screen, each through the camera moved by its sheet's offset; then the
    sheets' names, the chains (`chains.ts`), the selection and hover boxes,
    the base viewer's overlays (comment marks, the comment area being
    drawn), and last, with the `ecadPerfLog` flag, a frame counter
    (`frame-meter.ts`). Gestures, clicks, the comment area and insets come
    from the base viewer, so they work here as on one sheet.

    What is under a point is on the sheet whose paper holds it, in that
    sheet's coordinates (the point less the offset); what is reported to the
    element carries the sheet's key. The camera moves on a gesture and when
    asked (`show_sheet`, `show_point`, `show_item`, Fit), never by itself. A
    cross-probe to a sheet whose scene is not built yet waits for it; any
    camera move, a click the plane takes (`on_click`, `select_at`) and
    `clear_selection` drop the wait.
*/

import { BBox, Matrix3, Vec2 } from "../../base/math";
import type { Renderer } from "../../graphics";
import { Canvas2DRenderer } from "../../graphics/canvas2d";
import type { SchematicTheme } from "../../kicad";
import {
    PinInstance,
    SchematicSymbol,
    item_hyperlink,
} from "../../kicad/schematic";
import {
    SchematicInsetProvider,
    type SchematicInsetHost,
    type SchematicInsetPage,
    type SchematicPageView,
} from "../../ecad-viewer/insets/schematic-provider";
import { Chains } from "../../ecad-viewer/net-tracking/chains";
import {
    net_instance_at,
    traceable_uuid,
    type NetInstance,
    type NetInstancePage,
} from "../../ecad-viewer/net-tracking/net-graph";
import {
    TITLE_GAP,
    TITLE_SPACE,
    paint_connection,
    paint_endpoint,
    paint_hover,
    paint_selection,
    paint_title,
    read_tokens,
    type Tokens,
} from "../../ecad-viewer/net-tracking/paint";
import {
    KiCanvasProbeEvent,
    KiCanvasSelectEvent,
    LinkClickEvent,
    select_modifiers,
} from "../base/events";
import { isEcadPerfLogEnabled } from "../../kicanvas/perf_log";
import { ViewLayerSet } from "../base/view-layers";
import { Viewer, ViewerType, type ViewerInteraction } from "../base/viewer";
import { count_frame, type FrameMeter } from "./frame-meter";
import type { SchematicNetMembers } from "./net-highlight";
import { sheet_body_bbox } from "./painter";
import {
    fit_box,
    fit_zoom,
    plane_box,
    plane_slots,
    slot_at,
    slot_rect,
    zoom_floor,
    type PlaneSlot,
} from "./plane";
import { apply_schematic_render_defaults } from "./render-state";

/** A sheet instance on the plane, and its scene once built. */
export interface PlaneSheet extends PlaneSlot<NetInstancePage> {
    view: SchematicPageView | null;
    /** Why its scene was not built; null while building and once built. */
    error: string | null;
}

/** What the plane shows: the project's sheet instances, and what scenes read. */
export interface PlaneSource {
    pages: readonly NetInstancePage[];
    host: SchematicInsetHost;
}

/** What a point on the plane is on. */
interface PlaneHit {
    sheet: PlaneSheet;
    /** The point in the sheet's own coordinates. */
    local: Vec2;
    item: unknown;
    /** The item's box on its sheet, as a click outlines it. */
    bbox: BBox | null;
}

/** A frame around an item is this much (mm) larger than the item. */
const ITEM_MARGIN = 20;

const overlaps = (a: BBox, b: BBox) =>
    a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y;

export class PlaneViewer extends Viewer {
    override type: ViewerType = ViewerType.SCHEMATIC;

    #pages: NetInstancePage[] = [];
    #sheets: PlaneSheet[] = [];
    #provider: SchematicInsetProvider | null = null;
    #unsubscribe: (() => void) | null = null;
    /** The load the scenes being built belong to. */
    #ticket = 0;
    #nets: readonly SchematicNetMembers[] = [];
    #chains = new Chains();
    #tokens: Tokens | null = null;
    #hover: { sheet: PlaneSheet; box: BBox } | null = null;
    #selected: { sheet: PlaneSheet; box: BBox } | null = null;
    #probe: PinInstance | null = null;
    /** A cross-probe waiting for its sheet's scene. */
    #pending: { key: string; run: () => void } | null = null;
    #seen_size: Vec2 | null = null;
    #seen_camera: { x: number; y: number; zoom: number } | null = null;
    /** The frame counter's readout is drawn only with the `ecadPerfLog` flag. */
    readonly #metered = isEcadPerfLogEnabled();
    #meter: FrameMeter | null = null;

    constructor(
        canvas: HTMLCanvasElement,
        interaction: ViewerInteraction,
        public theme: SchematicTheme,
    ) {
        super(canvas, interaction);
    }

    override async setup() {
        const setup = super.setup();
        // The overlays' layers. The plane paints no document that would
        // bring them, so they are made here: once the renderer the overlays
        // draw with exists (the base setup makes it before its first wait),
        // and before the barrier the element's first overlays follow opens.
        this.layers = this.disposables.add(new ViewLayerSet());
        await setup;
    }

    override dispose() {
        this.#ticket++;
        this.#pending = null;
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#provider?.dispose();
        this.#provider = null;
        super.dispose();
    }

    protected override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new Canvas2DRenderer(canvas);
        apply_schematic_render_defaults(renderer, this.theme);
        // As a sheet's viewer paints it (`DocumentViewer.paint`).
        renderer.background_color = this.theme.background;
        return renderer;
    }

    /** The sheet instances in the plane's order, with their places. */
    get sheets(): readonly PlaneSheet[] {
        return this.#sheets;
    }

    /** The sheet instances as the element gave them (for nets). */
    get pages(): readonly NetInstancePage[] {
        return this.#pages;
    }

    sheet(key: string): PlaneSheet | undefined {
        return this.#sheets.find((sheet) => sheet.page.key === key);
    }

    /**
     * Show `pages`. The same sheets (key and document) only redraw; others
     * replace the scenes, the chains and the selection. Resolves once the
     * layout and the camera are set, without waiting for the scenes.
     */
    override async load(source: PlaneSource) {
        await this.setup_finished;
        if (this.disposables.isDisposed) return;
        const { pages, host } = source;
        const same =
            this.#provider !== null &&
            pages.length === this.#pages.length &&
            pages.every(
                (page, i) =>
                    page.key === this.#pages[i]!.key &&
                    page.document === this.#pages[i]!.document,
            );
        if (same) {
            this.draw();
            return;
        }

        const ticket = ++this.#ticket;
        this.#unsubscribe?.();
        this.#provider?.dispose();
        this.#chains.clear();
        this.#selected = null;
        this.#hover = null;
        this.#probe = null;
        this.#pending = null;
        this.#pages = [...pages];
        this.#sheets = plane_slots(pages).map((slot) => ({
            ...slot,
            view: null,
            error: null,
        }));
        const scene_pages: SchematicInsetPage[] = this.#sheets.map(
            ({ page }) => ({
                key: page.key,
                name: page.name,
                document: page.document,
                context: page.context,
            }),
        );
        const provider = new SchematicInsetProvider(
            { ...host, pages: () => scene_pages },
            Math.max(1, scene_pages.length),
            true,
        );
        provider.set_highlighted_nets(this.#nets);
        this.#unsubscribe = provider.subscribe(() => this.draw());
        this.#provider = provider;
        this.#tokens = read_tokens(this.canvas);

        this.renderer.update_canvas_size();
        this.viewport.sync_from_canvas();
        await this.viewport.ready;
        if (ticket !== this.#ticket || this.disposables.isDisposed) return;
        this.renderer.update_canvas_size();
        this.viewport.sync_from_canvas();
        this.zoom_fit_top_item();
        this.resolve_loaded(true);
        void this.#build(ticket, provider);
    }

    /** Build the scenes in the plane's order, a task apart, so each shows as it is ready. */
    async #build(ticket: number, provider: SchematicInsetProvider) {
        for (const sheet of this.#sheets) {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
            if (ticket !== this.#ticket) return;
            try {
                const view = await provider.page_view(sheet.page.key);
                if (ticket !== this.#ticket) {
                    view?.release();
                    return;
                }
                if (view) sheet.view = view;
                else sheet.error = "the sheet has no scene";
            } catch (error) {
                if (ticket !== this.#ticket) return;
                sheet.error =
                    error instanceof Error ? error.message : String(error);
            }
            if (sheet.error)
                console.warn(
                    `Schematic plane: sheet ${sheet.page.key} failed to draw: ${sheet.error}`,
                );
            if (this.#pending?.key === sheet.page.key) this.#pending.run();
            this.draw();
        }
    }

    /** Paint every scene again (the project's settings changed). */
    override paint() {
        this.#provider?.repaint();
    }

    set_variant(name: string | null) {
        this.#provider?.set_variant(name);
    }

    get highlighted_nets(): readonly SchematicNetMembers[] {
        return this.#nets;
    }

    /** The nets drawn over the schematic: every sheet's scene draws them. */
    set_highlighted_nets(nets: readonly SchematicNetMembers[]) {
        this.#nets = nets;
        this.#provider?.set_highlighted_nets(nets);
    }

    // --- Chains ----------------------------------------------------------

    /**
     * A double-click on the label, sheet entry or power symbol `uuid` of the
     * sheet `page`: its net's chain goes when drawn, else is added. The
     * camera stays. False when nothing changed.
     */
    toggle_chain(page: string, uuid: string): boolean {
        const from = net_instance_at(this.#pages, page, uuid);
        if (!from || !this.#chains.toggle(this.#pages, from)) return false;
        this.draw();
        return true;
    }

    /** Where `at` is on the plane, once its sheet's scene is built. */
    #place(at: NetInstance): Vec2 | null {
        const sheet = this.sheet(at.page);
        const box = sheet?.view?.item_bbox(at.uuid);
        return sheet && box ? box.center.add(sheet.offset) : null;
    }

    // --- Camera ----------------------------------------------------------

    /** The zoom showing `box` whole, with room above it for the names. */
    #fit(box: BBox) {
        const camera = this.viewport?.camera;
        if (!camera) return false;
        const zoom = fit_zoom(box, camera.fit_viewport_size, TITLE_SPACE);
        if (!Number.isFinite(zoom) || zoom <= 0) return false;
        camera.bbox = fit_box(box, zoom, TITLE_SPACE);
        return true;
    }

    /** Fit: the whole plane. */
    override zoom_fit_top_item() {
        this.#pending = null;
        const box = plane_box(this.#sheets);
        if (!box || !this.#fit(box)) return;
        this.#update_floor();
        this.notify_viewport_change();
        this.draw();
    }

    override get fit_zoom(): number {
        const box = plane_box(this.#sheets);
        const camera = this.viewport?.camera;
        if (!box || !camera) return super.fit_zoom;
        const zoom = fit_zoom(box, camera.fit_viewport_size, TITLE_SPACE);
        return Number.isFinite(zoom) && zoom > 0 ? zoom : super.fit_zoom;
    }

    /** The sheet `key` whole. */
    show_sheet(key: string): boolean {
        const sheet = this.sheet(key);
        if (!sheet) return false;
        this.#pending = null;
        if (!this.#fit(slot_rect(sheet))) return false;
        this.notify_viewport_change();
        this.draw();
        return true;
    }

    /**
     * The point `x`,`y` of the sheet `key` (its own coordinates) in the
     * middle, at no less than the zoom showing that sheet whole.
     */
    show_point(key: string, x: number, y: number): boolean {
        const sheet = this.sheet(key);
        const camera = this.viewport?.camera;
        if (!sheet || !camera) return false;
        this.#pending = null;
        const whole = fit_zoom(
            slot_rect(sheet),
            camera.fit_viewport_size,
            TITLE_SPACE,
        );
        if (Number.isFinite(whole) && camera.zoom < whole) camera.zoom = whole;
        const at = new Vec2(x, y).add(sheet.offset);
        const centre = camera.fit_viewport_center;
        camera.center.set(
            at.x + (camera.viewport_size.x / 2 - centre.x) / camera.zoom,
            at.y + (camera.viewport_size.y / 2 - centre.y) / camera.zoom,
        );
        this.notify_viewport_change();
        this.draw();
        return true;
    }

    /**
     * Frame and select the first of `uuids` found on the sheet `key`, as a
     * double-click on a part does; a sheet symbol is framed by its body. A
     * sheet whose scene is still being built is waited for; one whose scene
     * failed is shown whole. False when none of them is on the sheet.
     */
    show_item(key: string, uuids: readonly string[]): boolean {
        const sheet = this.sheet(key);
        if (!sheet) return false;
        this.#pending = null;
        if (!sheet.view) {
            if (sheet.error) return this.show_sheet(key);
            this.#pending = { key, run: () => this.show_item(key, uuids) };
            return true;
        }
        for (const uuid of uuids) {
            const symbol = sheet.page.document.sheets.find(
                (it) => it.uuid === uuid,
            );
            const box = symbol
                ? sheet_body_bbox(symbol)
                : sheet.view.item_bbox(uuid);
            if (box) {
                this.#frame_item(sheet, box);
                return true;
            }
        }
        return false;
    }

    /** Select `box` of `sheet` and put the camera on it. */
    #frame_item(sheet: PlaneSheet, box: BBox) {
        this.#selected = { sheet, box };
        const camera = this.viewport?.camera;
        if (camera) {
            camera.bbox = new BBox(
                box.x + sheet.offset.x,
                box.y + sheet.offset.y,
                box.w,
                box.h,
            ).grow(ITEM_MARGIN);
            this.notify_viewport_change();
        }
        this.draw();
    }

    /**
     * How far the gestures zoom out: see `zoom_floor`. Set on a Fit and when
     * the canvas changes size.
     */
    #update_floor() {
        this.viewport.set_zoom_range(this.#floor(), Viewer.MaxZoom);
    }

    protected override on_viewport_change() {
        const camera = this.viewport?.camera;
        if (camera) {
            const size = camera.viewport_size;
            if (
                !this.#seen_size ||
                size.x !== this.#seen_size.x ||
                size.y !== this.#seen_size.y
            ) {
                this.#seen_size = size.copy();
                this.#update_floor();
            }
            const seen = this.#seen_camera;
            const { x, y } = camera.center;
            if (
                !seen ||
                seen.x !== x ||
                seen.y !== y ||
                seen.zoom !== camera.zoom
            ) {
                this.#seen_camera = { x, y, zoom: camera.zoom };
                // A camera moved by a gesture or by a request: a waiting
                // cross-probe would pull it away again.
                this.#pending = null;
            }
        }
        super.on_viewport_change();
    }

    #zoom(factor: number) {
        const camera = this.viewport?.camera;
        if (!camera) return;
        camera.zoom = Math.min(
            Viewer.MaxZoom,
            Math.max(camera.zoom * factor, this.#floor()),
        );
        this.notify_viewport_change();
        this.draw();
    }

    #floor() {
        return zoom_floor(Viewer.MinZoom, this.fit_zoom, this.viewport.camera.zoom);
    }

    override zoom_in() {
        this.#zoom(Math.exp(0.015));
    }

    override zoom_out() {
        this.#zoom(Math.exp(-0.015));
    }

    override move(_pos: Vec2) {}

    // --- Selection -------------------------------------------------------

    /** Drop the selection box and a waiting cross-probe. */
    clear_selection() {
        this.#pending = null;
        this.#selected = null;
        this.draw();
    }

    // --- Pointer ---------------------------------------------------------

    /** The sheet under the plane point `pos`, and what on it is there. */
    #hit(pos: Vec2): PlaneHit | null {
        const sheet = slot_at(this.#sheets, pos);
        if (!sheet) return null;
        const local = pos.sub(sheet.offset);
        const found = sheet.view?.item_at(local) ?? { item: null, bbox: null };
        return { sheet, local, item: found.item, bbox: found.bbox };
    }

    override on_hover(pos: Vec2) {
        const hit = this.#hit(pos);
        const item = hit?.item ?? null;
        this.#update_probe(
            hit && item instanceof PinInstance && item.number.trim()
                ? { sheet: hit.sheet, pin: item }
                : null,
        );
        // An embedded hyperlink shows it can be clicked.
        const cursor = item_hyperlink(item) ? "pointer" : "";
        if (this.canvas.style.cursor !== cursor)
            this.canvas.style.cursor = cursor;
        const box = hit?.bbox ?? null;
        if (box === (this.#hover?.box ?? null)) return;
        this.#hover = hit && box ? { sheet: hit.sheet, box } : null;
        this.draw();
    }

    protected override on_pointer_leave() {
        this.#update_probe(null);
        this.canvas.style.cursor = "";
        if (!this.#hover) return;
        this.#hover = null;
        this.draw();
    }

    #update_probe(next: { sheet: PlaneSheet; pin: PinInstance } | null) {
        if ((next?.pin ?? null) === this.#probe) return;
        const previous = this.#probe;
        this.#probe = next?.pin ?? null;
        if (previous)
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "leave",
                    source: "pin",
                    number: previous.number,
                    index: previous.index,
                    crossIndex: previous.cross_index,
                }),
            );
        if (next)
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "hover",
                    source: "pin",
                    number: next.pin.number,
                    index: next.pin.index,
                    crossIndex: next.pin.cross_index,
                    ...this.#pin_identity(next.sheet, next.pin),
                }),
            );
    }

    /** A pin's designator and painted centre on the plane, for insets. */
    #pin_identity(sheet: PlaneSheet, pin: PinInstance) {
        const box = sheet.view?.item_box(pin) ?? pin.bbox;
        return {
            reference:
                sheet.page.context?.reference(pin.parent) ??
                pin.parent.reference,
            anchor: {
                x: box.x + box.w / 2 + sheet.offset.x,
                y: box.y + box.h / 2 + sheet.offset.y,
            },
        };
    }

    override on_click(pos: Vec2, event?: MouseEvent) {
        // The reader's own pick wins over a cross-probe still waiting.
        this.#pending = null;
        const hit = this.#hit(pos);
        const item = hit?.item ?? null;
        const modifiers = select_modifiers(event);
        // Shift-click toggles an item's net in the host's highlight set; on
        // an empty place it does nothing, so it never clears that set.
        if (modifiers?.shift && !item) return;
        const operation = modifiers?.shift ? "toggle" : "replace";

        if (hit && item instanceof PinInstance && item.number.trim()) {
            this.dispatchEvent(
                new KiCanvasProbeEvent({
                    phase: "activate",
                    source: "pin",
                    number: item.number,
                    index: item.index,
                    crossIndex: item.cross_index,
                    ...this.#pin_identity(hit.sheet, item),
                }),
            );
        } else {
            this.dispatchEvent(new KiCanvasProbeEvent({ phase: "clear" }));
        }

        if (hit && item) {
            const link = item_hyperlink(item);
            // A click follows a link; `select_at` (the host's right click),
            // which comes without a click event, selects the text.
            if (link && event) {
                this.dispatchEvent(new LinkClickEvent(link, hit.sheet.page.key));
                return;
            }
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item,
                    previous: null,
                    intent: "select",
                    operation,
                    modifiers,
                    page: hit.sheet.page.key,
                }),
            );
        } else {
            // An empty place: the host deselects.
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
        this.#selected =
            hit && item && hit.bbox ? { sheet: hit.sheet, box: hit.bbox } : null;
        this.draw();
    }

    override on_dblclick(pos: Vec2) {
        const hit = this.#hit(pos);
        const item = hit?.item ?? null;
        // A label, sheet entry or power symbol: the element toggles its
        // chain (`toggle_chain`); a sheet entry before its sheet symbol.
        if (hit && traceable_uuid(item)) {
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item,
                    previous: null,
                    intent: "trace",
                    page: hit.sheet.page.key,
                }),
            );
            return;
        }
        // Inside a sheet symbol, its name and file among it: the sheet it
        // places, whole.
        if (hit) {
            const symbol = hit.sheet.page.document.sheets.find(
                (it) => it.sheetfile && it.bbox.contains_point(hit.local),
            );
            if (symbol) {
                const child = this.#sheets.find(
                    (sheet) =>
                        sheet.page.parent_key === hit.sheet.page.key &&
                        sheet.page.sheet_uuid === symbol.uuid,
                );
                if (child) this.show_sheet(child.page.key);
                return;
            }
        }
        // A part or its pin: the camera on it.
        if (
            hit?.sheet.view &&
            (item instanceof SchematicSymbol || item instanceof PinInstance)
        ) {
            const uuid = (item as { uuid?: string }).uuid;
            const box =
                (uuid ? hit.sheet.view.item_bbox(uuid) : undefined) ??
                hit.bbox;
            if (box) this.#frame_item(hit.sheet, box);
            return;
        }
        // Anything else, a wire, text, blank paper or the space between
        // sheets: every chain goes.
        if (this.#chains.clear()) this.draw();
    }

    // --- Drawing ---------------------------------------------------------

    /** `box` of `sheet` (its own coordinates) on screen, in CSS pixels. */
    #screen_box(sheet: PlaneSheet, box: BBox, matrix: Matrix3) {
        const { x, y } = sheet.offset;
        return BBox.from_points([
            matrix.transform(new Vec2(box.x + x, box.y + y)),
            matrix.transform(new Vec2(box.x2 + x, box.y2 + y)),
        ]);
    }

    protected override on_draw() {
        const started = performance.now();
        const renderer = this.renderer as Canvas2DRenderer;
        renderer.clear_canvas();
        const ctx = renderer.ctx2d;
        const tokens = this.#tokens;
        if (ctx && tokens) this.#draw_plane(ctx, tokens);
        this.draw_overlays();
        if (!this.#metered || !ctx) return;
        this.#meter = count_frame(
            this.#meter,
            started,
            performance.now() - started,
        );
        this.#paint_meter(ctx, this.#meter);
    }

    /**
     * The frame counter in the top left corner: frames in the last second
     * and the fewest in a whole second of the latest pan; the latest frame's
     * time and the longest of that pan.
     */
    #paint_meter(ctx: CanvasRenderingContext2D, meter: FrameMeter) {
        const ms = (t: number) => `${t.toFixed(1)} ms`;
        const lines = [
            `${meter.recent.length} fps · pan min ${meter.pan?.min ?? "-"}`,
            `${ms(meter.took)} · pan max ${meter.pan ? ms(meter.pan.longest) : "-"}`,
        ];
        const dpr = window.devicePixelRatio || 1;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.font = "12px ui-monospace, monospace";
        ctx.textAlign = "start";
        ctx.textBaseline = "top";
        const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
        ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
        ctx.fillRect(8, 8, width + 12, lines.length * 16 + 8);
        ctx.fillStyle = "#ffffff";
        lines.forEach((line, i) => ctx.fillText(line, 14, 12 + i * 16));
        ctx.restore();
    }

    #draw_plane(ctx: CanvasRenderingContext2D, tokens: Tokens) {
        const camera = this.viewport.camera;
        const matrix = camera.matrix;
        const zoom = camera.zoom;
        const dpr = window.devicePixelRatio || 1;
        const view = camera.bbox;
        const above = TITLE_SPACE / zoom;
        const shown = this.#sheets.filter((sheet) => {
            const paper = slot_rect(sheet);
            const cell = new BBox(
                paper.x,
                paper.y - above,
                paper.w,
                paper.h + above,
            );
            return overlaps(cell, view);
        });

        for (const sheet of shown) {
            if (!sheet.view) continue;
            const clip = this.#screen_box(sheet, sheet.view.bounds, matrix);
            ctx.save();
            try {
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.beginPath();
                ctx.rect(clip.x, clip.y, clip.w, clip.h);
                ctx.clip();
                sheet.view.render_into(
                    ctx,
                    matrix.multiply(
                        Matrix3.translation(sheet.offset.x, sheet.offset.y),
                    ),
                    dpr,
                );
            } finally {
                ctx.restore();
            }
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        for (const sheet of shown) {
            const paper = this.#screen_box(sheet, sheet.paper, matrix);
            paint_title(
                ctx,
                tokens,
                sheet.page.name,
                new Vec2(paper.x, paper.y - TITLE_GAP),
            );
            if (sheet.error) {
                ctx.font = `11px ${tokens.font}`;
                ctx.fillStyle = tokens.muted;
                ctx.textAlign = "start";
                ctx.textBaseline = "top";
                ctx.fillText(
                    `failed to draw: ${sheet.error}`,
                    paper.x + 6,
                    paper.y + 6,
                );
            }
        }

        for (const chain of this.#chains.layout((at) => this.#place(at))) {
            for (const [a, b] of chain.segments)
                paint_connection(
                    ctx,
                    matrix.transform(a),
                    matrix.transform(b),
                    chain.color,
                    zoom,
                );
            for (const mark of chain.marks)
                paint_endpoint(
                    ctx,
                    matrix.transform(mark.at),
                    chain.color,
                    mark.start,
                );
        }

        if (this.#selected)
            paint_selection(
                ctx,
                this.#screen_box(
                    this.#selected.sheet,
                    this.#selected.box,
                    matrix,
                ),
            );
        if (this.#hover)
            paint_hover(
                ctx,
                this.#screen_box(this.#hover.sheet, this.#hover.box, matrix),
            );
    }
}
