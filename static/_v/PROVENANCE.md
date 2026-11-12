# Vendored viewer assets

`three-cad-viewer.esm.js` and `three-cad-viewer.css` are **built here**, by
`make viewer`, out of the library's source in [`viewer/`](../../viewer). They are
committed because the hub serves them and the test suite reads them, and because
that source moves only when somebody deliberately rebases or patches it.

`three.module.js` and `three.core.js` are npm's own artefacts, copied out of
`viewer/node_modules/three/build/` by the same target — not rebuilt. They are
**three r184** (`0.184.0`), which is the version the library's own `dependencies`
pin, so which three ships here is not a choice made in this repository. The first
imports the second by a relative path, which is why both are here under their own
names. They are the READABLE builds and not npm's `.min` twins: the Makefile says
what that choice is for.

`GLTFLoader.js`, `BufferGeometryUtils.js` and `SkeletonUtils.js` are three
r184's own add-ons (`examples/jsm/loaders/` and `utils/` of the same npm
package), for the 3D view of a board (`ui/src/BoardView3D.jsx`): it loads the
`.glb` with the loader, which imports the other two. Its camera is turned by
the library's own `CADTrackballControls`, out of the bundle above, so three's
`OrbitControls.js` is not here. Unlike the two above they are NOT
byte-for-byte: a bare `from 'three'` needs an import map, which the hub's CSP
drops, so each file's `from 'three'` is `from './three.module.js'`, and the
loader's two `../utils/…` imports are `./…`. Nothing else is changed.

`USDZExporter.js` and `fflate.module.js` are two more of the same package's
add-ons (`examples/jsm/exporters/` and `libs/`), for View in AR on the model's
page (`ui/src/ar.js`): the exporter writes the view on screen as a USDZ file
and zips it with fflate. The exporter's `from 'three'` is rewritten the same
way and its `../libs/fflate.module.js` import is `./fflate.module.js`; fflate
(0.8.2, MIT, its licence in its own header) imports nothing and is npm's file
byte for byte. sha256 of npm's file, then of ours:

| File | npm | here |
| --- | --- | --- |
| `GLTFLoader.js` | `97642d720f16cc9a0c9844934198e4d0c023bea8e89576d0f7545d03b2d103d2` | `d7f4b3a86e622f5ae040ab32349a96714e8d6b360bc706c697f17e5a6d9464d7` |
| `BufferGeometryUtils.js` | `d700b4c4584b9ff53a04692624d2363019f6d1df2978a207389168c6ae647a65` | `b3f9636affbbd893311f20c8d0d03c7bf3b345eff7fb723180d333a625e85a01` |
| `SkeletonUtils.js` | `b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f` | `eedd768765d6553f8082953ab3882e2c86dacc2eb7d180a312d1d52e86bb35c5` |
| `USDZExporter.js` | `ba4b5cdd504c9f299181203fc135db5fc95639a1bd92e687186db50cd37cf180` | `c4a740cbfeb3d03f98eeb77977a0834425616bc7092751d1181d764cb1ffdfaa` |
| `fflate.module.js` | `209a4412eb48ce609edb4391992a792ffcc3983d30ee7e2b0b89a8c470f3cd8a` | `209a4412eb48ce609edb4391992a792ffcc3983d30ee7e2b0b89a8c470f3cd8a` |

To move them: copy them from the same three version as the two above and
repeat the rewrites.

## Where the source came from

`viewer/` is `bernhard-42/three-cad-viewer` at tag **v5.0.7**, commit
`ca285378eafc4436f73b2ed26956eee59c1072e8`, MIT, taken 2026-09-25 — the library's
own `src/`, `css/`, `icons/`, `scripts/copy_version.cjs`, its rollup config and
its tsconfig. Its `docs/`, `examples/` and `tests/` are not vendored.

## What we changed, and why

Eight files, all of them but `package.json` carrying the reason in a comment of
their own:

* `viewer/src/index.ts` re-exports three's namespace, so the page can name the
  very classes the library renders with, and the library's `CADTrackballControls`,
  so the 3D view of a board (`ui/src/BoardView3D.jsx`) turns under the model's hand,
  and, for the measurement on that view, three's screen-wide lines
  (`LineSegments2`, `LineSegmentsGeometry`, `LineMaterial`);
* `viewer/src/core/viewer.ts` gains an `onBeforeRender` hook — the twin of the
  library's own `onAfterRender`, called at the top of `update()` — because this
  viewer renders ON DEMAND and a widget of ours standing in its scene has to be
  placed by the very frame that draws it (`ui/src/viewport/scene3d.js`). The
  field's declaration and the call site each carry the reason;
* depth peeling of translucent faces, because three sorts transparent objects
  per object and draws nested translucent parts (a board inside a ghosted case,
  a cover over a body) in the wrong order: `viewer/src/rendering/depth-peeling.ts`
  is ours, `viewer/src/scene/nestedgroup.ts` patches every face material for it
  in `renderShape`, and `viewer/src/core/viewer.ts` renders through it in
  `update()` and the screenshot instead of calling `renderer.render` directly.
  Every frame is peeled, a moving camera's too, and a layer is compared with
  the opaque depth after its own material's polygon offset, as pass A's depth
  test compares it. `ui/tests/peeling.test.js` asserts the bundle still does all
  of it;
