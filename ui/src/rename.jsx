// Renaming the project, a variant, and a view or a document of a variant, on
// both pages that show a build (HammerolaViewer.jsx, DocShell.jsx).
//
// A name lives in the project's source. The hub commits the new one into
// project.json on the variant's branch and publishes that commit as the
// variant's newest revision before it answers — a copy of the build it was
// made on, with the name rewritten (`renameItem` in hub.js, `commit_name` in
// src/prereceive.py). With the token, a pencil (`Pencil`) beside each name
// opens one window (`RenameWindow`), built like the Share window, which posts
// the new name (`saveRename`) and says it is saving until the hub answers;
// then the page opens that variant's `latest`, which carries the name
// (`renamedAddress`). A refusal leaves the window open, and the page toasts
// the hub's sentence.

import React from 'react';

import { format, fresh, parse } from './address.js';
import { DEFAULT_VARIANT, buildPath, renameItem } from './hub.js';
import { CARD, DIALOG_BTN, ON_ACCENT, SUNKEN } from './panelstyle.js';
import { css, SANS } from './style.jsx';

/** The window's heading, by the kind of thing it renames. */
export const RENAME_HEADS = {
  project: 'Rename project', variant: 'Rename variant', view: 'Rename view', document: 'Rename document',
};

/**
 * Save of the window on either page: post `name` for `subject`, what the
 * window renames (`{kind, variant, id, name}`; `variant` is the branch the
 * commit goes on), and once the hub has published it, leave for the
 * `latest` of that variant (`renamedAddress`). A refusal is the hub's sentence
 * handed to `toast`, the page staying. -> whether the page is leaving.
 */
export function saveRename(pid, subject, name, token, toast) {
  return renameItem(pid, { variant: subject.variant, kind: subject.kind, id: subject.id, name }, token).then(() => {
    // The project's title is committed into the default variant whatever
    // variant the page shows (`kind: "project"` in src/app.py), so that is
    // where the new title can be seen.
    window.location.href = renamedAddress(pid, subject.kind === 'project' ? DEFAULT_VARIANT : subject.variant);
    return true;
  }, (error) => {
    toast(String((error && error.message) || error));
    return false;
  });
}

/** The address a page opens once a rename of `variant` is published: that
 *  variant's `latest`, with the view (`v=`) and the document (`d=`) of the
 *  address `at`, the browser's own by default. */
export function renamedAddress(pid, variant, at = parse()) {
  return format(fresh(buildPath(pid, 'latest', variant), { view: at.view, doc: at.doc }));
}

const PENCIL_LOOK = 'font-size:11px;line-height:1;color:var(--text-faint);cursor:pointer;user-select:none';
const PENCIL = `flex:none;display:inline-block;margin-left:5px;${PENCIL_LOOK}`;
// In a menu row the pencil stands in the row's left padding, before the name,
// where a click meant for the row does not land; the row (`menuRow` in
// panelstyle.js) is positioned.
const PENCIL_LEAD = `position:absolute;left:8px;top:50%;transform:translateY(-50%);${PENCIL_LOOK}`;

// The pencil shows only while the pointer is over the element that carries
// `RENAME_HOST` — the name itself, its row, or the whole strip of views — and
// only after the pointer has rested there for half a second, so a pointer
// passing over a row does not flash it; it hides at once. The page draws
// `RENAME_CSS` once. Hidden rather than absent, so the line keeps its width
// when the pencil comes and goes; a hidden pencil takes no clicks. A screen
// with no hover (a phone) shows it always: there it could never appear, and
// the name could not be renamed.
export const RENAME_HOST = 'hmr-rename-host';
const PENCIL_CLASS = 'hmr-pencil';
export const RENAME_CSS = `@media (hover:hover){.${RENAME_HOST} .${PENCIL_CLASS}{visibility:hidden}`
  + `.${RENAME_HOST}:hover .${PENCIL_CLASS}{visibility:visible;transition:visibility 0s .5s}}`;

/** The faint control that opens the window for one name, inside an element
 *  carrying `RENAME_HOST`: right after the name, at the end of the strip of
 *  views, or with `lead`, in the left padding of a menu row. It stops its
 *  click, which would otherwise reach the row it stands in, a link among them. */
