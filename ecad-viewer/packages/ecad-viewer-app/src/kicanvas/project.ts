/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { Barrier } from "../base/async";
import { type IDisposable } from "../base/disposable";
import { first, length } from "../base/iterator";
import { Logger } from "../base/log";
import { dirname } from "../base/paths";

import { DrawingSheet, KicadPCB, KicadSch, ProjectSettings } from "../kicad";
import { merge_board_pods, parse_drawing_sheet } from "kicad-parser";
import * as Comlink from "comlink";
import {
    BoardBomItemVisitor,
    type DesignatorRef,
} from "../kicad/board_bom_visitor";
import type { BomItem } from "../kicad/bom_item";
import { ItemsGroupedByFpValueDNP } from "../kicad/ItemsGroupedByFpValueDNP";
import { NetRef, type LabelKind } from "../kicad/net_ref";
import {
    GlobalLabel,
    HierarchicalLabel,
    NetLabel,
    SchematicInstanceContext,
} from "../kicad/schematic";
import type { FilledPolygon } from "../kicad/board";
import { SchematicBomVisitor } from "../kicad/schematic_bom_visitor";
import { NewStrokeGlyph } from "../kicad/text/newstroke-glyphs";
import { readable_sheet_path, top_level_sheet_uuid } from "./sheet-path";

import {
    FetchFileSystem,
    type EcadBlob,
    type EcadSources,
} from "./services/vfs";
import "../ecad-viewer/ecad_viewer_global";
import {
    KICAD_PCB_EXT,
    KICAD_PRO_EXT,
    KICAD_SCH_EXT,
    KICAD_WKS_EXT,
} from "./file_ext";
import { ParseCache } from "./parse_cache";
import { WorkerPool } from "./worker_pool";
import { ecadPerfLog, formatBytes, isEcadPerfLogEnabled } from "./perf_log";

const log = new Logger("kicanvas:project");

/** KiCad's default-design sentinel; it is not a selectable variant name. */
export const DEFAULT_VARIANT_PLACEHOLDER = "< Default >";

/**
 * The empty string and the `< Default >` sentinel mean the default design
 * (packet 2.1). Schematic catalog identity is otherwise case-sensitive;
 * board-side folding happens while the catalog is built.
 */
export function normalize_variant_name(
    name: string | null | undefined,
): string | null {
    if (!name) return null;
    return name.toLowerCase() === DEFAULT_VARIANT_PLACEHOLDER.toLowerCase()
        ? null
        : name;
}

/** One entry of the project's variant catalog (packet 2.1). */
export interface ProjectVariant {
    name: string;
    description: string | null;
}

/** Outcome of validating a requested variant against the loaded catalog. */
export interface VariantRequestResolution {
    /** Name to apply; `null` is the default design. */
    effective: string | null;
    /** What to keep for the next settle; `null` when rejected or default. */
    requested: string | null;
    /** Whether the request is in the catalog (true when it cannot be checked yet). */
    known: boolean;
}

/**
 * Validate a requested variant against the project's catalog. Before the
 * sources settle nothing can be checked, so the request is kept and the
 * current selection is left alone (the element replays it after load). Once
 * loaded, an unknown name resolves the default design *and* clears the
 * request, so a later reload does not resurrect it.
 */
export function resolve_variant_request(
    project: Project,
    requested: string | null,
    loaded: boolean,
): VariantRequestResolution {
    const normalized = normalize_variant_name(requested);
    if (!loaded) {
        return {
            effective: project.active_variant,
            requested: normalized,
            known: true,
        };
    }
    const known =
        normalized === null ||
        project.variant_catalog().some((entry) => entry.name === normalized);
    if (!known) {
        return { effective: null, requested: null, known: false };
    }
    return { effective: normalized, requested: normalized, known: true };
}

export enum AssertType {
    SCH,
    PCB,
}

type PerfAccum = {
    pcb: number;
    sch: number;
    totalWorkerMs: number;
    totalModelMs: number;
};

// Single shared parser worker pool for the whole page. Each <ecad-viewer>
// creates its own Project, and a diff view mounts several viewers at once
// (new + old, sch + pcb). Giving every Project its own pool spawns
// N × workerCount workers that oversubscribe the CPU and make every parse
// several times slower under contention.
let _shared_pool: WorkerPool | undefined;
function get_shared_pool(): WorkerPool {
    if (!_shared_pool) {
        _shared_pool = new WorkerPool(
            Math.min(navigator.hardwareConcurrency ?? 4, 6),
        );
    }
    return _shared_pool;
}

// A board at least this large is split into self-contained chunks parsed in
// parallel on the pool (kicad-parser's board_split.ts), about one chunk per
// PARALLEL_PARSE_CHUNK_BYTES and never more than PARALLEL_PARSE_MAX_CHUNKS.
// Cold loads in Chrome: EDA-04903 (56.8 MB, 4 chunks) 3835 -> 2997 ms and
// jumperless_v5r7 (26.7 MB, 3 chunks) 1908 -> 1655 ms. At 16.4 MB
// (speedy_processing_module, 2 chunks) the worker saved only 50 ms, within
// run-to-run noise, so smaller boards keep the single parse.
const PARALLEL_PARSE_MIN_BYTES = 20 * 1024 * 1024;
// Zone fills with at least this many points are triangulated in the pool.
const ZONE_WORKER_MIN_POINTS = 5_000;
const PARALLEL_PARSE_CHUNK_BYTES = 12 * 1024 * 1024;
const PARALLEL_PARSE_MAX_CHUNKS = 4;

