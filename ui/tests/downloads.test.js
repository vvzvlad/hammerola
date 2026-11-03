// Which files belong to which part, whether the build ships any, and what the
// tree row's menu offers for one part.
//
// `meta.parts` is a catalogue keyed by the part's own identity, and each record
// names the files that were exported for it: `{key: {kind, files: {extension:
// filename}}}`. Nothing is reconstructed from filenames.
//
// What the build publishes about itself reaches no menu, but for the beds.
// The whole-view mesh and picture (`assembled.stl`, `assembled_preview.png`)
// are fields on a VIEW, and a part's own render is `preview` inside its
// catalogue record, one key away from `files`. They exist so a client can be
// told the files are there — the hub lists no directory — and a picture is
// looked at rather than downloaded. `print.stl` is the beds glued into one mesh
// for the picture; what a slicer is offered is each bed's own 3MF, the
// `plates` of the `print` view.
//
// The menu itself is assembled through the real `computed()` of the page
// rather than re-derived here. What is under test is a decision — which rows a row menu gets
// for a part, for a part that is not printed, for a row naming no part at all,
// for a group and for a build with no files — and each of those is a sentence
// about the menu, not about the helper.

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer, { menuAt, partRecord } from '../src/HammerolaViewer.jsx'
import BambuLink from '../src/bambu.jsx'
import CopyLink from '../src/copylink.jsx'
import { downloadsView, filesKeyFor } from '../src/downloadsview.js'
import { PAGE, indexTree, rereadPage } from '../src/hub.js'
import { FILES_KEY, makeComponent } from './component.js'
import { collect } from './eltree.js'

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
 * Everything the same build publishes about ITSELF, at its two levels: the
 * view's own mesh and picture (`views[].overview`, `views[].preview` in
 * src/render.py) and each part's render (`preview` inside its catalogue
 * record).
 *
 * Handed to the component so the tests below can assert that it changes
 * NOTHING on the menu; a fixture that left these out would agree with a
 * browser that had started reading them.
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
 * EVERY LEAF CARRIES ITS CATALOGUE KEY, which is what the view file stamps
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
 * without a key — so this is a hand-made file, or a hub that answered
 * something else. The row gets nothing, and its name is never used as a
 * stand-in key.
 */
const TREE_WITH_AN_UNKEYED_LEAF = {
  ...TREE,
  children: [...TREE.children, { id: '/model/mystery', name: 'plate' }],
}

/**
 * The same tree with a LEAF called `assembled` on it, keyed `post`.
 *
 * Keyed to a part that has files, so the two readings differ: three files by
 * key, nothing by name, and the row can be asked which of the two it used.
 *
 * No push produces this: a view entry is a reference into the catalogue
 * (`read_parts` in src/cadbuild/views.py) and the tessellator names the leaf
 * after its key, and `assembled` is a key no part may have (`RESERVED_STEMS`
 * in src/cadbuild/parts.py). A GROUP may carry the name (`_check_group_name`
 * refuses only a catalogue key), but a group is a different row with a
 * different menu, so this fixture stays a leaf.
 *
 * The row's name collides with `views[].overview` on the same document
 * (`assembled.stl`); matched by name against a filename's stem, the whole
 * assembly would land on this row's menu.
 */
const TREE_WITH_A_RESERVED_NAME = {
  ...TREE,
  children: [...TREE.children,
             { id: '/model/assembled', name: 'assembled', key: 'post' }],
}

/**
 * The component as `computed()` sees it, with the row menu open on one node.
 *
 * The state is the whole page and not a slice of it because `computed()` reads
 * nearly all of it: what is being avoided is a field left undefined turning into
 * a `TypeError` halfway down and looking like a failure of the menu. That whole
 * page is `makeComponent`'s default (ui/tests/component.js); what is written
 * below is what these tests are about.
 *
 * The ref `render()` hangs the viewport off is left empty, which is the
 * arrangement every other file in this directory uses. Building the menu does
 * not reach the element: the Move row asks the viewport which kind of object it
 * is from INSIDE its own `onClick`, and its gate asks only `viewer`, `narrow`
 * and `isNode` — so the ref is touched only by a test that clicks that row, and
 * no case here does.
 *
 * The key to the files is the default fixture's, on builds.json. `builds` and
 * `linkKey` (the key the address carried at load) are for the cases about
 * where a key comes from; `builds: null` is a page that has no picker.
 */
