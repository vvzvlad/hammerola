/**
 * The rules both pages write more than once, written once.
 *
 * A MODULE OF ITS OWN FOR THE REASON `style.jsx` IS ONE, and it is the same
 * reason: two entry points draw one interface, and a rule spelled in both of
 * them is two rules that no longer have to agree. `style.jsx` holds what every
 * rule is made OF — `css()`, the font stacks, the four palette roles two
 * components import by name. This holds the rules THEMSELVES: the popover
 * recipe five panels share, the three controls (`btn`, `tab`, `chip`), the four
 * tree icons, and the declarations that were written out 2 to 19 times each.
 *
 * NOTHING HERE IS A CLASS OR A STYLESHEET, deliberately. Every rule on these
 * pages is an inline style string through `css()`, which beats a class rule on
 * specificity and is what lets one `data-theme` attribute repaint the whole
 * interface — `style.jsx` argues that at length. What was wrong was never the
 * strings; it was the COPIES of them. So a name here resolves to exactly the
 * string its call sites used to spell, character for character.
 *
 * THE STRINGS ARE PINNED BY TESTS AS STRINGS. `ui/tests` asserts on the values
 * `computed()` answers with — `toBe('430px')`, `toContain('background:…')` —
 * so a declaration that comes out in a different ORDER, or with a space added,
 * is a changed rule even where the browser would paint the same pixels. The
 * `tail` slot on `popover` below exists for exactly that.
 *
 * PUNCTUATION IS PART OF THE NAME, and a call site cannot see it. Most names
 * here are finished declarations and end in neither `;` nor `:` — whoever
 * continues them adds one. Six are PREFIXES that end in `;` and are meant to be
 * continued: `SWATCH`, `CARD`, `PILL`, `NOTE_BOX`, `DIALOG_BTN`, `BADGE_SANS`.
 * `popover`'s `tail` is of the second kind and carries its own,
 * unlike its `pad`, `radius` and `shadow`, which are VALUES it punctuates: a
 * `tail` written without one runs into the property after it, and `css()` drops
 * the pair it cannot parse without saying anything.
 */
import { HEADER_BG, HEADER_LINE, MONO, SANS } from './style.jsx';

/**
 * A POPOVER AS ONE SHEET ALONG THE BOTTOM EDGE — what a panel of the build page
 * becomes at phone width (`narrow.test.js` says which). Three decisions:
 *   * `fixed`, NOT `absolute`: `left`/`right` resolve against the containing
 *     block, which here is the opening control's wrapper — after the header
 *     wraps, not even at the window's edge. Absolute is narrower AND off-side;
 *   * ANCHORED TO THE BOTTOM, because the header is wrappable BY CONSTRUCTION:
 *     any constant measured from the top has a header height at which the
 *     sheet covers its own button, which then cannot be pressed to dismiss it;
 *   * `top:auto`, because `css()` keeps the LAST spelling of a property — it
 *     is what drops the `top` of the wide string this replaces.
 */
const popSheet = 'position:fixed;left:8px;right:8px;bottom:8px;top:auto;width:auto;';

/* The two depths a popover is lifted off the page by. The default is not
   exported because `popover` is the only way to spend it; the high one is,
   because two call sites pass it. */
const POP_SHADOW = '0 10px 34px var(--shadow)';
export const POP_SHADOW_HIGH = '0 12px 40px var(--shadow)';

/**
 * THE FIVE POPOVERS OF THE BUILD PAGE, BUILT TO ONE RECIPE: the revision picker,
 * the downloads menu, the token control, the section control and the note box —
 * each a card hung off its own control, each becoming
 * `popSheet` when narrow, each shown by its own flag. Five spellings of one
 * shape, which is five places for the card to drift apart.
 * `tail` IS A POSITION, NOT A FEATURE. The string is pinned as
 * text, so a declaration moved past another is a changed rule, and one of the
 * five carries a declaration the common block would not put there: the
 * downloads menu's padding after the shadow. One call site, and the spelling
 * the tests hold.
 */
export function popover({
  narrow, anchor, width, radius, z, open, pad = '', shadow = POP_SHADOW, tail = '',
}) {
  return (narrow ? popSheet : `position:absolute;${anchor};width:${width};`)
    + `background:var(--card-bg);border:1px solid var(--line);border-radius:${radius};`
    + (pad ? `padding:${pad};` : '')
    + `box-shadow:${shadow};`
    + tail
    + `z-index:${z};display:` + (open ? 'block' : 'none');
}

/* -- the three controls both pages draw ------------------------------------ */

/**
 * A CHOSEN PILL, and the one visual answer to "this is the one you are on".
 * The build page's view switcher, its tab strip, the comparison's three modes
 * and the front page's sort and view pickers all say it this way; TAB_ON and
 * TAB_OFF below are the two halves, spent separately by the two controls that
 * draw a pill of a different size round them.
 */
