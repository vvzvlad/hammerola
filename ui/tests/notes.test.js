// The two notes on a part, and telling them apart — issue #11.
//
// There are now two things called a note in this interface, they land in the
// same box, and confusing them is the whole risk this file exists for:
//
//   * the AUTHOR's is written in `model.py`, checked at build and again at
//     publish, and arrives in the build's own meta.json as a flat map from part
//     NAME to text. It is published content — the same standing as the part's
//     name — so it is shown to everyone, with or without a token, and this side
//     may not edit it;
//   * the READER's is localStorage, keyed by the same part NAME, per project. It
//     never leaves the browser, there is still no route that writes it anywhere,
//     and it is hidden from a viewer along with every other edit.
//
// `meta.notes` IS ABSENT ON MOST BUILDS and that is not an error: a build whose
// parts say nothing carries no `notes` key, and neither does any build published
// before the key existed. Those two are one document, which is why several tests
// here are about a build that has no notes at all rendering exactly as it did.
//
// NOTHING IS MOUNTED, the arrangement every file in this directory uses: the
// instance is the real prototype with the state spelled out and the real
// `computed()` over it. Two tests go one step further and read `render()`'s
// return value (ui/tests/eltree.js) — the claim they make is about what reaches
// the SCREEN, and specifically about the note arriving there as TEXT, which
// `computed()` cannot answer on its own.
//
// The ninth claim of the entry — that a revision switch carries no stale note
// across — is in `revswitch.test.js`, where the swap's machinery already is.

import { describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { collect, texts } from './eltree.js'

/** A part, a group with a part in it, and a second loose part. */
const TREE = {
  id: '/model',
  name: 'model',
  children: [
    { id: '/model/lid', name: 'lid' },
    { id: '/model/inner', name: 'inner', children: [{ id: '/model/post', name: 'post' }] },
  ],
}

/** What the model said about its parts, as the hub publishes it. */
const NOTES = { lid: 'M3x8 DIN912', post: 'press fit, H7' }

/**
 * The component as `computed()` and `render()` see it.
 *
 * `notes` here is the AUTHOR's half — it goes into `meta`, because that is where
 * it comes from — and `mine` is the READER's, which is state. Two names on
 * purpose: a fixture that called both of them `notes` would be the very mistake
 * the interface is being tested for.
 *
 * The state is spelled out in full rather than defaulted, like every other
 * fixture here: `computed()` reads nearly all of it, and a field left undefined
 * becomes a `TypeError` halfway down that reads like a failure of the box.
 */
function component({ sel = '/model/lid', notes, mine = {}, token = 'sekrit',
                     compare = false } = {}) {
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.carry = null
  // `render()` hangs the viewport off this ref; without it the two tests that
  // read the drawn tree throw before they get to the box.
  c.host = { current: null }
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '', downloads: {},
      variants: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: 3, gzip: 1000 }],
      // Absent unless a test says otherwise, which is the ordinary build.
      ...(notes === undefined ? {} : { notes }),
    },
    builds: null,
    tree: indexTree(TREE),
    error: null, viewError: null, pending: null,
    view: 'assembled', tool: null, held: false,
    sel, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare, diffShow: 'both',
    bannerGone: false, rail: false, menu: null,
    notePop: null, noteDraft: '', notes: mine,
    comments: [], activePin: null, composer: null,
    measure: null, moved: null, toast: null,
    token, tokenPop: false, tokenDraft: '',
    theme: 'light',
  }
  return c
}

/** Whether a `display:` string from `computed()` draws its block or not. */
const shown = (style) => /display:block/.test(style)

// -- the author's note --------------------------------------------------------

