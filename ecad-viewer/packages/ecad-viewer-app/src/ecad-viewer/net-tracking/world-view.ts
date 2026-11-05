/*
    World view: every sheet a label's net reaches, side by side on one canvas.

    Each sheet is a live scene of its page instance, frame and border grid
    included, placed in one world and drawn through a single camera, so the
    view pans, zooms and drags like a sheet. The sheets stay interactive:
    hovering outlines items, a click selects (Shift+click highlights the
    net), and the host chains in more nets with `chain()`. Everything a click
    picks is reported through the host as a selection on that sheet's page.

    A chain is one label's reach. The first opens the view; each later one is
    added in its own colour, linking sheets already shown and bringing in the
    ones that are not (they join the end of the layout, so nothing on screen
    moves).

    Motion: the view fades in and the camera eases out from what the main
    view was showing to every sheet. Sheets fade in a hop at a time from where
    their chain started; each connection grows from the label it is reached
    from once its sheet is there, the label it reaches ripples once, and then
    the line flows outward until the view closes. A double-click eases into
    that sheet before handing it to the main view; closing fades out.
*/

import { BBox, Camera2, Matrix3, Vec2 } from "../../base/math";
import type { CameraViewportInsets } from "../../base/math/camera2";
import {
    MoveAndZoom,
    type MoveAndZoomOptions,
} from "../../base/dom/move-and-zoom";
import type { SchematicPageView } from "../insets/schematic-provider";
import {
    SHEET_GAP,
    blend_pose,
    connection_curve,
    ease_out,
    world_layout,
    type CameraPose,
} from "./geometry";
import {
    instance_key,
    net_closure,
    type NetInstance,
    type NetInstancePage,
} from "./net-graph";
import {
    CHAIN_COLORS,
    paint_arrowhead,
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
    /** Show `page` in the main view, framing `uuid` when given. */
    open_page(page: string, uuid?: string): void;
    /** A click on a sheet: report it as a selection on that page. */
    select(
        view: SchematicPageView,
        item: unknown | null,
        modifiers: { shift: boolean },
    ): void;
    background(): string;
    /** The main view's navigation settings and fit insets, to match it. */
    navigation(): MoveAndZoomOptions | undefined;
    insets(): Partial<CameraViewportInsets> | null;
    /** What the main view shows (page and world box), to ease out from. */
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
    opened_at: number;
    depth: Map<string, number>;
}

