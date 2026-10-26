"""What the browser UI cannot check about itself, checked from Python.

Everything here reads source as TEXT, which answers one kind of question: "does
this spelling appear where it must not". Anything about a VALUE the language can
compute — a set of keys, a colour, a font stack, SVG path attributes — belongs in
`ui/tests/` (vitest, run by CI; e.g. `vocabulary.test.js`, `chrome.test.js`),
where it is imported and executed. A text check can match prose or misparse a
`//` comment, and `strip_comments()` removes whole-line comments only.

What stays here is where two files must agree and nothing makes them, each a
silent failure (the build is green, one feature is inert):

  * the interface (`ui/src/`) and the viewport (`ui/src/viewport/`) talk over
    window events; a misspelt name is silence. The names have one source,
    `ui/src/viewport/events.js`, which the interface imports under aliases; the
    checks keep a second spelling from appearing;

  * the comment form posts to a route with field names the hub decides; a rename
    gets a 404 or a 422 with the text already typed;

  * the bundle must stay ONE output file, because five files copy it by name (see
    ui/vite.config.mjs); a dynamic import or imported stylesheet adds a second;

  * the page is served under `default-src 'self'` (src/app.py), so an external
    font or CDN reference is silently blocked in production.

Every check derives both halves from the files rather than carrying a copy.
"""

import re
from pathlib import Path

import pytest

from src.app import POST_ROUTES
from src.comments import PHOTO_KIND, SHOT_KIND, validate_payload
from src.records import MAX_FIELD_CHARS

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui" / "src"
VIEWPORT = UI / "viewport"

# The interface's own sources: everything under ui/src that is not the viewport
# adapter. Discovered, so a new module is covered automatically.
INTERFACE_FILES = sorted(p for p in UI.glob("*.js*") if p.is_file())
ADAPTER_FILES = sorted(VIEWPORT.glob("*.js")) if VIEWPORT.is_dir() else []

# Every source that reaches the bundle, at any depth: the rule about where a name
# may be spelled has no exceptions by directory.
ALL_UI_FILES = sorted(p for p in UI.rglob("*.js*") if p.is_file())

# The palette: one file, every page links it, and every `var(--…)` the interface
# spends has to name something in it.
TOKENS_CSS = ROOT / "static" / "_v" / "tokens.css"

EVENTS_JS = UI / "events.js"
ADAPTER_EVENTS_JS = VIEWPORT / "events.js"
COMPONENT = UI / "HammerolaViewer.jsx"
# What both build pages fetch, post and draw comments with.
COMMENTS = UI / "comments.jsx"

# `const NAME = "hmr:thing";` — the shape the ONE event module is written in.
EVENT_DECL = re.compile(r"""(?:export\s+)?const\s+(\w+)\s*=\s*["'](hmr:[a-z]+)["']""")

# `EVENT_PICK as PICK` — how the interface takes a name it did not spell.
EVENT_ALIAS = re.compile(r"\b(EVENT_[A-Z]+)\s+as\s+(\w+)\b")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# `from './chromeview.js'` — a sibling module, as the interface imports one.
SIBLING_IMPORT = re.compile(r"""from\s+['"]\./([\w./]+\.jsx?)['"]""")


def _sibling_imports(path: Path) -> set[Path]:
    """Every `./x.js` this file imports, RESOLVED against its own directory.

    Resolved, not compared as text: five files under `ui/src/viewport/` import
    their own `./events.js`. Comments are stripped because `viewport/index.js`
    names `./events.js` in prose.

    Only `from` imports. The one side-effect import (`main.jsx` →
    `./viewport/index.js`) is outside the set anyway; a missed consumer keeps a
    module in the swept set, so this gap fails towards checking more.
    """
    return {(path.parent / name).resolve()
            for name in SIBLING_IMPORT.findall(strip_comments(read(path)))}


def page_draws_with() -> list[Path]:
    """Everything the build page draws with: the component and what it imports.

    Derived, not listed: a list goes stale towards checking less. Reached rather
    than owned, so modules the front page also imports (`style.jsx`,
    `panelstyle.js`, `store.js`, `hub.js`) are swept too: a colour in
    `panelstyle.js` is a colour on this page. Transitive, so a module a panel
    imports is included.

    Only direct children of ui/src and only `from` imports; `ui/src/viewport/` is
    its own layer. Panels moved into a subdirectory would silently leave the
    sweep.
    """
    seen: set[Path] = set()
    todo = [COMPONENT]
    while todo:
        for path in _sibling_imports(todo.pop()):
            if path.is_file() and path.parent == UI and path not in seen:
                seen.add(path)
                todo.append(path)
    # The floor is asserted here: the callers' backstop ("does the page spend a
    # palette token") is satisfied by HammerolaViewer.jsx alone.
    assert seen, (
        "page_draws_with() found nothing but the component. The derivation has "
        "gone dark, so every check that takes it is back to sweeping one file")
    return [COMPONENT] + sorted(seen)


