import type { DesignURLs } from "./design_urls";

type PAGES = "sch" | "pcb" | "3d" | "bom" | "full" | "design_block";

declare global {
    // Note the capital "W"
    interface Window {
        is_module_lib?: boolean;
        zip_url?: string;
        cli_server_addr?: string;
        ai_url?: string;
        app?: PAGES;
        default_page?: PAGES;
        design_urls?: DesignURLs;
        hide_header?: boolean;
        white_bg?: boolean;
    }
}

/**
 * The page that loads the bundle opts in to standalone behaviour -- query
 * string configuration and the postMessage bridge -- with
 * `<meta name="ecad-viewer-mode" content="standalone">`. An app that embeds
 * the element (Prism) leaves it out, so a crafted link to that app cannot
 * configure the viewer through the URL.
 */
export const is_standalone_host = (doc: Document = document) =>
    doc
        .querySelector('meta[name="ecad-viewer-mode"]')
        ?.getAttribute("content")
        ?.trim() === "standalone";

/** A link target the viewer may render: https, or relative to the page. */
export const safe_link_url = (
    value: string | null | undefined,
    base: string = window.location.href,
): string | undefined => {
    if (!value) return undefined;
    const trimmed = value.trim();
    // Absolute and protocol-relative URLs must be https. Anything else is a
    // path on the page's own origin.
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    try {
        const url = new URL(trimmed, base);
        if (absolute || trimmed.startsWith("//")) {
            return url.protocol === "https:" ? url.href : undefined;
        }
        return url.origin === new URL(base).origin ? url.href : undefined;
    } catch {
        return undefined;
    }
};

/** A server the viewer may upload files to: the page's own origin only. */
export const same_origin_url = (
    value: string | null | undefined,
    base: string = window.location.href,
): string | undefined => {
    if (!value) return undefined;
    try {
        const url = new URL(value.trim(), base);
        return url.origin === new URL(base).origin ? url.href : undefined;
    } catch {
        return undefined;
    }
};

export const load_ecad_viewer_conf = (
    urlParams: URLSearchParams = new URLSearchParams(window.location.search),
) => {
    for (const key of [
        "zip-url",
        "is-module-lib",
        "app",
        "default-page",
        "hide-header",
    ]) {
        const value = urlParams.get(key);
        if (value) {
            // Replace all "-" with "_" to match the window variable names.
            const var_name = key.replace(/-/g, "_");
            // @ts-expect-error 7015
            window[var_name] = value;
        }
    }

    const cli_server_addr = same_origin_url(urlParams.get("cli-server-addr"));
    if (cli_server_addr) window.cli_server_addr = cli_server_addr;

    const ai_url = safe_link_url(urlParams.get("ai-url"));
    if (ai_url) window.ai_url = ai_url;

    const whiteBg = urlParams.get("whitebg");
    if (whiteBg !== null) {
        window.white_bg = whiteBg === "true" || whiteBg === "";
    }

    const base64_encoded_design_urls = urlParams.get("design_urls");

    if (base64_encoded_design_urls) {
        try {
            const json_str = atob(base64_encoded_design_urls);
            window.design_urls = JSON.parse(json_str);
        } catch (e) {
            console.error(e);
        }
    }
};

export const is_showing_design_block = () => window.app === "design_block";
