// Comparing two revisions — issue #10, ui-brief block 9.
//
// The hub measures the geometry and publishes two documents under an address of
// its own; this page shows the SCENE in the viewport it already has and the
// REPORT in the panel where the tree usually is. So the claims under test are
// about the seam rather than about the geometry, and there are five of them:
//
//   * which document the viewport is pointed at, and when. A comparison is an
//     ordinary view payload, so the whole of the switch is `base`, a `views`
//     list of one, and the token that address wants — and it happens ONLY once
//     the hub has answered, because a `scene.json` that does not exist yet would
//     take the build off the screen and draw the error panel over the panel
//     already explaining itself. A view tab pressed inside a comparison is a
//     different payload in a different place, so it arrives as a RELOAD;
//   * the three tabs, which are hidden groups and nothing else — each one a
//     revision and the difference that belongs to it — the scene menu, which
//     while one is up offers neither visibility nor a file, and the toolbar,
//     whose three tools act in the BUILD's terms and are therefore out of
//     service for as long as the scene belongs to a comparison;
//   * the parts list: what the report says, in the order that puts what changed
//     in front of somebody looking for one row in forty, a part the kernel
//     REFUSED to measure drawn as the verdict it is, and a click that lights that
//     part up in every group of the scene that draws it;
//   * the fetching itself: the report is asked for FIRST and the job is what a
//     404 means, a reader with no token is told so rather than shown a broken
//     scene, and an answer for a pair the reader has left is dropped;
//   * and the ADDRESS, which is the reason the route exists at all:
//     `/project/<pid>/<a>/compare/<b>/` is a link a person sends to somebody
//     else. Opening it cold has to be the page of `<a>` already comparing
//     against `<b>`; comparing in the page has to PUT the reader on that
//     address, or there is nothing to send; and since that is a navigation,
//     Back and Forward have to leave the address and the panel agreeing.
//
// NOTHING IS RENDERED, the arrangement every file in this directory uses: the
// instance is the real prototype with the state spelled out, and the real
// methods — `sync`, `computed`, `runCompare`, `leaveBuild`, `load`,
// `switchBuild` — run over it, the last block with the page's real listeners on
// the window. The hub fetches are the only mocks, because they are the only
// things here that talk to a hub.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

const { A, B, C } = vi.hoisted(() => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  window.history.replaceState(null, '', `/project/proj1/${a}/`)
  return { A: a, B: b, C: 'c'.repeat(64) }
})

// `loadMeta` and `loadBuilds` are mocked for the shared-link block at the end,
// which is the only one here that runs the real `load()`; every other test in
// this file never reaches them.
vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadCompareReport: vi.fn(),
  startCompare: vi.fn(),
  loadJob: vi.fn(),
  loadMeta: vi.fn(),
  loadBuilds: vi.fn(),
}))

import HammerolaViewer, { compareRows, compareSummary } from '../src/HammerolaViewer.jsx'
import { MEASURE, MOVED, PLACE, STATE } from '../src/events.js'
import { emptyProposal, moves } from '../src/proposal.js'
// The element itself, for the one claim below that is about what the VIEWPORT
// makes of a comparison's state: its rule for reload-or-live-swap is the thing
// under test, so it is the real one that runs (`viewport` further down).
import { HmrViewport } from '../src/viewport/element.js'
import {
  COMPARE_GROUPS, DIFF_COLOURS, PAGE, compareBase, indexTree, isPointerPage,
  loadBuilds, loadCompareReport, loadJob, loadMeta, rereadPage, startCompare,
} from '../src/hub.js'
import { drained as settled, makeComponent, replaceState } from './component.js'
import { guardPage } from './pageguard.js'

guardPage(`/project/proj1/${A}/`)

beforeEach(() => {
  loadCompareReport.mockReset()
  startCompare.mockReset()
  loadJob.mockReset()
  loadMeta.mockReset()
  loadBuilds.mockReset()
})

afterEach(() => { vi.restoreAllMocks() })

/**
 * The build the page is standing on while it compares two others.
 *
 * TWO VIEWS, AND THE SECOND ONE IS LOAD-BEARING. A build with one view can
 * never be on a tab other than the one its address opens on, so `entryView()`
 * always answers the view already showing and the branch in `switchBuild` that
 * puts a history entry's `?v=` back is unreachable — which is how a `popstate`
 * that ended in a `pushState` lived here through five rounds with two tests
 * asserting it could not happen. `printables` is the id the tests below already
 * pass to `showView`, so this is the fixture catching up with them.
 */
const VIEWS = [
  { id: 'assembled', name: 'assembled', file: 'a.json', parts: ['plate'], gzip: 1000 },
  { id: 'printables', name: 'printables', file: 'p.json', parts: ['plate'], gzip: 900 },
]

const PARTS = { plate: { kind: 'printable', files: { stl: 'plate.stl' } } }

/** The build's own tree, which the panel replaces rather than reads. */
const TREE = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/plate', name: 'plate', key: 'plate' }],
}

/**
 * The comparison's tree, as `treeFromShapes` builds it out of `scene.json`.
 *
 * ONE PART, FOUR TIMES — in each revision and in each difference group — which
 * is the whole reason the panel addresses a row by its CATALOGUE KEY and not by
 * a path.
 *
 * A DIFFERENCE LEAF IS NAMED `plate #1` AND KEYED `plate`, which is the hub's
 * own naming and not a decoration on this fixture: a boolean produces several
 * pieces of one difference routinely (a vent slot widened by 0.4 mm came out as
 * twelve), so `cadbuild/comparescene` numbers them apart to give each a path of
 * its own and stamps the catalogue key on every one. The browser builds the id
 * out of the name (`treeFromShapes`), so the piece's number is in the path too —
 * and the name on such a row is the one thing on it that is NOT the part.
 */
const CMP_TREE = {
  id: '/cmp',
  name: 'cmp',
  children: [
    { id: COMPARE_GROUPS.a,
      name: 'rev a',
      children: [{ id: `${COMPARE_GROUPS.a}/plate`, name: 'plate', key: 'plate' },
                 { id: `${COMPARE_GROUPS.a}/post`, name: 'post', key: 'post' }] },
    { id: COMPARE_GROUPS.b,
      name: 'rev b',
      children: [{ id: `${COMPARE_GROUPS.b}/plate`, name: 'plate', key: 'plate' },
                 { id: `${COMPARE_GROUPS.b}/post`, name: 'post', key: 'post' }] },
    { id: COMPARE_GROUPS.removed,
      name: 'removed',
      children: [{ id: `${COMPARE_GROUPS.removed}/plate #1`, name: 'plate #1', key: 'plate' }] },
    { id: COMPARE_GROUPS.added,
      name: 'added',
      children: [{ id: `${COMPARE_GROUPS.added}/plate #1`, name: 'plate #1', key: 'plate' }] },
  ],
}

/**
 * A report in the shape the hub writes it: a LIST of records, each carrying its
 * own key, sorted by key (`cadbuild/comparescene.report`).
 */
const REPORT = {
  parts: [
    { key: 'plate', status: 'changed', added_mm3: 206.4, removed_mm3: 435.1 },
    { key: 'post', status: 'unchanged', added_mm3: 0, removed_mm3: 0 },
  ],
  totals: { added_mm3: 206.4, removed_mm3: 435.1 },
}

/**
 * The component as `sync`, `computed` and `runCompare` see it.
 *
 * `setState` is the real one's CONTRACT and not React's — merge, then run the
 * callback — because the callback is where `set()` reaches `sync`, and `sync` is
 * where a comparison becomes visible to the viewport.
 */
function page({ watch, ...over } = {}) {
  const c = makeComponent(HammerolaViewer, {
    setState: replaceState,
    toast: vi.fn(),
    state: {
      meta: {
        project: 'fixture', title: 'Fixture', commit: A, published: null,
        built: '2026-08-27T18:20:00Z', parts: PARTS, views: VIEWS,
      },
      tree: indexTree(TREE),
      // THE COMPARISON, which the shared default leaves out: a page that is
      // about neither has none of these, and this is the file that is.
      cmpPair: null, cmpView: null, cmpStage: null, cmpError: null,
      cmpReport: null, cmpSel: null,
      ...over,
    },
  })
  if (!watch) c.sync = vi.fn()
  return c
}

/** A page with a comparison of A against B already on the screen. */
const comparing = (over = {}) => page({
  watch: true,
  cmp: [A, B], compare: true, cmpPair: [A, B], cmpView: 'assembled',
  cmpStage: 'ready', cmpReport: REPORT, tree: indexTree(CMP_TREE),
  ...over,
})

/**
 * A viewport standing on one `hmr:state` detail, for the next one to be judged
 * against.
 *
 * THE REAL PROTOTYPE AND THE REAL `setState`, which is the whole reason this is
 * here rather than an assertion about a field: the question "is this a reload or
 * a live swap" is the ELEMENT's to answer, and it answers it in one place
 * (viewport/element.js). `load` is the only thing stubbed, because everything
 * past it is a fetch and a WebGL scene — the verdict is its argument.
 *
 * The fields set below are the ones `setState` reads before it decides:
 * `element.test.js` builds a fuller one for the tests that go on into
 * `reconcile`.
 */
function viewport(detail) {
  const vp = Object.create(HmrViewport.prototype)
  vp.viewer = {}
  vp.booted = true
  vp.loadFailed = null
  vp.loadToken = 0
  vp.state = { ...detail }
  vp.load = vi.fn()
  return vp
}

/** The detail of every `hmr:state` a page built with `watch: true` sends. */
function listening() {
  const seen = []
  const listen = (event) => seen.push(event.detail)
  window.addEventListener(STATE, listen)
  onTestFinished(() => window.removeEventListener(STATE, listen))
  return seen
}

/**
 * The component with its REAL listeners on the window, so a viewport event
 * reaches the handler the page actually built.
 *
 * `readNotes` runs on mount and may find no storage; that is one line of noise
 * per test and nothing either block using this is about. `load` and `loadFeed`
 * are stubbed because `componentDidMount` starts with them and both reach a hub.
 */
const mounted = (over) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const c = page({ ...over })
  c.load = vi.fn(async () => {})
  c.loadFeed = vi.fn()
  c.componentDidMount()
  onTestFinished(() => c.componentWillUnmount())
  return c
}

// -- the report, as the panel reads it ----------------------------------------

