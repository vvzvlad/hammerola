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
//   * the uniform declarations losing their anchor, which is a shader that no
//     longer compiles;
//   * the cap units moving, so nothing gets patched at all;
//   * the patch becoming per-material, which would silently share one compiled
//     program between caps that wanted different ones;
//   * the per-part fields collapsing — every part onto one slope, the angle
//     drifting between revisions — none of which draws a word from any console;
//   * the pitch starting to follow the part's SIZE again, which is a decision
//     the owner has already reversed once and which no console would mention;
//   * the period drifting back into SCREEN pixels — the pattern painted on the
//     glass rather than on the part, so it slides across the cut face as the
//     model turns while every still frame looks perfect;
//   * the levels ceasing to NEST — the phase read as a fraction of the period
//     again, or the line centres moved off the integers — which puts that same
//     slide back one half-period at a time, at every boundary an ordinary
//     rotation crosses;
//   * the ink losing the conversion that keeps it in framebuffer pixels at
//     whatever level, which doubles or halves the hairline at a level boundary;
//   * the pitch losing the display's density (issue #96) — eight FRAMEBUFFER
//     pixels is four CSS ones on a retina screen, and lines four CSS pixels
//     apart read as scanner grain rather than as a hatch — or the LINE picking
//     that density up along with the pitch, which widens the hairline into a
//     band and is exactly as quiet;
//   * the checkbox unwiring itself, so toggling `cutHatch` stops reaching the
//     caps at all.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HATCH_AA_PX, HATCH_LINE_PX, HATCH_PITCH_PX, HATCH_SLOPES, hatchMarker,
  hatchSectionCaps, hatchShader, safeHatch, setCutHatch,
} from '../src/viewport/hatch.js'
import { fakeCapMaterial, fakeCapUnits, fakeMatrix, fakeSolidObject } from './fakes.js'

/** `internals()`'s answer for a scene with one solid per NAME: three caps per
 *  solid, one per clip plane, as `Clipping._createStencils` builds them. The
 *  solids all start as the same 10 mm cube at the origin; a test after a
 *  different part reshapes them with `min`/`max`/`matrix`, or trims the plane
 *  list with `planes`. */
const fakeInternals = (names, { size = 36, planes, ...box } = {}) => ({
  clipping: {
    _capUnits: fakeCapUnits(
      names.map((name) => fakeSolidObject(name, box)),
      { size, planes },
    ),
  },
})

const unitsOf = (g) => g.clipping._capUnits

const capsOf = (g) => unitsOf(g).flatMap((u) => u.capMeshes.map((c) => c.material))

/** The slope a cap was hatched at, in degrees, read back out of the direction
 *  uniform — the +90 of the module's dot direction undone. Rounded: a slope
 *  that survives degrees → radians → degrees with anything left over was never
 *  one of the set's. */
const slopeOf = (hatch) =>
  Math.round((Math.atan2(hatch.dirY, hatch.dirX) * 180 / Math.PI - 90 + 540) % 180)

/** Compile one patched material the way three.js would call the patch: with
 *  the material as `this` and a fresh parameters object. Returns the shader so
 *  a test can reach the live uniforms.
 *
 *  BOTH SPLICE POINTS are in the stub source — the uniform anchor and the
 *  marker — so what comes back carries the hatch's GLSL as well as its uniform
 *  values. The pitch tests need the two together: the target spacing is a
 *  uniform and the width a literal in the source, and only reading them side by
 *  side says what either measures. */
const compile = (material) => {
  const shader = {
    uniforms: {},
    fragmentShader: `uniform vec3 diffuse;\n${hatchMarker}\n`,
  }
  hatchShader.call(material, shader)
  return shader
}

// The display's density is a GLOBAL the module reads at patch time, and the
// pitch tests below stub it. Restored for everyone: a leaked 3x would move the
// period under every test in this file that compiles anything.
afterEach(() => { vi.unstubAllGlobals() })

