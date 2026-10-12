// Hold-to-peek: hold a key and the cut tool is up, let go and it is gone.
//
// Why a plain letter and not a modifier such as Command:
//   * the library already uses modifiers: its `keyMapping` permutes them
//     (`{shift: "ctrlKey", ctrl: "shiftKey", meta: "altKey", alt: "metaKey"}`),
//     and the trackball pans on a left drag with ctrl/meta/shiftKey, read off
//     the pointer event, so there is nothing to intercept;
//   * Cmd+wheel is the browser's page zoom;
//   * macOS hands Cmd+Tab, Cmd+Space and menu shortcuts to the system, taking
//     the keyup with them (the stuck-key problem below).
//
// Not any letter: the library binds `_handleKeyboardShortcut` on the container
// (`ViewerState.DISPLAY_DEFAULTS.keymap`) and answers a key it knows with
// `preventDefault(); stopPropagation()`. The container takes focus on any
// click on the model. Its letters, read off the bundle:
// A 0 g G p t b R r 5 1 3 8 2 4 6 x L D P I h space Escape T C M Z S, plus
// a/v/e/f/s while the topo-filter dropdown is open and Backspace with the select
// tool. Hiding the panel (`tools: false`, docs/viewer-api.md §1) is only CSS:
// the handler stays bound and still eats those keys.
//
// So: C. `c` is free, `C` is the library's Clip tab, and this key holds up the
// tool that drives that tab's plane. It is under the left hand.
//
// Matched on `code`, not `key`, so it works on a Cyrillic layout (where the key
// produces "с"); `key` is the fallback when no code is reported.
//
// Listeners are in the capture phase on the window, which runs before anything
// on the container, so the library cannot swallow this key.

const HOLD_CODE = "KeyC";
const HOLD_KEY = "c";

export const isHoldKey = (e) =>
  (e.code ? e.code === HOLD_CODE
          : String(e.key || "").toLowerCase() === HOLD_KEY);

/** True when the keystroke belongs to something the reader is typing into: a
 * textarea, contenteditable, a `<select>` (jumps to an option by letter), or a
 * text-entry `<input>`. Not any `<input>`: the library's tab strip and the
 * Clip panel's checkboxes are inputs too. Same rule as the library's handler.
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
 * `onRelease` is called at most once per hold and may fire for reasons other
 * than a keyup (see the listeners at the bottom), so the tool never stays up
 * after the reader has left the key.
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
  // The ways a keyup goes missing: Cmd+Tab away, a system menu over the page,
  // the tab going to the background. Redundant on purpose (backgrounding fires
  // both `blur` and `visibilitychange`); a second release is a no-op.
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
