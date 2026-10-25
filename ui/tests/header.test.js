// The header of the build page, and the one panel that hangs off it — the three
// answers `computed()` gives about WHICH BUILD this is and what is open beside
// it. None of them is a layout question: they are values the component
// computes, and each has to be computed in the right shape.
//
//   * the revision button draws the slot shortened. On a pointer that reads
//     `dev` or `latest`; on a pinned revision it is the digest of the sources —
//     64 characters — which the picker the button opens draws at seven;
//   * the picker's rows carry the date AND the clock: publishing is `hammerola
//     build` from a laptop, run as often as an author saves, so the date alone
//     would say the same thing on every row;
//   * the comment rail is closed on arrival: it takes 300 px of a page whose
//     whole job is showing a model.
//
// ALMOST NOTHING IS RENDERED HERE, the arrangement every file in this directory
// uses: the instance is the real prototype with the state spelled out, and the
// real `computed()` runs over it. The layout around these values is checked from
// Python against the source (tests/test_ui_source.py).
//
// THE ONE EXCEPTION IS BELOW. `computed()` and `render()` are two halves of a
// claim like "the whole digest stays within reach": one produces the value, the
// other puts it on an element where a reader can hover it and copy it for
// `hammerola source <rev>`. `render()` returns plain objects, so reading what it
// drew costs no DOM and no mounting (ui/tests/eltree.js).
//
// `PAGE` IS STUBBED AND `shortId` IS NOT. The page reads which build it is off
// its own URL, and jsdom's URL is `/` — so the interesting slot cannot be
// reached without saying what it is. What is under test is the chain from that
// slot to what the header shows, so the helper doing the shortening is left
// real; a stubbed one would let this file agree with itself.

import { beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.hoisted`, because the factory below is lifted above every other statement
// in this file and a plain `const` up here would not exist yet when it runs.
//
// ONE MUTABLE OBJECT rather than a mock re-registered per test, and that is the
// whole arrangement. `PAGE` is read as `PAGE.slot` at the moment `computed()`
// runs, so pointing this file's three slots at one object and changing its field
// is enough — no `vi.doMock`, no `vi.resetModules`, nothing to undo.
//
// (`vi.mock` is hoisted and registered ONCE, so a `vi.doUnmock` in a `finally`
// would take the registration away for every later test in the file.)
const { REV, PAGE } = vi.hoisted(() => {
  const rev = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'
  return { REV: rev, PAGE: { pid: 'proj1', slot: rev, base: `/project/proj1/${rev}/` } }
})

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PAGE,
}))

/** Put the page on one slot, the way its URL would have. */
const onSlot = (slot) => {
  PAGE.slot = slot
  PAGE.base = `/project/${PAGE.pid}/${slot}/`
}

// Every test starts on the pinned revision; the two that want a pointer say so.
beforeEach(() => onSlot(REV))

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { loadBuilds } from '../src/hub.js'
import { makeComponent } from './component.js'
import { collect, texts } from './eltree.js'

/** The component as `computed()` sees it, on a pinned revision with a history. */
function component({ builds = null, rail = null, props = {} } = {}) {
  return makeComponent(HammerolaViewer, {
    props: { ...HammerolaViewer.defaultProps, ...props },
    state: {
      meta: {
        project: 'fixture', commit: REV, built: '2026-08-27T18:20:00Z',
        parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
        views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                  parts: ['lid'], gzip: 1000 }],
      },
      builds,
      rail, menu: { id: null, x: 0, y: 0 },
      // A token, because the rail is drawn for the customer and hidden from the
      // viewer entirely — without one, "closed" would be true for the wrong
      // reason and the test would pass with the default flipped back.
      token: 'sekrit',
    },
  })
}

// -- the line under the title, and the tab strip ------------------------------
//
// `views[].parts` NAMES the catalogue keys a view shows; read as a count it
// would render as `lid,post,pin parts`. So both readers of it are asserted on
// their text, which is what a reader is actually shown.

describe('what the header says about this build', () => {
  /** The page on a build with the given views, opened on the first of them. */
  const showing = (views) => {
    const c = component()
    c.state.meta.views = views
    c.state.view = views[0].id
    return c
  }

  const VIEWS = [
    { id: 'assembled', name: 'assembled', file: 'a.json',
      parts: ['lid', 'post', 'pin'], gzip: 1_400_000 },
    { id: 'print', name: 'print', file: 'p.json', parts: ['lid'], gzip: 600_000 },
  ]

  it('counts the parts of THIS view and sizes the whole build', () => {
    // The count is the LENGTH of the list and nothing else, so what it counts
    // is whatever the hub put on the list. That five of one pin is one part is
    // a property of the BUILD (`list(dict.fromkeys(...))` in
    // src/cadbuild/views.py), asserted by
    // `test_a_real_export_is_a_document_the_hub_would_accept` in
    // tests/cadbuild/test_views.py.
    expect(showing(VIEWS).computed().subtitle).toBe('3 parts · 2 views · 2.0 MB')
  })

  it('says the same on every tab, without fetching a single view file', () => {
    // The promise the field exists to keep, and the reason it is a list rather
    // than the geometry: a reader learns what is in a tab before opening it.
    expect(showing(VIEWS).computed().viewTabs.map((t) => t.hint))
      .toEqual(['3 parts · 1.4 MB', '1 parts · 0.6 MB'])
  })

  it('says nothing rather than NaN when a view declares no list at all', () => {
    // A hand-made document, or one this page did not get from a push: no
    // `parts` on the view at all. `undefined.length` would take the header
    // down, and `${undefined} parts` would put the word "undefined" on the
    // page.
    const c = showing([{ id: 'assembled', name: 'assembled', file: 'a.json', gzip: 0 }])
    expect(c.computed().subtitle).toBe('0 parts · 1 view · 0.0 MB')
    expect(c.computed().viewTabs[0].hint).toBe('0 parts · 0.0 MB')
  })

  it('says nothing when the field is a NUMBER, either', () => {
    // The other shape of the same hand-made document, and it is not the one
    // above: the field is there and it is a number. `3` has no `.length`, so
    // the guard has to be `Array.isArray` and not "is it there"; asserting the
    // absent case alone leaves the reading that would put `undefined parts` on
    // the header.
    const c = showing([{ id: 'assembled', name: 'assembled', file: 'a.json',
                        parts: 3, gzip: 0 }])
    expect(c.computed().subtitle).toBe('0 parts · 1 view · 0.0 MB')
    expect(c.computed().viewTabs[0].hint).toBe('0 parts · 0.0 MB')
  })
})

// -- which revision this is --------------------------------------------------

describe('the revision in the header', () => {
  it('is cut to the length the rest of the site reads a revision at', () => {
    const v = component().computed()
    expect(v.slot).toBe('e05f73b')
    expect(v.slot).toHaveLength(7)
  })

  it('keeps the whole digest within reach rather than only on screen', () => {
    // Seven characters cannot be pasted into `hammerola source <rev>`, and the
    // header is where somebody looks for the id of the thing they are looking
    // at. The full value stays as the button's title.
    //
    // Both halves: `computed()` naming the value and `render()` hanging it on
    // an element are one claim, and "within reach" is a property of the
    // render. And on the revision button, not merely somewhere on the page:
    // exactly one element carries it, identified by WHAT IT DOES — clicking it
    // opens the build picker, which nothing else in the header does. Identity
    // against `v.revToggle` would not work: `computed()` builds a fresh closure
    // on every call, and `render()` calls it again, so the handler on the
    // element is never the object this test holds.
    const c = component()
    expect(c.computed().slotTitle).toBe(REV)

    const carrying = collect(c.render(), (el) => (el.props.title === REV ? el : undefined))
    expect(carrying, 'the header computes the full digest and then draws nothing with '
      + 'it — nobody can read it or copy it out').toHaveLength(1)

    expect(c.state.revOpen).toBe(false)
    expect(typeof carrying[0].props.onClick, 'the element carrying the full digest '
      + 'does nothing when clicked, so it is not the revision button').toBe('function')
    carrying[0].props.onClick({ stopPropagation() {} })
    expect(c.state.revOpen, 'the full digest hangs off some element that is not the '
      + 'revision button — it reads as a tooltip on the wrong thing').toBe(true)
  })

  it('offers no tooltip where nothing was cut', () => {
    // A tooltip repeating the word already under the cursor is noise, and
    // "shortened" and "worth a tooltip" have to stay the same question.
    onSlot('latest')
    expect(component().computed().slotTitle).toBe('')
    onSlot('dev')
    expect(component().computed().slotTitle).toBe('')
  })

  it('leaves a pointer name alone', () => {
    // `dev` and `latest` are the two slots that are not digests. Cutting them
    // would be cutting a word, and `dev` is three characters to begin with.
    onSlot('dev')
    expect(component().computed().slot).toBe('dev')
    onSlot('latest')
    expect(component().computed().slot).toBe('latest')
  })
})

// -- when it was built -------------------------------------------------------

describe('the build picker', () => {
  const rows = (built) => component({
    builds: { has_dev: false, latest: null, builds: built },
  }).computed().revRows

  it('says the time as well as the date', () => {
    // The list exists to choose BETWEEN builds, and `hammerola build` publishes
    // several a day: a column of identical dates answers the one question the
    // menu is open for with nothing at all.
    const [row] = rows([{ commit: REV, built: '2026-08-27T18:20:00Z' }])
    expect(row.date).toBe('2026-08-27 18:20')
  })

  it('says it in the same shape the header does', () => {
    // The two were formatted differently while naming the same instant, which
    // reads as two different facts about one build.
    const c = component({ builds: { has_dev: false, latest: null,
                                    builds: [{ commit: REV, built: '2026-08-27T18:20:00Z' }] } })
    const v = c.computed()
    expect(v.revRows[0].date).toBe(v.slotDate)
  })

  it('draws a build that carries no time at all without inventing one', () => {
    // `built` comes out of a pushed meta.json and is not validated beyond being
    // a string. Whatever it is, it is shown as it is.
    expect(rows([{ commit: REV, built: '' }])[0].date).toBe('')
    expect(rows([{ commit: REV, built: 'whenever' }])[0].date).toBe('whenever')
  })

  it('still shows each revision short', () => {
    expect(rows([{ commit: REV, built: '2026-08-27T18:20:00Z' }])[0].id).toBe('e05f73b')
  })

  it('marks the revision you are ON more faintly than the row you PICKED', () => {
    // TWO BLUE WASHES A FEW PIXELS APART, saying two different things: this row
    // is the build the address names, and the tree's highlighted row is the
    // part the reader just clicked. Nothing but WEIGHT tells them apart — same
    // hue, same shape, adjacent panels — so the two must not resolve to one
    // token; folded into one, everything still renders in both themes and no
    // other test notices.
    //
    // The TOKENS and not their values, because the values are in
    // static/_v/tokens.css and that file's own tests hold the two apart there.
    // What this owns is that the two CALL SITES keep asking for different ones.
    const c = picker()
    c.state.sel = '/model'
    const v = c.computed()

    const current = v.revRows.find((r) => r.key === REV)
    const [row] = v.rows
    const tokenOf = (style) => (style.match(/background:(var\(--[\w-]+\))/) || [])[1]

    expect(tokenOf(current.style), 'the current revision row draws no background')
      .toBeTruthy()
    expect(tokenOf(row.rowStyle), 'the selected tree row draws no background')
      .toBeTruthy()
    expect(tokenOf(current.style),
      'the row you are on and the row you picked are painted the same')
      .not.toBe(tokenOf(row.rowStyle))
  })

  // -- and what happens when one is picked -----------------------------------

  const OTHER = '7b1c0d4a2e6f8901234567890abcdef0123456789abcdef0123456789abcdef0'

  /** The picker with both pointers and two builds in it. */
  const picker = () => component({
    builds: {
      has_dev: true,
      latest: OTHER,
      builds: [{ commit: REV, built: '2026-08-27T18:20:00Z' },
               { commit: OTHER, built: '2026-08-26T10:00:00Z' }],
    },
  })

  it('hands a picked revision to the in-place switch', () => {
    // A build is an ADDRESS, and `history.pushState` says so without throwing
    // the document away — which is what keeps the camera, the hidden parts and
    // the section across the one gesture they are worth the most in. The row's
    // whole job is to name the build; what the switch
    // then does with it is ui/tests/revswitch.test.js.
    //
    // Stubbed on the INSTANCE, because `computed()` builds a fresh closure on
    // every call and the handler reads `this.switchBuild` when it fires.
    const c = picker()
    c.switchBuild = vi.fn(() => Promise.resolve())

    const row = c.computed().revRows.find((r) => r.key === OTHER)
    row.onPick({ stopPropagation() {} })

    expect(c.switchBuild).toHaveBeenCalledWith('proj1', OTHER)
  })

  it('takes the two pointer rows through the same door', () => {
    // `dev` and `latest` are names rather than digests, but they are the same
    // kind of thing to pick: a slot of this project with a build behind it. A
    // row that navigated while its neighbour swapped would lose the frame on
    // exactly the two rows a reader clicks most.
    const c = picker()
    c.switchBuild = vi.fn(() => Promise.resolve())

    c.computed().revRows.find((r) => r.key === 'dev').onPick({ stopPropagation() {} })
    c.computed().revRows.find((r) => r.key === 'latest').onPick({ stopPropagation() {} })

    expect(c.switchBuild.mock.calls.map((call) => call[1])).toEqual(['dev', 'latest'])
  })
})

// -- what is open beside the model -------------------------------------------

describe('the comment rail', () => {
  it('is closed on a page nobody has touched yet', () => {
    // `rail: null` is the state a fresh page is in — "the reader has not said".
    // The whole finding: this page is for looking at a model, and the rail is a
    // panel about something else.
    expect(component({ rail: null }).computed().railStyle).toContain('display:none')
  })

  it('opens on the first click of the header button', () => {
    const c = component({ rail: null })
    c.computed().railToggle({ stopPropagation() {} })
    expect(c.state.rail).toBe(true)
    expect(c.computed().railStyle).toContain('display:flex')
  })

  it('closes again on the next one', () => {
    const c = component({ rail: true })
    c.computed().railToggle({ stopPropagation() {} })
    expect(c.state.rail).toBe(false)
  })

  it('says how many open items it holds without being opened', () => {
    // What makes a closed rail acceptable rather than a feature switched off:
    // the count is on the button, so nothing is hidden from a reader who has a
    // reason to open it.
    const c = component({ rail: null })
    c.state.feed = [
      { id: '1', text: 'a', status: 'open' },
      { id: '2', text: 'b', status: 'resolved' },
    ]
    expect(c.computed().openCount).toBe(1)
  })

  it('is not remembered — a page opens closed however the last one was left', async () => {
    // The decision, said out loud so a later change has to argue with it rather
    // than drift past it: the rail also opens BY ITSELF, on a pin click and on
    // posting a comment, so a remembered "open" would turn one click on one pin
    // into "always show me the queue" — a preference nobody expressed.
    expect(HammerolaViewer.defaultProps.commentsOpen).toBe(false)
    // And nothing in the browser's memory is about it: store.js is the only
    // module on this side allowed to touch storage at all
    // (tests/test_ui_source.py), so its exports are the whole list of what
    // outlives a visit.
    const store = await import('../src/store.js')
    expect(Object.keys(store).filter((name) => /rail|comment/i.test(name))).toEqual([])
  })
})

// -- a shared link: what its reader is shown, and how the owner gets one -------

describe('a reader without the token', () => {
  it('gets the revision as a label, with no picker to open', () => {
    // builds.json is behind the token, so there is no list to open and the
    // button must not pretend there is one.
    const c = component()
    c.state.token = null
    const v = c.computed()
    expect(v.revPicker).toBe(false)
    expect(v.revToggle).toBeUndefined()
  })

  it('keeps the picker for the owner', () => {
    const v = component().computed()
    expect(v.revPicker).toBe(true)
    expect(typeof v.revToggle).toBe('function')
  })

  it('is drawn no menu, and the owner is', () => {
    // The render half of the claim above: a computed flag nobody reads would
    // leave the rows and Compare on the page.
    const compareButtons = (c) => collect(c.render(), (el) =>
      ([].concat(el.props.children).includes('Compare ') ? el : undefined))
    const viewer = component()
    viewer.state.token = null
    expect(compareButtons(viewer)).toHaveLength(0)
    expect(compareButtons(component())).toHaveLength(1)
  })

  it('never asks for the list of revisions', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      const c = component()
      c.state.token = null
      c.refreshBuilds()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('while the owner asks for it with the token', async () => {
    // Without the header the owner gets a 403 and an empty picker, silently.
    const seen = []
    vi.stubGlobal('fetch', (url, init) => {
      seen.push(init)
      return Promise.resolve({ ok: true, json: () => ({}) })
    })
    try {
      await loadBuilds('sekrit')
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen[0].headers).toEqual({ 'X-Hammerola-Token': 'sekrit' })
  })
})

describe('the Share window', () => {
  // THE ONE WAY TO A LINK. It opens from a row of the revision picker, which
  // only the owner has; `latest` gives a link that follows every new build, a
  // revision a link to exactly that one, and the box adds the key that opens
  // that address's files.
  const KEYS = { latest: 'key-of-latest', [REV]: 'key-of-rev', dev: 'key-of-dev' }
  const click = { stopPropagation() {} }

  /** The owner's page, the picker holding both pointers and one revision. */
  const owner = (keys = KEYS) => component({
    builds: {
      has_dev: true, latest: REV,
      builds: [{ commit: REV, built: '2026-08-27T18:20:00Z' }],
      ...(keys ? { files_keys: keys } : {}),
    },
  })
  const row = (c, key) => c.computed().revRows.find((r) => r.key === key)
  /** The window opened from one row, as a click on its icon opens it. */
  const opened = (key, keys) => {
    const c = owner(keys)
    row(c, key).onShare(click)
    return c
  }

  /** Copy with a stubbed clipboard: what was written, and the toast. */
  const copy = async (c, writeText) => {
    const written = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeText || ((t) => { written.push(t) }) },
      configurable: true,
    })
    try {
      await c.computed().copyShare()
    } finally {
      delete navigator.clipboard
    }
    return { written, toast: c.state.toast }
  }

  it('is offered on latest and on every revision, and not on the draft', () => {
    // The draft has no permanent address to give. Its icon keeps its space,
    // so the rows still line up.
    const c = owner()
    expect(typeof row(c, 'latest').onShare).toBe('function')
    expect(typeof row(c, REV).onShare).toBe('function')
    expect(row(c, 'dev').onShare).toBeUndefined()
    expect(row(c, 'dev').shareIconStyle).toContain('visibility:hidden')
  })

  it('opens without the files, on the full commit, and closes the picker', () => {
    const c = owner()
    c.state.revOpen = true
    row(c, REV).onShare(click)
    expect(c.state.revOpen).toBe(false)
    // The row SHOWS seven characters; the address needs all of them.
    expect(c.state.share).toEqual({ id: REV, files: false })
    const v = c.computed()
    expect(v.shareOpen).toBe(true)
    expect(v.shareHead).toBe('Share e05f73b')
    expect(v.shareFilesMark).toBe('')
    expect(v.shareLink).toBe(`${location.origin}/project/proj1/${REV}/`)
  })

  it('gives latest the moving address, not the revision behind it', () => {
    const v = opened('latest').computed()
    expect(v.shareHead).toBe('Share latest')
    expect(v.shareLink).toBe(`${location.origin}/project/proj1/latest/`)
  })

  it('adds the key of THAT address when the files are ticked', () => {
    const latest = opened('latest')
    latest.computed().toggleShareFiles()
    expect(latest.computed().shareLink)
      .toBe(`${location.origin}/project/proj1/latest/?files=key-of-latest`)

    const rev = opened(REV)
    rev.computed().toggleShareFiles()
    expect(rev.computed().shareFilesMark).toBe('✓')
    expect(rev.computed().shareLink)
      .toBe(`${location.origin}/project/proj1/${REV}/?files=key-of-rev`)
  })

  it('carries the view on screen when it is not the first one, beside the key', () => {
    const c = opened(REV)
    c.state.meta.views = [
      { id: 'assembled', name: 'assembled', file: 'a.json', parts: [], gzip: 0 },
      { id: 'print', name: 'print', file: 'p.json', parts: [], gzip: 0 },
    ]
    c.state.view = 'print'
    expect(c.computed().shareLink).toBe(`${location.origin}/project/proj1/${REV}/?v=print`)
    c.computed().toggleShareFiles()
    expect(c.computed().shareLink)
      .toBe(`${location.origin}/project/proj1/${REV}/?v=print&files=key-of-rev`)
  })

  it('carries the document over the model, between the view and the key', () => {
    const c = opened(REV)
    c.state.meta.documents = [{ id: 'docs__cut-list.md', name: 'docs/cut-list.md',
                                type: 'markdown', file: 'docs/cut-list.md', bytes: 10 }]
    c.state.doc = 'docs__cut-list.md'
    expect(c.computed().shareLink)
      .toBe(`${location.origin}/project/proj1/${REV}/?d=docs__cut-list.md`)
    c.state.meta.views = [
      { id: 'assembled', name: 'assembled', file: 'a.json', parts: [], gzip: 0 },
      { id: 'print', name: 'print', file: 'p.json', parts: [], gzip: 0 },
    ]
    c.state.view = 'print'
    c.computed().toggleShareFiles()
    expect(c.computed().shareLink).toBe(
      `${location.origin}/project/proj1/${REV}/?v=print&d=docs__cut-list.md&files=key-of-rev`)
  })

  it('carries the camera on screen as `c=` only with Current view ticked, before the key', () => {
    // The frame is read off the viewport as the window renders. Every other
    // test here has no viewport (`host.current` is null), and no `c=` at all.
    const c = opened(REV)
    c.host = { current: { getCamera: () => ({
      position: [10, -20, 30.5], quaternion: [0, 0, 0, 1], target: [1, 2, 3], zoom: 1.5,
    }) } }
    expect([c.computed().shareCameraMark, c.computed().shareLink])
      .toEqual(['', `${location.origin}/project/proj1/${REV}/`])
    const box = collect(c.render(), (el) => (
      [].concat(el.props.children).includes('Current view') ? el : undefined))
    expect(box).toHaveLength(1)
    box[0].props.onClick()
    expect(c.computed().shareCameraMark).toBe('✓')
    c.computed().toggleShareFiles()
    expect(c.computed().shareLink).toBe(
      `${location.origin}/project/proj1/${REV}/?c=10,-20,30.5,0,0,0,1,1,2,3,1.5&files=key-of-rev`)
    // A document covers the model: no box, and no frame in its link.
    c.state.meta.documents = [{ id: 'notes.md', name: 'notes.md', type: 'markdown', file: 'notes.md', bytes: 9 }]
    c.state.doc = 'notes.md'
    expect(texts(c.render())).not.toContain('Current view')
    expect(c.computed().shareLink)
      .toBe(`${location.origin}/project/proj1/${REV}/?d=notes.md&files=key-of-rev`)
  })

  it('cannot be ticked when builds.json came without the keys, and says why', () => {
    const c = opened(REV, null)
    const v = c.computed()
    expect(v.toggleShareFiles).toBeUndefined()
    expect(v.shareFilesHint).toBe('This hub did not send the download keys')
    // Even a ticked box puts no key that does not exist into the link.
    c.state.share = { id: REV, files: true }
    expect(c.computed().shareLink).toBe(`${location.origin}/project/proj1/${REV}/`)
    expect(c.computed().shareFilesMark).toBe('')
  })

  it('copies the link it shows, and says so', async () => {
    const c = opened(REV)
    c.computed().toggleShareFiles()
    const { written, toast } = await copy(c)
    expect(written).toEqual([`${location.origin}/project/proj1/${REV}/?files=key-of-rev`])
    expect(toast).toBe('link copied')
  })

  it('says so when the clipboard refuses, rather than "copied"', async () => {
    const { toast } = await copy(opened(REV), () => Promise.reject(new Error('denied')))
    expect(toast).toBe('Could not copy the link')
  })

  it('closes on Close and on the overlay, and a click on the card stays in it', () => {
    // Render half: what closes it has to be on the elements that say so.
    // The overlay is the element whose child is the 380px card.
    const c = opened(REV)
    const isCard = (el) => !!(el && el.props && el.props.style && el.props.style.width === '380px')
    const overlay = collect(c.render(), (el) => (
      [].concat(el.props.children).some(isCard) ? el : undefined))
    expect(overlay).toHaveLength(1)
    const card = [].concat(overlay[0].props.children).find(isCard)
    const stopped = vi.fn()
    card.props.onClick({ stopPropagation: stopped })
    expect(stopped).toHaveBeenCalled()
    expect(c.state.share).not.toBeNull()

    overlay[0].props.onClick(click)
    expect(c.state.share).toBeNull()
    expect(texts(c.render())).not.toContain('Copy')

    const again = opened(REV)
    const close = collect(again.render(), (el) => (el.props.children === 'Close' ? el : undefined))
    expect(close).toHaveLength(1)
    close[0].props.onClick(click)
    expect(again.state.share).toBeNull()
  })

  it('closes on Escape, with the menus', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = opened(REV)
    Object.assign(c, { load: vi.fn(async () => {}), loadFeed: vi.fn(),
                       loadProposal: vi.fn(), sync: vi.fn() })
    c.componentDidMount()
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(c.state.share).toBeNull()
    } finally {
      c.componentWillUnmount()
      vi.restoreAllMocks()
    }
  })

  it('takes an Escape that closed something, so a KiCad design under it keeps its selection', () => {
    // KicadView puts its selection out on an Escape nobody took, and listens
    // after the page.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = opened(REV)
    Object.assign(c, { load: vi.fn(async () => {}), loadFeed: vi.fn(),
                       loadProposal: vi.fn(), sync: vi.fn() })
    c.componentDidMount()
    const taken = () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    try {
      const share = taken()
      c.setState({ viewsOpen: true })
      expect([share, taken(), taken(), c.state.viewsOpen]).toEqual([true, true, false, false])
      // an armed tool is not on screen under an open document: closing it is no
      // Escape the design under that document should miss
      c.setState({ tool: 'measure', doc: 'readme' })
      const underDocument = taken()
      c.setState({ tool: 'measure', doc: null })
      expect([underDocument, taken()]).toEqual([false, true])
    } finally {
      c.componentWillUnmount()
      vi.restoreAllMocks()
    }
  })

  it('is the only way to a link: the header copies none', () => {
    // A copied address without the key, sent on, would lose its reader the
    // files without anybody noticing.
    const c = owner()
    expect(texts(c.render())).not.toContain('Copy link')
    expect(c.computed().copyLink).toBeUndefined()
  })
})
