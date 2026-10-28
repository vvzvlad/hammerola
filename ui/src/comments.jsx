/**
 * Comments, as both pages hold them: the model's page (HammerolaViewer.jsx)
 * and the page of a build with no model (DocShell.jsx).
 *
 * The queue is the project's (SPEC 7A.3), read and written under the token.
 * Here are fetching it (`readFeed`), closing an item (`closeComment`), the
 * composer's draft on a document (`docDraft`) and sending a draft
 * (`sendDraft`), what a document drawn by DocumentView.jsx is handed for
 * comments (`docComment`), and the composer, the header's comments button and
 * the rail: their values (`composerView`, `railView`) and their markup
 * (`composerCard`, `commentsButton`, `commentRail`), plain functions so that
 * what they return is read as part of the page's own tree. The rail's rows are
 * `feedView` in feedview.js.
 *
 * THE PAGE. What writes is handed the page's component as `page`: its
 * `state` (`composer`, `sending`, and on the model's page `view` and
 * `proposalStands`), `set(patch)` — the page's write, which drops a place
 * asked of a document when the patch moves the document on screen
 * (`dropStaleFocus` in feedview.js) — `setState`, `toast(said)` and
 * `loadFeed(quiet)`.
 */
import React from 'react';

import { COMMENTABLE } from './DocumentView.jsx';
import { docPlace } from './feedview.js';
import { askHub, HUB_UNREACHABLE, hubBody, hubTrouble, PAGE, VARIANT_SEGMENT } from './hub.js';
import { DRAFT_MARK } from './KicadView.jsx';
import { btn, FAINT_CLICK, FILL, HEAD_SANS, IDLE, META_MONO, ON_ACCENT, ROW, DIM_CLICK } from './panelstyle.js';
// The two attachments a comment carries, made small enough to send. Imported
// only for `sendDraft`: a frame grab itself stays lossless, because Frame
// writes its answer to the reader's disk.
import {
  shrink, SHOT_MAX_SIDE, SHOT_QUALITY, PHOTO_MAX_SIDE, PHOTO_QUALITY,
} from './shrink.js';
import { css, MONO, SANS } from './style.jsx';

// The same number as the hub's ceiling on comment text —
// `comment_max_text_chars` in src/settings.py — repeated here because the page
// cannot be told the hub's value: `templates/build.html` and meta.json are
// written at publish time (src/render.py) with no per-hub values, while the
// setting is read per request.
//
// If the hub's value is raised, the form is merely stricter; if lowered, the
// textarea accepts text the hub refuses with a 422 and the photo-format toast.
// At any setting it stops a runaway paste before it becomes a multipart upload.
const MAX_COMMENT_CHARS = 4000;

/**
 * The project's comment queue, fetched into the page (`feed`).
 *
 * Per project, not per build (SPEC 7A.3): the route takes a pid and returns
 * the whole queue oldest first, so it is not refetched on a build swap; each
 * row finds its place in the build on screen through `anchorFor`.
 *
 * Never throws: a failure leaves the rail holding what it had and says so,
 * like every other fetch here.
 *
 * `quiet` is for the refetch after a write: `toast()` replaces the toast on
 * screen, so a failing refetch would paint "Could not load the comments" over
 * "Sent to the agent", and the reader might send again. A duplicate in the
 * agent's queue costs more than a rail one entry stale.
 */
export async function readFeed(page, token, quiet = false) {
  const { response, error } = await askHub(
    `/api/v1/comments?project=${encodeURIComponent(PAGE.pid)}`, token);
  if (error) {
    console.error('feed', error);
    if (!quiet) page.toast(HUB_UNREACHABLE);
    return;
  }
  const said = hubTrouble(response, 200, 'Could not load the comments');
  if (said) { if (!quiet) page.toast(said); return; }
  const { body, error: unread } = await hubBody(response);
  if (unread) {
    console.error('feed', unread);
    if (!quiet) page.toast('Could not load the comments');
    return;
  }
  page.set({ feed: (body && body.comments) || [] });
}

/**
 * Close an item in the queue.
 *
 * `POST /api/v1/comments/<id>/resolve` takes the same EDIT_TOKEN the page
 * holds. Body-less on purpose: the route reads an optional `note`, which is
 * the agent's word about what it did, not the reader's.
 *
 * The queue is refetched, not patched: the hub stamps `resolved` and may add
 * a note.
 */