function parallel_parse_chunks(bytes: number, pool_size: number): number {
    if (bytes < PARALLEL_PARSE_MIN_BYTES) return 1;
    return Math.max(
        1,
        Math.min(
            PARALLEL_PARSE_MAX_CHUNKS,
            pool_size,
            Math.ceil(bytes / PARALLEL_PARSE_CHUNK_BYTES),
        ),
    );
}

// Parse de-duplication + result cache, keyed on a hash of the full content
// (sampling a few characters is not safe for two revisions of the same file)
// and budgeted by source bytes -- see parse_cache.ts.
const _parse_cache = new ParseCache(24, 32 * 1024 * 1024);
const _PARSER_CACHE_VERSION = "kicad-parser-v2";

export type EcadParserPerfSnapshot = {
    cacheHits: number;
    parserInvocations: number;
};

export function getParserPerfSnapshot(): EcadParserPerfSnapshot {
    return {
        cacheHits: _parse_cache.hits,
        parserInvocations: _parse_cache.misses,
    };
}

/**
 * The parse cache key. A SHA-256 of the file's UTF-8 bytes where the browser
 * offers crypto.subtle (secure contexts: https or localhost) -- it runs off
 * the main thread, where a JS hash of a 56.8 MB board cost ~86 ms -- and two
 * 32-bit FNV-1a streams over the text otherwise.
 */
async function _parse_key(
    filename: string,
    bytes: Uint8Array,
    content: string,
): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
        try {
            const digest = new Uint8Array(
                await subtle.digest("SHA-256", bytes as BufferSource),
            );
            let hex = "";
            for (const b of digest) hex += b.toString(16).padStart(2, "0");
            return `${_PARSER_CACHE_VERSION}:${filename}:sha256:${hex}`;
        } catch {
            // Fall through to the JS hash.
        }
    }
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < content.length; index++) {
        const code = content.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    return `${_PARSER_CACHE_VERSION}:${filename}:${content.length}:${(
        first >>> 0
    ).toString(16)}:${(second >>> 0).toString(16)}`;
}

/**
 * Parse once per distinct file. The key is computed before the cache is
 * consulted, and the entry is set synchronously after that, so concurrent
 * loads of the same file still share one parse. `bytes` must not be
 * transferred until this has computed the key -- `run` is only called after.
 */
async function dedup_parse<T>(
    filename: string,
    bytes: Uint8Array,
    content: string,
    run: () => Promise<T>,
): Promise<T> {
    const key = await _parse_key(filename, bytes, content);
    if (_parse_cache.has(key)) ecadPerfLog(`cache=hit  ${filename}`);
    return _parse_cache.get_or_run(key, bytes.byteLength, run);
}

export class Project extends EventTarget implements IDisposable {
    _fs = new FetchFileSystem();
    _files_by_name: Map<string, KicadPCB | KicadSch> = new Map();
    _file_content: Map<string, string> = new Map();
    _drawing_sheet_sources: Map<string, string> = new Map();
    _pool = get_shared_pool();
    _pcb: KicadPCB[] = [];
    _sch: KicadSch[] = [];
    _ov_3d_url?: string;
    _bom_items: BomItem[] = [];
    _label_name_refs = new Map<string, NetRef[]>();
    _net_item_refs = new Map<string, NetRef>();
    _designator_refs = new Map<string, DesignatorRef[]>();
    _project_name?: string;
    active_sch_file_name?: string;
    _found_cjk = false;
    #perf_accum: PerfAccum | null = null;

    find_labels_by_name(name: string) {
        return this._label_name_refs.get(name);
    }

    find_net_item(uuid: string) {
        return this._net_item_refs.get(uuid);
    }

    find_designator(d: string) {
        return this._designator_refs.get(d);
    }

    find_designator_by_pin(
        d: string,
        pin_num: string,
    ): DesignatorRef | undefined {
        const refs = this._designator_refs.get(d);
        if (!refs || refs.length === 0) {
            return undefined;
        }

        if (refs.length === 1) {
            return refs[0];
        }

        for (const ref of refs) {
            const sch = this.file_by_name(ref.sheet_name);
            if (sch instanceof KicadSch) {
                const symbol = sch.symbols.get(ref.uuid);
                if (symbol) {
                    const lib_symbol = symbol.lib_symbol;
                    if (lib_symbol) {
                        for (const child of lib_symbol.children) {
                            if (
                                child.unit === ref.unit &&
                                child.has_pin(pin_num)
                            ) {
                                return ref;
                            }
                        }
                    }
                }
            }
        }

        return refs[0];
    }

    get bom_items() {
        return this._bom_items;
    }

    public active_sch_name?: string;

    public loaded: Barrier = new Barrier();
    public settings: ProjectSettings = new ProjectSettings();

    /**
     * Resolve one of the project's own text variables.
     *
     * `.kicad_pro` has always been parsed into `settings.text_variables`, and
     * nothing ever read it: a design using `${VERSION}` on a sheet, on
     * silkscreen or in its title block drew the variable's name instead of its
     * value. Documents hold a reference to the project rather than a copy of
     * this map, because the host may append the `.kicad_pro` after the sheet it
     * belongs to has already been parsed.
     */
    resolve_text_var(name: string): string | undefined {
        return this.settings.text_variables?.[name];
    }
    _root_schematic_page?: ProjectPage;
    _pages_by_path: Map<string, ProjectPage> = new Map();