* the studio look behind the page's Studio button: `viewer/src/rendering/studio-look.ts`
  is ours (the room the faces reflect, the lights that follow the camera, the
  shadow under the model), `viewer/src/core/viewer.ts` switches it with
  `setStudio` (tone mapping, the default lights and the edges), and
  `viewer/src/core/picking-controller.ts` drops the hover tint while it is on.
  The peel shader in `depth-peeling.ts` tone-maps its layers itself when the
  renderer does, because three tone-maps only what it draws to the screen;
* the page's "Hover highlight" setting: `viewer/src/core/viewer.ts` gains
  `setHoverHighlight` (the hub turns hover preselection off unless the reader
  ticks it in Settings), and `viewer/src/core/picking-controller.ts` reads it
  through `PickHost.hoverHighlight` in `hoverPreselectActive`;
* `viewer/rollup.config.mjs` sets `external: three` — the whole point (issue #14)
  — and drops the outputs and the dev-server branch we do not use;
* `viewer/package.json` — `prepare` removed (it ran `yarn build`, and there is no
  yarn here), and the devDependencies cut down to what the one remaining output
  needs. Easy to miss on a rebase precisely because it carries no comment of its
  own: restore upstream's copy and `npm ci` starts pulling a toolchain for
  outputs that are no longer built.

`viewer/package-lock.json` is ours as well, and upstream has no counterpart to
rebase onto — it builds with yarn 1 and ships `yarn.lock`. Its root `version`
records the tag, so it has to be moved with `package.json`, or the lockfile
describes a release the source is not.

One instance is the property that matters: `instanceof` has to hold across the
library, its addons and anything we add to its scene. The bundle names that
instance by URL — `import * as THREE from '/_v/three.module.js'`, written in by
rollup's `output.paths` — and NOT as a bare `three` resolved by an import map on
the page. The map was tried first and does not work here: it is an inline script
and the hub serves every page under `default-src 'self'` with no `'unsafe-inline'`
in `script-src`, so the browser drops it in silence and the page dies on `Failed
to resolve module specifier "three"`.

Which is also why nothing in `static/_v/` is served `immutable` any more. The
year used to be granted to `three-cad-viewer.*` on the grounds that the name
carried the library's identity and a new version would arrive under a new name.
`make viewer` rewrites these exact names, so the viewer now changes with the
image like `hammerola.js` does (`src/app.py`).

## What this replaces, and the claim it corrects

These files used to be copied from the `ocp_vscode` pip package, and the previous
version of this file called that package the canonical source. It was not: the
bytes were measured equal to the npm release of `three-cad-viewer@5.0.1`, which
`ocp_vscode` merely pins and ships. Measured again when v5.0.1 was vendored here
— a build of it from this source, with our two edits reverted, was byte-for-byte
the file that had been committed before, `sourceMappingURL` comment aside.

## Upgrading

Rebase the edits listed above onto the new tag inside `viewer/`, run `make
viewer`, and commit the source and the built files together. The tessellation JSON
carries a `version` field (currently 3) produced by `ocp-tessellate` on the model
side, and the renderer must still understand it — so bump the two together and
re-check that a real project's build renders.

## The KiCad viewer: `ecad-viewer.js` and `parser.worker.js`

These are **built here** as well, by `make ecad`, out of the viewer's source in
[`ecad-viewer/`](../../ecad-viewer), and committed for the reasons the files above
are.

### Where its source came from

`ecad-viewer/` is
[`krishna-swaroop/ecad-viewer`](https://github.com/krishna-swaroop/ecad-viewer) at
commit `acce6970beab16053df66f29906437fd5b85e2a5`, the head of its `dev` branch,
MIT, taken 2026-11-05: the merge whose tree is that of
`564ff94cf3f5f0b08be9c7d9ea160dbcc2eab673` (both
`69254e0fa99d7690f5f1e06df82ecd0d2bf19a0d`), the commit the KiCAD-Prism repository
builds its copy of the viewer from:
[`krishna-swaroop/KiCAD-Prism`](https://github.com/krishna-swaroop/KiCAD-Prism) at
commit `a62fadf526eee6a69d15b2cc1e3ee29ec1102c1e` has it as `adapterCommit` in the
`ecad-viewer.manifest.json` of `frontend/public/` (`dirty: false`), built there by
`scripts/build-ecad-viewer.sh`, and the commit sits on the fork's pinned upstream
`c3537042ff7156ce077d204df00a9d4add0e29b1` (`upstreamCommit`). It carries the
fork's insets (`src/ecad-viewer/insets/`): windows onto the other document that
a pin or a pad opens, which the page turns on by linking its two elements
(`ui/src/KicadView.jsx`). The fork is a fork
of `Huaqiu-Electronics/ecad-viewer`. Licence: **MIT**, the fork's `LICENSE.md`,
its copyright line included, which is `ecad-viewer/LICENSE.md` and, beside the
served files, `ecad-viewer-LICENSE.md`. Prism's own code is Apache-2.0 and none of
it is here.

What is vendored, at the fork's own paths, so that a diff against the fork reads
as it stands: `LICENSE.md` and the root `tsconfig.json`; of
`packages/ecad-viewer-app/`, `src/` without `src/3d-viewer/` and `src/glyph/`
(the sources of `3d-viewer.js` and `glyph-full.js`, below), `scripts/build.js`
and `scripts/bundle.js`, `tsconfig.json`, and `third_party/earcut/` and
`third_party/earcut-wasm/` (the triangulation the bundle embeds); of
`packages/kicad-parser/`, `src/` and `tsconfig.json`. The tsconfigs are inputs of
the build, not only of a type check: esbuild takes `experimentalDecorators` and
`useDefineForClassFields` from them. Not vendored: the docs, the demo pages and
the tests (`static/`, `test/`, `packages/kicad-parser/tests/`), the font sources
(`third_party/newstroke/`, of which the committed
`src/kicad/text/newstroke-glyphs.ts` is the generated result),
`packages/ecad-renderer/`, and the scripts that lint, test and serve it or build
its sprites, its font, `glyph-full.js` and `3d-viewer.js`.
`src/ecad-viewer/ecad_viewer.ts` imports a type out of the absent
`src/3d-viewer/`, so `tsc` over this tree reports that import; the build does not
type-check.

### How it is built

`make ecad` runs `npm ci` in `ecad-viewer/` (once per change of its package
files) and `npm run build` there, which is
`node packages/ecad-viewer-app/scripts/build.js` — the fork's own script, the one
Prism's `scripts/build-ecad-viewer.sh` runs: esbuild 0.27.7, minified, ES2022,
`three` and the two glyph and 3D modules external. It then copies
`ecad-viewer.js` and `parser.worker.js` out of `packages/ecad-viewer-app/build/`
into this directory by name.

Three files of the build are ours:

* `ecad-viewer/package.json` — one package where the fork has a workspace of
  three: what the bundle takes in (`comlink`, `immutable`, `jszip`) and
  `esbuild`, each pinned to the version the fork's lockfile resolves, and `build`
  as its one script. Easy to miss on a rebase because it carries no comment:
  restore the fork's three and `npm ci` pulls their lint and test toolchain again;
* `ecad-viewer/package-lock.json` — resolved from the `package.json` above; the
  fork's lockfile is its workspace's;
* `packages/ecad-viewer-app/scripts/build.js` — the fork's third entry point,
  `ecad-renderer`, is dropped, which its comment says.

Built from this tree with our edits taken out, the two files are byte for byte
the ones Prism publishes, whose hashes its manifest records — which is what makes
the edits the only difference between Prism's viewer and ours:

| File | sha256 |
| --- | --- |
| `ecad-viewer.js` built without our edits, and Prism's | `679cf37da9a742ea36449f53c644a4e9e1aa0dd50a90f94ac00dfd3e1e8b44da` |
| `ecad-viewer.js` as committed | `93cc6f58e5ad9937288d33229f55045054273f535e2d74f54d34242278b909b3` |
| `parser.worker.js` built without our edits, and Prism's | `4db7d8e5ef8d705bc9d2fe19fd6619d8e0fc27a833027dd08b1bdc76e22a7f1f` |
| `parser.worker.js` as committed (edit 16 reaches it) | `594b1b7afb55d7ec1a173ef0168e846c6c22d337a68a1a970380e1360d3bd8c3` |
| `ecad-viewer-LICENSE.md` | `8a8fc30b7593ddc63132baa9e58c1d09464aa434f3c5ed5166a52800de6208b3` |

Prism's manifest names a third artefact, `ecad-renderer.js`, which is not built
here: Prism's library panel draws symbols and footprints with it, and
`ecad-viewer.js` never imports it. Neither are `3d-viewer.js` (the viewer's own
3D tab) and `glyph-full.js` (CJK
glyphs): `ecad-viewer.js` imports them by the names `window.ecad3dModuleName`
and `window.ecadGlyphModuleName` hold (`src/ecad-viewer/ecad_viewer.ts`,
`src/kicanvas/project.ts`), else by the bare names `3d-viewer` and `glyph-full`,
which only an import map resolves; the hub sets neither name and serves no
inline script. So a design whose text holds Chinese, Japanese or Korean
characters fails to load here (not checked against a real one).

`ecad-viewer.js` is an ES module, fetched by URL when a KiCad design is opened
(`ECAD_VIEWER_URL` in `ui/src/KicadView.jsx`), and it starts its parser workers
from `./parser.worker.js` relative to its own URL, which is why the two sit side
by side under these names. It needs two things of the hub's CSP (SPEC §7.4):
`'wasm-unsafe-eval'` in `script-src` for the WebAssembly triangulation embedded
in it, and `blob:` in `img-src` for the icons of its panels, an SVG sprite it
builds into a `blob:` URL.

### Our edits

Twenty, in the TypeScript of `packages/ecad-viewer-app/src/` and, for edit 16,
of `packages/kicad-parser/src/`, each with its reason in a comment at the spot.
Edit 6 is checked by `ui/tests/schematicpins.test.js`, which reads sheets
through the fork's own parser (`kicad-parser`, aliased in
`ui/vitest.config.mjs`; the JS step of CI carries `ecad-viewer/packages` for
it), edit 7 by `ui/tests/areaitems.test.js` the same way, edits 14 and 15 by
`ui/tests/boardoutline.test.js`, edit 16 by `ui/tests/kicad5board.test.js`
and edit 18 by `ui/tests/boardcopper.test.js` the same way, what edit 19 fits,
draws and boxes by `ui/tests/boardpicture.test.js`, the link, the double-click's
toggle and the keys of edit 20 by `ui/tests/worldview.test.js`, edit 9 by `ui/tests/pagekeys.test.js`, the text of edit 10 by
`ui/tests/intersheetrefs.test.js` and the arithmetic of edit 2 by
`ui/tests/wheelgesture.test.js`. The others are the viewer's drawing and input
code and what its element hands the page, checked in a browser; what keeps them
is that they live in the source the files are built from. Built without
minifying, the bundles of this tree and the fork's at `acce697` differ in these
twenty places and the comments beside them.

**1. A selected footprint is outlined, not filled over.** `paint_footprint` in
`viewers/board/painter.ts` painted the whole footprint into the selection mask
in cyan at 55% before drawing its bounding box, so a part double-clicked here or
arrived at from the schematic (`requestCrossProbe`) was covered by a solid
patch. The box alone says as much. The mask pass is dropped, the box kept.

**2. The wheel is the touchpad's, as everywhere else on the site.** `#on_wheel`
of `MoveAndZoom` in `base/dom/move-and-zoom.ts` zoomed on every wheel event off
`deltaY` and never read `deltaX`, so a two-finger swipe zoomed instead of moving
the drawing. It now pans on a plain wheel and zooms about the pointer with
Control held (which is how a touchpad pinch arrives), by the arithmetic of
`wheelMove` in `ui/src/gerber.js`: 16 px to a line, the zoom delta clamped to
40 px, the rate 0.01 a pixel — written as `0.01 / zoom_speed` because
`#handle_zoom` scales by the viewer's own `zoom_speed`, 0.005. The viewer's
±24 px clamp on the wheel delta, which it spent on the zoom, and its swap of the
axes under Shift, which only cancelled that zoom, are gone with it, and so is
`line_delta_multiplier` (8 px to a line); the Gerbers have neither, and Shift
and the wheel now pan like the wheel alone. `#handle_pan(dx, dy)` moves the
camera's centre by `(dx, dy) / zoom`, so passing the deltas through unchanged
makes the drawing follow the fingers; `#handle_zoom(delta, point)` multiplies
the zoom by `exp(-delta · zoom_speed)` and keeps the world point under `point`
where it is. The arithmetic is `wheel_gesture` (`base/dom/wheel-gesture.ts`),
and the wheel over an inset (`ecad-viewer/insets/session.ts`) takes it too, the
inset's own camera panned and zoomed about the pointer by the same numbers; Shift
and the wheel still turn an inset, as the fork has it.

**3. Selecting a footprint leaves the copper pours as they were.** The board
viewer's `highlight_fp` (`viewers/board/viewer.ts`), which a double click on a
footprint and `requestCrossProbe` go through, saved the visibility of every zone
layer into its private map `#zones_visibility` and hid them all, to be put back
by `#restore_zone_layers` or `on_document_clicked` when the selection went — so
a part arrived at from the schematic sat on a board with no pours. The hiding is
dropped; the map now stays empty, and both restorers do nothing with an empty
map.

**4. A highlighted net dims the board, not the page around it.** A click on a net
(a track, a pad, a pour) has `paint_highlight` in `viewers/board/painter.ts` lay
a veil of the theme's background colour at 72% (`HIGHLIGHT_DIM_OPACITY`) over
everything, the net then drawn above it. The veil's rectangle (`#board_extent`)
was the board outline's box grown on every side by a quarter of its longer side
plus 5 mm, so the page around the board went dark with it — a slab far wider
than the board. It is the outline's box itself now (the box of everything drawn,
when there is no `Edge.Cuts`).

**5. The element answers what is under a point.** `selectAt(clientX, clientY)`
of `<ecad-viewer>` (`ecad-viewer/ecad_viewer.ts`) selects, in the viewer on
screen, what a left click at that client point (a MouseEvent's
clientX/clientY) selects, and reports it as `ecad-viewer:selection`, as the
click would; under it is `select_at(clientX, clientY)` of every viewer
(`viewers/base/viewer.ts`), which runs the viewer's own `on_click` at the
point, and selects nothing before the viewer has drawn (no viewport, no layers
yet). The viewer selects on the left button only, and the page's right-click
menu (`ui/src/KicadView.jsx`) needs to know what is under the right one. Its
`kicanvas:context-selection` and `kicanvas:sch-context-selection` events would
not do: they are declared in `viewers/base/events.ts` and dispatched nowhere.
A text carrying a hyperlink is selected by `select_at` as any item is: the
schematic viewer's `on_click` (`viewers/schematic/viewer.ts`) follows a link
only on a click, which `select_at` does not hand it. Followed, a link with a
scheme opens as the fork has it (`http`, `https` and `mailto` only); a link
without one is a file of the project, and when it is no loaded schematic
(`#open_hyperlink` in `kicanvas/elements/kc-schematic/app.ts`) nothing opens:
the fork opened a window on it, which resolves the path against the address of
the page and finds no such file.

**6. A placed symbol without pin records still has its pins.** The viewer drew a
placed symbol's pins only from its own `(pin "N" (uuid …))` records; KiCad writes
them and draws a symbol without them too, and konnect writes none. So
`SchematicSymbol` (`kicad/schematic.ts`) gives a symbol with no record one pin
per pin number of its library symbol in `lib_symbols`: every unit's (which unit
is drawn is decided per placement), in body style 0 or its own, which is where
`LibSymbol.pin_by_number` looks them up; with no uuid, since the file has none,
and none at all when the library symbol is missing.

