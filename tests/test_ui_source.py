"""What the browser UI cannot check about itself, checked from Python.

BEFORE ADDING ANYTHING HERE, read this paragraph — it is the one that has cost
the most. There IS a JavaScript test runner in this repository (`ui/tests`,
vitest, run by both CI workflows), and the sentence that used to stand here said
there was not. Everything below reads source as TEXT, which is the right tool for
exactly one kind of question — "does this spelling appear where it must not" —
and the wrong tool for every question about a VALUE. Twice now a check written
here has passed on the defect it was written for: one looked for a colour and
found it in the prose explaining the colour; one collected the keys of an object
literal by matching braces and commas, and a trailing `//` comment containing a
comma handed it the next word as a key. `strip_comments()` below removes
whole-line comments only, deliberately, so neither was a bug in the helper —
they were the method.

So the division is: if the thing being checked is a value the language can
compute — a set of keys, a colour, a font stack, the attributes of an SVG path —
it belongs in `ui/tests/`, where it can be imported and executed
(`vocabulary.test.js`, `chrome.test.js`). What stays here is what only the text
can answer.

The question this file is for is still: WHERE TWO FILES HAVE TO AGREE AND
NOTHING MAKES THEM. Every check below is a silent-failure class — the build is
green, the page loads, and one feature is quietly inert:

  * the interface (`ui/src/`) and the viewport (`ui/src/viewport/`) talk over
    window events, and a name spelled differently at the two ends is not an error
    anywhere: `addEventListener` for a name nobody dispatches is silence, and the
    symptom is a button that does nothing. The names therefore have exactly one
    source — `ui/src/viewport/events.js` — which the interface imports under
    aliases of its own; what is checked here is that no second spelling has
    appeared, because nothing in the browser can tell "the other side is not
    listening" from "the other side had nothing to do";

  * the comment form posts to a route and with field names the hub decides. A
    rename on either side gets a 404 or a 422 with the text already typed;

  * the bundle must stay ONE output file, because five files outside this build
    copy it by name (ui/vite.config.mjs says so at length). A dynamic import or
    an imported stylesheet adds a second one, and the only report is a 404 in
    somebody's browser;

  * the page is served under `default-src 'self'` (src/app.py). An external font
    or CDN reference does not fail a build — it is simply blocked in the browser,
    on production, with the layout falling back to something that still looks
    plausible.

Every check DERIVES both halves from the files. A test carrying its own copy of a
name would be one more place to forget, and it would pass while agreeing only
with itself.
"""

import re
from pathlib import Path

import pytest

from src.comments import PHOTO_KIND, SHOT_KIND, validate_payload

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui" / "src"
VIEWPORT = UI / "viewport"

# The interface's own sources: everything under ui/src that is not the viewport
# adapter. Discovered rather than listed, so a module added tomorrow is covered
# by every check here without anybody remembering to add it.
INTERFACE_FILES = sorted(p for p in UI.glob("*.js*") if p.is_file())
ADAPTER_FILES = sorted(VIEWPORT.glob("*.js")) if VIEWPORT.is_dir() else []

# Every source that reaches the bundle, however deep, and WITHOUT the halves the
# two lists above keep apart. The rule about where a name may be spelled has no
# exceptions by directory, so the check that enforces it must not have a list
# that stops at one.
ALL_UI_FILES = sorted(p for p in UI.rglob("*.js*") if p.is_file())

EVENTS_JS = UI / "events.js"
ADAPTER_EVENTS_JS = VIEWPORT / "events.js"
COMPONENT = UI / "HammerolaViewer.jsx"

# `const NAME = "hmr:thing";` — the shape the ONE event module is written in.
EVENT_DECL = re.compile(r"""(?:export\s+)?const\s+(\w+)\s*=\s*["'](hmr:[a-z]+)["']""")

# `EVENT_PICK as PICK` — how the interface takes a name it did not spell.
EVENT_ALIAS = re.compile(r"\b(EVENT_[A-Z]+)\s+as\s+(\w+)\b")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(source: str) -> str:
    """Source with `//` and `/* */` comments removed.

    Comments are where this file's rules are ALLOWED to be broken: a URL named in
    a sentence explaining why it is not fetched is not a fetch, and `innerHTML`
    named in a note about the library's own behaviour is not an assignment. Every
    content check below therefore runs on what actually executes.

    LINE NUMBERS ARE PRESERVED — a block comment becomes the same lines of
    spaces rather than collapsing — so a check may report a line number, and so a
    check may look at the RAW line beside the stripped one. `test_nothing_splits_
    the_bundle` needs exactly that: the thing making a dynamic import legitimate
    is `/* @vite-ignore */`, which lives in a comment on that same line, so
    stripping first and asking afterwards would flag the one deliberate case.

    Only WHOLE-LINE `//` comments go, never a trailing one: `https://` inside a
    string would otherwise be read as the start of a comment and take the rest of
    the line — including the URL this file exists to notice — with it.
    """
    source = re.sub(r"/\*.*?\*/",
                    lambda m: re.sub(r"[^\n]", " ", m.group(0)), source, flags=re.S)
    return re.sub(r"^\s*//.*$", "", source, flags=re.M)


