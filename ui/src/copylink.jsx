// "Copy link" beside every link that downloads a file of the build: the rows
// of the header's Downloads menu (downloadsview.js), a part's files in its
// right-click menu (rowmenu.js), and the open document's Download at the left
// end of the bottom strip of both pages (`DocFile` in viewlist.jsx). What it copies is
// the whole address of that very link, the key to the files included when the
// link carries one (`fileHref`), so whoever it is pasted to downloads what this
// page would.
//
// It says how the copy went itself, for `COPY_SAID_MS`, and needs nothing from
// the page around it: the strip also stands on the page of a build with no
// model (DocShell.jsx), which has no toast.
//
// An icon with the words in its title, which turns into a tick or a cross for
// "Copied" or "Could not copy": `bar`, a 13 px icon in a quiet button like Fit
// and Frame, followed by the words "Copy link" when `words` is set, and
// otherwise a 12 px icon for the end of a row. The words stay "Copy link"
// while the icon says how the copy went: a word changing length would change
// the width `DocFile` measures to choose between words and icons. Either is a SIBLING of the link
// it copies, never inside it — a control inside an `<a>` is not valid markup —
// and its click neither follows a link nor reaches the page's handler that
// closes a menu, so the menu stays up to say "Copied".

import React from 'react';

import { QUIET_BTN } from './panelstyle.js';
import { css } from './style.jsx';

/** How long the control says "Copied" or "Could not copy" before it is itself again, ms. */
export const COPY_SAID_MS = 1500;

/** The address `href` names, whole, as a reader somewhere else has to be given it. */
export const absoluteHref = (href) => new URL(href, window.location.href).href;

/**
 * The whole address of `href` into the clipboard. -> a promise of true once it
 * is there, false otherwise; it never rejects. `navigator.clipboard` is missing
 * outside https, and `writeText` refuses through its promise (no focus, no
 * permission): both end in false, never in a claim of a copy.
 */
export function copyHref(href) {
  return Promise.resolve()
    .then(() => navigator.clipboard.writeText(absoluteHref(href)))
    .then(() => true, (error) => {
      console.warn('clipboard', error);
      return false;
    });
}

const ICON = 'flex:none;display:flex;align-items:center;margin:0;padding:0;border:0;background:none;cursor:pointer;'
  + 'color:var(--text-faint)';

// The icon's drawing for each thing the control can say: the link, a tick, a cross.
const ICON_PATHS = {
  '': 'M6.5 9.5l3-3M7.2 4.6l1.1-1.1a2.8 2.8 0 0 1 4 4l-1.1 1.1M8.8 11.4l-1.1 1.1a2.8 2.8 0 0 1-4-4l1.1-1.1',
  Copied: 'M3 8.5l3 3 7-7',
  'Could not copy': 'M4 4l8 8M12 4l-8 8',
};
// The bar's quiet button (`quietBtn(false)` in viewlist.jsx), on a <button>.
const BAR = `${QUIET_BTN};background:none`;

/** The control. Props: `href`, the download link's own; `bar` for the bar's
 *  look, and `words` with it for the word after the icon; `style`, a css
 *  string laid over the look (the row's padding). */
export default class CopyLink extends React.Component {
  constructor(props) {
    super(props);
    this.state = { said: '' };
  }

  componentWillUnmount() {
    this._gone = true;
    clearTimeout(this._timer);
  }

  copy = (event) => {
    event.preventDefault();
    event.stopPropagation();
    return copyHref(this.props.href).then((copied) => {
      if (this._gone) return;
      clearTimeout(this._timer);
      this.setState({ said: copied ? 'Copied' : 'Could not copy' });
      this._timer = setTimeout(() => {
        if (!this._gone) this.setState({ said: '' });
      }, COPY_SAID_MS);
    });
  };

  render() {
    const { bar, words: spelt, style = '' } = this.props;
    const { said } = this.state;
    const words = said || 'Copy link';
    const icon = (size) => (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d={ICON_PATHS[said]} />
      </svg>
    );
    return (
      <button type="button" onClick={this.copy} title={words} style={css(bar ? `${BAR};${style}` : `${ICON};${style}`)}>
        {icon(bar ? 13 : 12)}
        {bar && spelt && 'Copy link'}
      </button>
    );
  }
}
