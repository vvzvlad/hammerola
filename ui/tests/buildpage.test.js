// The build page's root (BuildPage.jsx): the header over the page the build
// has, and what belongs to neither handed down to both as props.
//
// Read off the element tree `render()` returns (`eltree.js`), on an instance
// whose state is written in place: nothing is mounted. A prop BuildPage does
// not hand down reaches nobody, and a page drawn without it still renders.

import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadBuilds: vi.fn(),
}))

import BuildPage from '../src/BuildPage.jsx'
import DocShell from '../src/DocShell.jsx'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import Header from '../src/Header.jsx'
import { DEFAULT_VARIANT, loadBuilds } from '../src/hub.js'
import { collect } from './eltree.js'

const MODEL = { project: 'fixture', title: 'Fixture', commit: 'abc1234', parts: {}, views: [] }
const DOCUMENTS = { ...MODEL, kind: 'documents', documents: [] }
const LIST = { has_dev: false, latest: null, builds: [] }

/** BuildPage over `meta`, holding a token, the dark theme and the variant's
 *  list, and what it drew: the header and the page. */
function drawn(meta) {
  const b = new BuildPage({ meta })
  Object.assign(b.state, { token: 'sekrit', theme: 'dark', builds: LIST })
  const [header, page] = collect(b.render(),
    (el) => ([Header, DocShell, HammerolaViewer].includes(el.type) ? el : undefined))
  return { b, header, page }
}

describe('the build page', () => {
  it('draws the documents page for `kind: documents` and the model\'s page otherwise, under one header', () => {
    for (const [meta, Page] of [[DOCUMENTS, DocShell], [MODEL, HammerolaViewer]]) {
      const { header, page } = drawn(meta)
      expect([header.type, page.type]).toEqual([Header, Page])
    }
  })

  it('hands either page the build, the token, the theme, the list and its doors', () => {
    for (const meta of [MODEL, DOCUMENTS]) {
      const { b, page } = drawn(meta)
      expect([page.props.meta, page.props.token, page.props.theme, page.props.builds])
        .toEqual([meta, 'sekrit', 'dark', LIST])
      for (const door of ['onBuild', 'onHeader', 'shutHeader', 'onRename']) {
        expect(page.props[door], door).toBe(b[door])
      }
    }
  })

  it('hands the header the same, the page to read and the page\'s menus to shut', () => {
    for (const meta of [MODEL, DOCUMENTS]) {
      const { b, header } = drawn(meta)
      expect([header.props.meta, header.props.token, header.props.theme, header.props.builds])
        .toEqual([meta, 'sekrit', 'dark', LIST])
      for (const door of ['parts', 'shutPage', 'onToken', 'onTheme', 'onRename']) {
        expect(header.props[door], door).toBe(b[door])
      }
    }
  })

  it('reads the variant\'s list with the token on mount, and redraws the header over the page now there', async () => {
    loadBuilds.mockReset()
    loadBuilds.mockResolvedValue(LIST)
    const b = new BuildPage({ meta: MODEL })
    b.state.token = 'sekrit'
    b.setState = (patch) => Object.assign(b.state, patch)
    b.header = { current: { forceUpdate: vi.fn() } }
    b.componentDidMount()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(loadBuilds).toHaveBeenCalledWith('sekrit', DEFAULT_VARIANT)
    expect(b.state.builds).toBe(LIST)
    expect(b.header.current.forceUpdate).toHaveBeenCalled()
  })
})