def declared_events(path: Path) -> dict:
    """{constant name: event name} for the module that declares them."""
    return {name: value for name, value in EVENT_DECL.findall(read(path))}


def interface_events() -> dict:
    """{the name the interface uses: the `hmr:` string behind it}.

    The interface declares no names of its own — it imports the adapter's
    constants under shorter aliases (`EVENT_PICK as PICK`) — so the value is
    looked up where it is actually written. Derived, like everything else here:
    an alias for a constant the adapter does not export is a failure rather than
    a missing key.
    """
    literals = declared_events(ADAPTER_EVENTS_JS)
    aliases = EVENT_ALIAS.findall(strip_comments(read(EVENTS_JS)))
    assert aliases, "ui/src/events.js no longer imports any event name"
    unknown = sorted(const for const, _ in aliases if const not in literals)
    assert not unknown, (
        f"ui/src/events.js imports {unknown} from the adapter and the adapter "
        "declares no such event")
    return {local: literals[const] for const, local in aliases}


def js_array(source: str, name: str) -> list:
    """The identifiers in `export const NAME = [ ... ];`, frozen or not.

    `Object.freeze(` is optional because two of the arrays read here are frozen
    and the others are not, and freezing one more must not be a change that
    breaks a reader of the source. It did break this one once — which is the
    right failure mode and is why the assertion below names the array rather
    than returning an empty list: a parser that silently found nothing would
    have handed every caller an empty set, and a check that sweeps an empty set
    passes.
    """
    match = re.search(rf"const\s+{name}\s*=\s*(?:Object\.freeze\(\s*)?\[(.*?)\]",
                      source, flags=re.S)
    assert match, f"{name} is not an array literal any more"
    return [item.strip() for item in match.group(1).split(",") if item.strip()]


skip_without_adapter = pytest.mark.skipif(
    not ADAPTER_FILES,
    reason="ui/src/viewport/ is empty — the adapter has not landed yet",
)


# -- the lists everything else iterates --------------------------------------

def test_the_discovery_found_the_files():
    """Every check below sweeps a DISCOVERED list, and an empty list passes them all.

    That is this file's own worst failure and it is the one it is least able to
    notice: a renamed directory, a changed extension, and the whole suite goes
    green by looking at nothing. So the modules the checks are actually about are
    named once, here, and their absence is a failure rather than a quiet skip.
    """
    names = {path.name for path in INTERFACE_FILES}
    assert {"HammerolaViewer.jsx", "HammerolaEntry.jsx", "events.js", "hub.js",
            "main.jsx", "store.js", "style.jsx"} <= names, (
        f"ui/src no longer holds the interface: {sorted(names)}")
    if not ADAPTER_FILES:
        pytest.skip("ui/src/viewport/ is empty — the cross-checks skip honestly")
    assert (VIEWPORT / "events.js").exists(), "the adapter is there but names no events"


# -- the event contract ------------------------------------------------------

@skip_without_adapter
def test_one_module_spells_every_event_name():
    """No `hmr:` literal ANYWHERE under ui/src except viewport/events.js.

    This replaced a check that compared two lists of literals — the interface
    kept its own copy of the names and the test reported when the copies drifted.
    That premise is gone: `ui/src/events.js` now imports the adapter's constants
    under aliases, so there is nothing left to drift. A detector is worth having
    when the error class cannot be removed; here it could be, and what is left to
    guard is that a SECOND source does not come back — a literal typed at a call
    site, which is invisible to the reader of the other file and to everything
    else in this one.

    COMMENTS ARE EXEMPT, deliberately and consistently with the rest of this
    file: the modules on both sides explain their own events at length and by
    name, and prose about `hmr:model` is not a dispatch. The failure being
    prevented is a name that EXECUTES, and a comment executes nothing.
    """
    assert ALL_UI_FILES, f"{UI} has no sources in it at all"
    assert set(INTERFACE_FILES) | set(ADAPTER_FILES) <= set(ALL_UI_FILES), (
        "the recursive sweep no longer covers the files the other checks use")
    strays = {}
    for path in ALL_UI_FILES:
        if path == ADAPTER_EVENTS_JS:
            continue
        found = re.findall(r"['\"`]hmr:[a-z]*['\"`]", strip_comments(read(path)))
        if found:
            strays[str(path.relative_to(UI))] = found
    assert not strays, (
        f"event names spelled outside {ADAPTER_EVENTS_JS.relative_to(UI)}: "
        f"{strays}")


