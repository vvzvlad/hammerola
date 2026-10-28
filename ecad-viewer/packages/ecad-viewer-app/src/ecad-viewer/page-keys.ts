/**
 * The step through the schematic's pages a key asks for: `[` the previous
 * page, `]` the next one, by the key or by its place on the keyboard (`х` and
 * `ъ` on a Russian layout), else null.
 *
 * Not with Command or Control held: then the key is the browser's. Command
 * with `[` and `]` is Back and Forward on a Mac, and a page step taken in
 * their place would keep the reader on the schematic and add an entry to the
 * history rather than take him back to the page he came from.
 */
export function schematicPageStep(
    event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey">,
): -1 | 1 | null {
    if (event.metaKey || event.ctrlKey) return null;
    if (event.key === "[" || event.code === "BracketLeft") return -1;
    if (event.key === "]" || event.code === "BracketRight") return 1;
    return null;
}
