/**
 * The menu a right-click opens, on a row of the tree or on the part in the scene.
 *
 * One section of the build page's `computed()`: it takes the page's state and
 * a bag of the page's own doors and answers with the three keys `render()`
 * draws the menu from — `menuStyle`, `menuName` and `menuItems`.
 *
 * TWO DOORS AND ONE MENU. A right-click on a tree row and a right-click on the
 * part itself both write `s.menu`, and the subject is whatever id they put in
 * it: a path, or `SECTION_ROW` for the cut's own row.
 *
 * `deps`: the writers are the component's, because what they write is its
 * state; the rest are answers `computed()` has already worked out (`compared`,
 * `narrow`, the catalogue, the shared `clearSection`) and lookups the component
 * also needs (`partRecord`, `fileList`, `noteFor`).
 */
import { countedName } from './hub.js';
import { SANS } from './style.jsx';

export function rowMenu(s, deps) {
  const {
    // -- what `computed()` has already worked out
    tree, viewer, narrow, compared, catalogue, anyDownloads, fileHref, filesKey,
    clearSection, stop, SECTION_ROW,
    // -- the lookups that stay beside the component
    noteFor, partRecord, fileList,
    // -- the page's own doors
    node: nodeAt, expandedTo, proposalBody, set, setState,
    setVisibility, toast, toggle,
  } = deps;

  const mNode = nodeAt(s.menu && s.menu.id);
  // The section's row is the one subject that is not a node. `mNode` stays
  // `null` for it (`SECTION_ROW` is no tree path), which keeps the part items
  // (Isolate, files, Copy name) off; `sectionItems` below are the cut's own.
  const secMenu = !!(s.menu && s.menu.id === SECTION_ROW);

  // Whether there is a section for Delete to clear: any of the four fields
  // `clearSection` writes differs from its cleared value. Not `s.secOn`: the
  // eye on the row hides the cut but keeps the plane and the offset.
  const secSet = s.secOn || !!s.secFace || s.secOff !== 0 || s.secFlip;
  // `mName` is the row's label and heads the menu; `mKey` is the catalogue key
  // everything about the PART is looked up under (note, files). A group or a
  // leaf that names no key has no catalogue entry — never the name used as a
  // stand-in.
  //
  // The count is on the header because the items act on the whole row: Hide
  // takes `mNode.leaves`. Copy name copies `mNode.name` bare. A group gets no
  // count: its `leaves` is every leaf underneath (`indexTree`), so `housing ×7`
  // would name the wrong quantity.
  //
  // The section heads its menu with the word on its row.
  const mName = secMenu ? SECTION_ROW : (mNode && !mNode.isNode
    ? countedName(mNode.name, mNode.leaves.length)
    : (mNode ? mNode.name : ''));
  const mKey = (mNode && mNode.key) || '';
  // Through `noteFor`: a bare lookup of a part called `constructor` returns a
  // function, and the `slice` below would throw and take the page down.
  const note = noteFor(s.notes, mKey);
  // `href` turns the row into a real `<a download>` — see the files block
  // below — and `tone` is 'top' for a rule above the row, 'said' for a row that
  // states something rather than doing it.
  //
  // A row with `href` is two controls side by side, the link and its Copy link
  // at the end (copylink.jsx), which may not sit inside the `<a>`: `rowStyle`
  // holds both and the rule above them, `style` is the link's, filling the
  // row, and `copyStyle` pads the Copy link.
  //
  // A 'said' row gets no handler at all, so it is inert as it looks: the click
  // stops at the menu's wrapper (which stops propagation so a press on the
  // menu's padding does not close it through `rootClick`), and the menu closes
  // on the next click outside.
  const mi = (label, hint, fn, tone, href) => {
    const rule = tone === 'top' || tone === 'said' ? ';border-top:1px solid var(--line-soft)' : '';
    return {
      key: label, label, hint: hint || '', href: href || '',
      style: 'display:flex;align-items:center;gap:10px;'
        + (href ? 'flex:1;min-width:0;padding:7px 4px 7px 14px;' : 'padding:7px 14px;')
        + `text-decoration:none;font:400 12px ${SANS};`
        + (tone === 'said' ? 'cursor:default;color:var(--text-faint)' : 'cursor:pointer;color:var(--text)')
        + (href ? '' : rule),
      rowStyle: href ? `display:flex;align-items:center${rule}` : '',
      copyStyle: href ? 'padding:7px 14px 7px 4px' : '',
      onClick: tone === 'said'
        ? undefined
        : stop(() => { fn(); setState({ menu: null }); }),
    };
  };

  /**
   * What arming the manipulator on `id` says.
   *
   * One manipulator (`viewport/gizmo.js`, `viewport/rings.js`): arrows and plane
   * quads slide, coloured discs turn, so the sentence names what the hand must
   * grab — a press on the part itself orbits. The tail differs: a part of the
   * BUILD moves as a statement to the agent and snaps back on rebuild; a body
   * of the PROPOSAL moves as an edit of the document, so it stays.
   */
  const armedSaid = (id) => (proposalBody(id)
    ? 'Drag an arrow or a quad to slide it, a coloured disc to turn — the proposal keeps the body where you put it'
    : 'Drag an arrow or a quad to slide it, a coloured disc to turn — it snaps back on the next rebuild');

  /**
   * This part's files — the row-menu half of the header's Downloads menu.
   *
   * A row per file rather than a submenu, like the header's menu. Each is a
   * plain `<a href download>` against the same base URL the header builds, so
   * middle-click and "save link as" work.
   *
   * Both empty cases say so: a part that is not printed has no files, and a
   * build may ship none. A row with no key lands on the same sentence through
   * `partRecord` answering `null`.
   *
   * Read off `files`, not `kind` (`_catalogue` keeps them consistent, but
   * `files` is what names the files). `preview` is not read: see `fileList`.
   *
   * Without `filesKey` the block is not drawn at all, sentences included: the
   * hub would refuse every link, and "No files in this build" would be untrue.
   */
  const fileRows = (key) => {
    if (!anyDownloads) return [mi('No files in this build', '', () => {}, 'said')];
    const files = fileList(partRecord(catalogue, key));
    if (!files.length) return [mi('No files for this part', 'not a printable', () => {}, 'said')];
    return files.map((f, at) => mi(f.ext.toUpperCase(), f.file, () => {},
                                   at === 0 ? 'top' : '', fileHref(f.file, filesKey)));
  };

  // WHILE A COMPARISON IS UP, VISIBILITY IS THE THREE TABS AND NOTHING ELSE.
  // `sync` sends the tabs' own hidden list and ignores `s.hidden`/`s.ghost`,
  // so the visibility items would do nothing visible and write the build's
  // lists behind the reader's back (Isolate would fill `s.hidden` with `/cmp/…`
  // paths). Move is excluded for `toolsOff`'s reason: a drag inside a
  // comparison files a `/cmp/…` path. The files go too: the catalogue on this
  // page is `<a>`'s, so a part of `/cmp/rev b` would be offered `<a>`'s file.
  /**
   * The section's two items — the whole of what that row's right-click offers.
   *
   * Edit opens the section popover (the same one a click on the row opens) by
   * writing its flag; `openSecPop` is not called because it is `stop()`-wrapped
   * for a DOM event, and `mi` already stops the click and closes the menu.
   *
   * With nothing to delete, Delete is a grey 'said' row, like `fileRows`.
   */
  const sectionItems = [
    mi('Edit', '', () => setState({ secPop: true })),
    ...(secSet
      ? [mi('Delete', 'clear the plane', clearSection, 'top')]
      : [mi('No section to delete', '', () => {}, 'said')]),
  ];
  const partItems = !mNode ? [] : [
    // Isolate only hides the rest and does not select: the selection shader
    // replaces the part's colour, which is what the reader isolated it to see.
    ...(compared ? [] : [
      mi('Isolate', 'show only this', () => {
        const keep = new Set(mNode.leaves);
        setVisibility({ hidden: tree.leaves.filter((id) => !keep.has(id)) });
      }),
      mi('Hide', '', () => setVisibility({ hidden: toggle(s.hidden, mNode.leaves) })),
      mi('Translucent', 'see through it', () => setVisibility({ ghost: toggle(s.ghost, mNode.leaves) })),
      // Move arms the manipulator on this object. It selects in the same write
      // because the widget stands on what is SELECTED (`held` in
      // viewport/gizmo.js), and neither door into this menu writes `sel`. Armed,
      // not toggled; Escape disarms. Offered on proposal bodies too, for the
      // same selection reason; the toast differs (see `armedSaid`).
      //
      // Withheld from:
      // - a group: `selectedPaths` keeps a group as its own path, which the
      //   library registers as a bare `Group` with no mesh, so `partCentre` is
      //   null and no manipulator appears;
      // - a viewer: both kinds of drag end in the proposal document, which is
      //   behind the token;
      // - narrow: the toolbar drops every tool at that width and the crossing
      //   disarms the one in hand (`componentDidMount`);
      // - a comparison: the enclosing `compared` block (`toolsOff`).
      ...(viewer || narrow || mNode.isNode ? [] : [
        mi('Move', '', () => {
          set({ sel: mNode.id, selName: mNode.name, tool: 'move',
                expanded: expandedTo(mNode.id) });
          toast(armedSaid(mNode.id));
        }),
      ]),
    ]),
    // A note is filed under the catalogue key, so a row without one is not
    // offered one: `notesWith` returns the map untouched for an empty key, and
    // the save would silently store nothing. The note lives in localStorage
    // and is not looked up in `meta.parts`, so a keyed leaf the catalogue does
    // not declare still gets it — do not change this to `partRecord(...)`.
    ...(viewer || !mKey ? [] : [mi('Note', note ? (note.length > 22 ? `${note.slice(0, 22)}…` : note) : '',
      () => setState({ notePop: mKey, noteDraft: note || '' }))]),
    // Files hang on a part, so a group row has none: the union of its leaves'
    // files would be invented. Bulk download (one format, all parts) is in the
    // header's menu.
    ...(compared || mNode.isNode || !filesKey ? [] : fileRows(mKey)),
    // Inside a comparison the row's label is an internal piece label
    // (`plate #1`, from `cadbuild/comparescene`), so the catalogue key is
    // copied instead. Everywhere else the row's name is the answer; a group
    // inside a comparison has no key and falls back to its name.
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
