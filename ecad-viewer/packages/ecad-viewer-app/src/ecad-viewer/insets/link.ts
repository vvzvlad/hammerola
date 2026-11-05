/*
    InsetLink: connects one <ecad-viewer> to its inset session.

    Each element owns a session whose overlay lives in its own shadow root,
    so a hidden tab hides its insets with it. The session is served by the
    element's own documents and by its peer's (the element holding the other
    document): hovering a schematic pin opens a PCB inset from the peer, and
    a chained inset (M5) can come back to this element's own schematic.
*/

import { Vec2 } from "../../base/math";
import {
    KiCanvasProbeEvent,
    type KiCanvasProbeDetail,
} from "../../viewers/base/events";
import type { Viewer } from "../../viewers/base/viewer";
import type { InsetCamera } from "./camera";
import type { InsetAction } from "./panel";
import { InsetSession, type Inset } from "./session";
import type {
    InsetHit,
    InsetKind,
    InsetProvider,
    InsetSource,
    InsetTarget,
} from "./types";

/** What a link needs from an element (its own, or its peer's). */
export interface InsetPeer {
    insetProvider(kind: InsetKind): InsetProvider | null;
    /** Mirror an inset-mode change made on the other element. */
    syncInsetMode?(on: boolean): void;
    /** The peer's current mode, adopted when the two are linked. */
    readonly insetMode?: boolean;
}

export interface InsetLinkHost extends InsetPeer {
    /** Where the overlay mounts: the element's shadow root. */
    overlay_parent(): Node | null;
    /** The element's viewers that act as hover sources, by kind. */
    source_viewers(): Partial<Record<InsetKind, Viewer | null>>;
    /** Inset mode changed here (key or API); the host tells its peer. */
    mode_changed?(on: boolean): void;
}

export const HOVER_OPEN_DELAY_MS = 180;
export const HOVER_CLOSE_DELAY_MS = 700;
/** While the other document loads, a held hover retries this often. */
export const LOADING_RETRY_MS = 250;

const OTHER: Record<InsetKind, InsetKind> = { sch: "pcb", pcb: "sch" };

type HoverDetail = Exclude<KiCanvasProbeDetail, { phase: "clear" }>;

/** Designators KiCad never places on a board (power and flag symbols). */
const is_virtual = (reference: string) =>
    !reference.trim() || reference.startsWith("#");

/** Toolbar keys (IN-11). Shift only changes R's direction. */
function key_action(event: KeyboardEvent): InsetAction | null {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (event.shiftKey && key !== "r") return null;
    switch (key) {
        case "r":
            return event.shiftKey ? "rotate-ccw" : "rotate-cw";
        case "m":
            return "mirror";
        case "l":
            return "lens";
        case "Home":
            return "refit";
        case "p":
            return "pin";
        case "t":
            return "3d";
        case "x":
            return "close";
    }
    return null;
}

/** A provider that finds the current real one on every call. */
class LazyProvider implements InsetProvider {
    #owners = new WeakMap<InsetTarget, InsetProvider>();
    #listeners = new Set<() => void>();
    #subscribed = new WeakSet<InsetProvider>();

    constructor(
        readonly kind: InsetKind,
        private readonly find: () => InsetProvider | null,
    ) {}

    /** Forwarded to whichever real provider appears (documents load late). */
    subscribe(listener: () => void) {
        this.#listeners.add(listener);
        this.#attach(this.find());
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #attach(provider: InsetProvider | null) {
        if (!provider?.subscribe || this.#subscribed.has(provider)) return;
        this.#subscribed.add(provider);
        provider.subscribe(() => {
            for (const listener of this.#listeners) listener();
        });
    }

    async resolve(reference: string, number: string) {
        const provider = this.find();
        this.#attach(provider);
        const target = (await provider?.resolve(reference, number)) ?? null;
        if (target && provider) this.#owners.set(target, provider);
        return target;
    }

    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ) {
        this.#owners.get(target)?.render(target, camera, canvas);
    }

    hit_test(target: InsetTarget, world: Vec2) {
        return this.#owners.get(target)?.hit_test?.(target, world) ?? null;
    }

    ready() {
        const provider = this.find();
        return !!provider && (provider.ready?.() ?? true);
    }

    state_3d() {
        return this.find()?.state_3d?.() ?? null;
    }

    load_3d() {
        this.find()?.load_3d?.();
    }

    release(target: InsetTarget) {
        this.#owners.get(target)?.release?.(target);
        this.#owners.delete(target);
    }
}

/** A main viewer as a leader source. Null while its canvas is hidden. */
export function viewer_source(viewer: Viewer): InsetSource {
    return {
        world_to_client(point: Vec2) {
            const rect = viewer.canvas.getBoundingClientRect();
            if (!rect.width || !rect.height || !viewer.viewport) return null;
            const p = viewer.viewport.camera.world_to_screen(point);
            return new Vec2(rect.left + p.x, rect.top + p.y);
        },
    };
}

export class InsetLink {
    readonly session = new InsetSession();
    #peer: InsetPeer | null = null;
    #listeners = new Map<
        Viewer,
        { kind: InsetKind; dispose(): void; source: InsetSource }
    >();
    #open_timer: number | null = null;
    #close_timer: number | null = null;
    #mode = false;
    #peeking = false;
    /** The pin or pad under the pointer, whether or not an inset opened. */
    #hover: { viewer: Viewer; detail: HoverDetail } | null = null;