describe('compareRows', () => {
  it('puts what changed in front of what did not', () => {
    // The brief's hardest case is one part of forty, and the report's own order
    // is the catalogue's — so without this the one row somebody opened the
    // comparison to see sits thirty rows down a scrolling list.
    const rows = compareRows({ parts: [
      { key: 'a', status: 'unchanged' },
      { key: 'b', status: 'changed' },
      { key: 'c', status: 'unchanged' },
      { key: 'd', status: 'removed' },
      { key: 'e', status: 'new' },
    ] })
    expect(rows.map((row) => row.key)).toEqual(['b', 'd', 'e', 'a', 'c'])
  })

  it('keeps the hub\'s order inside each half', () => {
    // The order is the ASSEMBLY's, and re-sorting by volume would answer a
    // question nobody asked.
    const rows = compareRows({ parts: [
      { key: 'z', status: 'changed', added_mm3: 1 },
      { key: 'y', status: 'changed', added_mm3: 900 },
      { key: 'x', status: 'unchanged' },
      { key: 'w', status: 'unchanged' },
    ] })
    expect(rows.map((row) => row.key)).toEqual(['z', 'y', 'x', 'w'])
  })

  it('shows a status it does not know rather than calling it unchanged', () => {
    // Six words are the contract; a seventh means the hub has moved, and sorting
    // it down would tell somebody nothing happened to a part the hub had
    // something to say about.
    const rows = compareRows({ parts: [{ key: 'a', status: 'unchanged' },
                                       { key: 'b', status: 'reshaped' }] })
    expect(rows.map((row) => row.key)).toEqual(['b', 'a'])
    expect(rows[0].status).toBe('reshaped')
  })

  it('drops a part with no key, which nothing could be done with', () => {
    // The key is the identity (issue #75) and the whole of what a row can do:
    // it is what the click resolves against the scene.
    const rows = compareRows({ parts: [{ status: 'changed' }, { key: '', status: 'new' },
                                       { key: 'plate', status: 'new' }] })
    expect(rows.map((row) => row.key)).toEqual(['plate'])
  })

  it('reads the list of records the hub writes, and takes the key off each', () => {
    const rows = compareRows({ parts: [
      { key: 'plate', status: 'changed', added_mm3: 5, removed_mm3: 0 },
      { key: 'post', status: 'unchanged' },
    ] })
    expect(rows.map((row) => row.key)).toEqual(['plate', 'post'])
    expect(rows[0].added).toBe(5)
  })

  it('reads a document that is not a report as no rows at all', () => {
    expect(compareRows(null)).toEqual([])
    expect(compareRows({})).toEqual([])
    expect(compareRows({ parts: 'plate' })).toEqual([])
    // AN OBJECT KEYED BY THE PART KEY IS ONE OF THOSE, and it is named here
    // rather than left to the line above. This side read that shape too for a
    // while, because the two halves were written at once and disagreed about
    // which it was. The hub settled on the list — `cadbuild/comparescene.report`
    // says so and a test of its own pins it — so the second reading was a branch
    // nothing could reach, kept in step by hand.
    expect(compareRows({ parts: { plate: { status: 'changed' } } })).toEqual([])
  })

  it('reads a volume that is not a number as none', () => {
    const [row] = compareRows({ parts: [{ key: 'plate', status: 'changed',
                                          added_mm3: null,
                                          removed_mm3: 'lots' }] })
    expect(row.added).toBe(0)
    expect(row.removed).toBe(0)
  })

  it('keeps `not measured` at the top, with the reason it came with', () => {
    // The fifth status, and it is a VERDICT: `shapediff.check` refuses a
    // measurement exactly where the kernel may have lied, so the acceptance gate
    // doing its job is what produces this row. It sorts with what changed rather
    // than with what did not, because a part nothing could answer for is the
    // first thing somebody opening a comparison needs to see — and the sentence
    // is carried, since the report has already written down which identity
    // failed and this row is the only place the reader can learn it.
    const rows = compareRows({ parts: [
      { key: 'a', status: 'unchanged' },
      { key: 'b', status: 'not measured', reason: 'the two solids could not be fused' },
    ] })

    expect(rows.map((row) => row.key)).toEqual(['b', 'a'])
    expect(rows[0].status).toBe('not measured')
    expect(rows[0].reason).toBe('the two solids could not be fused')
    // Nothing else carries one, and an ordinary row says so with '' rather than
    // with a field the panel has to test for existence.
    expect(rows[1].reason).toBe('')
  })

  it('sorts `not compared` with the rows nothing happened to', () => {
    // THE ROUTINE SILENCE, AND IT IS NOT THE ONE ABOVE. A `hardware` leaf or a
    // `mock` has no geometry of ours, so no build exports a STEP for it and
    // nothing was ever going to be compared — which is a property of the part
    // and not an event in this revision. Most models carry several, so sorted
    // with the refusals it is a stack of rows saying nothing happened and
    // nothing could have, standing between the reader and the one row that
    // changed.
    const rows = compareRows({ parts: [
      { key: 'reference_spacer', status: 'not compared',
        reason: 'the two builds did not both export it as STEP' },
      { key: 'plate', status: 'unchanged' },
      { key: 'post', status: 'changed' },
    ] })

    expect(rows.map((row) => row.key)).toEqual(['post', 'reference_spacer', 'plate'])
    // The sentence still comes with it: quiet is where the row sits, not
    // whether it says why nobody looked.
    expect(rows[1].reason).toBe('the two builds did not both export it as STEP')
  })

  it('keeps the two silences apart, one at each end of the list', () => {
    // The whole of the split, in one report: the gate's refusal is a question
    // outstanding and goes first, hardware nobody compares is not news and goes
    // last. Under one word the second used to carry the first's place.
    const rows = compareRows({ parts: [
      { key: 'a', status: 'not compared', reason: 'no STEP for it' },
      { key: 'b', status: 'unchanged' },
      { key: 'c', status: 'not measured', reason: 'the fuse did not close' },
    ] })

    expect(rows.map((row) => row.key)).toEqual(['c', 'a', 'b'])
  })

  it('reads a reason that is not a sentence as none', () => {
    // The same rule the volumes get, for the same reason: this is a document
    // another process wrote, and a shape this side does not know is not a
    // sentence to put in front of a reader.
    const [row] = compareRows({ parts: [
      { key: 'a', status: 'not measured', reason: { why: 'no' } },
    ] })
    expect(row.reason).toBe('')
  })
})

describe('compareSummary', () => {
  it('says the two revisions are identical, which is an answer', () => {
    // A list where every row reads `unchanged` cannot be told from a list that
    // failed to load one, and the brief names this state explicitly.
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'unchanged' }, { key: 'b', status: 'unchanged' },
    ] }))).toBe('identical — all 2 parts unchanged')
  })

  it('still says it on a model with bought parts, and says what it skipped', () => {
    // THE ANSWER USED TO BE UNREACHABLE, and this is the case that made it so.
    // The list is the VIEW's parts, `hardware` and `mock` among them, and those
    // read `not compared` — so on an ordinary model "every row is unchanged" is
    // never true, and two identical revisions came out as a row of zeroes that
    // reads like a comparison which found nothing to say. The claim is measured
    // against the rows something was ESTABLISHED about, with the remainder in
    // the same line so the reader can see how much of the model it covers.
    expect(compareSummary(compareRows({ parts: [
      { key: 'plate', status: 'unchanged' },
      { key: 'post', status: 'unchanged' },
      { key: 'reference_spacer', status: 'not compared', reason: 'no STEP pair' },
    ] }))).toBe('identical — all 2 compared parts unchanged · 1 not compared')
  })

  it('counts one compared part as one part', () => {
    expect(compareSummary(compareRows({ parts: [
      { key: 'plate', status: 'unchanged' },
      { key: 'reference_spacer', status: 'not compared', reason: 'no STEP pair' },
    ] }))).toBe('identical — all 1 compared part unchanged · 1 not compared')
  })

  it('counts each of the three things that can have happened', () => {
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'changed' }, { key: 'b', status: 'new' },
      { key: 'c', status: 'removed' }, { key: 'd', status: 'unchanged' },
    ] }))).toBe('4 parts · 1 changed · 1 new · 1 removed')
  })

  it('says so when the report names no parts', () => {
    expect(compareSummary([])).toBe('this report lists no parts')
    expect(compareSummary(null)).toBe('this report lists no parts')
  })

  it('never calls a comparison identical over a part nothing could measure', () => {
    // ONE ROW OF THIS WORD DENIES THE ANSWER ENTIRELY, and that is the whole
    // asymmetry between the two silences. `not measured` is the gate turning a
    // measurement down exactly where the kernel may have lied — something may be
    // wrong with this part — and "identical" is the most confident possible
    // answer to give over it.
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'unchanged' },
      { key: 'b', status: 'not measured', reason: 'the fuse did not close' },
    ] }))).toBe('2 parts · 0 changed · 0 new · 0 removed · 1 not measured')
  })

  it('denies it even where everything else was compared and unchanged', () => {
    // The same rule with the routine silence beside it, so neither of them can
    // talk the other into an answer: two compared rows both `unchanged`, one
    // bought part, and one refusal — which is still enough to take the sentence
    // away and put the counts back.
    expect(compareSummary(compareRows({ parts: [
      { key: 'plate', status: 'unchanged' },
      { key: 'post', status: 'unchanged' },
      { key: 'reference_spacer', status: 'not compared', reason: 'no STEP pair' },
      { key: 'lid', status: 'not measured', reason: 'the fuse did not close' },
    ] }))).toBe('4 parts · 0 changed · 0 new · 0 removed · 1 not measured')
  })

  it('claims nothing where the comparison established nothing at all', () => {
    // A view of bought parts only: there is no row the answer could be measured
    // against, so there is no `identical` to say. It falls to the counts, which
    // claim nothing about any part.
    expect(compareSummary(compareRows({ parts: [
      { key: 'reference_spacer', status: 'not compared', reason: 'no STEP pair' },
      { key: 'm3x8', status: 'not compared', reason: 'no STEP pair' },
    ] }))).toBe('2 parts · 0 changed · 0 new · 0 removed')
  })

  it('denies it for a status this side does not know', () => {
    // Six words are the contract; a seventh means the hub has moved. It is not
    // `unchanged`, so it is not a part that came out the same, and saying
    // "identical" over it would swallow whatever the hub had to say.
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'unchanged' }, { key: 'b', status: 'reshaped' },
    ] }))).toBe('2 parts · 0 changed · 0 new · 0 removed')
  })

  it('counts the refusal beside the rest, and only when there is one', () => {
    // On the end rather than in the middle, and absent entirely from an ordinary
    // comparison: a `· 0 not measured` on every line teaches the reader to stop
    // reading the tail of this one.
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'changed' }, { key: 'b', status: 'not measured' },
    ] }))).toBe('2 parts · 1 changed · 0 new · 0 removed · 1 not measured')
    expect(compareSummary(compareRows({ parts: [
      { key: 'a', status: 'changed' },
    ] }))).toBe('1 part · 1 changed · 0 new · 0 removed')
  })

  it('leaves `not compared` out of the counts, where it would say nothing', () => {
    // It earns its number in the identical sentence, where it is the qualifier
    // ON the claim. Beside three others it is one more count on nearly every
    // comparison an ordinary model produces, saying the same thing each time.
    expect(compareSummary(compareRows({ parts: [
      { key: 'plate', status: 'changed' },
      { key: 'reference_spacer', status: 'not compared', reason: 'no STEP pair' },
    ] }))).toBe('2 parts · 1 changed · 0 new · 0 removed')
  })
})

// -- which document the viewport is pointed at --------------------------------

describe('the scene a comparison puts on screen', () => {
  it('is the comparison\'s own document, fetched with the token', () => {
    // The whole of the switch: another base, a `views` list of one, and the
    // secret that address wants — the element fetches every view file it
    // renders, and this is the only one that is guarded.
    const c = comparing()
    const seen = listening()

    c.sync()

    expect(seen).toHaveLength(1)
    expect(seen[0].base).toBe(compareBase('proj1', A, B))
    // `?v=` and not a bare name: a comparison is of ONE VIEW, and the hub
    // cannot name a cache entry without being told which. The id carries the
    // view too — see the reload block below for what it buys — and the `view`
    // field is that id and not a second spelling of it, since the element picks
    // the entry it fetches by matching the two.
    expect(seen[0].views).toEqual([{ id: 'compare:assembled', file: 'scene.json?v=assembled' }])
    expect(seen[0].view).toBe('compare:assembled')
    expect(seen[0].mode).toBe('compare')
    expect(seen[0].token).toBe('sekrit')
  })

  it('is the BUILD until the hub has answered', () => {
    // A `scene.json` that has not been computed answers 404, which would take
    // the model off the screen and draw block 11's panel over the panel that is
    // already saying what is happening.
    const c = comparing({ cmpStage: 'running', cmpReport: null })
    const seen = listening()

    c.sync()

    expect(seen[0].base).toBe(`/project/proj1/${A}/`)
    expect(seen[0].view).toBe('assembled')
    expect(seen[0].mode).toBe('single')
  })

  it('carries no token when the document is a build\'s own, which is public', () => {
    const c = page({ watch: true })
    const seen = listening()

    c.sync()

    expect(seen[0].mode).toBe('single')
    expect(seen[0].token).toBe(null)
  })

  it('tells one comparison from another by the pair and by the view', () => {
    // `buildKey` is how the element notices the geometry changed, and a
    // comparison of another PAIR of the same view moves nothing else it reads —
    // the base is the pair's own address, but `base` alone it would read as a
    // live swap.
    const seen = listening()
    comparing().sync()
    comparing({ cmpPair: [A, 'c'.repeat(64)] }).sync()
    comparing({ cmpView: 'printables' }).sync()

    expect(new Set(seen.map((detail) => detail.buildKey)).size).toBe(3)
    expect(seen[2].views[0].file).toBe('scene.json?v=printables')
  })
})

