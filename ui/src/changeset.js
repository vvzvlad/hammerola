/**
 * The change set of the Files window (files.jsx): the edits made to the files
 * of one build, kept until Commit sends them as one commit of the hub's
 * (`POST /api/v1/source/<pid>/commit`, SPEC 7.8). Pure: every action takes a
 * set and answers a new one; BuildPage holds it and the window draws it.
 *
 * A set is `{variant, base, files, entries, folders, message}`: `base` is the
 * build whose files the window showed when the first change was made, `files`
 * that build's list (`[{path, size}]`), and `entries` one record per file of
 * `base` or new file — `from`, its path in `base` (undefined for a new file),
 * `path`, where it is now (null once deleted), and its bytes when they are not
 * `base`'s: `text` out of the editor or `blob` out of an upload, with `size`,
 * and `orig`, the text of `base` the editor started from, with every line
 * ending made `\n`. `folders` are new folders nothing has been put in yet, which
 * live in the window only (git keeps no empty folder); `message` is the commit
 * message once the reader has typed one.
 */

// The hub's words for a path it will not take (src/pagecommit.py), which the
// window says under its field before the hub is asked; tests/test_ui_source.py
// holds the last three to the hub's. `notAPath` is the hub's sentence with the
// path bare: the hub quotes it (`{path!r}`).
export const notAPath = (path) => `not a path of the project: ${path}`;
export const alreadyThere = (path) => `${path} already exists`;
export const fileInTheWay = (path) => `a file exists where you’re trying to create a subdirectory: ${path}`;
export const folderInTheWay = (path) => `a directory exists where you’re trying to create a file: ${path}`;

/** A set on `base` of `variant`, with nothing in it yet. */
export const startSet = (variant, base, files) => ({ variant, base, files, entries: [], folders: [], message: null });

/** A set with no change and no new folder is no set at all. */
export const isEmpty = (set) => !set || (set.entries.length === 0 && set.folders.length === 0);

/** Text with `\r\n` and `\r` made `\n`, as the editor joins its lines. */
export const normalText = (text) => String(text).replace(/\r\n?/g, '\n');

const hasBytes = (entry) => entry.text !== undefined || entry.blob !== undefined;
const under = (path, folder) => path.startsWith(`${folder}/`);
const foldersOf = (path) => {
  const names = path.split('/');
  return names.slice(0, -1).map((_, at) => names.slice(0, at + 1).join('/'));
};

/** What names an entry across edits: the path in `base` it came from, or a new
 *  file's path, which only one file has at a time. */
export const entryKey = (entry) => (entry.from !== undefined ? `base:${entry.from}` : `new:${entry.path}`);

/** M edited (or replaced), A new, R moved, D deleted. */
export const markOf = (entry) => {
  if (!entry) return '';
  if (entry.path === null) return 'D';
  if (entry.from === undefined) return 'A';
  return entry.from === entry.path ? 'M' : 'R';
};

/** The files of the set as they stand, by path: `{path, size, from, entry}`,
 *  `entry` null for a file of `base` nothing touched. */
function liveFiles(set) {
  const sizes = new Map(set.files.map((file) => [file.path, file.size]));
  const touched = new Set(set.entries.map((entry) => entry.from).filter((from) => from !== undefined));
  const live = new Map();
  set.files.forEach((file) => {
    if (!touched.has(file.path)) live.set(file.path, { path: file.path, size: file.size, from: file.path, entry: null });
  });
  set.entries.forEach((entry) => {
    if (entry.path === null) return;
    live.set(entry.path, {
      path: entry.path, size: hasBytes(entry) ? entry.size : sizes.get(entry.from), from: entry.from, entry,
    });
  });
  return live;
}

/** The file at `path` as the set has it, or null. */
export const fileAt = (set, path) => liveFiles(set).get(path) || null;

/** Every folder of the set: those of its files and the new empty ones. */
function allFolders(set, live) {
  const folders = new Set();
  live.forEach((_, path) => foldersOf(path).forEach((folder) => folders.add(folder)));
  set.folders.forEach((folder) => [...foldersOf(folder), folder].forEach((each) => folders.add(each)));
  return folders;
}

