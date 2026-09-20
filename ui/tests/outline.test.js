// ui/src/viewport/outline.js — the section contour, drawn on the library's own
// fat-line stack.
//
// Same runner discipline as hatch.test.js: there is no GPU and no library, so
// nothing below looks at a pixel. What IS assertable is every way this can go
// silently wrong — the arithmetic (a plane through a cube cuts the square it
// should; a corner cut cuts the hexagon; a plane that misses the solid cuts
// nothing), the silences (an empty or degenerate solid produces no segments
// and never a NaN in the buffer; the memo holds the rebuild off when the plane
// did not move), and the library facts the harvest leans on, read straight
// from the vendored files at the bottom of this file — the bundle for the
// library's own code and for the fat-line addons, three's own two files for
// three, which `external: three` has kept out of the bundle since the fork.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { internals } from '../src/viewport/internals.js'
import { GHOST_OPACITY, viewerOptions } from '../src/viewport/options.js'
import {
  OUTLINE_NAME, clearSectionOutlines, insideSection, sectionOutline,
  sectionSegments,
} from '../src/viewport/outline.js'
import {
  applyGhost, applyHidden, movePart, nudgePart, reconcileMoves,
} from '../src/viewport/parts.js'
import {
  dragSection, placeSectionPlane, sectionAxis, suspendSectionCut,
} from '../src/viewport/section.js'
import { RECT } from './component.js'
import {
  fakeMatrix, fakeRenderer, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

/** A repo file, MEMOISED: the three below are megabytes each and the last block
 *  asks a dozen questions of them. */
const sources = new Map()
const repoFile = (path) => {
  if (!sources.has(path)) {
    sources.set(path, readFileSync(resolve(process.cwd(), path), 'utf8'))
  }
  return sources.get(path)
}

/** WHICH FILE HOLDS WHAT, since the fork in `viewer/` builds with
 *  `external: three`. The bundle is three-cad-viewer's own code plus the
 *  `three/examples/jsm` addons it imports — `LineMaterial`, `LineSegments2` and
 *  their shaders are in here, not in three. three itself ships as two committed
 *  npm artefacts: `three.module.js` (the WebGL renderer, which is where
 *  `_maxInstanceCount` is written and clamped) importing `three.core.js` (the
 *  materials and the scene graph, which is where `Material.copy` lives). */
const BUNDLE = '../static/_v/three-cad-viewer.esm.js'
const THREE_MODULE = '../static/_v/three.module.js'
const THREE_CORE = '../static/_v/three.core.js'

/** The eight corners of an axis-aligned box, numbered in z runs: 0-1-2-3 round
 *  the low-z face, then 4-5-6-7 above them. `CUBE_INDEX` is written against
 *  this numbering, so it describes any box these corners are built from. */
const boxCorners = ([x0, y0, z0], [x1, y1, z1]) => [
  x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
  x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
]

// A cube spanning [0,2]^3, two triangles per face.
const CUBE_POSITIONS = new Float32Array(boxCorners([0, 0, 0], [2, 2, 2]))

// EVERY TRIANGLE WOUND OUTWARD, which is what a real tessellation gives — read
// off ui/tests/fixtures/assembled.json rather than assumed: all 1128 of its
// triangles agree in sign with the vertex normal OCP shipped beside them.
//
// It matters because the chords `planeThroughTriangles` emits are directed by
// the winding, and the measure that catches a solid wound half one way and half
// the other is the SIGNED area those chords enclose: three of this fixture's six
// faces used to face inwards, and the square below came out with an area of
// exactly zero. The diagonals are unchanged, so every segment count and endpoint
// in this file is what it always was.
const CUBE_INDEX = new Uint32Array([
  0, 3, 2, 0, 2, 1, // z = 0, outward -z, diagonal corner 0 - corner 2
  4, 5, 6, 4, 6, 7, // z = 2, outward +z
  0, 1, 5, 0, 5, 4, // y = 0, outward -y
  3, 6, 2, 3, 7, 6, // y = 2, outward +y
  0, 4, 7, 0, 7, 3, // x = 0, outward -x
  1, 2, 6, 1, 6, 5, // x = 2, outward +x
])

// The same cube stretched to a box spanning [0,sx] x [0,sy] x [0,sz]: the
// corners are numbered the same way, so CUBE_INDEX still describes it.
const boxPositions = (sx, sy, sz) =>
  new Float32Array(boxCorners([0, 0, 0], [sx, sy, sz]))

/** A box hollowed out to a wall `wall` thick — a solid whose THIN WALLS SIT
 *  INSIDE A FAT BOUNDING BOX, which is the shape no bounding box can report and
 *  the one `.faces(">Z").shell(-WALL)` leaves in the template model. The void
 *  here is CLOSED where that one is open at the top; at the heights these tests
 *  cut, halfway up and through the floor, the two are the same section, and
 *  they part company only above the cavity's ceiling. The cavity is a second
 *  box wound the other way round, because the surface of a void faces into it. */
const shelledBox = ([sx, sy, sz], wall) => {
  const inward = []
  for (let at = 0; at < CUBE_INDEX.length; at += 3) {
    inward.push(CUBE_INDEX[at] + 8, CUBE_INDEX[at + 2] + 8, CUBE_INDEX[at + 1] + 8)
  }
  return {
    positions: new Float32Array([
      ...boxCorners([0, 0, 0], [sx, sy, sz]),
      ...boxCorners([wall, wall, wall], [sx - wall, sy - wall, sz - wall]),
    ]),
    index: new Uint32Array([...CUBE_INDEX, ...inward]),
  }
}

function solidScene({ gridSize = 100, groups = {} } = {}) {
  const camera = orthoCamera({
    eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
  })
  const viewer = fakeViewer({ camera, gridSize, groups, rect: RECT })
  const vp = fakeViewport(viewer)
  return { viewer, vp, g: internals(viewer) }
}

function cubeScene({ matrix } = {}) {
  const solid = fakeShapeSolid('S|body', {
    positions: CUBE_POSITIONS, index: CUBE_INDEX, matrix,
  })
  const { viewer, vp, g } = solidScene({ groups: { 'S|body': solid } })
  return { solid, viewer, vp, g }
}

// The same scene, with the viewer carrying the leaf state the part passes read.
function partScene() {
  const solid = fakeShapeSolid('S|body', {
    positions: CUBE_POSITIONS, index: CUBE_INDEX,
  })
  const camera = orthoCamera({
    eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
  })
  const viewer = fakeViewer({
    camera, groups: { 'S|body': solid }, rect: RECT,
    states: { 'S|body': [1, 1] },
  })
  const vp = fakeViewport(viewer)
  return { solid, viewer, vp, g: internals(viewer) }
}

// By the mark the module writes on its own object. Neither the name nor the
// class identifies it: `renderShape` names the library's own children after the
// shape, and one of those children is a fat line too.
/** The one line of the vendored fat-line shader the depth patch hangs off,
 *  in the least source that can carry it. */
const shaderSource = () =>
  'void main() {\n  clip.xy += offset;\n  gl_Position = clip;\n}'

const outlineOf = (solid) =>
  solid.children.find((child) => child.userData && child.userData[OUTLINE_NAME])

/** The segments a rebuilt geometry holds, one `xyz xyz` pair after another —
 *  the interleaved buffer the bundle's `setPositions` builds. */
const segmentsOf = (outline) => {
  const { array } = outline.geometry.instanceStart.data
  const segments = []
  for (let at = 0; at < array.length; at += 6) {
    segments.push([
      [array[at], array[at + 1], array[at + 2]],
      [array[at + 3], array[at + 4], array[at + 5]],
    ])
  }
  return segments
}

const totalLength = (segments) => segments.reduce((total, [p, q]) => {
  const dx = p[0] - q[0]
  const dy = p[1] - q[1]
  const dz = p[2] - q[2]
  return total + Math.sqrt(dx * dx + dy * dy + dz * dz)
}, 0)

const allFinite = (segments) => segments.every(([p, q]) =>
  [p, q].every((point) => point.every(Number.isFinite)))

/** The area the directed chords enclose, off the segment buffer alone: the
 *  divergence form of the shoelace rule, `0.5 * |sum (a x b) . n|`, which a
 *  closed loop answers wherever it starts and whatever the origin is, and which
 *  subtracts a hole's loop by itself.
 *
 *  Nothing in the module computes this any more — it lives here because it is
 *  the measure that COLLAPSES when the chords are not consistently directed,
 *  which is what makes it the way to read that property off the buffer. `n`
 *  must be unit. */
const signedArea = (segments, n) => Math.abs(segments.reduce(
  (total, [a, b]) => total
    + (a[1] * b[2] - a[2] * b[1]) * n[0]
    + (a[2] * b[0] - a[0] * b[2]) * n[1]
    + (a[0] * b[1] - a[1] * b[0]) * n[2],
  0)) / 2

/** The same triangles, each listed from a different corner.
 *
 *  Rotating one triangle's vertex list leaves its winding, and therefore the
 *  solid, exactly as it was, and a tessellator has no reason to start every
 *  triangle at the same place. What it DOES change is which of a cut triangle's
 *  two crossings the edge walk meets first — so it is exactly the difference
 *  between a chord directed by the SIGN it crosses on and one directed by the
 *  accident of where the walk began. */
const rotateTriangles = (index) => {
  const out = new Uint32Array(index.length)
  for (let at = 0; at < index.length; at += 3) {
    const by = (at / 3) % 3
    for (let corner = 0; corner < 3; corner += 1) {
      out[at + corner] = index[at + ((corner + by) % 3)]
    }
  }
  return out
}

/** Does every triangle face away from `inside`? A solid's tessellation does,
 *  and a signed area is only worth reading on one that does. */
const woundOutward = (positions, index, inside) => {
  for (let at = 0; at < index.length; at += 3) {
    const [a, b, c] = [index[at] * 3, index[at + 1] * 3, index[at + 2] * 3]
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1],
               positions[b + 2] - positions[a + 2]]
    const v = [positions[c] - positions[a], positions[c + 1] - positions[a + 1],
               positions[c + 2] - positions[a + 2]]
    const away = [positions[a] - inside[0], positions[a + 1] - inside[1],
                  positions[a + 2] - inside[2]]
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0]]
    const dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2]
    if (!(dot > 0)) return false
  }
  return true
}