describe('a view tab pressed while a comparison is up', () => {
  it('asks for that view\'s comparison rather than that view of the build', () => {
    // The hub caches a scene and a report PER VIEW, so the pair on screen has
    // as many comparisons as the two revisions have views in common.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = comparing()

    c.showView('printables')

    expect(c.state.view).toBe('printables')
    expect(c.state.cmpView).toBe('printables')
    expect(loadCompareReport).toHaveBeenCalledWith('proj1', A, B, 'printables', 'sekrit')
  })

  it('is an ordinary view switch on a build page', () => {
    const c = page({ watch: true })
    const seen = listening()

    c.showView('printables')

    expect(seen[seen.length - 1].view).toBe('printables')
    expect(loadCompareReport).not.toHaveBeenCalled()
  })

  it('asks for nothing when it is the tab already on screen', async () => {
    // `showView` returns on the id it is already showing, and it is measured
    // against the BUILD's view id — the one the tab strip lights — because the
    // comparison's scene id is not one of `meta.views` and `onModel` never
    // writes it into the field. Pressing the lit tab therefore costs no fetch
    // and does not take the panel back to "measuring" for a scene that has not
    // moved.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = comparing()
    const seen = listening()

    c.showView('assembled')
    await settled()

    expect(loadCompareReport).not.toHaveBeenCalled()
    expect(c.state.cmpStage).toBe('ready')
    expect(seen).toEqual([])
  })

  it('reaches the viewport as a RELOAD, and not as a live swap', async () => {
    // The defect this pins: every comparison's scene used to arrive under the id
    // `compare`, so the element saw `view` unchanged and `buildKey` moved — its
    // definition of a swap — and answered with `captureLive`/`restoreLive`,
    // carrying the previous view's camera and tree states onto a different
    // arrangement of the parts, in a different place, with a different extent.
    // On a build page the same gesture is a reload that re-fits (ui-brief block
    // 2), and a comparison is not a reason for it to stop being one.
    //
    // ASSERTED THROUGH THE ELEMENT'S OWN RULE rather than against a copy of it:
    // what the two halves have to agree about is which FIELD says "a different
    // view", so a test that read `detail.view` and stopped would pass over a
    // viewport that had changed its mind about that field.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = comparing()
    const seen = listening()

    c.sync()
    c.showView('printables')
    await settled()

    const before = seen[0]
    const after = seen[seen.length - 1]
    expect(before.views[0].file).toBe('scene.json?v=assembled')
    expect(after.views[0].file).toBe('scene.json?v=printables')

    const vp = viewport(before)
    vp.setState(after)

    expect(vp.load).toHaveBeenCalledWith({ live: false })
  })
})

describe('the three tabs', () => {
  const hiddenFor = (show) => {
    const c = comparing({ diffShow: show })
    const seen = listening()
    c.sync()
    return seen[0].hidden
  }

  it('show everything in Overlay', () => {
    expect(hiddenFor('both')).toEqual([])
  })

  it('show A with what was REMOVED from it, and nothing that belongs to B', () => {
    // A tab has to be the revision it names. `added` is drawn where B stands and
    // is B's material, so on "A only" it is not an annotation about A — and a
    // part that exists only in B is drawn there WHOLE and opaque, which is a
    // part that is not in A at all dominating the tab claiming to be A, in front
    // of A's own geometry.
    expect(hiddenFor('a')).toEqual([COMPARE_GROUPS.b, COMPARE_GROUPS.added])
  })

  it('show B with what was ADDED to it, and nothing that belongs to A', () => {
    expect(hiddenFor('b')).toEqual([COMPARE_GROUPS.a, COMPARE_GROUPS.removed])
  })

  it('are the only thing hidden while a comparison is up', () => {
    // The reader's own hidden list names solids of the BUILD's tree, which is
    // not the tree on screen — carried across it would be a list of
    // instructions about parts nobody can see.
    const c = comparing({ hidden: ['/model/plate'], ghost: ['/model/plate'] })
    const seen = listening()

    c.sync()

    expect(seen[0].hidden).toEqual([])
    expect(seen[0].ghost).toEqual([])
  })

  it('are the only visibility the scene menu offers while one is up', () => {
    // The other half of the rule above, and the half that used to leak. The
    // context menu stayed live over the comparison's own solids: Isolate, Hide
    // and Translucent still called `setVisibility`, which `sync` then ignored —
    // so they did nothing visible AND wrote to the build's lists behind the
    // reader's back. Isolate is the loud one: it replaces `s.hidden` wholesale
    // with `/cmp/…` paths, which match nothing in the build's tree, so every
    // part the reader had hidden before comparing came back on screen the
    // moment they closed the panel.
    const menu = { id: `${COMPARE_GROUPS.b}/plate`, x: 10, y: 10 }
    const offered = comparing({ menu }).computed().menuItems.map((m) => m.label)

    expect(offered).not.toContain('Isolate')
    expect(offered).not.toContain('Hide')
    expect(offered).not.toContain('Translucent')
    // Not lost, though: everything the menu says about the PART is still there.
    expect(offered).toContain('Copy name')
  })

  it('leave the menu alone on the build, including while the hub measures', () => {
    // The condition is the one `sync` asks — is the comparison's scene on
    // screen — and not "is the panel open". Until the hub answers, the BUILD is
    // what the viewport is drawing and the reader's own hidden list is what is
    // in force, so the three are theirs as usual.
    const menu = { id: '/model/plate', x: 10, y: 10 }
    const measuring = comparing({
      menu, cmpStage: 'running', cmpReport: null, tree: indexTree(TREE),
    }).computed().menuItems.map((m) => m.label)
    const plain = page({ watch: true, menu }).computed().menuItems.map((m) => m.label)

    expect(measuring).toEqual(expect.arrayContaining(['Isolate', 'Hide', 'Translucent']))
    expect(plain).toEqual(expect.arrayContaining(['Isolate', 'Hide', 'Translucent']))
  })

  it('give the reader their own hidden parts back on the way out', () => {
    const c = comparing({ hidden: ['/model/plate'] })
    const seen = listening()

    c.computed().exitCompare({ stopPropagation() {} })

    expect(c.state.compare).toBe(false)
    expect(seen[seen.length - 1].base).toBe(`/project/proj1/${A}/`)
    expect(seen[seen.length - 1].hidden).toEqual(['/model/plate'])
  })
})

// -- the scene menu, over a comparison's own solids ---------------------------
//
// Everything the menu offers is about one part, and inside a comparison "which
// part" and "which revision's part" stop being the same question. The three
// visibility items are gone (above); these are the two that used to answer it
// wrong rather than not at all.

describe('a right-click on a part while a comparison is up', () => {
  /** The menu the page would draw over one solid of the comparison's scene. */
  const menuOver = (id, over) => comparing({ menu: { id, x: 10, y: 10 }, ...over })
    .computed().menuItems

  it('offers no file at all, since the ones it has are the WRONG revision\'s', () => {
    // The download rows are built from `PAGE.base` and this page's catalogue,
    // both of which are `<a>`'s. So a right-click on a part inside `/cmp/rev b`
    // — the geometry of the NEW revision, under the cursor — handed out `<a>`'s
    // `part.step` under the same file name, with nothing on the screen to give
    // it away. `<b>`'s would take `<b>`'s meta.json, which this page does not
    // load; so nothing is offered, which is the answer that cannot be misread.
    const offered = menuOver(`${COMPARE_GROUPS.b}/plate`).map((m) => m.label)

    expect(offered).not.toContain('STL')
    // And not the sentences either: "No files for this part" is a statement
    // about the catalogue, and this menu is not in a position to make one.
    expect(offered).not.toContain('No files for this part')
    expect(offered).not.toContain('No files in this build')
    expect(offered.filter((label) => label !== 'Note')).toEqual(['Copy name'])
  })

  it('goes on offering them on the build page, which is the one it describes', () => {
    // The predicate is `sync`'s — is the comparison's scene on screen — so a
    // build page keeps every file it always had, including while the hub is
    // still measuring a pair.
    const plain = page({ watch: true, menu: { id: '/model/plate', x: 10, y: 10 } })
      .computed().menuItems.map((m) => m.label)

    expect(plain).toContain('STL')
  })

  it('copies the PART on a difference leaf, and not the piece', () => {
    // The name on such a row is the hub's own numbering — `plate #1`, one of
    // however many pieces a boolean produced — and it names nothing a reader can
    // look up: not in the catalogue, not in the report beside it, not in
    // `model.py`. What all three speak is the catalogue key, which is what the
    // rows of this very panel print.
    const written = []
    Object.defineProperty(navigator, 'clipboard',
                          { value: { writeText: (t) => written.push(t) },
                            configurable: true })
    try {
      menuOver(`${COMPARE_GROUPS.removed}/plate #1`)
        .find((m) => m.label === 'Copy name').onClick({ stopPropagation() {} })
    } finally {
      delete navigator.clipboard
    }

    expect(written).toEqual(['plate'])
  })

  it('still copies the row\'s own name where that IS the part', () => {
    // Inside a revision's shell the leaf is the part as the reader is shown it,
    // and a group has no key at all — `rev a` is a name and copying it is what
    // the reader asked for. Both go through the same item, so both are said.
    const written = []
    Object.defineProperty(navigator, 'clipboard',
                          { value: { writeText: (t) => written.push(t) },
                            configurable: true })
    try {
      const copy = (id) => menuOver(id)
        .find((m) => m.label === 'Copy name').onClick({ stopPropagation() {} })
      copy(`${COMPARE_GROUPS.a}/post`)
      copy(COMPARE_GROUPS.a)
    } finally {
      delete navigator.clipboard
    }

    expect(written).toEqual(['post', 'rev a'])
  })
})

// -- the parts list -----------------------------------------------------------

