// Which files belong to which part, how the header's menu groups the same set by
// FORMAT, and what the tree row's menu offers for one part.
//
// `meta.downloads` is `{label: filename}` and carries nothing that says which
// part a file is for; the answer is in the filename. Two things make that worth
// a test file of its own rather than a glance:
//
//   * with a SINGLE printable the label degenerates to a bare `step`/`stl`/`3mf`
//     — the part name is gone from it — while the filename does not degenerate at
//     all (`download_labels` in src/cadbuild/printables.py). A menu built by
//     matching labels would work on every assembly except the one-part one;
//   * a printable's name may contain dots, so the split is at the LAST one.
//
// What the build writes about ITSELF is not in that map at all, and that is the
// decision these tests hold. `meta.overview` carries the two whole-build meshes
// (`assembled.stl`, `print.stl`) and `meta.previews` every picture; NEITHER
// REACHES EITHER MENU. They exist so a client can be told the files are there —
// the hub lists no directory — and a picture is looked at rather than
// downloaded. So both menus read `meta.downloads` and nothing else, and that is
// what makes the per-part reading of it TRUE rather than patched: `assembled.stl`
// is indistinguishable in shape from a part's `foo.stl`, so a whole-build entry
// left in that map lands on whatever node happens to be called `assembled`.
//
// The menu itself is assembled through the real `computed()` rather than
// re-derived here. What is under test is a decision — which rows a row menu gets
// for a part, for a reference part, for a group and for a build with no files at
// all — and each of those is a sentence about the menu, not about the helper.

import { describe, expect, it, vi } from 'vitest'

import HammerolaViewer, {
  DOWNLOAD_GAP_MS, filesByPart, groupDownloads, menuAt, sequentialDownload,
} from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'

/** Three printables' worth of `meta.downloads`, as the hub writes it. */
const DOWNLOADS = {
  'plate.step': 'plate.step', 'plate.stl': 'plate.stl', 'plate.3mf': 'plate.3mf',
  'post.step': 'post.step', 'post.stl': 'post.stl', 'post.3mf': 'post.3mf',
}

/**
 * Everything the same build publishes about ITSELF, in the two maps that carry
 * it — `overview_meshes` and `preview_files` in src/cadbuild/printables.py.
 *
 * Handed to the component so the tests below can assert that it changes NOTHING
 * on either menu. A fixture that simply left these out would agree with a
 * browser that had started reading them.
 */
const ABOUT_THE_BUILD = {
  overview: { assembled: 'assembled.stl', print: 'print.stl' },
  previews: {
    assembled: 'assembled_preview.png',
    print: 'print_preview.png',
    plate: 'plate_preview.png',
    post: 'post_preview.png',
  },
}

/** The same build's tree: a part, a group with a part in it, and a reference. */
const TREE = {
  id: '/model',
  name: 'model',
  children: [
    { id: '/model/plate', name: 'plate' },
    { id: '/model/inner', name: 'inner', children: [{ id: '/model/inner/post', name: 'post' }] },
    // Not in printables(), so no file was ever published for it — and its name
    // could not even become a download label, because of the space in it.
    { id: '/model/spacer', name: 'reference spacer' },
  ],
}

/**
 * The same tree with a reference part called `assembled` on it.
 *
 * Entirely legal: a view part needs a non-empty string for a name and nothing
 * more (`read_parts` in src/cadbuild/views.py), and a PRINTABLE of that name is
 * refused outright (`collect_printables`) — so a node like this is GUARANTEED to
 * have no files of its own, which is what makes it the sharpest case there is
 * for the exclusion below.
 */
const TREE_WITH_A_RESERVED_NAME = {
  ...TREE,
  children: [...TREE.children, { id: '/model/assembled', name: 'assembled' }],
}

/**
 * The component as `computed()` sees it, with the row menu open on one node.
 *
 * The state is spelled out rather than defaulted because `computed()` reads
 * nearly all of it: what is being avoided is a field left undefined turning into
 * a `TypeError` halfway down and looking like a failure of the menu.
 */
function component({ node, downloads = DOWNLOADS, token = null, expanded = {},
                     tree = TREE, about = {} } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { commentsOpen: false }
  c.home = null
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '', downloads, ...about,
      variants: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: 3, gzip: 1000 }],
    },
    builds: null,
    tree: indexTree(tree),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded,
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: false, menu: { id: node, x: 0, y: 0 },
    notePop: null, noteDraft: '', notes: {},
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    token, tokenPop: false, tokenDraft: '',
    theme: 'light',
  }
  return c
}

