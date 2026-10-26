/**
 * The proposal's branch of the tree, the fields its rows are made of, and the
 * list of primitives the toolbar's `Add primitive` menu is drawn from.
 *
 * One section of the build page's `computed()`: a view model, not a component.
 * It is handed the page's state and a bag of the page's own doors, and answers
 * with the `proposal*` keys `render()` draws from.
 *
 * `deps`: half are the page's writers (`setProposal`, `typeProposal`, …),
 * methods of the component because they write its state and push its viewport;
 * the other half are locals `computed()` works out once for every section (the
 * tree, the eye sets, `compared`). Nothing here recomputes them, so no two
 * panels can disagree about whether a comparison is up. The tree icons come
 * from ui/src/panelstyle.js.
 */
import {
  INDEX_MONO, SLOT_22, SWATCH, eyeDot, eyeOuter, ghostIcon, skipIcon,
} from './panelstyle.js';
import {
  addNode, bodies, emptyProposal, firstFree, removeNode, updateNode,
} from './proposal.js';
import { MONO } from './style.jsx';
import { HOLDABLE, markMenu } from './longpress.js';

export function proposalView(s, deps) {
  const {
    // -- what `computed()` has already worked out
    tree, overlayPath, hiddenSet, ghostSet, selRow, compared,
    branchOpen, PROPOSAL_BRANCH, stop, menuAt,
    // -- the page's own doors
    node: nodeAt, nextSeq, set, setState, setVisibility, toggle,
    typeProposal, commitProposal, commitSnapStep, nudgeProposal, setProposal,
    toggleProposalEye, toggleMoveEye, removeProposal,
  } = deps;

  // `|| emptyProposal()`, like `openTabs`'s `|| []` in chromeview.js: tests in
  // ui/tests spell the state out by hand and may omit the field.
  const doc = s.proposal || emptyProposal();
  // The move nodes whose own eye is shut — page state, not the document's (see
  // `movesOff` in the page).
  const movesOff = new Set(s.movesOff || []);
  // How far one drag step goes on each node — page state too (see `snapSteps`
  // in the page), read for the field that sets it.
  const snapSteps = s.snapSteps || {};

  // Every dimension, placement and angle is a plain number (proposal.js). They
  // reach the kernel raw (`placed` in proposalgeom.js), where a non-number
  // becomes NaN and renders as nothing, silently. An empty field is a zero: the
  // body goes flat until the next digit lands.
  const num = (raw) => {
    const value = Number(String(raw).trim());
    return Number.isFinite(value) ? value : 0;
  };
  // A field the browser could not read is not an empty one. A number input
  // reports `""` with `badInput` set for unparseable text — measured in Chrome
  // 153, only a lone `-` or a lone `.` (`.5` reads `.5`, `12.` reads `12`).
  // Without this, a sign or point typed and abandoned would commit a zero.
  // `badInput` is `false` on a text input, so the name passes through.
  const unread = (target) => !!(target && target.validity && target.validity.badInput);
  const swap = (list, index, value) => list.map((v, i) => (i === index ? value : v));

  // How far one nudge goes (the browser's own spinner, keys and repeat). Sizes
  // and places step 1 mm; angles step 15°, so the common angles (90, 45) are a
  // few clicks away.
  const STEP_MM = 1;
  const STEP_DEG = 15;

  // One box for every field of these rows, the snap step's included.
  const fieldStyle = (width) => `width:${width};box-sizing:border-box;border:1px solid var(--line);border-radius:5px;outline:none;padding:3px 5px;font:400 11px ${MONO};color:var(--text);background:var(--card-bg)`;

  // One field of the panel: what it shows, and what typing in it does.
  // `commit` turns the raw text into the whole NEXT DOCUMENT, because that is
  // what `setProposal` takes. A `step` makes it a number field; the name passes
  // none.
  //
  // Typing touches only the draft; the document is written on `change` (blur,
  // Enter, or a spinner nudge), as JSCAD's parameter panel does. Each commit
  // costs a whole re-stage (`setProposal` builds the bodies and `restage`
  // renders the model again); the CSG alone measured 23 ms at four bodies and
  // 81 ms at twelve (@jscad/modeling 2.13.0, Apple M-series).
  const field = (key, value, commit, width, step) => ({
    key,
    // `number` brings the platform's spinner, up/down keys and repeat, sized by
    // `step`.
    type: step ? 'number' : 'text',
    step,
    // The draft while this is the field being typed in, the document
    // everywhere else. `typeProposal` says why both are needed.
    value: s.proposalDraft && s.proposalDraft.key === key
      ? s.proposalDraft.text
      : String(value === undefined || value === null ? '' : value),
    style: fieldStyle(width),
    onChange: (e) => typeProposal(key, e.target.value),
    onBlur: (e) => commitProposal(key, e.target.value, commit, unread(e.target)),
    // Enter commits too: a reader who presses Enter has finished with the field
    // whether or not the focus leaves.
    onKeyDown: (e) => {
      if (e.key === 'Enter') commitProposal(key, e.target.value, commit, unread(e.target));
    },
    // The wheel scrolls the column and does not edit the body. Over a focused
    // number input the wheel steps the value (Chrome and Firefox), and the
    // column is scrolled with the cursor still on a field. Blurring is the only
    // mechanism: React registers the root `wheel` listener as passive
    // (react-dom 18.3.1), so `preventDefault` would be ignored. The blur commits
    // any typed text, as any other blur does.
    onWheel: step ? (e) => e.target.blur() : undefined,
    // A nudge goes through `commitProposal` too, and needs a real `change`
    // listener: React's `onChange` is the DOM `input` event, and the `change`
    // fired after a spinner step is dropped by React's value tracker (measured
    // against react-dom 18.3.1).
    //
    // The node's `onchange` property, not `addEventListener`: the next render
    // replaces it instead of stacking a second listener. A `change` after a
    // blur finds no draft (the blur already committed) and does nothing.
    //
    // Through `nudgeProposal`, which handles a held arrow's run of events.
    ref: step ? (el) => {
      if (el) {
        el.onchange = (e) => nudgeProposal(
          key, e.target.value, commit, unread(e.target),
        );
      }
    } : undefined,
  });

  /**
   * How far one drag step of this row goes, in millimetres — the one field in
   * these rows that is not about the document.
   *
   * Not built with `field`: that one's `commit` returns the next document,
   * while this writes the page's own map (`commitSnapStep` in
   * HammerolaViewer.jsx). It shares the box, the wheel blur, the draft (keyed by
   * field key) and the `ref` (React drops the platform's `change`).
   *
   * Empty is the automatic step, said by `placeholder`.
   */
  const snapGroup = (node) => {
    const key = `${node.id}.step`;
    const held = snapSteps[node.id];
    // Not called `commit`, which in this file returns the next document.
    const settle = (e) => commitSnapStep(key, e.target.value, node.id,
                                         unread(e.target));
    return {
      key: 'snap',
      // The unit is in the label, as `turn°` and `rot°` carry theirs: this row
      // sits under one of them, and a bare `step` would read as degrees.
      label: 'step mm',
      fields: [{
        key,
        type: 'number',
        step: STEP_MM,
        min: 0,
        placeholder: 'auto',
        value: s.proposalDraft && s.proposalDraft.key === key
          ? s.proposalDraft.text
          : String(held === undefined || held === null ? '' : held),
        style: fieldStyle('31%'),
        onChange: (e) => typeProposal(key, e.target.value),
        onBlur: settle,
        onKeyDown: (e) => { if (e.key === 'Enter') settle(e); },
        onWheel: (e) => e.target.blur(),
        ref: (el) => { if (el) el.onchange = settle; },
      }],
    };
  };

  // How each op spells its own size, keyed like `DIMS` in proposal.js and
  // `SHAPES` in proposalgeom.js (the three sets are held equal by a test).
  const SIZES = {
    box: (node) => ({
      label: 'size',
      fields: [0, 1, 2].map((axis) => field(
        `${node.id}.size.${axis}`, node.size[axis],
        (raw) => updateNode(doc, node.id, { size: swap(node.size, axis, num(raw)) }),
        '31%', STEP_MM)),
    }),
    // Spelled out, not mapped over `['d', 'h']` with a computed key:
    // `test_every_handled_event_is_imported_from_events_js` reads `[x]:` in
    // HammerolaViewer.jsx as a handler key.
    cylinder: (node) => ({
      label: 'd · h',
      fields: [
        field(`${node.id}.d`, node.d,
              (raw) => updateNode(doc, node.id, { d: num(raw) }), '47%', STEP_MM),
        field(`${node.id}.h`, node.h,
              (raw) => updateNode(doc, node.id, { h: num(raw) }), '47%', STEP_MM),
      ],
    }),
    sphere: (node) => ({
      label: 'd',
      fields: [field(`${node.id}.d`, node.d,
                     (raw) => updateNode(doc, node.id, { d: num(raw) }),
                     '47%', STEP_MM)],
    }),
  };

  // What each op is when added: a visible body at the origin. A zero size
  // builds fine but draws nothing.
  const NEW_BODY = {
    box: { size: [20, 20, 20] },
    cylinder: { d: 10, h: 20 },
    sphere: { d: 20 },
  };

  // The first free name (`firstFree` in proposal.js). A body's name is its
  // part's `name` in the payload, so two bodies under one name would be one
  // entry in the library's groups map and one row in the tree. It holds for
  // typed names as well as minted ones.
  //
  // Among the bodies only (`bodies`): a move's name is a build row's, which the
  // reader never chose; counting it would rename the reader's own `plate`.
  const freeName = (wanted, exceptId) => {
    const taken = new Set(bodies(doc)
      .filter((node) => node.id !== exceptId)
      .map((node) => node.name));
    return firstFree(wanted, taken);
  };

  const addBody = (op) => () => {
    // The menu closes on the press, like the view switcher's rows (`viewTabs`
    // in chromeview.js) — first, so a throw below cannot leave it open.
    setState({ opsOpen: false });
    // The counter is the page's (`nextSeq` bumps `_proposalSeq`), so two nodes
    // are never minted under one id.
    const seq = nextSeq();
    setProposal(addNode(doc, {
      id: `n${seq}`,
      name: freeName(`${op}${seq}`),
      op,
      role: 'solid',
      at: [0, 0, 0],
      rot: [0, 0, 0],
      ...NEW_BODY[op],
    }));
  };
  // -- the proposal, as a small tree of its own below the parts --------------
  //
  // THE WHOLE DOCUMENT IS ROWS, bodies and moves together in document order —
  // one place to look at what the reader has said. The kernel's verdict stands
  // under the head (`proposalSays`); nodes are added only by the toolbar's
  // `Add primitive` menu.
  //
  // A branch of the interface, not of the scene: the library's `render()` takes
  // ONE root and `treeFromShapes` derives every id from where a part sits, so a
  // second root would repath the whole model — and paths are identities
  // (comments, move nodes, a swap's hidden state). A move exists in no scene
  // anyway. So this is assembled from `s.proposal`.

  const proposalRows = doc.nodes.map((node) => {
    const isMove = node.role === 'move';
    // Where this body stands in the scene, by name. `staged()` in
    // viewport/element.js re-roots each overlay part as `<group>/<part name>`,
    // and a part's name is the body's (`part()` in proposalgeom.js), so this is
    // the same spelling from the viewport's group path.
    //
    // Computed, not looked up: the tree lags every edit by a re-stage, so a row
    // taking its identity from the tree would lose it for that long — notably
    // on a rename, where `selectionAfter` has already moved the selection.
    const wanted = isMove || !overlayPath ? null : `${overlayPath}/${node.name}`;
    // The scene row this one answers for: for a body, the part the overlay
    // staged; for a move, the build row it displaces (`paths[0]` is that row's
    // id). Null where the tree cannot answer (nothing staged, a refused
    // document, a part gone from the build).
    const scene = isMove ? nodeAt(node.paths[0])
      : (wanted && tree.nodes.get(wanted)) || null;
    // What the row selects: the live scene path where there is one, so a row
    // click lights up the body (or the part a move displaces) exactly as a
    // click in the scene does. Otherwise the document's node id, so a row still
    // opens — the fields are how a refused document gets repaired.
    //
    // The node id while a comparison is up: comparison paths (`/cmp/<a>:<b>/…`)
    // name no revision's part, and `sel` outlives the comparison
    // (`leaveCompare` does not clear it), so `measAdd` would post it as a
    // comment's `partId`. A node id is recognisably not a path, which is what
    // `measAdd` checks. So `sel` is always either a live path or not a path.
    const path = compared || !scene ? node.id : scene.id;
    // The page's one selection, matched three ways for the same row:
    //
    //   * the document's id — nothing staged, a comparison up, or a refused
    //     document;
    //   * the path this body WANTS, which `selectionAfter` writes when a name is
    //     committed, a re-stage before the tree holds it (and forever on a
    //     refused document);
    //   * the row the selection resolves to, so a copy picked in the scene
    //     selects the row that collapsed it (a move's case).
    const selected = s.sel === node.id
      || (!!wanted && s.sel === wanted)
      || (!!scene && selRow === scene);
    // The ghost square and colour are the scene's, so they are a body's alone:
    // a move draws nothing, and the displaced part keeps its own row, square
    // and colour in the tree below. A move still needs `scene` — selecting it
    // shows which part it is about — and its eye comes from `movesOff`.
    //
    // Null for every row while a comparison is up: `sync` sends
    // `hidden: diffHidden(s.diffShow), ghost: []` then and ignores
    // `s.hidden`/`s.ghost` (which is why `menuItems` drops Isolate, Hide and
    // Translucent under `compared`), and the overlay path inside a comparison
    // (`/cmp/…/proposal`) exists in no build.
    const marks = isMove || compared ? null : scene;
    const leaves = marks ? marks.leaves : [];
    const visible = leaves.filter((id) => !hiddenSet.has(id)).length;
    // A move's eye is a different control with the same glyph: it takes that
    // one displacement off the model and keeps the node. Two states, not
    // three — it is a switch (see `toggleMoveEye`).
    const moveOff = isMove && movesOff.has(node.id);
    const eye = isMove ? (moveOff ? 'off' : 'on')
      : visible === 0 ? 'off' : visible === leaves.length ? 'on' : 'part';
    const ghosted = leaves.length > 0 && leaves.every((id) => ghostSet.has(id));
    return {
      key: node.id,
      move: isMove,
      name: node.name,
      // The left padding stands over the head's caret column (3 padding + 20
      // caret + 2 gap, as `proposalHeadStyle` spends before its eye), so each
      // row's eye, square, tick and name sit under the head's. Padding, not
      // margin, so the row's pill starts where the head's does; the row takes
      // no click of its own (`onContextMenu` only).
      rowStyle: HOLDABLE + 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 25px;margin:0 0 1px;border-radius:4px;background:'
        + (selected ? 'var(--accent-bg)' : 'var(--float-bg-soft)') + ';cursor:default',
      // Drawn as absent rather than left out on a row with nothing in the
      // scene: `visibility:hidden` keeps the width, so names line up, and a
      // hidden box gets no pointer events. A move row keeps the box (its eye is
      // live) and hides the ghost square; its swatch is already transparent.
      marksStyle: 'display:flex;align-items:center;flex:none'
        + (leaves.length || isMove ? '' : ';visibility:hidden'),
      eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
      ghostStyle: SLOT_22 + (isMove ? ';visibility:hidden' : ''),
      dotStyle: SWATCH + ((marks && marks.color) || 'transparent'),
      // What kind of statement this row is: `move`, in the spelling
      // `proposalText` prints (`move "bracket" by (…)`), since a move and a body
      // are opposite claims about the model. `null`, not `''`, on a body, so
      // tests reading the tree see nothing rather than an empty child.
      kind: isMove ? 'move' : null,
      kindStyle: INDEX_MONO,
      // Excluded from what is sent, and from nothing else. `!node.skip` is the
      // whole read, so a node without the field is not skipped.
      skipIcon: skipIcon(!!node.skip),
      skipTitle: node.skip ? 'held back from the text sent to the agent'
                           : 'leave this out of the text sent to the agent',
      onSkip: stop(() => setProposal(
        updateNode(doc, node.id, { skip: !node.skip }))),
      // Faint ink means "this row is not on the model" — a move whose eye is
      // shut as well as a body whose leaves are all hidden.
      nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:400 12px ' + MONO
        + ';color:' + ((leaves.length || isMove) && eye === 'off'
          ? 'var(--text-faint)' : 'var(--text)'),
      // The same two writers every parts-tree row uses: a swap in flight
      // carries these lists across by name. A move's eye writes no visibility
      // (see `toggleMoveEye`): hiding the build part is a different statement
      // from putting it back.
      onVis: isMove ? stop(() => toggleMoveEye(node.id))
        : stop(() => setVisibility({ hidden: toggle(s.hidden, leaves) })),
      onGhost: stop(() => setVisibility({ ghost: toggle(s.ghost, leaves) })),
      // The scene row's plain name where there is one: `measAdd` heads a
      // composer with `selName` and expects a bare name, while a move's name
      // carries the count (`pin ×3`). The fallback only reaches a selection
      // `measAdd` refuses to attach anyway.
      onSelect: stop(() => set({
        sel: path, selName: scene ? scene.name : node.name,
      })),
      // Delete: a body is removed; a move's removal sends the part home, offset
      // and turn together — the next push stops claiming the path and
      // `reconcileMoves` puts it back.
      onRemove: stop(() => setProposal(removeNode(doc, node.id))),
      removeTitle: isMove ? 'put it back where the build has it' : '',
      // The right-click menu the body's row would have in the parts tree
      // (Isolate, Hide others, Move), opened on `scene` so `menuItems` builds
      // the same menu as a right-click on the body.
      //
      // None on a move row: every item there is about the build part or would
      // mint a second node over paths this one already claims. None on a body
      // the scene cannot place: `menuItems` is `[]` for it and `menuStyle`
      // would open an empty box.
      //
      // Asked of `scene`, not `marks` (they differ only during a comparison);
      // `menuItems` already strips what does not apply under `compared`.
      onMenu: isMove || !scene ? null : stop((e) => {
        e.preventDefault();
        markMenu(e.nativeEvent);
        setState({ menu: { id: scene.id, ...menuAt(e.clientX, e.clientY) } });
      }),
      // The fields show under the selected row only, so the tree stays one line
      // per row. Built either way and hidden by style, because each field's
      // `ref` wires the browser's `change` (`field` above).
      fieldsStyle: 'display:' + (selected ? 'block' : 'none')
        + ';width:250px;box-sizing:border-box;margin:1px 0 5px 16px;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--float-bg)',
      // A move has no name field, op or role: its name is a build row's, and it
      // draws no geometry.
      nameField: isMove ? null : field(`${node.id}.name`, node.name, (raw) => {
        const wanted = raw.trim();
        return updateNode(doc, node.id,
                          { name: wanted ? freeName(wanted, node.id) : node.name });
      }, '38%'),
      op: isMove ? '' : node.op,
      role: isMove ? '' : node.role,
      roleStyle: `padding:2px 7px;border-radius:4px;cursor:pointer;font:600 9.5px ${MONO};letter-spacing:.05em;border:1px solid `
        + (node.role === 'hole'
          ? 'var(--danger-line);background:var(--danger-bg);color:var(--danger)'
          : 'var(--line);background:var(--chip-bg);color:var(--text-soft)'),
      onRole: stop(() => setProposal(updateNode(doc, node.id, {
        role: node.role === 'hole' ? 'solid' : 'hole',
      }))),
      // The same three-by-three fields: a move's `by` is an offset from the
      // build's pose, and `turn°` is the same three degrees a body's `rot°` is.
      // The snap step is last on both, since both are dragged.
      groups: isMove ? [
        {
          key: 'delta',
          label: 'by',
          fields: [0, 1, 2].map((axis) => field(
            `${node.id}.delta.${axis}`, node.delta[axis],
            (raw) => updateNode(doc, node.id,
                                { delta: swap(node.delta, axis, num(raw)) }),
            '31%', STEP_MM)),
        },
        {
          key: 'turn',
          label: 'turn°',
          fields: [0, 1, 2].map((axis) => field(
            `${node.id}.turn.${axis}`, node.turn[axis],
            (raw) => updateNode(doc, node.id,
                                { turn: swap(node.turn, axis, num(raw)) }),
            '31%', STEP_DEG)),
        },
        snapGroup(node),
      ] : [
        { key: 'dims', ...SIZES[node.op](node) },
        {
          key: 'at',
          label: 'at',
          fields: [0, 1, 2].map((axis) => field(
            `${node.id}.at.${axis}`, node.at[axis],
            (raw) => updateNode(doc, node.id, { at: swap(node.at, axis, num(raw)) }),
            '31%', STEP_MM)),
        },
        {
          key: 'rot',
          // Degrees, said on the row: the kernel takes radians and `placed`
          // converts. Stepped by `STEP_DEG`.
          label: 'rot°',
          fields: [0, 1, 2].map((axis) => field(
            `${node.id}.rot.${axis}`, node.rot[axis],
            (raw) => updateNode(doc, node.id, { rot: swap(node.rot, axis, num(raw)) }),
            '31%', STEP_DEG)),
        },
        snapGroup(node),
      ],
    };
  });

  // The master tick's state. Not `sendsNothing`, which is also true for an
  // empty document; the branch is not drawn then anyway, so this is about a
  // head with rows under it.
  const allSkipped = doc.nodes.length > 0 && doc.nodes.every((node) => node.skip);

  return {
      // -- the rows of the `Add primitive` menu ---------------------------------
      //
      // Read off `SIZES`, in its order, so no row adds a body whose numbers
      // nothing can show. The menu card itself is chrome (`proposalMenuStyle` in
      // chromeview.js), like the view switcher.
      proposalOps: Object.keys(SIZES).map((op) => ({
        key: op,
        // The op's own name, with nothing between it and the row.
        label: op,
        onClick: addBody(op),
      })),

      // -- the proposal's branch of the tree ----------------------------------
      //
      // Drawn whenever the document has nodes. The branch's own eye is the only
      // thing that takes the proposal off the model, so it has to stay on
      // screen to be pressed again.
      proposalTreeStyle: 'padding:1px 0 6px;flex-direction:column;align-items:flex-start;display:'
        + (doc.nodes.length ? 'flex' : 'none'),
      // The head of the branch, drawn like a depth-0 group of the parts tree
      // (height, caret, count on the right).
      proposalHeadStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px;border-radius:4px;background:var(--float-bg-soft);cursor:default',
      proposalCaretPath: branchOpen ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4',
      proposalCaretStyle: 'width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-soft);cursor:pointer',
      // Written into a copy, not a computed key, for the same reason as `SIZES`
      // above: `{ [PROPOSAL_BRANCH]: … }` would be read by
      // `test_every_handled_event_is_imported_from_events_js` as an event key.
      proposalToggle: stop(() => {
        const expanded = { ...s.expanded };
        expanded[PROPOSAL_BRANCH] = !branchOpen;
        setState({ expanded });
      }),
      // The branch's own eye: the whole proposal off the model, bodies unstaged
      // and every displaced part back (see `toggleProposalEye`, one boolean of
      // interface state). Two states, not three: it is a switch, and the
      // per-body eyes below say what each body is doing.
      proposalEyeOuter: eyeOuter(s.proposalOff ? 'off' : 'on'),
      proposalEyeDot: eyeDot(s.proposalOff ? 'off' : 'on'),
      proposalEyeClick: stop(() => toggleProposalEye()),
      // The row's three columns, spent by the head too: an eye, then an empty
      // ghost slot and an empty colour slot that keep their width, so the master
      // tick sits over the row ticks. The slots come from the rows' constants,
      // so a column that changes in a row changes in the head with it.
      proposalMarksStyle: 'display:flex;align-items:center;flex:none',
      proposalGhostStyle: `${SLOT_22};visibility:hidden`,
      proposalDotStyle: `${SWATCH}transparent`,
      // The master tick: every node held back, or every node let through. It
      // shows filled only when nothing is left to send, so pressing it twice
      // is a round trip.
      proposalSkipAll: stop(() => setProposal({
        ...doc,
        nodes: doc.nodes.map((node) => ({ ...node, skip: !allSkipped })),
      })),
      proposalSkipIcon: skipIcon(allSkipped),
      proposalSkipTitle: allSkipped ? 'send all of it again'
                                    : 'hold all of it back from the agent',
      proposalHeadName: PROPOSAL_BRANCH,
      proposalHeadNameStyle: `white-space:nowrap;padding-right:4px;font:600 12px ${MONO};color:var(--text)`,
      // Deletes the whole thing — the record on the hub and the document on the
      // page. It asks first; see `removeProposal`.
      proposalRemove: stop(() => removeProposal().catch((error) => {
        console.error('proposal', error);
      })),
      proposalRemoveTitle: 'delete the whole proposal, here and on the hub',
      // How many statements are in it, where a parts-tree group carries its
      // count.
      proposalCount: String(doc.nodes.length),
      proposalCountStyle: INDEX_MONO,
      // Emptied by the caret rather than hidden, like a collapsed parts-tree
      // group.
      proposalRows: branchOpen ? proposalRows : [],

      // The kernel's verdict on the document, under the head rather than among
      // the rows, so it stays visible when the caret folds the branch. It is the
      // only thing that says why a body stopped following the numbers: the
      // model does not blank while a document is refused (`stageProposal`).
      // The kernel refuses a NEGATIVE size; a zero builds and draws nothing.
      proposalSays: s.proposalError || '',
      // Flush with the head and rows, not indented like a row's field block:
      // the verdict is about the whole document.
      proposalSaysStyle: 'width:250px;box-sizing:border-box;margin:1px 0 5px;padding:7px 9px;'
        + `border:1px solid var(--danger-line);background:var(--danger-bg);border-radius:6px;font:400 10.5px/1.5 ${MONO};color:var(--danger);display:`
        + (s.proposalError ? 'block' : 'none'),
  };
}
