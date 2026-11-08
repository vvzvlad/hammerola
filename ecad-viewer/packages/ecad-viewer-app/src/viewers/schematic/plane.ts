/*
    The schematic plane's sheets as numbers: the order they stand in, where
    each one is, which one a point is on, the zoom Fit sets and the least
    the gestures go to, and where a comment stands on the plane and on its
    sheet. Screen-independent maths only; plane-viewer.ts draws them.

    A sheet's own coordinates are its paper's, (0, 0) at the paper's corner;
    on the plane a sheet instance is moved by its offset. Sheets are laid out
    by their paper, not by what is drawn on them, so the layout is known
    before any sheet is drawn.
*/

import { BBox, Vec2 } from "../../base/math";
import { PaperSize } from "../../kicad/common";
import { SHEET_GAP, world_layout } from "../../ecad-viewer/net-tracking/geometry";

/** What the plane needs of a sheet instance (`NetInstancePage`). */
export interface PlanePage {
    key: string;
    document: {
        filename: string;
        paper?: { width?: number; height?: number };
    };
    /** Unset on the root sheet only. */
    parent_key?: string;
    /** KiCad's page number of the instance. */
    number?: string;
}

/** A sheet instance and its place on the plane. */
export interface PlaneSlot<P extends PlanePage = PlanePage> {
    page: P;
    /** The paper, in the sheet's own coordinates. */
    paper: BBox;
    /** Where the paper's corner is on the plane. */
    offset: Vec2;
}

/**
 * The sheets in the order the plane shows them: the root first, then by
 * KiCad's page numbers, then the sheets without a number in the order they
 * came (the project's walk).
 */
export function plane_order<P extends PlanePage>(pages: readonly P[]): P[] {
    const number = (page: P) => Number.parseInt(page.number ?? "", 10);
    const root = pages.filter((page) => !page.parent_key);
    const rest = pages.filter((page) => page.parent_key);
    const numbered = rest
        .filter((page) => Number.isFinite(number(page)))
        .sort((a, b) => number(a) - number(b));
    const unnumbered = rest.filter((page) => !Number.isFinite(number(page)));
    return [...root, ...numbered, ...unnumbered];
}

/** A sheet's paper; a sheet that names none is A4, as KiCad draws it. */
export function paper_box(document: PlanePage["document"]): BBox {
    const [a4_w, a4_h] = PaperSize.A4;
    return new BBox(
        0,
        0,
        document.paper?.width ?? a4_w,
        document.paper?.height ?? a4_h,
    );
}

/** The sheets in `plane_order`, laid out in rows (`world_layout`). */
export function plane_slots<P extends PlanePage>(
    pages: readonly P[],
): PlaneSlot<P>[] {
    const ordered = plane_order(pages);
    const papers = ordered.map((page) => paper_box(page.document));
    const offsets = world_layout(papers, SHEET_GAP);
    return ordered.map((page, i) => ({
        page,
        paper: papers[i]!,
        offset: offsets[i]!,
    }));
}

/** A sheet's paper on the plane. */
export function slot_rect(slot: PlaneSlot): BBox {
    return new BBox(slot.offset.x, slot.offset.y, slot.paper.w, slot.paper.h);
}

/** The paper of every sheet on the plane, or null when there are none. */
export function plane_box(slots: readonly PlaneSlot[]): BBox | null {
    return slots.length ? BBox.combine(slots.map(slot_rect)) : null;
}

/** The sheet whose paper holds the plane point `at`; papers never overlap. */
export function slot_at<S extends PlaneSlot>(
    slots: readonly S[],
    at: Vec2,
): S | undefined {
    return slots.find((slot) => slot_rect(slot).contains_point(at));
}

/** The sheet under `at`, else the one nearest it. */
export function slot_nearest<S extends PlaneSlot>(
    slots: readonly S[],
    at: Vec2,
): S | undefined {
    let nearest: S | undefined;
    let distance = Infinity;
    for (const slot of slots) {
        const d = at.sub(slot_rect(slot).constrain_point(at)).magnitude;
        if (d < distance) [nearest, distance] = [slot, d];
    }
    return nearest;
}

