// The Files window over the build page: the files of the revision on screen as
// a tree, and the file picked in it — a picture, a PDF, text in CodeMirror, or
// a line saying why the window does not show it. BuildPage.jsx draws it, as it
// draws the rename window, when the header's Files asks (`onFiles`). Wide, a
// card 24px off the window's edges over the dimmed page; narrow, the whole
// screen and one pane at a time, the tree or the file. ✕ and Escape close it.
//
// The list and every file's bytes come from one address, `source`
// (`sourceUrl` or `baseUrl` in filesview.js; a file through `sourceFileUrl`),
// fetched with the token: the hub hands the code of a revision to nobody else.
//
// It edits, too, where BuildPage allows it (`start`, on the newest revision of
// a variant): the text in the editor, Upload and a drop of files, New file, New
// folder, and a row's Rename or move… and Delete, each folded into the change
// set (changeset.js) BuildPage keeps (`set`, `onSet`), which outlives the
// window. Once the set holds anything the window shows the set's build, whatever
// the page shows. Commit sends it (`commitSet`, through BuildPage's `onCommit`,
// which follows the build to its end and hands its course down as `commit`).

import React from 'react';

import {
  bodyOf, changeRows, editText, entryKey, fileAt, isEmpty, markOf, messageOf, move, newFile, newFolder, normalText,
  notAPath, overlay, pathProblem, payload, putFile, remove, revert, revertAll, startSet, uploads, withMessage,
} from './changeset.js';
import {
  baseName, baseUrl, decodeText, editorLanguage, fileKind, fileRows, sizeText, sourceFileUrl,
} from './filesview.js';
import {
  HUB_UNREACHABLE, JOB_BUILDING, JOB_DONE, JOB_FAILED, Unauthorized, askHub, hubBody, hubTrouble, loadJob, shortId,
} from './hub.js';
import { CARD, CARD_LOOK, ELLIPSIS, FILL, ON_ACCENT } from './panelstyle.js';
import { css, MONO, NARROW, SANS } from './style.jsx';

const LIST_FAILED = 'Could not load the files';
const FILE_FAILED = 'Could not load the file';
const DOWNLOAD_FAILED = 'Could not download the file';
export const EDITOR_FAILED = 'Could not load the editor — reload the page';

// The lines of editing, as issue #161 words them.
export const notNewestLine = (variant) => `This is not the newest revision of ${variant} — edits go on the newest`;
export const editingLine = (base, variant) => `Editing on top of ${shortId(base)} of ${variant}`;
export const QUEUED = 'Queued…';
export const STILL_WAITING = 'Hub unreachable — still waiting';
export const HUB_LOST = 'The hub lost this build — commit again';
export const BRANCH_MOVED = 'The branch moved while this commit was building';
export const HUB_RESTARTED = 'The hub restarted during the build';
export const CONFLICTED = 'Changed on the hub since you opened them: ';
export const OVER_THEIRS = 'Commit mine over theirs';
export const SHOW_LIST = 'Show list';
export const HIDE_LIST = 'Hide list';
export const NO_FOLDERS = 'Folders can\'t be dropped — drop the files inside';

/** How long typing rests before the text goes up to the set: each change set
 *  redraws the whole page under the window. */
export const TEXT_REST_MS = 500;
/** How often a commit's job is asked about, as the comparison's
 *  (`COMPARE_POLL_MS` in HammerolaViewer.jsx). */
export const COMMIT_POLL_MS = 1500;

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
/** What a file's head calls a file the set changed, by its mark. */
const BADGES = {
  M: ['Modified', 'var(--warn-bg)', 'var(--warn)'],
  A: ['New file', 'var(--accent-bg)', 'var(--accent-text)'],
  R: ['Moved', 'var(--accent-bg)', 'var(--accent-text)'],
};
const BADGE = (mark) => `flex:none;padding:2px 7px;border-radius:4px;background:${BADGES[mark][1]};`
  + `color:${BADGES[mark][2]};font:600 10.5px ${SANS}`;
const FILE_BAR = 'flex:none;display:flex;gap:8px;padding:10px 16px 22px;border-top:1px solid var(--line);'
  + 'background:var(--sunken-bg)';
const OFF_BUTTON = ';color:var(--text-faint);background:var(--sunken-bg);cursor:default';
const ACCENT_BUTTON = `height:30px;flex:none;display:flex;align-items:center;padding:0 10px;border-radius:6px;${ON_ACCENT};`
  + `font:600 12px ${SANS};cursor:pointer;user-select:none`;
const STRIP = `flex:none;display:flex;align-items:center;gap:12px;padding:10px 18px;font:400 12.5px ${SANS}`;
const WARN_STRIP = `${STRIP};background:var(--warn-bg);border-bottom:1px solid var(--warn-line);color:var(--warn)`;
const INFO_STRIP = `${STRIP};background:var(--accent-bg-soft);border-bottom:1px solid var(--line-soft);color:var(--text-soft)`;
const OPEN_NEWEST = `${ACCENT_BUTTON};height:28px;padding:0 12px;text-decoration:none`;
const TOOLS = 'flex:none;display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid var(--line-soft)';
const FORM = 'flex:none;padding:10px 12px;border-bottom:1px solid var(--line-soft);background:var(--card-bg)';
const LABEL = `display:block;margin-bottom:4px;font:400 11px ${SANS};color:var(--text-muted)`;
const field = (wrong) => `flex:1;min-width:0;height:30px;box-sizing:border-box;padding:0 8px;border-radius:6px;outline:none;`
  + `border:1px solid ${wrong ? 'var(--danger)' : 'var(--accent)'};background:var(--card-bg);color:var(--text);`
  + `font:400 12px ${MONO}`;
