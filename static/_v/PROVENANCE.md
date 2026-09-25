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

Four files, all of them but `package.json` carrying the reason in a comment of
their own:

* `viewer/src/index.ts` re-exports three's namespace, so the page can name the
  very classes the library renders with;
* `viewer/src/core/viewer.ts` gains an `onBeforeRender` hook — the twin of the
  library's own `onAfterRender`, called at the top of `update()` — because this
  viewer renders ON DEMAND and a widget of ours standing in its scene has to be
  placed by the very frame that draws it (`ui/src/viewport/scene3d.js`). The
  field's declaration and the call site each carry the reason;
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

## Do not put these in `data/`

They are assets, not state. `data/` is covered by a docker volume on prod, which
would hide anything shipped there inside the image.
