// The documents this bundle does NOT draw, against the values it does.
//
//   * `static/_v/tokens.css` is the ONE place the palette is written down, and
//     all three page templates link it — the whole interface, the pre-paint page
//     colour and the resolver's header are painted from the names in it;
//   * `templates/build.html`, `templates/index.html` and `templates/pointer.html`
//     have to link it, and must not state a colour of their own beside it;
//   * `static/_v/site.css` reproduces the interface's header on the resolver at
//     /project/<pid>/, so that opening a project does not flash another design.
//
// None of them can import JavaScript, so what they carry are NAMES the bundle
// also uses, and a name is only worth anything while both sides still spell it
// the same. What makes this file trustworthy rather than another parser is WHICH
// SIDE is read as text: the interface's values are IMPORTED and executed —
// `PAGE_BG`, `FONTS`, `Mark` — and only the documents, which are static
// declarative files with no comments worth confusing anything, are matched
// against them.
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

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { HammerolaProjects } from '../src/HammerolaEntry.jsx'
import { indexTree, rereadPage } from '../src/hub.js'
import {
  css, FONTS, HEADER_BG, HEADER_LINE, Mark, PAGE_BG, PAGE_FG,
} from '../src/style.jsx'
import { collect, styles } from './eltree.js'

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
const POINTER_HTML = read('../../templates/pointer.html')
const SITE_CSS = read('../../static/_v/site.css')
const TOKENS_CSS = read('../../static/_v/tokens.css')

/** CSS with `/* … *\/` comments removed — they name the very values checked. */
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** `<!-- … -->` gone, for the same reason. */
const withoutMarkupComments = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ')


/** The declarations of a `SELECTOR{…}` rule, as a map. */
function ruleOf(source, selector, where) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
    .exec(withoutMarkupComments(withoutComments(source)))
  expect(match, `${where} declares no ${selector} rule`).toBeTruthy()
  const out = {}
  for (const decl of match[1].split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim()
  }
  return out
}

/** `#fff` and `#FFFFFF` as one value; anything that is not a hex as `null`. */
const colour = (value) => {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
    .exec(String(value).trim())
  if (!hex) return null
  const digits = hex[1].length <= 4
    ? [...hex[1]].map((c) => c + c).join('') : hex[1]
  return `#${digits.toLowerCase()}`
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * Module scope because two blocks need it and it is four lines: `the mark` asks
 * which side of 0.5 an ink is on, to tell the light drawing from the dark one,
 * and the call-site block below turns it into a contrast ratio.
 */
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5]
    .map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * WCAG contrast between two opaque colours, 1:1 to 21:1.
 *
 * THE OTHER QUESTION FROM `deltaE`, and the two are not interchangeable. dE76
 * asks whether a boundary between two fills can be SEEN; this asks whether
 * glyphs of one colour on the other can be READ, which is what a pill with a
 * number in it needs and what the dE floor says nothing about.
 */
function contrast(a, b) {
  // The same guard `deltaE` carries, and for the same reason: `colour()` answers
  // null for the one rgba role in the palette, and `luminance(null)` then throws
  // somewhere that names neither the role nor the theme it came from.
  const of = (value) => {
    const hex = colour(value)
    if (!hex) throw new Error(`contrast was handed ${value}, which is not a hex colour`)
    return luminance(hex)
  }
  const [one, two] = [of(a), of(b)]
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

/**
 * How far apart two colours LOOK, as CIELAB dE76.
 *
 * Sixteen lines of arithmetic rather than a dependency, and worth them: the one
 * question this palette keeps getting wrong is whether two near-identical greys
 * are far enough apart to be seen as two things, and that question has no
 * answer in sRGB. `#f2f3f5` and `#e3e6ea` are 15 apart per channel and
 * `#16181b` and `#1a1d21` are 5 — the second pair is the more visible of the
 * two, because the eye's resolution near black is not the same as near white.
 *
 * dE76 is the crude member of the family (CIE94 and CIEDE2000 correct its
 * hue/chroma weighting) and that is fine here: everything it is asked about is
 * a neutral, where those corrections barely move. ~2.3 is the conventional
 * just-noticeable difference.
 */
function deltaE(a, b) {
  const lab = (value) => {
    const hex = colour(value)
    if (!hex) throw new Error(`deltaE was handed ${value}, which is not a hex colour`)
    const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const [r, g, bl] = [1, 3, 5].map((at) =>
      linear(parseInt(hex.slice(at, at + 2), 16) / 255))
    // sRGB -> XYZ (D65), then XYZ -> L*a*b* against the D65 white point.
    const xyz = [
      (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047,
      0.2126 * r + 0.7152 * g + 0.0722 * bl,
      (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883,
    ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116))
    return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])]
  }
  const [one, two] = [lab(a), lab(b)]
  return Math.hypot(one[0] - two[0], one[1] - two[1], one[2] - two[2])
}

