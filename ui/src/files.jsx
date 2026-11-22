// The Files window over the build page: the files of the revision on screen as
// a tree, and the file picked in it — a picture, a PDF, text in CodeMirror
// (read-only), or a line saying why the window does not show it. BuildPage.jsx
// draws it, as it draws the rename window, when the header's Files asks
// (`onFiles`). Wide, a card 24px off the window's edges over the dimmed page;
// narrow, the whole screen and one pane at a time, the tree or the file. ✕ and
// Escape close it.
//
// The list and every file's bytes come from one address, `source`
// (`sourceUrl` in filesview.js; a file through `sourceFileUrl`), fetched with
// the token: the hub hands the code of a revision to nobody else.

import React from 'react';

import { baseName, decodeText, editorLanguage, fileKind, fileRows, sizeText, sourceFileUrl } from './filesview.js';
import { HUB_UNREACHABLE, askHub, hubBody, hubTrouble } from './hub.js';
import { CARD, ELLIPSIS, FILL } from './panelstyle.js';
import { css, MONO, NARROW, SANS } from './style.jsx';

const LIST_FAILED = 'Could not load the files';
const FILE_FAILED = 'Could not load the file';
const DOWNLOAD_FAILED = 'Could not download the file';
export const EDITOR_FAILED = 'Could not load the editor — reload the page';

/** What a file's head calls it, by the kind the window found it to be. */
const KIND_LABELS = { large: 'Large file', image: 'Image', pdf: 'PDF', text: 'Text', binary: 'Binary file' };
/** The pane of a file the window does not show: a heading and a line. */
const NOT_SHOWN = {
  large: ['Large file', 'Files over 16 MB are not loaded into the window.'],
  binary: ['This file is not text', 'The window does not show it — download it to open.'],
};

const OVERLAY = 'position:fixed;inset:0;z-index:40;background:var(--shadow)';
const BOX = `position:absolute;inset:24px;display:flex;flex-direction:column;overflow:hidden;${CARD}`
  + 'box-shadow:0 18px 48px var(--shadow)';
const BOX_NARROW = `${BOX};inset:0;border:0;border-radius:0`;
const BAR = 'height:48px;flex:none;display:flex;align-items:center;gap:12px;padding:0 10px 0 18px;'
  + 'border-bottom:1px solid var(--line)';
const CLOSE = 'width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;'
  + 'border-radius:6px;font-size:16px;color:var(--text-soft);cursor:pointer;user-select:none';
const BACK = `font:500 14px ${SANS};color:var(--accent-text);cursor:pointer;user-select:none`;
const HEAD = 'height:44px;flex:none;display:flex;align-items:center;gap:10px;padding:0 14px 0 18px;'
  + 'border-bottom:1px solid var(--line-soft)';
const BUTTON = 'height:28px;flex:none;display:flex;align-items:center;padding:0 10px;border-radius:6px;'
  + `border:1px solid var(--line);background:var(--card-bg);color:var(--text);font:400 12px ${SANS};`
  + 'cursor:pointer;user-select:none;text-decoration:none';
const CENTER = 'flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;'
  + `gap:4px;padding:20px;text-align:center;background:var(--sunken-bg);font:400 13px/19px ${SANS};color:var(--text-soft)`;

/** One row of the tree: indented by its depth, a directory in bold, the picked
 *  file marked; taller with a line under it on a narrow window, for a finger. */
const rowStyle = (row, picked, narrow) => 'display:flex;align-items:center;gap:6px;cursor:pointer;'
  + `height:${narrow ? 44 : 28}px;padding:0 12px 0 ${12 + row.depth * 16}px;`
  + `font:${row.dir || picked ? 600 : 400} ${narrow ? 14 : 12.5}px ${SANS};`
  + (narrow ? 'border-bottom:1px solid var(--line-soft);' : '')
  + (picked ? 'background:var(--accent-bg);box-shadow:inset 2px 0 0 var(--accent);color:var(--accent-text)'
    : 'color:var(--text)');

