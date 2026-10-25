// The bar a document view shows while its file comes in (ui/src/loadbar.jsx):
// what the fetch counts and hands back, how often the count reaches the
// screen, and what the bar says. `fetch` answers with a real `Response` whose
// body arrives in the chunks the test enqueues.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchBody, loadBar, meter, painted } from '../src/loadbar.jsx'
import { runFrames, stubFrames } from './component.js'
import { texts } from './eltree.js'

const chunked = (...parts) => new Response(new ReadableStream({
  start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
    controller.close()
  },
}))

/** How full the bar is drawn. */
const fill = (bar) => bar[1].props.children.props.style.width

beforeEach(() => stubFrames())
afterEach(() => vi.unstubAllGlobals())

describe('the bar under Loading…', () => {
  it('counts every chunk as it lands and hands the body back whole, as text or as bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chunked('ab', 'cdé', 'f')))
    const count = vi.fn()
    expect(await fetchBody('/doc.md', count, true)).toBe('abcdéf')
    // the decoded bytes: `é` is two
    expect(count.mock.calls).toEqual([[2], [4], [1]])
    expect(new TextDecoder().decode(await fetchBody('/doc.md', () => {}))).toBe('abcdéf')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    await expect(fetchBody('/doc.md', count)).rejects.toThrow('HTTP 404')
  })

  it('reaches the screen at most once a frame, with the running total', () => {
    const onBytes = vi.fn()
    const count = meter(onBytes)
    count(2)
    count(3)
    expect(onBytes).not.toHaveBeenCalled()
    runFrames()
    count(1)
    runFrames()
    runFrames()
    expect(onBytes.mock.calls).toEqual([[5], [6]])
  })

  it('waits for the second painted frame before the reading, except on a hidden page, which paints none', async () => {
    const done = vi.fn()
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    painted().then(done)
    await tick()
    expect(done).not.toHaveBeenCalled()
    // The first frame may come before React has put `Preparing…` on the page.
    runFrames()
    await tick()
    expect(done).not.toHaveBeenCalled()
    runFrames()
    await tick()
    expect(done).toHaveBeenCalled()
    // A background tab calls no animation frame at all: without this the file
    // would sit unread until the reader came back.
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await expect(painted()).resolves.toBeUndefined()
    hidden.mockRestore()
  })

  it('says what is in of what is due, never fills past full, and is full while the view is prepared', () => {
    expect(texts(loadBar(2_100_000, 40_700_000, false))).toEqual(['Loading… 2.1 / 40.7 MB'])
    expect(fill(loadBar(10_000_000, 40_000_000, false))).toBe('25%')
    expect(texts(loadBar(3_100, 7_765, false))).toEqual(['Loading… 3.1 / 7.8 kB'])
    expect(fill(loadBar(9_000_000, 8_000_000, false))).toBe('100%')
    expect([texts(loadBar(0, 8_000_000, true)), fill(loadBar(0, 8_000_000, true))]).toEqual([['Preparing…'], '100%'])
  })
})
