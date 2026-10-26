/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Color } from "../../base/color";
import { is_string } from "../../base/types";
import { KicadPCB, type BoardTheme } from "../../kicad";
import {
    ViewLayerNames as BaseLayerNames,
    ViewLayerSet as BaseLayerSet,
    ViewLayer,
    type VisibilityType,
} from "../base/view-layers";
export { ViewLayer };

/** Board view layer names
 *
 * There are view layers that correspond to respective board layers, but
 * there are also several graphical layers that are "virtual", such as layers
 * for drill holes and such.
 */
export enum LayerNames {
    /**
     * Low-alpha hatch drawn over footprint-effective DNP (VAR-06).
     *
     * Declared first because `LayerSet` adds layers front-to-back and draws
     * them back-to-front: only a layer added first is painted above the board
     * content. It is not part of `in_ui_order`, so it never appears as a
     * user-managed board layer.
     */
    dnp = ":DNP",
    /**
     * Net-name / pad-number labels for pads flashed on more than one copper
     * layer (through-hole pads) and for vias. Like KiCad's
     * `LAYER_PAD_NETNAMES` / `LAYER_VIA_NETNAMES`, they sit above the hole
     * layers so a drill never covers the text. Labels for SMD pads, tracks
     * and arcs live on the per-copper `:X.Cu:NetNames` virtual layers instead.
     * Both kinds are non-interactive and rebuilt on zoom by
     * `NetLabelLayers`, not by the document painter.
     */
    pad_netnames = ":Pad:NetNames",
    via_netnames = ":Via:NetNames",
    dwgs_user = "Dwgs.User",
    cmts_user = "Cmts.User",
    eco1_user = "Eco1.User",
    eco2_user = "Eco2.User",
    edge_cuts = "Edge.Cuts",
    margin = "Margin",
    user_1 = "User.1",
    user_2 = "User.2",
    user_3 = "User.3",
    user_4 = "User.4",
    user_5 = "User.5",
    user_6 = "User.6",
    user_7 = "User.7",
    user_8 = "User.8",
    user_9 = "User.9",
    anchors = ":Anchors",
    non_plated_holes = ":NonPlatedHoles",
    via_holes = ":Via:Holes",
    pad_holes = ":Pad:Holes",
    pad_holewalls = ":Pad:HoleWalls",
    via_holewalls = ":Via:HoleWalls",
    // pads_front = ":Pads:Front",
    f_cu = "F.Cu",
    f_mask = "F.Mask",
    f_silks = "F.SilkS",
    f_adhes = "F.Adhes",
    f_paste = "F.Paste",
    f_crtyd = "F.CrtYd",
    f_fab = "F.Fab",
    in1_cu = "In1.Cu",
    in2_cu = "In2.Cu",
    in3_cu = "In3.Cu",
    in4_cu = "In4.Cu",
    in5_cu = "In5.Cu",
    in6_cu = "In6.Cu",
    in7_cu = "In7.Cu",
    in8_cu = "In8.Cu",
    in9_cu = "In9.Cu",
    in10_cu = "In10.Cu",
    in11_cu = "In11.Cu",
    in12_cu = "In12.Cu",
    in13_cu = "In13.Cu",
    in14_cu = "In14.Cu",
    in15_cu = "In15.Cu",
    in16_cu = "In16.Cu",
    in17_cu = "In17.Cu",
    in18_cu = "In18.Cu",
    in19_cu = "In19.Cu",
    in20_cu = "In20.Cu",
    in21_cu = "In21.Cu",
    in22_cu = "In22.Cu",
    in23_cu = "In23.Cu",
    in24_cu = "In24.Cu",
    in25_cu = "In25.Cu",
    in26_cu = "In26.Cu",
    in27_cu = "In27.Cu",
    in28_cu = "In28.Cu",
    in29_cu = "In29.Cu",
    in30_cu = "In30.Cu",
    // pads_back = ":Pads:Back",
    b_cu = "B.Cu",
    b_mask = "B.Mask",
    b_silks = "B.SilkS",
    b_adhes = "B.Adhes",
    b_paste = "B.Paste",
    b_crtyd = "B.CrtYd",
    b_fab = "B.Fab",
    drawing_sheet = BaseLayerNames.drawing_sheet,
    grid = BaseLayerNames.grid,
}

