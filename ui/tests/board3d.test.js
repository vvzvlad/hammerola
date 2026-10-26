// The parts of a board's 3D model and what the 3D view does to them
// (ui/src/board3d.js), run on three's own objects with no GPU: the real loader
// reads a `.glb` built here the way KiCad writes one — an unnamed top node, parts
// named by designator with their meshes below them (one of them several bodies
// deep, its inner nodes named by numbers), a layer of the board named by a label
// tag, materials that name a colour only beside one that names its metal.

import { describe, expect, it, vi } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { mergeGeometries } from '../../static/_v/BufferGeometryUtils.js'
import { GLTFLoader } from '../../static/_v/GLTFLoader.js'
import {
  designatorOf, disposeModel, exportRoot, frameBox, fromPart, light, loadThree, mergeByMaterial, partOf, partPlace,
  partsOf, pickedPart, plainColours, sharedGeometries,
} from '../src/board3d.js'

const vec3 = (count, offset) => ({ bufferView: offset, componentType: 5126, count, type: 'VEC3' })
const MODEL = {
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [
    { children: [1, 3, 9] },
    { name: 'C523', translation: [0.17, 0.0016, 0.1], rotation: [0, -0.7071068, 0, 0.7071068], children: [2] },
    { name: '=>[0:1:1:3]', mesh: 0, translation: [0.001, 0, 0] },
    { name: 'L101', translation: [0.1, 0.0016, 0.05], children: [4] },
    { name: '=>[0:1:1:15]', children: [5] },
    { name: '114', children: [6, 7] },
    { name: '111', translation: [0, 0.002, 0], children: [8] },
    { name: '113', mesh: 2, translation: [0.003, 0, 0] },
    { name: '110', mesh: 1 },
    { name: '=>[0:1:1:98]', mesh: 3 },
  ],
  meshes: [
    { name: 'C_0603_1608Metric', primitives: [
      { attributes: { POSITION: 0, NORMAL: 2 }, material: 0 },
      { attributes: { POSITION: 1, NORMAL: 2 }, material: 0 },
      { attributes: { POSITION: 0, NORMAL: 2 }, material: 1 }] },
    { name: 'body', primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, material: 0 }] },
    { name: 'body', primitives: [{ attributes: { POSITION: 0, NORMAL: 2 }, material: 0 }] },
    { name: 'board_PCB', primitives: [{ attributes: { POSITION: 0, NORMAL: 2 }, material: 2 }] },
  ],
  materials: [
    { name: 'mat_0', pbrMetallicRoughness: { baseColorFactor: [0.65, 0.64, 0.57, 1] }, doubleSided: true },
    { name: 'mat_1', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0.5 } },
    { name: 'mat_36', pbrMetallicRoughness: { baseColorFactor: [0.42, 0.45, 0.29, 0.98], metallicFactor: 0,
      roughnessFactor: 0.8 }, doubleSided: true, alphaMode: 'BLEND' },
  ],
  accessors: [
    { ...vec3(3, 0), min: [0, 0, 0], max: [1, 1, 0] },
    { ...vec3(3, 1), min: [0, 0, 1], max: [1, 1, 1] },
    vec3(3, 2),
  ],
  bufferViews: [0, 1, 2].map((i) => ({ buffer: 0, byteOffset: i * 36, byteLength: 36 })),
  buffers: [{ byteLength: 108 }],
}
const BIN = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])

/** A binary glTF of `json` and `bin`, chunks padded as the format asks. */
function glb(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = Math.ceil(text.length / 4) * 4
  const total = 28 + jsonLength + bin.byteLength
  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  const bytes = new Uint8Array(out)
  ;[0x46546c67, 2, total, jsonLength, 0x4e4f534a].forEach((word, i) => view.setUint32(i * 4, word, true))
  bytes.fill(0x20, 20, 20 + jsonLength)
  bytes.set(text, 20)
  view.setUint32(20 + jsonLength, bin.byteLength, true)
  view.setUint32(24 + jsonLength, 0x004e4942, true)
  bytes.set(new Uint8Array(bin.buffer), 28 + jsonLength)
  return out
}

