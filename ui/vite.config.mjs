// Build configuration for the hub's browser UI.
//
// WHAT THIS BUILD PRODUCES today, from src/main.jsx:
//
//     dist/hammerola.js   -- the whole bundle: the entry, React and ReactDOM
//
// and nothing else. No index.html, because the entry is a module rather than a
// page -- the hub renders templates/build.html itself and only pulls this file
// in with a <script type="module">. No second chunk, because nothing is
// imported dynamically and rollup therefore has nothing to split off. No CSS
// asset, because nothing imports a stylesheet yet.
//
// That list is not a note, it is a contract, because everything downstream
// copies these files BY NAME rather than by directory. A commit that makes this
// build emit a second file -- a dynamic import, an imported stylesheet -- has to
// name it in three more places: `UI_FILES` in the Makefile, a `COPY --from=ui`
// line in the Dockerfile, and a row in `REQUIRED_PATHS` in ci/smoke.py. Miss any
// of them and the file simply never reaches the image, while the gate goes on
// reporting green about a bundle that no longer runs on its own.
//
// The output is copied into static/_v/ -- FLAT, beside viewer.js and the
// vendored three-cad-viewer bundle, not into a subdirectory of its own. That is
// forced by the hub rather than chosen: `_serve_asset()` in src/app.py serves
// `/_v/<one path component>` and `_safe_name()` rejects anything containing a
// slash, which is a path-traversal defence and not an accident. A subdirectory
// would mean loosening it to buy nothing but a tidier layout, so the file lives
// where every other asset already does.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // The hub serves this bundle from /_v/, so any URL vite bakes into the output
  // -- a dynamic import, a font referenced from a stylesheet -- has to resolve
  // there rather than at the site root, where nothing of ours lives.
  base: '/_v/',

  build: {
    outDir: 'dist',

    // Without the wipe, a file a previous build produced and this one no longer
    // does would sit here looking exactly like current output -- and the next
    // reader working out what the build emits would read it off this directory.
    emptyOutDir: true,

    rollupOptions: {
      // Named explicitly because there is no index.html to discover it from:
      // vite's default input for an application build is a HTML page, and this
      // build has none.
      input: 'src/main.jsx',

      // NO CONTENT HASHES IN THE FILE NAMES, deliberately, against vite's
      // default. A hashed name is right when the only thing that ever reads it
      // is a <script> tag the bundler wrote itself. Here the path is written by
      // hand in four places outside this repository's build step --
      // templates/build.html, the Makefile's copy target, the Dockerfile's
      // `COPY --from=ui` and REQUIRED_PATHS in ci/smoke.py -- and a name that
      // changed on every build would have to be rediscovered by all of them.
      // What the hash buys is cache invalidation, and that is the hub's job
      // anyway: it serves static/ and owns the response headers.
      //
      // The shared `hammerola` prefix is legibility, not a mechanism: the
      // output lands flat in static/_v/ among this project's committed assets,
      // and a reader of that directory should be able to tell at a glance which
      // files are built. Nothing depends on it -- the Makefile and the
      // Dockerfile both copy these files BY NAME, one line each, so a file that
      // fell outside the prefix would simply not be copied rather than
      // colliding with anything.
      output: {
        entryFileNames: 'hammerola.js',
        chunkFileNames: 'hammerola-[name].js',
        assetFileNames: 'hammerola.[ext]',
      },
    },
  },
})
