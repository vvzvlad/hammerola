// Polygon triangulation for the WebGL tesselator, compiled from
// mapbox/earcut.hpp.
//
// The JS earcut this replaces is the same algorithm -- the fork's
// third_party/earcut/earcut.js is mapbox/earcut 2.2.4 verbatim -- so the win
// here is purely that the C++ port runs the ear-clipping inner loop on typed
// memory instead of on a linked list of JS objects. Measured ~1.5x on the
// zone fills of a large board; see third_party/earcut-wasm/README.md.
//
// The boundary is deliberately one call per polygon. A batched entry point
// that triangulated a whole layer in one crossing measured within noise of
// this one (719 ms vs 731 ms on 789 polygons), so it bought nothing and would
// have forced PolygonSet to restructure around it.

#include <cstdint>
#include <vector>

#include <emscripten/emscripten.h>

#include "earcut.hpp"

namespace {

struct Pt {
    double x, y;
};

// Reused across calls so a repaint does not re-grow the arenas.
std::vector<double> g_coords;
std::vector<float> g_verts;

}  // namespace

namespace mapbox {
namespace util {
template <>
struct nth<0, Pt> {
    static double get(const Pt& p) { return p.x; }
};
template <>
struct nth<1, Pt> {
    static double get(const Pt& p) { return p.y; }
};
}  // namespace util
}  // namespace mapbox

extern "C" {

// Hand back the coordinate arena, grown to hold `n_doubles`. The caller writes
// interleaved xy into it before calling ec_run_one_f32.
EMSCRIPTEN_KEEPALIVE double* ec_coords(uint32_t n_doubles) {
    g_coords.resize(n_doubles);
    return g_coords.data();
}

// Triangulate the polygon currently in the arena and expand the resulting
// indices into interleaved float32 vertex positions -- the exact shape
// PolygonSet uploads. Expanding here rather than in JS keeps a 2M-iteration
// loop and its intermediate index array out of the main thread.
//
// Returns the vertex count (indices emitted); the positions are 2x that many
// floats at ec_verts().
EMSCRIPTEN_KEEPALIVE uint32_t ec_run_one_f32(uint32_t n_coords) {
    const uint32_t n_points = n_coords / 2;

    // Single outer ring: zone fills arrive already flattened with no holes,
    // matching the hole-less `earcut(points_flattened)` call this replaces.
    std::vector<std::vector<Pt>> polygon(1);
    auto& ring = polygon[0];
    ring.reserve(n_points);
    for (uint32_t i = 0; i < n_points; ++i) {
        ring.push_back({g_coords[i * 2], g_coords[i * 2 + 1]});
    }

    const std::vector<uint32_t> tri = mapbox::earcut<uint32_t>(polygon);

    g_verts.resize(tri.size() * 2);
    for (size_t i = 0; i < tri.size(); ++i) {
        const uint32_t idx = tri[i];
        g_verts[i * 2] = static_cast<float>(g_coords[idx * 2]);
        g_verts[i * 2 + 1] = static_cast<float>(g_coords[idx * 2 + 1]);
    }

    return static_cast<uint32_t>(tri.size());
}

EMSCRIPTEN_KEEPALIVE float* ec_verts() { return g_verts.data(); }

}  // extern "C"
