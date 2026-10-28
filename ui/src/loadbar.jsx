// What a document view shows while its file comes in: the bytes received so
// far against the file's size, as a label and a bar under it, in the middle of
// the view (BoardView3D.jsx, KicadView.jsx, GerberView.jsx, DocumentView.jsx).
// It covers the nearest positioned box, so a view draws it in its own
// positioned shell (markdown, which has none, in a box of its own) rather than
// inside the note it gives an error.
//
// THE SIZE IS THE DOCUMENT'S `bytes` in meta.json (src/render.py), not the
// answer's `Content-Length`: the proxy compresses the answer, so that header
// counts the compressed bytes, while the chunks read off the body arrive
// decoded and add up to the file itself, which is what `bytes` measures.

import React from 'react';

import { css, MONO } from './style.jsx';

/** A running count of bytes, told to `onBytes` at most once per animation
 *  frame however many chunks land in it: the returned function counts `n`
 *  more. */
export function meter(onBytes) {
  let received = 0;
  let frame = 0;
  return (n) => {
    received += n;
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        onBytes(received);
      });
    }
  };
}

/** The body of `url`, every chunk's length counted on `count` (`meter`) as it
 *  arrives: an ArrayBuffer, or the text when `text` is set. An answer that is
 *  not ok rejects with its status. */
export async function fetchBody(url, count, text = false) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    count(value.length);
  }
  const body = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return text ? new TextDecoder().decode(body) : body.buffer;
}

/** Resolves once a frame has been painted. Awaited between the last byte and
 *  the heavy reading of a file: started in the task the last chunk lands in,
 *  the reading would hold the frame that paints the full bar and `Preparing…`
 *  until it is over.
 *
 *  TWO frames, not one: the `Preparing…` the caller has just asked React for
 *  is put on the page by a task of React's own, which the browser may run
 *  after the next frame rather than before it; that frame then still shows the
 *  bar part-way, and the reading after it holds the page there. React's task
 *  runs before the frame after, which is the one waited for; the timeout
 *  starts the reading once that frame is out.
 *
 *  A hidden page paints no frames and calls no animation frame, so there it
 *  resolves at once: the reading goes on in the background and the view is
 *  ready when the reader comes back. */
export const painted = () => new Promise((resolve) => {
  if (document.visibilityState === 'hidden') resolve();
  else requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
});

// No width transition on the fill: width animates on the main thread, so the
// reading after `painted` would freeze the bar short of full.
const CENTER = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
  + 'justify-content:center;gap:12px;padding:24px 28px;box-sizing:border-box;pointer-events:none;'
  + `font:400 12.5px ${MONO};color:var(--text-muted)`;
const TRACK = 'width:260px;max-width:100%;height:4px;border-radius:2px;overflow:hidden;background:var(--line)';
const FILL = 'height:100%;border-radius:2px;background:var(--accent)';

/** `received` of `total` bytes in the unit the total reads in: megabytes from
 *  one, else kilobytes, as a document's size is written (`docSize`). */
function amount(received, total) {
  const [unit, name] = total >= 1e6 ? [1e6, 'MB'] : [1e3, 'kB'];
  return `${(received / unit).toFixed(1)} / ${(total / unit).toFixed(1)} ${name}`;
}

/** The label and the bar, centred over the view's positioned shell:
 *  `received` of `total` bytes, never past a full bar, or, once every byte is
 *  in (`done`) and until the view is drawn, a full bar under `Preparing…`. */
export function loadBar(received, total, done) {
  const share = done ? 1 : Math.min(1, received / total) || 0;
  return (
    <div data-loading="" style={css(CENTER)}>
      <div>{done ? 'Preparing…' : `Loading… ${amount(received, total)}`}</div>
      <div data-loadbar="" style={css(TRACK)}>
        <div style={{ ...css(FILL), width: `${share * 100}%` }} />
      </div>
    </div>
  );
}