export async function closeComment(page, token, id) {
  if (!id || !token) return;
  const { response, error } = await askHub(
    `/api/v1/comments/${encodeURIComponent(id)}/resolve`, token,
    { method: 'POST' });
  if (error) {
    console.error('resolve', error);
    page.toast(HUB_UNREACHABLE);
    return;
  }
  const said = hubTrouble(response, 200, 'Could not mark it processed');
  if (said) { page.toast(said); return; }
  page.toast('Marked processed');
  await page.loadFeed(true);
}

/**
 * The composer's draft for a place taken on document `doc` with the Comment
 * tool — `place`, in the comment's own fields (SPEC 7A.1): `frame`, and
 * `sheet`, `area` and the `items` in it on a KiCad design (KicadView.jsx),
 * `area` and `layer` on the Gerbers (GerberView.jsx), the part's designator,
 * `point` and `normal` on the board's 3D model (BoardView3D.jsx), `quote` on
 * markdown (DocumentView.jsx) — headed with where that is (`docPlace`), which
 * takes `part`: the designator is kept as `designator`. Over a draft already
 * standing (`composer`) it replaces where that one hangs and keeps what the
 * reader wrote and attached.
 */
export function docDraft(doc, place, composer) {
  return {
    ...place, doc: doc.file, part: docPlace(place, doc), designator: place.part || null,
    partId: null, key: null, p: null, n: null, meas: null,
    text: composer ? composer.text : '', photo: composer ? composer.photo : null,
  };
}

/** The open document's frame: what its view told the page it can do
 *  (`tools`, `onTools` in DocumentView.jsx), else null. */
export function docFrame(tools) {
  if (!tools) return Promise.resolve(null);
  return Promise.resolve().then(() => tools.frame()).catch((error) => {
    console.warn('frame', error);
    return null;
  });
}

/**
 * What a comment on `build` (its meta.json) is posted under, after the
 * project: its commit, and on the draft of a variant other than the default
 * that variant's slot, `v/<variant>/dev` — a bare `dev` is the default
 * variant's. The slot of a variant is reached only by its address, so the
 * address says which (`PAGE.variant`).
 */
export const commentTarget = (build) => (
  build.commit === 'dev' && PAGE.variant
    ? `${VARIANT_SEGMENT}/${encodeURIComponent(PAGE.variant)}/dev` : build.commit);

/**
 * The composer's draft, sent: the one Send of both pages. `build` is the
 * build on screen (its meta.json), `token` the reader's, `frame(draft)` the
 * frame on screen to send with the draft — a blob, or null — and `camera()`
 * the model's camera, which a draft on the model carries.
 */
