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
// from the vendored bundle at the bottom of this file.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { internals } from '../src/viewport/internals.js'
import { GHOST_OPACITY, OUTLINE_WIDTH_FRACTION } from '../src/viewport/options.js'
import {
  OUTLINE_NAME, clearSectionOutlines, insideSection, sectionOutline,
  sectionSegments,
} from '../src/viewport/outline.js'
import {
  applyGhost, applyHidden, movePart, resetMoves,
} from '../src/viewport/parts.js'
import {
  dragSection, placeSectionPlane, sectionAxis, suspendSectionCut,
} from '../src/viewport/section.js'
import {
  fakeMatrix, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

const RECT = { left: 0, top: 0, width: 800, height: 600 }

const repoFile = (path) => readFileSync(resolve(process.cwd(), path), 'utf8')
const BUNDLE = '../static/_v/three-cad-viewer.esm.js'

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
// It matters now that the contour's width comes off a SIGNED area (2A/P), which
// is meaningless on a solid wound half one way and half the other: three of
// this fixture's six faces used to face inwards, and the square below came out
// with an area of exactly zero. The diagonals are unchanged, so every segment
// count and endpoint in this file is what it always was.
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

/** The AREA the contour's width was derived from, read back out of the width.
 *
 *  `outlineWidth` is private, and it need not be exported to be measured: the
 *  width it writes is `f * 2A/P`, and the perimeter P is the total length of the
 *  very segments the outline is carrying — so A comes back out of the two, and
 *  a test can compare it against a cross-section worked out by hand. */
const measuredArea = (outline) => outline.material.linewidth
  * totalLength(segmentsOf(outline)) / (2 * OUTLINE_WIDTH_FRACTION)

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
    sectionOutline(vp, g, [1, 0, 0], -5)
    // The outline object stays — an update, not a rebuild — but it now writes
    // nothing: nothing of the contour cut where the plane USED to be may
    // linger.
    const outline = outlineOf(solid)
    expect(outline).toBeDefined()
    expect(outline.geometry.setPositionsCalls).toBe(2)
    expect(outline.geometry.instanceCount).toBe(0)
  })

  it('builds one outline per solid and updates it instead of stacking', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    sectionOutline(vp, g, [1, 0, 0], -1.5)
    expect(solid.children).toHaveLength(1)
    expect(outlineOf(solid).geometry.setPositionsCalls).toBe(2)
  })

  it('holds the rebuild off while the plane stands still', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outlineOf(solid).geometry.setPositionsCalls).toBe(1)
    // `show()` invalidates by clearing the key — the outline objects died with
    // the scene they hung on, so the next plane has to rebuild even if the
    // numbers repeat the old ones.
    vp.sectionOutlineKey = null
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outlineOf(solid).geometry.setPositionsCalls).toBe(2)
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

  it('clones the edge material dark and part-sized, clipped by the other two planes', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const material = outlineOf(solid).material
    expect(material.clipping).toBe(true)
    // The cut face is the 2 x 2 square, whose 2A/P is 2 * 4 / 8 = 1.
    expect(material.linewidth).toBeCloseTo(OUTLINE_WIDTH_FRACTION, 12)
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
    // A clone: the donor's material is untouched.
    expect(solid.edges.material.linewidth).toBe(1)
  })

  it('measures that width on the MODEL and not on the screen', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const material = outlineOf(solid).material
    expect(material.worldUnits).toBe(true)
    // Not a field but a view onto the shader DEFINES, and the accessor raises
    // `needsUpdate` on the flip itself — which is why outline.js asks for no
    // recompile of its own.
    expect(material.defines.WORLD_UNITS).toBe('')
    expect(material.needsUpdate).toBe(true)
    // The donor is left where the library put it: its own edges are still a
    // count of CSS pixels, and only the clone changed units.
    expect(solid.edges.material.worldUnits).toBe(false)
  })

  it('gives a thin part a proportionally thinner contour than a thick one', () => {
    // THE CLAIM THE FIX IS. A 2 mm wall and a 20 mm post standing side by side,
    // cut by one plane across the thickness of both: each contour is derived
    // from the FACE that plane makes in the part it belongs to and from nothing
    // else, so the ratio of the two lines is the ratio of the two faces.
    const wall = fakeShapeSolid('S|wall', {
      positions: boxPositions(40, 30, 2), index: CUBE_INDEX,
    })
    const post = fakeShapeSolid('S|post', {
      positions: boxPositions(40, 30, 20), index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({ groups: { 'S|wall': wall, 'S|post': post } })
    sectionOutline(vp, g, [1, 0, 0], -20) // the plane x = 20, through both
    const thin = outlineOf(wall).material.linewidth
    const thick = outlineOf(post).material.linewidth
    // 30 x 2 against 30 x 20: 2A/P is 120 / 64 and 1200 / 100. The 40 they
    // share is along the plane's own normal and says nothing about either line.
    expect(thin).toBeCloseTo((120 / 64) * OUTLINE_WIDTH_FRACTION, 12)
    expect(thick).toBeCloseTo((1200 / 100) * OUTLINE_WIDTH_FRACTION, 12)
    expect(thick).toBeGreaterThan(thin * 6)
  })

  it('leaves the thinnest cut face standing, which is the whole of issue #95', () => {
    // The fat line is CENTRED on the edge it marks, so half its width lies
    // inside the face; a cut across a wall has two such edges, and together
    // they eat one whole width of it. At three CSS pixels on a wall occupying
    // four the two met in the middle and the part came back a solid black bar.
    //
    // 2A/P is never WIDER than the face's own narrow way — for a w x L
    // rectangle it is wL / (w + L), under w whatever L is — so the pair eat
    // less than the fraction of the wall, and the fraction is a tenth.
    //
    // FOR A FACE OF ONE THICKNESS, which is the shape a cut across a wall or a
    // shell makes and the shape both bodies below have. A face that is massive
    // in one region and thin in another averages the two, and the thin part can
    // still be eaten: measured, a 40 x 40 x 10 block carrying a 1 mm rib reads
    // 16.0 and would put a 1.6 mm line on the rib. Nobody has met that shape
    // here and nothing is built for it; it is written down so the next reader
    // does not take this measure for a guarantee it does not give.
    const THICKNESS = 2
    const wall = fakeShapeSolid('S|wall', {
      positions: boxPositions(40, 30, THICKNESS), index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({ groups: { 'S|wall': wall } })
    sectionOutline(vp, g, [1, 0, 0], -20)
    const eaten = outlineOf(wall).material.linewidth
    // Not merely "they do not quite meet": most of the face has to survive AS
    // A FACE — coloured and hatched — rather than as a sliver inside a rim.
    expect(eaten).toBeLessThan(THICKNESS * OUTLINE_WIDTH_FRACTION)
    expect(eaten).toBeLessThan(THICKNESS / 2)
  })

  it('leaves a SHELLED body\'s wall standing too, which is where #95 came back', () => {
    // THE CASE THAT REOPENED THE ISSUE. The test above passes on a plate,
    // whose bounding box IS its thickness; this is the other kind of solid,
    // and it is the kind `model_template/model.py` builds — one body, thin
    // walls, a fat box. Sized off the box the contour was 0.1 * 20 = 2.0 mm
    // against a cut face 2.4 mm across, so the two lines ate 2.0 of the 2.4 and
    // the wall came back as the dark bar the issue is about — at every zoom,
    // this time, because a world-unit width holds the ratio however close the
    // reader leans in.
    const WALL = 2.4
    const shell = shelledBox([50.8, 33.8, 20], WALL)
    const body = fakeShapeSolid('S|body', shell)
    const { vp, g } = solidScene({ groups: { 'S|body': body } })
    // z = 10, half way up: the cut face is the RING of the four walls.
    sectionOutline(vp, g, [0, 0, 1], -10)
    const eaten = outlineOf(body).material.linewidth
    // The box says 20 and the face says 2.4 — the whole distance between the
    // two measures, and what the old rule would have eaten.
    const box = body.front.geometry.boundingBox
    expect(Math.min(box.max.x - box.min.x, box.max.y - box.min.y,
                    box.max.z - box.min.z)).toBeCloseTo(20, 9)
    expect(eaten).toBeCloseTo(WALL * OUTLINE_WIDTH_FRACTION, 6)
    expect(WALL - eaten).toBeCloseTo(WALL * (1 - OUTLINE_WIDTH_FRACTION), 6)
    expect(eaten).toBeLessThan(20 * OUTLINE_WIDTH_FRACTION / 8)
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

describe('the contour\'s width, measured on the cut face', () => {
  // `outlineWidth` is `OUTLINE_WIDTH_FRACTION * 2A/P` of the face the plane
  // makes, and the two halves of that are read off the section segments before
  // any material exists. The perimeter is the easy one — the segments' own
  // total length. The AREA is a signed sum, so it is the one that can be wrong
  // without anything looking wrong, and every case below compares it against a
  // cross-section worked out by hand.

  it('cuts a solid wound outward, the way a real tessellation is', () => {
    // The whole measure rests on it: a signed area summed over a solid wound
    // half one way and half the other is not the face's area and not anything
    // else either. Pinned here because the fixture used to fail it, and the
    // failure was invisible — a plausible contour of exactly the wrong width.
    expect(woundOutward(CUBE_POSITIONS, CUBE_INDEX, [1, 1, 1])).toBe(true)
  })

  it('measures a known area: the square a cube is cut in', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    // The 2 x 2 square: A = 4, P = 8, so 2A/P = 1 — and the width a tenth of it.
    expect(totalLength(segmentsOf(outline))).toBeCloseTo(8, 9)
    expect(measuredArea(outline)).toBeCloseTo(4, 6)
    expect(outline.material.linewidth).toBeCloseTo(OUTLINE_WIDTH_FRACTION, 12)
  })

  it('measures a known area on a face no axis is parallel to', () => {
    // The corner-on hexagon, side sqrt(2): A = 3 sqrt(3), P = 6 sqrt(2), so
    // 2A/P is sqrt(3/2). Every axis-aligned case above leaves two of the three
    // terms of the cross product multiplied by a zero component of the normal,
    // and this one weights all three — a sum that dropped one would still be
    // exactly right on the square and wrong here.
    const { solid, vp, g } = cubeScene()
    const third = 1 / Math.sqrt(3)
    sectionOutline(vp, g, [third, third, third], -Math.sqrt(3))
    const outline = outlineOf(solid)
    expect(totalLength(segmentsOf(outline))).toBeCloseTo(6 * Math.SQRT2, 9)
    expect(measuredArea(outline)).toBeCloseTo(3 * Math.sqrt(3), 6)
    expect(outline.material.linewidth).toBeCloseTo(
      OUTLINE_WIDTH_FRACTION * Math.sqrt(1.5), 6)
  })

  it('normalises the local normal, which the part\'s matrix may have scaled', () => {
    // The area is a projection onto the plane's normal, so that normal has to
    // be UNIT — and the one the segments are measured against is the LOCAL one,
    // which `localPlane` leaves carrying whatever the matrix scales by. Here
    // diag(2, 1, 1) doubles it, so a sum taken against it as it stands doubles
    // the area and the width with it, and every unscaled case above misses it.
    //
    // The cube spans world x in [0, 4]; the world plane x = 2 is its own local
    // x = 1, and the face is the same 2 x 2 square as the first case, measured
    // in the frame the segments are laid down in.
    const { solid, vp, g } = cubeScene({
      matrix: { elements: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    })
    sectionOutline(vp, g, [1, 0, 0], -2)
    const outline = outlineOf(solid)
    expect(measuredArea(outline)).toBeCloseTo(4, 6)
    expect(outline.material.linewidth).toBeCloseTo(OUTLINE_WIDTH_FRACTION, 12)
  })

  it('reads a ring-shaped cut face as the wall it is', () => {
    // The measure's whole reason for being. Outer 50.8 x 33.8, wall 2.4, cut
    // half way up: the face is the ring between 50.8 x 33.8 and 46 x 29, so
    // A = 1717.04 - 1334 = 383.04 and P = 169.2 + 150 = 319.2 — and 2A/P comes
    // out at the wall's own 2.4, exactly.
    //
    // The area is also what says the cavity is wound INTO itself the way a void
    // is: wound the other way its loop would ADD instead of subtracting, and
    // the face would read 3051 rather than 383.
    const shell = shelledBox([50.8, 33.8, 20], 2.4)
    const body = fakeShapeSolid('S|body', shell)
    const { vp, g } = solidScene({ groups: { 'S|body': body } })
    sectionOutline(vp, g, [0, 0, 1], -10)
    const outline = outlineOf(body)
    expect(totalLength(segmentsOf(outline))).toBeCloseTo(319.2, 3)
    expect(measuredArea(outline)).toBeCloseTo(383.04, 3)
    expect(outline.material.linewidth / OUTLINE_WIDTH_FRACTION)
      .toBeCloseTo(2.4, 5)
  })

  it('reads the same box left solid as the chunky face it is', () => {
    // The other half of the pair, and the number the bounding box could never
    // tell apart from the one above: same box, no cavity, 2A/P = 20.3.
    const plate = fakeShapeSolid('S|plate', {
      positions: boxPositions(50.8, 33.8, 20), index: CUBE_INDEX,
    })
    const { vp, g } = solidScene({ groups: { 'S|plate': plate } })
    sectionOutline(vp, g, [0, 0, 1], -10)
    const outline = outlineOf(plate)
    expect(measuredArea(outline)).toBeCloseTo(50.8 * 33.8, 2)
    expect(outline.material.linewidth / OUTLINE_WIDTH_FRACTION)
      .toBeCloseTo(2 * 50.8 * 33.8 / (2 * (50.8 + 33.8)), 4)
  })

  it('directs the chords by the sign they cross on, not by the edge walk', () => {
    // THE PREMISE THE AREA RESTS ON, measured rather than assumed. The same
    // solid, the same winding, the same cut — only each triangle's vertex list
    // rotated, which no tessellator promises not to do. Directed by the accident
    // of which crossing the walk met first, half of a solid's chords come back
    // reversed against the other half and the signed area collapses: on the
    // payload fixture's own cylinder, cut through its axis, it collapsed to
    // EXACTLY ZERO — a face 96 mm^2 across reported as no face at all, and a
    // contour of width zero.
    const shell = shelledBox([50.8, 33.8, 20], 2.4)
    const straight = fakeShapeSolid('S|straight', shell)
    const rotated = fakeShapeSolid('S|rotated', {
      positions: shell.positions, index: rotateTriangles(shell.index),
    })
    const { vp, g } = solidScene({
      groups: { 'S|straight': straight, 'S|rotated': rotated },
    })
    sectionOutline(vp, g, [0, 0, 1], -10)
    expect(measuredArea(outlineOf(rotated)))
      .toBeCloseTo(measuredArea(outlineOf(straight)), 6)
    expect(outlineOf(rotated).material.linewidth / OUTLINE_WIDTH_FRACTION)
      .toBeCloseTo(2.4, 5)
  })

  it('rewrites the width when the plane slides onto a face of another shape', () => {
    // A cut face is not a property of the solid, so the width cannot be one
    // either: the same shelled body reads 2.4 across at half height, where the
    // plane crosses four walls, and 20.3 down at the floor, where it crosses a
    // solid slab. An update path that only wrote the segments would leave the
    // floor wearing the wall's hairline.
    const body = fakeShapeSolid('S|body', shelledBox([50.8, 33.8, 20], 2.4))
    const { vp, g } = solidScene({ groups: { 'S|body': body } })
    sectionOutline(vp, g, [0, 0, 1], -10)
    const outline = outlineOf(body)
    const material = outline.material
    expect(material.linewidth / OUTLINE_WIDTH_FRACTION).toBeCloseTo(2.4, 5)
    // z = 1.2, below the cavity's floor at z = 2.4.
    sectionOutline(vp, g, [0, 0, 1], -1.2)
    expect(outlineOf(body)).toBe(outline)
    expect(outline.material).toBe(material)
    expect(outline.geometry.setPositionsCalls).toBe(2)
    expect(material.linewidth / OUTLINE_WIDTH_FRACTION)
      .toBeCloseTo(2 * 50.8 * 33.8 / (2 * (50.8 + 33.8)), 4)
  })

  it('draws no contour at all where there is no face to rim', () => {
    // Zero, and zero is the honest answer: a fat line of no width rasterises
    // nothing, which is what a plane that found no closed area should leave.
    // One triangle lying IN the plane is the case — the box test passes, so the
    // outline is created, and no crossing reaches it to have a width measured.
    const flat = fakeShapeSolid('S|flat', {
      positions: new Float32Array([1, 0, 0, 1, 2, 0, 1, 0, 2]),
      index: new Uint32Array([0, 1, 2]),
    })
    const { vp, g } = solidScene({ groups: { 'S|flat': flat } })
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outlineOf(flat).material.linewidth).toBe(0)
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
    expect(outline.geometry.setPositionsCalls).toBe(1)
    const axis = sectionAxis(viewer, g, [0, 0, 0])
    expect(dragSection(vp, g, axis, 40, 0)).toBeGreaterThan(0)
    expect(outlineOf(solid)).toBe(outline)
    expect(outline.geometry.setPositionsCalls).toBe(2)
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
    sectionOutline(vp, g, [1, 0, 0], -1)
    expect(outline.geometry.setPositionsCalls).toBe(3)
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
    expect(movePart(vp, ['S|body'], [2, 0, 0])).toBe(true)
    expect(outline.geometry.setPositionsCalls).toBe(2)
    expect(outline.geometry.instanceCount).toBe(0)
    // TWO draws, and the second one is the point. The library renders on
    // demand, the move's own render happens BEFORE the rebuild (which reads
    // the `matrixWorld` only a render refreshes), so without a second one the
    // corrected contour never reaches the screen and the reader keeps looking
    // at a curve carried off the plane with the part.
    expect(viewer.update.mock.calls.length).toBe(drawn + 2)
    // Put it back: the plane cuts the cube again.
    solid.front.matrixWorld = fakeMatrix()
    resetMoves(vp)
    expect(outline.geometry.setPositionsCalls).toBe(3)
    expect(outline.geometry.instanceCount).toBe(8)
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

describe('the vendored bundle still says what the outline rests on', () => {
  const bundle = () => repoFile(BUNDLE)
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
    expect(classBody(bundle(), 'class LineMaterial')).toContain('clipping: true')
    expect(bundle()).toContain('this.clipping = source.clipping')
  })

  it('makes worldUnits a shader define whose own setter asks for the recompile', () => {
    // Both halves of what outline.js leans on: the flag is a real accessor on
    // LineMaterial rather than a plain field, and flipping it raises
    // `needsUpdate` inside the setter — so nothing on our side has to.
    const body = classBody(bundle(), 'class LineMaterial')
    expect(body).toContain('set worldUnits( value )')
    expect(body).toContain('this.defines.WORLD_UNITS')
    expect(body).toContain('this.needsUpdate = true')
    // And a clone starts from its donor's defines, not from an empty set.
    expect(bundle()).toContain('this.defines = Object.assign( {}, source.defines )')
  })

  it('widens the world-units quad by the linewidth alone, no resolution in it', () => {
    // Why a width in world units needs no per-frame update and no camera hook:
    // under WORLD_UNITS the vertex shader offsets the quad in VIEW SPACE by
    // half the linewidth, and the division by `resolution` that turns the
    // number into a count of CSS pixels lives in the OTHER branch alone.
    const source = bundle()
    const from = source.indexOf('float hw = linewidth * 0.5;')
    expect(from).toBeGreaterThanOrEqual(0)
    const worldBranch = source.slice(
      from, source.indexOf('vec2 offset = vec2( dir.y, - dir.x );', from))
    expect(worldBranch).toContain('hw * worldUp')
    expect(worldBranch).not.toContain('resolution')
    expect(source).toContain('offset /= resolution.y;')
  })

  it('keeps the resolution in step with the canvas at render time', () => {
    expect(classBody(bundle(), 'class LineSegments2 extends Mesh'))
      .toContain('resolution.value.set( _viewport.z, _viewport.w )')
  })

  it('reserves the "clipping" child-name prefix for its own stencils', () => {
    // The outline's name must stay OUTSIDE the prefix the library skips.
    expect(bundle()).toContain('child.name.startsWith("clipping")')
    expect(OUTLINE_NAME.startsWith('clipping')).toBe(false)
  })

  it('fades a LineMaterial with an ordinary opacity, so the ghost pass reaches an outline', () => {
    // The accessor writes the uniform (:80616) and the fragment shader reads
    // it as the whole of its alpha — no shader change is needed to ghost the
    // outline.
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
})