describe('the author\'s note', () => {
  it('is the one meta.json carries for the selected part', () => {
    const v = component({ sel: '/model/lid', notes: NOTES }).computed()
    expect(v.authorNote).toBe('M3x8 DIN912')
    expect(v.noteName).toBe('lid')
    expect(shown(v.authorNoteStyle)).toBe(true)
    expect(shown(v.noteBoxStyle)).toBe(true)
  })

  it('follows the selection, by NAME, into a group', () => {
    // The key is the part name and nothing else: `post` is nested a level down
    // and its id says so, but the note was written about the part.
    const v = component({ sel: '/model/post', notes: NOTES }).computed()
    expect(v.authorNote).toBe('press fit, H7')
  })

  it('is shown to a reader with no token, and the reader\'s own is not offered', () => {
    // The split this entry had to get right. The author's note is published
    // content — the same standing as the part's name and the downloads — so it
    // is drawn for everybody. The reader's `Note` item is an EDIT and stays
    // behind the token exactly as it was.
    const c = component({ sel: '/model/lid', notes: NOTES, token: null })
    c.state.menu = { id: '/model/lid', x: 0, y: 0 }
    const v = c.computed()

    expect(v.authorNote).toBe('M3x8 DIN912')
    expect(shown(v.noteBoxStyle)).toBe(true)
    expect(shown(v.authorNoteStyle)).toBe(true)
    expect(v.menuItems.map((m) => m.label)).not.toContain('Note')
    // And no way in from the box either — the link there edits the reader's
    // note, which is the thing a viewer may not have. Asserted as the rule that
    // takes it off the page rather than through `shown()`: the link is inline
    // and never says `display:block`, so a check for one would pass whether or
    // not it is drawn.
    expect(v.editNoteStyle).toContain('display:none')
    // …and it IS there for somebody holding the token, which is the half that
    // makes the line above a claim about the split rather than about a style.
    expect(component({ sel: '/model/lid', notes: NOTES }).computed().editNoteStyle)
      .not.toContain('display:none')
  })

  it('says nothing on a GROUP, which is not a part and carries no note', () => {
    // `selectedName()` answers '' for a tree node, and the whole lookup hangs
    // off that name. A group showing the note of a part inside it would be the
    // interface inventing an author's sentence about an assembly.
    const v = component({ sel: '/model/inner', notes: NOTES }).computed()
    expect(v.noteName).toBe('')
    expect(v.authorNote).toBe('')
    expect(shown(v.noteBoxStyle)).toBe(false)
  })

  it('leaves a part the model said nothing about alone', () => {
    const v = component({ sel: '/model/lid', notes: { post: 'press fit, H7' } }).computed()
    expect(v.authorNote).toBe('')
    expect(shown(v.noteBoxStyle)).toBe(false)
  })

  it('is not read off the prototype for a part called `constructor`', () => {
    // `meta.notes` is parsed out of a fetched document, so it inherits from
    // `Object.prototype`: a bare lookup on a part named `constructor` or
    // `toString` answers with a FUNCTION, which React refuses to render — a
    // legal part name taking the whole page down.
    const c = component({ sel: '/model/lid', notes: {} })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/c', name: 'constructor' }] })
    c.state.sel = '/model/c'
    expect(c.computed().authorNote).toBe('')
  })

  it('treats a note that is not a string as no note at all', () => {
    // The hub writes strings and nothing else, but the document is fetched and
    // this side is what has to survive one that is not. Same reason as above:
    // an object handed to React as a child throws.
    const v = component({ sel: '/model/lid', notes: { lid: { text: 'nope' } } }).computed()
    expect(v.authorNote).toBe('')
  })
})

// -- a build from before the key existed --------------------------------------

describe('a build with no notes at all', () => {
  it('renders exactly as it did before author notes existed', () => {
    // The ordinary case, and every build published so far. `meta.notes` is
    // absent, asking about it must not throw, and the box must not open.
    const c = component({ sel: '/model/lid' })
    expect(c.state.meta.notes).toBeUndefined()
    const v = c.computed()
    expect(v.authorNote).toBe('')
    expect(shown(v.authorNoteStyle)).toBe(false)
    expect(shown(v.noteBoxStyle)).toBe(false)
  })

  it('still shows the reader their own note, unchanged', () => {
    // The half that existed before this entry, asserted so that adding the
    // author's cannot have quietly taken it away.
    const v = component({ sel: '/model/lid', mine: { lid: 'thin wall here' } }).computed()
    expect(v.noteText).toBe('thin wall here')
    expect(shown(v.noteBoxStyle)).toBe(true)
    expect(shown(v.readerNoteStyle)).toBe(true)
    expect(shown(v.authorNoteStyle)).toBe(false)
    // No rule above it: there is nothing above it to be separated from.
    expect(v.readerNoteStyle).not.toContain('border-top')
  })

  it('keeps the reader\'s note behind the token, as it always was', () => {
    const v = component({ sel: '/model/lid', mine: { lid: 'thin wall here' },
                          token: null }).computed()
    expect(shown(v.readerNoteStyle)).toBe(false)
    expect(shown(v.noteBoxStyle)).toBe(false)
  })
})

// -- both at once -------------------------------------------------------------

