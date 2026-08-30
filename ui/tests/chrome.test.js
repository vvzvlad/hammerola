// The three documents this bundle does NOT draw, against the values it does.
//
//   * `templates/build.html` and `templates/index.html` state the page colour
//     inline, because everything else in them is drawn by 255 KB of bundle and
//     until that has rendered the body has no background at all;
//   * `static/_v/site.css` reproduces the interface's header on the resolver at
//     /project/<pid>/, so that opening a project does not flash another design.
//
// None of the three can import JavaScript, so all three are copies, and a copy
// is only worth having while it is still the same thing. What makes this file
// trustworthy rather than another parser is WHICH SIDE is read as text: the
// interface's values are IMPORTED and executed — `PAGE_BG`, `FONTS`, `Mark` —
// and only the documents, which are static declarative files with no comments
// worth confusing anything, are matched against them.
//
// That distinction is the lesson of two failures in this area. A colour check
// written in Python survived a mutation because it found the hex in a sentence
// explaining the hex; a key check written in Python passed on the defect it was
// written for because a trailing comment held a comma. Both were regexes over
// code that could have been executed instead.
//
// WHY NOT PYTHON: it cannot import a React component, so it could only ever go
// back to reading `style.jsx` as text. The trade is that these checks are
// skipped on a machine with no node — `make test` says so out loud when it skips
// the JS suite — and both CI workflows run it.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FONTS, HEADER_BG, HEADER_LINE, Mark, PAGE_BG, PAGE_FG,
} from '../src/style.jsx'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/**
 * Every file under `rel` whose base name `wanted` accepts, as `[label, text]`.
 *
 * Recursive and sorted. It does NOT refuse an empty result, and that is a
 * decision rather than an omission: a throw here happens while the module is
 * being evaluated, so it takes the whole file down — the page colour, the fonts,
 * the mark — and blames the CI tar for it. The condition is legitimate in the
 * direction this branch is already moving, too: the day pointer.js moves into
 * the bundle, `static/_v/*.js` is correctly empty. The named list in
 * `searches every file that could hold a second copy` answers the same question
 * more precisely and fails as ONE test naming ONE missing file.
 */
function tree(rel, label, wanted) {
  const base = fileURLToPath(new URL(rel, import.meta.url))
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const at = prefix + entry.name
      if (entry.isDirectory()) walk(join(dir, entry.name), `${at}/`)
      else if (wanted(entry.name)) out.push([`${label}/${at}`, readFileSync(join(dir, entry.name), 'utf8')])
    }
  }
  walk(base, '')
  return out
}

/**
 * A file named the way the rest of the repository names it — the path from the
 * repository root, which is two levels above this test.
 *
 * The point is that a NAME is the only input. Constants that hold a file's text
 * beside a constant that holds its name are two facts nothing ties together:
 * `RAW = new Map([[COMPONENT, STYLE_JSX], …])` was written that way, its guard
 * compared the map against ITSELF, and pointing both names at one file passed
 * 41/41 — taking the "exactly one drawing" check off `style.jsx` while every
 * name still read correctly. Derived from the name there is nothing to point
 * anywhere: a wrong name throws in `readFileSync`, which is the same failure
 * `doc()` gives for a document, and re-deriving is what lets the guard at the
 * bottom of the mark block compare rather than agree with itself.
 */
const fromRepoRoot = (path) => read(`../../${path}`)

const BUILD_HTML = read('../../templates/build.html')
const INDEX_HTML = read('../../templates/index.html')
const SITE_CSS = read('../../static/_v/site.css')

/** CSS with `/* … *\/` comments removed — they name the very values checked. */
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** `<!-- … -->` gone, for the same reason. */
const withoutMarkupComments = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ')


/** The declarations of the first `html,body{…}` rule, as a map. */
function pageRule(source, where) {
  const match = /html\s*,\s*body\s*\{([^}]*)\}/.exec(withoutMarkupComments(withoutComments(source)))
  expect(match, `${where} declares no html,body rule — so it is white until the `
    + 'bundle renders, which is the flash this file exists for').toBeTruthy()
  const out = {}
  for (const decl of match[1].split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim()
  }
  return out
}

// -- the colour of a page before there is a page -----------------------------

describe('the page colour', () => {
  // EVERY DOCUMENT, and each against the value the interface itself uses. The
  // first version of this check compared the resolver against the FRONT page
  // while the resolver's redirect goes to the BUILD page — so the one document
  // on the path stayed unchecked, and changing the viewer's colour left the
  // flash behind with both suites green. There is now one constant and every
  // document is held to it.
  it.each([
    ['templates/build.html', BUILD_HTML],
    ['templates/index.html', INDEX_HTML],
    ['static/_v/site.css', SITE_CSS],
  ])('is the interface\'s own in %s', (where, source) => {
    const rule = pageRule(source, where)
    // `toBe` and not `toContain`, on both: containment passes on
    // `background:linear-gradient(#ff0000,#eceef1)`, where the colour named is
    // present and the page is red. The declaration has to BE the colour.
    expect(rule.background, `${where} paints a different page colour`).toBe(PAGE_BG)
    expect(rule.color, `${where} sets a different text colour`).toBe(PAGE_FG)
  })
})

// -- the header the resolver reproduces --------------------------------------