const menuOn = (options) => component(options).computed().menuItems
/** Every file either menu offers, whichever group or row it sits in. */
const offered = (v) => [...v.downloadGroups.flatMap((g) => g.files.map((f) => f.file)),
                        ...v.menuItems.filter((m) => m.hint).map((m) => m.hint)]
const labels = (items) => items.map((m) => m.label)
/** The rows that actually carry a file. */
const fileRows = (items) => items.filter((m) => m.href)

describe('filesByPart', () => {
  it('groups a many-printable build by the part in each filename', () => {
    const grouped = filesByPart(DOWNLOADS)
    expect([...grouped.keys()]).toEqual(['plate', 'post'])
    expect(grouped.get('plate')).toEqual([
      { ext: 'step', file: 'plate.step' },
      { ext: 'stl', file: 'plate.stl' },
      { ext: '3mf', file: 'plate.3mf' },
    ])
  })

  it('finds the part in a SINGLE-printable build, where the label has lost it', () => {
    // The case that defeats prefix-matching on the label, and the reason this
    // reads the value: one printable, and the hub's label is the bare extension.
    const grouped = filesByPart({ step: 'post.step', stl: 'post.stl', '3mf': 'post.3mf' })
    expect([...grouped.keys()]).toEqual(['post'])
    expect(grouped.get('post').map((f) => f.ext)).toEqual(['step', 'stl', '3mf'])
  })

  it('splits at the last dot, so a part name may contain dots', () => {
    const grouped = filesByPart({ 'v1.2.plate.stl': 'v1.2.plate.stl' })
    expect(grouped.get('v1.2.plate')).toEqual([{ ext: 'stl', file: 'v1.2.plate.stl' }])
    expect(grouped.has('v1')).toBe(false)
  })

  it('answers an absent or empty download map with nothing at all', () => {
    expect(filesByPart({}).size).toBe(0)
    expect(filesByPart(undefined).size).toBe(0)
    expect(filesByPart(null).size).toBe(0)
  })

  it('drops a filename that is not `<part>.<ext>` rather than inventing a part', () => {
    // A row built out of one of these would download nothing, which is worse
    // than not being offered.
    const grouped = filesByPart({ a: 'README', b: '.hidden', c: 'trailing.' })
    expect(grouped.size).toBe(0)
  })

  it('keeps a part called `__proto__` instead of silently storing nothing', () => {
    // A legal printable name (MEMBER_RE allows it) and a poisoned key on an
    // object literal — which is why the grouping is a Map.
    const grouped = filesByPart({ x: '__proto__.stl' })
    expect(grouped.get('__proto__')).toEqual([{ ext: 'stl', file: '__proto__.stl' }])
  })
})

