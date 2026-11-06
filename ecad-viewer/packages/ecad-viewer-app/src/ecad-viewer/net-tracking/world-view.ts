/*
    World view: every sheet a label's net reaches, side by side on one canvas.

    Each sheet is a live scene of its page instance, frame and border grid
    included, placed in one world and drawn through a single camera, so the
    view pans, zooms and drags like a sheet. The sheets stay interactive:
    hovering outlines items, a click selects (Shift+click highlights the
    net), and a double-click on a label, sheet entry or power symbol is the
    host's to trace (`toggle()`). Everything a click picks, or the host's
    right click (`select_at()`), is reported through the host as a selection
    on that sheet's page.

    A chain is one label's reach, linking it to every namesake it reaches,
    on another sheet or its own (a local label's namesakes are all on its
    own): its places joined by the shortest tree of straight, solid lines in
    the chain's colour, each to a near one, a ring on every label it joins
    and a larger one on the label it starts from. The first opens the view;
    each later one is added in its own colour, linking sheets already shown
    and bringing in the ones that are not (they join the end of the layout,
    so nothing on screen moves). A chain goes again on `toggle()` of any
    label it reaches, and the view closes with the last; its sheets stay.

    Motion: the view fades in with its camera where the main view's is, on
    the starting sheet framed as the main view framed it, and only a pan or a
    zoom moves it after that: a chain added, a resize or a double-click
    leaves it, and a line to a sheet off screen runs off the edge. Sheets
    fade in a hop at a time from where their chain started; a line is drawn
    whole and still once the sheets at both its ends are there, and a ring
    once its own sheet is. Frames are drawn while sheets fade in, and on a
    change. Closing hands the picture to the main view, so nothing on screen
    moves (`hand_over`): Escape, a double-click on an empty place, between
    the sheets or on a sheet's blank paper, and taking away the last chain
    give it the sheet under the middle of the canvas, or the one nearest
    it, and a double-click on any other item that item's sheet; the main
    view shows that sheet where and as large as the view shows it. The
    host's own `close()`, when it moves the main view itself (a page shown,
    a place stepped to), leaves the main view to it. Closing fades out.
*/

import { BBox, Camera2, Matrix3, Vec2 } from "../../base/math";
import type { CameraViewportInsets } from "../../base/math/camera2";
import {
    MoveAndZoom,
    type MoveAndZoomOptions,
} from "../../base/dom/move-and-zoom";
import type { SchematicPageView } from "../insets/schematic-provider";
import { Viewer } from "../../viewers/base/viewer";
import {
    SHEET_GAP,
    ease_out,
    spanning_pairs,
    world_layout,
} from "./geometry";
import {
    instance_key,
    net_closure,
    type NetInstance,
    type NetInstancePage,
} from "./net-graph";
import {
    CHAIN_COLORS,
    paint_connection,
    paint_endpoint,
    paint_hover,
    paint_selection,
    paint_title,
    read_tokens,
    type Tokens,
} from "./paint";

export interface WorldViewHost {
    /** Where the view mounts, over the schematic. */
    container(): ParentNode | null;
    pages(): NetInstancePage[];
    page_view(key: string): Promise<SchematicPageView | null>;
    /** The scenes changed (highlights, variant): call `listener`. */
    subscribe(listener: () => void): () => void;
    /** Show `page` in the main view, its camera on `box` (that sheet's coordinates). */
    open_page(page: string, box: BBox): void;
    /** A click on a sheet: report it as a selection on that page. */
    select(
        view: SchematicPageView,
        item: unknown | null,
        modifiers: { shift: boolean },
    ): void;
    /** A double-click on `item` of a sheet: true when the host traced it. */
    trace(view: SchematicPageView, item: unknown): boolean;
    background(): string;
    /** The main view's navigation settings and fit insets, to match it. */
    navigation(): MoveAndZoomOptions | undefined;
    insets(): Partial<CameraViewportInsets> | null;
    /** What the main view shows (page and world box), to open where it is. */
    main_view(): { page: string; box: BBox } | null;
}