export async function sendDraft(page, { build, token, frame, camera }) {
  const c = page.state.composer;
  if (!c || !build) return;
  // One comment at a time — the composer's one refusal.
  //
  // This spans the frame grab, its upload, the POST and the refetch, and the
  // composer keeps its text until the write clears it, so a reader may press
  // Send again. The hub cannot tell posts apart (no idempotency key, no
  // deduplication in src/comments.py), so each press would add a row to the
  // agent's queue.
  //
  // A refusal, not a queue: a second press is the same draft. Lowered in the
  // `finally` below, on error paths too, so a refused comment can be resent.
  if (page.state.sending) return;
  // Refused here rather than only by the hub, since step 0 put the write
  // behind the token. Not a security check — the hub's is — but the difference
  // between "you are not signed in" and a 403 arriving after the photo has
  // been uploaded and the frame grabbed. The composer cannot normally be open
  // without a token, because clearing one closes it; what this covers is the
  // token going away between opening the composer and pressing Send.
  if (!token) { page.toast('Add the token to comment'); return; }
  const text = (c.text || '').trim();
  if (!text) { page.toast('Write something first'); return; }

  // RAISED BEFORE THE FIRST AWAIT and after the refusals above, which return
  // without sending anything: a flag raised on a press that did nothing would
  // take the button out of service for a request that was never made.
  page.setState({ sending: true });
  try {
    // The hub's comment schema is closed — src/comments.py keeps `text`, `view`,
    // `part`, `key`, `published`, `point`, `normal`, `frame`, `camera` and a
    // document's place (`doc`, `sheet`, `area`, `items`, `layer`, `quote`) and
    // DROPS everything else without saying so — so the measurement rides in the
    // text, where the agent will actually read it, rather than in a field
    // discarded on the way in.
    const extra = [];
    if (c.meas) extra.push(`measured: ${c.meas}`);
    // Where the hub holds a proposal, a pointer to it. The document is not
    // copied into the comment: the hub keeps one proposal per project and the
    // client prints it to the agent (`hammerola proposal`), so a copy would
    // be redundant and go stale.
    //
    // From what the page knows, not a second request: `proposalStands` is the
    // load's answer kept current by the model page's writes.
    if (page.state.proposalStands) {
      extra.push('a proposal stands on this project '
                 + '— `hammerola proposal` reads it');
    }

    const body = extra.length ? `${text}\n\n${extra.join('\n')}` : text;
    const form = new FormData();
    // A draft on a document (`docDraft`) hangs on its place there and on no
    // view or camera of the model; the place's fields its kind does not
    // have are undefined, and left out.
    form.append('comment', JSON.stringify(c.doc ? {
      text: body,
      doc: c.doc,
      frame: c.frame,
      sheet: c.sheet,
      area: c.area,
      items: c.items,
      layer: c.layer,
      quote: c.quote,
      part: c.designator || undefined,
      point: c.point,
      normal: c.normal,
      published: build.published || null,
      view: null,
      camera: null,
    } : {
      text: body,
      view: page.state.view,
      part: c.partId || null,
      // The anchor that outlives this build: `part` is a path in this
      // revision's tree, which a rebuild may renumber; the catalogue key is
      // the part's identity, used to put the pin back on a later build.
      key: c.key || null,
      // WHICH BUILD THE COORDINATE WAS TAKEN ON — not necessarily the build the
      // slot holds when this request lands, since `dev` can rebuild while the
      // reader is still typing, and only this page knows which one it is showing.
      published: build.published || null,
      point: c.p || null,
      // Which way the comment's arrow stands out of the face at that point.
      normal: c.n || null,
      // Both in the frame of the solid `part` names (the model page's `PLACE`
      // handler), so they are a place on it in every view of this build.
      frame: 'part',
      camera: camera(),
    }));
    // The two attachments, and the only place either is shrunk (shrink.js):
    // upload size, not encoding (7–90 ms) or the hub (5–45 ms), dominates the
    // wait on Send.
    //
    // The name is built from the blob's own type. The hub identifies uploads
    // by magic bytes and ignores the name (`sniff_image`, src/comments.py),
    // but `shot.png` on a re-encoded WebP would mislead whoever debugs it. A
    // blob with no type gets the bare stem.
    const named = (stem, blob) => {
      const kind = /^image\/([a-z0-9+.-]+)$/i.exec(blob.type || '');
      return kind ? `${stem}.${kind[1].toLowerCase()}` : stem;
    };
    if (c.photo) {
      const photo = await shrink(c.photo,
                                 { maxSide: PHOTO_MAX_SIDE, quality: PHOTO_QUALITY });
      form.append('photo', photo, named('photo', photo));
    }
    const grabbed = await frame(c);
    if (grabbed) {
      const shot = await shrink(grabbed,
                                { maxSide: SHOT_MAX_SIDE, quality: SHOT_QUALITY });
      form.append('shot', shot, named('shot', shot));
    }

    // The token `askHub` sends has been required by the hub since step 0, and
    // is checked there before the body is parsed at all — so it is what makes
    // this a comment rather than a 403, with the whole upload already spent.
    const { response, error } = await askHub(
      `/api/v1/comments/${PAGE.pid}/${commentTarget(build)}`, token,
      { method: 'POST', body: form });
    if (error) {
      console.error('comment', error);
      page.toast(HUB_UNREACHABLE);
      return;
    }
    // FIXED SENTENCES RATHER THAN THE HUB'S OWN MESSAGE: nothing on these pages
    // should be in the habit of putting a response body on the screen. The
    // longest list here, because this is the request that can be refused for
    // reasons the reader can act on; 403 is not among them here, since
    // `hubTrouble` answers it with the same sentence it always does.
    const said = hubTrouble(response, 201, {
      404: 'This build is no longer available',
      413: 'Too large — try a smaller photo',
      422: 'The hub refused this comment. Is the photo a JPEG, PNG or WebP?',
      429: 'Too many comments from here. Try again in a few minutes.',
    }[response.status] || 'Could not send the comment');
    if (said) { page.toast(said); return; }

    // The queue is refetched rather than guessed at, so the rail shows the
    // record the hub stored, with the id, stamp and status the agent sees.
    page.set({ composer: null, rail: true });
    page.toast('Sent to the agent — a rebuild will follow');
    await page.loadFeed(true);
  } finally {
    // Every exit, including the throw `compSend` catches: a flag left up would
    // disable Send for good.
    //
    // This puts it after the silent refetch, so the flag outlives the composer
    // by one GET; a new composer opened in that window starts with Send spent.
    // Accepted: the window is short, and one lowering point is required.
    page.setState({ sending: false });
  }
}

