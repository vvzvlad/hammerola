import {
    ComponentERCResultEvent,
    ProjectERCResultEvent,
    ImageExportRequestEvent,
    ImageExportResultEvent,
    LOAD_ZIP_MESSAGE_TYPE,
    READY_MESSAGE_TYPE,
    ERROR_MESSAGE_TYPE,
    LoadZipEvent,
    LoadZipErrorEvent,
} from "../viewers/base/events";

// Track the current Blob URL for cleanup
let currentBlobUrl: string | null = null;

/**
 * Revoke the current Blob URL if it exists
 */
function revokeCurrentBlobUrl() {
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
}

/** The embedding window and the origins it may have. */
export interface BridgeOptions {
    parent?: Window;
    allowedOrigins?: Iterable<string>;
}

/**
 * Origins allowed to drive the bridge: the page's own, plus any listed in
 * `<meta name="ecad-viewer-bridge-origins" content="https://a https://b">`.
 */
export function bridge_origins(doc: Document = document): Set<string> {
    const origins = new Set([window.location.origin]);
    const listed = doc
        .querySelector('meta[name="ecad-viewer-bridge-origins"]')
        ?.getAttribute("content");
    for (const value of listed?.split(/\s+/) ?? []) {
        try {
            if (value) origins.add(new URL(value).origin);
        } catch {
            console.warn(`Ignoring invalid bridge origin: ${value}`);
        }
    }
    return origins;
}

let parentWindow: Window | null = null;
let allowedOrigins = new Set<string>();
// The origin the parent last spoke from; replies go only there.
let parentOrigin: string | null = null;

function postToParent(message: unknown) {
    if (!parentWindow || !parentOrigin) return;
    parentWindow.postMessage(message, parentOrigin);
}

/**
 * Send error message to parent
 */
function sendError(message: string) {
    postToParent({
        type: ERROR_MESSAGE_TYPE,
        message,
    });
}

/**
 * Handle ZIP blob loading from postMessage
 */
function handleLoadZipMessage(blob: Blob, filename?: string) {
    // Validate blob
    if (!(blob instanceof Blob)) {
        sendError("Invalid payload: blob is not a Blob");
        return;
    }

    if (blob.size === 0) {
        sendError("Invalid payload: blob is empty");
        return;
    }

    // Optional: check if it's a ZIP (by extension or MIME type)
    // Note: blob.type may not always be set correctly, so we don't strictly enforce it

    // Revoke previous Blob URL if exists (queueing: newest wins)
    revokeCurrentBlobUrl();

    // Create new Blob URL
    currentBlobUrl = URL.createObjectURL(blob);

    // Set window.zip_url for the existing loader to use
    window.zip_url = currentBlobUrl;

    // Dispatch LoadZipEvent so the viewer can react
    window.dispatchEvent(new LoadZipEvent(blob));
}

/**
 * Send ready notification to parent
 */
function sendReady() {
    // The parent's origin is not known yet: offer readiness to each allowed
    // one; the browser delivers only to the one that matches.
    for (const origin of allowedOrigins) {
        parentWindow?.postMessage({ type: READY_MESSAGE_TYPE }, origin);
    }
}

export const setup_iframe_bridge = (options: BridgeOptions = {}) => {
    const parent = options.parent ?? window.parent;
    // Not framed: nobody may drive the bridge.
    if (parent === window) return;
    parentWindow = parent;
    allowedOrigins = new Set(options.allowedOrigins ?? bridge_origins());
    parentOrigin = null;

    // Send ready notification on setup
    sendReady();

    window.addEventListener("message", (msg) => {
        if (msg.source !== parentWindow) return;
        if (!allowedOrigins.has(msg.origin)) return;
        parentOrigin = msg.origin;
        if (typeof msg.data !== "object" || msg.data === null) return;
        if (typeof msg.data.type !== "string") return;

        switch (msg.data.type) {
            case LOAD_ZIP_MESSAGE_TYPE: {
                // Validate and handle ZIP blob
                const { blob, filename } = msg.data;
                handleLoadZipMessage(blob, filename);
                break;
            }
            case ComponentERCResultEvent.type: {
                const evt = new CustomEvent(ComponentERCResultEvent.type, {
                    detail: msg.data.detail,
                });
                window.dispatchEvent(evt);
                break;
            }
            case ProjectERCResultEvent.type: {
                const evt = new CustomEvent(ProjectERCResultEvent.type, {
                    detail: msg.data.detail,
                });
                window.dispatchEvent(evt);
                break;
            }
            case ImageExportRequestEvent.type: {
                const evt = new ImageExportRequestEvent(msg.data.detail);
                window.dispatchEvent(evt);
                break;
            }
            default:
                // Only warn for known ecad-viewer message types that aren't handled
                if (msg.data.type.startsWith("ecad-viewer/")) {
                    console.warn(
                        `Unknown message type received in iframe bridge: ${msg.data.type}`,
                    );
                }
                // Ignore other message types silently
                break;
        }
    });

    window.addEventListener(ImageExportResultEvent.type, (evt) => {
        const event = evt as ImageExportResultEvent;
        postToParent({
            type: ImageExportResultEvent.type,
            detail: event.detail,
        });
    });

    // Listen for ZIP load error to send error message to parent and revoke Blob URL
    window.addEventListener(LoadZipErrorEvent.type, (evt) => {
        const event = evt as LoadZipErrorEvent;
        sendError(event.detail);
        revokeCurrentBlobUrl();
    });

    // Listen for project load completion/failure to revoke Blob URL
    // The ECadViewer dispatches events when loading completes
    window.addEventListener("kicanvas:load", () => {
        // Project loaded successfully, revoke Blob URL
        revokeCurrentBlobUrl();
    });
};
