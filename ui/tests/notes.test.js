// The two notes on a part, and telling them apart — issue #11.
//
// There are now two things called a note in this interface, they land in the
// same box, and confusing them is the whole risk this file exists for:
//
//   * the AUTHOR's is written in `model.py`, checked at build and again at
//     publish, and arrives inside the build's own catalogue record for the part:
//     `note` in `meta.parts[key]`. It is published content — the same standing
//     as the part's name — so it is shown to everyone, with or without a token,
//     and this side may not edit it;
//   * the READER's is localStorage, per project. It never leaves the browser,
//     there is still no route that writes it anywhere, and it is hidden from a
//     viewer along with every other edit.
//
// BOTH HANG ON THE CATALOGUE KEY (issue #75), and that is what changed under
// this file. They used to hang on the part's display NAME, in two flat maps of
// identical shape — `meta.notes` and the localStorage one — and the tests below
// could not tell a lookup by key from a lookup by name, because the fixture's
// keys and names were the same string. They are deliberately not the same string
// any more: the row nested in a group is NAMED `post(2)` and KEYED `post`, which
// is exactly what the tessellator does to a view holding two of one part, so a
// read that fell back to the name now finds nothing instead of finding the right
// answer by accident.
//
// A NOTE IS ABSENT ON MOST PARTS and that is not an error. It now has two
// spellings that mean the same thing — a record with no `note` key, and a part
// with no record in the catalogue at all — and several tests here are about a
// build that says nothing rendering exactly as it did.
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

import HammerolaViewer, { noteFor, notesWith } from '../src/HammerolaViewer.jsx'
import { indexTree } from '../src/hub.js'
import { collect, texts } from './eltree.js'

/**
 * A part, and a group with a part in it whose ROW NAME IS NOT ITS KEY.
 *
 * `post(2)` is what the tessellator calls the second instance of `post` in a
 * view (`export_views` in src/cadbuild/views.py), and it is written into the
 * fixture rather than left equal to the key because everything below is a claim
 * about which of the two strings the note hangs on. With `name === key` every
 * one of these tests passes under a lookup by name as well.
 */
const TREE = {
  id: '/model',
  name: 'model',
  children: [
    { id: '/model/lid', name: 'lid', key: 'lid' },
    { id: '/model/inner', name: 'inner',
      children: [{ id: '/model/post', name: 'post(2)', key: 'post' }] },
  ],
}

/** What the model said about its parts, by catalogue key. */
const NOTES = { lid: 'M3x8 DIN912', post: 'press fit, H7' }

/**
 * Those notes where they now travel: inside `meta.parts`, one record per key.
 *
 * The notes are written as a `{key: text}` map above because what these tests
 * are about is which note lands in which box — but the SHAPE is precisely what
 * moved in issue #75, so the conversion is one function, right here, rather
 * than a `note:` spelled out at forty call sites where nobody would notice it
 * drifting back to a flat map.
 *
 * A record is a `printable` with a file, because that is what a part carrying a
 * note usually is; the note itself is written only when there is one, which is
 * the shape `_catalogue` in src/render.py produces (an absent key, never `""`).
 */