/** Is `path` a folder of the set? */
export const isFolder = (set, path) => allFolders(set, liveFiles(set)).has(path);

/**
 * The rows of the tree: the files of the set, each with its `mark`, and each
 * deleted file of `base` at its old path, `gone`, unless a file stands there
 * again. -> `[{path, size, from, entry, mark, gone}]`, for `fileRows`
 * (filesview.js) with `set.folders`.
 */
export function overlay(set) {
  const live = liveFiles(set);
  const rows = [...live.values()].map((file) => ({ ...file, mark: markOf(file.entry), gone: false }));
  const sizes = new Map(set.files.map((file) => [file.path, file.size]));
  set.entries.forEach((entry) => {
    if (entry.path === null && !live.has(entry.from)) {
      rows.push({ path: entry.from, size: sizes.get(entry.from), from: entry.from, entry, mark: 'D', gone: true });
    }
  });
  return rows;
}

/**
 * What the hub would say against putting a file (`kind` 'file'), a folder
 * ('folder') or an upload ('upload', which replaces a file already there) at
 * `path`, '' for nothing. `moving` is the file or folder being moved there,
 * which leaves its place as it goes.
 */
export function pathProblem(set, path, kind, moving = null) {
  const segments = String(path).split('/');
  if (String(path).includes('\0')
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    return notAPath(path);
  }
  const leaves = (each) => moving !== null && (each === moving || under(each, moving));
  const live = liveFiles(set);
  [...live.keys()].forEach((each) => { if (leaves(each)) live.delete(each); });
  const folders = allFolders({ ...set, folders: set.folders.filter((folder) => !leaves(folder)) }, live);
  const blocking = foldersOf(path).find((folder) => live.has(folder));
  if (blocking) return fileInTheWay(blocking);
  if (live.has(path)) return kind === 'upload' ? '' : alreadyThere(path);
  if (folders.has(path)) return kind === 'folder' ? alreadyThere(path) : folderInTheWay(path);
  return '';
}

/** A record that says nothing — a file of `base` where it was, with its bytes —
 *  is no record. */
const says = (entry) => !(entry.from !== undefined && entry.path === entry.from && !hasBytes(entry));

/** The set with `entries`, the new folders a file has since landed in dropped:
 *  such a folder is now a folder of the tree. */
function settle(set, entries, folders = set.folders) {
  const next = { ...set, entries: entries.filter(says), folders };
  const paths = [...liveFiles(next).keys()];
  return { ...next, folders: folders.filter((folder) => !paths.some((path) => under(path, folder))) };
}

/** `old` (an entry of the set, or null) replaced by `next` (or by nothing), in
 *  its place in the list. */
function put(set, old, next) {
  const entries = old ? set.entries.flatMap((entry) => (entry === old ? (next ? [next] : []) : [entry]))
    : [...set.entries, ...(next ? [next] : [])];
  return settle(set, entries);
}

/** The record of the file at `path` — an entry of the set, or a fresh one for a
 *  file of `base` nothing touched yet — and the entry it replaces. */
function recordAt(set, path) {
  const entry = set.entries.find((each) => each.path === path);
  if (entry) return { old: entry, entry };
  if (set.files.some((file) => file.path === path) && !set.entries.some((each) => each.from === path)) {
    return { old: null, entry: { from: path, path } };
  }
  return null;
}

/** A new file standing where a file of `base` was deleted becomes that file,
 *  written. */
function absorb(entries) {
  let out = entries;
  entries.forEach((entry) => {
    if (entry.from !== undefined || entry.path === null) return;
    const gone = out.find((each) => each.path === null && each.from === entry.path);
    if (!gone) return;
    const written = { from: gone.from, path: gone.from, text: entry.text, blob: entry.blob, size: entry.size };
    out = out.flatMap((each) => (each === gone ? [written] : each === entry ? [] : [each]));
  });
  return out;
}

/**
 * The editor's text of the file at `path`. `orig` is the text it was opened
 * with when that came from `base`; a file whose text is back to it holds no
 * bytes of its own any more.
 */
