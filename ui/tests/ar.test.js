// @vitest-environment node
//
// View in AR (ui/src/ar.js): the scene handed to three's USDZ exporter, built
// out of groups shaped as the viewer's (`nestedGroup.groups`: a path to a group
// whose `front` is the mesh of its faces), on three's own objects with no GPU;
// then the exporter itself over that scene, as the browser runs it; and where
// a WebXR session stands that scene (`arPlacement`).
//
// Node and not jsdom, the directory's default, which this file needs nothing
// of: under jsdom `TextEncoder` hands fflate a Uint8Array of another realm,
// which its `instanceof` reads as a folder, and the archive comes out as a tree
// of one-byte files.

import { describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { strFromU8, unzipSync } from '../../static/_v/fflate.module.js'
import { USDZExporter } from '../../static/_v/USDZExporter.js'
import { arPlacement, arScene, MM, XR_NEAREST } from '../src/ar.js'

/** A part as the library draws it: a group placed at `at` holding its front
 *  (the faces, one triangle with a corner at the origin and one at x = 1) and
 *  the things a group holds beside it — the back faces and the edges. */
function part(parent, at, material) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3))
  geometry.setIndex([0, 1, 2])
  const group = new THREE.Group()
  group.position.set(...at)
  group.front = new THREE.Mesh(geometry, material)
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.BackSide })))
  group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial()))
  group.add(group.front)
  parent.add(group)
  return group
}

/** A model of four parts under a root the view placed 100 mm up: one shown,
 *  one ghosted, one the library hid by its material and one by its mesh. */
function model() {
  const root = new THREE.Group()
  root.position.set(0, 0, 100)
  const face = (options) => new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.65, ...options })
  const groups = {
    '/m': root,
    '/m/lid': part(root, [10, 20, 30], face({ color: 0xff8000 })),
    '/m/ghost': part(root, [0, 0, 0], face({ color: 0x0080ff, transparent: true, opacity: 0.25 })),
    '/m/off': part(root, [0, 0, 0], face({ color: 0x00ff00, visible: false })),
    '/m/studio': part(root, [0, 0, 0], face({ color: 0xff0000 })),
  }
  groups['/m/studio'].front.visible = false
  return groups
}

const meshes = (scene) => {
  const found = []
  scene.traverse((object) => object.isMesh && found.push(object))
  return found
}

describe('the scene View in AR exports', () => {
  it('carries the faces of every shown part and nothing else', () => {
    // Two: the ghosted part goes, the two hidden ones and every back face and
    // edge do not.
    const found = meshes(arScene(THREE, model()))
    expect(found.map((mesh) => mesh.material.color.getHex())).toEqual([0xff8000, 0x0080ff])
  })

  it('puts a millimetre of the Z-up model at a millimetre of Y-up metres', () => {
    // The lid stands at (10, 20, 130) mm in the model and the ghost at
    // (0, 0, 100): their own placements and the root's. Read as the step from
    // one to the other, since the whole model is also moved onto the floor.
    // USDZ's +Y is the model's +Z, its +Z the model's −Y.
    const [lid, ghost] = meshes(arScene(THREE, model()))
    const at = (mesh) => new THREE.Vector3().applyMatrix4(mesh.matrixWorld)
    const step = at(lid).sub(at(ghost))
    const want = [10 * MM, 30 * MM, -20 * MM]
    step.toArray().forEach((value, axis) => expect(value).toBeCloseTo(want[axis], 9))
  })

  it('stands the model on the floor, its middle over the origin', () => {
    // The shown parts span z = 100..130 mm in the model, which would float a
    // tenth of a metre over the plane Quick Look anchors the file to.
    const box = new THREE.Box3().setFromObject(arScene(THREE, model()))
    const middle = box.getCenter(new THREE.Vector3())
    expect(box.min.y).toBeCloseTo(0, 9)
    expect(middle.x).toBeCloseTo(0, 9)
    expect(middle.z).toBeCloseTo(0, 9)
  })

  it('stands a part turned off the axes on the floor by its lowest point', () => {
    // Turned −45° about (1, −1, 0), the triangle's lowest corners sit at
    // z = −0.5 mm, while the corner (1, 1, 0) of its own box, which is no
    // corner of the triangle, goes to z = −1: a model grounded by the boxes of
    // its parts would float half a millimetre over the floor.
    const root = new THREE.Group()
    const turned = part(root, [0, 0, 0], new THREE.MeshStandardMaterial())
    turned.quaternion.setFromAxisAngle(new THREE.Vector3(1, -1, 0).normalize(), -Math.PI / 4)
    const box = new THREE.Box3().setFromObject(arScene(THREE, { '/m': root, '/m/p': turned }), true)
    expect(box.min.y).toBeCloseTo(0, 9)
  })

  it('paints each part as the viewer does, translucency and all', () => {
    const [lid, ghost] = meshes(arScene(THREE, model()))
    expect(lid.material.isMeshStandardMaterial).toBe(true)
    expect([lid.material.opacity, lid.material.transparent]).toEqual([1, false])
    expect([ghost.material.opacity, ghost.material.transparent]).toEqual([0.25, true])
    expect([lid.material.metalness, lid.material.roughness]).toEqual([0.3, 0.65])
  })

  it('reads as a USDZ file in metres with Y up, a geometry and a colour per part', async () => {
    const groups = model()
    const files = unzipSync(await new USDZExporter().parseAsync(arScene(THREE, groups)))
    const usda = strFromU8(files['model.usda'])
    expect(usda).toContain('metersPerUnit = 1')
    expect(usda).toContain('upAxis = "Y"')
    expect(Object.keys(files).filter((name) => name.startsWith('geometries/'))).toHaveLength(2)
    const { r, g, b } = groups['/m/lid'].front.material.color
    expect(usda).toContain(`color3f inputs:diffuseColor = (${r}, ${g}, ${b})`)
    expect(usda).toContain('float inputs:opacity = 0.25')
  })
})

