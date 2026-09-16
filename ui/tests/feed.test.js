// The project's comment queue on the build page — issue #33.
//
// The rail used to hold what THIS session had posted and nothing else, because
// the page had no other copy of a comment. It reads the queue now
// (`GET /api/v1/comments?project=<pid>`, under the same EDIT_TOKEN the page
// already holds), and every claim below is about what that changes:
//
//   * the queue is per PROJECT (SPEC 7A.3), so it is fetched once, refetched
//     after a write, and NOT re-asked for on a revision switch;
//   * a comment is bound to the PRINTED ENTITY, which is its catalogue key
//     (issue #75) — not to the tree path a rebuild is free to renumber, and not
//     to a coordinate that is only true on the geometry it was measured on;
//   * where the key names nothing in the catalogue any more the comment is
//     ORPHANED, and that has to be VISIBLE in the rail rather than inferred by
//     the reader from a pin that quietly did not appear.
//
// The anchor arithmetic itself is `anchorFor`, pinned in ui/tests/anchor.test.js;
// this file is about the page's USE of it — what is fetched, what the rail says,
// and which of the five answers reaches the viewport as a pin.
//
// NOTHING IS MOUNTED, which is this directory's arrangement (chrome.test.js,
// theme.test.js, narrow.test.js): the real prototype over a state object spelled
// out by hand, with the real `computed()`, `render()` and `sync()` run against it.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { STATE } from '../src/events.js'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { texts } from './eltree.js'
import { guardPage } from './pageguard.js'

const REV = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'
const OLDER = '1f2e3d4c5b6a7988776655443322110099887766554433221100998877665544'
// The build's own stamp, off its meta.json: half of what says WHICH build this
// is, and the only half that moves on the local slot (SPEC 7.6).
const STAMP = '2026-08-27T18:00:00.123Z'

guardPage(`/project/proj1/${REV}/`)

/**
 * The build on screen: it draws `plate`, and its catalogue also holds `post`.
 *
 * The row's NAME and its KEY are deliberately different — `plate(2)` is what the
 * tessellator calls the second instance and `plate` is the catalogue entry — so
 * nothing here can pass by anchoring on the display name.
 */
const TREE = {
  id: '/model',
  name: 'model',
  children: [{ id: '/model/plate', name: 'plate(2)', key: 'plate' }],
}

const PARTS = {
  plate: { kind: 'printable', files: { stl: 'plate.stl' } },
  post: { kind: 'printable', files: { stl: 'post.stl' } },
}

/** One stored comment, in the shape `CommentStore.add` writes (SPEC 7A.1). */
const record = (over = {}) => ({
  id: 'c1', pid: 'proj1', commit: REV, published: STAMP, view: 'assembled',
  part: '/model/plate', key: 'plate', point: null, camera: null,
  text: 'this is too thin', status: 'open', created: '2026-08-27T18:20:00Z',
  resolved: null, note: null, ...over,
})

const served = (comments) => ({ status: 200, json: async () => ({ comments }) })

/** Each call answered by the next response; the last one stands for the rest. */
function answering(...responses) {
  const fetching = vi.fn(async () => (responses.length > 1
    ? responses.shift() : responses[0]))
  vi.stubGlobal('fetch', fetching)
  return fetching
}

/**
 * The component as `loadFeed`, `computed()` and `sync()` see it.
 *
 * `setState` is the real one's CONTRACT rather than React's — merge, then run
 * the callback — because the callback is where `set()` reaches `sync`. `sync`
 * itself is a spy unless a test asked to `watch` the real one, which is what
 * puts a `hmr:state` event on the window.
 */
