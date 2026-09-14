// The front page — the three things in it that are decisions rather than layout:
// what a card of /index.json becomes, what order the list is in, and what
// happens to a token between being typed and being stored.
//
// NOTHING IS RENDERED HERE, the same arrangement interface.test.js uses and for
// the same reason: what is under test is a mapping, a comparator and a short
// state machine, and putting a React tree under them would test none of the
// three better. The layout is checked from Python, against the source
// (tests/test_ui_source.py), and this file is not a foothold for creeping into
// it.
//
// THE TOKEN PATH IS THE PART WORTH THE FILE, and it is one path rather than two:
// `open()` is what both a stored token and a freshly typed one go through, so
// what these tests pin is that its three answers stay distinguishable. A list
// means signed in and stored; a 401 means refused, cleared and shown the door; a
// hub that did not answer means neither — the token stays, because "we could not
// ask" is not "the answer was no", and retyping a perfectly good token because a
// proxy hiccuped is the wrong thing to make somebody do.
//
// WHAT IS NOT TESTED HERE is that the list is private. It is not this
// component's to enforce and could not be: /index.json answers 401 on its own
// (tests/test_serving.py). What this side owns is only that a refusal is legible.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the call that talks to the hub. `projectCard`, `projectUrl`, `shortId`
// and `Unauthorized` are left real — this file checks the mapping itself and
// the branch that keys on that class, and a stubbed one would let it agree with
// itself instead of with the code.
//
// `loadStart` is stubbed beside it and answers `null` by default — a hub that
// could NOT be asked, which since issue #91 is the only thing `null` means. A hub
// with projects on it answers `{ ...paths, empty: false }`, and a test that wants
// that one says so: `FULL` below. What the real one does with what a hub actually
// sends is `start.test.js`, in a file of its own for the reason given there: this
// one needs the module mocked, that one needs it real.
vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadIndex: vi.fn(),
  loadStart: vi.fn(async () => null),
}))
// The storage functions are stubbed and the VOCABULARY is not: `PROJECT_VIEWS`
// and `PROJECT_SORTS` are what the component builds its tabs out of, so a copy
// of them here would let this file agree with itself about which tabs exist.
vi.mock('../src/store.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readToken: vi.fn(() => null),
  writeToken: vi.fn(),
  clearToken: vi.fn(),
  readProjectView: vi.fn(() => null),
  readProjectSort: vi.fn(() => null),
  writeProjectView: vi.fn(),
  writeProjectSort: vi.fn(),
}))

import HammerolaEntry, {
  agentBrief, HammerolaLogin, HammerolaProjects, relTime, REMOVE_TITLE, RevLine,
  VIEW_BODIES,
} from '../src/HammerolaEntry.jsx'
import { loadIndex, loadStart, projectCard, projectUrl, Unauthorized } from '../src/hub.js'
import {
  clearToken, readProjectSort, readProjectView, readToken, writeProjectSort,
  writeProjectView, writeToken,
} from '../src/store.js'
import { collect, texts, titles } from './eltree.js'

/**
 * One card exactly as /index.json answers it.
 *
 * `render.index_card` writes every field here but one: `status` is a live fact
 * about the project's draft, so the file declares it as null and the route
 * fills it in per request (`_serve_index_json` in src/app.py, issue #32).
 */
const CARD = {
  pid: '0a1b2c3d4e5f',
  project: 'vent_ctrl_case',
  title: 'Ventilation controller case',
  commit: 'c0ffee1234567890abcdef',
  built: '2026-08-26T18:20:00Z',
  first_built: '2026-01-22T09:00:00Z',
  dev: false,
  status: 'idle',
  // BOTH OF THESE WERE RENAMED, AND THE COUNT UNDER THE FIRST ONE CHANGED WITH
  // IT (issue #75). `parts` used to be the part count of the biggest view;
  // `printables` is how many records in the build's catalogue are actually
  // printed, so the bought screws and the scenery are out of it. The card would
  // have gone on rendering a number under the old name, which is exactly why
  // the hub stopped writing that name — a reader breaks loudly here instead of
  // quietly showing the wrong total.
  printables: 14,
  views: 3,
  mb: '1.2',
  // The name of a file this build published, not a URL: the hub writes what the
  // first view of the build declared, and turning it into an address is the
  // browser's half (`buildFileUrl`). `null` here is a build with no picture,
  // which is what an image with no rendering stack produces.
  preview: 'assembled_preview.png',
}

afterEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` forgets the CALLS and keeps the implementations, so a test
  // that made the hub answer with a block would go on answering that way for
  // every test after it. Put back the default the factory gave it.
  loadStart.mockImplementation(async () => null)
  vi.unstubAllGlobals()
})

// -- the card ----------------------------------------------------------------

describe('a card of /index.json', () => {
  it('becomes the row the list renders', () => {
    expect(projectCard(CARD)).toEqual({
      pid: '0a1b2c3d4e5f',
      title: 'Ventilation controller case',
      slug: 'vent_ctrl_case',
      meta: '14 printables · 3 views · 1.2 MB',
      rev: 'c0ffee1',
      dev: false,
      status: 'idle',
      built: '2026-08-26T18:20:00Z',
      first: '2026-01-22T09:00:00Z',
      preview: '/project/0a1b2c3d4e5f/c0ffee1234567890abcdef/assembled_preview.png',
    })
  })

  it('falls back through the names a project can be known by', () => {
    // `title` comes out of the pushed project.json and a rename can clear it.
    // An empty heading is a card nobody can tell from another; the id is ugly
    // and always there, which is the right last resort.
    expect(projectCard({ ...CARD, title: '' }).title).toBe('vent_ctrl_case')
    expect(projectCard({ ...CARD, title: '', project: '' }).title).toBe('0a1b2c3d4e5f')
  })

  it('shows the revision at the length the rest of the site reads it', () => {
    // There is no revision NUMBER to show beside it: a revision is named by the
    // digest of its sources, so the hash is the whole identifier.
    expect(projectCard(CARD).rev).toHaveLength(7)
  })

  it('carries the dev flag through as a boolean', () => {
    expect(projectCard({ ...CARD, dev: true }).dev).toBe(true)
    // A card written before the field existed must read as "no slot" rather than
    // as `undefined`, which React renders as nothing and reads as a chip that
    // never appears.
    expect(projectCard({ ...CARD, dev: undefined }).dev).toBe(false)
  })

  it('carries the draft status through as the hub worded it', () => {
    // NOT normalised, and not defaulted: the hub answers one of three words and
    // the mapping onto a chip lives in one place (`STATUS_CHIPS`). A card that
    // arrived without the field reads as `undefined`, which that table has no
    // entry for — i.e. no chip, which is also what `idle` draws.
    expect(projectCard({ ...CARD, status: 'building' }).status).toBe('building')
    expect(projectCard({ ...CARD, status: 'failed' }).status).toBe('failed')
    expect(projectCard({ ...CARD, status: undefined }).status).toBeUndefined()
  })
})

// -- the chip the status becomes ---------------------------------------------
//
// The word is drawn or it is not, which is a decision rather than layout: a pill
// on every card is a pill nobody reads, so `idle` gets none.
//
// `RevLine` is called DIRECTLY, the same move `drawnDoor` makes further down and
// for the same reason: a component element is where `texts()` stops — it walks
// `props.children`, and `<RevLine p={p} />` has none — so a reading taken off a
// view body's tree would pass whether or not either chip was ever drawn.

describe('what a card says about its draft', () => {
  const drawn = (card) => texts(RevLine({ p: projectCard({ ...CARD, ...card }) }))

  it('is a chip while the draft is building, and one when it failed', () => {
    expect(drawn({ status: 'building' })).toContain('building')
    expect(drawn({ status: 'failed' })).toContain('failed')
  })

  it('is nothing at all otherwise', () => {
    // `idle` is the answer for a project whose draft is not building, for one
    // nobody has ever pushed a draft to, and for a pointer at a job the hub no
    // longer has — three facts the front page has no reason to distinguish.
    expect(drawn({ status: 'idle' })).not.toContain('idle')
    // And a hub that answers no status at all — an older one, or a card the
    // route could not fill in — draws no chip rather than `undefined`.
    expect(drawn({ status: undefined })).not.toContain('undefined')
    // Only the revision is left in both cases, so the assertions above are not
    // passing on a line that drew nothing at all.
    expect(drawn({ status: 'idle' })).toEqual(['c0ffee1'])
  })

  it('leaves the dev chip alone', () => {
    // The two say different things and both can be true at once: uncommitted
    // work in the slot, and a build of it running right now.
    expect(drawn({ dev: true, status: 'building' }))
      .toEqual(['c0ffee1', 'dev', 'building'])
  })
})

// -- the picture on a card ---------------------------------------------------
//
// The plate is a component element, which is where `collect` stops — it walks
// `props.children`, and `<Preview src={…} />` has none — so what the plate drew
// is reached by CALLING what the body left in the tree, the same move `RevLine`
// above needs. The BODIES are rendered rather than the component on its own,
// because half of what is under test is the two call sites handing it
// `p.preview`: called directly, both would pass with neither of them wired up.

describe('the picture on a card', () => {
  /** The three things a view body asks of the page, none of them under test. */
  const PAGE = { hover: () => ({}), cardStyle: () => '', remover: () => null }

  const imgs = (card) => {
    const rows = [projectCard({ ...CARD, ...card })]
    const drawn = Object.values(VIEW_BODIES).map((body) => body(PAGE, rows))
    const plates = collect(drawn, (el) => (
      typeof el.type === 'function' ? el.type(el.props) : undefined))
    return collect(plates, (el) => (el.type === 'img' ? el : undefined))
  }

  it('is the file that build published, under that build', () => {
    // One per view body, and the same address from both: the picture belongs to
    // the commit the card names, not to whatever `latest` points at by the time
    // somebody looks.
    const drawn = imgs({}).map((el) => el.props.src)
    expect(drawn).toEqual([
      '/project/0a1b2c3d4e5f/c0ffee1234567890abcdef/assembled_preview.png',
      '/project/0a1b2c3d4e5f/c0ffee1234567890abcdef/assembled_preview.png',
    ])
  })

  it('is nothing at all for a build that has none', () => {
    // Not an empty `src` and not a hidden element: no img is drawn, so the plate
    // underneath is the whole of what the card shows.
    expect(imgs({ preview: null })).toEqual([])
  })
})

describe('where a card points', () => {
  it('is the project, not one of its pointers', () => {
    // The URL naming no pointer opens whichever of `latest` and `dev` the reader
    // was last on (SPEC 9). Linking at `latest` here would overwrite that memory
    // on every visit to the front page.
    expect(projectUrl('0a1b2c3d4e5f')).toBe('/project/0a1b2c3d4e5f/')
    expect(projectUrl('a/b')).toBe('/project/a%2Fb/')
  })
})

// -- the order ---------------------------------------------------------------

describe('the order of the list', () => {
  const rows = [
    { pid: 'b', title: 'Bracket', built: '2026-08-01T00:00:00Z', first: '2026-07-01T00:00:00Z' },
    { pid: 'a', title: 'Adapter', built: '2026-08-03T00:00:00Z', first: '2025-01-01T00:00:00Z' },
    { pid: 'c', title: 'Clamp', built: '2026-08-02T00:00:00Z', first: '2026-02-01T00:00:00Z' },
  ]

  const order = (sort) => {
    const c = Object.create(HammerolaProjects.prototype)
    c.props = { ...HammerolaProjects.defaultProps, projects: rows }
    c.state = { view: null, sort, hover: null }
    return c.sorted().map((p) => p.pid)
  }

  it('is newest-built first by default', () => {
    expect(order(null)).toEqual(['a', 'c', 'b'])
  })

  it('sorts by title', () => {
    expect(order('name')).toEqual(['a', 'b', 'c'])
  })

  it('sorts by first build, newest first, which is a different answer', () => {
    // The whole reason this tab exists rather than reusing "last built", and
    // `a` is the case that shows it: the most recently built project of the
    // three is also the longest-standing, so it leads one order and ends the
    // other. Both tabs run newest-first, like the mock's.
    expect(order('first')).toEqual(['b', 'c', 'a'])
    expect(order('modified')).toEqual(['a', 'c', 'b'])
  })

  it('does not reorder the array it was handed', () => {
    // `props.projects` is the parent's state. Sorting it in place would leave
    // the list in whatever order the last tab chose, and the next render would
    // start from there.
    const c = Object.create(HammerolaProjects.prototype)
    c.props = { ...HammerolaProjects.defaultProps, projects: rows }
    c.state = { view: null, sort: 'name', hover: null }
    c.sorted()
    expect(rows.map((p) => p.pid)).toEqual(['b', 'a', 'c'])
  })
})

// -- the arrangement, between visits -----------------------------------------
// Which way the list is drawn and what order it is in used to be state and
// nothing else, so both were re-chosen on every page load: a reader who works
// from the dense list by name got tiles by last-built again on the next visit.
// What is pinned here is the two ends of the memory — that a stored answer is
// what the page comes up with, and that choosing one records it.
//
// THE CASE THE STORAGE MAKES UNAVOIDABLE — a cell holding a value the page
// cannot use — is NOT here, and could not honestly be: store.js is stubbed in
// this file, so a bad value planted through the stub would be testing the
// component against something the real module cannot produce. It lives in
// `arrangement.test.js`, which drives the real store, in a file of its own
// because that is the cheap way to get the isolation: vitest resets the module
// registry between FILES, and undoing a `vi.mock` inside one is a two-part
// restore where forgetting the second part silently hands the next dynamic
// import the wrong module.

describe('the arrangement of the list', () => {
  /** The component as React builds it: defaultProps applied, constructor run. */
  const built = () => {
    const c = new HammerolaProjects({ ...HammerolaProjects.defaultProps })
    c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
    return c
  }

  it('opens on what this browser remembered', () => {
    readProjectView.mockReturnValueOnce('list')
    readProjectSort.mockReturnValueOnce('name')
    const c = built()
    expect(c.view).toBe('list')
    expect(c.sort).toBe('name')
  })

  it('opens on its own default when nothing was remembered', () => {
    // `null` is what store.js answers both for an empty cell and for a value it
    // cannot use, so this is also the second half of the bad-value case below.
    const c = built()
    expect(c.view).toBe('grid')
    expect(c.sort).toBe('modified')
  })

  it('records a choice as it makes it', () => {
    const c = built()
    c.choose({ sort: 'name' })
    c.choose({ view: 'list' })
    expect(writeProjectSort).toHaveBeenCalledWith('name')
    expect(writeProjectView).toHaveBeenCalledWith('list')
    expect(c.sort).toBe('name')
    expect(c.view).toBe('list')
  })

  it('records only what was chosen', () => {
    // Both halves travel through one method, and a click sets one of them. The
    // other must not be rewritten with the value it already had — a write per
    // click on an unrelated tab is a cell changing for no reason anybody could
    // trace.
    //
    // BOTH DIRECTIONS, because the sentence above is about the PAIR and only one
    // of them was asked: a `choose` that wrote the sort on every view click
    // passed this test unchanged, while the name claimed otherwise.
    built().choose({ sort: 'first' })
    expect(writeProjectSort).toHaveBeenCalledWith('first')
    expect(writeProjectView).not.toHaveBeenCalled()

    vi.clearAllMocks()

    built().choose({ view: 'list' })
    expect(writeProjectView).toHaveBeenCalledWith('list')
    expect(writeProjectSort).not.toHaveBeenCalled()
  })

  it('asks storage once, at construction, rather than on every render', () => {
    // AND IT RENDERS, which is the half the name promises and the body used to
    // leave out: with only the constructor run, a getter that read storage on
    // every access passed this test unchanged. Two renders rather than one,
    // because "once per render" and "once ever" are the same count at one.
    const c = built()
    c.props = { ...c.props, projects: [] }
    c.render()
    c.render()
    expect(readProjectView).toHaveBeenCalledTimes(1)
    expect(readProjectSort).toHaveBeenCalledTimes(1)
  })

  it('lights the card the pointer is over, in either view', () => {
    // `cardStyle` is the one thing the two view bodies share, and it became a
    // method when they became a table — so what used to be a closure over
    // `this.state` inside `render()` now has to read the same state from
    // outside it. Both bodies call it, so a break here is a break in both.
    const c = built()
    const resting = c.cardStyle('a')
    c.state = { ...c.state, hover: 'a' }
    expect(c.cardStyle('a')).not.toBe(resting)
    expect(c.cardStyle('a')).toContain('box-shadow')
    expect(c.cardStyle('b')).toBe(resting)
  })
})

// -- relative time -----------------------------------------------------------

describe('relTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the near past in the units a person would use', () => {
    expect(relTime('2026-08-27T11:59:40Z')).toBe('just now')
    expect(relTime('2026-08-27T11:42:00Z')).toBe('18 min ago')
    expect(relTime('2026-08-27T07:00:00Z')).toBe('5 h ago')
    expect(relTime('2026-08-26T11:00:00Z')).toBe('yesterday')
    expect(relTime('2026-08-24T12:00:00Z')).toBe('3 days ago')
  })

  it('gives a date once "ago" stops meaning anything', () => {
    expect(relTime('2026-08-12T09:00:00Z')).toBe('Aug 12')
  })

  it('says so rather than computing on a value it could not read', () => {
    // `built` is written by the model's own script and is not validated beyond
    // being a string, so an unparseable one reaches this page. `NaN min ago` is
    // the failure worth avoiding.
    expect(relTime('')).toBe('—')
    expect(relTime(undefined)).toBe('—')
    expect(relTime('whenever')).toBe('—')
  })
})

// -- the token ---------------------------------------------------------------

/** The page as `open`, `submit` and `signOut` see it. */
function page(token = null) {
  const c = Object.create(HammerolaEntry.prototype)
  c.state = { projects: null, token, busy: false, refused: '', start: null }
  c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
  c.open = HammerolaEntry.prototype.open
  c.askStart = HammerolaEntry.prototype.askStart
  return c
}

describe('signing in', () => {
  it('stores the token only once the hub has answered with a list', async () => {
    loadIndex.mockResolvedValue([CARD])
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, 'sekrit')
    expect(loadIndex).toHaveBeenCalledWith('sekrit')
    expect(writeToken).toHaveBeenCalledWith('sekrit')
    expect(c.state.token).toBe('sekrit')
    expect(c.state.projects).toHaveLength(1)
    expect(c.state.busy).toBe(false)
    expect(c.state.refused).toBe('')
  })

  it('stores NOTHING when the hub refuses it', async () => {
    // The one that matters. A token stored on a refusal would be retried on
    // every later page load, each time landing back on the sign-in screen, and
    // nothing would say the stored value is the problem.
    loadIndex.mockRejectedValue(new Unauthorized('401'))
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, 'wrong')
    expect(writeToken).not.toHaveBeenCalled()
    expect(c.state.token).toBeNull()
    expect(c.state.projects).toBeNull()
    expect(c.state.busy).toBe(false)
    expect(c.state.refused).toMatch(/refused/i)
  })

  it('keeps the reader on the door when the hub could not be reached', async () => {
    // Distinct from a refusal, and the distinction is the reason `Unauthorized`
    // is a class rather than a status number compared at the call site: this
    // path must not clear anything.
    loadIndex.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, 'sekrit')
    expect(writeToken).not.toHaveBeenCalled()
    expect(clearToken).not.toHaveBeenCalled()
    expect(c.state.projects).toBeNull()
    expect(c.state.busy).toBe(false)
    expect(c.state.refused).toMatch(/reach/i)
  })

  it('does not ask the hub about an empty field', async () => {
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, '   ')
    expect(loadIndex).not.toHaveBeenCalled()
    expect(c.state.refused).toBeTruthy()
  })

  it('trims before it asks, so the hub is asked about what will be stored', async () => {
    // A pasted selection often carries a newline. Asking about one string and
    // storing another would mean a token that verified and then failed.
    loadIndex.mockResolvedValue([])
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, '  sekrit\n')
    expect(loadIndex).toHaveBeenCalledWith('sekrit')
    expect(writeToken).toHaveBeenCalledWith('sekrit')
  })

  it('says it is working while it waits', async () => {
    let release
    loadIndex.mockReturnValue(new Promise((r) => { release = () => r([]) }))
    const c = page()
    const done = HammerolaEntry.prototype.submit.call(c, 'sekrit')
    expect(c.state.busy).toBe(true)
    release()
    await done
    expect(c.state.busy).toBe(false)
  })
})

describe('arriving with a token already stored', () => {
  it('goes straight to the list without asking again', async () => {
    loadIndex.mockResolvedValue([CARD])
    const c = page('remembered')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.projects).not.toBeNull())
    expect(loadIndex).toHaveBeenCalledWith('remembered')
  })

  it('asks for no list when there is no token, and asks /start instead', () => {
    // BOTH HALVES ARE ASSERTED, and the second one used to be a sentence. It
    // does ask the hub ONE thing on this path — whether anything is published
    // here, which is what the door's block is drawn from. That is the public
    // route and it carries no token; the guarded one is not touched.
    const c = page(null)
    HammerolaEntry.prototype.componentDidMount.call(c)
    expect(loadIndex).not.toHaveBeenCalled()
    expect(loadStart).toHaveBeenCalledTimes(1)
  })

  it('forgets a stored token the hub no longer accepts', async () => {
    // Rotated on the hub, or this browser has been shut for a month. It has to
    // land exactly where a mistyped one does, and the stale value has to go —
    // otherwise every visit from here on starts by being refused.
    loadIndex.mockRejectedValue(new Unauthorized('401'))
    const c = page('stale')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.refused).toBeTruthy())
    expect(clearToken).toHaveBeenCalled()
    expect(c.state.token).toBeNull()
  })

  it('reads the token at construction, so a fresh tab uses what was stored', () => {
    readToken.mockReturnValueOnce('remembered')
    const c = new HammerolaEntry({})
    expect(c.state.token).toBe('remembered')
    expect(c.state.projects).toBeNull()
  })
})

describe('signing out', () => {
  it('takes the token out of storage and the list off the screen', () => {
    // Both halves, because the list is the thing the token bought: clearing the
    // key while leaving the cards rendered would show a signed-out page full of
    // what only a signed-in one may see.
    const c = page('sekrit')
    c.state = { ...c.state, projects: [projectCard(CARD)] }
    HammerolaEntry.prototype.signOut.call(c)
    expect(clearToken).toHaveBeenCalled()
    expect(c.state.token).toBeNull()
    expect(c.state.projects).toBeNull()
  })
})

// -- which screen ------------------------------------------------------------

describe('which screen is drawn', () => {
  const screenOf = (state) => {
    const c = Object.create(HammerolaEntry.prototype)
    c.state = { projects: null, token: null, busy: false, refused: '', ...state }
    return HammerolaEntry.prototype.render.call(c).type
  }

  it('is the door until there is a list', () => {
    // Including "a token is stored but the fetch has not come back": there is
    // nothing to draw a list from yet, and the alternative is a flash of an
    // empty list that then fills in.
    expect(screenOf({}).name).toBe('HammerolaLogin')
    expect(screenOf({ token: 'sekrit', busy: true }).name).toBe('HammerolaLogin')
    expect(screenOf({ refused: 'no' }).name).toBe('HammerolaLogin')
  })

  it('is the list once the hub answered — including with nothing', () => {
    // `[]` is a real answer: this hub has no projects yet. It must not fall back
    // to the sign-in screen, which would read as "your token stopped working".
    expect(screenOf({ token: 'sekrit', projects: [] }).name).toBe('HammerolaProjects')
    expect(screenOf({ token: 'sekrit', projects: [projectCard(CARD)] }).name)
      .toBe('HammerolaProjects')
  })
})

// -- the block for an agent, on the door ------------------------------------
//
// Five lines somebody copies and hands to their agent: where the skill is, where
// the client is, what this hub's address is, install the skill and follow it,
// ask the owner for the token (issue #48). What is pinned here is the
// properties that are decisions rather than layout — it appears at every arrival
// at the door AND ONLY ON A HUB WITH NOTHING PUBLISHED, every address in it is
// BUILT from the browser's origin and the manifest's paths, it carries no token,
// and it never claims to have copied itself when it has not.
//
// THE CONDITION IS THIS SCREEN'S OWN NOW (issue #91). `startHint` used to answer
// `null` for a hub with projects, so nothing here could draw a block on one even
// by mistake; it answers `empty: false` instead, because the list draws the
// block on such a hub. So the assertion that the DOOR does not is the only thing
// holding that line, and it is the second test below.
//
// WHAT IS NOT HERE is what the manifest has to say for the paths to exist at
// all: that lives in start.test.js, where hub.js is the real module.

const HINT = { skill: '/start/skill.md', client: '/start/hammerola', empty: true }
/** A hub reached at an address nothing in this repository could have written. */
const AT = { origin: 'https://hub.example', ...HINT }
/** The same hub, once something has been published on it. */
const FULL = { ...AT, empty: false }

/** A HammerolaLogin as React builds one: defaultProps applied, state seeded. */
function login(props) {
  const c = new HammerolaLogin({ ...HammerolaLogin.defaultProps, ...props })
  c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
  return c
}

/** The sign-in screen exactly as the page hands it over, as an element tree. */
function drawnDoor(entryState) {
  const c = Object.create(HammerolaEntry.prototype)
  c.state = {
    projects: null, token: null, busy: false, refused: '', start: null, ...entryState,
  }
  const screen = HammerolaEntry.prototype.render.call(c)
  expect(screen.type).toBe(HammerolaLogin)
  return HammerolaLogin.prototype.render.call(login(screen.props))
}

const fields = (tree) => collect(tree, (el) => (el.type === 'input' ? el : undefined))

describe('the block for an agent', () => {
  it('is on the door, line for line, when the hub says it has nothing', () => {
    const drawn = texts(drawnDoor({ start: AT }))
    for (const line of agentBrief(AT)) expect(drawn).toContain(line)
  })

  it('is not on the door when the hub has something on it', () => {
    // THE ASSERTION THE GATE BECAME. The paths reach this screen on a hub with
    // forty projects exactly as they do on an empty one — the list needs them
    // there — so `empty` is the whole of what keeps the block off the door, and
    // a heading reading "Nothing published here yet" over a hub full of work is
    // what it costs to lose it.
    const drawn = texts(drawnDoor({ start: FULL }))
    for (const line of agentBrief(FULL)) expect(drawn).not.toContain(line)
    expect(drawn).not.toContain('Nothing published here yet')
    expect(drawn).toContain('Sign in')
    expect(fields(drawnDoor({ start: FULL }))).toHaveLength(1)
  })

  it('is not on the door when the hub was never asked', () => {
    // The other `null`: a hub that did not answer, or answered something this
    // page could not read (hub.js). There is nothing to draw a block out of,
    // and the form has to be the form all the same.
    const drawn = texts(drawnDoor({ start: null }))
    for (const line of agentBrief(AT)) expect(drawn).not.toContain(line)
    expect(drawn).not.toContain('Nothing published here yet')
    expect(drawn).toContain('Sign in')
    expect(fields(drawnDoor({ start: null }))).toHaveLength(1)
  })

  it('builds every address out of the origin and the manifest paths', () => {
    // THE POINT OF THE WHOLE FILE-FULL: nothing in the bundle names a host, and
    // nothing names the paths either — the origin is the browser's and the paths
    // are the hub's own answer. Fed an address and paths no deployment uses,
    // the block has to print exactly those.
    const odd = {
      origin: 'https://elsewhere.example:8443',
      skill: '/get/s.md',
      client: '/get/tool',
      empty: true,
    }
    const drawn = texts(drawnDoor({ start: odd }))
    expect(drawn).toContain('Skill: https://elsewhere.example:8443/get/s.md')
    expect(drawn).toContain('Client: https://elsewhere.example:8443/get/tool')
    expect(drawn).toContain('Hub: https://elsewhere.example:8443')
  })

  it('calls the client what the rest of this repository calls it', () => {
    // `hammerola/`, "the client" in AGENTS.md and the SPEC, `hammerola` on a
    // PATH. A third name for it here — `Helper:`, which is what this said first
    // — leaves whoever reads the block and then the skill working out that the
    // two are one file.
    expect(agentBrief(AT)).toContain(`Client: ${AT.origin}${AT.client}`)
    expect(agentBrief(AT).join('\n')).not.toMatch(/helper/i)
  })

  it('joins the browser\'s own origin to what the hub answered', async () => {
    // The other half of the same rule, at the place the two meet: the origin is
    // read off the page rather than stored anywhere, so this compares against
    // what the environment says and not against a string.
    loadStart.mockImplementation(async () => HINT)
    const c = page()
    await c.askStart()
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('carries no token and grows no field for one', () => {
    // The secret goes from a person to a person; the block only says so. A
    // field here would be a credential in whatever the reader pasted this into.
    const copied = agentBrief(AT).join('\n')
    expect(copied).toMatch(/ask the owner of this instance for the token/i)
    expect(copied).not.toMatch(/EDIT_TOKEN/)
    // One field on the whole screen, and it is the sign-in one.
    expect(fields(drawnDoor({ start: AT }))).toHaveLength(1)
  })

  it('says nothing this page cannot say', () => {
    // Five lines, no explanation of what any of it is: the skill is the first
    // address in it, and everything about hammerola is written there. A block
    // that grew a second account of it would be a copy going stale on a page
    // whose reader has not read the first one yet.
    expect(agentBrief(AT)).toHaveLength(5)
  })

  it('is handed no token to print, whatever the page is holding', () => {
    // THE RULE THAT USED TO BE A RULE ABOUT THE WHOLE FILE, now a rule about
    // this screen (issue #91): the lines CAN carry a token, and the door is
    // where they must not — its reader has not got in, so there is nothing of
    // theirs to print and a token on that screen could only be somebody else's.
    //
    // DRIVEN FROM THE PAGE, not from the screen, because what keeps the door's
    // copy tokenless is not a check inside it: it is that `render` hands the
    // token to the list and to nothing else. Asserted on the props as well as
    // on the text, so that passing it down "harmlessly" fails here rather than
    // the first time something prints it.
    const c = Object.create(HammerolaEntry.prototype)
    c.state = { projects: null, token: 'sekrit', busy: false, refused: '', start: AT }
    const screen = HammerolaEntry.prototype.render.call(c)
    expect(screen.type).toBe(HammerolaLogin)
    expect(Object.values(screen.props)).not.toContain('sekrit')
    const drawn = texts(HammerolaLogin.prototype.render.call(login(screen.props)))
    expect(drawn.join('\n')).not.toContain('sekrit')
    expect(drawn).toContain('Ask the owner of this instance for the token.')
  })
})

// -- the fifth line, which is the only one the two blocks differ in ----------

describe('the fifth line of the brief', () => {
  it('is the token, where a token was passed', () => {
    // The four above it are the same four either way: what the list's copy is
    // is the door's copy with the last line answered instead of deferred.
    expect(agentBrief({ ...AT, token: 'sekrit' }))
      .toEqual([...agentBrief(AT).slice(0, 4), 'Token: sekrit'])
  })

  it('is the sentence, where none was', () => {
    // Three ways of passing nothing, because the caller that has no token
    // passes no key at all and the page's own default is an empty string. An
    // empty `Token:` line would read as a hub with no secret on it.
    for (const token of [undefined, null, '']) {
      expect(agentBrief({ ...AT, token })).toEqual(agentBrief(AT))
      expect(agentBrief({ ...AT, token }).join('\n')).not.toMatch(/^Token:/m)
    }
  })

  it('puts it in that line and in no other', () => {
    // The token is one line's worth of the block. An address that carried it as
    // well would be a secret in a string somebody pastes into a browser bar,
    // and it would still be there after the fifth line was cut.
    const lines = agentBrief({ ...AT, token: 'sekrit' })
    expect(lines.filter((line) => line.includes('sekrit'))).toEqual(['Token: sekrit'])
    expect(agentBrief(AT).join('\n')).not.toMatch(/sekrit/)
  })
})

describe('when the page asks the hub about itself', () => {
  it('asks on a page load with no token, which is the arrival it exists for', async () => {
    // THE ONE THAT ACTUALLY HAPPENS: somebody deployed this, opened it, and has
    // no token — the whole reason the block was written. It was also the one
    // arrival nothing covered: deleting `this.askStart()` out of
    // `componentDidMount` left every test in this file green, while the two
    // arrivals below (sign-out, a refused token) both caught it. Asserted end to
    // end rather than by counting the call, so that a mount which asks and then
    // drops the answer fails here too.
    loadStart.mockImplementation(async () => HINT)
    const c = page(null)
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.start).not.toBeNull())
    expect(loadStart).toHaveBeenCalledTimes(1)
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('asks for a reader who has a token too, and after their list has come back', async () => {
    // THE LAZINESS THAT WENT WITH THE GATE (issue #91). While the door was the
    // only screen drawing a block, a reader with a token was somebody the
    // question bought nothing for; the list draws one now, so that reader is
    // exactly who it is asked for. Asserted end to end — the answer has to reach
    // `start`, not merely be requested — and the list is asserted first, because
    // the ask is deliberately behind it: this is the screen that reads it.
    loadIndex.mockResolvedValue([CARD])
    loadStart.mockImplementation(async () => ({ ...HINT, empty: false }))
    const c = page('remembered')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.projects).not.toBeNull())
    await vi.waitFor(() => expect(c.state.start).not.toBeNull())
    expect(loadStart).toHaveBeenCalledTimes(1)
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT, empty: false })
  })

  it('asks once, however often the door is arrived at', async () => {
    loadStart.mockImplementation(async () => HINT)
    const c = page()
    await c.askStart()
    await c.askStart()
    expect(loadStart).toHaveBeenCalledTimes(1)
  })

  it('asks after signing out', async () => {
    // The arrival that never passes through a page load: the list was on the
    // screen a moment ago, and this is a hub with nothing on it.
    loadStart.mockImplementation(async () => HINT)
    const c = page('sekrit')
    c.state = { ...c.state, projects: [projectCard(CARD)] }
    await HammerolaEntry.prototype.signOut.call(c)
    await vi.waitFor(() => expect(c.state.start).not.toBeNull())
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('asks after the hub refused a token', async () => {
    // Quite possibly the owner, setting the hub up with the wrong string in the
    // browser — which is exactly the reader the block is written for.
    loadIndex.mockRejectedValue(new Unauthorized('401'))
    loadStart.mockImplementation(async () => HINT)
    const c = page('stale')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.start).not.toBeNull())
  })

  it('does not ask a hub that just failed to answer anything', async () => {
    // Distinct from a refusal, and the distinction is deliberate: the hub could
    // not be reached, so another question is one more request nobody can get an
    // answer to. The door still works; there is simply no block on it.
    loadIndex.mockRejectedValue(new Error('offline'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const c = page()
    await HammerolaEntry.prototype.submit.call(c, 'sekrit')
    expect(loadStart).not.toHaveBeenCalled()
    expect(c.state.start).toBeNull()
  })

  it('keeps the paths when the hub answered that it has projects', async () => {
    // WHAT THE GATE'S REMOVAL LOOKS LIKE FROM UP HERE. This used to be a hub
    // whose answer was `null`, i.e. one the page learnt nothing addressable
    // from; it now hands the paths over with `empty: false` on them, because the
    // list has to print them on such a hub. `null` is left meaning one thing —
    // the hub was not asked, or could not be read — which is the test below.
    loadStart.mockImplementation(async () => ({ ...HINT, empty: false }))
    const c = page()
    await c.askStart()
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT, empty: false })
  })

  it('asks again after an ask that brought nothing back', async () => {
    // THE BUG THIS IS FOR, in the order it happens: the door opens, `/start`
    // does not answer, and the reader then types a token the hub refuses — the
    // arrival the block is most written for, since somebody typing a token into
    // an empty hub is usually its owner. With the flag set on the REQUEST that
    // second arrival found the question already asked and drew nothing until a
    // reload; set on the ANSWER, it asks again and gets one.
    loadStart.mockImplementation(async () => null)
    const c = page()
    await c.askStart()
    expect(c.state.start).toBeNull()

    loadStart.mockImplementation(async () => HINT)
    await c.askStart()
    expect(loadStart).toHaveBeenCalledTimes(2)
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('asks again after an ask that threw, rather than handing back the wreck', async () => {
    // UNREACHABLE TODAY AND WRITTEN ANYWAY, because the path is deliberate:
    // `loadStart` resolves for every failure it can have, and `startHint` was
    // put OUTSIDE its `try` on purpose so that a defect in this bundle arrives
    // as a stack trace instead of a hub that silently never has a block
    // (hub.js). "There is nothing to catch here" is therefore the first
    // sentence in askStart's docstring that will go stale, and clearing the
    // flight on the fulfilled branch alone makes that day cost twice: the
    // rejected promise sits in `this.asking` and every later arrival at the
    // door gets it back without a request being made, so the block never
    // appears again for the life of the page.
    loadStart.mockImplementationOnce(async () => { throw new Error('defect') })
    const c = page()
    await expect(c.askStart()).rejects.toThrow('defect')
    expect(c.state.start).toBeNull()

    loadStart.mockImplementation(async () => HINT)
    await c.askStart()
    expect(loadStart).toHaveBeenCalledTimes(2)
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('asks once for two arrivals inside one flight', async () => {
    // The other direction of the same field. Nothing overlaps them in the
    // browser today, but "ask once" has to mean once whether or not the first
    // answer has landed — otherwise moving the flag off the request traded one
    // wasted ask for two live ones.
    let answer
    loadStart.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const c = page()
    const first = c.askStart()
    const second = c.askStart()
    expect(loadStart).toHaveBeenCalledTimes(1)
    answer(HINT)
    await Promise.all([first, second])
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })

  it('leaves the question about /start unasked and unanswered', async () => {
    // THE CONSTRUCTOR IS OTHERWISE UNTESTED, and everything the block hangs off
    // is seeded there: `start`, `answered` and `asking`. Every other test in
    // this file builds the page with `Object.create` and writes `state` by
    // hand, so the constructor never runs in them — and all three of
    // `answered = true`, `asking = <a promise that never settles>` and a
    // `start` seeded with a block passed the entire suite unchanged. The first
    // two are the door never asking `/start` at any arrival, on any hub, for
    // the life of the tab; the third is the block drawn on a hub that never
    // said it was empty. Asserted through a real ask rather than by reading the
    // fields, so that seeding them with anything else fails here too.
    loadStart.mockImplementation(async () => HINT)
    const c = new HammerolaEntry({})
    c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
    expect(c.state.start).toBeNull()

    const flight = c.askStart()
    // Synchronously, before the answer: an `asking` seeded with a pending
    // promise is handed back instead, and no request is made at all.
    expect(loadStart).toHaveBeenCalledTimes(1)
    await flight
    expect(c.state.start).toEqual({ origin: window.location.origin, ...HINT })
  })
})

describe('copying the block', () => {
  const clipboardOf = (writeText) => {
    vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })
  }

  it('writes every line of it, in one piece', async () => {
    // One message, not five: the reason the button exists is that a person
    // selecting three addresses out of a box by hand drops a character off one.
    const writeText = vi.fn(async () => {})
    clipboardOf(writeText)
    const c = login({ start: AT })
    await c.copy()
    expect(writeText).toHaveBeenCalledWith(agentBrief(AT).join('\n'))
    expect(c.state.copied).toBe('done')
    expect(texts(HammerolaLogin.prototype.render.call(c))).toContain('Copied')
  })

  it('does not claim to have copied where there is no clipboard', async () => {
    // `navigator.clipboard` is absent in an insecure context, which a hub on a
    // plain http address inside a network is. Saying "Copied" there leaves
    // somebody pasting whatever was in the buffer before.
    clipboardOf(null)
    const c = login({ start: AT })
    await c.copy()
    expect(c.state.copied).toBe('none')
    const drawn = texts(HammerolaLogin.prototype.render.call(c))
    expect(drawn).not.toContain('Copied')
    expect(drawn).toContain('Copy by hand')
  })

  it('says so when the clipboard refused', async () => {
    // Rejected rather than absent: the document was not focused, or the
    // permission was denied. Same rule, and the failure must not be silent
    // either — the button is the only report there is.
    clipboardOf(vi.fn(async () => { throw new DOMException('not focused') }))
    const c = login({ start: AT })
    await c.copy()
    expect(c.state.copied).toBe('failed')
    expect(texts(HammerolaLogin.prototype.render.call(c))).toContain('Copy failed')
  })

  it('does nothing at all when there is no block to copy', async () => {
    const writeText = vi.fn(async () => {})
    clipboardOf(writeText)
    const c = login({ start: null })
    await c.copy()
    expect(writeText).not.toHaveBeenCalled()
    expect(c.state.copied).toBe('')
  })

  it('drops its verdict when the block underneath it changes', () => {
    // A verdict is about the text that was copied. `Copied` over lines that have
    // since changed claims a clipboard holding something else, and `Copy failed`
    // reports a failure that happened to different ones — neither correctable by
    // the reader, since the button says nothing more until it is pressed again.
    const c = login({ start: AT })
    c.state = { ...c.state, copied: 'failed' }
    c.props = { ...c.props, start: { origin: 'https://moved.example', ...HINT } }
    HammerolaLogin.prototype.componentDidUpdate.call(c, { start: AT })
    expect(c.state.copied).toBe('')
    expect(texts(HammerolaLogin.prototype.render.call(c))).toContain('Copy')
  })

  it('leaves the verdict alone while the block is the same', () => {
    // The other half: every keystroke in the token field re-renders this screen,
    // and a `Copied` that vanished on the next one would be a button that
    // answered and then took it back.
    const c = login({ start: AT })
    c.state = { ...c.state, copied: 'done' }
    HammerolaLogin.prototype.componentDidUpdate.call(c, { start: AT })
    expect(c.state.copied).toBe('done')
  })

  it('clears the last verdict before trying again', async () => {
    // A retry must not read as its own result for however long the clipboard
    // takes to answer.
    const c = login({ start: AT })
    const seen = []
    clipboardOf(vi.fn(async () => { seen.push(c.state.copied) }))
    c.state = { ...c.state, copied: 'failed' }
    await c.copy()
    expect(seen).toEqual([''])
    expect(c.state.copied).toBe('done')
  })
})

// -- the footer of the list: one caption, and the same block with the token --
//
// The list is behind the token, so this is the one page in the bundle that can
// print one — and the one whose reader is the owner who already has it. What is
// pinned here is that the block is drawn from what the page was handed, that the
// lines it copies are the lines it drew, and that it is drawn ON EVERY HUB
// (issue #91): the door's `empty` is the door's, and a page that only offered
// the brief while the list was empty would offer it for the one hour of a hub's
// life when nobody needs a page to find it.

/** The list as the page hands it over: defaultProps applied, state seeded. */
function list(props) {
  const c = new HammerolaProjects({ ...HammerolaProjects.defaultProps, projects: [], ...props })
  c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
  return c
}

const clipboard = (writeText) => {
  vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })
}

describe('the caption under the list', () => {
  it('says both halves of it, in one line', () => {
    // SHORTER, NOT SMALLER (issue #91). The two claims are the whole of the
    // sentence and neither survives being dropped: a project is listed from its
    // first commit, and a push into the local `dev` slot never lists one. What
    // is asserted is that ONE string carries both — the old wording said them on
    // two lines either side of a `<br>`, so a reading that found them in two
    // strings would pass on the sentence this replaced.
    const drawn = texts(list({}).render())
    const said = drawn.filter((line) => line.includes('hammerola commit'))
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/listed/)
    expect(said[0]).toMatch(/`dev`/)
    expect(said[0]).toMatch(/never/)
  })
})

describe('the block on the list', () => {
  it('draws the brief with the token in it, under the caption', () => {
    const c = list({ start: AT, token: 'sekrit' })
    const drawn = texts(c.render())
    for (const line of agentBrief({ ...AT, token: 'sekrit' })) expect(drawn).toContain(line)
    expect(drawn).toContain('Token: sekrit')
    // UNDER IT, in that order: the caption answers why a project is or is not
    // in the list above, and the block answers what to do next. Reversed, the
    // page offers the next step before saying what the step is about.
    const at = (needle) => drawn.findIndex((line) => line.includes(needle))
    expect(at('hammerola commit')).toBeGreaterThan(-1)
    expect(at('Hand this to your agent')).toBeGreaterThan(at('hammerola commit'))
  })

  it('says what pasting it costs, beside the button that offers to', () => {
    // The warning the door's old rule carried, at the one place it is now true:
    // these lines ARE a credential once they are out of this page.
    const drawn = texts(list({ start: AT, token: 'sekrit' }).render())
    expect(drawn.join('\n')).toMatch(/credential/)
    expect(drawn).toContain('Copy')
  })

  it('is there on a hub with projects on it, which is the hub it is for', () => {
    // THE POINT OF THE SECOND BLOCK. `empty: false` is what takes the door's
    // copy down and it must do nothing at all here: the reader is the owner,
    // and what they are doing on a hub that already has projects is starting
    // the next one. Drawn beside a real card, because "the footer of an empty
    // page" is exactly the state this must not be limited to.
    const c = list({ start: FULL, token: 'sekrit', projects: [projectCard(CARD)] })
    const drawn = texts(c.render())
    for (const line of agentBrief({ ...FULL, token: 'sekrit' })) expect(drawn).toContain(line)
    expect(drawn).toContain('Token: sekrit')
    expect(drawn).toContain('Hand this to your agent')
  })

  it('is not there at all until the paths have come back', () => {
    // The one state that takes it down: a hub that was not asked, or answered
    // something unreadable. There is nothing to print, and the token must not go
    // on the screen without the lines it belongs to.
    const c = list({ start: null, token: 'sekrit', projects: [projectCard(CARD)] })
    const drawn = texts(c.render())
    expect(drawn.join('\n')).not.toContain('sekrit')
    expect(drawn).not.toContain('Hand this to your agent')
    for (const line of agentBrief({ ...AT, token: 'sekrit' })) expect(drawn).not.toContain(line)
  })

  it('copies the lines it drew, and no others', async () => {
    // The rule the door keeps, at the second place it now has to hold: what is
    // copied cannot differ from what is read. Both come from `brief()`.
    const writeText = vi.fn(async () => {})
    clipboard(writeText)
    const c = list({ start: AT, token: 'sekrit' })
    await c.copy()
    const drawn = texts(c.render())
    expect(writeText).toHaveBeenCalledWith(drawn.filter((line) => (
      agentBrief({ ...AT, token: 'sekrit' }).includes(line)
    )).join('\n'))
    expect(writeText).toHaveBeenCalledWith(agentBrief({ ...AT, token: 'sekrit' }).join('\n'))
    expect(drawn).toContain('Copied')
  })

  it('does not claim to have copied where there is no clipboard', async () => {
    // The case this hub is actually deployed in as often as not: plain http on
    // a local network is an insecure context, and `navigator.clipboard` is
    // simply absent there. The button has to send the reader to select the
    // lines by hand rather than leave them pasting whatever was in the buffer.
    clipboard(null)
    const c = list({ start: AT, token: 'sekrit' })
    await c.copy()
    expect(c.state.copied).toBe('none')
    const drawn = texts(c.render())
    expect(drawn).toContain('Copy by hand')
    expect(drawn).not.toContain('Copied')
  })

  it('says so when the clipboard refused', async () => {
    clipboard(vi.fn(async () => { throw new DOMException('not focused') }))
    const c = list({ start: AT, token: 'sekrit' })
    await c.copy()
    expect(c.state.copied).toBe('failed')
    expect(texts(c.render())).toContain('Copy failed')
  })

  it('does nothing at all when there is no block to copy', async () => {
    const writeText = vi.fn(async () => {})
    clipboard(writeText)
    const c = list({ start: null, token: 'sekrit' })
    await c.copy()
    expect(writeText).not.toHaveBeenCalled()
    expect(c.state.copied).toBe('')
  })

  it('clears the last verdict before trying again', async () => {
    // The door's rule, on this copy of the button: a retry must not read as its
    // own result for however long the clipboard takes to answer. Asserted from
    // INSIDE `writeText`, because that is the only moment the stale verdict
    // would be on screen — after the promise settles both spellings agree.
    const c = list({ start: AT, token: 'sekrit' })
    const seen = []
    clipboard(vi.fn(async () => { seen.push(c.state.copied) }))
    c.state = { ...c.state, copied: 'failed' }
    await c.copy()
    expect(seen).toEqual([''])
    expect(c.state.copied).toBe('done')
  })
})

describe('what the page hands the list', () => {
  it('is the block and the token it can put in it', () => {
    // The other half of the door's rule: the token goes to the screen that is
    // already behind it, and `start` is the same field both screens read.
    const c = Object.create(HammerolaEntry.prototype)
    c.state = { projects: [], token: 'sekrit', busy: false, refused: '', start: AT }
    const screen = HammerolaEntry.prototype.render.call(c)
    expect(screen.type).toBe(HammerolaProjects)
    expect(screen.props.start).toBe(AT)
    expect(screen.props.token).toBe('sekrit')
  })

  it('hands it a way to remove one, which the list has no token to do itself', () => {
    // The division the list's own fetch already keeps: the secret is state up
    // here, so the request is made up here too, and what goes down is a
    // function. `token` still goes with it, because whether a card carries the
    // control at all is a question about the reader rather than about the
    // handler.
    const c = Object.create(HammerolaEntry.prototype)
    c.state = { projects: [], token: 'sekrit', busy: false, refused: '', start: AT }
    const screen = HammerolaEntry.prototype.render.call(c)
    expect(typeof screen.props.onDelete).toBe('function')
  })

  it.each([
    ['nothing at all', [], { ...HINT }],
    ['a project', [CARD], { ...HINT, empty: false }],
  ])('asks for the paths when the list came back with %s', async (_name, cards, answer) => {
    // BOTH CASES, because the ask has no condition on it and a condition is
    // exactly what would creep back. It was `if (!rows.length)` for one round —
    // which is the empty half of this passing and the other half quietly not,
    // i.e. no block on the hub the block is written for.
    loadIndex.mockResolvedValue(cards)
    loadStart.mockImplementation(async () => answer)
    const c = page('remembered')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.start).not.toBeNull())
    expect(c.state.projects).toHaveLength(cards.length)
    expect(c.state.start).toEqual({ origin: window.location.origin, ...answer })
  })
})

// -- removing a project ------------------------------------------------------
//
// Issue #92. The route has been there since #26 (`_handle_delete` in src/app.py)
// and until now only a terminal could reach it, so what is new is the interface
// and every one of these is about that: who is offered the control, what the
// confirmation demands before it will act, what goes on the wire when it does,
// and what a refusal leaves standing.
//
// THE HUB CALL IS THE REAL ONE. `deleteProject` is deliberately NOT in the mock
// factory at the top of this file — it arrives through `importOriginal` — so the
// request asserted below is the one a browser would make, read off `fetch`. A
// stubbed one would let this file agree with itself about a method and a header,
// which are exactly the two things a page that never deleted anything would
// still get wrong.
//
// AND THE CONFIRMATION IS DRIVEN THROUGH THE METHODS, not through the paint.
// `remove` is what the button and the Enter key both run, and it refuses on its
// own account: a test that only read the button's `cursor` would pass on a
// control that looked inert and deleted the project anyway.

/** One canned reply for the fetch `deleteProject` makes. */
const answering = (response) => {
  const fetching = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetching)
  return fetching
}
const gone = () => ({ ok: true, status: 200, json: async () => ({ builds: 3, comments: 1 }) })
const refusing = (status, said) => ({ ok: false, status, json: async () => ({ error: said }) })

/** The list as the page hands it over, with a card and something to press. */
const listing = (onDelete, props) => list({
  token: 'sekrit', onDelete, projects: [projectCard(CARD)], ...props,
})

/** Every delete control both view bodies drew, as elements. */
const controls = (c) => collect(
  Object.values(VIEW_BODIES).map((body) => body(c, c.props.projects)),
  (el) => (el.props.title === REMOVE_TITLE ? el : undefined))

/** The button of the confirmation, whichever of its two words it is showing. */
const button = (c) => collect(c.render(), (el) => (
  el.props.children === 'Delete' || el.props.children === 'Deleting…' ? el : undefined))[0]

describe('the delete control on a card', () => {
  it('is on every card, in either arrangement', () => {
    // Both bodies, because the control is one method called from two places and
    // wiring up only one of them is invisible to whoever works in the other.
    const drawn = Object.values(VIEW_BODIES).map((body) => (
      titles(body(listing(vi.fn()), [projectCard(CARD)])).filter((t) => t === REMOVE_TITLE)))
    expect(drawn).toEqual([[REMOVE_TITLE], [REMOVE_TITLE]])
  })

  it('is nowhere at all for a reader holding no token', () => {
    // There is no such reader on this screen today — the list is drawn only
    // once the hub has accepted a token — which is precisely why the condition
    // is written down and pinned here: the class is exported, its `token`
    // defaults to empty, and a control that offers to erase a project to
    // somebody who cannot is a button whose only outcome is a 401.
    expect(controls(listing(vi.fn(), { token: '' }))).toEqual([])
  })

  it('is nowhere without a handler behind it either', () => {
    expect(controls(listing(null))).toEqual([])
  })

  it('raises the confirmation instead of following the card\'s link', () => {
    // A card IS an `<a>` (see VIEW_BODIES), so a click anywhere inside it
    // navigates. Without the two calls on the event the box would be raised
    // over a page already on its way to the project.
    const c = listing(vi.fn())
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    controls(c)[0].props.onClick(event)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(c.state.doomed).toBe(CARD.pid)
  })

  it('names the project in the box, and the id to type', () => {
    const c = listing(vi.fn())
    c.askRemove(CARD.pid)
    const drawn = texts(c.render())
    expect(drawn).toContain('Ventilation controller case')
    expect(drawn).toContain(CARD.pid)
    expect(drawn.join(' ')).toMatch(/nothing undoes this/i)
  })
})

describe('confirming a deletion', () => {
  it('refuses everything that is not the id, and then acts', async () => {
    // THE WHOLE POINT OF TYPING IT. A deletion here is irreversible — no
    // retention, no undo, no copy on the hub (SPEC 5.3, 7.3) — so the near
    // misses are the cases: a prefix, the title that is on the card right
    // beside it, and the same id in the wrong case.
    const onDelete = vi.fn(async () => {})
    const c = listing(onDelete)
    c.askRemove(CARD.pid)
    expect(c.confirmed).toBe(false)

    for (const typed of ['', '0a1b2c3d4e5', '0a1b2c3d4e5f0', 'Ventilation controller case',
      '0A1B2C3D4E5F', 'yes']) {
      c.state = { ...c.state, typed }
      expect(c.confirmed).toBe(false)
      await c.remove()
      expect(onDelete).not.toHaveBeenCalled()
    }

    c.state = { ...c.state, typed: CARD.pid }
    expect(c.confirmed).toBe(true)
    await c.remove()
    expect(onDelete).toHaveBeenCalledWith(CARD.pid)
  })

  it('takes a pasted id with whitespace on it, the way the client does', () => {
    // `hammerola rm` strips what is typed at its prompt, and a selection copied
    // out of the card above carries a newline about as often as not. Trimmed and
    // nothing else: everything in the test above is still refused.
    const c = listing(vi.fn())
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: `  ${CARD.pid}\n` }
    expect(c.confirmed).toBe(true)
  })

  it('draws the button inert until the field matches', () => {
    // The other half of the same refusal, on the screen: the reader has to be
    // able to SEE that the box is not going to do anything yet.
    const c = listing(vi.fn())
    c.askRemove(CARD.pid)
    expect(button(c).props.style.cursor).toBe('default')
    c.state = { ...c.state, typed: CARD.pid }
    expect(button(c).props.style.cursor).toBe('pointer')
  })

  it('asks nothing at all when it is cancelled', () => {
    const onDelete = vi.fn(async () => {})
    const c = listing(onDelete)
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid }
    c.cancelRemove()
    expect(onDelete).not.toHaveBeenCalled()
    expect(c.state.doomed).toBeNull()
    expect(button(c)).toBeUndefined()
  })

  it('carries nothing from one project into the box raised over the next', () => {
    // Both fields, and `failed` is the one that matters: a sentence about a
    // refusal, left under a box now naming a different project, is a claim
    // about something the reader never asked for.
    const c = listing(vi.fn())
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid, failed: 'The hub did not remove it: not found' }
    c.askRemove('ffff00001111')
    expect(c.state.typed).toBe('')
    expect(c.state.failed).toBe('')
    expect(c.confirmed).toBe(false)
  })

  it('does not ask twice while the hub is still answering', async () => {
    let answer
    const onDelete = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    const c = listing(onDelete)
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid }
    const first = c.remove()
    expect(c.state.erasing).toBe(true)
    expect(texts(c.render())).toContain('Deleting…')
    await c.remove()
    expect(onDelete).toHaveBeenCalledTimes(1)
    answer()
    await first
    expect(c.state.doomed).toBeNull()
    expect(c.state.erasing).toBe(false)
  })
})

describe('a confirmed deletion', () => {
  it('asks the hub to DELETE that project, under the token', async () => {
    // The whole request, because every part of it is a way to get this wrong:
    // the method (a GET on that path is the file server's), the path (the id is
    // escaped, since nothing here promises what a pid may contain) and the
    // header, which is the only reason the hub answers at all.
    const fetching = answering(gone())
    const c = page('sekrit')
    c.state = { ...c.state, projects: [projectCard(CARD)] }
    await HammerolaEntry.prototype.remove.call(c, CARD.pid)
    expect(fetching).toHaveBeenCalledWith('/api/v1/projects/0a1b2c3d4e5f', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer sekrit' },
      cache: 'no-store',
    })
  })

  it('takes that card off the list and leaves the others where they were', async () => {
    answering(gone())
    const other = projectCard({ ...CARD, pid: 'ffff00001111', project: 'clamp', title: 'Clamp' })
    const c = page('sekrit')
    c.state = { ...c.state, projects: [projectCard(CARD), other] }
    await HammerolaEntry.prototype.remove.call(c, CARD.pid)
    expect(c.state.projects).toEqual([other])
  })

  it('closes the box once the page has answered', async () => {
    const c = listing(vi.fn(async () => {}))
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid }
    await c.remove()
    expect(c.state.doomed).toBeNull()
    expect(c.state.typed).toBe('')
    expect(c.state.failed).toBe('')
  })
})

describe('a deletion the hub refused', () => {
  it('leaves the list exactly as it was, and carries what the hub said', async () => {
    // The hub writes a sentence into `{"error": …}` and this route's are worth
    // reading — a 404 is somebody else having removed it already. "HTTP 409" on
    // its own tells the reader nothing they can act on.
    answering(refusing(409, 'a build of this project is running'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = [projectCard(CARD)]
    const c = page('sekrit')
    c.state = { ...c.state, projects: rows }
    await expect(HammerolaEntry.prototype.remove.call(c, CARD.pid))
      .rejects.toThrow(/a build of this project is running/)
    expect(c.state.projects).toEqual(rows)
  })

  it('says the token was refused rather than that the hub broke', async () => {
    // The division `loadIndex` makes, at the second route that makes it: "the
    // token is wrong" and "the hub is unreachable" are different sentences.
    answering({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
    const c = page('sekrit')
    c.state = { ...c.state, projects: [projectCard(CARD)] }
    await expect(HammerolaEntry.prototype.remove.call(c, CARD.pid))
      .rejects.toThrow(/refused that token/)
    // AND THE READER IS NOT SIGNED OUT OVER IT, which is where this path parts
    // company with `open`'s 401. There is a list on the screen that this same
    // token fetched, so throwing the token away would answer a failed deletion
    // by emptying the page.
    expect(clearToken).not.toHaveBeenCalled()
    expect(c.state.projects).toHaveLength(1)
    expect(c.state.token).toBe('sekrit')
  })

  it('keeps the box open with the sentence in it', async () => {
    // Closing it would put the reader back in front of a list that still shows
    // the project, with nothing anywhere saying why — and "it is still there"
    // is the one thing worth knowing after a deletion that did not happen.
    const said = 'The hub did not remove it: not found'
    const c = listing(vi.fn(async () => { throw new Error(said) }))
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid }
    await c.remove()
    expect(c.state.doomed).toBe(CARD.pid)
    expect(c.state.erasing).toBe(false)
    expect(texts(c.render())).toContain(said)
  })

  it('can be tried again without retyping the id', async () => {
    const onDelete = vi.fn()
      .mockRejectedValueOnce(new Error('The hub did not remove it: not found'))
      .mockResolvedValueOnce(undefined)
    const c = listing(onDelete)
    c.askRemove(CARD.pid)
    c.state = { ...c.state, typed: CARD.pid }
    await c.remove()
    expect(c.state.failed).toBeTruthy()
    await c.remove()
    // The verdict goes with the second press rather than surviving it, the same
    // rule the copy button keeps: a sentence about the attempt before this one
    // is a report about nothing the reader is looking at.
    expect(c.state.failed).toBe('')
    expect(c.state.doomed).toBeNull()
    expect(onDelete).toHaveBeenCalledTimes(2)
  })
})