    #child_timer: number | null = null;
    #child_close_timer: number | null = null;
    #retry_timer: number | null = null;
    /** A click landed while the other document loaded: pin it once open. */
    #pin_when_ready: HoverDetail | null = null;

    constructor(private readonly host: InsetLinkHost) {
        this.session.on_hit = (inset, hit) => this.#on_inset_hit(inset, hit);
        this.session.on_click = (inset) => this.#on_inset_click(inset);
        for (const kind of ["pcb", "sch"] as const) {
            this.session.register(
                new LazyProvider(
                    kind,
                    () =>
                        this.#peer?.insetProvider(kind) ??
                        this.host.insetProvider(kind),
                ),
            );
        }
    }

    set peer(peer: InsetPeer | null) {
        this.#peer = peer;
        if (!peer) this.session.close_all();
        // Linking to an element already in inset mode joins that mode.
        else if (peer.insetMode && !this.#mode) this.set_mode(true);
        this.sync();
        // The host may link the peer only once the mode turned on (Prism
        // mounts the PCB lazily): open for the pin already under the pointer.
        if (peer && this.#hover && (this.#mode || this.#peeking))
            this.#schedule_open(this.#hover.viewer, this.#hover.detail, 0);
    }

    get peer() {
        return this.#peer;
    }

    /** Inset mode: hovers open previews and clicks pin them. */
    get mode() {
        return this.#mode;
    }

    /** Set the mode; `quiet` skips the host callback (peer sync). */
    set_mode(on: boolean, quiet = false) {
        if (on === this.#mode) return;
        this.#mode = on;
        if (!on && !this.#peeking) {
            this.#clear_timers();
            this.session.close_previews();
        } else if (on && this.#hover) {
            this.#schedule_open(this.#hover.viewer, this.#hover.detail, 0);
        }
        if (!quiet) this.host.mode_changed?.(on);
    }

    /** True while Alt is held with the mode off. */
    get peeking() {
        return this.#peeking;
    }

    /**
     * Keyboard: `I` toggles the mode, holding Alt peeks. The element calls
     * this after its own guards (active host, no dialog, not typing).
     * Returns whether the key was used.
     */
    key_down(event: KeyboardEvent): boolean {
        const hovered = this.session.hovered;
        if (hovered && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const action = key_action(event);
            if (action) {
                this.session.act(hovered, action);
                return true;
            }
        }
        if (event.key === "Alt") {
            if (!this.#peeking && !event.repeat) {
                this.#peeking = true;
                if (!this.#mode && this.#hover)
                    this.#schedule_open(
                        this.#hover.viewer,
                        this.#hover.detail,
                        0,
                    );
            }
            return false;
        }
        if (
            (event.key === "i" || event.key === "I") &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.shiftKey &&
            !event.repeat
        ) {
            // No peer yet is fine: the host may load the other document
            // only once the mode is on (Prism mounts the PCB lazily).
            this.set_mode(!this.#mode);
            return true;
        }
        return false;
    }

    /** Releasing Alt (or losing focus) ends a peek. */
    key_up(event: KeyboardEvent | null) {
        if (event && event.key !== "Alt") return;
        if (!this.#peeking) return;
        this.#peeking = false;
        if (!this.#mode) {
            this.#clear_timers();
            this.session.close_previews();
        }
    }

    /** Attach to the element's current viewers and overlay host. */
    sync() {
        const parent = this.host.overlay_parent();
        if (parent) this.session.mount(parent);
        const wanted = new Map<Viewer, InsetKind>();
        for (const [kind, viewer] of Object.entries(
            this.host.source_viewers(),
        ) as [InsetKind, Viewer | null][])
            if (viewer) wanted.set(viewer, kind);
        for (const [viewer, entry] of this.#listeners)
            if (wanted.get(viewer) !== entry.kind) {
                entry.dispose();
                this.#listeners.delete(viewer);
            }
        for (const [viewer, kind] of wanted) {
            if (this.#listeners.has(viewer)) continue;
            const listener = viewer.addEventListener(
                KiCanvasProbeEvent.type,
                (event) => this.#on_probe(viewer, event.detail),
            );
            const intercept = () => this.#on_click(viewer);
            viewer.click_interceptor = intercept;
            this.#listeners.set(viewer, {
                kind,
                dispose: () => {
                    listener.dispose();
                    if (viewer.click_interceptor === intercept)
                        viewer.click_interceptor = null;
                },
                source: viewer_source(viewer),
            });
        }
    }

    /** The element's tab was hidden: drop previews and pending hovers. */
    hidden() {
        this.#clear_timers();
        this.#hover = null;
        this.#peeking = false;
        this.session.close_previews();
    }

    /** The element's tab is back: re-attach, re-render, re-lay out. */
    shown() {
        this.sync();
        this.session.refresh();
    }

    /** A source viewer's camera moved; leaders must follow. */
    sources_moved() {
        this.session.sources_moved();
    }

    dispose() {
        this.#clear_timers();
        for (const entry of this.#listeners.values()) entry.dispose();
        this.#listeners.clear();
        this.session.dispose();
    }

    #on_probe(viewer: Viewer, detail: KiCanvasProbeDetail) {
        if (detail.phase === "hover") {
            if (!detail.reference || !detail.anchor) return;
            if (is_virtual(detail.reference)) return;
            // Kept without a peer too: linking it opens this hover.
            this.#hover = { viewer, detail };
            this.#cancel_close();
            if (!this.#peer || (!this.#mode && !this.#peeking)) return;
            this.#schedule_open(viewer, detail, HOVER_OPEN_DELAY_MS);
        } else if (detail.phase === "leave" || detail.phase === "clear") {
            this.#hover = null;
            if (!this.#peer) return;
            if (this.#open_timer !== null) clearTimeout(this.#open_timer);
            this.#open_timer = null;
            this.#cancel_close();
            this.#close_timer = window.setTimeout(() => {
                this.#close_timer = null;
                const preview = this.session.preview;
                // The pointer reached the preview: leave it for pinning.
                if (preview && this.session.hovered !== preview)
                    this.session.close(preview);
            }, HOVER_CLOSE_DELAY_MS);
        }
    }

    #schedule_open(viewer: Viewer, detail: HoverDetail, delay: number) {
        const entry = this.#listeners.get(viewer);
        if (!entry || !detail.reference || !detail.anchor) return;
        if (this.#open_timer !== null) clearTimeout(this.#open_timer);
        const reference = detail.reference;
        const number = detail.number;
        const anchor = new Vec2(detail.anchor.x, detail.anchor.y);
        const open = async () => {
            this.#open_timer = null;
            // The element may have re-rendered its shadow DOM.
            const parent = this.host.overlay_parent();
            if (parent) this.session.mount(parent);
            const inset = await this.session.open({
                kind: OTHER[entry.kind],
                reference,
                number,
                source: entry.source,
                source_anchor: anchor,
                preview: true,
                show_missing: true,
            });
            if (inset && !inset.loading && this.#pin_when_ready === detail) {
                this.#pin_when_ready = null;
                this.session.pin(inset);
            }
            // The other document is still loading: try again while the
            // pointer stays on this pin. Leaving it ends the retries.
            if (inset?.loading) {
                if (this.#retry_timer !== null) clearTimeout(this.#retry_timer);
                this.#retry_timer = window.setTimeout(() => {
                    this.#retry_timer = null;
                    if (
                        this.#hover?.detail === detail &&
                        (this.#mode || this.#peeking)
                    )
                        this.#schedule_open(viewer, detail, 0);
                }, LOADING_RETRY_MS);
            }
            return inset;
        };
        if (delay <= 0) {
            this.#open_timer = null;
            this.#pending = open();
            return;
        }
        this.#open_timer = window.setTimeout(() => {
            this.#pending = open();
        }, delay);
    }

    /** The open still resolving, if any; a click waits for it to pin. */
    #pending: Promise<unknown> | null = null;

    /** In inset mode (or a peek), a click on a pin or pad pins its inset. */
    #on_click(viewer: Viewer): boolean {
        if (!this.#peer || (!this.#mode && !this.#peeking)) return false;
        const hover = this.#hover;
        if (!hover || hover.viewer !== viewer) return false;
        const matches = () => {
            const preview = this.session.preview;
            if (preview?.loading) {
                this.#pin_when_ready = hover.detail;
                return null;
            }
            return preview &&
                preview.target.reference === hover.detail.reference &&
                preview.target.number === hover.detail.number
                ? preview
                : null;
        };
        const pin_now = matches();
        if (pin_now) {
            this.session.pin(pin_now);
            return true;
        }
        // Not open yet (inside the hover delay): open now and pin it.
        this.#schedule_open(viewer, hover.detail, 0);
        const pending = this.#pending;
        void Promise.resolve(pending).then(() => {
            const preview = matches();
            if (preview) this.session.pin(preview);
        });
        return true;
    }

    // --- Chained insets (M5) -----------------------------------------

    /** The child preview hanging off `parent`, if any. */
    #child_preview(parent: Inset) {
        const preview = this.session.preview;
        return preview?.parent === parent ? preview : null;
    }

    #on_inset_hit(parent: Inset, hit: InsetHit | null) {
        if (!this.#peer || (!this.#mode && !this.#peeking)) return;
        if (this.#child_timer !== null) clearTimeout(this.#child_timer);
        this.#child_timer = null;
        if (hit) {
            if (this.#child_close_timer !== null)
                clearTimeout(this.#child_close_timer);
            this.#child_close_timer = null;
            if (is_virtual(hit.reference)) return;
            this.#child_timer = window.setTimeout(() => {
                this.#child_timer = null;
                void this.#open_child(parent, hit, true);
            }, HOVER_OPEN_DELAY_MS);
            return;
        }
        if (this.#child_close_timer !== null)
            clearTimeout(this.#child_close_timer);
        this.#child_close_timer = window.setTimeout(() => {
            this.#child_close_timer = null;
            const child = this.#child_preview(parent);
            if (child && this.session.hovered !== child)
                this.session.close(child);
        }, HOVER_CLOSE_DELAY_MS);
    }

    /** Open the other document's inset for a pin or pad inside `parent`. */
    #open_child(parent: Inset, hit: InsetHit, preview: boolean) {
        const existing = this.#child_preview(parent);
        if (
            existing &&
            existing.target.reference === hit.reference &&
            existing.target.number === hit.number
        ) {
            if (!preview) this.session.pin(existing);
            return Promise.resolve(existing);
        }
        // A preview parent becomes the chain's anchor: opening a child
        // preview would otherwise replace the parent itself.
        this.session.pin(parent);
        return this.session.open({
            kind: OTHER[parent.target.kind],
            reference: hit.reference,
            number: hit.number,
            source: parent,
            source_anchor: new Vec2(
                hit.box.x + hit.box.w / 2,
                hit.box.y + hit.box.h / 2,
            ),
            parent,
            preview,
            show_missing: true,
        });
    }

    /** A click on a pin or pad inside an inset pins (or opens) its child. */
    #on_inset_click(parent: Inset): boolean {
        if (!this.#peer || (!this.#mode && !this.#peeking)) return false;
        const hit = parent.hit;
        if (!hit || is_virtual(hit.reference)) return false;
        if (this.#child_timer !== null) clearTimeout(this.#child_timer);
        this.#child_timer = null;
        void this.#open_child(parent, hit, false);
        return true;
    }

    #cancel_close() {
        if (this.#close_timer !== null) clearTimeout(this.#close_timer);
        this.#close_timer = null;
    }

    #clear_timers() {
        if (this.#open_timer !== null) clearTimeout(this.#open_timer);
        this.#cancel_close();
        this.#open_timer = null;
        if (this.#child_timer !== null) clearTimeout(this.#child_timer);
        if (this.#child_close_timer !== null)
            clearTimeout(this.#child_close_timer);
        this.#child_timer = null;
        this.#child_close_timer = null;
        if (this.#retry_timer !== null) clearTimeout(this.#retry_timer);
        this.#retry_timer = null;
        this.#pin_when_ready = null;
    }
}
