/*
    Contracts between the inset session and the documents it shows.
*/

import type { BBox, Vec2 } from "../../base/math";
import type { InsetCamera } from "./camera";

export type InsetKind = "pcb" | "sch";

/** Which face of the target an inset shows; drives the header badge. */
/** `none`: the designator is not in that document (a header-only inset). */
export type InsetSide = "top" | "bottom" | "sch" | "none";

/** What a provider resolves a designator + pin/pad number to. */
export interface InsetTarget {
    kind: InsetKind;
    reference: string;
    /** Pin or pad number. */
    number: string;
    /** Short trailing label, e.g. the pin name or the sheet name. */
    detail?: string;
    side: InsetSide;
    /** World box the inset frames when it opens or is refit. */
    focus: BBox;
    /** World point the leader ends at: the matching pad or pin. */
    anchor: Vec2;
    /** World box of that pad or pin, outlined in the chain colour. */
    anchor_box?: BBox;
    /** Open mirrored (bottom-side footprint). */
    mirror: boolean;
}

/**
 * Where a PCB inset's 3D view stands (IN-61): drawn, still loading (the inset
 * shows 2D meanwhile), or not available for this board (no 3D bundle).
 */
export type Inset3DState = "ready" | "loading" | "unavailable";

/**
 * The host's 3D board, drawing inset views (IN-61). ecad-viewer has no 3D
 * renderer of its own; a host that has one (Prism's 3D tab) registers it on
 * the element holding the PCB with `setInset3D`.
 */
export interface InsetScene3D {
    state(): Inset3DState;
    /** Start loading the 3D board, if it is not loaded yet. */
    load(): void;
    /**
     * Draw the board through `camera` (KiCad mm, as the 2D inset camera)
     * into `canvas`, sized by CSS. `bottom` pivots on the bottom surface.
     * `key` names the inset, for what the host keeps resident. Returns
     * false when nothing was drawn.
     */
    render(
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
        bottom: boolean,
        key: string,
    ): boolean;
    /** The inset `key` closed. */
    release?(key: string): void;
    /** Call `listener` when the 3D picture or the state changed. */
    subscribe(listener: () => void): () => void;
}

/** A pin or pad under the pointer inside an inset. */
export interface InsetHit {
    reference: string;
    number: string;
    /** World box, for the hover outline. */
    box: BBox;
}

/**
 * One document kind's way of serving insets. The viewer that already holds
 * the document implements this; insets never copy the scene.
 */
export interface InsetProvider {
    readonly kind: InsetKind;
    resolve(reference: string, number: string): Promise<InsetTarget | null>;
    /** Draw `target`'s scene through `camera` into the inset's 2D canvas. */
    render(
        target: InsetTarget,
        camera: InsetCamera,
        canvas: HTMLCanvasElement,
    ): void;
    /**
     * The inset showing `target` closed, or a resolved target was discarded
     * (a newer hover won). Providers that hold resources per target free
     * them here.
     */
    release?(target: InsetTarget): void;
    /**
     * False while the document is still loading. A null resolve from an
     * unready provider means "not yet", not "not in this document".
     */
    ready?(): boolean;
    /** The pin or pad at a world point of `target`'s scene, if any. */
    hit_test?(target: InsetTarget, world: Vec2): InsetHit | null;
    /**
     * Call `listener` when the scene insets show changed (layer visibility,
     * highlights, selection, variant). Returns an unsubscribe function.
     */
    subscribe?(listener: () => void): () => void;
    /**
     * PCB insets: the 3D view's state, or null when the host has no 3D
     * board. `render` draws 3D for a camera with `view3d` once ready.
     */
    state_3d?(): Inset3DState | null;
    /** Start loading the 3D board. */
    load_3d?(): void;
}

/**
 * Where a leader starts: a main viewer, or (for chained insets) a parent
 * inset. Returns viewport (client) coordinates, or null when the point is
 * not on screen.
 */
export interface InsetSource {
    world_to_client(point: Vec2): Vec2 | null;
}
