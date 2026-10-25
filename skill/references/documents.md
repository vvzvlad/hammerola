# Documents published beside the model

A file published with the revision it belongs to: a cut list, a shopping
list, a report, a drawing, a PDF, a picture — or any file to hand over, a DXF
for the glass shop, a supplier's STEP. A KiCad design and a Gerber set are
documents too, with rules of their own — `references/boards.md`.

A cut list, a shopping list, a report, a drawing: files to read, published
with the revision they belong to. List them in `project.json`, in the order
the page shows them:

```json
"documents": ["docs/cut-list.md", {"file": "ref/terr-raspil.svg", "title": "Saw plan"},
              {"file": "cut/glass.dxf", "title": "Glass, cut list"}]
```

An entry is a path, or an object with the path as `file` and a `title`: the
caption the page shows for it in place of the path (one line of text, as a
project's title), and optionally `"hidden": true` or `"download": true`. Each
path is a file of the project and is published under the same path; nothing
unlisted is. Its EXTENSION decides only how the page shows it: a `.md`, `.pdf`,
`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.html`, `.htm`, `.svg`, `.kicad_sch`,
`.kicad_pcb`, `.glb` or `.zip` is drawn; a file of any other extension — a DXF
for the glass shop, a supplier's STEP, a CSV of measurements, a firmware image —
keeps its row in the menu and shows its name, extension and size instead of
drawing it, and a
model's build page also offers it in Downloads under its extension (DXF, CSV),
beside the STL. A `.dxf` is that kind of file too, with one addition: the hub
draws a picture of it at publish time and the page shows that picture. The picture is published as `<path>.svg` (`cut/glass.dxf.svg`),
so nothing else may be listed at that path; a DXF the hub cannot read, or one
with nothing drawn in it, refuses the push with a 422 naming it, and
`"download": true` on its entry publishes it with no picture. The build page lists them in its view menu, after
the views, one row each: choosing one shows it over the model, choosing a view brings the
model back, and `?d=<id>` in the address (the path with `/` written as `__`)
opens one on arrival. A hidden entry has no row: it is published and opens by its
`?d=<id>` like any other, so a file can sit in the project and be shown without
a menu entry of its own (twenty datasheets are twenty hidden entries, not twenty
rows). With no `model.py` the documents are the whole build,
chosen in the same menu at the bottom of the page. Markdown is drawn with its relative links resolved from its own
directory, web links open in a new tab, and a link to another listed document
(`[glass vendors](glass-vendors.md)`) opens that document on the page — so name a
neighbouring document with a link rather than in backticks; a picture it shows must be a file of
the build, because an image from another site is not loaded (the page allows
`img-src 'self' data: blob:`). HTML and SVG run as written; every document opens to
the link without a key, whatever its extension — that is how a revision is sent to
a workshop as the complete set. Whatever document is open, Download and Copy link
for its file stand at the bottom left of the page.
A path that is not a file, is listed twice or would
overwrite what the model's build wrote refuses the push with a 422 naming it.

`"download": true` publishes an entry as a plain file whatever its extension, so a
zip of stand logs is taken rather than read as a board's Gerbers, which share the
one extension the page unpacks. A schematic or a board listed that way brings
neither its sheets nor its `.kicad_pro`: there is nothing to draw them for.