describe('groupDownloads', () => {
  it('puts the printer\'s formats first and the rows under each in part order', () => {
    // The whole complaint the grouping answers: flat, this is six rows in the
    // order the hub wrote them, and "every STL" means picking every third one.
    const groups = groupDownloads(DOWNLOADS)
    expect(groups.map((g) => g.ext)).toEqual(['STL', '3MF', 'STEP'])
    expect(groups[0].files.map((f) => f.label)).toEqual(['plate', 'post'])
    expect(groups[0].files.map((f) => f.file)).toEqual(['plate.stl', 'post.stl'])
  })

  it('names the row after the PART on a single-printable build, where the label cannot', () => {
    // The degenerate case `filesByPart` above is also built around: with one
    // printable the hub's label is the bare extension, so stripping the format
    // off it leaves nothing and the filename's stem has to answer. A row reading
    // `stl / stl` would be the visible failure.
    const groups = groupDownloads({ step: 'post.step', stl: 'post.stl', '3mf': 'post.3mf' })
    expect(groups.map((g) => g.ext)).toEqual(['STL', '3MF', 'STEP'])
    expect(groups.flatMap((g) => g.files.map((f) => f.label))).toEqual(['post', 'post', 'post'])
  })

  it('groups by the extension off the FILENAME, not by the label', () => {
    // Same reason as everything else in this file: the label is the half that
    // degenerates. Here it is degenerate AND the group key would be wrong.
    const groups = groupDownloads({ stl: 'v1.2.plate.stl' })
    expect(groups).toHaveLength(1)
    expect(groups[0].ext).toBe('STL')
    expect(groups[0].files).toEqual([{ label: 'v1.2.plate', file: 'v1.2.plate.stl' }])
  })

  it('lands a format nobody planned for after the three, alphabetically', () => {
    // The order is a rule and not a list the hub is trusted to match: a format
    // added on the build side has to be ORDERED rather than turning up wherever
    // the object happened to be iterated.
    const groups = groupDownloads({
      'plate.stl': 'plate.stl', 'plate.zip': 'plate.zip',
      'plate.step': 'plate.step', 'plate.amf': 'plate.amf',
    })
    expect(groups.map((g) => g.ext)).toEqual(['STL', 'STEP', 'AMF', 'ZIP'])
  })

  it('answers an absent, empty or unusable download map with no groups at all', () => {
    expect(groupDownloads({})).toEqual([])
    expect(groupDownloads(undefined)).toEqual([])
    expect(groupDownloads(null)).toEqual([])
    // The same rule as `filesByPart`: a name that is not `<stem>.<ext>` makes a
    // row that downloads nothing, which is worse than not being offered.
    expect(groupDownloads({ a: 'README', b: '.hidden', c: 'trailing.' })).toEqual([])
  })

  it('keeps a format called `__proto__` instead of silently storing nothing', () => {
    // The keys come off model-supplied filenames, which is why the grouping is a
    // Map — the same trap `filesByPart` documents.
    const groups = groupDownloads({ 'plate.__proto__': 'plate.__proto__' })
    expect(groups.map((g) => g.ext)).toEqual(['__PROTO__'])
    expect(groups[0].files).toEqual([{ label: 'plate', file: 'plate.__proto__' }])
  })

  it('leaves a label alone when the format is not on the end of it', () => {
    // The strip takes the format off the label and nothing else. A hub that one
    // day writes a label of its own choosing gets that label drawn, rather than
    // this side guessing at which part of it to cut.
    const groups = groupDownloads({ 'the big plate': 'plate.stl' })
    expect(groups[0].files).toEqual([{ label: 'the big plate', file: 'plate.stl' }])
  })
})

/** A clicker and a clock, so the ORDER and the SPACING can both be read.
 *
 * `schedule` hands back NOTHING on purpose. A cancelled chain calls
 * `clearTimeout` on whatever the scheduler returned — a real id on the real path,
 * a no-op here — and a fake returning, say, an array length would be handing
 * `clearTimeout` a small integer, which is exactly what jsdom's own timer ids
 * are.
 */
function driver() {
  const clicked = []
  const timers = []
  return {
    clicked,
    timers,
    click: (href) => clicked.push(href),
    schedule: (fn, ms) => { timers.push({ fn, ms }) },
    tick: () => timers.shift().fn(),
  }
}

