// ui/src/viewport/picking.js — and in particular the one thing under the cursor
// the GPU picker cannot see: the stencil cap that closes a section cut off.
//
// NO GPU HERE, so `pickEntity` and `faceNormalAt` — which are readbacks off a
// render target and nothing else — are not what this file is about. What IS
// assertable without one is the whole of the cut-face correction, because every
// step of it is arithmetic: a pixel becomes a ray, the ray meets the section
// plane, and the point it lands on is tested against each solid's cross-section.
// The scene is the suite's 10 mm cube, cut by a plane the real `placeSectionPlane`
// lays on it, and the answers are checked against the parts the plane actually
// crosses.
//
// The vendored facts this correction rests on are read straight out of the
// shipped files at the bottom, in the style outline.test.js and hatch.test.js
// established: when three-cad-viewer is next updated they fail loudly, which is
// the only warning available for a mechanism that reads private fields. Since
// the fork builds with `external: three` those facts live in two places — the
// library's own code in the bundle, three's own in static/_v/three.module.js.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { projectPoint } from '../src/viewport/camera.js'
import { internals } from '../src/viewport/internals.js'
import { capOwnerAt, nameOf, planePointAt, solidOf } from '../src/viewport/picking.js'
import { SECTION_INDEX } from '../src/viewport/options.js'
import { applySection, placeSectionPlane } from '../src/viewport/section.js'
import { RECT } from './component.js'
import {
  fakeCapUnits, fakeShapeSolid, fakeViewer, fakeViewport, orthoCamera,
} from './fakes.js'

/** A repo file, MEMOISED: the two below are megabytes each and every `it()` in
 *  the last block would otherwise re-read one. */
const sources = new Map()
const repoFile = (path) => {
  if (!sources.has(path)) {
    sources.set(path, readFileSync(resolve(process.cwd(), path), 'utf8'))
  }
  return sources.get(path)
}

/** The library's own code, and three's. They are separate files since the fork
 *  in `viewer/` started building with `external: three`: the bundle holds
 *  three-cad-viewer plus the `three/examples/jsm` addons it uses, while three
 *  itself — the clipping shader chunks among it — ships as three.module.js with
 *  three.core.js behind it. */
const BUNDLE = '../static/_v/three-cad-viewer.esm.js'
const THREE_MODULE = '../static/_v/three.module.js'

/** A cube of side 2 with its near-bottom corner at `origin`, two triangles per
 *  face — the same tessellation outline.test.js intersects, moved. */
function cube(origin = [0, 0, 0]) {
  const [ox, oy, oz] = origin
  const positions = new Float32Array([
    ox, oy, oz, ox + 2, oy, oz, ox + 2, oy + 2, oz, ox, oy + 2, oz,
    ox, oy, oz + 2, ox + 2, oy, oz + 2, ox + 2, oy + 2, oz + 2, ox, oy + 2, oz + 2,
  ])
  const index = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    0, 5, 4, 0, 1, 5,
    3, 2, 6, 3, 6, 7,
    0, 3, 7, 0, 7, 4,
    1, 2, 6, 1, 6, 5,
  ])
  return { positions, index }
}

/**
 * A viewport looking straight down -Z at a scene of cubes, with a cut standing.
 *
 * `parts` is `[path, name, origin, matrix]` tuples: the SLASH path the tree and
 * the menu use as the key, the PIPE name the library writes on the group itself,
 * where the cube sits, and optionally the world matrix its group carries. The
 * two spellings are deliberately not each other's transform in some of the tests
 * below — that is the point of looking the path up by identity.
 *
 * The plane is laid by the REAL `placeSectionPlane`, so the gate this correction
 * gets past is the one the interface produces: a seed, and the renderer's
 * clipping flag that `keepSectionCut` turns on. It also leaves the eye on the
 * CLIPPED side, because `placeSectionPlane` turns the seed normal away from the
 * camera — the pose the correction is allowed to fire in.
 */
function cutScene(parts, { cut = [1, 1, 1], omit = [] } = {}) {
  const camera = orthoCamera({
    eye: [0, 0, 80], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1],
  })
  const solids = parts.map(([, name, origin, matrix]) =>
    fakeShapeSolid(name, { ...cube(origin), matrix }))
  const groups = Object.fromEntries(
    parts.map(([path], at) => [path, solids[at]]))
  const viewer = fakeViewer({
    camera, groups, capUnits: fakeCapUnits(solids, { omit }), rect: RECT,
  })
  const vp = fakeViewport(viewer)
  const g = internals(viewer)
  // Down the +z face of the first cube, which is the face a reader would click
  // to cut it. The cut then stands the way the interface stands one.
  expect(placeSectionPlane(vp, g, [0, 0, 1], cut)).toBe(true)
  viewer.setLocalClipping(true)
  return { camera, groups, solids, viewer, vp, g }
}

