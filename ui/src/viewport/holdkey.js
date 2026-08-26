// Hold-to-peek: hold a key and the cut tool is up, let go and it is gone.
//
// ui-brief block 4 asks for it by name, and the whole of this file is the
// answer to two questions that each cost a debugging session the first time this
// site built the feature: WHICH KEY, and WHAT HAPPENS WHEN THE RELEASE NEVER
// ARRIVES. Both answers are written out below rather than cited, because the
// code they were found in is gone and the findings are what mattered.
//
// WHY A PLAIN LETTER AND NOT A MODIFIER. Command was the obvious candidate and
// it does not survive contact:
//
//   * it is already spoken for INSIDE the library. Its `keyMapping` deliberately
//     permutes the modifiers (`{shift: "ctrlKey", ctrl: "shiftKey",
//     meta: "altKey", alt: "metaKey"}`), so `metaKey` reads as the logical `alt`
//     there, and the trackball pans on a left drag with ctrl/meta/shiftKey. The
//     flag is read off the POINTER event, not off a keydown that could be
//     swallowed, so there is nothing to intercept;
//   * Cmd+wheel is the browser's own page zoom, and a hold-to-peek is exactly
//     when somebody reaches for the wheel;
//   * and it is the worst case for the stuck-key problem below: macOS hands
//     Cmd+Tab, Cmd+Space and every menu-bar shortcut to the system, taking the
//     keyup with them.
//
// A plain letter, then — but NOT any plain letter. The library has a shortcut
// table of its own (`ViewerState.DISPLAY_DEFAULTS.keymap`), it hangs
// `_handleKeyboardShortcut` on the CONTAINER, and a key it recognises is
// answered with `preventDefault(); stopPropagation()`. The container takes focus
// the moment anybody clicks the model, so from then on a colliding key never
// reaches this file at all. Its letters, measured off the bundle rather than
// guessed: A 0 g G p t b R r 5 1 3 8 2 4 6 x L D P I h space Escape T C M Z S,
// plus a/v/e/f/s while the topo-filter dropdown is open and Backspace with the
// select tool. `x` is `explode` — and `x` was this feature's first key, silently
// eaten after every click on the part until that table was read off the bundle.
//
// Hiding the panel does NOT retire that list. `tools: false` is CSS
// (docs/viewer-api.md §1): the handler is still bound and the container still
// takes focus, so a colliding letter is still eaten, silently, by a toolbar
// nobody can see.
//
// So: C. `c` is free, `C` is the library's own Clip tab, and the tool this key
// holds up is the one that drives that tab's plane. It is also under the left
// hand while the right is on the mouse.
//
// Matched on `code`, not `key`: `code` is the physical key, so this still works
// on a Cyrillic layout, where the same key produces "с". `key` is the fallback
// for the rare input path that reports no code at all.
//
// The listeners are registered in the CAPTURE phase on the WINDOW for the same
// reason the collision was possible at all: capture on the window runs before
// anything on the container, so nothing downstream can swallow this key even if
// the library's table grows a `c` one day.

const HOLD_CODE = "KeyC";
const HOLD_KEY = "c";

export const isHoldKey = (e) =>
  (e.code ? e.code === HOLD_CODE
          : String(e.key || "").toLowerCase() === HOLD_KEY);

/** True when the keystroke belongs to something the reader is typing into.
 *
 * A comment box is a textarea, and a shortcut that fires while somebody is
 * writing a sentence is a shortcut that eats the sentence. A `<select>` counts
 * too — a picker jumps to an option by its first letter.
 *
 * "Any `<input>`" would be the wrong rule, and measurably so: the library's tab
 * strip is `<input>`, so are the Clip panel's checkboxes, and under that rule one
 * click on a checkbox would cost the reader the shortcut with nothing on screen
 * to explain it. Same test the library applies in its own handler — text-entry
 * inputs only.
 */
const NOT_TEXT_INPUT = new Set(["button", "checkbox", "radio", "submit",
                                "reset", "file", "image", "range", "color"]);

export function typingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NOT_TEXT_INPUT.has(String(el.type || "text").toLowerCase());
}

/**
 * Wire the hold key up to `onHold` / `onRelease`. Returns a teardown function.
 *
 * `onRelease` is called at most once per hold and may be called for reasons that
 * are not a keyup at all — see the three nets at the bottom. Every one of them
 * is a case that really happens, and the failure they prevent is the same one:
 * a tool that is still up when the reader comes back, reading as a viewer that
 * has broken rather than a mode nobody left.
 */
export function installHoldKey({ onHold, onRelease, onEscape }) {
  let held = false;

  const release = () => {
    if (!held) return;
    held = false;
    onRelease();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      release();
      if (onEscape) onEscape();
      return;
    }
    // A keyup for an ordinary key is NOT delivered while Command is down on
    // macOS: press C, then Cmd, then let C go, and the release never arrives.
    // From the moment Cmd goes down the real release cannot be relied on, so
    // treat Cmd itself as the release. Costs a peek that nobody asked to end
    // this way; the alternative is a tool stuck on with no key to press.
    if (e.key === "Meta") release();
    if (!isHoldKey(e)) return;
    // Auto-repeat is the same press, still held. Ignoring it is also what stops
    // Escape from being undone a moment later by a finger that never lifted.
    if (e.repeat) return;
    // Any modifier and this is somebody aiming at a browser or OS shortcut
    // (Cmd+C is copy), whose keyup the platform may well keep to itself.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (typingTarget()) return;
    if (held) return;
    held = true;
    onHold();
  };

  // No typingTarget() guard and no modifier guard on the way OUT: a release is
  // only ever allowed to turn the tool off, and a release that gets filtered is
  // exactly the stuck key this whole block is written around.
  const onKeyUp = (e) => {
    if (isHoldKey(e)) release();
  };

  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  // The three ways a keyup goes missing entirely. None is hypothetical: Cmd+Tab
  // away, a system menu opening over the page, or the tab going to the
  // background all leave the key down as far as this document is concerned.
  // Deliberately redundant — a tab going to the background fires `blur` AND
  // `visibilitychange` — because a release that arrives twice costs nothing and
  // one that never arrives costs the page.
  const onBlur = () => release();
  const onVisibility = () => {
    if (document.visibilityState !== "visible") release();
  };
  addEventListener("blur", onBlur);
  addEventListener("pagehide", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    release();
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("blur", onBlur);
    removeEventListener("pagehide", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