describe('sequentialDownload', () => {
  it('fires the first click inside the gesture and the rest on the clock', () => {
    // The first one is synchronous on purpose: a download is allowed because it
    // is inside the gesture that asked for it, and a first click handed to a
    // timer has left that gesture behind.
    const d = driver()
    const n = sequentialDownload(['/a.stl', '/b.stl', '/c.stl'],
                                 { click: d.click, schedule: d.schedule, delay: 200 })

    expect(n).toBe(3)
    expect(d.clicked).toEqual(['/a.stl'])
    expect(d.timers.map((t) => t.ms)).toEqual([200])

    d.tick()
    expect(d.clicked).toEqual(['/a.stl', '/b.stl'])
    d.tick()
    expect(d.clicked).toEqual(['/a.stl', '/b.stl', '/c.stl'])

    // Nothing is queued past the last file: a trailing timer would fire into a
    // page the reader has long since navigated away from.
    expect(d.timers).toEqual([])
  })

  it('spaces them by its own gap when the caller names none', () => {
    // The gap is not a workaround for a block — a browser asks once and then
    // remembers — it is there because anchors fired in one synchronous burst can
    // be coalesced into a single download, and which files survive is the
    // engine's business rather than this page's.
    const d = driver()
    sequentialDownload(['/a', '/b', '/c'], { click: d.click, schedule: d.schedule })
    expect(d.timers.map((t) => t.ms)).toEqual([DOWNLOAD_GAP_MS])
    expect(DOWNLOAD_GAP_MS).toBeGreaterThanOrEqual(150)
    expect(DOWNLOAD_GAP_MS).toBeLessThanOrEqual(300)
  })

  it('clicks a lone href once and schedules nothing', () => {
    const d = driver()
    expect(sequentialDownload(['/only.stl'], { click: d.click, schedule: d.schedule })).toBe(1)
    expect(d.clicked).toEqual(['/only.stl'])
    expect(d.timers).toEqual([])
  })

  it('does nothing at all for an empty or absent list', () => {
    const d = driver()
    expect(sequentialDownload([], { click: d.click, schedule: d.schedule })).toBe(0)
    expect(sequentialDownload(undefined, { click: d.click, schedule: d.schedule })).toBe(0)
    expect(d.clicked).toEqual([])
    expect(d.timers).toEqual([])
  })

  it('hands over nothing more once its signal is aborted', () => {
    // The chain outlives the gesture that started it — a fifth of a second per
    // file, six seconds on a thirty-file build — and every href in it was
    // captured off `PAGE.base` at the press. Whoever started it has to be able to
    // stop it, or a reader who moved on goes on receiving a build they left.
    const d = driver()
    const chain = new AbortController()

    sequentialDownload(['/a', '/b', '/c'],
                       { click: d.click, schedule: d.schedule, signal: chain.signal })
    expect(d.clicked).toEqual(['/a'])

    chain.abort()
    d.tick()

    expect(d.clicked).toEqual(['/a'])
    // And nothing is left queued behind it either.
    expect(d.timers).toEqual([])
  })

  it('hands over nothing at all under a signal that is already aborted', () => {
    // Checked at the top of every step, the first one included, so a chain
    // started after the cancel cannot slip one file through.
    const d = driver()
    const chain = new AbortController()
    chain.abort()

    sequentialDownload(['/a', '/b'],
                       { click: d.click, schedule: d.schedule, signal: chain.signal })

    expect(d.clicked).toEqual([])
    expect(d.timers).toEqual([])
  })

  // -- and it lets go of the signal when it is done ---------------------------
  //
  // THE SIGNAL OUTLIVES THE CHAIN, which is the whole of why this needs saying:
  // one controller serves the entire page (`downloadAll`), and it is replaced
  // only by a cancel. A listener left behind by a chain that FINISHED therefore
  // sits on that controller holding the chain's `list` and `timer` until the
  // next `switchBuild` or unmount — one more for every press of a group link, on
  // a page a reader can leave open all day. `{once: true}` covers only the other
  // end, an abort that actually fires.
  //
  // A hand-made signal rather than an `AbortController`, because a real one
  // reports nothing about how many listeners are on it — which is the whole
  // claim.

  /** A signal that says who is listening to it. */
  function watchedSignal() {
    const on = []
    return {
      aborted: false,
      on,
      addEventListener: (type, fn) => { on.push(fn) },
      removeEventListener: (type, fn) => {
        const at = on.indexOf(fn)
        if (at >= 0) on.splice(at, 1)
      },
    }
  }

  it('takes its listener off the signal when the chain runs out', () => {
    const d = driver()
    const signal = watchedSignal()

    sequentialDownload(['/a', '/b', '/c'], { click: d.click, schedule: d.schedule, signal })
    expect(signal.on, 'nothing was listening, so nothing is under test').toHaveLength(1)

    d.tick()
    expect(signal.on, 'let go before the last file').toHaveLength(1)
    d.tick()

    expect(signal.on, 'the finished chain is still holding the signal').toEqual([])
  })

  it('leaves nothing on the signal for a lone file or an empty list', () => {
    // Both leave `step` by its first line, which is the way out a listener is
    // easiest to forget on.
    const d = driver()
    const one = watchedSignal()
    const none = watchedSignal()

    sequentialDownload(['/only.stl'], { click: d.click, schedule: d.schedule, signal: one })
    sequentialDownload([], { click: d.click, schedule: d.schedule, signal: none })

    expect(one.on).toEqual([])
    expect(none.on).toEqual([])
  })

  it('does not pile them up over a session of pressing the button', () => {
    // The shape of the leak as a reader would produce it: one controller, one
    // group link, pressed again and again with every chain allowed to finish.
    const signal = watchedSignal()

    for (let n = 0; n < 5; n += 1) {
      const d = driver()
      sequentialDownload(['/a', '/b'], { click: d.click, schedule: d.schedule, signal })
      d.tick()
    }

    expect(signal.on).toEqual([])
  })
})