const catalogue = (notes) => Object.fromEntries(
  Object.entries(notes || {}).map(([key, note]) => [key, {
    kind: 'printable',
    files: { stl: `${key}.stl` },
    ...(note === undefined || note === '' ? {} : { note }),
  }]))

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
  c.history = []
  // `render()` hangs the viewport off this ref; without it the two tests that
  // read the drawn tree throw before they get to the box.
  c.host = { current: null }
  c.setState = vi.fn((patch) => { Object.assign(c.state, patch) })
  c.state = {
    meta: {
      project: 'fixture', commit: 'abc1234', built: '',
      // The catalogue is always there — a build has parts whether or not any of
      // them says anything — and it is the notes that are absent unless a test
      // asks for them, which is the ordinary build.
      parts: catalogue(notes === undefined ? { lid: '', post: '' } : notes),
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['lid', 'post'], gzip: 1000 }],
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
    feed: [], activePin: null, composer: null,
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

  it('follows the selection, by KEY, into a group', () => {
    // The lookup is the catalogue key and nothing else: this row is nested a
    // level down, its id says so, and its NAME is `post(2)` — the tessellator's
    // way of telling two copies of one part apart. The note was written about
    // the part, so it is found under `post`.
    const c = component({ sel: '/model/post', notes: NOTES })
    expect(c.state.tree.nodes.get('/model/post').name).toBe('post(2)')
    const v = c.computed()
    expect(v.authorNote).toBe('press fit, H7')
    // And the box is headed with the key rather than with the row's label: a
    // heading of `post(2)` would claim the note is about that one instance.
    expect(v.noteName).toBe('post')
  })

  it('says nothing on a leaf that names no part at all', () => {
    // No push the hub accepted carries one — `check_view_file` refuses a leaf
    // with no key — so this is a document that came from somewhere else. THE
    // ROW IS NAMED `lid`, which is a real key with a real note under it, so a
    // fallback to the name would answer with another part's sentence and look
    // exactly like it worked.
    const c = component({ notes: NOTES })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/x', name: 'lid' }] })
    c.state.sel = '/model/x'
    const v = c.computed()
    expect(v.noteName).toBe('')
    expect(v.authorNote).toBe('')
    expect(shown(v.noteBoxStyle)).toBe(false)
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
    // `selectedKey()` answers '' for a tree node — `indexTree` puts a key on
    // leaves only — and the whole lookup hangs off that key. A group showing
    // the note of a part inside it would be the interface inventing an author's
    // sentence about an assembly.
    const v = component({ sel: '/model/inner', notes: NOTES }).computed()
    expect(v.noteName).toBe('')
    expect(v.authorNote).toBe('')
    expect(shown(v.noteBoxStyle)).toBe(false)
  })

  it('leaves a part the model said nothing about alone, either spelling of it', () => {
    // TWO SPELLINGS OF THE SAME ABSENCE now that the note lives inside the
    // record: a part whose record carries no `note` key, and a part with no
    // record in the catalogue at all. Neither is an error and both must draw
    // the same empty box.
    const noNote = component({ sel: '/model/lid',
                               notes: { lid: '', post: 'press fit, H7' } }).computed()
    expect(noNote.authorNote).toBe('')
    expect(shown(noNote.noteBoxStyle)).toBe(false)

    const noRecord = component({ sel: '/model/lid',
                                 notes: { post: 'press fit, H7' } }).computed()
    expect(noRecord.authorNote).toBe('')
    expect(shown(noRecord.noteBoxStyle)).toBe(false)
  })

  it('is empty on a part called `constructor`, and real when the build declares one', () => {
    // `meta.parts` is parsed out of a fetched document, so it inherits from
    // `Object.prototype`: a bare lookup on a part keyed `constructor` or
    // `toString` answers with a FUNCTION, and `record.note` off one is
    // `undefined` — while `record` itself reaching React would take the page
    // down. A legal key: `render._check_part_name` does not object.
    //
    // THIS IS A CLAIM ABOUT THE BOX AND NOT A GUARD ON `partRecord`, and the
    // name says so because the two are easy to confuse. Take the ownership
    // check out of `partRecord` and this still passes: `authorNote` reads
    // `record.note` and refuses anything that is not a string, which is a
    // second wall in front of the same value. The guard itself is asserted
    // where it can be — `describe('partRecord')` in downloads.test.js, on the
    // function directly.
    const c = component({ sel: '/model/lid', notes: {} })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/c', name: 'c', key: 'constructor' }] })
    c.state.sel = '/model/c'
    expect(c.computed().authorNote).toBe('')

    // And a build that really declares one is found, because the guard asks
    // about the map rather than about what it inherits.
    c.state.meta.parts = catalogue({ constructor: 'M3x8' })
    expect(c.computed().authorNote).toBe('M3x8')
  })

  it('is empty when the catalogue record is not an object', () => {
    // The hub refuses one; this side reads the document rather than a promise
    // about it, and `record.note` off a number is `undefined` while `3.note`
    // would be nothing at all to show.
    //
    // Same reading as above: the box is what is under test here. `partRecord`
    // refusing a non-object is asserted on the function itself, in
    // downloads.test.js.
    const c = component({ sel: '/model/lid', notes: NOTES })
    c.state.meta.parts = { lid: 3 }
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

// -- the key is a CATALOGUE KEY, and that is not a safe key either -------------
//
// The reader's map is keyed by the part's catalogue key and is not an object
// this code built: it comes back out of `JSON.parse` on localStorage. A part is
// allowed to be keyed `constructor` — `render._check_part_name` does not object
// — and a bare lookup then answers with a function off `Object.prototype`.
//
// TWO READS, ONE HELPER, which is what these tests are really about. The guard
// used to be written out at the newest read and nowhere else; the older ones had
// it nowhere, and the next would have been added the same way. It was three
// reads until issue #75 moved the author's note inside the catalogue record,
// where `partRecord` makes the identical argument for the identical reason.

describe('noteFor', () => {
  it('answers the entry the map itself owns', () => {
    expect(noteFor({ lid: 'M3x8 DIN912' }, 'lid')).toBe('M3x8 DIN912')
  })

  it('answers nothing for a name that only the PROTOTYPE has', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(noteFor({}, name), `${name} came off the prototype`).toBe('')
    }
    // `__proto__` is the other half of the same trap: it is not an own property
    // of a literal either, and reading it answers with the prototype object.
    expect(noteFor({}, '__proto__')).toBe('')
  })

  it('still answers a part that is REALLY called `constructor`', () => {
    // The guard is about ownership, not about the spelling of the name: a model
    // may legitimately publish a part under one of these.
    expect(noteFor({ constructor: 'M3x8' }, 'constructor')).toBe('M3x8')
  })

  it('treats anything that is not a string as no note', () => {
    expect(noteFor({ lid: { text: 'nope' } }, 'lid')).toBe('')
    expect(noteFor({ lid: 12 }, 'lid')).toBe('')
  })

  it('answers nothing for a missing map or a missing key', () => {
    // The reader's map is `{}` until they write something and `selectedKey()`
    // is '' on a group; neither may be an error.
    expect(noteFor(undefined, 'lid')).toBe('')
    expect(noteFor(null, 'lid')).toBe('')
    expect(noteFor('not a map', 'lid')).toBe('')
    expect(noteFor({ lid: 'x' }, '')).toBe('')
  })
})