@skip_without_adapter
def test_the_up_events_lists_agree():
    """Both sides enumerate the same events as coming UP from the viewport.

    Direction is the half of the contract a shared import does NOT settle: the
    two lists are written independently — `UP_EVENTS` is what the interface
    attaches listeners for, `EVENTS_UP` is what the viewport says it sends — and
    an event on one and not the other is a handler that is never called, or a
    dispatch nothing hears.
    """
    ours = interface_events()
    theirs = declared_events(ADAPTER_EVENTS_JS)
    listed = js_array(read(EVENTS_JS), "UP_EVENTS")
    unknown = [name for name in listed if name not in ours]
    assert not unknown, f"UP_EVENTS names {unknown}, which this file never imports"
    up_ours = {ours[name] for name in listed}
    up_theirs = {theirs[name] for name in js_array(read(ADAPTER_EVENTS_JS), "EVENTS_UP")}
    assert up_ours == up_theirs, (
        f"the interface listens for {sorted(up_ours - up_theirs)} which the "
        f"viewport never sends; the viewport sends "
        f"{sorted(up_theirs - up_ours)} which nothing listens for")


def test_every_up_event_has_a_handler():
    """Each name in UP_EVENTS is a key of the component's handler map.

    Declaring an event and never listening for it is the same failure from the
    other end, and it looks exactly like a feature that was never wired up —
    which, at that point, it is.
    """
    component = strip_comments(read(COMPONENT))
    missing = [name for name in js_array(read(EVENTS_JS), "UP_EVENTS")
               if f"[{name}]:" not in component]
    assert not missing, f"declared but never listened for: {missing}"


def test_every_handled_event_is_imported_from_events_js():
    """The handler map's keys are the constants, never anything local.

    A `[SOMETHING]:` key that resolves to a local variable would sail past the
    check above while listening for whatever that variable happened to hold.
    """
    component = read(COMPONENT)
    clause = re.search(r"\bimport\s*\{([^}]+)\}\s*from\s*'\./events\.js'",
                       component, flags=re.S)
    assert clause, "the component no longer imports its event names"
    imported = {part.strip() for part in clause.group(1).split(",") if part.strip()}
    used = set(re.findall(r"\[(\w+)\]:", strip_comments(component)))
    assert used <= imported, f"handler keys that are not event constants: {used - imported}"


# -- the element itself ------------------------------------------------------

@skip_without_adapter
def test_the_element_tag_is_spelled_in_one_place():
    """The tag the interface renders IS the tag the adapter defines, by import.

    The component renders it by name and waits on
    `customElements.whenDefined(...)`. A second spelling that disagreed would
    give an unknown element — an ordinary inline box with no error of any kind —
    and a promise that never settles, so the interface would wait forever without
    a symptom to search for. `ui/src/events.js` takes the name from the adapter,
    which makes that impossible; what is checked is that a second literal has not
    come back somewhere else.

    THE MODULE IT IS TAKEN FROM IS ALSO CHECKED, and that is a separate property
    from where the string is written. `viewport/events.js` declares names and
    runs nothing; `viewport/index.js` calls `customElements.define` at module
    scope. Sourcing the tag from the second one works perfectly and costs the
    guarantee below it — the registration stops depending on main.jsx's explicit
    import alone and starts depending on a re-export chain nothing announces.
    """
    declared = re.search(r"TAG\s*=\s*['\"]([\w-]+)['\"]", read(ADAPTER_EVENTS_JS))
    assert declared, "the adapter no longer names the tag"
    assert re.search(r"\bTAG\s+as\s+VIEWPORT_TAG\b.*?'\./viewport/events\.js'",
                     strip_comments(read(EVENTS_JS)), flags=re.S), (
        "ui/src/events.js no longer takes VIEWPORT_TAG from "
        "ui/src/viewport/events.js — either it spells the tag itself again, in "
        "which case the two can disagree silently, or it takes it from the "
        "module that defines the element, which drags the registration into "
        "every component that only wanted the name")
    strays = [str(path.relative_to(UI)) for path in ALL_UI_FILES
              if path != ADAPTER_EVENTS_JS
              and re.search(rf"""['"`]{re.escape(declared.group(1))}['"`]""",
                            strip_comments(read(path)))]
    assert not strays, f"the tag is spelled a second time in {strays}"


@skip_without_adapter
def test_the_adapter_is_imported_for_its_side_effect():
    """Something has to import the module that calls `customElements.define`.

    Nothing REFERENCES that import — it is there for the registration alone — so
    it looks removable to a reader and to any tool that prunes unused imports.
    Removing it breaks no build and throws nothing: the tag stays unknown, the
    frame stays empty, `whenDefined` never resolves.

    AND IT IS THE ONLY IMPORT OF THAT MODULE, which is what makes the line above
    worth defending. While the interface took the tag out of `viewport/index.js`
    there was a second path to the registration, so deleting this line looked
    harmless and WAS harmless — until the re-export it had come to depend on got
    rearranged, at which point the element stopped being defined for a reason
    nothing in either file mentions.
    """
    entry = strip_comments(read(UI / "main.jsx"))
    assert re.search(r"import\s+'\./viewport/index\.js'", entry), (
        "main.jsx no longer imports ./viewport/index.js, so nothing defines the element")
    others = [str(path.relative_to(UI)) for path in ALL_UI_FILES
              if path not in (UI / "main.jsx", VIEWPORT / "index.js")
              and re.search(r"""from\s+['"][^'"]*viewport/index\.js['"]""",
                            strip_comments(read(path)))]
    assert not others, (
        f"{others} import ui/src/viewport/index.js, so the element is registered "
        "as a side effect of wanting something else out of it. Whatever they are "
        "after belongs in a module that does not call customElements.define")


