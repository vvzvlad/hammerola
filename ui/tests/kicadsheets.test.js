// A KiCad part's datasheet (ui/src/kicadsheets.js): the `Datasheet` field of its
// placed symbol and of its footprint, read from the design's texts, and the
// listed document the value names. The files are synthetic s-expressions shaped
// as KiCad writes them; the menu item KicadView offers from this is in kicad.test.js.

import { describe, expect, it } from 'vitest'

import { datasheetBase, datasheetDocument, datasheetPath, partDatasheets } from '../src/kicadsheets.js'

const field = (name, value) => `(property "${name}" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))`
/** A placed symbol; `paths` are the references of its sheet's placements. */
const symbol = (reference, datasheet, { unit = 1, paths = [] } = {}) => `\t(symbol (lib_id "Device:R") (at 1 1 0) (unit ${unit})
\t\t${field('Reference', reference)}\n\t\t${field('Datasheet', datasheet)}
\t\t(instances (project "p" ${paths.map((ref, i) => `(path "/s${i}" (reference "${ref}") (unit ${unit}))`).join(' ')})))\n`
// The library's copy of a symbol carries a datasheet of its own, and a
// `Reference` that is a prefix rather than a part.
const LIBRARY = `\t(lib_symbols (symbol "Device:R" ${field('Reference', 'R')} ${field('Datasheet', 'ds/library.pdf')}
\t\t(symbol "R_1_1" (pin passive line (number "1")))))\n`
const sheet = (...symbols) => `(kicad_sch\n\t(version 20250610)\n${LIBRARY}${symbols.join('')})\n`
const footprint = (reference, datasheet) => `\t(footprint "R_0603" (layer "F.Cu")\n\t\t${field('Reference', reference)}\n\t\t${field('Datasheet', datasheet)})\n`
const board = (...footprints) => `(kicad_pcb\n\t(version 20241229)\n${footprints.join('')})\n`

const read = (texts) => Object.fromEntries(partDatasheets(texts))

describe('a part\'s datasheet', () => {
  it('is the field of its placed symbol, never of the library symbol', () => {
    expect(read({ 'hw/a.kicad_sch': sheet(symbol('R1', 'ds/r.pdf'), symbol('R2', '')) })).toEqual({ R1: 'ds/r.pdf' })
  })

  it('is one per part drawn as several units, and every designator a reused sheet gives it', () => {
    const text = sheet(
      symbol('U1', '~', { unit: 1 }), symbol('U1', 'ds/quad.pdf', { unit: 2 }), symbol('U1', 'ds/other.pdf', { unit: 3 }),
      symbol('R5', 'ds/r5.pdf', { paths: ['R5', 'R105'] }))
    expect(read({ 'hw/a.kicad_sch': text })).toEqual({ U1: 'ds/quad.pdf', R5: 'ds/r5.pdf', R105: 'ds/r5.pdf' })
  })

  it('is read from the footprints too, the schematic winning where both name one', () => {
    const texts = {
      'hw/a.kicad_pro': '{"meta": {"version": 1}}',
      'hw/a.kicad_sch': sheet(symbol('R1', 'ds/sheet.pdf'), symbol('R2', ''), symbol('R3', '~')),
      'hw/sub/b.kicad_sch': sheet(symbol('R6', 'ds/sub.pdf')),
      'hw/a.kicad_pcb': board(footprint('R1', 'ds/board.pdf'), footprint('R2', 'ds/r2.pdf'), footprint('R3', 'ds/r3.pdf'),
        footprint('R4', 'ds/r4.pdf'), footprint('R6', 'ds/r6.pdf'), footprint('R7', ' ')),
    }
    expect(read(texts)).toEqual({ R1: 'ds/sheet.pdf', R2: 'ds/r2.pdf', R3: 'ds/r3.pdf', R4: 'ds/r4.pdf', R6: 'ds/sub.pdf' })
  })

  it('leaves a web address under the board\'s value, as a library symbol brings one with it', () => {
    const texts = {
      'hw/a.kicad_sch': sheet(symbol('U1', 'https://www.ti.com/lit/ds/symlink/tpa3250.pdf'), symbol('U2', 'ds/u2.pdf')),
      'hw/a.kicad_pcb': board(footprint('U1', '${KIPRJMOD}/ds/tpa3250.pdf'), footprint('U2', 'ds/other.pdf'),
        footprint('U3', 'file://${KIPRJMOD}/ds/u3.pdf')),
    }
    expect(read(texts)).toEqual({ U1: '${KIPRJMOD}/ds/tpa3250.pdf', U2: 'ds/u2.pdf', U3: 'file://${KIPRJMOD}/ds/u3.pdf' })
  })

  it('is none for text that does not parse, and nothing is thrown', () => {
    const texts = {
      'hw/broken.kicad_sch': '(kicad_sch (symbol (lib_id "Device:R")',
      'hw/a.kicad_pcb': 'not an s-expression',
      'hw/b.kicad_sch': board(footprint('R9', 'ds/r9.pdf')),
      'hw/c.kicad_sch': undefined,
      'hw/good.kicad_sch': sheet(symbol('R1', 'ds/r.pdf')),
    }
    expect(read(texts)).toEqual({ R1: 'ds/r.pdf' })
    expect(read({})).toEqual({})
  })
})

