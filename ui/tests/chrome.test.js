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

const BUILD_HTML = read('../../templates/build.html')
const INDEX_HTML = read('../../templates/index.html')
const POINTER_HTML = read('../../templates/pointer.html')
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

describe('the resolver\'s copy of the mark', () => {
  // The one value whose stale copy cannot fail harmlessly: a colour that lags
  // looks slightly out of date, a redrawn logo CHANGES WHEN YOU NAVIGATE. So
  // each path is compared as a WHOLE — the earlier check asked only whether each
  // `d` string appeared somewhere in the file, which is why swapping the two
  // stroke widths between the paths, recolouring the second one, and deleting
  // the opacity all passed.
  //
  // `Mark({})` is called rather than rendered: a function component returns its
  // element tree, and the two `<path>` elements are right there in `children`
  // with the props already resolved — including `width * 0.75`, which no reader
  // of the source would compute correctly by eye.
  const attrsOf = (text) => Object.fromEntries(
    [...text.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map(([, k, v]) => [k, v]))

  const mark = Mark({})
  // `[].concat` because one child is an element and two are an array, and this
  // block must not start passing vacuously the day the mark is drawn with a
  // single path.
  const drawn = [].concat(mark.props.children)
  const markup = withoutMarkupComments(POINTER_HTML)
  const parsed = [...markup.matchAll(/<path\b([^>]*)\/>/g)].map(([, attrs]) => attrsOf(attrs))
  const root = attrsOf((/<svg\b([^>]*)>/.exec(markup) || [, ''])[1])

  const same = (html, jsx) => {
    if (html === undefined || jsx === undefined) return html === jsx
    const a = Number(html)
    const b = Number(jsx)
    // Numerically where both are numbers: `1.6 * 0.75` is 1.2000000000000002 in
    // this language and `1.2` in the file, and an SVG renderer cannot tell them
    // apart.
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.abs(a - b) < 1e-9
    return String(html) === String(jsx)
  }

  it('draws the same number of paths', () => {
    expect(drawn.length).toBeGreaterThan(0)
    expect(parsed).toHaveLength(drawn.length)
  })

  it('opens the same <svg> as the component', () => {
    // THE ROOT, which the path comparison structurally cannot see: the children
    // are the INSIDE of the mark, and `size` sets `width`/`height` on the root
    // alone. So 18 → 20 in style.jsx moved the interface's mark and left the
    // resolver's at 18 with the whole suite green — a logo that changes when
    // you navigate, which is the one defect this describe block exists for,
    // reached through the one attribute nothing below compares. `viewBox` is
    // here from the other end: a root that keeps its size and changes its box
    // redraws every path at a different scale, with every `d` still identical.
    //
    // `mark.props` is the <svg> ELEMENT's props, so `mark.props.width` is the
    // rendered `size` — not `Mark`'s own `width` parameter, which is the stroke
    // width and is compared with the paths below.
    for (const key of ['width', 'height', 'viewBox']) {
      expect(same(root[key], mark.props[key]),
        `pointer.html opens its <svg> with a different ${key}`).toBe(true)
    }
  })

  // EVERY path, by index taken from the component rather than written out here.
  // `[0, 1]` was hardcoded, so adding a third path to `Mark` and a third,
  // entirely different one to pointer.html passed — the same shape as the
  // `d`-appears-somewhere check this replaced, one round later: "each" declared
  // in the prose, the first two compared in the code.
  it.each(drawn.map((_, at) => at))(
    'draws path %i with every attribute the component gives it', (at) => {
      const want = drawn[at].props
      const got = parsed[at]
      expect(got.d).toBe(want.d)
      expect(same(got.stroke, want.stroke)).toBe(true)
      expect(same(got['stroke-width'], want.strokeWidth)).toBe(true)
      expect(same(got.opacity, want.opacity)).toBe(true)
      expect(same(got.fill, want.fill)).toBe(true)
    })

  // WHERE A THIRD COPY COULD APPEAR — a SET, computed from the directories, and
  // not a list of files written out by hand.
  //
  // Two files used to be named here, `HammerolaEntry.jsx` and
  // `HammerolaViewer.jsx`, and that is the same defect as the `[0, 1]` above one
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
  // load-bearing rather than tidy.
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
    expect(paths).not.toContain('ui/src/style.jsx')
    expect(paths).not.toContain('templates/pointer.html')
  })

  it('is the only copy of it outside style.jsx', () => {
    // The build page used to inline the same SVG a third time, byte for byte.
    // The two pages carrying two copies link to each other, which is the exact
    // shape of "the logo changed when I navigated". EVERY path again, for the
    // reason given above the index list: this looked only at the first one, so a
    // copy that redrew the outline and kept the inner strokes went unnoticed.
    for (const [where, source] of SEARCHED) {
      for (const el of drawn) {
        expect(source.includes(el.props.d),
          `${where} draws the mark's path itself instead of using <Mark />`).toBe(false)
      }
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