// -- the palette -------------------------------------------------------------
//
// ONE FILE DEFINES IT AND EVERY DOCUMENT REFERENCES IT, which is what this block
// is about and what it replaces. What used to be here compared a colour written
// in `templates/build.html` against a colour written in `templates/index.html`
// against a colour written in `static/_v/site.css` against a constant in the
// bundle — four copies of one value, held together by this test and by nothing
// else, with two MORE copies in site.css that nothing held at all (one of which
// had already drifted: #1f6fd0 against the bundle's #1f7ae0). There is one
// definition now, so what is worth checking has moved with it: that the two
// themes define the same names, that every document links the file instead of
// answering for itself, and that no document has quietly kept a colour of its
// own beside it.

/** `--name: value` pairs of one rule in tokens.css, with duplicates reported. */
function tokensOf(selector) {
  const declarations = ruleOf(TOKENS_CSS, selector, 'static/_v/tokens.css')
  const names = Object.keys(declarations).filter((key) => key.startsWith('--'))
  // `ruleOf` builds a map, so a name written twice would silently keep the last
  // one — which is exactly the edit this block has to fail on, since the two
  // values would be a palette that depends on source order.
  const body = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
    .exec(withoutComments(TOKENS_CSS))[1]
  for (const name of names) {
    const written = [...body.matchAll(new RegExp(`(^|[;{\\s])${name}\\s*:`, 'g'))].length
    expect(written, `tokens.css defines ${name} ${written} times under ${selector} — `
      + 'two values for one role is a palette that depends on source order').toBe(1)
  }
  return Object.fromEntries(names.map((name) => [name, declarations[name]]))
}

const LIGHT = tokensOf(':root')
const DARK = tokensOf(':root[data-theme="dark"]')

