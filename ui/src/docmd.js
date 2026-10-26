// A markdown document of a build, as React elements.
//
// markdown-it parses; this file turns its token stream into elements rather
// than rendering it to an HTML string, because nothing in this interface writes
// markup from a string (tests/test_ui_source.py, `test_nothing_writes_markup`).
// `html: false` makes raw HTML in the source arrive as text, and React escapes
// every string, so a document cannot put an element on the page that is not a
// markdown construct.
//
// A relative link or picture points INTO THE SAME BUILD: it is resolved against
// the document's own directory in the build (`docBase` in DocumentView.jsx), since
// a document keeps its path in the tree. Absolute addresses, `/…`, `#…` and
// anything with a scheme are left as written. A link to `http:` or `https:`
// opens in a new tab, `noopener`, so the reader keeps the document.
//
// A link that lands on ANOTHER DOCUMENT of the build opens that document on the
// page, as its row in the list of views does, rather than the raw file. Which
// address is a document is the holder's knowledge, so it hands in `links`
// (`docLinks` in DocumentView.jsx): given a resolved href, the props the link
// takes instead, or null.

import MarkdownIt from 'markdown-it';
import React from 'react';

import { css, MONO } from './style.jsx';

const parser = new MarkdownIt({ html: false });

/** The class of a table cell short enough to keep on one line; styled by
 *  DocumentView.jsx. */
export const NOWRAP_CLASS = 'md-nowrap';

// How long a cell's text may be and still read as one value (`495.0 × 428.5`,
// `1 620 ₽`): such a cell does not break, and a longer one wraps as prose.
const SHORT_CELL = 24;

// What the browser's defaults leave unreadable or out of the palette. Every
// colour is a role in static/_v/tokens.css.
const TAG_STYLE = {
  // A bare address has nowhere to break and in a table widens its column past
  // the page; `anywhere` (not `break-word`) also lets the cell shrink to fit.
  a: 'color:var(--accent-text);overflow-wrap:anywhere',
  code: `font-family:${MONO};font-size:.92em;background:var(--sunken-bg);border-radius:3px;padding:1px 4px`,
  pre: `font-family:${MONO};font-size:13px;background:var(--sunken-bg);border:1px solid var(--line-soft);border-radius:6px;padding:10px 12px;overflow:auto`,
  blockquote: 'margin:0 0 1em;padding:0 14px;border-left:3px solid var(--line-strong);color:var(--text-soft)',
  table: 'border-collapse:collapse;margin:0 0 1em',
  th: 'border:1px solid var(--line);padding:4px 10px;background:var(--sunken-bg)',
  td: 'border:1px solid var(--line);padding:4px 10px',
  // A drawing is often black lines on nothing, which the dark page would hide.
  img: 'max-width:100%;background:var(--paper-bg)',
  hr: 'border:0;border-top:1px solid var(--line);margin:1.5em 0',
};

/** `href` as the page should follow it: relative means "in this build". */
export function resolveHref(href, base) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || /^[/#]/.test(href)) return href;
  const origin = window.location.origin;
  const url = new URL(href, origin + base);
  return url.origin === origin ? url.pathname + url.search + url.hash : href;
}

/** The text a list of drawn nodes puts on the page. */
function shown(nodes) {
  return (Array.isArray(nodes) ? nodes : [nodes]).map((node) => {
    if (typeof node === 'string') return node;
    return node && node.props ? shown(node.props.children || []) : '';
  }).join('');
}

/** The text of an inline run, as an image's `alt` takes it. */
function plain(tokens) {
  return (tokens || []).map((token) => (
    token.type === 'image' ? plain(token.children) : token.content || '')).join('');
}

function propsOf(token, base, key, links) {
  const props = { key };
  const style = [TAG_STYLE[token.tag], token.attrGet('style')].filter(Boolean).join(';');
  if (style) props.style = css(style);
  if (token.tag === 'a') {
    props.href = resolveHref(token.attrGet('href'), base);
    const doc = links && props.href ? links(props.href) : null;
    if (doc) Object.assign(props, doc);
    else if (/^https?:/i.test(props.href || '')) {
      props.target = '_blank';
      props.rel = 'noopener noreferrer';
    }
  }
  if (token.tag === 'ol' && token.attrGet('start')) props.start = Number(token.attrGet('start'));
  if (token.attrGet('title')) props.title = token.attrGet('title');
  return props;
}

/** One token that opens and closes nothing, as what it puts on the page. */
function leaf(token, base, key, links) {
  switch (token.type) {
    case 'inline':
      return elements(token.children, base, `${key}.`, links);
    case 'softbreak':
      return '\n';
    case 'hardbreak':
      return React.createElement('br', { key });
    case 'code_inline':
      return React.createElement('code', { key, style: css(TAG_STYLE.code) }, token.content);
    case 'code_block':
    case 'fence':
      return React.createElement('pre', { key, style: css(TAG_STYLE.pre) },
        React.createElement('code', null, token.content));
    case 'hr':
      return React.createElement('hr', { key, style: css(TAG_STYLE.hr) });
    case 'image':
      return React.createElement('img', {
        ...propsOf(token, base, key),
        src: resolveHref(token.attrGet('src'), base),
        alt: plain(token.children),
      });
    default:
      // `text` and `text_special`, and raw HTML, which `html: false` has
      // already turned into text: React escapes it.
      return token.content || null;
  }
}

