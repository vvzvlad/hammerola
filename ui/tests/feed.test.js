// The project's comment queue on the build page.
//
// The rail reads the queue (`GET /api/v1/comments?project=<pid>`, under the
// same EDIT_TOKEN the page already holds), and every claim below is about it:
//
//   * the queue is per PROJECT (SPEC 7A.3), so it is fetched once, refetched
//     after a write, and NOT re-asked for on a revision switch;
//   * a comment is bound to the PRINTED ENTITY, which is its catalogue key —
//     not to the tree path a rebuild is free to renumber, and not to a
//     coordinate that is only true on the geometry it was measured on;
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

import { PLACE, STATE } from '../src/events.js'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { emptyProposal } from '../src/proposal.js'
import {
  shrink, SHOT_MAX_SIDE, SHOT_QUALITY, PHOTO_MAX_SIDE, PHOTO_QUALITY,
} from '../src/shrink.js'
import { HmrViewport } from '../src/viewport/element.js'
import * as THREE from '../../static/_v/three.module.js'
import { drained as settled, makeComponent, replaceState } from './component.js'
import { collect, texts } from './eltree.js'
import { fakeViewer } from './fakes.js'
import { guardPage } from './pageguard.js'

// THE RE-ENCODE IS SPIED HERE RATHER THAN RUN, and the constants beside it are
// the real ones. What the module DOES is pinned in ui/tests/shrink.test.js; what
// is pinned in this file is the wiring — that `sendComment` goes through it at
// all, and with which ceiling for which picture. Nothing else can pin that:
// jsdom has no image decoder, so the real `shrink` hands every blob straight
// back, and a `sendComment` that had lost both calls would go on passing every
// other test here. The spy is a pass-through for exactly that reason — it
// behaves like the runner's own answer, so no other test in this file moves.
vi.mock('../src/shrink.js', async (importActual) => {
  const actual = await importActual()
  return { ...actual, shrink: vi.fn(async (blob) => blob) }
})

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
  const c = makeComponent(HammerolaViewer, {
    host: { current: partPoint ? { partPoint } : null },
    setState: replaceState,
    toast: vi.fn(),
    state: {
      meta: {
        project: 'fixture', title: 'Fixture', commit: REV, published: STAMP,
        built: '2026-08-27T18:00:00Z', parts: PARTS,
        views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                  parts: ['plate'], gzip: 1000 }],
      },
      tree: indexTree(TREE),
      rail: true, menu: { id: null, x: 0, y: 0 },
      feed,
      // THE DOCUMENT IS ALWAYS THERE, empty or not — the constructor seeds one and
      // nothing ever writes it back to null, so a fixture without it models a
      // component that cannot exist. It matters at exactly one door in this file:
      // giving up the token takes the proposal off the model, and the push that
      // does it reads this. The shared default leaves it out, because a page
      // that is about none of this has no document under every test in the file.
      proposal: emptyProposal(), proposalOff: false,
      proposalError: null, proposalDraft: null,
      // Whether the hub holds a proposal for this project that SAYS something, as
      // `loadProposal` learned it and this page's own saves have kept it since.
      // `sendComment` reads it to decide whether to tell the agent there is one to
      // read, so the default here is the page that has nothing to point at.
      proposalStands: false,
      token,
      ...over,
    },
  })
  if (!watch) c.sync = vi.fn()
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
      { headers: { 'X-Hammerola-Token': 'sekrit' } })
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
    answering({ status: 403, json: async () => ({}) })
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
    // The path is a number the next build is free to hand to something else;
    // the key is what the pin follows through a rebuild.
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

  it('posts the face normal beside the point, both in the part\'s frame', async () => {
    // What the comment's arrow stands out along once the queue comes back; the
    // hub keeps it next to `point`, and `frame` says whose coordinates they are.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      composer: { part: 'plate(2)', partId: '/model/plate', key: 'plate',
                  p: [1, 2, 3], n: [0, -1, 0], text: 'too thin', photo: null },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.point).toEqual([1, 2, 3])
    expect(sent.normal).toEqual([0, -1, 0])
    expect(sent.frame).toBe('part')
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
    // What the rail shows is the record the hub actually stored, with the id
    // and the stamp the agent sees — not a row the page invented.
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

  it('carries the measurement in the TEXT', async () => {
    // The hub's comment schema is CLOSED — `validate_payload` keeps eight keys
    // and drops everything else without a word, which is the quietest failure on
    // this page: the field reaches the hub, is discarded, and the sender sees a
    // 201. So everything that has to survive the trip is spliced into `text`,
    // and tests/test_ui_source.py holds the other end of it.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      composer: {
        part: 'plate(2)', partId: '/model/plate', key: 'plate', p: null,
        text: 'must clear this', photo: null,
        meas: '2.4 mm',
      },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.text).toContain('must clear this')
    expect(sent.text).toContain('measured: 2.4 mm')
    expect(sent.meas).toBeUndefined()
  })

  it('points at the stored proposal, which it never copies into the comment', async () => {
    // THE DOCUMENT LIVES ON THE HUB, one per project, and the agent reads it
    // with `hammerola proposal` — so a comment says THAT there is one and never
    // what it says. The page already asked for it when the token arrived
    // (`loadProposal`), so this costs no second request.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      proposalStands: true,
      composer: { part: '', partId: null, key: null, p: null,
                  text: 'too thin', photo: null },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.text).toContain('a proposal stands on this project')
    expect(sent.text).toContain('hammerola proposal')
    // The projection itself is not spliced in anywhere: there is no door on the
    // page that puts it in a draft, and this is the end of the road it would
    // have travelled down.
    expect(sent.text).not.toContain('result =')
  })

  it('says nothing about it where the hub holds no proposal at all', async () => {
    // Including the page that never got an answer: `proposalStands` is false
    // until `loadProposal` or a save of this page's own says otherwise, and a
    // page that does not know must not tell the agent there is something to
    // read. It is the same false either way, which is the half `proposalHeld`
    // keeps apart: a load that has not answered may not WRITE, while what it may
    // not do here is CLAIM.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({
      proposalStands: false,
      composer: { part: '', partId: null, key: null, p: null,
                  text: 'too thin', photo: null },
    })

    await c.sendComment()

    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent.text).toBe('too thin')
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