/** Rz(90 degrees), column-major as `Object3D.matrixWorld` carries it: a local
 *  (x, y, z) lands at world (-y, x, z). The same turn `outline.test.js` pins
 *  the local-frame arithmetic with. */
const QUARTER_TURN = {
  elements: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
}

/**
 * The NDC of the pixel a world point sits under.
 *
 * Through the module's own `projectPoint` rather than by hand: under this ortho
 * camera the depth does not reach the answer, so `[x, y, anything]` names the
 * pixel above `(x, y)` and the test never has to know where along the ray the
 * plane ended up.
 */
const pixelOver = (g, x, y) => projectPoint(g, [x, y, 0]).slice(0, 2)

const PLATE = ['/model/plate', 'model|plate', [0, 0, 0]]
// Flush underneath, exactly as the part that used to answer for the cut face:
// the plane does not cross it, so it must never be the answer.
const SPACER = ['/model/reference_spacer', 'model|reference_spacer', [0, 0, -2]]

describe('solidOf and nameOf', () => {
  it('strips a topo tail down to the solid, and reads the last name off it', () => {
    expect(solidOf({ path: '/model/plate/faces/faces_12' })).toBe('/model/plate')
    expect(solidOf({ path: '/model/plate/edges/edges_3' })).toBe('/model/plate')
    expect(solidOf({ path: '/model/plate/vertices/vertices_1' }))
      .toBe('/model/plate')
    expect(nameOf('/model/plate')).toBe('plate')
  })

  it('prefers the solidPath the library supplies over the tail it would strip', () => {
    expect(solidOf({ solidPath: '/a/b', path: '/somewhere/else/faces/faces_0' }))
      .toBe('/a/b')
  })

  it('is null for nothing at all', () => {
    expect(solidOf(null)).toBeNull()
    expect(nameOf(null)).toBeNull()
  })
})

