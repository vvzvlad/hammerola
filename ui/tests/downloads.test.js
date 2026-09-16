// Which files belong to which part, how the header's menu groups the same set by
// FORMAT, and what the tree row's menu offers for one part.
//
// THE ANSWER IS DECLARED NOW RATHER THAN RECONSTRUCTED (issue #75).
// `meta.parts` is a catalogue keyed by the part's own identity, and each record
// names the files that were exported for it: `{key: {kind, files: {extension:
// filename}}}`. What this file used to be about went with the code it tested —
// the page read `meta.downloads`, a flat `{label: filename}` map saying nothing
// about which part a file belonged to, and worked it out by cutting the
// filename at its last dot and calling the stem a part. Every hazard those
// tests were built around left with the parse: the label that degenerated to a
// bare `stl` on a one-part build, the part whose own name contains dots, the
// `assembled.stl` indistinguishable in shape from a part's `foo.stl`.
//
// WHAT THE BUILD PUBLISHES ABOUT ITSELF STILL REACHES NEITHER MENU, and that is
// the decision these tests hold — it MOVED rather than went away, which is
// exactly the kind of change that quietly stops being checked. The whole-view
// mesh and picture (`assembled.stl`, `assembled_preview.png`) are now fields on
// a VIEW, and a part's own render is `preview` INSIDE its catalogue record, one
// key away from `files`. They exist so a client can be told the files are there
// — the hub lists no directory — and a picture is looked at rather than
// downloaded. `print.stl` is the one where a button would be actively wrong:
// the plate is whatever the `print` view holds, nothing requires that to be
// printable parts only, and a button on a public page invites somebody to slice
// a plate with a mock of a purchased bearing on it.
//
// The menu itself is assembled through the real `computed()` rather than
// re-derived here. What is under test is a decision — which rows a row menu gets
// for a part, for a part that is not printed, for a row naming no part at all,
// for a group and for a build with no files — and each of those is a sentence
// about the menu, not about the helper.

import { describe, expect, it, vi } from 'vitest'

import HammerolaViewer, {
  DOWNLOAD_GAP_MS, groupDownloads, menuAt, partRecord, sequentialDownload,
} from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'

/**
 * `meta.parts`: two printables and a bought screw, as the hub writes it.
 *
 * The screw is not decoration. A catalogue holds every part a model declares,
 * and the ones that are never printed are the reason `kind` exists — so a
 * fixture of printables only would agree with a page that offered a download
 * for anything it found in the map.
 */
const PARTS = {
  plate: {
    kind: 'printable',
    files: { step: 'plate.step', stl: 'plate.stl', '3mf': 'plate.3mf' },
  },
  post: {
    kind: 'printable',
    files: { step: 'post.step', stl: 'post.stl', '3mf': 'post.3mf' },
  },
  spacer: { kind: 'hardware', note: 'M3x8 DIN912' },
}

/**
 * Everything the same build publishes about ITSELF, at the two levels it now
 * sits at: the view's own mesh and picture (`views[].overview`,
 * `views[].preview` in src/render.py) and each part's render (`preview` inside
 * its catalogue record).
 *
 * Handed to the component so the tests below can assert that it changes NOTHING
 * on either menu. A fixture that simply left these out would agree with a
 * browser that had started reading them — and the part's picture in particular
 * now sits in the SAME OBJECT as its files, which is a shorter reach than it
 * was when the pictures were a map of their own.
 */
const VIEW_FILES = {
  overview: 'assembled.stl',
  preview: 'assembled_preview.png',
}
const PARTS_WITH_PICTURES = {
  plate: { ...PARTS.plate, preview: 'plate_preview.png' },
  post: { ...PARTS.post, preview: 'post_preview.png' },
  spacer: { ...PARTS.spacer, preview: 'spacer_preview.png' },
}

/**
 * The same build's tree: a part, a group with a part in it, and a part that is
 * in the catalogue but never printed.
 *
 * EVERY LEAF CARRIES ITS CATALOGUE KEY, which is what the view file now stamps
 * on it (`export_views` in src/cadbuild/views.py) and what the hub refuses a
 * push without (`check_view_file`). The keys are deliberately not the row
 * NAMES: `reference spacer` is keyed `spacer`, so a lookup that fell back to
 * the label would find nothing here and be visible rather than accidentally
 * right.
 */
