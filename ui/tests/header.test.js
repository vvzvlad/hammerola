// The header of the build page, and the one panel that hangs off it — the three
// answers `computed()` gives about WHICH BUILD this is and what is open beside
// it. All three were wrong in a way a test could not have caught before, because
// none of them is a layout question: they are values the component computes, and
// each of them was computed from the right data in the wrong shape.
//
//   * the revision button drew `PAGE.slot` raw. On a pointer that reads `dev` or
//     `latest`; on a pinned revision it is the digest of the sources — 64
//     characters — while the picker the button opens has always drawn the same
//     value at seven. The header contradicted its own menu;
//   * the picker's rows carried the DATE and no clock, from a helper written for
//     a list of CI commits. Publishing is `hammerola build` from a laptop now,
//     run as often as an author saves, so the column that is supposed to tell
//     two builds apart said the same thing on every row;
//   * the comment rail was open on arrival, taking 300 px of a page whose whole
//     job is showing a model, from readers who had not asked to see a queue.
//
// ALMOST NOTHING IS RENDERED HERE, the arrangement every file in this directory
// uses: the instance is the real prototype with the state spelled out, and the
// real `computed()` runs over it. The layout around these values is checked from
// Python against the source (tests/test_ui_source.py).
//
// THE ONE EXCEPTION IS BELOW, and it is worth knowing why it had to be made.
// `computed()` and `render()` are two halves of a claim like "the whole digest
// stays within reach": one produces the value, the other puts it on an element
// where a reader can hover it. Checking the first half alone left `title=
// {v.slotTitle}` deletable with the entire suite green — the digest computed,
// shown to nobody, uncopyable, and `hammerola source <rev>` with nowhere to
// read its argument from. `render()` returns plain objects, so reading what it
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
// What that replaces was a trap: `vi.mock` is hoisted and registered ONCE, so a
// `vi.doUnmock` in a `finally` takes the registration away for good. Two tests
// here did that, and every later test in the file was quietly running against
// the real `hub.js` — which reads the slot off jsdom's URL, i.e. the empty
// string. The same mistake is why `arrangement.test.js` is a file of its own.
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
import { indexTree } from '../src/hub.js'
import { collect } from './eltree.js'

/** The component as `computed()` sees it, on a pinned revision with a history. */
function component({ builds = null, rail = null, props = {} } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps, ...props }
  c.home = null
  c.host = { current: null }
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', commit: REV, built: '2026-08-27T18:20:00Z', downloads: {},
      variants: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: 3, gzip: 1000 }],
    },
    builds,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail, menu: { id: null, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    // A token, because the rail is drawn for the customer and hidden from the
    // viewer entirely — without one, "closed" would be true for the wrong
    // reason and the test would pass with the default flipped back.
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light',
  }
  return c
}

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
    // BOTH HALVES. `computed()` naming the value and `render()` hanging it on
    // an element are one claim, and asserting the first alone is what let
    // `title={v.slotTitle}` be deleted with 378 JS tests and the whole Python
    // suite still green: "within reach" is a property of the render, so the
    // render is what has to be asked.
    //
    // AND ON THE REVISION BUTTON, not merely somewhere on the page. "Somewhere"
    // was the first version of this and it was weaker than the sentence above
    // it: moving the digest onto the neighbouring `all projects` link passed,
    // while the claim says it is the button's title. So: exactly one element
    // carries it, and that element is identified by WHAT IT DOES — clicking it
    // opens the build picker, which nothing else in the header does. Identity
    // against `v.revToggle` would not work, and the reason is worth writing
    // down: `computed()` builds a fresh closure on every call, and `render()`
    // calls it again, so the handler on the element is never the object this
    // test holds.
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

  it('says what moves each of the three slots', () => {
    // The badge beside the revision is the only place on this page that says
    // WHO writes the name in front of it, and `latest` used to answer "follows
    // CI" — a machine that stopped building models at the migration. What moves
    // it now is `hammerola commit`, so the badge names that instead. The other
    // two are untouched and are asserted here so a later edit to this branch
    // has to be a deliberate one.
    onSlot('dev')
    expect(component().computed().slotBadge).toBe('auto-updates')
    onSlot('latest')
    expect(component().computed().slotBadge).toBe('follows commits')
    onSlot(REV)
    expect(component().computed().slotBadge).toBe('pinned')
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
    // the section across the one gesture they are worth the most in (SPEC §8,
    // entry 62). The row's whole job is to name the build; what the switch then
    // does with it is ui/tests/revswitch.test.js.
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
    c.state.comments = [
      { id: '1', text: 'a', resolved: false },
      { id: '2', text: 'b', resolved: true },
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
