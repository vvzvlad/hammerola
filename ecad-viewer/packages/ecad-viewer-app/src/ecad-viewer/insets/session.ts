/*
    InsetSession: every inset open in one Visualizer.

    Insets form a tree. A root inset hangs off a pin or pad in a main viewer;
    a child hangs off a pad or pin inside its parent inset (chained insets).
    A chain shares one colour, and closing an inset closes its subtree.

    At most one inset is a preview: it follows the hover and is replaced by
    the next one. Pinning keeps it.

    Nothing here runs per frame on its own. Rendering and leader geometry are
    recomputed on the next animation frame after something changed: an inset's
    view, a panel move, or a source viewer's camera (`sources_moved()`).
*/

import { WHEEL_ZOOM_RATE, wheel_gesture } from "../../base/dom/wheel-gesture";
import { BBox, Vec2 } from "../../base/math";
import {
    DEFAULT_TILT,
    MAX_TILT,
    fit_camera,
    inset_to_world,
    pan_by,
    world_to_inset,
    zoom_about,
    type InsetCamera,
} from "./camera";
import { INSET_STYLES, InsetPanel, type InsetAction } from "./panel";
import type {
    InsetHit,
    InsetKind,
    InsetProvider,
    InsetSource,
    InsetTarget,
} from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";

export const CHAIN_COLORS = [
    "#8b5cf6",
    "#0ea5e9",
    "#f97316",
    "#10b981",
    "#ef4444",
    "#eab308",
];

/** At most this many insets are open; the least recently used goes first. */
export const MAX_INSETS = 8;

const ROTATE_STEP = Math.PI / 12;
const WHEEL_ROTATE_STEP = Math.PI / 36;
/**
 * Radians per pixel of a 3D inset's orbit drag: the 3D tab's rate and
 * directions (dragging down brings the view back towards straight down).
 */
const ORBIT_PER_PIXEL = 0.006;

export interface OpenInsetRequest {
    kind: InsetKind;
    reference: string;
    number: string;
    /** Where the leader starts. */
    source: InsetSource;
    /** World point in the source's document (the pin or pad hovered). */
    source_anchor: Vec2;
    /** Chained insets: the inset the source anchor lives in. */
    parent?: Inset;
    /** Previews follow the hover; defaults to true. */
    preview?: boolean;
    /**
     * When the designator is not in the target document, open a header-only
     * "not there" inset instead of nothing.
     */
    show_missing?: boolean;
    /** Panel size in CSS pixels (including the header). */
    size?: { w: number; h: number };
}

export class Inset implements InsetSource {
    readonly children: Inset[] = [];
    pinned = false;
    /** Last interaction (open, hover, toolbar), for the open-inset cap. */
    used = 0;
    /** The designator is not in the target document: header only. */
    missing = false;
    /** The target document is still loading: header only, retried. */
    loading = false;
    /** The pin or pad under the pointer inside this inset (IN-20). */
    hit: InsetHit | null = null;
    /** T was pressed while the 3D board loads: switch once it is ready. */
    want_3d = false;
    readonly target_outline = document.createElementNS(SVG_NS, "polygon");
    readonly hover_outline = document.createElementNS(SVG_NS, "polygon");
    #dirty = true;
    #rendered_size = { w: 0, h: 0 };

    constructor(
        readonly session: InsetSession,
        readonly provider: InsetProvider,
        readonly target: InsetTarget,
        readonly source: InsetSource,
        readonly source_anchor: Vec2,
        readonly parent: Inset | null,
        readonly color: string,
        readonly panel: InsetPanel,
        readonly leader: SVGPathElement,
        readonly ring: SVGCircleElement,
        readonly origin: SVGCircleElement,
        readonly camera: InsetCamera,
    ) {}

    /** Hover at a canvas point (or none): find what is under it. */
    hover_at(cursor: Vec2 | null) {
        let hit: InsetHit | null = null;
        if (cursor && !this.missing && this.provider.hit_test) {
            const { w, h } = this.canvas_size;
            if (w && h)
                hit = this.provider.hit_test(
                    this.target,
                    inset_to_world(this.camera, w, h, cursor),
                );
        }
        const same =
            hit?.reference === this.hit?.reference &&
            hit?.number === this.hit?.number;
        this.hit = hit;
        if (!same) {
            this.session.schedule();
            this.session.on_hit?.(this, hit);
        }
    }

