// ui/src/viewport/hatch.js — the diagonal hatch on a cut face.
//
// WHAT A RUNNER CAN AND CANNOT ANSWER HERE. There is no GPU and no library, so
// nothing below looks at a pixel: whether the lines are the right weight, and
// whether they read as a section, were settled in a browser and are not
// assertable here. What IS assertable is every way this can stop happening
// SILENTLY, which is the whole risk of the technique — the page renders
// perfectly with a plain fill and nothing anywhere says the hatch went away:
//
//   * the shader chunk it splices at disappearing from the vendored three.js;
//   * the splice landing in the wrong place, i.e. after the colour space
//     conversion instead of before it;
//   * the cap materials moving, so nothing gets patched at all;
//   * the patch becoming per-material, which would silently share one compiled
//     program between caps that wanted different ones.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { hatchMarker, hatchSectionCaps, hatchShader, safeHatch }
  from '../src/viewport/hatch.js'

/** A cap material as the library builds one: a `MeshStandardMaterial` with
 *  three.js's default no-op `onBeforeCompile`. */
const fakeMaterial = () => ({
  defines: { STANDARD: '' },
  needsUpdate: false,
  onBeforeCompile: function noop() {},
})

/** `internals()`'s answer, with the cap meshes the library hangs off
 *  `Clipping._planeMeshGroup` — one per (plane, solid), plane-major. */
const fakeInternals = (count = 6) => ({
  clipping: {
    _planeMeshGroup: {
      children: Array.from({ length: count }, () => ({ material: fakeMaterial() })),
    },
  },
})

const capsOf = (g) => g.clipping._planeMeshGroup.children.map((c) => c.material)

/** A file of this repository, read from `process.cwd()`.
 *
 * From the cwd and not from `import.meta.url`: under jsdom the module URL is an
 * http one and `fileURLToPath` refuses it. Vitest runs with the cwd at its
 * config root, which is `ui/`.
 *
 * The one path below that leaves `ui/` is the vendored bundle, and it is the
 * reason the JS step of both workflows names `static/_v/three-cad-viewer.esm.js`
 * beside `./ui` in its tar. If this ever throws ENOENT in CI, that is the line
 * to look at — not this one.
 */
const repoFile = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')

const BUNDLE = '../static/_v/three-cad-viewer.esm.js'

/** How three.js's `meshphysical_frag` opens, as the BUNDLE spells it: the quote
 *  that begins its literal, then the shader's first two lines with the newline
 *  between them still escaped. No other chunk starts this way. */
const PHYSICAL_OPENS = '"#define STANDARD\\n#ifdef PHYSICAL'

/** `meshphysical_frag` alone, cut out of the vendored bundle.
 *
 * WHY THE SHADER AND NOT THE FILE. Rollup leaves three.js's shader chunks as
 * ordinary double-quoted JS string literals with their newlines escaped, under
 * names it has mangled to nothing (`const fragment$5 = "#define STANDARD…"`),
 * and the bundle carries NINE copies of `#include <opaque_fragment>` — one per
 * material that ends the same way — beside ten of `uniform vec3 diffuse;`. A
 * search over the whole file therefore passes on any of the other eight, which
 * is a guard that cannot fail: the chunk could be renamed in the shader this
 * patches, and only there, while eight strangers kept the test green. Measured
 * that way rather than argued: with the marker taken out of this literal alone,
 * a file-wide `toContain` still passes. So the literal is found by its own
 * opening and read to its closing quote, and everything below is asked of THAT.
 *
 * Nothing is unescaped on the way out: every probe below sits within one line of
 * the shader, so the escaped newlines can stay exactly as the bundle wrote them.
 */
function meshphysicalFragment(source) {
  expect(source.split(PHYSICAL_OPENS)).toHaveLength(2)   // exactly one shader opens this way
  const literal = /"(?:[^"\\]|\\.)*"/y
  literal.lastIndex = source.indexOf(PHYSICAL_OPENS)
  const found = literal.exec(source)
  expect(found).not.toBeNull()
  return found[0]
}

