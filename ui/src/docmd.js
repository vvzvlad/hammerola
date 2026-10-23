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
  a: 'color:var(--accent-text)',
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

function propsOf(token, base, key) {
  const props = { key };
  const style = [TAG_STYLE[token.tag], token.attrGet('style')].filter(Boolean).join(';');
  if (style) props.style = css(style);
  if (token.tag === 'a') {
    props.href = resolveHref(token.attrGet('href'), base);
    if (/^https?:/i.test(props.href || '')) {
      props.target = '_blank';
      props.rel = 'noopener noreferrer';
    }
  }
  if (token.tag === 'ol' && token.attrGet('start')) props.start = Number(token.attrGet('start'));
  if (token.attrGet('title')) props.title = token.attrGet('title');
  return props;
}

/** One token that opens and closes nothing, as what it puts on the page. */
function leaf(token, base, key) {
  switch (token.type) {
    case 'inline':
      return elements(token.children, base, `${key}.`);
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
function elements(tokens, base, prefix) {
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
        const props = propsOf(top.token, base, top.key);
        if ((top.token.tag === 'td' || top.token.tag === 'th')
            && shown(top.children).length <= SHORT_CELL) {
          props.className = NOWRAP_CLASS;
        }
        parent.children.push(React.createElement(top.token.tag, props, ...top.children));
      }
      return;
    }
    const drawn = leaf(token, base, key);
    if (Array.isArray(drawn)) top.children.push(...drawn);
    else if (drawn !== null) top.children.push(drawn);
  });
  return root.children;
}

/** The whole document, as an array of elements; `base` is the document's
 *  directory in the build (`docBase` in DocumentView.jsx). Short table cells
 *  carry `NOWRAP_CLASS`. */
export function markdownElements(text, base) {
  return elements(parser.parse(String(text || ''), {}), base, 'md');
}
