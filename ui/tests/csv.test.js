// The rows of a CSV document, which DocumentView.jsx draws as a table.

import { describe, expect, it } from 'vitest'

import { parseCsv } from '../src/csv.js'

describe('parseCsv', () => {
  it('reads RFC 4180: commas, line breaks and quotes inside quotes, CRLF, no row after the last break', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n'))
      .toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']])
  })

  it('keeps empty fields, an empty line and a quote inside a bare field', () => {
    expect(parseCsv('a,,c\n\n5" bolt,')).toEqual([['a', '', 'c'], [''], ['5" bolt', '']])
    expect(parseCsv('')).toEqual([])
  })
})
