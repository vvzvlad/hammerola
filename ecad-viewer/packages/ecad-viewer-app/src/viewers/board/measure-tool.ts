/**
 * PCB measure mode: click two points, read the distance.
 *
 * The first click places A, the second places B and keeps the result on
 * screen; a third click starts over from a new A. The pointer snaps as
 * measure.ts describes (pads and vias anywhere on their copper, then track
 * ends, edge corners, tracks and the board edge within a few screen
 * pixels); holding Shift places a free point. Drag still pans. The
 * drawing is an overlay channel on the board viewer, so it pans and zooms
 * with the board and never touches the board's own layers.
 */
import { listen } from "../../base/events";
import type { IDisposable } from "../../base/disposable";
import { Vec2 } from "../../base/math";
import type { EcadOverlayPrimitive } from "../base/overlay-scene";
import {
    format_length,
    measure,
    SnapIndex,
    type MeasureSnap,
    type MeasureUnits,
    type Measurement,
} from "./measure";
import type { BoardViewer } from "./viewer";

export const MEASURE_CHANNEL = "__pcb-measure__";

/** Snap radius in CSS pixels. */
export const SNAP_RADIUS_PX = 12;

const COLOR = "#22d3ee";
const HALO = "#020617";

const LABEL_STYLE: Partial<CSSStyleDeclaration> = {
    position: "absolute",
    transform: "translate(-50%, -50%)",
    padding: "2px 6px",
    background: "rgba(2, 6, 23, 0.88)",
    color: COLOR,
    font: "600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "5",
};

export type MeasurePhase = "idle" | "placing" | "done";

export interface MeasureState {
    phase: MeasurePhase;
    /** A while placing (B follows the pointer), both when done. */
    measurement: Measurement | null;
    /** What the pointer would snap to right now. */
    hover: MeasureSnap | null;
}

export class MeasureTool {
    #viewer: BoardViewer | null = null;
    #index: SnapIndex | null = null;
    #listeners: IDisposable[] = [];
    #units: MeasureUnits = "mm";
    #a: MeasureSnap | null = null;
    #b: MeasureSnap | null = null;
    #hover: MeasureSnap | null = null;
    #cursor: string | null = null;
    #label: HTMLDivElement | null = null;

    constructor(private readonly changed: (state: MeasureState) => void) {}

    get active(): boolean {
        return this.#viewer !== null;
    }

    get units(): MeasureUnits {
        return this.#units;
    }

