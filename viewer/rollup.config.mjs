// The vendored viewer's build, trimmed to what hammerola ships.
//
// FOUR DELIBERATE DEVIATIONS from upstream's own rollup.config.mjs, all of them
// here so a rebase onto a newer release has one file to read:
//
//   * `external: ["three"]`, plus `output.paths` rewriting that specifier to the
//     URL the hub serves it from — the whole reason this source is vendored.
//     Upstream bakes three into the bundle, which leaves the page with a three
//     instance it cannot name; external, the library and everything we add to
//     its scene share ONE instance, which is what `instanceof` has to hold
//     across. `src/index.ts` re-exports that instance so the page can reach it
//     without importing three itself. The jsm addons the library imports stay
//     inside the bundle and pick up the external three like everything else.
//
//     A URL AND NOT A BARE `three` RESOLVED BY AN IMPORT MAP, which was tried
//     first and does not work here: an import map is an INLINE script, the hub
//     serves every page under `default-src 'self'` (CSP_HTML in src/app.py) with
//     no 'unsafe-inline' in script-src, and the browser drops the map silently —
//     the page then dies on `Failed to resolve module specifier "three"`. Written
//     into the bundle instead, the import is an ordinary same-origin fetch that
//     needs nothing from the page. three.module.js pulls ./three.core.js itself,
//     which is why both names sit flat under /_v/ (`_safe_name` in src/app.py
//     serves exactly one path component);
//   * ONE OUTPUT, the ES module. Upstream also emits UMD and a terser'd pair of
//     both; nothing here serves them, and building them spent the time twice;
//   * no dev-server branch, and no `serve`/`livereload` plugins with it: this
//     config is run by `make viewer` and never by `rollup -w`;
//   * sourcemaps default OFF. Upstream defaults them on and ships the `.map`
//     beside the bundle; we ship neither, so leaving it on wrote a
//     `sourceMappingURL` comment pointing at a file the hub answers 404 for.
import process from "process";
import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import image from "@rollup/plugin-image";
import { string } from "rollup-plugin-string";
import postcss from "rollup-plugin-postcss";
import url from "postcss-url";

const sourcemap = process.env.SOURCEMAP === "true";

export default {
  input: "src/index.ts",
  external: ["three"],
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: true,
      declarationDir: "./dist",
    }),
    postcss({
      plugins: [
        url({
          url: "inline", // inline all files as data URI
          maxSize: 10, // KB limit for inlining files (optional, defaults to 14kb)
          fallback: "copy", // if file too large, falls back to copy
        }),
      ],
      extract: "three-cad-viewer.css",
    }),
    resolve(),
    image(),
    string({ include: "src/ui/index.html" }),
  ],
  output: {
    format: "es",
    file: "dist/three-cad-viewer.esm.js",
    paths: { three: "/_v/three.module.js" },
    sourcemap,
  },
};
