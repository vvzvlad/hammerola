// viewer/src/scene/clipping.ts — which solids get a cap on the cut.
//
// The stencil cap is right only for a closed surface wound one way: on an open
// mesh (a board's copper, mask and silkscreen, a decal) it paints the whole
// sheet onto the plane, and on a closed one with triangles wound against each
// other it paints those triangles. `closedSurface` decides, from the leaf
// alone: a B-rep leaf (it has edges) always, a mesh leaf when every welded edge
// is walked as often from one end as from the other.
//
// Reached through the shipped bundle, as peeling.test.js explains: the cull
// constants, the two functions and `class Clipping` are cut out of its text and
// run against three's own module.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'

const SOURCE = readFileSync(resolve(process.cwd(), '../static/_v/three-cad-viewer.esm.js'), 'utf8')

/** From the cull constants to the end of `meshClosed`, then `class Clipping`. */
function library() {
  const start = SOURCE.indexOf('const CAP_CULL_MIN_PX = ')
  const last = SOURCE.indexOf('function meshClosed(', start)
  const at = SOURCE.indexOf('class Clipping extends THREE.Group {', last)
  if (start < 0 || last < 0 || at < 0) {
    throw new Error('the bundle no longer declares closedSurface, meshClosed and Clipping')
  }
  const end = SOURCE.indexOf('\n}\n', last) + 3
  const close = SOURCE.indexOf('\n}\n', at) + 3
  return new Function('THREE', `${SOURCE.slice(start, end)}${SOURCE.slice(at, close)}
return { closedSurface, Clipping };`)(THREE)
}

const { closedSurface, Clipping } = library()

// A unit cube's six faces, each with corners of its own, as a mesh leaf
// writes them (`_mesh_leaf` in src/cadbuild/views.py).
const FACES = [
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
]

/** A solid group as nestedgroup.ts builds one: `edges` set for a B-rep leaf,
 *  null for a mesh leaf, and its geometry indexed. */
function leaf(faces, { edges = false } = {}) {
  const positions = []
  const index = []
  for (const face of faces) {
    const base = positions.length / 3
    for (const corner of face) positions.push(...corner)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geometry.setIndex(index)
  return { edges: edges ? {} : null, shapeGeometry: geometry }
}

describe('which solids are capped on the cut', () => {
  it('caps a mesh whose faces close up, each face with corners of its own', () => {
    expect(closedSurface(leaf(FACES))).toBe(true)
  })

  it('does not cap a mesh with a face missing', () => {
    expect(closedSurface(leaf(FACES.slice(1)))).toBe(false)
  })

  it('does not cap a sheet on top of one facing down, as a board layer pair is', () => {
    expect(closedSurface(leaf([FACES[0], FACES[1]]))).toBe(false)
  })

  it('does not cap a closed mesh with one face wound the wrong way', () => {
    const faces = FACES.map((face) => [...face])
    faces[0].reverse()
    expect(closedSurface(leaf(faces))).toBe(false)
  })

  it('caps a mesh turned inside out as a whole', () => {
    expect(closedSurface(leaf(FACES.map((face) => [...face].reverse())))).toBe(true)
  })

  it('welds a corner written as -0 with the same corner written as 0', () => {
    const faces = FACES.map((face) => face.map((corner) => [...corner]))
    faces[0][0] = [-0, -0, -0]
    expect(closedSurface(leaf(faces))).toBe(true)
  })

  it('caps a B-rep solid without testing its tessellation', () => {
    expect(closedSurface(leaf(FACES.slice(1), { edges: true }))).toBe(true)
  })

  it('has cull take the stencil and the cap of an open mesh off, and keep a closed one', () => {
    // A cap unit as `_createStencils` builds one, for one plane.
    const unit = (solid) => ({
      solid, stencilGroups: [{ visible: true }], capMeshes: [{ index: 0, visible: true }],
      radiusPx: 0, closed: null,
    })
    const sheets = unit(leaf([FACES[0], FACES[1]]))
    const cube = unit(leaf(FACES))
    // Both on screen, both straddled by the plane at z = 0.5.
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1))
    const clipping = {
      _capUnits: [sheets, cube],
      _cullActive: true,
      _radiiScratch: [],
      clipPlanes: [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0.5)],
      _solidScreenRadius: () => 100,
      _solidWorldBox: () => box,
    }
    Clipping.prototype.cull.call(clipping, new THREE.OrthographicCamera(), 800, 600, true)
    expect([sheets.stencilGroups[0].visible, sheets.capMeshes[0].visible]).toEqual([false, false])
    expect([cube.stencilGroups[0].visible, cube.capMeshes[0].visible]).toEqual([true, true])
  })
})
