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
loader's two `../utils/…` imports are `./…`. Nothing else is changed. sha256 of
npm's file, then of ours:

| File | npm | here |
| --- | --- | --- |
| `GLTFLoader.js` | `97642d720f16cc9a0c9844934198e4d0c023bea8e89576d0f7545d03b2d103d2` | `d7f4b3a86e622f5ae040ab32349a96714e8d6b360bc706c697f17e5a6d9464d7` |
| `BufferGeometryUtils.js` | `d700b4c4584b9ff53a04692624d2363019f6d1df2978a207389168c6ae647a65` | `b3f9636affbbd893311f20c8d0d03c7bf3b345eff7fb723180d333a625e85a01` |
| `SkeletonUtils.js` | `b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f` | `eedd768765d6553f8082953ab3882e2c86dacc2eb7d180a312d1d52e86bb35c5` |

To move them: copy the three from the same three version as the two above and
repeat the two rewrites.

## Where the source came from

`viewer/` is `bernhard-42/three-cad-viewer` at tag **v5.0.7**, commit
`ca285378eafc4436f73b2ed26956eee59c1072e8`, MIT, taken 2026-09-25 — the library's
own `src/`, `css/`, `icons/`, `scripts/copy_version.cjs`, its rollup config and
its tsconfig. Its `docs/`, `examples/` and `tests/` are not vendored.

## What we changed, and why

Six files, all of them but `package.json` carrying the reason in a comment of
their own:

* `viewer/src/index.ts` re-exports three's namespace, so the page can name the
  very classes the library renders with, and the library's `CADTrackballControls`,
  so the 3D view of a board (`ui/src/BoardView3D.jsx`) turns under the model's hand;
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
  `update()` and the screenshot instead of calling `renderer.render` directly,
  hands it `update` to draw the peeled frame once the camera has settled, and
  has the screenshot pass `exact` so it is peeled even mid-move.
  `ui/tests/peeling.test.js` asserts the bundle still does all of it;
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
commit `461a091952ef44b56610e3ccbac4ba3c94139c4a`, MIT, taken 2026-10-26. It is the
commit the KiCAD-Prism repository builds its copy of the viewer from:
[`krishna-swaroop/KiCAD-Prism`](https://github.com/krishna-swaroop/KiCAD-Prism) at
commit `3215ab1ddb3905c279aa7a0ee806a62a3d9f2a63` has it as `adapterCommit` in the
`ecad-viewer.manifest.json` of `frontend/public/` (`dirty: false`), built there by
`scripts/build-ecad-viewer.sh`, and the commit sits on the fork's pinned upstream
`c3537042ff7156ce077d204df00a9d4add0e29b1` (`upstreamCommit`). The fork is a fork
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
* `ecad-viewer/package-lock.json` — the fork's lockfile at `461a091` does not
  install (`npm ci`: `Missing: ecad-renderer@0.1.0 from lock file`), so this one
  is resolved from the `package.json` above;
* `packages/ecad-viewer-app/scripts/build.js` — the fork's third entry point,
  `ecad-renderer`, is dropped, which its comment says.

Built from this tree with our edits taken out, the two files are byte for byte
the ones Prism publishes, whose hashes its manifest records — which is what makes
the edits the only difference between Prism's viewer and ours:

| File | sha256 |
| --- | --- |
| `ecad-viewer.js` built without our edits, and Prism's | `55ef0a844038a87f30e968b9509cafd4c6e25414ec0ca3700a296529f3f8939a` |
| `ecad-viewer.js` as committed | `cc573be2b10540e46462a6b5d18b754815db17dfdaf22722cfb5bdb3f46b294c` |
| `parser.worker.js` (none of our edits reach it) | `7a3b8f5f46977e2fb0c3f6de6b38cac4d5738d2beae970f0b5e86f84db890994` |
| `ecad-viewer-LICENSE.md` | `8a8fc30b7593ddc63132baa9e58c1d09464aa434f3c5ed5166a52800de6208b3` |

Prism's manifest names a third artefact, `ecad-renderer.js`, which is not built
here: Prism's library panel draws symbols and footprints with it, and
`ecad-viewer.js` never imports it. Neither are `3d-viewer.js` (the viewer's own
3D tab) and `glyph-full.js` (CJK
glyphs): `ecad-viewer.js` imports both by the bare names `3d-viewer` and
`glyph-full`, which only an import map resolves, and the hub serves no inline
script. So a design whose text holds Chinese, Japanese or Korean characters
fails to load here (not checked against a real one).

`ecad-viewer.js` is an ES module, fetched by URL when a KiCad design is opened
(`ECAD_VIEWER_URL` in `ui/src/KicadView.jsx`), and it starts its parser workers
from `./parser.worker.js` relative to its own URL, which is why the two sit side
by side under these names. It needs two things of the hub's CSP (SPEC §7.4):
`'wasm-unsafe-eval'` in `script-src` for the WebAssembly triangulation embedded
in it, and `blob:` in `img-src` for the icons of its panels, an SVG sprite it
builds into a `blob:` URL.

### Our edits

Nine, in the TypeScript of `packages/ecad-viewer-app/src/`, each with its reason
in a comment at the spot. Edit 6 is checked by `ui/tests/schematicpins.test.js`,
which reads sheets through the fork's own parser (`kicad-parser`, aliased in
`ui/vitest.config.mjs`; the JS step of CI carries `ecad-viewer/packages` for
it), edit 7 by `ui/tests/areaitems.test.js` the same way, and edit 9 by
`ui/tests/pagekeys.test.js`. The others are the viewer's drawing and input code,
checked in a browser; what keeps them is that they live in the source the files
are built from. Built without minifying, the bundle of this tree and the fork's
at `461a091` differ in these nine places and the comments beside them.

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
where it is.

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
viewer's draw (`viewers/base/viewer.ts`) refreshes its screen-sized overlays
every time: a fit after a load moves the camera without a change of viewport,
and left them sized for the zoom before.

**9. Command or Control with a bracket is the browser's.** `#handle_host_keydown`
of `<ecad-viewer>` steps through the schematic's pages on `[` and `]`, and took
them with Command or Control held as well. Command with `[` and `]` is Back and
Forward on a Mac, so on a schematic Back moved to the previous sheet — from the
root, round to the last — and added an entry to the history instead of leaving
the page. The step is decided by `schematicPageStep` (`ecad-viewer/page-keys.ts`),
which leaves the key to the browser with Command or Control held.

### Upgrading it

Take the new commit of the fork into `ecad-viewer/` by the list above, build it
first with none of our edits and compare the two files with what Prism publishes
from that commit, if it does; then re-apply the edits (a `git diff` of
`ecad-viewer/` against the fork at `461a091` is them, at the fork's paths, with
the three build files), run `make ecad` and the JS suite — `schematicpins.test.js`,
`areaitems.test.js` and `pagekeys.test.js` fail if edit 6, 7 or 9 was lost —
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