describe('the affected parts list', () => {
  it('draws one row per part, with what happened and how much moved', () => {
    const rows = comparing().computed().cmpRows

    expect(rows.map((row) => row.name)).toEqual(['plate', 'post'])
    expect(rows[0].status).toBe('changed')
    expect(rows[0].volume).toBe('+206 / −435 mm³')
    expect(rows[1].volume).toBe('')
  })

  it('says whether the two revisions came out identical', () => {
    const same = comparing({ cmpReport: { parts: [
      { key: 'plate', status: 'unchanged', added_mm3: 0, removed_mm3: 0 },
    ] } })
    expect(same.computed().cmpSummary).toBe('identical — all 1 part unchanged')
  })

  it('draws the refusal, with its reason, as its own kind of row', () => {
    // NOTHING BRIGHT IS DRAWN FOR SUCH A PART: the scene shows it exactly as it
    // shows a part nobody touched, so this row is the only place the reader
    // learns the kernel would not answer for it. Which makes both halves of the
    // row load-bearing — the sentence, which is dropped nowhere, and the chip,
    // which must not read as the muted `unchanged` beside it, because "nothing
    // to say about this part" and "could not say anything about this part" are
    // opposite claims.
    const v = comparing({ cmpReport: { parts: [
      { key: 'plate', status: 'not measured', added_mm3: 0, removed_mm3: 0,
        reason: 'the two solids could not be fused: the boolean did not close' },
      { key: 'post', status: 'unchanged', added_mm3: 0, removed_mm3: 0 },
    ] } }).computed()
    const [refused, ordinary] = v.cmpRows

    expect(refused.status).toBe('not measured')
    expect(refused.reason)
      .toBe('the two solids could not be fused: the boolean did not close')
    expect(refused.reasonStyle).toContain('display:block')
    expect(refused.statusStyle).not.toBe(ordinary.statusStyle)
    // And the row beside it is untouched: one line, and no second one hiding
    // under it with nothing in it.
    expect(ordinary.reason).toBe('')
    expect(ordinary.reasonStyle).toContain('display:none')
  })

  it('draws a part nobody compares as quietly as an unchanged one', () => {
    // THE CHIP IS THE OTHER HALF OF THE SPLIT. The warning surface is what this
    // interface spends on "read this before you trust what you are looking at",
    // and a bought screw having no geometry of ours is not that — it is the
    // state several rows of an ordinary model are always in, and putting the
    // warning colour on all of them is what teaches a reader to ignore it. So
    // this row wears exactly the chip `unchanged` wears, and exactly not the one
    // the gate's refusal wears.
    const v = comparing({ cmpReport: { parts: [
      { key: 'plate', status: 'not measured', added_mm3: 0, removed_mm3: 0,
        reason: 'the two solids could not be fused' },
      { key: 'post', status: 'unchanged', added_mm3: 0, removed_mm3: 0 },
      { key: 'reference_spacer', status: 'not compared', added_mm3: 0,
        removed_mm3: 0,
        reason: 'the two builds did not both export it as STEP' },
    ] } }).computed()
    const byKey = Object.fromEntries(v.cmpRows.map((row) => [row.key, row]))

    expect(byKey.reference_spacer.statusStyle).toBe(byKey.post.statusStyle)
    expect(byKey.reference_spacer.statusStyle)
      .not.toBe(byKey.plate.statusStyle)
    expect(byKey.plate.statusStyle).toContain('var(--warn)')
    expect(byKey.reference_spacer.statusStyle).not.toContain('var(--warn)')
    // The refusal is still first and the quiet pair still last, in the order the
    // hub listed them.
    expect(v.cmpRows.map((row) => row.key))
      .toEqual(['plate', 'post', 'reference_spacer'])
  })

  it('leaves the category explanation to the legend and the specific one on the row', () => {
    // AN EXPLANATION TRUE OF A WHOLE CATEGORY IS NOT A ROW'S TO CARRY. Every
    // `not compared` row means the same thing — this kind of part is never
    // measured — so the hub's sentence for it is word for word identical on
    // every one of them, and a model with eight bought screws spent most of the
    // panel's height saying what cannot change. The hub still writes the
    // sentence (the document is untouched); the panel draws it once, in the
    // legend, where saying what a word means is already the job.
    //
    // AND `not measured` KEEPS ITS OWN, which is the reason the two are not one
    // rule: that sentence names which identity failed on THIS part, and this row
    // is the only place a reader can learn it.
    const v = comparing({ cmpReport: { parts: [
      { key: 'plate', status: 'not measured', added_mm3: 0, removed_mm3: 0,
        reason: 'the two solids could not be fused: the boolean did not close' },
      { key: 'reference_spacer', status: 'not compared', added_mm3: 0,
        removed_mm3: 0,
        reason: 'the two builds did not both export it as STEP, so nothing was '
                + 'fused -- hardware and mocks most often' },
    ] } }).computed()
    const byKey = Object.fromEntries(v.cmpRows.map((row) => [row.key, row]))

    expect(byKey.reference_spacer.reason).toBe('')
    expect(byKey.reference_spacer.reasonStyle).toContain('display:none')
    expect(byKey.plate.reason)
      .toBe('the two solids could not be fused: the boolean did not close')
    expect(byKey.plate.reasonStyle).toContain('display:block')
  })

  it('says in the legend what the word the rows carry alone means', () => {
    // THE LEGEND WEARS THE ROW'S OWN CHIP, because a legend showing a chip the
    // list does not use explains nothing — one expression builds both
    // (`statusChip`), and this is what says so. The word in it is the hub's,
    // carried rather than spelled again, so it cannot drift from the status the
    // rows are matched on.
    const v = comparing({ cmpReport: { parts: [
      { key: 'reference_spacer', status: 'not compared', added_mm3: 0,
        removed_mm3: 0, reason: 'no STEP for it' },
    ] } }).computed()

    expect(v.legendNotCompared).toBe('not compared')
    expect(v.legendNotComparedStyle).toBe(v.cmpRows[0].statusStyle)
    expect(v.legendNotComparedStyle).not.toContain('var(--warn)')
  })

  it('explains the word by the missing STEP pair, hardware as the example', () => {
    // WHAT IS TRUE OF THE WHOLE CATEGORY IS THE DEFINITION, and hardware is not
    // it. The same row is given to a part that was `printable` in one revision
    // and hardware — or a mock — in the other: the walk called it `new` or
    // `removed`, left it out of `covered`, and one build DID export a STEP for
    // it. "Hardware and mocks have no geometry of ours to compare" is then a
    // false sentence printed under a true word. What holds everywhere is that no
    // pair of files came from the two builds, so nothing was fused.
    const why = comparing().computed().legendNotComparedWhy

    expect(why).toContain('did not both export it as STEP')
    expect(why).toContain('nothing was fused')
    expect(why).not.toContain('no geometry of ours')
    // The example follows the definition and is marked as the usual case rather
    // than as the rule. `tests/test_ui_source.py` is what holds this line and
    // the hub's own sentence for the same row equal, word for word.
    expect(why.indexOf('hardware and mocks')).toBeGreaterThan(why.indexOf('fused'))
    expect(why).toContain('most often')
  })

  it('carries that legend line whether or not the list has such a row', () => {
    // The legend belongs to the PANEL and not to the list, so there is no
    // arrangement in which a `not compared` row is on screen without the one
    // line explaining it — including the state where the report has not arrived
    // yet and there are no rows at all.
    for (const over of [{},
                        { cmpStage: 'running', cmpReport: null },
                        { cmpReport: { parts: [
                          { key: 'reference_spacer', status: 'not compared',
                            added_mm3: 0, removed_mm3: 0, reason: 'no STEP' },
                        ] } }]) {
      const v = comparing(over).computed()
      expect(v.legendNotCompared).toBe('not compared')
      expect(v.legendNotComparedStyle).toBeTruthy()
    }
  })

  it('lights the part up in every group of the scene that draws it', () => {
    // One part is drawn up to four times — in each revision and in each
    // difference group — and the report has one row for it. All four is the
    // answer: the reader asked where this part is.
    const c = comparing()
    const seen = listening()

    c.computed().cmpRows[0].onSelect({ stopPropagation() {} })

    expect(c.state.cmpSel).toBe('plate')
    expect(seen[seen.length - 1].selected).toEqual([
      `${COMPARE_GROUPS.a}/plate`, `${COMPARE_GROUPS.b}/plate`,
      `${COMPARE_GROUPS.removed}/plate #1`, `${COMPARE_GROUPS.added}/plate #1`,
    ])
  })

  it('selects nothing for a key the scene does not draw', () => {
    const c = comparing({ cmpSel: 'bracket' })
    const seen = listening()
    c.sync()
    expect(seen[0].selected).toEqual([])
  })

  it('is not drawn at all while the hub is still measuring', () => {
    // An empty list reads as "nothing changed", which is one of the answers
    // this panel has to be able to give truthfully.
    const v = comparing({ cmpStage: 'running', cmpReport: null }).computed()
    expect(v.cmpRows).toEqual([])
    expect(v.cmpSummaryStyle).toContain('display:none')
    expect(v.cmpNoteStyle).toContain('display:block')
    expect(v.cmpNoteHead).toBe('Measuring the difference…')
  })

  it('spends the payload\'s own colours in the legend', () => {
    // There is no industry convention for added and removed, so the legend is
    // mandatory — and it is worthless unless its swatches are the colours
    // actually on the model.
    const v = comparing().computed()
    expect(v.legendAddedStyle).toContain(DIFF_COLOURS.added)
    expect(v.legendRemovedStyle).toContain(DIFF_COLOURS.removed)
    expect(v.legendNeutralStyle).toContain(DIFF_COLOURS.neutral)
  })
})

describe('a pick in the scene', () => {
  it('answers the list rather than the build page\'s selection', () => {
    // The other half of "по строке списка можно попасть к детали на модели, и
    // наоборот". The two are addressed differently — the list by catalogue key,
    // the build page by path — so a pick while comparing writes the key, and
    // the pair the build page keeps is left where the reader left it.
    const c = comparing({ sel: '/model/plate', selName: 'plate' })
    const seen = listening()

    c.onPick({ id: `${COMPARE_GROUPS.b}/plate`, name: 'plate' })

    expect(c.state.cmpSel).toBe('plate')
    expect(c.state.sel).toBe('/model/plate')
    expect(seen[seen.length - 1].selected).toHaveLength(4)
  })

  it('clears the list selection when the background is clicked', () => {
    const c = comparing({ cmpSel: 'plate' })
    c.onPick({ id: null, name: '' })
    expect(c.state.cmpSel).toBe(null)
  })

  it('still writes the row and its name on a build page', () => {
    const c = page({ watch: true })
    c.onPick({ id: '/model/plate', name: 'plate' })
    expect(c.state.sel).toBe('/model/plate')
    expect(c.state.selName).toBe('plate')
    expect(c.state.cmpSel).toBe(null)
  })
})

// -- the three tools in the toolbar -------------------------------------------
//
// The same closing as the scene menu above, on the controls beside the model.
// All three act in the BUILD's terms and the scene under the cursor is not the
// build, so what each one produced against a comparison was nonsense with a
// straight face — and one of the three filed it into a real queue:
//
//   * COMMENT opened the composer headed `plate #1` and posted
//     `/cmp/added/plate #1` as the part to change, against build `<a>`. A
//     comment is how an agent is told to change the model, so that is a task
//     naming a part that is in no build, in no catalogue and in no `model.py`;
//   * MEASURE hangs `add to comment` off the chip, and that door posts `sel` —
//     which `onPick` deliberately stops writing while a comparison is up, so
//     the measurement went to the hub attached to whatever had been selected
//     before the panel opened;
//   * MOVE put a `/cmp/…` path in `partId` the same way.
//
// BOTH HALVES ARE ASSERTED, because either alone leaves the door ajar: what is
// OFFERED is what a person is stopped by — two buttons drawn spent and, for
// Move, a row of the object's menu that is not drawn at all — and the HANDLERS
// are what stops a tool armed before the comparison was opened, since nothing
// disarms one and the viewport goes on reporting the gestures it is armed for.

