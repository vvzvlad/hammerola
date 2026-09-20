/**
 * The proposal's branch of the tree, the fields its rows are made of, and the
 * list of primitives the toolbar's `Add primitive` menu is drawn from.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE. It is a view
 * model and not a component: it is handed the page's state and a bag of the
 * page's own doors, and it answers with the `proposal*` keys `render()` draws
 * from — the same keys, with the same values, this code returned while it was a
 * block inside that method (issue #103).
 *
 * WHAT `deps` IS, and why the list is as long as it is. Half of it is the
 * page's own writers — `setProposal`, `typeProposal` and the
 * rest — which are methods of the component because what they write is its
 * state and what they push is its viewport. The other half is the handful of
 * locals `computed()` works out once for every section that needs them: the
 * tree and the sets the eyes are drawn from, and `compared`, the answer every
 * panel on the page asks about. Nothing here is recomputed,
 * deliberately — a second answer to "is a comparison up" is two panels free to
 * disagree about it. The controls the parts tree and this branch draw the SAME
 * icons with are imported from ui/src/panelstyle.js by both.
 */
import {
  INDEX_MONO, SLOT_22, SWATCH, eyeDot, eyeOuter, ghostIcon, skipIcon,
} from './panelstyle.js';
import {
  addNode, bodies, emptyProposal, firstFree, removeNode, updateNode,
} from './proposal.js';
import { MONO } from './style.jsx';

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

  // `|| emptyProposal()` for the reason `openTabs` in chromeview.js carries its
  // `|| []`: every test file in ui/tests spells the state out by hand, and a
  // field added here would otherwise take down the ones written before it
  // existed, at `.nodes.length`.
  const doc = s.proposal || emptyProposal();
  // THE MOVE NODES WHOSE OWN EYE IS SHUT, which is page state and not the
  // document's — `movesOff` in the page carries the argument. Read into a set
  // once rather than per row, and `|| []` for the reason `doc` above has its
  // fallback.
  const movesOff = new Set(s.movesOff || []);
  // HOW FAR ONE STEP OF A DRAG GOES ON EACH NODE, which is page state too —
  // `snapSteps` in the page carries the argument — and read here for the field
  // that sets it. `|| {}` for the reason `doc` above has its fallback.
  const snapSteps = s.snapSteps || {};

  // EVERY DIMENSION AND EVERY PLACEMENT IS A NUMBER and nothing else — the
  // whole of the language `proposal.js` defines, with no expression syntax and
  // deliberately none coming. So this is the entire parser, and it is the same
  // one for a size, a place and an angle: they all reach the kernel raw
  // (proposalgeom.js, `placed`), where anything that is not a number arrives in
  // an arithmetic and comes out as NaN — geometry that renders as nothing,
  // with nothing said about it.
  //
  // AN EMPTY FIELD IS A ZERO, and what that decides is what the reader is
  // shown while they are mid-edit: a zero builds, so the body goes flat until
  // the next digit lands, which is visibly about the field they are typing in.
  const num = (raw) => {
    const value = Number(String(raw).trim());
    return Number.isFinite(value) ? value : 0;
  };
  // AND A FIELD THE BROWSER COULD NOT READ IS NOT AN EMPTY ONE. A number input
  // reports `""` for text it cannot parse, and `num` answers 0 for that, so a
  // field in that state committed a zero and flattened the body.
  //
  // WHICH TEXT actually reaches it was measured rather than reasoned about —
  // Chrome 153, a real `<input type="number">`, one keystroke at a time,
  // reading `value` on every `input` event. A lone `-` and a lone `.` do:
  // `""` with `badInput` set. NOTHING ELSE DOES — `.5` reads back as `.5`, and
  // a trailing dot is dropped rather than emptying the field, so `12.` reads
  // back as `12`. So the case this is here for is a sign or a point typed as
  // the first character of a number and then abandoned, the focus leaving on a
  // click elsewhere: without this, a dimension the reader never finished
  // typing goes to zero and the body goes flat.
  //
  // `badInput` is the platform's own answer to "there is text in here and I
  // could not read it", and it is the only thing that tells that apart from
  // the genuinely empty field the rule above is about. It is `false` on a text
  // input, so the name passes through it unchanged.
  const unread = (target) => !!(target && target.validity && target.validity.badInput);
  const swap = (list, index, value) => list.map((v, i) => (i === index ? value : v));

  // HOW FAR ONE NUDGE OF A NUMBER GOES. Every number of a body is an
  // `<input type="number">` with a step, so the arrows, the up/down keys and
  // the press-and-hold repeat are all the browser's own and none of them is
  // drawn here. TWO ANSWERS BECAUSE THERE ARE TWO KINDS OF NUMBER: a size and
  // a place are read in millimetres, where one is the unit somebody means by
  // "a bit bigger", while a turn is read in degrees, where the angles a body
  // is actually set to are the corners — a quarter turn, 45 at a diagonal —
  // and a degree a click would be two dozen clicks to reach any of them.
  const STEP_MM = 1;
  const STEP_DEG = 15;

  // ONE BOX FOR EVERY FIELD OF THESE ROWS, the snap step's included: two
  // spellings would be two kinds of input standing in one column, and the
  // difference would read as a difference in what they take.
  const fieldStyle = (width) => `width:${width};box-sizing:border-box;border:1px solid var(--line);border-radius:5px;outline:none;padding:3px 5px;font:400 11px ${MONO};color:var(--text);background:var(--card-bg)`;

  // One field of the panel: what it shows, and what typing in it does.
  // `commit` turns the raw text into the whole NEXT DOCUMENT, because that is
  // what `setProposal` takes — there is no partial write anywhere in here.
  // A `step` makes it one of the NUMBER fields; the name is text and passes
  // none.
  //
  // TYPING TOUCHES THE DRAFT AND NOTHING ELSE; the document is written on
  // `change` — a blur, an Enter, or a nudge of the arrows — which is the
  // browser's own event for "this field's value is settled" and what JSCAD's
  // parameter panel commits on. Per KEYSTROKE, which is what this used to be,
  // every character cost a whole scene: `setProposal` builds the bodies, hands
  // them to the viewport, and `restage` tears the model down and renders it
  // again with the tree going back up to React behind it. The CSG ALONE,
  // measured on this repository's own kernel (@jscad/modeling 2.13.0, vitest,
  // Apple M-series, mixed ops with every fifth body a hole): 0.3 ms at one
  // body, 23 ms at four, 81 ms at twelve — before any of the rest of it.
  // `-12.5` is five of those on the way to one number.
  const field = (key, value, commit, width, step) => ({
    key,
    // `number` IS WHAT BRINGS THE ARROWS, and it is the only thing that does:
    // the spinner, the up/down keys and the repeat on a held key are the
    // platform's, sized by `step`.
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
    // ENTER IS THE OTHER HALF OF `change`, and it is here rather than left to
    // the blur because a reader who types a number and presses Enter has
    // finished with that field whether or not they move off it — a panel that
    // answered nothing until the focus left would read as one that had
    // stopped listening.
    onKeyDown: (e) => {
      if (e.key === 'Enter') commitProposal(key, e.target.value, commit, unread(e.target));
    },
    // THE WHEEL SCROLLS THE COLUMN AND DOES NOT EDIT THE BODY. Over a FOCUSED
    // number input the wheel is a step of the value in both Chrome and
    // Firefox — `input`, `change` and all — and the column these rows open in
    // is scrolled through: the ordinary way to reach the body below the
    // one just typed in is a wheel click with the cursor still standing on its
    // size field. That was ±1 mm per click of the wheel, ±15° in a `rot` row,
    // on a body nobody meant to touch; a text field had no such road.
    //
    // DROPPING THE FOCUS IS THE ONLY MECHANISM THERE IS, and it is enough: the
    // platform steps only a field that HAS the focus, and taking it away
    // leaves the scrolling untouched. Not `preventDefault` — React registers
    // the root's `wheel` listener as PASSIVE (react-dom 18.3.1), so a
    // `preventDefault` from here is ignored outright and would stop neither
    // the step nor the scroll. ON THE FIELD and not on the sheet, because a
    // wheel over anything else in here was never an edit. The blur it causes
    // is the ordinary one: a number typed and not yet committed commits,
    // exactly as it would have when the focus left any other way.
    onWheel: step ? (e) => e.target.blur() : undefined,
    // A NUDGE TAKES THE SAME ROAD AS A TYPED NUMBER — `commitProposal` — AND IT
    // NEEDS A REAL `change` LISTENER TO GET THERE. React's `onChange` is the
    // DOM's `input` event, which is the keystroke and lands in the draft; the
    // `change` the platform fires after a step of the spinner arrives at the
    // same handler and is then DROPPED by React's own value tracker, which
    // sees a value it has already reported. Measured against react-dom 18.3.1
    // rather than assumed. Wired to `onChange` alone, a nudge would move the
    // number in the field and leave the body on the model where it was.
    //
    // THE NODE'S OWN `onchange` PROPERTY and not `addEventListener`: a
    // property is replaced by the next render rather than stacked on top of
    // the last one, so there is nothing to remove and no way to end up
    // committing twice. A blur after typing fires `change` too, and what that
    // schedules wakes up behind the blur above, which has already committed the
    // same text: it finds no draft and does nothing.
    //
    // THROUGH `nudgeProposal` and not straight into `commitProposal`, because
    // an arrow held down is a run of `change` events and not one; that method
    // says what happens to the run.
    ref: step ? (el) => {
      if (el) {
        el.onchange = (e) => nudgeProposal(
          key, e.target.value, commit, unread(e.target),
        );
      }
    } : undefined,
  });

  /**
   * HOW FAR ONE STEP OF A DRAG OF THIS ROW GOES, in millimetres — the one field
   * in these rows that is not about the document.
   *
   * A MAKER OF ITS OWN BESIDE `field` AND NOT A CALL OF IT. That one's `commit`
   * is contracted to hand back the whole next DOCUMENT and everything else in
   * the rows is built on it; this writes the page's own map instead
   * (`commitSnapStep` in HammerolaViewer.jsx). Shared with it: the box, the
   * wheel blur, the draft — keyed by field key, so it knows nothing about
   * documents — and the `ref`, without which a step of the spinner moves the
   * number and sets nothing (React drops the platform's `change`).
   *
   * EMPTY IS THE AUTOMATIC STEP and `placeholder` is where the row says so —
   * an empty number field is the state every row starts in, so it cannot read
   * as a zero.
   */
  const snapGroup = (node) => {
    const key = `${node.id}.step`;
    const held = snapSteps[node.id];
    // NAMED FOR WHAT IT DOES AND NOT `commit`, which in this file means the
    // function that hands back the next document.
    const settle = (e) => commitSnapStep(key, e.target.value, node.id,
                                         unread(e.target));
    return {
      key: 'snap',
      // THE UNIT IS IN THE LABEL, as `turn°` and `rot°` carry theirs. This row
      // stands directly under one of those two, and the rings a reader has just
      // been turning snap in whole degrees — so a bare `step` reads as the step
      // of a turn.
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

  // HOW EACH OP SPELLS ITS OWN SIZE, keyed the way `DIMS` in proposal.js and
  // `SHAPES` in proposalgeom.js are keyed — so an op that grows a dimension is
  // changed in three tables and nowhere else, and an op in only two of them
  // throws where it is looked up instead of drawing half a body.
  const SIZES = {
    box: (node) => ({
      label: 'size',
      fields: [0, 1, 2].map((axis) => field(
        `${node.id}.size.${axis}`, node.size[axis],
        (raw) => updateNode(doc, node.id, { size: swap(node.size, axis, num(raw)) }),
        '31%', STEP_MM)),
    }),
    // SPELLED OUT AND NOT MAPPED OVER `['d', 'h']`, which is the shorter way
    // and reaches for a computed key. `test_every_handled_event_is_imported_
    // from_events_js` reads `[x]:` out of HammerolaViewer.jsx as a handler key, and the
    // saving is two lines.
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

  // WHAT EACH OP IS THE MOMENT IT IS ADDED: a body big enough to see, at the
  // origin. Sizes rather than zeroes, because a zero builds perfectly well and
  // draws nothing — so a button that added one would read as a button that did
  // nothing at all.
  const NEW_BODY = {
    box: { size: [20, 20, 20] },
    cylinder: { d: 10, h: 20 },
    sphere: { d: 20 },
  };

  // THE FIRST FREE NAME, and for a harder reason than tidiness. A body's name
  // is its part's `name` in the payload and every body is drawn as a part of
  // its own — so two bodies under one name are one entry in the library's
  // groups map and one row in the tree, the second quietly standing in for the
  // first. This has to hold for a name the reader TYPES and not only for one
  // the + button mints: naming a body after the thing it stands for —
  // `motor`, `wall` — is most of what the panel is for.
  //
  // THE LOOP ITSELF IS `firstFree` IN proposal.js, beside the document it is a
  // fact about rather than here: what a name is when something already answers
  // to it is settled once, for a name the + button mints and for one the
  // reader types.
  //
  // AMONG THE BODIES AND NOT AMONG THE NODES (`bodies`), because a move node
  // carries a name too and it is a ROW OF THE BUILD's — `plate`, which the
  // reader never chose and cannot edit. Counted as taken, a part dragged in
  // the scene would rename the reader's own `plate` to `plate2` under their
  // hands, and the two names collide over nothing: one is a part in the
  // payload this panel builds, the other names a part in the model.
  const freeName = (wanted, exceptId) => {
    const taken = new Set(bodies(doc)
      .filter((node) => node.id !== exceptId)
      .map((node) => node.name));
    return firstFree(wanted, taken);
  };

  const addBody = (op) => () => {
    // THE MENU TAKES ITSELF DOWN ON THE PRESS, the way the view switcher's rows
    // do (`viewTabs` in chromeview.js): a menu left standing open on the row
    // just pressed is a control that ignored you. First, so that the write below
    // cannot leave it open if anything in it throws.
    setState({ opsOpen: false });
    // THE COUNTER IS THE PAGE'S AND NOT THIS MODULE'S, which is what keeps two
    // nodes from being minted under one id: `nextSeq` bumps the component's own
    // `_proposalSeq` and hands back what it now stands at. This menu is the
    // only door left that mints one — the row menu had a second until the
    // manipulator took that job.
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
  // THE WHOLE DOCUMENT IS ROWS AND THERE IS NO SECOND LIST. Every node gets
  // one — bodies and moves together, in the order the document holds them —
  // because they are the same kind of statement and the reader should have one
  // place to look at what they have said. What the kernel makes of it stands
  // under the head of the branch (`proposalSays`); what ADDS a node is the
  // toolbar's `Add primitive` menu, and nothing else is anywhere else.
  //
  // A BRANCH OF THE INTERFACE AND NOT OF THE SCENE, which is what makes it
  // possible at all. `render()` in the library takes ONE root shape object and
  // `treeFromShapes` derives every id from where a part SITS, so a second root
  // would repath every part of the model from `/<root>/…` — and paths are
  // identities here: comments anchor to them, move nodes name them, a swap
  // carries hidden state keyed by them. A MOVE could not be a scene row in any
  // case: it is a sentence about a part of the build and exists in no scene.
  // So this is assembled from `s.proposal` — the page state handed in, this
  // module holding no component — and owes the tree nothing but the rows it
  // resolves bodies through.

  const proposalRows = doc.nodes.map((node) => {
    const isMove = node.role === 'move';
    // WHERE THIS BODY STANDS IN THE SCENE, BY NAME, whether or not the tree
    // has caught up. `staged()` in viewport/element.js re-roots every part of
    // the overlay under the group as `<group>/<part name>`, and a part's name
    // is the body's own (`part()` in proposalgeom.js) — so this is that same
    // spelling worked out from this side, off the group path the VIEWPORT
    // minted rather than off a second guess at what the group is called.
    //
    // COMPUTED RATHER THAN LOOKED UP, which is the difference that matters
    // below: the tree lags every edit by a whole re-stage, so a row that took
    // its identity from what the tree HOLDS would lose it for the length of
    // one — most visibly on a rename, where `selectionAfter` has already moved
    // the selection onto a path the tree does not have yet.
    const wanted = isMove || !overlayPath ? null : `${overlayPath}/${node.name}`;
    // THE ROW IN THE SCENE THIS ONE ANSWERS FOR. A body's is the part the
    // overlay staged for it; a move's is the row of the BUILD it displaces,
    // which is where its first path points — `paths` is the row's `leaves` at
    // the moment of the gesture, so the first of them is that row's own id.
    // Null for either wherever the tree cannot answer: nothing staged yet, a
    // document the kernel refused, a build whose part has gone.
    const scene = isMove ? nodeAt(node.paths[0])
      : (wanted && tree.nodes.get(wanted)) || null;
    // WHAT THE ROW SELECTS. The scene's path where there is a LIVE one, so
    // that clicking a body's row lights the body up exactly as clicking the
    // body does, and clicking a move's row lights up the part the sentence is
    // about — the only way to see what it displaced. The DOCUMENT's own node
    // id otherwise, which buys a row that still OPENS: the fields are how a
    // document the kernel refused gets repaired, and a row that could not be
    // opened would be a dead end with the error box standing over it.
    //
    // AND THE ID WHILE A COMPARISON IS UP, whatever the scene holds. The
    // paths of a comparison's scene are `/cmp/<a>:<b>/…`, which name a part no
    // revision has — and `sel` outlives the comparison, because
    // `leaveCompare` does not clear it the way `leaveBuild` does. Written
    // there and left standing, such a path is what `measAdd` would post as the
    // `partId` of a comment once the reader measured
    // something: a task filed against a string that resolves in no build, and
    // the exact class `toolsOff` refuses everywhere else. It is also the one
    // door of its kind now — `onPick` writes `cmpSel` under a comparison, the
    // parts tree is not drawn, and Move is not offered. A node id instead is
    // recognisably NOT A PATH, which is what `measAdd` asks.
    //
    // `sel` IS THEREFORE EITHER A LIVE PATH OR RECOGNISABLY NOT ONE, and that
    // is the property everything downstream leans on rather than a tidiness.
    const path = compared || !scene ? node.id : scene.id;
    // THE PAGE'S ONE SELECTION AND NOT A SECOND OF THE PANEL'S, asked three
    // ways because `sel` can honestly be any of three things and the row is
    // the same row under all of them:
    //
    //   * the DOCUMENT's id — selected while nothing was staged, or while a
    //     comparison was up, or on a document the kernel refused;
    //   * the path this body WANTS, which is what `selectionAfter` writes the
    //     moment a name is committed and what the tree will hold one re-stage
    //     later. Asked of `wanted` and not of `scene`, so the block does not
    //     shut for the length of that window — and on a refused document,
    //     where the re-stage never comes, does not shut for good;
    //   * the ROW the selection resolves to, which is how a COPY picked in the
    //     scene selects the row that collapsed it. That is a move's case: a
    //     body is one part and has no copies.
    const selected = s.sel === node.id
      || (!!wanted && s.sel === wanted)
      || (!!scene && selRow === scene);
    // THE GHOST SQUARE AND THE COLOUR ARE THE SCENE'S, so they are a BODY's
    // alone — `marks` is the row they come off, and it is null for every move.
    // A move draws NOTHING: it displaces a part the build already draws, and
    // that part keeps its own row, its own square and its own colour in the
    // tree below, so a second set here would be two answers to one question
    // about one part. THE EYE ON A MOVE ROW IS NOT ONE OF THOSE TWO and is
    // worked out below from `movesOff` instead: it switches this page's own
    // push off, which is a statement about the move and not about the
    // geometry. Held apart from `scene`, which a move does have and needs —
    // it is the row the sentence is ABOUT, and selecting the move is how the
    // reader finds out which part that is.
    //
    // AND NULL FOR EVERY ROW WHILE A COMPARISON IS UP, which is the one place
    // this branch inherited a control the parts tree never had: that tree is
    // not drawn during a comparison at all, and this one is — deliberately,
    // because a proposal is as true over a comparison as over a build. But
    // `sync` sends `hidden: diffHidden(s.diffShow), ghost: []` while the scene
    // is a comparison's and never looks at `s.hidden`/`s.ghost`, which is why
    // `menuItems` throws Isolate, Hide and Translucent away under the same
    // `compared`. Left standing, the eye went pale over a body still on
    // screen — a control saying it did something it did not — and wrote
    // rubbish besides: the overlay's path inside a comparison is
    // `/cmp/…/proposal`, so a path that exists in no build went into
    // `s.hidden` and rode on through `setVisibility` into the history and the
    // swap's carry. Silence is the honest answer, and it is the menu's.
    const marks = isMove || compared ? null : scene;
    const leaves = marks ? marks.leaves : [];
    const visible = leaves.filter((id) => !hiddenSet.has(id)).length;
    // THE EYE IS THE ONE OF THE THREE A MOVE DOES HAVE, and it is a different
    // control wearing the same glyph: a body's is the scene's, a tally of the
    // leaves the tree hides, while a move's takes that one displacement off the
    // model and leaves the node standing. TWO STATES AND NOT THREE for the
    // reason the branch head's has two — there is nothing to tally, it is a
    // switch — and `toggleMoveEye` holds the rest of the argument.
    const moveOff = isMove && movesOff.has(node.id);
    const eye = isMove ? (moveOff ? 'off' : 'on')
      : visible === 0 ? 'off' : visible === leaves.length ? 'on' : 'part';
    const ghosted = leaves.length > 0 && leaves.every((id) => ghostSet.has(id));
    return {
      key: node.id,
      move: isMove,
      name: node.name,
      // ONE STEP IN FROM THE `proposal` HEAD, which is the indent the parts
      // tree spends on a depth of one (`node.depth * 16` in `emit`), because
      // this branch is read as a tree beside that one.
      // THE CARET'S COLUMN, STOOD OVER — 3 of padding, 20 of caret, 2 of gap,
      // exactly what `proposalHeadStyle` spends before ITS eye. No row of this
      // branch ever folds anything, so the column is empty on every one of
      // them; it is here so the eye, the square, the tick and the name of a row
      // each stand under the same thing in the head. It used to be a bare
      // `margin-left:16px` — an indent belonging to nothing above it, which put
      // every column 6px to the left of the one it answers to. The reader asked
      // what the blank space in front of the eye was, and that was the honest
      // answer: nothing.
      //
      // PADDING AND NOT MARGIN, so the row's own pill starts where the head's
      // does instead of beginning 25px in. The row takes no click of its own
      // (`onContextMenu` alone), so the column is not a target for anything.
      rowStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 25px;margin:0 0 1px;border-radius:4px;background:'
        + (selected ? 'var(--accent-bg)' : 'var(--float-bg-soft)') + ';cursor:default',
      // DRAWN AS ABSENT RATHER THAN LEFT OUT on a row with nothing in the
      // scene: `visibility:hidden` keeps the boxes' width, so the names of the
      // two kinds of row stand in one column, and the browser gives a hidden
      // box no pointer events — there is nothing to press rather than a
      // control that answers nothing.
      //
      // A MOVE ROW KEEPS THE BOX, because its eye is a live control (above),
      // and hides the ghost square inside it instead. The colour needs no
      // clause: `marks` is null on such a row, so the swatch is already
      // transparent and is the spacer that keeps the column.
      marksStyle: 'display:flex;align-items:center;flex:none'
        + (leaves.length || isMove ? '' : ';visibility:hidden'),
      eyeOuter: eyeOuter(eye), eyeDot: eyeDot(eye), ghostIcon: ghostIcon(ghosted),
      ghostStyle: SLOT_22 + (isMove ? ';visibility:hidden' : ''),
      dotStyle: SWATCH + ((marks && marks.color) || 'transparent'),
      // WHAT KIND OF STATEMENT THIS ROW IS, said in the word rather than left
      // to be inferred. A move's row used to be an indented name with three
      // invisible boxes in front of it — nothing on it said this was a part
      // of the build displaced rather than a body the reader had drawn, and
      // the two are the opposite claim about the same model. `move` and not a
      // badge or an icon, in the order and the spelling `proposalText` prints
      // (`move "bracket" by (…)`), so the row and the projection it travels
      // as read alike. NULL AND NOT `''` on a body: an empty string is a
      // child React renders as nothing and every reading of the tree still
      // reports, which is a blank where a reader of a test expects silence.
      kind: isMove ? 'move' : null,
      kindStyle: INDEX_MONO,
      // EXCLUDED FROM WHAT IS SENT, and from nothing else: the node stays in
      // the document, the body stays over the model, the part stays where the
      // move puts it. `!node.skip` is the whole of the read, which is what
      // makes a document written before this field existed a document with
      // nothing ticked off rather than one to migrate.
      skipIcon: skipIcon(!!node.skip),
      skipTitle: node.skip ? 'held back from the text sent to the agent'
                           : 'leave this out of the text sent to the agent',
      onSkip: stop(() => setProposal(
        updateNode(doc, node.id, { skip: !node.skip }))),
      // THE FAINT INK IS "THIS ROW IS NOT ON THE MODEL", which is as true of a
      // move whose eye is shut as of a body whose leaves are all hidden — the
      // part is standing where the build puts it, and the row says so in the
      // same ink the bodies use.
      nameStyle: 'white-space:nowrap;cursor:pointer;padding-right:4px;font:400 12px ' + MONO
        + ';color:' + ((leaves.length || isMove) && eye === 'off'
          ? 'var(--text-faint)' : 'var(--text)'),
      // The same two writers every row of the parts tree uses, and for the
      // same reason: a swap in flight is carrying these lists across BY NAME.
      //
      // A MOVE'S EYE IS THE PAGE'S OWN SWITCH AND NOT ONE OF THEM. It writes
      // no visibility at all: the node names paths of the BUILD, whose rows
      // have their own eyes in the tree below, and hiding those is a different
      // sentence from putting the part back where the build has it.
      onVis: isMove ? stop(() => toggleMoveEye(node.id))
        : stop(() => setVisibility({ hidden: toggle(s.hidden, leaves) })),
      onGhost: stop(() => setVisibility({ ghost: toggle(s.ghost, leaves) })),
      // THE ROW'S PLAIN NAME WHERE THE SCENE CAN ANSWER, and the node's own
      // only where it cannot. `measAdd` heads a composer with `selName` when
      // the tree cannot place the selection and states that both doors put a
      // BARE name there — and a move node's name carries the count, `pin ×3`,
      // which is a tally of parts and not the name of one. The fallback is
      // only ever spent on a selection `measAdd` refuses to attach at all,
      // since a row the scene cannot place selects by its node id.
      onSelect: stop(() => set({
        sel: path, selName: scene ? scene.name : node.name,
      })),
      // THE CONTROL THE WHOLE FEATURE TURNS ON, on both kinds of row. A body
      // is deleted; a part goes home by having its entry deleted — offset and
      // turn together, because the node is the one statement that carried both
      // — and what happens next is the viewport's half: the push that follows
      // stops claiming the path, and `reconcileMoves` puts it back.
      onRemove: stop(() => setProposal(removeNode(doc, node.id))),
      removeTitle: isMove ? 'put it back where the build has it' : '',
      // THE SAME MENU THE ROW HAD IN THE PARTS TREE, given back. Isolate, Hide
      // others and Move were all reachable by right-clicking a staged body's
      // row there, and taking that row out of the parts tree took them with
      // it: the scene still has them on a right-click of the body itself, but
      // a reader who used the tree lost them with nothing saying where they
      // went. It resolves `marks` — the same node the old row was — so this
      // opens the menu `menuItems` already builds rather than a second one.
      //
      // A MOVE ROW HAS NONE, and null rather than a handler that declines is
      // how that is said. Nothing in that menu applies to it: Isolate and Hide
      // others are about geometry the node does not own, the Files are the
      // catalogue's, and Move and Turn would mint a second node over paths
      // this one already claims — which `menuItems` refuses anyway. What is
      // left is a menu ABOUT THE BUILD PART, opened from a row that only names
      // it, which is the confusion the whole branch exists to avoid.
      //
      // AND NOTHING ON A BODY THE SCENE CANNOT PLACE, for a plainer reason:
      // `menuItems` is `[]` for a path no row answers to, and `menuStyle`
      // opens on `s.menu` alone — so the gesture would put an empty box on the
      // screen.
      //
      // ASKED OF `scene` AND NOT OF `marks`, which are the same object outside
      // a comparison and deliberately not inside one. This gate is only about
      // whether there is a scene object to open a menu ABOUT; what belongs in
      // that menu over a comparison is `menuItems`' own question, and it
      // already answers it — everything that writes visibility or names a file
      // is gone under `compared`, and `Copy name` is what remains.
      onMenu: isMove || !scene ? null : stop((e) => {
        e.preventDefault();
        setState({ menu: { id: scene.id, ...menuAt(e.clientX, e.clientY) } });
      }),
      // THE FIELDS ARE THE ROW'S, SHOWN WHEN IT IS SELECTED. A tree row is one
      // 24px line, and a panel of numbers under every row at once is the tree
      // covering the model it describes — so the block opens under the row the
      // reader is looking at and the rest stay one line each. BUILT EITHER
      // WAY and hidden by the style, because a field carries a `ref` that
      // wires the browser's own `change` (`field` above): building them only
      // for the open row would make what the branch can commit depend on what
      // is on screen.
      fieldsStyle: 'display:' + (selected ? 'block' : 'none')
        + ';width:250px;box-sizing:border-box;margin:1px 0 5px 16px;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--float-bg)',
      // A MOVE HAS NO NAME FIELD, NO OP AND NO ROLE. Its name is a row of the
      // BUILD's, resolved when the gesture landed and never chosen by the
      // reader; it draws no geometry, so there is no op to show and nothing
      // for `solid`/`hole` to be about.
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
      // THE SAME THREE-BY-THREE A BODY AND A MOVE HAVE ALWAYS BEEN DRAWN IN,
      // and the same `field`, because they are the same kind of number: a
      // move's `by` is an offset from wherever the build puts the part rather
      // than a place in the document's own space, and `turn°` is the same
      // three degrees about the same three axes a body's `rot°` is.
      //
      // AND THE SNAP STEP LAST ON BOTH KINDS, because both kinds are dragged:
      // a move IS a part of the build under the manipulator, and a body is one
      // of the reader's own under the same one.
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
          // DEGREES, said on the row rather than assumed: the kernel takes
          // radians and `placed` converts, so a reader who read this as
          // radians would turn a body two and a half times and get something
          // that still looks like a box. It is also what the arrows step by —
          // `STEP_DEG` and not `STEP_MM`, because this is the one row of the
          // three whose numbers are not millimetres.
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

  // IS THERE ANYTHING LEFT TO SEND — the master tick's own state, and what
  // pressing it does read backwards. `sendsNothing` is the same question asked
  // of the projection and answers true for an EMPTY document too, which is the
  // one reading that would be wrong here: a master drawn filled over a branch
  // that has no rows would say the reader had held something back. The branch
  // is not drawn at all in that state, so this is about the head of a branch
  // that has rows under it.
  const allSkipped = doc.nodes.length > 0 && doc.nodes.every((node) => node.skip);

  return {
      // -- the rows of the `Add primitive` menu ---------------------------------
      //
      // EVERY OP `SIZES` CAN DRAW, read off that table rather than listed again
      // beside it: a row for an op with no size row is a row that adds a body
      // whose numbers nothing can show, and a missing row is an op nothing can
      // reach. The ORDER is the table's, which is the order proposal.js tables
      // them in.
      //
      // THE ROWS ARE HERE AND THE MENU THEY HANG IN IS CHROME
      // (`proposalMenuStyle` in chromeview.js), which is the same division the
      // view switcher keeps: what the rows SAY is the document's business, where
      // the card is drawn belongs to the toolbar it opens out of.
      proposalOps: Object.keys(SIZES).map((op) => ({
        key: op,
        // THE OP'S OWN NAME, with nothing between it and the row. There used to
        // be a spelling table here for the one op whose key read badly on a
        // button; every op left is a solid whose name IS what the reader means
        // by it, so a table of one entry is a table to keep in step for nothing.
        // No `+` either, now that the button above the menu says `Add primitive`
        // and every row under it is one of the things it adds.
        label: op,
        onClick: addBody(op),
      })),

      // -- the proposal's branch of the tree ----------------------------------
      //
      // DRAWN OVER A DOCUMENT WITH SOMETHING IN IT, AND ON NOTHING ELSE. What
      // keeps the column quiet is the only condition left — a heading over
      // nothing says less than the empty column does.
      //
      // WHAT TAKES THE PROPOSAL OFF THE MODEL IS THIS BRANCH'S OWN EYE, and it
      // is the only thing that does, which is why the branch is drawn on the
      // document alone: a control that can put the bodies back has to stay on
      // screen to be pressed again.
      proposalTreeStyle: 'padding:1px 0 6px;flex-direction:column;align-items:flex-start;display:'
        + (doc.nodes.length ? 'flex' : 'none'),
      // THE HEAD OF THE BRANCH, drawn as a group of the parts tree is drawn at
      // depth 0 — the same height, the same caret, the same count on the right —
      // because it is read beside that tree and a second shape for it would read
      // as a second kind of thing.
      proposalHeadStyle: 'display:inline-flex;align-items:center;gap:2px;height:24px;padding:0 6px 0 3px;margin:0 0 1px;border-radius:4px;background:var(--float-bg-soft);cursor:default',
      proposalCaretPath: branchOpen ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4',
      proposalCaretStyle: 'width:20px;height:20px;flex:none;display:flex;align-items:center;justify-content:center;color:var(--text-soft);cursor:pointer',
      // WRITTEN INTO A COPY RATHER THAN SPELLED AS A COMPUTED KEY, which is the
      // same rule `SIZES` above keeps: `test_every_handled_event_is_imported_
      // from_events_js` reads `[x]:` out of HammerolaViewer.jsx as a handler key, and a
      // `{ [PROPOSAL_BRANCH]: … }` here would arrive there as an event constant
      // that events.js has never heard of.
      proposalToggle: stop(() => {
        const expanded = { ...s.expanded };
        expanded[PROPOSAL_BRANCH] = !branchOpen;
        setState({ expanded });
      }),
      // THE BRANCH'S OWN EYE, drawn with the rows' own `eyeOuter`/`eyeDot` so it
      // reads as the same control one level up — which is what it is: the whole
      // proposal off the model, bodies unstaged and every displaced part back
      // where the build puts it. `toggleProposalEye` has the rest of the
      // argument, including why it is one boolean of interface state and not a
      // per-node thing.
      //
      // TWO STATES AND NOT THREE. A group of the parts tree can be half-hidden
      // (`part`) because its eye is a tally of its leaves; this one is a switch,
      // and the per-body eyes underneath it go on saying what each body is
      // doing. So a proposal whose bodies are individually hidden still reads as
      // ON here — that is the truthful answer, because the moves are still
      // applied and the eyes below say the rest.
      proposalEyeOuter: eyeOuter(s.proposalOff ? 'off' : 'on'),
      proposalEyeDot: eyeDot(s.proposalOff ? 'off' : 'on'),
      proposalEyeClick: stop(() => toggleProposalEye()),
      // THE MASTER TICK: every node held back, or every node let through. It
      // shows filled only when there is nothing left to send, which is the state
      // it would put the document in — so pressing it twice is a round trip, and
      // a branch with one node ticked off shows an empty master with a filled
      // row under it.
      proposalSkipAll: stop(() => setProposal({
        ...doc,
        nodes: doc.nodes.map((node) => ({ ...node, skip: !allSkipped })),
      })),
      proposalSkipIcon: skipIcon(allSkipped),
      proposalSkipTitle: allSkipped ? 'send all of it again'
                                    : 'hold all of it back from the agent',
      proposalHeadName: PROPOSAL_BRANCH,
      proposalHeadNameStyle: `white-space:nowrap;padding-right:4px;font:600 12px ${MONO};color:var(--text)`,
      // THE WHOLE THING, DELETED — the record on the hub and the document on the
      // page together, which is the one control here that reaches past this
      // browser. It asks before it does it; `removeProposal` says why this `×`
      // and no other one on the page is allowed to interrupt.
      proposalRemove: stop(() => removeProposal().catch((error) => {
        console.error('proposal', error);
      })),
      proposalRemoveTitle: 'delete the whole proposal, here and on the hub',
      // HOW MANY STATEMENTS ARE IN IT, bodies and moves together, in the place a
      // group of the parts tree carries how many parts are under it.
      proposalCount: String(doc.nodes.length),
      proposalCountStyle: INDEX_MONO,
      // EMPTIED BY THE CARET rather than hidden by a style, which is how the
      // parts tree collapses a group too: a collapsed branch emits no rows.
      proposalRows: branchOpen ? proposalRows : [],

      // THE KERNEL'S OWN SENTENCE ABOUT THE DOCUMENT AS IT STANDS, under the
      // head of the branch and NOT among the rows — which is what keeps it on
      // screen whether or not the caret has folded the branch away, since the
      // caret empties `proposalRows`. It is the only thing on the page that says
      // why a body has stopped following the numbers: the model does not blink
      // out while a document is refused (`stageProposal`), so a refusal with
      // nothing drawn for it changes nothing anybody can see.
      //
      // WHAT THE KERNEL REFUSES, measured rather than assumed: a NEGATIVE size
      // ("size values must be positive"). A zero builds in silence and draws
      // nothing, and nothing anywhere stops a minus being typed.
      proposalSays: s.proposalError || '',
      // FLUSH WITH THE HEAD AND WITH THE ROWS, which all start at the column's
      // own left edge. NOT indented like the field block under a selected row
      // (16px): the verdict is about the whole document rather than about
      // whichever row happens to be open, and a left edge shared with the
      // branch is what says so.
      proposalSaysStyle: 'width:250px;box-sizing:border-box;margin:1px 0 5px;padding:7px 9px;'
        + `border:1px solid var(--danger-line);background:var(--danger-bg);border-radius:6px;font:400 10.5px/1.5 ${MONO};color:var(--danger);display:`
        + (s.proposalError ? 'block' : 'none'),
  };
}
