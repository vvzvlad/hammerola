// Renaming on the pages (rename.jsx): the window, the request it makes, where
// the page goes once the hub has published the name, and the pencils that
// open it.
//
// The page sits on `latest` of the variant `ceiling` (`guardPage`).

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { Pencil, RenameWindow } from '../src/rename.jsx'
import { VariantSwitch, variantChoices } from '../src/variants.jsx'
import { makeComponent } from './component.js'
import { collect, links } from './eltree.js'
import { guardPage } from './pageguard.js'

const CEILING_LATEST = '/project/proj1/v/ceiling/latest/'
guardPage(CEILING_LATEST)

const REV = 'c'.repeat(40)
const LISTING = {
  default: 'main',
  variants: [{ name: 'main', label: 'Wall bracket' }, { name: 'ceiling', label: 'Ceiling case' }],
}
const META = {
  project: 'fixture', title: 'Fixture bracket', commit: REV, built: '2026-10-26T10:00:00Z', parts: {},
  views: [{ id: 'assembled', name: 'assembled', file: 'a.json', parts: [], gzip: 1 }],
  documents: [{ id: 'notes.md', name: 'notes.md', file: 'notes.md', type: 'markdown', bytes: 1 }],
}

/** The model's page on `latest` of `ceiling`, with or without the token. */
const page = (token, state = {}) => makeComponent(HammerolaViewer, {
  state: { meta: META, builds: null, variants: LISTING, token, view: 'assembled', ...state },
})

/** The window, its state written in place as React would. */
function renameWindow(onSave, onClose = () => {}) {
  const w = new RenameWindow({ subject: { kind: 'view', variant: 'ceiling', id: 'assembled', name: 'assembled' },
                               onSave, onClose })
  w.setState = (patch) => Object.assign(w.state, patch)
  return w
}

const field = (w) => collect(w.render(), (el) => (el.type === 'input' ? el : undefined))[0]

/** A press on `pressedOn` and a release on `releasedOn` — 'overlay', 'card'
 *  or 'field' — ending, as in the browser, in a click on the overlay: a click
 *  goes to the nearest element holding both, so a drag between the card and
 *  the overlay ends in a click on the overlay as well. */
function clickOverlay(w, pressedOn, releasedOn = 'overlay') {
  const overlay = w.render()
  const at = { overlay, card: overlay.props.children, field: field(w) }
  overlay.props.onPointerDown({ target: at[pressedOn], currentTarget: overlay })
  overlay.props.onPointerUp({ target: at[releasedOn], currentTarget: overlay })
  overlay.props.onClick({ target: overlay, currentTarget: overlay })
}

/** Writes to `location.href`, which jsdom neither performs nor reports; the
 *  rest of the address read through to the real one. */
function watchNavigation() {
  const real = Object.getOwnPropertyDescriptor(window, 'location')
  const at = () => real.get.call(window)
  const went = []
  const view = {
    get href() { return at().href },
    set href(value) { went.push(value) },
    get pathname() { return at().pathname },
    get search() { return at().search },
    get hash() { return at().hash },
  }
  Object.defineProperty(window, 'location', { configurable: true, get: () => view })
  onTestFinished(() => Object.defineProperty(window, 'location', real))
  return went
}

/** One canned reply of the hub to every fetch. -> the fetch, to read its calls. */
function hubAnswers(reply) {
  const fetch = vi.fn(async () => reply)
  vi.stubGlobal('fetch', fetch)
  onTestFinished(() => { vi.unstubAllGlobals() })
  return fetch
}

/** The rename window the page draws, with `subject` open in it. */
function openWindow(c, subject) {
  c.state.rename = subject
  return collect(c.render(), (el) => (el.type === RenameWindow ? el : undefined))[0]
}