/** A file of this repository, read from `process.cwd()` and MEMOISED.
 *
 * From the cwd and not from `import.meta.url`: under jsdom the module URL is an
 * http one and `fileURLToPath` refuses it. Vitest runs with the cwd at its
 * config root, which is `ui/`.
 *
 * Memoised because the path below leaves `ui/` for a vendored file of three's
 * that is most of a megabyte; read once per run rather than once per assertion.
 * That path is also the reason the JS step of both workflows names the vendored
 * `static/_v/` files beside `./ui` in its tar. If this ever throws ENOENT in CI,
 * that is the line to look at — not this one.
 */
const sources = new Map()
const repoFile = (path) => {
  if (!sources.has(path)) {
    sources.set(path, readFileSync(resolve(process.cwd(), path), 'utf8'))
  }
  return sources.get(path)
}

/** three.js's own source, which is NO LONGER inside the viewer bundle: the fork
 *  in `viewer/` builds with `external: three`, so the library and the page share
 *  one instance loaded from here. `three.module.js` is the half that carries the
 *  renderer and the shader chunks — `meshphysical_frag` among them — and it
 *  imports `three.core.js` for the math and the scene graph. The bundle keeps
 *  only the library's own code and the `three/examples/jsm` addons it uses. */
const THREE_MODULE = '../static/_v/three.module.js'

/** How three.js's `meshphysical_frag` opens, as three.module.js spells it: the
 *  quote that begins its literal, then the shader's first two lines with the
 *  newline between them still escaped. No other chunk starts this way. */
const PHYSICAL_OPENS = '"#define STANDARD\\n#ifdef PHYSICAL'

