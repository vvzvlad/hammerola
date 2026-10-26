import type { EcadDiffPaintStatus } from "../base/diff-presentation";

/**
 * Which copper layers a selected route occupies, on one painted revision.
 *
 * Lives beside the board layer vocabulary rather than on the viewer class,
 * because it reasons about KiCad layer names and nothing about rendering — and
 * because the viewer is a thousand-line component that should not be the home
 * for every board fact that happens to have a caller there.
 */

export type BoardDiffSelectionEntry = {
    item: object;
    status: Exclude<EcadDiffPaintStatus, "unchanged">;
    routing: boolean;
};

/**
 * Copper layers that carry the selected route in one painted revision.
 *
 * Track and arc layers are authoritative. A through-via may span every copper
 * layer in the stack, but that does not mean the route has a trace on every
 * intermediate layer. Via endpoints are used only when the selected change
 * contains no track geometry (for example, a via-only fabrication edit).
 */
export function diff_selection_copper_layers(
    entries: ReadonlyArray<BoardDiffSelectionEntry>,
): Set<string> {
    const track_layers = new Set<string>();
    const via_end_layers = new Set<string>();
    for (const entry of entries) {
        if (!entry.routing) continue;
        const candidate = entry.item as {
            typeId?: string;
            layer?: string | { name?: string };
            layers?: string[];
        };
        const layer =
            typeof candidate.layer === "string"
                ? candidate.layer
                : candidate.layer?.name;
        if (layer?.endsWith(".Cu") && candidate.typeId !== "Via") {
            track_layers.add(layer);
        }
        if (candidate.typeId === "Via" && candidate.layers?.length) {
            const endpoints = [candidate.layers[0], candidate.layers.at(-1)];
            for (const name of endpoints) {
                if (name?.endsWith(".Cu")) via_end_layers.add(name);
            }
        }
    }
    return track_layers.size ? track_layers : via_end_layers;
}
