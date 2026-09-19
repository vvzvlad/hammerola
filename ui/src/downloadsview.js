/**
 * The downloads menu, built out of the part catalogue: key -> {extension -> file}.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE (issue #103). The
 * groups it answers with are `downloadGroups`, which `chromeView` puts back in
 * the object because the menu hangs off a header button; `anyDownloads` is the
 * same answer asked as a yes or no, and the row menu's file rows need it to
 * tell "this build ships nothing" from "this part is not a printable".
 *
 * `fileHref` IS EXPORTED BESIDE THEM because the row menu builds the same link
 * for one part that this menu builds for all of them, and two spellings of one
 * address is two ways for a file to come down under the wrong name.
 *
 * THE CATALOGUE IS THE WHOLE OF THE INPUT — there is no `s` here, because
 * nothing about this menu is a thing the reader has done: it is what the build
 * declares it ships. `groupDownloads` stays beside the component, which is
 * where the tests reach for it.
 */
import { PAGE } from './hub.js';
import { MONO, SANS } from './style.jsx';

export const fileHref = (file) => PAGE.base + encodeURIComponent(String(file));

export function downloadsView(catalogue, deps) {
  const { groupDownloads, downloadAll } = deps;

  const dlRowStyle = `display:flex;align-items:center;gap:10px;padding:6px 14px 6px 22px;text-decoration:none;color:var(--text);font:400 12px ${SANS}`;
  const downloadGroups = groupDownloads(catalogue).map((g) => ({
    key: g.ext,
    ext: g.ext,
    files: g.files.map((f) => ({
      key: f.file, label: f.label, file: f.file, href: fileHref(f.file),
      style: dlRowStyle,
    })),
    headStyle: `display:flex;align-items:center;gap:8px;padding:8px 14px 3px;font:600 10px ${MONO};color:var(--text-muted);letter-spacing:.08em`,
    allStyle: `cursor:pointer;font:500 10.5px ${MONO};color:var(--accent-text);text-decoration:underline`,
    // ONE CLICK, N DOWNLOADS, DONE IN THE BROWSER — the owner's decision, and
    // the cost is worth stating rather than discovering. A browser does not
    // block the second file and the ones after it; it ASKS, once, with a
    // per-site permission it then remembers (the note further down, on the
    // tree row's group, is where that correction is written out). So for a
    // PERSON this is one prompt and then nothing. For an agent driving the
    // page there is nobody to answer that prompt, which is why an agent takes
    // `hammerola artifacts` instead and why this is not the hub's job: no
    // route, no archive, no client change.
    //
    // No `stop()`: the click bubbles to `rootClick` and closes the menu, which
    // is exactly what a file row beside it already does by being a plain link.
    onAll: () => downloadAll(g.files.map((f) => fileHref(f.file))),
  }));
  const anyDownloads = downloadGroups.length > 0;

  return { downloadGroups, anyDownloads };
}