function component({ node, parts = PARTS, token = null, expanded = {},
                     tree = TREE, viewFiles = {}, builds, linkKey } = {}) {
  return makeComponent(HammerolaViewer, {
    ...(linkKey ? { _linkKey: linkKey } : {}),
    state: {
      ...(builds === undefined ? {} : { builds }),
      meta: {
        project: 'fixture', commit: 'abc1234', built: '',
        // `parts: null` means the field is not there, spelled by omission
        // because `{}` describes no real document: `_catalogue` in
        // src/render.py refuses an empty `parts`, a catalogue with no
        // `printable`, and a printable with no `files`. So the reader of the two
        // "no files" branches below is a hand-made document, or one this page
        // did not get from a push.
        ...(parts ? { parts } : {}),
        views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                  parts: Object.keys(parts || {}), gzip: 1000, ...viewFiles }],
      },
      tree: indexTree(tree),
      expanded,
      menu: { id: node, x: 0, y: 0 },
      token,
    },
  })
}

const menuOn = (options) => component(options).computed().menuItems
/** Every file the row menu offers over the page `c`. */
const offered = (c) => c.computed().menuItems.filter((m) => m.hint).map((m) => m.hint)
const labels = (items) => items.map((m) => m.label)
/** The rows that actually carry a file. */
const fileRows = (items) => items.filter((m) => m.href)

/** `meta.documents` of a build that lists its Gerbers, twice, beside a note. */
const GERBER_DOCUMENTS = [
  { id: 'notes.md', name: 'notes.md', type: 'markdown', file: 'notes.md', bytes: 9 },
  { id: 'fab__board_gerber.zip', name: 'Gerbers', type: 'gerbers', file: 'fab/board_gerber.zip', bytes: 9 },
  { id: 'panel.zip', name: 'panel.zip', type: 'gerbers', file: 'panel.zip', bytes: 9 },
]

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

describe('whether the build ships files', () => {
  // The row menu's file rows tell "this build ships nothing" from "this part
  // is not a printable" by it (`anyDownloads`, rowmenu.js).
  const ships = (parts, documents, views) => downloadsView(parts, { documents, views }).anyDownloads

  it('counts a part\'s exports, a zip of Gerbers, a plain or a text file, and a bed', () => {
    expect(ships(PARTS)).toBe(true)
    expect(ships(null, GERBER_DOCUMENTS)).toBe(true)
    expect(ships(null, [{ id: 'cut__glass.dxf', type: 'file', file: 'cut/glass.dxf' }])).toBe(true)
    expect(ships(null, [{ id: 'bom.csv', type: 'text', file: 'bom.csv' }])).toBe(true)
    expect(ships(null, undefined, [{ id: 'print', plates: { 1: 'print.3mf' } }])).toBe(true)
  })

  it('counts no part that is never printed, no `preview`, no view\'s own mesh and no drawn document', () => {
    // A bought screw and a mock carry no `files`; a part's picture and a
    // view's `overview` are declared for a client to fetch, not as downloads.
    expect(ships({ screw: { kind: 'hardware', note: 'M3x8 DIN912' }, board: { kind: 'mock' } })).toBe(false)
    expect(ships({ plate: { kind: 'printable', preview: 'plate_preview.png' } })).toBe(false)
    expect(ships(null, undefined, [{ id: 'assembled', overview: 'assembled.stl', preview: 'assembled_preview.png' }]))
      .toBe(false)
    expect(ships(null, [{ id: 'notes.md', type: 'markdown', file: 'notes.md' }])).toBe(false)
  })

  it('answers an absent, empty or unusable catalogue with no', () => {
    expect(ships({})).toBe(false)
    expect(ships(undefined)).toBe(false)
    // A record that is not an object, one whose `files` is not one, and a
    // filename that is not a non-empty string: documents the hub refuses.
    expect(ships({ plate: 3, post: { kind: 'printable', files: 'plate.stl' } })).toBe(false)
    expect(ships({ plate: { kind: 'printable', files: { stl: '', step: null } } })).toBe(false)
  })

  it('counts a part called `__proto__`', () => {
    // A computed key: `{__proto__: v}` in a literal is the setter and stores no
    // own property, while `JSON.parse` of a pushed document makes one.
    expect(ships({ ['__proto__']: { kind: 'printable', files: { stl: 'weird.stl' } } })).toBe(true)
  })
})

