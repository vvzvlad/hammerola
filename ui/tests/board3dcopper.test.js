// The board's copper in the 3D view (ui/src/board3dcopper.js), on three's own
// objects with no GPU: which of a KiCad `.glb`'s board layers are its copper,
// where our copper stands and how the stackup separation moves it, the drills
// and the board's edge cut out of it, and the camera of a 3D inset against the
// inset's own 2D matrix. What it looks like is checked by eye in a browser.

import { describe, expect, it } from 'vitest'

import * as THREE from '../../static/_v/three.module.js'
import { mergeVertices } from '../../static/_v/BufferGeometryUtils.js'
import { GLTFLoader } from '../../static/_v/GLTFLoader.js'
import { Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { world_to_inset } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/insets/camera.ts'
import { exportRoot } from '../src/board3d.js'
import {
  bodyTop, boardMask, copperModel, glbLayers, holeMask, insetView, place, separationLook, stackOffsets,
} from '../src/board3dcopper.js'

/** A binary glTF whose top node holds one node per mesh name of `names`, each a triangle. */
function glb(names) {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ children: names.map((_, i) => i + 1) }, ...names.map((_, i) => ({ name: `=>[0:1:1:${i + 1}]`, mesh: i }))],
    meshes: names.map((name) => ({ name, primitives: [{ attributes: { POSITION: 0 } }] })),
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  }
  const bin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
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

/** A 4-layer board's copper as `getBoardCopper` hands it: one triangle of net A
 *  a layer, KiCad's default heights, a through via and a blind one. */
const COPPER = {
  nets: ['', 'A'],
  layers: [['F.Cu', 1.51, 1.545], ['In1.Cu', 0.995, 1.03], ['In2.Cu', 0.48, 0.515], ['B.Cu', -0.035, 0]]
    .map(([name, bottom, top]) => ({ name, bottom, top, triangles: new Float32Array([0, 0, 4, 0, 0, 3]), nets: new Uint32Array([1, 1, 1]) })),
  barrels: [{ x: 1, y: 1, radius: 0.15, from: 0, to: 3, net: 1 }, { x: 3, y: 0.5, radius: 0.15, from: 0, to: 1, net: 1 }],
}

describe('the board layers of a KiCad .glb', () => {
  it('are told apart by the end of their mesh\'s name', async () => {
    const kinds = ['b_copper', 'b_pad', 'b_via', 'b_soldermask', 'b_silkscreen', 'b_PCB']
    const { scene, parser } = await new GLTFLoader().parseAsync(glb(kinds), '')
    const layers = exportRoot(scene).children
    const out = glbLayers(layers, parser)
    const index = (nodes) => nodes.map((node) => layers.indexOf(node))
    expect([index(out.copper), index(out.skin), index(out.board), index(out.body)])
      .toEqual([[0, 1, 2], [3, 4], [3, 4, 5], [5]])
  })
})

describe('the stackup separation', () => {
  it('pulls the layers apart about the middle, by the square of the slider and the board\'s size', () => {
    expect(stackOffsets(0, 100, 4).map((v) => v + 0)).toEqual([0, 0, 0, 0])
    // 0.12 of the diagonal, at least 8 and at most 25 mm between neighbours
    expect(stackOffsets(1, 100, 4)).toEqual([18, 6, -6, -18])
    expect(stackOffsets(1, 10, 3)).toEqual([8, 0, -8])
    expect(stackOffsets(0.5, 1000, 2)).toEqual([3.125, -3.125])
  })

  it('hides the parts by a tenth, and thins the board to 15% and colours the layers by a quarter', () => {
    expect(separationLook(0)).toEqual({ parts: 1, board: 1, layers: 0 })
    expect(separationLook(0.05)).toMatchObject({ parts: 0.5, layers: 0.2 })
    expect(separationLook(0.1).parts).toBe(0)
    expect(separationLook(0.25)).toMatchObject({ layers: 1, board: expect.closeTo(0.15, 9) })
    expect(separationLook(1).board).toBeCloseTo(0.15, 9)
  })
})