**7. The element says what an area holds.** `itemsInArea(context, bounds)` of
`<ecad-viewer>` (`ecad-viewer/ecad_viewer.ts`) hands what each layer of the
viewer has painted, with the box it painted it in, to `area_items`
(`ecad-viewer/area-items.ts`), which names what meets `bounds` (`[x, y, w, h]`
in the document's millimetres): the designators of symbols and footprints and
the names of nets, without power symbols and flags and without the names KiCad
makes up for an unnamed net. The page reads it for the area of a comment
(`ui/src/KicadView.jsx`).

**8. Overlays survive a load of the document.** `DocumentViewer`
(`viewers/base/document-viewer.ts`) bound the overlay scenes — the comment
markers among them — into a document's new layers before its painter ran; the
painter paints every layer the set yields, the overlays' own among them, and
left an overlay compiled before it with an empty layer that the same scene,
handed again, never filled. They are bound after the painter now. And the
viewer's draw of its own frame (`on_draw` in `viewers/base/viewer.ts`) refreshes
its screen-sized overlays every time: a fit after a load moves the camera
without a change of viewport, and left them sized for the zoom before. Not in
`render_layers`, under it, which every inset calls with its own camera on
every frame it draws.

**9. Command or Control with a bracket is the browser's.** `#handle_host_keydown`
of `<ecad-viewer>` steps through the schematic's pages on `[` and `]`, and took
them with Command or Control held as well. Command with `[` and `]` is Back and
Forward on a Mac, so on a schematic Back moved to the previous sheet — from the
root, round to the last — and added an entry to the history instead of leaving
the page. The step is decided by `schematicPageStep` (`ecad-viewer/page-keys.ts`),
which leaves the key to the browser with Command or Control held.

**10. A global label shows its inter-sheet references.** The viewer parsed a
global label's `Intersheetrefs` field (`Intersheet References` in KiCad 6) and
the `.kicad_pro`'s `intersheets_ref_*` settings, and drew neither.
`GlobalLabelPainter.paint_fields` (`viewers/schematic/painters/label.ts`) now
draws, while `intersheets_ref_show` is on, the text `intersheet_refs`
(`kicad/intersheet-refs.ts`) builds as KiCad 10's
`SCH_GLOBALLABEL::ResolveTextVar` does: the page numbers of the sheets that carry
a global label of the name, sorted, the own page per `intersheets_ref_own_page`,
the short form, the prefix and the suffix. It stands beside the label's body
when the field still sits at the label's point, where KiCad places it itself,
else at the field's saved place. The settings' defaults are left as they were,
which is what KiCad's application settings load: no brackets, no own page.

**11. The list of a label's namesakes is on screen, and a jump from it is a
page change.** `SchSelectionPopMenu`
(`kicanvas/elements/kc-schematic/selection-pop-menu.ts`), which a left click on a
global or local label opens, is a fixed host the size of the view with no `top`
or `left`; under `hide-chrome` it sat at its static place below the canvas, and
the panel placed at the pointer inside it was drawn off the window. The host is
pinned to the top left and lets the pointer through (`pointer-events: none`, the
panel `auto`), so the wheel over the drawing still pans and zooms while the list
is open; the panel is placed by the pointer's offset from the host's box once it
is attached, and kept inside the window; a press of any button anywhere else
closes it, so the page's right-click menu never stands on it. A jump from the list to another sheet
(`#select_item` in `kc-schematic/app.ts`) loaded the file straight into the
viewer; it now activates the sheet's page through the project, as a sheet
symbol's double click does, so the page hears of the change, and frames the item
after that load.

**12. The element hands out its BOM.** `getBomItems()` of `<ecad-viewer>`
(`ecad-viewer/ecad_viewer.ts`) returns the project's BOM, `bom_items`, as plain
objects `{ references, value, footprint, qty, dnp }`: a row per footprint, value
and DNP, as `_sort_bom` of `kicanvas/project.ts` groups the parts the schematic
visitor collects (every hierarchical instance; a part excluded from the BOM,
one with no footprint and one not annotated, `R?`, left out). `references` is
the group's designators one by one, which `ItemsGroupedByFpValueDNP`
(`kicad/ItemsGroupedByFpValueDNP.ts`) now hands out through a getter beside its
joined `Reference`. The page draws the BOM view of a design from it as a table
of its own (`ui/src/KicadView.jsx`), each designator a link to the part on the
board.

**13. A host that turns the selection panel off gets no list of a net from the
viewer.** A click on a label opens the viewer's list of the places of its name
(`kc-sch-selection-menu`) unless the host sets `show-selection-panel="false"`;
the page sets it and opens a menu of its own (`ui/src/KicadView.jsx`). The fork
checks that attribute through `closest("ecad-viewer")`, which does not leave the
shadow tree the app is drawn in, so it never found the host:
`#host_opens_lists` in `kc-schematic/app.ts` takes the host as the root of that
tree. A click on a sheet pin opens no list in the fork itself.

**14. A board is framed by the Edge.Cuts inside its footprints too.** The view
is fitted on load and by Fit to `KicadPCB.bbox`, which is `edge_cuts_bbox`
(`kicad/board.ts`), and that read the board's own drawings only. KiCad cuts
along the footprints' Edge.Cuts as well, and a board converted from Eagle can
carry its whole outline in its "board shape" footprints: WB-MGU v1.2 opened
zoomed into a 7 mm cut beside one part. `edge_cuts_bbox` now adds every
footprint's Edge.Cuts item, placed with the transform the painter and
`Footprint.bbox` use; the board size of the info panel reads it as well.

**15. An arc's points and box are where the arc is drawn.** An arc's angles are
atan2 in document space and `to_polyline` draws them with cos and sin, but its
start, mid and end radials (`base/math/arc.ts`) turned the radius with
`Angle.rotate_point`, KiCad's RotatePoint, which turns the other way: the
points, and the box built from them, came out mirrored about the centre's
horizontal while the drawing was right, and a rounded corner of an outline
framed the board 0.76 mm too tall. The radials now use cos and sin. The box is
the two ends and the radial at every multiple of 90° between the two angles;
the fork's axis checks added the wrong point past 270° and 360° and did not
handle a sweep below zero or running backwards.

**16. A board KiCad 5 wrote opens, with its arcs and pours.** KiCad 5 calls a
footprint `module`, and `parseFootprint` (`kicad-parser/src/board_parser.ts`)
insisted on `footprint` and threw on the whole board; it takes the start word
from its caller now, and the `module` collection passes `module`. This edit
reaches `parser.worker.js`. KiCad 5 gives an arc by its centre, its start and
the angle it sweeps, with no `mid`: the board's drawings, a footprint's and a
custom pad's primitives (`kicad/board.ts`) take an `angle` for an arc as well
as a `mid`, and `Arc.from_center_start_end` (`base/math/arc.ts`) raises the end
angle by whole turns until it is past the start, as KiCad's `CalcArcAngles`
does, where the fork's normalisation swept past a whole turn; its two
`console.log` calls are gone. A zone's fill without a layer, which KiCad 5
writes, takes its zone's, so the pour is drawn.

**17. A host can take the insets' Escape.** An inset session listens for
Escape on `window` from its first inset to its last (`insets/session.ts`), and
an element off screen (`setActive(false)`) drops only its previews, so the
pinned insets of a board the reader left closed on an Escape pressed over the
schematic, and a design kept mounted behind another took the Escape meant for
the one on screen. `enableInsets({ hostEscape: true })` (`ecad_viewer.ts`) has
the session listen for none (`own_escape`), in the link made then and in one
made again after `setInsetPeer(null)`; the host calls `escapeInsets()` for the
element on screen itself (`key` in `ui/src/KicadView.jsx`).

**18. The element hands out the board's copper for a 3D view.** KiCad's `.glb`
merges a board's copper into three meshes that carry no net and no layer, so a
3D view drawn from it can neither light a net nor pull the layers apart.
`getBoardCopper()` of `<ecad-viewer>` (`ecad-viewer/ecad_viewer.ts`) returns
`board_copper` (`ecad-viewer/board-copper.ts`) of the loaded board, null before
it: every copper layer in stack order with the heights of its faces where KiCad's
3D export puts them (`STEP_PCB_MODEL::getCopperLayerZPlacement` of KiCad 10,
over the board's `(stackup)` or, for a board without one, the stack
`BuildDefaultStackupList` makes), its triangles in the board's millimetres with
each vertex's net code, the plated barrels of the vias and through pads with the
layers they join, and the net names by code. The triangles are the 2D board's
shapes from the same data: zone fills as the loader triangulated them, tracks as
the renderer's pills, SMD pads and copper graphics through the viewer's own
painters into a `NullRenderer`; a via is a ring and a plated through pad its
outline less its drill. The page draws this copper in place of the `.glb`'s
(`ui/src/BoardView3D.jsx`, `ui/src/board3dcopper.js`).

**19. The element draws one side of the board into a canvas and hands out its
size and each part's box.** The BOM's assembly view (`ui/src/BomView.jsx`) shows
the board's top and bottom over the table and lights a row's parts on them; what
it is handed is in `ecad-viewer/board-picture.ts`, a file of ours.
`renderBoardPicture(canvas, { bottom })` of `<ecad-viewer>`
(`ecad-viewer/ecad_viewer.ts`) draws the loaded board fitted to its outline
(`picture_box`: `KicadPCB.bbox`, the Edge.Cuts box Fit frames, grown by 2% of its
longer side so the outline's stroke stays inside) into a 2D canvas sized by CSS,
through the path the board insets take: the board viewer's own scene and WebGL
context, one frame through another camera copied out in the same task
(`render_board_view`, `viewers/board/board-view.ts`), so it draws while the
element is hidden; the camera is the insets' (`inset_matrix`, `insets/camera.ts`),
mirrored left to right for the bottom. The frame draws that side alone
(`picture_layers`): its copper's pads (a through-hole pad is on both sides' copper,
as KiCad draws it), its silkscreen and fab with their designators and values, the
holes of pads and unplated holes, and Edge.Cuts; no tracks, zones or vias, no
inner copper, nothing of the other side, no user, drawing-sheet or margin layer,
no selection. `render_board_view` takes it as `only`, a test of a layer's name:
for that frame every other layer is hidden and none is highlighted, and each
layer's visibility and highlight is put back in the same call, before the main
view is drawn again. It returns the map from the board's millimetres to the
canvas's CSS pixels as the six numbers of a 2D context's `setTransform`, null when
nothing was drawn. `getBoardPictureSize()` returns the width and height in
millimetres of what it fits (`picture_box`), so the page gives each picture the
board's proportions; null before a board is loaded. `getFootprintBoxes()`
returns every footprint as `{ reference, bottom, outline }` (`footprint_boxes`):
its designator, whether its layer is a back one, and the four corners, in the
board's millimetres, of `Footprint.bbox` (the box the viewer outlines a selected
footprint with, `outline_footprint` in `viewers/board/painter.ts`) combined with
its pads' boxes, as a board inset frames a footprint, so a part with no
silkscreen or fab graphics still has the box of its pads.