/**
 * What a document drawn by DocumentView.jsx is handed for the page's
 * comments (its `comment`, on a type in `COMMENTABLE`): whether the Comment
 * tool is armed on it (`on`), the marks of the open comments on documents and
 * of the draft, each with its place in the comment's own fields and lit
 * (`active`) when it is the draft or the rail has it open, and the doors back:
 * a place taken (`onArea`, the page's `docArea`), a mark clicked (`onMarker`,
 * which lights its row and opens the rail; the draft's names no comment), the
 * place a row asked for shown (`onFocused`), and by a document's file the ids
 * of the comments on it that it, open, found no place for (`onLost`).
 */
export function docComment(s, { on, docArea, set, setState }) {
  return {
    on,
    marks: [
      ...s.feed.filter((r) => r.status !== 'resolved' && r.doc),
      ...(s.composer && s.composer.doc ? [{ ...s.composer, part: s.composer.designator, id: DRAFT_MARK }] : []),
    ].map(({ id, doc, sheet, area, part, point, normal, quote }) => ({
      id, doc, sheet: sheet || null, area: area || null, part: part || null, point: point || null,
      normal: normal || null, quote: quote || null, active: id === DRAFT_MARK || id === s.activePin,
    })),
    onArea: docArea,
    onMarker: (id) => {
      if (id !== DRAFT_MARK) set({ activePin: id, rail: true });
    },
    focus: s.docFocus || null,
    onFocused: () => setState({ docFocus: null }),
    onLost: (file, ids) => setState((now) => ({ docLost: { ...now.docLost, [file]: ids } })),
  };
}

/**
 * The composer's values, which `composerCard` draws. `docOpen` is the
 * document on screen, or null over the model; `tools` what its view can do
 * (`onTools` in DocumentView.jsx); `sendComment` the page's Send.
 */
export function composerView(s, { viewer, docOpen, tools, stop, set, setState, toast, sendComment }) {
  // The composer's Send, reached by the button and by Enter in the textarea.
  const send = () => sendComment().catch((error) => {
    console.error('comment', error);
    toast('Could not send the comment');
  });
  return {
    // Shown over what the draft is about — the model, or the document it was
    // drawn on (`docDraft`), known by its file among the documents that take a
    // comment, since a schematic's BOM is under the schematic's file
    // (kicadbom.js) — and hidden, not unmounted, over anything else:
    // the draft comes back with it, sentence and all. Over a document it
    // stands above the bar's strip, which the bar's layer (18) keeps over it.
    composerStyle: `position:absolute;right:16px;bottom:${docOpen ? 72 : 16}px;width:400px;background:var(--card-bg);border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 40px var(--shadow);z-index:16;display:`
      + (s.composer && !viewer && (s.composer.doc
        ? !!docOpen && COMMENTABLE.has(docOpen.type) && docOpen.file === s.composer.doc : !docOpen)
        ? 'block' : 'none'),
    nextLabel: String(s.feed.length + 1),
    composerPart: s.composer ? s.composer.part : '',
    composerText: s.composer ? s.composer.text : '',
    compType: (e) => setState({ composer: { ...s.composer, text: e.target.value } }),
    // The frame rides along wherever `sendDraft` can take one: the model's
    // always, a document's only when its view can draw a frame (`tools`);
    // a markdown page has none.
    compFrameChipStyle: 'display:' + (s.composer && s.composer.doc && !tools ? 'none' : 'flex')
      + `;align-items:center;gap:5px;padding:4px 8px;background:var(--sunken-bg);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-soft)`,
    compMeasChipStyle: 'display:' + (s.composer && s.composer.meas ? 'flex' : 'none') + `;align-items:center;gap:5px;padding:4px 8px;background:var(--warn-bg);border-radius:5px;font:500 10.5px ${MONO};color:var(--warn)`,
    compMeasText: (s.composer && s.composer.meas) || '',
    compMeasRemove: stop(() => setState({ composer: { ...s.composer, meas: null } })),
    compPhotoName: s.composer && s.composer.photo ? s.composer.photo.name : '',
    compPhoto: (e) => {
      const file = e.target.files && e.target.files[0];
      setState({ composer: { ...s.composer, photo: file || null } });
    },
    compCancel: stop(() => set({ composer: null })),
    compSend: send,
    // Enter sends, Shift+Enter falls through to the textarea's own newline.
    compKey: (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      e.preventDefault();
      send();
    },
    // The press must be visible — the other half of the refusal in
    // `sendDraft`, as with `bannerSwitchStyle`. The send spans a frame grab,
    // an upload and two requests, and the composer keeps its draft until the
    // write clears it, so the label says what is happening and the washed
    // accent says the button is spent.
    compSendLabel: s.sending ? 'Sending…' : 'Send',
    compSendStyle: `padding:6px 14px;background:${s.sending ? 'var(--accent-muted)' : 'var(--accent)'};`
      + `color:var(--text-on-accent);border-radius:6px;font:600 12px ${SANS};`
      + `cursor:${s.sending ? 'default' : 'pointer'}`,
  };
}

