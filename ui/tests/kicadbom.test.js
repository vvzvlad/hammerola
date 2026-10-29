// The BOM's table (ui/src/BomView.jsx) and its pure half (ui/src/kicadbom.js):
// a part per designator, its type and package, a value's magnitude, each
// column's filter in its head, and the search, the grouping and the sort.
// KicadView's side — the rows read from the schematic's element, a designator
// opening the board, a datasheet's cell and window — is in kicad.test.js. The
// footprints and designators are those of a real board.

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import BomView from '../src/BomView.jsx'
import {
  BOM_SORT, bomFilters, bomParts, bomTable, compareValues, entryOrder, NO_FILTER, partPackage, partType, valueMagnitude,
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
const VIEW = { query: '', excluded: NO_FILTER, grouped: true, sort: BOM_SORT }
/** The rows `bomTable` gives for the reader's `patch` and the values unchecked
 *  by column, `excluded`, as `designators qty`. */
const table = (patch, excluded = {}) => bomTable(PARTS, { ...VIEW, ...patch, excluded: { ...NO_FILTER, ...excluded } })
  .map((row) => `${row.references.join(' ')} ${row.qty}`)
/** Entries as `value:count`. */
const flat = (list) => list.map(({ key, count }) => `${key}:${count}`)

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

  it('offers each column\'s values in its own order, counting parts, and the rows\' Qty counting rows', () => {
    const filters = (grouped) => Object.fromEntries(Object.entries(bomFilters(PARTS, grouped))
      .map(([column, list]) => [column, flat(list)]))
    expect(filters(true)).toEqual({
      Refs: ['C:4', 'J:1', 'R:3', 'U:1'],
      Value: ['100nF 25V X7R:3', '10uF:1', '4k7:3', 'CAN:1', 'TPS54331:1'],
      Footprint: ['0603:3', '0805:3', '1206:1', 'SOIC-8:1', 'TerminalBlock_DORABO_DB125-3.5-2P:1'],
      Qty: ['1:4', '2:1', '3:1'],
      DNP: [':8', 'DNP:1'],
      Datasheet: [':7', 'Samsung MLCC:1', 'www.ti.com:1'],
    })
    expect(filters(false).Qty).toEqual(['1:9'])
    // by count, the greatest first, values level as they were
    expect(flat(entryOrder(bomFilters(PARTS, true).Value, true)))
      .toEqual(['100nF 25V X7R:3', '4k7:3', '10uF:1', 'CAN:1', 'TPS54331:1'])
  })

  it('keeps the parts of any value checked in a column, of every column at once, and none with none checked', () => {
    expect(table({}, { Refs: ['R', 'U'] })).toEqual(['C1 C2 C10 3', 'C5 1', 'J_CAN1 1'])
    expect(table({}, { Refs: ['J', 'R', 'U'], Footprint: ['0603'] })).toEqual(['C5 1'])
    expect(table({ query: 'r3' }, { Value: ['100nF 25V X7R'] })).toEqual(['R3 1'])
    // an empty cell is a value of its own
    expect(table({}, { Datasheet: [''] })).toEqual(['C5 1', 'U1 1'])
    expect(table({}, { Refs: ['J', 'R', 'U'], Datasheet: ['Samsung MLCC'] })).toEqual(['C1 C2 C10 3'])
    expect(table({}, { Refs: ['C', 'J', 'R', 'U'] })).toEqual([])
  })

  it('keeps every part, the parts fitted, or those not fitted', () => {
    const r = ['C', 'J', 'U']
    expect([table({}, { Refs: r }), table({}, { Refs: r, DNP: ['DNP'] }), table({}, { Refs: r, DNP: [''] }),
      table({}, { Refs: r, DNP: ['', 'DNP'] })]).toEqual([['R1 R3 2', 'R2 1'], ['R1 R3 2'], ['R2 1'], []])
  })

  it('filters by Qty the rows the grouping makes of the parts kept', () => {
    expect(table({}, { Qty: [1, 3] })).toEqual(['R1 R3 2'])
    // C1 C2 C10 cut to two by the search
    expect(table({ query: 'c1' }, { Qty: [1, 3] })).toEqual(['C1 C10 2'])
    expect(table({ grouped: false }, { Qty: [1] })).toEqual([])
  })
})

