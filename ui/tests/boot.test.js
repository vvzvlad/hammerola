// The entry point (src/main.jsx), as the build page loads it: what it does to
// the browser's history before anything is drawn. `loadMeta` never answers, so
// no shell renders and nothing reaches a hub.

import { expect, it, vi } from 'vitest'

vi.mock('../src/hub.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadMeta: vi.fn(() => new Promise(() => {})),
}))

it('forgets the schematic\'s sheet of the entry a build page loads under', async () => {
  document.body.innerHTML = '<div id="hmr_root"></div>'
  window.history.replaceState({ hmr: 'latest', kicadPage: { doc: 'hw__board.kicad_sch', page: 'p' } }, '')
  await import('../src/main.jsx')
  expect(window.history.state).toEqual({ hmr: 'latest' })
})
