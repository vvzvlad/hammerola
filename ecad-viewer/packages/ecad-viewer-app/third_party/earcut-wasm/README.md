# earcut-wasm

`mapbox/earcut.hpp` compiled to WebAssembly, used by the WebGL tesselator to
triangulate filled polygons (board zone fills, above all).

## Why

`../earcut/earcut.js` is `mapbox/earcut` 2.2.4 vendored verbatim -- the only
difference in the whole file is a pair of redundant parentheses Prettier
removed. So this is not a different algorithm, and switching between the JS
package and the vendored copy is worth nothing. What is worth something is
running the same ear-clipping loop over typed memory instead of over a linked
list of JS objects.

On the zone fills of a large board (789 polygons, 702,436 points, Chrome 141,
Apple silicon, median of 5):

| Implementation                      | Triangulate + expand to vertices |
| ----------------------------------- | -------------------------------- |
| `third_party/earcut/earcut.js` (JS) | 1051 ms                          |
| this module (wasm)                  | 715 ms                           |

1.47x, or ~336 ms off a full zone repaint of that board.

Loading the same board cold in the viewer -- parse, paint, upload, everything
-- the isolated saving shows up almost exactly, 5 runs each, medians:

| | document load | time to interactive |
| --- | --- | --- |
| JS | 2944 ms | 2977 ms |
| wasm | 2587 ms | 2622 ms |
| | **-357 ms (12.1%)** | **-355 ms (11.9%)** |

Two things that did _not_ pay, and so are not here:

- **Swapping the vendored JS earcut for the npm package.** Same code; measured
  1.00x in Node and 0.95x in Chrome, i.e. noise in both directions.
- **Batching a whole layer into one wasm call.** 719 ms batched vs 731 ms
  per-call across the same 789 polygons -- within noise, because the crossing
  is a `HEAPF64.set` of a contiguous run either way. The per-call boundary
  keeps `Tesselator.triangulate_polygon` a drop-in shape.

## Output is a different triangulation, not the same one

earcut.hpp and earcut.js emit **different** triangle sets: 785 of those 789
polygons get a different index array. That is expected and harmless -- both
tile the same region, they just clip ears in a different order.

Do not use the index count to check this. Every complete triangulation of a
simple n-gon has exactly n-2 triangles, so the total index count is fixed by
the input (2,102,574 here) no matter which triangulator ran, and matching
counts prove nothing. The property the renderer actually depends on is that
the triangles tile the ring, which is what `test/wasm-triangulation.test.ts`
asserts: total triangle area equals the ring's shoelace area. Measured max
relative deviation across all 789 polygons is 2.7e-13 for both.

## Memory

`INITIAL_MEMORY` is 16 MB with growth enabled. The largest single zone fill on
the board benchmarked above is 65,173 points, which needs about 4.4 MB across
the coordinate arena, the ring, the index list and the expanded vertices -- so
a board of that size triangulates without ever triggering a growth event, and
wasm memory is demand-paged, so the headroom is reserved rather than resident.

## Rebuilding

The built module is committed, so a normal checkout builds and tests without
Emscripten. If you change `earcut_wasm.cpp`, run `./build.sh` (needs `em++`;
built with Emscripten 6.0.8) and commit the regenerated `earcut_wasm.mjs`.

## Provenance

- `earcut.hpp` -- mapbox/earcut.hpp @ `f25bc765e3084583b7350080319c29ad87bf5857`, unmodified.
- `LICENSE` -- ISC, from the same repository.