@skip_without_adapter
def test_every_class_the_viewport_sets_is_styled_here():
    """The viewport positions its elements; this stylesheet is what makes them visible.

    A pin is an empty `<div>` with a class on it. If the interface stops defining
    that class the pin is still created, still positioned, still clickable — and
    zero pixels across, which reads as "comments are not showing" rather than as
    a stylesheet that lost a rule.
    """
    styled = read(COMPONENT)
    wanted = {name for path in ADAPTER_FILES
              for value in re.findall(r"className\s*=\s*\"([^\"]+)\"", read(path))
              for name in value.split()}
    # Without this the check passes by finding nothing, which is how it would
    # behave the day the adapter sets its classes some other way.
    assert wanted, "no className assignments found in the adapter — has the shape changed?"
    missing = sorted(name for name in wanted if f".{name}" not in styled)
    assert not missing, f"the viewport sets these classes and nothing styles them: {missing}"


def test_the_library_stylesheet_is_still_on_the_page():
    """The viewer library ships its own CSS and the page must keep linking it.

    Neither half of the bundle can add it: the CSP forbids nothing here, but an
    `import` of it would make this build emit a second output file, which is the
    one thing ui/vite.config.mjs is built to prevent.
    """
    url = re.search(r"VIEWER_MODULE_URL\s*=\s*\"([^\"]+)\"",
                    read(VIEWPORT / "library.js")) if ADAPTER_FILES else None
    stylesheet = url.group(1).replace(".esm.js", ".css") if url else "/_v/three-cad-viewer.css"
    assert stylesheet in read(ROOT / "templates" / "build.html"), (
        f"templates/build.html no longer links {stylesheet}")


# -- the comment endpoint ----------------------------------------------------

def test_the_comment_post_goes_where_the_hub_listens():
    """The route in the component is the one src/app.py dispatches on.

    app.py matches on a list of path segments, so the URL the browser has to use
    is that list joined — derived here rather than repeated.
    """
    app = read(ROOT / "src" / "app.py")
    match = re.search(r'segments\[:3\]\s*==\s*\[([^\]]+)\]', app)
    assert match, "app.py no longer dispatches comments on a segment prefix"
    prefix = "/" + "/".join(re.findall(r'"([^"]+)"', match.group(1)))
    assert f"`{prefix}/" in read(COMPONENT), (
        f"the component does not post to {prefix}/<pid>/<commit>")


def test_the_attachment_field_names_are_the_hubs():
    """`photo` and `shot` are read out of src/comments.py by name.

    A part the hub does not recognise is not an error: `parts.get(kind)` simply
    returns None, the comment is stored without it, and the reader is told it
    was sent.
    """
    component = strip_comments(read(COMPONENT))
    for kind in (PHOTO_KIND, SHOT_KIND):
        assert f"'{kind}'" in component, f"nothing is appended as `{kind}`"


def test_the_comment_payload_only_uses_fields_the_hub_keeps():
    """`validate_payload` DROPS unknown keys without saying so.

    That is the quietest failure on this page: a field added to the payload
    reaches the hub, is discarded, and the sender sees a 201. Anything that has
    to survive the trip belongs in `text`.
    """
    kept = set(validate_payload({"text": "x"}, 100))
    body = re.search(r"form\.append\('comment',\s*JSON\.stringify\(\{(.*?)\}\)\)",
                     read(COMPONENT), flags=re.S)
    assert body, "the comment body is no longer one object literal"
    sent = set(re.findall(r"^\s*(\w+):", body.group(1), flags=re.M))
    assert sent <= kept, f"fields the hub will silently drop: {sorted(sent - kept)}"


# -- a spelling the migration retired ----------------------------------------

# What the badge beside the revision used to say about the `latest` pointer.
# Written here once, as a constant, so the only copy of it left in the
# repository is the one whose job is to make sure there are no others.
RETIRED_POINTER_BADGE = "follows CI"


