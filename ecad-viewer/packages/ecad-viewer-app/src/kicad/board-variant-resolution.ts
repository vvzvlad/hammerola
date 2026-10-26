/*
    Copyright (c) 2026 KiCAD-Prism contributors.
    Use of this source code is governed by an MIT-style
    license that can be found in the LICENSE file or at
    https://opensource.org/licenses/MIT.
*/

/**
 * Pure design-variant resolution for boards (KiCad 10), the PCB counterpart
 * of `variant-resolution.ts`.
 *
 * The rules mirror KiCad's own reading of a footprint `(variant …)` record and
 * the ones frozen in the KiCAD-Prism design-variant contract packet (v1.0,
 * section 2.4):
 *
 * - a record's boolean token replaces the footprint's base `attr` flag; an
 *   absent token inherits it (KiCad initialises every record from the base and
 *   only writes the tokens that differ);
 * - variant names are matched case-insensitively on the board
 *   (`CASE_INSENSITIVE_MAP`, N16/N17); a record name that matches only by case
 *   still resolves;
 * - the empty name, the `< Default >` sentinel and an unknown name all resolve
 *   the base footprint (N17/N18);
 * - a `field` entry replaces that property's text by name, an empty value
 *   included; field names are stored exact, as `std::map<wxString, wxString>`
 *   does (N16);
 * - nothing is OR-folded from other footprints or from the schematic: each
 *   footprint UUID carries its own base flags and records.
 *
 * Nothing here touches parsed objects: callers pass base values in and get
 * effective values out, so switching A → B → default never mutates a footprint.
 */

import type { boardProto } from "kicad-parser";

/** KiCad's default-design sentinel; it is not a selectable variant name. */
export const DEFAULT_VARIANT_PLACEHOLDER = "< Default >";

/** One `(variant …)` record as it sits on a footprint. */
export class FootprintVariantRecord {
    readonly name: string;
    readonly dnp?: boolean;
    readonly exclude_from_bom?: boolean;
    readonly exclude_from_pos_files?: boolean;
    readonly fields: ReadonlyMap<string, string>;

    constructor(data: boardProto.I_FootprintVariant) {
        this.name = data.name;
        if (data.dnp !== undefined) this.dnp = data.dnp;
        if (data.exclude_from_bom !== undefined)
            this.exclude_from_bom = data.exclude_from_bom;
        if (data.exclude_from_pos_files !== undefined)
            this.exclude_from_pos_files = data.exclude_from_pos_files;
        this.fields = new Map(
            (data.fields ?? []).map((field) => [field.name, field.value]),
        );
    }

    /**
     * Wrap a footprint's records. File order is preserved: KiCad's
     * case-insensitive map keeps the record first written on a
     * case-insensitive tie, so lookup must see the same order.
     */
    static from_list(
        data: boardProto.I_FootprintVariant[] | undefined,
    ): FootprintVariantRecord[] {
        return (data ?? []).map((entry) => new FootprintVariantRecord(entry));
    }
}

/** The base `attr` flags a footprint carries in the file. */
export interface FootprintBaseFlags {
    dnp: boolean;
    exclude_from_bom: boolean;
    exclude_from_pos_files: boolean;
}

/** Effective flags of one footprint; already exclusion-oriented. */
export interface EffectiveFootprintFlags {
    dnp: boolean;
    exclude_from_bom: boolean;
    exclude_from_pos_files: boolean;
}

/**
 * The empty string and the `< Default >` sentinel are not names; both mean the
 * default design. Native compares the sentinel case-insensitively.
 */
export function normalize_variant_name(
    name: string | null | undefined,
): string | null {
    if (!name) return null;
    return name.toLowerCase() === DEFAULT_VARIANT_PLACEHOLDER.toLowerCase()
        ? null
        : name;
}

/**
 * The footprint's record for `name`: first record in file order whose name
 * matches case-insensitively (packet 2.4, native `CASE_INSENSITIVE_MAP`).
 */
export function find_footprint_variant(
    records: readonly FootprintVariantRecord[] | undefined,
    name: string | null,
): FootprintVariantRecord | undefined {
    const normalized = normalize_variant_name(name);
    if (normalized === null) return undefined;
    const folded = normalized.toLowerCase();
    for (const record of records ?? []) {
        if (record.name.toLowerCase() === folded) return record;
    }
    return undefined;
}

/** Effective flags of a footprint: present tokens over base, absent inherit. */
export function resolve_footprint_flags(
    base: FootprintBaseFlags,
    record: FootprintVariantRecord | undefined,
): EffectiveFootprintFlags {
    return {
        dnp: record?.dnp ?? base.dnp,
        exclude_from_bom: record?.exclude_from_bom ?? base.exclude_from_bom,
        exclude_from_pos_files:
            record?.exclude_from_pos_files ?? base.exclude_from_pos_files,
    };
}

/**
 * Property text under a record: the override wins when the record names the
 * property exactly (an empty override is an explicit value). Unlike the
 * schematic field override, a footprint variant is never written with
 * `Reference`, so no name is carved out here.
 */
export function resolve_footprint_field_text(
    record: FootprintVariantRecord | undefined,
    name: string,
    base: string | undefined,
): string | undefined {
    if (!record) return base;
    const override = record.fields.get(name);
    return override === undefined ? base : override;
}