describe('sectionOutline', () => {
  it('cuts a cube parallel to a face along the square it is', () => {
    const { solid, vp, g } = cubeScene()
    // Plane x = 1: the slider counts from the grid centre at the origin, so
    // the value of the plane x = 1 along +x is -1.
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    const segments = segmentsOf(outline)
    // Four cut faces, two triangles each, both crossed: the square's sides,
    // each split once by its face's diagonal.
    expect(segments).toHaveLength(8)
    for (const [p, q] of segments) {
      expect(p[0]).toBeCloseTo(1, 9)
      expect(q[0]).toBeCloseTo(1, 9)
    }
    expect(totalLength(segments)).toBeCloseTo(8, 9)
  })

  it('cuts a cube corner-on along the hexagon it is', () => {
    const { solid, vp, g } = cubeScene()
    // Plane x + y + z = 3, through the cube's centre corner-on. THE NORMAL IS
    // UNIT, which is the module's precondition and not decoration: with a bare
    // [1, 1, 1] this call still draws a hexagon, but on a different plane from
    // the one the library would clip with for the same pair — and a test is
    // the first thing the next caller copies.
    const third = 1 / Math.sqrt(3)
    sectionOutline(vp, g, [third, third, third], -Math.sqrt(3))
    const segments = segmentsOf(outlineOf(solid))
    // Six cut faces, two triangles each, both crossed.
    expect(segments).toHaveLength(12)
    for (const [p, q] of segments) {
      for (const point of [p, q]) {
        expect(point[0] + point[1] + point[2]).toBeCloseTo(3, 9)
        for (const axis of point) {
          expect(axis).toBeGreaterThanOrEqual(-1e-9)
          expect(axis).toBeLessThanOrEqual(2 + 1e-9)
        }
      }
    }
    // The hexagon's side is sqrt(2); the diagonal splits change the segment
    // count, never the length they cover.
    expect(totalLength(segments)).toBeCloseTo(6 * Math.SQRT2, 9)
  })

  it('draws nothing when the plane misses the solid', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -5) // plane x = 5, the cube ends at 2
    expect(outlineOf(solid)).toBeUndefined()
    expect(solid.children).toHaveLength(0)
  })

  it('empties a solid\'s outline when the plane moves back out of it', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    const first = outline.geometry
    sectionOutline(vp, g, [1, 0, 0], -5)
    // The outline object stays — an update, not a rebuild — but it now writes
    // nothing: nothing of the contour cut where the plane USED to be may
    // linger.
    expect(outlineOf(solid)).toBe(outline)
    expect(outline.geometry.instanceCount).toBe(0)
    // A NEW geometry under that same object, and the old one disposed. This is
    // the fill contract `writeSegments` states: three caches the instance count
    // it may draw on the geometry at its first bind and nothing recomputes it
    // while that geometry lives, so a geometry refilled in place goes on drawing
    // the count it had at birth.
    expect(outline.geometry).not.toBe(first)
    expect(first.disposed).toBe(1)
    // ONE fill and not two: the fresh geometry carries its own counter, so this
    // is the same assertion the count on a reused geometry used to make.
    expect(outline.geometry.setPositionsCalls).toBe(1)
  })

  it('builds one outline per solid and updates it instead of stacking', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    const first = outline.geometry
    sectionOutline(vp, g, [1, 0, 0], -1.5)
    expect(solid.children).toHaveLength(1)
    expect(outlineOf(solid)).toBe(outline)
    expect(outline.geometry).not.toBe(first)
    expect(first.disposed).toBe(1)
    expect(outline.geometry.setPositionsCalls).toBe(1)
  })

  it('gives every fill a geometry the renderer has not bound, so a cut that grows is drawn whole', () => {
    // WHAT THIS PINS, and it was measured in a browser on the owner's own
    // model rather than reasoned about: three caches on an
    // InstancedBufferGeometry how many instances it may draw
    // (`_maxInstanceCount`, written at the FIRST bind and never recomputed), so
    // an outline whose geometry is refilled in place goes on drawing the
    // segment count it had when it was born. A cut laid on an outer face and
    // then dragged in through a spherical cavity stood at 185 segments with 48
    // drawn — a few straight edges inked, the whole curve of the cavity
    // missing. Replacing the geometry is what makes the renderer count again.
    const { solid, vp, g } = cubeScene()
    // Square first (8 chords), then the same cube corner-on (12): the fill has
    // to GROW, which is the direction the cached count cannot follow.
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    const square = outline.geometry
    expect(square.instanceCount).toBe(8)
    const third = 1 / Math.sqrt(3)
    sectionOutline(vp, g, [third, third, third], -Math.sqrt(3))
    expect(outlineOf(solid)).toBe(outline)
    expect(outline.geometry).not.toBe(square)
    expect(outline.geometry.instanceCount).toBe(12)
    // And the geometry it replaced is disposed rather than left holding a GPU
    // buffer and a vertex-array object nothing points at.
    expect(square.disposed).toBe(1)
  })

  it('holds the rebuild off while the plane stands still', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    const first = outline.geometry
    sectionOutline(vp, g, [1, 0, 0], -1)
    // Nothing was written at all: a fill replaces the geometry, so the one
    // standing being the first is what says the memo held the rebuild off.
    expect(outline.geometry).toBe(first)
    expect(first.disposed).toBe(0)
    // `show()` invalidates by clearing the key — the outline objects died with
    // the scene they hung on, so the next plane has to rebuild even if the
    // numbers repeat the old ones.
    vp.sectionOutlineKey = null
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outline.geometry).not.toBe(first)
  })

  it('works in the solid\'s own frame, not the world\'s', () => {
    // The same cube, carried five units along x by its matrixWorld. The
    // segments are read back in LOCAL coordinates — the plane at world x = 6
    // is local x = 1.
    const { solid, vp, g } = cubeScene({
      matrix: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] },
    })
    sectionOutline(vp, g, [1, 0, 0], -6)
    const segments = segmentsOf(outlineOf(solid))
    expect(segments).toHaveLength(8)
    for (const [p, q] of segments) {
      expect(p[0]).toBeCloseTo(1, 9)
      expect(q[0]).toBeCloseTo(1, 9)
    }
    expect(totalLength(segments)).toBeCloseTo(8, 9)
  })

  it('draws nothing for a solid with no triangles, and nothing NaN', () => {
    const solid = fakeShapeSolid('S|empty', {
      positions: CUBE_POSITIONS, index: new Uint32Array(0),
    })
    const { vp, g } = solidScene({ groups: { 'S|empty': solid } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    expect(segmentsOf(outline)).toHaveLength(0)
  })

  it('lets a degenerate vertex cost nothing, not NaN', () => {
    // One triangle collinear (zero area, finite), one proper: whatever the
    // zero-area one contributes degenerates to a point, and every number that
    // reaches the buffer is finite.
    const solid = fakeShapeSolid('S|thin', {
      positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 0, 0]),
      index: new Uint32Array([0, 1, 2, 0, 1, 3]),
    })
    const { vp, g } = solidScene({ groups: { 'S|thin': solid } })
    sectionOutline(vp, g, [1, 0, 0], -0.5)
    expect(allFinite(segmentsOf(outlineOf(solid)))).toBe(true)
  })

  it('scans for a donor with edges instead of assuming the first solid has one', () => {
    const edgeless = fakeShapeSolid('S|bare', {
      positions: CUBE_POSITIONS, index: CUBE_INDEX, edges: false,
    })
    const carried = fakeShapeSolid('S|full', {
      positions: CUBE_POSITIONS, index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({ groups: { 'S|bare': edgeless, 'S|full': carried } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    // The donor's absence only blocks the HARVEST. Both solids have triangles,
    // so both get an outline.
    expect(outlineOf(edgeless)).toBeDefined()
    expect(outlineOf(carried)).toBeDefined()
  })

  it('says so once per call when no solid has edges to harvest', () => {
    const edgeless = fakeShapeSolid('S|bare', {
      positions: CUBE_POSITIONS, index: CUBE_INDEX, edges: false,
    })
    const { vp, g } = solidScene({ groups: { 'S|bare': edgeless } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sectionOutline(vp, g, [1, 0, 0], -1)
      sectionOutline(vp, g, [1, 0, 0], -1.5)
      expect(warn).toHaveBeenCalledTimes(2)
      expect(outlineOf(edgeless)).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('stays silent in a scene with no solids at all', () => {
    const { vp, g } = solidScene()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sectionOutline(vp, g, [1, 0, 0], -1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('clones the edge material dark and one pixel wide, clipped by the other two planes', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const material = outlineOf(solid).material
    expect(material.clipping).toBe(true)
    // An edge's own width: the cut carries no edge of the library's, so this
    // line IS the edge a section opens up rather than a heavier mark over one.
    expect(material.linewidth).toBe(1)
    for (const channel of ['r', 'g', 'b']) {
      expect(material.color[channel]).toBeCloseTo(0x30 / 255, 12)
    }
    // The cap material's trick: every plane but the one the outline lies in,
    // in the library's own order.
    const planes = g.clipping.clipPlanes
    expect(material.clippingPlanes).toHaveLength(planes.length - 1)
    expect(material.clippingPlanes[0]).toBe(planes[1])
    expect(material.clippingPlanes[1]).toBe(planes[2])
    // Where the viewport knows its size — the same numbers the library feeds
    // its own edge materials.
    expect(material.resolution.x).toBe(RECT.width)
    expect(material.resolution.y).toBe(RECT.height)
    // A clone: the donor's material is untouched. Read off the COLOUR now that
    // the contour is an edge's width — the widths agreeing says nothing about
    // cloning, the donor still being white says it.
    expect(solid.edges.material).not.toBe(material)
    expect(solid.edges.material.color.r).toBe(1)
  })

  it('puts the cut plane into the fat-line shader, on one program every contour shares', () => {
    // WHAT THIS IS FOR. A fat line is a quad widened in SCREEN space, and the
    // vendored shader shifts only `clip.xy` — the whole band keeps the depth of
    // the segment's endpoint while the plane it lies in recedes across it. Half
    // of every band therefore sinks behind the cut and the depth test gives
    // those pixels to the cut's own cap. The patch below is what puts the
    // widened corner back on the plane.
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const { material } = outlineOf(solid)
    const shader = { uniforms: {}, vertexShader: shaderSource() }
    material.onBeforeCompile(shader)
    // The uniform the hook writes and the uniform the shader reads are ONE
    // object — a copy would leave the correction frozen at the first frame.
    expect(shader.uniforms.hmrCutNormal).toBe(material.userData.cutNormal)
    expect(shader.vertexShader).toContain('uniform vec4 hmrCutNormal;')
    expect(shader.vertexShader).toContain('clip.z += projectionMatrix[2][2]')
    // After the shift and not before it: the correction reads `offset`.
    expect(shader.vertexShader.indexOf('clip.z += projectionMatrix[2][2]'))
      .toBeGreaterThan(shader.vertexShader.indexOf('clip.xy += offset;'))
    // ONE COMPILED PROGRAM FOR EVERY CONTOUR, which is why there is no
    // `customProgramCacheKey` here: three's default key is the patch's own
    // source, so materials whose patch reads the same share a program — the
    // reasoning `hatch.js` writes out for the cap patch.
    //
    // Compared as the shader the patch PRODUCES and not as the source that
    // produces it, because the trap `hatch.js` warns about is exactly the one
    // `toString()` cannot see: bake a per-material number into the GLSL through
    // a template string and the source stays identical, the key stays
    // identical, and every contour after the first gets the first one's shader.
    const other = fakeShapeSolid('S|other', {
      positions: boxPositions(4, 4, 4), index: CUBE_INDEX,
    })
    const second = solidScene({ groups: { 'S|other': other } })
    sectionOutline(second.vp, second.g, [1, 0, 0], -1)
    const mine = { uniforms: {}, vertexShader: shaderSource() }
    const theirs = { uniforms: {}, vertexShader: shaderSource() }
    material.onBeforeCompile(mine)
    outlineOf(other).material.onBeforeCompile(theirs)
    expect(theirs.vertexShader).toBe(mine.vertexShader)
    // While the uniform each of them writes stays its own: the shared program
    // is a program, not shared state.
    expect(theirs.uniforms.hmrCutNormal).not.toBe(mine.uniforms.hmrCutNormal)
    expect(material.customProgramCacheKey).toBeUndefined()
  })

  it('builds an ORTHOGRAPHIC camera, which is what makes the depth patch exact', () => {
    // Under a perspective projection a corner's `clip.w` moves with its depth
    // and the correction would have to move both; the shader reads the
    // projection and does nothing there, so this option is the reason the
    // contour is whole rather than merely better.
    expect(viewerOptions.ortho).toBe(true)
  })

  it('says so rather than drawing on when the vendored shader moves', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const { material } = outlineOf(solid)
    const shader = { uniforms: {}, vertexShader: 'void main() { gl_Position = clip; }' }
    const before = shader.vertexShader
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      material.onBeforeCompile(shader)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    // Unchanged rather than half-patched: a source this no longer recognises is
    // one whose `offset` may not mean what the correction assumes.
    expect(shader.vertexShader).toBe(before)
  })

  it('writes the plane normal in VIEW space before every draw', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    const { value } = outline.material.userData.cutNormal
    // Nothing until a frame has run: the branch in the shader is off.
    expect(value[3]).toBe(0)
    // A camera turned a quarter turn about Z: its matrixWorld's columns are
    // +Y, -X, +Z, so the world +X normal reads as -Y in view space.
    const camera = { matrixWorld: { elements: [
      0, 1, 0, 0,
      -1, 0, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ] } }
    outline.onBeforeRender({}, {}, camera)
    expect(value[0]).toBeCloseTo(0, 12)
    expect(value[1]).toBeCloseTo(-1, 12)
    expect(value[2]).toBeCloseTo(0, 12)
    expect(value[3]).toBe(1)
  })

  it('wraps the library hook rather than replacing it', () => {
    // The hook the contour hangs its uniform off is the one the library uses to
    // keep `resolution` in step with the canvas, and a fat line whose
    // resolution stops moving stops being the width it was asked for. So the
    // wrapper has to CALL it, with the arguments it was given.
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    // Read as the EFFECT and not as a spy on the prototype: the wrapper binds
    // the inherited method when it is installed, so a spy hung on the prototype
    // afterwards would never be reached and would report a failure that is not
    // one. What has to stay true is that the canvas size still arrives.
    expect(outline.material.resolution.x).toBe(RECT.width)
    const renderer = fakeRenderer({ width: 1024, height: 768 })
    const camera = { matrixWorld: { elements: [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ] } }
    outline.onBeforeRender(renderer, {}, camera)
    expect(outline.material.resolution.x).toBe(1024)
    expect(outline.material.resolution.y).toBe(768)
    // And the contour's own work still happened on the same call.
    expect(outline.material.userData.cutNormal.value[3]).toBe(1)
  })

  it('moves the stored normal with a plane that turns', () => {
    // The update path rebuilds the segments of an outline that already exists,
    // and a contour left describing the plane it was born under would correct
    // the depth toward the wrong one.
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    sectionOutline(vp, g, [0, 1, 0], -1)
    const camera = { matrixWorld: { elements: [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ] } }
    outline.onBeforeRender({}, {}, camera)
    const { value } = outline.material.userData.cutNormal
    expect([value[0], value[1], value[2]]).toEqual([0, 1, 0])
  })

  it('draws above every face and edge the library orders, on every solid', () => {
    // WHAT THIS IS FOR. The whole model lives in the transparent pass, which
    // sorts by `renderOrder` before anything else, and the library hands out
    // 999 to its edges always and to a part's faces whenever that part is
    // translucent. A contour left at the default 0 draws first and the
    // translucent faces — which write no depth — blend over it, which is how a
    // contour came to be missing on some solids and crisp on others in the same
    // frame. The number therefore has to sit ABOVE the library's, not level
    // with it: inside one bucket the order is decided per object by depth and
    // turns over as the model turns.
    const wall = fakeShapeSolid('S|wall', {
      positions: boxPositions(40, 30, 2), index: CUBE_INDEX,
    })
    const slab = fakeShapeSolid('S|slab', {
      positions: boxPositions(40, 33.8, 50.8), index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({
      groups: { 'S|wall': wall, 'S|slab': slab },
    })
    sectionOutline(vp, g, [1, 0, 0], -20) // the plane x = 20, through both
    for (const solid of [wall, slab]) {
      expect(outlineOf(solid).renderOrder).toBeGreaterThan(999)
      // THE OTHER HALF OF THAT NUMBER BEING SAFE. Drawn last, the contour is
      // held behind an opaque part standing in front of it by the depth test
      // and by nothing else — turn it off to make the contour "always visible"
      // and it starts showing through the model.
      expect(outlineOf(solid).material.depthTest).toBe(true)
    }
  })

  it('gives every cut face the same contour, whatever size the face is', () => {
    // THE CLAIM THE WIDTH IS. A 2 mm wall, a 20 mm post and a 50.8 x 33.8 slab
    // standing side by side, cut by one plane across all three: the faces they
    // make differ by a factor of nearly thirty in area (60, 600, 1717 mm^2) and
    // the contour does not differ at all. Both attempts at a width off the
    // MODEL — a tenth of the smallest bounding-box dimension, then 2A/P of the
    // cut face — put a fat rim on the slab and, on the wall, a line too thin to
    // see or none at all.
    const wall = fakeShapeSolid('S|wall', {
      positions: boxPositions(40, 30, 2), index: CUBE_INDEX,
    })
    const post = fakeShapeSolid('S|post', {
      positions: boxPositions(40, 30, 20), index: CUBE_INDEX,
    })
    const slab = fakeShapeSolid('S|slab', {
      positions: boxPositions(40, 33.8, 50.8), index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({
      groups: { 'S|wall': wall, 'S|post': post, 'S|slab': slab },
    })
    sectionOutline(vp, g, [1, 0, 0], -20) // the plane x = 20, through all three
    for (const solid of [wall, post, slab]) {
      const { material } = outlineOf(solid)
      expect(material.linewidth).toBe(1)
      // Which is a count of CSS PIXELS, because `linewidth` counts those unless
      // the material is told otherwise and nothing tells it otherwise. The flag
      // is a view onto the shader defines rather than a field, so this reads the
      // define too.
      expect(material.worldUnits).toBe(false)
      expect(material.defines.WORLD_UNITS).toBeUndefined()
    }
  })

  it('takes neither the name nor the class of a part called sectionOutline', () => {
    // `renderShape` names the library's children after the shape, so a part
    // called exactly `sectionOutline` puts front, back AND edges into its
    // group under the outline's own name. Both decoys below are what that
    // looks like, and each defeats one half of a weaker scan: the mesh has no
    // `setPositions` for a name-only scan to call, and the EDGES answer name
    // and fat-line class both — a scan on those two would write the contour
    // into the part's own edges and take them off the screen.
    const solid = fakeShapeSolid(OUTLINE_NAME, {
      positions: CUBE_POSITIONS, index: CUBE_INDEX,
    })
    const mesh = { name: OUTLINE_NAME, isMesh: true, geometry: {} }
    const edges = { name: OUTLINE_NAME, isLineSegments2: true, userData: {},
                    geometry: { setPositions: vi.fn() } }
    solid.add(mesh)
    solid.add(edges)
    const { vp, g } = solidScene({ groups: { [OUTLINE_NAME]: solid } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    expect(outline).not.toBe(mesh)
    expect(outline).not.toBe(edges)
    expect(edges.geometry.setPositions).not.toHaveBeenCalled()
    expect(segmentsOf(outline)).toHaveLength(8)
  })
})

describe('the chords, directed by the sign the edge crosses on', () => {
  // `planeThroughTriangles` emits each chord from its `+ -> -` crossing to its
  // `- -> +` one rather than in the order the edge walk met the two. NOTHING
  // DOWNSTREAM READS THAT TODAY — the fat line and `insideSection` are both
  // blind to the direction — so these two tests are the whole of what keeps it
  // true, and they read it straight off the segment buffer.

  it('cuts a solid wound outward, the way a real tessellation is', () => {
    // The direction rests on it: the chords of a solid wound half one way and
    // half the other come out reversed against each other, and the signed area
    // below is then not the face's area and not anything else either. Pinned
    // here because the fixture used to fail it, and the failure was invisible —
    // every segment count and endpoint in this file held throughout.
    expect(woundOutward(CUBE_POSITIONS, CUBE_INDEX, [1, 1, 1])).toBe(true)
  })

  it('directs the chords by the sign they cross on, not by the edge walk', () => {
    // MEASURED RATHER THAN ASSUMED. The same solid, the same winding, the same
    // cut — only each triangle's vertex list rotated, which no tessellator
    // promises not to do. Directed by the accident of which crossing the walk
    // met first, half of a solid's chords come back reversed against the other
    // half and the signed area they enclose collapses: on the payload fixture's
    // own cylinder, cut through its axis, it collapsed to EXACTLY ZERO — a face
    // 96 mm^2 across reported as no face at all, with a perfectly correct
    // perimeter beside it.
    //
    // Outer 50.8 x 33.8, wall 2.4, cut half way up: the face is the ring
    // between 50.8 x 33.8 and 46 x 29, so A = 1717.04 - 1334 = 383.04 and
    // P = 169.2 + 150 = 319.2. The area is also what says the cavity is wound
    // INTO itself the way a void is: wound the other way its loop would ADD
    // instead of subtracting and the ring would read 3051.
    const UP = [0, 0, 1]
    const shell = shelledBox([50.8, 33.8, 20], 2.4)
    const straight = fakeShapeSolid('S|straight', shell)
    const rotated = fakeShapeSolid('S|rotated', {
      positions: shell.positions, index: rotateTriangles(shell.index),
    })
    const { vp, g } = solidScene({
      groups: { 'S|straight': straight, 'S|rotated': rotated },
    })
    sectionOutline(vp, g, UP, -10)
    const asWalked = segmentsOf(outlineOf(straight))
    expect(totalLength(asWalked)).toBeCloseTo(319.2, 3)
    expect(signedArea(asWalked, UP)).toBeCloseTo(383.04, 3)
    // Rotating the vertex lists moves nothing whatever: the same edges are
    // crossed, so every chord comes back with the same two ends IN THE SAME
    // ORDER, which is the claim itself and not a consequence of it.
    expect(segmentsOf(outlineOf(rotated))).toEqual(asWalked)
  })
})

describe('the local-frame arithmetic, pinned', () => {
  it('takes a rotated part: a quarter turn about z', () => {
    // Rz(90°): local (x, y, z) lands at world (-y, x, z). The world plane
    // y = 1 is local x = 1; a transposed normal turns this into a miss.
    const { solid, vp, g } = cubeScene({
      matrix: { elements: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    })
    sectionOutline(vp, g, [0, 1, 0], -1)
    const segments = segmentsOf(outlineOf(solid))
    expect(segments).toHaveLength(8)
    for (const [p, q] of segments) {
      expect(p[0]).toBeCloseTo(1, 9)
      expect(q[0]).toBeCloseTo(1, 9)
    }
    expect(totalLength(segments)).toBeCloseTo(8, 9)
  })

  it('takes a non-uniform scale: the normal carries the scale', () => {
    // diag(2, 1, 1): the cube spans world x in [0, 4] and the world plane
    // x = 2 is local x = 1. A normal left unscaled lands the plane on the
    // cube's own x = 2 face and the walk finds nothing.
    const { solid, vp, g } = cubeScene({
      matrix: { elements: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    })
    sectionOutline(vp, g, [1, 0, 0], -2)
    const segments = segmentsOf(outlineOf(solid))
    expect(segments).toHaveLength(8)
    for (const [p, q] of segments) {
      expect(p[0]).toBeCloseTo(1, 9)
      expect(q[0]).toBeCloseTo(1, 9)
    }
    expect(totalLength(segments)).toBeCloseTo(8, 9)
  })

  it('takes a vertex exactly on the plane as one zero-length segment', () => {
    // d = [0, 1, 1]: both edges at the touched vertex cross, at t = 0 and
    // t = 1, both at [1, 0, 0]. On screen the fat line degenerates to
    // nothing; the buffer holds the arithmetic, exactly.
    const solid = fakeShapeSolid('S|touched', {
      positions: new Float32Array([1, 0, 0, 2, 0, 0, 2, 2, 0]),
      index: new Uint32Array([0, 1, 2]),
    })
    const { vp, g } = solidScene({ groups: { 'S|touched': solid } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    const segments = segmentsOf(outlineOf(solid))
    expect(segments).toHaveLength(1)
    expect(segments[0][0]).toEqual([1, 0, 0])
    expect(segments[0][1]).toEqual([1, 0, 0])
    expect(totalLength(segments)).toBe(0)
    expect(allFinite(segments)).toBe(true)
  })

  it('takes a triangle lying in the plane as empty, not as a miss', () => {
    // Every distance zero: no edge crosses, but the box test passes — the
    // outline is created and holds nothing, rather than being skipped with
    // whatever it carried before.
    const solid = fakeShapeSolid('S|flat', {
      positions: new Float32Array([1, 0, 0, 1, 2, 0, 1, 0, 2]),
      index: new Uint32Array([0, 1, 2]),
    })
    const { vp, g } = solidScene({ groups: { 'S|flat': solid } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    expect(segmentsOf(outline)).toHaveLength(0)
  })
})

describe('the outline through the section\'s own call sites', () => {
  it('is built by a placement and moved by a drag, one object throughout', () => {
    const { solid, viewer, vp, g } = cubeScene()
    // The plane through the cube's x = 1 middle, sunk the placement sliver
    // in. The normal is the screen's right — a drag needs an in-screen slide
    // direction, which a plane facing the camera dead-on does not have.
    placeSectionPlane(vp, g, [1, 0, 0], [1, 0, 1])
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    const placed = outline.geometry
    expect(placed.setPositionsCalls).toBe(1)
    const axis = sectionAxis(viewer, g, [0, 0, 0])
    expect(dragSection(vp, g, axis, 40, 0)).toBeGreaterThan(0)
    expect(outlineOf(solid)).toBe(outline)
    expect(outline.geometry).not.toBe(placed)
    // This drag carries the plane out of the cube (x = 1.005 to x = 3.005),
    // so the second write is the empty one — the walk to the sites is also
    // what keeps a contour from outliving its plane.
    expect(outline.geometry.instanceCount).toBe(0)
  })
})

describe('clearing the outlines when the cut is suspended', () => {
  it('empties every outline and drops the memo, so the next build is not suppressed', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    expect(vp.sectionOutlineKey).not.toBeNull()
    clearSectionOutlines(vp, g)
    expect(outline.geometry.instanceCount).toBe(0)
    expect(vp.sectionOutlineKey).toBeNull()
    // The same plane again: a stale key would have suppressed this write, and
    // the empty geometry would have been the last word.
    const emptied = outline.geometry
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outline.geometry).not.toBe(emptied)
    expect(outline.geometry.instanceCount).toBe(8)
  })

  it('runs from suspendSectionCut, and drops the memo even with no scene', () => {
    const { solid, viewer, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    suspendSectionCut(vp)
    expect(viewer.setClipSlider).toHaveBeenCalled()
    expect(outlineOf(solid).geometry.instanceCount).toBe(0)
    expect(vp.sectionOutlineKey).toBeNull()
    // No internals: nothing to empty, and the memo still drops.
    const bare = fakeViewport(fakeViewer())
    suspendSectionCut(bare)
    expect(bare.sectionOutlineKey).toBeNull()
  })
})

describe('the outline under the part passes', () => {
  it('hides with its part and comes back with it', () => {
    const { solid, viewer, vp, g } = partScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    applyHidden(viewer, ['S|body'])
    expect(outline.visible).toBe(false)
    applyHidden(viewer, [])
    expect(outline.visible).toBe(true)
  })

  it('reaches an outline built while its part was already hidden', () => {
    // The states already agree with the list, so `setStates` is skipped — the
    // visibility write must not live behind that early return.
    const { solid, viewer, vp, g } = partScene()
    applyHidden(viewer, ['S|body'])
    sectionOutline(vp, g, [1, 0, 0], -1)
    applyHidden(viewer, ['S|body'])
    expect(outlineOf(solid).visible).toBe(false)
    expect(viewer.setStates).toHaveBeenCalledTimes(1)
  })

  it('is born matching its part, because nothing comes back to it', () => {
    // The two passes above reach an outline that already exists, and an
    // outline can be created after both have run: a live reload applies the
    // hidden list inside `show()` and only restores the cut afterwards. A
    // contour floating over a part that is not on screen is the failure.
    const { solid, vp, g } = partScene()
    solid.front.material.visible = false
    solid.front.material.opacity = 0.25
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outlineOf(solid).visible).toBe(false)
    expect(outlineOf(solid).material.opacity).toBe(0.25)
  })

  it('fades with its part and comes back with it, by plain opacity', () => {
    const { solid, viewer, vp, g } = partScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    applyGhost(viewer, ['S|body'])
    expect(outline.material.opacity).toBe(GHOST_OPACITY)
    expect(viewer.update).toHaveBeenCalled()
    applyGhost(viewer, [])
    expect(outline.material.opacity).toBe(1)
  })

  it('fades by the library\'s arithmetic when the part itself is translucent', () => {
    // `alpha` is the model's own transparency: ghosting takes the face to
    // `opacity * alpha`, restoring gives the alpha back. The outline rides
    // that one value, never a literal — a flat number would out-glare the body
    // it belongs to, and a restore to 1 would sit opaque over it.
    //
    // 0.8 rather than a value at or below the ghost's own, because that is where
    // the two directions differ: `applyGhost` divides by the alpha to LAND on
    // GHOST_OPACITY, so the face goes there and comes back to 0.8, and an
    // outline that had copied `group.opacity` instead would read 0.625 in the
    // first place and 0.625 again in the second.
    const { solid, viewer, vp, g } = partScene()
    solid.alpha = 0.8
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    applyGhost(viewer, ['S|body'])
    expect(outline.material.opacity).toBeCloseTo(GHOST_OPACITY)
    applyGhost(viewer, [])
    expect(outline.material.opacity).toBe(0.8)
  })

  it('follows its part through the standing plane when the part moves', () => {
    const { solid, viewer, vp, g } = partScene()
    placeSectionPlane(vp, g, [1, 0, 0], [1, 0, 1])
    // As the interface has it: seeding the plane is what turns `secOn` on, and
    // the move path asks for both — a seed alone survives the cut being
    // switched off, and a switched-off cut has no contour to follow a part.
    vp.state.cut = true
    const outline = outlineOf(solid)
    expect(outline.geometry.instanceCount).toBe(8)
    // Move the part two units along x. The plane has not moved, so the memo
    // alone would hold the redraw off and the contour would stay behind,
    // marking a cut that no longer exists. The fake has no render loop, so
    // the matrixWorld the move carries is set by hand — `movePart` writes
    // only `position`.
    solid.front.matrixWorld = fakeMatrix({ position: [2, 0, 0] })
    const drawn = viewer.update.mock.calls.length
    const before = outline.geometry
    expect(movePart(vp, ['S|body'], [2, 0, 0])).toBe(true)
    expect(outline.geometry).not.toBe(before)
    expect(outline.geometry.instanceCount).toBe(0)
    // TWO draws, and the second one is the point. The library renders on
    // demand, the move's own render happens BEFORE the rebuild (which reads
    // the `matrixWorld` only a render refreshes), so without a second one the
    // corrected contour never reaches the screen and the reader keeps looking
    // at a curve carried off the plane with the part.
    expect(viewer.update.mock.calls.length).toBe(drawn + 2)
    // Put it back — which is the document dropping the entry, so the reconcile
    // is handed nothing at all: the plane cuts the cube again.
    solid.front.matrixWorld = fakeMatrix()
    const emptied = outline.geometry
    reconcileMoves(vp, [])
    expect(outline.geometry).not.toBe(emptied)
    expect(outline.geometry.instanceCount).toBe(8)
  })

  it('follows a PROPOSAL body too, which is a solid like any other', () => {
    // The proposal panel's bodies are staged into the scene (`staged()` in
    // element.js), so the plane clips them and a contour is drawn on them
    // exactly as on a part of the build — and the Move tool drags them through
    // it. `nudgePart` differs from `movePart` in what it REMEMBERS, not in what
    // it draws: a body dragged out from under the plane with its curve left
    // hanging behind is the same failure the test above pins, one source of
    // parts over.
    const { solid, viewer, vp, g } = partScene()
    placeSectionPlane(vp, g, [1, 0, 0], [1, 0, 1])
    vp.state.cut = true
    const outline = outlineOf(solid)
    expect(outline.geometry.instanceCount).toBe(8)

    solid.front.matrixWorld = fakeMatrix({ position: [2, 0, 0] })
    const drawn = viewer.update.mock.calls.length
    // The home is the CALLER'S — the gesture read it at the press — which is the
    // whole difference in the signature.
    const before = outline.geometry
    expect(nudgePart(vp, ['S|body'], [[0, 0, 0]], [2, 0, 0])).toBe(true)

    expect(outline.geometry).not.toBe(before)
    expect(outline.geometry.instanceCount).toBe(0)
    // TWO draws, for the reason spelled out above: the rebuild reads a
    // `matrixWorld` only a render refreshes, and the library draws on demand.
    expect(viewer.update.mock.calls.length).toBe(drawn + 2)
    // And still nothing recorded: the contour is redrawn, the offset is not
    // kept. `restageMoves` walks that map on the panel's very next edit.
    expect(vp.moved.size).toBe(0)
    expect(vp.partHome.size).toBe(0)
  })
})

describe('sectionSegments', () => {
  // The same intersection the contour draws, handed back in WORLD coordinates
  // instead of laid into the solid's own group — which is what lets a question
  // asked in the world ("is the cursor's point inside this cut face") be
  // answered without inverting the solid's matrix.

  /** Every segment as a pair of points, off the flat xyz xyz list. */
  const pairs = (flat) => {
    const out = []
    for (let at = 0; at < flat.length; at += 6) {
      out.push([[flat[at], flat[at + 1], flat[at + 2]],
                [flat[at + 3], flat[at + 4], flat[at + 5]]])
    }
    return out
  }

  // The plane z = 1 as the library carries one: `distanceToPoint(p) = n . p + c`.
  const AT_Z1 = { normal: [0, 0, 1], constant: -1 }

  it('cuts the cube along the square the plane crosses it in', () => {
    const { solid } = cubeScene()
    const segments = pairs(
      sectionSegments(solid.front, AT_Z1.normal, AT_Z1.constant))
    expect(segments).toHaveLength(8)
    expect(totalLength(segments)).toBeCloseTo(8, 9)
    for (const [p, q] of segments) {
      expect(p[2]).toBeCloseTo(1, 9)
      expect(q[2]).toBeCloseTo(1, 9)
      for (const point of [p, q]) {
        expect(point[0]).toBeGreaterThanOrEqual(-1e-9)
        expect(point[0]).toBeLessThanOrEqual(2 + 1e-9)
        expect(point[1]).toBeGreaterThanOrEqual(-1e-9)
        expect(point[1]).toBeLessThanOrEqual(2 + 1e-9)
      }
    }
  })

  it('answers in WORLD coordinates, so a moved part reports where it now is', () => {
    // The whole reason this exists beside the contour. The contour hangs off the
    // solid's group and lets the scene graph place it; nothing places this, so a
    // local answer would put a part that has been dragged five units away back
    // at the origin and the menu would open on it from the wrong pixel.
    const { solid } = cubeScene({ matrix: fakeMatrix({ position: [5, 0, 0] }) })
    const segments = pairs(
      sectionSegments(solid.front, AT_Z1.normal, AT_Z1.constant))
    expect(segments).toHaveLength(8)
    for (const [p, q] of segments) {
      for (const point of [p, q]) {
        expect(point[0]).toBeGreaterThanOrEqual(5 - 1e-9)
        expect(point[0]).toBeLessThanOrEqual(7 + 1e-9)
      }
    }
  })

  it('carries a ROTATION, which a transposed lift would mirror', () => {
    // Every other matrix in this block is diagonal, and a diagonal matrix reads
    // the same down a column as across a row — so transposing the lift survives
    // them all. Rz(90 degrees): local (x, y, z) lands at world (-y, x, z).
    //
    // The world plane y = 1 is the solid's local x = 1, so the cut is the local
    // square in (y, z), and lifting it puts every point at world y = 1 with
    // world x in [-2, 0]. Read down the rows instead and the segments come back
    // at world y = -1: the same shape, mirrored onto the wrong side of the part.
    const { solid } = cubeScene({
      matrix: { elements: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    })
    const segments = pairs(sectionSegments(solid.front, [0, 1, 0], -1))
    expect(segments).toHaveLength(8)
    expect(totalLength(segments)).toBeCloseTo(8, 9)
    for (const [p, q] of segments) {
      for (const point of [p, q]) {
        expect(point[1]).toBeCloseTo(1, 9)
        expect(point[0]).toBeGreaterThanOrEqual(-2 - 1e-9)
        expect(point[0]).toBeLessThanOrEqual(1e-9)
      }
    }
  })

  it('carries the matrix SCALE too, not only the translation', () => {
    const { solid } = cubeScene({ matrix: fakeMatrix({ scale: [3, 3, 3] }) })
    // The cube now spans [0,6]^3, so the plane z = 1 still crosses it and the
    // square it cuts is three times as wide.
    const segments = pairs(
      sectionSegments(solid.front, AT_Z1.normal, AT_Z1.constant))
    expect(totalLength(segments)).toBeCloseTo(24, 9)
  })

  it('is empty when the plane misses the solid altogether', () => {
    const { solid } = cubeScene()
    expect(sectionSegments(solid.front, [0, 0, 1], -9)).toHaveLength(0)
  })

  it('is null when there is no tessellation to intersect', () => {
    expect(sectionSegments({ matrixWorld: fakeMatrix() }, [0, 0, 1], -1)).toBeNull()
    expect(sectionSegments(null, [0, 0, 1], -1)).toBeNull()
  })

  it('is null for a plane with no constant, rather than a buffer of NaN', () => {
    const { solid } = cubeScene()
    expect(sectionSegments(solid.front, [0, 0, 1], undefined)).toBeNull()
  })
})

describe('insideSection', () => {
  // A pure predicate, so it is fed shapes directly rather than through a solid:
  // the cases that matter — a hole, an unordered buffer, a degenerate segment —
  // are awkward to reach through a tessellation and trivial to state here.

  /** A closed loop in the plane z = 1, as the flat `xyz xyz` list the predicate
   *  eats: each corner to the next, wrapping. */
  const loop = (points, z = 1) => {
    const flat = []
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      flat.push(a[0], a[1], z, b[0], b[1], z)
    }
    return flat
  }
  const UP = [0, 0, 1]
  const SQUARE = [[0, 0], [2, 0], [2, 2], [0, 2]]
  const buffer = (...loops) => new Float32Array(loops.flat())

  it('says yes inside the shape and no outside it', () => {
    const shape = buffer(loop(SQUARE))
    expect(insideSection(shape, [1, 1, 1], UP)).toBe(true)
    expect(insideSection(shape, [5, 1, 1], UP)).toBe(false)
    expect(insideSection(shape, [1, -3, 1], UP)).toBe(false)
    // Just inside and just outside the same edge, so a test that answered
    // "somewhere near the shape" fails here.
    expect(insideSection(shape, [1.99, 1, 1], UP)).toBe(true)
    expect(insideSection(shape, [2.01, 1, 1], UP)).toBe(false)
  })

  it('reads a hole as outside, which is what the reader sees there', () => {
    // A cross-section is a set of CLOSED LOOPS and a hole is one of them, so
    // parity gets this right with no notion of which loop is which: a point in
    // the hole crosses the boundary twice.
    const shape = buffer(loop(SQUARE), loop([[0.5, 0.5], [1.5, 0.5],
                                             [1.5, 1.5], [0.5, 1.5]]))
    expect(insideSection(shape, [1, 1, 1], UP)).toBe(false)
    expect(insideSection(shape, [0.25, 1, 1], UP)).toBe(true)
  })

  it('does not care what order the segments arrive in', () => {
    // `planeThroughTriangles` emits one chord per triangle, in triangle order,
    // so the loops it produces are not walked round — and this is the property
    // that lets its output be used as it stands.
    const ordered = loop(SQUARE)
    const shuffled = []
    for (const at of [3, 0, 2, 1]) {
      shuffled.push(...ordered.slice(at * 6, at * 6 + 6))
    }
    // ...and one of them reversed end for end, which a walk would also trip on.
    const [ax, ay, az, bx, by, bz] = shuffled.slice(0, 6)
    shuffled.splice(0, 6, bx, by, bz, ax, ay, az)
    expect(insideSection(new Float32Array(shuffled), [1, 1, 1], UP)).toBe(true)
    expect(insideSection(new Float32Array(shuffled), [3, 1, 1], UP)).toBe(false)
  })

  it('ignores the zero-length segments a vertex on the plane produces', () => {
    // `planeThroughTriangles` emits those deliberately (its own note says why
    // they are harmless to the fat-line shader); here they must not toggle
    // parity, which would turn a point inside the shape into a point outside it.
    const shape = buffer(loop(SQUARE), [1, 1, 1, 1, 1, 1, 0.5, 0.5, 1, 0.5, 0.5, 1])
    // THE SAME THREE ANSWERS THE BARE SQUARE GIVES, asked of a buffer that also
    // carries two degenerate segments — one of them sitting exactly on the ray
    // the first probe casts. Stated as a whole answer rather than as one `true`,
    // because "the degenerates changed nothing" is only worth anything if the
    // reading is discriminating in the first place.
    expect(insideSection(shape, [1, 1, 1], UP)).toBe(true)
    expect(insideSection(shape, [1, -3, 1], UP)).toBe(false)
    expect(insideSection(shape, [5, 1, 1], UP)).toBe(false)
  })

  it('works on a plane no world axis is parallel to', () => {
    // The in-plane basis is derived from the normal, and a projection that
    // ignored it would collapse this plane onto a LINE: it stands vertically,
    // through the world z axis, so dropping z takes every one of its points onto
    // the diagonal y = x and parity stops meaning anything.
    //
    // The same square as above, laid into that plane: `a` runs along the
    // in-plane horizontal and `b` straight up.
    const k = Math.SQRT1_2
    const put = ([a, b]) => [a * k, a * k, b]
    const corners = SQUARE.map(put)
    const flat = []
    for (let i = 0; i < corners.length; i += 1) {
      flat.push(...corners[i], ...corners[(i + 1) % corners.length])
    }
    const shape = new Float32Array(flat)
    const normal = [k, -k, 0]
    expect(insideSection(shape, put([1, 1]), normal)).toBe(true)
    expect(insideSection(shape, put([5, 1]), normal)).toBe(false)
    expect(insideSection(shape, put([1, 5]), normal)).toBe(false)
  })

  it('refuses a buffer too short to close a loop, and a normal with no direction', () => {
    expect(insideSection(new Float32Array([0, 0, 1, 2, 0, 1]), [1, 1, 1], UP))
      .toBe(false)
    expect(insideSection(null, [1, 1, 1], UP)).toBe(false)
    expect(insideSection(buffer(loop(SQUARE)), [1, 1, 1], [0, 0, 0])).toBe(false)
  })
})

describe('the vendored files still say what the outline rests on', () => {
  const bundle = () => repoFile(BUNDLE)
  const threeCore = () => repoFile(THREE_CORE)
  const threeModule = () => repoFile(THREE_MODULE)
  const classBody = (source, declaration) => {
    const start = source.indexOf(declaration)
    expect(start).toBeGreaterThanOrEqual(0)
    return source.slice(start, source.indexOf('\nclass ', start + 1))
  }

  it('builds LineSegments2 on the Mesh base, so _forEachMaterial reaches an outline', () => {
    expect(bundle()).toContain('class LineSegments2 extends Mesh')
  })

  it('keeps setPositions in one stride-6 interleaved buffer', () => {
    // The shape the fat-line fake models: start at offset 0, end at 3.
    expect(bundle()).toContain(
      'new InstancedInterleavedBuffer( lineSegments, 6, 1 )')
    expect(bundle()).toContain(
      'new InterleavedBufferAttribute( instanceBuffer, 3, 0 )')
    expect(bundle()).toContain(
      'new InterleavedBufferAttribute( instanceBuffer, 3, 3 )')
  })

  it('turns shader clipping on in the LineMaterial constructor, so a clone keeps it', () => {
    // TWO FILES, one sentence. `LineMaterial` is a `three/examples/jsm` addon
    // and stays inside the bundle; the `copy` that carries the flag over to a
    // clone is `Material.copy`, three's own, and `external: three` put that in
    // three.core.js.
    expect(classBody(bundle(), 'class LineMaterial')).toContain('clipping: true')
    expect(threeCore()).toContain('this.clipping = source.clipping')
  })

  it('keeps worldUnits a shader define, which is what makes its ABSENCE readable', () => {
    // NOT A FLAG THIS MODULE SETS — outline.js never touches it. What the
    // outline rests on is the SHAPE of it: `worldUnits` is an accessor over
    // `defines` rather than a plain field, so the mode a material is in IS the
    // presence of that define, and it is a live switch — the setter raises
    // `needsUpdate` on the flip — rather than a leftover key. That is what gives
    // `expect(material.defines.WORLD_UNITS).toBeUndefined()` above something to
    // mean: the clone is in the PIXEL branch, not merely missing a field.
    const body = classBody(bundle(), 'class LineMaterial')
    expect(body).toContain('set worldUnits( value )')
    expect(body).toContain('this.defines.WORLD_UNITS')
    expect(body).toContain('this.needsUpdate = true')
    // And a clone starts from its donor's defines, not from an empty set — so
    // an absence on the clone is the DONOR's absence and not an artefact of
    // cloning. That line is `Material.copy`'s, so it is three's own and lives in
    // three.core.js rather than in the bundle the addon is built into.
    expect(threeCore()).toContain('this.defines = Object.assign( {}, source.defines )')
  })

  it('divides the quad by the resolution in the branch the outline is drawn in', () => {
    // WHY `resolution` IS LOAD-BEARING HERE. `linewidth` counts CSS pixels in
    // the DEFAULT branch — the one the outline material is left in — and it is
    // that branch which turns the number into pixels by dividing the quad's
    // offset by the canvas size. So the `resolution` the clone carries is not
    // decoration, and the case below is what keeps it in step with the canvas.
    //
    // CUT AT THE BRANCH AND NOT SEARCHED FOR IN THE WHOLE FILE, because the
    // sentence above is about WHERE the division lives: the string occurs twice
    // in the bundle, and a bare `toContain` would go on passing if the upgrade
    // that moved it put it under `#ifdef WORLD_UNITS` instead.
    const source = bundle()
    const at = source.indexOf('offset /= resolution.y;')
    expect(at, 'the line shader no longer divides by the resolution').toBeGreaterThan(-1)
    const opened = source.lastIndexOf('#ifdef WORLD_UNITS', at)
    const otherwise = source.indexOf('#else', opened)
    expect(opened, 'no world-units branch above it').toBeGreaterThan(-1)
    expect(otherwise, 'the branch has no screen-space half').toBeGreaterThan(opened)
    expect(otherwise, 'the division sits in the WORLD half').toBeLessThan(at)
    const pixels = source.slice(otherwise, source.indexOf('#endif', at))
    // The two together are what makes `linewidth` a pixel count: the offset is
    // scaled by it and then divided by the canvas, in that order and in this
    // half. The world half does neither — it is why a width in world units
    // needed no `resolution` and why this one does.
    expect(pixels).toContain('offset *= linewidth;')
    expect(pixels).toContain('offset /= resolution.y;')
    expect(source.slice(opened, otherwise)).not.toContain('offset /= resolution.y;')
  })

  it('keeps the resolution in step with the canvas at render time', () => {
    expect(classBody(bundle(), 'class LineSegments2 extends Mesh'))
      .toContain('resolution.value.set( _viewport.z, _viewport.w )')
  })

  it('orders its own edges at 999 and a translucent part\'s faces with them', () => {
    // The two numbers the contour's own `renderOrder` has to clear, read off
    // the bundle rather than remembered. The faces one is CONDITIONAL — that
    // condition is the whole per-solid mechanism: an opaque part leaves its
    // faces at 0, a translucent one lifts them over everything ordered lower.
    const source = bundle()
    expect(source).toContain('edges.renderOrder = 999;')
    const at = source.indexOf('back.renderOrder = 999;')
    expect(at, 'the faces are no longer ordered').toBeGreaterThan(-1)
    expect(source.slice(at - 200, at)).toContain('if (alpha < 1.0) {')
  })

  it('still shifts a fat line in x and y alone, which is what the depth patch corrects', () => {
    // The two facts the correction rests on, read off the bundle rather than
    // remembered: the pixel branch widens the quad by moving `clip.xy` and
    // NOTHING else, so the band's depth is the endpoint's across its whole
    // width; and the line the patch hangs off is still spelled that way.
    const source = bundle()
    // CUT AT THE BRANCH, for the reason its neighbour above gives: the string
    // occurs twice in the bundle — once in the visual line shader and once in
    // the pick shader's port of it — and a slice taken from the first hit would
    // go on passing while looking at the wrong one.
    const at = source.indexOf('offset /= resolution.y;')
    expect(at, 'the pixel branch of the line shader is gone').toBeGreaterThan(-1)
    const opened = source.lastIndexOf('#ifdef WORLD_UNITS', at)
    expect(opened, 'no world-units branch above it').toBeGreaterThan(-1)
    const otherwise = source.indexOf('#else', opened)
    expect(otherwise, 'the branch has no screen-space half').toBeGreaterThan(opened)
    expect(otherwise, 'the shift sits in the WORLD half').toBeLessThan(at)
    const branch = source.slice(otherwise, source.indexOf('#endif', at))
    expect(branch).toContain('clip.xy += offset;')
    // `clip.w` IS touched here — `offset *= clip.w` converts the shift back to
    // clip space — and `clip.z` is not touched at all. That second absence is
    // the defect: the widened corner keeps the endpoint's depth.
    expect(branch).toContain('offset *= clip.w;')
    expect(branch).not.toContain('clip.z')
  })

  it('reserves the "clipping" child-name prefix for its own stencils', () => {
    // The outline's name must stay OUTSIDE the prefix the library skips.
    expect(bundle()).toContain('child.name.startsWith("clipping")')
    expect(OUTLINE_NAME.startsWith('clipping')).toBe(false)
  })

  it('fades a LineMaterial with an ordinary opacity, so the ghost pass reaches an outline', () => {
    // The accessor writes the uniform (`set opacity` in
    // three/examples/jsm/lines/LineMaterial.js, which the bundle carries) and
    // the fragment shader reads it as the whole of its alpha — no shader change
    // is needed to ghost the outline.
    const body = classBody(bundle(), 'class LineMaterial')
    expect(body).toContain('get opacity()')
    expect(body).toContain('this.uniforms.opacity.value = value')
    expect(bundle()).toContain('float alpha = opacity;')
  })

  it('builds the edge material transparent, so the outline clone can fade at all', () => {
    const source = bundle()
    const at = source.indexOf('createEdgeMaterial(')
    const body = source.slice(at, source.indexOf('createSimpleEdgeMaterial(', at))
    expect(body).toContain('transparent: true')
  })

  it('still draws a solid\'s own edges one pixel wide, which is the width the contour takes', () => {
    // WHAT THE CONSTANT CLAIMS, held to the bundle. The cut carries no edge of
    // the library's — hiding every contour leaves the boundary of a cut face
    // with no line at all — so the contour IS that edge, and it is drawn at the
    // width the library gives the edges it does draw. A re-vendoring that
    // changed that number would leave the claim beside OUTLINE_WIDTH false with
    // nothing failing.
    expect(bundle(), "the library no longer draws a solid's own edges one pixel wide")
      .toContain('this._renderEdges(edgeList, 1, null, states[1], path)')
  })

  it('still caches the instance count on the geometry, which is why a fill replaces it', () => {
    // THE REASON `writeSegments` EXISTS, held to three's own source so that a
    // re-vendoring which removes the cache says so instead of leaving a
    // geometry swap nobody can explain — and so that the swap is not
    // "simplified" back into a refill in place.
    //
    // three.module.js and not the bundle: both lines are the WebGL renderer's
    // (`WebGLBindingStates.setupVertexAttributes` writes the field,
    // `renderBufferDirect` reads it), and `external: three` moved the renderer
    // out of the bundle entirely.
    //
    // Two lines, and the pair is the mechanism: the count is written ONLY while
    // it is undefined, so it never follows a buffer that grew; and the draw
    // takes the smaller of it and the geometry's own count, so what the cache
    // holds is a CEILING on the segments that reach the screen.
    const source = threeModule()
    expect(source, 'three no longer caches _maxInstanceCount on the geometry')
      .toContain('geometry._maxInstanceCount === undefined')
    expect(source, 'the draw no longer clamps the instance count')
      .toContain('Math.min( geometry.instanceCount, maxInstanceCount )')
  })
})