def strip_comments(source: str) -> str:
    r"""Source with `//` and `/* */` comments removed.

    Comments may break this file's rules: a URL named in prose is not a fetch.
    Every content check runs on what executes.

    Line numbers are preserved (a block comment becomes blank lines), so a check
    may report a line and read the raw line beside the stripped one —
    `test_nothing_splits_the_bundle` needs that for `/* @vite-ignore */`.

    Only whole-line `//` comments go: a trailing pattern would eat `https://`
    inside a string. `[ \t]`, not `\s`, in that pattern: `\s` matches the
    newline and would delete the blank line before a comment
    (`test_strip_comments_keeps_every_file_line_for_line`).
    """
    source = re.sub(r"/\*.*?\*/",
                    lambda m: re.sub(r"[^\n]", " ", m.group(0)), source, flags=re.S)
    return re.sub(r"^[ \t]*//.*$", "", source, flags=re.M)


def declared_events(path: Path) -> dict:
    """{constant name: event name} for the module that declares them."""
    return {name: value for name, value in EVENT_DECL.findall(read(path))}


def interface_events() -> dict:
    """{the name the interface uses: the `hmr:` string behind it}.

    The interface imports the adapter's constants under aliases
    (`EVENT_PICK as PICK`), so the value is looked up in the adapter; an alias
    for a constant the adapter does not export fails.
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

    `Object.freeze(` is optional so freezing an array does not break this
    reader. A miss asserts rather than returning an empty list, which every
    caller's sweep would pass.
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
    """Every check below sweeps a discovered list, and an empty list passes them all.

    So the modules the checks are about are named here, and their absence is a
    failure rather than a quiet skip.
    """
    names = {path.name for path in INTERFACE_FILES}
    assert {"HammerolaViewer.jsx", "HammerolaEntry.jsx", "events.js", "hub.js",
            "main.jsx", "store.js", "style.jsx"} <= names, (
        f"ui/src no longer holds the interface: {sorted(names)}")
    if not ADAPTER_FILES:
        pytest.skip("ui/src/viewport/ is empty — the cross-checks skip honestly")
    assert (VIEWPORT / "events.js").exists(), "the adapter is there but names no events"


def test_strip_comments_keeps_every_file_line_for_line():
    """`strip_comments` preserves the line count of every file.

    `test_nothing_splits_the_bundle` reads the raw line beside a stripped one,
    and any reported line number is the stripped file's.
    """
    short = {path.name: len(read(path).splitlines())
             - len(strip_comments(read(path)).splitlines())
             for path in ALL_UI_FILES
             if len(strip_comments(read(path)).splitlines())
             != len(read(path).splitlines())}
    assert not short, (
        f"strip_comments changed the line count of {short} — every check that "
        f"reports a line number now reports the wrong one, and the ones that "
        f"read the raw line beside the stripped one read a different line")


# -- the event contract ------------------------------------------------------

@skip_without_adapter
def test_one_module_spells_every_event_name():
    """No `hmr:` literal ANYWHERE under ui/src except viewport/events.js.

    `ui/src/events.js` imports the adapter's constants under aliases; this keeps
    a second source (a literal typed at a call site) from coming back. Comments
    are exempt: prose about `hmr:model` dispatches nothing.
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

    Direction is what a shared import does not settle: `UP_EVENTS` (what the
    interface listens for) and `EVENTS_UP` (what the viewport sends) are written
    independently.
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
    """Each name in UP_EVENTS is a key of the component's handler map."""
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

    A second spelling that disagreed would be an unknown inline element and a
    `customElements.whenDefined(...)` that never settles, with no symptom.

    The source module is checked too: `viewport/events.js` declares names and
    runs nothing, while `viewport/index.js` calls `customElements.define` at
    module scope. Taking the tag from the latter would make registration depend
    on a re-export chain instead of main.jsx's explicit import.
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

    Nothing references that import, so it looks removable; removing it throws
    nothing, the tag stays unknown and `whenDefined` never resolves. It must be
    the only import of that module, so registration does not hinge on a
    side effect of importing something else.
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

    The measurement label is a `<div>` with a class on it. If the interface stops
    defining that class the label is still created and still positioned — and
    drawn in the browser's defaults, which reads as a broken measurement rather
    than as a stylesheet that lost a rule.
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

class _Reached:
    """A stand-in handler that remembers which of its methods were asked for."""

    def __init__(self):
        self.names = []

    def __getattr__(self, name):
        self.names.append(name)
        return lambda *args, **kwargs: None