    get pages() {
        return Array.from(this._pages_by_path.values());
    }

    get project_name() {
        if (this._project_name) return this._project_name;

        const fn =
            (this._pcb.length
                ? this._pcb[0]?.filename
                : this._sch.length
                  ? this._root_schematic_page?.filename
                  : "") ?? "";

        const fns = fn.split(".");

        if (fns.length > 1) {
            return fns.slice(0, -1).join(".");
        }
        return fn;
    }

    public dispose() {
        // Do not dispose the shared WorkerPool — other Project instances reuse it.
        for (const i of [this._pcb, this._sch]) i.length = 0;
        this._files_by_name.clear();
        this._pages_by_path.clear();
        this._file_content.clear();
        this._drawing_sheet_sources.clear();
        this._label_name_refs.clear();
        this._net_item_refs.clear();
        this._designator_refs.clear();
    }

    public reset() {
        this.dispose();
        this._pool = get_shared_pool();
        this._fs = new FetchFileSystem();
        this._pcb = [];
        this._sch = [];
        this._bom_items = [];
        this._drawing_sheet_sources = new Map();
        this._project_name = undefined;
        this._root_schematic_page = undefined;
        this.active_sch_file_name = undefined;
        this.active_sch_name = undefined;
        this._found_cjk = false;
        this.settings = new ProjectSettings();
        this.loaded = new Barrier();
    }

    /**
     * Adopt an already-parsed project model without invoking parser workers.
     * Collections are shallow-cloned so resetting this viewport cannot clear
     * the session owner's project; immutable parsed document objects remain
     * shared between viewports.
     */
    public adopt(source: Project) {
        this.dispose();
        this._fs = source._fs;
        this._pool = source._pool;
        this._files_by_name = new Map(source._files_by_name);
        this._file_content = new Map(source._file_content);
        this._drawing_sheet_sources = new Map(source._drawing_sheet_sources);
        this._pcb = [...source._pcb];
        this._sch = [...source._sch];
        this._ov_3d_url = source._ov_3d_url;
        this._bom_items = [...source._bom_items];
        this._label_name_refs = new Map(source._label_name_refs);
        this._net_item_refs = new Map(source._net_item_refs);
        this._designator_refs = new Map(source._designator_refs);
        this._project_name = source._project_name;
        this.active_sch_file_name = source.active_sch_file_name;
        this.active_sch_name = source.active_sch_name;
        this.active_variant = source.active_variant;
        this._found_cjk = source._found_cjk;
        this.settings = source.settings;
        this._root_schematic_page = source._root_schematic_page;
        this._pages_by_path = new Map(source._pages_by_path);
        this.#perf_accum = null;
        this.loaded = new Barrier();
        this.loaded.open();
    }

    public static async import_cjk_glyphs() {
        const glyphModule =
            (
                window as Window & {
                    ecadGlyphModuleName?: string;
                }
            ).ecadGlyphModuleName ?? "glyph-full";
        await import(glyphModule).then((mod) => {
            NewStrokeGlyph.glyph_data = mod.glyph_data;
        });
    }

    public async load(sources: EcadSources) {
        this._fs = new FetchFileSystem(sources.urls);

        const promises = [];
        const perf_enabled = isEcadPerfLogEnabled();
        if (perf_enabled) {
            this.#perf_accum = {
                pcb: 0,
                sch: 0,
                totalWorkerMs: 0,
                totalModelMs: 0,
            };
        } else {
            this.#perf_accum = null;
        }
        const load_t0 = perf_enabled ? performance.now() : 0;

        for (const filename of this._fs.list()) {
            promises.push(this._load_file(filename));
        }

        const find_root_sch_file_name = () => {
            const sch_file_names = new Set<string>();

            let expected_root_sch = "";
            for (const blob of sources.blobs) {
                if (blob.filename.endsWith(KICAD_SCH_EXT))
                    sch_file_names.add(blob.filename);
                if (blob.filename.endsWith(KICAD_PRO_EXT))
                    expected_root_sch = blob.filename.replace(
                        KICAD_PRO_EXT,
                        KICAD_SCH_EXT,
                    );
            }

            if (sch_file_names.size === 1)
                return sch_file_names.values().next().value;
            if (sch_file_names.has(expected_root_sch)) return expected_root_sch;
            return sch_file_names.values().next().value;
        };

        const root_sch_file_name = find_root_sch_file_name();

        const root_sch_blob = sources.blobs.find(
            (b) => b.filename === root_sch_file_name,
        );
        if (root_sch_blob) {
            await this._load_blob(root_sch_blob);
        }

        for (const blob of sources.blobs) {
            if (blob.filename.startsWith(".")) continue;
            if (blob.filename === root_sch_file_name) continue;

            if (blob.filename.endsWith(KICAD_PCB_EXT)) {
                promises.push(this._load_blob(blob));
            } else if (blob.filename.endsWith(KICAD_SCH_EXT)) {
                promises.push(this._load_blob(blob));
            } else if (blob.filename.endsWith(KICAD_PRO_EXT)) {
                this._project_name = blob.filename.slice(
                    0,
                    blob.filename.length - `.${KICAD_PRO_EXT}`.length,
                );
                const data = JSON.parse(blob.content);
                this.settings = ProjectSettings.load(data);
            } else if (blob.filename.endsWith(KICAD_WKS_EXT)) {
                this._drawing_sheet_sources.set(blob.filename, blob.content);
            }
        }

