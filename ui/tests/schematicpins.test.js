// The pins the KiCad viewer gives a placed symbol (SchematicSymbol in
// ecad-viewer/packages/ecad-viewer-app/src/kicad/schematic.ts): its own
// `(pin "N" (uuid …))` records when the file has them, else one per pin number
// of its library symbol. The sheets are synthetic s-expressions shaped as KiCad
// writes them, read by the viewer's own parser into its own document, with
// `kicad-parser` aliased as its build aliases it (vitest.config.mjs); what the
// viewer then draws is checked in a browser, not here.

import { SchematicParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'

const effects = '(effects (font (size 1.27 1.27)))'
const pin = (number) => `(pin passive line (at 0 0 0) (length 2.54) (name "~" ${effects}) (number "${number}" ${effects}))`

/** A library symbol `name` whose sub-symbols `<base>_<unit>_<style>` hold `parts`' pins. */
const libSymbol = (name, parts) => `\t\t(symbol "${name}"\n${Object.entries(parts).map(([suffix, numbers]) => `\t\t\t(symbol "${name.split(':').pop()}_${suffix}"\n${numbers.map((n) => `\t\t\t\t${pin(n)}\n`).join('')}\t\t\t)\n`).join('')}\t\t)\n`

/** A placed symbol, its own pin records (`pins`) and fields given as lines. */
const placed = ({ libId, uuid, extra = '', pins = [] }) => `\t(symbol\n\t\t(lib_id "${libId}")\n\t\t(at 100 100 0)\n${extra}\t\t(uuid "${uuid}")\n\t\t(property "Reference" "U1" (at 0 0 0) ${effects})\n${pins.map((n) => `\t\t(pin "${n}"\n\t\t\t(uuid "00000000-0000-4000-8000-00000000000${n}")\n\t\t)\n`).join('')}\t\t(instances\n\t\t\t(project "p" (path "/x" (reference "U1") (unit 1)))\n\t\t)\n\t)\n`

const sheet = (libs, symbols) => `(kicad_sch\n\t(version 20250610)\n\t(generator "konnect")\n\t(lib_symbols\n${libs.join('')}\t)\n${symbols.join('')})\n`

/** The placed symbols of `text`, in order, as the viewer reads them. */
const symbolsOf = (text) => [...new KicadSch('test.kicad_sch', new SchematicParser().parse(text)).symbols.values()]

/** The pin numbers each placed symbol of `text` has, in order. */
const pinsOf = (text) => symbolsOf(text).map((symbol) => symbol.pins.map((p) => p.number))

const RESISTOR = libSymbol('Device:R', { '0_1': [], '1_1': ['1', '2'] })

describe('the pins of a placed symbol in the KiCad viewer', () => {
  it('come from its library symbol when it has no records, one per pin, without a uuid', () => {
    const [symbol] = symbolsOf(sheet([RESISTOR], [placed({ libId: 'Device:R', uuid: 'a1' })]))
    expect(symbol.pins.map((p) => [p.number, p.uuid])).toEqual([['1', ''], ['2', '']])
    expect(symbol.pins.map((p) => p.definition.number.text)).toEqual(['1', '2'])
  })

  it('are its own records when it has them, and only those', () => {
    const [symbol] = symbolsOf(sheet([RESISTOR], [placed({ libId: 'Device:R', uuid: 'a1', pins: ['2'] })]))
    expect(symbol.pins.map((p) => [p.number, p.uuid])).toEqual([['2', '00000000-0000-4000-8000-000000000002']])
  })

  it('are every unit\'s, since the viewer picks the unit a placement shows', () => {
    // A sheet used twice can show unit 1 on one path and unit 2 on another; the
    // viewer chooses by the placement's path, so each unit's pins have to be there.
    const quad = libSymbol('Amp:LM324', { '0_1': ['4', '11'], '1_1': ['1', '2', '3'], '2_1': ['5', '6', '7'] })
    const text = sheet([quad], [
      placed({ libId: 'Amp:LM324', uuid: 'u1', extra: '\t\t(unit 2)\n' }),
      placed({ libId: 'Amp:LM324', uuid: 'u2' }),
    ])
    const every = ['4', '11', '1', '2', '3', '5', '6', '7'].sort()
    expect(pinsOf(text).map((numbers) => [...numbers].sort())).toEqual([every, every])
  })

  it('are those of the body style the symbol is drawn in', () => {
    // `3` exists only in the De Morgan style, `9` only in the normal one.
    const gate = libSymbol('Logic:NAND', { '0_0': ['14'], '1_1': ['1', '2', '9'], '1_2': ['1', '2', '3'] })
    const text = sheet([gate], [
      placed({ libId: 'Logic:NAND', uuid: 'g1', extra: '\t\t(unit 1)\n\t\t(convert 2)\n' }),
      placed({ libId: 'Logic:NAND', uuid: 'g2', extra: '\t\t(body_style 2)\n' }),
      placed({ libId: 'Logic:NAND', uuid: 'g3' }),
    ])
    expect(pinsOf(text)).toEqual([['14', '1', '2', '3'], ['14', '1', '2', '3'], ['14', '1', '2', '9']])
  })

  it('are none when the sheet does not carry its library symbol', () => {
    expect(pinsOf(sheet([], [placed({ libId: 'Device:R', uuid: 'o1' })]))).toEqual([[]])
  })
})
