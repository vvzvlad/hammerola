// The size the KiCad viewer gives a schematic text
// (ecad-viewer/packages/ecad-viewer-app/src/kicad/text/eda-text.ts). KiCad writes a
// font size as `(size HEIGHT WIDTH)`; texts imported from Eagle are narrower than
// they are tall, and read the other way round they are drawn wider and lower than
// in KiCad, over the wires and symbols beside them.

import { SchematicParser } from 'kicad-parser'
import { describe, expect, it } from 'vitest'

import { KicadSch } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/index.ts'
import { SchText } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/text/sch-text.ts'

const sheet = '(kicad_sch\n\t(version 20250610)\n\t(generator "konnect")\n\t(lib_symbols\n\t)\n'
  + '\t(text "B1"\n\t\t(at 10 10 0)\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.778 1.5113)\n\t\t\t)\n\t\t)\n'
  + '\t\t(uuid "00000000-0000-4000-8000-000000000001")\n\t)\n)\n'

describe('a schematic text in the KiCad viewer', () => {
  it('is as tall as the first number of its font size and as wide as the second', () => {
    const [text] = new KicadSch('test.kicad_sch', new SchematicParser().parse(sheet)).drawings
    const drawn = new SchText(text.text)
    drawn.apply_effects(text.effects)
    expect([drawn.text_height, drawn.text_width]).toEqual([17780, 15113])
  })
})
