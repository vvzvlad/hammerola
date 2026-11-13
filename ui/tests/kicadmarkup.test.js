// How the KiCad viewer reads the markup in a line of text
// (ecad-viewer/packages/ecad-viewer-app/src/kicad/text/markup.ts), as KiCad's
// MARKUP_PARSER does (include/markup_parser.h): `^{`, `_{` and `~{` open
// superscript, subscript and overbar, and only when a `}` closes them; everything
// else is the text itself. How the text looks is checked by eye.

import { describe, expect, it } from 'vitest'

import { Markup } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/text/markup.ts'

/** The tree written out: text as it is, a markup node as its control
 *  character and its children in square brackets. */
const tree = (node) => node.text + node.children.map((child) => {
  const mark = child.superscript ? '^' : child.subscript ? '_' : child.overbar ? '~' : ''
  return mark ? `${mark}[${tree(child)}]` : tree(child)
}).join('')

const read = (text) => tree(new Markup(text).root)

describe('the markup of a line of text', () => {
  it('reads superscript, subscript and overbar, nested too', () => {
    expect(read('V_{CC} ~{RST} x^{2}')).toBe('V_[CC] ~[RST] x^[2]')
    expect(read('~{A_{1}B}')).toBe('~[A_[1]B]')
  })

  it('keeps an opener that nothing closes, and a stray brace, as text', () => {
    expect(read('библиотеки~{')).toBe('библиотеки~{')
    expect(read('-} eeprom WP (pin 4) to GND')).toBe('-} eeprom WP (pin 4) to GND')
    // the inner markup closes; the outer, left open, is text
    expect(read('~{a^{b}')).toBe('~{a^[b]')
  })

  it('opens markup only on ^, _ and ~', () => {
    expect(read('-{x}')).toBe('-{x}')
    expect(read('${VAR}')).toBe('${VAR}')
  })

  it('does not end an overbar at the brace of an escape sequence', () => {
    expect(read('~{A{slash}B}')).toBe('~[A{slash}B]')
  })
})