def test_nothing_says_the_latest_pointer_still_follows_a_build_machine():
    """The retired badge, pinned out of the tree because nothing else could see it.

    `latest` was moved by a Gitea workflow once; it is moved by `hammerola
    commit` now, and the migration that changed that swept the pages, the
    templates and the documents for every sentence the change made false. It
    missed this one — and it missed it for a structural reason rather than
    carelessness. The string was not in a template, not in a document and not in
    a route: it was a VALUE computed inside a React component, one arm of a
    ternary in `computed()`, so no grep of the prose and no reading of a page
    would ever land on it. Nothing could point at it, which is exactly the
    condition this file exists for.

    THE TEXT IS THE WHOLE QUESTION HERE, which is why it is asked in Python
    against the source rather than in `ui/tests/`: the JS suite can assert what
    the badge SAYS TODAY (`header.test.js` does, on all three slots), and that is
    a different claim. "This spelling is gone from the repository" is not a value
    any of these files computes; it is a property of the text of all of them.

    COMMENTS ARE NOT EXEMPT, unlike most of this file, and the exception is
    deliberate — the same reasoning as
    `test_the_project_list_chooses_its_body_from_that_table`. A sentence
    explaining a wrong string by quoting it is how the string comes back:
    somebody greps for it later, finds it, and reads it as the current answer.
    Prose about this one therefore says what it says WITHOUT spelling it, the way
    the comment above `slotBadge` does.

    THE SWEEP REACHES THE CLIENT AND THE SERVED ASSETS, not just the bundle
    sources, because "what moves `latest`" is a sentence any of them could carry
    — the CLI prints its own explanations of the two pointers, and the committed
    page scripts are served to a browser exactly as they are. Only the vendored
    viewer is skipped: it is 3.5 MB of somebody else's build output, and nothing
    in it has ever heard of this hub.
    """
    swept = list(ALL_UI_FILES)
    swept += sorted((ROOT / "templates").glob("*.html"))
    swept += sorted(p for p in (ROOT / "static" / "_v").glob("*.js")
                    if p.name != "three-cad-viewer.esm.js")
    swept += sorted((ROOT / "src" / "client").rglob("*.py"))
    # Otherwise a moved directory turns this into a check that sweeps nothing and
    # passes — this file's own oldest failure mode.
    assert len(swept) > 20, f"the sweep found almost nothing to read: {swept}"

    strays = [str(path.relative_to(ROOT)) for path in swept
              if RETIRED_POINTER_BADGE in read(path)]
    assert not strays, (
        f"{strays} still say the `latest` pointer {RETIRED_POINTER_BADGE!r}. "
        "CI does not build models any more — the hub does, and `hammerola "
        "commit` is what moves that pointer")


# -- what the hub actually publishes -----------------------------------------

def test_every_meta_field_the_ui_reads_is_one_render_writes():
    """`meta.<field>` on the UI side against the keys src/render.py emits.

    A field that is not there reads as `undefined`, which renders as an empty
    string and formats as `NaN` — never as an error.

    TWO SPELLINGS COUNT AS WRITING A FIELD, and the second one had to be added
    the day a field became OPTIONAL. Most of meta.json is one dict literal, so
    `"field":` finds it; `notes` is emitted only when the build has any — an
    empty object there would be a build SAYING it has none, and no older build
    says anything at all — so it is written by subscript afterwards. Read with
    the literal spelling alone, this check called a field render.py demonstrably
    writes a field it does not, i.e. it failed on exactly the shape it exists to
    permit: a document whose keys are not all decided in one place.

    The subscript pattern is deliberately narrow — a string key assigned into a
    subscript, which in this module only ever happens to a document being
    assembled — rather than "any name that appears near an `=`".
    """
    render = read(ROOT / "src" / "render.py")
    written = (set(re.findall(r'"(\w+)":', render))
               | set(re.findall(r'\[\s*"(\w+)"\s*\]\s*=', render)))
    read_by_ui = set()
    for path in (COMPONENT, UI / "hub.js"):
        # `meta.json` is the FILE the fields come out of, not one of them, and it
        # is spelled the same way a field access is. Dropped by name rather than
        # by excluding the word `json`, so a field genuinely called `json` would
        # still be checked.
        source = strip_comments(read(path)).replace("meta.json", "")
        read_by_ui |= set(re.findall(r"\bmeta\.(\w+)", source))
    assert read_by_ui, "the UI stopped reading meta.json"
    assert read_by_ui <= written, (
        f"the UI reads fields render.py does not write: "
        f"{sorted(read_by_ui - written)}")