describe('the chain the page keeps a handle on', () => {
  it('stops where `cancelDownloads` says, wherever the reader went', () => {
    // `componentWillUnmount` and `switchBuild` are the two callers, and both mean
    // the same thing: the addresses in this chain have stopped describing what is
    // on the screen.
    const c = component({ node: '/model/plate' })
    const d = driver()

    c.downloadAll(['/a.stl', '/b.stl', '/c.stl'], { click: d.click, schedule: d.schedule })
    expect(d.clicked).toEqual(['/a.stl'])

    c.cancelDownloads()
    d.tick()

    expect(d.clicked).toEqual(['/a.stl'])
  })

  it('goes with the page when the component is unmounted', () => {
    // The chain touches no state at all, so it survives an unmount perfectly
    // happily — which is precisely why nothing else here would have stopped it.
    const c = component({ node: '/model/plate' })
    const d = driver()

    c.downloadAll(['/a.stl', '/b.stl'], { click: d.click, schedule: d.schedule })
    c.componentWillUnmount()
    d.tick()

    expect(d.clicked).toEqual(['/a.stl'])
  })

  it('cancels every chain still stepping, not only the last one started', () => {
    // Two group links in a row is an ordinary sequence rather than a race: thirty
    // files take six seconds to hand over. Both chains are about the build the
    // reader was on, so both end together — which is what ONE signal for the page
    // buys, and what a controller per press would need a list to do.
    const c = component({ node: '/model/plate' })
    const first = driver()
    const second = driver()

    c.downloadAll(['/a.stl', '/b.stl'],
                  { click: first.click, schedule: first.schedule })
    c.downloadAll(['/a.3mf', '/b.3mf'],
                  { click: second.click, schedule: second.schedule })
    c.cancelDownloads()
    first.tick()
    second.tick()

    expect(first.clicked).toEqual(['/a.stl'])
    expect(second.clicked).toEqual(['/a.3mf'])
  })

  it('starts a fresh signal for the next press after a cancel', () => {
    // The controller is dropped rather than reused, so cancelling the downloads
    // of the build being left does not quietly disable the ones asked for on the
    // build being arrived at.
    const c = component({ node: '/model/plate' })
    c.cancelDownloads()
    const d = driver()

    c.downloadAll(['/a.stl', '/b.stl'], { click: d.click, schedule: d.schedule })
    d.tick()

    expect(d.clicked).toEqual(['/a.stl', '/b.stl'])
  })
})

describe('the header\'s downloads menu', () => {
  it('offers each group a link that takes the whole group, in the menu\'s own order', () => {
    // The point of issue #66 in one assertion: one click, every STL. The
    // downloading itself is `sequentialDownload`; what is checked here is that
    // the button hands it exactly the group's own files and nothing else.
    const c = component({ node: '/model/plate' })
    c.downloadAll = vi.fn()
    const [stl] = c.computed().downloadGroups

    stl.onAll()

    expect(c.downloadAll).toHaveBeenCalledTimes(1)
    expect(c.downloadAll.mock.calls[0][0]).toEqual(stl.files.map((f) => f.href))
    expect(c.downloadAll.mock.calls[0][0]).toHaveLength(2)
  })

  it('says so on a build that ships no files, instead of drawing an empty menu', () => {
    // The row menu has a sentence for this case too, and the two must not drift
    // apart: a menu with nothing in it reads as a menu that failed to load.
    const v = component({ node: '/model/plate', downloads: {} }).computed()
    expect(v.downloadGroups).toEqual([])
  })

  it('reads `meta.downloads` and neither of the maps beside it', () => {
    // The decision this file was reworked around. `meta.overview` and
    // `meta.previews` are on the very document this menu is built from, and both
    // are ignored: a mesh here would offer the plate for slicing — and the plate
    // is whatever the `print` view holds, which may be a mock of a purchased
    // bearing — while a picture here is a file saved instead of a picture looked
    // at, one row per part.
    const v = component({ node: '/model/plate', about: ABOUT_THE_BUILD }).computed()
    expect(v.downloadGroups.map((g) => g.ext)).toEqual(['STL', '3MF', 'STEP'])
    expect(v.downloadGroups.flatMap((g) => g.files.map((f) => f.file)))
      .toEqual(['plate.stl', 'post.stl', 'plate.3mf', 'post.3mf',
                'plate.step', 'post.step'])
  })
})