export const HoleLayerNames = [
    LayerNames.non_plated_holes,
    LayerNames.via_holes,
    LayerNames.pad_holes,
    LayerNames.pad_holewalls,
    LayerNames.via_holewalls,
];

export const CopperLayerNames = [
    LayerNames.f_cu,
    LayerNames.in1_cu,
    LayerNames.in2_cu,
    LayerNames.in3_cu,
    LayerNames.in4_cu,
    LayerNames.in5_cu,
    LayerNames.in6_cu,
    LayerNames.in7_cu,
    LayerNames.in8_cu,
    LayerNames.in9_cu,
    LayerNames.in10_cu,
    LayerNames.in11_cu,
    LayerNames.in12_cu,
    LayerNames.in13_cu,
    LayerNames.in14_cu,
    LayerNames.in15_cu,
    LayerNames.in16_cu,
    LayerNames.in17_cu,
    LayerNames.in18_cu,
    LayerNames.in19_cu,
    LayerNames.in20_cu,
    LayerNames.in21_cu,
    LayerNames.in22_cu,
    LayerNames.in23_cu,
    LayerNames.in24_cu,
    LayerNames.in25_cu,
    LayerNames.in26_cu,
    LayerNames.in27_cu,
    LayerNames.in28_cu,
    LayerNames.in29_cu,
    LayerNames.in30_cu,
    LayerNames.b_cu,
];

export enum CopperVirtualLayerNames {
    bb_via_holes = "BBViaHoles",
    bb_via_hole_walls = "BBViaHoleWalls",
    zones = "Zones",
    pads = "Pads",
    /** Track, arc and single-layer pad labels for this copper layer. */
    netnames = "NetNames",
}

export const ObjLayerNames = [
    LayerNames.f_fab,
    LayerNames.b_fab,
    LayerNames.f_silks,
    LayerNames.b_silks,
];

const ObjLayerNamesSet = new Set(ObjLayerNames);

/**
 * Opacity of the DNP hatch overlay (VAR-06). Low enough that pads, copper and
 * silkscreen below stay readable; the hatch is a marker, not a mask.
 */
export const DNP_HATCH_OPACITY = 0.18;

/**
 * KiCad's default net-label colours: `board.track_net_names` is white at 0.7,
 * its inverse is used over bright copper, and via labels are never themed and
 * fall back to opaque white. Pad labels on through-hole pads use the light
 * colour too (`LAYER_PAD_NETNAMES` is loaded from the track colour).
 */
export const NetLabelColors = {
    light: new Color(1, 1, 1, 0.7),
    dark: new Color(0, 0, 0, 0.7),
    via: new Color(1, 1, 1, 1),
} as const;

export enum FabVirtualLayerNames {
    hidden_text = "hidden_text",
    fp_value = "fp_value",
    fp_ref = "fp_ref",
}

export function virtual_layer_for(
    physical_layer: string,
    virtual_name: string,
) {
    return `:${physical_layer}:${virtual_name}`;
}

function is_virtual(name: string) {
    return name.startsWith(":");
}

function is_virtual_for(physical_layer: string, layer_name: string) {
    return (
        is_virtual(layer_name) && layer_name.startsWith(`:${physical_layer}:`)
    );
}

function is_copper(name: string) {
    return name.endsWith(".Cu");
}

export function* copper_layers_between(
    start_layer_name: string,
    end_layer_name: string,
) {
    let found_start = false;
    for (const layer_name of CopperLayerNames) {
        if (layer_name == start_layer_name) {
            found_start = true;
        }
        if (found_start) {
            yield layer_name;
        }
        if (layer_name == end_layer_name) {
            return;
        }
    }
}

/**
 * Board view layer set
 */
