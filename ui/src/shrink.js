// ui/src/shrink.js — the two pictures a comment carries, made small enough to
// send over the wire the reader actually has.
//
// The upload body dominates the time to send a comment (encoding is 7–90 ms,
// the hub answers in 5–45 ms), and both attachments arrive large:
//
//   * the FRAME is `el.snapshot()` — a lossless PNG in DEVICE pixels, on a
//     retina display a 3060×2240 canvas of about 1.2 MB;
//   * the PHOTO is the `File` from `<input type=file>`, up to the 8 MiB the
//     hub accepts.
//
// Both are re-encoded here, on the way into the request only. `frameBlob()`
// does not go through this: `saveFrame()` calls it too, and a frame saved to
// disk should be the full-size lossless PNG.
//
// Invariants:
//
//   1. EXIF-AWARE. Re-encoding through a canvas drops the orientation tag, so
//      without `imageOrientation: 'from-image'` a phone photo arrives sideways.
//   2. NEVER AN ENLARGEMENT, in pixels (scale capped at 1) or in bytes (if the
//      re-encode is not smaller, the original is sent).
//   3. UNABLE TO LOSE THE COMMENT. On any failure the original blob is returned
//      and the reason logged; nothing is thrown out of `shrink`.
//   4. WEBP WITH NO FALLBACK BRANCH. The hub sniffs JPEG, PNG and WebP by magic
//      bytes (`sniff_image`, src/comments.py), and a browser that cannot encode
//      WebP must hand back a PNG instead, still scaled — so no format detection
//      and no white matte.
//   5. EVERY BITMAP IS CLOSED: `createImageBitmap` decodes outside the JS heap
//      (tens of megabytes for a phone photo) and is not collected with the handle.

/** The viewport frame: what the agent needs to see WHERE the reader is pointing.
 *
 * The viewport is about 1530 CSS pixels wide on a full screen, so 1600 keeps the
 * frame at roughly its on-screen size and gives up only the device-pixel
 * doubling.
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
  // Every giving-up path goes through here, so rule 3 is one place: the
  // original blob, a console line, never a throw.
  const giveUp = (why) => { console.warn('shrink', why); return blob; };
  let bitmap = null;
  try {
  // Absent in the test runner, where returning the blob untouched is right.
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
  // A re-encode that grew is not a failure (flat fills can beat the lossy
  // codec as PNG), so it returns silently.
    if (smaller.size >= blob.size) return blob;
    return smaller;
  } catch (error) {
    return giveUp(error);
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
