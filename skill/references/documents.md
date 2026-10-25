# Documents published beside the model

A file to read, published with the revision it belongs to: a cut list, a
shopping list, a report, a drawing, a PDF, a picture. A KiCad design and a
Gerber set are documents too, with rules of their own — `references/boards.md`.

A cut list, a shopping list, a report, a drawing: files to read, published
with the revision they belong to. List them in `project.json`, in the order
the page shows them:

```json
"documents": ["docs/cut-list.md", {"file": "ref/terr-raspil.svg", "title": "Saw plan"}]
```

An entry is a path, or an object with the path as `file` and a `title`: the
caption the page shows for it in place of the path (one line of text, as a
project's title), and optionally `"hidden": true`. Each path is a file of the
project, a `.md`, `.pdf`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.html`, `.htm`,
`.svg`, `.kicad_sch`, `.kicad_pcb`, `.glb` or `.zip`, and is published
under the same path; nothing unlisted is. The build page lists them in its view menu, after
the views, one row each: choosing one shows it over the model, choosing a view brings the
model back, and `?d=<id>` in the address (the path with `/` written as `__`)
opens one on arrival. A hidden entry has no row: it is published and opens by its
`?d=<id>` like any other, so a file can sit in the project and be shown without
a menu entry of its own (twenty datasheets are twenty hidden entries, not twenty
rows). With no `model.py` the documents are the whole build,
chosen in the same menu at the bottom of the page. Markdown is drawn with its relative links resolved from its own
directory, web links open in a new tab; a picture it shows must be a file of
the build, because an image from another site is not loaded (the page allows
`img-src 'self' data: blob:`). HTML and SVG run as written; every document opens to
the link without a key.
A path that is not a file, has another extension, is listed twice or would
overwrite what the model's build wrote refuses the push with a 422 naming it.
