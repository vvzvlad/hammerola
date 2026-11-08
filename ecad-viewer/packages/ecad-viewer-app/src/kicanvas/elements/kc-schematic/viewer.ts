/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { PlaneViewer } from "../../../viewers/schematic/plane-viewer";
import { SchematicViewer } from "../../../viewers/schematic/viewer";
import { KCViewerElement } from "../common/viewer";

/**
 * A schematic's viewer: with the `plane` attribute, every sheet of the
 * project on one plane (the schematic tab); without it, one document (a
 * sheet's preview).
 */
export class KCSchematicViewerElement extends KCViewerElement<
    SchematicViewer | PlaneViewer
> {
    protected override update_theme(): void {
        this.viewer.theme = this.themeObject.schematic;
    }

    protected override make_viewer(): SchematicViewer | PlaneViewer {
        if (this.hasAttribute("plane"))
            return new PlaneViewer(
                this.canvas,
                !this.disableinteraction,
                this.themeObject.schematic,
            );
        return new SchematicViewer(
            this.canvas,
            !this.disableinteraction,
            this.themeObject.schematic,
        );
    }
}

window.customElements.define("kc-schematic-viewer", KCSchematicViewerElement);