describe('the key to the files', () => {
  // The hub refuses a build's STEP, STL and 3MF without the token or the key
  // of that address, so which key the page holds decides whether it offers
  // the files at all.
  const carried = (key) => ({ slot: 'abc1234', key })

  it('is the owner\'s from builds.json first, then the one the address carried', () => {
    const owned = { files_keys: { abc1234: 'owned' } }
    expect(filesKeyFor(owned, 'abc1234', carried('carried'))).toBe('owned')
    expect(filesKeyFor(null, 'abc1234', carried('carried'))).toBe('carried')
    // builds.json the hub could not add keys to.
    expect(filesKeyFor({ has_dev: false }, 'abc1234', carried('carried'))).toBe('carried')
  })

  it('opens only the address it was made for', () => {
    // A key is good for one address alone: the address key on another slot, or
    // an owner's map without this slot, is no key.
    expect(filesKeyFor(null, 'latest', carried('carried'))).toBe('')
    expect(filesKeyFor({ files_keys: { latest: 'l' } }, 'abc1234', null)).toBe('')
  })

  it('is read off the address the page opened on, bound to that slot', () => {
    // A recipient's only key is `files=` in the link. It belongs to the slot
    // the page was opened on, so a later move of the address carries nothing.
    const before = `${location.pathname}${location.search}`
    onTestFinished(() => {
      window.history.replaceState(null, '', before)
      rereadPage(location.pathname)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rev = 'abc1234'.padEnd(64, '0')
    window.history.replaceState(null, '', `/project/proj1/${rev}/?v=print&files=K`)
    rereadPage(location.pathname)
    // The page's, for the row menus.
    expect(new HammerolaViewer({})._linkKey).toEqual({ slot: rev, key: 'K' })
    window.history.replaceState(null, '', `/project/proj1/${rev}/`)
    expect(new HammerolaViewer({})._linkKey).toEqual({ slot: rev, key: '' })
  })

  it('answers nothing for a slot named after what every object has', () => {
    expect(filesKeyFor({ files_keys: {} }, 'constructor', null)).toBe('')
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

  it('ends every file row with Copy link, for that row\'s own address', () => {
    // The plate's three, each a sibling of its link. Read row by row: an
    // element whose own children are a download link and a Copy link, so a
    // Copy link moved inside its `<a>` leaves no such row.
    const c = component({ node: '/model/plate' })
    const kids = (el) => [].concat(el.props.children).filter((k) => k && typeof k === 'object')
    const rows = collect(c.render(), (el) => {
      const link = kids(el).find((k) => k.type === 'a' && k.props.download)
      const copy = kids(el).find((k) => k.type === CopyLink)
      return link && copy ? [link.props.href, copy.props.href] : undefined
    })
    expect(rows).toHaveLength(3)
    rows.forEach(([link, copy]) => expect(copy).toBe(link))
  })

  it('puts Open in Bambu Studio on the 3MF row alone, with its own row\'s address', () => {
    // Bambu Studio refuses any other format, so on a STEP or STL row the
    // control would open an error in it.
    const c = component({ node: '/model/plate' })
    const want = fileRows(c.computed().menuItems).filter((m) => m.hint.endsWith('.3mf'))
      .map((f) => f.href)
    const got = collect(c.render(), (el) => (el.type === BambuLink ? el.props.href : undefined))
    expect(want).toHaveLength(1)
    expect(got).toEqual(want)
  })

  it('links each file against the build\'s own directory, with the key', () => {
    // An `<a download>` cannot carry the token, so without the key in the
    // query the hub refuses the file.
    expect(fileRows(menuOn({ node: '/model/plate' })).map((m) => m.href))
      .toEqual(['plate.step', 'plate.stl', 'plate.3mf'].map((f) => `${PAGE.base}${f}?files=${FILES_KEY}`))
  })

  it('offers none to a reader with no key, not even the sentence', () => {
    // A shared link without the files: every one of these would be a 403, and
    // "No files in this build" would be untrue.
    const items = menuOn({ node: '/model/plate', token: null, builds: null })
    expect(fileRows(items)).toHaveLength(0)
    expect(labels(items).filter((l) => /^No files/.test(l))).toEqual([])
    expect(labels(items)).toContain('Copy name')
  })

  it('offers them to a reader without the token whose link carried the key', () => {
    const items = menuOn({ node: '/model/plate', token: null, builds: null,
                           linkKey: { slot: PAGE.slot, key: 'from-the-link' } })
    expect(labels(items)).not.toContain('Note')
    expect(fileRows(items).map((m) => m.href))
      .toEqual(['plate.step', 'plate.stl', 'plate.3mf']
        .map((f) => `${PAGE.base}${f}?files=from-the-link`))
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
    // be inventing.
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

  it('says so on a document carrying no catalogue', () => {
    // A hand-made file, or one this page did not get from a push, with no
    // `meta.parts` on it at all: a menu with nothing in it reads as a menu
    // that failed to load.
    const items = menuOn({ node: '/model/plate', parts: null })
    expect(labels(items)).toContain('No files in this build')
    expect(fileRows(items)).toHaveLength(0)
  })

  it('gives a row named `assembled` ITS OWN part\'s files, not the assembly', () => {
    // The row is named `assembled` while `views[].overview` on the same
    // document names `assembled.stl`, the whole product. Matched by KEY the
    // question does not arise: the key is `post`, a name is not looked at
    // anywhere on the path, and what the row offers is what `post` exported.
    //
    // The key points at a part with files, so this tests the lookup rather
    // than the sentence: a lookup by NAME would find no `assembled` and answer
    // "No files for this part", so the assertion is the three files. The build
    // side refuses the reserved name as well (see the fixture).
    const c = component({ node: '/model/assembled', viewFiles: VIEW_FILES,
                          tree: TREE_WITH_A_RESERVED_NAME })
    expect(fileRows(c.computed().menuItems).map((m) => m.hint))
      .toEqual(['post.step', 'post.stl', 'post.3mf'])
    // And the assembly's own mesh is not on the menu, under any name.
    expect(offered(c)).not.toContain('assembled.stl')
  })

  it('offers no picture on a part that HAS one', () => {
    // The part's own render sits in the same record as its files now, one key
    // away rather than in a map of its own, and the row still offers three
    // files. A picture is looked at, not downloaded — and it is declared so
    // `hammerola artifacts` can fetch it, which is a different reader.
    const c = component({ node: '/model/plate', parts: PARTS_WITH_PICTURES,
                          viewFiles: VIEW_FILES })
    expect(fileRows(c.computed().menuItems).map((m) => m.hint))
      .toEqual(['plate.step', 'plate.stl', 'plate.3mf'])
    expect(offered(c).filter((f) => f.endsWith('.png'))).toEqual([])
  })

  it('gives a row that STATES something no handler at all', () => {
    // The styling on those two rows says they are not clickable — `cursor:
    // default` and a grey — so they get no `onClick`: inert, as they claim, and
    // the menu still closes on the next click outside it.
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
    row.onMenu({ stopPropagation() {}, preventDefault() {}, nativeEvent: {}, clientX, clientY })
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
