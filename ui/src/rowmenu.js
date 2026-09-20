/**
 * The menu a right-click opens, on a row of the tree or on the part in the scene.
 *
 * ONE SECTION OF `computed()` IN THE BUILD PAGE, LIFTED WHOLE (issue #103): it
 * takes the page's state and a bag of the page's own doors and answers with the
 * three keys `render()` draws the menu from — `menuStyle`, `menuName` and
 * `menuItems` — with the same values they had while this was a block inside
 * that method.
 *
 * TWO DOORS AND ONE MENU. A right-click on a tree row and a right-click on the
 * part itself both write `s.menu`, and the subject is whatever id they put in
 * it: a path, or `SECTION_ROW` for the cut's own row. Everything below reads
 * that one field, which is what keeps the two doors from opening two menus.
 *
 * WHAT `deps` IS. The writers are the component's, because what they write is
 * its state. The rest are answers `computed()` has already worked out for every
 * section that needs them — `compared`, `narrow`, the catalogue, and the one
 * `clearSection` this menu shares with the section popover — and the few
 * lookups that stay beside the component because something else there needs
 * them too: `partRecord` and `fileList` for the files, `noteFor` for the note.
 */
import { countedName } from './hub.js';
import { SANS } from './style.jsx';

export function rowMenu(s, deps) {
  const {
    // -- what `computed()` has already worked out
    tree, viewer, narrow, compared, catalogue, anyDownloads, fileHref,
    clearSection, stop, SECTION_ROW,
    // -- the lookups that stay beside the component
    noteFor, partRecord, fileList,
    // -- the page's own doors
    node: nodeAt, proposalBody, set, setState,
    setVisibility, toast, toggle,
  } = deps;

  const mNode = nodeAt(s.menu && s.menu.id);
  // THE SECTION'S ROW IS THE ONE SUBJECT OF THIS MENU THAT IS NOT A NODE, and
  // it is asked for by name rather than faked into one. A stand-in node would
  // have to carry `leaves`, a `key` and a `name` it does not have, and every
  // item below reads at least one of the three — so the fake would reach
  // Isolate, the files and Copy name, all of them about a part that is not
  // there. `mNode` stays `null` for it (`SECTION_ROW` is no tree path), which
  // is what keeps those items off; the two branches below add the ones that
  // ARE about the cut.
  const secMenu = !!(s.menu && s.menu.id === SECTION_ROW);

  // WHETHER THERE IS A SECTION FOR Delete TO CLEAR, which is the four fields
  // `clearSection` writes standing anywhere but where that call would put
  // them. NOT `s.secOn`: the eye on the row takes the cut off the screen and
  // deliberately KEEPS the plane and the offset, so a Delete that read an
  // unlit row as "no section" would decline on exactly the state it exists to
  // clean up.
  const secSet = s.secOn || !!s.secFace || s.secOff !== 0 || s.secFlip;
  // TWO NAMES, AND THE MENU USES BOTH FOR DIFFERENT THINGS. `mName` is the
  // row's own label and is what the menu is headed with — it addresses the
  // ROW, which is one solid in one view UNLESS the row collapsed repeats of
  // one part, and then it is all of them. `mKey` is
  // the catalogue key and is what everything about the PART is looked up
  // under: its note, its files. A group has no key and neither has a leaf
  // that names none, and in both cases the answer is that this row has
  // nothing in the catalogue — never the name used as a stand-in (issue #75).
  //
  // THE COUNT IS ON THE HEADER because the items below it act on the whole
  // row: Hide takes `mNode.leaves`, so a menu headed plain `pin` over a row
  // of five would hide five parts having named one. Copy name is the other
  // half of the same decision and deliberately copies `mNode.name` bare —
  // what goes on the clipboard is a part's name, not a tally of it.
  //
  // A GROUP IS EXCLUDED, on the same ground the tree row gives next door: it
  // would not be the same quantity. A group's `leaves` is every leaf path
  // UNDERNEATH it (`indexTree`), so `housing ×7` reads as seven housings when
  // the seven are the parts inside one. Hide does act on all seven — the
  // argument above holds for a group word for word — but a header naming the
  // wrong quantity is worse than one naming none. What does NOT carry over is
  // the tree row's second remark, that the number is drawn on the right
  // anyway: this menu has no meta column, so nothing here shows it at all.
  //
  // THE SECTION HEADS ITS MENU WITH THE WORD ON ITS ROW, which is the constant
  // the id is: a menu headed anything else would read as being about a part.
  const mName = secMenu ? SECTION_ROW : (mNode && !mNode.isNode
    ? countedName(mNode.name, mNode.leaves.length)
    : (mNode ? mNode.name : ''));
  const mKey = (mNode && mNode.key) || '';
  // Through `noteFor` like the other read of the reader's map. This one throws
  // EARLIEST of the two when it is not: the item below slices the note to 22
  // characters for its hint, and a part called `constructor` hands a bare
  // lookup a function, which has no `slice` — so the whole menu, and with it
  // `computed()` and the page, ends on a right-click.
  const note = noteFor(s.notes, mKey);
  // `href` turns the row into a real `<a download>` — see the files block
  // below — and `tone` is 'top' for a rule above the row, 'said' for a row that
  // states something rather than doing it.
  //
  // A 'said' ROW GETS NO HANDLER AT ALL, which is what makes its `cursor:
  // default` and its grey true rather than a costume. It used to be styled
  // unclickable and then handed an `onClick` anyway — one that stopped the
  // event and closed the menu, i.e. a row that acted while saying it would
  // not. Without one the row is inert, which is exactly what it claims to be:
  // the click stops at the menu's own wrapper (which stops propagation so that
  // a press on the menu's padding does not close it through `rootClick`), and
  // the menu closes on the next click anywhere outside, as it always has.
  const mi = (label, hint, fn, tone, href) => ({
    key: label, label, hint: hint || '', href: href || '',
    style: `display:flex;align-items:center;gap:10px;padding:7px 14px;text-decoration:none;font:400 12px ${SANS};`
      + (tone === 'said' ? 'cursor:default;color:var(--text-faint)' : 'cursor:pointer;color:var(--text)')
      + (tone === 'top' || tone === 'said' ? ';border-top:1px solid var(--line-soft)' : ''),
    onClick: tone === 'said'
      ? undefined
      : stop(() => { fn(); setState({ menu: null }); }),
  });

  /**
   * What arming the manipulator on `id` says, which is ONE sentence because
   * there is one widget.
   *
   * ONE ROW ARMS IT, and the sentence has to name the whole manipulator
   * because the row's name cannot. There were two rows and two tools, Move and
   * Turn, and a reader had to put a part down before they could turn it; there
   * is one manipulator round the part now (`viewport/gizmo.js` and
   * `viewport/rings.js`) — arrows and plane quads that slide it and coloured
   * discs that turn it, all at once — and a second row arming the same tool
   * said there were two gestures when there is one.
   *
   * AND IT NAMES WHAT THE HAND MUST ACTUALLY GRAB. "Drag it" was true while a
   * press on the part itself slid it about; that gesture is gone
   * (`viewport/tools.js`), so a reader told to drag the part would drag it,
   * orbit the model instead, and conclude the tool is broken.
   *
   * THE TAIL IS STILL TWO SENTENCES, and it has to be: a part of the BUILD
   * moves as a statement to the agent and the model is untouched, so the next
   * rebuild puts it back; a body of the PROPOSAL moves as an edit of the
   * document the reader is authoring, so it stays. One tail would be false on
   * one of them.
   */
  const armedSaid = (id) => (proposalBody(id)
    ? 'Drag an arrow or a quad to slide it, a coloured disc to turn — the proposal keeps the body where you put it'
    : 'Drag an arrow or a quad to slide it, a coloured disc to turn — it snaps back on the next rebuild');

  /**
   * This part's files — the row-menu half of the header's Downloads menu.
   *
   * Three rows and not a submenu: one click cannot sensibly deliver three
   * files, this menu has no submenu machinery anywhere in it, and a row per
   * file is exactly what the header's menu already looks like — extension on
   * the left, filename on the right. Each one is a plain `<a href download>`
   * against the same base URL the header builds, so middle-click and "save
   * link as" work on it like any other link on the page.
   *
   * BOTH EMPTY CASES SAY SO OUT LOUD. A part that is not printed — a bought
   * screw, a mock of something bought — has no files and never will, and a
   * menu that silently dropped the item would read as a menu that forgot.
   * Same for a build that ships nothing: the header's menu has a sentence for
   * that case and this one must not be worse.
   *
   * A ROW WITH NO KEY LANDS ON THE SAME SENTENCE, through `partRecord`
   * answering `null` for an empty key. It is the honest answer: the row names
   * no catalogue entry, so there is nothing here that is this row's.
   *
   * TAKEN OFF `files` AND NEVER OFF `kind`, though the two say the same thing
   * on any document the hub accepted (`_catalogue` refuses a printable with
   * no files and a non-printable with some). `files` is what actually names
   * the files, so reading it is one question with one answer; reading `kind`
   * and then trusting `files` to match would be two, free to disagree on the
   * one document nobody validated. `preview` sits in the same record and is
   * deliberately not read: see `fileList`.
   */
  const fileRows = (key) => {
    if (!anyDownloads) return [mi('No files in this build', '', () => {}, 'said')];
    const files = fileList(partRecord(catalogue, key));
    if (!files.length) return [mi('No files for this part', 'not a printable', () => {}, 'said')];
    return files.map((f, at) => mi(f.ext.toUpperCase(), f.file, () => {},
                                   at === 0 ? 'top' : '', fileHref(f.file)));
  };

  // WHILE A COMPARISON IS UP, VISIBILITY IS THE THREE TABS AND NOTHING ELSE.
  // `sync` sends the tabs' own hidden list and ignores `s.hidden`/`s.ghost`
  // while the scene is a comparison's, so the three visibility items below
  // would do NOTHING VISIBLE and write to the reader's build lists behind
  // their back — Isolate worst of all, which replaces `s.hidden` wholesale
  // with `/cmp/…` paths that match nothing in the build's tree, so the parts
  // they had hidden before comparing came back on screen when they closed the
  // panel. The same question `sync` asks, so the two cannot answer it
  // differently.
  //
  // MOVE RIDES IN THE SAME EXCLUSION ON ITS OWN GROUND, which is `toolsOff`'s:
  // a drag inside a comparison files a `/cmp/…` path as the part a comment is
  // about. Its row says so where it stands; it is in this block because the
  // block is where a row that must not be offered over a comparison goes.
  //
  // AND THE FILES GO WITH THEM, on a stronger ground than "they would do
  // nothing": they would do the WRONG THING quietly. The catalogue on this
  // page is `<a>`'s (`PAGE.base`, `meta.parts`), so a right-click on a part
  // inside `/cmp/rev b` — the geometry of the NEW revision, on screen, under
  // the cursor — offered `<b>`'s part under `<a>`'s file, with the same file
  // name on the row and nothing anywhere saying which revision came down.
  // Serving `<b>`'s would take `<b>`'s meta.json, which this page never
  // fetches; so the honest answer is to offer nothing, and the header's
  // Downloads menu goes on being `<a>`'s where it says so.
  /**
   * The section's two items — the whole of what that row's right-click offers.
   *
   * EDIT IS THE POPOVER AND NOT A SECOND DIALOG. Clicking the row's name or
   * its subtitle already opens it; this is the same door reached by the
   * gesture every other row in the panel answers to, so what it writes is the
   * one flag that panel is drawn by. `openSecPop` itself is not called here:
   * it is built in `computed()` itself and is `stop()`-wrapped for a DOM
   * event this closure does not have — `mi` has already stopped the click and
   * will close the menu behind us.
   *
   * AND DELETE SAYS SO RATHER THAN ACTING WHEN THERE IS NOTHING TO DELETE,
   * which is `fileRows`' rule for an item that does not apply: a grey row
   * stating the case, with no handler at all, instead of a live row that
   * quietly writes the values already in place.
   */
  const sectionItems = [
    mi('Edit', '', () => setState({ secPop: true })),
    ...(secSet
      ? [mi('Delete', 'clear the plane', clearSection, 'top')]
      : [mi('No section to delete', '', () => {}, 'said')]),
  ];
  const partItems = !mNode ? [] : [
    // HIDING EVERYTHING ELSE IS THE WHOLE OF IT, and the selection it used to
    // write alongside is gone (issue #83). `sel` reaches `selectSolid`, whose
    // shader REPLACES the part's colour with the selection blue — and colour
    // is an assertion in this interface, grey for a mock and the author's own
    // hue for everything else — so isolating a part destroyed the one thing
    // the reader isolated it to look at.
    ...(compared ? [] : [
      mi('Isolate', 'show only this', () => {
        const keep = new Set(mNode.leaves);
        setVisibility({ hidden: tree.leaves.filter((id) => !keep.has(id)) });
      }),
      mi('Hide', '', () => setVisibility({ hidden: toggle(s.hidden, mNode.leaves) })),
      mi('Translucent', 'see through it', () => setVisibility({ ghost: toggle(s.ghost, mNode.leaves) })),
      // THE MOVE TOOL, ARMED ON THIS OBJECT. It used to be a button in the
      // toolbar, which armed a gesture and left the reader to find the part
      // afterwards; here the object is already named, so the row can do both.
      //
      // AND IT SELECTS BEFORE IT ARMS, in one write, which is the half that
      // makes the row mean what it says. The armed tool puts a manipulator on
      // what is SELECTED and there is nowhere else a drag of a part can start
      // (`held` in viewport/gizmo.js) — and neither door into this menu writes
      // `sel`: a right-click on a tree row does not select, and neither does
      // one on the part in the scene. So Move chosen here while another object
      // stood selected would have stood the widget on that other one.
      //
      // ARMED AND NOT TOGGLED, unlike the toolbar buttons `setTool` draws: a
      // row of a menu that closes behind it is not something a reader presses
      // a second time to undo. Escape still disarms, as it always did.
      //
      // AND THE SELECTION IS WHY THE ROW IS OFFERED ON A PROPOSAL BODY TOO,
      // rather than being the one kind of object this is kept off. Such a body
      // needs the same armed tool as any part, and the widget comes up on what
      // is SELECTED: a row offered on the parts and withheld from the bodies
      // would arm the tool with a PART selected every time, and the reader
      // would be looking at a manipulator standing on the wrong object.
      //
      // NOT UNREACHABLE WITHOUT THE ROW — ONE GESTURE MORE. A click on the
      // body selects it and the widget comes up round it, so what this row
      // saves is that step rather than being the only door.
      //
      // THE SENTENCE IS NOT THE SAME FOR THE TWO, because the surprising half
      // differs. A part of the MODEL moves as a statement to the agent and the
      // model is untouched, so it goes back where the build put it. A body of
      // the PROPOSAL moves as an edit of the panel's own document, which is
      // the thing the reader is authoring — it stays where it is put, and the
      // numbers in the panel follow it.
      //
      // AND A GROUP IS REFUSED BY THE SAME ARITHMETIC THE BODIES ALMOST WERE.
      // `selectedPaths` spreads a LEAF into the copies of its part, but a group
      // it leaves as the node's own path — and the widget stands on a part's
      // own centre, which an assembly node has none of: the library registers
      // such a path as a bare `Group` with no front mesh under it, so
      // `partCentre` answers null and `place` draws nothing. A row promising to
      // move this object, which then arms a tool that puts no manipulator on
      // screen at all, is worse than no row: `Note` and the file rows already
      // stand off a group for reasons of their own, and this is a third.
      //
      // TWO MORE THINGS TAKE IT AWAY, each answering a different question.
      // `viewer` is about who the reader IS: both kinds of drag end in the
      // proposal document, which travels to the agent as a comment and is
      // behind the token either way, so a reader without one has nothing to
      // move a thing FOR — and the panel that holds it is gone too. `narrow`
      // is about the WINDOW: the toolbar drops every tool at that width and
      // the crossing disarms the one in hand (`componentDidMount`), because
      // there is no room to aim on a phone, and a row that armed one anyway
      // would hand back exactly what narrow takes away.
      //
      // The comparison is the third, and it is the `compared` block this list
      // sits inside rather than a condition here: a drag inside one puts a `/cmp/…` path in `partId`,
      // which is what `toolsOff` refuses everywhere else.
      ...(viewer || narrow || mNode.isNode ? [] : [
        mi('Move', '', () => {
          set({ sel: mNode.id, selName: mNode.name, tool: 'move' });
          toast(armedSaid(mNode.id));
        }),
      ]),
    ]),
    // A NOTE IS FILED UNDER THE CATALOGUE KEY, so a row that has none is not
    // offered one — and the reason is the WRITE, not the catalogue. A note
    // lives in localStorage and is never looked up in `meta.parts`: a leaf
    // whose key the catalogue does not declare gets this item and should,
    // because the reader's sentence is theirs rather than the build's. What
    // an empty key breaks is `notesWith`, which hands the map back UNTOUCHED
    // (`if (!key) return next`) — so the item on such a row would take the
    // text, close the dialog exactly as a successful save closes it, and
    // store nothing, with nothing anywhere saying so.
    //
    // DO NOT "FIX" THIS INTO `partRecord(...)`: that would take the note away
    // from a keyed leaf the catalogue happens not to declare, which is a row
    // this page is built to survive.
    //
    // `mKey` is empty on a group and on a leaf that names no key, which is
    // why the condition asks about it rather than about `isNode`.
    ...(viewer || !mKey ? [] : [mi('Note', note ? (note.length > 22 ? `${note.slice(0, 22)}…` : note) : '',
      () => setState({ notePop: mKey, noteDraft: note || '' }))]),
    // Files hang on a PART, so a group row has none of its own — the same rule
    // and the same reason as the note above it. A group is not a printable and
    // has no catalogue record of its own, so the union of its leaves' files is
    // a set this menu would be INVENTING; and bulk by the axis a reader
    // actually asks along — one format, all parts — is in the header's menu,
    // where each group has a "download all" of its own.
    //
    // THIS USED TO SAY BROWSERS BLOCK EVERY DOWNLOAD AFTER THE FIRST. They do
    // not — they ASK, once, with a per-site permission a person grants and the
    // browser then remembers. Corrected here rather than deleted because the
    // false version reads like a hard wall and was quoted onward as one: it
    // makes "hand out N files on one click" look impossible, when for a person
    // it costs one prompt. What it does still cost is anything driving the
    // page that cannot answer a prompt — an agent — and a file whose name the
    // page never chose. Those are the reasons to prefer one archive over N
    // links; "the browser refuses" is not one, because it does not.
    ...(compared || mNode.isNode ? [] : fileRows(mKey)),
    // WHAT IS COPIED IS THE PART, and inside a comparison the row's own label
    // is not it. The scene numbers the pieces of one difference apart —
    // `plate #1`, and a vent slot widened by 0.4 mm came out as twelve of them
    // (`cadbuild/comparescene`) — so `mNode.name` on a difference leaf is an
    // internal piece label that names nothing a reader can look up, in the
    // catalogue, in the report beside it, or in `model.py`. The catalogue key
    // is what all three speak, and it is what the panel's own rows print.
    //
    // THE ROW'S NAME REMAINS THE ANSWER EVERYWHERE ELSE, unchanged: on a build
    // page a leaf's name IS the part as the reader is shown it, and a
    // collapsed run copies the name bare rather than the tally (the header
    // above). A group inside a comparison has no key, and falls back to its
    // own name, which for `/cmp/rev a` is exactly what it says.
    mi('Copy name', '', () => {
      const name = (compared && mKey) || mNode.name;
      try {
        navigator.clipboard.writeText(name);
        toast(`copied: ${name}`);
      } catch (error) {
        console.warn('clipboard', error);
        toast('Could not copy the name');
      }
    }, 'top'),
  ];
  const menuItems = secMenu ? sectionItems : partItems;

  return {
    menuStyle: 'position:fixed;width:230px;background:var(--card-bg);border:1px solid var(--line);border-radius:9px;box-shadow:0 12px 40px var(--shadow);padding:2px 0 6px;z-index:60;display:' + (s.menu ? 'block' : 'none') + ';left:' + (s.menu ? s.menu.x : 0) + 'px;top:' + (s.menu ? s.menu.y : 0) + 'px',
    menuName: mName, menuItems,
  };
}