def test_the_comment_post_goes_where_the_hub_listens():
    """The route the pages post a comment to is the one src/app.py dispatches on.

    app.py matches on a prefix of path segments, so the URL the browser has to
    use is that prefix joined — derived here rather than repeated. The entry is
    the one of `POST_ROUTES` whose `call` reaches `_handle_comment_post`, asked
    of the call itself, so its place in the table does not decide which is read.
    """
    leading = []
    for (prefix, count), call in POST_ROUTES:
        reached = _Reached()
        call(reached, ["probe"] * ((count or len(prefix) + 1) - len(prefix)),
             "", False, True)
        if "_handle_comment_post" in reached.names:
            leading.append(prefix)
    assert len(leading) == 1, (
        f"expected one POST_ROUTES entry to reach _handle_comment_post, "
        f"found {leading}")
    prefix = "/" + "/".join(leading[0])
    assert f"`{prefix}/" in read(COMMENTS), (
        f"the pages do not post to {prefix}/<pid>/<commit>")


def test_the_attachment_field_names_are_the_hubs():
    """`photo` and `shot` are read out of src/comments.py by name.

    A part the hub does not recognise is not an error: `parts.get(kind)` simply
    returns None, the comment is stored without it, and the reader is told it
    was sent.
    """
    component = strip_comments(read(COMMENTS))
    for kind in (PHOTO_KIND, SHOT_KIND):
        assert f"'{kind}'" in component, f"nothing is appended as `{kind}`"


def test_the_comment_payload_only_uses_fields_the_hub_keeps():
    """`validate_payload` DROPS unknown keys without saying so.

    That is the quietest failure on this page: a field added to the payload
    reaches the hub, is discarded, and the sender sees a 201. Anything that has
    to survive the trip belongs in `text`. The body is an object literal, one
    for a comment on the model and one for a comment on a document; the keys
    of both are read.
    """
    kept = set(validate_payload({"text": "x"}, 100))
    body = re.search(r"form\.append\('comment',\s*JSON\.stringify\((.*?)\)\);",
                     read(COMMENTS), flags=re.S)
    assert body, "the comment body is no longer appended as one JSON.stringify call"
    sent = set(re.findall(r"^\s*(\w+):", body.group(1), flags=re.M))
    assert sent <= kept, f"fields the hub will silently drop: {sorted(sent - kept)}"


def test_a_gerber_comment_layer_note_fits_the_hubs_one_line_field():
    """`layerNote` cuts a comment's `layer` to `LAYER_NOTE_CHARS`; the hub
    answers a one-line field longer than `MAX_FIELD_CHARS` with a 422, and the
    comment is not stored at all."""
    declared = re.search(r"export\s+const\s+LAYER_NOTE_CHARS\s*=\s*(\d+)\s*;",
                         read(UI / "gerber.js"))
    assert declared, "gerber.js no longer declares LAYER_NOTE_CHARS"
    assert int(declared.group(1)) == MAX_FIELD_CHARS


# -- what the hub actually publishes -----------------------------------------

def test_every_meta_field_the_ui_reads_is_one_render_writes():
    """`meta.<field>` on the UI side against the keys src/render.py emits.

    A missing field reads as `undefined`, renders empty and formats as `NaN`,
    never as an error.

    Two spellings count as writing a field: `"field":` in the main dict literal,
    and a subscript assignment for optional fields emitted only when present
    (`notes`). The subscript pattern is deliberately narrow.
    """
    render = read(ROOT / "src" / "render.py")
    written = (set(re.findall(r'"(\w+)":', render))
               | set(re.findall(r'\[\s*"(\w+)"\s*\]\s*=', render)))
    read_by_ui = set()
    # Every file under ui/src, not `page_draws_with()`: "no `meta.x` anywhere
    # that render.py does not write" is stronger and needs no derivation.
    for path in ALL_UI_FILES:
        # `meta.json` is the file, not a field; dropped by name so a field called
        # `json` would still be checked.
        source = strip_comments(read(path)).replace("meta.json", "")
        read_by_ui |= set(re.findall(r"\bmeta\.(\w+)", source))
    assert read_by_ui, "the UI stopped reading meta.json"
    assert read_by_ui <= written, (
        f"the UI reads fields render.py does not write: "
        f"{sorted(read_by_ui - written)}")