describe('the canvas tools while a comparison is up', () => {
  /** A comparison on screen, with the page's real listeners on the window. */
  const comparingLive = (over) => mounted({
    cmp: [A, B], compare: true, cmpPair: [A, B], cmpView: 'assembled',
    cmpStage: 'ready', cmpReport: REPORT, tree: indexTree(CMP_TREE), ...over,
  })

  it('draws the two buttons out of service, and leaves them live on a build page',
     () => {
    const off = comparing().computed()
    const on = page().computed()

    for (const style of ['measureBtnStyle', 'commentBtnStyle']) {
      expect(off[style], style).toContain('pointer-events:none')
      expect(on[style], style).not.toContain('pointer-events:none')
    }
  })

  it('offers Move on no row at all, which is its half of the same rule', () => {
    // Move has no button to draw spent: it is a row of the object's own menu,
    // and a row is either there or it is not. Asked over the COMPARISON'S OWN
    // SOLID, which is the scene a drag would file a `/cmp/…` path out of, and
    // then over the build's own part on a build page, so this is a claim about
    // the comparison rather than about the row having gone missing altogether.
    //
    // THE HUB HAS TO HAVE ASKED FOR THE PANEL for the second half to mean
    // anything: the row is gated on that flag too, since a displacement is a
    // node of the proposal and there is nowhere for one to go without it.
    document.documentElement.setAttribute('data-proposal-panel', 'on')
    onTestFinished(() =>
      document.documentElement.removeAttribute('data-proposal-panel'))
    const menu = { id: `${COMPARE_GROUPS.b}/plate`, x: 10, y: 10 }
    expect(comparing({ menu }).computed().menuItems.map((m) => m.label))
      .not.toContain('Move')
    expect(page({ watch: true, menu: { id: '/model/plate', x: 10, y: 10 } })
      .computed().menuItems.map((m) => m.label)).toContain('Move')
  })

  it('keeps the one that is armed looking armed, so it comes back armed', () => {
    // Out of service is not disarmed: `tool` is untouched, the panel closes,
    // and the tool the reader chose is the tool they still have.
    const v = comparing({ tool: 'measure' }).computed()
    expect(v.measureBtnStyle).toContain('var(--accent-bg)')
    expect(v.measureBtnStyle).toContain('pointer-events:none')
  })

  it('stops the hint telling the reader to click a model that will not answer',
     () => {
    // The one line on the page that would still have described an armed tool as
    // live. The hold key is not one of the three and keeps its own sentence.
    expect(comparing({ tool: 'comment' }).computed().hintText).toContain('orbit')
    expect(page({ tool: 'comment' }).computed().hintText)
      .toBe('click the model to pin a task')
  })

  it('opens no composer for a point placed in the comparison scene', () => {
    const c = comparingLive()

    window.dispatchEvent(new CustomEvent(PLACE, {
      detail: { id: `${COMPARE_GROUPS.added}/plate #1`, name: 'plate #1',
                p: [1, 2, 3] } }))

    expect(c.state.composer).toBe(null)
  })

  it('raises no measurement chip, so there is nothing to attach `sel` to', () => {
    // `sel` is the part picked on the BUILD before the panel opened, and it is
    // exactly what `measAdd` would have posted with a comparison's measurement.
    const c = comparingLive({ sel: '/model/plate', selName: 'plate' })

    window.dispatchEvent(new CustomEvent(MEASURE, {
      detail: { kind: 'distance', value: 4, approximate: false,
                crossPart: false, moved: false } }))

    expect(c.state.measure).toBe(null)
    expect(c.state.sel).toBe('/model/plate')
  })

  it('records no drag, so no /cmp path can reach the proposal', () => {
    // A move is a node of the proposal document now, naming the path in the
    // BUILD's terms — and a comparison's paths are `/cmp/…`, a part no revision
    // has, in a document the agent reads as a statement about this one.
    const c = comparingLive()

    window.dispatchEvent(new CustomEvent(MOVED, {
      detail: { id: `${COMPARE_GROUPS.b}/plate`, name: 'plate',
                paths: [`${COMPARE_GROUPS.b}/plate`], count: 1,
                delta: [3, 0, 0] } }))

    expect(moves(c.state.proposal || emptyProposal())).toEqual([])
  })

  it('leaves them working while the panel is up and the BUILD is on screen', () => {
    // The predicate is `sync`'s — is the comparison's SCENE on screen — and not
    // "is the panel open". While the hub is still measuring, the build is what
    // is under the cursor, so a comment placed on it is about the build and is
    // honest; taking the tools away there would be this page refusing a gesture
    // it can answer.
    const c = comparingLive({ cmpStage: 'running', cmpReport: null,
                              tree: indexTree(TREE) })

    expect(c.computed().commentBtnStyle).not.toContain('pointer-events:none')

    window.dispatchEvent(new CustomEvent(PLACE, {
      detail: { id: '/model/plate', name: 'plate', p: [1, 2, 3] } }))

    expect(c.state.composer.partId).toBe('/model/plate')
    expect(c.state.composer.key).toBe('plate')
  })
})

// -- getting one computed -----------------------------------------------------

describe('runCompare', () => {
  it('asks for the report first, and queues nothing when it is there', async () => {
    // A pair somebody has already looked at is two fetches and no queue;
    // queueing first would spend a CAD process on an answer already on the
    // volume.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })

    await c.runCompare([A, B], 'assembled')

    expect(loadCompareReport).toHaveBeenCalledWith('proj1', A, B, 'assembled', 'sekrit')
    expect(startCompare).not.toHaveBeenCalled()
    expect(c.state.cmpStage).toBe('ready')
    expect(c.state.cmpReport).toBe(REPORT)
  })

  it('queues the job when the pair has never been compared, and waits for it', async () => {
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    loadCompareReport.mockResolvedValueOnce(null).mockResolvedValueOnce(REPORT)
    startCompare.mockResolvedValue('job1')
    loadJob.mockResolvedValueOnce({ state: 'queued' })
      .mockResolvedValueOnce({ state: 'building' })
      .mockResolvedValueOnce({ state: 'done' })
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })

    const running = c.runCompare([A, B], 'assembled')
    await vi.advanceTimersByTimeAsync(10000)
    await running

    expect(startCompare).toHaveBeenCalledWith('proj1', A, B, 'assembled', 'sekrit')
    expect(loadJob).toHaveBeenCalledTimes(3)
    expect(loadCompareReport).toHaveBeenCalledTimes(2)
    expect(c.state.cmpStage).toBe('ready')
  })

  it('shows the hub\'s own words when the job fails', async () => {
    loadCompareReport.mockResolvedValue(null)
    startCompare.mockResolvedValue('job1')
    loadJob.mockResolvedValue({ state: 'failed', error: 'the boolean did not close' })
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })

    await c.runCompare([A, B], 'assembled')

    expect(c.state.cmpStage).toBe('failed')
    expect(c.state.cmpError).toBe('the boolean did not close')
  })

  it('shows the hub\'s own words when the view cannot be compared at all', async () => {
    // THE REFUSAL THAT IS NOT ABOUT THE PAIR. A view id is the author's own
    // string, published under a rule that allows a dot and 128 characters
    // (`hubspec.MEMBER_RE`), and the comparison cache has to spell it as a
    // DIRECTORY — so a name that cannot be one publishes, draws its tab and has
    // no comparison. The hub answers that in a sentence (`app.py`,
    // VIEW_NOT_NAMEABLE_ERROR); `HTTP 422` in the panel would tell nobody to
    // rename anything, so what is thrown is what the hub wrote.
    loadCompareReport.mockResolvedValue(null)
    startCompare.mockRejectedValue(
      new Error('this view cannot be compared: its name has to be a plain '
                + 'directory segment'))
    const c = page({ cmpPair: [A, B], cmpView: 'top v2', compare: true })

    await c.runCompare([A, B], 'top v2')

    expect(c.state.cmpStage).toBe('failed')
    expect(c.state.cmpError).toContain('this view cannot be compared')
    expect(c.computed().cmpNote).toContain('directory segment')
  })

  it('says a job that finished and published nothing did not finish', async () => {
    // Silence here would leave the panel saying `measuring` for ever.
    loadCompareReport.mockResolvedValue(null)
    startCompare.mockResolvedValue('job1')
    loadJob.mockResolvedValue({ state: 'done' })
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })

    await c.runCompare([A, B], 'assembled')

    expect(c.state.cmpStage).toBe('failed')
    expect(c.state.cmpError).toContain('no report')
  })

  it('tells a reader with no token, and asks the hub nothing', async () => {
    // Both documents are behind EDIT_TOKEN, so there is nothing to fetch and
    // nothing to show — and the panel says which of the two it is rather than
    // handing them the 401 the hub would send.
    const c = page({ token: null, cmpPair: [A, B], cmpView: 'assembled', compare: true })

    await c.runCompare([A, B], 'assembled')

    expect(c.state.cmpStage).toBe('locked')
    expect(loadCompareReport).not.toHaveBeenCalled()
    expect(startCompare).not.toHaveBeenCalled()
  })

  it('drops an answer for a pair the reader has left', async () => {
    // The ticks in the picker go on being the reader's to change while a
    // comparison runs, and a job landing against the pair they moved on from
    // would put one comparison's report beside another comparison's scene.
    let answer = null
    loadCompareReport.mockImplementation(() => new Promise((done) => { answer = done }))
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })

    const running = c.runCompare([A, B], 'assembled')
    c.state.cmpPair = [A, 'c'.repeat(64)]
    answer(REPORT)
    await running

    expect(c.state.cmpStage).toBe('starting')
    expect(c.state.cmpReport).toBe(null)
  })

  it('is the one door, and the Try again beside a failure comes through it', async () => {
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ cmp: [A, B], compare: true, cmpPair: [A, B],
                     cmpView: 'assembled', cmpStage: 'failed',
                     cmpError: 'the hub was restarting' })

    c.computed().retryCompare({ stopPropagation() {} })
    await settled()

    expect(c.state.cmpError).toBe(null)
    expect(c.state.cmpStage).toBe('ready')
  })

  it('is what the Compare button presses, on the two rows that are ticked', async () => {
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ cmp: [A, B] })

    c.computed().startCompare({ stopPropagation() {} })
    await settled()

    expect(c.state.compare).toBe(true)
    expect(c.state.cmpPair).toEqual([A, B])
    expect(c.state.revOpen).toBe(false)
  })
})

// -- the request that asks, and what it does with a refusal -------------------
//
// THE REAL MODULE RUNS HERE, past this file's mock of it, because what is under
// test is `startCompare`'s own reading of the reply: every other block mocks the
// function whose insides these tests are about. The hub answers a refusal as
// `{"error": "..."}` (`app._error`) and one of those is a sentence a reader can
// act on — a view whose name cannot be a directory segment — so a bare status
// here is the panel losing the only thing the hub had to say.
describe('startCompare', () => {
  /** The unmocked function, and one canned reply for its fetch. */
  async function asking(response) {
    vi.stubGlobal('fetch', vi.fn(async () => response))
    onTestFinished(() => { vi.unstubAllGlobals() })
    const hub = await vi.importActual('../src/hub.js')
    return hub.startCompare('proj1', A, B, 'top v2', 'sekrit')
  }

  it('throws the hub\'s own sentence where the refusal carries one', async () => {
    await expect(asking({
      ok: false,
      status: 422,
      json: async () => ({ error: 'this view cannot be compared: its name has'
                                  + ' to be a plain directory segment' }),
    })).rejects.toThrow('plain directory segment')
  })

  it('falls back to the address and the status where it does not', async () => {
    // A proxy's HTML, an empty 502, a body that is not JSON at all: this is
    // already the failure path and a parse error must not replace the refusal.
    await expect(asking({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('Unexpected token <') },
    })).rejects.toThrow(/\/api\/v1\/compare\/proj1\/.* -> HTTP 502/)
  })

  it('names the job on the ordinary path, which is unchanged', async () => {
    await expect(asking({ ok: true, status: 202, json: async () => ({ job: 'j1' }) }))
      .resolves.toBe('j1')
  })
})

