// The Files window's change set (changeset.js): actions on the files of one
// build folded into one record per file, the tree they make, the names the hub
// would refuse, and what Commit sends — the `changes` of
// `POST /api/v1/source/<pid>/commit` (SPEC 7.8) and the default message.

import { describe, expect, it } from 'vitest'

import {
  alreadyThere, bodyOf, changeRows, defaultMessage, editText, fileInTheWay, folderInTheWay, isEmpty, move, newFile,
  newFolder, normalText, notAPath, overlay, pathProblem, payload, putFile, remove, revert, startSet, uploads,
} from '../src/changeset.js'
import { fileRows } from '../src/filesview.js'

const BASE = [
  { path: 'model.py', size: 10 }, { path: 'README.md', size: 7 }, { path: 'docs/a.md', size: 3 },
  { path: 'old.txt', size: 2 },
]
const fresh = () => startSet('main', 'abc1234', BASE)
/** The list under Changes (N), as the reader reads it. */
const listed = (set) => changeRows(set).map((row) => `${row.mark} ${row.label}`)
/** What Commit sends, each uploaded record's blob named after its path. */
const sent = (set, over) => payload(set, Object.fromEntries(uploads(set).map((e) => [e.path, `sha-${e.path}`])), over)
const bytes = (text) => new Blob([text])

describe('one record per file: the fold table of issue #161', () => {
  it('a new file moved is a new file in its new place', () => {
    const set = move(newFile(fresh(), 'x.py'), 'x.py', 'c/x.py')
    expect([listed(set), sent(set)]).toEqual([['A c/x.py'], [{ path: 'c/x.py', blob: 'sha-c/x.py' }]])
  })

  it('a move of a moved file is one move from the first place to the last', () => {
    const set = move(move(fresh(), 'README.md', 'b.md'), 'b.md', 'docs/c.md')
    expect([listed(set), sent(set)]).toEqual([['R README.md → docs/c.md'], [{ path: 'docs/c.md', from: 'README.md' }]])
  })

  it('a move back is nothing, or the edit when the file was edited on the way', () => {
    const moved = move(fresh(), 'README.md', 'b.md')
    expect(isEmpty(move(moved, 'b.md', 'README.md'))).toBe(true)
    const edited = move(editText(moved, 'b.md', 'new\n', 'old\n'), 'b.md', 'README.md')
    expect([listed(edited), sent(edited)]).toEqual([['M README.md'], [{ path: 'README.md', blob: 'sha-README.md' }]])
  })

  it('a moved file deleted is its old place deleted', () => {
    const set = remove(move(fresh(), 'README.md', 'b.md'), 'b.md')
    expect([listed(set), sent(set)]).toEqual([['D README.md'], [{ path: 'README.md', blob: null }]])
  })

  it('a moved file edited or replaced moves with its bytes, and its text back where it was moves without', () => {
    const moved = move(fresh(), 'README.md', 'b.md')
    const edited = editText(moved, 'b.md', 'hi\n', 'hello\n')
    expect(sent(edited)).toEqual([{ path: 'b.md', from: 'README.md', blob: 'sha-b.md' }])
    expect(sent(editText(edited, 'b.md', 'hello\n', 'hello\n'))).toEqual([{ path: 'b.md', from: 'README.md' }])
    expect(sent(putFile(moved, 'b.md', bytes('x')))).toEqual([{ path: 'b.md', from: 'README.md', blob: 'sha-b.md' }])
  })

  it('a deleted file written again, new or uploaded, is that file edited', () => {
    const deleted = remove(fresh(), 'old.txt')
    for (const set of [newFile(deleted, 'old.txt'), putFile(deleted, 'old.txt', bytes('x'))]) {
      expect([listed(set), sent(set)]).toEqual([['M old.txt'], [{ path: 'old.txt', blob: 'sha-old.txt' }]])
    }
  })

  it('a new file deleted is nothing', () => {
    expect(isEmpty(remove(newFile(fresh(), 'x.py'), 'x.py'))).toBe(true)
  })

  it('leaves the place a file moved from free: a new file there is a record of its own', () => {
    const set = newFile(move(fresh(), 'model.py', 'model_old.py'), 'model.py')
    expect(listed(set)).toEqual(['R model.py → model_old.py', 'A model.py'])
    expect(sent(set)).toEqual([{ path: 'model_old.py', from: 'model.py' }, { path: 'model.py', blob: 'sha-model.py' }])
  })
})