**20. The world view opens on a double-click on a label, a local label's
included, its lines are straight and still, its camera moves only by hand,
closing it hands its picture to the main view, and a namesake on the label's
own sheet is linked.** The fork's world view
(`ecad-viewer/net-tracking/`) lays every sheet a label's net reaches on one
canvas, with a line from the label to each place it reaches. It opened on `~`,
held while clicking or pressed after a click, and chained more nets in the same
way; each line was a curve leaving its label sideways, grew from the label, then
ran in dashes with the net's name written on them and an arrowhead at its far
end, the label it reached rippled once, and the view redrew every frame while
open; the camera eased out from what the main view showed to every sheet,
eased again to frame them all when a chain was added, and framed them again on
a resize until moved by hand; `#add_chain` dropped a link whose two ends are on
one sheet, so a global label's namesake on its own sheet got neither line nor
mark; and `net_closure` stopped a local label at the wires of its sheet, so a
local label's namesakes were lit by the schematic viewer's own overlay instead
(lit boxes joined by straight dashes, `show_local_trace`), one name per sheet;
the tracker no longer calls it. A double-click on a label, a sheet entry or a power
symbol in the main view now traces it (`on_dblclick` in
`viewers/schematic/viewer.ts` reports it as a select of intent `trace`, which
`ecad_viewer.ts` hands to the tracker), a local label as anything else: it opens
the view, `net_closure` taking a local label on to its namesakes on its sheet,
which fan out from the first of them reached as global labels do. A sheet entry
is taken before the sheet symbol it sits on, a double-click elsewhere on a sheet
symbol still enters it, any other item is framed as before, and a wire is not
traced; what is traced is `traceable_uuid`, now in `net-graph.ts`, so the viewer
asks it without importing the view's scenes, which import the viewer. In the
view, a double-click on such a label takes away every chain it is in, the view
closing with the last of them and its sheets staying, or adds its net in the
next colour (`WorldView.toggle`; the next colour is counted from the view's
opening, not from the chains left). Closing the view moves nothing on screen:
the main view takes over the picture it shows (`WorldView.hand_over`). Escape, a
double-click on an empty place, between the sheets or on a sheet's blank paper,
and taking away the last chain hand it the sheet under the middle of the canvas,
or the one nearest it; a double-click on any other item hands it that item's
sheet (the fork eased into the sheet first, then framed the first label of a
chain on it with `zoom_fit_item`, far zoomed in). The main view shows that
sheet, switching to it when another is on screen, with its camera on the box the
view shows, taken from the world into that sheet's own coordinates (the host's
`open_page`, `#open_page_at` in `ecad_viewer.ts`); the view covers the main
view's canvas exactly, so the same box is the same picture. `~` is gone, its
key-up wiring with it. The view opens with its
camera where the main view's is, on the starting sheet framed as the main view
frames it (on every sheet when the main view shows none of them), and only a
pan or a zoom moves it after that; a line to a sheet off screen runs off the
edge, and its zoom spans the main view's (`Viewer.MinZoom` to `Viewer.MaxZoom`;
the fork's went further out and less far in), so the camera it hands back on
closing is one the main view can hold. A chain's lines join the places it links, on every sheet shown,
by the shortest tree of segments (`spanning_pairs` in `geometry.ts`), each
place to a near one, where the fork drew a line from the traced label to every
place it reached. A line is straight and solid in its chain's colour over a
soft glow, with a ring on each label it joins and no name or arrowhead, drawn
whole and still once the sheets at both its ends have faded in; frames are
drawn while sheets
fade in, and on a change (a hover, a click, a pan or a zoom). `shown_links`
keeps a link with both ends on one sheet, and a net that stays on one sheet
opens the view on that sheet alone (the fork wanted two sheets). The page
(`ui/src/KicadView.jsx`) opens its menu for a net a left click picked on the
schematic only once the time for a second click has passed, so the double-click
opens none. While the view is open, `selectAt`, which the page's right click
asks what is under the pointer, selects what the view shows there
(`WorldView.select_at`, the view's own click), not the schematic under it; and
a place the page's menu steps to on the schematic closes the view first
(`hideWorldView`), since the schematic shows the place. That close, like the one
in `showPage`, hands nothing over: the step frames its place itself.

### Upgrading it

Take the new commit of the fork into `ecad-viewer/` by the list above, build it
first with none of our edits and compare the two files with what Prism publishes
from that commit, if it does; then re-apply the edits (a `git diff` of
`ecad-viewer/` against the fork at `acce697` is them, at the fork's paths, with
the three build files), run `make ecad` and the JS suite — `schematicpins.test.js`,
`areaitems.test.js`, `pagekeys.test.js`, `intersheetrefs.test.js`,
`boardoutline.test.js`, `kicad5board.test.js`, `boardcopper.test.js`,
`boardpicture.test.js` and `worldview.test.js` fail if edit 6, 7, 9, 10, 14 and 15, 16, 18, 19 or 20 was lost (`wheelgesture.test.js` checks the
arithmetic of edit 2, not that `MoveAndZoom` and the inset panel still call it) —
update this section and the hashes, and commit the
source and the built files together.

## The Gerber renderer: `wasm_gerber_processor.js` and `wasm_gerber_processor_bg.wasm`

Not built here either. They are the `wasm/` directory of the npm package
[`wasm-gerber-renderer`](https://www.npmjs.com/package/wasm-gerber-renderer)
**0.8.1** (published 2026-10-09, `gitHead`
`02d079729a1e5125a7cc096931c00603d9453ec1` of
[`dsafdsaf132/wasm-gerber-viewer`](https://github.com/dsafdsaf132/wasm-gerber-viewer),
`packages/wasm-gerber-renderer`), taken with `npm pack wasm-gerber-renderer@0.8.1`
and copied byte for byte. The package's own `LICENSE` (**MIT**, copyright line
included) is copied as `wasm-gerber-renderer-LICENSE.txt`. Its other files — the
`index.js`/`shared.js` front end, the Node half, the CLI and the 64-bit build in
`wasm/pkg64/` — are not here: the page drives `GerberProcessor` of the first
file directly (`ui/src/GerberView.jsx`), because the front end parses every
layer again for each frame it draws.

| File | sha256 |
| --- | --- |
| `wasm-gerber-renderer-0.8.1.tgz` (npm's tarball, not here) | `2663cc45617d7044f4a526bc3a4a39f5b3735f1bce5eff3952fda8535a1665c6` |
| `wasm_gerber_processor.js` | `484724887e1cde60076ccee9955eb6ecf8bd4fd6bc0bac0360ef46286fc118d5` |
| `wasm_gerber_processor_bg.wasm` | `201b4cf697506a51b0723abe3537f26136c34d663a093cabfbd9cffd2e7e44bc` |
| `wasm-gerber-renderer-LICENSE.txt` | `61953d24005a26ce1ef6bd75c01eda5cd850d7f059d89a337baaed131ed5b625` |

`wasm_gerber_processor.js` is wasm-bindgen's ES module, fetched by URL when a set
of Gerbers is opened (`GERBER_MODULE_URL` in `ui/src/gerber.js`); its `default`
export fetches `./wasm_gerber_processor_bg.wasm` relative to its own URL, which
is why the two sit side by side under these names. Two things of the hub make
it work: `'wasm-unsafe-eval'` in the CSP's `script-src` (SPEC §7.4), and the
`.wasm` served as `application/wasm` (`CONTENT_TYPES` in `src/app.py`) — under
any other type `WebAssembly.instantiateStreaming` refuses it and the module
falls back to the slower `WebAssembly.instantiate` with a console warning.

To move it: `npm pack` the new version, replace the three files together, and
update this section and the hashes in one commit.

## Do not put these in `data/`

They are assets, not state. `data/` is covered by a docker volume on prod, which
would hide anything shipped there inside the image.