function page({ feed = [], token = 'sekrit', partPoint, watch, ...over } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.host = { current: partPoint ? { partPoint } : null }
  c.state = {
    meta: {
      project: 'fixture', title: 'Fixture', commit: REV, published: STAMP,
      built: '2026-08-27T18:00:00Z', parts: PARTS,
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['plate'], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree(TREE),
    error: null, viewError: null, pending: null, swapping: false,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: true, menu: { id: null, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    feed, activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    token, tokenPop: false, tokenDraft: '',
    theme: 'light', tabs: [], narrow: false, treeOpen: false,
    ...over,
  }
  c.setState = vi.fn((patch, done) => {
    const next = typeof patch === 'function' ? patch(c.state) : patch
    c.state = { ...c.state, ...next }
    if (done) done()
  })
  if (!watch) c.sync = vi.fn()
  c.toast = vi.fn()
  return c
}

/** The detail of every `hmr:state` event, for a page built with `watch: true`. */
function listening() {
  const seen = []
  const listen = (event) => seen.push(event.detail)
  window.addEventListener(STATE, listen)
  onTestFinished(() => window.removeEventListener(STATE, listen))
  return seen
}

/** Everything a fetch chain has queued behind it, run. */
const settled = () => new Promise((done) => { setTimeout(done, 0) })

afterEach(() => {
  vi.unstubAllGlobals()
})

// -- reading the queue --------------------------------------------------------

describe('loadFeed', () => {
  it('asks for the project\'s queue with the token, and keeps what came back', async () => {
    const records = [record(), record({ id: 'c2' })]
    const fetching = answering(served(records))
    const c = page()

    await c.loadFeed()

    expect(fetching).toHaveBeenCalledWith('/api/v1/comments?project=proj1',
      { headers: { Authorization: 'Bearer sekrit' } })
    expect(c.state.feed).toEqual(records)
  })

  it('asks for the PROJECT and never for one build', async () => {
    // The queue outlives a revision (SPEC 7A.3), and a request narrowed to the
    // commit on screen would quietly make it a per-build list again.
    const fetching = answering(served([]))
    await page().loadFeed()
    expect(fetching.mock.calls[0][0]).not.toContain(REV)
  })

  it('says so and keeps the queue it had when the hub refuses the token', async () => {
    answering({ status: 401, json: async () => ({}) })
    const c = page({ feed: [record()] })

    await c.loadFeed()

    expect(c.toast).toHaveBeenCalledWith('The hub refused the token')
    expect(c.state.feed).toHaveLength(1)
  })

  it('is never thrown out of when the hub cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const c = page()

    await expect(c.loadFeed()).resolves.toBeUndefined()
    expect(c.toast).toHaveBeenCalledWith('Could not reach the hub')
  })

  it('is never thrown out of when the body is not the queue', async () => {
    answering({ status: 200, json: async () => { throw new SyntaxError('<') } })
    const c = page()

    await expect(c.loadFeed()).resolves.toBeUndefined()
    expect(c.state.feed).toEqual([])
  })
})

// -- the two writes, which refetch rather than guess --------------------------

describe('a comment that was just filed', () => {
  it('posts the catalogue key beside the path', async () => {
    // The path is a number the next build is free to hand to something else; the
    // key is what the pin follows through a rebuild (issue #75).
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      composer: { part: 'plate(2)', partId: '/model/plate', key: 'plate',
                  p: [1, 2, 3], text: 'too thin', photo: null },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.key).toBe('plate')
    expect(sent.part).toBe('/model/plate')
  })

  it('stamps the build on screen, not the one the slot holds when it lands', async () => {
    // THE SHARP ONE, and the reason `published` is a payload field at all. On
    // the local slot `commit` is the constant `dev` for every build it ever
    // holds (SPEC 7.6), so the POST goes to the same URL before and after a
    // rebuild. The reader placed this point on P1 and is still typing when the
    // slot rebuilds into P2; the page does not follow a rebuild on its own —
    // polling only raises the banner — so the coordinate in the composer is
    // still P1's. A hub reading the slot's meta.json at this moment would stamp
    // the record P2, and P1's coordinate would then be painted on P2's
    // geometry. So the stamp rides in the payload, out of the page's own `meta`.
    const P2 = '2026-08-27T18:41:00.456Z'
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      composer: { part: 'plate(2)', partId: '/model/plate', key: 'plate',
                  p: [1, 2, 3], text: 'too thin', photo: null },
    })
    c.state.meta = { ...c.state.meta, commit: 'dev' }

    await c.sendComment()

    expect(fetching.mock.calls[0][0]).toBe('/api/v1/comments/proj1/dev')
    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.published).toBe(c.state.meta.published)
    expect(sent.published).toBe(STAMP)
    expect(sent.published).not.toBe(P2)
  })

  it('is read back off the hub rather than appended here', async () => {
    // The page used to invent a row — its own id, its own label, `just now` —
    // because it had no other copy of the queue. What the rail shows now is the
    // record the hub actually stored, with the id and the stamp the agent sees.
    const stored = record({ id: 'real', created: '2026-08-27T19:00:00Z' })
    const fetching = answering({ status: 201 }, served([stored]))
    const c = page({
      composer: { part: 'plate(2)', partId: '/model/plate', key: 'plate',
                  p: null, text: 'too thin', photo: null },
    })

    await c.sendComment()

    expect(fetching).toHaveBeenCalledTimes(2)
    expect(fetching.mock.calls[1][0]).toBe('/api/v1/comments?project=proj1')
    expect(c.state.feed).toEqual([stored])
  })

  it('carries the measurement, the drag and the proposal in the TEXT', async () => {
    // The hub's comment schema is CLOSED — `validate_payload` keeps seven keys
    // and drops everything else without a word, which is the quietest failure on
    // this page: the field reaches the hub, is discarded, and the sender sees a
    // 201. So everything that has to survive the trip is spliced into `text`,
    // and tests/test_ui_source.py holds the other end of it.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      composer: {
        part: 'plate(2)', partId: '/model/plate', key: 'plate', p: null,
        text: 'must clear this', photo: null,
        meas: '2.4 mm', move: 'plate by 3 mm',
        proposal: 'units: mm\n\nsolid  box  "motor"  20 x 20 x 40  at (0, 0, 0)',
      },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.text).toContain('must clear this')
    expect(sent.text).toContain('measured: 2.4 mm')
    expect(sent.text).toContain('moved: plate by 3 mm (temporary, not in the model)')
    expect(sent.text).toContain('solid  box  "motor"  20 x 20 x 40  at (0, 0, 0)')
    expect(sent.proposal).toBeUndefined()
    // LAST, because it is the only one that spans lines: a block in the middle
    // would split the one-line facts above it away from the sentence they
    // belong to.
    expect(sent.text.indexOf('proposal')).toBeGreaterThan(sent.text.indexOf('moved:'))
  })

  it('leaves the queue alone when the hub refused it', async () => {
    const fetching = answering({ status: 422 })
    const c = page({
      composer: { part: 'plate(2)', partId: '/model/plate', key: 'plate',
                  p: null, text: 'too thin', photo: null },
    })

    await c.sendComment()

    expect(fetching).toHaveBeenCalledTimes(1)
    expect(c.state.feed).toEqual([])
  })
})

