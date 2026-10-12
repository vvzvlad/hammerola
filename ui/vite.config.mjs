// Build configuration for the hub's browser UI.
//
// This build produces, from src/main.jsx:
//
//     dist/hammerola.js   -- the whole bundle: the entry, React and ReactDOM
//
// and nothing else. No index.html (the hub renders templates/build.html and
// loads this file with a <script type="module">), no second chunk (nothing is
// imported dynamically), no CSS asset (nothing imports a stylesheet).
//
// That list is a contract: everything downstream copies these files by name. A
// second output file has to be named in `UI_FILES` in the Makefile, a
// `COPY --from=ui` line in the Dockerfile, and `REQUIRED_PATHS` in ci/smoke.py,
// or it never reaches the image while the gate stays green.
//
// The output is copied flat into static/_v/, beside the committed page scripts
// and the vendored three-cad-viewer bundle: `_serve_asset()` in src/app.py
// serves `/_v/<one path component>` and `_safe_name()` rejects any slash, as a
// path-traversal defence.
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

    // Without the wipe, a file this build no longer produces would sit here
    // looking like current output.
    emptyOutDir: true,

    rollupOptions: {
      // Named explicitly because there is no index.html to discover it from:
      // vite's default input for an application build is a HTML page, and this
      // build has none.
      input: 'src/main.jsx',

      // No content hashes in the file names, against vite's default: the path is
      // written by hand outside the build step (templates/build.html, the
      // Makefile's copy target, the Dockerfile's `COPY --from=ui` and
      // REQUIRED_PATHS in ci/smoke.py). Cache invalidation is the hub's job: it
      // serves static/ and owns the response headers.
      //
      // The `hammerola` prefix only marks built files among the committed assets
      // in static/_v/; nothing depends on it, since the Makefile and Dockerfile
      // copy by name.
      output: {
        entryFileNames: 'hammerola.js',
        chunkFileNames: 'hammerola-[name].js',
        assetFileNames: 'hammerola.[ext]',
      },
    },
  },
})