describe('where WebXR stands the model', () => {
  // In the session's `local` space the phone is at the origin looking down −Z,
  // Y up. Read off the scene as the session draws it: `arScene`'s root moved
  // to `arPlacement`.
  const placed = (groups) => {
    const root = arScene(THREE, groups)
    const size = new THREE.Box3().setFromObject(root, true).getSize(new THREE.Vector3())
    const at = arPlacement(size)
    root.position.set(at.x, at.y, at.z)
    root.updateMatrixWorld(true)
    return new THREE.Box3().setFromObject(root, true)
  }
  /** A model of one part, its triangle `mm` millimetres on a side. */
  const sized = (mm) => {
    const root = new THREE.Group()
    const one = part(root, [0, 0, 0], new THREE.MeshStandardMaterial())
    one.scale.setScalar(mm)
    return { '/m': root, '/m/p': one }
  }

  it('keeps it at 1:1', () => {
    // The shown parts of `model()` span 11 × 21 × 30 mm (x, y, z); in the
    // session's metres with Y up that is 11 mm across, 30 up and 21 deep.
    const size = placed(model()).getSize(new THREE.Vector3())
    const want = [11 * MM, 30 * MM, 21 * MM]
    size.toArray().forEach((value, axis) => expect(value).toBeCloseTo(want[axis], 9))
  })

  it('stands its middle straight ahead, a little below eye level', () => {
    const middle = placed(model()).getCenter(new THREE.Vector3())
    expect(middle.x).toBeCloseTo(0, 9)
    // a small part no nearer than the nearest the reader holds a thing
    expect(middle.z).toBeCloseTo(-XR_NEAREST, 9)
    // below the phone, and by less than it is ahead: in front, not underfoot
    expect(middle.y).toBeLessThan(0)
    expect(-middle.y).toBeLessThan(-middle.z)
  })

  it('puts the whole of it ahead of the phone, a large one farther off', () => {
    // Two metres on a side: the nearest face of the model must still be in
    // front of the phone, and it is not drawn smaller to get there.
    const small = placed(sized(10))
    const large = placed(sized(2000))
    expect(small.max.z).toBeLessThan(0)
    expect(large.max.z).toBeLessThan(0)
    expect(large.getCenter(new THREE.Vector3()).z).toBeLessThan(small.getCenter(new THREE.Vector3()).z)
    expect(large.getSize(new THREE.Vector3()).x).toBeCloseTo(2, 9)
  })
})