// -- and the WRITE, which had no guard at all ---------------------------------
//
// Every read went through `noteFor` and the one write did not, which is the
// half of the trap that loses data rather than throwing. `notes[key] = text` is
// an ASSIGNMENT, and `__proto__` names an accessor on `Object.prototype` rather
// than a slot on the object: handed a string that setter does nothing and
// reports nothing. So a reader writing a note on a part keyed `__proto__`
// watched the dialog close exactly as it does on success, `{}` went to
// localStorage, and `noteFor` afterwards answered with an empty box — honestly,
// because there was nothing there. Nothing anywhere said so.
//
// THE KEY IS LEGAL. `render._check_part_name` does not object, so this is a
// part a model may publish rather than an attack.

describe('notesWith', () => {
  it('writes an ordinary name and reads back through `noteFor`', () => {
    const next = notesWith({ post: 'press fit' }, 'lid', 'M3x8 DIN912')
    expect(noteFor(next, 'lid')).toBe('M3x8 DIN912')
    expect(noteFor(next, 'post')).toBe('press fit')
  })

  it('really writes a part called `__proto__`, which assignment does not', () => {
    // The defect in one line: `{}[name] = text` here creates no own property at
    // all and answers no differently for having tried.
    const next = notesWith({}, '__proto__', 'thin wall here')

    expect(Object.prototype.hasOwnProperty.call(next, '__proto__'),
           'the note went to the prototype setter and vanished').toBe(true)
    expect(noteFor(next, '__proto__')).toBe('thin wall here')
    // And the map is still a map: writing the note did not move its prototype.
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype)
  })

  it('survives the round trip through localStorage', () => {
    // The map does not stay in this process: `writeNotes` stringifies it and
    // `readNotes` parses it back, and an own `__proto__` has to make both
    // crossings — `JSON.parse` DEFINES the key rather than assigning it, which
    // is what makes this work at all.
    const written = JSON.stringify(notesWith({ lid: 'M3x8' }, '__proto__', 'thin wall here'))
    const back = JSON.parse(written)

    expect(noteFor(back, '__proto__')).toBe('thin wall here')
    expect(noteFor(back, 'lid')).toBe('M3x8')
  })

  it('writes the other prototype names too, and reads them back', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const next = notesWith({}, name, 'M3x8')
      expect(noteFor(next, name), `${name} did not survive the write`).toBe('M3x8')
    }
  })

  it('takes an entry out for an empty note, `__proto__` included', () => {
    expect(notesWith({ lid: 'x', post: 'y' }, 'lid', '')).toEqual({ post: 'y' })

    const had = notesWith({}, '__proto__', 'x')
    const gone = notesWith(had, '__proto__', '')
    expect(Object.prototype.hasOwnProperty.call(gone, '__proto__')).toBe(false)
    expect(noteFor(gone, '__proto__')).toBe('')
  })

  it('leaves the map it was given alone', () => {
    // `saveNotes` puts the answer in state, and state is not edited in place.
    const before = { lid: 'M3x8' }
    notesWith(before, 'post', 'press fit')
    expect(before).toEqual({ lid: 'M3x8' })
  })

  it('copies a map that already carries a `__proto__` entry', () => {
    // The spread DEFINES rather than assigns, which is why copying is safe where
    // writing is not — and why the map that came back from localStorage above
    // does not lose the entry on the next save.
    const had = JSON.parse('{"__proto__":"thin wall here","lid":"M3x8"}')
    const next = notesWith(had, 'post', 'press fit')

    expect(noteFor(next, '__proto__')).toBe('thin wall here')
    expect(noteFor(next, 'post')).toBe('press fit')
  })

  it('answers a copy for a missing or unusable map, and for no name', () => {
    // `notePop` is a part name off the tree and `notes` starts as `{}`, but the
    // map has been through `JSON.parse` and the name through a menu.
    expect(notesWith(undefined, 'lid', 'x')).toEqual({ lid: 'x' })
    expect(notesWith(null, 'lid', 'x')).toEqual({ lid: 'x' })
    expect(notesWith('not a map', 'lid', 'x')).toEqual({ lid: 'x' })
    expect(notesWith({ lid: 'x' }, '', 'y')).toEqual({ lid: 'x' })
  })
})

