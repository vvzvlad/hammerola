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
