// Which moving pointer — `latest` or `dev` — a reader last opened, PER PROJECT.
//
// THIS FILE IS THE READING HALF, and its one importer is the resolver at
// /project/<pid>/ (pointer.js). The recording half is the build page, which is
// now the React interface: `rememberPointer` in ui/src/store.js writes the key
// when a build page opens under one of the two moving names.
//
// THE TWO HALVES CANNOT SHARE A MODULE, which is why the key is spelled twice.
// This file is served straight to the resolver page, and that page must not
// pull the interface bundle — 3.6 MB downloaded to read one key and leave, on
// the way to a page that will download it again (tests/test_pointer_memory.py
// pins that too). So the spellings are compared from Python instead, which is
// the same arrangement POINTER_NAMES has lived under since live reload
// (tests/test_live_reload.py). A copy nothing compares is a pair that agrees
// until the day one of them is edited, and the failure is silent — a reader
// whose choice simply stops being remembered.
//
// PER PROJECT, not one flag for the whole site. Someone editing one model lives
// in `dev` while merely looking at another, and a single flag would open the
// second one on a local build that has nothing to do with what they wanted.

/** The two moving names. A commit id is neither, and is never remembered. */
export const POINTER_NAMES = ["latest", "dev"];

// Namespaced like the other keys this site stores (`.pointing_device`, and the
// interface's `.token.<pid>` and `.notes.<pid>`), and suffixed with the project
// id, which is why it is a PREFIX.
const KEY_PREFIX = "hammerola.pointer.";

const key = (pid) => KEY_PREFIX + pid;

/**
 * The remembered pointer for one project, or null.
 *
 * Anything that is not one of the two names reads as null — an old value, a key
 * somebody set by hand, a name this site no longer has. The caller then falls
 * back to `latest`, which is the answer that is always safe.
 */
export function readPointer(pid) {
  if (!pid) return null;
  let saved = null;
  try {
    saved = localStorage.getItem(key(pid));
  } catch (e) {
    // Private mode, or storage turned off. Nothing was remembered, and that is
    // a complete answer — not an error worth showing anybody.
    console.warn("pointer preference", e);
  }
  return POINTER_NAMES.includes(saved) ? saved : null;
}