describe('the resolver\'s copy of the header', () => {
  const css = withoutComments(SITE_CSS)

  it('carries the interface\'s header colours', () => {
    expect(css).toContain(HEADER_BG)
    expect(css).toContain(HEADER_LINE)
  })

  it.each(Object.entries(FONTS))('names the same %s stack', (name, stack) => {
    // Token by token rather than as one squashed string: squashing whitespace
    // AWAY made `"Segoe UI"` and `"SegoeUI"` the same text, so a stack that had
    // lost the space inside a quoted family name passed. Split on commas, trim
    // each family, and let the declaration wrap over as many lines as it likes.
    const families = stack.split(',').map((f) => f.trim())
    const pattern = new RegExp(
      families.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*,\\s*'))
    expect(pattern.test(css), `site.css names a different ${name} stack — two `
      + 'typefaces on one site, drifting apart with nothing reporting it').toBe(true)
  })
})

// -- the mark ----------------------------------------------------------------

describe('the mark', () => {
  // The one value whose stale copy cannot fail harmlessly: a colour that lags
  // looks slightly out of date, a redrawn logo CHANGES WHEN YOU NAVIGATE. So
  // every element is compared as a WHOLE — an earlier check asked only whether
  // each `d` string appeared somewhere in the file, which is why swapping two
  // stroke widths, recolouring one shape and deleting an opacity all passed.
  //
  // THREE DOCUMENTS SINCE 2026-08-28, not two, and the third one changed what
  // this block is about. The mark used to be drawn here — two outlined paths
  // that `style.jsx` authored and `pointer.html` copied — so the only question
  // was whether the copy still matched the original. It is now the designer's
  // drawing, kept as `brand/mark-on-light.svg`, and BOTH renderings are
  // transcriptions of that file: neither can import it (an imported asset would
  // make the bundle emit a second output file; the resolver must not fetch a
  // second thing on the one page whose job is to leave quickly), so there are
  // three copies of one drawing and the file is the one that is right by
  // definition. Both are therefore compared against IT, rather than one against
  // the other — which also means a transcription error is reported against the
  // document that has it instead of as "these two disagree, pick one".
  //
  // AND THE SECOND INK IS HELD TO THE SAME DRAWING. `brand/mark-on-dark.svg` is
  // the pair's other half, for a dark background; nothing renders it until the
  // theme covers the interface (issue #35). An unrendered file is
  // exactly the thing that drifts in silence, so its GEOMETRY is compared here
  // too — the day it is wired in it is provably the same logo, and not a second
  // one that quietly became different while nobody was looking at it.
  //
  // TWO OF THESE CHECKS ASK A DIFFERENT QUESTION, and they are here because
  // "the same drawing" is not the same as "a drawing at all". Everything else
  // in this block parses a document into shapes and attributes and compares
  // those, which means a file can render WRONG while comparing EQUAL: an
  // attribute name misspelled in a way the comparison normalises away
  // (`strokewidth`, `CX`), or an element the parsing does not look at
  // (`<style>` — which is what a drawing editor exports by default, and what
  // the favicon replaced in this same commit actually had). So the raw text is
  // held to two things besides: every attribute name spelled the way SVG spells
  // it, and nothing inside the `<svg>` but shapes.
  //
  // Those two run over a FOURTH document, `static/_v/favicon.svg`, which is not
  // the mark and is compared to it nowhere. It is here because it is the only
  // one of the four that a browser fetches, and because it is where the
  // `<style>` block in the paragraph above actually came from — leaving the
  // proof out of the check it proves is how such a block comes back.
  //
  // `Mark({})` is called rather than rendered: a function component returns its
  // element tree, and the six children are right there in `children` with the
  // props already resolved.

  // Every shape SVG can carry, matched whether it self-closes (`<rect …/>`) or
  // is written with an end tag (`<rect …></rect>`). NO DOCUMENT HERE USES THE
  // SECOND FORM — all four write self-closing tags and none contains a single
  // `</rect>` — so that branch of the regex is uncovered by anything in the
  // repository and is here for the copy somebody pastes out of an editor that
  // writes end tags: it has to be FOUND and then compared, not silently seen as
  // zero elements, which would pass every comparison below by comparing
  // nothing. The tag list is wider than the three kinds the mark draws today
  // (six shapes: a rect, a path and four circles) for the same reason — a copy
  // that redrew a hole as an `<ellipse>` must fail, not be skipped.
  //
  // It is a LIST rather than a literal regex because `draws with nothing but
  // shapes` reads the same list from the other end: anything inside the `<svg>`
  // that is not on it is refused outright, so the two can never disagree about
  // what "a shape" means.
  const SHAPE_TAGS = ['rect', 'circle', 'ellipse', 'path', 'line', 'polyline',
                      'polygon', 'g', 'use']
  const SHAPE = new RegExp(`<(${SHAPE_TAGS.join('|')})\\b([^>]*?)/?>`, 'g')

  // Any element at all, opening or closing, so the check above can name what it
  // found instead of skipping it.
  const TAG = /<\/?([a-zA-Z][\w:.-]*)/g

  // An attribute in ALL THREE FORMS the markup languages allow: double-quoted,
  // single-quoted, and (HTML only) bare. Double quotes alone is what every
  // document here happens to use, and reading only those is not "close enough":
  // an attribute ADDED in the other quoting is not compared against `undefined`
  // on the far side, it is INVISIBLE — it never enters the union of keys, which
  // is the one thing the union was introduced for. Changing an existing one
  // fails either way; adding one is the hole, and it is exactly the shape of
  // edit somebody makes by hand at 2am.
  const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

  /**
   * ONE SPELLING OF AN ATTRIBUTE NAME, applied to both sides before either is
   * looked up: lower case, hyphens gone. `strokeWidth` in JSX and
   * `stroke-width` in a document both land on `strokewidth`.
   *
   * Not React's own table, and deliberately not: React hyphenates most
   * presentation attributes (`strokeWidth` -> `stroke-width`) and leaves a
   * handful of SVG ones camelCase (`viewBox`, `preserveAspectRatio`), so a
   * one-way translation has to KNOW which — and getting that wrong does not
   * fail loudly, it compares an attribute against `undefined` on the other side.
   *
   * WHAT IT GIVES UP IS BOTH HALVES OF WHAT IT COLLAPSES, and neither is
   * harmless in a document — this is the correction of a claim that stood here
   * and was wrong. Case: `CX=` is a different, unknown attribute in XML, so the
   * circle keeps its radius and its ink and SLIDES to `cx`'s default of 0 — a
   * hole punched off the ribbon, at the left edge of the box. The hyphen:
   * `strokewidth` is not in the HTML parser's rewriting table and is not an SVG
   * presentation attribute either, so the ribbon's arc is drawn at `stroke-width`'s
   * default of 1 — a hair where the mark has a band.
   * Both were verified to survive against every one of the documents. And
   * the danger is not two VALID names colliding (SVG has no such pair); it is
   * an INVALID name collapsing onto a valid one, which is a much easier thing
   * to write by accident.
   *
   * So the collapse is only allowed to happen where the far side is React,
   * which has no other spelling to offer. Every name as WRITTEN in a document
   * is held to `SPELLINGS` by `writes every attribute name the way SVG spells
   * it`, and that check is what makes this function safe rather than merely
   * convenient.
   */
  const canon = (key) => key.toLowerCase().replace(/-/g, '')

  /** `<rect x="11" y='5' width=9>` -> `{ x: '11', y: '5', width: '9' }`. */
  const attrsOf = (text) => Object.fromEntries([...text.matchAll(ATTR)]
    .map(([, key, dq, sq, bare]) => [canon(key), dq ?? sq ?? bare]))

  /**
   * THE EXACT SPELLING OF EVERY ATTRIBUTE THESE DOCUMENTS MAY USE.
   *
   * A closed vocabulary that FAILS CLOSED: a name not on it is a failure, not a
   * skip, so this is not the "list somebody chose" that has bitten this file
   * three times — that failure mode is a check looking at a SUBSET of what it
   * claims to examine, and this one refuses everything outside the list. Adding
   * an attribute to the mark therefore costs one line here, spelled once,
   * deliberately, with the case and the hyphens looked at.
   *
   * It is wider than what is drawn today on purpose: the entries that nothing
   * uses are the correct spellings of the attributes somebody would REACH for
   * next, so the failure they produce says "you spelled it wrong" rather than
   * "this test has not heard of it".
   */
  const SPELLINGS = [
    // The root
    'xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio',
    'role', 'aria-hidden', 'aria-label', 'class', 'id', 'style',
    // Geometry
    'x', 'y', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2',
    'd', 'points', 'transform', 'href',
    // Paint
    'fill', 'fill-opacity', 'fill-rule', 'opacity',
    'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray',
  ]

  it('allows exactly the elements it says it allows', () => {
    // THE ONE LIST HERE THAT MUST NOT GROW QUIETLY, and the only one whose
    // guard is membership rather than a property. `SPELLINGS` may grow freely —
    // a new attribute still gets compared, because the comparison is a union of
    // both sides. `SHAPE_TAGS` is the opposite: it is the definition of "an
    // element this file knows how to compare", read from both ends, so widening
    // it does not extend a check, it EXEMPTS whatever was added.
    //
    // For the three documents whose geometry is compared that is survivable —
    // a new element changes the shape count and fails. For the FAVICON it is
    // not: its geometry is compared with nothing, so `draws with nothing but
    // shapes` is its only structural check, and adding a tag here removes it
    // outright. Both halves of that were tried and both passed.
    //
    // The realistic path is not sabotage, it is economy: somebody adds a
    // `<title>` to the favicon for a screen reader, reads the failure, and the
    // cheapest thing that makes it green is one word on this list. (The right
    // answer for that case is that the icon already carries `role="img"` and an
    // `aria-label`; if a `<title>` is genuinely wanted, this file has to learn
    // to compare one first.)
    expect([...SHAPE_TAGS].sort(), 'SHAPE_TAGS has changed. Adding an element here '
      + 'exempts it from every comparison in this block rather than including it — for '
      + 'the favicon, whose geometry is compared with nothing, it removes the only '
      + 'structural check there is. Change this list only with that in mind')
      .toEqual(['circle', 'ellipse', 'g', 'line', 'path', 'polygon', 'polyline',
                'rect', 'use'].sort())
  })

  it('knows one spelling per attribute, so canon() cannot merge two of them', () => {
    // The claim `canon` rests on, checked rather than asserted in prose: within
    // the vocabulary these documents may use, no two DIFFERENT valid names
    // collapse to the same key. If a future entry did, the union comparison
    // would silently compare one attribute against another.
    const merged = SPELLINGS.map(canon)
    expect(new Set(merged).size,
      `two entries in SPELLINGS collapse to the same key: ${
        merged.filter((k, at) => merged.indexOf(k) !== at).join(', ')}`)
      .toBe(SPELLINGS.length)
  })

  /**
   * The first `<svg>` in `source`: its attributes, its shapes, and the raw
   * material the two checks about SPELLING and about UNKNOWN ELEMENTS need —
   * neither survives being parsed into the maps, which is why they are carried
   * out rather than recomputed by whoever writes the next check.
   */
  function svgOf(source, where) {
    const clean = withoutMarkupComments(source)
    const open = /<svg\b([^>]*?)\s*>/.exec(clean)
    expect(open, `${where} holds no <svg> at all`).toBeTruthy()
    const after = clean.slice(open.index + open[0].length)
    const close = after.indexOf('</svg>')
    expect(close, `${where} never closes its <svg>`).toBeGreaterThan(-1)
    const body = after.slice(0, close)
    const children = [...body.matchAll(SHAPE)]
      .map(([, tag, attrs]) => ({ tag, attrs: attrsOf(attrs) }))
    expect(children.length, `${where} draws no shapes — every comparison against `
      + 'it would pass by comparing nothing').toBeGreaterThan(0)
    return {
      root: attrsOf(open[1]),
      children,
      tags: [...body.matchAll(TAG)].map(([, tag]) => tag),
      names: [...`${open[1]} ${body}`.matchAll(ATTR)].map(([, name]) => name),
    }
  }

  const mark = Mark({})
  // `[].concat` because a single child is an element and several are an array,
  // and this block must not start passing vacuously the day the mark is drawn
  // with one shape again.
  const drawn = [].concat(mark.props.children).map((el) => ({
    tag: el.type,
    attrs: Object.fromEntries(
      Object.entries(el.props).map(([k, v]) => [canon(k), String(v)])),
  }))

  // EVERY SVG THIS BLOCK IS RESPONSIBLE FOR, NAMED ONCE.
  //
  // Naming them here and checking every list below against this naming is the
  // only thing standing between those lists and the worst failure a check can
  // have — the one `AGENTS.md` describes for `ci/smoke.py`: a probe that
  // quietly stops probing prints nothing, fails nothing and exits 0, so the run
  // is green PRECISELY BECAUSE a check disappeared. Deleting one line from
  // `ROOTS` used to take the resolver's root comparison out of the suite — the
  // comparison this whole block was written for — and both workflows stayed
  // green, with only the test count moving and nobody asserting that.
  //
  // BY NAME AND NOT BY COUNT, for the reason `searches every file that could
  // hold a second copy` gives one screen down: a count moves whenever anybody
  // adds a check, so it gets edited to whatever the run produced rather than
  // thought about. A missing NAME cannot be resolved that way — the failure
  // says which document stopped being checked.
  const COMPONENT = 'ui/src/style.jsx'
  const RESOLVER = 'templates/pointer.html'
  const ON_LIGHT_FILE = 'brand/mark-on-light.svg'
  const ON_DARK_FILE = 'brand/mark-on-dark.svg'
  const FAVICON_FILE = 'static/_v/favicon.svg'

  // EVERY STANDALONE .svg IN THE REPOSITORY, FOUND BY WALKING the two
  // directories that hold one — not written out by hand.
  //
  // The hand-written version of this list said "every SVG in the repository"
  // and meant "the three somebody remembered". Two new .svg files dropped into
  // these directories — one of them served to browsers, both carrying a
  // `<style>` block and misspelled attributes — passed with the suite green,
  // because a list checked against ANOTHER hand-written list is checked against
  // nothing on disk. That is the same defect as `SEARCHED` below before it was
  // computed from the directories, and this is the same fix.
  //
  // NO EXCLUSIONS TODAY, deliberately. `static/_v/` also holds the compiled
  // bundle, but the build emits JavaScript and nothing else (the Makefile's
  // UI_FILES), so there is no generated `.svg` to skip. If one ever appears it
  // fails here loudly, which is the right way round: a drawing that is not held
  // to these checks has to be an argued exclusion written out by name, never a
  // file nobody noticed.
  const STANDALONE = [
    ...tree('../../brand', 'brand', (name) => name.endsWith('.svg')),
    ...tree('../../static/_v', 'static/_v', (name) => name.endsWith('.svg')),
  ].map(([where, source]) => [where, svgOf(source, where)])

  // NAME -> PARSED DOCUMENT, and the ONLY way anything below reaches a parse.
  //
  // The lists used to be written as literal `[name, document]` pairs, and the
  // guard over them read the NAME and nothing else — so the pairing could be
  // severed with a one-token edit that left every name in place:
  // `[ON_DARK_FILE, ON_LIGHT, …]` checks the light file twice, and the dark
  // one's root then took an `opacity="0.2"` and a different `viewBox` with 439
  // tests green and the count unmoved. The same edit hid a `<style>` block in
  // the favicon and a second component in `style.jsx`.
  //
  // So a name is now the only thing a list may carry, and the document comes
  // from here. There is nothing left to disagree: `doc()` throws on a name this
  // never found, and the guard at the bottom still checks the pairs by
  // IDENTITY, because "derived by a helper" is a property of today's code and
  // the identity check is a property of the run.
  const PARSED = new Map([
    [RESOLVER, svgOf(fromRepoRoot(RESOLVER), RESOLVER)], ...STANDALONE])

  function doc(name) {
    const found = PARSED.get(name)
    if (found) return found
    throw new Error(`${name} is not among the SVG documents this file found `
      + `(${[...PARSED.keys()].join(', ')}) — it was renamed, moved, or never `
      + 'travelled in the CI tar')
  }

  const POINTER = doc(RESOLVER)
  const ON_LIGHT = doc(ON_LIGHT_FILE)
  const ON_DARK = doc(ON_DARK_FILE)

  // EVERY SVG DOCUMENT, for the two checks about a document being a VALID
  // drawing rather than the same one. Both questions are gone by the time
  // anything is parsed into shapes: how a name was spelled, and what else was
  // inside the `<svg>`.
  //
  // The favicon is in here and in `NAMESPACED` and nowhere else. It is not the
  // mark — its tile, hole size and centring are deliberately its own — so
  // holding it to the geometry would be wrong; but it is the one drawing that
  // ships in the image and is served to browsers, and it is the file whose
  // `<style>` block is the reason the second check exists at all. Leaving the
  // proof out of the check it proves is how that block comes back.
  const DOCUMENTS = [[RESOLVER, POINTER], ...STANDALONE]

  it.each(DOCUMENTS)('%s writes every attribute name the way SVG spells it', (where, doc) => {
    // WHAT MAKES `canon` SAFE, and the check that has to exist for it to be
    // allowed to collapse anything. Three real defects live in this one
    // assertion, each of which renders wrong and each of which `canon` would
    // otherwise wave through: `strokewidth` (unknown attribute, so the arc is
    // drawn at `stroke-width`'s default of 1 and the ribbon becomes a hair),
    // `CX` in an XML file (unknown attribute, so the circle keeps its radius and
    // its ink and slides to `cx`'s default of 0 — a hole punched off the ribbon
    // at the left edge), and `viewbox` in an XML file (no coordinate box at
    // all). The first two are described again above `canon` and, in one line,
    // in `AGENTS.md`; the third is only here, and that is on purpose — a
    // missing coordinate box has its own check now (`declares what a standalone
    // SVG cannot render without`), which is where its consequence is written
    // out. These descriptions have already drifted apart once, so: this is the
    // long version, `canon` is the short one, and `AGENTS.md` is the one line.
    //
    // The HTML document is held to the same spellings even though its parser
    // would forgive the case: there is no reason to allow, in the transcription,
    // a spelling that is broken in the file it is transcribed FROM — and a
    // reader comparing the two side by side should not have to know which of
    // them is the forgiving one.
    for (const name of doc.names) {
      expect(SPELLINGS.includes(name), `${where} writes \`${name}=\`, which is not `
        + 'how SVG spells any attribute this mark uses. If it is a new attribute, add '
        + 'its exact spelling to SPELLINGS; if it is a typo of an existing one, a '
        + 'renderer is ignoring it right now').toBe(true)
    }
  })

  it.each(DOCUMENTS)('%s draws with nothing but shapes', (where, doc) => {
    // NOT HYPOTHETICAL, and the proof shipped in this very commit: the favicon
    // being replaced here carried exactly this — a `<style>` block with `.tile`
    // and `.bar` classes recolouring the drawing — because that is what an
    // editor exports by default. A block like it inside one of these files
    // repaints the mark past every comparison in this file, all of which read
    // presentation ATTRIBUTES off the shapes.
    //
    // The refusal is total rather than a list of elements to look out for:
    // `<style>`, `<defs>`, `<mask>`, `<clipPath>`, `<filter>`, `<text>`,
    // `<image>` and whatever SVG grows next all fail the same way, by not being
    // a shape. Wanting one of them is a real decision — it means this file has
    // to learn to compare it — and it should cost a conversation, not a silence.
    for (const tag of doc.tags) {
      expect(SHAPE_TAGS.includes(tag), `${where} contains a <${tag}>, and nothing here `
        + 'compares one — a drawing is only held to this file through its shapes, so an '
        + 'element outside that set changes the mark invisibly').toBe(true)
    }
  })

  /** `#fff` and `#FFFFFF` as one value; anything that is not a hex as `null`. */
  const colour = (value) => {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
      .exec(String(value).trim())
    if (!hex) return null
    const digits = hex[1].length <= 4
      ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return `#${digits.toLowerCase()}`
  }

  const same = (got, want) => {
    if (got === undefined || want === undefined) return got === want
    // Colours first, and by VALUE rather than by spelling: `#fff` in the
    // designer's file and `#ffffff` in a transcription of it are the same ink,
    // and failing on that would train whoever hits it to stop trusting this.
    const [a, b] = [colour(got), colour(want)]
    if (a || b) return a === b
    // Then numerically where both are numbers, so `1.90` and `1.9` agree — an
    // SVG renderer cannot tell them apart either. The blank guard is what keeps
    // `Number('')`, which is 0, from making an empty attribute equal to "0".
    const [x, y] = [String(got).trim(), String(want).trim()]
    if (x !== '' && y !== '' && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y))) {
      return Math.abs(Number(x) - Number(y)) < 1e-9
    }
    return x === y
  }

  /**
   * Every shape, every attribute, in order — the UNION of both sides' keys.
   *
   * The union is the half that is easy to leave out and expensive to: a fixed
   * list of attribute names cannot see an attribute the copy has and the
   * original does not, so an `opacity=".55"` or a `transform` left behind by an
   * earlier drawing would sit in one rendering of the logo and nowhere else.
   */
  function compare(got, want, where) {
    expect(got.length,
      `${where} draws ${got.length} shapes where the mark has ${want.length}`)
      .toBe(want.length)
    got.forEach((el, at) => {
      expect(el.tag, `${where}: shape ${at} is a <${el.tag}> and the mark's is a `
        + `<${want[at].tag}>`).toBe(want[at].tag)
      for (const key of new Set([...Object.keys(el.attrs), ...Object.keys(want[at].attrs)])) {
        expect(same(el.attrs[key], want[at].attrs[key]),
          `${where}: <${el.tag}> ${at} has ${key}=${JSON.stringify(el.attrs[key])} `
          + `where the mark has ${JSON.stringify(want[at].attrs[key])}`).toBe(true)
      }
    })
  }

  /**
   * The same shapes with the INK taken out, for comparing the two brand files.
   *
   * `fill="none"` survives, and that is the point of testing the value rather
   * than dropping `fill` and `stroke` by name: "this shape is not filled" is a
   * fact about the drawing, not about its colour, so a variant that filled the
   * ribbon's arc has to fail here rather than pass as a recolouring.
   */
  const geometry = (els) => els.map(({ tag, attrs }) => ({
    tag,
    attrs: Object.fromEntries(Object.entries(attrs)
      .filter(([k, v]) => !((k === 'fill' || k === 'stroke') && colour(v)))),
  }))

  /**
   * The two inks a rendering of the mark uses: the ribbon's and the holes'.
   *
   * The holes are the circles and are PUNCHED — painted in the colour of the
   * page behind the mark rather than left transparent — so a rendering of it
   * carries exactly two colours, and which two is what decides whether it is
   * visible on the background it was put on.
   */
  function inks(els, where) {
    const of = { ribbon: new Set(), hole: new Set() }
    for (const { tag, attrs } of els) {
      const painted = attrs.stroke && attrs.stroke !== 'none' ? attrs.stroke : attrs.fill
      const ink = colour(painted)
      expect(ink, `${where}: a <${tag}> is painted ${JSON.stringify(painted)}, `
        + 'which is not a colour this can compare').toBeTruthy()
      of[tag === 'circle' ? 'hole' : 'ribbon'].add(ink)
    }
    for (const part of ['ribbon', 'hole']) {
      expect([...of[part]], `${where} inks the ${part} in more than one colour`).toHaveLength(1)
    }
    return { ribbon: [...of.ribbon][0], hole: [...of.hole][0] }
  }

  /** WCAG relative luminance, 0 (black) to 1 (white). */
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5]
      .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  /**
   * THE ROOT `<svg>`, which the shape comparison structurally cannot see: the
   * children are the INSIDE of the mark, and `size` sets `width`/`height` on
   * the root alone. So 18 -> 20 in style.jsx moved the interface's mark and
   * left the resolver's at 18 with the whole suite green — a logo that changes
   * when you navigate, which is the one defect this describe block exists for,
   * reached through the place nothing else looks.
   *
   * EVERY ATTRIBUTE, as the UNION of both sides, minus a NAMED list of the ones
   * this pair is allowed to disagree on. A written-out `['width', 'height',
   * 'viewBox']` stood here and is the same defect one level up: three names
   * somebody thought of, in the spot the prose calls the dangerous one. An
   * `opacity=".4"`, a `fill` or a `class` on a root repaints the whole mark and
   * passed against that list; each fails against this. Both halves of that
   * sentence were run, for the resolver AND for the designer's files, which had
   * the identical hole one turn later — `viewBox` alone, with everything else
   * on the root unexamined.
   */
  function compareRoot(got, want, excused, where) {
    for (const key of new Set([...Object.keys(got), ...Object.keys(want)])) {
      if (excused.includes(key)) continue
      expect(same(got[key], want[key]),
        `${where} opens its <svg> with ${key}=${JSON.stringify(got[key])} where the `
        + `mark has ${JSON.stringify(want[key])}`).toBe(true)
    }
  }

  /**
   * …and the guard without which the exception list is a permission nobody
   * re-reads: every name on it has to be EXERCISED — present on exactly one of
   * the two sides. The day both sides carry it, it stops covering a real
   * difference and starts standing ready to cover the next one, and this fails
   * so that somebody deletes the line rather than inherits it.
   */
  function excusesAreLive(got, want, excused, where) {
    for (const key of excused) {
      expect((got[key] === undefined) !== (want[key] === undefined),
        `${key} is excused between ${where} and the mark's <svg> root, and both sides `
        + 'now agree on it — the exception has stopped excusing anything and should go')
        .toBe(true)
    }
  }

  // The component's root, as attributes rather than props. `children` is the
  // drawing and is compared as shapes, not here; `mark.props.width` is the
  // rendered `size`, not an ink and not a stroke width.
  const COMPONENT_ROOT = Object.fromEntries(Object.entries(mark.props)
    .filter(([key]) => key !== 'children')
    .map(([key, value]) => [canon(key), String(value)]))

  // `aria-hidden` is a fact about the DOCUMENT rather than about the drawing.
  // The resolver's markup puts the mark next to the literal word `hammerola`
  // and marks it decorative there; `Mark` takes no such prop, so the three call
  // sites inside the bundle cannot say it even if they wanted to. Whether that
  // is right is a question about the pages, not about whether the two drawings
  // are the same one — and it is the ONLY difference between these two roots
  // that a reader cannot see, which is what makes it the only one excused.
  const POINTER_ROOT_MAY_DIFFER = ['aria-hidden'].map(canon)

  // A FILE and a COMPONENT differ in two more ways, both structural. `xmlns` is
  // what makes a standalone document an SVG at all and is meaningless inline —
  // the HTML parser supplies the namespace itself. `width`/`height` are the
  // other direction: an asset has no size of its own, while the component's are
  // `size` and vary by call site. Everything else on those roots — `viewBox`,
  // and any `opacity`, `fill`, `class` or `style` somebody adds — has to match.
  const FILE_ROOT_MAY_DIFFER = ['xmlns', 'width', 'height'].map(canon)

  it('is the drawing in brand/mark-on-light.svg, ink and all', () => {
    // THE FILE IS THE ORIGINAL and the component is the transcription, so this
    // is the comparison the other two hang off: get it right and a redraw is
    // "edit the file, then make these agree with it"; leave it out and the
    // designer's file is decoration that happens to sit in the repository.
    compare(drawn, ON_LIGHT.children, 'ui/src/style.jsx')
  })

  it('is drawn the same way on the resolver page', () => {
    // AGAINST THE FILE, not against the component, which is what the prose at
    // the top of this block says and what the argument used to contradict. The
    // triangle closes either way, but a transcription error should be reported
    // against the document that has it rather than as "these two disagree".
    compare(POINTER.children, ON_LIGHT.children, 'templates/pointer.html')
  })

  it('is the same drawing in brand/mark-on-dark.svg, only inked differently', () => {
    // Geometry, deeply, because this file is not rendered by anything yet and
    // an unrendered copy is the one that drifts without a symptom. Its ink is
    // SUPPOSED to differ, so the ink is taken out here and checked below.
    expect(geometry(ON_DARK.children)).toEqual(geometry(ON_LIGHT.children))
  })

  // Written once, because the two tests below have to look at the SAME three
  // roots with the SAME exceptions: a document that quietly appeared in one
  // list and not the other would be compared with an exception nothing proves
  // is still live, which is precisely the state the second test exists to make
  // impossible.
  //
  // A NAME AND ITS EXCEPTIONS, with the document fetched by `doc()` — never
  // written beside the name, which is how the two came apart before.
  const ROOTS = [
    [RESOLVER, POINTER_ROOT_MAY_DIFFER],
    [ON_LIGHT_FILE, FILE_ROOT_MAY_DIFFER],
    [ON_DARK_FILE, FILE_ROOT_MAY_DIFFER],
  ].map(([name, excused]) => [name, doc(name), excused])

  it.each(ROOTS)('%s opens the same <svg> as the component', (where, doc, excused) => {
    compareRoot(doc.root, COMPONENT_ROOT, excused, where)
  })

  it.each(ROOTS)('%s excuses only root attributes that are there to excuse',
    (where, doc, excused) => {
      excusesAreLive(doc.root, COMPONENT_ROOT, excused, where)
    })

  // The STANDALONE documents — every `.svg` file here, which is every document
  // except the resolver's inline copy. The favicon is on this list for the
  // strongest reason of the three: it is fetched by a browser as a document of
  // its own.
  const NAMESPACED = STANDALONE

  it.each(NAMESPACED)('%s declares what a standalone SVG cannot render without',
    (where, document) => {
      // The half of `xmlns` and `viewBox` that being excused on the root above
      // must not take away. These are STANDALONE documents — opened directly by
      // the designer, by an image viewer, by a browser asking for the tab icon
      // — and each attribute is one nothing draws without.
      //
      // BOTH, and not just the namespace, because the pair failed apart: the
      // brand files get their `viewBox` compared against the component's, so
      // theirs is covered by accident of being the mark; the FAVICON's is
      // compared with nothing, and dropping it outright survived while a mere
      // misspelling of the same attribute on the same file was caught. Without
      // a box and without a width the rasteriser falls back to its own default
      // size, a 48-unit drawing lands in the corner of it, and the tab gets a
      // speck — in the one file here that ships in the image and that all three
      // templates link to.
      expect(document.root.xmlns, `${where} declares no SVG namespace, so nothing `
        + 'outside this test renders it at all').toBe('http://www.w3.org/2000/svg')
      const box = document.root[canon('viewBox')]
      expect(/^\s*-?[\d.]+(\s+|\s*,\s*)-?[\d.]+(\s+|\s*,\s*)-?[\d.]+(\s+|\s*,\s*)-?[\d.]+\s*$/
        .test(String(box)), `${where} states no usable viewBox (${JSON.stringify(box)}), `
        + 'so it has no coordinate system: a renderer uses its own default size and the '
        + 'drawing sits in one corner of it').toBe(true)
    })

  // WHICH FILE IS FOR WHICH BACKGROUND, which is the whole reason they are not
  // named after their ink. The designer sent them as `-dark` and `-light`
  // meaning the INK, and read as a theme name each one says the opposite of
  // what it is; putting the wrong one on a page does not look wrong in a diff
  // and does not fail anything else — it is simply a logo the colour of the
  // page it is on, i.e. an empty space where the mark used to be.
  //
  // So the name is turned into an assertion. On a light background the ribbon
  // is the dark ink and the holes show the light page through it; on a dark one
  // both swap. Mid-grey is the threshold, deliberately loose: this is not
  // checking a palette (that would be a fourth copy of the hexes), it is
  // checking that neither file has been swapped for the other.
  // The PAIR, and only the pair: this check is about two files whose names make
  // a promise about a background, which is a thing only they do.
  const INKED = [
    [ON_LIGHT_FILE, 'light'],
    [ON_DARK_FILE, 'dark'],
  ].map(([name, background]) => [name, doc(name), background])

  it.each(INKED)('%s is inked for the background its name promises', (where, doc, background) => {
    const { ribbon, hole } = inks(doc.children, where)
    const onLight = background === 'light'
    expect(luminance(ribbon) < 0.5, `${where} is named for a ${background} background `
      + `and its ribbon is ${ribbon} — on that page the mark is invisible`).toBe(onLight)
    expect(luminance(hole) < 0.5, `${where} is named for a ${background} background `
      + `and punches its holes in ${hole} — the holes show the page through the `
      + 'ribbon, so they are the page\'s colour and not a contrast to it').toBe(!onLight)
  })

  it('uses a different ink on a dark background than on a light one', () => {
    // Otherwise the pair is one file twice and the second is unusable, which is
    // a state the geometry comparison above is perfectly happy with.
    const light = inks(ON_LIGHT.children, ON_LIGHT_FILE)
    const dark = inks(ON_DARK.children, ON_DARK_FILE)
    expect(dark.ribbon).not.toBe(light.ribbon)
    expect(dark.hole).not.toBe(light.hole)
  })


  // WHERE A THIRD COPY COULD APPEAR — a SET, computed from the directories, and
  // not a list of files written out by hand.
  //
  // Two files used to be named here, `HammerolaEntry.jsx` and
  // `HammerolaViewer.jsx`, and that is the same defect as a hardcoded index one
  // level up: a check that says "the only copy" while looking at two places
  // somebody chose. A third copy inlined into `templates/build.html` — a
  // document this very file reads two blocks earlier — passed, and so did a `d`
  // string appearing in `ui/src/hub.js`. It is also how the regression that this
  // block exists for actually happened: a second copy turned up in a component
  // that no hand-written list would have had a reason to contain.
  //
  // Three roots, and each exclusion is a file ALLOWED to hold the mark:
  // `style.jsx` draws it, `pointer.html` is the sanctioned copy this whole block
  // compares, `three-cad-viewer.esm.js` is vendored, and `hammerola*` under
  // static/_v is this bundle COMPILED (AGENTS.md), so it contains style.jsx by
  // construction — the local one really does, which is why the exclusion is
  // load-bearing rather than tidy. `brand/` is not a root at all for the same
  // reason `pointer.html` is excluded from one: it is the original, not a copy.
  //
  // THAT LAST EXCLUSION IS A HOLE, and it is empty by other people's rules
  // rather than by anything decided here: a hand-written `hammerola_widget.js`
  // would be skipped. What keeps the prefix meaning "generated" is `.gitignore`,
  // `.dockerignore` and the named paths in both workflows' tar — none of which
  // this file checks. Narrow the prefix if a hand-written name ever wants it.
  const SEARCHED = [
    ...tree('../src', 'ui/src', (name) => /\.jsx?$/.test(name) && name !== 'style.jsx'),
    ...tree('../../templates', 'templates',
      (name) => name.endsWith('.html') && name !== 'pointer.html'),
    ...tree('../../static/_v', 'static/_v', (name) => name.endsWith('.js')
      && name !== 'three-cad-viewer.esm.js' && !name.startsWith('hammerola')),
  ]

  it('searches every file that could hold a second copy', () => {
    // THE GUARD, and it has to name every file the CI tar sends for this search
    // — one per path on that line, or the sweep silently narrows. It did:
    // `static/_v/pointer_pref.js` was on the tar line and not on this list, so a
    // tar built without it left 19 files and 380 tests green while one of the
    // two files that line was lengthened for stopped being searched at all.
    // `tree()` cannot see that, because the OTHER file in the directory keeps
    // the root non-empty.
    //
    // Named files rather than counts: a count moves whenever anybody adds a
    // module, and would be edited to match rather than thought about.
    const paths = SEARCHED.map(([where]) => where)
    for (const wanted of ['ui/src/HammerolaEntry.jsx', 'ui/src/HammerolaViewer.jsx',
                          'ui/src/hub.js', 'ui/src/viewport/index.js',
                          'templates/build.html', 'templates/index.html',
                          'static/_v/pointer.js', 'static/_v/pointer_pref.js']) {
      expect(paths, `${wanted} is not being searched for a copy of the mark — if it `
        + 'left the tar in both workflows, it left this sweep with it').toContain(wanted)
    }
    expect(paths).not.toContain(COMPONENT)
    expect(paths).not.toContain(RESOLVER)
  })

  // THE OTHER HALF OF THAT SWEEP, and without it the exclusions above are a
  // hole rather than a decision. `SEARCHED` skips the two sanctioned files
  // ENTIRELY, while everything in this block compares exactly ONE drawing out of
  // each: `svgOf` takes the first `<svg>` in the resolver, and `Mark({})` is one
  // component. So a SECOND drawing inside a sanctioned file is invisible from
  // both directions — the sweep does not look, and the comparison looks past it.
  // Both were tried and both were green: a second `<svg>` with drifted geometry
  // at the end of pointer.html, and a second component in style.jsx drawing the
  // same knob with different numbers.
  //
  // The second is not an invented story. Issue #35 puts a second INK of
  // this mark on the roadmap, and the obvious wrong turn is a second component
  // beside `Mark` rather than the two props it already takes — a change that
  // would meet no red test at all.
  //
  // So: count occurrences, require exactly one. Fixing the file exclusion by
  // moving the hole from "files nobody named" down to "occurrences inside the
  // named ones" is not fixing it.
  //
  // ON THE RAW TEXT, comments and all, and that is the correction of a real
  // hole rather than laziness. Stripping comments first meant the regex
  // replaced the WHOLE LINE holding a `//`, so a second drawing vanished from
  // the count the moment it carried a trailing comment — and
  //
  //   export const MarkDark = ({ size = 18 }) => <svg …>…</svg>; // dark variant
  //
  // is exactly what somebody writes for issue #35's second ink. Two tags in the
  // file, one counted, 439 green. Erasing text can only ever hide evidence,
  // never add it; both files hold exactly one `<svg` in their raw bytes today,
  // so the stripping bought nothing at all. If prose here ever wants to write
  // that tag, this fails loudly and the prose is what changes.
  //
  // AND THE TEXT COMES FROM THE NAME. A hand-written `[[COMPONENT, STYLE_JSX],
  // [RESOLVER, POINTER_HTML]]` stood here, and its half of the guard compared
  // that map against itself — so pointing both names at one file passed 41/41
  // and took this check off `style.jsx` entirely, second component and all.
  // `fromRepoRoot` leaves nothing to point: the name IS the path.
  const DRAWN_ONCE = [COMPONENT, RESOLVER].map((name) => [name, fromRepoRoot(name)])

  it.each(DRAWN_ONCE)('%s draws exactly one <svg>, and it is the compared one',
    (where, source) => {
      const drawings = [...source.matchAll(/<svg\b/g)].length
      expect(drawings, `${where} opens ${drawings} <svg> elements. Everything in this `
        + 'block compares the FIRST one, and this file is excluded from the sweep for a '
        + 'second copy, so any other drawing here is checked by nothing. Two ways to be '
        + 'here: a second DRAWING, which needs its own comparison above before this '
        + 'number may move — or the tag written in PROSE, in a comment, which is counted '
        + 'because counting the raw bytes is what keeps a trailing comment from hiding a '
        + 'real one; in that case the prose is what moves').toBe(1)
    })

  it('is the only copy of it outside style.jsx', () => {
    // The build page used to inline the same SVG a third time, byte for byte.
    // The two pages carrying two copies link to each other, which is the exact
    // shape of "the logo changed when I navigated".
    //
    // The `d` of every path the mark draws, and today that is one — the ribbon's
    // turn, `M20 23.5h8a8.5 8.5 0 018.5 8.5v11`, which nothing else in this
    // repository could plausibly contain and which any inlined copy of the mark
    // must. The assertion above it is what keeps that from silently becoming a
    // sweep over an empty list: the mark is drawn with a rectangle and four
    // circles besides, none of which carry a `d`, so a redraw that dropped the
    // arc would leave this loop iterating over nothing and passing.
    expect(drawn.some((el) => el.attrs.d), 'the mark draws no path, so there is no '
      + 'distinctive literal left to sweep for — this check has stopped checking').toBe(true)
    for (const [where, source] of SEARCHED) {
      for (const el of drawn.filter((one) => one.attrs.d)) {
        expect(source.includes(el.attrs.d),
          `${where} draws the mark itself instead of using <Mark />`).toBe(false)
      }
    }
  })

  // -- the lists themselves --------------------------------------------------

  it('finds every standalone SVG in the repository', () => {
    // THE WALK ITSELF, which nothing else can see go wrong. `tree()` does not
    // refuse an empty result — deliberately, one screen up — so a CI tar that
    // stopped carrying `brand/` or `static/_v/favicon.svg` would simply produce
    // a shorter list, and every `it.each` over it would run over fewer files
    // and pass. Naming the three is what turns that into one failure that says
    // which drawing stopped being checked.
    //
    // (Two of them cannot get that far: `doc()` throws at module scope for the
    // brand pair, which takes the whole file down before this runs. The favicon
    // is reached only through the walk, and this is its only guard.)
    const found = STANDALONE.map(([where]) => where)
    for (const wanted of [ON_LIGHT_FILE, ON_DARK_FILE, FAVICON_FILE]) {
      expect(found, `${wanted} was not found by the walk — if it left the tar in both `
        + 'workflows, it left every document-level check with it').toContain(wanted)
    }
  })

  it.each([
    ['DOCUMENTS', DOCUMENTS, [RESOLVER, ON_LIGHT_FILE, ON_DARK_FILE, FAVICON_FILE], doc],
    ['ROOTS', ROOTS, [RESOLVER, ON_LIGHT_FILE, ON_DARK_FILE], doc],
    ['NAMESPACED', NAMESPACED, [ON_LIGHT_FILE, ON_DARK_FILE, FAVICON_FILE], doc],
    ['INKED', INKED, [ON_LIGHT_FILE, ON_DARK_FILE], doc],
    ['DRAWN_ONCE', DRAWN_ONCE, [COMPONENT, RESOLVER], fromRepoRoot],
  ])('%s names exactly the documents its check applies to', (what, list, wanted, lookup) => {
    // THE LISTS WERE THE LAST UNGUARDED THING IN THIS BLOCK. Every check above
    // is an `it.each` over one of them, so deleting ONE LINE took a whole check
    // out of the suite with both workflows green. Six such deletions were tried
    // and all six passed — including "drop the resolver from ROOTS", which
    // removes the root comparison this entire describe block exists for.
    // Nothing moved but the test count, and no test asserts the test count.
    //
    // That is the failure `AGENTS.md` names as the worst one a gate can have: a
    // probe that quietly stops probing prints nothing, fails nothing and exits
    // 0, so the run is green BECAUSE a check disappeared. `SEARCHED` above has
    // been guarded against exactly this for three rounds, by NAMES; the lists
    // added since were not, and this is that same guard applied to them.
    //
    // BY NAME AND NOT BY COUNT, for the reason the guard above gives: a count
    // moves whenever anybody adds anything, so it gets edited to whatever the
    // run produced rather than thought about. Exact set equality in both
    // directions — a missing name is a check that silently stopped running for
    // that file, and an extra one is either a document held to a rule nobody
    // argued for it (the favicon in a geometry comparison, say, which would be
    // wrong: it is deliberately NOT the mark) or a NEW drawing the walk found,
    // which is a thing to acknowledge here rather than to inherit in silence.
    //
    // AND THE PAIRS RE-DERIVED FROM THE NAME, which is the half the first
    // version of this guard left out and the reason it could be walked past. It
    // read the name and never looked at what the row carried beside it, so
    // `[ON_DARK_FILE, ON_LIGHT, …]` satisfied it completely: every name present,
    // every count unchanged, and the dark file checked by nothing at all.
    //
    // `lookup` is a FUNCTION OF THE NAME, not the same container the list was
    // built from, and that distinction is the whole value of this line. The
    // version before it compared `DRAWN_ONCE` against the hand-written map
    // `DRAWN_ONCE` was built from — a registry against itself — which is not a
    // check at all: pointing both of its names at one file passed. `doc()` and
    // `fromRepoRoot()` both go back to the name (a lookup that throws, a read
    // that throws), so a row carrying somebody else's document fails here even
    // though every name still reads correctly.
    //
    // This test is where the regress stops, and it stops here for the same
    // reason `searches every file that could hold a second copy` stops where it
    // does: the names are written out in the assertion, so removing one is
    // removing a name from a test that says what the name is for, not deleting
    // a line whose absence looks like nothing.
    expect([...list.map(([where]) => where)].sort(),
      `${what} does not hold the documents it is supposed to. A name missing here is a `
      + 'check that has silently stopped running for that file; a name added is a file '
      + 'being held to a rule nobody wrote for it').toEqual([...wanted].sort())
    for (const [where, carried] of list) {
      expect(carried, `${what} pairs the name ${where} with a DIFFERENT document, so `
        + `whatever ${where} contains is checked by nothing while every name here still `
        + 'reads correctly').toBe(lookup(where))
    }
  })
})

// -- where the page colour has to sit ----------------------------------------

describe('the build page\'s inline style', () => {
  it('comes after the vendored stylesheet, which also paints the body', () => {
    // Load-bearing, and nothing checked it. three-cad-viewer.css carries
    // `body { background-color: var(--tcv-bg-color) }`, and the library sets
    // `data-theme` ON `document.body` when it first renders — so from that
    // moment the custom property resolves and the rule is live, at the same
    // specificity as ours. Same specificity means source order decides, and
    // ours has to be second or the library repaints the page after
    // initialisation.
    const html = withoutMarkupComments(BUILD_HTML)
    const link = html.indexOf('three-cad-viewer.css')
    const style = html.indexOf('<style>')
    expect(link, 'build.html no longer links the vendored stylesheet').toBeGreaterThan(-1)
    expect(style, 'build.html no longer states the page colour').toBeGreaterThan(-1)
    expect(style).toBeGreaterThan(link)
  })
})
