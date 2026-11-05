/*
    Inset camera: a 2D view onto another document's scene.

    An inset does not own a scene. It owns this camera and a canvas, and the
    viewer that already holds the document renders the scene through it. The
    camera is centre + zoom + rotation + mirror, applied about the centre of
    the inset's canvas.

    A PCB inset can also show the board in 3D (IN-61), leaning back by
    `tilt`. The 3D view is orthographic and pivots on the board surface, so
    on that surface the lean is exact in 2D: screen y shrinks by cos(tilt).
    Pads sit on the surface, so pan, zoom, hover, outlines and leaders all
    keep using this one matrix.
*/

import { BBox, Matrix3, Vec2 } from "../../base/math";

export interface InsetCamera {
    /** World point shown at the centre of the inset canvas. */
    center: Vec2;
    /** Screen pixels (CSS) per world unit. */
    zoom: number;
    /** Radians, clockwise on screen. */
    rotation: number;
    /** Mirror about the vertical axis: a bottom-side view. */
    mirror: boolean;
    /** Show the 3D board instead of the 2D one (PCB insets). */
    view3d?: boolean;
    /** Radians the 3D view leans back from straight down. */
    tilt?: number;
}

/** The lean the 3D view opens with, and the most an orbit leans it. */
export const DEFAULT_TILT = (40 * Math.PI) / 180;
export const MAX_TILT = (75 * Math.PI) / 180;

/** The lean in effect: none in 2D. */
export function camera_tilt(camera: InsetCamera) {
    return camera.view3d ? (camera.tilt ?? 0) : 0;
}

/** World → inset canvas (CSS pixels) for a canvas of `w`×`h`. */
export function inset_matrix(camera: InsetCamera, w: number, h: number) {
    // Matrix3.rotation turns counter-clockwise on a y-down screen; the inset
    // camera's rotation is clockwise, like the toolbar's ↻.
    return Matrix3.translation(w / 2, h / 2)
        .scale_self(1, Math.cos(camera_tilt(camera)))
        .rotate_self(-camera.rotation)
        .scale_self(camera.mirror ? -camera.zoom : camera.zoom, camera.zoom)
        .translate_self(-camera.center.x, -camera.center.y);
}

export function world_to_inset(
    camera: InsetCamera,
    w: number,
    h: number,
    point: Vec2,
): Vec2 {
    return inset_matrix(camera, w, h).transform(point);
}

export function inset_to_world(
    camera: InsetCamera,
    w: number,
    h: number,
    point: Vec2,
): Vec2 {
    return inset_matrix(camera, w, h).inverse().transform(point);
}

export interface FitOptions {
    /** Frame this many times the focus box, so neighbours show. */
    span?: number;
    /** Never frame less than this many world units across. */
    min_extent?: number;
}

/**
 * Centre on `focus` and zoom so its neighbourhood fills the canvas. Keeps
 * rotation, mirror and tilt as they are.
 */
export function fit_camera(
    camera: InsetCamera,
    focus: BBox,
    w: number,
    h: number,
    { span = 2, min_extent = 4 }: FitOptions = {},
): InsetCamera {
    const extent_x = Math.max(focus.w * span, min_extent);
    const extent_y = Math.max(focus.h * span, min_extent);
    camera.center = new Vec2(focus.x + focus.w / 2, focus.y + focus.h / 2);
    camera.zoom = Math.min(
        Math.max(1, w) / extent_x,
        Math.max(1, h) / (extent_y * Math.cos(camera_tilt(camera))),
    );
    return camera;
}

/** Zoom by `factor` keeping the world point under `cursor` fixed. */
export function zoom_about(
    camera: InsetCamera,
    w: number,
    h: number,
    cursor: Vec2,
    factor: number,
): InsetCamera {
    const before = inset_to_world(camera, w, h, cursor);
    camera.zoom *= factor;
    const after = inset_to_world(camera, w, h, cursor);
    camera.center = new Vec2(
        camera.center.x + (before.x - after.x),
        camera.center.y + (before.y - after.y),
    );
    return camera;
}

/** Drag the scene by a screen delta: the content follows the pointer. */
export function pan_by(
    camera: InsetCamera,
    dx: number,
    dy: number,
): InsetCamera {
    // Only the linear part matters for a delta, so any canvas size works.
    const inverse = inset_matrix(camera, 0, 0).inverse();
    const a = inverse.transform(new Vec2(0, 0));
    const b = inverse.transform(new Vec2(dx, dy));
    camera.center = new Vec2(
        camera.center.x - (b.x - a.x),
        camera.center.y - (b.y - a.y),
    );
    return camera;
}
