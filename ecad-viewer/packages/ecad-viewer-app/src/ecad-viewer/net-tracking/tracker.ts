/*
    NetTracker: `~` on the schematic, and the world view it opens.

    The element hands it every schematic selection and every key. `~` (held
    while clicking, or pressed after a click) acts on the selected label,
    sheet entry, wire or power symbol:

    - a local label joins its namesakes on its sheet (the main view's, or
      that sheet's inside the world view);
    - anything that leaves the sheet (global or hierarchical label, sheet
      entry, power rail, or a wire carrying one) opens the world view, or,
      while it is open, chains that net in. Escape closes it.

    Selections made inside the world view are reported like the main view's,
    on that sheet's own page. While the view is open the main view underneath
    does not reset what `~` acts on (the host echoes selections back to it).
*/

import {
    Label,
    PinInstance,
    SchematicSymbol,
    Wire,
} from "../../kicad/schematic";
import type { SchematicViewer } from "../../viewers/schematic/viewer";
import type { SchematicNetMembers } from "../../viewers/schematic/net-highlight";
import { normalize_schematic_selection } from "../host-adapter";
import type { EcadSemanticSelectionDetail } from "../host-adapter";
import {
    SchematicInsetProvider,
    type SchematicInsetHost,
    type SchematicPageView,
} from "../insets/schematic-provider";
import {
    is_power,
    net_instance_at,
    wire_instance,
    type NetInstancePage,
} from "./net-graph";
import { WorldView } from "./world-view";

export interface NetTrackerHost {
    /** Every schematic page instance with its place in the hierarchy. */
    pages(): NetInstancePage[];
    /** The main schematic view, while there is one. */
    viewer(): SchematicViewer | null;
    /** What scene providers read: pages, theme, variant. */
    scene_host(): SchematicInsetHost;
    /** Whether the schematic is the tab in front. */
    showing(): boolean;
    /** Report a selection made in the world view (`null`: nothing picked). */
    select(detail: EcadSemanticSelectionDetail | null): void;
    /** Show `page` in the main view, framing `uuid` when given. */
    open_page(page: string, uuid?: string): void;
}

/** Something on a page that `~` can act on. */
interface Traceable {
    page: string;
    uuid: string;
}

/** World-view scenes kept besides the open sheets, for going back and forth. */
const WORLD_SCENES = 12;

export class NetTracker {
    #world: WorldView | null = null;
    #scenes: SchematicInsetProvider | null = null;
    #nets: readonly SchematicNetMembers[] = [];
    #selected: Traceable | null = null;
    #held = false;

    constructor(private readonly host: NetTrackerHost) {}

    get world_open() {
        return this.#world?.open ?? false;
    }

    /** The main view's highlighted nets, for the world view's sheets too. */
    set_highlighted_nets(nets: readonly SchematicNetMembers[]) {
        this.#nets = nets;
        this.#scenes?.set_highlighted_nets(nets);
    }

