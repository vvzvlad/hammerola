// ui/src/shrink.js — the two pictures a comment carries, made small enough to
// send over the wire the reader actually has.
//
// WHAT THIS IS FOR, measured rather than guessed. Pressing Send took fifteen
// seconds, and the two halves that could have explained it do not: encoding the
// frame is 7–90 ms and the hub answers in 5–45 ms. The time is the BODY going
// up. There are two attachments and neither was touched before it left:
//
//   * the FRAME is `el.snapshot()`, the library's own render — a lossless PNG
//     in DEVICE pixels, which on a retina display is a 3060×2240 canvas and
//     1.2 MB of it;
//   * the PHOTO is the `File` straight out of `<input type=file>`, up to the
//     8 MiB the hub accepts, exactly as the phone wrote it.
//
// So both are re-encoded here, on the way into the request and nowhere else.
// `frameBlob()` deliberately does NOT go through this: `saveFrame()` calls it
// too, and a reader saving the frame to disk wants the full-size lossless PNG.
//
// FIVE THINGS THIS FILE IS, each of which is a bug if it is dropped:
//
//   1. EXIF-AWARE. A phone photo is stored in the sensor's orientation with an
//      EXIF tag saying how to turn it, and everything that has shown it so far
//      — the browser, the agent — reads that tag. Re-encoding through a canvas
//      throws the tag away, so without `imageOrientation: 'from-image'` the
//      picture of the defect arrives lying on its side.
//   2. NEVER AN ENLARGEMENT. Neither in pixels — the scale is capped at 1, so
//      an image already under `maxSide` is left at its size — nor in BYTES: a
//      screenshot of flat fills occasionally encodes larger than the PNG it
//      came from, and then the original is what gets sent.
//   3. UNABLE TO LOSE THE COMMENT. Every step here is best-effort. Whatever
//      fails — no `createImageBitmap`, a blob that will not decode, no canvas,
//      a `toBlob` that hands back null — the ORIGINAL blob is returned, the
//      reason is logged, and the comment goes as it would have before this
//      module existed. Nothing is thrown out of `shrink`: the picture is an
//      attachment to the comment, and the comment is the thing being sent.
//   4. WEBP WITH NO FALLBACK BRANCH, because the fallback is in the platform.
//      The hub takes JPEG, PNG and WebP and decides which by the magic bytes
//      (`sniff_image`, src/comments.py), so the encoding is ours to choose; and
//      a browser that cannot encode WebP is required by the canvas spec to hand
//      back a PNG instead, which is still the SCALED image. That is the whole
//      of the fallback: no format detection, no JPEG branch, and no white
//      matte, which only a format without alpha would need.
//   5. TIDY WITH BITMAPS. `createImageBitmap` decodes into a buffer that is not
//      the JS heap and is not collected with the handle — tens of megabytes for
//      a phone photo — so every one of them is closed.

/** The viewport frame: what the agent needs to see WHERE the reader is pointing.
 *
 * The viewport is about 1530 CSS pixels wide on a full screen, so 1600 is the
 * frame at roughly its on-screen size — the device-pixel doubling is the part
 * being given up, and none of it was ever visible to the person who framed the
 * shot.
 */
export const SHOT_MAX_SIDE = 1600;
export const SHOT_QUALITY = 0.85;

/** The photo: a picture of a DEFECT, which is the detail being sent.
 *
 * Bigger and less compressed than the frame on purpose. The reader is
 * photographing a layer split or a warped edge, and the thing worth looking at
 * can be a few millimetres of a print.
 */
export const PHOTO_MAX_SIDE = 2000;
export const PHOTO_QUALITY = 0.8;

/**
 * `blob`, re-encoded as WebP with its long side no greater than `maxSide`.
 *
 * Returns the ORIGINAL blob rather than throwing, on any failure and whenever
 * the re-encode did not actually save anything — see 2 and 3 in the header.
 */
export async function shrink(blob, { maxSide, quality }) {
  // EVERY GIVING-UP PATH GOES THROUGH HERE, which is what makes rule 3 a
  // property of this function rather than of four separate branches: one place
  // decides what a failure costs — the original blob, a line in the console,
  // and never a throw — so the next branch added cannot quietly return
  // something else, or return nothing at all.
  const giveUp = (why) => { console.warn('shrink', why); return blob; };
  let bitmap = null;
  try {
    // The decoder is the one piece here with no fallback worth writing: it is
    // in every browser this page runs in, and it is absent in the test runner,
    // where returning the blob untouched is exactly the right answer.
    if (typeof createImageBitmap !== 'function') {
      return giveUp('this browser has no createImageBitmap');
    }
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    // Rounded, and never to zero: a canvas of zero width encodes nothing.
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return giveUp('the canvas gave back no 2d context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const smaller = await new Promise((done) => {
      canvas.toBlob(done, 'image/webp', quality);
    });
    // `toBlob` reports failure by CALLING BACK WITH NULL rather than throwing,
    // so this is read as a value; without it the null would reach the form.
    if (!smaller) return giveUp('the encoder produced nothing');
    // A re-encode that grew is not a failure, it is an answer — the frame is
    // mostly flat fill and PNG beat the lossy codec at it — so it is the one
    // way out of here that has nothing to say in the console.
    if (smaller.size >= blob.size) return blob;
    return smaller;
  } catch (error) {
    return giveUp(error);
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
