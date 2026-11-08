/** What `readable_sheet_path` reads of a sheet instance (`ProjectPage`). */
export interface SheetPathPage {
    name?: string;
    parent_project_path?: string;
}

/**
 * What KiCad prints for `${SHEETPATH}`: the names of the sheets from the
 * root down, "/" for the root and "/amp/" for a sheet under it. The
 * page's own `sheet_path` is the UUID path, which KiCad never shows.
 * `page_by_path` finds a page by its project path.
 */
export function readable_sheet_path<P extends SheetPathPage>(
    page: P | undefined,
    page_by_path: (project_path: string) => P | undefined,
): string {
    const names: string[] = [];
    for (
        let at = page;
        at?.parent_project_path;
        at = page_by_path(at.parent_project_path)
    ) {
        names.unshift(at.name ?? "");
    }
    return names.length ? `/${names.join("/")}/` : "/";
}

/** KiCad's nil UUID, written where no UUID was set. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The UUID KiCad 10 roots a schematic's instance paths at, from the project
 * file's `schematic.top_level_sheets` (`listed`); undefined where it names
 * none, and the paths then start at the root file's own UUID.
 *
 * Symbol and sheet instance paths start at the listed top-level sheet's UUID
 * rather than the root file's own; the two differ in an imported project. A
 * listed nil UUID names no sheet: KiCad 10 writes it into the project file
 * while the paths in the schematic files start at the root file's UUID. A
 * host may load the root under another name, so a lone top-level sheet is
 * taken as the root's.
 */
export function top_level_sheet_uuid(
    listed: unknown,
    root_filename: string,
): string | undefined {
    if (!Array.isArray(listed)) return undefined;
    const sheets = listed.filter(
        (sheet): sheet is { uuid: string; filename?: unknown } =>
            typeof sheet?.uuid === "string" &&
            sheet.uuid !== "" &&
            sheet.uuid !== NIL_UUID,
    );
    const named = sheets.find((sheet) => sheet.filename === root_filename);
    return (named ?? (sheets.length === 1 ? sheets[0] : undefined))?.uuid;
}
