// The project's variants on the pages: where an address says which variant
// it is of, the switcher beside the title, Share's `latest`, the comment on a
// variant's draft and the front page's card.
//
// The page sits on `latest` of the variant `ceiling` (`guardPage`), so `PAGE`
// is the real record read off a real address, as every module reads it.

import { describe, expect, it } from 'vitest'

import { commentTarget } from '../src/comments.jsx'
import { DocPage } from '../src/DocShell.jsx'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import {
  buildPath, DEFAULT_VARIANT, pageFrom, pageVariant, projectCard, rereadPage, variantRoot,
} from '../src/hub.js'
import { VariantSwitch, variantChoices } from '../src/variants.jsx'
import { makeComponent } from './component.js'
import { collect, links, texts } from './eltree.js'
import { guardPage } from './pageguard.js'

const CEILING_LATEST = '/project/proj1/v/ceiling/latest/'
guardPage(CEILING_LATEST)

const REV = 'c'.repeat(40)
const LISTING = {
  default: 'main',
  variants: [{ name: 'main', label: 'Wall bracket' },
             { name: 'ceiling', label: 'Потолочный корпус' },
             { name: 'bare', label: 'bare' }],
}

describe('an address', () => {
  it('names the variant of a pointer under `v/`, and none elsewhere', () => {
    expect(pageFrom(CEILING_LATEST)).toEqual({
      pid: 'proj1', slot: 'latest', variant: 'ceiling', base: CEILING_LATEST, cmp: '' })
    expect(pageFrom('/project/proj1/latest/')).toMatchObject({ slot: 'latest', variant: '' })
    expect(pageFrom(`/project/proj1/${REV}/`)).toMatchObject({ slot: REV, variant: '' })
  })

  it('of a variant called `compare` is that variant and not a comparison (criterion 12)', () => {
    expect(pageFrom('/project/proj1/v/compare/latest/')).toMatchObject({
      slot: 'latest', variant: 'compare', cmp: '', base: '/project/proj1/v/compare/latest/' })
  })

  it('of a pointer is its variant\'s, of a revision the one address it has', () => {
    expect(buildPath('proj1', 'latest', 'ceiling')).toBe(CEILING_LATEST)
    expect(buildPath('proj1', 'dev', 'ceiling')).toBe('/project/proj1/v/ceiling/dev/')
    expect(buildPath('proj1', 'latest', DEFAULT_VARIANT)).toBe('/project/proj1/latest/')
    expect(buildPath('proj1', 'latest')).toBe('/project/proj1/latest/')
    expect(buildPath('proj1', REV, 'ceiling')).toBe(`/project/proj1/${REV}/`)
    expect(variantRoot('proj1', 'ceiling')).toBe('/project/proj1/v/ceiling/')
  })
})

describe('the variant a page is of', () => {
  it('is the address\'s on a pointer, whatever the build it shows says', () => {
    // A branch with no commit of its own shows a revision of `main`.
    expect(pageVariant(pageFrom(CEILING_LATEST), { variant: 'main' })).toBe('ceiling')
    expect(pageVariant(pageFrom('/project/proj1/dev/'), { variant: 'ceiling' })).toBe('main')
  })

  it('is the revision\'s own on a revision, and the default without one (criterion 9)', () => {
    const revision = pageFrom(`/project/proj1/${REV}/`)
    expect(pageVariant(revision, { variant: 'ceiling' })).toBe('ceiling')
    expect(pageVariant(revision, {})).toBe('main')
    expect(variantChoices(LISTING, 'proj1', pageVariant(revision, { variant: 'ceiling' })).label)
      .toBe('Потолочный корпус')
  })
})