/**
 * A token stream as elements, nesting by each token's `nesting`.
 *
 * A HIDDEN pair (the paragraph inside a tight list item) opens no element:
 * markdown-it's own renderer drops the tags and keeps what is between them.
 */
function elements(tokens, base, prefix, links) {
  const root = { children: [] };
  const stack = [root];
  (tokens || []).forEach((token, index) => {
    const key = `${prefix}${index}`;
    if (token.nesting === 1) {
      stack.push({ token, key, children: [] });
      return;
    }
    const top = stack[stack.length - 1];
    if (token.nesting === -1 && top !== root) {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (top.token.hidden) parent.children.push(...top.children);
      else {
        const props = propsOf(top.token, base, top.key, links);
        if ((top.token.tag === 'td' || top.token.tag === 'th')
            && shown(top.children).length <= SHORT_CELL) {
          props.className = NOWRAP_CLASS;
        }
        parent.children.push(React.createElement(top.token.tag, props, ...top.children));
      }
      return;
    }
    const drawn = leaf(token, base, key, links);
    if (Array.isArray(drawn)) top.children.push(...drawn);
    else if (drawn !== null) top.children.push(drawn);
  });
  return root.children;
}

/** The whole document, as an array of elements; `base` is the document's
 *  directory in the build (`docBase` in DocumentView.jsx), `links` the lookup
 *  that turns a link to another document into one that opens it (optional).
 *  Short table cells carry `NOWRAP_CLASS`. */
export function markdownElements(text, base, links) {
  return elements(parser.parse(String(text || ''), {}), base, 'md', links || null);
}

// -- a comment's quote ---------------------------------------------------------
//
// A comment on a markdown document hangs on a passage of it as the page draws
// it (SPEC 7A.1, `quote`): the text selected and up to `QUOTE_CONTEXT`
// characters on either side. The text is the drawn one — every text node of
// the article in order, a `<style>` left out — because that is what a
// selection selects; the source's markdown is not on the page. Found again
// by its text, and among several of them by the one whose sides agree most
// with what was around it.

/** How many characters of the drawn text on either side a quote carries. */
export const QUOTE_CONTEXT = 30;

/** The drawn text under `root`, `{ text, nodes }`: each text node with the
 *  offset it starts at, in document order. */
export function textIndex(root) {
  const nodes = [];
  let text = '';
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentNode && node.parentNode.localName === 'style') continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

/** The offset in `index` of the boundary point (`container`, `offset`) of a
 *  selection: within a text node, or before the first text node at or after
 *  a point between elements. */
export function offsetOf(index, container, offset) {
  const at = index.nodes.find(({ node }) => node === container);
  if (at) return at.start + offset;
  const point = container.ownerDocument.createRange();
  point.setStart(container, offset);
  const next = index.nodes.find(({ node }) => point.comparePoint(node, 0) >= 0);
  return next ? next.start : index.text.length;
}

/** The DOM range of `[start, end)` in `index`. The start is in the node that
 *  holds its first character and the end in the node that holds its last, so
 *  a passage starting a node does not begin at the end of the node before it. */
export function rangeOf(index, start, end) {
  const range = index.nodes[0].node.ownerDocument.createRange();
  const at = (offset, after) => {
    const one = index.nodes.find(({ node, start: from }) => (after
      ? offset > from && offset <= from + node.data.length
      : offset >= from && offset < from + node.data.length));
    return [one.node, offset - one.start];
  };
  range.setStart(...at(start, false));
  range.setEnd(...at(end, true));
  return range;
}

/** The quote of `[start, end)` of `text`, `{ text, before, after }`, its
 *  blanks at either end moved out into the sides, so that the highlight and
 *  the rail's line do not start or end on a blank (the hub keeps all three as
 *  sent); null for nothing but blanks, which the hub refuses as empty. */
export function quoteOf(text, start, end) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from])) from += 1;
  while (to > from && /\s/.test(text[to - 1])) to -= 1;
  if (from === to) return null;
  return {
    text: text.slice(from, to),
    before: text.slice(Math.max(0, from - QUOTE_CONTEXT), from),
    after: text.slice(to, to + QUOTE_CONTEXT),
  };
}

/** `[start, end)` of `quote` in `text`, or null where its text is nowhere:
 *  of the places it is, the one whose characters before and after agree with
 *  the quote's sides for longest, the first of equals. */
export function findQuote(text, quote) {
  const agree = (a, b, backward) => {
    let n = 0;
    while (n < a.length && n < b.length
      && (backward ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n += 1;
    return n;
  };
  let best = null;
  for (let at = text.indexOf(quote.text); at >= 0 && quote.text; at = text.indexOf(quote.text, at + 1)) {
    const end = at + quote.text.length;
    const score = agree(text.slice(Math.max(0, at - QUOTE_CONTEXT), at), quote.before || '', true)
      + agree(text.slice(end, end + QUOTE_CONTEXT), quote.after || '', false);
    if (!best || score > best.score) best = { at, end, score };
  }
  return best && [best.at, best.end];
}