def test_every_index_card_field_the_ui_reads_is_one_render_writes():
    """`hub.projectCard` against the keys `render.index_card` actually emits.

    The same silent failure as the meta check above, on the other document: a
    field that is not there reads as `undefined`, renders as an empty string and
    formats as `NaN`, and nothing anywhere says why a card went blank. The front
    page is also where it would be least noticed, because a card that is merely
    missing its size or its date still looks like a card.

    Both halves are DERIVED, and the Python half is narrowed to this one function
    rather than swept from the whole module. `render.py` writes several documents
    and a union of all their keys would accept a field that exists on meta.json
    but never on a card — which is precisely the mistake available here, since
    the two are built from the same meta and share most of their names.
    """
    render = read(ROOT / "src" / "render.py")
    body = re.search(r"def index_card\(.*?\n    return \{(.*?)\n    \}",
                     render, flags=re.S)
    assert body, "src/render.py no longer returns index_card's dict literally"
    written = set(re.findall(r'"(\w+)":', body.group(1)))
    assert written, "index_card's returned object has no string keys any more"

    mapping = re.search(r"export function projectCard\(card\) \{(.*?)\n\}",
                        strip_comments(read(UI / "hub.js")), flags=re.S)
    assert mapping, (
        "ui/src/hub.js no longer maps a card in one function. That mapping is "
        "deliberately in one place so this check has something to read; spread "
        "through the JSX it cannot be checked against anything")
    read_by_ui = set(re.findall(r"\bcard\.(\w+)", mapping.group(1)))
    assert read_by_ui, "projectCard stopped reading any field off the card"

    assert read_by_ui <= written, (
        f"the front page reads card fields index_card does not write: "
        f"{sorted(read_by_ui - written)}")


def test_the_build_picker_reads_the_fields_builds_json_carries():
    """The picker's fallback object names exactly what builds.json has.

    It is the shape the component falls back to when builds.json is missing, so
    it is also the list of fields it expects when it is not.
    """
    render = read(ROOT / "src" / "render.py")
    written = set(re.findall(r'"(\w+)":', render))
    fallback = re.search(r"const info = s\.builds \|\| \{([^}]+)\}", read(COMPONENT))
    assert fallback, "the build picker no longer has a fallback shape"
    fields = set(re.findall(r"(\w+):", fallback.group(1)))
    assert fields <= written, (
        f"the picker expects fields builds.json does not carry: "
        f"{sorted(fields - written)}")


# -- one output file ---------------------------------------------------------

def test_nothing_splits_the_bundle():
    """No dynamic import and no imported stylesheet, either of which adds a file.

    The one exception is marked in the source with `@vite-ignore`, which is what
    turns an unanalysable specifier into a deliberate one: vite leaves it as a
    runtime URL rather than emitting a chunk for it.
    """
    offenders = []
    for path in INTERFACE_FILES + ADAPTER_FILES:
        raw = read(path).splitlines()
        # Detect on the stripped line so prose about imports is not an import;
        # look for the exemption on the RAW one, because the exemption IS a
        # comment. strip_comments keeps the two in step line for line.
        for number, line in enumerate(strip_comments(read(path)).splitlines()):
            marker = raw[number] if number < len(raw) else ""
            if re.search(r"(?<![\w.])import\s*\(", line) and "@vite-ignore" not in marker:
                offenders.append(f"{path.name}:{number + 1} dynamic import")
            if re.search(r"import\s+['\"][^'\"]+\.css['\"]", line):
                offenders.append(f"{path.name}:{number + 1} stylesheet import")
    assert not offenders, f"these would make the build emit a second file: {offenders}"


# -- the page's own CSP ------------------------------------------------------

# The one absolute URL in the UI that is not an address. `createElementNS` takes
# an XML NAMESPACE NAME, and a namespace name is an identifier that happens to be
# spelled as a URL — nothing dereferences it, no request is ever made for it, and
# the CSP therefore has nothing to say about it. The viewport draws the view cube
# as SVG built element by element, and this is the only way to build one.
#
# Enumerated rather than pattern-matched on purpose: `www.w3.org` as a prefix
# would also wave through a stylesheet or an image from that host, which is
# exactly the thing below is for.
XML_NAMESPACES = {"http://www.w3.org/2000/svg"}


def test_no_external_urls_in_the_ui():
    """`default-src 'self'` — an absolute URL to another host is blocked.

    The mock-up this was ported from linked IBM Plex from Google Fonts. It does
    not fail anything at build time; it simply never loads, and the page falls
    back to a system font that looks deliberate.
    """
    offenders = {}
    for path in INTERFACE_FILES + ADAPTER_FILES:
        found = [url for url in re.findall(r"https?://[^\s'\"`)]+",
                                           strip_comments(read(path)))
                 if url not in XML_NAMESPACES]
        if found:
            offenders[path.name] = found
    assert not offenders, f"absolute URLs the CSP will block: {offenders}"


