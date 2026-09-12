// `/start`, the one route this bundle asks for without a token — and the only
// one whose every failure has to be silence.
//
// A FILE OF ITS OWN, for the reason `arrangement.test.js` is one: `entry.test.js`
// mocks hub.js so the page can be driven a state at a time, and the question
// here is what the REAL function does with what a hub (or a proxy, or a captive
// portal) actually answers. Vitest resets the module registry between files, so
// this is the cheap way to have both.
//
// WHAT IS BEING PINNED is a promise that resolves for everything. `loadIndex`
// beside it throws, and rightly: that fetch is the page. This one is a hint on
// top of a sign-in form that works without it, so an unreachable hub, an HTML
// error page and a manifest with the wrong fields must all end as "no block" —
// and every test below is written as a plain `await` precisely so that a
// rejection fails it.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { hubOrigin, loadStart, startHint } from '../src/hub.js'

/** The manifest as src/onboarding.py writes it. */
const MANIFEST = {
  empty: true,
  skill: '/start/skill.md',
  client: '/start/hammerola',
  template: '/start/template.tar.gz',
}

const served = (payload) => ({ ok: true, status: 200, json: async () => payload })
/**
 * A refusal WITH A READABLE BODY, and the body is the point.
 *
 * An error page that answers `{}` proves nothing: the shape check would refuse
 * it anyway, and a `loadStart` that ignored the status entirely passed — checked
 * by removing the status test, which left every test in this file green. So the
 * body here is a perfectly good manifest, and the only thing that can refuse it
 * is the status. Not a contrivance either: a proxy or a gateway in front of the
 * hub answers 401 and 502 with JSON of its own.
 */
const refused = (status) => ({ ok: false, status, json: async () => MANIFEST })
/** A proxy, a captive portal, a 200 with an HTML body — `json()` rejects. */
const garbled = () => ({
  ok: true,
  status: 200,
  json: async () => { throw new SyntaxError('Unexpected token <') },
})

const answering = (response) => {
  const fetching = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetching)
  return fetching
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// -- what the two pages get --------------------------------------------------

describe('reading the manifest', () => {
  it('offers the two paths and what the hub said about being empty', async () => {
    answering(served(MANIFEST))
    expect(await loadStart()).toEqual({
      skill: '/start/skill.md',
      client: '/start/hammerola',
      empty: true,
    })
  })

  it('asks /start and sends no credential with it', async () => {
    // The whole init, not just the URL: the route is public and its reader at
    // the door has no token, so a header here would make the block's arrival
    // depend on the very thing it exists to help somebody get. `no-store`
    // because `empty` is a fact about the deployment that changes with the
    // first push.
    const fetching = answering(served(MANIFEST))
    await loadStart()
    expect(fetching).toHaveBeenCalledWith('/start', { cache: 'no-store' })
  })

  it('carries nothing but the two paths and the boolean onward', async () => {
    // `template` is in the manifest and has a reader (`hammerola create`); this
    // page is not it. The two versions are read by the client for the same
    // reason. Passing the whole document through would put fields on these
    // screens that nothing draws and that the next reader has to decide about.
    answering(served(MANIFEST))
    expect(Object.keys(await loadStart()).sort()).toEqual(['client', 'empty', 'skill'])
  })
})

// -- the boolean -------------------------------------------------------------
//
// IT IS A FIELD HERE AND A CONDITION ON THE DOOR (issue #91). What this file
// pins is that the field says exactly what the hub said; that the door and only
// the door acts on it is entry.test.js's, in `the block for an agent`.

describe('how empty is read', () => {
  it('is true only when the hub said exactly true', () => {
    expect(startHint(MANIFEST).empty).toBe(true)
  })

  it.each([
    ['false', false],
    ['a missing key', undefined],
    ['the word', 'true'],
    ['a number', 1],
    ['a list of nothing', []],
  ])('is false for %s', (_name, empty) => {
    // A strict comparison and not a truthy test, because what comes back need
    // not be the manifest: three of the five above are truthy, and each of them
    // would put a "nothing published here yet" block on the door of a hub with
    // forty projects on it. The paths come through all the same — the list
    // prints them on such a hub, which is the whole of why the gate moved.
    expect(startHint({ ...MANIFEST, empty }).empty).toBe(false)
    expect(startHint({ ...MANIFEST, empty }).skill).toBe('/start/skill.md')
  })

  it('is nothing at all for a document that is not one', () => {
    expect(startHint(null)).toBeNull()
    expect(startHint('empty')).toBeNull()
    expect(startHint(42)).toBeNull()
  })
})

// -- the paths ---------------------------------------------------------------

describe('which paths are usable', () => {
  it.each([
    ['a missing one', undefined],
    ['a number', 7],
    ['an empty string', ''],
    ['a bare word', 'start/skill.md'],
    ['an absolute address', 'https://elsewhere.example/start/skill.md'],
  ])('refuses the whole block for %s', (_name, skill) => {
    // HALF A BLOCK IS THE FAILURE WORTH NAMING: the lines are one message, and
    // one of them reading `Skill: undefined` is worse than no block.
    //
    // WHAT IS NOT BEING TESTED IS A BOUNDARY. Every case above is a manifest
    // that is no good for an ordinary reason — a broken image, a proxy, a field
    // of the wrong type. `/start` comes from the SAME hub as this page and this
    // bundle, so there is nothing here to defend against: a hub that wanted to
    // point an agent elsewhere would write the address into the HTML rather
    // than smuggle it through a field of its own manifest.
    expect(startHint({ ...MANIFEST, skill })).toBeNull()
    expect(startHint({ ...MANIFEST, client: skill })).toBeNull()
  })
})

// -- every way it can fail ---------------------------------------------------

describe('a hub that did not answer the question', () => {
  it('is no block when the route is not there', async () => {
    answering(refused(404))
    expect(await loadStart()).toBeNull()
  })

  it('is no block when the answer is not JSON', async () => {
    answering(garbled())
    expect(await loadStart()).toBeNull()
  })

  it('is no block when the fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await loadStart()).toBeNull()
  })

  it('is no block where there is no fetch at all', async () => {
    // An old browser, or a page opened in something that is not one. The whole
    // call is inside one try, so "there is nothing to call" ends where every
    // other failure does.
    vi.stubGlobal('fetch', undefined)
    expect(await loadStart()).toBeNull()
  })
})

// -- where the hub is --------------------------------------------------------

describe('the hub address', () => {
  it('is the one this page was loaded from', () => {
    // DERIVED, never written down: this repository carries the address of no
    // deployment, and a page served by the hub already knows where it is.
    expect(hubOrigin()).toBe(window.location.origin)
    expect(hubOrigin()).toBeTruthy()
  })
})
