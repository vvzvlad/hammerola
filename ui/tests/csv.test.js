// The rows of a CSV document, which DocumentView.jsx draws as a table.

import { describe, expect, it } from 'vitest'

import { csvDelimiter, decodeCsv, parseCsv } from '../src/csv.js'

describe('parseCsv', () => {
  it('reads RFC 4180: commas, line breaks and quotes inside quotes, CRLF, no row after the last break', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n'))
      .toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']])
  })

  it('keeps empty fields, an empty line and a quote inside a bare field', () => {
    expect(parseCsv('a,,c\n\n5" bolt,')).toEqual([['a', '', 'c'], [''], ['5" bolt', '']])
    expect(parseCsv('')).toEqual([])
  })

  it('splits on the delimiter its header line holds most of outside quotes: a semicolon, a tab, else a comma', () => {
    expect(parseCsv('"Value";"Qty";"Parts";\n"100n";"2";"C1, C2";\n'))
      .toEqual([['Value', 'Qty', 'Parts'], ['100n', '2', 'C1, C2']])
    expect(parseCsv('Ref\tQty\nR1\t2')).toEqual([['Ref', 'Qty'], ['R1', '2']])
    expect(csvDelimiter('"a;b;c",d\n1;2;3;4')).toBe(',')
    expect(csvDelimiter('a;b,c\n')).toBe(',')
    expect(csvDelimiter('Ref\n')).toBe(',')
  })

  it('drops a last field empty in every row, the delimiter Eagle ends each line with, and only then', () => {
    expect(parseCsv('a;b;\n1;2;\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b,\nc,d,e\n')).toEqual([['a', 'b', ''], ['c', 'd', 'e']])
  })
})

describe('decodeCsv', () => {
  it('reads UTF-8, and windows-1251 when the bytes are not UTF-8', () => {
    expect(decodeCsv(new TextEncoder().encode('Сумма;Qty'))).toBe('Сумма;Qty')
    expect(decodeCsv(new Uint8Array([0xd1, 0xf3, 0xec, 0xec, 0xe0, 0x3b, 0x51]))).toBe('Сумма;Q')
  })
})
