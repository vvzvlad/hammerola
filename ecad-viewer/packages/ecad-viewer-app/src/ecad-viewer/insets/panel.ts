/*
    The DOM for one inset: a header (chain dot, title, side badge, toolbar),
    the canvas the provider renders into, and a resize grip. The panel owns
    gestures; what they mean is up to the session.
*/

import { Vec2 } from "../../base/math";
import type { InsetSide } from "./types";

export type InsetAction =
    | "rotate-ccw"
    | "rotate-cw"
    | "mirror"
    | "lens"
    | "refit"
    | "pin"
    | "3d"
    | "close";

export interface InsetPanelHandlers {
    action(action: InsetAction): void;
    /** The panel moved or resized; leaders need recomputing. */
    moved(): void;
    /** The canvas size changed; the inset needs re-rendering. */
    resized(): void;
    /**
     * Drag on the canvas, in screen pixels. `secondary`: a Shift, right or
     * middle drag (3D insets pan with it and orbit with a plain drag, as
     * the 3D tab does).
     */
    drag(dx: number, dy: number, secondary: boolean): void;
    /** Wheel on the canvas; `cursor` is in canvas CSS pixels. */
    wheel(cursor: Vec2, event: WheelEvent): void;
    /** Pointer over the canvas (canvas CSS pixels), or null when it left. */
    pointer(cursor: Vec2 | null): void;
    /** The user grabbed the panel (header, grip or canvas). */
    touched(): void;
    /** The pointer entered (true) or left (false) the panel. */
    hover(on: boolean): void;
    /** A press on the canvas released without dragging. */
    click(): void;
}

/** Action, glyph, label and key (IN-11; keys act on the hovered inset). */
export const TOOLBAR: [InsetAction, string, string, string][] = [
    ["rotate-ccw", "↺", "Rotate −15°", "⇧R"],
    ["rotate-cw", "↻", "Rotate +15°", "R"],
    ["mirror", "⇋", "Mirror", "M"],
    ["lens", "◯", "Lens", "L"],
    ["refit", "⌂", "Refit", "Home"],
    ["3d", "3D", "3D view", "T"],
    ["pin", "", "Pin", "P"],
    ["close", "✕", "Close", "X"],
];

/**
 * Push-pin in the toolbar's colour: an outline while the inset is a preview,
 * filled once pinned (an emoji would ignore the "on" colour).
 */
