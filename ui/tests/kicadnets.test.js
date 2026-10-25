// The nets a KiCad design's sheets name (ui/src/kicadnets.js): its labels,
// power symbols and sheet pins, sheet by sheet and by uuid, and the name the
// board gives each one's net. The files are synthetic s-expressions shaped as KiCad writes them; the
// menu KicadView builds from this is in kicad.test.js.

import { describe, expect, it } from 'vitest'

import { netIndex } from '../src/kicadnets.js'

const field = (name, value) => `(property "${name}" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))`
/** A placed symbol: a power symbol, a power flag or a part, by its `Reference`. */
const placed = (reference, value, uuid) => `\t(symbol (lib_id "lib:${value}") (at 1 1 0) (unit 1)
\t\t${field('Reference', reference)}\n\t\t${field('Value', value)}\n\t\t(uuid "${uuid}"))\n`
const label = (kind, name, uuid) => `\t(${kind} "${name}"${kind === 'label' ? '' : ' (shape input)'} (at 0 0 0)`
  + ` (effects (font (size 1.27 1.27))) (uuid "${uuid}"))\n`
// The library's copy of a power symbol carries the `Reference` and the `Value`
// of one, and is placed nowhere.
const LIBRARY = `\t(lib_symbols (symbol "power:+5V" (power) ${field('Reference', '#PWR')} ${field('Value', '+5V')}
\t\t(symbol "+5V_0_1" (pin power_in line (number "1")))))\n`
const sheet = (...items) => `(kicad_sch\n\t(version 20250610)\n\t(uuid "sheet")\n${LIBRARY}${items.join('')})\n`

describe('the nets of a design\'s sheets', () => {
  it('are its labels and its power symbols, in the order the file holds them, never a power flag or a part', () => {
    const text = sheet(label('hierarchical_label', 'EN', 'h1'), placed('#PWR0101', '+12V', 'p1'),
      placed('#FLG0101', 'PWR_FLAG', 'f1'), placed('C507', '100n', 'c1'), label('global_label', 'AMP_CLIP_OTW', 'g1'),
      label('label', 'SW', 'l1'))
    expect(netIndex({ 'hw/amp.kicad_sch': text }).occurrences).toEqual([
      { sheet: 'hw/amp.kicad_sch', name: 'EN', uuid: 'h1', kind: 'hierarchical', board: 'EN' },
      { sheet: 'hw/amp.kicad_sch', name: '+12V', uuid: 'p1', kind: 'power', board: '+12V' },
      { sheet: 'hw/amp.kicad_sch', name: 'AMP_CLIP_OTW', uuid: 'g1', kind: 'global', board: 'AMP_CLIP_OTW' },
      { sheet: 'hw/amp.kicad_sch', name: 'SW', uuid: 'l1', kind: 'local', board: 'SW' },
    ])
  })

  it('are read sheet by sheet, the other files skipped, and found by uuid', () => {
    const nets = netIndex({
      'hw/board.kicad_pro': '{"meta": {"version": 1}}',
      'hw/board.kicad_sch': sheet(placed('#PWR0101', '+12V', 'p1')),
      'hw/sub/power.kicad_sch': sheet(placed('#PWR0201', '+12V', 'p2'), label('global_label', 'EN', 'g2')),
      'hw/board.kicad_pcb': '(kicad_pcb (global_label "EN" (uuid "board")))',
    })
    expect(nets.occurrences.map((one) => `${one.sheet} ${one.name}`))
      .toEqual(['hw/board.kicad_sch +12V', 'hw/sub/power.kicad_sch +12V', 'hw/sub/power.kicad_sch EN'])
    expect(nets.byUuid.get('g2'))
      .toEqual({ sheet: 'hw/sub/power.kicad_sch', name: 'EN', uuid: 'g2', kind: 'global', board: 'EN' })
    expect(nets.byUuid.get('board')).toBeUndefined()
  })

  it('are none from a file that does not parse, and nothing is thrown', () => {
    const nets = netIndex({
      'hw/cut.kicad_sch': '(kicad_sch (global_label "EN" (uuid "cut")',
      'hw/text.kicad_sch': 'not a list',
      'hw/board.kicad_sch': sheet(label('label', 'SW', 'l1')),
    })
    expect(nets.occurrences.map((one) => one.uuid)).toEqual(['l1'])
  })
})

