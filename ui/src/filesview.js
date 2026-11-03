/**
 * The header's Files card (Header.jsx): the files of the project directory the
 * build on screen was made from, as the hub lists them
 * (`GET /api/v1/source/`, src/app.py). Pure: the address, the rows and the
 * size a row says; the fetching is the header's.
 */
import { VARIANT_SEGMENT, buildKey } from './hub.js';

/** The list's address for the build on screen, `page` being `PAGE` and `meta`
 *  its meta.json. On `latest` it is the revision meta.json names: `latest` moves
 *  on with the next push while the page still shows the build it loaded. Any
 *  other slot as the page addresses it, a variant's pointer under
 *  `v/<variant>/`, as a snapshot names a build. `dev` is the slot as it stands:
 *  a draft pushed over the one on screen replaces it on the hub, which keeps no
 *  other, so until the page takes the new one the card lists the new one's. */
export function sourceUrl(page, meta) {
  const commit = page.slot === 'latest' && meta && meta.commit;
  return `/api/v1/source/${encodeURIComponent(page.pid)}/` + (commit ? encodeURIComponent(commit)
    : (page.variant ? `${VARIANT_SEGMENT}/${encodeURIComponent(page.variant)}/` : '')
      + encodeURIComponent(page.slot));
}

/** What the card's list is held under: its address and the build itself, since
 *  `dev` keeps its address for every draft it takes (`buildKey`). */
export const filesId = (page, meta) => `${sourceUrl(page, meta)}#${buildKey(meta)}`;

/** One file of the list at `url`: its path in the query, as the hub looks it up. */
export const sourceFileUrl = (url, path) => `${url}?path=${encodeURIComponent(path)}`;

/** The last segment of a path: the name a file is saved under. */
export const baseName = (path) => String(path).split('/').pop();

/** A file's size as a row says it. */
export const sizeText = (bytes) => (bytes < 1000 ? `${bytes} B`
  : bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : `${(bytes / 1e6).toFixed(1)} MB`);

const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The hub's flat list `[{path, size}]` as the rows of a tree,
 * `[{path, name, depth, dir, open, size}]`: in each directory its directories
 * first, then its files, each alphabetically; a directory's rows follow it only
 * when `open[path]` is `true`, so everything below the top is shut until the
 * reader opens it. Maps, because a name out of a pushed tree may be
 * `__proto__`.
 */
export function fileRows(files, open) {
  const root = new Map();
  files.forEach(({ path, size }) => {
    const names = String(path).split('/');
    let level = root;
    names.forEach((name, at) => {
      if (at === names.length - 1) {
        level.set(name, { name, path, size, dir: false });
        return;
      }
      if (!level.has(name)) {
        level.set(name, { name, path: names.slice(0, at + 1).join('/'), dir: true, children: new Map() });
      }
      level = level.get(name).children;
    });
  });
  const rows = [];
  const walk = (level, depth) => {
    [...level.values()]
      .sort((a, b) => (b.dir - a.dir) || text(a.name, b.name))
      .forEach((node) => {
        const opened = node.dir && open[node.path] === true;
        rows.push({ path: node.path, name: node.name, depth, dir: node.dir, open: opened, size: node.size });
        if (opened) walk(node.children, depth + 1);
      });
  };
  walk(root, 0);
  return rows;
}