export const TAB_ON = 'background:var(--card-bg);color:var(--text);box-shadow:0 1px 2px var(--shadow-soft)';
export const TAB_OFF = 'color:var(--text-soft)';
export const tab = (active) => `padding:5px 13px;border-radius:5px;font:500 12px ${SANS};cursor:pointer;`
  + (active ? TAB_ON : TAB_OFF);

/**
 * A HEADER BUTTON. `off` is a THIRD state, beside resting and active, and it is
 * not `hide`: the button stays where the reader left it and stops working,
 * which is what a control that is out of service FOR NOW has to look like — the
 * argument `bannerSwitchStyle` makes at length, and the two properties
 * `compareBtnStyle` already spells an unpressable button with. Last in the
 * string, so its `color` and `cursor` beat the resting pair above (`css` keeps
 * the last spelling of a property), and `pointer-events:none` is the half that
 * actually refuses the click.
 */
export const btn = (active, hide, off) => `display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:6px;font:500 12px ${SANS};cursor:pointer;border:1px solid ` + (active ? 'var(--accent-line);background:var(--accent-bg);color:var(--accent-text)' : 'transparent;color:var(--text-soft)') + (hide ? ';display:none' : '') + (off ? ';color:var(--text-faint);cursor:default;pointer-events:none' : '');

/* A card floating over the model — the new-build banner, the measurement. */
export const chip = (show, bg, border, color) => 'pointer-events:auto;display:' + (show ? 'flex' : 'none') + `;align-items:center;gap:8px;padding:7px 12px;background:${bg};border:1px solid ${border};border-radius:7px;font:500 11.5px ${SANS};color:${color};box-shadow:0 2px 8px var(--shadow-soft)`;

/* -- the four icons a tree row is drawn with ------------------------------- */
//
// The parts tree and the proposal's branch draw the SAME controls, so these are
// one definition reached from both rather than a pair handed down through
// `computed()`. `eyeDot` fills half of its circle from a LINE role on purpose —
// tests/test_ui_source.py argues that case where it sweeps for the others.

export const eyeOuter = (st) => 'width:15px;height:10px;border:1.5px solid ' + (st === 'off' ? 'var(--line-strong)' : 'var(--text-soft)') + ';border-radius:50%;display:flex;align-items:center;justify-content:center';
export const eyeDot = (st) => 'width:5px;height:5px;border-radius:3px;' + (st === 'on' ? 'background:var(--text-soft)' : st === 'part' ? 'background:linear-gradient(90deg,var(--text-soft) 50%,var(--line-strong) 50%)' : 'background:transparent');
export const ghostIcon = (on) => 'width:11px;height:11px;border-radius:3px;' + (on ? 'background:linear-gradient(135deg,var(--text-soft) 50%,var(--hover-bg) 50%);border:1px solid var(--text-soft)' : 'border:1px solid var(--line-strong);background:linear-gradient(135deg,var(--hover-bg) 50%,transparent 50%)');

/**
 * THE PROPOSAL'S TICK, drawn as the square beside it so the two read as one row
 * of controls rather than a checkbox bolted onto a tree. FILLED MEANS HELD
 * BACK, which is the way round the reader asked for it — a tick is "leave this
 * out of what you send" — and empty means the node travels, so a branch nobody
 * has touched is a row of empty squares and says so.
 */
export const skipIcon = (on) => 'width:11px;height:11px;border-radius:3px;border:1px solid '
  + (on ? 'var(--text-soft);background:var(--text-soft)' : 'var(--line-strong);background:transparent');

/* -- the declarations that were written out once per call site -------------- *
 *
 * Nothing below is new: each is the string its call sites already spelled,
 * moved here because they spelled it 2 to 19 times. A name is the ROLE where
 * the page has one — a card, a sunken field, the chosen tab — and the SHAPE
 * where it does not, which is most of the type.
 *
 * THIS IS NOT A DESIGN SYSTEM and must not grow into one. A new rule belongs at
 * its call site until a SECOND site wants the same string; that is the only
 * thing that puts one here, and it keeps the list a record of real repetition
 * rather than a vocabulary somebody has to learn to read the page.
 */

/* -- how a box is laid out */
export const FILL = 'flex:1';
export const HIDDEN = 'display:none';
export const RELATIVE = 'position:relative';
export const ROW = 'display:flex;align-items:center;gap:8px';
export const ROW_LABELLED = 'display:flex;align-items:center;gap:8px;margin-bottom:5px';
export const STACK = 'display:flex;flex-direction:column;gap:3px';
/* A name that must never push its row wider than the window. */
export const ELLIPSIS = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

