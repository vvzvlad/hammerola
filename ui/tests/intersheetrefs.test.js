// The inter-sheet references the KiCad viewer draws beside a global label
// (`intersheet_refs` in ecad-viewer/packages/ecad-viewer-app/src/kicad/intersheet-refs.ts),
// read from a project in the shapes the viewer's Project holds it: its pages in
// hierarchy order, its index of labels by name and its .kicad_pro settings. The
// Project itself is not built here, its constructor starts the parser's Web
// Workers. KiCad 10.0.6 was given this design under each of these settings
// (`kicad-cli sch export svg`), and every expected string but `?` is what it drew;
// where they are drawn is checked by eye.

import { describe, expect, it } from 'vitest'

import { intersheet_refs } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/intersheet-refs.ts'
import { NetRef } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/net_ref.ts'
import { ProjectSettings } from '../../ecad-viewer/packages/ecad-viewer-app/src/kicad/project-settings.ts'

// The root, page 1, places child.kicad_sch twice (pages 2 and 3) and other.kicad_sch
// once (page 4). An entry `[name, kind]` is a label of another kind than global:
// other.kicad_sch has a local label MOVED.
const PAGES = [['/r', 't.kicad_sch', '1'], ['/r/a', 'child.kicad_sch', '2'], ['/r/b', 'child.kicad_sch', '3'], ['/r/c', 'other.kicad_sch', '4']]
const LABELS = {
  't.kicad_sch': ['SIG', 'ONLY', 'MANY', 'MOVED'],
  'child.kicad_sch': ['SIG', 'MANY', 'MOVED'],
  'other.kicad_sch': ['MANY', 'SIG', ['MOVED', 'net']],
}

/** What the global label `name` on the page at `path` shows, with `drawing` in the .kicad_pro. */
const refsOn = (path, name, drawing = {}, pages = PAGES) => {
  const index = new Map()
  for (const [file, names] of Object.entries(LABELS)) {
    for (const entry of names) {
      const [label, kind] = Array.isArray(entry) ? entry : [entry, 'global']
      index.set(label, [...(index.get(label) ?? []), new NetRef(file, label, `${file}/${label}`, kind)])
    }
  }
  const project = {
    pages: pages.map(([sheet, filename, page]) => ({ project_path: `${filename}:${sheet}`, filename, page })),
    settings: ProjectSettings.load({ schematic: { drawing: { intersheets_ref_show: true, ...drawing } } }),
    find_labels_by_name: (label) => index.get(label),
  }
  return intersheet_refs(project, name, project.pages.find((page) => page.project_path.endsWith(`:${path}`)).project_path)
}

describe('the inter-sheet references of a global label in the KiCad viewer', () => {
  it('are the other pages carrying a global label of its name, bare, when the project sets nothing else', () => {
    expect(['SIG', 'MOVED', 'ONLY'].map((name) => refsOn('/r', name))).toEqual(['2,3,4', '2,3', ''])
    expect(refsOn('/r/c', 'SIG')).toEqual('1,2,3')
    expect(refsOn('/r', 'NOWHERE')).toEqual('?')
  })

  it('count a sheet used twice once per use, each use leaving out only its own page', () => {
    expect([refsOn('/r/a', 'SIG'), refsOn('/r/b', 'SIG'), refsOn('/r/a', 'MOVED')]).toEqual(['1,3,4', '1,2,4', '1,3'])
  })

  it('take in the own page under intersheets_ref_own_page', () => {
    const own = { intersheets_ref_own_page: true }
    expect([refsOn('/r', 'SIG', own), refsOn('/r', 'ONLY', own)]).toEqual(['1,2,3,4', '1'])
  })

  it('run from first to last past two pages under intersheets_ref_short, between the prefix and the suffix', () => {
    const short = { intersheets_ref_short: true, intersheets_ref_prefix: '[', intersheets_ref_suffix: ']' }
    const own = { ...short, intersheets_ref_own_page: true }
    expect(['SIG', 'MOVED', 'ONLY'].map((name) => refsOn('/r', name, own))).toEqual(['[1..4]', '[1..3]', '[1]'])
    expect(['SIG', 'MOVED', 'ONLY'].map((name) => refsOn('/r', name, short))).toEqual(['[2..4]', '[2,3]', '[]'])
  })

  it('go in page-number order rather than hierarchy order', () => {
    const pages = [['/r', 't.kicad_sch', '1'], ['/r/a', 'child.kicad_sch', '10'], ['/r/b', 'child.kicad_sch', '2'], ['/r/c', 'other.kicad_sch', '9']]
    const own = { intersheets_ref_own_page: true }
    expect([refsOn('/r', 'SIG', own, pages), refsOn('/r', 'MOVED', own, pages)]).toEqual(['1,2,9,10', '1,2,10'])
  })
})