    /** Outline the target pad/pin and the hovered one over the canvas. */
    layout_marks() {
        const { w, h } = this.canvas_size;
        const polygon = (el: SVGPolygonElement, box: BBox | undefined) => {
            if (!box || !w || !h) {
                el.style.display = "none";
                return;
            }
            const corners = [
                new Vec2(box.x, box.y),
                new Vec2(box.x + box.w, box.y),
                new Vec2(box.x + box.w, box.y + box.h),
                new Vec2(box.x, box.y + box.h),
            ].map((p) => world_to_inset(this.camera, w, h, p));
            el.setAttribute(
                "points",
                corners.map((p) => `${p.x},${p.y}`).join(" "),
            );
            el.style.display = "";
        };
        polygon(this.target_outline, this.target.anchor_box);
        polygon(this.hover_outline, this.hit?.box);
    }

    get canvas_size() {
        return {
            w: this.panel.canvas.clientWidth,
            h: this.panel.canvas.clientHeight,
        };
    }

    /** What the inset shows, in client pixels: its canvas, or a lens circle. */
    get view(): { rect: DOMRect; circle: boolean } {
        const circle = this.panel.lens;
        return {
            rect: (circle
                ? this.panel.el
                : this.panel.canvas
            ).getBoundingClientRect(),
            circle,
        };
    }

    world_to_client(point: Vec2): Vec2 | null {
        const { w, h } = this.canvas_size;
        if (!w || !h) return null;
        const p = world_to_inset(this.camera, w, h, point);
        const rect = this.panel.canvas.getBoundingClientRect();
        return new Vec2(rect.left + p.x, rect.top + p.y);
    }

    client_to_world(point: Vec2): Vec2 | null {
        const { w, h } = this.canvas_size;
        if (!w || !h) return null;
        const rect = this.panel.canvas.getBoundingClientRect();
        return inset_to_world(
            this.camera,
            w,
            h,
            new Vec2(point.x - rect.left, point.y - rect.top),
        );
    }

    fit() {
        if (this.missing) return;
        const { w, h } = this.canvas_size;
        fit_camera(this.camera, this.target.focus, w, h);
        this.invalidate();
    }

    rotate(delta: number) {
        this.camera.rotation += delta;
        this.invalidate();
    }

    set_mirror(value: boolean) {
        this.camera.mirror = value;
        this.panel.mirrored = value;
        this.invalidate();
    }

    /**
     * T (IN-61): switch a PCB inset between the 2D board and the host's 3D
     * board, leaning back by DEFAULT_TILT. The first switch loads the 3D
     * board when it is not loaded yet; the inset stays 2D until it is.
     */
    toggle_3d() {
        const state = this.provider.state_3d?.() ?? null;
        if (state === null || this.missing) return;
        if (this.camera.view3d || this.want_3d) {
            this.want_3d = false;
            this.camera.view3d = false;
        } else if (state === "unavailable") {
            this.panel.notice("3D unavailable");
        } else {
            this.want_3d = true;
            this.provider.load_3d?.();
        }
        this.sync_3d();
        this.invalidate();
    }

    /**
     * A plain drag on a 3D inset orbits, as in the 3D tab: across turns the
     * board about its normal, up leans the view back, down straightens it.
     * The lean stops short of edge-on; M shows the other side.
     */
    orbit(dx: number, dy: number) {
        if (!this.camera.view3d) return;
        // The tab turns its camera, so from above the board turns against
        // the pointer on screen and from below with it; `rotation` is the
        // board's clockwise turn on screen.
        const turn = dx * ORBIT_PER_PIXEL;
        this.camera.rotation += this.camera.mirror ? turn : -turn;
        const tilt = (this.camera.tilt ?? DEFAULT_TILT) - dy * ORBIT_PER_PIXEL;
        this.camera.tilt = Math.min(MAX_TILT, Math.max(0, tilt));
        this.invalidate();
    }