/**
 * The window. Props: `source`, the list's address; `token`; `theme`, the page's,
 * for the text pane; `subtitle`, what the bar says beside "Files" on a wide
 * window; `toast(said)`, the page's; `onClose()`.
 */
export class FilesWindow extends React.Component {
  constructor(props) {
    super(props);
    // `list` is null while it is on its way, then `{files}` or `{said}`;
    // `picked` the file on the right, `{path, size, kind}` and what came of it
    // (`loading`, `said`, `url` of its bytes, `text`); `editor` the editor's
    // module once imported, `'failed'` when it could not be.
    this.state = {
      list: null, dirs: {}, picked: null, editor: null,
      narrow: !!(window.matchMedia && window.matchMedia(NARROW).matches),
    };
    this.host = React.createRef();
    // The text pane on screen, the `blob:` address of the bytes on screen, and
    // the pick a fetch belongs to: a fetch that lands after another pick is
    // dropped.
    this.view = null;
    this.url = null;
    this.ticket = null;
    this.editorAsked = null;
    this.mq = null;
    this.gone = false;
    this.box = React.createRef();
    this.onNarrow = (event) => this.setState({ narrow: event.matches });
    // An Escape that something inside the window took — CodeMirror's search
    // panel shutting, a selection collapsing — is not the window's; any other
    // is, one the page under it took included. The box hears the event twice:
    // on its way down, after the page's capturing listeners (DocShell takes
    // Escape there), and on its way up, before anything else on `window`;
    // what was prevented between the two was prevented inside.
    this.inside = null;
    this.takenOutside = false;
    this.insideTook = null;
    this.onInsideDown = (event) => { this.takenOutside = event.defaultPrevented; };
    this.onInsideKey = (event) => {
      this.insideTook = event.key === 'Escape' && event.defaultPrevented && !this.takenOutside ? event : null;
    };
    this.onKey = (event) => {
      if (event.key !== 'Escape' || event === this.insideTook) return;
      event.preventDefault();
      this.props.onClose();
    };
    this.back = () => {
      this.release();
      this.setState({ picked: null });
    };
  }

  componentDidMount() {
    this.inside = this.box.current;
    this.inside.addEventListener('keydown', this.onInsideDown, true);
    this.inside.addEventListener('keydown', this.onInsideKey);
    window.addEventListener('keydown', this.onKey);
    this.mq = window.matchMedia ? window.matchMedia(NARROW) : null;
    if (this.mq) this.mq.addEventListener('change', this.onNarrow);
    this.loadList();
  }

  componentDidUpdate() {
    this.mountEditor();
  }

  componentWillUnmount() {
    this.inside.removeEventListener('keydown', this.onInsideDown, true);
    this.inside.removeEventListener('keydown', this.onInsideKey);
    window.removeEventListener('keydown', this.onKey);
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    this.release();
    this.gone = true;
  }

  /** The list at `source`; a refusal or a broken answer is a line instead. */
  async loadList() {
    const { response, error } = await askHub(this.props.source, this.props.token);
    let list = { said: error ? HUB_UNREACHABLE : hubTrouble(response, 200, LIST_FAILED) };
    if (!list.said) {
      const { body, error: unread } = await hubBody(response);
      list = unread ? { said: LIST_FAILED } : { files: (body && body.files) || [] };
    }
    if (!this.gone) this.setState({ list });
  }

  /** The text pane, the bytes' address and the fetch of the file on screen,
   *  let go: a fetch that lands after ← Files is dropped too. */
  release() {
    if (this.view) this.view.destroy();
    if (this.url) URL.revokeObjectURL(this.url);
    this.view = null;
    this.url = null;
    this.ticket = null;
  }

  /** Show one file of the list: fetched unless it is large (`fileKind`). */
  pick(path, size) {
    this.release();
    const kind = fileKind(path, size);
    const ticket = {};
    this.ticket = ticket;
    this.setState({ picked: { path, size, kind, loading: kind !== 'large' } });
    if (kind !== 'large') this.fetchFile(ticket, path, size, kind);
  }

