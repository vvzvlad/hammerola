/*
    What the hub's BOM draws of a board in its assembly view
    (ui/src/BomView.jsx): one side of the whole board fitted to its outline,
    with that side's parts and nothing else, and each part's box to light it
    by. The element hands these out (`renderBoardPicture`,
    `getBoardPictureSize`, `getFootprintBoxes` in ecad_viewer.ts).
*/

import { BBox } from "../base/math";
import type { KicadPCB } from "../kicad/board";
import {
    CopperVirtualLayerNames,
    FabVirtualLayerNames,
    LayerNames,
    virtual_layer_for,
} from "../viewers/board/layers";

/**
 * The box a picture of the board is fitted to: its outline (`KicadPCB.bbox`,
 * the Edge.Cuts box Fit frames), grown by 2% of its longer side so the
 * outline's own stroke stays inside.
 */
export function picture_box(board: KicadPCB): BBox {
    const outline = board.bbox;
    return outline.grow(Math.max(outline.w, outline.h) * 0.02);
}

/**
 * The layers a picture of one side draws, by name: that side's pads (a
 * through-hole pad is on the copper of both, as KiCad draws it), its
 * silkscreen and fab with their designators and values, the holes of pads
 * and of the footprints' unplated holes, and the outline. No tracks, zones
 * or vias, no inner copper, nothing of the other side, no user, drawing or
 * margin layer, no selection.
 */
export function picture_layers(bottom: boolean): Set<string> {
    const side = bottom ? "B" : "F";
    const texts = (layer: string) => [
        layer,
        virtual_layer_for(layer, FabVirtualLayerNames.fp_ref),
        virtual_layer_for(layer, FabVirtualLayerNames.fp_value),
    ];
    return new Set([
        virtual_layer_for(`${side}.Cu`, CopperVirtualLayerNames.pads),
        ...texts(`${side}.SilkS`),
        ...texts(`${side}.Fab`),
        LayerNames.pad_holes,
        LayerNames.pad_holewalls,
        LayerNames.non_plated_holes,
        LayerNames.edge_cuts,
    ]);
}

/** A footprint as the assembly view lights it. */
export interface FootprintBox {
    reference: string;
    /** On the back of the board. */
    bottom: boolean;
    /** Its box's four corners, in the board's millimetres. */
    outline: [number, number][];
}

/**
 * Every footprint's box: the box the viewer outlines a selected footprint
 * with (`Footprint.bbox`, its graphics turned with it and squared to the
 * board's axes) and its pads', as a board inset frames a footprint, so a part
 * with no silkscreen or fab graphics still has the box of its pads.
 */
export function footprint_boxes(board: KicadPCB): FootprintBox[] {
    return board.footprints.map((fp) => {
        const { x, y, x2, y2 } = BBox.combine([
            fp.bbox,
            ...fp.pads.map((pad) => pad.bbox),
        ]);
        return {
            reference: fp.reference,
            bottom: fp.layer?.startsWith("B.") ?? false,
            outline: [
                [x, y],
                [x2, y],
                [x2, y2],
                [x, y2],
            ],
        };
    });
}
