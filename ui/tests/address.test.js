// A page's address as ui/src/address.js reads it and spells it back. The cases
// are those of the documents page's `d=`; what the pages write through it is
// in docshell, viewlink, viewdocs, revswitch, kicad and header.

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { follow, format, parse, respell, subscribe, unsubscribe } from '../src/address.js'
import { guardSubscribers } from './addressguard.js'

guardSubscribers()

const BASE = '/project/proj1/abc123/'

/** The query `search` turns into once `fields` are spelled anew. */
const query = (search, fields) => format(respell(parse({ pathname: BASE, search, hash: '' }, null), fields))
  .slice(BASE.length)

describe('a document in the address', () => {
  it('is `d=`, none where no document is named, and keeps the rest', () => {
    expect(query('', { doc: 'report.pdf' })).toBe('?d=report.pdf')
    expect(query('?d=report.pdf', { doc: null })).toBe('')
    expect(query('?x=1&d=a', { doc: 'page.html' })).toBe('?x=1&d=page.html')
  })
})

describe('Back and Forward', () => {
  it('reach every subscriber when one throws, and its error is thrown again later', () => {
    // As separate browser listeners are: one throwing does not stop the next.
    const later = []
    vi.stubGlobal('queueMicrotask', (fn) => later.push(fn))
    const boom = new Error('boom')
    const seen = []
    const bad = () => { throw boom }
    const good = (at) => seen.push(at.path)
    subscribe(bad)
    subscribe(good)
    onTestFinished(() => { unsubscribe(bad); unsubscribe(good); vi.unstubAllGlobals() })
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(seen).toEqual([window.location.pathname])
    expect(later).toHaveLength(1)
    expect(() => later[0]()).toThrow(boom)
  })

  it('are how the page follows an address it moves to itself: one new entry, handed to every subscriber', () => {
    window.history.replaceState({ hmr: 'abc123' }, '', `${BASE}?files=k`)
    const push = vi.spyOn(window.history, 'pushState')
    const seen = []
    const one = (at) => seen.push([format(at), at.state])
    const two = (at) => seen.push([at.view])
    subscribe(one)
    subscribe(two)
    onTestFinished(() => {
      unsubscribe(one)
      unsubscribe(two)
      push.mockRestore()
      window.history.replaceState(null, '', '/')
    })
    follow(respell(parse(), { view: 'open' }))
    expect(push).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([[`${BASE}?files=k&v=open`, { hmr: 'abc123' }], ['open']])
  })
})