interface CameraMove {
    from: CameraPose;
    to: CameraPose;
    start: number;
    duration: number;
    then?: () => void;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 100;
/** One hop's sheets start this long after the previous hop's. */
const HOP_DELAY = 200;
/** A sheet fades in over this long; its connection then grows over this long. */
const SHEET_MS = 360;
const LINE_MS = 440;
const FADE_MS = 160;
const OPEN_MS = 520;
const REFRAME_MS = 420;
const ENTER_MS = 320;
/** A press that moves further than this is a drag, not a click. */
const CLICK_SLOP = 4;

export class WorldView {
    #root: HTMLElement | null = null;
    #sheets_canvas: HTMLCanvasElement | null = null;
    #marks_canvas: HTMLCanvasElement | null = null;
    #camera = new Camera2();
    #move: CameraMove | null = null;
    #pan: MoveAndZoom | null = null;
    #observer: ResizeObserver | null = null;
    #unsubscribe: (() => void) | null = null;
    #sheets = new Map<string, Sheet>();
    #order: string[] = [];
    #cols = 1;
    #chains: Chain[] = [];
    #tokens: Tokens | null = null;
    #frame: number | null = null;
    #sheets_dirty = true;
    #ticket = 0;
    #touched = false;
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
        return this.#chains.some(
            (chain) =>
                instance_key(chain.from) === key ||
                chain.reached.some((it) => instance_key(it) === key),
        );
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
        this.#touched = false;
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
            () => {
                // A hand on the camera ends any eased move and any refit.
                this.#touched = true;
                this.#move = null;
                this.invalidate();
            },
            MIN_ZOOM,
            MAX_ZOOM,
            undefined,
            () => !this.#closing,
            this.host.navigation(),
        );
        this.#listen(sheets_canvas);
        this.#unsubscribe = this.host.subscribe(() => this.invalidate());
        this.#observer = new ResizeObserver(() => {
            this.#resize();
            // Until the view is moved by hand, it keeps every sheet framed
            // as the panels around it open and close.
            if (!this.#touched && !this.#move) {
                this.#camera.fit_insets = this.host.insets();
                this.#set_pose(this.#fit_pose());
            }
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
        if (!this.#touched) this.#ease_to(this.#fit_pose(), REFRAME_MS);
        this.invalidate();
        return true;
    }

    /** Fade out, then let go of every scene. */
    close() {
        if (!this.#root || this.#closing) return;
        this.#closing = true;
        const ticket = this.#ticket;
        this.#root.style.opacity = "0";
        window.setTimeout(() => {
            if (ticket === this.#ticket) this.#dispose();
        }, FADE_MS);
    }

    #dispose() {
        this.#ticket++;
        this.#closing = false;
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#move = null;
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
        // The first chain needs somewhere to go; a later one may stay on
        // sheets already shown.
        if (first && keys.length < 2) return false;
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
            links: links.filter(
                ([a, b]) =>
                    a.page !== b.page &&
                    this.#sheets.has(a.page) &&
                    this.#sheets.has(b.page),
            ),
            reached: instances,
            color: CHAIN_COLORS[this.#chains.length % CHAIN_COLORS.length]!,
            opened_at: now,
            depth,
        });
        return true;
    }

    /** When a connection to `to` in `chain` starts to grow. */
    #landing(chain: Chain, to: NetInstance) {
        const target = this.#sheets.get(to.page);
        const hop = chain.depth.get(instance_key(to)) ?? 1;
        return Math.max(
            chain.opened_at + Math.max(0, hop - 1) * HOP_DELAY,
            target?.appear_at ? target.appear_at + SHEET_MS : 0,
        );
    }

    // --- Camera --------------------------------------------------------

    #pose(): CameraPose {
        return { center: this.#camera.center.copy(), zoom: this.#camera.zoom };
    }

    #set_pose(pose: CameraPose) {
        this.#camera.center = pose.center.copy();
        this.#camera.zoom = pose.zoom;
    }

    /** The pose that frames `box` (world units), without moving there. */
    #pose_for(box: BBox): CameraPose {
        const here = this.#pose();
        this.#camera.bbox = box;
        const there = this.#pose();
        this.#set_pose(here);
        return there;
    }

    #fit_pose(): CameraPose {
        return this.#pose_for(
            BBox.combine(
                [...this.#sheets.values()].map((sheet) =>
                    this.#world_rect(sheet),
                ),
            ).grow(SHEET_GAP / 2),
        );
    }

    /**
     * Open where the main view was looking: on the starting sheet, framed as
     * the main view framed it, then ease out to every sheet.
     */
    #open_camera(from: NetInstance) {
        const fit = this.#fit_pose();
        const main = this.host.main_view();
        const sheet = this.#sheets.get(main?.page ?? from.page);
        if (!main || !sheet || main.page !== sheet.view.key) {
            this.#set_pose(fit);
            return;
        }
        const b = sheet.view.bounds;
        const box = new BBox(
            main.box.x - b.x + sheet.offset.x,
            main.box.y - b.y + sheet.offset.y,
            main.box.w,
            main.box.h,
        );
        this.#set_pose(this.#pose_for(box));
        this.#ease_to(fit, OPEN_MS);
    }

    #ease_to(to: CameraPose, duration: number, then?: () => void) {
        this.#move = {
            from: this.#pose(),
            to,
            start: performance.now(),
            duration,
            then,
        };
        this.#schedule();
    }

    /** Advance an eased camera move; true while one is running. */
    #step_camera(now: number) {
        const move = this.#move;
        if (!move) return false;
        const t = (now - move.start) / move.duration;
        this.#set_pose(blend_pose(move.from, move.to, t));
        if (t < 1) return true;
        this.#move = null;
        move.then?.();
        return false;
    }

    // --- Drawing -------------------------------------------------------

    #world_rect(sheet: Sheet) {
        const b = sheet.view.bounds;
        return new BBox(sheet.offset.x, sheet.offset.y, b.w, b.h);
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

    /** The connections flow for as long as the view is open. */
    #schedule() {
        if (this.#frame !== null || !this.#root) return;
        this.#frame = requestAnimationFrame((now) => {
            this.#frame = null;
            if (!this.#root) return;
            const moving = this.#step_camera(now);
            if (this.#sheets_dirty || moving || this.#sheets_settling(now)) {
                this.#sheets_dirty = false;
                this.#draw_sheets(now);
            }
            this.#draw_marks(now);
            this.#schedule();
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
            const reached = new Map<string, number>();
            for (const [from, to] of chain.links) {
                const landed = this.#landing(chain, to);
                const grow = ease_out((now - landed) / LINE_MS);
                if (grow <= 0) continue;
                const a = this.#instance_point(from);
                const b = this.#instance_point(to);
                if (!a || !b) continue;
                const curve = connection_curve(a, b);
                paint_connection(ctx, curve, {
                    color: chain.color,
                    name: to.name,
                    grow,
                    now,
                    zoom,
                });
                if (grow < 1) continue;
                reached.set(instance_key(to), landed + LINE_MS);
                const end = curve.at(curve.length);
                paint_arrowhead(ctx, end.point, end.angle, chain.color, zoom);
            }
            const start = this.#instance_point(chain.from);
            if (start)
                paint_endpoint(ctx, start, chain.color, {
                    start: true,
                    since: chain.opened_at,
                    now,
                });
            for (const [, to] of chain.links) {
                const since = reached.get(instance_key(to));
                const p = since === undefined ? null : this.#instance_point(to);
                if (p)
                    paint_endpoint(ctx, p, chain.color, {
                        start: false,
                        since: since!,
                        now,
                    });
            }
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
        });
        canvas.addEventListener("pointerleave", () => {
            this.#hover = null;
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
            const hit = this.#hit(event);
            const item = hit?.found.item ?? null;
            const bbox = hit?.found.bbox ?? null;
            this.#selected =
                hit && item && bbox ? { sheet: hit.sheet, box: bbox } : null;
            if (hit)
                this.host.select(hit.sheet.view, item, {
                    shift: event.shiftKey,
                });
        });
        canvas.addEventListener("dblclick", (event) => {
            const hit = this.#hit(event);
            if (!hit || this.#closing) return;
            const key = hit.sheet.view.key;
            const here = this.#chains
                .flatMap((chain) => [chain.from, ...chain.links.flat()])
                .find((it) => it.page === key);
            // Ease into the sheet, then hand it to the main view.
            this.#touched = true;
            this.#ease_to(
                this.#pose_for(this.#world_rect(hit.sheet)),
                ENTER_MS,
                () => {
                    this.host.open_page(key, here?.uuid);
                    this.close();
                },
            );
        });
    }

    /** The sheet and item under a pointer event. */
    #hit(event: MouseEvent) {
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
