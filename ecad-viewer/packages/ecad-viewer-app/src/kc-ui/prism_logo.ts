import { html } from "../base/web-components/html";

/**
 * Corner mark shown over every viewer canvas.
 *
 * Inlined rather than fetched: the viewer renders inside a shadow root in a
 * host page whose CSP we do not control, and a corner mark is not worth a
 * network dependency. The gradient/pattern ids are scoped by that shadow root,
 * so several viewers on one page do not collide.
 */
export const PRISM_LOGO = html` <svg
    viewBox="0 0 64 64"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="KiCAD Prism">
    <defs>
        <linearGradient
            id="prismStroke"
            x1="6"
            y1="6"
            x2="60"
            y2="58"
            gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#60A5FA" />
            <stop offset="0.55" stop-color="#3B82F6" />
            <stop offset="1" stop-color="#2563EB" />
        </linearGradient>
        <linearGradient
            id="prismFacet"
            x1="34"
            y1="18"
            x2="56"
            y2="60"
            gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#93C5FD" stop-opacity="0.38" />
            <stop offset="1" stop-color="#1D4ED8" stop-opacity="0.26" />
        </linearGradient>
        <pattern
            id="prismHatch"
            patternUnits="userSpaceOnUse"
            width="4"
            height="4"
            patternTransform="rotate(45)">
            <line
                x1="0"
                y1="0"
                x2="0"
                y2="4"
                stroke="#60A5FA"
                stroke-opacity="0.66"
                stroke-width="1.8" />
        </pattern>
    </defs>

    <polygon
        points="32,4 58,19 32,60 6,19"
        stroke="url(#prismStroke)"
        stroke-width="4"
        fill="none"
        stroke-linejoin="round"
        stroke-linecap="round" />
    <polygon points="58,19 32,31 32,60" fill="url(#prismFacet)" />
    <polygon points="58,19 32,31 32,60" fill="url(#prismHatch)" />
    <polyline
        points="6,19 32,31 32,60"
        stroke="url(#prismStroke)"
        stroke-width="4"
        fill="none"
        stroke-linejoin="round"
        stroke-linecap="round" />
    <line
        x1="32"
        y1="31"
        x2="58"
        y2="19"
        stroke="url(#prismStroke)"
        stroke-width="4"
        stroke-linecap="round" />
</svg>`;
