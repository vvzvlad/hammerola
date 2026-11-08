/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { html, type ElementOrFragment } from "../../../base/web-components";
import { KCViewerAppElement, type KicadAssert } from "../common/app";
import { KCSchematicViewerElement } from "./viewer";

// import dependent elements so they're registered before use.
import "./info-panel";
import "./properties-panel";
import "./viewer";
import "./erc-inspector";
import type { KCErcInspectorElement } from "./erc-inspector";

import { KicadSch } from "../../../kicad";
import { AssertType } from "../../project";
import { SchPreviewListElement } from "./sch-preview-list";
import {
    LinkClickEvent,
    ProjectERCResultEvent,
} from "../../../viewers/base/events";
import type {
    PlaneViewer,
    PlaneSource,
} from "../../../viewers/schematic/plane-viewer";
import { first_slot, slot_by_link } from "../../../viewers/schematic/plane";

/**
 * Internal "parent" element for KiCanvas's schematic viewer. Handles
 * setting up the schematic viewer as well as interface controls. It's
 * basically KiCanvas's version of EESchema. Its viewer is the schematic
 * plane, every sheet of the project at once (`show_plane`).
 */
export class KCSchematicAppElement extends KCViewerAppElement<KCSchematicViewerElement> {
    override assert_type(): AssertType {
        return AssertType.SCH;
    }

    protected override make_property_element(): ElementOrFragment {
        return html`<kc-schematic-properties-panel></kc-schematic-properties-panel>`;
    }

    protected override make_fitter_menu(): HTMLElement {
        const preview = new SchPreviewListElement();
        return preview;
    }

    get plane(): PlaneViewer {
        return this.viewer as PlaneViewer;
    }

    override initialContentCallback() {
        super.initialContentCallback();
        this.viewer.addEventListener(LinkClickEvent.type, (e) => {
            this.#open_hyperlink(e.detail.url, e.detail.page);
        });

        window.addEventListener(ProjectERCResultEvent.type, (e) => {
            console.log("Project ERC Result", e.detail);
            const inspector = this.renderRoot.querySelector(
                "kc-erc-inspector",
            ) as KCErcInspectorElement;
            if (inspector && e.detail) {
                inspector.ercResult = e.detail;
            }
        });
    }

    /**
     * Follow a schematic hyperlink clicked on the sheet `page`.
     *
     * KiCad authors embedded links as `(href "...")` on a text item's
     * effects. Three kinds exist: absolute URLs (web pages, mailto:) which
     * open in a new browser tab; `#<page number>`, KiCad's own link to
     * another page of the schematic; and project-relative file paths,
     * resolved the way KiCad resolves sibling sheet references. A link to a
     * sheet shows it whole on the plane; a file placed by several sheet
     * symbols shows its first.
     */
    #open_hyperlink(url: string, page?: string) {
        if (!url) return;

        const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();

        if (scheme) {
            // Only safe, user-facing schemes are followed; anything else
            // (javascript:, data:, unknown protocols) is ignored.
            if (!["http", "https", "mailto"].includes(scheme)) {
                console.warn(
                    `Refusing to open hyperlink with scheme ${scheme}`,
                );
                return;
            }
            window.open(url, "_blank", "noopener,noreferrer");
            return;
        }

        const sheets = this.plane.sheets;
        const numbered = slot_by_link(sheets, url);
        if (numbered) {
            this.plane.show_sheet(numbered.page.key);
            return;
        }

        // No scheme: a link to a file in the repo, relative to the sheet the
        // link is on.
        const from = page ? this.plane.sheet(page) : undefined;
        if (!from) return;
        const resolved = this.project.resolve_schematic_filename(
            from.page.document.filename,
            url,
        );
        const file = resolved ? this.project.file_by_name(resolved) : null;
        const target =
            file instanceof KicadSch
                ? first_slot(sheets, file.filename)
                : undefined;
        if (target) this.plane.show_sheet(target.page.key);

        // Not a loaded schematic: nothing opens. The path is the project's,
        // and a window opened on it would resolve it against the address of
        // the page the viewer is embedded in, which serves no such file.
    }

    /** The plane reports its selections to the element; nothing to do here. */
    override on_viewer_select() {}

    override can_load(src: KicadAssert): boolean {
        return src instanceof KicadSch;
    }

    /**
     * The project changed (`"change"`: a variant, files added, the load
     * settled). The plane's sheets come from the element (`show_plane`) and
     * the variant reaches the scenes through it, so this only shows the
     * content and draws.
     */
    override async load(_src: KicadAssert) {
        await this.viewerReady;
        this.revealLoadedContent();
        this.viewer?.draw();
    }

    /**
     * Show `source.pages`, the project's sheet instances, on the plane, the
     * whole plane fitted. Resolves once the layout and the camera are set;
     * the scenes are built after.
     */
    async show_plane(source: PlaneSource) {
        await this.viewerReady;
        this.revealLoadedContent();
        await this.plane.load(source);
        this.plane.draw_now();
    }

    protected override do_render() {
        const inspector =
            html`<kc-erc-inspector></kc-erc-inspector>` as KCErcInspectorElement;
        const content = super.render_viewer();
        return html`${content} ${inspector}`;
    }

    override make_viewer_element(): KCSchematicViewerElement {
        // `plane` before the element is connected: it picks its viewer then.
        return html`<kc-schematic-viewer plane></kc-schematic-viewer>` as KCSchematicViewerElement;
    }
}

window.customElements.define("kc-schematic-app", KCSchematicAppElement);