describe('the switcher', () => {
  it('offers every variant by its label, each row a link to its latest (criterion 2)', () => {
    const choices = variantChoices(LISTING, 'proj1', 'ceiling')
    expect(choices.label).toBe('Потолочный корпус')
    expect(choices.rows.map((r) => [r.label, r.href, r.current])).toEqual([
      ['Wall bracket', '/project/proj1/latest/', false],
      ['Потолочный корпус', CEILING_LATEST, true],
      ['bare', '/project/proj1/v/bare/latest/', false],
    ])
  })

  it('is not there for a project of one variant, or with no list', () => {
    expect(variantChoices({ default: 'main', variants: [{ name: 'main', label: 'x' }] },
                          'proj1', 'main')).toBe(null)
    expect(variantChoices(null, 'proj1', 'main')).toBe(null)
    expect(VariantSwitch({ choices: null })).toBe(null)
  })

  it('draws the rows as links', () => {
    const drawn = VariantSwitch({ choices: variantChoices(LISTING, 'proj1', 'ceiling'), open: true })
    expect(links(drawn).map((a) => a.props.href)).toEqual([
      '/project/proj1/latest/', CEILING_LATEST, '/project/proj1/v/bare/latest/'])
  })

  /** The model's page on `latest` of `ceiling`, with or without the token. */
  const page = (token) => makeComponent(HammerolaViewer, {
    state: {
      meta: { project: 'fixture', commit: REV, built: '2026-10-26T10:00:00Z', parts: {},
              views: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: [], gzip: 1 }] },
      builds: token ? { has_dev: false, latest: REV, builds: [{ commit: REV, built: '' }],
                        files_keys: { latest: 'key-of-latest', [REV]: 'key-of-rev' } } : null,
      variants: LISTING, token,
    },
  })

  it('is the same for a reader with no token (criterion 2)', () => {
    const viewer = page(null).computed()
    const owner = page('sekrit').computed()
    expect(viewer.variantChoices).toEqual(owner.variantChoices)
    expect(viewer.variantChoices.label).toBe('Потолочный корпус')
  })

  it('is beside the title on the page of documents too', () => {
    const tree = DocPage({
      meta: { title: 'Wall bracket', commit: REV, documents: [{ id: 'a.md', file: 'a.md', name: 'a.md', type: 'markdown' }] },
      active: 'a.md', base: CEILING_LATEST, onPick: () => {},
      variants: variantChoices(LISTING, 'proj1', 'ceiling'),
    })
    const [drawn] = collect(tree, (el) => (el.type === VariantSwitch ? el : undefined))
    expect(texts(VariantSwitch(drawn.props))).toContain('Потолочный корпус')
  })

  it('shares `latest` of the variant on screen (criterion 7)', () => {
    const c = page('sekrit')
    c.computed().revRows.find((r) => r.key === 'latest').onShare({ stopPropagation() {} })
    expect(c.computed().shareLink).toBe(`${location.origin}${CEILING_LATEST}`)
    c.computed().toggleShareFiles()
    expect(c.computed().shareLink).toBe(`${location.origin}${CEILING_LATEST}?files=key-of-latest`)
  })
})

describe('a comment on a draft', () => {
  it('goes to the slot of the variant the address names (criterion 8)', () => {
    rereadPage('/project/proj1/v/ceiling/dev/')
    try {
      expect(commentTarget({ commit: 'dev' })).toBe('v/ceiling/dev')
      expect(commentTarget({ commit: REV })).toBe(REV)
    } finally {
      rereadPage(CEILING_LATEST)
    }
    rereadPage('/project/proj1/dev/')
    try {
      expect(commentTarget({ commit: 'dev' })).toBe('dev')
    } finally {
      rereadPage(CEILING_LATEST)
    }
  })
})

describe('the front page\'s card', () => {
  it('says how many variants a project has when it has more than one (criterion 6)', () => {
    expect(projectCard({ pid: 'p', variants: 2 }).variants).toBe('2 variants')
    expect(projectCard({ pid: 'p', variants: 1 }).variants).toBe('')
    expect(projectCard({ pid: 'p' }).variants).toBe('')
  })
})
