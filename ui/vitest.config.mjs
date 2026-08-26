// The JS test runner, kept in a file of its own.
//
// NOT a `test:` block inside vite.config.mjs, deliberately. That file is the
// BUILD contract — it names the one output the Makefile, the Dockerfile and the
// publish gate each copy by name — and a test setting living inside it is a
// test setting that gets read as part of the contract. Vitest picks this file up
// ahead of vite.config.mjs, so the build config is neither read nor amended by a
// test run, and `vite build` never reads this one.
//
// That separation is also what keeps the runner out of the bundle: the build's
// entry is `src/main.jsx` and rollup only ever reaches what that imports, while
// everything here lives under `tests/`, which nothing in `src/` imports. The
// tests reach INTO src, never the other way round.
//
// NO REACT PLUGIN, because nothing under test is JSX: `ui/src/viewport/**` and
// `ui/src/store.js` are plain ES modules, and the interface's own COMPONENTS are
// checked from Python, against their source. Adding the plugin here would buy a
// transform nothing needs and a second place for the build's plugin list to
// disagree with itself.
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
  },
})