describe('a part carrying both notes', () => {
  const both = () => component({ sel: '/model/lid', notes: NOTES,
                                 mine: { lid: 'thin wall here — do not touch' } })

  it('shows the two of them, separated, the model\'s first', () => {
    const v = both().computed()
    expect(v.authorNote).toBe('M3x8 DIN912')
    expect(v.noteText).toBe('thin wall here — do not touch')
    expect(shown(v.authorNoteStyle)).toBe(true)
    expect(shown(v.readerNoteStyle)).toBe(true)
    // The rule between them appears only when there are two.
    expect(v.readerNoteStyle).toContain('border-top')
  })

  it('labels each one, so nobody has to know the system to tell them apart', () => {
    // The point of the entry in one assertion: two sentences in one box, one of
    // which travelled with the build and one of which exists only here. Read off
    // the drawn tree in DRAW ORDER, because "which is which" is a claim about
    // what a reader sees next to what.
    const drawn = texts(both().render())
    const at = (text) => drawn.indexOf(text)

    expect(at('FROM THE MODEL')).toBeGreaterThan(-1)
    expect(at('ONLY IN THIS BROWSER')).toBeGreaterThan(-1)
    expect(at('M3x8 DIN912')).toBeGreaterThan(-1)
    expect(at('thin wall here — do not touch')).toBeGreaterThan(-1)

    // Each label sits immediately in front of the note it names, and the
    // author's block comes first.
    expect(at('FROM THE MODEL')).toBeLessThan(at('M3x8 DIN912'))
    expect(at('M3x8 DIN912')).toBeLessThan(at('ONLY IN THIS BROWSER'))
    expect(at('ONLY IN THIS BROWSER')).toBeLessThan(at('thin wall here — do not touch'))
  })

  it('offers to edit only the reader\'s half, and says so', () => {
    // One link in the box, and what it opens is the reader's editor. With the
    // author's note on screen the box now stands for parts this browser has
    // written nothing about, so the link says which of the two things it is
    // about to do rather than a bare `edit` beside two notes.
    const c = both()
    expect(c.computed().editNoteLabel).toBe('edit yours')
    expect(component({ sel: '/model/lid', notes: NOTES }).computed().editNoteLabel)
      .toBe('add yours')

    c.computed().editNote({ stopPropagation() {} })
    expect(c.state.notePop).toBe('lid')
    expect(c.state.noteDraft).toBe('thin wall here — do not touch')
  })
})

// -- what the reader's editor may not touch -----------------------------------

describe('writing the reader\'s note', () => {
  it('leaves the author\'s note exactly where it was', () => {
    // The one way this feature could destroy published content: the reader's
    // note is keyed by the same part NAME, and a save that wrote into the same
    // map would replace the model's sentence with the reader's — permanently,
    // silently, and only in the browser that did it.
    const c = component({ sel: '/model/lid', notes: NOTES, mine: {} })
    c.state.notePop = 'lid'
    c.state.noteDraft = 'mine now'
    c.computed().noteSave({ stopPropagation() {} })

    expect(c.state.notes).toEqual({ lid: 'mine now' })
    expect(c.state.meta.notes).toEqual(NOTES)
    const v = c.computed()
    expect(v.authorNote).toBe('M3x8 DIN912')
    expect(v.noteText).toBe('mine now')
  })

  it('leaves it there when the reader CLEARS their own', () => {
    // The same claim from the other side: an empty draft deletes the reader's
    // key, and the box must not go empty on a part the model has something to
    // say about.
    const c = component({ sel: '/model/lid', notes: NOTES, mine: { lid: 'mine' } })
    c.state.notePop = 'lid'
    c.state.noteDraft = '   '
    c.computed().noteSave({ stopPropagation() {} })

    expect(c.state.notes).toEqual({})
    const v = c.computed()
    expect(v.noteText).toBe('')
    expect(shown(v.readerNoteStyle)).toBe(false)
    expect(v.authorNote).toBe('M3x8 DIN912')
    expect(shown(v.noteBoxStyle)).toBe(true)
  })
})

// -- the text is text ---------------------------------------------------------

describe('what reaches the screen', () => {
  // The hub refuses `<`, `>` and control characters in a note, and this side
  // deliberately does not depend on that being the only line of defence: the
  // page is permanent, cached `immutable` for a year, and shares an origin with
  // every other project on the hub. So the note is asserted to arrive as a
  // CHILD — React renders a child as text — rather than as anything a browser
  // would parse.
  const MARKUP = '<img src=x onerror=alert(1)>'

  it('hands the author\'s note over as a child, never as markup', () => {
    const c = component({ sel: '/model/lid', notes: { lid: MARKUP } })
    const holding = collect(c.render(),
                            (el) => (el.props.children === MARKUP ? el : undefined))

    expect(holding, 'the author\'s note is not on the page as a text child')
      .toHaveLength(1)
    // A string child is a string: whatever is in it is drawn, not parsed.
    expect(typeof holding[0].props.children).toBe('string')
    expect(texts(c.render())).toContain(MARKUP)
  })

  it('draws nothing anywhere on the page from raw HTML', () => {
    // The whole tree, not only the box: the check is that no element on this
    // page takes its content from a string the browser will parse, which is the
    // property that makes a pushed note safe wherever it is put next.
    const c = component({ sel: '/model/lid', notes: { lid: MARKUP },
                          mine: { lid: MARKUP } })
    const raw = collect(c.render(),
                        (el) => (el.props.dangerouslySetInnerHTML ? el : undefined))
    expect(raw).toEqual([])
  })
})