const load = () => new GLTFLoader().parseAsync(glb(MODEL, BIN), '')

const meshesOf = (nodes) => {
  const out = []
  for (const node of nodes) node.traverse((object) => object.isMesh && out.push(object))
  return out
}

/** Every vertex under `node`, in the world, with the material it is drawn in. */
function worldPoints(node) {
  node.updateWorldMatrix(true, true)
  return meshesOf([node]).flatMap((mesh) => {
    const position = mesh.geometry.attributes.position
    return Array.from({ length: position.count }, (_, i) => {
      const at = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
      return `${mesh.material.name} ${at.toArray().map((v) => Math.round(v * 1e7) / 1e7 + 0).join(' ')}`
    })
  }).sort()
}

describe('a KiCad export', () => {
  it('names a part by its designator and a layer of the board by nothing', async () => {
    const node = (name) => Object.assign(new THREE.Object3D(), { userData: { name } })
    // top-level names of a real export (kicad-cli 10.0.6 `pcb export glb`)
    for (const name of ['C523', 'R104', 'L101', 'CM202', 'FB101', 'U501', 'Y301', 'J101', 'D203', 'Q101']) {
      expect(designatorOf(node(name))).toBe(name)
    }
    for (const name of ['=>[0:1:1:98]', '=>[0:1:1:102]', '', undefined]) expect(designatorOf(node(name))).toBeNull()
    // the glTF's own name: three's `name` is sanitised
    const { scene } = await load()
    const layer = exportRoot(scene).children[2]
    expect([layer.name, layer.userData.name, designatorOf(layer)]).toEqual(['=>01198', '=>[0:1:1:98]', null])
  })

  it('groups every mesh under a top-level node into that node\'s part', async () => {
    const { scene } = await load()
    const root = exportRoot(scene)
    expect(root).toBe(scene.children[0])
    const parts = partsOf(scene)
    expect([...parts.keys()]).toEqual(['C523', 'L101'])
    expect(meshesOf([scene]).map((mesh) => partOf(mesh, root))).toEqual(['C523', 'C523', 'C523', 'L101', 'L101', null])
    expect([partOf(root, root), partOf(new THREE.Mesh(), root)]).toEqual([null, null])
    // a designator the board repeats is one part of both nodes
    const top = { children: ['R1', 'R1', '=>[0:1:1:9]'].map((name) => ({ userData: { name }, children: [] })) }
    expect(partsOf({ children: [top] }).get('R1')).toHaveLength(2)
    // the nearest thing hit decides: the board in front hides a part
    const [pin] = meshesOf(parts.get('C523'))
    const board = root.children[2]
    expect(pickedPart([{ object: pin }, { object: board }], root)).toBe('C523')
    expect(pickedPart([{ object: board }, { object: pin }], root)).toBeNull()
    expect(pickedPart([], root)).toBeNull()
  })

  it('merges each part\'s meshes into one per material, every vertex where it was', async () => {
    const { scene } = await load()
    const root = exportRoot(scene)
    const before = root.children.map(worldPoints)
    const loaded = meshesOf([root]).length
    // The loader hands one geometry to every primitive naming the same
    // accessors, across parts: here two, one drawn by C523, L101 and the
    // board, the other by C523 and L101, each moved into place only as a copy,
    // or the others would move with it. (Both also name one normal accessor,
    // which OCCT never writes; harmless here, as both are copied.)
    const shared = sharedGeometries(root)
    expect(shared.size).toBe(2)
    for (const node of [...root.children]) mergeByMaterial(THREE, mergeGeometries, node, shared)
    expect(root.children.map(worldPoints)).toEqual(before)
    const [c523, l101, board] = root.children
    expect([loaded, meshesOf([root]).length]).toEqual([6, 4])
    expect(meshesOf([c523]).map((mesh) => mesh.material.name).sort()).toEqual(['mat_0', 'mat_1'])
    // three bodies deep, one material: one mesh straight under the part, the empty nodes gone
    expect(l101.children.map((child) => child.isMesh)).toEqual([true])
    expect(board.isMesh).toBe(true)
    expect(meshesOf([root]).map((mesh) => partOf(mesh, root))).toEqual(['C523', 'C523', 'L101', null])
  })

  it('moves a geometry no one else draws in place, copies a shared one, and leaves a group it cannot merge as it was', () => {
    const material = new THREE.MeshStandardMaterial({ name: 'mat' })
    const mesh = (geometry, x, y) => {
      const out = new THREE.Mesh(geometry, material)
      out.position.set(x, y, 0)
      out.rotation.z = x / 7
      return out
    }
    const both = new THREE.BoxGeometry(1, 2, 3)
    const root = new THREE.Group()
    // A: its own geometry and one B and C draw too; B: that one and its own;
    // C: an indexed geometry beside one that is not, which the utility
    // refuses, and the shared one, whose copy, not itself, is moved there
    const a = new THREE.Group().add(mesh(new THREE.BoxGeometry(1, 1, 1), 5, 0), mesh(both, 0, 7))
    const b = new THREE.Group().add(mesh(both, -3, 1), mesh(new THREE.SphereGeometry(1), 2, 2))
    const c = new THREE.Group().add(mesh(new THREE.BoxGeometry(1, 1, 1), 5, 0),
      mesh(new THREE.BoxGeometry(1, 1, 1).toNonIndexed(), 0, 7), mesh(both, 2, -4))
    root.add(a, b, c)
    a.position.set(1, 2, 3)
    /** Every coordinate of every vertex under `node` in the world, in the
     *  order the meshes and their vertices come in, which a merge keeps. */
    const points = (node) => {
      node.updateWorldMatrix(true, true)
      return meshesOf([node]).flatMap((one) => {
        const position = one.geometry.attributes.position
        return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i)
          .applyMatrix4(one.matrixWorld).toArray()).flat()
      })
    }
    /** How far apart the furthest pair of the same coordinate lie: moved and
     *  moved back, or moved by a product of matrices, a vertex keeps float noise. */
    const apart = (one, other) => (one.length === other.length
      ? Math.max(...one.map((v, i) => Math.abs(v - other[i]))) : Infinity)
    const before = [a, b, c].map(points)
    const shared = sharedGeometries(root)
    expect([shared.size, shared.has(both)]).toEqual([1, true])
    const refused = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const node of [a, b, c]) mergeByMaterial(THREE, mergeGeometries, node, shared)
    expect(refused).toHaveBeenCalled()
    refused.mockRestore()
    expect([a, b, c].map((node) => meshesOf([node]).length)).toEqual([1, 1, 3])
    expect([a, b, c].map((node, i) => apart(points(node), before[i]) < 1e-5)).toEqual([true, true, true])
  })

  it('takes a colour given with no metallic factor for no metal, and keeps a factor given', async () => {
    const { scene, parser } = await load()
    const metals = () => Object.fromEntries(meshesOf([scene]).map((mesh) => [mesh.material.name, mesh.material.metalness]))
    expect(metals()).toEqual({ mat_0: 1, mat_1: 0.5, mat_36: 0 })
    plainColours(scene, parser)
    expect(metals()).toEqual({ mat_0: 0, mat_1: 0.5, mat_36: 0 })
  })

  it('lights a whole part in copies of its materials, never in those other parts share', async () => {
    const { scene } = await load()
    const parts = partsOf(scene)
    const [shared] = meshesOf(parts.get('L101')).map((mesh) => mesh.material)
    const loaded = new Set(meshesOf([scene]).map((mesh) => mesh.material))
    const accent = new THREE.Color(0.1, 0.5, 0.9)
    light(parts.get('C523'), accent)
    const lit = meshesOf(parts.get('C523')).map((mesh) => mesh.material)
    expect(lit.every((material) => material.color.equals(accent) && !loaded.has(material))).toBe(true)
    expect(meshesOf(parts.get('L101'))[0].material).toBe(shared)
    expect(shared.color.equals(accent)).toBe(false)
    light(parts.get('C523'), null)
    expect(meshesOf(parts.get('C523')).every((mesh) => loaded.has(mesh.material))).toBe(true)
    light(parts.get('C523'), accent)
    expect(meshesOf(parts.get('C523')).every((mesh, i) => mesh.material === lit[i])).toBe(true)
    // freed, the copies too, each once
    const freed = vi.fn()
    for (const material of [...loaded, ...lit]) material.addEventListener('dispose', () => freed(material))
    disposeModel(scene)
    expect(new Set(freed.mock.calls.map(([material]) => material))).toEqual(new Set([...loaded, ...lit]))
    expect(freed).toHaveBeenCalledTimes(loaded.size + lit.length)
  })
})