const TREE = {
  id: '/model',
  name: 'model',
  children: [
    { id: '/model/plate', name: 'plate', key: 'plate' },
    {
      id: '/model/inner',
      name: 'inner',
      children: [{ id: '/model/inner/post', name: 'post', key: 'post' }],
    },
    // In the catalogue as hardware, so no file was ever exported for it.
    { id: '/model/spacer', name: 'reference spacer', key: 'spacer' },
  ],
}

/**
 * The same tree with a leaf that names NO key.
 *
 * No push the hub accepted produces one — `check_view_file` refuses a leaf
 * without a key — so this is a document that did not come through the front
 * door: a hand-made file, or a hub that answered something else.
 *
 * AN OLD BUILD IS NOT ON THAT LIST, and the omission is the decision rather
 * than an oversight. Reaching a view file's tree at all means `meta.json` was
 * read first, and a genuine document from before issue #75 named its list
 * `variants` (`build_meta` in src/render.py, before 5683fea) where `load()`
 * reads `meta.views` with no guard — so it takes the page down long before any
 * tree is fetched. Old builds were dropped by decision; nothing here opens one.
 *
 * It is here because the answer to it is a DECISION rather than an accident:
 * the row gets nothing, and its name is never used as a stand-in key.
 */
const TREE_WITH_AN_UNKEYED_LEAF = {
  ...TREE,
  children: [...TREE.children, { id: '/model/mystery', name: 'plate' }],
}

/**
 * The same tree with a LEAF called `assembled` on it, keyed `post`.
 *
 * KEYED TO A PART THAT HAS FILES, WHICH IS THE WHOLE OF WHAT MAKES IT A TEST.
 * It was keyed `spacer` — hardware, no files — and that made the two readings
 * agree: by key, a record with no files; by name, no record at all; both
 * answering "No files for this part". So the test below stayed green with the
 * menu reverted to a full lookup by NAME — the very reconstruction this fixture
 * exists to catch — and asked, byte for byte, the same question the bought
 * screw already asks. Keyed `post` the two readings differ: three files by key,
 * nothing by name, so the row can be asked which of the two it used.
 *
 * NO PUSH PRODUCES THIS ONE EITHER, and it takes two rules to say why. A view
 * entry no longer carries a name at all — it is a REFERENCE into the catalogue
 * (`read_parts` in src/cadbuild/views.py), and the tessellator names the leaf
 * after the key it was given — so a leaf named `assembled` and keyed `post`
 * is two strings that cannot come apart on a real build. And `assembled` is a
 * key no part may have, whatever its kind: it is one of the stems a build keeps
 * for itself (`RESERVED_STEMS` in src/cadbuild/parts.py, whose own note spells
 * out that the reservation applies to every kind, not only to what is
 * exported). What IS legal under that name is a GROUP — `_check_group_name`
 * refuses only a name that is also a catalogue key — but a group is a different
 * row with a different menu, so this fixture stays a leaf.
 *
 * IT IS HERE AS THE HAND-MADE DOCUMENT the old reconstruction died on, and the
 * assertion is a decision rather than a description of a real build: this row's
 * name collides with `views[].overview` on the very same document, which names
 * `assembled.stl`. Matched the old way — a row's name against a filename's stem
 * — those two put the whole assembly on this row's menu, with the link working
 * and nothing anywhere saying whose file it was.
 */
const TREE_WITH_A_RESERVED_NAME = {
  ...TREE,
  children: [...TREE.children,
             { id: '/model/assembled', name: 'assembled', key: 'post' }],
}

/**
 * The component as `computed()` sees it, with the row menu open on one node.
 *
 * The state is spelled out rather than defaulted because `computed()` reads
 * nearly all of it: what is being avoided is a field left undefined turning into
 * a `TypeError` halfway down and looking like a failure of the menu.
 */