const ALERT = `margin-top:4px;font:400 11px ${SANS};color:var(--danger)`;
const MARK_COLOURS = { M: 'var(--warn)', A: 'var(--ok)', R: 'var(--accent-text)', D: 'var(--danger)' };
const markStyle = (mark) => `width:14px;flex:none;text-align:center;font:700 10.5px ${SANS};color:${MARK_COLOURS[mark]}`;
const MORE = 'width:24px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:4px;'
  + 'color:var(--text-soft);background:var(--chip-bg);font-size:13px;line-height:1;cursor:pointer;user-select:none';
const MENU = `position:absolute;right:8px;top:100%;z-index:3;width:170px;padding:5px 0;${CARD_LOOK}`
  + 'box-shadow:0 10px 28px var(--shadow)';
const MENU_ITEM = `height:30px;display:flex;align-items:center;padding:0 14px;font:400 12.5px ${SANS};color:var(--text);`
  + 'cursor:pointer;user-select:none';
const CATCHER = 'position:fixed;inset:0;z-index:2';
const DROP_ROW = ';outline:1.5px dashed var(--accent);outline-offset:-2px;background:var(--accent-bg)';
const DROP_PANE = ';outline:1.5px dashed var(--accent);outline-offset:-4px';
const CHANGES = 'flex:none;display:flex;flex-direction:column;padding:12px;border-top:1px solid var(--line);'
  + 'background:var(--card-bg)';
const changeRow = (conflict) => `display:flex;align-items:center;gap:8px;min-height:26px;font:400 12px ${SANS}`
  + (conflict ? ';background:var(--warn-bg)' : '');
const QUIET = `flex:none;font:400 11.5px ${SANS};color:var(--text-muted);cursor:pointer;user-select:none`;
const MESSAGE = 'width:100%;box-sizing:border-box;height:52px;resize:none;padding:7px 9px;border-radius:6px;'
  + `border:1px solid var(--line);background:var(--card-bg);color:var(--text);font:400 12px ${MONO}`;
const COMMIT = `margin-top:8px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:6px;`
  + `font:600 12.5px ${SANS};user-select:none`;
const NOTE = `margin-top:10px;padding:10px 12px;border-radius:8px;font:400 12px/17px ${SANS}`;
const BAD_NOTE = `${NOTE};background:var(--danger-bg);border:1px solid var(--danger-line);color:var(--danger)`;
const WARN_NOTE = `${NOTE};background:var(--warn-bg);border:1px solid var(--warn-line);color:var(--warn)`;
const LOG = 'margin-top:8px;max-height:220px;overflow:auto;padding:8px;border-radius:6px;background:var(--card-bg);'
  + `border:1px solid var(--line-soft);color:var(--text-soft);font:400 10.5px/15px ${MONO};white-space:pre`;

// The row's ⋯ shows while the pointer is over the row, and always on a screen
// with no hover, where it could never appear.
const ROW_CLASS = 'hmr-files-row';
const MORE_CLASS = 'hmr-files-more';
const ROW_CSS = `@media (hover:hover){.${ROW_CLASS} .${MORE_CLASS}{visibility:hidden}`
  + `.${ROW_CLASS}:hover .${MORE_CLASS}{visibility:visible}}`;

const parentOf = (path) => path.split('/').slice(0, -1).join('/');
const hasBytes = (entry) => !!entry && (entry.text !== undefined || entry.blob !== undefined);
/** Whether the hub named paths in the last Commit that changed on it. */
const hasConflicts = (commit) => !!(commit && commit.conflicts && commit.conflicts.length);
const carriesFiles = (event) => !!event.dataTransfer && [...(event.dataTransfer.types || [])].includes('Files');
const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** One row of the tree: indented by its depth, a directory in bold, the picked
 *  file marked; taller with a line under it on a narrow window, for a finger. */
const rowStyle = (row, picked, narrow) => 'position:relative;display:flex;align-items:center;gap:6px;'
  + `cursor:${row.gone ? 'default' : 'pointer'};height:${narrow ? 44 : 28}px;padding:0 12px 0 ${12 + row.depth * 16}px;`
  + `font:${row.dir || picked ? 600 : 400} ${narrow ? 14 : 12.5}px ${SANS};`
  + (narrow ? 'border-bottom:1px solid var(--line-soft);' : '')
  + (picked ? 'background:var(--accent-bg);box-shadow:inset 2px 0 0 var(--accent);color:var(--accent-text)'
    : row.gone ? 'color:var(--text-faint)' : 'color:var(--text)');

/**
 * The window. Props: `source`, the list's address; `token`; `theme`, the page's,
 * for the text pane; `subtitle`, what the bar says beside "Files" on a wide
 * window; `toast(said)`, the page's; `onClose()`. For editing: `set`, the change
 * set or null; `start`, `{variant, base}` where a first change may start one,
 * null where the window only shows; `notNewest`, `{variant, href}` of the line
 * that says why it only shows; `commit`, how the last Commit is going (`busy`
 * with `step`, `since` and `unreachable`, or its end: `said`, `failed`,
 * `conflicts`); `onSet(set)` takes the set after an action, `onCommit(over)`
 * sends it.
 */