describe('our copper in the .glb\'s frame', () => {
  const model = copperModel(THREE, COPPER, { 'F.Cu': '#ff0000' })
  const heights = (mesh) => [...new Set(Array.from({ length: mesh.geometry.attributes.position.count },
    (_, i) => Math.round(mesh.geometry.attributes.position.getY(i) * 1e9) / 1e6))]

  it('lays each layer on its face that looks out of the board, in metres, x and y as the board\'s', () => {
    expect(model.layers.map((layer) => heights(layer.mesh))).toEqual([[1.545], [1.03], [0.48], [-0.035]])
    const position = model.layers[0].mesh.geometry.attributes.position
    expect(position.getX(1)).toBeCloseTo(0.004, 9)
    expect(position.getZ(2)).toBeCloseTo(0.003, 9)
    expect(model.layers.map((layer) => layer.mesh.geometry.attributes.netIndex.getX(0))).toEqual([1, 1, 1, 1])
    expect(model.diagonal).toBe(5)
  })

  it('stretches each barrel between the layers it joins, apart or together', () => {
    const barrelHeights = () => {
      const { position } = model.barrels.mesh.geometry.attributes
      const through = Array.from({ length: 72 }, (_, i) => position.getY(i))
      const blind = Array.from({ length: 72 }, (_, i) => position.getY(72 + i))
      const span = (ys) => [Math.min(...ys), Math.max(...ys)].map((y) => Math.round(y * 1e9) / 1e6)
      return [span(through), span(blind)]
    }
    expect(barrelHeights()).toEqual([[-0.035, 1.545], [0.995, 1.545]])
    place(stackOffsets(1, model.diagonal, 4), model.layers, model.barrels)
    expect(model.layers.map((layer) => Math.round(layer.mesh.position.y * 1e9) / 1e6)).toEqual([12, 4, -4, -12])
    expect(barrelHeights()).toEqual([[-12.035, 13.545], [4.995, 13.545]])
    place(stackOffsets(0, model.diagonal, 4), model.layers, model.barrels)
    expect(barrelHeights()).toEqual([[-0.035, 1.545], [0.995, 1.545]])
  })
})

/** Mask `data` on the grid of `grid` (a `holeMask`) at the board's mm point
 *  `x`, `y`, 0 to 1, as the texture's linear lookup reads it: texel centres at
 *  half a texel. */
function linear(grid, data, x, y) {
  const [u, v] = [(x - grid.x0) / grid.texel - 0.5, (y - grid.y0) / grid.texel - 0.5]
  const [i, j] = [Math.floor(u), Math.floor(v)]
  const [fu, fv] = [u - i, v - j]
  const texel = (a, b) => data[b * grid.width + a] / 255
  return (texel(i, j) * (1 - fu) + texel(i + 1, j) * fu) * (1 - fv) + (texel(i, j + 1) * (1 - fu) + texel(i + 1, j + 1) * fu) * fv
}

describe('the drills cut out of the copper', () => {
  const box = { x0: 0, y0: 0, x1: 4, y1: 3 }
  const mask = holeMask(COPPER, box)
  const at = (x, y) => mask.data[Math.floor((y - mask.y0) / mask.texel) * mask.width + Math.floor((x - mask.x0) / mask.texel)]

  it('cover the copper\'s box at a texel of 25 um', () => {
    expect(mask.texel).toBe(0.025)
    expect(mask.x0 + mask.width * mask.texel).toBeGreaterThan(box.x1)
    expect(mask.y0 + mask.height * mask.texel).toBeGreaterThan(box.y1)
  })

  it('are full inside a drill through the whole stack and empty off it', () => {
    expect([at(1, 1), at(1.1, 1), at(1, 1.2), at(1.3, 1)]).toEqual([255, 255, 0, 0])
  })

  it('cross a half, as the shader reads them, within 3 um of the drill\'s edge', () => {
    for (const angle of [0, 0.3, Math.PI / 4, 2, 4]) {
      let edge = 0
      for (let r = 0; r < 0.3; r += 0.0005) if (linear(mask, mask.data, 1 + r * Math.cos(angle), 1 + r * Math.sin(angle)) > 0.5) edge = r
      expect([angle, Math.abs(edge - 0.15) <= 0.003]).toEqual([angle, true])
    }
  })

  it('leave a drill that stops inside the stack to its own rings', () => {
    expect(at(3, 0.5)).toBe(0)
  })

  it('grow the texel so a big board stays within 4096 of them a side', () => {
    const big = holeMask(COPPER, { x0: 0, y0: 0, x1: 400, y1: 10 })
    expect(big.width).toBeLessThanOrEqual(4096)
    expect(big.x0 + big.width * big.texel).toBeGreaterThan(400)
  })

  it('stay within 4096 a side where the rounding of the division would tip the count over', () => {
    // 102.367 mm a side: 4097 texels, had the texel been a 4094th of the side
    const tipped = holeMask(COPPER, { x0: 0, y0: 0, x1: 102.367, y1: 102.367 })
    expect(Math.max(tipped.width, tipped.height)).toBeLessThanOrEqual(4096)
    expect(Math.min(tipped.x0 + tipped.width * tipped.texel, tipped.y0 + tipped.height * tipped.texel)).toBeGreaterThan(102.367)
  })
})

