// The revision picker, in the header over both pages that show a build
// (Header.jsx), right after the variants: a button
// naming the build on screen — a dot, the slot of its address, when it was
// built — and the card it opens with the variant's pointers and builds
// (`builds.json`, behind the token). On a narrow window the button is a row of
// the header's menu (`revisionRow`, headmenu.jsx) and the card a sheet along
// the bottom edge.
//
// The card's rows are `revisionView` in revisionview.js. On the model's page a
// row swaps the build in place and carries a tick to compare and a Share icon;
// on the page of a build with no model a row is a link, a page load, and
// carries neither: a comparison is of the model's STEP, and that page has no
// Share window.
//
// `revisionPicker` and `revisionRow` are plain functions, like `headMenu` and
// `commentsButton`, so what they return is read as part of the header's own
// tree. They draw from `revisionHead`'s values, the rows (`revRows`,
// `revEmpty`) and whether the header is folded into its menu (`headFolded`).

import React from 'react';

import { headRow } from './headmenu.jsx';
import { PAGE, shortId, stamp } from './hub.js';
import { HEAD_MONO, META_MONO, popover } from './panelstyle.js';
import { css, SANS } from './style.jsx';

/**
 * The values the button, its row and its card are drawn from: on a window
 * `narrow` or not, for a reader without the token (`viewer`) or with it, the
 * card shown while `open`, `built` the build's `meta.built`, `onToggle(event)`
 * what opens and shuts the card, `dot` the colour of the button's dot.
 */
export function revisionHead({ narrow, viewer, open, built, onToggle, dot }) {
  return {
    // The wrapper the card hangs off. Wide, it holds the button and its card,
    // measured from the button. Narrow, the button is a row of the menu and
    // the card a sheet along the bottom edge (`popover`), which needs no
    // button to hang off; `display:contents` keeps a wrapper left with only
    // its card from taking a gap in the row.
    revWrapStyle: narrow ? 'display:contents' : 'position:relative;margin-left:8px;flex:none',
    // The row: a label without a token, as the button is.
    revRowStyle: headRow(false) + (viewer ? ';cursor:default' : ''),
    // Shortened: `PAGE.slot` comes straight from the URL, so on a pinned
    // revision it is the full 64-character source digest, too wide for the
    // header row. The picker draws the same value via `shortId`, so the two
    // agree. Pointer names pass through: `dev` is special-cased and `latest` is
    // shorter than the cut.
    slot: shortId(PAGE.slot),
    // The whole of it, for the reader who needs to copy one. A revision is
    // addressed by its full digest everywhere off this page — `hammerola
    // source <rev>`, a permanent URL — and the seven characters above cannot
    // be pasted anywhere. Empty when nothing was cut: a tooltip that repeats
    // the word under the cursor is noise, and `dev` and `latest` are shown
    // whole already.
    slotTitle: shortId(PAGE.slot) === PAGE.slot ? '' : PAGE.slot,
    slotDate: stamp(built),
    // WITHOUT A TOKEN THE BUTTON IS A LABEL: builds.json is behind the token,
    // so a reader holding a shared link has no list to open and no menu.
    revPicker: !viewer,
    revToggle: viewer ? undefined : onToggle,
    revBtnStyle: 'display:flex;align-items:center;gap:8px;padding:6px 11px;border:1px solid var(--line);background:var(--card-bg);border-radius:6px'
      + (viewer ? '' : ';cursor:pointer'),
    revMenuStyle: popover({
      narrow, anchor: 'left:0;top:40px', width: '430px', radius: '9px', z: 40, open }),
    statusDotStyle: `width:8px;height:8px;border-radius:4px;background:${dot};flex:none`,
  };
}

const CARET = <span style={css('font-size:9px;color:var(--text-faint)')}>&#9662;</span>;

// What a row picks by: its id, its version on a tag, its badge, the author's
// message and the date.
const PICK = 'display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;min-width:0';

/**
 * The button and its card: wide, the button with the card hung under it;
 * narrow, the card alone, a sheet the menu's row opens (`revisionRow`).
 * Without the token the button is a label and there is no card. In the card
 * the pointers stand on top and the history below, whose heading carries
 * "Tags only" when the history has tags; a row with an `href` is a
 * link to that revision, one without picks it through `onPick`. With
 * `startCompare` the ticks pick two to compare and the card ends in Compare.
 */
export function revisionPicker(v) {
  return (
    <div style={css(v.revWrapStyle)}>
      {!v.headFolded && (
        <div onClick={v.revToggle} title={v.slotTitle} style={css(v.revBtnStyle)}>
          <span style={css(v.statusDotStyle)} />
          <span style={css(HEAD_MONO)}>{v.slot}</span>
          <span style={css(META_MONO)}>{v.slotDate}</span>
          {v.revPicker && CARET}
        </div>
      )}

      {v.revPicker && (
        <div style={css(v.revMenuStyle)}>
          <div style={css('max-height:308px;overflow:auto')}>
            {v.revRows.map((r) => {
              const named = (
                <>
                  <span style={css(r.idStyle)}>{r.id}</span>
                  {r.version ? <span title={r.version} style={css(r.versionStyle)}>{r.version}</span> : null}
                  <span style={css(r.badgeStyle)}>{r.badge}</span>
                  <span title={r.message} style={css(r.messageStyle)}>{r.message}</span>
                  <span style={css(META_MONO)}>{r.date}</span>
                </>
              );
              return (
                <React.Fragment key={r.key}>
                  <div style={css(r.headStyle)}>
                    {r.head}
                    {r.onTags && <span onClick={r.onTags} style={css(r.tagsStyle)}>Tags only</span>}
                  </div>
                  <div style={css(r.style)}>
                    <span onClick={r.onCmp} style={css(r.cmpStyle)}>{r.cmpMark}</span>
                    {r.href
                      ? <a href={r.href} style={css(`${PICK};text-decoration:none;color:inherit`)}>{named}</a>
                      : <span onClick={r.onPick} style={css(PICK)}>{named}</span>}
                    <span onClick={r.onShare} title="Share" style={css(r.shareIconStyle)}>
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 10V1.8M5 4.8l3-3 3 3M3.5 7.5v6.5h9V7.5" /></svg>
                    </span>
                  </div>
                </React.Fragment>
              );
            })}
            {v.revEmpty && (
              <div style={css(`padding:12px 14px;font:400 11.5px ${SANS};color:var(--text-muted)`)}>
                This project has no other builds yet.
              </div>
            )}
          </div>
          {v.startCompare && (
            <div style={css('display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--line-soft)')}>
              <div onClick={v.startCompare} style={css(v.compareBtnStyle)}>Compare {v.cmpLabel}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The button's row in the header's menu on a narrow window: what it says,
 *  and its click opens the card as the button's does. */
export function revisionRow(v) {
  return (
    <div onClick={v.revToggle} style={css(v.revRowStyle)}>
      <span style={css(v.statusDotStyle)} />
      <span style={css(HEAD_MONO)}>{v.slot}</span>
      <span style={css(META_MONO)}>{v.slotDate}</span>
      {v.revPicker && CARET}
    </div>
  );
}
