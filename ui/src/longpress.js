// A finger held still asks for the menu a right click opens.
//
// The part menu opens on the part in the scene (viewport/tools.js) and on the
// rows of the tree (`onContextMenu`), and all of them answer a `contextmenu`
// event. A phone sends one for a long press on Android only: iOS Safari never
// does (WebKit bug 202143). So this module does it: a primary touch that stays
// within HOLD_PX of where it landed for HOLD_MS gets a `contextmenu`
// dispatched at the element it pressed, at the point it pressed, and every
// right-click handler on the page answers it as it is.
//
// When the browser sends its own `contextmenu` first (Android), the timer
// stands down, so the menu is not asked for twice.
//
// A press that opened a menu (its handler said so with `markMenu`) also eats
// the click its release would make: iOS clicks after a long press, and the
// page's root closes every menu on a click (`rootClick`), so the menu would
// shut the moment the finger lifted. Cancelling the `touchend` is what stops
// that click; the pointer events the scene listens to still arrive. Only an
// opened menu counts, not a cancelled event: the KiCad viewer cancels every
// `contextmenu` and selects on the click, which a slow tap must keep.

/** How long a finger has to stay down: the platforms' own long press. */
export const HOLD_MS = 500;

/** How far it may drift and still be held: UIKit's long-press allowance
 *  (`allowableMovement`, 10 points). A finger held for half a second wanders
 *  further than the 4 px a click is allowed (`CLICK_PX`). */
export const HOLD_PX = 10;

/** For a row that opens a menu: iOS Safari honours only the prefixed form of
 *  `user-select`, so the page's `user-select:none` does not reach it there,
 *  and a held finger on the row's name selects the text instead of opening
 *  the menu. */
export const HOLDABLE = '-webkit-user-select:none;';

const OPENED = 'hmrMenuOpened';

/** Called by a `contextmenu` handler that opened a menu, on the native event. */
export function markMenu(event) {
  event[OPENED] = true;
}

/** Whether a handler opened a menu on this event. */
export const menuOpened = (event) => event[OPENED] === true;

/** Listen on `win`; the function returned takes the listeners off again. */
export function installLongPress(win = window) {
  // The press being timed: its pointer, where it landed, and the timer.
  let held = null;
  // Whether the next `touchend` is the release of a press that opened a menu.
  let swallow = false;

  const cancel = () => {
    if (held) clearTimeout(held.timer);
    held = null;
  };

  const onDown = (event) => {
    // Any new contact ends the timing: a second finger is a pinch, not a
    // longer press. It also disarms a swallow whose `touchend` never came (the
    // touch was cancelled instead), which would otherwise eat this tap's click.
    cancel();
    swallow = false;
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const { pointerId, clientX, clientY, target } = event;
    const timer = setTimeout(() => {
      held = null;
      const menu = new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX, clientY,
      });
      target.dispatchEvent(menu);
      swallow = menuOpened(menu);
    }, HOLD_MS);
    held = { pointerId, clientX, clientY, timer };
  };

  const onMove = (event) => {
    if (held && event.pointerId === held.pointerId
        && Math.hypot(event.clientX - held.clientX, event.clientY - held.clientY) > HOLD_PX) {
      cancel();
    }
  };

  const onEnd = (event) => {
    if (held && event.pointerId === held.pointerId) cancel();
  };

  // The browser's own long press: ours would be a second menu.
  const onNative = (event) => {
    if (event.isTrusted) cancel();
  };

  const onTouchEnd = (event) => {
    if (!swallow) return;
    swallow = false;
    event.preventDefault();
  };

  // On the window and in the capture phase: the scene stops a tool's press
  // from propagating (viewport/tools.js), and that press is timed too.
  // `passive: false` is for `touchend`, whose cancelling is the point.
  const listeners = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onEnd],
    ['pointercancel', onEnd], ['contextmenu', onNative], ['touchend', onTouchEnd],
  ];
  for (const [type, fn] of listeners) {
    win.addEventListener(type, fn, { capture: true, passive: false });
  }
  return () => {
    cancel();
    for (const [type, fn] of listeners) win.removeEventListener(type, fn, true);
  };
}