def test_the_svg_namespace_is_named_in_exactly_one_place():
    """The exemption above is one construct in one file, so pin it as one.

    `test_no_external_urls_in_the_ui` waves the namespace through wherever it
    appears, in any of the UI's files and in any context — a filter far wider
    than the reason for it, which is a single `const SVG_NS = ...` in the view
    cube. This is the guard against the day it is copied: a second module
    spelling the same string would still pass the filter, and so would a fetch,
    an `<img src>` or a stylesheet link built out of it in viewcube.js itself.
    """
    ns, = XML_NAMESPACES
    users = [p.name for p in INTERFACE_FILES + ADAPTER_FILES
             if ns in strip_comments(read(p))]
    assert users == ["viewcube.js"], (
        f"the SVG namespace is spelled in {users} — it belongs in viewcube.js, "
        f"and the exemption in test_no_external_urls_in_the_ui covers only that")

    source = strip_comments(read(VIEWPORT / "viewcube.js"))
    assert re.search(rf'\bconst\s+SVG_NS\s*=\s*["\']{re.escape(ns)}["\']', source), (
        "viewcube.js no longer names the SVG namespace as the initialiser of "
        "SVG_NS — the exemption is written for that one construct")
    assert source.count(ns) == 1, (
        "viewcube.js spells the SVG namespace more than once; only the SVG_NS "
        "initialiser is exempt")


def test_no_fonts_are_fetched_at_all():
    """Not even in a comment, for this one host.

    `fonts.googleapis.com` is the specific thing the mock-up carried, so the
    check that it did not survive the port is worth being blunt about.
    """
    for path in INTERFACE_FILES + ADAPTER_FILES:
        assert "fonts.googleapis" not in read(path), f"{path.name} pulls Google Fonts"


def test_nothing_fetches_a_data_url():
    """`connect-src` inherits `default-src 'self'`, and `data:` is not 'self'.

    Decoding one by hand is fine and the viewport does exactly that; handing one
    to `fetch` is what fails, and it fails only in the browser.
    """
    for path in INTERFACE_FILES + ADAPTER_FILES:
        source = strip_comments(read(path))
        assert not re.search(r"fetch\(\s*['\"`]data:", source), (
            f"{path.name} fetches a data: URL")
        assert not re.search(r"(?:src|href)\s*=\s*['\"`]?\{?\s*['\"`]data:", source), (
            f"{path.name} points an element at a data: URL")


# -- markup is never built from a string -------------------------------------

def test_nothing_writes_markup():
    """No `innerHTML`, no `dangerouslySetInnerHTML`, anywhere in the UI.

    Everything on these pages comes out of a PUSHED meta.json, view file or
    index card — a part name, a title, a filename — and every project on this
    host shares one origin. React escaping text is the whole defence, and it
    holds only as long as nobody builds markup out of a string.

    THE OTHER HALF OF THIS RULE is
    tests/test_comments.py::test_the_committed_page_scripts_never_build_markup_from_a_string,
    which reads the committed page scripts the same way. Two checks because the
    two halves can only be made differently — this one strips comments from
    source, that one reads files as they ship — and between them they have to
    cover every script the site runs. The forbidden list is kept in step with
    that one deliberately: `.outerHTML` is on it because it is there, not because
    anything here has ever used it, and a rule that is narrower on one side than
    the other is a gap nobody would find by reading either file alone.
    """
    offenders = []
    for path in INTERFACE_FILES + ADAPTER_FILES:
        source = strip_comments(read(path))
        if re.search(r"\.(?:inner|outer)HTML\s*=", source):
            offenders.append(f"{path.name}: innerHTML/outerHTML")
        if "dangerouslySetInnerHTML" in source:
            offenders.append(f"{path.name}: dangerouslySetInnerHTML")
        if re.search(r"insertAdjacentHTML|document\.write\(", source):
            offenders.append(f"{path.name}: writes markup")
    assert not offenders, f"markup built from a string: {offenders}"


# -- browser storage ---------------------------------------------------------

def test_localstorage_is_touched_in_one_place_only():
    """One module, so there is one place to audit for the try/catch below.

    The viewport keeps its own answers — the pointing device and the canvas
    theme, both in `viewport/options.js` — and is exempt: that is a separate
    module with its own guard, and the rule is one place PER SIDE, not one place
    in the repository.
    """
    users = [p.name for p in INTERFACE_FILES
             if "localStorage" in strip_comments(read(p))]
    assert users == ["store.js"], (
        f"localStorage is reached from {users} — it belongs in store.js")


def test_every_localstorage_access_is_guarded():
    """A private window THROWS on the property itself, not on the call.

    So this cannot be checked by looking at the return value anywhere: an
    unguarded read happens during render and takes the whole interface down over
    a remembered preference.
    """
    for path in INTERFACE_FILES + ADAPTER_FILES:
        lines = strip_comments(read(path)).splitlines()
        for number, line in enumerate(lines):
            if "localStorage" not in line:
                continue
            # The nearest `try {` above, within the block a guard can plausibly
            # cover. Deliberately short: a `try` twenty lines up is not a guard
            # anybody can see from the access.
            window = lines[max(0, number - 6):number]
            assert any("try {" in earlier for earlier in window), (
                f"{path.name}:{number + 1} touches localStorage outside a try")

