// The camera in a link to the model page: `c=`, eleven numbers, so a Share
// link with its Current view box ticked opens on the angle its sender was
// looking from.
//
// Under test is the chain from the address to the viewport: the pair of
// functions that write and read the value (hub.js), the frame an opened
// address carries put on screen by the first model event (on a comparison
// link, the comparison scene's), and the address bar, which never carries the
// frame: the page takes `c=` out as it opens, a scene drawn afresh writes the
// view on screen, and nothing writes the frame back. The viewport is a stub
// that answers `getCamera` and takes `setCamera`; what the library does with a
// frame is element.test.js's subject.
//
// Nothing is rendered: the instance is the real prototype with the state
// spelled out (component.js), and the real methods run over it.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { decodeCamera, encodeCamera, rereadPage } from '../src/hub.js'
import { makeComponent, replaceState } from './component.js'
import { guardPage } from './pageguard.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const HOME = `/project/proj1/${A}/`

// Every test here writes the address; the guard puts it back around each one.
guardPage(HOME)

// `linkOf` silences `console.warn` with a spy: one left standing would swallow
// the next test's warnings.
afterEach(() => { vi.restoreAllMocks() })

/** A frame as the library reports one, with more digits than the address keeps. */
const FRAME = {
  position: [12.3456, -7.891, 99.9999],
  quaternion: [0.123456, -0.654321, 0.5, 0.543219],
  target: [1.234, 0, -3.999],
  zoom: 1.234567,
}

/** The same frame as `c=` spells it. */
const TEXT = '12.35,-7.89,100,0.12346,-0.65432,0.5,0.54322,1.23,0,-4,1.235'

/** The same frame unrounded, as a hand-edited link could carry it. */
const RAW = '12.3456,-7.891,99.9999,0.123456,-0.654321,0.5,0.543219,1.234,0,-3.999,1.234567'

/** The library's own fit, before any frame from the address is put on screen. */
const FITTED = { position: [0, 0, 500], quaternion: [0, 0, 0, 1], target: [0, 0, 0], zoom: 1 }

/** The tree a model event brings: one empty node is enough for `onModel`. */
const TREE = { id: '/model', name: 'model', children: [] }

/** A build with two views, so the address has a `v=` to say. */
const META = {
  project: 'fixture', commit: A, built: '', parts: {},
  views: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: [], gzip: 0 },
          { id: 'print', name: 'print', file: 'p.json', parts: [], gzip: 0 }],
}

/** A viewport whose camera goes where `setCamera` puts it. */
const viewport = (start) => {
  let shown = start
  return {
    getCamera: () => shown,
    setCamera: vi.fn((frame) => { shown = frame }),
  }
}

describe('the value of c=', () => {
  it('is the frame rounded, and reads back as the rounded frame', () => {
    expect(encodeCamera(FRAME)).toBe(TEXT)
    const back = decodeCamera(TEXT)
    expect(back).toEqual({
      position: [12.35, -7.89, 100], quaternion: [0.12346, -0.65432, 0.5, 0.54322],
      target: [1.23, 0, -4], zoom: 1.235,
    })
    expect(encodeCamera(back)).toBe(TEXT)
  })

  it('reads as no camera unless it is exactly eleven finite numbers', () => {
    for (const text of [
      null, '', '1,2,3', '1,2,3,4,5,6,7,8,9,10', '1,2,3,4,5,6,7,8,9,10,11,12',
      '1,2,3,4,5,6,7,8,9,10,x', '1,2,3,4,5,6,7,8,9,,11', '1,2,3,4,5,6,7,8,9,10,Infinity',
    ]) {
      expect(decodeCamera(text), String(text)).toBeNull()
    }
    // And with no frame to read there is no value to write.
    expect(encodeCamera(null)).toBeNull()
  })
})

/** The page as `onModel` sees it, over `el`. */
const page = (el, fields = {}) => makeComponent(HammerolaViewer, {
  setState: replaceState, sync: vi.fn(), host: { current: el }, ...fields,
})