describe('two jobs waited on at once', () => {
  // A view tab pressed while the first comparison is still queued starts a
  // second `awaitJob` beside the first — so the gap between two polls cannot be
  // one field on the component.

  it('does not strand the first, which used to hang until the page went', async () => {
    // ONE TIMER PER COMPONENT meant the second wait cancelled the first one's
    // timeout, and the first chain then awaited a promise nothing would ever
    // settle: it never resolved, never gave up, and held its fetch loop open
    // for as long as the page lived.
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    loadJob.mockResolvedValueOnce({ state: 'queued' })
      .mockResolvedValueOnce({ state: 'queued' })
      .mockResolvedValue({ state: 'done' })
    const c = page({ cmpPair: [A, B], cmpView: 'assembled', compare: true })
    const woke = []

    c.awaitJob('job1', [A, B], 'assembled', 'sekrit').then(() => woke.push('job1'))
    c.awaitJob('job2', [A, B], 'assembled', 'sekrit').then(() => woke.push('job2'))
    await vi.advanceTimersByTimeAsync(10000)

    expect(woke.sort()).toEqual(['job1', 'job2'])
  })

  it('takes every outstanding wait down with the page', async () => {
    // The other half of a timer per wait: an unmount has to clear ALL of them,
    // or one wakes up and asks the hub about a job nobody is waiting for.
    vi.useFakeTimers()
    onTestFinished(() => vi.useRealTimers())
    const c = page()
    c.cancelDownloads = vi.fn()
    let woke = 0

    c.pause(1500).then(() => { woke += 1 })
    c.pause(1500).then(() => { woke += 1 })
    c.componentWillUnmount()
    await vi.advanceTimersByTimeAsync(10000)

    expect(woke).toBe(0)
  })
})

// -- a pair is always two commits ---------------------------------------------
//
// The hub refuses `latest` and `dev` as ends of a pair, and it has to: an entry
// in the comparison cache is filed under the names it was ASKED with, so one
// filed under `latest` goes on answering for a pair that has moved on. So the
// ASKING side resolves — `builds.json` carries `latest` as the commit id it
// points at — and `dev`, which has no commit id at all, is not offered.

/** builds.json as the hub writes it: the slot, the pointer, two commits. */
const BUILDS = {
  has_dev: true,
  latest: A,
  builds: [
    { commit: A, built: '2026-08-27T18:20:00Z', message: 'first' },
    { commit: B, built: '2026-08-28T18:20:00Z', message: 'second' },
  ],
}

const rowFor = (c, key) => c.computed().revRows.find((r) => r.key === key)

describe('the compare ticks in the picker', () => {
  it('ticks the commit `latest` stands for, and never `latest` itself', () => {
    // The gesture the defect broke: ticking the pointer row and a build sent
    // `POST …/latest/<b>/<view>`, which the hub answers 404 — so the panel said
    // the comparison did not finish and Try again failed the same way.
    const c = page({ builds: BUILDS })

    rowFor(c, 'latest').onCmp({ stopPropagation() {} })

    expect(c.state.cmp).toEqual([A])
    // And the two rows read as one revision, because they are one revision.
    expect(rowFor(c, 'latest').cmpMark).toBe('✓')
    expect(rowFor(c, A).cmpMark).toBe('✓')
  })

  it('offers no tick at all on the dev slot', () => {
    // `has_dev` is a flag and not an id, deliberately: the slot has no
    // permanent address, so there is no name a cached comparison could be
    // filed under. Saying so on the row is the honest answer; offering the
    // tick and failing at the POST is the same answer given later, as an error.
    const dev = rowFor(page({ builds: BUILDS }), 'dev')

    expect(dev.onCmp).toBe(undefined)
    expect(dev.cmpStyle).toContain('visibility:hidden')
  })

  it('sends the Compare button off with two commits', async () => {
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ builds: BUILDS })

    rowFor(c, 'latest').onCmp({ stopPropagation() {} })
    rowFor(c, B).onCmp({ stopPropagation() {} })
    c.computed().startCompare({ stopPropagation() {} })
    await settled()

    expect(c.state.cmpPair).toEqual([A, B])
    expect(loadCompareReport).toHaveBeenCalledWith('proj1', A, B, 'assembled',
                                                   'sekrit')
  })
})

describe('a pointer reaching compareRevisions anyway', () => {
  it('is resolved, so a reader standing on /latest/ can compare from there', async () => {
    // The one door resolves, which is what covers every caller at once: this
    // page's own slot, an address someone typed with a pointer in it, and
    // `popstate` back onto one.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ builds: BUILDS })

    c.compareRevisions(['latest', B])
    await settled()

    expect(c.state.cmpPair).toEqual([A, B])
    expect(startCompare).not.toHaveBeenCalled()
  })

  it('opens no panel for the dev slot, which resolves to nothing', async () => {
    // Refusing it is the decision, and the refusal is the same one the hub
    // makes: there is no permanent name to ask with, so there is no comparison
    // to show and nothing is asked for.
    const c = page({ builds: BUILDS })

    c.compareRevisions(['dev', B])
    await settled()

    expect(c.state.compare).toBe(false)
    expect(c.state.cmpPair).toBe(null)
    expect(loadCompareReport).not.toHaveBeenCalled()
    expect(startCompare).not.toHaveBeenCalled()
  })
})

// -- and what ends one --------------------------------------------------------

describe('leaving the build', () => {
  it('ends the comparison it was started from', () => {
    // The panel stands where the tree stands and the scene on screen is the
    // comparison's, so a swap that kept it would move the address and change
    // nothing the reader can see.
    const c = comparing()

    const { state } = c.leaveBuild(true)

    expect(state.compare).toBe(false)
    expect(state.cmpPair).toBe(null)
    expect(state.cmpStage).toBe(null)
    expect(state.cmpReport).toBe(null)
  })

  it('keeps the ticks, which are a choice the reader made', () => {
    const c = comparing()
    expect('cmp' in c.leaveBuild(true).state).toBe(false)
  })
})

// -- the banner, when a comparison opens under it -----------------------------
//
// THE POLL'S OFFER AND THIS PANEL CANNOT BOTH BE STANDING. Entering a comparison
// from a pointer page moves the address onto the commit — deliberately, since
// that is the shareable link — and `takePending` is the one door that opens
// another build WITHOUT moving the address, because it was written for a page
// where `PAGE.base` already means "the newest". Pressed inside a comparison it
// put one build's `views` and `buildKey` in state beside another build's `base`:
// the view file fetched fine, so the OLD geometry stayed on screen under the NEW
// build's name, with the downloads pointing into the old directory.
describe('the offer of a newer build, when a comparison opens', () => {
  /** What the poll saw: a commit neither end of the pair is. */
  const NEWER = { ...META, commit: C, built: '2026-08-29T18:20:00Z' }

  /** Standing on `/latest/` with the banner up, which is where this happens. */
  function watching(over = {}) {
    opened('/project/proj1/latest/')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ builds: BUILDS, pending: NEWER, bannerGone: false, ...over })
    c.schedulePoll = vi.fn()
    return c
  }

  it('is withdrawn, banner and all, on the way in', () => {
    const c = watching()
    expect(c.computed().bannerStyle).toContain('display:flex')

    c.compareRevisions(['latest', B])

    expect(c.state.pending).toBe(null)
    expect(c.computed().bannerStyle).toContain('display:none')
    // LIFTED RATHER THAN SET, exactly as `switchBuild` leaves it: nothing has
    // been offered on the road the page is now on, so the flag must not be
    // standing when the reader comes back out and the next poll offers again.
    expect(c.state.bannerGone).toBe(false)
  })

  it('leaves Switch with nothing to take, which is the whole defect', () => {
    const c = watching()

    c.compareRevisions(['latest', B])
    c.computed().bannerSwitch()

    // The build on screen is still the one this page opened, and the address is
    // still the comparison's.
    expect(c.state.meta.commit).toBe(A)
    expect(c.state.compare).toBe(true)
    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
  })

  it('leaves a swap Switch had already deferred with nothing to do', () => {
    // Switch waits while the reader's hand is on the model (`takePending`) and
    // that timer outlives the gesture — it fires a quarter of a second later,
    // inside the comparison. What stops it swapping the build is the offer being
    // gone rather than the timer being cancelled: `takePending` returns on an
    // empty `pending` before it touches anything. Later has to cancel it
    // (`dismissPending`) precisely because Later leaves the offer standing.
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const c = watching()
    c.host = { current: { isBusy: () => true } }

    c.takePending()
    c.compareRevisions(['latest', B])
    vi.advanceTimersByTime(5000)

    expect(c.state.pending).toBe(null)
    expect(c.state.meta.commit).toBe(A)
  })

  it('drops an answer the poll was already waiting for', async () => {
    // The request went out on the pointer and lands on a page that has moved,
    // so the offer it carries is about a road this page has left — and putting
    // it back up would hand the reader the very button the withdrawal exists to
    // take away. Cut off by generation, the way `switchBuild` cuts one off.
    let land
    loadMeta.mockReturnValue(new Promise((done) => { land = done }))
    const c = watching({ pending: null })
    const polling = c.poll()

    c.compareRevisions(['latest', B])
    land(NEWER)
    await polling

    expect(c.state.pending).toBe(null)
    expect(c.computed().bannerStyle).toContain('display:none')
  })

  it('is made again once the reader is back on the pointer', async () => {
    // Withdrawn is not refused: the way out puts the page back on `latest`
    // (`leaveCompare`), the poll re-arms with it, and the next answer offers the
    // build again if it is still the newest.
    const c = watching()
    c.compareRevisions(['latest', B])
    await settled()
    c.computed().exitCompare({ stopPropagation() {} })
    expect(isPointerPage()).toBe(true)

    c.schedulePoll = vi.fn()
    loadMeta.mockResolvedValue(NEWER)
    await c.poll()

    expect(c.state.pending).toEqual(NEWER)
    expect(c.state.bannerGone).toBe(false)
    expect(c.computed().bannerStyle).toContain('display:flex')
  })
})

describe('the model event a comparison sends back', () => {
  it('does not put the comparison\'s view id on the build page', () => {
    // `compare:assembled` is not one of `meta.views` — the prefix is what keeps
    // it from ever colliding with one — so a page that recorded it would light
    // no tab and, on the way out, ask the viewport for a view the build does not
    // have.
    const c = comparing()
    c.sync = vi.fn()
    c.captureHome = vi.fn()

    c.onModel({ view: 'compare:assembled', tree: CMP_TREE, live: false })

    expect(c.state.view).toBe('assembled')
    expect(c.state.tree.nodes.has(`${COMPARE_GROUPS.added}/plate #1`)).toBe(true)
  })

  it('still records the view a build\'s own model event names', () => {
    const c = page()
    c.captureHome = vi.fn()

    c.onModel({ view: 'printables', tree: TREE, live: false })

    expect(c.state.view).toBe('printables')
  })
})