describe('the BOM on screen', () => {
  /** The table with `props`, its state written at once, as React would. */
  function shown(props = {}) {
    const view = new BomView({ items: ITEMS, datasheets: new Map(), webDatasheets: new Map(), base: '', documents: [],
      hasBoard: true, onPart: vi.fn(), onDatasheet: vi.fn(), ...props })
    view.setState = (patch) => Object.assign(view.state, patch)
    onTestFinished(() => view.componentWillUnmount())
    return view
  }
  const pick = (view, test) => collect(view.render(), (el) => (test(el) ? el : undefined))
  const heads = (view) => pick(view, (el) => el.type === 'th')
  /** The rows as drawn, each its designators. */
  const rows = (view) => pick(view, (el) => el.type === 'tr' && el.key !== null)
    .map((row) => collect(row, (el) => el.props['data-ref']).join(' '))
  const the = (view, name, value) => pick(view, (el) => el.props[name] === value)[0]
  /** The open filter's entries, each its value, its count and whether it is checked. */
  const entries = (view) => pick(view, (el) => el.props['data-entry'])
    .map((el) => [...texts(el), collect(el, (one) => (one.type === 'input' ? one.props.checked : undefined))[0]])
  const untick = (view, value) => collect(the(view, 'data-entry', value), (el) => (el.type === 'input' ? el : undefined))[0]
    .props.onChange()

  it('sorts by the column whose name is clicked, a second click the other way, and not by its ▾', () => {
    const view = shown()
    const click = (name) => the(view, 'data-sort', name).props.onClick()
    expect(heads(view).map((el) => texts(el))).toEqual([['Refs', '▲', '▾'], ['Value', '▾'], ['Footprint', '▾'],
      ['Qty', '▾'], ['DNP', '▾'], ['Datasheet', '▾']])
    click('Value')
    expect(rows(view)).toEqual(['C1 C2 C10', 'C5', 'R1 R3', 'R2', 'J_CAN1', 'U1'])
    click('Value')
    // rows level by value stay in KiCad's order
    expect(rows(view)).toEqual(['U1', 'J_CAN1', 'R1 R3', 'R2', 'C5', 'C1 C2 C10'])
    the(view, 'data-funnel', 'Qty').props.onClick()
    expect([view.state.sort, view.state.popup.column]).toEqual([{ column: 'Value', descending: true }, 'Qty'])
  })

  it('filters from a head\'s ▾, every value checked at first, the table following each tick', () => {
    const view = shown()
    the(view, 'data-funnel', 'Refs').props.onClick()
    expect(entries(view)).toEqual([['C', '4', true], ['J', '1', true], ['R', '3', true], ['U', '1', true]])
    untick(view, 'C')
    expect(rows(view)).toEqual(['J_CAN1', 'R1 R3', 'R2', 'U1'])
    expect(entries(view)[0]).toEqual(['C', '4', false])
    // the field searches the entries, not the table
    the(view, 'placeholder', 'Search values').props.onChange({ target: { value: 'r' } })
    expect([entries(view), rows(view)]).toEqual([[['R', '3', true]], ['J_CAN1', 'R1 R3', 'R2', 'U1']])
    the(view, 'placeholder', 'Search values').props.onChange({ target: { value: '' } })
    the(view, 'data-order', 'Count').props.onClick()
    expect(entries(view).map(([value]) => value)).toEqual(['C', 'R', 'J', 'U'])
    the(view, 'data-bulk', 'none').props.onClick()
    expect(rows(view)).toEqual([])
    the(view, 'data-bulk', 'all').props.onClick()
    expect(rows(view)).toEqual(['C1 C2 C10', 'C5', 'J_CAN1', 'R1 R3', 'R2', 'U1'])
    // an empty value reads `(empty)`
    the(view, 'data-funnel', 'DNP').props.onClick()
    expect(entries(view)).toEqual([['(empty)', '8', true], ['DNP', '1', true]])
  })

  it('keeps what is checked on Close and a press outside, and puts back what it opened with on Cancel and Escape', () => {
    const view = shown()
    const opened = (column, value) => {
      the(view, 'data-funnel', column).props.onClick()
      untick(view, value)
      expect(rows(view)).not.toContain('U1')
    }
    opened('Refs', 'U')
    the(view, 'data-button', 'cancel').props.onClick()
    expect([view.state.popup, rows(view).at(-1)]).toEqual([null, 'U1'])
    opened('Refs', 'U')
    the(view, 'data-button', 'close').props.onClick()
    expect([view.state.popup, view.state.excluded.Refs]).toEqual([null, ['U']])
    the(view, 'data-funnel', 'Refs').props.onClick()
    the(view, 'data-bulk', 'all').props.onClick()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect([view.state.popup, view.state.excluded.Refs]).toEqual([null, []])
    // Escape is taken, so the design under the table does nothing with it, and
    // only while a filter is open
    const page = document.body.appendChild(document.createElement('div'))
    onTestFinished(() => page.remove())
    view.card = page.appendChild(document.createElement('div'))
    opened('Value', 'TPS54331')
    const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    const first = escape()
    document.body.dispatchEvent(first)
    expect([first.defaultPrevented, view.state.popup, view.state.excluded.Value]).toEqual([true, null, []])
    const second = escape()
    document.body.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    // the BOM gone from the screen with no press: Escape is the view's, the filter kept
    opened('Value', 'TPS54331')
    page.style.visibility = 'hidden'
    const away = escape()
    document.body.dispatchEvent(away)
    expect([away.defaultPrevented, view.state.popup, view.state.excluded.Value]).toEqual([false, null, ['TPS54331']])
    // a resize closes it as kept
    page.style.visibility = ''
    opened('Refs', 'U')
    window.dispatchEvent(new Event('resize'))
    expect([view.state.popup, view.state.excluded.Refs]).toEqual([null, ['U']])
  })

  it('searches and groups from over the table', () => {
    const view = shown()
    the(view, 'type', 'checkbox').props.onChange()
    the(view, 'placeholder', 'Search').props.onChange({ target: { value: '4k7' } })
    expect(rows(view)).toEqual(['R1', 'R2', 'R3'])
  })

  it('hands a designator to `onPart`, and lists it as plain text with no board', () => {
    const view = shown()
    the(view, 'data-ref', 'R3').props.onClick()
    expect(view.props.onPart.mock.calls).toEqual([['R3']])
    const plain = shown({ hasBoard: false })
    expect(pick(plain, (el) => el.props['data-ref'])).toEqual([])
    expect(texts(plain.render())).toContain('J_CAN1')
  })
})
