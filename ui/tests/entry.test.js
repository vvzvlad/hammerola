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
// `loadStart` is stubbed beside it and answers "no block" by default, which is
// what a hub with projects on it answers. What the real one does with what a hub
// actually sends is `start.test.js`, in a file of its own for the reason given
// there: this one needs the module mocked, that one needs it real.
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
  agentBrief, HammerolaLogin, HammerolaProjects, relTime, RevLine,
} from '../src/HammerolaEntry.jsx'
import { loadIndex, loadStart, projectCard, projectUrl, Unauthorized } from '../src/hub.js'
import {
  clearToken, readProjectSort, readProjectView, readToken, writeProjectSort,
  writeProjectView, writeToken,
} from '../src/store.js'
import { collect, texts } from './eltree.js'

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

// -- the block for an agent, on a hub with nothing on it ---------------------
//
// Five lines somebody copies and hands to their agent: where the skill is, where
// the client is, what this hub's address is, install the skill and follow it,
// ask the owner for the token (issue #48). What is pinned here is the
// three properties that are decisions rather than layout — it is on the DOOR and
// appears at every arrival there, every address in it is BUILT from the browser's
// origin and the manifest's paths, and it never claims to have copied itself
// when it has not.
//
// WHAT IS NOT HERE is what the manifest has to say for the block to exist at
// all: that lives in start.test.js, where hub.js is the real module.

const HINT = { skill: '/start/skill.md', client: '/start/hammerola' }
/** A hub reached at an address nothing in this repository could have written. */
const AT = { origin: 'https://hub.example', ...HINT }

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
    // `start` is null for a hub with projects, for a hub that could not be
    // asked and for one that answered something unreadable — all three by the
    // time it gets here (hub.js). The form has to be the form either way.
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
    const odd = { origin: 'https://elsewhere.example:8443', skill: '/get/s.md', client: '/get/tool' }
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
})

describe('when the door asks whether the hub is empty', () => {
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

  it('does not ask at all for a reader who has a token', async () => {
    // Lazy: somebody with a token is going to the list, where no block is
    // drawn, and a second request on that path buys the page nothing.
    loadIndex.mockResolvedValue([CARD])
    loadStart.mockImplementation(async () => HINT)
    const c = page('remembered')
    await HammerolaEntry.prototype.componentDidMount.call(c)
    await vi.waitFor(() => expect(c.state.projects).not.toBeNull())
    expect(loadStart).not.toHaveBeenCalled()
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

  it('draws no block when the hub answered that it has projects', async () => {
    loadStart.mockImplementation(async () => null)
    const c = page()
    await c.askStart()
    expect(c.state.start).toBeNull()
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