/** What the constructor reads off the address the page is opened on. */
const linkOf = (address) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  window.history.replaceState(null, '', address)
  return new HammerolaViewer({})._linkCamera
}

describe('an address that carries c=', () => {
  it('is taken out of the address as the page opens, before anything is drawn', () => {
    // A document opened or Back pressed before the model is drawn finds no
    // frame in the address to carry along: the page holds it (`_linkCamera`).
    window.history.replaceState({ hmr: 'kept' }, '', `${HOME}?v=print&c=${RAW}&files=K`)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(new HammerolaViewer({})._linkCamera).toEqual(decodeCamera(RAW))
    expect(location.search).toBe('?v=print&files=K')
    expect(history.state).toEqual({ hmr: 'kept' })
  })

  it('opens on that frame, set once by the first model event, with Fit left on the library\'s', () => {
    const el = viewport(FITTED)
    // What the constructor read off the address, handed to a page built by
    // hand the way every fixture in this directory is.
    const c = page(el, {
      _linkCamera: linkOf(`${HOME}?v=print&c=${RAW}`), state: { meta: META, view: 'print' },
    })

    c.onModel({ tree: TREE, view: 'print', live: false })
    expect(el.setCamera).toHaveBeenCalledTimes(1)
    expect(el.setCamera).toHaveBeenCalledWith(decodeCamera(RAW))
    expect(c.home).toEqual(FITTED)
    // And the address names the view on screen and no frame: the one the
    // link came with is spent.
    expect(location.search).toBe('?v=print')

    c.onModel({ tree: TREE, view: 'print', live: false })
    expect(el.setCamera).toHaveBeenCalledTimes(1)
  })

  it('is spent unapplied by a first model event that is live', () => {
    // A live scene keeps the frame the reader already has. The link's frame
    // belongs to the page's first model event, and no later one takes it up.
    const el = viewport(FITTED)
    const c = page(el, { _linkCamera: decodeCamera(TEXT) })
    c.onModel({ tree: TREE, view: 'assembled', live: true })
    expect(el.setCamera).not.toHaveBeenCalled()
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(el.setCamera).not.toHaveBeenCalled()
  })

  it('on a comparison link, is kept for the comparison scene', () => {
    // `load` shows the build's own view first and the comparison scene once
    // the hub has measured it; the frame was taken looking at the scene.
    const linked = linkOf(`/project/proj1/${A}/compare/${B}/?c=${TEXT}`)
    rereadPage(location.pathname)
    const el = viewport(FITTED)
    const c = page(el, {
      _linkCamera: linked,
      state: { compare: true, cmpPair: [A, B], cmpView: 'assembled', cmpStage: null },
    })

    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(el.setCamera).not.toHaveBeenCalled()
    // Out of the address already: the frame waits in the page, not there.
    expect(location.search).toBe('')

    c.setState({ cmpStage: 'ready' })
    c.onModel({ tree: TREE, view: 'compare:assembled', live: false })
    expect(el.setCamera).toHaveBeenCalledTimes(1)
    expect(el.setCamera).toHaveBeenCalledWith(decodeCamera(TEXT))
    expect(location.search).toBe('')
  })

  /** A page opened on a comparison link carrying `c=`, before any model event. */
  const comparisonLink = (state) => {
    const linked = linkOf(`/project/proj1/${A}/compare/${B}/?c=${TEXT}`)
    rereadPage(location.pathname)
    const el = viewport(FITTED)
    const c = page(el, {
      _linkCamera: linked,
      state: { meta: META, compare: true, cmpPair: [A, B], cmpView: 'assembled', ...state },
    })
    return { c, el }
  }

  it('on a comparison link, is dropped when the panel closes before the scene', () => {
    const { c, el } = comparisonLink({ cmpStage: 'running' })
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    c.leaveCompare()
    // The next view drawn afresh fits as any view does.
    c.onModel({ tree: TREE, view: 'print', live: false })
    expect(el.setCamera).not.toHaveBeenCalled()
  })

  it('on a comparison link that cannot be shown, is put on the build\'s own view', async () => {
    // No token: both documents of a comparison are behind it, so no scene is
    // coming, and the reader still gets the angle that was shared.
    const { c, el } = comparisonLink({ cmpStage: null, token: '' })
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(el.setCamera).not.toHaveBeenCalled()
    await c.runCompare([A, B], 'assembled')
    expect(c.state.cmpStage).toBe('locked')
    expect(el.setCamera).toHaveBeenCalledTimes(1)
    expect(el.setCamera).toHaveBeenCalledWith(decodeCamera(TEXT))
    expect(location.search).toBe('')
  })

  it('on a comparison link whose job failed, is put on the build\'s own view', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    onTestFinished(() => { vi.unstubAllGlobals() })
    const { c, el } = comparisonLink({ cmpStage: null, token: 't' })
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(el.setCamera).not.toHaveBeenCalled()
    await c.runCompare([A, B], 'assembled')
    expect(c.state.cmpStage).toBe('failed')
    expect(el.setCamera).toHaveBeenCalledTimes(1)
    expect(el.setCamera).toHaveBeenCalledWith(decodeCamera(TEXT))
    expect(location.search).toBe('')
  })

  it('on a comparison link locked before any view rendered, is taken by the own view', async () => {
    // The order a reader without the token meets: `load` reaches `runCompare`
    // through two state callbacks, before the view's file has been fetched.
    const { c, el } = comparisonLink({ cmpStage: null, token: '' })
    await c.runCompare([A, B], 'assembled')
    expect(el.setCamera).not.toHaveBeenCalled()
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(el.setCamera).toHaveBeenCalledTimes(1)
    expect(el.setCamera).toHaveBeenCalledWith(decodeCamera(TEXT))
    expect(location.search).toBe('')
  })
})