// -- the link somebody sends somebody else ------------------------------------
//
// THE REASON THE ROUTE EXISTS. A comparison reached by ticking two rows never
// moves the address, so `/project/<pid>/<a>/compare/<b>/` is only ever arrived
// at cold — and until this it was arrived at broken: the bundle read the address
// literally, fetched `meta.json` under it, and drew the error panel over a route
// that serves two files and 404s on everything else.
//
// The decision is that the address means "the page of build `<a>`, comparing
// against `<b>`": everything that is not the scene is `<a>`'s, exactly as if the
// reader had opened `/project/<pid>/<a>/` and ticked `<b>`.

/** Stand the browser on `pathname` and let `PAGE` catch up, as a load would. */
function opened(pathname) {
  window.history.replaceState(null, '', pathname)
  rereadPage(pathname)
}

/** `meta.json` as the hub writes it for the build the link names. */
const META = {
  project: 'fixture', title: 'Fixture', commit: A, published: null,
  built: '2026-08-27T18:20:00Z', parts: PARTS, views: VIEWS,
}

describe('a comparison opened by its own URL', () => {
  it('reads the address as the page of <a>, comparing against <b>', () => {
    // One reading of the pathname and this is it (`pageFrom`): the base is the
    // BUILD's directory, so every relative fetch on the page — meta.json, the
    // view files, the downloads — goes where a build page's would.
    opened(`/project/proj1/${A}/compare/${B}/`)

    expect(PAGE.pid).toBe('proj1')
    expect(PAGE.slot).toBe(A)
    expect(PAGE.base).toBe(`/project/proj1/${A}/`)
    expect(PAGE.cmp).toBe(B)
  })

  it('leaves a build page alone, including a build called compare', () => {
    // `compare` passes the hub's own `SAFE_ID`, so a project may have published
    // a build under that name and its page is at `/project/<pid>/compare/`. The
    // word only means a comparison in the FOURTH segment, which is exactly where
    // that page has the trailing slash instead.
    opened('/project/proj1/compare/')

    expect(PAGE.slot).toBe('compare')
    expect(PAGE.base).toBe('/project/proj1/compare/')
    expect(PAGE.cmp).toBe('')
  })

  it('loads <a>\'s documents and boots straight into the comparison', async () => {
    // The whole claim in one test: the page that comes up is `<a>`'s — its
    // meta.json, its builds.json, its picker with both rows ticked — and the
    // panel is already measuring the pair the link names, on the view a build
    // page would have opened by itself.
    opened(`/project/proj1/${A}/compare/${B}/`)
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(null)
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ watch: true })

    await c.load()
    await settled()

    // No argument: `loadMeta` then asks under `PAGE.base`, which is `<a>`'s.
    expect(loadMeta).toHaveBeenCalledWith()
    expect(loadBuilds).toHaveBeenCalled()
    expect(c.state.meta).toBe(META)
    expect(c.state.compare).toBe(true)
    expect(c.state.cmpPair).toEqual([A, B])
    expect(c.state.cmpStage).toBe('ready')
    // The ticks the sender had made, made again: the panel is reachable a second
    // time from the picker without the reader having to work out which two rows
    // the link they followed was about.
    expect(c.state.cmp).toEqual([A, B])
    expect(loadCompareReport).toHaveBeenCalledWith('proj1', A, B, 'assembled',
                                                   'sekrit')
  })

  it('opens the view a build page would, since THIS address names none', () => {
    // A comparison address carries `?v=` exactly as a build address does — the
    // same `viewQuery`, written by `moveAddress`, and dropped for the build's
    // first view — so a link with nothing after the path is a link to the
    // default view, and the page opens on the one `/project/<pid>/<a>/` opens
    // on. The other half is pinned further down, by `carries the view query the
    // page itself would write`: a comparison started on another tab is sent with
    // that tab in the query.
    opened(`/project/proj1/${A}/compare/${B}/`)
    expect(compareBase(PAGE.pid, PAGE.slot, PAGE.cmp))
      .toBe(`/project/proj1/${A}/compare/${B}/`)
    expect(window.location.search).toBe('')
  })

  it('puts the address back on <a> when the panel is closed', async () => {
    // Closing the panel puts the BUILD on screen, and the build is `<a>` — the
    // one the reader is already standing on, so nothing is fetched. What would
    // be left otherwise is an address naming a comparison that is not up, and a
    // `PAGE` that no longer describes it.
    opened(`/project/proj1/${A}/compare/${B}/`)
    const c = comparing()

    c.computed().exitCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe(`/project/proj1/${A}/`)
    expect(PAGE.cmp).toBe('')
    expect(PAGE.base).toBe(`/project/proj1/${A}/`)
    expect(c.state.compare).toBe(false)
  })

  it('comes out on the COMMIT, since a link was never on a pointer', async () => {
    // The other door out, and it must not take the new path: a comparison
    // opened from a typed or shared URL has no pointer behind it — `<a>` is a
    // commit, the reader has stood on nothing else since the page loaded, and
    // the build's own address is the only answer there is. Run through the real
    // `load()` rather than a hand-built state, because what is under test is
    // what the LOAD leaves behind for the way out to read.
    opened(`/project/proj1/${A}/compare/${B}/`)
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(BUILDS)
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page()
    c.schedulePoll = vi.fn()

    await c.load()
    await settled()
    expect(c.state.compare).toBe(true)

    c.computed().exitCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe(`/project/proj1/${A}/`)
    expect(PAGE.slot).toBe(A)
    expect(PAGE.cmp).toBe('')
    expect(isPointerPage()).toBe(false)
  })

  it('leaves the address alone when the comparison was started in the page', () => {
    // Closing a comparison the reader never navigated to: the bar is the build's
    // already, so there is nothing to move and no entry to rewrite.
    const c = comparing()

    c.computed().exitCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe(`/project/proj1/${A}/`)
    expect(c.state.compare).toBe(false)
  })
})

// -- and the link somebody makes by comparing ---------------------------------
//
// The other half of the same fix. Nothing in the interface produced that address
// — it worked only for whoever typed it — which for an address chosen so a
// comparison can be SENT is a defect and not a gap. So entering one moves the
// bar, and because that is a real navigation it is a `pushState`: Back has to
// take the reader out of it, which makes `popstate` this page's business in both
// directions.

describe('a comparison entered in the page', () => {
  it('pushes the address, so what is on the screen can be copied and sent', () => {
    const push = vi.spyOn(history, 'pushState')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ cmp: [A, B] })

    c.computed().startCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
    // PUSH and not replace: this is somewhere the reader went, so Back is what
    // takes them out of it — and `popstate` is what answers that.
    expect(push).toHaveBeenCalledTimes(1)
    // And `PAGE` says what the bar says, which is what every fetch reads.
    expect(PAGE.cmp).toBe(B)
    expect(PAGE.base).toBe(`/project/proj1/${A}/`)
  })

  it('carries the view query the page itself would write', () => {
    // `viewQuery`, the same reading `switchBuild` writes an address with: '' for
    // the build's first view, so the ordinary comparison is a link with nothing
    // after the path, and a comparison of another tab reopens on that tab.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ cmp: [A, B], view: 'printables' })

    c.computed().startCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
    expect(window.location.search).toBe('?v=printables')
  })

  it('pushes nothing when the address already names that comparison', () => {
    // Three doors arrive here with the bar already right — a link opened cold,
    // Try again beside a failure, and a view tab pressed mid-comparison — and an
    // entry pushed for any of them would be a Back that goes nowhere the reader
    // has been. Measured against the bar rather than told by the caller.
    opened(`/project/proj1/${A}/compare/${B}/`)
    const push = vi.spyOn(history, 'pushState')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = comparing({ cmpStage: 'failed', cmpError: 'the hub was restarting' })

    c.computed().retryCompare({ stopPropagation() {} })

    expect(push).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
  })

  it('takes the address off a comparison it cannot spell', () => {
    // The ticks are ANY two rows, so a reader standing on `<a>` can compare
    // `<b>` against `<c>` — and `/project/<pid>/<b>/compare/<c>/` is the page of
    // `<b>`, whose meta.json and downloads this page is not showing. That
    // comparison has no link; what it must not do is leave the bar naming the
    // one that has just been closed.
    opened(`/project/proj1/${A}/compare/${B}/`)
    const push = vi.spyOn(history, 'pushState')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = comparing()

    c.compareRevisions([B, C])

    expect(push).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/project/proj1/${A}/`)
    expect(PAGE.cmp).toBe('')
    expect(c.state.cmpPair).toEqual([B, C])
  })

  it('writes the COMMIT\'s address when the page stands on a pointer', () => {
    // `/project/<pid>/latest/` is where readers land, and "compare against the
    // previous revision, then send the link" is the whole reason this address
    // shape was chosen. A pair is two commits, so the pointer's own name never
    // appears in one — and the address written is the commit's, which is the
    // build the pointer was already showing under the name that still means it
    // tomorrow. `/latest/compare/<b>/` is refused by the hub and would name a
    // different pair the day the pointer moves.
    opened('/project/proj1/latest/')
    const push = vi.spyOn(history, 'pushState')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ builds: BUILDS })

    c.compareRevisions(['latest', B])

    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
    expect(push).toHaveBeenCalledTimes(1)
    // And `PAGE` follows the bar, so meta.json, the downloads, the picker's
    // current row and the comment rail all describe that same build.
    expect(PAGE.slot).toBe(A)
    expect(PAGE.base).toBe(`/project/proj1/${A}/`)
    expect(PAGE.cmp).toBe(B)
    expect(c.state.cmpPair).toEqual([A, B])
  })

  it('comes back out onto that pointer when the panel is closed', async () => {
    // WHAT THE COMMIT ADDRESS COSTS, and it is not only the bar: standing on a
    // commit is what `isPointerPage` answers, so `schedulePoll` stops re-arming
    // and the watch for new builds dies, and the chip stops saying `up to
    // date`. Closing the panel used to answer with `<a>` — the commit — so a
    // reader who merely opened a comparison and shut it again was pinned for
    // the rest of the session, with nothing on the screen saying so and only
    // Back or the picker's `latest` row to undo it.
    loadCompareReport.mockResolvedValue(REPORT)
    opened('/project/proj1/latest/')
    const push = vi.spyOn(history, 'pushState')
    const c = page({ watch: true, builds: BUILDS })
    c.schedulePoll = vi.fn()
    const seen = listening()

    c.compareRevisions(['latest', B])
    await settled()
    // The link the comparison is up under is the COMMIT's, and that is not in
    // question: it is the whole of what makes the address mean this pair
    // tomorrow.
    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
    expect(isPointerPage()).toBe(false)

    c.computed().exitCompare({ stopPropagation() {} })

    expect(window.location.pathname).toBe('/project/proj1/latest/')
    expect(PAGE.slot).toBe('latest')
    expect(PAGE.base).toBe('/project/proj1/latest/')
    expect(PAGE.cmp).toBe('')
    // The watch, re-armed — and the chip, which is drawn from the same answer.
    expect(isPointerPage()).toBe(true)
    expect(c.schedulePoll).toHaveBeenCalled()
    expect(c.computed().statusText).toBe('up to date')
    // AND THE ADDRESS MOVES FIRST, which is what the one payload the viewport
    // gets is read off: `sync` builds it out of `PAGE.base`, so a page that
    // closed the panel before it moved would point the element at the commit's
    // directory and never send a second event correcting it.
    expect(seen[seen.length - 1].base).toBe('/project/proj1/latest/')
    // AND NOTHING IS LEFT BEHIND: the one entry is the one entering pushed, and
    // the way out replaces it, exactly as closing a comparison on a build page
    // does. Closing a panel is not somewhere the reader went.
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('still writes none for a pair whose first end is not on screen', () => {
    // The rule the pointer case is an instance of, not an exception to: the
    // ticks are ANY two rows, so a reader on `<a>` can compare `<b>` against
    // `<c>`, and `/project/<pid>/<b>/compare/<c>/` is the page of `<b>` — whose
    // meta.json and downloads this page is not showing.
    opened('/project/proj1/latest/')
    const push = vi.spyOn(history, 'pushState')
    loadCompareReport.mockResolvedValue(REPORT)
    const c = page({ builds: BUILDS })

    c.compareRevisions([B, C])

    expect(push).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/project/proj1/latest/')
    expect(c.state.cmpPair).toEqual([B, C])
  })

  it('keeps its address when a swap to somewhere else is called off', () => {
    // `switchBuild`'s cancelling branch, which repairs the bar for a reader who
    // pressed Forward onto B and then clicked the row for the build still on
    // screen. Nothing there changes what is DRAWN, so the address it repairs to
    // is the comparison's whenever one is up — writing the build's URL would
    // take the panel's own link away under a panel nobody closed.
    opened(`/project/proj1/${A}/compare/${B}/`)
    const replace = vi.spyOn(history, 'replaceState')
    const c = comparing()
    // A swap to C on the wire is what makes this branch reachable at all:
    // `_want` is where the page is going, and the gesture asks to stay.
    c._want = C

    c.switchBuild('proj1', A)

    expect(replace).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)
    expect(PAGE.cmp).toBe(B)
  })
})

