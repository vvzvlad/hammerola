// A hub whose operator set HUB_NAME / HUB_LOGO: the name and the mark the
// front page and the door draw, and the "Powered by hammerola" line that comes
// with either. The meta tags are what the hub writes into the page
// (`render.brand_page`), so they are what these tests set.

import { afterEach, describe, expect, it } from 'vitest'

import { HammerolaLogin, HammerolaProjects } from '../src/HammerolaEntry.jsx'
import { Mark } from '../src/style.jsx'
import { collect, texts } from './eltree.js'

const POWERED = 'Powered by hammerola'

function setMeta(name, content) {
  const tag = document.createElement('meta')
  tag.setAttribute('name', `hmr-brand-${name}`)
  tag.setAttribute('content', content)
  document.head.appendChild(tag)
}

afterEach(() => {
  document.head.querySelectorAll('meta[name^="hmr-brand-"]').forEach((tag) => tag.remove())
})

function door() {
  const c = new HammerolaLogin({ ...HammerolaLogin.defaultProps, animate: false })
  return HammerolaLogin.prototype.render.call(c)
}

function list() {
  const c = Object.create(HammerolaProjects.prototype)
  c.props = { ...HammerolaProjects.defaultProps, projects: [] }
  c.state = { view: null, sort: null, hover: null }
  return HammerolaProjects.prototype.render.call(c)
}

/** What each `<Mark/>` in the tree draws: its element type and `src`. */
function marks(tree) {
  return collect(tree, (el) => (el.type === Mark ? el.type(el.props) : undefined))
    .map((drawn) => ({ type: drawn.type, src: drawn.props.src }))
}

describe.each([['the door', door], ['the project list', list]])('%s', (_, draw) => {
  it('is hammerola, with no credit line, on a hub nobody branded', () => {
    const tree = draw()
    expect(texts(tree)).not.toContain(POWERED)
    expect(marks(tree).map((m) => m.type)).not.toContain('img')
  })

  it('shows the operator\'s name and mark and credits hammerola', () => {
    setMeta('name', 'Acme CAD')
    setMeta('logo', '/logo')
    const tree = draw()
    expect(texts(tree)).toContain('Acme CAD')
    expect(texts(tree)).not.toContain('hammerola')
    expect(texts(tree)).toContain(POWERED)
    expect(marks(tree)).toContainEqual({ type: 'img', src: '/logo' })
  })

  it('credits hammerola when only the name was replaced', () => {
    setMeta('name', 'Acme CAD')
    const tree = draw()
    expect(texts(tree)).toContain(POWERED)
    expect(marks(tree).map((m) => m.type)).not.toContain('img')
  })

  it('credits hammerola when only the mark was replaced, and keeps the name', () => {
    setMeta('logo', '/logo')
    const tree = draw()
    expect(texts(tree)).toContain(POWERED)
    expect(texts(tree)).toContain('hammerola')
    expect(marks(tree).map((m) => m.type)).toContain('img')
  })
})

describe('the mark', () => {
  it('is the drawing, not an image, until a logo is set', () => {
    expect(Mark({}).type).toBe('svg')
    setMeta('logo', '/logo')
    expect(Mark({ size: 44 }).props.style.height).toBe(44)
  })
})
