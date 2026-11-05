/**
 * Split one large `.kicad_pcb` into several smaller, self-contained board
 * sources so they can be parsed in parallel, and merge the results back into
 * the shape a single `BoardParser.parse` would have produced.
 *
 * A board's top-level items are independent of each other as far as the
 * parser is concerned: a footprint, track or zone parses the same wherever it
 * sits. So the bulk items -- footprints, tracks, arcs, vias, zones, drawings
 * and groups -- are dealt, in file order, into byte-balanced chunks, and the
 * small header items every board needs (version, layers, nets, setup, ...)
 * are copied into each chunk. Each chunk is then a valid board on its own.
 *
 * Merging concatenates the bulk collections in chunk order, which is file
 * order, and takes everything else from the first chunk. Any top-level item
 * this file does not know goes to the first chunk only, so it is parsed
 * exactly once, as it would have been.
 */

import type { I_KicadPCB } from "./proto/board";

/** Top-level items dealt out across chunks. */
const BULK = new Set([
    "footprint",
    "module",
    "zone",
    "segment",
    "arc",
    "via",
    "gr_line",
    "gr_circle",
    "gr_arc",
    "gr_poly",
    "gr_rect",
    "gr_text",
    "dimension",
    "group",
]);

/** Top-level items copied into every chunk. */
const HEADER = new Set([
    "version",
    "generator",
    "generator_version",
    "embedded_fonts",
    "general",
    "paper",
    "title_block",
    "setup",
    "property",
    "layers",
    "net",
    "variants",
]);

/** The pod fields BULK items land in, merged by concatenation. */
const BULK_FIELDS = [
    "footprints",
    "zones",
    "segments",
    "vias",
    "drawings",
    "groups",
] as const;

const OPEN = 0x28; // (
const CLOSE = 0x29; // )
const QUOTE = 0x22; // "
const BACKSLASH = 0x5c; // \

/**
 * Split a board's UTF-8 bytes into `k` board sources. Returns the input
 * unsplit (one element) when `k < 2` or the file is not a well-formed
 * `(kicad_pcb ...)` with at least `k` bulk items.
 */
export function split_board_bytes(bytes: Uint8Array, k: number): Uint8Array[] {
    if (k < 2) return [bytes];

    // One pass: the byte ranges of the root's direct children, skipping
    // strings so parentheses inside them do not count.
    const starts: number[] = [];
    const ends: number[] = [];
    let depth = 0;
    let root_open = -1;
    let root_close = -1;
    const n = bytes.length;
    for (let i = 0; i < n; i++) {
        const c = bytes[i]!;
        if (c === QUOTE) {
            for (i++; i < n; i++) {
                const d = bytes[i]!;
                if (d === BACKSLASH) i++;
                else if (d === QUOTE) break;
            }
        } else if (c === OPEN) {
            depth++;
            if (depth === 1 && root_open < 0) root_open = i;
            else if (depth === 2) starts.push(i);
        } else if (c === CLOSE) {
            if (depth === 2) ends.push(i + 1);
            else if (depth === 1 && root_close < 0) root_close = i;
            depth--;
        }
    }
    if (root_open < 0 || root_close < 0 || starts.length !== ends.length) {
        return [bytes];
    }

    // Classify each child by its head token.
    const header: number[] = [];
    const first_only: number[] = [];
    const bulk: number[] = [];
    let bulk_bytes = 0;
    for (let i = 0; i < starts.length; i++) {
        const token = head_token(bytes, starts[i]!);
        if (BULK.has(token)) {
            bulk.push(i);
            bulk_bytes += ends[i]! - starts[i]!;
        } else if (HEADER.has(token)) {
            header.push(i);
        } else {
            first_only.push(i);
        }
    }
    if (bulk.length < k) return [bytes];

    // Deal bulk items into k contiguous, byte-balanced runs.
    const runs: number[][] = Array.from({ length: k }, () => []);
    let seen = 0;
    for (const i of bulk) {
        const run = Math.min(k - 1, Math.floor((seen / bulk_bytes) * k));
        runs[run]!.push(i);
        seen += ends[i]! - starts[i]!;
    }

    const prefix = bytes.subarray(root_open, head_end(bytes, root_open));
    const out: Uint8Array[] = [];
    for (let r = 0; r < k; r++) {
        const items =
            r === 0
                ? [...header, ...first_only, ...runs[r]!]
                : [...header, ...runs[r]!];
        let size = prefix.length + 2;
        for (const i of items) size += ends[i]! - starts[i]! + 1;
        const chunk = new Uint8Array(size);
        chunk.set(prefix, 0);
        let o = prefix.length;
        for (const i of items) {
            chunk[o++] = 0x0a;
            chunk.set(bytes.subarray(starts[i]!, ends[i]!), o);
            o += ends[i]! - starts[i]!;
        }
        chunk[o++] = 0x0a;
        chunk[o++] = CLOSE;
        out.push(chunk.subarray(0, o));
    }
    return out;
}

/**
 * Merge the pods of chunks from `split_board_bytes`, in chunk order, into
 * what parsing the whole board would have returned.
 */
export function merge_board_pods(pods: I_KicadPCB[]): I_KicadPCB {
    if (pods.length === 1) return pods[0]!;
    const merged: Record<string, unknown> = { ...pods[0]! };
    for (const field of BULK_FIELDS) {
        let list: unknown[] | undefined;
        for (const pod of pods) {
            const part = (pod as unknown as Record<string, unknown[]>)[field];
            if (!part) continue;
            list = list ? list.concat(part) : part.slice();
        }
        if (list) merged[field] = list;
    }
    return merged as unknown as I_KicadPCB;
}

/** The head token of the list opening at `open`, e.g. "footprint". */
function head_token(bytes: Uint8Array, open: number): string {
    let i = open + 1;
    let s = "";
    for (; i < bytes.length && i < open + 32; i++) {
        const c = bytes[i]!;
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
        if (c === OPEN || c === CLOSE) break;
        s += String.fromCharCode(c);
    }
    return s;
}

/** End of the root's head, i.e. just after `(kicad_pcb`. */
function head_end(bytes: Uint8Array, open: number): number {
    let i = open + 1;
    while (i < bytes.length) {
        const c = bytes[i]!;
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) break;
        if (c === OPEN || c === CLOSE) break;
        i++;
    }
    return i;
}