// -- and it is filed ONCE, however many times Send was pressed ----------------
//
// The window between the press and the queue coming back is a frame grab, an
// upload of it and two requests. A reader who sees nothing happen presses Send
// again, and the hub, which has no idempotency key and deduplicates nothing
// (src/comments.py), would store one comment per press.

describe('a second press of Send', () => {
  const draft = {
    part: 'plate(2)', partId: '/model/plate', key: 'plate',
    p: [1, 2, 3], text: 'too thin', photo: null,
  }
  const posts = (fetching) => fetching.mock.calls
    .filter(([, init]) => init && init.method === 'POST')

  it('sends nothing while the first is still on the wire', async () => {
    const fetching = answering({ status: 201 }, served([]))
    const c = page({ composer: draft })

    const first = c.sendComment()
    await c.sendComment()
    await first

    expect(posts(fetching)).toHaveLength(1)
  })

  it('is not raised at all by a press that sends nothing', async () => {
    // The order is the point: the two refusals below — no text, no token —
    // return BEFORE the `try`, so their `return` never reaches the `finally`.
    // Raise the flag above them and a press on an empty draft leaves it up
    // FOREVER: the button sits on 'Sending…' for a request that was never made,
    // with the draft in a composer that can no longer send it.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({ composer: { ...draft, text: '   ' } })

    await c.sendComment()

    expect(c.state.sending).toBe(false)
    expect(posts(fetching)).toHaveLength(0)

    c.state.composer = draft
    c.state.token = null
    await c.sendComment()

    expect(c.state.sending).toBe(false)
    expect(posts(fetching)).toHaveLength(0)
  })

  it('goes through once the first has landed', async () => {
    // The refusal lasts exactly the one request: it is not a lock on the
    // composer, and a reader who wants to file a second comment can.
    //
    // FOUR ANSWERS rather than two, so the second press walks the SUCCESS path
    // as well: the queue hands the last one out for ever, so a shorter list
    // would answer the second POST with the refetch's 200 and this test would
    // be pinning `sendComment`'s error branch under a name that says otherwise.
    const fetching = answering({ status: 201 }, served([]), { status: 201 }, served([]))
    const c = page({ composer: draft })

    await c.sendComment()
    expect(c.state.sending).toBe(false)
    c.state.composer = draft
    await c.sendComment()

    expect(posts(fetching)).toHaveLength(2)
  })

  it('goes through after the hub refused the first', async () => {
    // THE EXPENSIVE HALF TO GET WRONG. A flag left up by a failure is a
    // composer whose Send never works again, with the draft still in it and no
    // way out but reloading the page — which loses the draft.
    const fetching = answering({ status: 422 })
    const c = page({ composer: draft })

    await c.sendComment()
    expect(c.state.sending).toBe(false)
    await c.sendComment()

    expect(posts(fetching)).toHaveLength(2)
  })

  it('comes back down when the hub could not be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const c = page({ composer: draft })

    await c.sendComment()

    expect(c.state.sending).toBe(false)
  })

  it('leaves the button looking spent while the comment is on the wire', () => {
    // The other half of the refusal: the button must not keep looking like a
    // button while it ignores presses (`bannerSwitchStyle` says the same).
    const idle = page({ composer: draft }).computed()
    const out = page({ composer: draft, sending: true }).computed()

    expect(idle.compSendLabel).toBe('Send')
    expect(idle.compSendStyle).toContain('cursor:pointer')
    expect(out.compSendLabel).toBe('Sending…')
    expect(out.compSendStyle).not.toContain('cursor:pointer')
  })
})

