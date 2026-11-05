/*
    Board insets: the PCB around a footprint, rendered by the board viewer
    that already holds the document.
*/

import { BBox, Vec2 } from "../../base/math";
import { Pad } from "../../kicad/board";
import { Depth } from "../../kicad/board_bbox_visitor";
import { VIEWER_DRAW_REQUESTED } from "../../viewers/base/viewer";
import type { NetLabelLayers } from "../../viewers/board/net-label-layers";
import type { BoardViewer } from "../../viewers/board/viewer";
import { inset_matrix, type InsetCamera } from "./camera";
import { BOARD_FOCUS_LIMIT, BOARD_FOCUS_WINDOW, local_focus } from "./focus";
import type {
    InsetHit,
    InsetProvider,
    InsetScene3D,
    InsetTarget,
} from "./types";

const center = (box: BBox) => new Vec2(box.x + box.w / 2, box.y + box.h / 2);

export class BoardInsetProvider implements InsetProvider {
    readonly kind = "pcb" as const;

    #listeners = new Set<() => void>();
    /** Each open inset's own labels, gated for its zoom (IN-31). */
    #labels = new WeakMap<InsetTarget, NetLabelLayers>();
    #hooked: BoardViewer | null = null;
    #unhook: (() => void) | null = null;
    /** The host's 3D board (IN-61), and each open inset's key in it. */
    #scene3d: InsetScene3D | null = null;
    #unhook_3d: (() => void) | null = null;
    #keys_3d = new WeakMap<InsetTarget, string>();
    #next_key = 0;

    constructor(private readonly viewer: () => BoardViewer | null) {}

    /** Register (or with null, drop) the host's 3D board. */
    set scene3d(scene: InsetScene3D | null) {
        if (scene === this.#scene3d) return;
        this.#unhook_3d?.();
        this.#unhook_3d = null;
        this.#scene3d = scene;
        if (scene) this.#unhook_3d = scene.subscribe(() => this.#notify());
        this.#notify();
    }

    get scene3d() {
        return this.#scene3d;
    }

    state_3d() {
        return this.#scene3d?.state() ?? null;
    }

    load_3d() {
        this.#scene3d?.load();
    }

    #notify() {
        for (const listener of this.#listeners) listener();
    }

    /**
     * Insets show the board viewer's own scene, so every change it draws
     * (layers, highlights, selection, variant, DNP) reaches them: they
     * re-render on its draw requests.
     */
    subscribe(listener: () => void) {
        this.#listeners.add(listener);
        this.#hook();
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #hook() {
        const viewer = this.viewer();
        if (!viewer || viewer === this.#hooked) return;
        this.#unhook?.();
        this.#hooked = viewer;
        const notify = () => this.#notify();
        viewer.addEventListener(VIEWER_DRAW_REQUESTED as never, notify);
        this.#unhook = () =>
            viewer.removeEventListener(VIEWER_DRAW_REQUESTED, notify);
    }

    ready() {
        this.#hook();
        return !!this.viewer()?.board;
    }

    async resolve(
        reference: string,
        number: string,
    ): Promise<InsetTarget | null> {
        this.#hook();
        const board = this.viewer()?.board;
        if (!board) return null;
        const fp = board.footprints.find((f) => f.reference === reference);
        if (!fp) return null;
        const pad = fp.pad_by_number(number) ?? null;
        const bottom = fp.layer?.startsWith("B.") ?? false;
        return {
            kind: "pcb",
            reference,
            number,
            detail: pad?.net?.name || undefined,
            side: bottom ? "bottom" : "top",
            focus: local_focus(
                // Graphics plus pads: sparse fab/courtyard layers can leave
                // the footprint's own box smaller than its pads.
                BBox.combine([fp.bbox, ...fp.pads.map((p) => p.bbox)]),
                pad?.bbox,
                BOARD_FOCUS_LIMIT,
                BOARD_FOCUS_WINDOW,
            ),
            anchor: center(pad ? pad.bbox : fp.bbox),
            anchor_box: pad?.bbox,
            mirror: bottom,
        };
    }

    hit_test(_target: InsetTarget, world: Vec2): InsetHit | null {
        const viewer = this.viewer();
        if (!viewer?.board) return null;
        for (const entry of viewer.find_items_under_pos(world)) {
            const item = entry.item;
            if (entry.depth !== Depth.PAD || !(item instanceof Pad)) continue;
            if (!item.number.trim()) continue;
            return {
                reference: item.parent.reference,
                number: item.number,
                box: item.bbox,
            };
        }
        return null;
    }

    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ) {
        const scene = this.#scene3d;
        if (camera.view3d && scene?.state() === "ready") {
            let key = this.#keys_3d.get(target);
            if (!key) {
                key = `inset-${++this.#next_key}`;
                this.#keys_3d.set(target, key);
            }
            if (scene.render(camera, canvas, target.side === "bottom", key))
                return;
        }
        const viewer = this.viewer();
        if (!viewer) return;
        let labels = this.#labels.get(target);
        if (!labels) {
            labels =
                viewer.fork_net_labels({
                    zoom: camera.zoom,
                    bbox: target.focus,
                }) ?? undefined;
            if (labels) this.#labels.set(target, labels);
        }
        viewer.render_view(canvas, (w, h) => inset_matrix(camera, w, h), {
            // A bottom view shows the back side on top, KiCad's flip view.
            back_on_top: camera.mirror,
            labels: labels ? { view: labels, zoom: camera.zoom } : undefined,
        });
    }

    release(target: InsetTarget) {
        this.#labels.get(target)?.dispose();
        this.#labels.delete(target);
        const key = this.#keys_3d.get(target);
        if (key) this.#scene3d?.release?.(key);
        this.#keys_3d.delete(target);
    }
}
