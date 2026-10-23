// The pin entries a schematic is handed to the KiCad viewer with (kicadpins.js):
// added to a placed symbol that has none, from its library symbol, and nothing
// else touched. The sheets are synthetic s-expressions shaped as KiCad writes
// them; what the viewer then draws is checked in a browser, not here.

import { describe, expect, it } from 'vitest'

import { addPinEntries, parseSexpr, pinUuid } from '../src/kicadpins.js'

const pin = (number) => `(pin passive line (at 0 0 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "${number}" (effects (font (size 1.27 1.27)))))`

/** A library symbol `name` whose sub-symbols `<base>_<unit>_<style>` hold `parts`' pins. */
const libSymbol = (name, parts) => `\t\t(symbol "${name}"\n${Object.entries(parts).map(([suffix, numbers]) => `\t\t\t(symbol "${name.split(':').pop()}_${suffix}"\n${numbers.map((n) => `\t\t\t\t${pin(n)}\n`).join('')}\t\t\t)\n`).join('')}\t\t)\n`

/** A placed symbol, its own entries (`pins`) and fields given as lines. */
const placed = ({ libId, uuid, extra = '', pins = [] }) => `\t(symbol\n\t\t(lib_id "${libId}")\n\t\t(at 100 100 0)\n${extra}\t\t(uuid "${uuid}")\n\t\t(property "Reference" "U1" (at 0 0 0))\n${pins.map((n) => `\t\t(pin "${n}"\n\t\t\t(uuid "00000000-0000-4000-8000-00000000000${n}")\n\t\t)\n`).join('')}\t\t(instances\n\t\t\t(project "p" (path "/x" (reference "U1") (unit 1)))\n\t\t)\n\t)\n`

const sheet = (libs, symbols) => `(kicad_sch\n\t(version 20250610)\n\t(generator "konnect")\n\t(lib_symbols\n${libs.join('')}\t)\n${symbols.join('')})\n`

/** The pin numbers each placed symbol of `text` carries, in order. */
function entries(text) {
  const root = parseSexpr(text)
  return root.list.filter((c) => c.list && c.list[0].atom === 'symbol')
    .map((s) => s.list.filter((c) => c.list && c.list[0].atom === 'pin').map((p) => p.list[1].atom))
}

const RESISTOR = libSymbol('Device:R', { '0_1': [], '1_1': ['1', '2'] })

describe('pin entries for the KiCad viewer', () => {
  it('are added to a placed symbol that has none, one per pin, before its instances', () => {
    const text = sheet([RESISTOR], [placed({ libId: 'Device:R', uuid: 'a1' })])
    const out = addPinEntries(text)
    expect(entries(out)).toEqual([['1', '2']])
    expect(out).toContain(`(pin "1" (uuid "${pinUuid('a1/1')}"))\n\t\t(pin "2" (uuid "${pinUuid('a1/2')}"))\n\t\t(instances`)
    // only inserted into: dropping what was added gives the sheet back
    expect(out.replace(/\(pin "\d" \(uuid "[0-9a-f-]{36}"\)\)\n\t\t/g, '')).toBe(text)
    expect(addPinEntries(text)).toBe(out)
    expect(pinUuid('a1/1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // a symbol with no instances gets them before its closing parenthesis
    const bare = sheet([RESISTOR], ['\t(symbol (lib_id "Device:R") (uuid "b1"))\n'])
    expect(entries(addPinEntries(bare))).toEqual([['1', '2']])
  })

  it('leave a sheet KiCad wrote, with its entries, byte for byte', () => {
    const text = sheet([RESISTOR], [placed({ libId: 'Device:R', uuid: 'a1', pins: ['1', '2'] })])
    expect(addPinEntries(text)).toBe(text)
  })

  it('give a symbol the pins of every unit, since the viewer picks the unit a placement shows', () => {
    // A sheet used twice can show unit 1 on one path and unit 2 on another; the
    // viewer chooses by the placement's path, so each unit's pins have to be there.
    const quad = libSymbol('Amp:LM324', { '0_1': ['4', '11'], '1_1': ['1', '2', '3'], '2_1': ['5', '6', '7'] })
    const text = sheet([quad], [
      placed({ libId: 'Amp:LM324', uuid: 'u1', extra: '\t\t(unit 2)\n' }),
      placed({ libId: 'Amp:LM324', uuid: 'u2' }),
    ])
    const every = ['4', '11', '1', '2', '3', '5', '6', '7']
    expect(entries(addPinEntries(text)).map((numbers) => [...numbers].sort())).toEqual([[...every].sort(), [...every].sort()])
  })

  it('take the pins of the body style the symbol is drawn in', () => {
    // `3` exists only in the De Morgan style, `9` only in the normal one.
    const gate = libSymbol('Logic:NAND', { '0_0': ['14'], '1_1': ['1', '2', '9'], '1_2': ['1', '2', '3'] })
    const text = sheet([gate], [
      placed({ libId: 'Logic:NAND', uuid: 'g1', extra: '\t\t(unit 1)\n\t\t(convert 2)\n' }),
      placed({ libId: 'Logic:NAND', uuid: 'g2', extra: '\t\t(body_style 2)\n' }),
      placed({ libId: 'Logic:NAND', uuid: 'g3' }),
    ])
    expect(entries(addPinEntries(text))).toEqual([['14', '1', '2', '3'], ['14', '1', '2', '3'], ['14', '1', '2', '9']])
  })

  it('read past quotes, escaped quotes and parentheses inside a string', () => {
    const tricky = '\t\t(property "Value" "10\\" (x) \\\\ \\"k" (at 0 0 0))\n'
    const text = sheet([RESISTOR], [placed({ libId: 'Device:R', uuid: 'q1', extra: tricky })])
    const out = addPinEntries(text)
    expect(entries(out)).toEqual([['1', '2']])
    expect(out).toContain(tricky)
  })

  it('return anything they cannot read as it was, without throwing', () => {
    const unread = ['', '   ', 'garbage', '(kicad_sch (symbol', '(kicad_sch (lib_id "open)', '(kicad_sch) (extra)',
      ')(', '(kicad_pcb (symbol (lib_id "Device:R")))']
    for (const text of unread) expect(addPinEntries(text)).toBe(text)
    expect(addPinEntries(undefined)).toBe(undefined)
    // a symbol whose library symbol the sheet does not carry
    const orphan = sheet([], [placed({ libId: 'Device:R', uuid: 'o1' })])
    expect(addPinEntries(orphan)).toBe(orphan)
  })

  it('leave a root sheet of a hierarchy, with sheets and no symbols, as it was', () => {
    const root = '(kicad_sch\n\t(version 20250610)\n\t(lib_symbols)\n\t(sheet\n\t\t(at 10 10)\n\t\t(size 20 20)\n\t\t(property "Sheetname" "power")\n\t\t(property "Sheetfile" "power.kicad_sch")\n\t\t(pin "VIN" input (at 10 15 180))\n\t)\n)\n'
    expect(addPinEntries(root)).toBe(root)
  })
})