describe('the editor\'s text', () => {
  it('is a record while it differs from the text opened, line endings made \\n, and none once back', () => {
    const orig = normalText('a\r\nb\r')
    expect(orig).toBe('a\nb\n')
    expect(isEmpty(editText(fresh(), 'model.py', 'a\nb\n', orig))).toBe(true)
    const edited = editText(fresh(), 'model.py', 'a\nc\n', orig)
    expect(listed(edited)).toEqual(['M model.py'])
    expect(isEmpty(editText(edited, 'model.py', 'a\nb\n', undefined))).toBe(true)
  })

  it('goes up as UTF-8, every line ending as the editor wrote it', async () => {
    const [entry] = uploads(editText(fresh(), 'model.py', 'é\nb\n', 'a\r\nb\r\n'))
    expect([...new Uint8Array(await bodyOf(entry).arrayBuffer())]).toEqual([0xc3, 0xa9, 0x0a, 0x62, 0x0a])
  })

  it('of a file uploaded over is kept against that upload, not the build\'s text', () => {
    const set = editText(putFile(fresh(), 'model.py', bytes('up')), 'model.py', 'up', undefined)
    expect(listed(set)).toEqual(['M model.py'])
  })
})

describe('Upload, Delete, Rename or move and Revert', () => {
  it('replaces a file with the upload of the same name, and Revert brings the file back', () => {
    const set = putFile(fresh(), 'model.py', bytes('x'))
    expect(listed(set)).toEqual(['M model.py'])
    expect(isEmpty(revert(set, changeRows(set)[0].key))).toBe(true)
  })

  it('deletes and moves every file of a folder', () => {
    expect(listed(remove(fresh(), 'docs'))).toEqual(['D docs/a.md'])
    expect(listed(move(fresh(), 'docs', 'notes'))).toEqual(['R docs/a.md → notes/a.md'])
  })

  it('taking a move back where a new file took the place makes that file the edit', () => {
    const set = newFile(move(fresh(), 'model.py', 'model_old.py'), 'model.py')
    expect(listed(revert(set, changeRows(set)[0].key))).toEqual(['M model.py'])
  })
})

describe('a new folder', () => {
  it('stands in the tree, empty, until a file is put in it, and never goes to the hub', () => {
    const set = newFolder(fresh(), 'fixtures')
    const row = fileRows(overlay(set), {}, set.folders).find((r) => r.path === 'fixtures')
    expect([row.dir, row.empty, sent(set)]).toEqual([true, true, []])
    const filled = newFile(set, 'fixtures/x.txt')
    expect([filled.folders, sent(filled)]).toEqual([[], [{ path: 'fixtures/x.txt', blob: 'sha-fixtures/x.txt' }]])
  })
})

describe('the tree', () => {
  it('marks an edit M, a new file A, a move R in its new place, and keeps a deleted file at its place', () => {
    let set = editText(fresh(), 'model.py', 'x', 'y')
    set = remove(move(putFile(set, 'ref/p.png', bytes('png')), 'README.md', 'docs/README.md'), 'old.txt')
    expect(overlay(set).map((r) => [r.path, r.mark, r.gone]).sort()).toEqual([
      ['docs/README.md', 'R', false], ['docs/a.md', '', false], ['model.py', 'M', false],
      ['old.txt', 'D', true], ['ref/p.png', 'A', false]])
  })
})