describe('the board\'s name of a net', () => {
  /** A sheet symbol pointing at `file`, as KiCad 7 on spells its fields, or as
   *  KiCad 6 does, with its sheet pins. */
  const sheetSymbol = (name, file, six = false, pins = '') => `\t(sheet (at 0 0) (size 10 10) (uuid "sheet-${name}")\n`
    + `\t\t${field(six ? 'Sheet name' : 'Sheetname', name)}\n\t\t${field(six ? 'Sheet file' : 'Sheetfile', file)}${pins})\n`
  const sheetPin = (name, uuid) => `\n\t\t(pin "${name}" input (at 0 0 0) (uuid "${uuid}") (effects (font (size 1.27 1.27))))`
  // The root, not the first file here, points at `amp` twice, as a sheet used
  // twice; `amp` at `sub`, a directory below, in KiCad 6's spelling; `sub` at
  // the root and at itself. No sheet points at `stray`. `FAULT_N` is a
  // hierarchical label on `amp` and on `sub`, and a pin of the root's sheet
  // `amp`; `SPARE`, a pin of `amp`'s sheet `sub`, is no hierarchical label's.
  const TEXTS = {
    'kicad/amp.kicad_sch': sheet(sheetSymbol('sub', 'parts/sub.kicad_sch', true, sheetPin('SPARE', 'pin-spare')),
      label('label', 'OUT_C', 'out'), label('hierarchical_label', 'EN', 'en'), label('global_label', 'AMP_FAULT', 'fault-amp'),
      label('hierarchical_label', 'FAULT_N', 'fault-n-amp')),
    'kicad/top.kicad_sch': sheet(sheetSymbol('amp', 'amp.kicad_sch', false, sheetPin('FAULT_N', 'pin-fault-n')),
      sheetSymbol('amp2', 'amp.kicad_sch'),
      label('label', 'X', 'x'), label('global_label', 'AMP_FAULT', 'fault'), placed('#PWR01', '+12V', 'p')),
    'kicad/parts/sub.kicad_sch': sheet(sheetSymbol('top', '../top.kicad_sch'), sheetSymbol('self', './sub.kicad_sch'),
      label('label', 'SW', 'sw'), label('hierarchical_label', 'FAULT_N', 'fault-n-sub')),
    'kicad/stray.kicad_sch': sheet(label('label', 'Y', 'y')),
  }
  const boards = (texts) => Object.fromEntries(netIndex(texts, 'kicad/top.kicad_sch').occurrences
    .map((one) => [one.uuid, one.board]))

  it('is a global label\'s or a power symbol\'s own name, a local or a hierarchical label\'s with a sheet\'s path in front', () => {
    expect(boards(TEXTS)).toEqual({
      x: '/X', fault: 'AMP_FAULT', p: '+12V',
      out: '/amp/OUT_C', en: '/amp/EN', 'fault-amp': 'AMP_FAULT',
      // the sheets followed by name from the root, a file reached twice by the path it was reached by first
      sw: '/amp/sub/SW',
      // no board: the first sheet's, for every label of the name and the sheet pin of it
      'fault-n-amp': '/amp/FAULT_N', 'fault-n-sub': '/amp/FAULT_N', 'pin-fault-n': '/amp/FAULT_N',
      // a sheet pin no hierarchical label is named after: the path of the sheet that draws it
      'pin-spare': '/amp/SPARE',
      // no path known: the label's own name
      y: 'Y',
    })
  })

  it('is, for every hierarchical label of one name and every sheet pin of it, the one of its sheets\' names the board has', () => {
    const pcb = '(kicad_pcb (net 0 "") (footprint "R" (pad "1" smd rect (net "/amp/sub/FAULT_N"))'
      + ' (pad "2" smd rect (net "GND"))))'
    expect(boards({ ...TEXTS, 'kicad/top.kicad_pcb': pcb }))
      .toMatchObject({ 'fault-n-amp': '/amp/sub/FAULT_N', 'fault-n-sub': '/amp/sub/FAULT_N', 'pin-fault-n': '/amp/sub/FAULT_N',
        en: '/amp/EN', out: '/amp/OUT_C' })
  })
})