describe('the palette', () => {
  it('is defined once per theme, for exactly the same set of roles', () => {
    // The failure this is written for is not a missing file, it is a token
    // added to one theme and forgotten in the other: the interface then paints
    // that one detail in the light colour on a dark page, which is a single
    // unreadable label rather than a page that is obviously wrong.
    expect(Object.keys(DARK).sort(), 'the two themes in static/_v/tokens.css do not '
      + 'define the same roles — whatever is missing from one of them is painted in the '
      + 'other theme\'s colour on that page').toEqual(Object.keys(LIGHT).sort())
    expect(Object.keys(LIGHT).length).toBeGreaterThan(0)
  })

  it('keeps apart the roles that were split because one value could not do both', () => {
    // FOUR ROLES EXIST ONLY AS A DIFFERENCE, and each of them was added after a
    // conversion folded it into its neighbour and something the reader had been
    // using went away (issue #35). A role that exists to be different from
    // another one is a role somebody will later "simplify" by giving it that
    // other one's value — the names stay, both themes stay in step, every other
    // check here stays green, and the distinction is gone a second time.
    //
    // WHAT EACH PAIR CARRIES, so the next person can weigh the simplification
    // rather than guess at it:
    //
    //   accent-bg / accent-bg-soft   the row you PICKED against the row you are
    //                                ON — same hue, adjacent panels, told apart
    //                                by weight and nothing else
    //   accent / accent-muted        a live button against one waiting on the
    //                                network, which is the whole of what says a
    //                                press was taken
    //   accent-line / accent-muted   a border colour against a fill; equal
    //                                values are how the fill goes back to being
    //                                spelled `--accent-line`
    //   warn / warn-soft             a heading in the note box against the
    //                                captions under it, where one ink makes
    //                                three headings
    //   sunken-bg / chip-bg          a surface set INTO its container against a
    //                                shape lying ON it; the test below measures
    //                                what the second one needs that the first
    //                                does not
    const split = [['--accent-bg', '--accent-bg-soft'], ['--accent', '--accent-muted'],
                   ['--accent-line', '--accent-muted'], ['--warn', '--warn-soft'],
                   ['--sunken-bg', '--chip-bg']]
    for (const [role, other] of split) {
      for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
        expect(set[role], `tokens.css defines no ${role} in the ${theme} theme`).toBeTruthy()
        expect(set[other], `tokens.css defines no ${other} in the ${theme} theme`).toBeTruthy()
        expect(set[role], `${role} and ${other} hold one value in the ${theme} theme, so `
          + 'the two things they tell apart are painted the same').not.toBe(set[other])
      }
    }
  })

  it('leaves the pin\'s halo translucent, in both themes', () => {
    // The active comment pin wears `box-shadow: 0 0 0 3px var(--accent-ring)`,
    // and it wears it ON THE MODEL. Opaque, that is a blue disc sitting over
    // the geometry the pin is pointing at — so the alpha is doing a job here
    // rather than softening an edge, and it is the only alpha in the palette
    // that is not a shadow or a floating panel.
    //
    // ONE VALUE FOR BOTH THEMES, like the fill it is made of: the ring is
    // `--accent` spread thin, and `--accent` is one of the two accent roles the
    // dark set does not lift — the other is `--accent-strong`, its hover — for
    // the same reason. White on a fill reads the same whatever is behind the
    // button, so lifting one only makes its label harder to read.
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      expect(set['--accent-ring'], `no --accent-ring in the ${theme} theme`)
        .toMatch(/^rgba\(/)
      const alpha = Number(set['--accent-ring'].split(',').pop().replace(')', '').trim())
      expect(alpha, `--accent-ring is opaque in the ${theme} theme — the halo now `
        + 'hides the geometry the pin is pointing at').toBeLessThan(1)
      expect(alpha).toBeGreaterThan(0)
    }
    expect(DARK['--accent-ring'], 'the halo is the accent FILL spread thin, and that '
      + 'fill is the same in both themes').toBe(LIGHT['--accent-ring'])
  })

  it('keeps a chip visible against every surface a chip is laid on', () => {
    // A CHIP IS ITS EDGES. A pill, a rev-id chip, a segmented track: what says
    // each of them is an object rather than a run of text is the boundary
    // between its fill and the surface under it, and nothing else — no border,
    // no shadow, no weight change. So "can that boundary be seen" is the whole
    // specification of `--chip-bg`, and it is a number rather than a taste.
    //
    // THE FAILURE THIS IS WRITTEN FOR ALREADY HAPPENED. The palette conversion
    // put chips and tracks on `--sunken-bg`, which is the OTHER recessed fill —
    // the one that exists to barely separate, because a field at rest should
    // read as part of its card. On `--header-bg` that took the rail's count
    // pill from dE 6.5 to 1.7, and on the front page it took the switcher track
    // past invisible to inverted: lighter than the page it lies on, a groove
    // drawn as a ridge. Both still rendered, in both themes, with no test
    // anywhere going red.
    //
    // CIELAB AND NOT A CONTRAST RATIO, because WCAG contrast answers a question
    // about TEXT — will these glyphs be legible — and every value here would
    // pass it comfortably while looking like nothing at all. dE76 is the crude
    // one of the perceptual metrics and is right for exactly this: two greys a
    // step apart, where hue barely moves.
    //
    // 2.5 IS THE FLOOR because the just-noticeable difference is about 2.3, and
    // a boundary at the JND is one somebody has to look for. The real values
    // clear it at 2.9 in light and 2.9 in dark on their tightest ground, which
    // is thin — deliberately: this is the check saying the chip may not get any
    // closer to its ground than it already is, not a wide berth.
    const GROUNDS = ['--card-bg', '--header-bg', '--page-bg']
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      for (const ground of GROUNDS) {
        const apart = deltaE(set['--chip-bg'], set[ground])
        expect(apart, `in the ${theme} theme --chip-bg is dE ${apart.toFixed(2)} from `
          + `${ground} — a chip laid on that surface has no edge to see, so it reads `
          + 'as a run of text rather than as an object').toBeGreaterThan(2.5)
      }
    }
  })

  it('paints the page from its own tokens, in the names the interface uses', () => {
    // The pre-paint rule, which is why the palette is a stylesheet and not a
    // JavaScript object: every page here is drawn by something that has not
    // arrived yet, and until it does the body has no background at all.
    //
    // `toBe` and not `toContain`: containment passes on
    // `background:linear-gradient(#ff0000,var(--page-bg))`, where the name is
    // present and the page is red. The declaration has to BE the reference —
    // and the reference is what the bundle imports, so the two cannot drift.
    const rule = ruleOf(TOKENS_CSS, 'html, body', 'static/_v/tokens.css')
    expect(rule.background, 'tokens.css paints the page from something other than the '
      + 'token the interface uses').toBe(PAGE_BG)
    expect(rule.color, 'tokens.css sets the text colour from something other than the '
      + 'token the interface uses').toBe(PAGE_FG)
  })

  it.each([
    ['templates/build.html', BUILD_HTML],
    ['templates/index.html', INDEX_HTML],
    ['templates/pointer.html', POINTER_HTML],
  ])('is linked by %s rather than restated in it', (where, source) => {
    const html = withoutMarkupComments(source)
    expect(html, `${where} does not link the palette, so it is white until whatever `
      + 'draws it arrives — which is the flash this file exists for')
      .toContain('href="/_v/tokens.css"')
    // A document that links the palette AND carries a stylesheet of its own is
    // how the second copy comes back: the link satisfies the check above while
    // the colours on screen come from the block below it.
    expect(/<style[\s>]/.test(html), `${where} carries a <style> block. The palette is `
      + 'one file now; a second statement of it here is the copy that drifts').toBe(false)
  })

  it('is the only thing the resolver\'s mark takes its ink from', () => {
    // templates/pointer.html is the one document that still writes colours out,
    // because its mark is a transcription of the designer's file and is compared
    // against it attribute for attribute. Those two inks are therefore the ONLY
    // colours it may contain — anything else is a value that has escaped the
    // palette on the one page that cannot run a line of our JavaScript.
    const found = [...withoutMarkupComments(POINTER_HTML).matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
      .map(([hex]) => colour(hex)).filter(Boolean)
    expect(found.length, 'templates/pointer.html draws no mark any more, so this check '
      + 'is comparing nothing').toBeGreaterThan(0)
    const inks = [colour(LIGHT['--mark-ink']), colour(LIGHT['--mark-hole'])]
    for (const hex of new Set(found)) {
      expect(inks, `templates/pointer.html writes ${hex}, which is neither of the mark's `
        + 'two inks — every other colour on that page comes from tokens.css').toContain(hex)
    }
  })

  it('hands the vendored viewer its page colour where the library will look', () => {
    // THE RULE THAT LOOKS LIKE A TYPO AND IS NOT, checked because the version
    // before it looked perfectly reasonable and did nothing at all.
    //
    // `Display.setTheme` stamps `data-theme` on `document.body` AND on its own
    // container — the `div.hmr_canvas` our adapter hands it — and the vendored
    // stylesheet declares `--tcv-bg-color` under `[data-theme="…"]`. So the
    // variable is DECLARED on that box, and everything painted from it is a
    // descendant inheriting it from there. This rule was `html[data-theme] body`
    // and therefore reached the document and never the widget: deleting it left
    // both suites green while the canvas kept the library's colour.
    //
    // The property is not specificity alone — `html[data-theme] body` outweighs
    // `[data-theme="dark"]` and still loses, because it never MATCHES the
    // element the declaration is on. What is needed is a selector made of the
    // attribute and nothing else, repeated so it outweighs the library's on the
    // elements they share. A type selector anywhere in it is the old bug.
    const match = /([^{}]+)\{[^}]*--tcv-bg-color\s*:([^;}]+)/.exec(withoutComments(TOKENS_CSS))
    expect(match, 'tokens.css no longer shadows the vendored --tcv-bg-color, so the '
      + 'canvas is the one surface left with its own idea of the theme').toBeTruthy()
    expect(match[2].trim(), 'the shadow no longer resolves to our own token').toBe('var(--canvas-bg)')
    expect(match[1].trim().replace(/\s+/g, ''), 'the --tcv-bg-color shadow is aimed at '
      + `\`${match[1].trim()}\`. It has to be attribute-only — the library stamps its own `
      + 'container as well as the body, and a selector naming an element type cannot reach '
      + 'that box, so the rule would paint nothing while looking right')
      .toMatch(/^(\[data-theme\]){2,}$/)
  })

  it('is what the resolver repaints its mark from', () => {
    // The headline of this stage on the one page that runs no JavaScript: the
    // SVG in pointer.html is inked light in its attributes, and these two
    // declarations are the only thing that makes it follow a dark page. Deleting
    // them is invisible — the mark still draws, in the wrong ink, on a page whose
    // every other colour moved.
    const css = withoutComments(SITE_CSS)
    for (const name of ['--mark-ink', '--mark-hole']) {
      expect(css, `static/_v/site.css does not spend ${name}. The resolver's mark is `
        + 'transcribed with the LIGHT inks in its attributes, so without this rule it stays '
        + 'light on a dark page — and nothing else on that page can repaint it')
        .toContain(`var(${name})`)
    }
  })

  it('is what site.css spends, with nothing of its own left in it', () => {
    // The resolver's chrome used to hold six colours: four copied from the
    // bundle and checked here, two copied and checked nowhere. It holds none.
    const css = withoutComments(SITE_CSS)
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(([hex]) => hex)
    expect(hexes, 'static/_v/site.css writes a colour of its own again. Every one of them '
      + 'is a copy of a value defined in tokens.css, and the two that nothing compared had '
      + 'already drifted apart before this file existed').toEqual([])
    // …and every name it spends is one the palette actually defines, in both
    // themes. A typo here is a declaration the browser drops in silence.
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      expect(LIGHT[name], `static/_v/site.css uses ${name}, which tokens.css does not `
        + 'define — the browser drops that declaration without a word').toBeTruthy()
    }
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
  // the pair's other half, for a dark background. Nothing renders that FILE even
  // now — the mark is a transcription on every page, as the paragraph above says
  // — but its two colours stopped being unused the moment the theme covered the
  // interface (issue #35): they are the dark values of `--mark-ink` and
  // `--mark-hole`, and the last check in this block holds the palette to them.
  // Its GEOMETRY is compared here for the reason it always was — an unrendered
  // file is exactly the thing that drifts in silence — and what has changed is
  // that a drift in it would now be a drift in something on screen.
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

  /**
   * A `var(--…)` reference resolved through the LIGHT palette, anything else
   * unchanged.
   *
   * The component draws the mark in `var(--mark-ink)` / `var(--mark-hole)` so
   * that it follows the page (issue #35), while the designer's file has to hold
   * real ink — it is a document an image viewer opens. Resolving one side here
   * is what keeps the comparison below element-for-element instead of dropping
   * the two attributes that carry the colour: the triangle is component ->
   * token -> file rather than one link shorter, and every link of it fails
   * loudly. LIGHT and not DARK because `brand/mark-on-light.svg` is the file the
   * component is compared against; the dark pair is checked against its own file
   * a few tests down.
   */
  const resolved = (value) => {
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value).trim())
    if (!ref) return value
    expect(LIGHT[ref[1]], `the mark is drawn with ${ref[1]}, which static/_v/tokens.css `
      + 'does not define — the browser drops that attribute and the shape is painted '
      + 'black').toBeTruthy()
    return LIGHT[ref[1]]
  }

  const same = (rawGot, rawWant) => {
    if (rawGot === undefined || rawWant === undefined) return rawGot === rawWant
    const [got, want] = [resolved(rawGot), resolved(rawWant)]
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

  it('takes its two inks from the palette rather than writing them out', () => {
    // THE OTHER HALF OF "the mark follows the page", and the half every
    // comparison in this block is blind to: `resolved()` unwraps a `var()`
    // through the light palette and hands anything else back untouched, so a
    // component that went back to `ink = '#1c1f23'` compares EQUAL to the
    // designer's file and passes — with a mark that stays dark on a dark page
    // wherever the bundle draws it.
    const painted = drawn.flatMap(({ attrs }) => [attrs.fill, attrs.stroke])
      .filter((value) => value !== undefined && value !== 'none')
    expect(painted.length, 'the mark paints nothing, so this is comparing an empty list')
      .toBeGreaterThan(0)
    for (const value of painted) {
      expect(/^var\(--[\w-]+\)$/.test(String(value)), `the mark is drawn with `
        + `${JSON.stringify(value)}. A literal here is a logo that does not follow the `
        + 'theme, and every other check in this block passes on one because it resolves '
        + 'the token before comparing').toBe(true)
    }
  })

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

  it.each(INKED)('%s is the ink the palette draws the mark in', (where, document, background) => {
    // WHAT FINALLY RENDERS THE SECOND FILE. `brand/mark-on-dark.svg` sat in this
    // repository from 2026-08-28 with nothing drawing it, kept only because an
    // unrendered asset is the one that drifts in silence — and everything above
    // could do no more than hold its GEOMETRY to the other file, since no page
    // could choose between the two inks. `--mark-ink` / `--mark-hole` are that
    // choice (issue #35): the component's defaults are those two tokens, and
    // site.css repaints the resolver's transcription from them, so both
    // renderings of the mark follow `data-theme`. This is what says the values
    // in tokens.css are the DESIGNER'S two pairs and not a third pair that looks
    // about right.
    const tokens = background === 'light' ? LIGHT : DARK
    const { ribbon, hole } = inks(document.children, where)
    expect(colour(tokens['--mark-ink']), `the ${background} --mark-ink is not the ribbon `
      + `colour in ${where}`).toBe(ribbon)
    expect(colour(tokens['--mark-hole']), `the ${background} --mark-hole is not the hole `
      + `colour in ${where} — the holes show the page through the ribbon, so a hole that `
      + 'does not follow its ink is a mark with four dots of the other theme in it')
      .toBe(hole)
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

describe('the build page\'s palette link', () => {
  it('comes after the vendored stylesheet, which also paints the body', () => {
    // Load-bearing, and nothing checked it. three-cad-viewer.css carries
    // `body { background-color: var(--tcv-bg-color) }`, and the library sets
    // `data-theme` ON `document.body` when it first renders — which the server
    // now also stamps on `<html>`, so that rule is live from the first paint, at
    // the same specificity as ours. Same specificity means source order decides,
    // and ours has to be second or the library repaints the page out from under
    // the interface.
    const html = withoutMarkupComments(BUILD_HTML)
    const vendored = html.indexOf('three-cad-viewer.css')
    const palette = html.indexOf('tokens.css')
    expect(vendored, 'build.html no longer links the vendored stylesheet').toBeGreaterThan(-1)
    expect(palette, 'build.html no longer links the palette').toBeGreaterThan(-1)
    expect(palette).toBeGreaterThan(vendored)
  })
})

// -- the call sites those measurements are about ------------------------------
//
// EVERY CHECK ABOVE IS ABOUT THE PALETTE FILE, WHICH IS HALF OF THE PROPERTY.
// `--chip-bg` can be dE 2.9 from every ground in both themes while nothing on
// either page still asks for it — and that is not hypothetical: repointing
// every `var(--chip-bg)` in the two components at `--sunken-bg` left the whole
// suite green, and so did `--warn-soft` -> `--warn` and `--accent-ring` ->
// `--accent-line`. Three roles that exist ONLY as a difference, each deletable
// with one search and replace, with the file that measures them agreeing all
// the while.
//
// SO THESE READ THE RENDER AND MEASURE THE PAIR. Not "this style says
// --chip-bg", which is the source copied out with an `expect` around it, but:
// the shape's fill and the surface UNDER it are two different roles, and the
// two values those roles hold are far enough apart, in both themes, to be seen
// as an edge. A call site moved onto the neighbouring neutral fails on the
// number, in the theme where it matters, naming the shape that went invisible
// and what it went invisible against.
//
// WHAT IS ASSERTED IS THE SAME 2.5 the palette block uses, for the same reason:
// the just-noticeable difference is about 2.3, and a boundary at the JND is one
// somebody has to look for.

const REV = 'e05f73ba91b263b8517147e338d23e868533c6a034a342ad5926abb6edcb7b40'

/**
 * The build page, with one comment still open and one already processed.
 *
 * The prototype and a state object spelled out, which is ui/tests/theme.test.js
 * and ui/tests/narrow.test.js's arrangement: `computed()` and `render()` are the
 * real ones and what they drew is read off the returned element objects. The
 * address goes through `rereadPage`, hub.js's own answer for a caller that knows
 * the path before the browser does — `PAGE` is derived from `location` when that
 * module loads, and this runner's location is not a build page.
 */
const COMMENTS = [
  { id: 'c1', commit: REV, view: 'assembled', part: '/model/lid', key: 'lid',
    point: null, text: 'open', status: 'open', created: '2026-08-27T18:25:00Z' },
  { id: 'c2', commit: REV, view: 'assembled', part: '/model/lid', key: 'lid',
    point: null, text: 'done', status: 'resolved', created: '2026-08-27T18:26:00Z' },
]

function buildPage({ feed = COMMENTS } = {}) {
  rereadPage(`/project/proj1/${REV}/`)
  const c = Object.create(HammerolaViewer.prototype)
  c.props = { ...HammerolaViewer.defaultProps }
  c.home = null
  c.host = { current: null }
  c.setState = () => {}
  c.sync = () => {}
  c.state = {
    meta: {
      project: 'fixture', title: 'Fixture bracket', commit: REV,
      built: '2026-08-27T18:20:00Z',
      parts: { lid: { kind: 'printable', files: { stl: 'lid.stl' } } },
      views: [{ id: 'assembled', name: 'assembled', file: 'a.json',
                parts: ['lid'], gzip: 1000 }],
    },
    builds: null,
    tree: indexTree({ id: '/model', name: 'model', children: [] }),
    error: null, viewError: null, pending: null, swapping: false,
    view: 'assembled', tool: null, held: false,
    sel: null, selName: '', hidden: [], ghost: [], expanded: {},
    secOn: false, secOff: 0, secRange: null, secFlip: false, hatch: true,
    secFace: null, secPop: false,
    revOpen: false, dlOpen: false, cmp: [], compare: false, diffShow: 'both',
    bannerGone: false, rail: true, menu: { id: null, x: 0, y: 0 },
    // A note of each kind, so the amber box is drawn with both of its levels.
    notePop: null, noteDraft: '', notes: { lid: 'mine' },
    feed,
    activePin: null, composer: null, sending: false,
    measure: null, toast: null,
    token: 'sekrit', tokenPop: false, tokenDraft: '',
    theme: 'light', tabs: [], narrow: false, treeOpen: false,
  }
  return c
}

/** The front page's signed-in list, as ui/tests/narrow.test.js builds it. */
function projectsPage() {
  const c = Object.create(HammerolaProjects.prototype)
  c.props = { ...HammerolaProjects.defaultProps, projects: [] }
  c.state = { view: null, sort: null, hover: null }
  return HammerolaProjects.prototype.render.call(c)
}

describe('the shapes the palette is measured for', () => {
  /** The one element drawn with `style`, found by the object `css()` cached. */
  function drawnWith(node, style, what) {
    const wanted = css(style)
    const found = collect(node, (el) => (el.props.style === wanted ? el : undefined))
    expect(found, `nothing on the page is drawn with ${what}'s own style`).toHaveLength(1)
    return found[0]
  }

  const REFERENCE = /^var\(\s*(--[\w-]+)\s*\)$/
  const nameOf = (reference) => REFERENCE.exec(reference)[1]

  /** The role a background is painted from, out of a style object or string. */
  function fillOf(style, what) {
    const value = typeof style === 'string'
      ? (/background:\s*(var\(\s*--[\w-]+\s*\))/.exec(style) || [])[1]
      : (style || {}).background
    expect(value, `${what} does not paint its background from the palette`)
      .toMatch(REFERENCE)
    return value
  }

  /** The role an ink is written in, out of a style object or string. */
  function inkOf(style, what) {
    const value = typeof style === 'string'
      // `(?:^|[;\s])` and not a bare `color:`, which also matches the tail of
      // `background-color:` and would answer with the fill.
      ? (/(?:^|[;\s])color:\s*(var\(\s*--[\w-]+\s*\))/.exec(style) || [])[1]
      : (style || {}).color
    expect(value, `${what} does not take its ink from the palette`).toMatch(REFERENCE)
    return value
  }

  /** A shape and its ground: two roles, and how far apart they actually look. */
  function seenAgainst(fill, ground, what) {
    expect(fill, `${what} is filled from the very role that paints the surface under `
      + 'it, so there is no edge to see and the shape is a run of text').not.toBe(ground)
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      const apart = deltaE(set[nameOf(fill)], set[nameOf(ground)])
      expect(apart, `in the ${theme} theme ${what} is dE ${apart.toFixed(2)} from the `
        + `surface under it — ${fill} on ${ground}`).toBeGreaterThan(2.5)
    }
  }

  it('keeps a thread card off the rail\'s own fill', () => {
    // A card lying directly on the rail with no shadow: its fill against the
    // rail's fill is the whole of what says it is an object. The pill saying
    // "N sent here" used to be this pair — the one the conversion got wrong, dE
    // 6.5 down to 1.7 — and it went with issue #33, which put the project's
    // whole queue in the rail and left it nothing to count off against. The
    // cards are what lies on that ground now, and they lie on it in numbers.
    const c = buildPage()
    const open = c.computed().threads.find((t) => !t.resolved)
    expect(open, 'the fixture has no open comment, so this measures nothing').toBeTruthy()
    const rail = drawnWith(c.render(), c.computed().railStyle, 'the comment rail')
    const card = drawnWith(rail, open.style, 'an open thread card')
    seenAgainst(fillOf(card.props.style, 'a thread card'),
      fillOf(c.computed().railStyle, 'the comment rail'), 'a thread card')
  })

  it('keeps the resting count pill readable, and a pill', () => {
    // THE ROUND BEFORE THIS ONE MOVED THIS PILL AND PINNED IT WITH NOTHING, so
    // every number the move was made on lived in a comment: reverting it whole
    // left the suite green, and so did dropping its ink a step. What the pill
    // owes is not a token but a READABLE LABEL — the count is the only thing on
    // it — and the two states are told apart by the fill turning blue rather
    // than by making the resting one faint. That was the defect: faintness was
    // measured in the light theme alone, where white on `--line-strong` is
    // 1.68:1, and came out at 9.89:1 in dark, so the resting pill was the
    // clearer of the two in half the interface.
    const live = buildPage().computed().railCountStyle
    const rest = buildPage({ feed: [] }).computed().railCountStyle
    expect(rest, 'the pill is drawn the same way whether or not anybody is '
      + 'waiting, so nothing on it says which').not.toBe(live)

    const fill = fillOf(rest, 'the resting count pill')
    const ink = inkOf(rest, 'the resting count pill')
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      const ratio = contrast(set[nameOf(ink)], set[nameOf(fill)])
      expect(ratio, `in the ${theme} theme the resting count reads at `
        + `${ratio.toFixed(2)}:1 — ${ink} on ${fill}, under the 4.5 a small label `
        + 'needs').toBeGreaterThanOrEqual(4.5)
    }

    // AND IT IS A SHAPE ON THE BUTTON RATHER THAN A HOLE IN IT: the same role on
    // both is a pill you cannot see, whatever its label reads at.
    expect(fill, 'the resting pill is painted in the very role that paints the '
      + 'button under it, so there is no pill there at all')
      .not.toBe(fillOf(buildPage().computed().railBtnStyle, 'the comments button'))

    // THE COUNT IS DRAWN IN ONE PLACE NOW. The rail's head used to repeat it as
    // "N sent here", and the two copies were held to the same fill and the same
    // ink here; issue #33 took that chip out, because the rail shows the whole
    // project queue and there is nothing left for a count at its head to mean.
    // So this pill is the only one, and the case above is the only measurement
    // it has.
  })

  it('keeps the processed badge off the card it lies on', () => {
    // Both halves come from `computed()` as strings, which is the whole reason
    // this one is cheap: the badge and the card it sits in are two values of one
    // thread. The margin here is the thinnest in the interface — dE 2.88 in dark
    // — which is why it is measured rather than looked at.
    const thread = buildPage().computed().threads.find((t) => t.resolved)
    expect(thread, 'the fixture has no processed comment, so this measures nothing')
      .toBeTruthy()
    seenAgainst(fillOf(thread.pinStyle, 'the processed badge'),
      fillOf(thread.style, 'the thread card'), 'the processed badge')
  })

  it('keeps the front page\'s switcher tracks off the page', () => {
    // The hardest ground in the interface, and the one that inverted: a track
    // lies directly on `--page-bg` with nothing between, so it is the call site
    // where the two recessed fills are a groove and a ridge rather than two
    // shades. Found by their shape — the only elements on that page with a 2px
    // pad and a 2px gap — rather than by the token they are painted in, which
    // would be the source copied out.
    const tracks = styles(projectsPage())
      .filter((s) => s.padding === '2px' && s.gap === '2px')
    expect(tracks, 'the front page draws no segmented track any more, or draws it '
      + 'in another shape — this case is measuring nothing').toHaveLength(2)
    for (const track of tracks) {
      // PAGE_BG is what `html, body` in tokens.css paints, and nothing between
      // the body and these two rows paints anything of its own.
      seenAgainst(fillOf(track, 'a switcher track'), PAGE_BG, 'a switcher track')
    }
  })

  it('writes the note box\'s captions in the quieter of the two ambers', () => {
    // `--warn-soft` exists so a heading and the labels under it are not three
    // headings. What says it is still doing that is not its VALUE but its
    // position: the caption has to sit closer to the panel it is written on than
    // the heading does, in both themes — which is what "a fifth of the way back
    // into `--warn-bg`" means, and what collapsing it into `--warn` undoes.
    const c = buildPage()
    const box = drawnWith(c.render(), c.computed().noteBoxStyle, 'the note box')
    const inks = new Set(styles(box).map((s) => s.color).filter((c2) => REFERENCE.test(c2)))
    expect(inks.has('var(--warn)'), 'the note box has no amber heading').toBe(true)
    expect(inks.has('var(--warn-soft)'), 'the note box writes its two captions in '
      + 'something other than the caption ink, so they read as headings').toBe(true)

    const fill = fillOf(c.computed().noteBoxStyle, 'the note box')
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      const heading = deltaE(set['--warn'], set[nameOf(fill)])
      const caption = deltaE(set['--warn-soft'], set[nameOf(fill)])
      expect(caption, `in the ${theme} theme the note box's captions are ${caption > heading
        ? 'louder' : 'exactly as loud'} as its heading`).toBeLessThan(heading)
    }
  })

  /**
   * PIN_CSS as text, off the render.
   *
   * The one stylesheet this bundle writes, because a pin is placed by the
   * viewport sixty times a second and cannot be a React element — so it arrives
   * here as a `<style>` element's only child rather than as a style object.
   */
  function pinSheet() {
    const found = collect(buildPage().render(),
      (el) => (el.type === 'style' ? el : undefined))
    expect(found, 'the build page injects no stylesheet, so the pins have no rules')
      .toHaveLength(1)
    return String(found[0].props.children)
  }

  /** One rule's declarations out of that sheet, by selector. */
  function pinRule(sheet, selector) {
    const rule = new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(sheet)
    expect(rule, `PIN_CSS no longer carries a ${selector} rule`).toBeTruthy()
    return rule[1]
  }

  it('leaves the active pin\'s halo something the model shows through', () => {
    // The halo is drawn ON the geometry the pin points at, so what matters is
    // not which name is spelled in the rule but that the name resolves to a
    // value with an alpha: an opaque one is a blue disc over the part.
    const halo = /box-shadow:[^;]*var\(\s*(--[\w-]+)\s*\)/
      .exec(pinRule(pinSheet(), '.hmr_pin.is_active'))
    expect(halo, 'the active pin wears no halo from the palette').toBeTruthy()
    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      expect(set[halo[1]], `the ${theme} theme has no ${halo[1]}`).toBeTruthy()
      expect(set[halo[1]], `in the ${theme} theme the pin's halo is ${halo[1]}, which is `
        + 'opaque — a disc of it covers the geometry the pin is pointing at')
        .toMatch(/^rgba\(/)
    }
  })

  it('lifts the picked pin above the ones it overlaps', () => {
    // NOT DECORATION, WHICH IS WHY IT IS HERE AND NOT ONLY IN THE COMMENT ABOVE
    // THE RULE. Two comments left on the same part resolve to one anchor — one
    // catalogue key, one bounding-box centre — so their pins land on the same
    // screen point and only the one appended last can be clicked. The active
    // pin's lift is the way out of that stack: clicking either rail row raises
    // its own pin. Tidying the `z-index` away as a stray declaration during some
    // later pass over the palette would pass every other case in this file.
    expect(pinRule(pinSheet(), '.hmr_pin.is_active'),
      'the picked pin no longer rises above the pins it exactly overlaps, so a '
      + 'second comment on the same part is unreachable on the model')
      .toMatch(/z-index:\s*1\b/)
  })

  it('never lifts a filled accent above the label it carries', () => {
    // WHAT ROUND ONE CAUGHT BY EYE AND NOTHING HELD AFTERWARDS. The dark set
    // lifts the accent INKS, because #1f7ae0 read as a link on near-black is too
    // dim — and `--accent-strong` was lifted with them although it is a FILL:
    // the picked pin here, the hovered button on the front page, both under a
    // white label. At #4e97ea that label came to 3.03:1, below AA and below the
    // 4.27:1 of the state it is the emphasis OF, so picking a pin made its
    // number fainter and the signal ran backwards. Every test passed.
    //
    // READ OFF THE PIN RULES rather than named here, so what is asserted is "the
    // emphasis state of a filled accent, whatever it is painted in" and not a
    // pair of token names copied out of the palette. The pin is a PROXY for the
    // front page's button, which spends the same pair — and that is checked
    // below rather than asserted here, because the day the button moves off the
    // pair is the day this case silently stops covering it.
    //
    // THE RESTING FLOOR IS 4.2 AND NOT 4.5, with the number said out loud: white
    // on `--accent` is 4.27:1 in both themes, under AA for a label this size. It
    // has been that since before this palette existed and moving `--accent` is
    // not this change's business, so the floor sits just under where the value
    // stands — pinning it rather than licensing a quiet slide down to 3.
    const sheet = pinSheet()
    const resting = pinRule(sheet, '.hmr_pin')
    const label = inkOf(resting, 'the comment pin')
    const fills = {
      resting: fillOf(resting, 'the comment pin'),
      picked: fillOf(pinRule(sheet, '.hmr_pin.is_active'), 'the picked comment pin'),
    }
    expect(fills.picked, 'a picked pin is filled exactly like a resting one, so '
      + 'nothing on the model says which comment is open').not.toBe(fills.resting)

    const button = read('../src/HammerolaEntry.jsx')
    for (const fill of [fills.resting, fills.picked]) {
      expect(button, `the front page's button no longer spends ${fill}, so it is `
        + 'no longer the pair measured here and needs a case of its own')
        .toContain(fill)
    }

    for (const [theme, set] of [['light', LIGHT], ['dark', DARK]]) {
      const reads = (fill) => contrast(set[nameOf(fill)], set[nameOf(label)])
      const [rest, picked] = [reads(fills.resting), reads(fills.picked)]
      expect(picked, `in the ${theme} theme the picked pin carries its label at `
        + `${picked.toFixed(2)}:1 against the resting pin's ${rest.toFixed(2)}:1 — the `
        + 'emphasis state is the fainter of the two, so the signal runs backwards')
        .toBeGreaterThan(rest)
      expect(picked, `in the ${theme} theme the picked pin's label reads at `
        + `${picked.toFixed(2)}:1, under the 4.5 a small label needs`)
        .toBeGreaterThanOrEqual(4.5)
      expect(rest, `in the ${theme} theme the resting pin's label reads at `
        + `${rest.toFixed(2)}:1 — it has been 4.27:1 since before this palette, and `
        + 'this floor is here so it cannot quietly drop further').toBeGreaterThanOrEqual(4.2)
    }
  })
})