  async fetchFile(ticket, path, size, kind) {
    const { response, error } = await askHub(sourceFileUrl(this.props.source, path), this.props.token);
    const said = error ? HUB_UNREACHABLE : hubTrouble(response, 200, FILE_FAILED);
    let bytes = null;
    if (!said) {
      try {
        bytes = await response.arrayBuffer();
      } catch {
        bytes = null;
      }
    }
    if (this.gone || ticket !== this.ticket) return;
    const picked = { path, size, kind };
    if (said || !bytes) {
      this.setState({ picked: { ...picked, said: said || FILE_FAILED } });
    } else if (kind === 'image' || kind === 'pdf') {
      // The hub sends every file as octet-stream; a frame shows a PDF only from
      // bytes typed as one.
      this.url = URL.createObjectURL(new Blob([bytes], kind === 'pdf' ? { type: 'application/pdf' } : {}));
      this.setState({ picked: { ...picked, url: this.url } });
    } else {
      const text = decodeText(bytes);
      this.setState({ picked: text === null ? { ...picked, kind: 'binary' } : { ...picked, text } });
      if (text !== null) this.loadEditor();
    }
  }

  /** The editor's chunk, `static/_v/hammerola-editor.js`. */
  editorModule() {
    return import('./editor/editor.js');
  }

  /** Import the editor once per window; the browser keeps the module for the
   *  next window. */
  loadEditor() {
    if (this.editorAsked) return;
    this.editorAsked = this.editorModule().then(
      (module) => { if (!this.gone) this.setState({ editor: module }); },
      (error) => {
        console.warn('editor', error);
        if (!this.gone) this.setState({ editor: 'failed' });
      },
    );
  }

  /** CodeMirror over the picked text, once the text, the module and the box
   *  for it are all there. */
  mountEditor() {
    const { picked, editor } = this.state;
    if (this.view || !picked || picked.text === undefined || !editor || editor === 'failed' || !this.host.current) {
      return;
    }
    this.view = editor.mount(this.host.current, {
      text: picked.text, language: editorLanguage(picked.path), readOnly: true, theme: this.props.theme,
    });
  }

