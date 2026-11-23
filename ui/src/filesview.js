/**
 * The Files window (files.jsx): the files of the project directory the build on
 * screen was made from, as the hub lists them (`GET /api/v1/source/`,
 * src/app.py). Pure: the address, the rows, the size a row says and what the
 * window does with a file; the fetching is the window's.
 */
import { VARIANT_SEGMENT, buildKey } from './hub.js';

/** The list's address for the build on screen, `page` being `PAGE` and `meta`
 *  its meta.json. On `latest` it is the revision meta.json names: `latest` moves
 *  on with the next push while the page still shows the build it loaded. Any
 *  other slot as the page addresses it, a variant's pointer under
 *  `v/<variant>/`, as a snapshot names a build. `dev` is the slot as it stands:
 *  a draft pushed over the one on screen replaces it on the hub, which keeps no
 *  other, so until the page takes the new one the window lists the new one's.
 *  The window asks this one address for the list and, through `sourceFileUrl`,
 *  for every file's bytes. */
export function sourceUrl(page, meta) {
  const commit = page.slot === 'latest' && meta && meta.commit;
  return commit ? baseUrl(page.pid, commit) : `/api/v1/source/${encodeURIComponent(page.pid)}/`
    + (page.variant ? `${VARIANT_SEGMENT}/${encodeURIComponent(page.variant)}/` : '')
    + encodeURIComponent(page.slot);
}

/** The list's address for build `base` by its name — the one a change set is
 *  on, whichever revision the page shows. */
export const baseUrl = (pid, base) => `/api/v1/source/${encodeURIComponent(pid)}/${encodeURIComponent(base)}`;

/** Which list the window shows: its address and the build itself, since `dev`
 *  keeps its address for every draft it takes (`buildKey`). */
export const filesId = (page, meta) => `${sourceUrl(page, meta)}#${buildKey(meta)}`;

/** One file of the list at `url`: its path in the query, as the hub looks it up. */
export const sourceFileUrl = (url, path) => `${url}?path=${encodeURIComponent(path)}`;

/** The last segment of a path: the name a file is saved under. */
export const baseName = (path) => String(path).split('/').pop();

/** A file's extension in lower case, '' for none. */
const extension = (path) => {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Above this many bytes (as `sizeText` counts a megabyte) the window does not
 *  fetch a file: over the largest text files read by hand, a `.kicad_pcb` of
 *  12.8 MB, and under an ASCII STEP of a whole assembly, up to 61 MB. */
export const LARGE_FILE = 16e6;

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** What the window does with a file of the list, by its path and its listed
 *  size: `large` is not fetched, `image` and `pdf` are drawn from their bytes,
 *  `text` is fetched and decoded (`decodeText`), and turns out binary when it
 *  does not decode. */
export function fileKind(path, size) {
  if (size > LARGE_FILE) return 'large';
  const ext = extension(path);
  if (IMAGES.has(ext)) return 'image';
  return ext === 'pdf' ? 'pdf' : 'text';
}

/** The bytes of a file as text, or null where they are not text: not UTF-8, or
 *  holding a NUL. `ignoreBOM` keeps a byte-order mark as the text's first
 *  character instead of dropping it. */
export function decodeText(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\0') ? null : text;
}

const LANGUAGES = new Map([['py', 'python'], ['json', 'json']]);

/** The language the text pane highlights a file in (`mount` in
 *  editor/editor.js), '' for none. */
export const editorLanguage = (path) => LANGUAGES.get(extension(path)) || '';

/** A file's size as a row says it. */
export const sizeText = (bytes) => (bytes < 1000 ? `${bytes} B`
  : bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(1)} MB`);

const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The hub's flat list `[{path, size}]` as the rows of a tree,
 * `[{path, name, depth, dir, open, size}]`: in each directory its directories
 * first, then its files, each alphabetically; a directory's rows follow it only
 * when `open[path]` is `true`, so everything below the top is shut until the
 * reader opens it. A file's other fields (`mark`, `gone`, … of `overlay` in
 * changeset.js) ride on its row; `folders` are directories with no file in
 * them, and a directory with nothing under it is `empty`. Maps, because a name
 * out of a pushed tree may be `__proto__`, keyed by kind as well, since a set
 * of changes can hold a file and a folder of one name for a while.
 */
export function fileRows(files, open, folders = []) {
  const root = new Map();
  const dirIn = (level, name, path) => {
    const key = `d:${name}`;
    if (!level.has(key)) level.set(key, { name, path, dir: true, children: new Map() });
    return level.get(key).children;
  };
  const place = (path) => {
    const names = String(path).split('/');
    let level = root;
    names.slice(0, -1).forEach((name, at) => { level = dirIn(level, name, names.slice(0, at + 1).join('/')); });
    return { level, name: names[names.length - 1] };
  };
  files.forEach((file) => {
    const { level, name } = place(file.path);
    level.set(`f:${name}`, { ...file, name, dir: false });
  });
  folders.forEach((folder) => {
    const { level, name } = place(folder);
    dirIn(level, name, folder);
  });
  const rows = [];
  const walk = (level, depth) => {
    [...level.values()]
      .sort((a, b) => (b.dir - a.dir) || text(a.name, b.name))
      .forEach(({ children, ...node }) => {
        const opened = node.dir && open[node.path] === true;
        rows.push({ ...node, depth, open: opened, ...(node.dir ? { empty: children.size === 0 } : {}) });
        if (opened) walk(children, depth + 1);
      });
  };
  walk(root, 0);
  return rows;
}
