// The BOM's table (ui/src/BomView.jsx) and its pure half (ui/src/kicadbom.js):
// a part per designator, its type and package, a value's magnitude, and the
// search, the filters, the grouping and the sort over the parts. KicadView's
// side — the rows read from the schematic's element, a designator opening the
// board, a datasheet's cell and window — is in kicad.test.js. The footprints
// and designators are those of a real board.

import { describe, expect, it, vi } from 'vitest'

import BomView from '../src/BomView.jsx'
import {
  BOM_SORT, bomParts, bomTable, compareValues, packageChips, partPackage, partType, typeChips, valueMagnitude,
} from '../src/kicadbom.js'
import { collect, texts } from './eltree.js'

describe('a part of the BOM', () => {
  it('has the package its footprint\'s name says, else the whole name, the library dropped', () => {
    const packages = {
      'Capacitor_SMD:C_1206_3216Metric': '1206',
      'Capacitor_SMD:C_0603_1608Metric': '0603',
      'Resistor_SMD:R_0805_2012Metric': '0805',
      'Capacitor_Tantalum_SMD:CP_EIA-3216-18_Kemet-A': 'EIA-3216-18',
      'Package_TO_SOT_SMD:SOT-23': 'SOT-23',
      'Package_TO_SOT_SMD:SOT-223-3_TabPin2': 'SOT-223-3',
      'Package_TO_SOT_SMD:TSOT-23-6': 'TSOT-23-6',
      'Package_SO:TSSOP-24_4.4x7.8mm_P0.65mm': 'TSSOP-24',
      'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm': 'SOIC-8',
      'Package_SO:TI_SO-PowerPAD-8_ThermalVias': 'SO-PowerPAD-8',
      'Diode_SMD:D_SMA': 'SMA',
      'ukuetis:WSON-6-1EP_2x2mm_P0.65mm_EP1x1.6mm_NoPasteEP': 'WSON-6-1EP',
      'ukuetis:SOIC-20W_7.5x15.4mm_P1.27mm_Creepage8.0mm': 'SOIC-20W',
      'Package_SO:SOP-8_3.9x4.9mm_P1.27mm': 'SOP-8',
      'Package_SO:VSSOP-8_2.3x2mm_P0.5mm': 'VSSOP-8',
      'Package_SO:HTSSOP-20-1EP_4.4x6.5mm_P0.65mm': 'HTSSOP-20-1EP',
      'ukuetis:TerminalBlock_DORABO_DB125-3.5-2P': 'TerminalBlock_DORABO_DB125-3.5-2P',
      'ukuetis:Fuse_Littelfuse_0215001.MXEP_Axial_P25.50mm': 'Fuse_Littelfuse_0215001.MXEP_Axial_P25.50mm',
    }
    expect(Object.fromEntries(Object.keys(packages).map((footprint) => [footprint, partPackage(footprint)])))
      .toEqual(packages)
  })

  it('has the type its designator starts with', () => {
    const refs = ['J_CAN1', 'D_OUT1', 'Q_OUT1', 'MR6', 'MU1', 'LED1', 'SW1', 'TP701', 'RT1', 'RV1', 'PS1', 'C12']
    expect(refs.map(partType)).toEqual(['J', 'D', 'Q', 'MR', 'MU', 'LED', 'SW', 'TP', 'RT', 'RV', 'PS', 'C'])
  })

  it('sorts by its value\'s magnitude, values with none after them in natural order', () => {
    const values = ['NE555', '10k', '4k7', '100nF 25V X7R', '2R2', '1N4148', '100R', '1M', '22p', '4.7µF', '1uF/50V',
      'BC847', '10', '74HC595']
    expect([...values].sort(compareValues)).toEqual(['22p', '100nF 25V X7R', '1uF/50V', '4.7µF', '2R2', '10', '100R',
      '4k7', '10k', '1M', '1N4148', '74HC595', 'BC847', 'NE555'])
    expect(['NE555', '1N4148', '74HC595', '', '1.5KE6.8CA'].map(valueMagnitude)).toEqual([null, null, null, null, null])
  })
})