def test_every_index_card_field_the_ui_reads_is_one_render_writes():
    """`hub.projectCard` against the keys `render.index_card` actually emits.

    The same silent failure as the meta check, on the front page, where a card
    missing its size or date still looks like a card. The Python half is narrowed
    to `index_card`: a union of all render.py's keys would accept a meta.json
    field that never appears on a card.
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


def test_the_assembled_view_is_spelled_the_same_on_both_sides_of_the_wire():
    """`assembled` is spelled the same in JavaScript and in Python.

    The build refuses a model with no view under this id
    (`views.prepare_views`). The interface compares the current view's id against
    its own copy to decide whether a cross-part distance is a real gap or a
    print-layout artefact; a rename would silently label every cross-part
    measurement as belonging to the current layout. Single-part measurements
    (`crossPart: false`) are unaffected. The Python constant lives in
    `artifacts.py`.
    """
    from src.cadbuild.artifacts import ASSEMBLED_VIEW_ID

    declared = re.search(r"export\s+const\s+ASSEMBLED_VIEW_ID\s*=\s*['\"`]([^'\"`]+)['\"`]",
                         strip_comments(read(UI / "hub.js")))
    assert declared, (
        "ui/src/hub.js no longer declares ASSEMBLED_VIEW_ID as a plain literal. "
        "It has to stay one: this check reads it as text, because the Python "
        "side of the pair cannot be imported into the JS suite")
    assert declared.group(1) == ASSEMBLED_VIEW_ID, (
        f"ui/src/hub.js calls the assembled view {declared.group(1)!r} and "
        f"src/cadbuild/artifacts.py calls it {ASSEMBLED_VIEW_ID!r}: every "
        f"cross-part measurement on a build page would be labelled as taken in "
        f"the current layout, on a page that is showing the assembly")


def test_the_compare_legend_says_what_the_hub_says_not_compared_means():
    """One explanation of one word, written on both sides of the wire.

    The hub writes the sentence onto every `not compared` row of report.json
    (`comparescene._uncovered_line`); the panel draws it once, in the legend,
    rather than on every row. So the legend is that sentence, and this keeps the
    two from drifting. (Hardware and mocks do not define the term: a part that
    changed kind between revisions is also not compared.)

    The em dash is the one difference allowed: the hub's strings are ASCII (its
    reasons travel through job logs).
    """
    from src.cadbuild.comparescene import _uncovered_line

    declared = re.search(r"const NOT_COMPARED_WHY =(.+?);",
                         strip_comments(read(COMPONENT)), flags=re.S)
    assert declared, (
        "ui/src/HammerolaViewer.jsx no longer declares NOT_COMPARED_WHY. The "
        "legend's sentence has to stay a named literal: it is the hub's "
        "sentence said once, and this check reads it as text because the "
        "Python side cannot be imported into the JS suite")
    legend = "".join(re.findall(r"'([^']*)'", declared.group(1)))
    assert legend, "NOT_COMPARED_WHY is no longer built out of string literals"

    assert legend.replace("—", "--") == _uncovered_line("part")["reason"], (
        "the legend and report.json explain `not compared` differently, so the "
        "reader is told one thing by the panel and another by the document")


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
        # Detect on the stripped line (prose is not an import); look for the
        # exemption on the raw one, because it is a comment.
        for number, line in enumerate(strip_comments(read(path)).splitlines()):
            marker = raw[number] if number < len(raw) else ""
            if re.search(r"(?<![\w.])import\s*\(", line) and "@vite-ignore" not in marker:
                offenders.append(f"{path.name}:{number + 1} dynamic import")
            if re.search(r"import\s+['\"][^'\"]+\.css['\"]", line):
                offenders.append(f"{path.name}:{number + 1} stylesheet import")
    assert not offenders, f"these would make the build emit a second file: {offenders}"


# -- the page's own CSP ------------------------------------------------------

# The one absolute URL in the UI that is not an address: `createElementNS` takes
# an XML namespace name, which nothing dereferences, so the CSP does not apply.
# The viewport builds the view cube as SVG. Enumerated, not a `www.w3.org`
# prefix, which would admit real requests to that host.
XML_NAMESPACES = {"http://www.w3.org/2000/svg"}


def test_no_external_urls_in_the_ui():
    """`default-src 'self'` — an absolute URL to another host is blocked, with no
    build-time failure; a font would silently fall back to a system one."""
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

    The URL filter waves the namespace through anywhere; this keeps it to the
    single `const SVG_NS = ...` in viewcube.js, so a copy elsewhere, or a fetch
    or `<img src>` built from it, fails.
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
    """Not even in a comment, for `fonts.googleapis.com`, which the mock-up the
    UI was ported from linked."""
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

    Everything on these pages comes from a pushed meta.json, view file or index
    card, and every project shares one origin; React's text escaping is the
    defence only while nobody builds markup from a string.

    The other half of this rule is
    tests/test_comments.py::test_the_committed_page_scripts_never_build_markup_from_a_string,
    for the committed page scripts as they ship. The forbidden list is kept in
    step with that one (hence `.outerHTML`).
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

    One place per side: the viewport keeps its pointing-device answer in
    `viewport/wheel.js` with its own guard and is exempt. The theme is a cookie
    in store.js because the server needs it before the page is sent (see the
    two tests below).
    """
    users = [p.name for p in INTERFACE_FILES
             if "localStorage" in strip_comments(read(p))]
    assert users == ["store.js"], (
        f"localStorage is reached from {users} — it belongs in store.js")


def test_the_cookie_is_touched_in_one_place_only():
    """The theme is the one thing kept in a cookie, and one module writes it.

    Stricter than the localStorage rule: a cookie is sent to the hub on every
    request, and the server reads it by a name that must match `src/render.py`.
    """
    users = [p.name for p in INTERFACE_FILES + ADAPTER_FILES
             if "document.cookie" in strip_comments(read(p))]
    assert users == ["store.js"], (
        f"document.cookie is reached from {users} — it belongs in store.js")


# -- the address and the browser's history ------------------------------------

