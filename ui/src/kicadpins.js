// A schematic's placed symbols, given the pin entries the KiCad viewer draws
// pins from.
//
// The vendored viewer (static/_v/ecad-viewer.js, KiCanvas's model) draws a
// placed symbol's pins only from its own `(pin "N" (uuid ...))` entries, and
// finds each one's graphics in the library symbol by number. KiCad writes those
// entries, and also draws a symbol without them; other tools (konnect) leave
// them out, and the viewer then draws the body alone with every wire stopping
// a pin's length short of it. So before a schematic is handed to the viewer,
// each placed symbol with no entry at all gets one per pin of its library
// symbol in the sheet's `lib_symbols`: the pins of every unit, in body style 0
// or the symbol's own (`body_style`, older `convert`, else 1). Which unit is
// drawn is the viewer's to decide when it paints, per placement — a sheet used
// twice can show a different unit of one symbol — and it drops the entries of
// the others; the style is what `pin_by_number` resolves from, and it throws on
// a number found only in another style.
//
// Text in, text out, and only ever inserted into: a symbol that has entries,
// a symbol whose library symbol is missing, and any text that does not parse
// come back byte for byte, and nothing is thrown.

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

function numberOf(node, name, fallback) {
  const found = Number(valueOf(children(node, name)[0]));
  return Number.isInteger(found) ? found : fallback;
}

/** The numbers of the pins of every unit the viewer resolves in `style`, once each. */
function pinNumbers(definition, style) {
  const numbers = [];
  const take = (symbol) => {
    for (const pin of children(symbol, 'pin')) {
      const number = valueOf(children(pin, 'number')[0]);
      if (number !== undefined) numbers.push(number);
    }
  };
  take(definition);
  for (const part of children(definition, 'symbol')) {
    const match = /_\d+_(\d+)$/.exec(valueOf(part) || '');
    if (!match) continue;
    const partStyle = Number(match[1]);
    if (partStyle === 0 || partStyle === style) take(part);
  }
  return [...new Set(numbers)];
}

const quoted = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A UUID derived from `seed` (a symbol's uuid and a pin number), so the same
 * schematic always gets the same entries: four FNV-1a hashes, with the version
 * (8, custom) and variant bits set.
 */
export function pinUuid(seed) {
  let hex = '';
  for (let round = 0; round < 4; round += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(round + 1, 0x9e3779b1)) >>> 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, '0');
  }
  const variant = (8 | (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function withPinEntries(text) {
  const root = parseSexpr(text);
  if (head(root) !== 'kicad_sch') return text;
  const library = new Map();
  for (const section of children(root, 'lib_symbols')) {
    for (const symbol of children(section, 'symbol')) library.set(valueOf(symbol), symbol);
  }
  const inserts = [];
  for (const placed of children(root, 'symbol')) {
    const libId = valueOf(children(placed, 'lib_id')[0]);
    const definition = library.get(libId);
    if (!definition || children(placed, 'pin').length) continue;
    const style = numberOf(placed, 'body_style', numberOf(placed, 'convert', 1));
    const numbers = pinNumbers(definition, style);
    if (!numbers.length) continue;
    const owner = valueOf(children(placed, 'uuid')[0]) || `${libId}@${placed.start}`;
    const entry = (number) => `(pin ${quoted(number)} (uuid "${pinUuid(`${owner}/${number}`)}"))`;
    // Before `(instances`, where KiCad writes them, on lines of their own;
    // without one, before the symbol's closing parenthesis.
    const instances = children(placed, 'instances')[0];
    if (instances) {
      const lineStart = text.lastIndexOf('\n', instances.start) + 1;
      const indent = text.slice(lineStart, instances.start);
      const separator = /^[ \t]*$/.test(indent) ? `\n${indent}` : ' ';
      inserts.push({ at: instances.start, block: numbers.map((n) => entry(n) + separator).join('') });
    } else {
      inserts.push({ at: placed.end - 1, block: numbers.map((n) => ` ${entry(n)}`).join('') });
    }
  }
  if (!inserts.length) return text;
  let out = text;
  for (const { at, block } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + block + out.slice(at);
  }
  return out;
}

/** `text`, a `.kicad_sch`, with pin entries for every placed symbol that has none. */
export function addPinEntries(text) {
  if (typeof text !== 'string') return text;
  try {
    return withPinEntries(text);
  } catch {
    return text;
  }
}