export function editText(set, path, text, orig) {
  const found = recordAt(set, path);
  if (!found) return set;
  const { old, entry } = found;
  const start = entry.orig !== undefined ? entry.orig : orig;
  const back = entry.from !== undefined && start !== undefined && text === start;
  const next = back ? { from: entry.from, path: entry.path }
    : { from: entry.from, path: entry.path, text, size: new TextEncoder().encode(text).length, orig: start };
  return put(set, old, next);
}

/** Bytes put at `path`: over the file there, over a deleted file of `base`
 *  (which is then that file, written), or as a new file. */
function write(set, path, bytes) {
  const found = recordAt(set, path);
  if (found) return put(set, found.old, { from: found.entry.from, path, orig: found.entry.orig, ...bytes });
  const gone = set.entries.find((entry) => entry.path === null && entry.from === path);
  if (gone) return put(set, gone, { from: path, path, ...bytes });
  return put(set, null, { from: undefined, path, ...bytes });
}

/** An uploaded file (a `Blob`) at `path`. */
export const putFile = (set, path, blob) => write(set, path, { blob, size: blob.size });

/** An empty text file at `path`. */
export const newFile = (set, path) => write(set, path, { text: '', size: 0 });

/** A new folder, in the window only until a file is put in it. */
export const newFolder = (set, path) => settle(set, set.entries, [...set.folders, path]);

/** The file at `path` deleted — a new one is just gone — or every file of the
 *  folder at `path`. */
export function remove(set, path) {
  const found = recordAt(set, path);
  if (found) {
    const { old, entry } = found;
    return put(set, old, entry.from === undefined ? null : { from: entry.from, path: null });
  }
  let next = settle(set, set.entries, set.folders.filter((folder) => folder !== path && !under(folder, path)));
  [...liveFiles(next).keys()].filter((each) => under(each, path)).forEach((each) => { next = remove(next, each); });
  return next;
}

/** The file at `path` moved to `to`, or the folder at `path` with every file
 *  in it. A file of `base` moved back to its place holds only its bytes, if
 *  any. */
export function move(set, path, to) {
  if (path === to) return set;
  const live = liveFiles(set);
  const moves = new Map(live.has(path) ? [[path, to]]
    : [...live.keys()].filter((each) => under(each, path)).map((each) => [each, to + each.slice(path.length)]));
  const entries = set.entries.map((entry) => (entry.path !== null && moves.has(entry.path)
    ? { ...entry, path: moves.get(entry.path) } : entry));
  live.forEach((file, each) => {
    if (!file.entry && moves.has(each)) entries.push({ from: each, path: moves.get(each) });
  });
  const folders = set.folders.map((folder) => (folder === path || under(folder, path)
    ? to + folder.slice(path.length) : folder));
  return settle(set, absorb(entries), folders);
}

/**
 * The record `key` (`entryKey`) taken back: the file is as in `base` again. A
 * file of `base` coming back to a place a new file took makes that file its
 * bytes; to one another file of `base` was moved to, takes that move back too.
 */
export function revert(set, key) {
  const entry = set.entries.find((each) => entryKey(each) === key);
  if (!entry) return set;
  let next = { ...set, entries: set.entries.filter((each) => each !== entry) };
  if (entry.from !== undefined && entry.path !== entry.from) {
    const there = next.entries.find((each) => each.path === entry.from);
    if (there && there.from === undefined) {
      const written = { from: entry.from, path: entry.from, text: there.text, blob: there.blob, size: there.size };
      next = { ...next, entries: next.entries.map((each) => (each === there ? written : each)) };
    } else if (there) {
      next = revert(next, entryKey(there));
    }
  }
  return settle(next, next.entries);
}

/** Every record taken back and every new empty folder dropped: the set is
 *  empty and the files are as in `base` again. Not Revert row by row, which can
 *  leave a record behind — a move taken back onto a new file's place makes that
 *  file an edit. */
export const revertAll = (set) => settle(set, [], []);

/** The set with the message the reader typed. */
export const withMessage = (set, message) => ({ ...set, message });