describe('the board\'s edge cutting the copper', () => {
  // A 10 x 8 mm body with a 2 x 2 mm notch in the edge at y 0 and a 2 mm drill at
  // (7, 5), as KiCad's `PCB` is: in the .glb's frame (metres, Y up, the board's y
  // along Z), 1.51 mm thick with its bottom at 0, indexed, walls and a bottom
  // face and all; its root moved in the world, which the copper is not.
  const outline = new THREE.Shape([[0, 0], [4, 0], [4, 2], [6, 2], [6, 0], [10, 0], [10, 8], [0, 8]]
    .map(([x, y]) => new THREE.Vector2(x / 1000, y / 1000)))
  outline.holes.push(new THREE.Path().absarc(0.007, 0.005, 0.001, 0, 2 * Math.PI, true))
  const solid = new THREE.ExtrudeGeometry(outline, { depth: 0.00151, bevelEnabled: false, curveSegments: 64 })
  solid.rotateX(Math.PI / 2).translate(0, 0.00151, 0)
  const root = new THREE.Group()
  root.position.set(5, 5, 5)
  const body = new THREE.Group()
  body.add(new THREE.Mesh(mergeVertices(solid)))
  root.add(body)
  const top = bodyTop(THREE, [body], root)
  const grid = holeMask(COPPER, { x0: -1, y0: -1, x1: 11, y1: 9 })
  const mask = boardMask(top, grid)
  const at = (x, y) => mask[Math.floor((y - grid.y0) / grid.texel) * grid.width + Math.floor((x - grid.x0) / grid.texel)]

  it('is the top face of the body, in the board\'s mm, its walls and bottom left out', () => {
    const areas = []
    for (let i = 0; i < top.length; i += 6) {
      areas.push(Math.abs((top[i + 2] - top[i]) * (top[i + 5] - top[i + 1]) - (top[i + 3] - top[i + 1]) * (top[i + 4] - top[i])) / 2)
    }
    // one of the two caps (the extrusion's first group), no side
    expect(areas.length).toBe(solid.groups[0].count / 6)
    // the drill a polygon in the circle
    expect(areas.reduce((a, b) => a + b)).toBeCloseTo(80 - 4 - Math.PI, 1)
    expect([Math.min(...top.filter((_, i) => i % 2 === 0)), Math.max(...top.filter((_, i) => i % 2 === 1))].map((v) => +v.toFixed(6)))
      .toEqual([0, 8])
  })

  it('is a mask full on the body and empty in the notch, the drill and off the board', () => {
    expect([at(2, 4), at(5, 3), at(5, 1), at(7, 5), at(10.5, 4), at(2, 8.5)]).toEqual([255, 255, 0, 0, 0, 0])
  })

  it('crosses a half, as the shader reads it, within 3 um of the outline and the drill', () => {
    const edge = (from, to, want) => {
      let last = 0
      for (let t = 0; t <= 1; t += 0.001) {
        if (linear(grid, mask, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t) > 0.5) last = t
      }
      const crossed = [from[0] + (to[0] - from[0]) * last, from[1] + (to[1] - from[1]) * last]
      return Math.hypot(crossed[0] - want[0], crossed[1] - want[1]) <= 0.003
    }
    expect([edge([9.8, 4.3], [10.2, 4.3], [10, 4.3]), edge([2.3, 7.8], [2.3, 8.2], [2.3, 8]),
      edge([3.8, 1], [4.2, 1], [4, 1]), edge([5.3, 2.2], [5.3, 1.8], [5.3, 2])]).toEqual([true, true, true, true])
    for (const angle of [0, 0.7, 2.5, 4]) {
      const [c, s] = [Math.cos(angle), Math.sin(angle)]
      expect([angle, edge([7 + 1.2 * c, 5 + 1.2 * s], [7 + 0.8 * c, 5 + 0.8 * s], [7 + c, 5 + s])]).toEqual([angle, true])
    }
  })

  it('is full over a grid the body overhangs on every side', () => {
    const inside = holeMask(COPPER, { x0: 1, y0: 3, x1: 3, y1: 6 })
    expect(new Set(boardMask(top, inside))).toEqual(new Set([255]))
  })

  it('cuts nothing of a board with no body, and reads a barrel past its wall', () => {
    const plain = copperModel(THREE, COPPER, {}, null).shared.boardMap.value.image
    expect([plain.width, plain.height, [...plain.data]]).toEqual([1, 1, [255]])
    const model = copperModel(THREE, COPPER, {}, top)
    const { image } = model.shared.boardMap.value
    const drills = holeMask(COPPER, { x0: 0, y0: 0, x1: 4, y1: 3 })
    expect([image.width, image.height, image.data.length]).toEqual([drills.width, drills.height, drills.data.length])
    // each corner of a tube reaches out from its axis, the sagitta of a side and two texels past the drill
    const { position, outward } = model.barrels.mesh.geometry.attributes
    const reach = (i) => {
      const barrel = COPPER.barrels[Math.floor(i / 72)]
      const [x, y] = [position.getX(i) * 1000 + outward.getX(i), position.getZ(i) * 1000 + outward.getY(i)]
      return Math.hypot(x - barrel.x, y - barrel.y) - barrel.radius * (2 - Math.cos(Math.PI / 12))
    }
    expect(new Set(Array.from({ length: position.count }, (_, i) => +reach(i).toFixed(5)))).toEqual(new Set([0.05]))
  })
})