/* -- the fixed-width slots a tree row's controls sit in, and the little marks */
export const SLOT_22 = 'width:22px;display:flex;justify-content:center;cursor:pointer;flex:none';
export const SLOT_24 = 'width:24px;display:flex;justify-content:center;cursor:pointer;flex:none';
export const TOOL_SQUARE = 'width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:var(--text-soft);cursor:pointer;background:var(--float-bg-soft)';
/* Open-ended: the part's own colour, out of the pushed model, closes it. */
export const SWATCH = 'width:9px;height:9px;border-radius:3px;flex:none;margin:0 4px 0 2px;background:';
/* A line, drawn the only way a flex row can draw one. */
export const RULE = 'width:1px;height:18px;background:var(--line)';
export const HEADER_RULE = `width:1px;height:22px;background:${HEADER_LINE}`;
export const HEADER_BAR = `background:${HEADER_BG};border-bottom:1px solid ${HEADER_LINE}`;

/* -- the surfaces */
export const ON_ACCENT = 'background:var(--accent);color:var(--text-on-accent)';
export const ON_ACCENT_EDGE = 'background:var(--accent);color:var(--text-on-accent);border:1px solid var(--accent-strong)';
export const ON_CARD = 'background:var(--card-bg);color:var(--text)';
export const CARD = 'background:var(--card-bg);border:1px solid var(--line);border-radius:12px;';
export const SUNKEN = 'border:1px solid var(--line);background:var(--sunken-bg)';
export const DANGER = 'border:1px solid var(--danger-line);background:var(--danger-bg)';
/* A box with nothing in it yet — the ink is hidden rather than absent. */
export const BLANK_BOX = 'border:1px solid var(--line-strong);background:var(--card-bg);color:transparent';

/* -- ink and cursor */
export const INK = 'color:var(--text)';
export const FAINT_CLICK = 'color:var(--text-faint);cursor:pointer';
export const DIM_CLICK = 'cursor:pointer;opacity:.6';
export const LINK = 'cursor:pointer;text-decoration:underline';
export const IDLE = 'cursor:default';

/* -- boxes and buttons */
export const PILL = 'padding:4px 9px;border-radius:5px;cursor:pointer;user-select:none;';
export const NOTE_BOX = 'margin-top:9px;padding:10px 11px;border-radius:6px;';
export const DIALOG_BTN = 'display:flex;align-items:center;height:34px;padding:0 13px;border-radius:6px;';
export const SEGMENTED = 'display:flex;background:var(--chip-bg);border-radius:6px;padding:2px;gap:2px';
export const QUIET_BTN = `display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:6px;font:500 12px ${SANS};color:var(--text-soft);cursor:pointer;border:1px solid transparent`;
export const HALF_BTN = `flex:1;padding:6px;text-align:center;border:1px solid var(--line);border-radius:5px;font:500 11px ${MONO};color:var(--text-soft);cursor:pointer;background:var(--card-bg)`;
export const ACCENT_BTN = `padding:6px 14px;background:var(--accent);color:var(--text-on-accent);border-radius:6px;font:600 11.5px ${SANS};cursor:pointer`;

/* -- type */
export const WORDMARK = `font:700 14px ${SANS};letter-spacing:-.2px`;
export const TITLE = `font:600 13.5px ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
export const HEAD_SANS = `font:600 12.5px ${SANS}`;
export const HEAD_MONO = `font:600 12px ${MONO}`;
export const NAME_SANS = `font:600 11.5px ${SANS};color:var(--text)`;
export const LABEL_SANS = `font:400 11.5px ${SANS}`;
export const BADGE_SANS = `font:600 10.5px ${SANS};border:1px solid var(--line);`;
export const BODY_SANS = `font:400 11px/1.55 ${SANS};color:var(--text-muted);margin-top:5px`;
export const ACCENT_MONO = `font:600 12px ${MONO};color:var(--accent-text)`;
/* The catalogue key, which is the identity and may be any length (issue #75). */
export const KEY_MONO = `font:600 12px ${MONO};background:var(--chip-bg);padding:2px 7px;border-radius:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
export const META_MONO = `font:400 11px ${MONO};color:var(--text-muted)`;
export const META_MONO_ONE_LINE = `font:400 10.5px ${MONO};color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;
export const FAINT_MONO = `font:400 10.5px ${MONO};color:var(--text-faint)`;
export const INDEX_MONO = `flex:none;font:400 10px ${MONO};color:var(--text-faint);padding:0 2px`;
export const SPAN_MONO = `flex:1;font:400 10px ${MONO};color:var(--text-muted)`;
export const BODY_MONO = `font:400 11px/1.55 ${MONO};color:var(--text);overflow-wrap:anywhere`;
export const WARN_CAPS = `font:600 9px ${MONO};color:var(--warn-soft);letter-spacing:.07em`;
export const WARN_BODY = `font:400 11.5px/1.5 ${SANS};color:var(--text-soft);margin-top:3px`;
