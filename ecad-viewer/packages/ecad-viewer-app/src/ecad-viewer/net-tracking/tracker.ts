/*
    NetTracker: a double-click on a label of the schematic, and the world
    view it opens.

    The element hands it the main view's double-clicks on a label, sheet
    entry or power symbol, and the world view its own. Each one, a local
    label's as much as a global one's, opens the world view on its net, or,
    while the view is open, takes away the chain it is in, else chains its
    net in (`WorldView.toggle`). A local label's net reaches its namesakes on
    its sheet, so its chain links them there as a global label's links its
    namesakes. Escape closes the view, and so does a double-click on an
    empty place in it, the main view taking over the picture it shows
    (`world-view.ts`); `hide_world_view`, for the element when it moves the
    main view itself, leaves the main view to it.

    Selections made inside the world view are reported like the main view's,
    on that sheet's own page.
*/

import type { BBox } from "../../base/math";
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
    /** Show `page` in the main view, its camera on `box` (that sheet's coordinates). */
    open_page(page: string, box: BBox): void;
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

    /** Select what the open world view shows at a page point; false when closed. */
    select_at(x: number, y: number): boolean {
        if (!this.world_open) return false;
        this.#world!.select_at(x, y);
        return true;
    }

    /**
     * Keys: Escape closes the world view, handing the main view what it
     * shows. True when used.
     */
    key_down(event: KeyboardEvent): boolean {
        if (event.key === "Escape" && this.world_open) {
            this.#world!.hand_over();
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
            open_page: (key, box) => this.host.open_page(key, box),
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
        void this.#world_view().toggle(from);
        return true;
    }
}