export function Pencil({ title, onClick, lead = false }) {
  return (
    <span title={title} className={PENCIL_CLASS} style={css(lead ? PENCIL_LEAD : PENCIL)}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClick(); }}>
      ✎
    </span>
  );
}

const OVERLAY = 'position:fixed;inset:0;z-index:40;padding:20px;box-sizing:border-box;'
  + 'display:flex;align-items:center;justify-content:center;background:var(--shadow)';
const BOX = `width:380px;max-width:100%;box-sizing:border-box;${CARD}`
  + 'box-shadow:0 14px 44px var(--shadow);padding:22px 22px 18px;display:flex;flex-direction:column;gap:10px';
const FIELD = 'width:100%;box-sizing:border-box;height:36px;padding:0 12px;border-radius:6px;'
  + `font:500 13px ${SANS};color:var(--text);outline:none;${SUNKEN}`;
const BUTTON = `${DIALOG_BTN}user-select:none;font:600 12px ${SANS};`;

/**
 * The window: `subject` is what it renames, its field starts at the current
 * name. Over the whole page, like the Share window: Cancel and Escape close it
 * (`onClose`), a click on the card stops there, and Save or Enter hands the
 * field to `onSave`. A click outside the card — pressed and released outside
 * it — saves a changed name too, so a typed name is not lost to a stray
 * click, and closes an unchanged one.
 * `onSave` answers a promise: true when the hub took the name and the page
 * is leaving for the new revision, so the window goes on saying it is saving
 * until the page is gone. One Save at a time.
 */
export class RenameWindow extends React.Component {
  constructor(props) {
    super(props);
    this.state = { typed: props.subject.name || '', saving: false };
    this.onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.props.onClose();
    };
    this.save = () => {
      if (this.state.saving) return Promise.resolve();
      this.setState({ saving: true });
      return Promise.resolve(this.props.onSave(this.state.typed)).then((leaving) => {
        if (!leaving && !this.gone) this.setState({ saving: false });
      });
    };
    // The browser sends a click to the nearest element holding both the press
    // and the release, so a selection dragged out of the field, or a press on
    // the overlay released on the card, ends in a click on the overlay too.
    // Neither closes the window nor saves: both ends must be on the overlay.
    this.pressed = (event) => { this.pressedOutside = event.target === event.currentTarget; };
    this.released = (event) => { this.releasedOutside = event.target === event.currentTarget; };
    this.outside = (event) => {
      const outside = this.pressedOutside && this.releasedOutside && event.target === event.currentTarget;
      this.pressedOutside = false;
      this.releasedOutside = false;
      if (!outside) return undefined;
      return this.state.typed === (this.props.subject.name || '') ? this.props.onClose() : this.save();
    };
  }

  componentDidMount() {
    window.addEventListener('keydown', this.onKey);
  }

  componentWillUnmount() {
    window.removeEventListener('keydown', this.onKey);
    this.gone = true;
  }

  render() {
    const { subject, onClose } = this.props;
    const { saving } = this.state;
    return (
      <div onPointerDown={this.pressed} onPointerUp={this.released} onClick={this.outside} style={css(OVERLAY)}>
        <div onClick={(event) => event.stopPropagation()} style={css(BOX)}>
          <div style={css(`font:700 15px ${SANS}`)}>{RENAME_HEADS[subject.kind]}</div>
          <input type="text" autoFocus value={this.state.typed} autoComplete="off" spellCheck="false"
                 onChange={(event) => this.setState({ typed: event.target.value })}
                 onKeyDown={(event) => { if (event.key === 'Enter') this.save(); }}
                 style={css(FIELD)} />
          <div style={css('display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:2px')}>
            <div onClick={onClose}
                 style={css(`${BUTTON}cursor:pointer;border:1px solid var(--line);background:var(--card-bg);color:var(--text)`)}>
              Cancel
            </div>
            <div onClick={this.save} aria-disabled={saving}
                 style={css(`${BUTTON}${ON_ACCENT};cursor:${saving ? 'default;opacity:0.6' : 'pointer'}`)}>
              {saving ? 'Saving…' : 'Save'}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
