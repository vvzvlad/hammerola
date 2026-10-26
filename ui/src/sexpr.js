// The reader of KiCad's s-expressions that the texts of a design are read
// with: by kicadnets.js for the nets its sheets name, by kicadsheets.js for the
// datasheet of each part.

const OPEN = 40;
const CLOSE = 41;
const QUOTE = 34;
const BACKSLASH = 92;

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 13 || code === 0xfeff;

/**
 * The one list `text` holds, as `{ list, start, end }` with atoms as
 * `{ atom, start, end }` (a quoted atom unescaped). Throws on anything but
 * exactly one balanced list.
 */
export function parseSexpr(text) {
  const stack = [{ list: [] }];
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (isSpace(code)) {
      i += 1;
    } else if (code === OPEN) {
      stack.push({ list: [], start: i });
      i += 1;
    } else if (code === CLOSE) {
      if (stack.length < 2) throw new Error(`unbalanced ")" at ${i}`);
      const node = stack.pop();
      node.end = i + 1;
      stack[stack.length - 1].list.push(node);
      i += 1;
    } else if (code === QUOTE) {
      let value = '';
      let j = i + 1;
      while (j < text.length && text.charCodeAt(j) !== QUOTE) {
        if (text.charCodeAt(j) === BACKSLASH) j += 1;
        value += text[j];
        j += 1;
      }
      if (j >= text.length) throw new Error(`unterminated string at ${i}`);
      stack[stack.length - 1].list.push({ atom: value, start: i, end: j + 1 });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length) {
        const next = text.charCodeAt(j);
        if (isSpace(next) || next === OPEN || next === CLOSE || next === QUOTE) break;
        j += 1;
      }
      stack[stack.length - 1].list.push({ atom: text.slice(i, j), start: i, end: j });
      i = j;
    }
  }
  const top = stack[0].list;
  if (stack.length !== 1 || top.length !== 1 || !top[0].list) throw new Error('not one list');
  return top[0];
}

/** The name a list starts with: `kicad_sch` of `(kicad_sch …)`. */
export const head = (node) => node.list[0] && node.list[0].atom;
/** The lists directly inside `node` that start with `name`. */
export const children = (node, name) => node.list.slice(1).filter((child) => child.list && head(child) === name);
/** The atom after a list's name: `"R1"` of `(reference "R1")`. */
export const valueOf = (node) => (node && node.list[1] ? node.list[1].atom : undefined);