// -- the two pictures, shrunk on the way into the request ---------------------
//
// The body going up is where the fifteen seconds were, and the attachments are
// the body: a lossless PNG of the frame in DEVICE pixels, and the phone's own
// file for the photo. Each goes through `shrink` with its own ceiling, and the
// two ceilings are different on purpose — which is the part a refactor can drop
// silently, since sending the originals still works.

describe('the pictures a comment carries', () => {
  const draft = {
    part: 'plate(2)', partId: '/model/plate', key: 'plate',
    p: [1, 2, 3], text: 'too thin', photo: null,
  }
  const picture = (type) => new Blob([new Uint8Array(9)], { type })

  it('takes the photo down to the photo ceiling', async () => {
    shrink.mockClear()
    answering({ status: 201 }, served([]))
    const photo = picture('image/jpeg')
    const c = page({ composer: { ...draft, photo } })

    await c.sendComment()

    expect(shrink).toHaveBeenCalledWith(
      photo, { maxSide: PHOTO_MAX_SIDE, quality: PHOTO_QUALITY })
  })

  it('takes the frame down to the frame ceiling', async () => {
    shrink.mockClear()
    answering({ status: 201 }, served([]))
    const frame = picture('image/png')
    const c = page({ composer: draft })
    // The viewport as `frameBlob` asks it: the library's own render of the frame
    // (`el.snapshot()`), which is the picture that rides along by itself.
    c.host = { current: { snapshot: async () => frame } }

    await c.sendComment()

    expect(shrink).toHaveBeenCalledWith(
      frame, { maxSide: SHOT_MAX_SIDE, quality: SHOT_QUALITY })
  })

  it('names each part after what the blob actually turned out to be', async () => {
    // Cosmetic to the hub, which reads the magic bytes and never this name — but
    // `shot.png` on a re-encoded WebP is a request lying about itself to
    // whoever has to read one in a network panel.
    const fetching = answering({ status: 201 }, served([]))
    const c = page({ composer: { ...draft, photo: picture('image/webp') } })
    c.host = { current: { snapshot: async () => picture('image/png') } }

    await c.sendComment()

    const sent = fetching.mock.calls[0][1].body
    expect(sent.get('photo').name).toBe('photo.webp')
    expect(sent.get('shot').name).toBe('shot.png')
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
      { headers: { 'X-Hammerola-Token': 'sekrit' } })
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

  it('says a point left in another view of this build was left here', () => {
    // The point is in the part's frame, so the arrow stands on the face that was
    // clicked in this view too, and the row says what it says for any point.
    const v = page({ feed: [record({ view: 'exploded', point: [1, 2, 3], frame: 'part' })] })
      .computed()
    expect(v.threads[0].says).toBe('left here, on this build')
    expect(v.threads[0].part).toBe('plate(2)')
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
  it('uses the stored coordinate and normal on the build they were taken on', () => {
    const c = page({
      feed: [record({ point: [1, 2, 3], normal: [0, -1, 0] }),
             record({ id: 'c2', point: [4, 5, 6] })],
      watch: true,
    })
    const seen = listening()

    c.sync()

    // The second record predates the field: its arrow comes from above, which
    // the viewport reads off a null.
    expect(seen[0].pins).toEqual([
      { id: 'c1', p: [1, 2, 3], n: [0, -1, 0], active: false },
      { id: 'c2', p: [4, 5, 6], n: null, active: false },
    ])
  })

  it('asks the viewport where the part IS on any other build', () => {
    // The coordinate was measured on geometry that has been rebuilt since, so
    // the pin goes where the key is drawn today — which only the viewport can
    // answer. The normal goes with the coordinate it was taken at: the part's
    // centre has no face, so the arrow comes from above.
    const partPoint = vi.fn(() => [7, 8, 9])
    const c = page({
      feed: [record({ commit: OLDER, published: '2026-08-20T09:00:00.000Z',
                      point: [1, 2, 3], normal: [0, -1, 0] })],
      partPoint, watch: true,
    })
    const seen = listening()

    c.sync()

    expect(partPoint).toHaveBeenCalledWith('/model/plate')
    expect(seen[0].pins).toEqual([
      { id: 'c1', p: [7, 8, 9], n: null, active: false },
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

  it('keeps the draft\'s own pin beside the queue\'s, standing on its normal', () => {
    // The draft holds its point in the frame of the solid it was placed on,
    // and the viewport stands it where that solid is.
    const fromPart = vi.fn((path, p, n) => ({ p: [p[0] + 10, p[1], p[2]], n }))
    const c = page({
      feed: [record({ point: [1, 2, 3] })],
      composer: { part: 'plate(2)', partId: '/model/plate', p: [4, 5, 6],
                  n: [1, 0, 0], text: '' },
      watch: true,
    })
    c.host = { current: { fromPart } }
    const seen = listening()

    c.sync()

    expect(fromPart).toHaveBeenCalledWith('/model/plate', [4, 5, 6], [1, 0, 0])
    expect(seen[0].pins.map((pin) => pin.id)).toEqual(['c1', 'draft'])
    expect(seen[0].pins[1]).toEqual(
      { id: 'draft', p: [14, 5, 6], n: [1, 0, 0], active: true })
  })

  it('draws no pin for a processed comment', () => {
    const c = page({
      feed: [record({ id: 'c1', point: [1, 2, 3], status: 'resolved',
                      resolved: '2026-08-27T20:00:00Z' }),
             record({ id: 'c2', point: [4, 5, 6] })],
      watch: true,
    })
    const seen = listening()

    c.sync()

    expect(seen[0].pins).toEqual([
      { id: 'c2', p: [4, 5, 6], n: null, active: false },
    ])
  })
})

// -- one build, several views, and the two pages it is served under ------------
//
// The owner's report: on the latest page, an arrow left from the `dev` page and
// one left from another view both stood straight down at the part's centre. The
// build is the same in all three places (`published` says so); only the view's
// placement of the part differs, and a point in the part's own frame is a place
// on it under any placement.

describe('the pins on the same build, wherever they were left', () => {
  const S = Math.SQRT1_2
  // The glass view lays the part flat — a quarter turn about -x, (x, y, z) to
  // (x, z, -y), then a shift. The assembled view stands it elsewhere — a
  // quarter turn about z, (x, y, z) to (-y, x, z), then another shift.
  const GLASS = { position: [-672.5, -603.5, 495], quaternion: [-S, 0, 0, S] }
  const ASSEMBLED = { position: [100, 20, 0], quaternion: [0, 0, S, S] }
  // One spot of the part, on its +x face, as each view shows it: the point and
  // the face normal there. In the part's own frame it is [2, 4, 0.5] facing +x.
  const IN_GLASS = [2 - 672.5, 0.5 - 603.5, -4 + 495]
  const IN_GLASS_N = [1, 0, 0]
  const IN_ASSEMBLED = [-4 + 100, 2 + 20, 0.5]
  const IN_ASSEMBLED_N = [0, 1, 0]
  const VIEWS = [
    { id: 'assembled', name: 'assembled', file: 'a.json', parts: ['plate'], gzip: 1000 },
    { id: 'glass', name: 'glass', file: 'g.json', parts: ['plate'], gzip: 1000 },
  ]

  /** The page on `view`, mounted with its real handlers, over a real viewport
   *  drawing the part; `place` stands the part as a view does. */
  function opened(view) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const c = page({
      watch: true, view,
      meta: {
        project: 'fixture', title: 'Fixture', commit: REV, published: STAMP,
        built: '2026-08-27T18:00:00Z', parts: PARTS, views: VIEWS,
      },
    })
    const group = new THREE.Group()
    group.front = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    group.add(group.front)
    const el = Object.create(HmrViewport.prototype)
    el.viewer = fakeViewer({ groups: { '/model/plate': group } })
    el.three = THREE
    c.host = { current: el }
    c.load = vi.fn(async () => {})
    c.loadFeed = vi.fn()
    c.loadProposal = vi.fn()
    c.componentDidMount()
    onTestFinished(() => {
      c.componentWillUnmount()
      warn.mockRestore()
    })
    const place = ({ position, quaternion }) => {
      group.position.set(...position)
      group.quaternion.set(...quaternion)
      group.updateMatrixWorld()
    }
    return { c, place, group }
  }

  const near = (actual, expected) => {
    expect(actual).toHaveLength(3)
    expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 9))
  }

  it('stands a comment left in one view on the same spot of the part in another', async () => {
    // Left in the glass view: a click on that spot as the glass view shows it.
    const { c, place } = opened('glass')
    place(GLASS)
    const seen = listening()
    window.dispatchEvent(new CustomEvent(PLACE, { detail: {
      id: '/model/plate', name: 'plate(2)', p: IN_GLASS, n: IN_GLASS_N } }))
    // The draft stands where the click was.
    const [draft] = seen[seen.length - 1].pins
    expect(draft.id).toBe('draft')
    near(draft.p, IN_GLASS)
    near(draft.n, IN_GLASS_N)

    c.state.composer = { ...c.state.composer, text: 'too thin' }
    const fetching = answering({ status: 201 }, served([]))
    await c.sendComment()
    const sent = JSON.parse(fetching.mock.calls[0][1].body.get('comment'))
    expect(sent).toMatchObject({ view: 'glass', part: '/model/plate', frame: 'part' })

    // Read in the assembled view, which stands the part elsewhere, as the hub
    // stored it.
    place(ASSEMBLED)
    c.set({ view: 'assembled', feed: [record({ ...sent, id: 'c1' })] })

    const [pin] = seen[seen.length - 1].pins
    expect(pin.id).toBe('c1')
    near(pin.p, IN_ASSEMBLED)
    near(pin.n, IN_ASSEMBLED_N)
    // Out of the instance on screen, with no other view's file asked for.
    expect(fetching).toHaveBeenCalledTimes(1)
  })

  it('stands it on top of the part in a comparison, whose first copy may be another revision', () => {
    const { c, place, group } = opened('assembled')
    // A body to stand on: the arrow goes to the top of the part's box.
    group.front.geometry = new THREE.BoxGeometry(4, 8, 1)
    place(ASSEMBLED)
    const seen = listening()
    c.set({
      compare: true, cmpStage: 'ready', cmpView: 'assembled', cmpPair: [REV, 'c'.repeat(64)],
      feed: [record({ view: 'glass', frame: 'part', point: [2, 4, 0.5], normal: [1, 0, 0] })],
    })
    const [pin] = seen[seen.length - 1].pins
    expect(pin).toMatchObject({ id: 'c1', n: null })
    near(pin.p, c.el().partPoint('/model/plate'))
  })
})

describe('the composer keyboard', () => {
  const draft = {
    part: 'plate(2)', partId: '/model/plate', key: 'plate',
    p: [1, 2, 3], text: 'too thin', photo: null,
  }
  const posts = (fetching) => fetching.mock.calls
    .filter(([, init]) => init && init.method === 'POST')
  const key = (over) => ({ key: 'Enter', shiftKey: false, preventDefault: vi.fn(), ...over })
  // The textarea as the page DREW it, found by the ref the focus goes through:
  // a handler or a ref left off the markup fails here, not only in a browser.
  const box = (c) => collect(c.render(),
    (el) => (el.type === 'textarea' && el.ref === c.compBox ? el : undefined))[0]
  it('sends on Enter, and on no other key', async () => {
    const fetching = answering({ status: 201 }, served([]))
    const c = page({ composer: draft })
    const letter = key({ key: 'a' })
    const enter = key()

    box(c).props.onKeyDown(letter)
    await settled()
    expect(letter.preventDefault).not.toHaveBeenCalled()
    expect(posts(fetching)).toHaveLength(0)

    box(c).props.onKeyDown(enter)
    await settled()
    expect(enter.preventDefault).toHaveBeenCalled()
    expect(posts(fetching)).toHaveLength(1)
  })

  it('leaves Shift+Enter to the textarea as a newline', async () => {
    const fetching = answering({ status: 201 }, served([]))
    const c = page({ composer: draft })
    const e = key({ shiftKey: true })

    box(c).props.onKeyDown(e)
    await settled()

    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(posts(fetching)).toHaveLength(0)
  })

  it('takes focus when a measurement opens it', () => {
    // The point placed on the model is the other door, in repeats.test.js.
    const c = page({ measure: { text: '12.0 mm', note: '', full: '12.0 mm' } })
    expect(box(c)).toBeDefined()
    const focus = vi.fn()
    c.compBox.current = { focus }

    c.computed().measAdd()

    expect(c.state.composer.meas).toBe('12.0 mm')
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