# A call whose first argument is the event `popstate`: `addEventListener`,
# `removeEventListener`, `window[method]`. Not the bare word, which KicadView.jsx
# compares `window.event.type` against.
POPSTATE_LISTENER = re.compile(r"""\(\s*['"]popstate['"]\s*,|onpopstate""")


def test_history_is_written_and_followed_in_one_place_only():
    """address.js writes every entry of the browser's history (`navigate`) and
    holds the one `popstate` listener, which hands the address to subscribers.
    A page writing an entry itself would spell the address a second way, and a
    listener of its own would run outside the order the subscribers keep."""
    users = {}
    for path in ALL_UI_FILES:
        source = strip_comments(read(path))
        found = [word for word in ("pushState", "replaceState") if word in source]
        found += ["a popstate listener"] if POPSTATE_LISTENER.search(source) else []
        if found:
            users[path.name] = found
    assert users == {"address.js": ["pushState", "replaceState", "a popstate listener"]}, (
        f"the history is written or followed from {users} — it belongs in address.js")


def test_every_cookie_access_is_guarded():
    """`document.cookie` is an accessor, and a sandboxed frame throws on it.

    It is read while the page is built, so an uncaught throw is a blank page.
    """
    for path in INTERFACE_FILES + ADAPTER_FILES:
        lines = strip_comments(read(path)).splitlines()
        for number, line in enumerate(lines):
            if "document.cookie" not in line:
                continue
            # A `try {` within the few lines above, the same window the
            # localStorage check uses.
            window = lines[max(0, number - 6):number]
            assert any("try {" in earlier for earlier in window), (
                f"{path.name}:{number + 1} touches document.cookie outside a try")


def test_the_browser_and_the_hub_spell_the_theme_the_same_way():
    """The cookie name and theme values match between store.js and render.py.

    The hub stamps `data-theme` on `<html>` from this cookie before the page is
    sent, and the interface writes it on toggle. Drift is silent: the chosen
    theme stops surviving navigation. The Python side is imported, the
    JavaScript side read as text.
    """
    from src.render import DEFAULT_THEME, THEME_COOKIE, THEMES

    store = strip_comments(read(UI / "store.js"))
    namespace = re.search(r"const NS = '([^']+)'", store)
    assert namespace, "ui/src/store.js no longer declares the `hammerola.` namespace"
    built = re.search(r"const THEME_COOKIE = `\$\{NS\}([^`$]*)`", store)
    assert built, (
        "ui/src/store.js no longer builds the theme cookie's name out of NS")
    assert namespace.group(1) + built.group(1) == THEME_COOKIE, (
        f"the interface writes `{namespace.group(1) + built.group(1)}` and "
        f"src/render.py reads `{THEME_COOKIE}`")

    themes = re.search(r"THEMES = Object\.freeze\(\[([^\]]*)\]\)", store)
    assert themes, "ui/src/store.js no longer declares the two themes"
    assert tuple(re.findall(r"'([^']+)'", themes.group(1))) == THEMES, (
        f"the interface knows themes {themes.group(1)} and src/render.py knows "
        f"{THEMES} — a value one side accepts and the other corrects away is a "
        f"page that arrives in one theme and repaints into the other")

    default = re.search(r"DEFAULT_THEME = '([^']+)'", store)
    assert default, "ui/src/store.js no longer declares the default theme"
    assert default.group(1) == DEFAULT_THEME, (
        f"a browser with no cookie opens on {default.group(1)!r} and the hub "
        f"sends {DEFAULT_THEME!r}")


def test_the_browser_walks_a_part_tree_as_deep_as_the_hub_publishes_one():
    """The interface's `MAX_DEPTH` equals the hub's MAX_VIEW_DEPTH.

    The hub refuses a view nesting parts deeper than MAX_VIEW_DEPTH. A browser
    ceiling below it is silent: `walk` answers `null` past it, so the deepest
    parts of an accepted model are missing from the tree panel. The Python side
    is imported, the JavaScript side read as text.
    """
    from src.render import MAX_VIEW_DEPTH

    source = strip_comments(read(UI / "hub.js"))
    declared = re.search(r"const MAX_DEPTH = (\d+);", source)
    assert declared, (
        "ui/src/hub.js no longer declares MAX_DEPTH as a plain literal, so "
        "this check is reading nothing. It is the ceiling the part-tree walk "
        "stops at; pin it against src/render.MAX_VIEW_DEPTH however it is "
        "spelled now")
    assert int(declared.group(1)) == MAX_VIEW_DEPTH, (
        f"the interface walks {declared.group(1)} levels of the part tree and "
        f"src/render.py publishes up to {MAX_VIEW_DEPTH} — the parts below the "
        f"lower of the two are missing from the tree panel of a model the hub "
        f"accepted, with nothing in the browser to say so")