function component({ node, parts = PARTS, token = null, expanded = {},
                     tree = TREE, viewFiles = {} } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { commentsOpen: false }
  c.home = null
  // The arrangement every other file in this directory uses. Building the menu
  // does not reach the element: the Move row asks the viewport which kind of
  // object it is from INSIDE its own `onClick`, and its gate asks only `viewer`,
  // `narrow` and `isNode` — so the ref is touched only by a test that clicks
  // that row, and no case here does.
  c.host = { current: null }
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '',
      // `parts: null` MEANS THE FIELD IS NOT THERE, and it is spelled by
      // omission rather than as an empty object because `{}` describes no
      // document there has ever been: `_catalogue` in src/render.py refuses an
      // empty `parts` in as many words, and refuses again a catalogue with no
      // `printable` in it (and a printable with no `files`). So the reader of
      // the two "no files" branches below is A HAND-MADE DOCUMENT, OR ONE THIS
      // PAGE DID NOT GET FROM A PUSH.
      //
      // IT IS NOT AN OLD BUILD, and that is worth writing down because the
      // reading is inviting and wrong. A genuine document from before issue #75
      // carried `variants` where this one carries `views` (`build_meta` in
      // src/render.py, before 5683fea), and exactly TWO readings of `meta.views`
      // are unguarded: `load()` calls `.find` on it the moment meta.json
      // arrives, and `subtitle()` does the same on every render that has a meta
      // at all. Those two are also the ones that run FIRST, so such a document
      // takes the page down long before any catalogue is looked at.
      //
      // Every other reading of that field does guard, and that is not an
      // inconsistency to be tidied in either direction: what those guard is
      // `meta` not being THERE yet — the page draws before the fetch answers,
      // and a build swap has a window mid-flight — with the two that ingest a
      // freshly fetched document (`switchBuild` and `poll`/`takePending`)
      // checking the shape of `views` on top of that. Neither question is the
      // one above, and answering it here would only hide the crash that keeps
      // an old document out.
      //
      // Nothing here opens one and nothing here promises to: old builds were
      // dropped by decision, while an untrusted document is a different thing
      // and is what these branches are for.
      ...(parts ? { parts } : {}),
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: Object.keys(parts || {}), gzip: 1000, ...viewFiles }],
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
    feed: [], activePin: null, composer: null,
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

describe('partRecord', () => {
  it('answers with the record the key names', () => {
    expect(partRecord(PARTS, 'plate')).toBe(PARTS.plate)
  })

  it('answers nothing for a key the catalogue does not declare', () => {
    // Which is what a row naming a part of another build looks like, and what
    // the page has to survive rather than throw over.
    expect(partRecord(PARTS, 'lid')).toBeNull()
  })

  it('does not hand back a function for a part called `constructor`', () => {
    // The trap the guard is there for: `render._check_part_name` does not
    // object to a key of `constructor` or `__proto__`, and the catalogue comes
    // back from `JSON.parse`, so it inherits from `Object.prototype`. A bare
    // `parts[key]` answers `constructor` with a FUNCTION, which the reads
    // downstream then slice or hand to React.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(partRecord(PARTS, key), key).toBeNull()
    }
    // And a build that really does declare one is found, since the guard asks
    // about the map rather than about what it inherits.
    const declared = { constructor: { kind: 'printable', files: { stl: 'c.stl' } } }
    expect(partRecord(declared, 'constructor')).toBe(declared.constructor)
  })

  it('answers nothing for an absent catalogue or an empty key', () => {
    expect(partRecord(undefined, 'plate')).toBeNull()
    expect(partRecord(null, 'plate')).toBeNull()
    expect(partRecord(PARTS, '')).toBeNull()
    expect(partRecord(PARTS, null)).toBeNull()
  })

  it('refuses a record that is not an object rather than reading fields off it', () => {
    // The hub refuses one, but this side reads a fetched document rather than a
    // promise about it, and `record.files` on a number is `undefined`.
    expect(partRecord({ plate: 3 }, 'plate')).toBeNull()
    expect(partRecord({ plate: 'plate.stl' }, 'plate')).toBeNull()
    expect(partRecord({ plate: null }, 'plate')).toBeNull()
  })
})

