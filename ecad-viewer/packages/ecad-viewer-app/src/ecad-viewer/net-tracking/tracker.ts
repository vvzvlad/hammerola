/*
    NetTracker: a double-click on a label of the schematic, and the world
    view it opens.

    The element hands it the main view's double-clicks on a label, sheet
    entry or power symbol, and the world view its own:

    - a local label joins its namesakes on its sheet (the main view's, or
      that sheet's inside the world view), or lets them go again;
    - anything that leaves the sheet (global or hierarchical label, sheet
      entry, power rail) opens the world view, or, while it is open, takes
      away the chain it is in, else chains its net in (`WorldView.toggle`).
      Escape closes the view.

    Selections made inside the world view are reported like the main view's,
    on that sheet's own page.
*/

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
    net_instance_at,
    traceable_uuid,
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
    /** Report a selection made in the world view (`null`: nothing picked). */
    select(detail: EcadSemanticSelectionDetail | null): void;
    /** Show `page` in the main view, framing `uuid` when given. */
    open_page(page: string, uuid?: string): void;
}

/** Something on a page that a double-click traces from. */
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

    constructor(private readonly host: NetTrackerHost) {}

    get world_open() {
        return this.#world?.open ?? false;
    }

    /** The main view's highlighted nets, for the world view's sheets too. */
    set_highlighted_nets(nets: readonly SchematicNetMembers[]) {
        this.#nets = nets;
        this.#scenes?.set_highlighted_nets(nets);
    }

    /** A double-click in the main view on `item` of `page`, its sheet instance. */
    trace_in_main(item: unknown, page: string | null) {
        const uuid = traceable_uuid(item);
        if (uuid && page) this.#trace({ page, uuid });
    }

    /** Keys: Escape closes the world view. True when used. */
    key_down(event: KeyboardEvent): boolean {
        if (event.key === "Escape" && this.world_open) {
            this.hide_world_view();
            return true;
        }
        return false;
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
            trace: (view, item) => {
                const uuid = traceable_uuid(item);
                return !!uuid && this.#trace({ page: view.key, uuid });
            },
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
        this.host.select(detail);
    }

    /** Trace from `at`; false when it is on no net. */
    #trace(at: Traceable): boolean {
        const from = net_instance_at(this.host.pages(), at.page, at.uuid);
        if (!from) return false;
        const world = this.#world;
        if (from.kind === "local") {
            // Inside the world view the trace goes on that sheet there.
            const scene = world?.open ? world.view(from.page) : null;
            if (scene) {
                scene.show_local_trace(
                    scene.local_trace() === from.name ? null : from.name,
                );
                world!.invalidate();
                return true;
            }
            const viewer = this.host.viewer();
            viewer?.show_local_trace(
                viewer.local_trace === from.name ? null : from.name,
            );
            return true;
        }
        void this.#world_view().toggle(from);
        return true;
    }
}
