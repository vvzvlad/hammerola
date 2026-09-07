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
import {
  OUTLINE_NAME, clearSectionOutlines, sectionOutline,
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

// A cube spanning [0,2]^3, two triangles per face, corners numbered in z runs.
const CUBE_POSITIONS = new Float32Array([
  0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, // z = 0
  0, 0, 2, 2, 0, 2, 2, 2, 2, 0, 2, 2, // z = 2
])
const CUBE_INDEX = new Uint32Array([
  0, 1, 2, 0, 2, 3, // z = 0, diagonal corner 0 - corner 2
  4, 5, 6, 4, 6, 7, // z = 2
  0, 5, 4, 0, 1, 5, // y = 0
  3, 2, 6, 3, 6, 7, // y = 2
  0, 3, 7, 0, 7, 4, // x = 0
  1, 2, 6, 1, 6, 5, // x = 2
])

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
    // Plane x + y + z = 3, through the cube's centre corner-on.
    sectionOutline(vp, g, [1, 1, 1], -3)
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

  it('clones the edge material thick and dark, clipped by the other two planes', () => {
    const { solid, vp, g } = cubeScene()
    sectionOutline(vp, g, [1, 0, 0], -1)
    const material = outlineOf(solid).material
    expect(material.clipping).toBe(true)
    expect(material.linewidth).toBe(3)
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
    expect(outline.material.opacity).toBe(0.25)
    expect(viewer.update).toHaveBeenCalled()
    applyGhost(viewer, [])
    expect(outline.material.opacity).toBe(1)
  })

  it('fades by the library\'s arithmetic when the part itself is translucent', () => {
    // `alpha` is the model's own transparency: ghosting takes the face to
    // `opacity * alpha`, restoring gives the alpha back. The outline rides
    // that one value, never a literal — a flat 0.25 would out-glare the body
    // it belongs to, and a restore to 1 would sit opaque over it.
    const { solid, viewer, vp, g } = partScene()
    solid.alpha = 0.5
    sectionOutline(vp, g, [1, 0, 0], -1)
    const outline = outlineOf(solid)
    applyGhost(viewer, ['S|body'])
    expect(outline.material.opacity).toBe(0.125)
    applyGhost(viewer, [])
    expect(outline.material.opacity).toBe(0.5)
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
