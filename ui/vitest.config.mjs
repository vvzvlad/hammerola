// The JS test runner, kept in a file of its own.
//
// Not a `test:` block in vite.config.mjs: that file is the build contract (the
// one output the Makefile, Dockerfile and publish gate copy by name). Vitest
// picks this file up ahead of vite.config.mjs, and `vite build` never reads
// this one. The build's entry is `src/main.jsx` and nothing in `src/` imports
// `tests/`, so the runner stays out of the bundle.
//
// No React plugin, although `tests/interface.test.js` imports the interface:
// vite's esbuild step transforms `.jsx` itself, and the plugin's Fast Refresh
// and babel pass are for a dev server this runner never starts.
//
// Component layout is checked from Python against the source
// (tests/test_ui_source.py).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tests/schematicpins.test.js imports the KiCad viewer's own source from
  // ecad-viewer/, which needs two things its build gives it
  // (ecad-viewer/packages/ecad-viewer-app/scripts/build.js and bundle.js):
  // `kicad-parser` is the parser package's source, and a `.kicad_wks` file is
  // imported as its text.
  resolve: {
    alias: [{
      find: /^kicad-parser$/,
      replacement: fileURLToPath(new URL('../ecad-viewer/packages/kicad-parser/src/index.ts', import.meta.url)),
    }],
  },
  plugins: [{
    name: 'kicad-wks-text',
    enforce: 'pre',
    load(id) {
      if (id.endsWith('.kicad_wks')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
    },
  }],
  test: {
    // jsdom rather than the default `node`: holdkey.js listens on `window` and
    // reads `document.activeElement` and `document.visibilityState`, and the
    // custom element in element.js needs `HTMLElement` to exist at all. The
    // parts of the viewport that need a GPU are deliberately NOT tested here —
    // see tests/README-less note in each file's header.
    environment: 'jsdom',

    // Only this directory, and only files that say `.test.js`. The fixture
    // generator beside them is Python and the fixture itself is data; an
    // include pattern wide enough to pick either up would fail in a way that
    // reads like a broken test rather than a mis-scoped glob.
    include: ['tests/**/*.test.js'],

    // The jsdom worker pool defaults to the CPU count, and every worker holds
    // its own jsdom and the interface modules, so the suite's memory grows with
    // the machine it happens to run on. The CI container is held to 3 GB
    // (`--memory=3g`); on the 72-CPU runner the default pool was killed at that
    // ceiling, at 4 GB and at 6 GB, on the same code that had passed on fewer
    // CPUs. Eight workers is the pool the 3 GB margin was measured with.
    maxWorkers: 8,
  },
})
