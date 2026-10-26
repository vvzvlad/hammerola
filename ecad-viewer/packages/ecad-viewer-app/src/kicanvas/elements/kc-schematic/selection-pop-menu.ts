import { Vec2 } from "../../../base/math";
import { css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import type { NetRef } from "../../../kicad/net_ref";
import {
    KiCanvasFitterMenuEvent,
    NetItemSelectEvent,
} from "../../../viewers/base/events";
import type { SchematicViewer } from "../../../viewers/schematic/viewer";

export class SchSelectionPopMenu extends KCUIElement {
    static override styles = [
        css`
            :host {
                position: fixed;
                display: block;
                height: 100%;
                width: 100%;
                background: transparent;
                color: var(--pop-menu-fg);
                z-index: 10;
            }

            .modal-panel {
                background-color: var(--pop-menu-bg);
                position: absolute;
                display: flex;
                flex-direction: column;
                gap: 6px;
                border-radius: 5px;
                box-shadow: 0 0 10px rgba(0, 0, 0, 0.3);
                padding: 8px 10px;
                color: var(--pop-menu-fg);
                z-index: 300;
                min-width: 160px;
                max-width: 280px;
            }

            .nav-header {
                display: flex;
                flex-direction: column;
                gap: 6px;
                border-bottom: 1px solid
                    color-mix(in srgb, var(--pop-menu-fg) 20%, transparent);
                padding-bottom: 6px;
            }

            .nav-title {
                font-weight: 600;
                font-size: 12px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .nav-controls {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }

            .nav-controls button {
                background: transparent;
                border: 1px solid
                    color-mix(in srgb, var(--pop-menu-fg) 35%, transparent);
                color: var(--pop-menu-fg);
                border-radius: 3px;
                cursor: pointer;
                padding: 2px 8px;
                line-height: 1.2;
            }

            .nav-controls button:hover:not(:disabled) {
                color: var(--pop-menu-fg-hover);
                border-color: var(--pop-menu-fg-hover);
            }

            .nav-controls button:disabled {
                opacity: 0.4;
                cursor: default;
            }

            .nav-counter {
                font-size: 11px;
                font-variant-numeric: tabular-nums;
            }

            .modal-list {
                list-style-type: none;
                margin: 0;
                padding: 0;
                max-height: 220px;
                overflow-y: auto;
            }

            .modal-list li {
                color: var(--pop-menu-fg);
                margin-bottom: 6px;
                cursor: pointer;
                padding: 2px 4px;
                border-radius: 3px;
                transition:
                    color 0.3s,
                    background-color 0.2s;
            }

            .modal-list li:last-child {
                margin-bottom: 0;
            }

            .modal-list li:hover {
                color: var(--pop-menu-fg-hover);
            }

            .modal-list li.active {
                color: var(--pop-menu-fg-hover);
                background-color: color-mix(
                    in srgb,
                    var(--pop-menu-fg-hover) 18%,
                    transparent
                );
            }
        `,
    ];
    #net_items: NetRef[] = [];
    #index = 0;
    #content: HTMLDivElement;
    #pos: Vec2 | null = null;
    #anchor: Vec2 | null = null;
    viewer: SchematicViewer;
    constructor() {
        super();
        this.hidden = true;
    }

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
            this.setup_events();
        })();
    }

    private setup_events() {
        window.addEventListener("mousemove", (e) => {
            this.#pos = new Vec2(e.clientX, e.clientY);
        });

        this.addEventListener("click", (event: MouseEvent) => {
            if (this.#content?.contains(event.target as any)) {
                return;
            }

            if (event.button === 0 && this.hidden === false) {
                this.hidden = true;
            }
        });

        this.addEventListener(KiCanvasFitterMenuEvent.type, (e) => {
            this.#net_items = e.detail.items as NetRef[];
            if (!this.#net_items.length) {
                this.hidden = true;
                return;
            }

            const activeUuid = e.detail.activeUuid;
            const found = activeUuid
                ? this.#net_items.findIndex((it) => it.uuid === activeUuid)
                : 0;
            this.#index = found >= 0 ? found : 0;

            if (!this.#pos) return;
            this.#anchor = this.#pos.copy();
            this.#apply_positioned_update();
            this.hidden = false;
        });
    }

    #apply_positioned_update() {
        this.update();
        const anchor = this.#anchor ?? this.#pos;
        if (!anchor || !this.#content) return;
        this.#content.style.top = `${anchor.y - 10}px`;
        this.#content.style.left = `${anchor.x}px`;
    }

    build_item_desc(itm: NetRef) {
        return `${itm.sheet_name}:${itm.name}`;
    }

    #select_index(index: number, navigate: boolean) {
        if (!this.#net_items.length) return;
        const n = this.#net_items.length;
        this.#index = ((index % n) + n) % n;
        this.#apply_positioned_update();
        if (!navigate) return;
        // The index is moved by the caller, so it can point past the list.
        const item = this.#net_items[this.#index];
        if (!item) return;
        this.viewer.dispatchEvent(
            new NetItemSelectEvent({
                sheet: item.sheet_name,
                uuid: item.uuid,
            }),
        );
    }

    override render() {
        const show_nav = this.#net_items.length >= 2;
        const current = this.#net_items[this.#index];
        const title = current?.name ?? "";

        this.#content = html`<div class="modal-panel"></div>` as HTMLDivElement;

        if (show_nav) {
            const header = html`<div
                class="nav-header"></div>` as HTMLDivElement;
            const title_el = html`<div class="nav-title">${title}</div>`;
            const controls = html`<div
                class="nav-controls"></div>` as HTMLDivElement;
            const prev = html`<button type="button" title="Previous">
                ‹
            </button>`;
            const counter = html`<span class="nav-counter"
                >${this.#index + 1} / ${this.#net_items.length}</span
            >`;
            const next = html`<button type="button" title="Next">›</button>`;

            prev.addEventListener("click", (e) => {
                e.stopPropagation();
                this.#select_index(this.#index - 1, true);
            });
            next.addEventListener("click", (e) => {
                e.stopPropagation();
                this.#select_index(this.#index + 1, true);
            });

            controls.append(prev, counter, next);
            header.append(title_el, controls);
            this.#content.appendChild(header);
        }

        const list = html`<ul class="modal-list"></ul>` as HTMLUListElement;

        for (const [i, item] of this.#net_items.entries()) {
            // `html` can yield a fragment; this template is always one <li>.
            const selection = html`<li>
                ${this.build_item_desc(item)}
            </li>` as HTMLLIElement;
            if (i === this.#index) {
                selection.classList.add("active");
            }
            selection.addEventListener("click", (e) => {
                e.stopPropagation();
                this.#select_index(i, true);
            });
            list.appendChild(selection);
        }

        this.#content.appendChild(list);
        return html`${this.#content}`;
    }
}

window.customElements.define("kc-sch-selection-menu", SchSelectionPopMenu);
