// Which key steps through the schematic's pages (`schematicPageStep` in
// ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/page-keys.ts) and which
// it leaves to the browser: Command with `[` and `]` is Back and Forward on a Mac.

import { describe, expect, it } from 'vitest'

import { schematicPageStep } from '../../ecad-viewer/packages/ecad-viewer-app/src/ecad-viewer/page-keys.ts'

const key = (init) => new KeyboardEvent('keydown', init)

describe('schematicPageStep', () => {
  it('steps back and forward on the bare brackets, by key or by place', () => {
    expect(schematicPageStep(key({ key: '[', code: 'BracketLeft' }))).toBe(-1)
    expect(schematicPageStep(key({ key: ']', code: 'BracketRight' }))).toBe(1)
    expect(schematicPageStep(key({ key: 'х', code: 'BracketLeft' }))).toBe(-1)
  })

  it("leaves Command and Control with a bracket to the browser's Back and Forward", () => {
    expect(schematicPageStep(key({ key: '[', code: 'BracketLeft', metaKey: true }))).toBeNull()
    expect(schematicPageStep(key({ key: ']', code: 'BracketRight', metaKey: true }))).toBeNull()
    expect(schematicPageStep(key({ key: '[', code: 'BracketLeft', ctrlKey: true }))).toBeNull()
  })

  it('takes no other key', () => {
    expect(schematicPageStep(key({ key: 'a', code: 'KeyA' }))).toBeNull()
  })
})
