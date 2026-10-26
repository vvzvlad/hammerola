/*
    Copyright (c) 2026 KiCAD-Prism contributors.
    Use of this source code is governed by an MIT-style
    license that can be found in the LICENSE file or at
    https://opensource.org/licenses/MIT.
*/

/**
 * Pure design-variant resolution for schematics (KiCad 10).
 *
 * The rules mirror KiCad's own reading of a `(variant …)` record and are the
 * ones frozen in the KiCAD-Prism design-variant contract packet (v1.0,
 * section 2.2):
 *
 * - a record's boolean token replaces the base attribute; an absent token
 *   inherits it (KiCad initialises every record from the base and only writes
 *   the tokens that differ);
 * - `in_bom`, `on_board` and `in_pos_files` are positive tokens, except that
 *   `in_bom` in schematic files older than 20260306 (10.0 pre-release
 *   nightlies) already *is* the excluded flag;
 * - a field entry replaces that field's text, an empty value included;
 *   `Reference` is never overridden;
 * - a symbol is DNP / excluded from BOM, board or simulation when any
 *   ancestor sheet occurrence is (an OR fold up to the root); exclusion from
 *   position files has no sheet fold.
 *
 * Nothing here touches parsed objects: callers pass base values in and get
 * effective values out, so switching A → B → default never mutates a symbol.
 */

import type { schematicProto } from "kicad-parser";

/** Schematic file versions from this one on write `in_bom` as positive logic. */
export const IN_BOM_POSITIVE_SINCE = 20260306;

/** One `(variant …)` record as it sits on a symbol or sheet instance path. */
export class VariantRecord {
    readonly name: string;
    readonly dnp?: boolean;
    readonly exclude_from_sim?: boolean;
    readonly in_bom?: boolean;
    readonly on_board?: boolean;
    readonly in_pos_files?: boolean;
    readonly fields: ReadonlyMap<string, string>;

    constructor(data: schematicProto.I_SchematicVariant) {
        this.name = data.name;
        if (data.dnp !== undefined) this.dnp = data.dnp;
        if (data.exclude_from_sim !== undefined)
            this.exclude_from_sim = data.exclude_from_sim;
        if (data.in_bom !== undefined) this.in_bom = data.in_bom;
        if (data.on_board !== undefined) this.on_board = data.on_board;
        if (data.in_pos_files !== undefined)
            this.in_pos_files = data.in_pos_files;
        this.fields = new Map(
            (data.fields ?? []).map((field) => [field.name, field.value]),
        );
    }

    static from_list(
        data: schematicProto.I_SchematicVariant[] | undefined,
    ): Map<string, VariantRecord> {
        const records = new Map<string, VariantRecord>();
        for (const entry of data ?? []) {
            // KiCad keys records by name; a duplicate name in a hand-edited
            // file resolves to the last one, as std::map assignment would.
            records.set(entry.name, new VariantRecord(entry));
        }
        return records;
    }
}

/** The base attributes a placed symbol carries in the file. */
export interface SymbolBaseFlags {
    dnp: boolean;
    in_bom: boolean;
    on_board: boolean;
    exclude_from_sim: boolean;
    in_pos_files: boolean;
}

/** Effective, exclusion-oriented flags for one symbol occurrence. */
export interface EffectiveSymbolFlags {
    dnp: boolean;
    exclude_from_bom: boolean;
    exclude_from_board: boolean;
    exclude_from_sim: boolean;
    exclude_from_pos_files: boolean;
}

/** The base attributes of a hierarchical sheet symbol. */
export interface SheetBaseFlags {
    dnp: boolean;
    in_bom: boolean;
    on_board: boolean;
    exclude_from_sim: boolean;
}

/** Effective flags of one sheet occurrence; these fold onto its contents. */
export interface SheetFlags {
    dnp: boolean;
    exclude_from_bom: boolean;
    exclude_from_board: boolean;
    exclude_from_sim: boolean;
}

/**
 * Whether a record's `in_bom` token is the excluded flag rather than the
 * positive "in BOM" it reads as. An unknown version is treated as current.
 */
export function in_bom_token_is_excluded(version: number | undefined): boolean {
    return version !== undefined && version < IN_BOM_POSITIVE_SINCE;
}

function excluded_from_bom(
    base_in_bom: boolean,
    record: { in_bom?: boolean } | undefined,
    version: number | undefined,
): boolean {
    if (record?.in_bom === undefined) return !base_in_bom;
    return in_bom_token_is_excluded(version) ? record.in_bom : !record.in_bom;
}

/** Effective flags of a symbol occurrence before the sheet fold. */
export function resolve_symbol_flags(
    base: SymbolBaseFlags,
    record: VariantRecord | undefined,
    version: number | undefined,
): EffectiveSymbolFlags {
    return {
        dnp: record?.dnp ?? base.dnp,
        exclude_from_bom: excluded_from_bom(base.in_bom, record, version),
        exclude_from_board: !(record?.on_board ?? base.on_board),
        exclude_from_sim: record?.exclude_from_sim ?? base.exclude_from_sim,
        exclude_from_pos_files: !(record?.in_pos_files ?? base.in_pos_files),
    };
}

/** Effective flags of one sheet occurrence (its own record over its base). */
export function resolve_sheet_flags(
    base: SheetBaseFlags,
    record: VariantRecord | undefined,
    version: number | undefined,
): SheetFlags {
    return {
        dnp: record?.dnp ?? base.dnp,
        exclude_from_bom: excluded_from_bom(base.in_bom, record, version),
        exclude_from_board: !(record?.on_board ?? base.on_board),
        exclude_from_sim: record?.exclude_from_sim ?? base.exclude_from_sim,
    };
}

/**
 * OR every ancestor sheet occurrence onto a symbol's flags. Position-file
 * exclusion is deliberately left alone: KiCad never folds it.
 */
export function fold_sheet_flags(
    flags: EffectiveSymbolFlags,
    ancestors: Iterable<SheetFlags>,
): EffectiveSymbolFlags {
    const folded = { ...flags };
    for (const sheet of ancestors) {
        folded.dnp ||= sheet.dnp;
        folded.exclude_from_bom ||= sheet.exclude_from_bom;
        folded.exclude_from_board ||= sheet.exclude_from_board;
        folded.exclude_from_sim ||= sheet.exclude_from_sim;
    }
    return folded;
}

/** Same fold for a sheet occurrence sitting under other sheets. */
export function fold_ancestor_sheet_flags(
    flags: SheetFlags,
    ancestors: Iterable<SheetFlags>,
): SheetFlags {
    const folded = { ...flags };
    for (const sheet of ancestors) {
        folded.dnp ||= sheet.dnp;
        folded.exclude_from_bom ||= sheet.exclude_from_bom;
        folded.exclude_from_board ||= sheet.exclude_from_board;
        folded.exclude_from_sim ||= sheet.exclude_from_sim;
    }
    return folded;
}

/**
 * Field text under a record: the override wins when the record names the
 * field (an empty override is an explicit value); `Reference` can never be
 * overridden.
 */
export function resolve_field_text(
    record: VariantRecord | undefined,
    name: string,
    base: string | undefined,
): string | undefined {
    if (name === "Reference" || !record) return base;
    const override = record.fields.get(name);
    return override === undefined ? base : override;
}