  /** One file, fetched with the token and handed to the browser under its own
   *  name; a refusal, or a body cut off on the way, is a toast. */
  async download(path) {
    const { response, error } = await askHub(sourceFileUrl(this.props.source, path), this.props.token);
    const said = error ? HUB_UNREACHABLE : hubTrouble(response, 200, DOWNLOAD_FAILED);
    if (said) {
      this.props.toast(said);
      return;
    }
    let blob;
    try {
      blob = await response.blob();
    } catch {
      this.props.toast(DOWNLOAD_FAILED);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** The tree, or the line that stands for it. */
  tree() {
    const { list, dirs, picked, narrow } = this.state;
    const said = !list ? 'Loading…' : list.said || (list.files.length ? '' : 'No files in this revision.');
    if (said) return <div style={css(`padding:10px 14px;font:400 12px ${SANS};color:var(--text-muted)`)}>{said}</div>;
    return fileRows(list.files, dirs).map((row) => (
      <div key={row.path} title={row.path} style={css(rowStyle(row, !!picked && picked.path === row.path, narrow))}
           onClick={row.dir ? () => this.setState({ dirs: { ...dirs, [row.path]: !row.open } })
             : () => this.pick(row.path, row.size)}>
        <span style={css('width:12px;height:12px;flex:none;display:flex;color:var(--text-muted)')}>
          {row.dir && (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d={row.open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
            </svg>
          )}
        </span>
        <span style={css(`${FILL};min-width:0;${ELLIPSIS}`)}>{row.name}</span>
        {!row.dir && <span style={css(`flex:none;font:400 10.5px ${MONO};color:var(--text-faint)`)}>{sizeText(row.size)}</span>}
      </div>
    ));
  }

  /** What the picked file's pane shows under its head. */
  body(picked) {
    const { editor } = this.state;
    if (picked.loading) return <div style={css(CENTER)}>Loading…</div>;
    if (picked.said) return <div style={css(CENTER)}>{picked.said}</div>;
    if (NOT_SHOWN[picked.kind]) {
      const [heading, line] = NOT_SHOWN[picked.kind];
      return (
        <div style={css(CENTER)}>
          <div style={css(`font:600 14px ${SANS};color:var(--text)`)}>{heading}</div>
          <div>{line}</div>
        </div>
      );
    }
    if (picked.kind === 'image') {
      return (
        <div style={css(`${CENTER};padding:28px;overflow:auto`)}>
          <img src={picked.url} alt={picked.path} style={css('max-width:100%;max-height:100%;object-fit:contain')} />
        </div>
      );
    }
    if (picked.kind === 'pdf') {
      return <iframe src={picked.url} title={picked.path} style={css('flex:1;min-height:0;width:100%;border:0')} />;
    }
    if (editor === 'failed') return <div style={css(CENTER)}>{EDITOR_FAILED}</div>;
    if (!editor) return <div style={css(CENTER)}>Loading…</div>;
    return <div ref={this.host} style={css('flex:1;min-height:0;overflow:hidden')} />;
  }

  /** The picked file: its path, what it is and its size, Open for a PDF (the
   *  same bytes in a tab of their own: a phone may show only the first page
   *  in a frame), Download, and the pane. */
  file(picked) {
    const label = picked.loading && picked.kind === 'text' ? '' : KIND_LABELS[picked.kind];
    return (
      <>
        <div style={css(HEAD)}>
          <span title={picked.path} style={css(`flex:0 1 auto;min-width:0;font:600 12.5px ${MONO};${ELLIPSIS}`)}>
            {picked.path}
          </span>
          <span style={css(`flex:none;font:400 11px ${SANS};color:var(--text-muted)`)}>
            {[label, sizeText(picked.size)].filter(Boolean).join(' · ')}
          </span>
          <span style={css(FILL)} />
          {picked.kind === 'pdf' && picked.url && (
            <a href={picked.url} target="_blank" rel="noopener" style={css(BUTTON)}>Open</a>
          )}
          <span onClick={() => this.download(picked.path)} style={css(BUTTON)}>Download</span>
        </div>
        {this.body(picked)}
      </>
    );
  }

  render() {
    const { narrow, picked } = this.state;
    // Both panes always stand in the tree, a narrow window hiding one, so the
    // box CodeMirror is mounted in is never rebuilt under it.
    const treeShown = !narrow || !picked;
    const fileShown = !narrow || !!picked;
    return (
      <div style={css(OVERLAY)}>
        <div ref={this.box} style={css(narrow ? BOX_NARROW : BOX)}>
          <div style={css(BAR)}>
            {narrow && picked
              ? <span onClick={this.back} style={css(BACK)}>← Files</span>
              : <span style={css(`flex:none;font:600 14px ${SANS}`)}>Files</span>}
            {!narrow && (
              <span style={css(`min-width:0;font:400 11.5px ${MONO};color:var(--text-muted);${ELLIPSIS}`)}>
                {this.props.subtitle}
              </span>
            )}
            <span style={css(FILL)} />
            <span onClick={this.props.onClose} title="Close" style={css(CLOSE)}>&#10005;</span>
          </div>
          <div style={css('flex:1;min-height:0;display:flex')}>
            <div style={css(`${narrow ? 'flex:1' : 'width:340px;flex:none;border-right:1px solid var(--line)'};`
              + `overflow:auto;padding:${narrow ? 0 : 6}px 0;background:${narrow ? 'var(--card-bg)' : 'var(--sunken-bg)'};`
              + `display:${treeShown ? 'block' : 'none'}`)}>
              {this.tree()}
            </div>
            <div style={css(`flex:1;min-width:0;flex-direction:column;display:${fileShown ? 'flex' : 'none'}`)}>
              {picked ? this.file(picked) : <div style={css(CENTER)}>Pick a file on the left to see it here.</div>}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
