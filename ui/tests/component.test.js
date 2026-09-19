// The three contracts of `component.js`, which 21 files now rest on (#102).
//
// A FIXTURE WITH NO PROOF THAT IT CAN FAIL IS WORTH WHAT THAT ONE WAS —
// `pageguard.test.js` says it about a guard, and it holds here for the same
// reason: these three were prose in a docblock, and prose is what a later
// "improvement" reads past. Each one below is a way the helper could be made
// to look better and take a directory of tests down with it QUIETLY.
//
// The one-level merge is the sharpest. Deepening it reads like a fix — the
// docblock itself calls the current behaviour surprising — and the three
// fixtures that pass `{ parts: null }` to ask for a build with no files would
// then get the default's `lid.stl` back and go on passing, asserting the
// "nothing to download" branch against a build that has something.

import { describe, it, expect, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'

import { makeComponent, mergeState, replaceState } from './component.js'

describe('makeComponent', () => {
  it('replaces meta whole instead of patching it', () => {
    const c = makeComponent(HammerolaViewer, { state: { meta: { project: 'x' } } })

    expect(c.state.meta).toEqual({ project: 'x' })
    // The default's part and view are GONE, not merged under the override.
    expect(c.state.meta.parts).toBeUndefined()
    expect(c.state.meta.views).toBeUndefined()
    // One level down is still a merge: the rest of the page is the default.
    expect(c.state.view).toBe('assembled')
  })

  it('sets everything that is not state on the instance', () => {
    const sync = vi.fn()
    const c = makeComponent(HammerolaViewer, { sync, home: 'fitted' })

    expect(c.sync).toBe(sync)
    expect(c.home).toBe('fitted')
    expect(c.state.sync).toBeUndefined()
  })
})

describe('the two setState contracts', () => {
  it('mergeState writes in place and never reaches the callback', () => {
    const c = makeComponent(HammerolaViewer, { setState: mergeState })
    const before = c.state
    const done = vi.fn()

    c.setState({ view: 'other' }, done)

    // Identity kept: a fixture holding a reference still sees the live page.
    expect(c.state).toBe(before)
    expect(c.state.view).toBe('other')
    // The callback is the door to `sync()`, and this contract does not open it.
    expect(done).not.toHaveBeenCalled()
  })

  it('replaceState runs the callback and applies a function patch', () => {
    const c = makeComponent(HammerolaViewer, { setState: replaceState })
    const before = c.state
    const done = vi.fn()

    c.setState((s) => ({ view: `${s.view}-again` }), done)

    expect(c.state).not.toBe(before)
    expect(c.state.view).toBe('assembled-again')
    expect(done).toHaveBeenCalledTimes(1)
  })
})