/**
 * The rail's values, and those of the header's button that opens it: `open`
 * is whether the rail is open, `threads` and `openCount` the rows and the
 * count `feedView` answered.
 */
export function railView({ open, viewer, narrow, threads, openCount, stop, setState }) {
  return {
    // The header's menu shuts with it: on a narrow window this is a row of it
    // (headmenu.jsx).
    railToggle: stop(() => setState({ rail: !open, headMenu: false })),
    railBtnStyle: btn(false) + ';border:1px solid var(--line);background:var(--card-bg)' + (viewer ? ';display:none' : ''),
    // The two states differ by tone, not ink contrast. White on `--accent` is
    // 4.27:1 in both themes and cannot rise without moving the accent, and a
    // grey that looks faint on a light page stands out on a dark one. The
    // signal that carries across both themes at 17px is the disc turning blue;
    // each state gets an ink its own fill can be read with.
    //
    // So the resting pill is an ordinary chip: `--text-soft` on `--chip-bg`,
    // 6.51:1 in light, 8.36:1 in dark. (`--line-strong` under white is
    // 1.68:1 in light and 9.89:1 in dark, backwards in one theme.)
    railCountStyle: 'min-width:17px;height:17px;padding:0 5px;border-radius:9px;'
      + (openCount ? ON_ACCENT
                   : 'background:var(--chip-bg);color:var(--text-soft)')
      + `;display:flex;align-items:center;justify-content:center;font:600 10px ${MONO}`,
    openCount,
    // A COLUMN BESIDE THE PAGE'S STAGE, OR A SHEET OVER IT. 300px taken out of
    // the width is a third of a phone's screen, and what is left is the thing
    // the page exists to show — so on narrow the rail stops being a column and
    // covers it instead, the way the model page's tree already does. It is the
    // same panel either way: it opens and closes by the same button and holds
    // the same threads.
    railStyle: (narrow ? 'position:absolute;inset:0;z-index:20' : 'width:300px;flex:none')
      + ';background:var(--header-bg);border-left:1px solid var(--line);display:'
      + (open && !viewer ? 'flex' : 'none') + ';flex-direction:column;min-height:0',
    threads,
  };
}

/** The comments' icon: on the header's button, and on the row of the header's
 *  menu that stands for it on a narrow window (headmenu.jsx). */
export const COMMENT_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 2.5h12v8.5H8.5L5.5 14v-3H2z" /></svg>
);

/** The header's button that opens the rail, wearing the count of open comments. */
export function commentsButton(v) {
  return (
    <div onClick={v.railToggle} style={css(v.railBtnStyle)}>
      {COMMENT_ICON}
      Comments
      <span style={css(v.railCountStyle)}>{v.openCount}</span>
    </div>
  );
}

