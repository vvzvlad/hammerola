// The Files window (files.jsx, filesview.js): the revision's files as a tree,
// and a picked file shown by what it is, every byte from the one address the
// list came from; opened by the header's Files, drawn by BuildPage, and only for
// a reader holding the token, since the hub hands the code of a revision to
// nobody else. On the newest revision it edits: the change set (changeset.js,
// its own suite) lives in BuildPage, and Commit (`commitSet`) sends it.

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import BuildPage from '../src/BuildPage.jsx'
import {
  alreadyThere, changeRows, editText, move, notAPath, putFile, remove, revert, startSet,
} from '../src/changeset.js'
import {
  BRANCH_MOVED, COMMIT_POLL_MS, CONFLICTED, EDITOR_FAILED, FilesWindow, HUB_LOST, NO_FOLDERS, OVER_THEIRS, QUEUED,
  TEXT_REST_MS, commitSet, editingLine, notNewestLine,
} from '../src/files.jsx'
import { baseUrl, decodeText, editorLanguage, fileKind, fileRows, filesId, sourceUrl } from '../src/filesview.js'
import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { HUB_UNREACHABLE, PAGE } from '../src/hub.js'
import { renamedAddress } from '../src/rename.jsx'
import { drained, headerOn, makeComponent } from './component.js'
import { collect, texts } from './eltree.js'

/** The list under Changes (N), as the reader reads it. */
const listed = (set) => changeRows(set).map((row) => `${row.mark} ${row.label}`)
/** A reply of the hub, JSON or text. */
const answer = (status, body) => ({
  status, ok: status >= 200 && status < 300, json: async () => body, text: async () => body,
  blob: async () => new Blob([body]),
})
/** The hub, answering each fetch by `route(url)`; -> the requests it took. */
function hubAnswers(route) {
  const calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push([url, init])
    const reply = route(url, calls.length)
    if (reply instanceof Error) throw reply
    return reply
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  return calls
}

/** A project's files as `GET /api/v1/source/` lists them, in no order of use. */
const LIST = [
  { path: 'project.json', size: 40 },
  { path: 'src/parts/lid.py', size: 1200 },
  { path: 'src/model.py', size: 90 },
  { path: 'README.md', size: 2048000 },
  { path: 'docs/a.md', size: 3 },
]