export class LayerSet extends BaseLayerSet {
    /**
     * Create a new LayerSet
     */
    constructor(
        board: KicadPCB,
        public theme: BoardTheme,
    ) {
        super();

        const board_layers = new Map();

        for (const l of board.layers) {
            board_layers.set(l.canonical_name, l);
        }

        for (const layer_name of Object.values(LayerNames)) {
            // Skip physical layers that aren't present on the board.
            if (!is_virtual(layer_name) && !board_layers.has(layer_name)) {
                continue;
            }

            let visible: VisibilityType = true;
            let interactive = false;

            // The DNP hatch is a display overlay: never interactive, and
            // painted at low opacity so it marks a footprint without reading
            // as copper, pads or silkscreen.
            if (layer_name === LayerNames.dnp) {
                const layer = new ViewLayer(
                    this,
                    layer_name,
                    true,
                    false,
                    this.dnp_hatch_color(),
                );
                layer.opacity = DNP_HATCH_OPACITY;
                this.add(layer);
                continue;
            }

            // These virtual layers require at least one visible copper layer to be shown.
            if (HoleLayerNames.includes(layer_name)) {
                visible = () => this.is_any_copper_layer_visible();
                interactive = true;
            }

            // Multi-layer pad and via labels follow the copper stack as a
            // whole; they are never a click target.
            if (
                layer_name === LayerNames.pad_netnames ||
                layer_name === LayerNames.via_netnames
            ) {
                this.add(
                    new ViewLayer(
                        this,
                        layer_name,
                        () => this.is_any_copper_layer_visible(),
                        false,
                        (layer_name === LayerNames.via_netnames
                            ? NetLabelColors.via
                            : NetLabelColors.light
                        ).copy(),
                    ),
                );
                continue;
            }

            // Pad layers require that the front or back layer is visible.
            // if (layer_name == LayerNames.pads_front) {
            //     visible = () => true;
            //     interactive = true;
            // }
            // if (layer_name == LayerNames.pads_back) {
            //     visible = () => true;
            //     interactive = true;
            // }

            // Copper layers require additional virual layers for zones and
            // blind/buried vias. Those are generated here.
            // Zone virtual layers for copper layers require that the referenced
            // copper layer is visible.
            if (is_copper(layer_name)) {
                interactive = true;

                // Added first so it draws above this copper's pads, zones and
                // blind/buried via layers (KiCad's `NETNAMES_LAYER_INDEX`).
                this.add(
                    new ViewLayer(
                        this,
                        virtual_layer_for(
                            layer_name,
                            CopperVirtualLayerNames.netnames,
                        ),
                        () => this.by_name(layer_name)!.visible,
                        false,
                        this.netname_color_for(layer_name),
                    ),
                );
                this.add(
                    new ViewLayer(
                        this,
                        virtual_layer_for(
                            layer_name,
                            CopperVirtualLayerNames.bb_via_holes,
                        ),
                        () => this.by_name(layer_name)!.visible,
                        false,
                        this.color_for(LayerNames.via_holes),
                    ),
                );
                this.add(
                    new ViewLayer(
                        this,
                        virtual_layer_for(
                            layer_name,
                            CopperVirtualLayerNames.bb_via_hole_walls,
                        ),
                        () => this.by_name(layer_name)!.visible,
                        false,
                        this.color_for(LayerNames.via_holewalls),
                    ),
                );
                this.add(
                    new ViewLayer(
                        this,
                        virtual_layer_for(
                            layer_name,
                            CopperVirtualLayerNames.zones,
                        ),
                        () => this.by_name(layer_name)!.visible,
                        false,
                        this.color_for(layer_name),
                    ),
                );
                this.add(
                    new ViewLayer(
                        this,
                        virtual_layer_for(
                            layer_name,
                            CopperVirtualLayerNames.pads,
                        ),
                        () => this.by_name(layer_name)!.visible,
                        false,
                        this.color_for(layer_name),
                    ),
                );
            }

            if (ObjLayerNamesSet.has(layer_name)) {
                interactive = true;
                for (const it of [
                    FabVirtualLayerNames.hidden_text,
                    FabVirtualLayerNames.fp_value,
                    FabVirtualLayerNames.fp_ref,
                ])
                    this.add(
                        new ViewLayer(
                            this,
                            virtual_layer_for(layer_name, it),
                            () => this.by_name(layer_name)!.visible,
                            false,
                            this.color_for(layer_name),
                        ),
                    );
            }
            this.add(
                new ViewLayer(
                    this,
                    layer_name,
                    visible,
                    interactive,
                    this.color_for(layer_name),
                ),
            );
        }
    }