def test_every_palette_token_the_interface_spends_is_defined():
    """A `var(--…)` nothing defines is a declaration the browser drops in silence.

    A typo in a role name from `static/_v/tokens.css` leaves the element with its
    inherited or initial colour. A name, not a value, so it is checked here;
    `ui/tests/chrome.test.js` executes the values side.

    The `--hmr-` prefix is exempt (derived): those are the font stacks, defined
    by the bundle in `FONTS` and spread onto its mount element.
    """
    tokens = set(re.findall(r"^\s*(--[\w-]+)\s*:",
                            strip_comments(read(TOKENS_CSS)), flags=re.M))
    assert tokens, "static/_v/tokens.css defines no custom properties at all"
    own = set(re.findall(r"'(--hmr-[\w-]+)':", read(UI / "style.jsx")))
    assert own, "ui/src/style.jsx no longer declares the font custom properties"

    missing = {}
    for path in ALL_UI_FILES:
        for name in re.findall(r"var\(\s*(--[\w-]+)", strip_comments(read(path))):
            if name not in tokens and name not in own:
                missing.setdefault(name, path.name)
    assert not missing, (
        f"these custom properties are used and defined nowhere: {missing}. The "
        f"browser drops every declaration that references one, without a word")


# The front page, whose colours are all references to those roles.
FRONT_PAGE = UI / "HammerolaEntry.jsx"

# How a colour is written down: hex and the `rgb()`/`hsl()` families are
# complete; the keywords are the common end of the CSS vocabulary, enough to catch
# the `#fff` somebody actually writes. `transparent` and `currentColor` name no
# colour and are deliberately absent.
COLOUR_LITERAL = re.compile(
    r"#[0-9a-fA-F]{3,8}\b"
    r"|\b(?:rgba?|hsla?)\s*\("
    r"|(?<![\w-])(?:white|black|silver|gray|grey|red|green|blue|yellow|orange"
    r"|purple|pink|brown|navy|teal|olive|lime|aqua|fuchsia|maroon|cyan|magenta"
    r"|violet|indigo|crimson|coral|salmon|gold)(?![\w-])",
    re.I,
)


def test_the_front_page_spends_the_palette_and_writes_no_colour_of_its_own():
    """Not one value in the whole file — every colour is a role in tokens.css.

    A surviving literal is one element painted in the light value on a dark page:
    nothing reports it, so only a sweep can hold it. Comments are stripped (prose
    paints nothing). No exemptions: the backdrop's ink, which a canvas cannot
    take as a `var()`, is read off the element at draw time (next test).
    """
    source = strip_comments(read(FRONT_PAGE))
    found = sorted({match.group(0) for match in COLOUR_LITERAL.finditer(source)})
    assert not found, (
        f"{FRONT_PAGE.name} writes {found} rather than naming a role from "
        f"static/_v/tokens.css. A value here is right in one theme and wrong in "
        f"the other, and the page that is wrong still renders")
    # Otherwise a file that stopped painting anything would pass by having
    # nothing to find.
    assert re.search(r"var\(\s*--", source), (
        f"{FRONT_PAGE.name} spends no palette token at all — this check is "
        f"sweeping a file that has stopped drawing")


def test_the_backdrop_reads_its_ink_off_its_own_element():
    """The one colour on that page a `var()` cannot reach, and how it still does.

    A canvas 2D context discards an unparseable `var(--text-muted)` and keeps the
    initial black. So the token goes on the canvas element, the drawing reads the
    resolved value with `getComputedStyle`, and the context is stroked with that.
    Without the first, the element inherits the page's text ink; without the
    others, strokes fall back to a literal or black. jsdom returns no 2D context,
    so ui/tests/ cannot reach this path.

    The read is cached and refreshed when `data-theme` changes; without that
    subscription the backdrop keeps the theme the page opened in.
    """
    source = strip_comments(read(FRONT_PAGE))
    assert re.search(r"style=\{css\(.*?color:\$\{this\.props\.color\}", source, flags=re.S), (
        "the backdrop no longer puts its ink on the canvas element, so "
        "getComputedStyle below it reads whatever the page's text colour is")
    assert re.search(r"ink\s*=\s*window\.getComputedStyle\(canvas\)\.color", source), (
        "the backdrop no longer reads its stroke colour back off the element — "
        "a canvas context resolves no var(), so whatever replaced this is "
        "either a literal or the context's initial black")
    assert re.search(r"ctx\.strokeStyle\s*=\s*ink\b", source), (
        "the backdrop strokes with something other than the value it read off "
        "the element, and the read above is then decoration")
    assert re.search(r"attributeFilter:\s*\['data-theme'\]", source), (
        "nothing re-reads the ink when the theme changes, so the backdrop keeps "
        "the one the page was opened in")
    assert re.search(r"color:\s*'var\(--[\w-]+\)'", source), (
        "the backdrop's default ink is no longer a palette role")


# A numeric character reference is not a colour but is spelled like one: the
# build page's `&#10005;` `&#9662;` `&#8594;` would read as hexes. Removed before
# the sweep, since `&#…;` is a different notation, rather than listed per glyph.
CHARACTER_REFERENCE = re.compile(r"&#\w+;")