/** The root sheet's slot: the one with no parent. */
export function root_slot<S extends PlaneSlot>(
    slots: readonly S[],
): S | undefined {
    return slots.find((slot) => !slot.page.parent_key) ?? slots[0];
}

/** The first instance of the file `filename` on the plane. */
export function first_slot<S extends PlaneSlot>(
    slots: readonly S[],
    filename: string,
): S | undefined {
    return slots.find((slot) => slot.page.document.filename === filename);
}

/**
 * The sheet a link `#<page number>` names, as KiCad writes a link to another
 * page of the schematic; undefined for any other link and for a number no
 * sheet has.
 */
export function slot_by_link<S extends PlaneSlot>(
    slots: readonly S[],
    link: string,
): S | undefined {
    if (!link.startsWith("#") || link.length < 2) return undefined;
    const number = link.slice(1);
    return slots.find((slot) => slot.page.number === number);
}

/**
 * The zoom that fits `box` into `viewport` (CSS px) with `top` px of the
 * screen left above it for the sheets' names, which are drawn in screen
 * pixels above their papers.
 */
export function fit_zoom(box: BBox, viewport: Vec2, top: number): number {
    return Math.min(viewport.x / box.w, (viewport.y - top) / box.h);
}

/** The box a camera fits to show `box` at `zoom` with `top` px above it. */
export function fit_box(box: BBox, zoom: number, top: number): BBox {
    return new BBox(box.x, box.y - top / zoom, box.w, box.h + top / zoom);
}

/**
 * How far the gestures zoom out: no further than the viewers' common floor,
 * nor than the whole plane's Fit, which on a phone lies below it, nor than
 * where the camera is, so that the first gesture never jumps.
 */
export function zoom_floor(min_zoom: number, fit: number, current: number) {
    return Math.min(
        min_zoom,
        Number.isFinite(fit) && fit > 0 ? fit : min_zoom,
        Number.isFinite(current) && current > 0 ? current : min_zoom,
    );
}

/** A comment mark as the element's `setCommentOverlays` takes it. */
export interface PlaneComment {
    id: string;
    anchor:
        | { kind: "world"; x: number; y: number; page?: string }
        | {
              kind: "source-item";
              uuid: string;
              page?: string;
              relativePoint?: [number, number];
          };
    areaBounds?: [number, number, number, number];
}

/**
 * Comment marks moved onto the plane. A comment names a sheet's file (its
 * anchor's `page`) and a point in that file's coordinates, so its mark
 * stands on every instance of the file; one naming no file is on the root
 * sheet. Its point and area move by each instance's offset; the file it
 * names stays, which is what a click on the mark reports. A mark of another
 * kind is left as it is.
 */
export function plane_comments<C extends PlaneComment>(
    comments: readonly C[],
    slots: readonly PlaneSlot[],
): C[] {
    return comments.flatMap((comment) => {
        const anchor = comment.anchor;
        if (anchor.kind !== "world") return [comment];
        const root = root_slot(slots);
        const targets = anchor.page
            ? slots.filter((slot) => slot.page.document.filename === anchor.page)
            : root
              ? [root]
              : [];
        return targets.map((slot) => {
            const { x: dx, y: dy } = slot.offset;
            const bounds = comment.areaBounds;
            return {
                ...comment,
                anchor: { ...anchor, x: anchor.x + dx, y: anchor.y + dy },
                ...(bounds
                    ? {
                          areaBounds: [
                              bounds[0] + dx,
                              bounds[1] + dy,
                              bounds[2],
                              bounds[3],
                          ] as [number, number, number, number],
                      }
                    : {}),
            };
        });
    });
}

/**
 * The sheet a comment's area drawn on the plane is on: the one under its
 * centre, else the one nearest it; and the area in that sheet's own
 * coordinates, not cut at the paper's edge. Null on an empty plane.
 */
export function area_on_sheet<S extends PlaneSlot>(
    slots: readonly S[],
    bounds: [number, number, number, number],
): { slot: S; bounds: [number, number, number, number] } | null {
    const [x, y, w, h] = bounds;
    const centre = new Vec2(x + w / 2, y + h / 2);
    const slot = slot_at(slots, centre) ?? slot_nearest(slots, centre);
    if (!slot) return null;
    return {
        slot,
        bounds: [x - slot.offset.x, y - slot.offset.y, w, h],
    };
}