describe('planePointAt', () => {
  it('lands ON the section plane, under the pixel it was asked about', () => {
    const { camera, vp, g } = cutScene([PLATE])
    const ndc = pixelOver(g, 1, 1)
    const { point } = planePointAt(vp, g, ndc)
    // Two claims, and they are the whole of what this function owes anybody:
    // the point is on the plane, and it is under that pixel.
    expect(g.plane.distanceToPoint({ x: point[0], y: point[1], z: point[2] }))
      .toBeCloseTo(0, 9)
    const back = camera.project(point)
    expect(back[0]).toBeCloseTo(ndc[0], 9)
    expect(back[1]).toBeCloseTo(ndc[1], 9)
  })

  it('moves with the pixel rather than answering one point for the canvas', () => {
    const { vp, g } = cutScene([PLATE])
    const here = planePointAt(vp, g, pixelOver(g, 1, 1)).point
    const there = planePointAt(vp, g, pixelOver(g, 7, -3)).point
    expect(here[0]).toBeCloseTo(1, 9)
    expect(here[1]).toBeCloseTo(1, 9)
    expect(there[0]).toBeCloseTo(7, 9)
    expect(there[1]).toBeCloseTo(-3, 9)
  })

  it('reports the slope as `normal . dir`, the ray\'s approach to the plane', () => {
    // The second half of the answer, and the one the cut-face resolver gates on:
    // the rate at which the signed distance grows as the ray advances. Here the
    // camera looks down -Z and `placeSectionPlane` has turned the normal away
    // from it, so the ray closes on the plane from the clipped half at exactly
    // one unit of distance per unit of travel.
    const { vp, g } = cutScene([PLATE])
    const [, , nz] = g.plane.normal
    expect(nz).toBe(-1)
    expect(planePointAt(vp, g, pixelOver(g, 1, 1)).slope).toBeCloseTo(1, 9)
    // It is the same number for every pixel under ortho, where the rays are
    // parallel — which is what makes it a fact about the POSE.
    expect(planePointAt(vp, g, pixelOver(g, 7, -3)).slope).toBeCloseTo(1, 9)
  })

  it('is null when the ray runs parallel to the plane', () => {
    // The reader looking along the cut edge-on: there is no point on the plane
    // under that pixel at all, and `sectionAxis` refuses to drag a plane in the
    // same pose for the same reason.
    const { viewer, vp, g } = cutScene([PLATE])
    viewer.setClipNormal(SECTION_INDEX, [1, 0, 0], 0)
    expect(planePointAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
  })

  it('is null when the camera basis is unusable', () => {
    const { viewer, vp, g } = cutScene([PLATE])
    viewer.target = [0, NaN, 0]
    expect(planePointAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
  })
})

describe('capOwnerAt', () => {
  it('answers with the part whose cross-section covers the pixel', () => {
    const { vp, g } = cutScene([PLATE])
    const entity = capOwnerAt(vp, g, pixelOver(g, 1, 1))
    expect(entity).toMatchObject({
      id: '/model/plate', name: 'plate', path: '/model/plate', topo: 'face',
    })
    // The point comes back too, in the shape `pickEntity` uses, and it is on
    // the plane — a menu opened from here is opened at a place, not at a guess.
    expect(entity.point[0]).toBeCloseTo(1, 9)
    expect(entity.point[1]).toBeCloseTo(1, 9)
    expect(g.plane.distanceToPoint({
      x: entity.point[0], y: entity.point[1], z: entity.point[2],
    })).toBeCloseTo(0, 9)
  })

  it('is null for a pixel outside every cross-section', () => {
    // Empty space beside the model, with the cut standing. The menu then falls
    // through to the picker exactly as it always did, which is how it closes.
    const { vp, g } = cutScene([PLATE])
    expect(capOwnerAt(vp, g, pixelOver(g, 9, 9))).toBeNull()
    // ...and just outside the cut face, so an answer of "anywhere near the
    // model" fails here.
    expect(capOwnerAt(vp, g, pixelOver(g, 2.05, 1))).toBeNull()
    expect(capOwnerAt(vp, g, pixelOver(g, 1.95, 1))).not.toBeNull()
  })

  it('never answers with a part the plane does not cut, however close it lies', () => {
    // ISSUE #73, MEASURED IN A BROWSER: the cut face of `plate` opened the menu
    // for `reference_spacer`, which sits flush underneath and is what the id
    // picker reads through the id-less cap quad to. The spacer is listed FIRST
    // here so a loop that answered with the first unit it looked at fails.
    const { vp, g } = cutScene([SPACER, PLATE])
    expect(capOwnerAt(vp, g, pixelOver(g, 1, 1)).id).toBe('/model/plate')
  })

  it('takes the path from the group KEY, not from the name on the group', () => {
    // `nestedGroup.groups` is keyed by the slash path; the name on the group is
    // the library's pipe spelling of it, and a model is free to contain a pipe
    // of its own — so the key is found by matching the group object.
    const { vp, g } = cutScene([['/model/plate', 'a|b|c', [0, 0, 0]]])
    expect(capOwnerAt(vp, g, pixelOver(g, 1, 1)))
      .toMatchObject({ id: '/model/plate', name: 'plate' })
  })

  it('follows a part that its matrix has turned', () => {
    // Every other scene here carries an identity matrix, where a cross-section
    // lifted into world coordinates by a TRANSPOSED matrix is indistinguishable
    // from one lifted correctly. Rz(90) sends the cube's local x in [0,2] to
    // world x in [-2,0], so the two readings land on opposite sides of the
    // origin and the cursor tells them apart.
    const { vp, g } = cutScene(
      [['/model/plate', 'model|plate', [0, 0, 0], QUARTER_TURN]],
      { cut: [-1, 1, 1] })
    expect(capOwnerAt(vp, g, pixelOver(g, -1, 1)).id).toBe('/model/plate')
    // Where the part would be if the lift dropped the turn on the floor.
    expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
  })

  it('is null when the solid is not in the group tree under any key', () => {
    const { groups, vp, g } = cutScene([PLATE])
    delete groups['/model/plate']
    expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
  })

  describe('a cap that is not on screen', () => {
    it('does not win when the library has culled it', () => {
      const { viewer, vp, g } = cutScene([PLATE])
      const [unit] = viewer.clipping._capUnits
      unit.capMeshes.find((c) => c.index === SECTION_INDEX).visible = false
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('ignores the OTHER planes\' caps being culled', () => {
      // Only the section plane's cap is the cut face a reader clicks; the
      // library's two other planes are parked and their caps say nothing.
      const { viewer, vp, g } = cutScene([PLATE])
      const [unit] = viewer.clipping._capUnits
      for (const cap of unit.capMeshes) {
        if (cap.index !== SECTION_INDEX) cap.visible = false
      }
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).not.toBeNull()
    })

    it('does not win when the part is hidden', () => {
      // Hiding writes `material.visible` on the front face and on the solid's
      // own stencils; the cap mesh stays visible and paints nothing, so this
      // cannot be read off the cap.
      const { solids, vp, g } = cutScene([PLATE])
      solids[0].front.material.visible = false
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('does not win when the solid group itself is switched off', () => {
      const { solids, vp, g } = cutScene([PLATE])
      solids[0].visible = false
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('does not win when the unit has no cap for the SECTION plane', () => {
      // `capMeshes` is filled plane-major, so a unit the library's loop skipped
      // for plane 0 has the rest shifted along and `capMeshes[SECTION_INDEX]`
      // hands back plane 1's cap with nothing on it to say so. No cap for the
      // section plane means no cut face for this solid, whatever the others say.
      const { viewer, vp, g } = cutScene([PLATE], { omit: [SECTION_INDEX] })
      const [unit] = viewer.clipping._capUnits
      expect(unit.capMeshes.map((c) => c.index)).toEqual([1, 2])
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })
  })

  describe('which side the ray reaches the plane from', () => {
    // THE PREMISE THE WHOLE CORRECTION RESTS ON, and it holds in one pose only.
    // three.js discards where the signed distance is NEGATIVE, so along a ray
    // `d(t) = d0 + t * (normal . dir)` everything nearer than the cap is clipped
    // exactly when that dot product is POSITIVE. Then nothing can stand between
    // the reader and the cut face. With it negative the near part of the ray is
    // in the kept half, the solid's own surface is in the way, and the picker's
    // answer is the right one.
    //
    // It is a fact about the RAY and not about the eye: an ortho ray does not
    // start at the eye, so "the eye is in the clipped half" is a different
    // statement that only agrees with this one while the standoff dominates.

    /** The pixel a world point sits under, whatever the camera's pose. */
    const pixelAt = (g, p) => projectPoint(g, p).slice(0, 2)

    it('answers while the ray reaches the plane from the cut-away half', () => {
      // The positive control for the refusals below: same scene, same pixel.
      const { vp, g } = cutScene([PLATE])
      expect(planePointAt(vp, g, pixelOver(g, 1, 1)).slope).toBeGreaterThan(0)
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1)).id).toBe('/model/plate')
    })

    it('stands aside once the reader has orbited past the plane', () => {
      // The camera goes round to the far side; the plane has not moved. What was
      // a cut face is now the back of a solid part, and the cap behind it.
      const { camera, viewer, vp, g } = cutScene([PLATE])
      camera.eye = [0, 0, -80]
      camera.forward = [0, 0, 1]
      viewer.target = [0, 0, 0]
      expect(planePointAt(vp, g, pixelOver(g, 1, 1)).slope).toBeLessThan(0)
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('stands aside once the reader has flipped the cut', () => {
      // `Flip` turns the plane over and MOVES NOTHING (section.js), so the
      // cross-section under the cursor is the same one — the only thing that
      // changed is which half is kept, and with it which way the ray arrives.
      const { vp, g } = cutScene([PLATE])
      const before = g.plane.constant
      vp.state.cutFlip = true
      expect(applySection(vp, g)).toBe(true)
      expect(g.plane.constant).toBeCloseTo(-before, 9)
      expect(planePointAt(vp, g, pixelOver(g, 1, 1)).slope).toBeLessThan(0)
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('answers at a grazing angle, where the EYE\'s own side disagrees', () => {
      // THE CASE THAT SEPARATES THE TWO CRITERIA, and the one a gate on the eye
      // gets wrong. The cut is placed near the top of the cube and the camera is
      // orbited to a few degrees off edge-on. The reader is looking into the cut
      // — the ray closes on the plane from the clipped half — but the eye itself
      // has drifted over to the kept side, because an ortho ray starts at its own
      // laterally offset point rather than at the eye. Gate on the eye and the
      // menu falls back to the picker and opens on what lies behind the cut,
      // which is issue #73 itself.
      //
      // The pose is built explicitly rather than orbited into: `s` is the sine
      // of the angle off edge-on, the basis stays orthonormal, and the eye sits
      // one standoff back along the view axis.
      const s = 0.08
      const c = Math.sqrt(1 - s * s)
      const { camera, viewer, vp, g } = cutScene([PLATE], { cut: [1, 1, 1.895] })
      const target = [1, 1, 1]
      const standoff = 5 * Math.sqrt(3)   // Camera.DISTANCE_FACTOR * the radius
      camera.forward = [c, 0, -s]
      camera.right = [s, 0, c]
      camera.up = [0, 1, 0]
      camera.eye = [target[0] - c * standoff, target[1],
                    target[2] + s * standoff]
      viewer.target = target

      // The eye has crossed to the KEPT side...
      expect(g.plane.distanceToPoint(g.camera.getPosition())).toBeGreaterThan(0)
      // ...while the ray still arrives from the cut-away half.
      const onPlane = [1, 1, g.plane.constant]
      expect(g.plane.distanceToPoint({
        x: onPlane[0], y: onPlane[1], z: onPlane[2],
      })).toBeCloseTo(0, 9)
      const hit = planePointAt(vp, g, pixelAt(g, onPlane))
      expect(hit.slope).toBeCloseTo(s, 9)
      expect(capOwnerAt(vp, g, pixelAt(g, onPlane)).id).toBe('/model/plate')
    })
  })

  describe('the gate: nothing runs without a cut on screen', () => {
    it('is null with no seed, however the plane happens to stand', () => {
      const { vp, g } = cutScene([PLATE])
      vp.sectionSeed = null
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('is null when the cut is suspended but the seed is kept', () => {
      // `suspendSectionCut` deliberately keeps the seed so that turning the cut
      // back on needs no second click — which makes the seed alone "a cut was
      // placed once" rather than "a cut is on screen".
      const { viewer, vp, g } = cutScene([PLATE])
      viewer.setLocalClipping(false)
      expect(vp.sectionSeed).not.toBeNull()
      expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
    })

    it('gives up quietly when the library has moved its cap units', () => {
      // QUIETLY is the assertion, not decoration. This runs on a right-click, so
      // a private field that has moved must be ASKED FOR and found missing —
      // reaching it and being saved by the catch would log a line per click, and
      // the catch is there for what nobody thought of rather than for this.
      const { viewer, vp, g } = cutScene([PLATE])
      delete viewer.clipping._capUnits
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(capOwnerAt(vp, g, pixelOver(g, 1, 1))).toBeNull()
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('gives up quietly when there is no viewport or no internals', () => {
      const { vp, g } = cutScene([PLATE])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(capOwnerAt(null, g, [0, 0])).toBeNull()
        expect(capOwnerAt(vp, null, [0, 0])).toBeNull()
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })
})

describe('the vendored files still say what the cut-face menu rests on', () => {
  const bundle = () => repoFile(BUNDLE)
  const three = () => repoFile(THREE_MODULE)

  /** The body of one method, from its signature to the next method at the same
   *  indent — enough to ask what a single function does and does not do. */
  const methodBody = (source, signature, until) => {
    const start = source.indexOf(signature)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(until, start + signature.length)
    expect(end).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('still builds the cut face as a cap quad in Clipping._createStencils', () => {
    // The thing under the cursor that this whole correction is about. If it
    // stops being built here, the correction is answering about something that
    // no longer exists.
    const body = methodBody(bundle(), '_createStencils(center, size, theme) {',
                            'rebuildStencils(center, size) {')
    expect(body).toContain('new PlaneMesh(i, plane, center, size, planeMaterial')
    expect(body).toContain('unit.capMeshes.push(capMesh)')
  })

  it('still spells the per-solid record the way this reads it', () => {
    // `_capUnits`, `unit.solid`, `unit.capMeshes` and the cap's own `index` are
    // the four names `capOwnerAt` walks; a rename in any of them turns the
    // correction off silently, which is why they are pinned by text.
    const source = bundle()
    expect(source).toContain(
      'unit = { solid: group, stencilGroups: [], capMeshes: [], radiusPx: 0 };')
    expect(source).toContain('this._capUnits = [...unitsBySolid.values()];')
    // The cap carries the plane it belongs to, which is what lets the section
    // plane's cap be found by `index` rather than by its position in the list.
    expect(methodBody(source, 'constructor(index, plane, center, size, material, color, type) {',
                      'updateMatrixWorld(force) {')).toContain('this.index = index;')
  })

  it('still culls a cap by writing visible on the mesh', () => {
    const body = methodBody(bundle(), 'cull(camera, width, height, clipActive) {',
                            '_solidWorldBox(solid) {')
    expect(body).toContain('cap.visible = planeHit;')
    expect(body).toContain('c.visible = false;')
  })

  it('still keys nestedGroup.groups by the SLASH path and names the group with pipes', () => {
    // Which is why the path is recovered by matching the group OBJECT: the name
    // is a lossy spelling of the key, and a model may contain the delimiter.
    const source = bundle()
    expect(source).toContain('this.delim = "|";')
    expect(source).toContain('group.name = path.replaceAll("/", this.delim);')
    expect(source).toContain('this.groups[path] = group;')
  })

  it('still replaces every material in the pick pass, which is why the cap cannot carry an id', () => {
    // The route that is closed. `overrideMaterial` kills the cap's stencil, so
    // an id painted on the quad would cover the whole clipping rectangle rather
    // than the part's cross-section.
    const body = methodBody(bundle(), '_pass(camera, layer, material) {',
                            'dispose() {')
    expect(body).toContain('scene.overrideMaterial = material;')
    expect(body).toContain('this.renderer.render(scene, camera);')
  })

  it('still puts NOTHING but faces, edges and vertices on a pick layer', () => {
    // The premise itself: no cap quad is pickable, so the id buffer reads
    // straight through the cut face to whatever lies behind it. The call sites
    // are enumerated rather than counted, so a NEW pickable object shows up as
    // a name this list does not know.
    const source = bundle()
    const calls = [...source.matchAll(/enablePickLayer\((\w+), "(\w+)"\)/g)]
      .map(([, object, topo]) => `${object}:${topo}`)
    expect(calls.length).toBeGreaterThan(0)
    expect([...new Set(calls)].sort())
      .toEqual(['edges:edge', 'front:face', 'points:vertex'])
    // ...and the pick-layer-only door, which the `obj_vertices` cloud uses.
    const exclusive = [...source.matchAll(/setPickLayerExclusive\((\w+), "(\w+)"\)/g)]
      .map(([, object, topo]) => `${object}:${topo}`)
    expect([...new Set(exclusive)]).toEqual(['pickPoints:vertex'])
  })

  it('still registers ids nowhere near the stencils', () => {
    // The other half of "the cap has no id": it is in no registry either, so
    // there is no id to look up even if the buffer could name it.
    const body = methodBody(bundle(), '_createStencils(center, size, theme) {',
                            'rebuildStencils(center, size) {')
    expect(body).not.toContain('registry.register')
    expect(body).not.toContain('enablePickLayer')
  })

  it('still discards on a NEGATIVE signed distance, which is what `slope > 0` means', () => {
    // The one fact the whole gate rests on, and the one that would break
    // SILENTLY: a reversed convention makes `capOwnerAt` fire in exactly the
    // pose it must stand aside in, with nothing on screen to say so. Three
    // lines carry it -- the vertex chunk's negation, the fragment chunk's
    // comparison, and what `projectPlanes` puts in `w` -- and together they
    // read as "discard where n . p + c < 0".
    //
    // ALL THREE ARE THREE'S OWN, so they are asked of three.module.js and not of
    // the bundle: `external: three` took the clipping chunks and `WebGLClipping`
    // out of it, and a `toContain` pointed at the bundle would now fail on a
    // convention that never moved.
    const source = three()
    expect(source).toContain('vClipPosition = - mvPosition.xyz;')
    expect(source).toContain('if ( dot( vClipPosition, plane.xyz ) > plane.w ) discard;')
    expect(source).toContain('dstArray[ i4 + 3 ] = plane.constant;')
  })

  it('names three by the URL the hub actually serves it at', () => {
    // THE JOINT THE FORK HANGS ON, and it is held by nothing else. Two halves
    // written in two files that never meet: `output.paths` in
    // viewer/rollup.config.mjs decides the specifier inside the bundle, and
    // `_serve_asset` in src/app.py decides the URL the hub answers. A typo in
    // the first -- `/v/` for `/_v/` -- survives `make viewer`, survives this
    // whole suite (which reads the file by its path in the repository, never
    // through the bundle) and survives ci/smoke.py (which checks the file is IN
    // the image, not that anything points at it). It fails in the browser, and
    // only there: the page dies resolving a module and draws an empty canvas.
    expect(bundle()).toContain("from '/_v/three.module.js'")
    // And the re-export the last line of viewer/src/index.ts exists for: lose it
    // on a rebase and our own code can no longer name the classes the library
    // renders with, which is the other half of why three is external at all.
    expect(bundle()).toContain('export { THREE }')
  })
})