# -- the arrangement of the project list -------------------------------------
#
# ONE CHECK, and what is NOT here is the point. The four key sets that have to
# agree — `PROJECT_SORTS` / `PROJECT_VIEWS` in store.js against `SORT_LABELS`,
# `SORT_CMP`, `VIEW_ICONS` and `VIEW_BODIES` in HammerolaEntry.jsx — used to be
# compared here, by matching braces and reading the words after commas. That
# check passed on the very defect it was written for: `strip_comments()` above
# removes whole-line comments only (deliberately, and its docstring says so), so
# a TRAILING `// oldest project, parts come from metrics` put a comma at depth
# zero and the parser took the next word for a key. It failed the other way too,
# on a comma inside a perfectly ordinary label string.
#
# The tables are exported now and `ui/tests/vocabulary.test.js` compares
# `Object.keys` against the two lists — the same invariant, at the same moment,
# with the whole class of parsing mistakes simply absent. A set of keys is
# something the language computes; guessing at it from the text was never the
# cheaper answer, only the closer one.
#
# What stays here is the property that IS about the text: a set of names must
# have one spelling, and a branch on a view id is a second spelling that no
# comparison of exported values can see, because a branch is not a value.


def test_the_project_list_chooses_its_body_from_that_table():
    """No view id is written down in the page except as the default it opens on.

    `{grid && …}` / `{!grid && …}` is how two of the four sets used to be
    written, and it drew the dense list for every id that was not `grid`, so an
    unknown view LOOKED like a working answer. The same shape can come back at
    any time, and nothing that compares exported tables would notice: the tables
    would still be complete and still agree, while the render ignored them.

    THE RULE IS ABOUT THE LITERAL, NOT ABOUT AN OPERATOR, and that is the third
    version of it. Forbidding `this.view === 'grid'` meant enumerating ways to
    write a comparison, and the enumeration was never finished: the first version
    missed `'grid' === this.view`, and the second still let through both

        switch (this.view) { case 'grid': … }
        const v = this.view; const body = v === 'grid' ? … : …

    each of which reproduces exactly the property this test is about. A view id
    is a name the tables are keyed by; the page has no business writing one down
    at all, except to say which one it opens on. That single rule covers the
    switch, the alias, the Yoda spelling and every operator nobody has thought
    of yet.

    COMMENTS ARE NOT STRIPPED, deliberately, and this is where the operator
    version was actively harmful: it failed on a trailing comment quoting the
    spelling it forbade, i.e. on somebody documenting it. Under this rule a
    literal in a comment IS the violation — say `the grid view` and not
    `'grid'`, the same way the rest of this file's prose does.

    ALL THREE QUOTE CHARACTERS, backtick included. A template literal with no
    substitution in it is an ordinary string, and `this.view === \\`grid\\`` is the
    same branch; leaving the backtick out would have repeated one floor down
    exactly the mistake this rule was written to end — an incomplete enumeration,
    of quotes instead of operators.

    THE ALLOWED REGION IS THE DECLARATION, NOT THE LINE. Anchoring on "the line
    also contains defaultProps" meant a purely cosmetic wrap of that declaration
    — a fourth prop, a formatter — failed this test with a message about
    branching, which is the same species of harm the operator version did when it
    failed on a comment. The span of each `static defaultProps = { … };` is
    computed instead, so the declaration may be written over as many lines as it
    likes.
    """
    page = read(UI / "HammerolaEntry.jsx")
    views = {item.strip("'\"") for item in js_array(strip_comments(read(UI / "store.js")),
                                                    "PROJECT_VIEWS")}
    assert views, "store.js no longer declares PROJECT_VIEWS"

    # Every defaultProps in the file, not only this component's: a view id inside
    # any of them is a default being declared, which is the one thing allowed.
    # A nested object would end the span early at its inner `};` — and that fails
    # loudly here rather than passing something through, which is the right way
    # round for a bound this rough.
    allowed = [match.span() for match
               in re.finditer(r"static\s+defaultProps\s*=\s*\{.*?\}\s*;", page, flags=re.S)]
    assert allowed, "HammerolaEntry.jsx declares no defaultProps at all"

    seen = 0
    for view in views:
        for found in re.finditer(rf"['\"`]{re.escape(view)}['\"`]", page):
            seen += 1
            if any(start <= found.start() < end for start, end in allowed):
                continue
            number = page.count("\n", 0, found.start()) + 1
            line = page.splitlines()[number - 1]
            raise AssertionError(
                f"HammerolaEntry.jsx:{number} writes the view id '{view}' down: "
                f"{line.strip()!r}. The views are a set of names keyed into "
                "VIEW_BODIES / VIEW_ICONS, and the page names one only in its "
                "defaultProps — anywhere else is a branch, an alias or a switch "
                "that the tables cannot see, which is how an unknown view came to "
                "look like a working answer")
    # Otherwise a file that stopped naming any view would pass by having nothing
    # to find, which is this file's own oldest failure mode.
    assert seen, ("HammerolaEntry.jsx names no view at all — defaultProps has to say "
                  "which one the page opens on")