describe('closing an item', () => {
  it('reads the queue back instead of marking the row here', async () => {
    // `status`, the stamp on it and the agent's note are the hub's to write, and
    // a row edited in place would be this page's idea of the record.
    const closed = record({ status: 'resolved', resolved: '2026-08-27T20:00:00Z' })
    const fetching = answering({ status: 200 }, served([closed]))
    const c = page({ feed: [record()] })

    await c.resolveComment('c1')

    expect(fetching.mock.calls[0][0]).toBe('/api/v1/comments/c1/resolve')
    expect(fetching.mock.calls[1][0]).toBe('/api/v1/comments?project=proj1')
    expect(c.state.feed).toEqual([closed])
  })

  it('leaves the queue alone when the hub would not close it', async () => {
    answering({ status: 404 })
    const c = page({ feed: [record()] })

    await c.resolveComment('c1')

    expect(c.state.feed[0].status).toBe('open')
  })
})

// -- the token, which is what there is to read the queue with -----------------

describe('the token', () => {
  /** The two controls are closures on `computed()`, wrapped in `stop()`. */
  const CLICK = { stopPropagation: () => {} }

  it('is what the queue arrives with, the moment it is entered', async () => {
    const fetching = answering(served([record()]))
    const c = page({ token: null, tokenDraft: ' sekrit ' })

    c.computed().tokenSave(CLICK)
    await settled()

    expect(fetching).toHaveBeenCalledWith('/api/v1/comments?project=proj1',
      { headers: { Authorization: 'Bearer sekrit' } })
    expect(c.state.feed).toHaveLength(1)
  })

  it('takes the queue with it when it is cleared', () => {
    // Every row in the rail was read under that token, and a browser that no
    // longer has one may not read the queue at all.
    const c = page({ feed: [record()] })

    c.computed().tokenClear(CLICK)

    expect(c.state.feed).toEqual([])
    expect(c.state.token).toBeNull()
  })
})