/** What one record says in the default message. */
function verb(entry) {
  if (entry.path === null) return `delete ${entry.from}`;
  if (entry.from !== undefined && entry.from !== entry.path) return `move ${entry.from}`;
  if (entry.blob !== undefined) return `upload ${entry.path}`;
  return entry.from === undefined ? `add ${entry.path}` : `edit ${entry.path}`;
}

/** `Edit model.py; upload ref/bracket.step; delete old.txt`, and past three
 *  records `…and N more`. */
export function defaultMessage(set) {
  const said = set.entries.map(verb);
  const text = said.slice(0, 3).join('; ') + (said.length > 3 ? ` …and ${said.length - 3} more` : '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The message Commit sends. */
export const messageOf = (set) => (set.message !== null ? set.message : defaultMessage(set));

/** The paths a record touches: where it is (or was, deleted) and where it came
 *  from — what the hub's `conflicts` name. */
const pathsOf = (entry) => [entry.path === null ? entry.from : entry.path, entry.from]
  .filter((path) => path !== undefined);

/** The list under Changes (N): `{key, mark, label, conflict}` per record, a
 *  move one line `from → path`; `conflict` when the hub named one of its paths. */
export function changeRows(set, conflicts = []) {
  const named = new Set(conflicts);
  return set.entries.map((entry) => {
    const mark = markOf(entry);
    const label = mark === 'D' ? entry.from : mark === 'R' ? `${entry.from} → ${entry.path}` : entry.path;
    return { key: entryKey(entry), mark, label, conflict: pathsOf(entry).some((path) => named.has(path)) };
  });
}

/** A move onto the path of a file of `base`, deleted or moved away. It goes
 *  to the hub as a write of its bytes there and a delete of its old place,
 *  unless another file stands there now: the hub takes no path both removed
 *  and written, and a move onto a file of the tip would have to be `over`,
 *  which skips the hub's conflict check of both its paths. A write over a file
 *  of the tip needs neither, and each path is checked on its own. A move onto
 *  a place another move left goes the same way: that move may itself go as a
 *  write, which no longer clears its old place. */
const replaces = (set, entry) => entry.path !== null && entry.from !== undefined && entry.from !== entry.path
  && set.files.some((file) => file.path === entry.path);

/** The records whose bytes go up before the commit, each by `blob`: those
 *  holding bytes of their own, and a move onto the path of a file of `base`
 *  (`replaces`), whose bytes without its own are `base`'s at its old place. */
export const uploads = (set) => set.entries.filter((entry) => entry.path !== null
  && (hasBytes(entry) || replaces(set, entry)));

/** One record's bytes as the body of `POST …/blob`: the upload, the text in
 *  UTF-8, or null for bytes that are `base`'s at `entry.from`, which the
 *  caller fetches from there. */
export const bodyOf = (entry) => (entry.blob !== undefined ? entry.blob
  : entry.text !== undefined ? new Blob([entry.text]) : null);

/**
 * The commit's `changes` (SPEC 7.8): `shas` the blob of each uploaded record by
 * its path, `over` the paths of the hub's `conflicts` the reader puts his
 * version over — a move by either of its ends, the write and the delete a move
 * onto the path of a file of `base` goes as (`replaces`) each by its own path.
 */
export function payload(set, shas, over = []) {
  const live = liveFiles(set);
  const forced = new Set(over);
  const changes = [];
  const put = (change, paths) => {
    if (paths.some((path) => forced.has(path))) change.over = true;
    changes.push(change);
  };
  set.entries.forEach((entry) => {
    if (entry.path === null) {
      if (!live.has(entry.from)) put({ path: entry.from, blob: null }, [entry.from]);
    } else if (entry.from === undefined || entry.from === entry.path) {
      put({ path: entry.path, blob: shas[entry.path] }, [entry.path]);
    } else if (replaces(set, entry)) {
      put({ path: entry.path, blob: shas[entry.path] }, [entry.path]);
      if (!live.has(entry.from)) put({ path: entry.from, blob: null }, [entry.from]);
    } else {
      const change = { path: entry.path, from: entry.from };
      if (hasBytes(entry)) change.blob = shas[entry.path];
      put(change, pathsOf(entry));
    }
  });
  return changes;
}
