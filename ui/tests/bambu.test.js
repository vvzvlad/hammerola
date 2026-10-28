// Open in Bambu Studio, beside a 3MF's download link: the link that hands
// Bambu Studio the file, as Bambu Studio reads it back.

import { describe, expect, it } from 'vitest'

import { bambuHref } from '../src/bambu.jsx'

const PAGE_URL = 'https://hub.example/project/proj1/abc1234/?v=print'

/** What Bambu Studio does with the link: the tail after its scheme decoded,
 *  then cut at the literal `&name=` into the download address and the name. */
const opened = (href, scheme) => {
  expect(href.startsWith(scheme)).toBe(true)
  return decodeURIComponent(href.slice(scheme.length)).split('&name=')
}

describe('open in bambu studio', () => {
  it('hands macOS the whole download address, its key kept, and the name', () => {
    const href = bambuHref('/project/proj1/abc1234/plate.3mf?files=K3Y', PAGE_URL, true)
    expect(href).toBe('bambustudioopen://https%3A%2F%2Fhub.example%2Fproject%2Fproj1'
      + '%2Fabc1234%2Fplate.3mf%3Ffiles%3DK3Y%26name%3Dplate.3mf')
    expect(opened(href, 'bambustudioopen://')).toEqual([
      'https://hub.example/project/proj1/abc1234/plate.3mf?files=K3Y', 'plate.3mf'])
  })

  it('hands Windows and Linux an address with no key the same way, under their scheme', () => {
    // No query to extend: `&name=` still, since `?name=` is not what Bambu
    // Studio cuts at.
    const href = bambuHref('/project/proj1/abc1234/plate.3mf', PAGE_URL, false)
    expect(href).toBe('bambustudio://open?file=https%3A%2F%2Fhub.example%2Fproject%2Fproj1'
      + '%2Fabc1234%2Fplate.3mf%26name%3Dplate.3mf')
    expect(opened(href, 'bambustudio://open?file=')).toEqual([
      'https://hub.example/project/proj1/abc1234/plate.3mf', 'plate.3mf'])
  })
})
