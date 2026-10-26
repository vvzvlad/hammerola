// The reader of KiCad's s-expressions (ui/src/sexpr.js) that kicadnets.js and
// kicadsheets.js read a design's texts with: a string is read to its closing
// quote, whatever it holds, and anything but one balanced list is refused.

import { describe, expect, it } from 'vitest'

import { children, head, parseSexpr, valueOf } from '../src/sexpr.js'

describe('the s-expression reader', () => {
  it('reads past quotes, escaped quotes, backslashes and parentheses inside a string', () => {
    const tricky = '(property "Value" "10\\" (x) \\\\ \\"k" (at 0 0 0))'
    const text = `(kicad_sch\n\t${tricky}\n\t(uuid "a1")\n)\n`
    const root = parseSexpr(text)
    expect(head(root)).toBe('kicad_sch')
    const [property] = children(root, 'property')
    expect(property.list.map((node) => node.atom ?? head(node))).toEqual(['property', 'Value', '10" (x) \\ "k', 'at'])
    expect(text.slice(property.start, property.end)).toBe(tricky)
    // what follows the string is read as it is written
    expect(valueOf(children(property, 'at')[0])).toBe('0')
    expect(valueOf(children(root, 'uuid')[0])).toBe('a1')
  })

  it('throws on anything but exactly one balanced list', () => {
    const unread = ['', '   ', 'garbage', '(kicad_sch (symbol', '(kicad_sch (lib_id "open)', '(kicad_sch) (extra)', ')(']
    for (const text of unread) expect(() => parseSexpr(text), JSON.stringify(text)).toThrow()
  })
})