def test_the_build_page_spends_the_palette_and_writes_no_colour_of_its_own():
    """Not one value on the build page — every colour is a role in tokens.css.

    The same assertion as the front page's, over `css()` strings and the
    `VIEWPORT_CSS` block. Many shades were collapsed onto few roles, so a near-miss
    shade tempts a hex that would break the theme for one element; the answer is
    a role in tokens.css. Comments are stripped.

    Two exemptions, `proposalgeom.js` and `hub.js`: their hexes colour model
    parts (proposed bodies, and the comparison's published colours), like the
    colours a view file carries. The tree swatch is `node.color`, from the model.
    """
    # The whole page via `page_draws_with`: panels and shared rules
    # (`panelstyle.js`) live in modules of their own.
    # The exemptions colour the payload, not the interface: `proposalgeom.js`
    # builds proposed bodies, `DIFF_COLOURS` in `hub.js` is the comparison's
    # published palette the legend must match. Each module's header names this
    # check.
    excused = {"proposalgeom.js", "hub.js"}
    sources = page_draws_with()
    whole = ""
    for path in sources:
        if path.name in excused:
            continue
        source = CHARACTER_REFERENCE.sub("", strip_comments(read(path)))
        found = sorted({m.group(0) for m in COLOUR_LITERAL.finditer(source)})
        assert not found, (
            f"{path.name} writes {found} rather than naming a role from "
            f"static/_v/tokens.css. A value here is right in one theme and "
            f"wrong in the other, and the page that is wrong still renders")
        whole += source
    # Otherwise a page that stopped painting would pass. Asked of the page, not
    # each file, because several modules draw nothing.
    assert re.search(r"var\(\s*--", whole), (
        "the build page spends no palette token at all — this check is "
        "sweeping files that have stopped drawing")


# A `css()` source file, cut into declaration-sized pieces.
#
# Every rule in this interface is a string, so a declaration ends at a `;` or at
# the end of its string literal. Interpolations are flattened first:
# `background:${busy ? 'var(--a)' : 'var(--b)'}` is one declaration with two
# values, so both branches land in one piece; no newline is removed, so offsets
# still map to lines. The whole file, not line by line, because a declaration
# can span lines (a template literal ending in `background:` followed by a
# concatenated ternary).
#
# Cheaper methods fail: the nearest property before a value misattributes a
# ternary's branches, and matching `background:var(--x)` misses the
# interpolated form.
INTERPOLATION = re.compile(r"\$\{([^{}]*)\}")
DECLARATION_END = re.compile(r"""[;'"`]""")


def declarations(source):
    """`source` as `(offset, text)` declaration-sized pieces, in order."""
    flat = INTERPOLATION.sub(
        lambda m: m.group(1).replace("'", " ").replace('"', " "), source)
    pieces, at = [], 0
    for end in DECLARATION_END.finditer(flat):
        pieces.append((at, flat[at:end.start()]))
        at = end.end()
    pieces.append((at, flat[at:]))
    return flat, pieces


def test_the_accents_line_roles_are_never_spent_as_a_fill():
    """The accent's line role (`--accent-line`) never fills a surface.

    A role spent outside its name couples unrelated restyles. The accent owns
    five surfaces — `--accent`, `--accent-strong`, `--accent-muted`,
    `--accent-bg`, `--accent-bg-soft` — so a fill from a line role is always a
    substitution for one of them (a waiting button takes `--accent-muted`).

    The neutral ramp is not swept: its line roles legitimately paint fills —
    1px `<div>` dividers (`--line`); the compare legend's
    grey swatch (a sample of a model colour); and the tree's tri-state eye dot
    (`eyeDot` in ui/src/panelstyle.js, half `--text-soft`, half `--line-strong`,
    the outline's two states side by side). Chip-fill visibility is measured in
    `ui/tests/chrome.test.js`.

    Declarations are found by `declarations` above.
    """
    role = re.compile(r"var\(\s*--accent-line\s*\)")
    offenders = []
    for path in ALL_UI_FILES:
        flat, pieces = declarations(strip_comments(read(path)))
        for index, (offset, piece) in enumerate(pieces):
            fill = piece.rfind("background")
            if fill < 0:
                continue
            found = [(offset + fill, piece[fill:])]
            # A property dangling at the end of its piece takes its value from
            # what is concatenated on: `` `…;background:` `` + `(busy ? … : …)`.
            if not re.search(r"var\(", found[0][1]):
                found = [(at, text) for at, text in pieces[index + 1:]
                         if re.search(r"var\(", text)][:1]
            for at, text in found:
                for hit in role.finditer(text):
                    line = flat.count("\n", 0, at + hit.start()) + 1
                    offenders.append(f"{path.name}:{line} {hit.group(0)}")
    assert not offenders, (
        f"a line role is filling a surface at {offenders}. The accent has five "
        f"surfaces of its own — --accent, --accent-strong, --accent-muted, "
        f"--accent-bg, --accent-bg-soft — and one of them is the one meant here")
    # The sweep has to be looking at something: the role IS used, as a line.
    used = sum(len(re.findall(r"var\(\s*--accent-line\s*\)",
                              strip_comments(read(path)))) for path in ALL_UI_FILES)
    assert used, "no --accent-line anywhere — this check sweeps nothing"