describe('groupDownloads', () => {
  it('puts the printer\'s formats first and the rows under each in part order', () => {
    // The whole complaint the grouping answers: flat, this is six rows in the
    // order the hub wrote them, and "every STL" means picking every third one.
    const groups = groupDownloads(PARTS)
    expect(groups.map((g) => g.ext)).toEqual(['STL', '3MF', 'STEP'])
    expect(groups[0].files.map((f) => f.label)).toEqual(['plate', 'post'])
    expect(groups[0].files.map((f) => f.file)).toEqual(['plate.stl', 'post.stl'])
  })

  it('names every row after the KEY, on a one-part build as on a six-part one', () => {
    // The case that used to need the whole reconstruction: the hub's download
    // label degenerated to a bare `stl` when there was only one printable, so
    // the part's name had to be dug out of the filename. A catalogue key does
    // not degenerate — it is the part's identity whatever else the build holds.
    const groups = groupDownloads({ post: PARTS.post })
    expect(groups.map((g) => g.ext)).toEqual(['STL', '3MF', 'STEP'])
    expect(groups.flatMap((g) => g.files.map((f) => f.label)))
      .toEqual(['post', 'post', 'post'])
  })

  it('takes the row\'s name from the key and never from the filename', () => {
    // THE PARSE IS GONE, and this is the assertion that says so: a build is
    // free to export a part under a filename that looks nothing like its key,
    // and the old code — which cut `v1.2.plate.stl` at its last dot and called
    // the stem the part — would draw `v1.2.plate` here.
    const groups = groupDownloads({
      plate: { kind: 'printable', files: { stl: 'v1.2.plate.stl' } },
    })
    expect(groups[0].files).toEqual([{ label: 'plate', file: 'v1.2.plate.stl' }])
  })

  it('groups by the EXTENSION the record declares, not by the filename', () => {
    // The other half of the same sentence. The extension is the map's key and
    // the file is its value, and the two are free to disagree: `SAFE_LABEL` in
    // src/render.py holds the extension to an alphabet and says nothing about
    // what the file it points at is called.
    const groups = groupDownloads({
      plate: { kind: 'printable', files: { stl: 'plate.model' } },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].ext).toBe('STL')
    expect(groups[0].files).toEqual([{ label: 'plate', file: 'plate.model' }])
  })

  it('lands a format nobody planned for after the three, alphabetically', () => {
    // The order is a rule and not a list the hub is trusted to match: a format
    // added on the build side has to be ORDERED rather than turning up wherever
    // the object happened to be iterated.
    const groups = groupDownloads({
      plate: {
        kind: 'printable',
        files: { stl: 'plate.stl', zip: 'plate.zip', step: 'plate.step', amf: 'plate.amf' },
      },
    })
    expect(groups.map((g) => g.ext)).toEqual(['STL', 'STEP', 'AMF', 'ZIP'])
  })

  it('answers an absent, empty or unusable catalogue with no groups at all', () => {
    expect(groupDownloads({})).toEqual([])
    expect(groupDownloads(undefined)).toEqual([])
    expect(groupDownloads(null)).toEqual([])
    // A record that is not an object, and one whose `files` is not one: both
    // are documents the hub refuses, and neither may take the menu down.
    expect(groupDownloads({ plate: 3, post: { kind: 'printable', files: 'plate.stl' } }))
      .toEqual([])
    // And a filename that is not a non-empty string, which would make a row
    // that downloads nothing — worse than not being offered.
    expect(groupDownloads({ plate: { kind: 'printable', files: { stl: '', step: null } } }))
      .toEqual([])
  })

  it('offers nothing for a part that is never printed', () => {
    // A bought screw and a mock of one are parts — they are in the catalogue,
    // they carry notes, the tree draws them — and no file was ever exported for
    // either. The record says so by carrying no `files` at all, which is the
    // shape `_catalogue` enforces rather than a convention.
    expect(groupDownloads({
      screw: { kind: 'hardware', note: 'M3x8 DIN912' },
      board: { kind: 'mock' },
    })).toEqual([])
  })

  it('never offers the `preview` sitting in the same record', () => {
    // Now a shorter reach than it was: the part's picture used to be in a map
    // of its own and is now one key away from its files. A picture is looked at
    // rather than saved, and it is declared so `hammerola artifacts` can fetch
    // it — a different reader.
    const groups = groupDownloads(PARTS_WITH_PICTURES)
    expect(groups.flatMap((g) => g.files.map((f) => f.file)))
      .toEqual(['plate.stl', 'post.stl', 'plate.3mf', 'post.3mf',
                'plate.step', 'post.step'])
  })

  // -- and `__proto__` is a legal name on both axes -------------------------
  //
  // WRITTEN AS A COMPUTED KEY, which is not style: `{__proto__: v}` in an object
  // literal is the SETTER, so it stores no own property at all and the fixture
  // would be an empty object testing nothing. `{['__proto__']: v}` is an
  // ordinary own property — the shape `JSON.parse` produces from a pushed
  // document, which is the shape under test.

  it('keeps a format called `__proto__` instead of silently storing nothing', () => {
    // The group key comes out of that document, which is why the grouping is a
    // Map: `groups.__proto__ = []` on an object literal stores nothing and
    // reports no failure.
    const groups = groupDownloads({
      plate: { kind: 'printable', files: { ['__proto__']: 'plate.weird' } },
    })
    expect(groups.map((g) => g.ext)).toEqual(['__PROTO__'])
    expect(groups[0].files).toEqual([{ label: 'plate', file: 'plate.weird' }])
  })

  it('keeps a part called `__proto__` on its row rather than losing the label', () => {
    // The same alphabet on the other axis: `_check_part_name` allows it, so the
    // key is read off `Object.entries` and travels to the row as a plain label.
    const groups = groupDownloads({
      ['__proto__']: { kind: 'printable', files: { stl: 'weird.stl' } },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toEqual([{ label: '__proto__', file: 'weird.stl' }])
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

  it('says so on a document carrying no catalogue, instead of drawing an empty menu', () => {
    // The branch is not dead and its reader is named: a hand-made document, or
    // one this page did not get from a push, with no `meta.parts` on it at all.
    // No push produces one — the hub refuses a catalogue that is empty or has
    // nothing printable in it — and no build from before issue #75 gets here
    // either, since those named the list `variants` and this page reads
    // `meta.views` unguarded. The row menu has a sentence for the same
    // document, and the two must not drift apart: a menu with nothing in it
    // reads as a menu that failed to load.
    const c = component({ node: '/model/plate', parts: null })
    expect('parts' in c.state.meta, 'the fixture still carries a catalogue').toBe(false)
    expect(c.computed().downloadGroups).toEqual([])
  })

  it('reads the catalogue\'s `files` and nothing else on the document', () => {
    // The decision this file was reworked around, now that the two things it
    // excludes have moved to two different levels. The view's `overview` and
    // `preview` name the whole-build mesh and its picture; each part's own
    // render is `preview` INSIDE the record whose `files` this menu reads. A
    // mesh here would offer the plate for slicing — and the plate is whatever
    // the `print` view holds, which may be a mock of a purchased bearing —
    // while a picture here is a file saved instead of a picture looked at.
    const v = component({ node: '/model/plate', parts: PARTS_WITH_PICTURES,
                          viewFiles: VIEW_FILES }).computed()
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

  it('SAYS a part that is not printed has no files rather than dropping the row', () => {
    // A bought screw has none and never will. An item that is quietly missing
    // reads as a menu that forgot, and a dead link reads as a broken build.
    const items = menuOn({ node: '/model/spacer' })
    expect(labels(items)).toContain('No files for this part')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('SAYS the same for a row that names no part at all', () => {
    // A leaf with no catalogue key: no push the hub accepted carries one, and
    // the answer is still the honest one rather than a guess. THE ROW IS NAMED
    // `plate` ON PURPOSE — there is a real `plate` in the catalogue with three
    // files under it — so a lookup that fell back to the row's name would offer
    // another part's downloads here and look exactly like it worked.
    const items = menuOn({ node: '/model/mystery', tree: TREE_WITH_AN_UNKEYED_LEAF })
    expect(labels(items)).toContain('No files for this part')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('finds a part whose row is called something else entirely', () => {
    // The other direction, and the reason the fixture's keys are not its names:
    // the tessellator names a row, the catalogue names a part, and the files
    // are looked up under the second. `reference spacer` is not a key and
    // `spacer` is not a row name, so neither could stand in for the other.
    const items = menuOn({
      node: '/model/spacer',
      parts: { ...PARTS, spacer: { kind: 'printable', files: { stl: 'spacer.stl' } } },
    })
    expect(fileRows(items).map((m) => m.hint)).toEqual(['spacer.stl'])
  })

  it('offers a group nothing, the same way a note is not offered on one', () => {
    // Files hang on a PART. A group is not a part and has no catalogue record
    // of its own, so the union of its leaves' files is a set this menu would
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

  it('heads itself with the ROW and copies the ROW, never the key', () => {
    // THE OTHER DIRECTION OF THE SAME SPLIT, and the only two places in this
    // menu that go that way: everything it LOOKS UP is by the key, while the
    // heading and `Copy name` are about the row a reader right-clicked. The row
    // is `reference spacer` and the part is `spacer`, so each of these is a
    // claim about which of the two strings is being shown.
    const c = component({ node: '/model/spacer' })
    const written = []
    c.toast = vi.fn()
    // jsdom has no clipboard at all, so the handler would take its catch branch
    // and toast a failure. Put one there for the length of this test and take
    // it away again — a global left behind is a global the next file inherits.
    Object.defineProperty(navigator, 'clipboard',
                          { value: { writeText: (t) => written.push(t) },
                            configurable: true })
    try {
      const v = c.computed()
      expect(v.menuName).toBe('reference spacer')
      v.menuItems.find((m) => m.label === 'Copy name').onClick({ stopPropagation() {} })
    } finally {
      delete navigator.clipboard
    }

    expect(written).toEqual(['reference spacer'])
    expect(c.toast).toHaveBeenCalledWith('copied: reference spacer')
  })

  it('says so on a document carrying no catalogue, too', () => {
    // The same document as the header's sentence above, and the same reader: a
    // hand-made file, or one this page did not get from a push, with no
    // `meta.parts` on it at all. The header's menu says so; the row menu must
    // not be worse.
    const items = menuOn({ node: '/model/plate', parts: null })
    expect(labels(items)).toContain('No files in this build')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('gives a row named `assembled` ITS OWN part\'s files, not the assembly', () => {
    // The case the old reconstruction actually broke on, kept because what
    // protects against it changed and the failure did not. The row is named
    // `assembled` while `views[].overview` on the same document names
    // `assembled.stl`, the whole product: matched by name those two put the
    // entire assembly on this row, with the link working and nothing saying
    // whose file it was. Matched by KEY the question does not arise — the key
    // is `post`, a name is not looked at anywhere on the path, and what the row
    // offers is what `post` exported.
    //
    // THE KEY POINTS AT A PART WITH FILES ON PURPOSE, which is what makes this
    // a test of the lookup rather than of the sentence: reverted to a lookup by
    // NAME the row finds no `assembled` in the catalogue and answers "No files
    // for this part", so the assertion has to be the three files and not the
    // absence of them. The reserved name is still the point — the collision is
    // what the row is built out of — and the build side refuses it as well (see
    // the fixture), so this is the second line rather than the only one.
    const v = component({ node: '/model/assembled', viewFiles: VIEW_FILES,
                          tree: TREE_WITH_A_RESERVED_NAME }).computed()
    expect(fileRows(v.menuItems).map((m) => m.hint))
      .toEqual(['post.step', 'post.stl', 'post.3mf'])
    // And the assembly's own mesh is on neither menu, under any name.
    expect(offered(v)).not.toContain('assembled.stl')
  })

  it('offers no picture on a part that HAS one', () => {
    // The part's own render sits in the same record as its files now, one key
    // away rather than in a map of its own, and the row still offers three
    // files. A picture is looked at, not downloaded — and it is declared so
    // `hammerola artifacts` can fetch it, which is a different reader.
    const v = component({ node: '/model/plate', parts: PARTS_WITH_PICTURES,
                          viewFiles: VIEW_FILES }).computed()
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
                         menuOn({ node: '/model/plate', parts: null })]) {
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