describe('the names the hub would refuse', () => {
  it('says so in the hub\'s words before it is asked', () => {
    const set = fresh()
    for (const path of ['', 'a//b', './a', 'a/..', '.git/x', 'x/.GIT']) expect(pathProblem(set, path, 'file')).toBe(notAPath(path))
    expect(pathProblem(set, 'README.md', 'file')).toBe(alreadyThere('README.md'))
    expect(pathProblem(set, 'docs', 'folder')).toBe(alreadyThere('docs'))
    expect(pathProblem(set, 'model.py/x', 'file')).toBe(fileInTheWay('model.py'))
    expect(pathProblem(set, 'docs', 'file')).toBe(folderInTheWay('docs'))
    expect(pathProblem(set, 'README.md', 'upload')).toBe('')
    // A file being moved leaves its place, so a folder may move inside itself.
    expect(pathProblem(set, 'model.py', 'file', 'model.py')).toBe('')
    expect(pathProblem(set, 'docs/sub', 'folder', 'docs')).toBe('')
    // The place of a deleted file is free.
    expect(pathProblem(remove(set, 'old.txt'), 'old.txt', 'file')).toBe('')
  })
})

describe('what Commit sends', () => {
  const four = () => {
    const set = editText(fresh(), 'model.py', 'SIZE = 2\n', 'SIZE = 1\n')
    return move(remove(putFile(set, 'ref/photo.png', bytes('png')), 'old.txt'), 'README.md', 'docs/README.md')
  }

  it('uploads the bytes of edited and new files only, and says what changed, three at most', () => {
    expect(uploads(four()).map((e) => e.path)).toEqual(['model.py', 'ref/photo.png'])
    expect(defaultMessage(four())).toBe('Edit model.py; upload ref/photo.png; delete old.txt …and 1 more')
    expect(defaultMessage(newFile(fresh(), 'x.md'))).toBe('Add x.md')
    expect(sent(four())).toEqual([
      { path: 'model.py', blob: 'sha-model.py' }, { path: 'ref/photo.png', blob: 'sha-ref/photo.png' },
      { path: 'old.txt', blob: null }, { path: 'docs/README.md', from: 'README.md' }])
  })

  it('puts the reader\'s version over the hub\'s on the paths it named, a move by either of its ends', () => {
    const changes = sent(four(), ['model.py', 'README.md'])
    expect(changes.filter((c) => c.over).map((c) => c.path)).toEqual(['model.py', 'docs/README.md'])
    expect(changeRows(four(), ['README.md']).map((r) => r.conflict)).toEqual([false, false, false, true])
  })

  it('sends a move onto the place of a deleted file as a write there and a delete, each path checked on its own', () => {
    const set = move(remove(fresh(), 'old.txt'), 'README.md', 'old.txt')
    // Its bytes are the build's at README.md, which Commit fetches (null body).
    expect(uploads(set).map((e) => [e.path, bodyOf(e)])).toEqual([['old.txt', null]])
    const split = [{ path: 'old.txt', blob: 'sha-old.txt' }, { path: 'README.md', blob: null }]
    expect(sent(set)).toEqual(split)
    const edited = editText(set, 'old.txt', 'hi\n', 'hello\n')
    expect([bodyOf(uploads(edited)[0]) instanceof Blob, sent(edited)]).toEqual([true, split])
    // `over` only on the path the reader put his version over.
    expect(sent(set, ['README.md'])).toEqual([split[0], { ...split[1], over: true }])
  })

  it('sends a chain of moves onto freed places as writes, deleting only the place left empty', () => {
    const set = move(move(remove(fresh(), 'old.txt'), 'model.py', 'old.txt'), 'README.md', 'model.py')
    expect(sent(set)).toEqual([
      { path: 'old.txt', blob: 'sha-old.txt' }, { path: 'model.py', blob: 'sha-model.py' },
      { path: 'README.md', blob: null }])
  })
})