    color_for(layer_name: string): Color {
        const color = this.color_for_impl(layer_name);

        if (!is_copper(layer_name)) {
            color.a = 0.8;
        }

        return color;
    }

    /**
     * The DNP hatch color: KiCad's PCB DNP marker tone, painted at full
     * intensity because the layer's own opacity makes it faint.
     */
    dnp_hatch_color(): Color {
        return this.theme.drc_error.with_alpha(1);
    }

    /**
     * Label colour for tracks and single-layer pads on a copper layer: light
     * on dark copper, inverted on bright copper, as
     * `PCB_RENDER_SETTINGS::LoadColors` picks it from the copper's brightness.
     */
    netname_color_for(copper_layer_name: string): Color {
        const copper = this.color_for_impl(copper_layer_name);
        const brightness =
            copper.r * 0.299 + copper.g * 0.587 + copper.b * 0.117;
        return (
            brightness > 0.5 ? NetLabelColors.dark : NetLabelColors.light
        ).copy();
    }

    /**
     * Get the theme color for a given layer.
     */
    color_for_impl(layer_name: string): Color {
        switch (layer_name) {
            case LayerNames.drawing_sheet:
                return (this.theme["worksheet"] as Color) ?? Color.white;
            case LayerNames.non_plated_holes:
                return (this.theme["non_plated_hole"] as Color) ?? Color.white;
            case LayerNames.via_holes:
                return (this.theme["via_hole"] as Color) ?? Color.white;
            case LayerNames.via_holewalls:
                return (this.theme["via_through"] as Color) ?? Color.white;
            case LayerNames.pad_holes:
                return (this.theme["background"] as Color) ?? Color.white;
            case LayerNames.pad_holewalls:
                return (this.theme["pad_through_hole"] as Color) ?? Color.white;
        }

        let name = layer_name;

        name = name.replace(":Zones:", "").replace(".", "_").toLowerCase();

        if (name.endsWith("_cu")) {
            name = name.replace("_cu", "");
            const copper_theme = this.theme.copper;
            return (
                copper_theme[name as keyof typeof copper_theme] ?? Color.white
            );
        }

        type KeyType = keyof Omit<BoardTheme, "copper">;

        return this.theme[name as KeyType] ?? Color.white;
    }

    /**
     * @yields layers that coorespond to board layers that should be
     *      displayed in the layer selection UI
     */
    *in_ui_order() {
        const order = [
            ...CopperLayerNames,
            LayerNames.f_adhes,
            LayerNames.b_adhes,
            LayerNames.f_paste,
            LayerNames.b_paste,
            LayerNames.f_silks,
            LayerNames.b_silks,
            LayerNames.f_mask,
            LayerNames.b_mask,
            LayerNames.dwgs_user,
            LayerNames.cmts_user,
            LayerNames.eco1_user,
            LayerNames.eco2_user,
            LayerNames.edge_cuts,
            LayerNames.margin,
            LayerNames.f_crtyd,
            LayerNames.b_crtyd,
            LayerNames.f_fab,
            LayerNames.b_fab,
            LayerNames.user_1,
            LayerNames.user_2,
            LayerNames.user_3,
            LayerNames.user_4,
            LayerNames.user_5,
            LayerNames.user_6,
            LayerNames.user_7,
            LayerNames.user_8,
            LayerNames.user_9,
        ];

        for (const name of order) {
            const layer: ViewLayer = this.by_name(name as string)!;

            if (layer) {
                yield layer;
            }
        }
    }

    *fp_reference_txt_layers() {
        for (const copper_name of ObjLayerNames) {
            const layer = this.by_name(
                virtual_layer_for(copper_name, FabVirtualLayerNames.fp_ref),
            );
            if (layer) {
                yield layer;
            }
        }
    }

    is_fp_reference_txt_layers_visible() {
        for (const layer of this.fp_reference_txt_layers()) {
            if (layer.opacity !== 0) return true;
        }
        return false;
    }

    *fp_value_txt_layers() {
        for (const copper_name of ObjLayerNames) {
            const layer = this.by_name(
                virtual_layer_for(copper_name, FabVirtualLayerNames.fp_value),
            );
            if (layer) {
                yield layer;
            }
        }
    }

