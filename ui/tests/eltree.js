// Reading what a component DREW, without a DOM.
//
// A function component returns its element tree, and a React element is a plain
// object: `type`, `props`, `key`. So what was actually put on the screen can be
// read straight off the return value of `render()` — no jsdom, no mounting, no
// act(). That is what makes assertions here about the SCREEN rather than about
// "something was returned", which is the distinction three separate findings in
// this directory turned on:
//
//   * `expect(render()).toBeTruthy()` passed on a page that drew tiles while its
//     tab said rows — every body returns an element;
//   * a view body that drew NO CARDS passed everything, because the check
//     recognised the grid CONTAINER, which a body emits whether or not it has
//     anything to put in it;
//   * `computed().slotTitle` was the whole of "the full digest is within
//     reach", so deleting `title={v.slotTitle}` from the render left 378 tests
//     green with the digest computed for nobody.
//
// ONE WALKER, THREE READINGS, and the sharing is the point rather than economy:
// three files were about to carry a seven-line recursion apiece, and three
// copies of a recursion drift — one handling arrays, one not; one descending
// into `children`, one stopping at the first hit. The lesson is the project's
// own (`src/metricsdiff.py`): a comparison worth making twice is worth moving
// to where both sides import it.

/**
 * Every non-nullish `take(element)` in the tree, depth first, in draw order.
 *
 * `take` returns `undefined` for an element it is not interested in, which is
 * why it may also return a falsy value that MATTERS — `0`, `''` — without it
 * being dropped.
 */
export function collect(node, take, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, take, out))
    return out
  }
  if (node.props) {
    const got = take(node)
    if (got !== undefined && got !== null) out.push(got)
    collect(node.props.children, take, out)
  }
  return out
}

/** Every `style` object, which is how the two view bodies are told apart. */
export const styles = (node) => collect(node, (el) => el.props.style)

/**
 * Every `<a>` element, which is how a list is told from an EMPTY list.
 *
 * The elements themselves rather than their hrefs, because the caller wants
 * `key` too: it is the row's `pid`, so the sequence of keys says both how many
 * rows were drawn and in what order.
 */
export const links = (node) => collect(node, (el) => (el.type === 'a' ? el : undefined))

/** Every `title` prop — a value the page shows only to somebody who hovers. */
export const titles = (node) => collect(node, (el) => el.props.title)
