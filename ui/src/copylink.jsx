// "Copy link" beside every link that downloads a file of the build: the rows
// of the header's Downloads menu (downloadsview.js), a part's files in its
// right-click menu (rowmenu.js), the card of a file the page does not draw
// (DocumentView.jsx) and the Gerbers' zip (GerberView.jsx). What it copies is
// the whole address of that very link, the key to the files included when the
// link carries one (`fileHref`), so whoever it is pasted to downloads what this
// page would.
//
// It says how the copy went itself, for `COPY_SAID_MS`, and needs nothing from
// the page around it: the card and the Gerbers also stand on the page of a
// build with no model (DocShell.jsx), which has no toast.
//
// Two looks: `button`, a text button for a card, styled by the caller like the
// link beside it; otherwise a 12 px link icon for the end of a row. Either is a
// SIBLING of the link it copies, never inside it — a control inside an `<a>` is
// not valid markup — and its click neither follows a link nor reaches the
// page's handler that closes a menu, so the menu stays up to say "Copied".

import React from 'react';

import { css, SANS } from './style.jsx';

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

const ICON = 'flex:none;display:flex;align-items:center;margin:0;border:0;background:none;cursor:pointer;'
  + `white-space:nowrap;font:500 10.5px ${SANS};color:var(--text-faint)`;
const BUTTON = 'background:none;cursor:pointer';

/** The control. Props: `href`, the download link's own; `button` for the
 *  card's look; `style`, a css string laid over the look (the row's padding,
 *  the card link's whole style). */
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
    const { button, style = '' } = this.props;
    const { said } = this.state;
    if (button) {
      return <button type="button" onClick={this.copy} style={css(`${style};${BUTTON}`)}>{said || 'Copy link'}</button>;
    }
    return (
      <button type="button" onClick={this.copy} title="Copy link" style={css(`${ICON};${style}`)}>
        {said || (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M6.5 9.5l3-3M7.2 4.6l1.1-1.1a2.8 2.8 0 0 1 4 4l-1.1 1.1M8.8 11.4l-1.1 1.1a2.8 2.8 0 0 1-4-4l1.1-1.1" />
          </svg>
        )}
      </button>
    );
  }
}
