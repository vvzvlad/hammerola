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
vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadIndex: vi.fn(),
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

import HammerolaEntry, { HammerolaProjects, relTime } from '../src/HammerolaEntry.jsx'
import { loadIndex, projectCard, projectUrl, Unauthorized } from '../src/hub.js'
import {
  clearToken, readProjectSort, readProjectView, readToken, writeProjectSort,
  writeProjectView, writeToken,
} from '../src/store.js'

/** One card exactly as src/render.py's `index_card` writes it. */
const CARD = {
  pid: '0a1b2c3d4e5f',
  project: 'vent_ctrl_case',
  title: 'Ventilation controller case',
  commit: 'c0ffee1234567890abcdef',
  built: '2026-08-26T18:20:00Z',
  first_built: '2026-01-22T09:00:00Z',
  dev: false,
  parts: 14,
  variants: 3,
  mb: '1.2',
}

afterEach(() => {
  vi.clearAllMocks()
})

// -- the card ----------------------------------------------------------------

describe('a card of /index.json', () => {
  it('becomes the row the list renders', () => {
    expect(projectCard(CARD)).toEqual({
      pid: '0a1b2c3d4e5f',
      title: 'Ventilation controller case',
      slug: 'vent_ctrl_case',
      meta: '14 parts · 3 views · 1.2 MB',
      rev: 'c0ffee1',
      dev: false,
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
  c.state = { projects: null, token, busy: false, refused: '' }
  c.setState = vi.fn((patch) => { c.state = { ...c.state, ...patch } })
  c.open = HammerolaEntry.prototype.open
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

  it('asks nothing at all when there is no token', () => {
    const c = page(null)
    HammerolaEntry.prototype.componentDidMount.call(c)
    expect(loadIndex).not.toHaveBeenCalled()
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
