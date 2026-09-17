// The re-encode a comment's two attachments go through on the way out —
// ui/src/shrink.js.
//
// THIS RUNNER CANNOT SEE A PIXEL, and that is the shape of every test here.
// There is no `createImageBitmap` in jsdom at all, and there is no rasteriser
// behind `<canvas>` either — the `canvas` package is deliberately not in
// ui/package.json — so `getContext('2d')` answers null and nothing that draws
// can be checked by looking at what came out.
//
// What CAN be checked is the policy, which is the whole of what this module
// decides: how big the canvas was made, that the proportion survived it, what
// the encoder was asked for, which blob came back, and that the decoded bitmap
// was released. Those are stubs of the two platform calls and assertions about
// the ARGUMENTS they were handed — the pixels are the browser's half.
//
// The absence of the decoder is also load-bearing OUTSIDE this file: it is why
// `sendComment` behaves in ui/tests/feed.test.js exactly as it did before this
// module existed, and the first test below says so out loud rather than leaving
// it to be inferred from a suite that stayed green.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  shrink, SHOT_MAX_SIDE, SHOT_QUALITY, PHOTO_MAX_SIDE, PHOTO_QUALITY,
} from '../src/shrink.js'

/** A blob of a known SIZE, which is what the "did it actually shrink" rule reads. */
const bytes = (size, type = 'image/png') =>
  new Blob([new Uint8Array(size)], { type })

/** What the decoder hands back: a bitmap of a given size that counts its close(). */
const bitmap = (width, height) => ({
  width, height, closed: 0, close() { this.closed += 1 },
})

/** `createImageBitmap`, as the global, answering `answer` (or throwing it). */
function decoder(answer) {
  const decode = vi.fn(async () => {
    if (answer instanceof Error) throw answer
    return answer
  })
  vi.stubGlobal('createImageBitmap', decode)
  return decode
}

/**
 * The canvas `shrink` will find, recording everything it was asked to do.
 *
 * `document.createElement` is spied rather than replaced wholesale so a test
 * that reaches for any other element gets told, instead of silently drawing
 * onto something that is not a canvas.
 */
function canvasDouble({ out = bytes(40, 'image/webp'), context = true,
                        encode } = {}) {
  const canvas = {
    width: 0, height: 0, drawn: [], asked: [],
    getContext: (kind) => (context
      ? { kind, drawImage: (...args) => canvas.drawn.push(args) }
      : null),
    toBlob: (done, type, quality) => {
      canvas.asked.push({ type, quality })
      if (encode) { encode(done); return }
      done(out)
    },
  }
  vi.spyOn(document, 'createElement').mockImplementation((tag) => {
    if (tag !== 'canvas') throw new Error(`the module asked for <${tag}>`)
    return canvas
  })
  return canvas
}

/** console.warn, quieted — every failure path here is required to log one. */
const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// -- the runner's own state, which the rest of the suite depends on -----------

describe('the test environment', () => {
  it('has no image decoder, which is why the other suites did not move', () => {
    // If jsdom ever grows `createImageBitmap`, `sendComment` in feed.test.js
    // starts re-encoding blobs for real and the assertions there about what is
    // in the form change underneath it. This is the tripwire for that day.
    expect(typeof createImageBitmap).toBe('undefined')
  })
})

// -- the size, which is the point of the whole module -------------------------

describe('the size it draws at', () => {
  it('pulls the long side down to maxSide and keeps the proportion', async () => {
    // The measured case: `el.snapshot()` on a retina screen is 3060x2240 and
    // 1.2 MB of lossless PNG, which is the request body the reader waited on.
    const frame = bitmap(3060, 2240)
    decoder(frame)
    const canvas = canvasDouble()

    await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })

    expect(canvas.width).toBe(1600)
    expect(canvas.height).toBe(1171)
    // 2240 * 1600/3060 = 1171.2, and the ratio is what survives the rounding:
    // a canvas sized on one axis only would squash the frame instead.
    expect(canvas.drawn).toEqual([[frame, 0, 0, 1600, 1171]])
  })

  it('measures the LONG side, whichever one it is', async () => {
    // A photo off a phone is portrait far more often than not, and a cap
    // written against `width` would leave those at full height.
    decoder(bitmap(2250, 4000))
    const canvas = canvasDouble()

    await shrink(bytes(1200, 'image/jpeg'), { maxSide: 2000, quality: 0.8 })

    expect(canvas.height).toBe(2000)
    expect(canvas.width).toBe(1125)
  })

  it('never stretches an image that is already small enough', async () => {
    // The scale is capped at 1. Without the cap this module would take a
    // 640x480 snap off an old phone and hand the hub a blurred 2000px upscale
    // of it — more bytes, no more detail, and a picture of a defect that looks
    // worse than the one the reader took.
    decoder(bitmap(640, 480))
    const canvas = canvasDouble()

    await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })

    expect([canvas.width, canvas.height]).toEqual([640, 480])
  })
})

// -- what it asks the platform for --------------------------------------------

describe('the decode', () => {
  it('asks for the EXIF orientation to be applied', async () => {
    // NOT AN OPTION, a correction. A phone stores the frame the way the sensor
    // read it plus a tag saying how to turn it, and everything that has shown
    // the photo so far reads that tag. Re-encoding through a canvas throws the
    // tag away — so without this flag the picture of the defect reaches the
    // agent lying on its side.
    const decode = decoder(bitmap(4000, 3000))
    canvasDouble()
    const source = bytes(1200, 'image/jpeg')

    await shrink(source, { maxSide: 2000, quality: 0.8 })

    expect(decode).toHaveBeenCalledWith(source, { imageOrientation: 'from-image' })
  })

  it('releases the bitmap, on the way out and on the way through', async () => {
    // The decoded buffer is not on the JS heap and is not collected with the
    // handle: tens of megabytes per photo on the device least able to spare
    // them. Both paths, because the failing one is where a `close()` written at
    // the end of the happy path would be skipped.
    const good = bitmap(3060, 2240)
    decoder(good)
    canvasDouble()
    await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })
    expect(good.closed).toBe(1)

    vi.unstubAllGlobals()
    vi.restoreAllMocks()

    warnings()
    const bad = bitmap(3060, 2240)
    decoder(bad)
    canvasDouble({ context: false })
    await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })
    expect(bad.closed).toBe(1)
  })
})

