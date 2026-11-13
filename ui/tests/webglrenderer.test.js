// The KiCad viewer's WebGL2 renderer
// (ecad-viewer/packages/ecad-viewer-app/src/graphics/webgl/renderer.ts): what
// its ResizeObserver does to the projection and to the canvas's buffer. There
// is no WebGL in jsdom, so `gl` is a stand-in with the calls a resize and a
// clear make, `setup()` is never run, and the shader sets, which import GLSL
// files, are mocked out.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Vec2 } from '../../ecad-viewer/packages/ecad-viewer-app/src/base/math/index.ts'
import { WebGL2Renderer } from '../../ecad-viewer/packages/ecad-viewer-app/src/graphics/webgl/renderer.ts'

vi.mock('../../ecad-viewer/packages/ecad-viewer-app/src/graphics/webgl/vector.ts', () => ({
  CircleSet: class {}, PolygonSet: class {}, PolylineSet: class {}, PrimitiveSet: class {}, ShaderTypes: {},
}))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the WebGL2 renderer on a resize', () => {
  it('projects at every tick\'s size, and resizes its buffer at most once per 100 ms, at the final size', () => {
    // Each resize reallocates the multisampled buffer (RESIZE_MS in renderer.ts);
    // CSS stretches the old one over the new box meanwhile.
    let tick = null
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { tick = callback }
      observe() {}
      disconnect() {}
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const canvas = document.createElement('canvas')
    let width = 400
    canvas.getBoundingClientRect = () => ({ width, height: 300 })
    const renderer = new WebGL2Renderer(canvas)
    renderer.gl = { COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, viewport() {}, clear() {} }
    renderer.update_canvas_size()
    const buffers = []
    for (const w of [400, 500, 600]) {
      width = w
      tick([{ contentRect: { width: w, height: 300 } }])
      const corner = renderer.projection_matrix.transform(new Vec2(w, 300))
      expect(corner.x).toBeCloseTo(1)
      expect(corner.y).toBeCloseTo(-1)
      // a frame inside the window
      renderer.clear_canvas()
      buffers.push(canvas.width)
    }
    const dpr = window.devicePixelRatio
    expect(buffers).toEqual([400 * dpr, 400 * dpr, 400 * dpr])
    vi.advanceTimersByTime(100)
    expect(canvas.width).toBe(600 * dpr)
  })
})