interface Sheet {
    view: SchematicPageView;
    /** World position of the sheet's top-left corner. */
    offset: Vec2;
    /** When it starts fading in (ms, `performance.now()`); 0 is at once. */
    appear_at: number;
}

interface Chain {
    from: NetInstance;
    links: Array<[NetInstance, NetInstance]>;
    reached: NetInstance[];
    color: string;
}

/** Whether `chain` starts at or reaches the instance `key`. */
const holds = (chain: Chain, key: string) =>
    instance_key(chain.from) === key ||
    chain.reached.some((it) => instance_key(it) === key);

/**
 * The links of a chain whose ends are its places: both ends on sheets shown,
 * the two sheets different or the same (a global label's namesake on its own
 * sheet).
 */
export function shown_links(
    links: ReadonlyArray<[NetInstance, NetInstance]>,
    shown: (page: string) => boolean,
): Array<[NetInstance, NetInstance]> {
    return links.filter(([a, b]) => shown(a.page) && shown(b.page));
}

/** One hop's sheets start this long after the previous hop's. */
const HOP_DELAY = 200;
/** A sheet fades in over this long; its connections are drawn after. */
const SHEET_MS = 360;
const FADE_MS = 160;
/** A press that moves further than this is a drag, not a click. */
const CLICK_SLOP = 4;

export class WorldView {
    #root: HTMLElement | null = null;
    #sheets_canvas: HTMLCanvasElement | null = null;
    #marks_canvas: HTMLCanvasElement | null = null;
    #camera = new Camera2();
    #pan: MoveAndZoom | null = null;
    #observer: ResizeObserver | null = null;
    #unsubscribe: (() => void) | null = null;
    #sheets = new Map<string, Sheet>();
    #order: string[] = [];
    #cols = 1;
    #chains: Chain[] = [];
    /** Chains added since the view opened: the next one's colour. */
    #colors = 0;
    #tokens: Tokens | null = null;
    #frame: number | null = null;
    #sheets_dirty = true;
    #ticket = 0;
    #closing = false;
    #hover: { sheet: Sheet; box: BBox } | null = null;
    #selected: { sheet: Sheet; box: BBox } | null = null;
    #press: Vec2 | null = null;

    constructor(private readonly host: WorldViewHost) {}

    get open() {
        return this.#root !== null && !this.#closing;
    }

    /** Whether `at` already starts or is reached by a chain. */
    traced(at: NetInstance) {
        const key = instance_key(at);
        return this.#chains.some((chain) => holds(chain, key));
    }

    /** The scene of `page`, while the view shows it. */
    view(page: string): SchematicPageView | null {
        return this.#sheets.get(page)?.view ?? null;
    }

    /** Something drawn on the sheets changed: redraw them. */
    invalidate() {
        this.#sheets_dirty = true;
        this.#schedule();
    }

