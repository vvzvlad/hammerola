/*
    Inter-sheet references of a global label: the text KiCad 9/10 gives its
    `${INTERSHEET_REFS}` field (SCH_GLOBALLABEL::ResolveTextVar,
    eeschema/sch_label.cpp) over the page map that
    SCHEMATIC::RecomputeIntersheetRefs (eeschema/schematic.cpp) builds.
*/

import { sorted_by_numeric_strings } from "../base/array";
import type { NetRef } from "./net_ref";
import type { SchematicDrawingSettings } from "./project-settings";

/** The part of a project the references are read from; `Project` has it. */
export interface IntersheetRefsProject {
    readonly pages: readonly {
        project_path: string;
        filename: string;
        page?: string;
    }[];
    readonly settings: { schematic: { drawing: SchematicDrawingSettings } };
    find_labels_by_name(name: string): readonly NetRef[] | undefined;
}

/**
 * The references of the global label `name` drawn on the page whose
 * `project_path` is `page_path`: the page number of every page whose sheet
 * carries a global label of that name (a sheet used twice counts once per
 * use), in page-number order, the drawn page itself only under
 * `intersheets_ref_own_page`, as `first..last` past two pages under
 * `intersheets_ref_short`, between the prefix and the suffix. KiCad writes `?`
 * for the pages when no page carries the name.
 */
export function intersheet_refs(
    project: IntersheetRefsProject,
    name: string,
    page_path: string,
): string {
    const drawing = project.settings.schematic.drawing;
    const files = new Set(
        (project.find_labels_by_name(name) ?? [])
            .filter((ref) => ref.kind === "global")
            .map((ref) => ref.sheet_name),
    );
    // Stable, so pages of one number keep the hierarchy order KiCad's
    // SCH_SHEET_LIST::SortByPageNumbers falls back to.
    const pages = sorted_by_numeric_strings(
        project.pages.filter((page) => files.has(page.filename)),
        (page) => page.page ?? "",
    );

    let refs = "?";
    if (pages.length) {
        const numbers = pages
            .filter(
                (page) =>
                    drawing.intersheets_ref_own_page ||
                    page.project_path !== page_path,
            )
            .map((page) => page.page ?? "");
        refs =
            drawing.intersheets_ref_short && numbers.length > 2
                ? `${numbers[0]}..${numbers.at(-1)}`
                : numbers.join(",");
    }
    return `${drawing.intersheets_ref_prefix}${refs}${drawing.intersheets_ref_suffix}`;
}
