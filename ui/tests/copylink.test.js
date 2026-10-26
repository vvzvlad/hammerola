// Copy link, the control beside every link that downloads a file of the build:
// what it puts on the clipboard, and what it says when it could not.

import { afterEach, describe, expect, it, vi } from 'vitest'

import CopyLink, { absoluteHref, COPY_SAID_MS, copyHref } from '../src/copylink.jsx'
import { texts } from './eltree.js'

const HREF = '/project/proj1/abc1234/plate.step?files=K3Y'

const clipboardOf = (writeText) => {
  vi.stubGlobal('navigator', { clipboard: writeText ? { writeText } : undefined })
}

/** The control as React would hold it, its `setState` writing straight in. */
function control(props = { href: HREF }) {
  const view = new CopyLink(props)
  view.setState = (patch) => Object.assign(view.state, patch)
  return view
}
const click = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('copy link', () => {
  it('copies the whole address of the download link, its key included', async () => {
    // Pasted into a chat, a path is no link; the key is what lets its reader
    // download without the token.
    expect(absoluteHref(HREF)).toBe(`${window.location.origin}${HREF}`)
    const writeText = vi.fn(async () => {})
    clipboardOf(writeText)
    expect(await copyHref(HREF)).toBe(true)
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}${HREF}`)
  })

  it('does not claim a copy without a clipboard, or when the clipboard refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    clipboardOf(null)
    expect(await copyHref(HREF)).toBe(false)
    clipboardOf(vi.fn(async () => { throw new DOMException('not focused') }))
    expect(await copyHref(HREF)).toBe(false)

    // Each look is an icon that says how the copy went in its title; the
    // bar's keeps its words, which are not what reports it.
    for (const [props, words] of [[{ href: HREF }, []], [{ href: HREF, bar: true }, ['Copy link']]]) {
      const view = control(props)
      await view.copy(click())
      expect([view.render().props.title, texts(view.render())]).toEqual(['Could not copy', words])
    }
  })

  it('says it copied for a moment, then is itself again, and its click goes nowhere else', async () => {
    vi.useFakeTimers()
    clipboardOf(vi.fn(async () => {}))
    const view = control({ href: HREF, bar: true })
    expect(view.render().props.title).toBe('Copy link')
    const event = click()
    await view.copy(event)
    // Neither the download nor the page's handler that closes a menu.
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(view.render().props.title).toBe('Copied')
    vi.advanceTimersByTime(COPY_SAID_MS)
    expect(view.render().props.title).toBe('Copy link')
  })
})