/** The composer, from `composerView`'s values; `box` is the ref its textarea
 *  is focused through. The frame rides along by itself, the photo does not. */
export function composerCard(v, box) {
  return (
    <div onClick={(e) => e.stopPropagation()} style={css(v.composerStyle)}>
      <div style={css('display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line-soft)')}>
        <span style={css(`width:20px;height:20px;border-radius:10px 10px 10px 3px;background:var(--accent);color:var(--text-on-accent);display:flex;align-items:center;justify-content:center;font:600 10.5px ${MONO}`)}>{v.nextLabel}</span>
        <span style={css(`font:600 12px ${SANS}`)}>Task for the agent</span>
        {/* Only when there IS a part: the separator belongs to the name,
            and a draft that lost its attachment to a revision swap would
            otherwise show a lone middle dot. */}
        {v.composerPart
          ? <span style={css(META_MONO)}>&middot; {v.composerPart}</span>
          : null}
        <span style={css(FILL)} />
        <span onClick={v.compCancel} style={css(FAINT_CLICK)}>&#10005;</span>
      </div>
      <textarea
        ref={box}
        value={v.composerText}
        onChange={v.compType}
        onKeyDown={v.compKey}
        maxLength={MAX_COMMENT_CHARS}
        placeholder="e.g. gap here is 2.4 — make it 3"
        style={css(`width:100%;box-sizing:border-box;border:none;outline:none;resize:none;padding:10px 12px;font:400 12.5px/1.5 ${SANS};color:var(--text);height:64px;background:transparent`)}
      />
      <div style={css('display:flex;align-items:center;gap:6px;padding:0 12px 10px;flex-wrap:wrap')}>
        <span style={css(v.compFrameChipStyle)}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5" /><circle cx="8" cy="8.7" r="2.6" /></svg>
          camera frame &mdash; attached automatically
        </span>
        <span style={css(v.compMeasChipStyle)}>&#8596; {v.compMeasText} <span onClick={v.compMeasRemove} style={css(DIM_CLICK)}>&#10005;</span></span>
        <label style={css(`padding:4px 8px;border:1px dashed var(--line-strong);border-radius:5px;font:400 10.5px ${MONO};color:var(--text-muted);cursor:pointer`)}>
          {v.compPhotoName ? `photo: ${v.compPhotoName}` : '+ photo of the print'}
          <input type="file" accept="image/jpeg,image/png,image/webp"
                 onChange={v.compPhoto} style={{ display: 'none' }} />
        </label>
        <span style={css(FILL)} />
        <span onClick={v.compSend} style={css(v.compSendStyle)}>{v.compSendLabel}</span>
      </div>
    </div>
  );
}

/** The rail, from `railView`'s values: the whole project queue, so nothing in
 *  it has to explain what it is not showing. Each row says where it hangs on
 *  the build in view instead (`feedView`). */
export function commentRail(v) {
  return (
    <div style={css(v.railStyle)}>
      <div style={css('flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line-soft)')}>
        <span style={css(HEAD_SANS)}>Comments</span>
        <span style={css(FILL)} />
        <span onClick={v.railToggle} style={css('color:var(--text-faint);cursor:pointer;font-size:14px')}>&#10005;</span>
      </div>
      <div style={css('flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px')}>
        {v.threads.map((c) => (
          <div key={c.key} onClick={c.onOpen} style={css(c.style)}>
            <div style={css(ROW)}>
              <span style={css(c.pinStyle)}>{c.label}</span>
              <span style={css(`font:500 11.5px ${MONO};color:var(--text)`)}>{c.part}</span>
              <span style={css(FILL)} />
              <span style={css(`font:400 10.5px ${MONO};color:var(--text-muted)`)}>{c.time}</span>
            </div>
            <div style={css(`font:400 12px/1.5 ${SANS};color:var(--text);margin:7px 0 8px`)}>{c.text}</div>
            <div style={css(c.saysStyle)}>{c.says}</div>
            <div style={css('display:flex;align-items:center;gap:10px;margin-top:8px')}>
              <span onClick={c.onResolve} style={css(`font:500 10.5px ${MONO};color:var(--text-muted);` + (c.resolved ? IDLE : 'cursor:pointer'))}>
                {c.resolved ? 'processed' : 'mark processed'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
