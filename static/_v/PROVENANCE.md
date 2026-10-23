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

## Where the source came from

`viewer/` is `bernhard-42/three-cad-viewer` at tag **v5.0.7**, commit
`ca285378eafc4436f73b2ed26956eee59c1072e8`, MIT, taken 2026-09-25 — the library's
own `src/`, `css/`, `icons/`, `scripts/copy_version.cjs`, its rollup config and
its tsconfig. Its `docs/`, `examples/` and `tests/` are not vendored.

## What we changed, and why

Six files, all of them but `package.json` carrying the reason in a comment of
their own:

* `viewer/src/index.ts` re-exports three's namespace, so the page can name the
  very classes the library renders with;
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

Unlike the files above these are **not built here**. They are the built viewer
out of the KiCAD-Prism repository,
[`krishna-swaroop/KiCAD-Prism`](https://github.com/krishna-swaroop/KiCAD-Prism) at
commit `3215ab1ddb3905c279aa7a0ee806a62a3d9f2a63`, `frontend/public/`, copied
byte for byte, taken 2026-10-23. Prism builds them (`scripts/build-ecad-viewer.sh`)
from its fork of ecad-viewer,
[`krishna-swaroop/ecad-viewer`](https://github.com/krishna-swaroop/ecad-viewer) at
commit `461a091952ef44b56610e3ccbac4ba3c94139c4a` (`adapterCommit` in the
`ecad-viewer.manifest.json` beside them; `dirty: false`), which sits on the
fork's pinned upstream `c3537042ff7156ce077d204df00a9d4add0e29b1`
(`upstreamCommit`). The fork is a fork of `Huaqiu-Electronics/ecad-viewer`.
Licence: **MIT**, the fork's `LICENSE.md` at `461a091` copied as
`ecad-viewer-LICENSE.md`, its copyright line included. Prism's own code is
Apache-2.0 and none of it is here.

| File | sha256 |
| --- | --- |
| `ecad-viewer.js` | `55ef0a844038a87f30e968b9509cafd4c6e25414ec0ca3700a296529f3f8939a` |
| `parser.worker.js` | `7a3b8f5f46977e2fb0c3f6de6b38cac4d5738d2beae970f0b5e86f84db890994` |
| `ecad-viewer-LICENSE.md` | `8a8fc30b7593ddc63132baa9e58c1d09464aa434f3c5ed5166a52800de6208b3` |

The first two equal the hashes Prism's manifest records for them. The manifest
names a third artefact, `ecad-renderer.js`, which is not here: Prism's library
panel draws symbols and footprints with it, and `ecad-viewer.js` never imports
it. Neither are `3d-viewer.js` (the viewer's own 3D tab) and `glyph-full.js` (CJK
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

To move it: take the same three things from a newer Prism commit — the two files
and the manifest's commits — replace both files together, and update this
section and the hashes in one commit.

## Do not put these in `data/`

They are assets, not state. `data/` is covered by a docker volume on prod, which
would hide anything shipped there inside the image.