describe('hatchSectionCaps', () => {
  it('patches every cap the library built', () => {
    const g = fakeInternals()
    expect(hatchSectionCaps(g)).toBe(6)
    for (const m of capsOf(g)) {
      expect(m.onBeforeCompile).toBe(hatchShader)
      expect(m.needsUpdate).toBe(true)
      // `vUv` exists only for materials that asked for it since three r152, and
      // a cap has no map of any kind to ask on its behalf.
      expect(m.defines.USE_UV).toBe('')
      expect(m.defines.STANDARD).toBe('')     // and nothing it had is lost
    }
  })

  it('gives every cap THE SAME patch, which is what keeps it to one program', () => {
    // three.js's default `customProgramCacheKey` is `onBeforeCompile.toString()`,
    // so one function object across the caps means one compiled program. The day
    // a hatch parameter becomes per-material it has to move out of the shared
    // function or be declared in a cache key of its own — a `toString()` cannot
    // see a closure, and every cap would silently take whichever program was
    // compiled first.
    const g = fakeInternals()
    hatchSectionCaps(g)
    const patches = new Set(capsOf(g).map((m) => m.onBeforeCompile))
    expect(patches.size).toBe(1)
    // ...while the MATERIALS stay distinct, and this line really does check
    // that: `capsOf` reads `cap.material` back AFTER the call, so a module that
    // collapsed the caps onto one shared material would be caught here whatever
    // syntax it assigned with. It matters because the library orders its draws
    // by `material.id` to keep a solid's stencil pass next to its own cap; one
    // material across two caps reorders the draws and breaks the stencil
    // isolation the caps depend on.
    expect(new Set(capsOf(g)).size).toBe(6)
  })

  it('does nothing the second time, so a re-render does not recompile', () => {
    const g = fakeInternals(2)
    hatchSectionCaps(g)
    for (const m of capsOf(g)) m.needsUpdate = false
    expect(hatchSectionCaps(g)).toBe(2)
    for (const m of capsOf(g)) expect(m.needsUpdate).toBe(false)
  })

  it('says so when the cap materials are not where it expects them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = fakeInternals(4)
    g.clipping._planeMeshGroup.children[1].material = { onBeforeCompile: null }
    g.clipping._planeMeshGroup.children[2].material = null
    expect(hatchSectionCaps(g)).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)      // once per render, not per cap
    warn.mockRestore()
  })

  it('is quiet about a scene with no caps in it, which is a scene with no solids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hatchSectionCaps(fakeInternals(0))).toBe(0)
    expect(hatchSectionCaps({ clipping: {} })).toBe(0)
    expect(hatchSectionCaps(null)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('safeHatch', () => {
  /** Internals whose cap material cannot be READ without throwing.
   *
   *  "Asks defensively" is not "cannot throw": every reach in here is a property
   *  access on an object this module does not own, and a getter — or a proxy, or
   *  a revoked reference — throws where a plain read returns undefined. A getter
   *  is simply the cheapest way to produce that from a test. */
  const hostile = () => {
    const g = fakeInternals(1)
    Object.defineProperty(g.clipping._planeMeshGroup.children[0], 'material', {
      get() { throw new TypeError('the library moved it') },
    })
    return g
  }

  it('swallows a throw the patching could not have foreseen, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // THE PREMISE FIRST, so this cannot pass by finding nothing to catch: the
    // unguarded call really does throw on this scene. Without it, an
    // `hatchSectionCaps` that had quietly become total would leave the
    // assertions below green while testing nothing at all.
    expect(() => hatchSectionCaps(hostile())).toThrow(TypeError)
    // ...and the entry point the viewport uses does not, which is the promise
    // the header makes. Nothing above `show()`'s catch ever sees it.
    expect(safeHatch(hostile())).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('is `hatchSectionCaps` on every scene that does not throw', () => {
    // The guard must not become a second implementation: what it returns on the
    // ordinary path is the count of caps patched, unchanged, and the caps are
    // really patched — a wrapper that swallowed the work as well as the throw
    // would satisfy the test above and nothing else.
    const g = fakeInternals(3)
    expect(safeHatch(g)).toBe(3)
    for (const m of capsOf(g)) expect(m.onBeforeCompile).toBe(hatchShader)
    expect(safeHatch(null)).toBe(0)
  })
})

describe('hatchShader', () => {
  // The tail of `meshphysical_frag`, in the order three.js writes it. Only the
  // ordering matters to the assertions below.
  const TAIL = [
    '#include <opaque_fragment>',
    '#include <tonemapping_fragment>',
    '#include <colorspace_fragment>',
    '#include <fog_fragment>',
    '#include <dithering_fragment>',
  ].join('\n')

  it('writes the cut face BEFORE the colour is converted for the screen', () => {
    // The hatch mixes two colours that came out of the `diffuse` uniform, which
    // is in the working (linear) space. Splicing it after `colorspace_fragment`
    // would mix linear numbers into a converted result: a hatch that is the
    // wrong shade everywhere, and wrong in a way that looks like a taste
    // decision rather than a bug.
    const shader = { fragmentShader: TAIL }
    hatchShader(shader)
    const at = shader.fragmentShader.indexOf('hatchCov')
    expect(at).toBeGreaterThan(shader.fragmentShader.indexOf(hatchMarker))
    expect(at).toBeLessThan(shader.fragmentShader.indexOf('tonemapping_fragment'))
  })

  it('leaves a shader it does not recognise exactly as it was', () => {
    const shader = { fragmentShader: 'void main() {}' }
    hatchShader(shader)
    expect(shader.fragmentShader).toBe('void main() {}')
  })

  it('splices at a chunk the VENDORED three.js still has', () => {
    // THE UPGRADE GUARD, and the reason this test reads a 3.4 MB file. This is
    // string surgery on three.js's shader chunks, so it is pinned to the THREE
    // inside static/_v/three-cad-viewer.esm.js (r184 as this was written) rather
    // than to a release of the viewer. A rename there costs the page its hatch
    // and NOTHING ELSE: no error, no warning, a section that is simply a flat
    // fill again. This is the only place that can notice.
    //
    // `meshphysical_frag` and not the file: the bundle carries nine copies of
    // this chunk name and only ONE of them is in the shader a
    // `MeshStandardMaterial` compiles, which is what the library's cap is. See
    // `meshphysicalFragment` for what that costs and why the file-wide search it
    // replaced could not fail.
    const shader = meshphysicalFragment(repoFile(BUNDLE))
    const at = shader.indexOf(hatchMarker)
    expect(at).toBeGreaterThan(-1)
    // The two names the spliced code reads, which have to be declared ahead of
    // it in this shader for it to compile at all: `diffuse` is the cap's own
    // colour (the library sets it per solid — `clipObjectColors`, options.js)
    // and `diffuseColor.a` the alpha the hatch writes back out.
    expect(shader.indexOf('uniform vec3 diffuse;')).toBeGreaterThan(-1)
    expect(shader.indexOf('uniform vec3 diffuse;')).toBeLessThan(at)
    expect(shader.indexOf('vec4 diffuseColor = vec4( diffuse, opacity );'))
      .toBeGreaterThan(-1)
    expect(shader.indexOf('vec4 diffuseColor = vec4( diffuse, opacity );'))
      .toBeLessThan(at)
    // ...and the splice lands before the colour is converted for the screen.
    // The first test in this block asserts that about the PATCH, against a stub
    // tail written here; this asserts it about the shader the patch will really
    // be applied to, where the order is three.js's to change.
    expect(at).toBeLessThan(shader.indexOf('#include <colorspace_fragment>'))
  })
})