const PIN_ICON = `<svg class="inset-pin" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
<path d="M10.2 1.8 14.2 5.8 12.8 6.4 10.6 8.6 10.9 11.6 9.8 12.7 7.1 10 3.4 13.7 2.3 13.7 2.3 12.6 6 8.9 3.3 6.2 4.4 5.1 7.4 5.4 9.6 3.2Z"
 stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

const SIDE_LABEL: Record<InsetSide, string> = {
    top: "TOP",
    bottom: "BOT",
    sch: "SCH",
    none: "—",
};

export const MIN_PANEL_WIDTH = 160;
export const MIN_PANEL_HEIGHT = 120;

export class InsetPanel {
    readonly el: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    /** Outlines drawn over the canvas, in canvas pixels; clipped with it. */
    readonly marks: SVGSVGElement;
    #title: HTMLSpanElement;
    #side: HTMLSpanElement;
    #notice: HTMLDivElement;
    #notice_timer: ReturnType<typeof setTimeout> | null = null;
    #buttons = new Map<InsetAction, HTMLButtonElement>();
    #resize_observer: ResizeObserver;

    constructor(
        color: string,
        private readonly handlers: InsetPanelHandlers,
    ) {
        this.el = document.createElement("div");
        this.el.className = "inset preview";
        this.el.style.setProperty("--inset-color", color);

        const header = document.createElement("div");
        header.className = "inset-header";
        const dot = document.createElement("span");
        dot.className = "inset-dot";
        this.#title = document.createElement("span");
        this.#title.className = "inset-title";
        this.#side = document.createElement("span");
        this.#side.className = "inset-side";
        const toolbar = document.createElement("span");
        toolbar.className = "inset-toolbar";
        for (const [action, glyph, label, key] of TOOLBAR) {
            const button = document.createElement("button");
            button.type = "button";
            if (action === "pin") button.innerHTML = PIN_ICON;
            else button.textContent = glyph;
            button.dataset["key"] = key;
            button.dataset["label"] = label;
            // Styled tooltip with the key cap (mockup 02); a native title
            // would show a second, unstyled one.
            const tip = document.createElement("span");
            tip.className = "inset-tip";
            tip.setAttribute("aria-hidden", "true");
            const kbd = document.createElement("kbd");
            kbd.textContent = key;
            tip.append(label, kbd);
            button.append(tip);
            button.setAttribute("aria-label", label);
            button.dataset["action"] = action;
            button.addEventListener("click", (e) => {
                e.stopPropagation();
                handlers.action(action);
            });
            this.#buttons.set(action, button);
            toolbar.append(button);
        }
        header.append(dot, this.#title, this.#side, toolbar);

        this.canvas = document.createElement("canvas");
        this.canvas.className = "inset-canvas";
        const grip = document.createElement("div");
        grip.className = "inset-grip";
        this.marks = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
        );
        this.marks.classList.add("inset-marks");
        this.#notice = document.createElement("div");
        this.#notice.className = "inset-notice";
        const view = document.createElement("div");
        view.className = "inset-view";
        view.append(this.canvas, this.marks, this.#notice);
        this.el.append(header, view, grip);
        this.canvas.addEventListener("pointermove", (e) => {
            // Panning is not hovering.
            if (e.buttons) return;
            const rect = this.canvas.getBoundingClientRect();
            handlers.pointer(
                new Vec2(e.clientX - rect.left, e.clientY - rect.top),
            );
        });
        this.canvas.addEventListener("pointerleave", () =>
            handlers.pointer(null),
        );

        this.#drag(header, (dx, dy) => {
            this.el.style.left = `${this.el.offsetLeft + dx}px`;
            this.el.style.top = `${this.el.offsetTop + dy}px`;
            handlers.moved();
        });
        this.#drag(grip, (dx, dy) => {
            this.set_size(this.el.offsetWidth + dx, this.el.offsetHeight + dy);
        });
        this.#drag(
            this.canvas,
            (dx, dy, secondary) => handlers.drag(dx, dy, secondary),
            () => handlers.click(),
            true,
        );
        // Right-drag pans; no browser menu over the inset.
        this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        this.canvas.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = this.canvas.getBoundingClientRect();
                handlers.wheel(
                    new Vec2(e.clientX - rect.left, e.clientY - rect.top),
                    e,
                );
            },
            { passive: false },
        );
        this.el.addEventListener("pointerenter", () => handlers.hover(true));
        this.el.addEventListener("pointerleave", () => handlers.hover(false));
        this.#resize_observer = new ResizeObserver(() => handlers.resized());
        this.#resize_observer.observe(this.canvas);
    }

    set title(value: {
        reference: string;
        number: string;
        detail?: string;
        /** Chained insets: the parent's "REF · PIN", shown as a breadcrumb. */
        crumb?: string;
    }) {
        const sub = [value.number, value.detail].filter(Boolean).join(" · ");
        const parts: Node[] = [];
        if (value.crumb)
            parts.push(
                Object.assign(document.createElement("span"), {
                    className: "inset-crumb",
                    textContent: `${value.crumb} › `,
                }),
            );
        parts.push(
            Object.assign(document.createElement("b"), {
                textContent: value.reference,
            }),
            document.createTextNode(sub ? ` · ${sub}` : ""),
        );
        this.#title.replaceChildren(...parts);
    }

    set side(side: InsetSide) {
        this.#side.textContent = SIDE_LABEL[side];
        this.#side.classList.toggle("bottom", side === "bottom");
    }

    set preview(value: boolean) {
        this.el.classList.toggle("preview", value);
        // The pin button shows the state and offers the opposite.
        const pin = this.#buttons.get("pin")!;
        const label = value ? "Pin" : "Unpin";
        pin.classList.toggle("on", !value);
        pin.setAttribute("aria-pressed", `${!value}`);
        pin.setAttribute("aria-label", label);
        pin.dataset["label"] = label;
        const tip = pin.querySelector(".inset-tip");
        if (tip?.firstChild) tip.firstChild.textContent = label;
    }

    set mirrored(value: boolean) {
        this.#buttons.get("mirror")!.classList.toggle("on", value);
    }

    /** PCB insets offer the 3D view; `pending` while it loads. */
    set view3d(value: { offered: boolean; on: boolean; pending: boolean }) {
        const button = this.#buttons.get("3d")!;
        button.hidden = !value.offered;
        button.classList.toggle("on", value.on);
        button.classList.toggle("pending", value.pending);
        button.setAttribute("aria-pressed", `${value.on}`);
        this.el.classList.toggle("view3d", value.on);
    }

    /** A short message over the canvas, e.g. "3D unavailable". */
    notice(text: string, ms = 2000) {
        this.#notice.textContent = text;
        this.#notice.classList.add("on");
        if (this.#notice_timer) clearTimeout(this.#notice_timer);
        this.#notice_timer = setTimeout(() => {
            this.#notice_timer = null;
            this.#notice.classList.remove("on");
        }, ms);
    }

    get notice_text() {
        return this.#notice.classList.contains("on")
            ? this.#notice.textContent
            : null;
    }

    get lens() {
        return this.el.classList.contains("lens");
    }

    set lens(value: boolean) {
        this.el.classList.toggle("lens", value);
        this.#buttons.get("lens")!.classList.toggle("on", value);
    }

    button(action: InsetAction) {
        return this.#buttons.get(action)!;
    }

    place(x: number, y: number, w: number, h: number) {
        this.el.style.left = `${x}px`;
        this.el.style.top = `${y}px`;
        this.set_size(w, h);
    }

    set_size(w: number, h: number) {
        this.el.style.width = `${Math.max(MIN_PANEL_WIDTH, w)}px`;
        this.el.style.height = `${Math.max(MIN_PANEL_HEIGHT, h)}px`;
    }

    dispose() {
        if (this.#notice_timer) clearTimeout(this.#notice_timer);
        this.#resize_observer.disconnect();
        this.el.remove();
    }

    #drag(
        target: HTMLElement,
        on_move: (dx: number, dy: number, secondary: boolean) => void,
        on_click?: () => void,
        any_button = false,
    ) {
        target.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 && !(any_button && e.button <= 2)) return;
            // Decided at the press, like the 3D tab: Shift or a non-left
            // button for the whole drag.
            const secondary = e.shiftKey || e.button !== 0;
            // Toolbar buttons take their own clicks. Capturing the pointer
            // here would retarget the click to the header and swallow it.
            if ((e.target as Element).closest("button")) return;
            e.preventDefault();
            e.stopPropagation();
            // Synthetic or already-released pointers cannot be captured.
            try {
                target.setPointerCapture(e.pointerId);
            } catch {
                /* drag still works while the pointer stays over the target */
            }
            let last = { x: e.clientX, y: e.clientY };
            let travel = 0;
            const move = (ev: PointerEvent) => {
                const dx = ev.clientX - last.x;
                const dy = ev.clientY - last.y;
                travel += Math.abs(dx) + Math.abs(dy);
                on_move(dx, dy, secondary);
                last = { x: ev.clientX, y: ev.clientY };
            };
            const end = () => {
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", up);
                target.removeEventListener("pointercancel", end);
            };
            const up = () => {
                end();
                // Pointer jitter is not a drag.
                if (travel < 4 && e.button === 0) on_click?.();
            };
            target.addEventListener("pointermove", move);
            target.addEventListener("pointerup", up);
            target.addEventListener("pointercancel", end);
            this.handlers.touched();
        });
    }
}

/*
    Theme: every colour and metric is a custom property with a light
    fallback. Custom properties inherit into the shadow root, so a host
    themes insets by setting them on <ecad-viewer> (Prism maps its tokens,
    which also switch for dark mode).

    --inset-bg, --inset-fg, --inset-muted, --inset-muted-bg, --inset-border,
    --inset-shadow, --inset-radius, --inset-font, --inset-bottom-bg,
    --inset-bottom-fg, --inset-tip-bg, --inset-tip-fg, --inset-focus
*/
export const INSET_STYLES = `
.inset-root { position: absolute; inset: 0; pointer-events: none; z-index: 30; overflow: hidden; }
.inset-root svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; z-index: 2; pointer-events: none; }
.inset { position: absolute; z-index: 1; pointer-events: auto; display: flex; flex-direction: column;
  background: var(--inset-bg, #fff); color: var(--inset-fg, #0f172a);
  border: 1.5px solid var(--inset-color); border-radius: var(--inset-radius, 8px);
  box-shadow: var(--inset-shadow, 0 8px 24px rgb(15 23 42 / 18%)); overflow: hidden;
  font: 12px/1.3 var(--inset-font, system-ui, sans-serif); }
.inset.preview { border-style: dashed; box-shadow: var(--inset-shadow, 0 4px 14px rgb(15 23 42 / 14%)); }
.inset-header { position: relative; display: flex; align-items: center; gap: 6px; height: 28px; flex: none;
  padding: 0 4px 0 8px; border-bottom: 1px solid var(--inset-border, #e2e8f0); background: var(--inset-bg, #fff);
  cursor: move; user-select: none; white-space: nowrap; z-index: 1; }
.inset-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--inset-color); flex: none; }
.inset-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--inset-muted, #64748b); }
.inset-title b { color: var(--inset-fg, #0f172a); font-weight: 600; }
.inset-crumb { color: var(--inset-muted, #64748b); }
.inset-side { flex: none; font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 5px; border-radius: 4px;
  background: var(--inset-muted-bg, #f1f5f9); color: var(--inset-muted, #64748b); }
.inset-side.bottom { background: var(--inset-bottom-bg, #dbe7f7); color: var(--inset-bottom-fg, #29558f); }
.inset-toolbar { display: flex; gap: 1px; flex: none; }
.inset-toolbar button { all: unset; position: relative; width: 22px; height: 22px; display: flex; align-items: center;
  justify-content: center; border-radius: 5px; color: var(--inset-muted, #64748b); cursor: pointer; font-size: 13px; }
.inset-toolbar button:hover { background: var(--inset-muted-bg, #f1f5f9); color: var(--inset-fg, #0f172a); }
.inset-toolbar button:focus-visible { outline: 2px solid var(--inset-focus, var(--inset-color)); outline-offset: 1px; }
.inset-toolbar button.on { color: var(--inset-color); background: color-mix(in srgb, var(--inset-color) 12%, transparent); }
.inset-tip { position: absolute; top: calc(100% + 6px); right: 0; display: none; align-items: center; gap: 6px;
  padding: 4px 6px; border-radius: 6px; background: var(--inset-tip-bg, #0f172a); color: var(--inset-tip-fg, #fff);
  font: 500 11px/1.2 var(--inset-font, system-ui, sans-serif); white-space: nowrap; pointer-events: none; z-index: 3; }
.inset-tip kbd { font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 4px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--inset-tip-fg, #fff) 35%, transparent); color: inherit; }
.inset-toolbar button:hover .inset-tip, .inset-toolbar button:focus-visible .inset-tip { display: flex; }
.inset-toolbar button[hidden] { display: none; }
.inset-toolbar button[data-action="3d"] { width: 24px; font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.inset-toolbar button.pending { animation: inset-pulse 1s ease-in-out infinite alternate; }
.inset-notice { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); display: none; padding: 3px 8px;
  border-radius: 6px; background: var(--inset-tip-bg, #0f172a); color: var(--inset-tip-fg, #fff);
  font: 500 11px/1.2 var(--inset-font, system-ui, sans-serif); white-space: nowrap; pointer-events: none; z-index: 2; }
.inset-notice.on { display: block; }
.inset-pin { fill: none; }
.inset-toolbar button.on .inset-pin { fill: currentColor; }
.inset.preview .inset-toolbar button:not([data-action="pin"]) { display: none; }
.inset.loading .inset-dot { animation: inset-pulse 1s ease-in-out infinite alternate; }
@keyframes inset-pulse { from { opacity: 1; } to { opacity: .3; } }
.inset.missing { height: auto !important; border-color: var(--inset-border, #cbd5e1); border-style: solid; }
.inset.missing .inset-dot { background: var(--inset-border, #cbd5e1); }
.inset.missing .inset-view, .inset.missing .inset-grip,
.inset.missing .inset-toolbar button:not([data-action="close"]) { display: none !important; }
.inset.missing .inset-header { border-bottom: 0; }
.inset.missing .inset-tip { display: none !important; }
.inset-view { position: relative; flex: 1; min-height: 0; }
.inset-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.inset-marks { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
.inset-marks .target { fill: none; stroke: var(--inset-color); stroke-width: 2; }
.inset-marks .hover { fill: color-mix(in srgb, var(--inset-color) 14%, transparent); stroke: var(--inset-color);
  stroke-width: 1.5; stroke-dasharray: 4 3; }
.inset-canvas:active { cursor: grabbing; }
.inset-grip { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; }
.inset.lens { border-radius: 50%; border-width: 2px; }
.inset.lens .inset-header { position: absolute; top: 9%; left: 18%; right: 18%; height: 24px;
  border: 1px solid var(--inset-border, #e2e8f0); border-radius: 6px; box-shadow: 0 1px 4px rgb(0 0 0 / 10%); }
.inset.lens .inset-title, .inset.lens .inset-side { display: none; }
.inset.lens .inset-toolbar { margin-left: auto; }
.inset.lens .inset-grip { right: 14%; bottom: 14%; }
`;