/** `meshphysical_frag` alone, cut out of the vendored three.module.js.
 *
 * WHY THE SHADER AND NOT THE FILE. three's own build leaves its shader chunks as
 * ordinary double-quoted JS string literals with their newlines escaped, under
 * names it has mangled to nothing (`const fragment$5 = "#define STANDARD…"`),
 * and the file carries NINE copies of `#include <opaque_fragment>` — one per
 * material that ends the same way — beside nine of `uniform vec3 diffuse;`. A
 * search over the whole file therefore passes on any of the other eight, which
 * is a guard that cannot fail: the chunk could be renamed in the shader this
 * patches, and only there, while eight strangers kept the test green. Measured
 * that way rather than argued: with the marker taken out of this literal alone,
 * a file-wide `toContain` still passes. So the literal is found by its own
 * opening and read to its closing quote, and everything below is asked of THAT.
 *
 * Nothing is unescaped on the way out: every probe below sits within one line of
 * the shader, so the escaped newlines can stay exactly as three wrote them.
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
    const g = fakeInternals(['|model|lid', '|model|body'])
    expect(hatchSectionCaps(g)).toBe(6)
    for (const m of capsOf(g)) {
      expect(m.onBeforeCompile).toBe(hatchShader)
      expect(m.needsUpdate).toBe(true)
      // `vUv` exists only for materials that asked for it since three r152, and
      // a cap has no map of any kind to ask on its behalf.
      expect(m.defines.USE_UV).toBe('')
      expect(m.defines.STANDARD).toBe('')     // and nothing it had is lost
      // The part's numbers ride on the MATERIAL, from where the patch reads
      // them at compile time.
      for (const field of ['dirX', 'dirY', 'phase', 'on']) {
        expect(typeof m.userData.hatch[field]).toBe('number')
      }
    }
  })

  it('gives every cap THE SAME patch, which is what keeps it to one program', () => {
    // three.js's default `customProgramCacheKey` is `onBeforeCompile.toString()`,
    // so one function object across the caps means one compiled program. The
    // per-part numbers therefore may NOT live in the function — a `toString()`
    // cannot see a closure, and every cap would silently take whichever
    // program was compiled first — they travel as uniform VALUES read off
    // `this.userData`. The assertion below holds the function to that: a per-part
    // number leaking into its source would carry the tree path's own delimiter.
    const g = fakeInternals(['|model|lid', '|model|body'])
    hatchSectionCaps(g)
    expect(hatchShader.toString()).not.toContain('|')
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
    const g = fakeInternals(['|model|lid', '|model|body'])
    hatchSectionCaps(g)
    for (const m of capsOf(g)) m.needsUpdate = false
    expect(hatchSectionCaps(g)).toBe(6)
    for (const m of capsOf(g)) expect(m.needsUpdate).toBe(false)
  })

  it('says so when the cap units are not where it expects them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = fakeInternals(['|model|lid', '|model|body', '|model|pin'])
    const units = unitsOf(g)
    units[0] = null                                  // a unit that never got filled
    units[1].solid.name = null                       // a solid with no path to hash
    units[2].capMeshes[1].material = null            // a cap with nothing to patch
    expect(hatchSectionCaps(g)).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)      // once per render, not per cap
    warn.mockRestore()
  })

  it('is quiet about a scene with no caps in it, which is a scene with no solids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(hatchSectionCaps(fakeInternals([]))).toBe(0)
    expect(hatchSectionCaps({ clipping: {} })).toBe(0)
    expect(hatchSectionCaps(null)).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('one field per part', () => {
  it('hatches every cap of ONE solid out of the same angle and phase', () => {
    // The field belongs to the PART: its three caps — one per clip plane — are
    // three windows onto one hatch, and reading them back apart would put a
    // seam through a single body.
    const g = fakeInternals(['|model|lid'])
    hatchSectionCaps(g)
    const fields = capsOf(g).map((m) => m.userData.hatch)
    for (const field of fields) {
      expect(slopeOf(field)).toBe(slopeOf(fields[0]))
      expect(field.phase).toBe(fields[0].phase)
    }
  })

  it('puts two neighbouring parts on different slopes', () => {
    // The drawing convention the owner asked for, on the names a real model's
    // tree produces. It is a property of THESE two keys under the module's one
    // hash — determinism is the decision, and a guarantee over every possible
    // pair is not reachable with one — so this pins the example rather than
    // proving a theorem.
    const g = fakeInternals(['|model|lid', '|model|body'])
    hatchSectionCaps(g)
    // One cap per UNIT — `capsOf` flattens, and its first two entries would be
    // two planes of the same solid, which share their slope by design.
    const [lid, body] = unitsOf(g).map((u) => u.capMeshes[0].material.userData.hatch)
    expect(slopeOf(lid)).not.toBe(slopeOf(body))
  })

  it('draws every angle from the one fixed set, 45 degrees included', () => {
    // The set is the readability guarantee: whatever the hash picks, no two
    // choices can sit closer to each other than the set's own gap.
    const names = ['|model|lid', '|model|body', '|model|wall', '|model|board',
                   '|model|base', '|model|post', '|model|pin', '|model|plate']
    const g = fakeInternals(names)
    hatchSectionCaps(g)
    const slopes = capsOf(g)
      .filter((m) => m.userData.hatch)
      .map((m) => slopeOf(m.userData.hatch))
    expect(slopes.length).toBeGreaterThan(0)
    for (const s of slopes) expect(HATCH_SLOPES).toContain(s)
    expect(HATCH_SLOPES).toContain(45)
    // ...and no two members of the set are within a readable distance of each
    // other. Slopes live on a half turn: 175 and 5 are 10 degrees apart as
    // numbers and 10 degrees apart on the paper too.
    for (let i = 0; i < HATCH_SLOPES.length; i++) {
      for (let j = i + 1; j < HATCH_SLOPES.length; j++) {
        expect(Math.abs(HATCH_SLOPES[i] - HATCH_SLOPES[j])).toBeGreaterThanOrEqual(30)
      }
    }
  })

  it('gives the same part the same angle twice, revisions included', () => {
    // THE stability the owner bought with a hash: nothing about the answer
    // depends on which other parts exist, where the part sits, or when the
    // question is asked — which is what lets two revisions of one model be
    // compared by eye.
    const first = fakeInternals(['|model|lid'])
    const second = fakeInternals(['|model|lid'])
    hatchSectionCaps(first)
    hatchSectionCaps(second)
    const a = capsOf(first)[0].userData.hatch
    const b = capsOf(second)[0].userData.hatch
    expect(b.dirX).toBe(a.dirX)
    expect(b.dirY).toBe(a.dirY)
    expect(b.phase).toBe(a.phase)
  })
})

describe('one pitch for every cut face, anchored to the part', () => {
  /** What `hatchSectionCaps` stored on the first cap of a one-solid scene built
   *  the given way. Same part name throughout, so angle and phase are fixed and
   *  anything that moves moved because of the geometry. */
  const paramsOf = (options) => {
    const g = fakeInternals(['|model|lid'], options)
    hatchSectionCaps(g)
    return capsOf(g)[0].userData.hatch
  }

  it('stores the same numbers whatever the part and the region measure', () => {
    // The owner's decision, and the reverse of the one it replaced: one step
    // everywhere, like Fusion's. Every variant below moved the pitch that
    // followed the part — a part twenty times the size, the same part placed at
    // twice its own scale, a clipping region ten times as wide — and not one of
    // them may move anything now.
    const plain = paramsOf({})
    for (const variant of [{ max: [200, 200, 200] },
                           { matrix: fakeMatrix({ scale: [2, 2, 2] }) },
                           { size: 400 }]) {
      expect(paramsOf(variant)).toEqual(plain)
    }
  })

  it('keeps no size-derived field for a pitch to come back in', () => {
    // Stronger than the equality above, and the reason it is a second line: a
    // per-part pitch that happened to agree across those three scenes would
    // pass there. What a cap carries is the part's direction, its phase and the
    // checkbox — there is no fourth field.
    expect(Object.keys(paramsOf({})).sort())
      .toEqual(['dirX', 'dirY', 'on', 'phase'])
  })

  it('counts the period in the PLANE OF THE CUT, in power-of-two levels', () => {
    // Where the pitch went instead: into the GLSL, which no runner here can
    // execute. What IS assertable is the frame the period is counted in, and
    // that is the whole of the defect this replaced. `hatchUv` is a distance in
    // the cap quad's uv, which is the section plane in world proportions, so
    // dividing it by a length in THOSE units anchors the stripes to the part.
    // Dividing it by its own screen gradient instead — a period of so many
    // FRAMEBUFFER pixels, which is what this used to do — paints the pattern on
    // the glass: the foreshortening changes as the model turns, the same point
    // of the part lands in a different stripe, and the field creeps. Every
    // still frame of that looks perfect, which is why it is asserted here.
    //
    // THE LENGTH AND NOT `fwidth`, which is why the last assertion is here: the
    // two read alike and only one of them is a gradient. `fwidth` is
    // `abs(dFdx) + abs(dFdy)`, which runs up to 1.41 times the gradient
    // depending on how the stripes happen to lie on the screen — a level
    // threshold that depends on the angle, and a face near a boundary flipping
    // levels as the model turns, which is the creep back again.
    const shader = { fragmentShader: hatchMarker }
    hatchShader(shader)
    const source = shader.fragmentShader
    // uv per framebuffer pixel across the stripes, floored against a zero
    // gradient. The floor used to protect one direct division; it now also
    // stands between `log2(0)`, which is minus infinity, and `hatchStep`, which
    // would come out zero and take every distance below down with it.
    expect(source)
      .toMatch(/float hatchGrad = max\(\s*length\(\s*vec2\(\s*dFdx\(\s*hatchUv\s*\)\s*,\s*dFdy\(\s*hatchUv\s*\)\s*\)\s*\)\s*,\s*1e-8\s*\)/)
    // THE LADDER: the smallest power of two at least the target spacing
    // expressed in uv. `ceil` so the spacing on screen lands between one and
    // two times the target and the lines can never be about to merge; a power
    // of two so the step is exactly representable and the levels can nest.
    expect(source)
      .toMatch(/float hatchStep = exp2\(\s*ceil\(\s*log2\(\s*hatchPitch \* hatchGrad\s*\)\s*\)\s*\)/)
    // ...and the period `hatchS` counts is that level, in uv — not a pixel
    // count. `hatchPx`, the screen-pixel coordinate the creep came out of, is
    // gone rather than merely unused.
    expect(source).toMatch(/float hatchS = \(hatchUv \+ hatchPhase\) \/ hatchStep;/)
    expect(source).not.toMatch(/hatchPx/)
    expect(source).not.toMatch(/fwidth/)
  })

  it('NESTS the levels, so a crossing adds or removes lines and moves none', () => {
    // THE PAIR OF LINES IS THE WHOLE MECHANISM, which is why both are pinned
    // here and why they may only move together.
    //
    // `hatchS = (hatchUv + hatchPhase) / hatchStep` makes the phase an offset in
    // the PLANE, and `hatchF = abs(fract(hatchS + 0.5) - 0.5)` is zero at the
    // INTEGERS of `hatchS` — write `hatchS = n + d`, and that expression is
    // `min(d, 1 - d)`, the distance to the nearest integer, which is what the
    // smoothstep needs it to be. So the lines stand at
    // `hatchUv = n * hatchStep - hatchPhase`, and doubling a power-of-two step
    // leaves every even one of them exactly where it was: a level change halves
    // or doubles the line count and shifts nothing.
    //
    // WHY IT IS NOT OPTIONAL, and the reason this test exists at all: the level
    // is picked off `hatchGrad`, which is the face's own foreshortening, so
    // tilting a face from head-on to 60 degrees doubles the gradient across the
    // stripes and crosses one level by itself. Ordinary rotation hits boundaries
    // constantly. Under the convention this replaced — line centres on the
    // HALF-integers and `hatchPhase` added as a fraction of the period,
    // `hatchUv / hatchStep + hatchPhase` — every one of those crossings slid the
    // whole field by up to half a period, which is the jumping the levels were
    // introduced to stop rather than a smaller helping of it.
    const shader = { fragmentShader: hatchMarker }
    hatchShader(shader)
    const source = shader.fragmentShader
    expect(source).toContain('float hatchS = (hatchUv + hatchPhase) / hatchStep;')
    expect(source).toContain('float hatchF = abs(fract(hatchS + 0.5) - 0.5);')
    // The phase is added to the DISTANCE and never to the period count, which is
    // the difference between the two conventions in one line of source.
    expect(source).not.toMatch(/hatchStep\s*\+\s*hatchPhase/)
  })

  it('and the arithmetic those two lines spell out is the arithmetic wanted', () => {
    // The test above pins the two lines as SOURCE, which catches a drift but
    // not a mistake: an edit that replaced both with plausible-but-wrong ones
    // and updated the pin to match would pass it, and the derivation would be
    // left living in a comment — the one place this project does not keep an
    // assertion. So the expressions are transcribed and checked, scalar and
    // without a GPU, the way `inkOf` below already transcribes the ink.
    const fract = (x) => x - Math.floor(x)   // GLSL ES floors towards -infinity
    const hatchF = (s) => Math.abs(fract(s + 0.5) - 0.5)

    // It is the distance to the nearest INTEGER of `hatchS`, negatives
    // included — which is where `fract` and a C `fmod` would part company, and
    // the half of the claim a reader is most likely to take on trust.
    for (const s of [-1234.5, -2, -1.75, -0.5, -1e-7, 0, 1e-7, 0.25, 3, 8191.75]) {
      expect(hatchF(s)).toBeCloseTo(Math.abs(s - Math.round(s)), 12)
    }
    expect(hatchF(0)).toBe(0)      // on a line
    expect(hatchF(0.5)).toBe(0.5)  // exactly between two

    // And the levels nest: a line of the COARSE level is a line of the fine one
    // at the same place on the part, for any phase — the phase translates the
    // whole grid, so it cannot enter the answer. Within rounding rather than
    // exactly, because this arithmetic is float64 and the shader's is float32;
    // what the GPU gains is that a power-of-two step divides bit for bit.
    for (const phase of [0, 0.001, 0.25, 0.5, 0.731, 0.999]) {
      for (const step of [2 ** -6, 2 ** -3, 1]) {
        for (let n = -8; n <= 8; n += 1) {
          const uv = n * (2 * step) - phase
          expect(hatchF((uv + phase) / step), `phase ${phase} step ${step} n ${n}`)
            .toBeLessThan(1e-9)
        }
      }
    }
  })

  /** The three measurements one compiled shader is really cut at — the target
   *  spacing and, IN FRAMEBUFFER PIXELS, the ink — worked out of it the way the
   *  GPU would.
   *
   *  The target is the uniform the patch wrote. The line and the band are
   *  literals the source multiplies by `hatchGrad / hatchStep`, and that factor
   *  is exactly the reciprocal of one period's pixel size: `hatchS` counts
   *  periods of `hatchStep` uv (asserted below, because the two lines only mean
   *  pixels together), and one of those is `hatchStep / hatchGrad` framebuffer
   *  pixels. So each literal is a pixel count outright, whatever the level, and
   *  the width in pixels is just the literal doubled. That cancellation is what
   *  lets the SPACING follow the display and then step between levels while the
   *  ink does neither. */
  const inkOf = (shader) => {
    const source = shader.fragmentShader
    const cut = source.match(
      /float hatchHalf = ([\d.]+) \* hatchGrad \/ hatchStep;\s*float hatchAa = ([\d.]+) \* hatchGrad \/ hatchStep;/)
    expect(cut).not.toBeNull()
    // The period those two are fractions OF, which is what makes them pixels.
    expect(source).toContain('float hatchS = (hatchUv + hatchPhase) / hatchStep;')
    // ...and the smoothstep is cut at those two and at nothing else, so the
    // numbers just read really are the ones the coverage comes out of.
    expect(source).toContain('smoothstep(hatchHalf - hatchAa,')
    expect(source).toContain('hatchHalf + hatchAa,')
    return {
      pitch: shader.uniforms.hatchPitch.value,
      line: 2 * Number(cut[1]),
      band: 2 * Number(cut[2]),
    }
  }

  /** One cap of one part, patched and compiled on a display of that density. */
  const inkAt = (ratio) => {
    vi.stubGlobal('devicePixelRatio', ratio)
    const g = fakeInternals(['|model|lid'], { planes: [[0, 0, 1]] })
    hatchSectionCaps(g)
    return inkOf(compile(capsOf(g)[0]))
  }

  it('targets PITCH_PX CSS pixels between lines on every display', () => {
    // ISSUE #96, and the reason the target is a uniform at all. The library
    // renders at `setPixelRatio(window.devicePixelRatio)`, so the pixels the
    // shader's derivatives count are FRAMEBUFFER ones: a spacing pinned at 8 of
    // those is four CSS pixels on a retina screen, and four CSS pixels between
    // lines three quarters of one wide is scanner grain rather than hatching —
    // worst on a close-up, where it fills the screen. What a reader judges the
    // spacing in is CSS pixels, so the target follows the density — and the
    // level ladder is picked against it, which is what carries the density all
    // the way into what the reader sees.
    for (const ratio of [1, 2, 3]) {
      expect(inkAt(ratio).pitch).toBeCloseTo(HATCH_PITCH_PX * ratio, 12)
    }
  })

  it('reads a missing or zero density as 1, and nothing further', () => {
    // The only defensiveness there is about the number. No ceiling either: the
    // pitch has to track what `setPixelRatio` was actually handed, and clamping
    // it at 2 would quietly halve the spacing on a 3x display.
    for (const ratio of [undefined, 0]) {
      expect(inkAt(ratio).pitch).toBeCloseTo(HATCH_PITCH_PX, 12)
    }
  })

  it('draws the line LINE_PX wide and softens it over about one pixel', () => {
    // FRAMEBUFFER PIXELS, and pointedly not scaled with the spacing above — the
    // half of issue #96 the fix must not overshoot, and now also what has to
    // survive a LEVEL change: `inkOf` reads these as pixel counts precisely
    // because the source converts them through the period's own pixel size, so
    // the same two numbers hold at every level. These two used to be written as
    // fractions of a period that was itself a constant; a period that grows with
    // the density — or doubles at a zoom boundary — would have carried them
    // along, widening the hairline from 1.5 framebuffer pixels to 3. A band
    // instead of a grain is not a fix. The band matters as much as the width:
    // the two-pixel `fwidth` band this replaced is wider than the line itself,
    // and a line with no inked middle is an even grey wash, which reads as a
    // colour decision rather than as a bug.
    for (const ratio of [1, 2, 3]) {
      const ink = inkAt(ratio)
      expect(ink.line).toBeCloseTo(HATCH_LINE_PX, 12)
      expect(ink.band).toBeCloseTo(HATCH_AA_PX, 12)
      expect(ink.band).toBeLessThan(ink.line)   // a line with an inked middle
    }
  })

  it('keeps all three across a `setCutHatch` toggle', () => {
    // The checkbox writes the live uniforms, so it is the one path that could
    // leave a cap hatching at the wrong period — and the path that repairs one.
    vi.stubGlobal('devicePixelRatio', 2)
    const g = fakeInternals(['|model|lid'], { planes: [[0, 0, 1]] })
    hatchSectionCaps(g)
    const shader = compile(capsOf(g)[0])
    expect(inkOf(shader)).toEqual({
      pitch: HATCH_PITCH_PX * 2, line: HATCH_LINE_PX, band: HATCH_AA_PX,
    })
    setCutHatch(g, false)
    setCutHatch(g, true)
    expect(shader.uniforms.hatchOn.value).toBe(1)
    expect(inkOf(shader)).toEqual({
      pitch: HATCH_PITCH_PX * 2, line: HATCH_LINE_PX, band: HATCH_AA_PX,
    })
    // ...and a window dragged to a display of another density recovers HERE,
    // on the next toggle or the next render, because those are what rewrite the
    // uniform. Nothing watches for the move itself: a `matchMedia` listener
    // would be permanent machinery for a case that corrects itself the moment
    // the reader does anything at all.
    vi.stubGlobal('devicePixelRatio', 1)
    setCutHatch(g, true)
    expect(inkOf(shader).pitch).toBeCloseTo(HATCH_PITCH_PX, 12)
  })
})