/** The rows as a reader sees them: indented, a directory marked shut or open. */
const shown = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.dir ? (r.open ? '-' : '+') : ''}${r.name}`)

describe('the rows of the tree', () => {
  it('put directories first, then files, each alphabetically, and only the top level until one is opened', () => {
    expect(shown(fileRows(LIST, {}))).toEqual(['+docs', '+src', 'README.md', 'project.json'])
  })

  it('show an opened directory\'s rows under it, its own directories still shut', () => {
    expect(shown(fileRows(LIST, { src: true }))).toEqual(
      ['+docs', '-src', '  +parts', '  model.py', 'README.md', 'project.json'])
    expect(shown(fileRows(LIST, { src: true, 'src/parts': true }))).toEqual(
      ['+docs', '-src', '  -parts', '    lid.py', '  model.py', 'README.md', 'project.json'])
    // A directory is named by its whole path, a file by the path the hub
    // listed, which is what the window asks for.
    expect(fileRows(LIST, { src: true }).map((r) => [r.path, r.size])).toEqual([
      ['docs', undefined], ['src', undefined], ['src/parts', undefined],
      ['src/model.py', 90], ['README.md', 2048000], ['project.json', 40]])
  })
})

describe('the address of the list', () => {
  it('names the revision on screen on `latest`, which may have moved on, and any other slot as the page does', () => {
    const sha = 'a'.repeat(40)
    expect(sourceUrl({ pid: 'p', slot: 'latest', variant: '' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
    expect(sourceUrl({ pid: 'p', slot: 'latest', variant: 'wide' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
    expect(sourceUrl({ pid: 'p', slot: 'dev', variant: 'wide' }, { commit: 'dev' })).toBe('/api/v1/source/p/v/wide/dev')
    expect(sourceUrl({ pid: 'p', slot: 'dev', variant: '' }, { commit: 'dev' })).toBe('/api/v1/source/p/dev')
    expect(sourceUrl({ pid: 'p', slot: sha, variant: '' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
  })
})

describe('what the window does with a file', () => {
  it('leaves one over 16 MB unfetched, draws a picture or a PDF, and reads the rest as text', () => {
    expect(['ref/rail.step', 'a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.pdf', 'model.py', 'g.3mf', 'Makefile']
      .map((path) => fileKind(path, 1000)))
      .toEqual(['text', 'image', 'image', 'image', 'image', 'image', 'pdf', 'text', 'text', 'text'])
    expect([fileKind('ref/rail.step', 16e6), fileKind('ref/rail.step', 16e6 + 1), fileKind('big.png', 61e6)])
      .toEqual(['text', 'large', 'large'])
  })

  it('takes UTF-8 without a NUL as text, its byte-order mark kept, and anything else as not text', () => {
    const bytes = (...values) => new Uint8Array(values)
    expect(decodeText(new TextEncoder().encode('é = 1\r\n'))).toBe('é = 1\r\n')
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a')
    expect(decodeText(bytes(0xff, 0xfe, 0x61))).toBeNull()
    expect(decodeText(bytes(0x61, 0x00, 0x62))).toBeNull()
  })

  it('highlights Python and JSON, and nothing else', () => {
    expect(['model.py', 'project.json', 'README.md', '__proto__', 'x.PY'].map(editorLanguage))
      .toEqual(['python', 'json', '', '', 'python'])
  })
})

describe('the Files button', () => {
  beforeEach(() => {
    PAGE.pid = 'proj1'
    PAGE.slot = 'latest'
    PAGE.base = '/project/proj1/latest/'
  })

  const header = (token) => headerOn(makeComponent(HammerolaViewer, { state: { token } }))

  it('is drawn for a reader holding the token and not for one without, and Downloads for neither', () => {
    expect(texts(header('sekrit').render())).toContain('Files')
    expect(texts(header(null).render())).not.toContain('Files')
    for (const token of ['sekrit', null]) expect(texts(header(token).render())).not.toContain('Downloads')
  })

  it('opens the window and shuts the header\'s cards and the page\'s menus', () => {
    const h = header('sekrit')
    h.state.tokenPop = true
    h.view().openFiles({ stopPropagation() {} })
    expect([h.props.onFiles.mock.calls.length, h.state.tokenPop, h.props.shutPage.mock.calls.length])
      .toEqual([1, false, 1])
  })
})

describe('the build page', () => {
  const META = { project: 'fixture', title: 'Fixture', commit: 'abc1234def', parts: {}, views: [] }
  beforeEach(() => {
    PAGE.pid = 'proj1'
    PAGE.slot = 'latest'
    PAGE.variant = ''
  })

  const drawn = (b) => collect(b.render(), (el) => (el.type === FilesWindow ? el : undefined))

  it('draws the window when the header asks, on the build on screen, with the token only, until it closes', () => {
    const b = new BuildPage({ meta: META })
    b.setState = (patch) => Object.assign(b.state, patch)
    Object.assign(b.state, { token: 'sekrit' })
    expect(drawn(b)).toHaveLength(0)
    b.onFiles()
    const [w] = drawn(b)
    // Keyed by the build: a draft swapped in under the same address opens it afresh.
    expect([w.props.source, w.props.token, w.key]).toEqual([sourceUrl(PAGE, META), 'sekrit', filesId(PAGE, META)])
    w.props.onClose()
    expect(drawn(b)).toHaveLength(0)
    b.onFiles()
    b.state.token = null
    expect(drawn(b)).toHaveLength(0)
  })

  const SET = editText(startSet('main', META.commit, [{ path: 'model.py', size: 8 }]), 'model.py', 'x', 'y')
  const page = () => {
    const b = new BuildPage({ meta: META })
    b.setState = (patch) => Object.assign(b.state, patch)
    Object.assign(b.state, { token: 'sekrit', files: true })
    return b
  }

  it('lets a first change start a set on the newest revision only, and keeps the window on the set\'s build', () => {
    const b = page()
    let [w] = drawn(b)
    expect([w.props.start, w.props.notNewest]).toEqual([{ variant: 'main', base: META.commit }, null])
    const { key } = w
    b.onSet(SET)
    ;[w] = drawn(b)
    expect([w.key, w.props.source, w.props.set, w.props.start]).toEqual([key, baseUrl('proj1', META.commit), SET, null])
    // An older revision on screen: the window still edits the set, on its build.
    Object.assign(PAGE, { slot: 'old1234' })
    Object.assign(b.state, { meta: { ...META, commit: 'old1234' }, builds: { latest: META.commit } })
    ;[w] = drawn(b)
    expect([w.key, w.props.source]).toEqual([key, baseUrl('proj1', META.commit)])
    // Emptied, the set is gone, and that revision only shows.
    b.onSet(revert(SET, 'base:model.py'))
    ;[w] = drawn(b)
    expect([b.state.set, w.props.start, w.props.notNewest])
      .toEqual([null, null, { variant: 'main', href: renamedAddress('proj1', 'main') }])
    // The revision builds.json calls the newest edits; a draft never does.
    Object.assign(PAGE, { slot: META.commit })
    b.state.meta = META
    expect(drawn(b)[0].props.start).toEqual({ variant: 'main', base: META.commit })
    Object.assign(PAGE, { slot: 'dev' })
    b.state.meta = { ...META, dev: true }
    expect(drawn(b)[0].props.start).toBe(null)
  })

  it('warns before the page is left with a change, after taking the text typed last', () => {
    const b = page()
    b.filesWindow = { current: { flush: vi.fn(() => b.onSet(SET)) } }
    const leaving = { preventDefault: vi.fn(), returnValue: undefined }
    b.onLeave(leaving)
    expect([b.filesWindow.current.flush.mock.calls.length, leaving.preventDefault.mock.calls.length, leaving.returnValue])
      .toEqual([1, 1, ''])
    // Closing the window keeps the set; with nothing in it, leaving is not stopped.
    b.state.files = false
    expect(b.state.set).toBe(SET)
    b.onSet(revert(SET, 'base:model.py'))
    b.filesWindow = { current: null }
    const quiet = { preventDefault: vi.fn() }
    b.onLeave(quiet)
    expect(quiet.preventDefault).not.toHaveBeenCalled()
  })

  it('commits the set and opens the newest revision of its variant, or keeps the set and says why not', async () => {
    const b = page()
    b.leave = vi.fn()
    b.onSet(SET)
    let commit = answer(200, { commit: 'c'.repeat(40), already: true })
    hubAnswers((url) => (url.endsWith('/blob') ? answer(200, { blob: 'b'.repeat(40) }) : commit))
    await b.commitSet([])
    expect([b.leave.mock.calls, b.set]).toEqual([[[renamedAddress('proj1', 'main')]], null])
    b.onSet(SET)
    commit = answer(409, { error: 'changed on the hub since the editor opened: model.py', conflicts: ['model.py'] })
    await b.commitSet([])
    expect([b.state.commit, b.set]).toEqual([{ conflicts: ['model.py'] }, SET])
  })
})

describe('the Files window', () => {
  const SOURCE = '/api/v1/source/proj1/abc1234'
  const LISTED = {
    files: [
      { path: 'model.py', size: 8 }, { path: 'ref/photo.png', size: 3 }, { path: 'ref/sheet.pdf', size: 4 },
      { path: 'print/foot.3mf', size: 3 }, { path: 'ref/rail.step', size: 61e6 }, { path: 'notes.txt', size: 2 },
    ],
  }
  /** What the hub answers for each file: its bytes. */
  const BYTES = {
    'model.py': new TextEncoder().encode('print(1)'),
    'ref/photo.png': new Uint8Array([0x89, 0x50, 0x4e]),
    'ref/sheet.pdf': new TextEncoder().encode('%PDF'),
    'print/foot.3mf': new Uint8Array([0x50, 0x00, 0x03]),
    'notes.txt': new TextEncoder().encode('hi'),
  }
  let asked
  let made
  let mount
  let kept

  beforeEach(() => {
    asked = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      asked.push([url, init.headers['X-Hammerola-Token']])
      if (url === SOURCE) return { status: 200, json: async () => LISTED }
      const bytes = BYTES[decodeURIComponent(url.split('?path=')[1])]
      return { status: 200, arrayBuffer: async () => bytes.buffer, blob: async () => new Blob([bytes]) }
    }))
    made = []
    kept = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = vi.fn((blob) => {
      made.push(blob)
      return `blob:${made.length}`
    })
    URL.revokeObjectURL = vi.fn()
    mount = vi.fn(() => ({ getText: () => '', destroy: vi.fn() }))
    vi.spyOn(FilesWindow.prototype, 'editorModule').mockResolvedValue({ mount })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    URL.createObjectURL = kept.create
    URL.revokeObjectURL = kept.revoke
  })

  /** The window on its list, its state written in place, as React would. */
  async function opened(props = {}) {
    const w = new FilesWindow({
      source: SOURCE, token: 'sekrit', theme: 'dark', subtitle: 'fixture · main · abc1234',
      toast: vi.fn(), onClose: vi.fn(), ...props,
    })
    w.setState = (patch) => Object.assign(w.state, patch)
    await w.loadList()
    return w
  }
  const picked = async (w, path) => {
    w.pick(path, LISTED.files.find((f) => f.path === path).size)
    await drained()
  }
  const one = (w, type) => collect(w.render(), (el) => (el.type === type ? el : undefined))[0]

  it('lists the revision with the token, and asks the same address, with the token, for a picked file', async () => {
    const w = await opened()
    expect(asked).toEqual([[SOURCE, 'sekrit']])
    expect(texts(w.render())).toEqual(expect.arrayContaining(['ref', 'print', 'model.py', 'notes.txt']))
    await picked(w, 'model.py')
    expect(asked[1]).toEqual([`${SOURCE}?path=model.py`, 'sekrit'])
  })

  it('shows text in a read-only editor, highlighted by its language, in the page\'s theme', async () => {
    const w = await opened()
    await picked(w, 'model.py')
    w.host = { current: document.createElement('div') }
    w.mountEditor()
    expect(mount).toHaveBeenCalledWith(w.host.current,
      expect.objectContaining({ text: 'print(1)', language: 'python', readOnly: true, theme: 'dark' }))
    expect(texts(w.render())).toContain('Text · 8 B')
  })

  it('imports the editor the first time a text file opens, and not before or again', async () => {
    const w = await opened()
    await picked(w, 'ref/sheet.pdf')
    await picked(w, 'print/foot.3mf')
    expect(FilesWindow.prototype.editorModule).not.toHaveBeenCalled()
    await picked(w, 'model.py')
    await picked(w, 'notes.txt')
    expect(FilesWindow.prototype.editorModule).toHaveBeenCalledTimes(1)
  })

  it('says so when the editor could not be loaded, and the rest of the window goes on working', async () => {
    FilesWindow.prototype.editorModule.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await opened()
    await picked(w, 'model.py')
    expect(texts(w.render())).toContain(EDITOR_FAILED)
    await picked(w, 'ref/photo.png')
    expect(one(w, 'img').props.src).toBe('blob:1')
  })

  it('does not fetch a file over 16 MB, and offers it to download', async () => {
    const w = await opened()
    await picked(w, 'ref/rail.step')
    expect(asked).toHaveLength(1)
    expect(texts(w.render())).toEqual(expect.arrayContaining(
      ['Large file · 61.0 MB', 'Large file', 'Files over 16 MB are not loaded into the window.', 'Download']))
  })

  it('shows a PDF in a frame from its bytes typed as a PDF, and opens the same in a tab of its own', async () => {
    const w = await opened()
    await picked(w, 'ref/sheet.pdf')
    expect(made[0].type).toBe('application/pdf')
    expect(one(w, 'iframe').props.src).toBe('blob:1')
    const open = one(w, 'a')
    expect([open.props.href, open.props.target, open.props.children]).toEqual(['blob:1', '_blank', 'Open'])
    // Another pick lets the bytes go.
    await picked(w, 'model.py')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
  })

  it('calls a file that is not text binary, and imports no editor for it', async () => {
    const w = await opened()
    await picked(w, 'print/foot.3mf')
    expect(texts(w.render())).toEqual(expect.arrayContaining(['Binary file · 3 B', 'This file is not text']))
    expect(FilesWindow.prototype.editorModule).not.toHaveBeenCalled()
  })

  it('drops a file that lands after another was picked, or after ← Files', async () => {
    const w = await opened()
    let land
    fetch.mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
    w.pick('ref/photo.png', 3)
    await picked(w, 'model.py')
    land({ status: 200, arrayBuffer: async () => BYTES['ref/photo.png'].buffer })
    await drained()
    expect([w.state.picked.path, made]).toEqual(['model.py', []])
    fetch.mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
    w.pick('ref/photo.png', 3)
    w.back()
    land({ status: 200, arrayBuffer: async () => BYTES['ref/photo.png'].buffer })
    await drained()
    expect([w.state.picked, made]).toEqual([null, []])
  })

  it('says so when the list or a file did not come', async () => {
    fetch.mockResolvedValueOnce({ status: 403 })
    expect(texts((await opened()).render())).toContain('The hub refused the token')
    fetch.mockResolvedValueOnce({ status: 502 })
    expect(texts((await opened()).render())).toContain('Could not load the files')
    const w = await opened()
    fetch.mockResolvedValueOnce({ status: 404 })
    await picked(w, 'model.py')
    expect(texts(w.render())).toContain('Could not load the file')
  })

  it('saves a file fetched with the token under its own name, and tells of one the hub refused', async () => {
    const w = await opened()
    const saved = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function save() { saved.push([this.download, this.getAttribute('href')]) })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await w.download('ref/sheet.pdf')
      vi.advanceTimersByTime(10000)
    } finally {
      vi.useRealTimers()
    }
    expect([asked[1], saved]).toEqual([[`${SOURCE}?path=ref%2Fsheet.pdf`, 'sekrit'], [['sheet.pdf', 'blob:1']]])
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1')
    fetch.mockResolvedValueOnce({ status: 403 })
    await w.download('model.py')
    expect(w.props.toast.mock.calls).toEqual([['The hub refused the token']])
  })

  it('closes on ✕ and on Escape, the page under it taking it or not, but not on one something inside it took', async () => {
    const w = await opened()
    w.box = { current: document.createElement('div') }
    const inside = document.createElement('input')
    const text = document.createElement('div')
    w.box.current.append(inside, text)
    document.body.appendChild(w.box.current)
    // The model's page drops an armed tool on Escape, listening on `window`
    // from before the window opened; the documents page does it capturing.
    const page = (event) => event.preventDefault()
    window.addEventListener('keydown', page)
    w.componentDidMount()
    try {
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(w.props.onClose).toHaveBeenCalledTimes(1)
      window.removeEventListener('keydown', page)
      window.addEventListener('keydown', page, true)
      text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(w.props.onClose).toHaveBeenCalledTimes(2)
      w.props.onClose.mockClear()
      window.removeEventListener('keydown', page, true)
      // CodeMirror's search panel shuts on its own Escape, gone from the page
      // before the event reaches the window.
      inside.addEventListener('keydown', (event) => {
        event.preventDefault()
        inside.remove()
      })
      inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(w.props.onClose).not.toHaveBeenCalled()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(w.props.onClose).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', page)
      window.removeEventListener('keydown', page, true)
      w.componentWillUnmount()
      w.box.current.remove()
    }
    collect(w.render(), (el) => (el.props.title === 'Close' ? el : undefined))[0].props.onClick()
    expect(w.props.onClose).toHaveBeenCalledTimes(2)
  })

  it('shows one pane at a time on a narrow window, and ← Files goes back to the tree', async () => {
    const w = await opened()
    w.state.narrow = true
    /** What the hidden pane holds. */
    const hidden = () => texts(collect(w.render(), (el) => (el.props.style && el.props.style.display === 'none'
      ? el : undefined)))
    expect(hidden()).toEqual(['Pick a file on the left to see it here.'])
    await picked(w, 'model.py')
    expect(hidden()).toEqual(expect.arrayContaining(['ref', 'model.py', 'notes.txt']))
    const back = collect(w.render(), (el) => (el.props.children === '← Files' ? el : undefined))[0]
    back.props.onClick()
    expect([w.state.picked, hidden()]).toEqual([null, ['Pick a file on the left to see it here.']])
  })

  const START = { variant: 'main', base: 'abc1234' }
  const by = (w, text) => collect(w.render(), (el) => (el.props.children === text ? el : undefined))[0]

  it('only shows a revision that is not the newest, saying so, with the way to the newest', async () => {
    const w = await opened({ notNewest: { variant: 'main', href: '/project/proj1/latest/' } })
    expect(texts(w.render())).toEqual(expect.arrayContaining([notNewestLine('main'), 'Open newest']))
    expect([one(w, 'a').props.href, w.canEdit()]).toEqual(['/project/proj1/latest/', false])
  })

  it('hands the text up once typing rests, and at once before Commit', async () => {
    const onSet = vi.fn()
    const onCommit = vi.fn()
    const w = await opened({ start: START, onSet, onCommit })
    await picked(w, 'model.py')
    let typed = 'print(22)'
    let heard
    mount.mockImplementation((element, options) => {
      heard = options
      return { getText: () => typed, setReadOnly: vi.fn(), destroy: vi.fn() }
    })
    w.host = { current: document.createElement('div') }
    w.mountEditor()
    expect(heard.readOnly).toBe(false)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      heard.onChange()
      vi.advanceTimersByTime(TEXT_REST_MS - 1)
      expect(onSet).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      // The head of the pane says the size of the text as it went up.
      expect([listed(onSet.mock.calls[0][0]), texts(w.render())]).toEqual([['M model.py'], expect.arrayContaining(['Text · 9 B'])])
      typed = 'print(3)'
      heard.onChange()
      w.commit([])
      expect([onSet.mock.calls[1][0].entries[0].text, onCommit.mock.calls]).toEqual(['print(3)', [[[]]]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('puts an upload or a drop into the folder chosen, and toasts a name the hub would refuse', async () => {
    const onSet = vi.fn()
    const w = await opened({ start: START, onSet })
    w.upload([new File(['x'], 'scan.png')], 'ref')
    w.upload([new File(['x'], '.git')], '')
    w.dropped({ dataTransfer: { types: ['Files'], files: [new File(['y'], 'photo.png')] },
      preventDefault() {}, stopPropagation() {} }, 'ref')
    expect(listed(w.current())).toEqual(['A ref/scan.png', 'M ref/photo.png'])
    expect(w.props.toast.mock.calls).toEqual([[notAPath('.git')]])
  })

  it('leaves a folder dropped from Finder out, says so, and puts up the files dropped with it', async () => {
    const onSet = vi.fn()
    const w = await opened({ start: START, onSet })
    const item = (name, directory) => ({
      kind: 'file', webkitGetAsEntry: () => ({ isDirectory: directory }), getAsFile: () => new File(['z'], name),
    })
    w.dropped({ dataTransfer: { types: ['Files'], items: [item('scans', true), item('a.png', false)], files: [] },
      preventDefault() {}, stopPropagation() {} }, 'ref')
    expect([listed(w.current()), w.props.toast.mock.calls]).toEqual([['A ref/a.png'], [[NO_FOLDERS]]])
  })

  it('opens a new file empty in the editor, and refuses a taken path under the field as it is typed', async () => {
    const w = await opened({ start: START, onSet: vi.fn() })
    w.openForm('file')
    w.state.form.typed = 'docs/assembly.md'
    w.submitForm()
    expect([listed(w.current()), w.state.picked.path, w.state.picked.text]).toEqual([['A docs/assembly.md'], 'docs/assembly.md', ''])
    w.openForm('rename', 'notes.txt')
    collect(w.render(), (el) => (el.type === 'input' && el.props.type === 'text' ? el : undefined))[0]
      .props.onChange({ target: { value: 'model.py' } })
    expect(texts(w.render())).toContain(alreadyThere('model.py'))
  })

  it('lists the changes with a Revert each, is read-only while a Commit is under way, and offers mine over theirs', async () => {
    const set = remove(putFile(startSet('main', 'abc1234', LISTED.files), 'model.py', new Blob(['x'])), 'notes.txt')
    const onSet = vi.fn()
    const onCommit = vi.fn()
    const w = await opened({ set, onSet, onCommit, commit: { busy: true, step: 'Uploading 1/2' } })
    expect(texts(w.render())).toEqual(expect.arrayContaining([editingLine('abc1234', 'main'), 'Changes (2)', 'Uploading 1/2']))
    expect(w.canEdit()).toBe(false)
    w.props.commit = { conflicts: ['model.py'] }
    expect(texts(w.render())).toEqual(expect.arrayContaining([CONFLICTED, 'model.py', OVER_THEIRS, 'changed on the hub']))
    by(w, OVER_THEIRS).props.onClick()
    by(w, 'Revert').props.onClick()
    expect([onCommit.mock.calls, listed(onSet.mock.calls[0][0])]).toEqual([[[['model.py']]], ['D notes.txt']])
  })
})

describe('Commit', () => {
  const SET = putFile(editText(startSet('main', 'abc1234', [{ path: 'model.py', size: 8 }, { path: 'old.txt', size: 1 }]),
    'model.py', 'SIZE = 2\n', 'SIZE = 1\n'), 'ref/p.png', new Blob(['png']))
  const send = (set, over = []) => {
    const reports = []
    const end = commitSet(set, over, { pid: 'proj1', token: 'sekrit', report: (r) => reports.push(r), gone: () => false })
    return { reports, end }
  }
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('uploads each edited file, commits the set and asks after its build until it ends, waiting a hub out', async () => {
    const jobs = [answer(200, { state: 'queued' }), answer(200, { state: 'building' }), answer(502, {}),
      answer(200, { state: 'done' })]
    const calls = hubAnswers((url, n) => (url.endsWith('/blob') ? answer(200, { blob: `${n}`.repeat(40) })
      : url.endsWith('/commit') ? answer(202, { job: 'j1', commit: 'c', status_url: '/api/v1/jobs/j1' }) : jobs.shift()))
    const { reports, end } = send(SET)
    await vi.advanceTimersByTimeAsync(COMMIT_POLL_MS * 4)
    expect(await end).toEqual({ done: true })
    expect(calls.map(([url]) => url)).toEqual(['/api/v1/source/proj1/blob', '/api/v1/source/proj1/blob',
      '/api/v1/source/proj1/commit', '/api/v1/jobs/j1', '/api/v1/jobs/j1', '/api/v1/jobs/j1', '/api/v1/jobs/j1'])
    expect(calls[0][1].headers['X-Hammerola-Token']).toBe('sekrit')
    expect(JSON.parse(calls[2][1].body)).toEqual({
      variant: 'main', base: 'abc1234', message: 'Edit model.py; upload ref/p.png',
      changes: [{ path: 'model.py', blob: '1'.repeat(40) }, { path: 'ref/p.png', blob: '2'.repeat(40) }],
    })
    expect(reports.map((r) => [r.step, !!r.since, !!r.unreachable])).toEqual([
      ['Uploading 1/2', false, false], ['Uploading 2/2', false, false], [QUEUED, false, false],
      [QUEUED, false, false], [QUEUED, true, false], [QUEUED, true, true]])
  })

  it('takes the bytes of a move onto a deleted file\'s place from the build, and sends a write and a delete', async () => {
    const files = [{ path: 'README.md', size: 1 }, { path: 'docs/README.md', size: 4 }]
    const set = move(remove(startSet('main', 'abc1234', files), 'README.md'), 'docs/README.md', 'README.md')
    const calls = hubAnswers((url) => (url.includes('?path=') ? answer(200, 'docs')
      : url.endsWith('/blob') ? answer(200, { blob: 'd'.repeat(40) }) : answer(409, { conflicts: ['docs/README.md'] })))
    const { reports, end } = send(set)
    expect(await end).toEqual({ conflicts: ['docs/README.md'] })
    expect(calls.map(([url]) => url)).toEqual(['/api/v1/source/proj1/abc1234?path=docs%2FREADME.md',
      '/api/v1/source/proj1/blob', '/api/v1/source/proj1/commit'])
    const up = new TextDecoder().decode(await calls[1][1].body.arrayBuffer())
    expect([up, reports[0].step]).toEqual(['docs', 'Uploading 1/1'])
    expect(JSON.parse(calls[2][1].body).changes)
      .toEqual([{ path: 'README.md', blob: 'd'.repeat(40) }, { path: 'docs/README.md', blob: null }])
  })

  it('ends on a failed build with its line, error and log, and on a job the hub lost', async () => {
    const deleted = remove(startSet('main', 'abc1234', [{ path: 'old.txt', size: 1 }]), 'old.txt')
    let job = answer(200, { state: 'failed', code: 409, error: 'the branch moved', log_url: '/api/v1/jobs/j1/log' })
    hubAnswers((url) => (url.endsWith('/commit') ? answer(202, { job: 'j1' })
      : url.endsWith('/log') ? answer(200, 'Traceback') : job))
    expect(await send(deleted).end)
      .toEqual({ failed: { line: BRANCH_MOVED, error: 'the branch moved', log: 'Traceback' } })
    job = answer(404, { error: 'not found' })
    expect(await send(deleted).end).toEqual({ said: HUB_LOST })
  })

  it('ends on the conflicts the hub named, and on its words for any other refusal', async () => {
    let commit = answer(409, { error: 'changed on the hub since the editor opened: model.py', conflicts: ['model.py'] })
    const calls = hubAnswers((url) => (url.endsWith('/blob') ? answer(200, { blob: 'b'.repeat(40) }) : commit))
    expect(await send(SET).end).toEqual({ conflicts: ['model.py'] })
    await send(SET, ['model.py']).end
    expect(JSON.parse(calls.at(-1)[1].body).changes[0]).toEqual({ path: 'model.py', blob: 'b'.repeat(40), over: true })
    commit = answer(422, { error: 'the commit needs a message' })
    expect(await send(SET).end).toEqual({ said: 'the commit needs a message' })
    commit = new TypeError('Failed to fetch')
    expect(await send(SET).end).toEqual({ said: HUB_UNREACHABLE })
  })
})