describe('the address bar', () => {
  it('names the view on screen after a view tab and no frame, keeping the rest', () => {
    // `showView` moves no address, so the scene it draws is what writes `v=`.
    window.history.replaceState({ hmr: 'kept' }, '', `${HOME}?d=docs__a.md&files=K`)
    const c = page(viewport(FRAME), { state: { meta: META, view: 'assembled' } })

    c.onModel({ tree: TREE, view: 'print', live: false })
    expect(location.search).toBe('?v=print&d=docs__a.md&files=K')
    expect(history.state).toEqual({ hmr: 'kept' })

    // Back on the first view, which the path already implies: no `v=`.
    c.onModel({ tree: TREE, view: 'assembled', live: false })
    expect(location.search).toBe('?d=docs__a.md&files=K')
  })

  it('is left alone under an open document, and gets no frame once it closes', () => {
    window.history.replaceState(null, '', `${HOME}?d=docs__a.md&files=K`)
    const listing = { ...META, documents: [
      { id: 'docs__a.md', name: 'docs/a.md', type: 'markdown', file: 'docs/a.md', bytes: 9 }] }
    const c = page(viewport(FRAME), { state: { meta: listing, view: 'assembled', doc: 'docs__a.md' } })
    c.writeView('print')
    expect(location.search).toBe('?d=docs__a.md&files=K')
    // `writeDoc` names `d=` and no sheet of the schematic open before.
    window.history.replaceState(null, '', `${HOME}?d=hw__a.kicad_sch&files=K&s=amp`)
    c.writeDoc('docs__a.md')
    expect(location.search).toBe('?files=K&d=docs__a.md')
    c.writeDoc(null)
    expect(location.search).toBe('?files=K')
  })

  it('gets no frame from Fit', () => {
    window.history.replaceState(null, '', `${HOME}?files=K`)
    const el = viewport({ ...FRAME, zoom: 5 })
    const c = page(el, { home: FRAME })
    c.fitView()
    expect(el.setCamera).toHaveBeenCalledWith(FRAME)
    expect(location.search).toBe('?files=K')
  })
})