// -- what the rail says -------------------------------------------------------

describe('the rail', () => {
  it('numbers the whole queue from 1, in the order the hub sorted it', () => {
    const v = page({ feed: [record(), record({ id: 'c2' }), record({ id: 'c3' })] })
      .computed()
    expect(v.threads.map((t) => t.label)).toEqual(['1', '2', '3'])
    expect(v.threads.map((t) => t.key)).toEqual(['c1', 'c2', 'c3'])
  })

  it('counts the open ones by the status the hub stored', () => {
    const v = page({ feed: [record(), record({ id: 'c2', status: 'resolved' })] })
      .computed()
    expect(v.openCount).toBe(1)
    expect(v.threads.map((t) => t.resolved)).toEqual([false, true])
  })

  it('heads a row with the row the key names, not with the stored path', () => {
    // `part` says `/model/plate` and the row drawn from that key is called
    // `plate(2)`: what the reader can find in the tree is the row.
    const v = page({ feed: [record({ commit: OLDER })] }).computed()
    expect(v.threads[0].part).toBe('plate(2)')
    expect(v.threads[0].time).toBe('2026-08-27 18:20')
  })

  it('says a comment whose part has left the catalogue is orphaned', () => {
    const v = page({ feed: [record({ key: 'flange' })] }).computed()
    expect(v.threads[0].says).toBe(
      'the part this was left on is no longer in the catalogue')
  })

  it('names the view a comment belongs to when this one does not draw it', () => {
    // `post` is in the catalogue and no row of this view draws it.
    const v = page({ feed: [record({ key: 'post', view: 'exploded' })] }).computed()
    expect(v.threads[0].says).toBe('the part is not in this view — left on exploded')
  })

  it('draws the text and the anchor as TEXT on the page', () => {
    // The rail is the one place a comment's text is rendered, so this is also
    // the claim that it arrives as a string and never as markup.
    const c = page({ feed: [record({ key: 'flange', text: '<b>too thin</b>' })] })
    const said = texts(c.render())
    expect(said).toContain('<b>too thin</b>')
    expect(said).toContain('the part this was left on is no longer in the catalogue')
  })
})

// -- what reaches the viewport ------------------------------------------------

describe('the pins', () => {
  it('uses the stored coordinate on the build it was taken on', () => {
    const c = page({ feed: [record({ point: [1, 2, 3] })], watch: true })
    const seen = listening()

    c.sync()

    expect(seen[0].pins).toEqual([
      { id: 'c1', label: '1', p: [1, 2, 3], resolved: false, active: false },
    ])
  })

  it('asks the viewport where the part IS on any other build', () => {
    // The coordinate was measured on geometry that has been rebuilt since, so
    // the pin goes where the key is drawn today — which only the viewport can
    // answer.
    const partPoint = vi.fn(() => [7, 8, 9])
    const c = page({
      feed: [record({ commit: OLDER, point: [1, 2, 3] })], partPoint, watch: true,
    })
    const seen = listening()

    c.sync()

    expect(partPoint).toHaveBeenCalledWith('/model/plate')
    expect(seen[0].pins).toEqual([
      { id: 'c1', label: '1', p: [7, 8, 9], resolved: false, active: false },
    ])
  })

  it('draws nothing for a part this view has no row for, or none at all', () => {
    const partPoint = vi.fn(() => [7, 8, 9])
    const c = page({
      feed: [record({ id: 'c1', key: 'post' }), record({ id: 'c2', key: 'flange' }),
             record({ id: 'c3', key: null })],
      partPoint,
      watch: true,
    })
    const seen = listening()

    c.sync()

    expect(partPoint).not.toHaveBeenCalled()
    expect(seen[0].pins).toEqual([])
  })

  it('keeps the draft\'s own pin beside the queue\'s', () => {
    const c = page({
      feed: [record({ point: [1, 2, 3] })],
      composer: { part: 'plate(2)', partId: '/model/plate', p: [4, 5, 6], text: '' },
      watch: true,
    })
    const seen = listening()

    c.sync()

    expect(seen[0].pins.map((pin) => pin.id)).toEqual(['c1', 'draft'])
  })
})
