// Which files belong to which part, and what the tree row's menu offers for one.
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
// The menu itself is assembled through the real `computed()` rather than
// re-derived here. What is under test is a decision — which rows a row menu gets
// for a part, for a reference part, for a group and for a build with no files at
// all — and each of those is a sentence about the menu, not about the helper.

import { describe, expect, it } from 'vitest'

import HammerolaViewer, { filesByPart } from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'

/** Three printables' worth of `meta.downloads`, as the hub writes it. */
const DOWNLOADS = {
  'plate.step': 'plate.step', 'plate.stl': 'plate.stl', 'plate.3mf': 'plate.3mf',
  'post.step': 'post.step', 'post.stl': 'post.stl', 'post.3mf': 'post.3mf',
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
 * The component as `computed()` sees it, with the row menu open on one node.
 *
 * The state is spelled out rather than defaulted because `computed()` reads
 * nearly all of it: what is being avoided is a field left undefined turning into
 * a `TypeError` halfway down and looking like a failure of the menu.
 */
function component({ node, downloads = DOWNLOADS, token = null } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { commentsOpen: false }
  c.home = null
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '', downloads,
      variants: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: 3, gzip: 1000 }],
    },
    builds: null,
    tree: indexTree(TREE),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
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
    const v = component({ node: '/model/plate' }).computed()
    const header = new Map(v.downloads.map((d) => [d.file, d.href]))
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
    // Files hang on a PART. A group is not a printable, has no files under its
    // own name, and its leaves' files are one menu away in the header — where
    // they can be taken one at a time instead of as a dozen downloads at once.
    //
    // This comment used to end "a browser would block after the first", which is
    // false: a browser ASKS, once, with a per-site permission it then remembers.
    // Corrected rather than dropped because the false version made the choice
    // look like a constraint.
    const items = menuOn({ node: '/model/inner' })
    expect(labels(items)).toEqual(['Isolate', 'Hide', 'Translucent', 'Copy name'])
  })

  it('says so on a build that ships no files at all', () => {
    // The header's menu has a sentence for this; the row menu must not be worse.
    const items = menuOn({ node: '/model/plate', downloads: {} })
    expect(labels(items)).toContain('No files in this build')
    expect(fileRows(items)).toHaveLength(0)
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