describe('the camera of a 3D inset', () => {
  // The board's mm point `p` on the plane at `surface` metres, as an orthographic camera of
  // `insetView` draws it on a `w` x `h` canvas, in CSS px.
  function drawn(view, w, h, surface, p) {
    const frame = insetView(view, w, h, 0.2, surface)
    const back = frame.eye.map((v, i) => v - frame.target[i])
    const length = Math.hypot(...back)
    const z = back.map((v) => v / length)
    const y = frame.up
    const x = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]]
    const d = [p.x / 1000 - frame.target[0], surface - frame.target[1], p.y / 1000 - frame.target[2]]
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    return { x: w / 2 + (dot(d, x) / (2 * frame.halfWidth)) * w, y: h / 2 - (dot(d, y) / (2 * frame.halfHeight)) * h, z }
  }

  it('puts a point of the board where the inset\'s own matrix does, turned, mirrored and leaning', () => {
    const points = [new Vec2(10, 20), new Vec2(13, 18), new Vec2(6.5, 24)]
    for (const rotation of [0, 0.4, -2.1, Math.PI / 2]) {
      for (const mirror of [false, true]) {
        for (const tilt of [0, 0.7]) {
          const view = { center: new Vec2(10, 20), zoom: 12, rotation, mirror, view3d: true, tilt }
          for (const p of points) {
            const want = world_to_inset(view, 300, 200, p)
            const got = drawn(view, 300, 200, 0.00155, p)
            // a thousandth of a pixel: the inset's matrix is Float32
            const off = Math.hypot(got.x - want.x, got.y - want.y)
            expect({ rotation, mirror, tilt, p: [p.x, p.y], off: off < 1e-3 ? 0 : off })
              .toEqual({ rotation, mirror, tilt, p: [p.x, p.y], off: 0 })
          }
        }
      }
    }
  })

  it('looks at the top from above and, mirrored, at the bottom from below', () => {
    const view = { center: new Vec2(0, 0), zoom: 1, rotation: 0, tilt: 0 }
    const toward = (mirror) => drawn({ ...view, mirror }, 10, 10, 0, new Vec2(0, 0)).z.map((v) => Math.round(v * 1e9) / 1e9 + 0)
    expect(toward(false)).toEqual([0, 1, 0])
    expect(toward(true)).toEqual([0, -1, 0])
  })
})