describe('the rename window', () => {
  it('saves what was typed on Enter and closes on Escape', () => {
    const onSave = vi.fn(async () => false)
    const onClose = vi.fn()
    const w = renameWindow(onSave, onClose)
    field(w).props.onChange({ target: { value: 'Front' } })
    field(w).props.onKeyDown({ key: 'Enter' })
    expect(onSave.mock.calls).toEqual([['Front']])

    w.componentDidMount()
    onTestFinished(() => w.componentWillUnmount())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('saves a changed name on a click outside the card, and closes an unchanged one', () => {
    const onSave = vi.fn(async () => false)
    const onClose = vi.fn()
    const w = renameWindow(onSave, onClose)
    clickOverlay(w, 'overlay')
    expect([onSave.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 1])

    field(w).props.onChange({ target: { value: 'Front' } })
    clickOverlay(w, 'overlay')
    expect(onSave.mock.calls).toEqual([['Front']])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('neither saves nor closes on a drag between the card and the outside', () => {
    const onSave = vi.fn(async () => false)
    const onClose = vi.fn()
    const w = renameWindow(onSave, onClose)
    field(w).props.onChange({ target: { value: 'Front' } })
    clickOverlay(w, 'field', 'overlay')
    clickOverlay(w, 'overlay', 'card')
    expect([onSave.mock.calls.length, onClose.mock.calls.length]).toEqual([0, 0])
  })

  it('takes one Save at a time, and takes one again only after a refusal', async () => {
    let answer
    const onSave = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    const w = renameWindow(onSave)
    const saving = w.save()
    w.save()
    field(w).props.onKeyDown({ key: 'Enter' })
    expect(onSave).toHaveBeenCalledTimes(1)
    answer(false)
    await saving
    w.save()
    expect(onSave).toHaveBeenCalledTimes(2)

    // Taken, and the page leaving: no second Save while it goes.
    answer(true)
    await Promise.resolve()
    await Promise.resolve()
    w.save()
    expect(onSave).toHaveBeenCalledTimes(2)
  })
})

describe('a rename sent from the page', () => {
  it('posts the change to /names and then opens the variant\'s latest with the view and the document', async () => {
    const fetch = hubAnswers({ ok: true, status: 200,
                               json: async () => ({ commit: REV, build_url: `/project/proj1/${REV}/` }) })
    history.replaceState(null, '', `${CEILING_LATEST}?v=print&d=notes.md&c=1`)
    onTestFinished(() => history.replaceState(null, '', CEILING_LATEST))
    const went = watchNavigation()
    const c = page('sekrit')

    const win = openWindow(c, { kind: 'variant', variant: 'main', name: 'Wall bracket' })
    expect(await win.props.onSave('Wall mk2')).toBe(true)

    const [url, init] = fetch.mock.calls[0]
    expect([url, init.method, init.headers['X-Hammerola-Token']])
      .toEqual(['/api/v1/projects/proj1/names', 'POST', 'sekrit'])
    expect(JSON.parse(init.body)).toEqual({ variant: 'main', kind: 'variant', name: 'Wall mk2' })
    expect(went).toEqual(['/project/proj1/latest/?v=print&d=notes.md'])
  })

  it('stays on a refusal and toasts the hub\'s sentence', async () => {
    hubAnswers({ ok: false, status: 422,
                 json: async () => ({ error: 'the model or a gate refused the build (failed)' }) })
    const went = watchNavigation()
    const c = page('sekrit')
    const subject = { kind: 'view', variant: 'ceiling', id: 'assembled', name: 'assembled' }

    expect(await openWindow(c, subject).props.onSave('Front')).toBe(false)
    clearTimeout(c._tt)

    expect(c.state.toast).toBe('the model or a gate refused the build (failed)')
    expect(c.state.rename).toBe(subject)
    expect(went).toEqual([])
  })
})

describe('the pencils', () => {
  it('are there only with the token, and each opens the window on its own name', () => {
    const viewer = page(null).computed()
    expect([viewer.renameTitle, viewer.variantRename, viewer.renameView, viewer.viewTabs[0].onRename,
            viewer.docRows[0].onRename].some(Boolean)).toBe(false)

    const c = page('sekrit')
    c.computed().renameView()
    expect(c.state.rename).toEqual({ kind: 'view', variant: 'ceiling', id: 'assembled', name: 'assembled' })
    c.computed().renameTitle()
    expect(c.state.rename).toEqual({ kind: 'project', variant: 'ceiling', name: 'Fixture bracket' })
    c.computed().variantRename(c.computed().variantChoices.rows[0])
    expect(c.state.rename).toEqual({ kind: 'variant', variant: 'main', name: 'Wall bracket' })
    c.computed().docRows[0].onRename()
    expect(c.state.rename).toEqual({ kind: 'document', variant: 'ceiling', id: 'notes.md', name: 'notes.md' })
  })

  it('in a variant\'s row, which is a link, renames that variant and does not follow the link', () => {
    const onRename = vi.fn()
    const choices = variantChoices(LISTING, 'proj1', 'ceiling')
    const [row] = links(VariantSwitch({ choices, open: true, onRename }))
    const [pencil] = collect(row, (el) => (el.type === Pencil ? el : undefined))
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() }

    Pencil(pencil.props).props.onClick(click)

    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
    expect(onRename).toHaveBeenCalledWith(choices.rows[0])
  })
})