describe('back and forward through a comparison', () => {
  /** The browser moving first, which is the whole shape of a `popstate`. */
  const back = async (pathname) => {
    window.history.replaceState(null, '', pathname)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await settled()
  }

  it('enters the comparison an entry names', async () => {
    // The entries only exist because this page pushed them, so it has to answer
    // for them: nothing else reads a comparison off the address after the load.
    loadCompareReport.mockResolvedValue(REPORT)
    const c = mounted()

    await back(`/project/proj1/${A}/compare/${B}/`)

    expect(c.state.compare).toBe(true)
    expect(c.state.cmpPair).toEqual([A, B])
    expect(PAGE.cmp).toBe(B)
  })

  it('leaves the comparison when the entry names none', async () => {
    opened(`/project/proj1/${A}/compare/${B}/`)
    const c = mounted({ compare: true, cmpPair: [A, B], cmpView: 'assembled',
                        cmpStage: 'ready', cmpReport: REPORT })

    await back(`/project/proj1/${A}/`)

    expect(c.state.compare).toBe(false)
    expect(c.state.cmpPair).toBe(null)
    expect(PAGE.cmp).toBe('')
  })

  it('opens the build and the comparison when the entry moves both', async () => {
    // The trip the picker makes possible: compare on `<a>`, switch to another
    // build, then Back. The build has to be opened AND the panel put back — and
    // `PAGE` has to be re-derived from the BAR, since the address the swap
    // composes for itself is the build's and this entry is a comparison's.
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(null)
    loadCompareReport.mockResolvedValue(REPORT)
    opened(`/project/proj1/${C}/`)
    const c = mounted()

    await back(`/project/proj1/${A}/compare/${B}/`)

    expect(PAGE.slot).toBe(A)
    expect(PAGE.base).toBe(`/project/proj1/${A}/`)
    expect(PAGE.cmp).toBe(B)
    expect(c.state.meta).toBe(META)
    expect(c.state.compare).toBe(true)
    expect(c.state.cmpPair).toEqual([A, B])
  })

  it('re-derives PAGE from the bar, and not from the path the swap composed', async () => {
    // `switchBuild` writes its own address when it PUSHES, so the two agree
    // there. A `popstate` is the other way round — the browser moved first, onto
    // an entry this page wrote, which may name a comparison — and reading the
    // record off the build URL the swap composed would leave `PAGE.cmp` empty
    // under an address that names a pair. Asserted on `switchBuild` itself,
    // because `syncCompare` re-derives it a second time one step later and would
    // hide the difference.
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(null)
    opened(`/project/proj1/${C}/`)
    const c = page()
    window.history.replaceState(null, '', `/project/proj1/${A}/compare/${B}/`)

    await c.switchBuild('proj1', A, { push: false })

    expect(PAGE.slot).toBe(A)
    expect(PAGE.cmp).toBe(B)
  })

  it('comes back out onto the pointer page it was entered from', async () => {
    // The entry behind a comparison entered on `/project/<pid>/latest/` is that
    // pointer page, so Back has to land there with the panel closed — and the
    // page has to be the pointer's again, live reload and all. What Back must
    // never land on is `/latest/compare/<b>/`, which the hub answers 404.
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(BUILDS)
    loadCompareReport.mockResolvedValue(REPORT)
    opened('/project/proj1/latest/')
    const c = mounted({ builds: BUILDS })

    c.compareRevisions(['latest', B])
    await settled()
    expect(window.location.pathname).toBe(`/project/proj1/${A}/compare/${B}/`)

    await back('/project/proj1/latest/')

    expect(PAGE.slot).toBe('latest')
    expect(PAGE.cmp).toBe('')
    expect(c.state.compare).toBe(false)
    expect(c.state.cmpPair).toBe(null)
  })

  it('gets there first, and the panel\'s own way out does not fight it', async () => {
    // Two doors reach the same pointer page now: Back, where the browser has
    // already restored the entry, and the exit inside the panel, which has an
    // address of its own to write (`leaveCompare`). On this trip the swap has
    // closed the comparison before `syncCompare` is even asked, so the second
    // door is never opened — and what it must not do is lay an entry on top of
    // the one the reader came back to, which would cost them Forward.
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(BUILDS)
    loadCompareReport.mockResolvedValue(REPORT)
    opened('/project/proj1/latest/')
    const c = mounted({ builds: BUILDS })

    c.compareRevisions(['latest', B])
    await settled()
    const push = vi.spyOn(history, 'pushState')

    await back('/project/proj1/latest/')

    expect(c.state.compare).toBe(false)
    expect(PAGE.slot).toBe('latest')
    expect(window.location.pathname).toBe('/project/proj1/latest/')
    expect(isPointerPage()).toBe(true)
    expect(push, 'the way out wrote an entry over the one Back restored')
      .not.toHaveBeenCalled()
  })

  it('reads an entry naming a pointer as the commit it stands for', async () => {
    // The idempotency this block turns on is measured against the PAIR, and the
    // pair on screen is a pair of commits. An entry whose `<a>` is `latest`
    // names the same comparison as the commit it resolves to, so reading the
    // two as different strings would tear the panel down and rebuild it on
    // every trip through such an entry.
    loadCompareReport.mockResolvedValue(REPORT)
    opened('/project/proj1/latest/')
    const c = page({ builds: BUILDS, compare: true, cmpPair: [A, B],
                     cmpView: 'assembled', cmpStage: 'ready', cmpReport: REPORT })

    c.syncCompare({ slot: 'latest', cmp: B })
    await settled()

    expect(loadCompareReport).not.toHaveBeenCalled()
    expect(c.state.cmpPair).toEqual([A, B])
  })

  it('restores an entry\'s view without restarting the comparison on it', async () => {
    // THE DOOR THE ONE-VIEW FIXTURE HID. Coming back onto an entry of the build
    // already on screen leaves one thing out of step — that entry's `?v=` — and
    // `switchBuild`'s cancelling branch used to put it back through `showView`,
    // which while a comparison is up is not a view switch at all: it restarts
    // the comparison on the new view, `compareRevisions` moves the address, and
    // `moveAddress` PUSHES. That is a `popstate` ending in a `pushState` — the
    // entry the reader came back to overwritten, their Forward gone, and two
    // identical entries where there was one. Both this file and `moveAddress`
    // say in prose that it cannot happen, and two tests here assert it; none of
    // them could see this door, because a build with one view has no entry whose
    // `?v=` differs from the tab on screen.
    //
    // THE SWAP IN FLIGHT IS WHAT MAKES THE BRANCH REACHABLE: the guard above it
    // answers "already going there" off `_want`, so the cancelling branch is
    // only entered by a gesture that asks to STAY while the page is on its way
    // somewhere else. A `loadMeta` that never resolves is that journey.
    opened(`/project/proj1/${A}/compare/${B}/`)
    loadCompareReport.mockResolvedValue(REPORT)
    loadMeta.mockImplementation(() => new Promise(() => {}))
    const c = mounted({ compare: true, cmpPair: [A, B], cmpView: 'assembled',
                        cmpStage: 'ready', cmpReport: REPORT })

    // Forward onto another build: the swap goes out and never lands, so the
    // comparison is still what is on the screen.
    await back(`/project/proj1/${C}/`)
    expect(c._want).toBe(C)
    const push = vi.spyOn(history, 'pushState')

    // And Back again, onto an entry of the build that never left — on the other
    // tab, which is the whole of what is out of step.
    await back(`/project/proj1/${A}/?v=printables`)

    expect(push, 'a popstate that pushes buries the entry the reader came back to')
      .not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/project/proj1/${A}/`)
    expect(window.location.search).toBe('?v=printables')
    // The view the entry named is on screen, and the panel is closed — by
    // `syncCompare`, reading the address, which is the one door that answers
    // whether an entry is a comparison.
    expect(c.state.view).toBe('printables')
    expect(c.state.compare).toBe(false)
    expect(PAGE.cmp).toBe('')
  })

  it('puts the comparison on the view its own entry names', async () => {
    // THE OTHER SIDE OF WRITING THE VIEW BARE. The entry above named no
    // comparison, so the panel simply closed; this one names the pair already on
    // screen ON ANOTHER VIEW — an entry pushed by a comparison started from the
    // `printables` tab, come back to after the reader pressed `assembled` inside
    // the panel (which moves the comparison and deliberately not the address).
    // A comparison is computed per view, so the same pair on another view is a
    // different comparison: with the pair alone as the test of agreement, the
    // strip would light `printables` over the assembled comparison's scene and
    // nothing would ever correct it.
    //
    // AND IT STILL PUSHES NOTHING — the address is the one being agreed with.
    opened(`/project/proj1/${A}/compare/${B}/?v=printables`)
    loadCompareReport.mockResolvedValue(REPORT)
    loadMeta.mockImplementation(() => new Promise(() => {}))
    const c = mounted({ compare: true, cmpPair: [A, B], cmpView: 'assembled',
                        cmpStage: 'ready', cmpReport: REPORT })

    // A swap to another build on the wire, so the gesture below reaches the
    // branch that only calls it off.
    await back(`/project/proj1/${C}/`)
    const push = vi.spyOn(history, 'pushState')

    await back(`/project/proj1/${A}/compare/${B}/?v=printables`)

    expect(push).not.toHaveBeenCalled()
    expect(c.state.view).toBe('printables')
    expect(c.state.cmpView).toBe('printables')
    expect(c.state.cmpPair).toEqual([A, B])
    expect(loadCompareReport)
      .toHaveBeenCalledWith('proj1', A, B, 'printables', 'sekrit')
  })

  it('asks for nothing when the entry only moved the build', async () => {
    // The reading is idempotent against the bar, which is what lets `popstate`
    // run it after every entry rather than only after the ones that changed the
    // mode: a Back between two builds must not open a panel or push anything.
    loadMeta.mockResolvedValue(META)
    loadBuilds.mockResolvedValue(null)
    const push = vi.spyOn(history, 'pushState')
    opened(`/project/proj1/${C}/`)
    const c = mounted()

    await back(`/project/proj1/${A}/`)

    expect(c.state.compare).toBe(false)
    expect(loadCompareReport).not.toHaveBeenCalled()
    expect(push, 'a popstate that pushes buries the entry the reader came back to')
      .not.toHaveBeenCalled()
  })
})