    /** Follow the 3D board's state: it became ready, failed or went away. */
    sync_3d() {
        const state = this.provider.state_3d?.() ?? null;
        if (this.want_3d && state === "ready") {
            this.want_3d = false;
            this.camera.view3d = true;
            this.camera.tilt ??= DEFAULT_TILT;
        } else if (this.want_3d && state !== "loading") {
            this.want_3d = false;
            if (state === "unavailable") this.panel.notice("3D unavailable");
        }
        if (this.camera.view3d && state !== "ready") this.camera.view3d = false;
        this.panel.view3d = {
            offered: state !== null && !this.missing,
            on: !!this.camera.view3d,
            pending: this.want_3d,
        };
    }

    invalidate() {
        this.#dirty = true;
        this.session.schedule();
    }

    /** Render if the view changed since the last frame. */
    render(force = false) {
        if (this.missing || (!this.#dirty && !force)) return;
        const { w, h } = this.canvas_size;
        if (!w || !h) return;
        this.#dirty = false;
        this.sync_3d();
        this.#rendered_size = { w, h };
        this.provider.render(this.target, this.camera, this.panel.canvas);
    }

    /** The canvas resized; only a real size change needs a new frame. */
    resized() {
        const { w, h } = this.canvas_size;
        if (w !== this.#rendered_size.w || h !== this.#rendered_size.h)
            this.invalidate();
    }
}

export class InsetSession {
    readonly #root: HTMLDivElement;
    readonly #svg: SVGSVGElement;
    readonly #providers = new Map<InsetKind, InsetProvider>();
    #insets: Inset[] = [];
    #preview: Inset | null = null;
    #hovered: Inset | null = null;
    #request = 0;
    #next_color = 0;
    #clock = 0;
    #frame: number | null = null;
    #key_listening = false;
    // Our edit (hammerola): a host that takes Escape itself and calls
    // `escape()` through the element's `escapeInsets` (`own_escape`). The
    // session's own window listener would otherwise keep closing the pinned
    // insets of an element that is off screen, and take the Escape meant for
    // whatever the page shows over its own view.
    #host_escape = false;

    /**
     * Chained insets (M5): the pin or pad under the pointer inside an inset
     * changed, or the canvas was clicked without dragging. The host decides
     * whether that opens or pins a child inset; on_click returns whether it
     * used the click.
     */
    on_hit: ((inset: Inset, hit: InsetHit | null) => void) | null = null;
    on_click: ((inset: Inset) => boolean) | null = null;

    constructor() {
        this.#root = document.createElement("div");
        this.#root.className = "inset-root";
        const style = document.createElement("style");
        style.textContent = INSET_STYLES;
        this.#svg = document.createElementNS(SVG_NS, "svg");
        this.#root.append(style, this.#svg);
    }

    /** The overlay element; for hosts and tests. */
    get root(): HTMLElement {
        return this.#root;
    }

    get insets(): readonly Inset[] {
        return this.#insets;
    }

    get count() {
        return this.#insets.length;
    }

    get preview(): Inset | null {
        return this.#preview;
    }

    /** The inset under the pointer; toolbar keys act on it. */
    get hovered(): Inset | null {
        return this.#hovered;
    }

    register(provider: InsetProvider) {
        this.#providers.set(provider.kind, provider);
        // The scene behind this provider changed: its insets re-render.
        provider.subscribe?.(() => {
            for (const inset of this.#insets)
                if (inset.provider === provider) inset.invalidate();
        });
    }

    provider(kind: InsetKind): InsetProvider | undefined {
        return this.#providers.get(kind);
    }

    /**
     * Host the overlay in `parent` (the shadow root of the viewer on screen).
     * Moving it between hosts keeps every inset.
     */
    mount(parent: Node) {
        if (this.#root.parentNode !== parent) parent.appendChild(this.#root);
        this.schedule();
    }

    /** A source viewer's camera or layout changed; leaders must follow. */
    sources_moved() {
        if (this.#insets.length) this.schedule();
    }

    async open(request: OpenInsetRequest): Promise<Inset | null> {
        const provider = this.#providers.get(request.kind);
        if (!provider) return null;
        const ticket = ++this.#request;
        // Readiness as of the resolve: a document that finishes loading
        // meanwhile still answered "nothing yet", not "absent".
        const was_ready = provider.ready?.() !== false;
        const target = await provider.resolve(
            request.reference,
            request.number,
        );
        // Still loading is not the same as absent: a "loading" header that
        // the host replaces once the document is ready.
        const loading = !target && (!was_ready || provider.ready?.() === false);
        const missing = !target;
        if (!target && !(request.show_missing && ticket === this.#request))
            return null;
        const current = this.#preview;
        if (
            loading &&
            current?.loading &&
            current.target.kind === request.kind &&
            current.target.reference === request.reference &&
            current.target.number === request.number &&
            current.parent === (request.parent ?? null)
        )
            return current;
        // A newer hover superseded this one while it resolved, or the parent
        // closed meanwhile.
        if (
            ticket !== this.#request ||
            (request.parent && !this.#insets.includes(request.parent))
        ) {
            if (target) provider.release?.(target);
            return null;
        }
        const shown: InsetTarget = target ?? {
            kind: request.kind,
            reference: request.reference,
            number: request.number,
            side: "none",
            focus: new BBox(0, 0, 0, 0),
            anchor: new Vec2(0, 0),
            mirror: false,
        };

        const preview = request.preview ?? true;
        if (preview && this.#preview) this.close(this.#preview);
        if (!this.#make_room(request.parent ?? null)) {
            if (target) provider.release?.(target);
            return null;
        }

        const color =
            request.parent?.color ??
            CHAIN_COLORS[this.#next_color++ % CHAIN_COLORS.length]!;
        const camera: InsetCamera = {
            center: new Vec2(0, 0),
            zoom: 1,
            rotation: 0,
            mirror: shown.mirror,
        };
        let inset!: Inset;
        const panel = new InsetPanel(color, {
            action: (action) => this.act(inset, action),
            moved: () => this.schedule(),
            resized: () => inset.resized(),
            drag: (dx, dy, secondary) => {
                if (inset.camera.view3d && !secondary) {
                    inset.orbit(dx, dy);
                    return;
                }
                pan_by(inset.camera, dx, dy);
                inset.invalidate();
            },
            wheel: (cursor, event) => {
                if (event.shiftKey) {
                    inset.rotate(Math.sign(event.deltaY) * WHEEL_ROTATE_STEP);
                    return;
                }
                // As on the main view (`MoveAndZoom`): a two-finger swipe
                // pans and the drawing follows the fingers, a pinch zooms
                // about the pointer.
                const gesture = wheel_gesture(event);
                if (gesture.kind === "zoom") {
                    const { w, h } = inset.canvas_size;
                    zoom_about(
                        inset.camera,
                        w,
                        h,
                        cursor,
                        Math.exp(-gesture.by * WHEEL_ZOOM_RATE),
                    );
                } else {
                    pan_by(inset.camera, -gesture.dx, -gesture.dy);
                }
                inset.invalidate();
            },
            touched: () => this.pin(inset),
            pointer: (cursor) => inset.hover_at(cursor),
            click: () => void this.on_click?.(inset),
            hover: (on) => {
                if (on) inset.used = ++this.#clock;
                if (on) this.#hovered = inset;
                else if (this.#hovered === inset) this.#hovered = null;
            },
        });
        panel.title = {
            ...shown,
            detail: loading ? "Loading…" : shown.detail,
            crumb: request.parent
                ? `${request.parent.target.reference} · ${request.parent.target.number}`
                : undefined,
        };
        panel.side = shown.side;
        panel.mirrored = shown.mirror;
        panel.preview = preview;
        panel.el.classList.toggle("missing", missing);
        panel.el.classList.toggle("loading", loading);

        const leader = document.createElementNS(SVG_NS, "path");
        leader.setAttribute("fill", "none");
        leader.setAttribute("stroke", color);
        leader.setAttribute("stroke-width", "2");
        leader.setAttribute("stroke-dasharray", "6 4");
        leader.setAttribute("stroke-linecap", "round");
        const ring = document.createElementNS(SVG_NS, "circle");
        ring.setAttribute("r", "7");
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "2");
        const origin = document.createElementNS(SVG_NS, "circle");
        origin.setAttribute("r", "3.5");
        origin.setAttribute("fill", color);

        inset = new Inset(
            this,
            provider,
            shown,
            request.source,
            request.source_anchor,
            request.parent ?? null,
            color,
            panel,
            leader,
            ring,
            origin,
            camera,
        );
        inset.pinned = !preview;
        inset.missing = missing;
        inset.loading = loading;
        inset.used = ++this.#clock;
        request.parent?.children.push(inset);
        this.#insets.push(inset);
        if (preview) this.#preview = inset;

        inset.target_outline.classList.add("target");
        inset.hover_outline.classList.add("hover");
        panel.marks.append(inset.target_outline, inset.hover_outline);
        this.#root.append(panel.el);
        this.#svg.append(leader, ring, origin);
        this.#place(inset, request.size ?? { w: 320, h: 248 });
        inset.sync_3d();
        if (!missing) inset.fit();
        this.#listen_keys(true);
        return inset;
    }

    pin(inset: Inset) {
        // A loading placeholder is replaced when its document is ready.
        if (inset.pinned || inset.loading) return;
        inset.pinned = true;
        inset.panel.preview = false;
        if (this.#preview === inset) this.#preview = null;
    }

    /**
     * Make a pinned inset the preview again (the toolbar pin toggles). The
     * current preview, if another, gives way. An inset with children stays
     * pinned: it anchors their chain.
     */
    unpin(inset: Inset) {
        if (!inset.pinned || inset.children.length) return;
        if (this.#preview && this.#preview !== inset) this.close(this.#preview);
        inset.pinned = false;
        inset.panel.preview = true;
        this.#preview = inset;
    }

    /** Close `inset` and everything chained from it. */
    close(inset: Inset) {
        for (const child of [...inset.children]) this.close(child);
        if (!inset.missing) inset.provider.release?.(inset.target);
        inset.panel.dispose();
        inset.leader.remove();
        inset.ring.remove();
        inset.origin.remove();
        this.#insets = this.#insets.filter((candidate) => candidate !== inset);
        if (inset.parent) {
            const siblings = inset.parent.children;
            const index = siblings.indexOf(inset);
            if (index >= 0) siblings.splice(index, 1);
        }
        if (this.#preview === inset) this.#preview = null;
        if (this.#hovered === inset) this.#hovered = null;
        if (!this.#insets.length) this.#listen_keys(false);
    }

    /** Close the preview, if any. Returns whether anything closed. */
    close_previews(): boolean {
        if (!this.#preview) return false;
        this.close(this.#preview);
        return true;
    }

    /** Returns whether anything closed. */
    close_all(): boolean {
        if (!this.#insets.length) return false;
        for (const inset of this.#insets.filter((i) => !i.parent))
            this.close(inset);
        return true;
    }

    /** Escape: previews first, then everything. */
    escape(): boolean {
        return this.close_previews() || this.close_all();
    }

    /** Re-render every inset (the shared scene changed). */
    refresh() {
        for (const inset of this.#insets) inset.invalidate();
    }

    schedule() {
        if (this.#frame !== null) return;
        this.#frame = requestAnimationFrame(() => {
            this.#frame = null;
            this.flush();
        });
    }

    /** Render dirty insets and lay out leaders now. */
    flush() {
        const root = this.#root.getBoundingClientRect();
        for (const inset of this.#insets) {
            inset.render();
            inset.layout_marks();
            this.#layout_leader(inset, root);
        }
    }

    dispose() {
        for (const inset of this.#insets.filter((i) => !i.parent))
            this.close(inset);
        if (this.#frame !== null) cancelAnimationFrame(this.#frame);
        this.#frame = null;
        this.#listen_keys(false);
        this.#root.remove();
    }

    /** Run a toolbar action on `inset` (buttons and keys). */
    act(inset: Inset, action: InsetAction) {
        inset.used = ++this.#clock;
        switch (action) {
            case "rotate-ccw":
                inset.rotate(-ROTATE_STEP);
                break;
            case "rotate-cw":
                inset.rotate(ROTATE_STEP);
                break;
            case "mirror":
                inset.set_mirror(!inset.camera.mirror);
                break;
            case "lens":
                inset.panel.lens = !inset.panel.lens;
                inset.invalidate();
                break;
            case "refit":
                inset.fit();
                break;
            case "pin":
                if (inset.pinned) this.unpin(inset);
                else this.pin(inset);
                break;
            case "3d":
                inset.toggle_3d();
                break;
            case "close":
                this.close(inset);
                break;
        }
    }

    /**
     * Keep at most MAX_INSETS open: close the least recently used one (with
     * its chain) that is not the new inset's ancestor. Returns false when
     * nothing can make room.
     */
    #make_room(parent: Inset | null): boolean {
        const protected_ = new Set<Inset>();
        for (let p = parent; p; p = p.parent) protected_.add(p);
        while (this.#insets.length >= MAX_INSETS) {
            let victim: Inset | null = null;
            for (const inset of this.#insets) {
                if (protected_.has(inset)) continue;
                if (!victim || inset.used < victim.used) victim = inset;
            }
            if (!victim) return false;
            this.close(victim);
        }
        return true;
    }

    /**
     * Beside the parent panel (chained) or the source point (root), on the
     * side with the least overlap with other panels, inside the overlay.
     */
    #place(inset: Inset, size: { w: number; h: number }) {
        const root = this.#root.getBoundingClientRect();
        const { w, h } = size;
        const candidates: [number, number][] = [];
        const parent = inset.parent?.panel.el;
        if (parent) {
            const px = parent.offsetLeft;
            const py = parent.offsetTop;
            const pw = parent.offsetWidth;
            const ph = parent.offsetHeight;
            const gap = 16;
            candidates.push(
                [px + pw + gap, py],
                [px, py + ph + gap],
                [px - gap - w, py],
                [px, py - gap - h],
            );
        } else {
            const anchor = inset.source.world_to_client(inset.source_anchor);
            const sx = (anchor?.x ?? root.left + root.width / 2) - root.left;
            const sy = (anchor?.y ?? root.top + root.height / 2) - root.top;
            const gap = 60;
            candidates.push(
                [sx + gap, sy - h / 2],
                [sx - gap - w, sy - h / 2],
                [sx - w / 2, sy + gap],
                [sx - w / 2, sy - gap - h],
            );
        }
        const others = this.#insets
            .filter((other) => other !== inset)
            .map((other) => other.panel.el)
            .filter((el) => el.isConnected)
            .map((el) => ({
                x: el.offsetLeft,
                y: el.offsetTop,
                w: el.offsetWidth,
                h: el.offsetHeight,
            }));
        const overlap = (
            ax: number,
            ay: number,
            b: { x: number; y: number; w: number; h: number },
        ) =>
            Math.max(0, Math.min(ax + w, b.x + b.w) - Math.max(ax, b.x)) *
            Math.max(0, Math.min(ay + h, b.y + b.h) - Math.max(ay, b.y));
        const outside = (x: number, y: number) =>
            w * h -
            overlap(x, y, { x: 0, y: 0, w: root.width, h: root.height });
        // Beside each open panel too, so a crowded spot still has a clear
        // place; the nearest clear place to the first choice wins.
        for (const other of others)
            candidates.push(
                [other.x + other.w + 16, other.y],
                [other.x, other.y + other.h + 16],
            );
        const [fx, fy] = candidates[0]!;
        let best = candidates[0]!;
        let best_score = Infinity;
        for (const [x, y] of candidates) {
            let score = outside(x, y) * 4 + Math.hypot(x - fx, y - fy);
            for (const other of others) score += overlap(x, y, other) * 2;
            if (score < best_score) {
                best_score = score;
                best = [x, y];
            }
        }
        const clamp = (v: number, size: number, max: number) =>
            Math.min(Math.max(8, v), Math.max(8, max - size - 8));
        inset.panel.place(
            clamp(best[0], w, root.width),
            clamp(best[1], h, root.height),
            w,
            h,
        );
    }

    #layout_leader(inset: Inset, root: DOMRect) {
        const raw_a = inset.source.world_to_client(inset.source_anchor);
        const raw = inset.missing
            ? null
            : inset.world_to_client(inset.target.anchor);
        const visible = !!raw_a && !!raw;
        for (const el of [inset.leader, inset.ring, inset.origin])
            el.style.display = visible ? "" : "none";
        if (!raw_a || !raw) return;
        // Panned or zoomed so a pad is out of view: keep that end of the
        // leader on the inset's edge, pointing at it, and mark the edge. Both
        // ends: a chained inset's leader starts inside its parent inset.
        const end = inset.view;
        const { point: b, clipped } = clamp_to_view(raw, end.rect, end.circle);
        let a = raw_a;
        let a_clipped = false;
        if (inset.source instanceof Inset) {
            const start = inset.source.view;
            ({ point: a, clipped: a_clipped } = clamp_to_view(
                raw_a,
                start.rect,
                start.circle,
            ));
        }
        const ax = a.x - root.left;
        const ay = a.y - root.top;
        const bx = b.x - root.left;
        const by = b.y - root.top;
        const dx = (bx - ax) * 0.5;
        inset.leader.setAttribute(
            "d",
            `M${ax},${ay} C${ax + dx},${ay - 40} ${bx - dx},${by - 40} ${bx},${by}`,
        );
        inset.ring.setAttribute("cx", `${bx}`);
        inset.ring.setAttribute("cy", `${by}`);
        inset.ring.setAttribute("r", clipped ? "4" : "7");
        inset.ring.setAttribute("fill", clipped ? inset.color : "none");
        inset.ring.classList.toggle("off-view", clipped);
        inset.origin.setAttribute("cx", `${ax}`);
        inset.origin.setAttribute("cy", `${ay}`);
        inset.origin.classList.toggle("off-view", a_clipped);
    }

    #on_key = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (is_typing_target(e)) return;
        if (this.escape()) e.preventDefault();
    };

    /** Our edit (hammerola): the host takes Escape from now on. */
    own_escape() {
        this.#host_escape = true;
        this.#listen_keys(false);
    }

    #listen_keys(on: boolean) {
        on &&= !this.#host_escape;
        if (on === this.#key_listening) return;
        this.#key_listening = on;
        if (on) window.addEventListener("keydown", this.#on_key);
        else window.removeEventListener("keydown", this.#on_key);
    }
}

function is_typing_target(e: Event) {
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
    );
}

const EDGE_MARGIN = 4;

/**
 * Keep a leader end inside the inset's view: the canvas rectangle, or the
 * circle of a lens. A point outside moves to the edge along the line from
 * the view's centre, so the leader still points at the pad.
 */
export function clamp_to_view(
    point: Vec2,
    view: { left: number; top: number; width: number; height: number },
    circle = false,
): { point: Vec2; clipped: boolean } {
    const cx = view.left + view.width / 2;
    const cy = view.top + view.height / 2;
    const dx = point.x - cx;
    const dy = point.y - cy;
    if (circle) {
        const r = Math.max(
            0,
            Math.min(view.width, view.height) / 2 - EDGE_MARGIN,
        );
        const d = Math.hypot(dx, dy);
        if (d <= r) return { point, clipped: false };
        return {
            point: new Vec2(cx + (dx / d) * r, cy + (dy / d) * r),
            clipped: true,
        };
    }
    const hx = Math.max(0, view.width / 2 - EDGE_MARGIN);
    const hy = Math.max(0, view.height / 2 - EDGE_MARGIN);
    if (Math.abs(dx) <= hx && Math.abs(dy) <= hy)
        return { point, clipped: false };
    const t = Math.min(
        dx ? hx / Math.abs(dx) : Infinity,
        dy ? hy / Math.abs(dy) : Infinity,
    );
    return { point: new Vec2(cx + dx * t, cy + dy * t), clipped: true };
}