describe('the encode', () => {
  it('asks for WebP at the quality it was given', async () => {
    // One format and no branch for a second: the hub takes JPEG, PNG and WebP
    // and tells them apart by their magic bytes (`sniff_image`,
    // src/comments.py), and a browser that cannot encode WebP is required by
    // the canvas spec to hand back a PNG — still scaled, which is the fallback.
    decoder(bitmap(3060, 2240))
    const canvas = canvasDouble()

    await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })

    expect(canvas.asked).toEqual([{ type: 'image/webp', quality: 0.85 }])
  })

  it('hands back what the encoder produced when it is smaller', async () => {
    const small = bytes(40, 'image/webp')
    decoder(bitmap(3060, 2240))
    canvasDouble({ out: small })

    const sent = await shrink(bytes(1200), { maxSide: 1600, quality: 0.85 })

    expect(sent).toBe(small)
  })
})

// -- and it is allowed to decide it achieved nothing ---------------------------

describe('a re-encode that did not pay', () => {
  it('sends the original when the result came out bigger', async () => {
    // It happens: a viewport frame is mostly flat fill, which PNG compresses
    // better than a lossy codec meant for photographs. Sending the bigger file
    // would make the slow press this module exists to fix slower still.
    //
    // AND IT IS NOT LOGGED, unlike every failure below: nothing went wrong
    // here, the answer is just that the original was already the better one,
    // and a console line on an ordinary outcome is how a real warning gets
    // learned as noise.
    const warn = warnings()
    const source = bytes(1200)
    decoder(bitmap(3060, 2240))
    canvasDouble({ out: bytes(1400, 'image/webp') })

    expect(await shrink(source, { maxSide: 1600, quality: 0.85 })).toBe(source)
    expect(warn).not.toHaveBeenCalled()
  })
})

// -- nothing here may cost the reader the comment ------------------------------
//
// Every one of these is a real browser: a decoder that is not there, a blob
// that will not decode, a canvas that refuses a context, an encoder that gives
// up. The comment is the thing being sent — the picture is an attachment to it
// — so each of them sends the ORIGINAL blob and says so in the console, and
// none of them throws into `sendComment`, where a throw would be a comment the
// reader loses with the draft still in the composer.
//
// EACH IS ASSERTED THE SAME THREE WAYS — resolves (rather than throws), the
// source blob back, a warning logged — because the failure being guarded
// against is silence: a path that returns undefined puts `undefined` in the
// form, and a path that throws costs the reader the draft, and neither shows
// up in a test that only checks the happy case still works.

describe('every way this can fail', () => {
  /** Ran, came back with the source, and left a line in the console. */
  async function survives(run) {
    const warn = warnings()
    const source = bytes(1200)

    await expect(run(source)).resolves.toBe(source)
    expect(warn).toHaveBeenCalled()
  }

  it('sends the original when the browser has no decoder', async () => {
    // Nothing stubbed: `createImageBitmap` is genuinely absent in this runner,
    // so this is the real branch rather than a simulated one.
    const canvas = canvasDouble()

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))

    expect(canvas.drawn).toEqual([])
  })

  it('sends the original when the blob will not decode', async () => {
    decoder(new Error('the source image cannot be decoded'))
    canvasDouble()

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))
  })

  it('sends the original when there is no 2d context', async () => {
    decoder(bitmap(3060, 2240))
    canvasDouble({ context: false })

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))
  })

  it('sends the original when there is no canvas to make at all', async () => {
    decoder(bitmap(3060, 2240))
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('no elements here')
    })

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))
  })

  it('sends the original when the encoder hands back null', async () => {
    // `toBlob`'s own way of reporting failure: the callback is called, with
    // null in it. Read as a value rather than as an error, so the check for it
    // is the only thing between that null and `form.append('shot', null)`.
    decoder(bitmap(3060, 2240))
    canvasDouble({ encode: (done) => done(null) })

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))
  })

  it('sends the original when the encoder throws', async () => {
    decoder(bitmap(3060, 2240))
    canvasDouble({ encode: () => { throw new Error('encoder is gone') } })

    await survives((source) => shrink(source, { maxSide: 1600, quality: 0.85 }))
  })
})

// -- the two settings the build page sends with ---------------------------------

describe('the sizes the comment is sent at', () => {
  it('keeps the frame at about its on-screen size', () => {
    // The viewport is around 1530 CSS pixels wide on a full screen, so the cap
    // gives up the device-pixel doubling and nothing the reader ever saw.
    expect(SHOT_MAX_SIDE).toBe(1600)
    expect(SHOT_QUALITY).toBe(0.85)
  })

  it('keeps the photo bigger, because the photo IS the detail', () => {
    // A picture of a defect: a layer split or a warped edge can be a couple of
    // millimetres of the print, and it has to survive the re-encode.
    expect(PHOTO_MAX_SIDE).toBe(2000)
    expect(PHOTO_QUALITY).toBe(0.8)
    expect(PHOTO_MAX_SIDE).toBeGreaterThan(SHOT_MAX_SIDE)
  })
})
