// The fixtures this directory builds a PAGE out of, in one place.
//
// Nothing here renders through the DOM. A component is the real prototype with
// a state object written by hand — `Object.create(Klass.prototype)` and then
// the fields `componentDidMount` would have set — and its methods are called
// directly. That is deliberate and is not what this file changes: what it
// changes is that the same forty-line state literal used to be written out in
// nineteen files, so one new field on the page was an edit in nineteen places.
//
// WHAT THE DEFAULT STATE REPRESENTS: an ordinary build, opened by its owner.
// One printable part with an STL, one view with that part in it, a tree of one
// empty node, a token in hand, nothing selected, nothing open, no section, no
// comparison, no menu, and the light theme. It is the page every file here used
// to spell for itself, at the value the most of them spelled.
//
// AND HOW TO DIFFER FROM IT: a fixture that needs something else PASSES IT AS
// AN OVERRIDE. It does not get normalised onto the default, and the default
// does not grow a parameter for it — `makeComponent(Klass, { state: { … } })`
// is the whole mechanism, and the override is written at the call site where
// the test that depends on it can be read beside it. Where a file's value
// disagrees with the default because it MEANS something — an empty `built`, a
// catalogue with notes on it, a reader with no token — that override is the
// point of the test and belongs in the test's own file.
//
// Two GROUPS of fields are deliberately NOT in the default, although the real
// component seeds both: the proposal document (`proposal`, `proposalOpen`, …)
// and the comparison (`cmpPair`, `cmpStage`, …). Neither appears in the
// fixtures of the pages that are about neither, and seeding them here would put
// a document and a comparison under every test in the directory. The files that
// are about them — feed, proposalpanel and compare — pass them.

import { vi } from 'vitest'

import { indexTree } from '../src/hub.js'
import { HmrViewport } from '../src/viewport/element.js'

// -- the canvas every viewport test measures against ---------------------------
// 800x600 at the origin: jsdom computes no layout, so the rect a fixture hands
// back is the only one there is, and a fixture whose container and canvas are
// the same rect is what the page actually does (the two cancel).
export const RECT = { left: 0, top: 0, width: 800, height: 600 }

// -- the two waits, which are NOT the same wait --------------------------------

/** One turn of the microtask queue.
 *
 * What the viewport's reports are deferred by, exactly (`reportProposalMove` in
 * tools.js says why). A test that awaited a timer instead would still pass and
 * would no longer pin the "exactly one" part.
 */
export const settled = () => Promise.resolve()

/** Everything a fetch chain has queued behind it, run.
 *
 * A macrotask, because a chain of awaited fetches is not drained by one turn of
 * the microtask queue. Imported as `settled` by the files that mean this one.
 */
export const drained = () => new Promise((done) => { setTimeout(done, 0) })

// -- the rAF loop, driven by hand ---------------------------------------------
// The modules that animate re-arm their loop from inside the frame they are
// running, so a snapshot is taken before the callbacks run and whatever they
// queue lands in the next one.
let frames = new Map()
let nextFrame = 0

/** Install the hand-driven loop. Call from `beforeEach`. */
export function stubFrames() {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id) => { frames.delete(id) })
}

/** Run every frame that has been asked for, once. */
export const runFrames = () => {
  const due = [...frames.values()]
  frames.clear()
  for (const callback of due) callback(0)
}

// -- setState, in the two contracts the fixtures here use ----------------------
// Both are factories over the component, because the body has to close over the
// instance it is writing to. A call site names the one it means.

/** Merge, in place, and ignore the callback.
 *
 * The page as a fixture that never reaches a `setState` callback sees it. The
 * state object keeps its identity, so anything holding a reference to it goes
 * on seeing the current page.
 */
export const mergeState = (c) => vi.fn((patch) => { Object.assign(c.state, patch) })

/** The real one's CONTRACT and not React's: merge, then run the callback.
 *
 * The callback is where `set()` reaches `sync()`, which is where a change
 * becomes visible to the viewport — so a fixture whose test goes through that
 * door needs this one. A function patch is applied against the current state,
 * the way React applies one.
 */
export const replaceState = (c) => vi.fn((patch, done) => {
  const next = typeof patch === 'function' ? patch(c.state) : patch
  c.state = { ...c.state, ...next }
  if (done) done()
})

/** The ordinary build, opened by its owner. See the note at the top of the file. */
const defaultState = () => ({
  meta: {
    project: 'fixture', commit: 'abc1234', built: '',
    parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
    views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
              parts: ['lid'], gzip: 1000 }],
  },
  builds: null,
  tree: indexTree({ id: '/model', name: 'model', children: [] }),
  error: null, viewError: null, pending: null, swapping: false,
  view: 'assembled', tool: null, held: false,
  sel: null, selName: '', hidden: [], ghost: [], expanded: {},
  secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
  secFace: null, secPop: false,
  revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
  bannerGone: false, rail: false, menu: null,
  notePop: null, noteDraft: '', notes: {},
  feed: [], activePin: null, composer: null, sending: false,
  measure: null, toast: null,
  token: 'sekrit', tokenPop: false, tokenDraft: '',
  theme: 'light', tabs: [], narrow: false, treeOpen: false,
})

/**
 * A page on the real prototype, with the state above and the fields the
 * constructor sets.
 *
 * `overrides.state` is merged OVER the default state, one level deep — so
 * `meta` is replaced whole rather than patched, and a fixture that changes one
 * field of it spells the meta it means. Everything else in `overrides` is set
 * on the INSTANCE, which is where `sync`, `toast`, `schedulePoll` and the rest
 * of the spies go.
 *
 * `setState` is a factory over the component: pass `mergeState` or
 * `replaceState` (see above) rather than a function of your own, unless the
 * fixture has to record the patches as well.
 */
export function makeComponent(Klass, { state = {}, setState = mergeState, ...fields } = {}) {
  const c = Object.create(Klass.prototype)
  c.props = { ...Klass.defaultProps }
  // The four the constructor seeds and every page here needs: the ref
  // `render()` hangs the viewport off, the fitted frame, the visibility a build
  // swap carries across, and the undo stack.
  c.host = { current: null }
  c.home = null
  c.carry = null
  c.history = []
  c.state = { ...defaultState(), ...state }
  c.setState = setState(c)
  Object.assign(c, fields)
  return c
}

/**
 * A viewport on the real prototype, with the fields `connectedCallback` and
 * `show()` would have written.
 *
 * The defaults are a viewport that HAS rendered a build (`drawnKey`) with no
 * proposal panel open over it (`payload`, `overlayParts`), whose container is
 * the same rect as its canvas, and whose events are a spy — `dispatchEvent` is
 * a real DOM method on a prototype chain that reaches HTMLElement, and it
 * refuses to run on an object the DOM never built.
 *
 * Everything in `overrides` is set on the instance, after the defaults, so the
 * scene the library stands in (`fakeViewport`) is spread in there.
 */
export function makeViewport(overrides = {}) {
  const vp = Object.create(HmrViewport.prototype)
  vp.holdActive = false
  vp.drawnKey = 'build-1'
  vp.payload = null
  vp.overlayParts = []
  vp.box = { getBoundingClientRect: () => ({ ...RECT }) }
  vp.dispatchEvent = vi.fn()
  Object.assign(vp, overrides)
  return vp
}