    set units(units: MeasureUnits) {
        if (units === this.#units) return;
        this.#units = units;
        this.#paint();
    }

    /** B, or while placing the snap under the pointer (not A itself). */
    #b_or_hover(): MeasureSnap | null {
        if (this.#b) return this.#b;
        return this.#a && this.#hover !== this.#a ? this.#hover : null;
    }

    get state(): MeasureState {
        const a = this.#a;
        const b = this.#b_or_hover();
        return {
            phase: !a ? "idle" : this.#b ? "done" : "placing",
            measurement: a && b ? measure(a, b) : null,
            hover: this.#hover,
        };
    }

    /** Start measuring on this viewer; null stops. */
    attach(viewer: BoardViewer | null) {
        if (viewer === this.#viewer) return;
        this.#detach();
        if (!viewer) {
            this.#emit();
            return;
        }
        this.#viewer = viewer;
        const canvas = viewer.canvas;
        this.#cursor = canvas.style.cursor;
        canvas.style.cursor = "crosshair";
        this.#listeners = [
            viewer.add_click_interceptor((event) => this.#click(event)),
            listen(canvas, "mousemove", (event) =>
                this.#move(event as MouseEvent),
            ),
            // Zoom changes the snap radius and the label offset.
            listen(canvas, "panzoom", () => this.#paint()),
            listen(canvas, "mouseleave", () => {
                if (!this.#hover) return;
                this.#hover = null;
                this.#paint();
                this.#emit();
            }),
        ];
        this.#emit();
    }

    /** Escape: clear the points first. Returns whether anything cleared. */
    clear(): boolean {
        if (!this.#a && !this.#b) return false;
        this.#a = null;
        this.#b = null;
        this.#paint();
        this.#emit();
        return true;
    }

    dispose() {
        this.#detach();
    }

    #detach() {
        for (const listener of this.#listeners) listener.dispose();
        this.#listeners = [];
        if (this.#viewer) {
            this.#viewer.canvas.style.cursor = this.#cursor ?? "";
            this.#viewer.clear_overlay_scene(MEASURE_CHANNEL);
        }
        this.#label?.remove();
        this.#viewer = null;
        this.#a = null;
        this.#b = null;
        this.#hover = null;
    }

    #snap_at(event: MouseEvent): MeasureSnap | null {
        const viewer = this.#viewer;
        const board = viewer?.board;
        if (!viewer || !board || !viewer.viewport) return null;
        if (this.#index?.board !== board) this.#index = new SnapIndex(board);
        const rect = viewer.canvas.getBoundingClientRect();
        const camera = viewer.viewport.camera;
        const world = camera.screen_to_world(
            new Vec2(event.clientX - rect.left, event.clientY - rect.top),
        );
        if (event.shiftKey)
            return {
                kind: "free",
                x: world.x,
                y: world.y,
                label: "",
                net: null,
            };
        return this.#index.snap(
            world,
            SNAP_RADIUS_PX / Math.max(camera.zoom, 1e-6),
            viewer.snap_filter(),
        );
    }

    #move(event: MouseEvent) {
        if (event.buttons !== 0) return; // panning
        this.#hover = this.#snap_at(event);
        this.#paint();
        this.#emit();
    }

    #click(event: MouseEvent): boolean {
        const snap = this.#snap_at(event);
        if (!snap) return true;
        if (!this.#a || this.#b) {
            this.#a = snap;
            this.#b = null;
        } else {
            this.#b = snap;
        }
        this.#hover = snap;
        this.#paint();
        this.#emit();
        return true;
    }

    #emit() {
        this.changed(this.state);
    }

    #paint() {
        const viewer = this.#viewer;
        if (!viewer) return;
        const zoom = Math.max(viewer.viewport?.camera.zoom ?? 1, 1e-6);
        const primitives: EcadOverlayPrimitive[] = [];
        const a = this.#a;
        const b = this.#b_or_hover();
        let label_at: { x: number; y: number } | null = null;
        let label_text = "";

        if (a && b) {
            const m = measure(a, b);
            const corner: [number, number] = [b.x - a.x, 0];
            const ab: [number, number] = [b.x - a.x, b.y - a.y];
            // ΔX and ΔY legs, then the measured line, each over a dark halo
            // so they read on light copper and on a dark background.
            primitives.push(
                line("dx-halo", a, [[0, 0], corner], 3, HALO, [4, 3]),
                line("dx", a, [[0, 0], corner], 1.5, COLOR, [4, 3]),
                line("dy-halo", a, [corner, ab], 3, HALO, [4, 3]),
                line("dy", a, [corner, ab], 1.5, COLOR, [4, 3]),
                line(
                    "halo",
                    a,
                    [
                        [0, 0],
                        [b.x - a.x, b.y - a.y],
                    ],
                    4,
                    HALO,
                ),
                line(
                    "ab",
                    a,
                    [
                        [0, 0],
                        [b.x - a.x, b.y - a.y],
                    ],
                    2,
                    COLOR,
                ),
            );
            if (m.distance > 0) {
                // The label sits beside the midpoint, on the side away from
                // the right angle, 16 px off the line.
                const nx = -(b.y - a.y) / m.distance;
                const ny = (b.x - a.x) / m.distance;
                const side =
                    nx * (corner[0] - (b.x - a.x) / 2) +
                        ny * (0 - (b.y - a.y) / 2) >
                    0
                        ? -1
                        : 1;
                const off = (16 / zoom) * side;
                label_at = {
                    x: (a.x + b.x) / 2 + nx * off,
                    y: (a.y + b.y) / 2 + ny * off,
                };
                label_text = format_length(m.distance, this.#units);
            }
        }
        for (const [id, snap] of [
            ["a", a],
            ["b", this.#b],
            ["hover", this.#hover],
        ] as const) {
            if (snap) primitives.push(...marker(id, snap));
        }

        this.#place_label(label_at, label_text);
        if (!primitives.length) {
            viewer.clear_overlay_scene(MEASURE_CHANNEL);
            return;
        }
        viewer.set_overlay_scene({
            channelId: MEASURE_CHANNEL,
            context: "PCB",
            placement: "foreground",
            visible: true,
            // The overlay draws its first primitive on top; these were
            // listed bottom first.
            primitives: primitives.reverse(),
        });
    }

    /**
     * The distance label is DOM over the canvas: the board's stroke font
     * does not draw in overlay channels, and DOM text stays crisp.
     */
    #place_label(at: { x: number; y: number } | null, text: string) {
        const viewer = this.#viewer;
        // The canvas may sit directly in a shadow root.
        const parent = viewer?.canvas.parentNode;
        if (!viewer || !parent || !at || !text) {
            this.#label?.remove();
            return;
        }
        if (!this.#label) {
            this.#label = document.createElement("div");
            this.#label.className = "pcb-measure-label";
            Object.assign(this.#label.style, LABEL_STYLE);
        }
        if (this.#label.parentNode !== parent) parent.appendChild(this.#label);
        this.#label.textContent = text;
        const canvas = viewer.canvas.getBoundingClientRect();
        const origin = (
            this.#label.offsetParent ?? document.documentElement
        ).getBoundingClientRect();
        const p = viewer.viewport.camera.world_to_screen(new Vec2(at.x, at.y));
        this.#label.style.left = `${canvas.left - origin.left + p.x}px`;
        this.#label.style.top = `${canvas.top - origin.top + p.y}px`;
    }
}

function line(
    id: string,
    origin: { x: number; y: number },
    points: [number, number][],
    width: number,
    stroke: string,
    dash?: number[],
): EcadOverlayPrimitive {
    return {
        id,
        kind: "polyline",
        anchor: { kind: "world", x: origin.x, y: origin.y },
        points,
        sizing: "screen",
        stroke,
        strokeWidth: width,
        dash,
    };
}

/** Square for a pad, ring for a via, small square for a track end or edge corner, dot otherwise. */
function marker(id: string, snap: MeasureSnap): EcadOverlayPrimitive[] {
    const anchor = { kind: "world" as const, x: snap.x, y: snap.y };
    const dot: EcadOverlayPrimitive = {
        id: `${id}-dot`,
        kind: "marker",
        anchor,
        radius: 2,
        sizing: "screen",
        fill: COLOR,
    };
    const box = (padding: number): EcadOverlayPrimitive[] => [
        {
            id: `${id}-halo`,
            kind: "bbox",
            anchor: { kind: "bbox", bounds: [snap.x, snap.y, 0, 0] },
            padding,
            sizing: "screen",
            stroke: HALO,
            strokeWidth: 3.5,
        },
        {
            id: `${id}-box`,
            kind: "bbox",
            anchor: { kind: "bbox", bounds: [snap.x, snap.y, 0, 0] },
            padding,
            sizing: "screen",
            stroke: COLOR,
            strokeWidth: 1.5,
        },
    ];
    switch (snap.kind) {
        case "pad":
            return [...box(6), dot];
        case "via":
            return [
                {
                    id: `${id}-ring-halo`,
                    kind: "marker",
                    anchor,
                    radius: 8,
                    sizing: "screen",
                    fill: `${HALO}99`,
                },
                {
                    id: `${id}-ring`,
                    kind: "marker",
                    anchor,
                    radius: 6.5,
                    sizing: "screen",
                    fill: `${COLOR}55`,
                },
                dot,
            ];
        case "track-end":
        case "edge-corner":
            return [...box(4), dot];
        default:
            return [dot];
    }
}
