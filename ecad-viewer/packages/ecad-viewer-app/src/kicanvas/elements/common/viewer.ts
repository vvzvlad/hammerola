/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import { KiCanvasLoadEvent } from "../../../viewers/base/events";
import type { Viewer } from "../../../viewers/base/viewer";
import { Preferences, WithPreferences } from "../../preferences";
import themes from "../../themes";
import type { KicadAssert } from "./app";

/**
 * Basic element for wiring up a Viewer to the DOM.
 */
export abstract class KCViewerElement<
    ViewerT extends Viewer,
> extends WithPreferences(KCUIElement) {
    canvas: HTMLCanvasElement;
    viewer: ViewerT;
    selected: any[] = [];

    @attribute({ type: Boolean })
    loaded: boolean;

    @attribute({ type: String })
    theme: string;

    @attribute({ type: Boolean })
    disableinteraction: boolean;

    override initialContentCallback() {
        (async () => {
            this.viewer = this.addDisposable(this.make_viewer());

            await this.viewer.setup();

            this.addDisposable(
                this.viewer.addEventListener(KiCanvasLoadEvent.type, () => {
                    this.loaded = true;
                    this.dispatchEvent(new KiCanvasLoadEvent());
                }),
            );
        })();
    }

    override async preferenceChangeCallback(preferences: Preferences) {
        // Don't apply preference changes if the theme has been set via an attribute.
        if (this.theme || !this.viewer || !this.viewer.loaded) {
            return;
        }
        this.update_theme();
        this.viewer.paint();
        this.viewer.draw();
    }

    override disconnectedCallback() {
        super.disconnectedCallback();
        this.selected = [];
    }

    protected get themeObject() {
        // If the theme attribute is set, override preferences.
        if (this.theme) {
            return themes.by_name(this.theme);
        } else {
            return Preferences.INSTANCE.theme;
        }
    }

    protected abstract update_theme(): void;

    protected abstract make_viewer(): ViewerT;

    override async load(src: KicadAssert) {
        this.loaded = false;
        await this.viewer.load(src);
    }

    override render() {
        this.canvas = html`<canvas></canvas>` as HTMLCanvasElement;

        // Drag panning is part of viewer navigation (`MoveAndZoom`), not of
        // this element, so every host that mounts a viewer -- this element and
        // the standalone renderer alike -- navigates the same way.
        return html`<style>
                :host {
                    display: block;
                    touch-action: none;
                    width: 100%;
                    height: 100%;
                }
                canvas {
                    width: 100%;
                    height: 100%;
                    /* border: solid 1px rgb(24, 144, 255); */
                }
            </style>
            ${this.canvas}`;
    }
}