export class FilesWindow extends React.Component {
  constructor(props) {
    super(props);
    // `list` is null while it is on its way, then `{files}` or `{said}`;
    // `picked` the file on the right, `{path, size, kind}` and what came of it
    // (`loading`, `said`, `url` of its bytes, `text` and `orig`, the text of
    // `base` it compares with); `editor` the editor's module once imported,
    // `'failed'` when it could not be. `folder` is where New file, New folder
    // and Upload put things ('' the top); `menu` the path whose ⋯ is open;
    // `form` the field open (`{kind: 'file' | 'folder' | 'rename', subject,
    // typed, said}`); `drop` the folder a drag over the window would land in,
    // `dropRow` whether it is over that folder's row; `message` the commit
    // message while it is being typed; `listOpen` whether a narrow window shows
    // the rows under Changes (N), which a conflict from the hub opens.
    this.state = {
      list: null, dirs: {}, picked: null, editor: null,
      narrow: !!(window.matchMedia && window.matchMedia(NARROW).matches),
      folder: '', menu: null, form: null, drop: null, dropRow: false, message: null,
      listOpen: hasConflicts(props.commit),
    };
    // The set as this window last left it, until BuildPage hands it back as
    // `set`: two actions in one turn must not both start from the old one.
    this.unsent = undefined;
    // The text typed and not yet handed up, and what the pane on screen is of.
    this.resting = null;
    this.paneOf = null;
    this.paneLocked = true;
    this.tick = null;
    this.picker = React.createRef();
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
      // A menu or a field open takes Escape first.
      if (this.state.menu !== null || this.state.form) this.setState({ menu: null, form: null });
      else this.props.onClose();
    };
    // Files dragged over the window land in `folder`, the chosen one when not
    // over a folder's row. A drop anywhere over the window is the window's:
    // the browser would otherwise open the file in place of the page.
    this.dragOver = (event, folder = this.state.folder, row = false) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!this.canEdit()) return;
      if (this.state.drop !== folder || this.state.dropRow !== row) this.setState({ drop: folder, dropRow: row });
    };
    this.dragLeave = (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) this.setState({ drop: null, dropRow: false });
    };
    // A folder from Finder arrives as a file the browser cannot read: it is
    // left out, said in a toast, and the files dropped with it go up.
    this.dropped = (event, folder = this.state.folder) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.setState({ drop: null, dropRow: false });
      const { items, files } = event.dataTransfer;
      const dropped = items ? [...items].filter((item) => item.kind === 'file') : [];
      if (!dropped.length) {
        this.upload([...files], folder);
        return;
      }
      const isFolder = (item) => {
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        return !!entry && entry.isDirectory;
      };
      if (this.canEdit() && dropped.some(isFolder)) this.props.toast(NO_FOLDERS);
      this.upload(dropped.filter((item) => !isFolder(item)).map((item) => item.getAsFile()).filter(Boolean), folder);
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

  componentDidUpdate(prev) {
    if (prev.set !== this.props.set) this.unsent = undefined;
    if (hasConflicts(this.props.commit) && !hasConflicts(prev.commit)) this.setState({ listOpen: true });
    this.mountEditor();
    this.ticking();
  }

  componentWillUnmount() {
    this.inside.removeEventListener('keydown', this.onInsideDown, true);
    this.inside.removeEventListener('keydown', this.onInsideKey);
    window.removeEventListener('keydown', this.onKey);
    if (this.mq) this.mq.removeEventListener('change', this.onNarrow);
    if (this.tick) clearInterval(this.tick);
    this.gone = true;
    this.release();
  }

  /** "Building… m:ss" counts on between two answers of the hub. */
  ticking() {
    const on = !!(this.props.commit && this.props.commit.since);
    if (on && !this.tick) this.tick = setInterval(() => this.forceUpdate(), 1000);
    if (!on && this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  /** The change set as it stands, or null. */
  current() {
    return this.unsent !== undefined ? this.unsent : this.props.set;
  }

  /** What the window shows: the set, or the revision's list as a set with
   *  nothing in it. */
  shown() {
    const { list } = this.state;
    return this.current() || startSet('', '', (list && list.files) || []);
  }

  /** Whether an action may be taken now: a set to add to, or the newest
   *  revision to start one on, the list there, and no Commit under way. */
  canEdit() {
    const { list } = this.state;
    const { start, commit } = this.props;
    return !!(this.current() || start) && !!(list && list.files) && !(commit && commit.busy);
  }

  /** One action folded into the set — started on the revision on screen if
   *  there is none — and handed to BuildPage. */
  act(fold) {
    const { start } = this.props;
    const set = this.current();
    if (!set && !start) return;
    const next = fold(set || startSet(start.variant, start.base, this.state.list.files));
    this.unsent = isEmpty(next) ? null : next;
    this.props.onSet(next);
  }

  /** An action that may move, replace or remove the file on screen: the text
   *  typed goes first, and afterwards the pane shows the file as it now is —
   *  where it was moved to (`moved`, `{from, to}`), or nothing once it is gone. */
  structural(fold, moved = null) {
    this.flush();
    const before = this.shown();
    this.act(fold);
    const { picked } = this.state;
    if (!picked) return;
    let path = picked.path;
    if (moved && (path === moved.from || path.startsWith(`${moved.from}/`))) {
      path = moved.to + path.slice(moved.from.length);
    }
    const was = fileAt(before, picked.path);
    const now = fileAt(this.shown(), path);
    if (!now) {
      this.release();
      this.setState({ picked: null });
    } else if (path !== picked.path || !was || now.entry !== was.entry) {
      this.pick(path);
    }
  }

  /** The text typed and the message typed, handed up now: before Commit, a
   *  Revert, another file, closing and leaving the page. */
  flush() {
    if (this.resting) {
      clearTimeout(this.resting);
      this.resting = null;
      this.sendText();
    }
    const typed = this.state.message;
    if (typed !== null) {
      if (!this.gone) this.setState({ message: null });
      this.act((set) => withMessage(set, typed));
    }
  }

  sendText() {
    if (!this.view || !this.paneOf) return;
    const text = this.view.getText();
    const { path, orig } = this.paneOf;
    this.act((set) => editText(set, path, text, orig));
  }

  /** The list at `source`, or the set's, which is that of its build; a refusal
   *  or a broken answer is a line instead. */
  async loadList() {
    if (this.props.set) {
      this.setState({ list: { files: this.props.set.files } });
      return;
    }
    const { response, error } = await askHub(this.props.source, this.props.token);
    let list = { said: error ? HUB_UNREACHABLE : hubTrouble(response, 200, LIST_FAILED) };
    if (!list.said) {
      const { body, error: unread } = await hubBody(response);
      list = unread ? { said: LIST_FAILED } : { files: (body && body.files) || [] };
    }
    if (!this.gone) this.setState({ list });
  }

  /** The text pane, the bytes' address and the fetch of the file on screen,
   *  let go — the text typed in the pane handed up first: a fetch that lands
   *  after ← Files is dropped too. */
  release() {
    this.flush();
    if (this.view) this.view.destroy();
    if (this.url) URL.revokeObjectURL(this.url);
    this.view = null;
    this.paneOf = null;
    this.url = null;
    this.ticket = null;
  }

  /** Show one file: its bytes in the set when it holds them — the text in it
   *  always as text — otherwise fetched from the set's build, at the path it
   *  had there, unless it is large (`fileKind`). Its folder becomes the one
   *  New file and Upload put things in. */
  pick(path) {
    this.release();
    const file = fileAt(this.shown(), path);
    const size = file ? file.size : 0;
    const entry = file && file.entry;
    const kind = entry && entry.text !== undefined ? 'text' : fileKind(path, size);
    const ticket = {};
    this.ticket = ticket;
    this.setState({ picked: { path, size, kind, loading: kind !== 'large' }, folder: parentOf(path), menu: null });
    if (kind === 'large') return;
    if (entry && entry.text !== undefined) {
      this.setState({ picked: { path, size, kind, text: entry.text, orig: entry.orig } });
      this.loadEditor();
    } else if (hasBytes(entry)) {
      entry.blob.arrayBuffer().then((bytes) => this.show(ticket, { path, size, kind }, bytes, entry.orig, true),
        () => this.show(ticket, { path, size, kind }, null));
    } else {
      this.fetchFile(ticket, path, size, kind, file ? file.from : path);
    }
  }

  async fetchFile(ticket, path, size, kind, from) {
    const { response, error } = await askHub(sourceFileUrl(this.props.source, from), this.props.token);
    const said = error ? HUB_UNREACHABLE : hubTrouble(response, 200, FILE_FAILED);
    let bytes = null;
    if (!said) {
      try {
        bytes = await response.arrayBuffer();
      } catch {
        bytes = null;
      }
    }
    this.show(ticket, { path, size, kind }, bytes, undefined, false, said);
  }

  /** The bytes of the picked file on screen, by its kind. Text compares with
   *  what it was in the build (`orig`): the bytes fetched from it, every line
   *  ending made `\n`, or for bytes the set holds what the set kept. */
  show(ticket, picked, bytes, orig, local, said = null) {
    if (this.gone || ticket !== this.ticket) return;
    const { kind } = picked;
    if (said || !bytes) {
      this.setState({ picked: { ...picked, said: said || FILE_FAILED } });
    } else if (kind === 'image' || kind === 'pdf') {
      // The hub sends every file as octet-stream; a frame shows a PDF only from
      // bytes typed as one.
      this.url = URL.createObjectURL(new Blob([bytes], kind === 'pdf' ? { type: 'application/pdf' } : {}));
      this.setState({ picked: { ...picked, url: this.url } });
    } else {
      const text = decodeText(bytes);
      this.setState({ picked: text === null ? { ...picked, kind: 'binary' }
        : { ...picked, text, orig: local ? orig : normalText(text) } });
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
   *  for it are all there; read-only while no action may be taken, and turned
   *  so in place when that changes (a Commit under way). What is typed goes up
   *  once typing rests (`TEXT_REST_MS`). */
  mountEditor() {
    const { picked, editor } = this.state;
    const locked = !this.canEdit();
    if (this.view) {
      if (locked !== this.paneLocked) {
        this.flush();
        this.view.setReadOnly(locked);
        this.paneLocked = locked;
      }
      return;
    }
    if (!picked || picked.text === undefined || !editor || editor === 'failed' || !this.host.current) return;
    this.paneLocked = locked;
    this.paneOf = { path: picked.path, orig: picked.orig };
    this.view = editor.mount(this.host.current, {
      text: picked.text, language: editorLanguage(picked.path), readOnly: locked, theme: this.props.theme,
      onChange: () => {
        clearTimeout(this.resting);
        this.resting = setTimeout(() => {
          this.resting = null;
          this.sendText();
        }, TEXT_REST_MS);
      },
    });
  }

  /** One file handed to the browser under its own name: the bytes the set
   *  holds, or fetched with the token from the set's build; a refusal, or a
   *  body cut off on the way, is a toast. */
  async download(path) {
    this.flush();
    const file = fileAt(this.shown(), path);
    if (file && hasBytes(file.entry)) {
      this.save(path, bodyOf(file.entry));
      return;
    }
    const { response, error } = await askHub(sourceFileUrl(this.props.source, file ? file.from : path),
      this.props.token);
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
    this.save(path, blob);
  }

  save(path, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** Every folder down to `path` opened, and `path` too when it is one. */
  openTo(path, itself = false) {
    const names = path.split('/');
    const dirs = { ...this.state.dirs };
    names.slice(0, itself ? names.length : -1).forEach((_, at) => { dirs[names.slice(0, at + 1).join('/')] = true; });
    this.setState({ dirs });
  }

  /** Files from Upload or a drop, into `folder`: a name already there is
   *  replaced; one the hub would not take is a toast. */
  upload(files, folder) {
    if (!this.canEdit() || !files.length) return;
    files.forEach((file) => {
      const path = folder ? `${folder}/${file.name}` : file.name;
      const said = pathProblem(this.shown(), path, 'upload');
      if (said) this.props.toast(said);
      else this.structural((set) => putFile(set, path, file));
    });
    if (folder) this.openTo(folder, true);
  }

  /** The field New file, New folder or Rename or move… opens, starting at the
   *  chosen folder, or at the path of the row it renames. */
  openForm(kind, subject = null) {
    if (!this.canEdit()) return;
    const { folder } = this.state;
    const typed = kind === 'rename' ? subject : folder ? `${folder}/` : '';
    this.setState({ form: { kind, subject, typed, said: '' }, menu: null });
  }

  /** What the hub would say against the path typed, '' for nothing. */
  formProblem(form) {
    const { kind, subject, typed } = form;
    if (kind === 'rename' && typed === subject) return '';
    const shown = this.shown();
    const folder = kind === 'folder' || (kind === 'rename' && !fileAt(shown, subject));
    return pathProblem(shown, typed, folder ? 'folder' : 'file', kind === 'rename' ? subject : null);
  }

  submitForm() {
    const { form } = this.state;
    if (!form || !this.canEdit()) return;
    const said = form.typed ? this.formProblem(form) : notAPath(form.typed);
    if (said) {
      this.setState({ form: { ...form, said } });
      return;
    }
    const { kind, subject, typed } = form;
    this.setState({ form: null });
    if (kind === 'file') {
      this.structural((set) => newFile(set, typed));
      this.openTo(typed);
      this.pick(typed);
    } else if (kind === 'folder') {
      this.act((set) => newFolder(set, typed));
      this.openTo(typed, true);
      this.setState({ folder: typed });
    } else if (typed !== subject) {
      this.structural((set) => move(set, subject, typed), { from: subject, to: typed });
      this.openTo(typed);
    }
  }

  /** One record of the set taken back, the text typed handed up first. */
  revertChange(key) {
    this.structural((set) => revert(set, key));
  }

  /** Every record of the set taken back, the text typed handed up first. */
  revertAllChanges() {
    this.structural((set) => revertAll(set));
  }

  commit(over) {
    this.flush();
    this.props.onCommit(over);
  }

  /** The field open: its label, the path, the button and what the hub would
   *  say against the path, said as it is typed. */
  form() {
    const { form } = this.state;
    const label = form.kind === 'rename' ? `Rename or move ${baseName(form.subject)}`
      : form.kind === 'folder' ? 'New folder path' : 'New file path';
    const off = !form.typed || !!form.said;
    return (
      <div key="form" onClick={(event) => event.stopPropagation()}
           style={css(form.kind === 'rename' ? `${FORM};padding-left:30px` : FORM)}>
        <label htmlFor="hmr-files-path" style={css(LABEL)}>{label}</label>
        <div style={css('display:flex;gap:6px')}>
          <input id="hmr-files-path" type="text" autoFocus value={form.typed} autoComplete="off" spellCheck="false"
                 onChange={(event) => {
                   const typed = event.target.value;
                   this.setState({ form: { ...form, typed, said: typed ? this.formProblem({ ...form, typed }) : '' } });
                 }}
                 onKeyDown={(event) => { if (event.key === 'Enter') this.submitForm(); }}
                 style={css(field(!!form.said))} />
          <span onClick={off ? undefined : () => this.submitForm()}
                style={css(off ? `${BUTTON};height:30px${OFF_BUTTON}` : ACCENT_BUTTON)}>
            {form.kind === 'rename' ? 'Rename' : 'Create'}
          </span>
        </div>
        {form.said && <div role="alert" style={css(ALERT)}>{form.said}</div>}
      </div>
    );
  }

  /** A tree row's ⋯ menu — Rename or move…, Download for a file, Delete — or,
   *  on a narrow window (`fromFile`), the file head's: the Rename or move…
   *  field stands in the tree, so that screen goes back to it. */
  menu(row, fromFile = false) {
    const item = (label, action, danger = false) => (
      <div key={label} style={css(danger ? `${MENU_ITEM};color:var(--danger)` : MENU_ITEM)}
           onClick={(event) => {
             event.stopPropagation();
             this.setState({ menu: null });
             action();
           }}>
        {label}
      </div>
    );
    return (
      <div onClick={(event) => event.stopPropagation()} style={css(MENU)}>
        {item('Rename or move…', () => {
          if (fromFile) this.back();
          this.openForm('rename', row.path);
        })}
        {!row.dir && item('Download', () => this.download(row.path))}
        <div style={css('height:1px;margin:4px 0;background:var(--line-soft)')} />
        {item('Delete', () => this.structural((set) => remove(set, row.path)), true)}
      </div>
    );
  }

  /** The tree, or the line that stands for it: the files of the set as they
   *  stand, a change marked (`markOf` in changeset.js), a deleted file struck
   *  through, a new folder with nothing in it said so; with a ⋯ per row while
   *  an action may be taken, and the Rename or move… field under its row. */
  tree() {
    const { list, dirs, picked, narrow, menu, form, drop, dropRow } = this.state;
    const shown = this.shown();
    const said = !list ? 'Loading…' : list.said
      || (list.files.length || shown.entries.length || shown.folders.length ? '' : 'No files in this revision.');
    if (said) return <div style={css(`padding:10px 14px;font:400 12px ${SANS};color:var(--text-muted)`)}>{said}</div>;
    const editing = this.canEdit();
    const out = [];
    fileRows(overlay(shown), dirs, shown.folders).forEach((row) => {
      const dropHere = dropRow && row.dir && drop === row.path;
      const open = () => (row.dir
        ? this.setState({ dirs: { ...dirs, [row.path]: !row.open }, folder: row.path, menu: null })
        : this.pick(row.path));
      out.push(
        <div key={`${row.dir ? 'd' : 'f'}:${row.path}`} title={row.path} className={ROW_CLASS}
             style={css(rowStyle(row, !!picked && !row.gone && !row.dir && picked.path === row.path, narrow)
               + (dropHere ? DROP_ROW : ''))}
             onClick={row.gone ? undefined : open}
             onDragOver={row.dir ? (event) => this.dragOver(event, row.path, true) : undefined}
             onDrop={row.dir ? (event) => this.dropped(event, row.path) : undefined}>
          <span style={css('width:12px;height:12px;flex:none;display:flex;color:var(--text-muted)')}>
            {row.dir && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d={row.open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
              </svg>
            )}
          </span>
          <span style={css(`${FILL};min-width:0;${ELLIPSIS}${row.gone ? ';text-decoration:line-through' : ''}`)}>
            {row.name}
          </span>
          {dropHere && (
            <span style={css(`flex:none;font:600 11px ${SANS};color:var(--accent-text)`)}>
              {`Drop to upload into ${row.path}/`}
            </span>
          )}
          {!dropHere && row.dir && row.empty && (
            <span style={css(`flex:none;font:italic 400 11px ${SANS};color:var(--text-muted)`)}>empty — add a file</span>
          )}
          {row.mark && <span style={css(markStyle(row.mark))}>{row.mark}</span>}
          {!row.dir && <span style={css(`flex:none;font:400 10.5px ${MONO};color:var(--text-faint)`)}>{sizeText(row.size)}</span>}
          {editing && !row.gone && (
            <span className={MORE_CLASS} title="Actions"
                  onClick={(event) => {
                    event.stopPropagation();
                    this.setState({ menu: menu === row.path ? null : row.path });
                  }}
                  style={css(menu === row.path ? `${MORE};visibility:visible` : MORE)}>
              &#8943;
            </span>
          )}
          {/* A deleted file has no actions; the gap keeps its size under the others'. */}
          {editing && row.gone && <span style={css('width:24px;flex:none')} />}
          {editing && menu === row.path && this.menu(row)}
        </div>,
      );
      if (form && form.kind === 'rename' && form.subject === row.path) out.push(this.form());
    });
    return out;
  }

  /** New file, New folder and Upload, shown off where no action may be taken. */
  tools() {
    const off = !this.canEdit();
    const button = (label, onClick) => (
      <span key={label} onClick={off ? undefined : onClick}
            style={css(`${BUTTON};height:30px${off ? OFF_BUTTON : ''}`)}>
        {label}
      </span>
    );
    return (
      <div style={css(TOOLS)}>
        {button('New file', () => this.openForm('file'))}
        {button('New folder', () => this.openForm('folder'))}
        {button('Upload', () => this.picker.current.click())}
        <input ref={this.picker} type="file" multiple style={css('display:none')}
               onChange={(event) => {
                 const files = [...event.target.files];
                 event.target.value = '';
                 this.upload(files, this.state.folder);
               }} />
      </div>
    );
  }

  /** What the Commit button says while a Commit is under way. */
  step(commit) {
    return commit.since ? `Building… ${clock(Date.now() - commit.since)}` : commit.step || QUEUED;
  }

  /** Changes (N) with Revert all, and on a narrow window Show list / Hide list,
   *  which folds the rows away until a conflict opens them; each record with
   *  its Revert, the hub's conflicts over them, the message, Commit, and how
   *  the last Commit went. */
  changes(set) {
    const { commit } = this.props;
    const busy = !!(commit && commit.busy);
    const rows = changeRows(set, (commit && commit.conflicts) || []);
    const conflicted = busy ? [] : rows.filter((row) => row.conflict);
    const message = this.state.message !== null ? this.state.message : messageOf(set);
    const { narrow, listOpen } = this.state;
    const folded = narrow && !listOpen;
    return (
      <div style={css(CHANGES)}>
        <div style={css(`display:flex;align-items:center;gap:12px;margin-bottom:6px;font:600 12px ${SANS}`)}>
          <span>{`Changes (${rows.length})`}</span>
          <span style={css(FILL)} />
          <span onClick={busy ? undefined : () => this.revertAllChanges()}
                style={css(busy ? `${QUIET};color:var(--text-faint);cursor:default` : `${QUIET};color:var(--accent-text)`)}>
            Revert all
          </span>
          {narrow && (
            <span onClick={() => this.setState({ listOpen: !listOpen })}
                  style={css(`${QUIET};font-size:12.5px;color:var(--accent-text)`)}>
              {folded ? SHOW_LIST : HIDE_LIST}
            </span>
          )}
        </div>
        {conflicted.length > 0 && (
          <div style={css(`${WARN_NOTE};margin:0 0 6px`)}>
            <div>
              {CONFLICTED}
              <b style={css(`font-family:${MONO}`)}>{conflicted.map((row) => row.label).join(', ')}</b>
            </div>
            <span onClick={() => this.commit(commit.conflicts)}
                  style={css(`${BUTTON};margin-top:8px;display:inline-flex;border-color:var(--warn-line)`)}>
              {OVER_THEIRS}
            </span>
          </div>
        )}
        {!folded && <div style={css('max-height:30vh;overflow:auto')}>
          {rows.map((row) => (
            <div key={row.key} style={css(changeRow(row.conflict && !busy))}>
              <span style={css(markStyle(row.mark))}>{row.mark}</span>
              <span title={row.label} style={css(`flex:0 1 auto;min-width:0;font:400 11.5px ${MONO};${ELLIPSIS}`
                + (row.mark === 'D' ? ';text-decoration:line-through;color:var(--text-muted)' : ''))}>
                {row.label}
              </span>
              {row.conflict && !busy && (
                <span style={css(`flex:none;font:600 10.5px ${SANS};color:var(--warn)`)}>changed on the hub</span>
              )}
              <span style={css(FILL)} />
              <span onClick={busy ? undefined : () => this.revertChange(row.key)}
                    style={css(busy ? `${QUIET};color:var(--text-faint);cursor:default` : QUIET)}>
                Revert
              </span>
            </div>
          ))}
        </div>}
        <label htmlFor="hmr-files-message" style={css(`${LABEL};margin-top:10px`)}>Commit message</label>
        <textarea id="hmr-files-message" value={message} disabled={busy} spellCheck="false"
                  onChange={(event) => this.setState({ message: event.target.value })}
                  onBlur={() => this.flush()}
                  style={css(busy ? `${MESSAGE};background:var(--sunken-bg);color:var(--text-muted)` : MESSAGE)} />
        <span onClick={busy ? undefined : () => this.commit([])}
              style={css(busy ? `${COMMIT};background:var(--chip-bg);color:var(--text-muted);cursor:default`
                : `${COMMIT};${ON_ACCENT};cursor:pointer`)}>
          {busy ? this.step(commit) : 'Commit'}
        </span>
        {busy && commit.unreachable && <div style={css(WARN_NOTE)}>{STILL_WAITING}</div>}
        {commit && commit.said && <div role="alert" style={css(BAD_NOTE)}>{commit.said}</div>}
        {commit && commit.failed && (
          <div role="alert" style={css(BAD_NOTE)}>
            {commit.failed.line && <div style={css('font-weight:600')}>{commit.failed.line}</div>}
            {commit.failed.error && (
              <div style={css(`margin-top:4px;font:400 11px ${MONO};overflow-wrap:anywhere`)}>{commit.failed.error}</div>
            )}
            {commit.failed.log && <div style={css(LOG)}>{commit.failed.log}</div>}
          </div>
        )}
      </div>
    );
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

  /** The picked file: its path, what it is and its size, a badge when the set
   *  changed it, Open for a PDF (the same bytes in a tab of their own: a phone
   *  may show only the first page in a frame), and the pane. Revert (of that
   *  file's record, when it has one) and Download are in the head, and on a
   *  narrow window in a bar under the pane, with a ⋯ menu in the head. The size
   *  is the tree's, so it follows the text typed once that goes up. */
  file(picked) {
    const label = picked.loading && picked.kind === 'text' ? '' : KIND_LABELS[picked.kind];
    const record = fileAt(this.shown(), picked.path);
    const { narrow } = this.state;
    const mark = record ? markOf(record.entry) : '';
    const busy = !!(this.props.commit && this.props.commit.busy);
    const look = narrow ? `${BUTTON};height:34px;font-size:13px` : BUTTON;
    const revertButton = mark && (
      <span key="revert" onClick={busy ? undefined : () => this.revertChange(entryKey(record.entry))}
            style={css(busy ? `${look}${OFF_BUTTON}` : look)}>
        Revert
      </span>
    );
    const download = <span key="download" onClick={() => this.download(picked.path)} style={css(look)}>Download</span>;
    return (
      <>
        <div style={css(`${HEAD};position:relative`)}>
          <span title={picked.path} style={css(`flex:0 1 auto;min-width:0;font:600 12.5px ${MONO};${ELLIPSIS}`)}>
            {picked.path}
          </span>
          <span style={css(`flex:none;font:400 11px ${SANS};color:var(--text-muted)`)}>
            {[label, sizeText(record ? record.size : picked.size)].filter(Boolean).join(' · ')}
          </span>
          {mark && <span style={css(BADGE(mark))}>{BADGES[mark][0]}</span>}
          <span style={css(FILL)} />
          {picked.kind === 'pdf' && picked.url && (
            <a href={picked.url} target="_blank" rel="noopener" style={css(BUTTON)}>Open</a>
          )}
          {!narrow && revertButton}
          {!narrow && download}
          {narrow && this.canEdit() && (
            <span title="Actions" onClick={() => this.setState({ menu: this.state.menu === picked.path ? null : picked.path })}
                  style={css(`${MORE};width:32px;height:32px;font-size:18px`)}>
              &#8943;
            </span>
          )}
          {narrow && this.state.menu === picked.path && this.menu({ path: picked.path }, true)}
        </div>
        {this.body(picked)}
        {narrow && <div style={css(FILE_BAR)}>{revertButton}{download}</div>}
      </>
    );
  }

  render() {
    const { narrow, picked, menu, form, drop, dropRow } = this.state;
    const { notNewest } = this.props;
    const set = this.current();
    // Both panes always stand in the tree, a narrow window hiding one, so the
    // box CodeMirror is mounted in is never rebuilt under it.
    const treeShown = !narrow || !picked;
    const fileShown = !narrow || !!picked;
    return (
      <div style={css(OVERLAY)} onDragOver={this.dragOver} onDragLeave={this.dragLeave} onDrop={this.dropped}>
        <style>{ROW_CSS}</style>
        {menu !== null && <div onClick={() => this.setState({ menu: null })} style={css(CATCHER)} />}
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
          {set ? <div style={css(INFO_STRIP)}>{editingLine(set.base, set.variant)}</div> : notNewest && (
            <div style={css(WARN_STRIP)}>
              <span style={css('min-width:0')}>{notNewestLine(notNewest.variant)}</span>
              <a href={notNewest.href} style={css(OPEN_NEWEST)}>Open newest</a>
            </div>
          )}
          <div style={css('flex:1;min-height:0;display:flex')}>
            <div style={css(`${narrow ? 'flex:1' : 'width:340px;flex:none;border-right:1px solid var(--line)'};`
              + `min-width:0;flex-direction:column;background:${narrow ? 'var(--card-bg)' : 'var(--sunken-bg)'};`
              + `display:${treeShown ? 'flex' : 'none'}`)}>
              {this.tools()}
              {form && form.kind !== 'rename' && this.form()}
              <div style={css(`flex:1;min-height:0;overflow:auto;padding:${narrow ? 0 : 6}px 0`
                + (drop !== null && !dropRow ? DROP_PANE : ''))}>
                {this.tree()}
              </div>
              {set && set.entries.length > 0 && this.changes(set)}
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

const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** The hub's own words for a refusal, or its status where it wrote none. */
const refusalOf = (response, body) => (body && typeof body.error === 'string' && body.error.trim())
  || hubTrouble(response, null, `HTTP ${response.status}`);

/**
 * Commit, from the page (BuildPage's `onCommit`), so that it outlives the
 * window: the bytes of each record of `set` up, one `POST …/blob` each (those
 * a move onto a deleted file's place takes from `base`, fetched first), then
 * `POST …/commit` with the set's `changes` — the paths `over` put over the
 * hub's — and its job asked after every `COMMIT_POLL_MS` until it ends.
 * `report(commit)` hears the way (`{busy, step, since, unreachable}`);
 * `gone()` says the page is leaving. -> how it ended: `{done}`, `{said}`, the
 * job's `{failed: {line, error, log}}`, `{conflicts}`, or null once gone.
 */
export async function commitSet(set, over, { pid, token, report, gone }) {
  const sends = uploads(set);
  const shas = {};
  for (let at = 0; at < sends.length; at += 1) {
    report({ busy: true, step: `Uploading ${at + 1}/${sends.length}` });
    let bytes = bodyOf(sends[at]);
    if (bytes === null) {
      // The listing carries no blob ids, so `base`'s bytes come down and go up.
      const got = await askHub(sourceFileUrl(baseUrl(pid, set.base), sends[at].from), token);
      if (got.error) return { said: HUB_UNREACHABLE };
      if (got.response.status !== 200) return { said: refusalOf(got.response, (await hubBody(got.response)).body) };
      try {
        bytes = await got.response.blob();
      } catch {
        return { said: HUB_UNREACHABLE };
      }
    }
    const sent = await askHub(`/api/v1/source/${encodeURIComponent(pid)}/blob`, token,
      { method: 'POST', body: bytes });
    if (sent.error) return { said: HUB_UNREACHABLE };
    const { body } = await hubBody(sent.response);
    if (sent.response.status !== 200 || !body || typeof body.blob !== 'string') {
      return { said: refusalOf(sent.response, body) };
    }
    shas[sends[at].path] = body.blob;
  }
  report({ busy: true, step: QUEUED });
  const asked = await askHub(`/api/v1/source/${encodeURIComponent(pid)}/commit`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      variant: set.variant, base: set.base, message: messageOf(set), changes: payload(set, shas, over),
    }),
  });
  if (asked.error) return { said: HUB_UNREACHABLE };
  const { response } = asked;
  const { body } = await hubBody(response);
  if (response.status === 200 && body && body.already === true) return { done: true };
  if (response.status === 409 && body && Array.isArray(body.conflicts) && body.conflicts.length) {
    return { conflicts: body.conflicts };
  }
  if (response.status !== 202 || !body || typeof body.job !== 'string') return { said: refusalOf(response, body) };
  return follow(body.job, token, report, gone);
}

/** The commit's job, asked after until it ends. A job ends always (the hub
 *  fails one a restart cut off), so there is no deadline: no answer, or a 5xx
 *  from a proxy while the hub restarts, is waited out; a 404 is a job the hub
 *  no longer has. The build time counts from the first `building`, by this
 *  browser's clock: `started` is the hub's. */
async function follow(job, token, report, gone) {
  let since = null;
  for (;;) {
    let record = null;
    try {
      record = await loadJob(job, token);
    } catch (error) {
      if (error instanceof Unauthorized) return { said: hubTrouble({ status: 403 }, null, '') };
      if (error.status === 404) return { said: HUB_LOST };
      if (error.status !== undefined && error.status < 500) return { said: `HTTP ${error.status}` };
    }
    if (gone()) return null;
    if (record && record.state === JOB_DONE) return { done: true };
    if (record && record.state === JOB_FAILED) return { failed: await failure(record, token) };
    if (record && record.state === JOB_BUILDING && since === null) since = Date.now();
    report({ busy: true, step: QUEUED, since, unreachable: !record });
    await pause(COMMIT_POLL_MS);
    if (gone()) return null;
  }
}

/** A failed job as the window says it: the line for a branch that moved or a
 *  hub that restarted, the job's `error`, and its log. */
async function failure(record, token) {
  let log = '';
  if (typeof record.log_url === 'string') {
    const { response } = await askHub(record.log_url, token);
    if (response && response.status === 200) {
      try {
        log = await response.text();
      } catch {
        log = '';
      }
    }
  }
  const line = record.code === 409 ? BRANCH_MOVED : record.code === 503 ? HUB_RESTARTED : '';
  return { line, error: String(record.error || ''), log };
}