describe('the camera', () => {
  it('stands where the box\'s sphere, with its margin, fits the narrower side of the view', () => {
    const box = new THREE.Box3(new THREE.Vector3(1, 1, 1), new THREE.Vector3(3, 3, 3))
    const radius = Math.sqrt(3)
    const along = new THREE.Vector3(0, 0, 1)
    for (const [aspect, margin, least, seen, half] of [
      [2, 1, 0, radius, 45], [0.5, 2, 0, radius * 2, Math.atan(0.5) * 180 / Math.PI], [1, 1, 10, 10, 45]]) {
      const { target, position } = frameBox(THREE, box, along, 90, aspect, margin, least)
      expect(target.toArray()).toEqual([2, 2, 2])
      expect(position.x).toBe(2)
      expect(position.y).toBe(2)
      expect(Math.asin(seen / (position.z - 2)) * 180 / Math.PI).toBeCloseTo(half, 9)
    }
  })
})

describe('a comment on a part', () => {
  const close = (a, b) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 6))

  it('hangs in the part\'s own frame in millimetres, faces the camera, and moves with the part', async () => {
    const { scene } = await load()
    const root = exportRoot(scene)
    scene.updateWorldMatrix(true, true)
    const part = root.children[0]
    const [mesh] = meshesOf([part])
    // A point of C523 1, 2, 3 mm from its origin; glTF's unit is the metre.
    const local = [1, 2, 3]
    const world = () => new THREE.Vector3(...local).divideScalar(1000).applyMatrix4(part.matrixWorld)
    // The mesh sits in C523's frame unturned: its face normal is C523's.
    const faceInWorld = () => new THREE.Vector3(0, 0, 1)
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld))
    const hit = { object: mesh, point: world(), face: { normal: new THREE.Vector3(0, 0, 1) } }
    const place = partPlace(THREE, hit, root, faceInWorld().negate())
    expect(place.part).toBe('C523')
    close(place.point, local)
    close(place.normal, [0, 0, 1])
    // seen from behind the face, the normal is turned to the camera
    close(partPlace(THREE, hit, root, faceInWorld()).normal, [0, 0, -1])
    // a layer of the board is no part
    expect(partPlace(THREE, { ...hit, object: root.children[2] }, root, faceInWorld())).toBeNull()

    part.position.x += 0.01
    part.rotateY(0.3)
    scene.updateWorldMatrix(true, true)
    const { p, n } = fromPart(THREE, part, place.point, place.normal)
    close(p.toArray(), world().toArray())
    close(n.toArray(), faceInWorld().toArray())
    expect(fromPart(THREE, part, place.point, null).n).toBeNull()
  })
})

describe('three, fetched by URL', () => {
  it('is fetched again after a failed import', async () => {
    const first = loadThree()
    await expect(first).rejects.toThrow()
    const second = loadThree()
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrow()
  })
})