    /** Open on the net of the label or sheet entry `from`. */
    async show(from: NetInstance) {
        this.#dispose();
        const container = this.host.container();
        if (!container) return false;
        const ticket = ++this.#ticket;
        this.#mount(container);

        const added = await this.#add_chain(from, ticket, true);
        if (!added || ticket !== this.#ticket) {
            if (ticket === this.#ticket) this.#dispose();
            return false;
        }

        const sheets_canvas = this.#sheets_canvas!;
        this.#camera.fit_insets = this.host.insets();
        this.#resize();
        this.#open_camera(from);
        this.#pan = new MoveAndZoom(
            sheets_canvas,
            this.#camera,
            () => this.invalidate(),
            // The main view's range: the view opens at its zoom and hands
            // its own back on closing, so neither ends up out of range.
            Viewer.MinZoom,
            Viewer.MaxZoom,
            undefined,
            () => !this.#closing,
            this.host.navigation(),
        );
        this.#listen(sheets_canvas);
        this.#unsubscribe = this.host.subscribe(() => this.invalidate());
        this.#observer = new ResizeObserver(() => {
            this.#resize();
            this.invalidate();
        });
        this.#observer.observe(this.#root!);
        requestAnimationFrame(() => {
            if (this.#root) this.#root.style.opacity = "1";
        });
        this.invalidate();
        return true;
    }

    /**
     * Chain in the net of `from`, a label on a sheet already shown: its
     * connections are drawn in the next colour, and sheets it reaches that
     * are not shown yet join the end of the layout. Nothing happens for a
     * label already traced.
     */
    async chain(from: NetInstance) {
        if (!this.open || this.traced(from)) return false;
        const added = await this.#add_chain(from, this.#ticket, false);
        if (!added) return false;
        this.invalidate();
        return true;
    }

    /**
     * A double-click on `from`: open on its net; while open, take away every
     * chain it is in, closing the view with the last of them, or chain its
     * net in when it is in none.
     */
    async toggle(from: NetInstance) {
        if (!this.open) return this.show(from);
        if (!this.traced(from)) return this.chain(from);
        const key = instance_key(from);
        this.#chains = this.#chains.filter((chain) => !holds(chain, key));
        if (this.#chains.length) this.invalidate();
        else this.hand_over();
        return true;
    }

    /**
     * Fade out, then let go of every scene; the main view stays where it is,
     * for a host that moves it itself.
     */
    close() {
        if (!this.#root || this.#closing) return;
        this.#closing = true;
        const ticket = this.#ticket;
        this.#root.style.opacity = "0";
        window.setTimeout(() => {
            if (ticket === this.#ticket) this.#dispose();
        }, FADE_MS);
    }

    /**
     * Close, the main view taking over the picture: the sheet of `page`, by
     * default the one under the middle of the canvas or else the one nearest
     * it, where and as large as the view shows it. The view covers the main
     * view's canvas exactly, so the same box is the same picture.
     */
    hand_over(page?: string) {
        if (!this.open) return;
        const box = this.#camera.bbox;
        const sheet =
            (page !== undefined ? this.#sheets.get(page) : undefined) ??
            this.#sheet_nearest(box.center);
        // Closing first: the host's page switch closes the view as well.
        this.close();
        if (!sheet) return;
        const b = sheet.view.bounds;
        this.host.open_page(
            sheet.view.key,
            new BBox(
                box.x - sheet.offset.x + b.x,
                box.y - sheet.offset.y + b.y,
                box.w,
                box.h,
            ),
        );
    }

    #dispose() {
        this.#ticket++;
        this.#closing = false;
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#pan?.dispose();
        this.#pan = null;
        this.#observer?.disconnect();
        this.#observer = null;
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        for (const sheet of this.#sheets.values()) sheet.view.release();
        this.#sheets.clear();
        this.#order = [];
        this.#chains = [];
        this.#colors = 0;
        this.#hover = null;
        this.#selected = null;
        this.#root?.remove();
        this.#root = null;
        this.#sheets_canvas = null;
        this.#marks_canvas = null;
    }

    #mount(container: ParentNode) {
        const root = document.createElement("div");
        root.className = "world-view";
        Object.assign(root.style, {
            position: "absolute",
            inset: "0",
            zIndex: "20",
            background: this.host.background(),
            opacity: "0",
            transition: `opacity ${FADE_MS}ms ease-out`,
        });
        const sheets_canvas = document.createElement("canvas");
        const marks_canvas = document.createElement("canvas");
        for (const canvas of [sheets_canvas, marks_canvas])
            Object.assign(canvas.style, {
                position: "absolute",
                inset: "0",
                width: "100%",
                height: "100%",
            });
        marks_canvas.style.pointerEvents = "none";
        root.append(sheets_canvas, marks_canvas);
        container.append(root);
        this.#root = root;
        this.#sheets_canvas = sheets_canvas;
        this.#marks_canvas = marks_canvas;
        this.#tokens = read_tokens(root);
    }

    // --- Chains --------------------------------------------------------

    async #add_chain(from: NetInstance, ticket: number, first: boolean) {
        const pages = this.host.pages();
        const { instances, links, depth } = net_closure(pages, from);
        const keys = pages
            .map((page) => page.key)
            .filter((key) => instances.some((it) => it.page === key));
        // The first chain needs a namesake to link to, on another sheet or
        // its own: a net that stays on one sheet opens the view on that sheet.
        if (first && !links.length) return false;
        const fresh = keys.filter((key) => !this.#sheets.has(key));
        const views = await Promise.all(
            fresh.map((key) => this.host.page_view(key)),
        );
        if (ticket !== this.#ticket) {
            for (const view of views) view?.release();
            return false;
        }
        const now = performance.now();
        const sheet_depth = (key: string) =>
            Math.min(
                ...instances
                    .filter((it) => it.page === key)
                    .map((it) => depth.get(instance_key(it)) ?? 0),
            );
        const added = views.filter((view): view is SchematicPageView => !!view);
        if (first) this.#cols = Math.max(1, Math.ceil(Math.sqrt(added.length)));
        for (const view of added) {
            const hops = sheet_depth(view.key);
            this.#sheets.set(view.key, {
                view,
                offset: new Vec2(0, 0),
                appear_at:
                    first && hops === 0
                        ? 0
                        : now + Math.max(0, hops - 1) * HOP_DELAY,
            });
            this.#order.push(view.key);
        }
        const offsets = world_layout(
            this.#order.map((key) => this.#sheets.get(key)!.view.bounds),
            SHEET_GAP,
            this.#cols,
        );
        this.#order.forEach((key, i) => {
            this.#sheets.get(key)!.offset = offsets[i]!;
        });
        this.#chains.push({
            from,
            links: shown_links(links, (page) => this.#sheets.has(page)),
            reached: instances,
            color: CHAIN_COLORS[this.#colors++ % CHAIN_COLORS.length]!,
        });
        return true;
    }

    // --- Camera --------------------------------------------------------

    /**
     * Open where the main view is looking: on the starting sheet, framed as
     * the main view frames it. When the main view shows none of the sheets,
     * open on all of them.
     */
    #open_camera(from: NetInstance) {
        const main = this.host.main_view();
        const sheet = this.#sheets.get(main?.page ?? from.page);
        if (!main || !sheet || main.page !== sheet.view.key) {
            this.#camera.bbox = BBox.combine(
                [...this.#sheets.values()].map((sheet) =>
                    this.#world_rect(sheet),
                ),
            ).grow(SHEET_GAP / 2);
            return;
        }
        const b = sheet.view.bounds;
        this.#camera.bbox = new BBox(
            main.box.x - b.x + sheet.offset.x,
            main.box.y - b.y + sheet.offset.y,
            main.box.w,
            main.box.h,
        );
    }

    // --- Drawing -------------------------------------------------------

    #world_rect(sheet: Sheet) {
        const b = sheet.view.bounds;
        return new BBox(sheet.offset.x, sheet.offset.y, b.w, b.h);
    }

    /** The sheet under the world point `at`, else the one nearest it. */
    #sheet_nearest(at: Vec2): Sheet | undefined {
        let nearest: Sheet | undefined;
        let distance = Infinity;
        for (const sheet of this.#sheets.values()) {
            const d = at.sub(this.#world_rect(sheet).constrain_point(at))
                .magnitude;
            if (d < distance) [nearest, distance] = [sheet, d];
        }
        return nearest;
    }

    /** How far this sheet has faded in (0 to 1) at `now`. */
    #arrival(sheet: Sheet, now: number) {
        if (!sheet.appear_at) return 1;
        return ease_out((now - sheet.appear_at) / SHEET_MS);
    }

    /** Sheet coordinates → screen (CSS pixels). */
    #sheet_matrix(sheet: Sheet, now = performance.now()): Matrix3 {
        const b = sheet.view.bounds;
        // Arriving sheets settle from very slightly smaller.
        const s = 0.97 + 0.03 * this.#arrival(sheet, now);
        return this.#camera.matrix
            .multiply_self(
                Matrix3.translation(
                    sheet.offset.x + (b.w * (1 - s)) / 2,
                    sheet.offset.y + (b.h * (1 - s)) / 2,
                ),
            )
            .multiply_self(Matrix3.scaling(s, s))
            .multiply_self(Matrix3.translation(-b.x, -b.y));
    }

    #screen_box(sheet: Sheet, box: BBox, matrix = this.#sheet_matrix(sheet)) {
        return BBox.from_points([
            matrix.transform(new Vec2(box.x, box.y)),
            matrix.transform(new Vec2(box.x + box.w, box.y + box.h)),
        ]);
    }

    /** Where `at` is in the world, as if its sheet had arrived. */
    #world_point(at: NetInstance): Vec2 | null {
        const sheet = this.#sheets.get(at.page);
        const box = sheet?.view.item_bbox(at.uuid);
        if (!sheet || !box) return null;
        const b = sheet.view.bounds;
        return new Vec2(
            sheet.offset.x + box.center.x - b.x,
            sheet.offset.y + box.center.y - b.y,
        );
    }

    #instance_point(at: NetInstance): Vec2 | null {
        const sheet = this.#sheets.get(at.page);
        const box = sheet?.view.item_bbox(at.uuid);
        return sheet && box ? this.#screen_box(sheet, box).center : null;
    }

    #sheets_settling(now: number) {
        for (const sheet of this.#sheets.values())
            if (sheet.appear_at && now < sheet.appear_at + SHEET_MS)
                return true;
        return false;
    }

    /** Whether the sheet of `page` is shown and has faded in. */
    #there(page: string, now: number) {
        const sheet = this.#sheets.get(page);
        return !!sheet && this.#arrival(sheet, now) >= 1;
    }

    /** Draw a frame, and the next ones while sheets fade in. */
    #schedule() {
        if (this.#frame !== null || !this.#root) return;
        this.#frame = requestAnimationFrame((now) => {
            this.#frame = null;
            if (!this.#root) return;
            const settling = this.#sheets_settling(now);
            if (this.#sheets_dirty || settling) {
                this.#sheets_dirty = false;
                this.#draw_sheets(now);
            }
            this.#draw_marks(now);
            if (settling) this.#schedule();
        });
    }

    #resize() {
        const dpr = window.devicePixelRatio || 1;
        for (const canvas of [this.#sheets_canvas, this.#marks_canvas]) {
            if (!canvas) continue;
            const w = Math.round(canvas.clientWidth * dpr);
            const h = Math.round(canvas.clientHeight * dpr);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
        }
        const canvas = this.#sheets_canvas;
        if (canvas)
            this.#camera.viewport_size = new Vec2(
                canvas.clientWidth,
                canvas.clientHeight,
            );
    }

    #draw_sheets(now: number) {
        const canvas = this.#sheets_canvas;
        const ctx = canvas?.getContext("2d");
        const tokens = this.#tokens;
        if (!canvas || !ctx || !tokens) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = this.host.background();
        ctx.fillRect(0, 0, w, h);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const key of this.#order) {
            const sheet = this.#sheets.get(key)!;
            const alpha = this.#arrival(sheet, now);
            if (alpha <= 0) continue;
            const matrix = this.#sheet_matrix(sheet, now);
            const r = this.#screen_box(sheet, sheet.view.bounds, matrix);
            if (r.x2 < 0 || r.y2 < 0 || r.x > w || r.y > h) continue;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.rect(r.x, r.y, r.w, r.h);
            ctx.clip();
            sheet.view.render_into(ctx, matrix, dpr);
            ctx.restore();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.globalAlpha = alpha;
            paint_title(ctx, tokens, sheet.view.name, new Vec2(r.x, r.y - 6));
            ctx.globalAlpha = 1;
        }
    }

    #draw_marks(now: number) {
        const canvas = this.#marks_canvas;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const zoom = this.#camera.zoom;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

        for (const chain of this.#chains) {
            // Every place the chain links, on any sheet shown, joined by the
            // shortest tree of segments. It is found in world coordinates,
            // which neither the camera nor a sheet fading in moves, so the
            // tree keeps its shape while the view pans and zooms; a segment
            // is drawn once both its sheets are there.
            const places = new Map(
                [chain.from, ...chain.links.flat()].map((it) => [
                    instance_key(it),
                    it,
                ]),
            );
            const marks = [...places.values()].flatMap((it) => {
                const world = this.#world_point(it);
                const at = this.#instance_point(it);
                return world && at ? [{ it, world, at }] : [];
            });
            for (const [i, j] of spanning_pairs(marks.map((m) => m.world))) {
                const a = marks[i]!;
                const b = marks[j]!;
                if (this.#there(a.it.page, now) && this.#there(b.it.page, now))
                    paint_connection(ctx, a.at, b.at, chain.color, zoom);
            }
            for (const { it, at } of marks)
                if (this.#there(it.page, now))
                    paint_endpoint(ctx, at, chain.color, it === chain.from);
        }

        if (this.#selected)
            paint_selection(
                ctx,
                this.#screen_box(this.#selected.sheet, this.#selected.box),
            );
        if (this.#hover)
            paint_hover(
                ctx,
                this.#screen_box(this.#hover.sheet, this.#hover.box),
            );
    }

    // --- Interaction ---------------------------------------------------

    #listen(canvas: HTMLCanvasElement) {
        canvas.addEventListener("pointerdown", (event) => {
            this.#press = new Vec2(event.clientX, event.clientY);
        });
        canvas.addEventListener("pointermove", (event) => {
            const hit = this.#hit(event);
            const box = hit?.found.bbox ?? null;
            if (box === (this.#hover?.box ?? null)) return;
            this.#hover = hit && box ? { sheet: hit.sheet, box } : null;
            this.#schedule();
        });
        canvas.addEventListener("pointerleave", () => {
            this.#hover = null;
            this.#schedule();
        });
        canvas.addEventListener("click", (event) => {
            const press = this.#press;
            this.#press = null;
            if (
                this.#closing ||
                (press &&
                    Math.hypot(
                        event.clientX - press.x,
                        event.clientY - press.y,
                    ) > CLICK_SLOP)
            )
                return;
            this.select_at(event.clientX, event.clientY, event.shiftKey);
        });
        canvas.addEventListener("dblclick", (event) => {
            if (this.#closing) return;
            const hit = this.#hit(event);
            const item = hit?.found.item ?? null;
            // An empty place, between the sheets or on a sheet's blank
            // paper, closes the view on the sheet in the middle.
            if (!hit || !item) {
                this.hand_over();
                return;
            }
            if (this.host.trace(hit.sheet.view, item)) return;
            // Any other item: on that item's sheet.
            this.hand_over(hit.sheet.view.key);
        });
    }

    /**
     * Select what is at the page point `x`,`y` and report it, as a click
     * there does; the host's right click asks this too, so its menu is for
     * what the view shows there, not the main view underneath.
     */
    select_at(x: number, y: number, shift = false) {
        const hit = this.#hit({ clientX: x, clientY: y });
        const item = hit?.found.item ?? null;
        const bbox = hit?.found.bbox ?? null;
        this.#selected =
            hit && item && bbox ? { sheet: hit.sheet, box: bbox } : null;
        this.#schedule();
        if (hit) this.host.select(hit.sheet.view, item, { shift });
    }

    /** The sheet and item under a page point. */
    #hit(event: { clientX: number; clientY: number }) {
        const canvas = this.#sheets_canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        const screen = new Vec2(
            event.clientX - rect.left,
            event.clientY - rect.top,
        );
        for (const sheet of this.#sheets.values()) {
            const local = this.#sheet_matrix(sheet).inverse().transform(screen);
            if (!sheet.view.bounds.contains_point(local)) continue;
            return { sheet, found: sheet.view.item_at(local) };
        }
        return null;
    }
}