const tpa = { id: 'hw__ds__TPA3250.pdf', name: 'TPA3250', type: 'pdf', file: 'hw/ds/TPA3250.pdf', hidden: true }
const notes = { id: 'docs__amp.pdf', name: 'docs/amp.pdf', type: 'pdf', file: 'docs/amp.pdf' }
const DOCS = [tpa, notes]

describe('the document a datasheet names', () => {
  it('is the listed one at its path from the project\'s directory, hidden or not', () => {
    const paths = ['${KIPRJMOD}/ds/TPA3250.pdf', 'ds/TPA3250.pdf', 'ds\\TPA3250.pdf', '${KIPRJMOD}\\ds\\TPA3250.pdf',
      'file://${KIPRJMOD}/ds/TPA3250.pdf', './sub/../ds/TPA3250.pdf']
    expect(paths.map((value) => datasheetPath(value, 'hw'))).toEqual(paths.map(() => 'hw/ds/TPA3250.pdf'))
    expect(paths.map((value) => datasheetDocument(value, 'hw', DOCS))).toEqual(paths.map(() => tpa))
    expect(datasheetDocument('../docs/amp.pdf', 'hw', DOCS)).toBe(notes)
    expect(datasheetDocument('docs/amp.pdf', '', DOCS)).toBe(notes)
  })

  it('is none for a web address, a path out of the tree or none listed, or another case', () => {
    const values = ['https://www.ti.com/lit/ds/tpa3250.pdf', 'http://hw/ds/TPA3250.pdf', 'file:///hw/ds/TPA3250.pdf',
      '/hw/ds/TPA3250.pdf', '../../hw/ds/TPA3250.pdf', 'ds/tpa3250.pdf', 'ds/TPA3250.PDF', 'ds/missing.pdf', '']
    expect(values.map((value) => datasheetDocument(value, 'hw', DOCS))).toEqual(values.map(() => null))
    expect(values.slice(0, 5).map((value) => datasheetPath(value, 'hw'))).toEqual(values.slice(0, 5).map(() => null))
  })

  it('resolves from the directory of the design\'s project, else of its schematic, else its board', () => {
    const sch = { type: 'schematic', file: 'hw/sch/board.kicad_sch', kicad: { project: null } }
    const pcb = { type: 'board', file: 'hw/board.kicad_pcb', kicad: { project: null } }
    const model = { type: 'board3d', file: 'hw/board.glb' }
    expect(datasheetBase([model, pcb, { ...sch, kicad: { project: 'proj/board.kicad_pro' } }])).toBe('proj')
    expect(datasheetBase([model, pcb, sch])).toBe('hw/sch')
    expect(datasheetBase([model, pcb])).toBe('hw')
    expect(datasheetBase([{ ...pcb, file: 'board.kicad_pcb', kicad: { project: 'board.kicad_pro' } }])).toBe('')
  })
})