describe('saving a note on a part called `__proto__`', () => {
  it('lands, through the editor the reader actually uses', () => {
    // END TO END, because the defect was never in the helper: it was in the one
    // line of `noteSave`, and a reader met it as a dialog that closed like any
    // other and a note that was simply not there afterwards.
    const c = component({ mine: {} })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/p', name: 'p', key: '__proto__' }] })
    c.state.sel = '/model/p'
    c.state.notePop = '__proto__'
    c.state.noteDraft = 'thin wall here'

    c.computed().noteSave({ stopPropagation() {} })

    expect(noteFor(c.state.notes, '__proto__'),
           'the note closed the dialog and went nowhere').toBe('thin wall here')
    // And it comes back out where the reader looks for it.
    expect(c.computed().noteText).toBe('thin wall here')
  })

  it('clears again when the reader empties the box', () => {
    const c = component({ mine: notesWith({}, '__proto__', 'thin wall here') })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/p', name: 'p', key: '__proto__' }] })
    c.state.sel = '/model/p'
    c.state.notePop = '__proto__'
    c.state.noteDraft = '   '

    c.computed().noteSave({ stopPropagation() {} })

    expect(noteFor(c.state.notes, '__proto__')).toBe('')
    expect(c.computed().noteText).toBe('')
  })
})