def test_every_localstorage_access_is_guarded():
    """A private window throws on the property itself, not on the call, so an
    unguarded read during render takes the interface down."""
    for path in INTERFACE_FILES + ADAPTER_FILES:
        lines = strip_comments(read(path)).splitlines()
        for number, line in enumerate(lines):
            if "localStorage" not in line:
                continue
            # A `try {` within the few lines above, visible from the access.
            window = lines[max(0, number - 6):number]
            assert any("try {" in earlier for earlier in window), (
                f"{path.name}:{number + 1} touches localStorage outside a try")


def test_a_project_reaches_the_tab_strip_from_exactly_one_place():
    """Exactly one `rememberTab(` call: the arrival is what the strip records.

    `ui/tests/tabs.test.js` drives `load()` and holds the recording itself; it
    cannot see a second caller. The revision switch and the poll refresh also
    replace `meta`, but recording there would refresh the stamp of a reader who
    never left, and the stamp is the eviction's only input, so the wrong tab
    would be evicted silently.
    """
    calls = strip_comments(read(COMPONENT)).count("rememberTab(")
    assert calls == 1, (
        f"the interface records a tab from {calls} places, not one. The strip "
        "is filled on arrival — where the project is first NAMED — and a "
        "second caller on a path that merely replaces `meta` refreshes the "
        "stamp of a reader who has not gone anywhere, which silently reorders "
        "what gets evicted")


# -- the arrangement of the project list -------------------------------------
#
# The four key sets that must agree (`PROJECT_SORTS` / `PROJECT_VIEWS` in
# store.js against `SORT_LABELS`, `SORT_CMP`, `VIEW_ICONS`, `VIEW_BODIES` in
# HammerolaEntry.jsx) are compared by `ui/tests/vocabulary.test.js` via
# `Object.keys`. What stays here is about the text: a branch on a view id is a
# second spelling that no comparison of exported values can see.


def test_the_project_list_chooses_its_body_from_that_table():
    """No view id is written down in the page except as the default it opens on.

    A branch on a view id (`{grid && …}` / `{!grid && …}`) bypasses the tables
    while they still look complete and agree. The rule is about the literal, not
    an operator, so it covers comparisons in either order, `switch`/`case`,
    aliases, and anything else.

    Comments are not stripped: a quoted id in a comment is a violation too; prose
    says "the grid view". All three quote characters count, backtick included.
    The allowed region is each `static defaultProps = { … };` declaration span,
    so it may wrap over several lines.
    """
    page = read(UI / "HammerolaEntry.jsx")
    views = {item.strip("'\"") for item in js_array(strip_comments(read(UI / "store.js")),
                                                    "PROJECT_VIEWS")}
    assert views, "store.js no longer declares PROJECT_VIEWS"

    # Every defaultProps in the file: a view id inside one is a declared default.
    # A nested object would end the span early at its inner `};`, which fails
    # loudly rather than passing.
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
    # Otherwise a file that stopped naming any view would pass.
    assert seen, ("HammerolaEntry.jsx names no view at all — defaultProps has to say "
                  "which one the page opens on")


def test_the_document_module_reaches_no_module_that_reaches_the_viewer():
    """`ui/src/proposal.js` stays loadable with no browser anywhere near it.

    Its header promises that a proposal can be built, edited, projected and
    compared as plain data. `quaternionOf`/`anglesOf` come from
    `viewport/math.js`, not `viewport/parts.js` which re-exports them: `parts.js`
    imports `internals.js`, which reads `location` at module scope, so
    `proposal.js` would throw outside a browser. The whole of `viewport/` is
    checked, one module deep.
    """
    source = strip_comments(read(UI / "proposal.js"))
    reached = set(re.findall(r"""from\s+['"]\./viewport/([\w.-]+)['"]""", source))
    # `math.js` imports nothing, which is what makes it safe to reach.
    stray = sorted(reached - {"math.js"})
    assert not stray, (
        f"ui/src/proposal.js imports {stray} out of the viewport. Only "
        "`viewport/math.js` may be reached from here: everything else in that "
        "directory leads to `internals.js` and the viewer, and this module "
        "promises in its own header that a document can be handled with no "
        "browser near it")
    # Through `strip_comments`: a comment line starting with "import" must not
    # count.
    assert not re.search(r"""^\s*import\s""",
                         strip_comments(read(UI / "viewport" / "math.js")),
                         flags=re.M), (
        "ui/src/viewport/math.js has grown an import, so it is no longer the "
        "leaf `proposal.js` is allowed to reach through — either keep it a "
        "leaf, or move the arithmetic `proposal.js` needs somewhere that is")