    is_fp_value_txt_layers_visible() {
        for (const layer of this.fp_value_txt_layers()) {
            if (layer.opacity !== 0) return true;
        }
        return false;
    }

    *fp_txt_layers() {
        for (const obj of [
            FabVirtualLayerNames.fp_ref,
            FabVirtualLayerNames.fp_value,
        ])
            for (const copper_name of ObjLayerNames) {
                const layer = this.by_name(virtual_layer_for(copper_name, obj));
                if (layer) {
                    yield layer;
                }
            }
    }

    is_fp_txt_layers_visible() {
        for (const layer of this.fp_txt_layers()) {
            if (layer.opacity !== 0) return true;
        }
        return false;
    }

    *hidden_txt_layers() {
        for (const copper_name of ObjLayerNames) {
            const layer = this.by_name(
                virtual_layer_for(
                    copper_name,
                    FabVirtualLayerNames.hidden_text,
                ),
            );
            if (layer) {
                yield layer;
            }
        }
    }

    is_hidden_txt_layers_visible() {
        for (const layer of this.hidden_txt_layers()) {
            if (layer.opacity !== 0) return true;
        }
        return false;
    }

    *copper_layers() {
        for (const name of CopperLayerNames) {
            const layer = this.by_name(name);
            if (layer) {
                yield layer;
            }
        }
    }

    *via_layers() {
        yield this.by_name(LayerNames.via_holes)!;
        yield this.by_name(LayerNames.via_holewalls)!;

        for (const copper_name of CopperLayerNames) {
            for (const virtual_name of [
                CopperVirtualLayerNames.bb_via_hole_walls,
                CopperVirtualLayerNames.bb_via_holes,
            ]) {
                const layer = this.by_name(
                    virtual_layer_for(copper_name, virtual_name),
                );
                if (layer) {
                    yield layer;
                }
            }
        }
    }

    *zone_layers() {
        for (const copper_name of CopperLayerNames) {
            const zones_name = virtual_layer_for(
                copper_name,
                CopperVirtualLayerNames.zones,
            );
            const layer = this.by_name(zones_name);
            if (layer) {
                yield layer;
            }
        }
    }

    *pad_layers() {
        for (const name of CopperLayerNames) {
            const pad_layer = this.by_name(
                virtual_layer_for(name, CopperVirtualLayerNames.pads),
            );
            if (pad_layer) {
                yield pad_layer;
            }
        }

        yield this.by_name(LayerNames.f_mask)!;
        yield this.by_name(LayerNames.b_mask)!;
        yield this.by_name(LayerNames.f_paste)!;
        yield this.by_name(LayerNames.b_paste)!;
    }

    *pad_hole_layers() {
        yield this.by_name(LayerNames.pad_holes)!;
        yield this.by_name(LayerNames.pad_holewalls)!;
    }

    /**
     * Every layer that can carry a net-name or pad-number label. Track and
     * single-layer pad labels share the per-copper layer, so which *kinds* of
     * label are drawn is decided by `NetLabelLayers`, not by these layers.
     */
    *netname_layers() {
        yield this.by_name(LayerNames.pad_netnames)!;
        yield this.by_name(LayerNames.via_netnames)!;
        for (const copper_name of CopperLayerNames) {
            const layer = this.by_name(
                virtual_layer_for(
                    copper_name,
                    CopperVirtualLayerNames.netnames,
                ),
            );
            if (layer) {
                yield layer;
            }
        }
    }

    /**
     * @returns true if any copper layer is enabled and visible.
     */
    is_any_copper_layer_visible(): boolean {
        for (const layer of this.copper_layers()) {
            if (layer.visible) {
                return true;
            }
        }
        return false;
    }

    /**
     * Highlights the given layer.
     *
     * The board viewer has to make sure to also highlight associated virtual
     * layers when a physical layer is highlighted
     */
    override highlight(layer: string | ViewLayer | null): void {
        let layer_name = "";
        if (layer instanceof ViewLayer) {
            layer_name = layer.name;
        } else if (is_string(layer)) {
            layer_name = layer;
        }

        const matching_layers = this.query(
            (l) => l.name == layer_name || is_virtual_for(layer_name, l.name),
        );

        super.highlight(matching_layers);
    }
}