describe('a part keyed `constructor`', () => {
  /** That part, selected, with the row menu open on it. */
  const onIt = (over) => {
    const c = component({ sel: '/model/lid', ...over })
    c.state.tree = indexTree({ id: '/model', name: 'model',
                              children: [{ id: '/model/c', name: 'c', key: 'constructor' }] })
    c.state.sel = '/model/c'
    return c
  }

  it('reads no READER note off the prototype either', () => {
    // The older of the two reads, and the one nobody looked at when the guard
    // was written for the author's: same key, same map shape, same failure.
    expect(onIt({ mine: {} }).computed().noteText).toBe('')
  })

  it('does not take the row menu down when it is right-clicked', () => {
    // The read that fails EARLIEST: the `Note` item slices the note to 22
    // characters for its hint, and a function has no `slice` — so an
    // unguarded lookup throws inside `computed()` and the whole page goes with
    // the menu, on a right-click.
    const c = onIt({ mine: {} })
    c.state.menu = { id: '/model/c', x: 0, y: 0 }

    expect(() => c.computed()).not.toThrow()
    const item = c.computed().menuItems.find((m) => m.label === 'Note')
    expect(item.hint).toBe('')

    // And the editor it opens starts empty rather than on a function.
    item.onClick({ stopPropagation() {} })
    expect(c.state.noteDraft).toBe('')
  })
})

// -- a build from before the key existed --------------------------------------