    /** A selection in the main view (`page` is its sheet instance). */
    selected_in_main(item: unknown, page: string | null) {
        if (this.world_open) return;
        const uuid = traceable_uuid(item);
        this.#selected = uuid && page ? { page, uuid } : null;
        if (this.#held && this.#selected) this.#trace(this.#selected);
    }

    /** Keys: `~` traces, Escape closes the world view. True when used. */
    key_down(event: KeyboardEvent): boolean {
        if (event.key === "Escape" && this.world_open) {
            this.hide_world_view();
            return true;
        }
        if (
            !is_tilde(event) ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            !this.host.showing()
        )
            return false;
        if (!event.repeat) {
            this.#held = true;
            if (this.#selected) this.#trace(this.#selected);
        }
        return true;
    }

    /** A key went up, or the window lost focus (`null`). */
    key_up(event: KeyboardEvent | null) {
        if (!event || is_tilde(event)) this.#held = false;
    }

    async show_world_view(page: string, uuid: string): Promise<boolean> {
        const from = net_instance_at(this.host.pages(), page, uuid);
        if (!from || !this.host.viewer()) return false;
        return this.#world_view().show(from);
    }

    hide_world_view() {
        this.#world?.close();
    }

    #world_view(): WorldView {
        if (this.#world) return this.#world;
        this.#scenes = new SchematicInsetProvider(
            this.host.scene_host(),
            WORLD_SCENES,
            true,
        );
        this.#scenes.set_highlighted_nets(this.#nets);
        const scenes = this.#scenes;
        this.#world = new WorldView({
            container: () => {
                // The canvas sits in the viewer element's shadow root; the
                // view is placed absolutely against that element.
                const parent = this.host.viewer()?.canvas.parentNode;
                const anchor =
                    parent instanceof ShadowRoot
                        ? parent.host
                        : (parent as HTMLElement | null);
                if (
                    anchor instanceof HTMLElement &&
                    getComputedStyle(anchor).position === "static"
                )
                    anchor.style.position = "relative";
                return (parent as ParentNode | null) ?? null;
            },
            pages: () => this.host.pages(),
            page_view: (key) => scenes.page_view(key),
            subscribe: (listener) => scenes.subscribe(listener),
            open_page: (key, uuid) => this.host.open_page(key, uuid),
            select: (view, item, modifiers) =>
                this.#selected_in_world(view, item, modifiers.shift),
            background: () =>
                this.host.viewer()?.renderer.background_color.to_css() ??
                "#000",
            navigation: () => this.host.viewer()?.navigation_options,
            insets: () =>
                this.host.viewer()?.viewport?.camera.fit_insets ?? null,
            main_view: () => {
                const viewer = this.host.viewer();
                const page = viewer?.instance_context?.project_path;
                const box = viewer?.viewport?.camera.bbox;
                return page && box ? { page, box } : null;
            },
        });
        return this.#world;
    }

    #selected_in_world(
        view: SchematicPageView,
        item: unknown | null,
        shift: boolean,
    ) {
        const detail = item
            ? normalize_schematic_selection(
                  item,
                  view.page.document,
                  view.page.context,
              )
            : null;
        if (item && !detail) return;
        if (detail) detail.operation = shift ? "toggle" : "replace";
        const uuid = traceable_uuid(item);
        this.#selected = uuid ? { page: view.key, uuid } : null;
        this.host.select(detail);
        if (this.#held && this.#selected) this.#trace(this.#selected);
    }

    #trace(at: Traceable) {
        const pages = this.host.pages();
        // A wire traces from the label or sheet entry it carries.
        const from =
            net_instance_at(pages, at.page, at.uuid) ??
            wire_instance(pages, at.page, at.uuid);
        if (!from) return;
        const world = this.#world;
        if (from.kind === "local") {
            // Inside the world view the trace goes on that sheet there.
            const scene = world?.open ? world.view(from.page) : null;
            if (scene) {
                scene.show_local_trace(
                    scene.local_trace() === from.name ? null : from.name,
                );
                world!.invalidate();
                return;
            }
            const viewer = this.host.viewer();
            viewer?.show_local_trace(
                viewer.local_trace === from.name ? null : from.name,
            );
            return;
        }
        if (world?.open) void world.chain(from);
        else void this.#world_view().show(from);
    }
}

/** The `~` key, by position (left of 1) or by the character it typed. */
export function is_tilde(event: KeyboardEvent) {
    return event.code === "Backquote" || event.key === "`" || event.key === "~";
}

/**
 * What `~` traces from a selected item: a label, sheet entry or wire, or a
 * power symbol (clicked on the symbol or on its pin). Null otherwise.
 */
export function traceable_uuid(item: unknown): string | null {
    if ((item instanceof Label || item instanceof Wire) && item.uuid)
        return item.uuid;
    const symbol =
        item instanceof PinInstance
            ? item.parent
            : item instanceof SchematicSymbol
              ? item
              : null;
    return symbol && is_power(symbol) ? symbol.uuid : null;
}