// Two groups the viewer made of one footprint and value, apart by DNP, and a
// datasheet for U1 alone.
const ITEMS = [
  { references: ['C2', 'C10', 'C1'], value: '100nF 25V X7R', footprint: 'Capacitor_SMD:C_0603_1608Metric', qty: 3, dnp: false },
  { references: ['C5'], value: '10uF', footprint: 'Capacitor_SMD:C_1206_3216Metric', qty: 1, dnp: false },
  { references: ['R3', 'R1'], value: '4k7', footprint: 'Resistor_SMD:R_0805_2012Metric', qty: 2, dnp: false },
  { references: ['R2'], value: '4k7', footprint: 'Resistor_SMD:R_0805_2012Metric', qty: 1, dnp: true },
  { references: ['U1'], value: 'TPS54331', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', qty: 1, dnp: false },
  { references: ['J_CAN1'], value: 'CAN', footprint: 'ukuetis:TerminalBlock_DORABO_DB125-3.5-2P', qty: 1, dnp: false },
]
const SHEET = { value: 'https://www.ti.com/lit/ds/tps54331.pdf', text: 'www.ti.com' }
// A datasheet of the build, its cell showing the document's name, not the field.
const DOC_SHEET = { value: '${KIPRJMOD}/ds/cl.pdf', text: 'Samsung MLCC' }
const PARTS = bomParts(ITEMS, (ref) => ({ U1: SHEET, C5: DOC_SHEET })[ref] || null)
const VIEW = { query: '', types: [], packages: [], dnp: 'all', grouped: true, sort: BOM_SORT }
/** The rows `bomTable` gives for the reader's `patch`, as `designators qty`. */
const table = (patch) => bomTable(PARTS, { ...VIEW, ...patch }).map((row) => `${row.references.join(' ')} ${row.qty}`)

describe('the BOM\'s table', () => {
  it('opens grouped, a row per footprint, value and DNP, in KiCad\'s order; ungrouped, a row per part', () => {
    expect(table({})).toEqual(['C1 C2 C10 3', 'C5 1', 'J_CAN1 1', 'R1 R3 2', 'R2 1', 'U1 1'])
    expect(table({ grouped: false })).toEqual(['C1 1', 'C2 1', 'C5 1', 'C10 1', 'J_CAN1 1', 'R1 1', 'R2 1', 'R3 1', 'U1 1'])
  })

  it('groups the parts a search keeps, each group listing and counting only those', () => {
    // a designator, then a value, a footprint and a datasheet, ignoring case
    expect(table({ query: 'c1' })).toEqual(['C1 C10 2'])
    expect([table({ query: ' 4K7 ' }), table({ query: 'soic' }), table({ query: 'TI.com' })])
      .toEqual([['R1 R3 2', 'R2 1'], ['U1 1'], ['U1 1']])
    // a datasheet by the name its cell shows as well as by its field
    expect([table({ query: 'samsung' }), table({ query: 'ds/cl' })]).toEqual([['C5 1'], ['C5 1']])
  })

  it('keeps the parts of any chip of a filter and of every filter at once', () => {
    expect(typeChips(PARTS)).toEqual([{ name: 'C', count: 4 }, { name: 'J', count: 1 }, { name: 'R', count: 3 },
      { name: 'U', count: 1 }])
    expect(packageChips(PARTS).map((chip) => chip.name)).toEqual(['0603', '0805', '1206', 'SOIC-8',
      'TerminalBlock_DORABO_DB125-3.5-2P'])
    expect(table({ types: ['C', 'J'] })).toEqual(['C1 C2 C10 3', 'C5 1', 'J_CAN1 1'])
    expect(table({ types: ['C'], packages: ['1206', '0805'] })).toEqual(['C5 1'])
    expect(table({ types: ['R'], query: 'r3' })).toEqual(['R3 1'])
  })

  it('keeps every part, the parts fitted, or those not fitted', () => {
    expect([table({ types: ['R'] }), table({ types: ['R'], dnp: 'without' }), table({ types: ['R'], dnp: 'only' })])
      .toEqual([['R1 R3 2', 'R2 1'], ['R1 R3 2'], ['R2 1']])
  })
})

describe('the BOM on screen', () => {
  /** The table with `props`, its state written at once, as React would. */
  function shown(props = {}) {
    const view = new BomView({ items: ITEMS, datasheets: new Map(), webDatasheets: new Map(), base: '', documents: [],
      hasBoard: true, onPart: vi.fn(), onDatasheet: vi.fn(), ...props })
    view.setState = (patch) => Object.assign(view.state, patch)
    return view
  }
  const pick = (view, test) => collect(view.render(), (el) => (test(el) ? el : undefined))
  const heads = (view) => pick(view, (el) => el.type === 'th')
  /** The rows as drawn, each its designators. */
  const rows = (view) => pick(view, (el) => el.type === 'tr' && el.key !== null)
    .map((row) => collect(row, (el) => el.props['data-ref']).join(' '))

  it('narrows and groups its rows by its controls', () => {
    const view = shown()
    const chips = pick(view, (el) => el.props['data-chip'])
    expect(chips.map((el) => texts(el))).toEqual([['C', '4'], ['J', '1'], ['R', '3'], ['U', '1'], ['0603'], ['0805'], ['1206'],
      ['SOIC-8'], ['TerminalBlock_DORABO_DB125-3.5-2P']])
    chips.find((el) => el.props['data-chip'] === 'types:R').props.onClick()
    expect(rows(view)).toEqual(['R1 R3', 'R2'])
    pick(view, (el) => el.props['data-dnp'] === 'without')[0].props.onClick()
    expect(rows(view)).toEqual(['R1 R3'])
    pick(view, (el) => el.props.type === 'checkbox')[0].props.onChange()
    expect(rows(view)).toEqual(['R1', 'R3'])
    pick(view, (el) => el.props.type === 'search')[0].props.onChange({ target: { value: 'r3' } })
    expect(rows(view)).toEqual(['R3'])
    // a chip clicked again is off
    pick(view, (el) => el.props['data-chip'] === 'types:R')[0].props.onClick()
    expect(view.state.types).toEqual([])
  })

  it('sorts by the column whose head is clicked, a second click the other way', () => {
    const view = shown()
    const click = (name) => heads(view).find((el) => el.props['data-column'] === name).props.onClick()
    expect(heads(view).map((el) => texts(el))).toEqual([['Refs', '▲'], ['Value'], ['Footprint'], ['Qty'], ['DNP'], ['Datasheet']])
    click('Value')
    expect(rows(view)).toEqual(['C1 C2 C10', 'C5', 'R1 R3', 'R2', 'J_CAN1', 'U1'])
    click('Value')
    // rows level by value stay in KiCad's order
    expect(rows(view)).toEqual(['U1', 'J_CAN1', 'R1 R3', 'R2', 'C5', 'C1 C2 C10'])
    expect(texts(heads(view)[1])).toEqual(['Value', '▼'])
    click('Qty')
    expect(rows(view)).toEqual(['C5', 'J_CAN1', 'R2', 'U1', 'R1 R3', 'C1 C2 C10'])
  })

  it('hands a designator to `onPart`, and lists it as plain text with no board', () => {
    const view = shown()
    pick(view, (el) => el.props['data-ref'] === 'R3')[0].props.onClick()
    expect(view.props.onPart.mock.calls).toEqual([['R3']])
    const plain = shown({ hasBoard: false })
    expect(pick(plain, (el) => el.props['data-ref'])).toEqual([])
    expect(texts(plain.render())).toContain('J_CAN1')
  })
})