describe('a build with no notes at all', () => {
  it('renders exactly as it did before author notes existed', () => {
    // The ordinary case, and every build published so far. No record carries a
    // `note`, asking about it must not throw, and the box must not open.
    const c = component({ sel: '/model/lid' })
    for (const record of Object.values(c.state.meta.parts)) {
      expect(record.note).toBeUndefined()
    }
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

// -- the two doors into the reader's editor -----------------------------------
//
// A reader starts a note from one of two places — the row's context menu and the
// `add yours` link in the box — and BOTH OF THEM PUT A KEY IN `notePop`, which
// is the string `noteSave` later hands to `notesWith`. Write the ROW's label
// there instead and nothing reports a thing: the note lands under `post(2)`,
// `selectedNote()` looks under `post` and finds nothing, the box goes on saying
// `add yours`, and the dialog closed exactly the way it closes on success.
//
// EVERY ASSERTION HERE IS ABOUT `notePop` ITSELF and goes through the row where
// the two strings differ. The draft beside it is the same empty string either
// way on a part with no note yet, so a test that checked the draft alone — or
// one that went through `/model/lid`, where the name IS the key — cannot see
// this at all.

describe('starting a note on a row whose name is not its key', () => {
  /** The row menu open on `post(2)`, the second instance of `post`. */
  const onPost = (over) => {
    const c = component({ sel: '/model/post', ...over })
    c.state.menu = { id: '/model/post', x: 0, y: 0 }
    return c
  }
  const noteItem = (c) => c.computed().menuItems.find((m) => m.label === 'Note')

  it('reads the row menu\'s hint under the KEY', () => {
    // The read, and its failure is worse than a blank hint: an item that found
    // nothing opens the editor with an empty draft, and an empty draft saved is
    // a DELETE (`notesWith`). So a hint looked up under `post(2)` does not
    // merely look empty — it hands the reader a box whose next OK wipes the
    // note they already wrote, and looks to them like they typed nothing.
    const c = onPost({ mine: { post: 'press fit, H7' } })
    expect(c.state.tree.nodes.get('/model/post').name).toBe('post(2)')

    expect(noteItem(c).hint).toBe('press fit, H7')
  })

  it('opens the editor on the key, not on the row', () => {
    const c = onPost({ mine: { post: 'press fit, H7' } })

    noteItem(c).onClick({ stopPropagation() {} })

    expect(c.state.notePop).toBe('post')
    expect(c.state.noteDraft).toBe('press fit, H7')
  })

  it('lands the note where the box reads it back from', () => {
    // End to end through that door, because `notePop` only matters for what
    // `noteSave` does with it: written under `post(2)` the note is found by
    // nothing, and the row that was just annotated still offers to `add yours`.
    const c = onPost({ mine: {} })
    noteItem(c).onClick({ stopPropagation() {} })
    c.state.noteDraft = 'thin wall here'

    c.computed().noteSave({ stopPropagation() {} })

    expect(c.state.notes).toEqual({ post: 'thin wall here' })
    const v = c.computed()
    expect(v.noteText).toBe('thin wall here')
    expect(v.editNoteLabel).toBe('edit yours')
  })

  it('opens the box\'s own link on the key too', () => {
    // The other door, and a second PLACE rather than a second spelling of the
    // first: the menu reads the node the menu is open on, the link reads the
    // SELECTION. Both have to answer `post`, and only one of them was ever
    // asserted — through `/model/lid`, where either answer is `lid`.
    const c = component({ sel: '/model/post', mine: { post: 'press fit, H7' } })

    c.computed().editNote({ stopPropagation() {} })

    expect(c.state.notePop).toBe('post')
    expect(c.state.noteDraft).toBe('press fit, H7')
  })
})

describe('the Note item on a row with no catalogue key', () => {
  /** The labels of the row menu opened on one node of `tree`. */
  const labelsOn = (id, tree) => {
    const c = component({ sel: '/model/lid' })
    c.state.tree = indexTree(tree)
    c.state.menu = { id, x: 0, y: 0 }
    return c.computed().menuItems.map((m) => m.label)
  }

  it('is not offered on a leaf that names no part, because the write goes nowhere', () => {
    // `notesWith` answers with the map UNTOUCHED for an empty key (`if (!key)
    // return next`), so an item offered here would take the reader's sentence,
    // close the dialog the way a save closes it and store nothing. THE ROW IS
    // NAMED `lid` on purpose: `lid` is a real key with a real note under it, so
    // a condition asking about the row rather than about the key would look
    // exactly like it worked.
    expect(labelsOn('/model/x', { id: '/model', name: 'model',
                                  children: [{ id: '/model/x', name: 'lid' }] }))
      .not.toContain('Note')
  })

  it('is offered on a leaf that HAS one', () => {
    // The other half, so the line above is a claim about the key rather than
    // about the item having gone missing from the menu altogether.
    expect(labelsOn('/model/post', TREE)).toContain('Note')
  })

  it('is not offered on a group, which is the same rule and not a second one', () => {
    // A group is not a part, so it has no record for a note to hang on —
    // `indexTree` puts a key on leaves only, and that absence is what the
    // condition reads. Stated here so the rule has one home rather than two.
    expect(labelsOn('/model/inner', TREE)).not.toContain('Note')
  })
})

// -- what the reader's editor may not touch -----------------------------------

describe('writing the reader\'s note', () => {
  it('leaves the author\'s note exactly where it was', () => {
    // The one way this feature could destroy published content: the reader's
    // note is keyed by the same CATALOGUE KEY, and a save that wrote into the
    // published record would replace the model's sentence with the reader's —
    // permanently, silently, and only in the browser that did it. The two now
    // live in different documents, which is a stronger separation than the two
    // maps were; asserted anyway, because that is what the claim is about.
    const c = component({ sel: '/model/lid', notes: NOTES, mine: {} })
    c.state.notePop = 'lid'
    c.state.noteDraft = 'mine now'
    c.computed().noteSave({ stopPropagation() {} })

    expect(c.state.notes).toEqual({ lid: 'mine now' })
    expect(c.state.meta.parts).toEqual(catalogue(NOTES))
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
