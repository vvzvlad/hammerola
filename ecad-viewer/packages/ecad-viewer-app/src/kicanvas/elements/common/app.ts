/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { DeferredPromise } from "../../../base/async";
import { delegate, listen } from "../../../base/events";
import {
    css,
    html,
    type ElementOrFragment,
} from "../../../base/web-components";
import { KCUISelectElement, KCUIElement } from "../../../kc-ui";
import type { KicadPCB, KicadSch } from "../../../kicad";
import {
    EcadCommentAreaEvent,
    EcadOverlayClickEvent,
    EcadOverlayHoverEvent,
    EcadOverlayLeaveEvent,
    KiCanvasSelectEvent,
    TabMenuVisibleChangeEvent,
} from "../../../viewers/base/events";
import type { Viewer } from "../../../viewers/base/viewer";
import type { AssertType, Project } from "../../project";

// import dependent elements so they're registered before use.
import "./help-panel";
import "./preferences-panel";
import "./viewer-bottom-toolbar";
export type KicadAssert = KicadPCB | KicadSch;

interface ViewerElement extends HTMLElement {
    viewer: Viewer;
    load(src: KicadAssert): Promise<void>;
    disableinteraction: boolean;
}

export interface SourceSelection {
    idx: number;
    name: string;
}

/**
 * Common base class for the schematic, board, etc. apps.
 */
export abstract class KCViewerAppElement<
    ViewerElementT extends ViewerElement,
> extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                margin: 0;
                display: flex;
                position: relative;
                width: 100%;
                height: 100%;
                max-height: 100%;
                /* Do not force A4 aspect-ratio here: in sized Prism panes it
                   shrinks the canvas and desyncs the first camera fit (same
                   fix as ecad-viewer :host vs :host(.aspect-a4)). */
                background-color: white;
                color: var(--fg);
                contain: layout paint;
            }
            .content_container {
                height: 100%;
                width: 100%;
            }
            .toggle-button {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                width: 16px;
                height: 36px;
                background-color: #0b1222ff;
                border: none;
                border-top-right-radius: 8px;
                border-bottom-right-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                z-index: 10;
                left: calc(max(15%, 240px));
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }
            .toggle-button.menu-hidden {
                left: 0px;
                border-top-right-radius: 8px;
                border-bottom-right-radius: 8px;
            }
            .toggle-button::before {
                content: "«";
                font-size: 16px;
                color: white;
                font-weight: bold;
            }
            .toggle-button.menu-hidden::before {
                content: "»";
            }
        `,
    ];
    #viewer_elm: ViewerElementT;
    #property_viewer: ElementOrFragment;
    #fitter_menu?: HTMLElement;
    #toggle_button?: HTMLElement;
    #placeholder = html`<ecad-spinner></ecad-spinner>` as HTMLElement;
    #content?: HTMLElement;
    public showPropertyPanel = true;

    public set tabMenuHidden(v: boolean) {
        if (!this.#fitter_menu) return;
        this.#fitter_menu.hidden = v;
        if (this.#toggle_button) {
            if (v) {
                this.#toggle_button.classList.add("menu-hidden");
            } else {
                this.#toggle_button.classList.remove("menu-hidden");
            }
        }
        this.dispatchEvent(
            new TabMenuVisibleChangeEvent(!this.#fitter_menu.hidden),
        );
    }

    public get tabMenuHidden() {
        return this.#fitter_menu?.hidden ?? true;
    }

    project: Project;
    viewerReady: DeferredPromise<boolean> = new DeferredPromise<boolean>();

    constructor() {
        super();
        this.provideLazyContext("viewer", () => this.viewer);
    }

    get viewer() {
        return this.#viewer_elm.viewer;
    }

    override connectedCallback() {
        (async () => {
            this.project = await this.requestContext("project");
            await this.project.loaded;
            super.connectedCallback();
        })();
    }

    abstract assert_type(): AssertType;

    override initialContentCallback() {
        // Listen for changes to the project's active page and load or hide
        // as needed.
        this.addDisposable(
            listen(this.project, "change", async (e) => {
                const page = this.project.get_first_page(this.assert_type());
                if (page) {
                    await this.load(page);
                }
            }),
        );
        // Project "change" often fires during parent setup before this
        // listener exists. Catch up so content_container is unhidden.
        const first_page = this.project.get_first_page(this.assert_type());
        if (first_page) {
            void this.load(first_page);
        }

        // Handle item selection in the viewers.
        this.addDisposable(
            this.viewer.addEventListener(KiCanvasSelectEvent.type, (e) => {
                this.on_viewer_select(
                    e.detail.item,
                    e.detail.previous,
                    e.detail.intent ?? "select",
                );
                // Viewer is an EventTarget rather than a DOM node, so its
                // selection event cannot bubble through the custom-element
                // host by itself. Relay it once at the app boundary for
                // embedders such as the Prism host adapter.
                this.dispatchEvent(new KiCanvasSelectEvent(e.detail));
            }),
        );

        // Relay overlay hit-test and comment-area events emitted by the
        // Viewer (a plain EventTarget, not a DOM node) onto this element so
        // they reach embedders such as the Prism host adapter.
        this.addDisposable(
            this.viewer.addEventListener(EcadOverlayClickEvent.type, (e) => {
                this.dispatchEvent(new EcadOverlayClickEvent(e.detail));
            }),
        );
        this.addDisposable(
            this.viewer.addEventListener(EcadOverlayHoverEvent.type, (e) => {
                this.dispatchEvent(new EcadOverlayHoverEvent(e.detail));
            }),
        );
        this.addDisposable(
            this.viewer.addEventListener(EcadOverlayLeaveEvent.type, (e) => {
                this.dispatchEvent(new EcadOverlayLeaveEvent(e.detail));
            }),
        );
        this.addDisposable(
            this.viewer.addEventListener(EcadCommentAreaEvent.type, (e) => {
                this.dispatchEvent(new EcadCommentAreaEvent(e.detail));
            }),
        );

        // Handle download button.
        delegate(this.renderRoot, "kc-ui-button", "click", (e) => {
            const target = e.target as KCUISelectElement;
            console.log("button", target);
            switch (target.name) {
                default:
                    console.warn("Unknown button", e);
            }
        });
    }

    protected abstract on_viewer_select(
        item?: unknown,
        previous?: unknown,
        intent?: "select" | "crossprobe",
    ): void;

    protected abstract can_load(src: KicadAssert): boolean;

    /**
     * Unhide the loaded viewer shell without re-entering DocumentViewer.load.
     * Used by document-comparison cold paths that already painted via
     * load_diff_document.
     */
    public revealLoadedContent(): void {
        if (this.#content) {
            this.#content.hidden = false;
        }
        if (this.#placeholder) {
            this.#placeholder.hidden = true;
        }
    }

    override async load(src: KicadAssert) {
        await this.viewerReady;
        const documentViewer = this.viewer as Viewer & {
            is_disposed?: boolean;
            set_drawing_sheet?: (
                sheet: ReturnType<Project["drawing_sheet_for"]>,
            ) => void;
        };
        if (documentViewer?.is_disposed) {
            return;
        }
        if (this.can_load(src)) {
            documentViewer.set_drawing_sheet?.(
                this.project.drawing_sheet_for(this.assert_type(), src),
            );
            const settled = this.viewer as Viewer & {
                document?: unknown;
                draw?: () => void;
                draw_now?: () => void;
                zoom_fit_top_item?: () => void;
                renderer?: { update_canvas_size?: () => void };
                viewport?: { sync_from_canvas?: () => boolean };
                is_disposed?: boolean;
            };
            const sync_viewport = () => {
                if (settled?.is_disposed) return false;
                settled.renderer?.update_canvas_size?.();
                return settled.viewport?.sync_from_canvas?.() ?? false;
            };
            if (
                "document" in documentViewer &&
                (documentViewer as Viewer & { document?: unknown }).document ===
                    src
            ) {
                this.revealLoadedContent();
                sync_viewport();
                settled.draw_now?.() ?? settled.draw?.();
                return;
            }
            // Unhide before tessellating so viewport.ready can open. Painting
            // while content_container is display:none still earcuts the whole
            // board and used to be thrown away by a second sized paint.
            this.revealLoadedContent();
            sync_viewport();
            await this.#viewer_elm.load(src);
            if (documentViewer.is_disposed || settled?.is_disposed) {
                return;
            }
            const sized = sync_viewport();
            if (sized) {
                settled.zoom_fit_top_item?.();
            }
            settled.draw_now?.() ?? settled.draw?.();
        } else {
            if (this.#content) {
                this.#content.hidden = true;
            }
            this.#placeholder.hidden = false;
        }
    }

    protected abstract make_property_element(): ElementOrFragment;

    protected abstract make_viewer_element(): ViewerElementT;

    protected abstract make_fitter_menu(): HTMLElement;

    /**
     * Headless mode: render only the viewer canvas, omitting the built-in
     * fitter menu (layers/objects/nets) and property panel, so a host app can
     * supply its own UI. Set by <ecad-viewer hide-chrome>. Purely structural —
     * no host styling here.
     */
    public headless = false;

    protected render_viewer() {
        this.#viewer_elm = this.make_viewer_element();

        // In headless mode, skip building the chrome entirely (no fitter menu,
        // no property panel). The host renders its own.
        if (this.headless) {
            return html` ${this.#viewer_elm} `;
        }

        this.#fitter_menu = this.make_fitter_menu();
        this.#fitter_menu.hidden = true;
        this.#fitter_menu.addEventListener(
            TabMenuVisibleChangeEvent.type,
            (e: TabMenuVisibleChangeEvent) => {
                this.tabMenuHidden = e.detail;
            },
        );
        this.#property_viewer = this.make_property_element();

        let elements: ElementOrFragment[] = [
            this.#fitter_menu,
            this.#viewer_elm,
        ];
        if (this.showPropertyPanel) elements.push(this.#property_viewer);

        if (window.hide_header) {
            this.#toggle_button = html`<div
                class="toggle-button menu-hidden"></div>` as HTMLElement;
            this.#toggle_button.addEventListener("click", () => {
                this.tabMenuHidden = !this.tabMenuHidden;
            });
            elements.unshift(this.#toggle_button);
        }

        return html` ${elements} `;
    }

    protected abstract do_render(): ElementOrFragment;

    override render() {
        this.#content = html`<div class="content_container">
            ${this.do_render()}
        </div>` as HTMLElement;
        this.#content.hidden = true;
        return html`${this.#content} ${this.#placeholder}`;
    }

    override renderedCallback(): void | undefined {
        window.requestAnimationFrame(() => {
            this.viewerReady.resolve(true);
        });
    }
}
