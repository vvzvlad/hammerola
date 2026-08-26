# ui/ — the hub's browser interface

React sources for the page the hub serves at `/<project>/<build>/`. Built with
vite into a single ES module; the hub itself serves the result as a plain static
file and knows nothing about node.

```bash
make ui        # from the repository root: build and copy into static/_v/
```

Nothing here is imported by the Python side, and nothing here runs on the
server. The output is `static/_v/hammerola.js`, loaded by `templates/build.html`
with a `<script type="module" src="/_v/hammerola.js">`.

## Why the output is flat, beside the committed assets

Not `static/_v/ui/`, which would be the tidier layout. The hub serves
`/_v/<one path component>` and nothing deeper — `_serve_asset()` in
`src/app.py` rejects a request with more than one segment, and `_safe_name()`
rejects any name containing a slash. That is a path-traversal defence, built in
layers on purpose, and loosening it to buy a subdirectory would be paying real
attack surface for cosmetics. A nested bundle would build, ship, satisfy the
publish gate and then 404 in the browser.

The consequence is that built files share a directory with committed ones —
`site.css`, `index.js`, `pointer.js`, `pointer_pref.js`,
`three-cad-viewer.esm.js` —
so **everything that copies this build copies it BY NAME**, one file per line:
`UI_FILES` in the `Makefile`, `COPY --from=ui /ui/dist/hammerola.js
static/_v/hammerola.js` in the `Dockerfile`. Never a directory copy. A directory
copy merges, and a merge means a chunk that vite happened to call `index.js`
replaces the hub's own `index.js` — silently, with the publish gate still green,
because the gate asks whether a path exists and after such an overwrite it
still does.

When this build starts emitting a second file, it needs three edits in one
commit: a name in `UI_FILES`, a `COPY` line in the `Dockerfile`, a row in
`REQUIRED_PATHS` in `ci/smoke.py`. Both ways of getting that wrong are caught —
a file listed but no longer produced fails the image build at its `COPY` line,
and a file produced but not listed simply never enters the image, which is what
`REQUIRED_PATHS` is for.

## Two ways this is built

* `make ui` builds it **on a workstation** and copies the named files into
  `static/_v/`, so `make run` serves a UI you can look at.
* `docker build` builds it **in a stage of its own** (`FROM node:22-bookworm-slim
  AS ui`) and copies that stage's output into the image.

The image always wins over a workstation's copy, and two separate things make
that true. `.dockerignore` excludes `static/_v/hammerola*`, so a local build's
output should not reach the build context at all; and `COPY --from=ui …` sits
**after** `COPY static/ static/` in the Dockerfile, so anything that got in
anyway is overwritten by the bundle built from the commit being published. Keep
those two lines in that order.

Neither is redundant. Ordering can only beat a file the stage also emits — it
wins by copying over the same name — so a chunk an older vite config produced
and the current one does not would arrive with nothing to overwrite it, and only
the `.dockerignore` line keeps it out. Conversely, that line is a string anyone
can delete without a single build failing, and the ordering is what still holds
afterwards.

## Exact versions, no ranges

Every dependency is pinned to an exact version — no `^`, no `~`. This is the
same rule the Python side follows with `==` in `requirements.txt`, and it is
here for the same reason: the artefact this repository publishes is an IMAGE,
built at an arbitrary later time from these files, and a range means the image
built from an unchanged commit is not the image that was tested. `^18.3.1` on
react is not a small freedom — it is a standing permission for any later 18.x to
land in production without a commit.

`package-lock.json` is committed and is the other half of that. The pins cover
the four packages named in `package.json`; the lockfile covers everything they
drag in transitively, which is the majority of what actually ends up in the
bundle. `npm ci` installs the lockfile exactly and fails if `package.json`
disagrees with it, whereas `npm install` would quietly resolve and rewrite. The
Dockerfile stage runs `npm ci` unconditionally; `make ui` runs it only when the
lockfile is actually there and falls back to `npm install` when it is not — a
deliberate fallback, with its reasoning written above that rule in the
`Makefile`.

So deleting the lockfile breaks the two halves DIFFERENTLY, and only one of them
says so. On a workstation the fallback takes over silently: `npm install`
resolves whatever npm feels like today, `make ui` succeeds, and the bundle you
are looking at is simply no longer the bundle anyone else gets. The image never
reaches that question — the stage copies `ui/package-lock.json` by name, so
`docker build` fails at that `COPY` line (`failed to compute cache key … not
found` under BuildKit) before `npm ci` runs at all. That asymmetry is an
argument FOR committing the lockfile, not a reason to relax about losing it: the
half that keeps going without complaint is the half you are looking at, and the
half that stops is the one that produces what ships.

## React 18, not 19

18.3.1 is the version the mock-up being ported here was WRITTEN against and
looked at in a browser, so it is the version this pipeline is stood up on. That
is the whole reason, and it is a deliberately narrow one: the port is where the
mock-up first gets exercised for real, and pinning to the line it is known to
have run on keeps a version difference out of the list of things that could be
wrong at that moment.

Moving to 19 is a decision with its own verification, not a side effect of the
pin chosen today — and it is deferred rather than ruled out. Nothing in the
mock-up is known to block it: it is a CLASS component, and React 19's removal of
`defaultProps` applies to FUNCTION components only, so its `static defaultProps`
is unaffected; it uses no string refs, no legacy `contextTypes` and no
`findDOMNode`, and mounting here already goes through `createRoot`. So the
upgrade looks cheap — which is an argument for making it a separate, checked
change once the real component is on screen, not for folding it into this one.

## Output file names carry no hash

`hammerola.js`, not `hammerola-a1b2c3d4.js`. The reasoning is in
`vite.config.mjs` beside the setting; the short version is that this name is
written by hand in four other files (the page template, the Makefile, the
Dockerfile and the publish gate), a hashed name would have to be rediscovered by
all of them on every build, and cache invalidation is the hub's job because the
hub is what serves the file and sets the headers.

`tests/test_ui_bundle.py` is what keeps those copies of the path in step — it
reads them out of the files and fails when one of them drifts, because the
symptom otherwise is a green gate and a 404 in the browser.

## The placeholder

`src/HammerolaViewer.jsx` is a stub that renders one line and the React version.
It is not the interface — it is what makes the pipeline observable end to end,
and the port of the designer's mock-up replaces it wholesale.

It renders `hidden`, so look for it in DevTools
(`document.querySelector('.hmr_stub')`) rather than on the page. The stub
outlives the commit that adds it while a merge to main publishes `:latest` and
the auto-update label deploys it unattended, so a visible debug line would reach
every build page in production without anybody choosing to put it there.