describe('setCutHatch', () => {
  it('flips the live uniform on every patched cap, and recompiles nothing', () => {
    const g = fakeInternals(['|model|lid'])
    expect(hatchSectionCaps(g)).toBe(3)
    const shaders = capsOf(g).map(compile)
    for (const m of capsOf(g)) m.needsUpdate = false
    expect(setCutHatch(g, false)).toBe(3)
    capsOf(g).forEach((m, i) => {
      expect(m.userData.hatch.on).toBe(0)
      expect(shaders[i].uniforms.hatchOn.value).toBe(0)
      expect(m.needsUpdate).toBe(false)          // the whole point: no recompile
    })
    expect(setCutHatch(g, true)).toBe(3)
    expect(capsOf(g)[0].userData.hatch.on).toBe(1)
    expect(shaders[0].uniforms.hatchOn.value).toBe(1)
  })

  it('leaves the answer where the NEXT compile will read it', () => {
    // The uniform is the live half; `userData.hatch` is what a later recompile
    // — a context loss, a light state change — rebuilds from. Toggling only
    // the uniform would bring the hatch back on the next compile.
    const g = fakeInternals(['|model|lid'])
    hatchSectionCaps(g)
    setCutHatch(g, false)
    const shaders = capsOf(g).map(compile)
    for (const s of shaders) expect(s.uniforms.hatchOn.value).toBe(0)
  })

  it('is quiet about scenes and materials it does not recognise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(setCutHatch(null, true)).toBe(0)
    expect(setCutHatch({ clipping: {} }, true)).toBe(0)
    const g = fakeInternals(['|model|lid'])
    expect(setCutHatch(g, false)).toBe(0)        // present, but not patched yet
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
    const g = fakeInternals(['|model|lid'], { planes: [[0, 0, 1]] })
    Object.defineProperty(g.clipping._capUnits[0].capMeshes[0], 'material', {
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
    const g = fakeInternals(['|model|lid', '|model|body', '|model|pin'],
                            { planes: [[0, 0, 1]] })
    expect(safeHatch(g)).toBe(3)
    for (const m of capsOf(g)) expect(m.onBeforeCompile).toBe(hatchShader)
    expect(safeHatch(null)).toBe(0)
  })

  it('hands the checkbox through, so a scene can come up unhatched', () => {
    // `show()` renders with the reader's current answer, not with the default:
    // a scene that lands while the box is unticked is patched but hatching
    // nothing, which is what keeps the later toggle a pure uniform write.
    const g = fakeInternals(['|model|lid'], { planes: [[0, 0, 1]] })
    expect(safeHatch(g, false)).toBe(1)
    expect(capsOf(g)[0].userData.hatch.on).toBe(0)
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

  it('declares every uniform it reads, at global scope ahead of main', () => {
    // The five identifiers exist for the GLSL compiler only because the
    // declarations are spliced in beside three.js's own uniform block. Losing
    // that splice is a shader that fails to compile — and a cut face that
    // renders as an error where the fill used to be.
    const material = fakeCapMaterial()
    material.userData.hatch = { dirX: 1, dirY: 0, phase: 0.5, on: 1 }
    const shader = { uniforms: {}, fragmentShader: 'uniform vec3 diffuse;\n' + TAIL }
    hatchShader.call(material, shader)
    for (const name of ['hatchDirX', 'hatchDirY', 'hatchPhase', 'hatchOn',
                        'hatchPitch']) {
      const declaration = shader.fragmentShader.indexOf(`uniform float ${name};`)
      expect(declaration).toBeGreaterThan(-1)
      // The marker sits inside `main()`, so ahead of it is what makes these
      // declarations legal; the shader's own diffuse uniform is the anchor.
      expect(declaration)
        .toBeLessThan(shader.fragmentShader.indexOf(hatchMarker))
    }
  })

  it('carries the part\'s numbers in as uniform VALUES, off this.userData', () => {
    // three.js calls `material.onBeforeCompile(parameters, renderer)`, so `this`
    // is the material and the numbers were written there by `patchCapMaterial`.
    // This is the half that lets every cap share ONE compiled program while
    // hatching to its own slope and phase.
    const material = fakeCapMaterial()
    const hatch = { dirX: -0.5, dirY: 0.5, phase: 0.25, on: 0 }
    material.userData.hatch = hatch
    const shader = { uniforms: {}, fragmentShader: 'uniform vec3 diffuse;\n' + TAIL }
    hatchShader.call(material, shader)
    expect(shader.uniforms.hatchDirX.value).toBe(-0.5)
    expect(shader.uniforms.hatchDirY.value).toBe(0.5)
    expect(shader.uniforms.hatchPhase.value).toBe(0.25)
    expect(shader.uniforms.hatchOn.value).toBe(0)
    // ...and the handle the toggle needs later: the shader object itself, kept
    // on the material so `.value` can be rewritten without a recompile.
    expect(material.userData.hatchShader).toBe(shader)
  })

  it('splices at a chunk the VENDORED three.js still has', () => {
    // THE UPGRADE GUARD, and the reason this test reads most of a megabyte. This
    // is string surgery on three.js's shader chunks, so it is pinned to the
    // THREE the page actually loads — static/_v/three.module.js (r184 as this
    // was written), which since `external: three` is a file of its own beside
    // the viewer bundle rather than a passenger inside it — and not to a release
    // of the viewer. A rename there costs the page its hatch and NOTHING ELSE:
    // no error, no warning, a section that is simply a flat fill again. This is
    // the only place that can notice.
    //
    // `meshphysical_frag` and not the file: three.module.js carries nine copies
    // of this chunk name and only ONE of them is in the shader a
    // `MeshStandardMaterial` compiles, which is what the library's cap is. See
    // `meshphysicalFragment` for what that costs and why the file-wide search it
    // replaced could not fail.
    const shader = meshphysicalFragment(repoFile(THREE_MODULE))
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
