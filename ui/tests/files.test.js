// The header's Files card (Header.jsx, filesview.js): the hub's flat list of the
// revision's files as the rows of a tree, and the button that opens it, drawn
// only for a reader holding the token, since the hub hands the code of a
// revision to nobody else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import HammerolaViewer from '../src/HammerolaViewer.jsx'
import { fileRows, sourceUrl } from '../src/filesview.js'
import { PAGE } from '../src/hub.js'
import { drained, headerOn, makeComponent } from './component.js'
import { texts } from './eltree.js'

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

describe('the rows of the Files card', () => {
  it('put directories first, then files, each alphabetically, and only the top level until one is opened', () => {
    expect(shown(fileRows(LIST, {}))).toEqual(['+docs', '+src', 'README.md', 'project.json'])
  })

  it('show an opened directory\'s rows under it, its own directories still shut', () => {
    expect(shown(fileRows(LIST, { src: true }))).toEqual(
      ['+docs', '-src', '  +parts', '  model.py', 'README.md', 'project.json'])
    expect(shown(fileRows(LIST, { src: true, 'src/parts': true }))).toEqual(
      ['+docs', '-src', '  -parts', '    lid.py', '  model.py', 'README.md', 'project.json'])
    // A directory is named by its whole path, a file by the path the hub
    // listed, which is what a download asks for.
    expect(fileRows(LIST, { src: true }).map((r) => [r.path, r.size])).toEqual([
      ['docs', undefined], ['src', undefined], ['src/parts', undefined],
      ['src/model.py', 90], ['README.md', 2048000], ['project.json', 40]])
  })
})

describe('the address of the Files card', () => {
  it('names the revision on screen on `latest`, which may have moved on, and any other slot as the page does', () => {
    const sha = 'a'.repeat(40)
    expect(sourceUrl({ pid: 'p', slot: 'latest', variant: '' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
    expect(sourceUrl({ pid: 'p', slot: 'latest', variant: 'wide' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
    expect(sourceUrl({ pid: 'p', slot: 'dev', variant: 'wide' }, { commit: 'dev' })).toBe('/api/v1/source/p/v/wide/dev')
    expect(sourceUrl({ pid: 'p', slot: 'dev', variant: '' }, { commit: 'dev' })).toBe('/api/v1/source/p/dev')
    expect(sourceUrl({ pid: 'p', slot: sha, variant: '' }, { commit: sha })).toBe(`/api/v1/source/p/${sha}`)
  })
})

describe('the Files button', () => {
  beforeEach(() => {
    PAGE.pid = 'proj1'
    PAGE.slot = 'latest'
    PAGE.base = '/project/proj1/latest/'
  })

  const drawn = (token) => texts(headerOn(makeComponent(HammerolaViewer, { state: { token } })).render())

  it('is drawn for a reader holding the token and not for one without, and Downloads for neither', () => {
    expect(drawn('sekrit')).toContain('Files')
    expect(drawn(null)).not.toContain('Files')
    for (const token of ['sekrit', null]) expect(drawn(token)).not.toContain('Downloads')
  })
})

describe('the Files card', () => {
  // The hub's answers as plain objects: the card reads `status`, `json()` and
  // `blob()` and nothing else.
  const LISTED = { files: [{ path: 'model.py', size: 90 }, { path: 'ref/notes.md', size: 3 }] }
  let asked
  beforeEach(() => {
    PAGE.pid = 'proj1'
    PAGE.slot = 'latest'
    PAGE.variant = ''
    PAGE.base = '/project/proj1/latest/'
    asked = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      asked.push([url, init.headers['X-Hammerola-Token']])
      return { status: 200, json: async () => LISTED, blob: async () => new Blob(['print(1)']) }
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  const opened = async (h) => {
    h.view().filesToggle({ stopPropagation() {} })
    await drained()
  }
  const names = (h) => h.view().fileRows.map((row) => row.name)

  it('asks for the build on screen as it opens, opens a directory, and saves a file fetched with the token', async () => {
    const h = headerOn(makeComponent(HammerolaViewer, { state: { token: 'sekrit' } }))
    await opened(h)
    expect(asked).toEqual([['/api/v1/source/proj1/abc1234', 'sekrit']])
    expect(names(h)).toEqual(['ref', 'model.py'])
    h.view().fileRows[0].onClick()
    expect(names(h)).toEqual(['ref', 'notes.md', 'model.py'])

    const saved = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function save() { saved.push([this.download, this.getAttribute('href')]) })
    const kept = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = vi.fn(() => 'blob:files')
    URL.revokeObjectURL = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      h.view().fileRows[1].onClick()
      await vi.waitFor(() => expect(saved).toHaveLength(1))
      vi.advanceTimersByTime(10000)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:files')
    } finally {
      vi.useRealTimers()
      click.mockRestore()
      URL.createObjectURL = kept.create
      URL.revokeObjectURL = kept.revoke
    }
    expect(asked[1]).toEqual(['/api/v1/source/proj1/abc1234?path=ref%2Fnotes.md', 'sekrit'])
    expect(saved).toEqual([['notes.md', 'blob:files']])
  })

  it('says so when the list did not come, and asks again on the next opening', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      asked.push([url])
      return { status: 403 }
    }))
    const h = headerOn(makeComponent(HammerolaViewer, { state: { token: 'sekrit' } }))
    await opened(h)
    expect(h.view().filesSaid).toBe('The hub refused the token')
    await opened(h)
    await opened(h)
    expect(asked).toHaveLength(2)
  })

  it('tells of a file the hub refused or that broke off on the way, and saves nothing', async () => {
    const page = makeComponent(HammerolaViewer, { state: { token: 'sekrit' } })
    const told = vi.spyOn(page, 'toast').mockImplementation(() => {})
    const h = headerOn(page)
    await opened(h)
    const create = vi.fn()
    const kept = URL.createObjectURL
    URL.createObjectURL = create
    try {
      for (const reply of [{ status: 404 }, { status: 200, blob: async () => { throw new TypeError('cut off') } }]) {
        vi.stubGlobal('fetch', vi.fn(async () => reply))
        await h.downloadFile('model.py')
      }
    } finally {
      URL.createObjectURL = kept
    }
    expect(told.mock.calls).toEqual([['Could not download the file'], ['Could not download the file']])
    expect(create).not.toHaveBeenCalled()
  })

  it('drops a list that comes for a build the page no longer shows', async () => {
    let answer
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { answer = resolve })))
    const h = headerOn(makeComponent(HammerolaViewer, { state: { token: 'sekrit' } }))
    h.view().filesToggle({ stopPropagation() {} })
    h.props = { ...h.props, meta: { ...h.props.meta, commit: 'b'.repeat(40) } }
    answer({ status: 200, json: async () => LISTED })
    await drained()
    expect(h.state.files.list).toBeUndefined()
  })

  it('asks again when a new draft takes the screen under the same address', async () => {
    PAGE.slot = 'dev'
    PAGE.base = '/project/proj1/dev/'
    const page = makeComponent(HammerolaViewer, { state: { token: 'sekrit' } })
    page.state.meta = { ...page.state.meta, commit: 'dev', dev: true, published: 'first' }
    const h = headerOn(page)
    await opened(h)
    const prev = h.props
    h.props = { ...prev, meta: { ...prev.meta, published: 'second' } }
    h.componentDidUpdate(prev)
    await drained()
    expect(asked.map(([url]) => url)).toEqual(['/api/v1/source/proj1/dev', '/api/v1/source/proj1/dev'])
  })
})