describe('the row menu', () => {
  it('offers a part its own three files, under the extension', () => {
    const items = menuOn({ node: '/model/plate' })
    expect(labels(items)).toEqual(
      ['Isolate', 'Hide', 'Translucent', 'STEP', 'STL', '3MF', 'Copy name'])
    expect(fileRows(items).map((m) => m.hint))
      .toEqual(['plate.step', 'plate.stl', 'plate.3mf'])
  })

  it('points those rows at the same URLs the header\'s menu does', () => {
    // One construction for both menus: a plain link against the build's own
    // directory. Compared against the header's list rather than rebuilt here,
    // so a change to either one has to move the other.
    //
    // READ OUT OF THE GROUPS, because that is what the header now draws. The
    // flat `v.downloads` this used to read is gone — a value nothing rendered
    // would have been a parity test against a list nobody could see.
    const v = component({ node: '/model/plate' }).computed()
    const header = new Map(v.downloadGroups.flatMap((g) => g.files)
      .map((f) => [f.file, f.href]))
    fileRows(v.menuItems).forEach((m) => {
      expect(m.href).toBe(header.get(m.hint))
    })
    expect(header.get('plate.step')).toMatch(/plate\.step$/)
  })

  it('offers them without a token, because looking is open to everyone', () => {
    // The files are on the open side of the customer/viewer split, exactly as
    // the header's Downloads menu is; only the note is not.
    const items = menuOn({ node: '/model/plate', token: null })
    expect(labels(items)).not.toContain('Note')
    expect(fileRows(items)).toHaveLength(3)
  })

  it('SAYS a reference part has no files rather than dropping the row', () => {
    // A tree node that is not in printables() has none and never will. An item
    // that is quietly missing reads as a menu that forgot, and a dead link reads
    // as a broken build.
    const items = menuOn({ node: '/model/spacer' })
    expect(labels(items)).toContain('No files for this part')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('offers a group nothing, the same way a note is not offered on one', () => {
    // Files hang on a PART. A group is not a printable and has no files under
    // its own name, so the union of its leaves' files is a set this menu would
    // be inventing. Bulk along the axis a reader actually asks for — one format,
    // every part — is in the header's menu, which has a "download all" per group
    // since issue #66.
    //
    // This comment used to end "a browser would block after the first", which is
    // false: a browser ASKS, once, with a per-site permission it then remembers.
    // Corrected rather than dropped because the false version made the choice
    // look like a constraint — and it is the reason the header's bulk button
    // could be built at all.
    const items = menuOn({ node: '/model/inner' })
    expect(labels(items)).toEqual(['Isolate', 'Hide', 'Translucent', 'Copy name'])
  })

  it('says so on a build that ships no files at all', () => {
    // The header's menu has a sentence for this; the row menu must not be worse.
    const items = menuOn({ node: '/model/plate', downloads: {} })
    expect(labels(items)).toContain('No files in this build')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('SAYS a part named `assembled` has no files, not "here is the assembly"', () => {
    // The sharpest case there is, and the one the split was made for. A view
    // part may be called `assembled` — a name only a PRINTABLE is refused — so
    // this node is guaranteed to have no files, while `meta.overview.assembled`
    // on the same document names the whole product. Read together they put the
    // entire assembly on a reference body's row, with the link working and
    // nothing anywhere saying whose file it was.
    const items = menuOn({ node: '/model/assembled', about: ABOUT_THE_BUILD,
                          tree: TREE_WITH_A_RESERVED_NAME })
    expect(labels(items)).toContain('No files for this part')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('offers no picture on a part that HAS one', () => {
    // `meta.previews.plate` is this part's own render, and the row still offers
    // three files. A picture is looked at, not downloaded — and it is declared
    // so `hammerola artifacts` can fetch it, which is a different reader.
    const v = component({ node: '/model/plate', about: ABOUT_THE_BUILD }).computed()
    expect(fileRows(v.menuItems).map((m) => m.hint))
      .toEqual(['plate.step', 'plate.stl', 'plate.3mf'])
    expect(offered(v).filter((f) => f.endsWith('.png'))).toEqual([])
  })

  it('gives a row that STATES something no handler at all', () => {
    // The styling on those two rows says they are not clickable — `cursor:
    // default` and a grey — and they used to be handed an `onClick` anyway, one
    // that stopped the event and closed the menu: a row acting while saying it
    // would not. With no handler it is inert, which is exactly what it claims,
    // and the menu still closes on the next click outside it.
    for (const items of [menuOn({ node: '/model/spacer' }),
                         menuOn({ node: '/model/plate', downloads: {} })]) {
      const said = items.filter((m) => m.style.includes('cursor:default'))
      expect(said).toHaveLength(1)
      expect(said[0].onClick).toBeUndefined()
    }
  })

  it('keeps one on every row that DOES something', () => {
    // The other half of the same sentence: only the stated rows lose it.
    for (const m of menuOn({ node: '/model/plate' })) {
      expect(typeof m.onClick).toBe('function')
      expect(m.style).toContain('cursor:pointer')
    }
  })
})

// -- the same menu, from the other door ---------------------------------------
//
// A right-click on the PART IN THE SCENE opens the menu the tree row's
// right-click opens. The viewport resolves the part and says where the cursor
// was (`hmr:menu`, tools.test.js); everything below is what this side then does
// with that, and every one of these is a way the two doors could come apart
// while each still looked like it worked.

describe('the part menu opened from the scene', () => {
  /** The tree row's own right-click, as `computed()` builds it. */
  function fromTree(id, [clientX, clientY]) {
    const c = component({ node: null, expanded: { '/model': true, '/model/inner': true } })
    const row = c.computed().rows.find((r) => r.key === id)
    expect(row, `no tree row for ${id}`).toBeTruthy()
    row.onMenu({ stopPropagation() {}, preventDefault() {}, clientX, clientY })
    return c
  }

  /** The same menu, asked for by the viewport. */
  function fromScene(id, name, [x, y]) {
    const c = component({ node: null, expanded: { '/model': true, '/model/inner': true } })
    c.sceneMenu({ id, name, x, y })
    return c
  }

  it('opens on the part under the cursor', () => {
    const c = fromScene('/model/plate', 'plate', [120, 90])
    expect(c.state.menu.id).toBe('/model/plate')
    expect(c.computed().menuName).toBe('plate')
  })

  it('leaves the selection exactly where the reader put it', () => {
    // The decision this test exists to hold: a tree row's menu does not select,
    // so neither does this one. A menu that means "look at this" from one door
    // and "select this and look at it" from the other is worse than either.
    const c = component({ node: null })
    c.state.sel = '/model/inner/post'
    c.state.selName = 'post'

    c.sceneMenu({ id: '/model/plate', name: 'plate', x: 120, y: 90 })

    expect(c.state.menu.id).toBe('/model/plate')
    expect(c.state.sel).toBe('/model/inner/post')
    expect(c.state.selName).toBe('post')
  })

  it('closes on a right-click that hit nothing', () => {
    // There are no items about the view as a whole, so empty space has no menu
    // to show — and a menu left standing over the model after a click meant to
    // dismiss it is the reading this avoids.
    const c = fromScene('/model/plate', 'plate', [120, 90])
    c.sceneMenu({ id: null, name: null, x: 10, y: 10 })
    expect(c.state.menu).toBeNull()
  })

  it('offers a part exactly the items the tree row does', () => {
    // Two doors, one menu. The handlers are fresh closures on either side, so
    // what is compared is everything a reader can see: the labels, the hints and
    // the links.
    const shown = (c) => c.computed().menuItems
      .map(({ label, hint, href, style }) => ({ label, hint, href, style }))

    expect(shown(fromScene('/model/plate', 'plate', [120, 90])))
      .toEqual(shown(fromTree('/model/plate', [120, 90])))
    // And on the row that has nothing to offer, which is the half a menu built
    // from a different source would be likeliest to get wrong.
    expect(shown(fromScene('/model/spacer', 'reference spacer', [120, 90])))
      .toEqual(shown(fromTree('/model/spacer', [120, 90])))
  })

  it('puts it in the same place either way, by the same clamp', () => {
    // Coordinates past the edge of jsdom's window, so the clamp actually bites:
    // two copies of this arithmetic would agree on a menu in the middle of the
    // screen and disagree on exactly the case it exists for.
    const far = [9000, 9000]
    const clamped = menuAt(far[0], far[1])
    expect(clamped.x).toBeLessThan(far[0])
    expect(clamped.y).toBeLessThan(far[1])

    expect(fromScene('/model/plate', 'plate', far).state.menu)
      .toEqual({ id: '/model/plate', ...clamped })
    expect(fromTree('/model/plate', far).state.menu)
      .toEqual({ id: '/model/plate', ...clamped })
  })
})
