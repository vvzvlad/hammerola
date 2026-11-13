// viewport/frames.js — the ways back from one render per animation frame to the
// library's own synchronous one. The frames are driven by hand (component.js).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { coalesceRenders } from '../src/viewport/frames.js'
import { runFrames, stubFrames } from './component.js'

beforeEach(() => { stubFrames() })
afterEach(() => { vi.unstubAllGlobals() })

/** A viewer whose `update` is a spy, routed. */
function routed() {
  const render = vi.fn()
  const viewer = { update: render }
  return { viewer, render, frames: coalesceRenders(viewer) }
}

describe('coalesceRenders', () => {
  it('draws at once inside `now`, until the promise `fn` returned settles', async () => {
    const { viewer, render, frames } = routed()
    let settle = null
    const held = frames.now(() => new Promise((resolve) => { settle = resolve }))
    viewer.update(true, false)
    expect(render.mock.calls).toEqual([[true, false]])
    settle('done')
    expect(await held).toBe('done')
    viewer.update(true, false)
    expect(render).toHaveBeenCalledTimes(1)
    runFrames()
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('draws a pending render on flush, and no frame draws it again', () => {
    const { viewer, render, frames } = routed()
    viewer.update(false, true)
    frames.flush()
    expect(render.mock.calls).toEqual([[false, true]])
    runFrames()
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('holds a frame while the GPU has two in flight, and never a synchronous one', () => {
    // Fences are numbered in the order they are set; the GPU has finished those
    // below `finished`.
    let made = 0
    let finished = 0
    const gl = {
      SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, UNSIGNALED: 'unsignaled',
      fenceSync: vi.fn(() => ({ n: made++ })), deleteSync: vi.fn(), flush: vi.fn(),
      getSyncParameter: (fence) => (fence.n < finished ? 'signaled' : 'unsignaled'),
    }
    const render = vi.fn()
    const viewer = { update: render }
    const frames = coalesceRenders(viewer, gl)
    for (let i = 0; i < 2; i++) {
      viewer.update(true, true)
      runFrames()
    }
    expect(render).toHaveBeenCalledTimes(2)
    viewer.update(true, true)
    runFrames()
    runFrames()
    expect(render).toHaveBeenCalledTimes(2)
    finished = 1
    runFrames()
    expect(render).toHaveBeenCalledTimes(3)
    // the oldest of three fences is let go
    expect(gl.deleteSync.mock.calls).toEqual([[{ n: 0 }]])
    viewer.update(true, true)
    frames.flush()
    expect(render).toHaveBeenCalledTimes(4)
    frames.now(() => viewer.update(true, false))
    expect(render).toHaveBeenCalledTimes(5)
  })

  it('drops a pending render on cancel', () => {
    const { viewer, render, frames } = routed()
    viewer.update(true, true)
    frames.cancel()
    runFrames()
    expect(render).not.toHaveBeenCalled()
  })
})