        await Promise.all(promises);

        if (this._found_cjk) {
            await Project.import_cjk_glyphs();
        }

        let has_root_sch = false;

        if (this.has_schematics)
            has_root_sch = this._determine_schematic_hierarchy();

        this._recompute_bom(has_root_sch);

        this.loaded.open();

        if (perf_enabled && this.#perf_accum) {
            ecadPerfLog(
                `project load complete  pcb=${this.#perf_accum.pcb}  sch=${this.#perf_accum.sch}  totalWorker=${this.#perf_accum.totalWorkerMs.toFixed(0)}ms  totalModel=${this.#perf_accum.totalModelMs.toFixed(0)}ms  wall=${(performance.now() - load_t0).toFixed(0)}ms`,
            );
        }

        this.dispatchEvent(
            new CustomEvent("load", {
                detail: this,
            }),
        );
    }

    _sort_bom(bom_list: BomItem[]) {
        const grouped_it_map: Map<string, ItemsGroupedByFpValueDNP> = new Map();

        const group_by_fp_value = (itm: BomItem) =>
            `${itm.Footprint}-${itm.Name}-${itm.DNP}`;

        for (const it of bom_list) {
            const key = group_by_fp_value(it);

            if (!grouped_it_map.has(key)) {
                grouped_it_map.set(
                    key,
                    new ItemsGroupedByFpValueDNP(
                        it.Name,
                        it.Datasheet,
                        it.Description,
                        it.Footprint,
                        it.DNP,
                    ),
                );
            }
            grouped_it_map.get(key)!.addReference(it.Reference);
        }
        this._bom_items = Array.from(grouped_it_map.values());
    }

    /**
     * Rebuild the engineering BOM from the current revision and the selected
     * variant. The schematic visitor resolves each occurrence's effective
     * flags and fields through its instance context, and those contexts read
     * `active_variant`, so a variant switch is a recompute rather than a
     * second copy of the BOM.
     */
    _recompute_bom(has_root_sch: boolean) {
        const bom_items = (() => {
            if (this.has_schematics) {
                const sch_visitor = new SchematicBomVisitor();
                if (has_root_sch) {
                    for (const page of this.pages) {
                        const context = page.schematic_context;
                        if (context) sch_visitor.visit_instance(context);
                    }
                } else {
                    for (const sch of this.schematics()) {
                        sch_visitor.visit(sch);
                    }
                }

                this._designator_refs = sch_visitor.designator_refs;
                if (sch_visitor.bom_list.length) return sch_visitor.bom_list;
            }
            if (this.has_boards) {
                const visitor = new BoardBomItemVisitor();
                for (const b of this.boards()) visitor.visit(b);
                this._designator_refs = visitor.designator_refs;
                return visitor.bom_list;
            }
            return [];
        })();
        this._sort_bom(bom_items);
    }

    /**
     * Select the design variant this project resolves against. `null` (or the
     * empty/sentinel name) is the default design. The selection survives
     * source replacement because `reset()` keeps it; a revision that dropped
     * the name resolves the base until the host selects another.
     */
    set_active_variant(name: string | null): boolean {
        const normalized = normalize_variant_name(name);
        if (normalized === this.active_variant) return false;
        this.active_variant = normalized;
        this._recompute_bom(!!this._root_schematic_page);
        this.on_loaded();
        return true;
    }

    /** The selected variant; `null` is the default design. */
    public active_variant: string | null = null;

    /** Description from the catalog, or undefined when there is none. */
    variant_description(name: string): string | undefined {
        return (
            this.variant_catalog().find((entry) => entry.name === name)
                ?.description ?? undefined
        );
    }

    /**
     * The variant catalog for the loaded revision (packet 2.1): project
     * registry first in file order, then board-header names, then schematic
     * record names in hierarchy walk order, then footprint record names, each
     * in first-seen order. Board-side names fold case-insensitively into an
     * existing entry; schematic names stay case-sensitive.
     */
    public variant_catalog(): ProjectVariant[] {
        const entries: ProjectVariant[] = [];

        const merge_description = (
            entry: ProjectVariant,
            description: string | null,
        ) => {
            if (entry.description === null && description !== null)
                entry.description = description;
        };

        const add = (
            name: string,
            description: string | null,
            fold: boolean,
        ) => {
            if (!name) return;
            const exact = entries.find((entry) => entry.name === name);
            if (exact) {
                merge_description(exact, description);
                return;
            }
            if (fold) {
                // Board-side names fold case-insensitively into the first
                // catalog entry with that spelling (packet 2.1). Exact names
                // win, and two schematic names differing only by case stay
                // distinct.
                const folded = name.toLowerCase();
                const match = entries.find(
                    (entry) => entry.name.toLowerCase() === folded,
                );
                if (match) {
                    merge_description(match, description);
                    return;
                }
            }
            entries.push({ name, description });
        };

        // 1. `.kicad_pro` `$.schematic.variants`, in file order (N10).
        const registry = (this.settings.schematic as { variants?: unknown })
            .variants;
        if (Array.isArray(registry)) {
            for (const raw of registry) {
                if (!raw || typeof raw !== "object") continue;
                const record = raw as { name?: unknown; description?: unknown };
                if (typeof record.name !== "string") continue;
                add(
                    record.name,
                    typeof record.description === "string"
                        ? record.description
                        : null,
                    false,
                );
            }
        }

        // 2. Board headers, in board then file order (N18).
        for (const board of this.boards()) {
            for (const variant of board.variants) {
                add(variant.name, variant.description ?? null, true);
            }
        }

        // 3. Schematic symbol- and sheet-instance records, hierarchy walk
        //    order then file order (N1/N2).
        const visited_documents = new Set<KicadSch>();
        const add_schematic_names = (document: KicadSch) => {
            if (visited_documents.has(document)) return;
            visited_documents.add(document);
            for (const symbol of document.symbols.values()) {
                for (const instance of symbol.instances.values()) {
                    for (const name of instance.variants.keys())
                        add(name, null, false);
                }
            }
            for (const sheet of document.sheets) {
                for (const instance of sheet.instances.values()) {
                    for (const name of instance.variants.keys())
                        add(name, null, false);
                }
            }
        };
        const pages = this.pages;
        if (pages.length) {
            for (const page of pages) {
                const document = page.document;
                if (document instanceof KicadSch) add_schematic_names(document);
            }
        } else {
            for (const schematic of this.schematics())
                add_schematic_names(schematic);
        }

        // 4. Footprint records, board then file order (N16).
        for (const board of this.boards()) {
            for (const footprint of board.footprints) {
                for (const record of footprint.variants) {
                    add(record.name, null, true);
                }
            }
        }

        return entries;
    }

    public get root_schematic_page() {
        return this._root_schematic_page;
    }

    async _load_file(filename: string) {
        log.info(`Loading file ${filename}`);

        if (filename.endsWith(".kicad_sch")) {
            return await this._load_doc(filename);
        }
        if (filename.endsWith(".kicad_pcb")) {
            return await this._load_doc(filename);
        }
        if (filename.endsWith(".kicad_pro")) {
            return this._load_meta(filename);
        }
        if (filename.endsWith(".kicad_wks")) {
            const text = await this.get_file_text(filename);
            this._drawing_sheet_sources.set(filename, text!);
            return;
        }

        log.warn(`Couldn't load ${filename}: unknown file type`);
    }

    async _load_doc(filename: string) {
        if (this._files_by_name.has(filename)) {
            return this._files_by_name.get(filename);
        }

        const text = await this.get_file_text(filename);
        return this._load_blob({
            filename,
            content: text!,
        });
    }

    /**
     * Triangulate a board's large zone fills on the worker pool, in parallel,
     * and leave the triangles on each FilledPolygon for the zone painter.
     * Done serially on the main thread during paint, EDA-04903's six planes
     * cost 78-132 ms each even after strip triangulation. Fills below
     * ZONE_WORKER_MIN_POINTS stay on the main thread: shipping them costs
     * more than triangulating them. A failure here only means the painter
     * triangulates as before.
     */
    async #triangulate_zone_fills(doc: KicadPCB) {
        const fills: FilledPolygon[] = [];
        for (const zone of doc.zones) {
            for (const fill of zone.filled_polygons ?? []) {
                if (fill.point_count >= ZONE_WORKER_MIN_POINTS) {
                    fills.push(fill);
                }
            }
        }
        if (!fills.length) return;

        const t0 = isEcadPerfLogEnabled() ? performance.now() : 0;
        // A copy: the rings are transferred to the workers, which would
        // detach the fill's own packed coordinates.
        const rings = fills.map((fill) => fill.coords.slice());

        // Largest first, each to the lightest group, one group per worker.
        const groups: number[][] = Array.from(
            { length: Math.min(this._pool.size, fills.length) },
            () => [],
        );
        const load = groups.map(() => 0);
        const order = rings
            .map((_, i) => i)
            .sort((a, b) => rings[b]!.length - rings[a]!.length);
        for (const i of order) {
            const g = load.indexOf(Math.min(...load));
            groups[g]!.push(i);
            load[g]! += rings[i]!.length;
        }

        try {
            await Promise.all(
                groups.map(async (group) => {
                    const batch = group.map((i) => rings[i]!);
                    const triangles = await this._pool.run((worker) =>
                        worker.triangulate_rings(
                            Comlink.transfer(
                                batch,
                                batch.map((r) => r.buffer as ArrayBuffer),
                            ),
                        ),
                    );
                    group.forEach((i, j) => {
                        fills[i]!.triangles = triangles[j];
                        fills[i]!.triangles_bbox = fills[i]!.bbox;
                    });
                }),
            );
        } catch (e) {
            log.warn(`zone triangulation in workers failed: ${e}`);
            for (const fill of fills) {
                fill.triangles = undefined;
                fill.triangles_bbox = undefined;
            }
        }

        if (t0) {
            ecadPerfLog(
                `zone fills  ${doc.filename}  ${fills.length} triangulated in workers  ${(performance.now() - t0).toFixed(0)}ms`,
            );
        }
    }

    async _load_blob(blob: EcadBlob) {
        const file_content = blob.content;

        if (this._files_by_name.has(blob.filename)) {
            return this._files_by_name.get(blob.filename);
        }
        const filename = blob.filename;
        let doc: KicadPCB | KicadSch;

        const is_pcb = blob.filename.endsWith(KICAD_PCB_EXT);
        const perf = this.#perf_accum;
        const t_worker0 = perf ? performance.now() : 0;

        const bytes = new TextEncoder().encode(blob.content);
        // The worker reports whether the text has CJK characters (it needs
        // the full glyph set), so that scan stays off the main thread and is
        // cached with the parse.
        const parsed = await dedup_parse(
            blob.filename,
            bytes,
            file_content,
            async () => {
                const buffer = bytes.buffer as ArrayBuffer;
                const k = is_pcb
                    ? parallel_parse_chunks(buffer.byteLength, this._pool.size)
                    : 1;
                if (k > 1) {
                    const chunks = await this._pool.run((worker) =>
                        worker.split_board(
                            Comlink.transfer(buffer, [buffer]),
                            k,
                        ),
                    );
                    const pods = await Promise.all(
                        chunks.map((chunk) =>
                            this._pool.run(async (worker) => {
                                if (perf) await worker.set_perf_log(true);
                                return worker.parse_board(
                                    Comlink.transfer(chunk, [chunk]),
                                );
                            }),
                        ),
                    );
                    if (perf) {
                        ecadPerfLog(
                            `parallel parse  ${filename}  chunks=${chunks.length}`,
                        );
                    }
                    return {
                        pod: merge_board_pods(pods.map((p) => p.pod)),
                        has_cjk: pods.some((p) => p.has_cjk),
                    };
                }
                return this._pool.run(async (worker) => {
                    if (perf) await worker.set_perf_log(true);
                    return is_pcb
                        ? worker.parse_board(Comlink.transfer(buffer, [buffer]))
                        : worker.parse_schematic(
                              Comlink.transfer(buffer, [buffer]),
                          );
                });
            },
        );

        const pod = parsed.pod;
        if (parsed.has_cjk) this._found_cjk = true;

        const t_worker1 = perf ? performance.now() : 0;
        const t_model0 = t_worker1;

        if (filename.endsWith(KICAD_PCB_EXT)) {
            doc = new KicadPCB(filename, pod as any);
        } else {
            doc = new KicadSch(filename, pod as any);
        }
        doc.project = this;

        const t_model1 = perf ? performance.now() : 0;

        if (doc instanceof KicadPCB) {
            await this.#triangulate_zone_fills(doc);
        }

        if (perf) {
            const workerMs = t_worker1 - t_worker0;
            const modelMs = t_model1 - t_model0;
            if (is_pcb) perf.pcb += 1;
            else perf.sch += 1;
            perf.totalWorkerMs += workerMs;
            perf.totalModelMs += modelMs;
            ecadPerfLog(
                `parse ${is_pcb ? "PCB" : "SCH"}  ${filename}  ${formatBytes(blob.content.length)}  worker=${workerMs.toFixed(0)}ms  model=${modelMs.toFixed(0)}ms`,
            );
        }

        this._files_by_name.set(filename, doc);
        if (doc instanceof KicadPCB) this._pcb.push(doc);
        else {
            this._sch.push(doc);

            for (const it of doc.labels) {
                if (it.uuid) {
                    let kind: LabelKind | undefined;
                    if (it instanceof GlobalLabel) kind = "global";
                    else if (it instanceof NetLabel) kind = "net";
                    else if (it instanceof HierarchicalLabel)
                        kind = "hierarchical";

                    const ref = new NetRef(
                        doc.filename,
                        it.text,
                        it.uuid,
                        kind,
                    );
                    this._net_item_refs.set(it.uuid, ref);

                    if (!this._label_name_refs.has(it.text))
                        this._label_name_refs.set(it.text, []);

                    this._label_name_refs.get(it.text)!.push(ref);
                }
            }

            // A sheet entry carries the net into its child sheet, so it is an
            // instance of that net like a label is.
            for (const sheet of doc.sheets) {
                for (const pin of sheet.pins) {
                    if (!pin.uuid) continue;
                    const ref = new NetRef(
                        doc.filename,
                        pin.name,
                        pin.uuid,
                        "sheet-pin",
                    );
                    this._net_item_refs.set(pin.uuid, ref);
                    if (!this._label_name_refs.has(pin.name))
                        this._label_name_refs.set(pin.name, []);
                    this._label_name_refs.get(pin.name)!.push(ref);
                }
            }
        }
        this._files_by_name.set(filename, doc);
        // A board or schematic is fully parsed by now and is never re-read
        // from its text, so it is not kept: that held a second copy of every
        // file -- 57 MB of heap for EDA-04903.
        return doc;
    }

    async _load_meta(filename: string) {
        const text = await this.get_file_text(filename);
        const data = JSON.parse(text!);
        this.settings = ProjectSettings.load(data);
    }

    /**
     * The drawing sheet `document` is framed by. On a schematic its number,
     * path and name are those of a sheet instance: `instance` when given (each
     * instance on the schematic plane prints its own, a file placed twice
     * included), else the one `#page_for_drawing_sheet` picks.
     */
    public drawing_sheet_for(
        kind: AssertType,
        document?: KicadPCB | KicadSch,
        instance?: ProjectPage,
    ): DrawingSheet {
        const configured =
            kind === AssertType.SCH
                ? String(
                      (this.settings.schematic as Record<string, unknown>)[
                          "page_layout_descr_file"
                      ] ?? "",
                  )
                : this.settings.pcbnew.page_layout_descr_file;
        const requested = configured
            .replace(/^kicad-embed:\/\//, "")
            .replace(/\\/g, "/");
        let content = requested
            ? this._drawing_sheet_sources.get(requested)
            : undefined;
        if (!content && requested) {
            const basename = requested.split("/").pop();
            for (const [name, source] of this._drawing_sheet_sources) {
                if (name === basename || name.endsWith(`/${basename}`)) {
                    content = source;
                    break;
                }
            }
        }
        // A project with one supplied worksheet commonly relies on KiCad's
        // embedded-path indirection.  Use it when the configured basename was
        // flattened by an embedding host.
        if (!content && requested && this._drawing_sheet_sources.size === 1) {
            content = this._drawing_sheet_sources.values().next().value;
        }
        let drawing_sheet: DrawingSheet;
        if (!content) {
            drawing_sheet = DrawingSheet.default();
        } else {
            try {
                drawing_sheet = new DrawingSheet(parse_drawing_sheet(content));
            } catch (error) {
                log.warn(`Couldn't parse drawing sheet ${requested}: ${error}`);
                drawing_sheet = DrawingSheet.default();
            }
        }
        const page =
            kind === AssertType.SCH
                ? (instance ?? this.#page_for_drawing_sheet(document))
                : undefined;
        drawing_sheet.sheet_number = page?.page || "1";
        const numbered_pages = this.pages
            .map((candidate) => Number.parseInt(candidate.page ?? "", 10))
            .filter(Number.isFinite);
        drawing_sheet.sheet_count = String(
            Math.max(1, ...numbered_pages, this.pages.length),
        );
        drawing_sheet.sheet_path = readable_sheet_path(page, (path) =>
            this._pages_by_path.get(path),
        );
        drawing_sheet.sheet_name = page?.name || "";
        drawing_sheet.kicad_version =
            document instanceof KicadSch
                ? document.generator_version || document.generator || "KiCad"
                : document?.generator || "KiCad";
        return drawing_sheet;
    }

    #page_for_drawing_sheet(document?: KicadPCB | KicadSch) {
        const active = this.active_sch_name ?? "";
        const exact = this._pages_by_path.get(active);
        if (exact) return exact;

        // Hosts may activate by filename while the internal project uses a
        // filename + instance-path key. Prefer the active filename before the
        // document fallback so reused hierarchical sheets keep their page ID.
        const by_filename = this.pages.find(
            (candidate) => candidate.filename === active,
        );
        if (by_filename) return by_filename;
        return this.pages.find((candidate) => candidate.document === document);
    }

    async get_file_text(filename: string) {
        if (this._file_content.has(filename))
            return this._file_content.get(filename);
        return await (await this._fs.get(filename)).text();
    }

    public *files() {
        yield* this._files_by_name.values();
    }

    *sch_in_order() {
        for (const p of this.pages) {
            yield this.file_by_name(p.filename) ??
                // AD HOC for ad converted sch
                this.file_by_name(p.sheet_path);
        }
    }

    public file_by_name(name: string) {
        if (this._files_by_name.has(name)) {
            return this._files_by_name.get(name);
        }

        // Fuzzy match: check if any stored filename ends with the requested name
        for (const [key, value] of this._files_by_name) {
            if (key.endsWith(`/${name}`)) {
                return value;
            }
        }

        return undefined;
    }

    /**
     * Resolve a schematic sheet file using KiCad's relative-path semantics.
     * A child sheet path is relative to the schematic that owns the sheet,
     * rather than unconditionally relative to the project root.
     */
    public resolve_schematic_filename(
        parent_filename: string,
        requested_filename: string,
    ): string | undefined {
        const normalize = (value: string) => {
            const parts: string[] = [];
            for (const part of value.replace(/\\/g, "/").split("/")) {
                if (!part || part === ".") continue;
                if (part === "..") parts.pop();
                else parts.push(part);
            }
            return parts.join("/");
        };

        const requested = normalize(requested_filename);
        const relative = normalize(
            `${dirname(parent_filename.replace(/\\/g, "/"))}/${requested_filename}`,
        );

        // Relative resolution is authoritative for nested sheets. Exact root
        // paths remain a fallback for top-level project references.
        for (const candidate of [relative, requested]) {
            if (candidate && this._files_by_name.has(candidate)) {
                return candidate;
            }
        }

        const filenames = Array.from(this._files_by_name.keys());
        const normalized_filenames = filenames.map((filename) => ({
            filename,
            normalized: normalize(filename),
        }));

        // Loaded paths should already be normalized, but preserve the same
        // exact relative/root priority when a host supplied separators or dot
        // segments in its source names.
        for (const candidate of [relative, requested]) {
            const normalized_matches = normalized_filenames.filter(
                ({ normalized }) => normalized === candidate,
            );
            if (normalized_matches.length === 1) {
                return normalized_matches[0]!.filename;
            }
            if (normalized_matches.length > 1) return undefined;
        }

        // Hosts sometimes flatten source paths. Only use a basename/suffix
        // fallback when it identifies exactly one loaded schematic.
        const matches = normalized_filenames.filter(
            ({ normalized }) =>
                normalized.endsWith(`/${requested}`) ||
                normalized.endsWith(`/${relative}`),
        );
        if (matches.length === 1) return matches[0]!.filename;
        if (matches.length > 1) return undefined;

        // KiCad projects are commonly authored on case-insensitive filesystems.
        // Preserve the actual loaded key, but only case-fold as a final fallback
        // when it identifies one file. Case-collisions must fail closed.
        const requested_folded = requested.toLowerCase();
        const relative_folded = relative.toLowerCase();
        const folded_matches = normalized_filenames.filter(({ normalized }) => {
            const folded = normalized.toLowerCase();
            return (
                folded === requested_folded ||
                folded.endsWith(`/${requested_folded}`) ||
                folded === relative_folded ||
                folded.endsWith(`/${relative_folded}`)
            );
        });
        if (folded_matches.length === 1) return folded_matches[0]!.filename;
        if (folded_matches.length > 1) {
            log.warn(
                `Ambiguous case-insensitive schematic path ${requested_filename}: ${folded_matches.map(({ filename }) => filename).join(", ")}`,
            );
        }
        return undefined;
    }

    public *boards() {
        for (const value of this._files_by_name.values()) {
            if (value instanceof KicadPCB) {
                yield value;
            }
        }
    }

    public get has_3d() {
        return (
            this._ov_3d_url !== undefined ||
            window.design_urls?.glb_url !== undefined
        );
    }

    public set ov_3d_url(url: string | undefined) {
        this._ov_3d_url = url;
    }

    public get ov_3d_url() {
        return this._ov_3d_url;
    }

    public get has_boards() {
        return (
            length(this.boards()) > 0 ||
            window.design_urls?.pcb_url !== undefined
        );
    }

    public *schematics() {
        for (const [, v] of this._files_by_name) {
            if (v instanceof KicadSch) {
                yield v;
            }
        }
    }

    public get has_schematics() {
        return (
            length(this.schematics()) > 0 ||
            window.design_urls?.sch_url !== undefined
        );
    }

    public get_first_page(kind: AssertType) {
        switch (kind) {
            case AssertType.SCH:
                if (this.active_sch_name) {
                    const active_page = this._pages_by_path.get(
                        this.active_sch_name,
                    );
                    if (active_page?.document instanceof KicadSch)
                        return active_page.document;
                    const active_file = this._files_by_name.get(
                        this.active_sch_name,
                    );
                    if (active_file instanceof KicadSch) return active_file;
                }
                return (
                    (this._files_by_name.get(
                        `${this._project_name}.kicad_sch`,
                    ) as KicadSch) ??
                    this.root_schematic_page?.document ??
                    first(this._sch)
                );
            case AssertType.PCB:
                return first(this._pcb);
        }
    }

    public page_by_path(project_path: string) {
        return this._pages_by_path.get(project_path)?.document;
    }

    public get is_empty() {
        return length(this.files()) === 0;
    }

    public on_loaded() {
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: this,
            }),
        );
    }

    _determine_schematic_hierarchy() {
        // KiCad schematic navigation is an instance tree. A schematic file can
        // be instantiated more than once, so filenames alone cannot identify a
        // page. Rebuild the tree from the root document and each sheet's UUID,
        // instance path, and parent-relative file reference.
        this._pages_by_path.clear();
        const schematics = Array.from(this.schematics());
        const expected_root = this._project_name
            ? this._files_by_name.get(`${this._project_name}.kicad_sch`)
            : undefined;
        const root =
            (expected_root instanceof KicadSch ? expected_root : undefined) ??
            schematics.find((schematic) =>
                schematic.sheet_instances?.get("/"),
            ) ??
            first(schematics);
        if (!root) {
            this._root_schematic_page = undefined;
            return false;
        }

        const root_page = new ProjectPage(
            this,
            root.filename,
            `/${
                top_level_sheet_uuid(
                    (this.settings.schematic as { top_level_sheets?: unknown })
                        .top_level_sheets,
                    root.filename,
                ) ?? root.uuid
            }`,
            "Root",
            root.sheet_instances?.get("/")?.page ?? "1",
        );
        this._root_schematic_page = root_page;
        const visited = new Set<string>();

        const visit = (document: KicadSch, page: ProjectPage) => {
            if (visited.has(page.project_path)) return;
            visited.add(page.project_path);
            this._pages_by_path.set(page.project_path, page);

            for (const sheet of document.sheets) {
                if (!sheet.sheetfile) continue;
                const instance =
                    sheet.instances.get(page.sheet_path) ??
                    (sheet.instances.size === 1
                        ? first(sheet.instances.values())
                        : undefined);
                if (!instance) continue;
                const filename = this.resolve_schematic_filename(
                    document.filename,
                    sheet.sheetfile,
                );
                const child_document = filename
                    ? this._files_by_name.get(filename)
                    : undefined;
                if (!(child_document instanceof KicadSch) || !filename)
                    continue;

                const child_path = `${page.sheet_path}/${sheet.uuid}`;
                const child_page = new ProjectPage(
                    this,
                    filename,
                    child_path,
                    sheet.sheetname ?? sheet.sheetfile,
                    instance.page ?? "",
                    page.project_path,
                    sheet.uuid,
                );
                visit(child_document, child_page);
            }
        };

        visit(root, root_page);
        if (!this._pages_by_path.has(this.active_sch_name ?? "")) {
            this.active_sch_name = root_page.project_path;
        }
        return true;
    }
}

export class ProjectPage {
    constructor(
        public project: Project,
        public filename: string,
        public sheet_path: string,
        public name?: string,
        public page?: string,
        public parent_project_path?: string,
        public sheet_uuid?: string,
    ) {}

    /**
     * A unique identifier for this page within the project,
     * made from the filename and sheet path.
     */
    get project_path() {
        if (this.sheet_path) {
            return `${this.filename}:${this.sheet_path}`;
        } else {
            return this.filename;
        }
    }

    get document() {
        return this.project.file_by_name(this.filename)!;
    }

    get schematic_context(): SchematicInstanceContext | undefined {
        const document = this.document;
        return document instanceof KicadSch
            ? new SchematicInstanceContext(
                  document,
                  this.sheet_path,
                  this.project_path,
              )
            : undefined;
    }
}
