// The nets a KiCad design's sheets name (ui/src/kicadnets.js): its global,
// local and hierarchical labels and its power symbols, sheet by sheet and by
// uuid. The files are synthetic s-expressions shaped as KiCad writes them; the
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
      { sheet: 'hw/amp.kicad_sch', name: 'EN', uuid: 'h1', kind: 'hierarchical' },
      { sheet: 'hw/amp.kicad_sch', name: '+12V', uuid: 'p1', kind: 'power' },
      { sheet: 'hw/amp.kicad_sch', name: 'AMP_CLIP_OTW', uuid: 'g1', kind: 'global' },
      { sheet: 'hw/amp.kicad_sch', name: 'SW', uuid: 'l1', kind: 'local' },
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
    expect(nets.byUuid.get('g2')).toEqual({ sheet: 'hw/sub/power.kicad_sch', name: 'EN', uuid: 'g2', kind: 'global' })
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
