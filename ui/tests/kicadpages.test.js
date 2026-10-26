// The sheets of a KiCad schematic as the list of views offers them
// (ui/src/kicadpages.js), read from its files' texts in the shape the viewer's
// `getSchematicPages()` reports, and the `s=` each one's row writes. The files
// are synthetic s-expressions shaped as KiCad writes them; the rows drawn from
// the list are in viewdocs.test.js.

import { describe, expect, it } from 'vitest'

import { sheetQueryValue } from '../src/KicadView.jsx'
import { schematicSheets } from '../src/kicadpages.js'

const field = (name, value) => `(property "${name}" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))`
/** A sheet symbol; `pages` are its placements' page numbers by the path of the sheet it is placed on. */
const sheet = (uuid, name, file, pages = {}, names = ['Sheetname', 'Sheetfile']) => `\t(sheet (at 10 10) (size 20 10) (uuid "${uuid}")
\t\t${field(names[0], name)}\n\t\t${field(names[1], file)}
\t\t(instances (project "dionis" ${Object.entries(pages).map(([path, page]) => `(path "${path}" (page "${page}"))`).join(' ')})))\n`
const schematic = (uuid, ...sheets) => `(kicad_sch\n\t(version 20250610)\n\t(generator "eeschema")\n\t(uuid "${uuid}")\n${sheets.join('')})\n`

// The root places a KiCad 6 sheet, with no placements in its symbol, an
// amplifier twice, a file that is not there, notes whose only placement is
// under another root (a file copied in from another project), on page 1, and a
// sheet placed twice elsewhere, under neither of them; the amplifier places a
// filter, which is two sheets of one name, and names the root, its own
// ancestor.
const ROOT = 'kicad/top.kicad_sch'
const TEXTS = {
  [ROOT]: schematic('r',
    sheet('s-psu', 'psu', 'psu.kicad_sch', {}, ['Sheet name', 'Sheet file']),
    sheet('s-ampl', 'amp_l', 'amp/amp.kicad_sch', { '/r': '3' }),
    sheet('s-gone', 'gone', 'missing.kicad_sch', { '/r': '4' }),
    sheet('s-ampr', 'amp_r', 'amp/amp.kicad_sch', { '/r': '2' }),
    sheet('s-notes', 'notes', 'notes.kicad_sch', { '/old': '1' }),
    sheet('s-copy', 'copy', 'psu.kicad_sch', { '/old': '7', '/older': '8' })),
  'kicad/amp/amp.kicad_sch': schematic('a',
    sheet('s-filter', 'filter', 'filter.kicad_sch', { '/r/s-ampl': '6', '/r/s-ampr': '5' }),
    sheet('s-loop', 'loop', '../top.kicad_sch', { '/r/s-ampl': '8', '/r/s-ampr': '9' })),
  'kicad/amp/filter.kicad_sch': schematic('f'),
  'kicad/psu.kicad_sch': schematic('p'),
  'kicad/notes.kicad_sch': schematic('n'),
}

describe('a schematic\'s sheets', () => {
  it('are its placements as the viewer lists them, the root first and the rest by page number', () => {
    const sheets = schematicSheets(TEXTS, ROOT)
    const AMP_L = 'kicad/amp/amp.kicad_sch:/r/s-ampl'
    const AMP_R = 'kicad/amp/amp.kicad_sch:/r/s-ampr'
    expect(sheets).toEqual([
      { projectPath: `${ROOT}:/r`, name: 'Root', parentProjectPath: undefined },
      { projectPath: 'kicad/notes.kicad_sch:/r/s-notes', name: 'notes', parentProjectPath: `${ROOT}:/r` },
      { projectPath: AMP_R, name: 'amp_r', parentProjectPath: `${ROOT}:/r` },
      { projectPath: AMP_L, name: 'amp_l', parentProjectPath: `${ROOT}:/r` },
      { projectPath: 'kicad/amp/filter.kicad_sch:/r/s-ampr/s-filter', name: 'filter', parentProjectPath: AMP_R },
      { projectPath: 'kicad/amp/filter.kicad_sch:/r/s-ampl/s-filter', name: 'filter', parentProjectPath: AMP_L },
    ])
    // the `s=` of each row: none for the root, the name where it is the only
    // one, the path where two sheets share it
    expect(sheets.map((one) => sheetQueryValue(sheets, one.projectPath))).toEqual(['', 'notes', 'amp_r', 'amp_l',
      'kicad/amp/filter.kicad_sch:/r/s-ampr/s-filter', 'kicad/amp/filter.kicad_sch:/r/s-ampl/s-filter'])
  })

  it('are none where the root file does not parse', () => {
    expect(schematicSheets({ ...TEXTS, [ROOT]: '(kicad_sch (uuid "r")' }, ROOT)).toEqual([])
    expect(schematicSheets({}, ROOT)).toEqual([])
  })
})
