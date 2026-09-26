"""The invariants of `ui/src/viewport/` that no browser is needed to check.

The viewport is the half of the new interface that drives three-cad-viewer: a
custom element, `<hmr-viewport>`, wrapped around the library with the library's
own UI switched off. Almost everything it does can only be judged with a GPU and
a pointer in a real browser, and that part is not what this file is for.

What is left over is a short list of agreements that are invisible at runtime
until they are expensive, and each check below is one of them:

  * THE LIBRARY IS NOT IN THE BUNDLE. It is vendored (3.5 MB, committed, served
    by the hub already) and reached through a runtime `import()` of a URL. A
    static import instead would still work perfectly — the page would load, the
    model would render — while quietly tripling the size of a bundle whose whole
    build contract is "one output file, copied by name in three other places".
  * THE URL IS ONE THE HUB WILL SERVE. `_serve_asset()` answers
    `/_v/<one path component>` and `_safe_name()` rejects a slash, so a deeper
    path is a 404 nobody sees until the viewport is opened.
  * THE NAMES ON THE WIRE COME FROM ONE FILE. A misspelled event name is not an
    error, it is silence: nothing dispatches it and nothing says so.
    `ui/src/viewport/events.js` is the one place any of them is written, and the
    React side imports its constants under aliases — this file checks the half
    only this side can see, that the ADAPTER never spells a name outside that
    module either.
  * THE MEASURED CONSTANTS STILL CARRY THE VALUES THEY WERE MEASURED AT.
    Half a dozen of the viewport's numbers are measurements rather than
    preferences — the pinch rate off a CDP-driven gesture, the ring radii against
    a half-resolution pick buffer, the depth bias that stops a stencil cap
    z-fighting. Each is checked against a LITERAL written out below, together
    with how it was arrived at.

    A test that repeats a literal is normally a test agreeing with itself, and
    this is the case where it is not. The event names above have a live shared
    source — a module that can be imported — so an import beats a copy there.
    A measured physical constant has no such source: the number came out of a
    browser, and the file it was first written in has been deleted along with the
    viewer it drove. The job of the check is not "these two places agree", it is
    "this number is a measurement, do not round it on the way past; here is how
    to take it again". For that the literal is unavoidable and the derivation in
    the docstring is the load-bearing half.

Nothing here runs JavaScript: the checks read the sources as text, the same way
tests/test_ui_bundle.py already does.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
ADAPTER = ROOT / "ui" / "src" / "viewport"

# The directory the hub serves at `/_v/`.
ASSETS = ROOT / "static" / "_v"

# A line whose content begins a comment. Used instead of a real comment stripper
# because every check that needs one is a search for a short literal, and the
# question "is this occurrence prose?" is answered line by line — while a stripper
# would have to survive the regex literals in this tree (`replace(/\/(faces|...)/`)
# to answer a question nothing here asks.
PROSE = re.compile(r"^\s*(//|\*|/\*)")


def sources():
    """Every module of the adapter, as {name: text}."""
    return {path.name: path.read_text(encoding="utf-8")
            for path in sorted(ADAPTER.glob("*.js"))}


def code_lines(text):
    """The lines of a module that are not comments."""
    return [line for line in text.splitlines() if not PROSE.match(line)]


def code(text):
    return "\n".join(code_lines(text))


@pytest.fixture(scope="module")
def modules():
    found = sources()
    assert found, f"{ADAPTER} has no modules in it at all"
    return found


@pytest.fixture(scope="module")
def library_url(modules):
    """`VIEWER_MODULE_URL`, read off the declaration rather than assumed."""
    match = re.search(r"(?m)^export const VIEWER_MODULE_URL = \"([^\"]+)\";$",
                      modules["library.js"])
    assert match, (
        "ui/src/viewport/library.js no longer declares VIEWER_MODULE_URL. It is "
        "the one place the adapter says where the vendored library lives, and "
        "every check below reads it from there."
    )
    return match.group(1)


# -- the library stays out of the bundle -------------------------------------
def test_the_library_is_never_a_static_import(modules):
    """A static import would inline 3.5 MB into a bundle copied by name.

    The failure is entirely silent: the page works, the model renders, and the
    only trace is a `hammerola.js` twenty-five times its previous size — next to
    a `three-cad-viewer.esm.js` the browser fetches anyway, from the URL the hub
    already serves it at.

    Both spellings are refused. `from "three-cad-viewer"` is the npm package,
    which is not a dependency here and would resolve to nothing (or, worse, to a
    version that is not the vendored one); `from "/_v/..."` is the vendored file
    reached at build time, which vite resolves against the project root rather
    than the hub's URL space.
    """
    static_imports = []
    for name, text in modules.items():
        for line in code_lines(text):
            match = re.search(r"""(?:^|\s)from\s+["']([^"']+)["']""", line)
            if match and ("three-cad-viewer" in match.group(1)
                          or match.group(1).startswith("/_v/")):
                static_imports.append((name, line.strip()))

    assert not static_imports, (
        f"these lines import the viewer library at BUILD time: {static_imports!r}. "
        "The library is vendored and already served by the hub; a static import "
        "puts a second copy of 3.5 MB inside hammerola.js, which nothing would "
        "report. Load it through loadViewerLibrary() in library.js instead."
    )


def test_the_package_json_has_not_grown_a_copy_of_three():
    """`three` as a dependency is the same 3.5 MB by another route.

    It is also worse than a duplicate: three-cad-viewer bundles its own three.js,
    and two copies of three in one page do not interoperate — an instance of one
    `Vector3` fails every `instanceof` in the other, so the symptoms are wrong
    answers rather than a missing module.
    """
    package = (ROOT / "ui" / "package.json").read_text(encoding="utf-8")
    for name in ("\"three\"", "\"three-cad-viewer\""):
        assert name not in package, (
            f"ui/package.json declares {name}. The viewer library is VENDORED in "
            "static/_v/ and loaded at runtime from the URL the hub serves it at; "
            "an npm copy beside it is a second three.js in the same page."
        )


def test_the_dynamic_import_is_the_only_one_in_the_tree(modules):
    """A second `import()` means a second output file, and nothing copies it.

    `ui/vite.config.mjs` states the build's contract in its first paragraph: one
    file, `hammerola.js`. A dynamic import that vite CAN analyse is split into a
    chunk, and that chunk has to be named in the Makefile's `UI_FILES`, in a
    `COPY --from=ui` line and in `REQUIRED_PATHS` — miss any of them and the
    chunk never reaches the image while the gate goes on reporting green.

    The library's own import escapes that because vite cannot analyse it: the
    specifier is a constant and `@vite-ignore` says to leave it alone. Which is
    exactly why a new one, written the ordinary way, must be noticed here.
    """
    dynamic = [(name, line.strip()) for name, text in modules.items()
               for line in code_lines(text) if re.search(r"\bimport\s*\(", line)]

    assert len(dynamic) == 1, (
        f"the adapter contains {len(dynamic)} dynamic imports: {dynamic!r}. There "
        "must be exactly one -- the vendored library in library.js, which vite "
        "leaves alone. Any other one is split into a chunk that the Makefile, the "
        "Dockerfile and ci/smoke.py know nothing about."
    )
    name, line = dynamic[0]
    assert name == "library.js", (
        f"the dynamic import lives in {name}, not in library.js. Loading the "
        "library is that module's whole job, and the comment explaining why the "
        "import is written the way it is lives there."
    )
    assert "/* @vite-ignore */" in line, (
        f"the dynamic import {line!r} has no /* @vite-ignore */. Without it vite "
        "tries to resolve the specifier at build time: today that is a warning "
        "and an unanalysable import left as-is, but nothing promises it stays "
        "that way, and the failure mode is a build that inlines or rewrites the "
        "URL."
    )
    assert "import(/* @vite-ignore */ VIEWER_MODULE_URL)" in line, (
        f"the dynamic import {line!r} does not take the VIEWER_MODULE_URL "
        "constant. A string LITERAL there is a specifier vite resolves against "
        "the project root, where nothing of the sort exists."
    )


def test_the_url_names_a_file_the_hub_really_serves(library_url):
    """Three separate ways this URL can be wrong, all of them 404 at runtime."""
    assert library_url.startswith("/_v/"), (
        f"VIEWER_MODULE_URL is {library_url!r}, which is not under /_v/. That is "
        "the only URL prefix the hub serves static assets from."
    )
    name = library_url[len("/_v/"):]
    assert "/" not in name, (
        f"VIEWER_MODULE_URL is {library_url!r}, which has more than one path "
        "component under /_v/. `_safe_name()` in src/app.py rejects a name "
        "containing a slash -- a path-traversal defence, not an oversight -- so "
        "this would 404 however correctly the file is deployed."
    )
    assert (ASSETS / name).is_file(), (
        f"VIEWER_MODULE_URL is {library_url!r} and static/_v/{name} does not "
        "exist. Nothing else in the bundle references the library, so this "
        "string IS the dependency."
    )


# -- the names on the wire ---------------------------------------------------
def test_every_name_on_the_wire_is_declared_in_events_js(modules):
    """No `hmr:` literal anywhere in the adapter except its contract module.

    That module is now the ONE place any of these names is written: the React
    side imports its constants under aliases rather than keeping a copy. Which
    makes this check the one that keeps the arrangement honest -- a name
    dispatched from a literal in tools.js would be a second source again,
    reachable from nothing that imports it.

    Comments are exempt -- the modules explain their own events at length -- so
    the match is on lines that are not prose.
    """
    stray = [(name, line.strip()) for name, text in modules.items()
             if name != "events.js"
             for line in code_lines(text) if "hmr:" in line]

    assert not stray, (
        f"these lines spell an event name outside ui/src/viewport/events.js: "
        f"{stray!r}. Every name has to be a constant exported from that module, "
        "because it is the only file the React side's own list is compared "
        "against -- a literal here is a name nothing checks and nobody hears."
    )


def dispatched(body):
    """Every `EVENT_` constant the adapter really hands to `emit`.

    THE SECOND ARGUMENT OF EVERY `emit(` IS WHAT A DISPATCH IS, and most of them
    name their constant outright. The manipulator's four do not: a slide and a
    turn are one gesture cycle written once (`reportGesture` in gesture.js), so
    the constants are handed to it in an options object and what it emits is the
    PARAMETER. So an argument that is not a constant is resolved through the key
    it names -- `emit(vp, modelEvent, ...)` dispatches whatever any `modelEvent:`
    in the adapter is bound to.

    ONE HOP AND NO MORE, which is a floor under the indirection rather than an
    accident of the regex: a dispatcher that took its name from anything but a
    named key of its own argument drops out of this set, and the check above
    fails. That is the honest failure -- the tie between a declared name and the
    line that sends it is exactly what this file exists to keep readable.
    """
    sent = set()
    for arg in re.findall(r"\bemit\(\s*[^,]+,\s*([\w$.]+)", body):
        if arg.startswith("EVENT_"):
            sent.add(arg)
            continue
        key = arg.rsplit(".", 1)[-1]
        sent.update(re.findall(rf"\b{re.escape(key)}:\s*(EVENT_[A-Z]+)\b", body))
    return sent


def test_every_declared_up_event_is_actually_dispatched(modules):
    """A contract that names an event nobody sends is a contract that lies.

    The React side listens for all of them, so a name declared and never
    dispatched is a handler that is simply never called -- the exact silence this
    whole arrangement is built to avoid, and the reason the list is checked
    against the call sites rather than against itself.

    WHAT COUNTS AS A CALL SITE is `dispatched` above, and it is the whole of what
    this check had to grow when the four names of the move tool stopped being
    written at an `emit(` of their own. Deleting either `emit` inside the shared
    dispatcher turns this red, exactly as deleting a literal one does: the names
    bound to that key are then sent by nothing.
    """
    events = modules["events.js"]
    listed = re.search(r"(?s)export const EVENTS_UP = \[(.*?)\];", events)
    assert listed, "ui/src/viewport/events.js no longer exports EVENTS_UP"
    names = re.findall(r"\bEVENT_[A-Z]+\b", listed.group(1))
    assert names, "EVENTS_UP is empty"

    body = "\n".join(code(text) for name, text in modules.items()
                     if name != "events.js")
    sent = dispatched(body)
    unsent = [name for name in names if name not in sent]

    assert not unsent, (
        f"these events are declared in EVENTS_UP and never dispatched: {unsent!r}. "
        "Either something stopped emitting one, or a name was added to the list "
        "ahead of the code that sends it, or a dispatcher shared by several names "
        "no longer emits the parameter its callers spell as a key -- in all three "
        "cases the interface is listening for something that never arrives."
    )


def test_the_element_is_defined_once_under_the_tag_the_interface_uses(modules):
    """`customElements.define` THROWS on a duplicate name.

    Which is not a corner case here: vite's dev server re-executes a module on
    every hot update, so an unguarded define takes the page down with a
    NotSupportedError the first time somebody saves a file.

    THE TAG IS DECLARED IN `events.js` AND USED IN `index.js`, which is the split
    this check also pins. `index.js` is the module whose evaluation registers the
    element, so anything that reads a name out of it registers the element as a
    side effect of asking a question -- the React side wants the tag and nothing
    else. `events.js` runs nothing on import and is already where the other half
    of the contract with the interface is written, so the name lives there and
    the registering module imports it like everybody else.
    """
    events = modules["events.js"]
    index = modules["index.js"]
    assert re.search(r"export const TAG = \"hmr-viewport\";", events), (
        "ui/src/viewport/events.js no longer names the tag `hmr-viewport`. This "
        "declaration is the only place the string is written -- the React side "
        "re-exports it as VIEWPORT_TAG -- so renaming it renames what the "
        "component renders too, and the export has to stay a constant this "
        "check can read."
    )
    assert re.search(r"""import\s*\{[^}]*\bTAG\b[^}]*\}\s*from\s*"\./events\.js";""",
                     index), (
        "ui/src/viewport/index.js no longer takes TAG from ./events.js. If it "
        "declares the string itself again there are two spellings of it, and the "
        "one the interface renders is not necessarily the one defined here."
    )
    assert "customElements.get(TAG)" in index, (
        "the customElements.define in index.js is not guarded by "
        "customElements.get. A second evaluation of the module -- which is what "
        "a hot update is -- would throw."
    )


# -- the measured constants --------------------------------------------------
# name in ui/src/viewport/options.js  ->  the value it was measured at, as the
# module has to spell it. Compared as TEXT, which is what keeps `0.15` from being
# accepted back as `0.150000001`.
#
# HOW EACH ONE WAS ARRIVED AT — this block is the derivation, and it is here
# rather than in a commit message because a number whose reason cannot be found
# is a number the next reader rounds:
#
#   PINCH_DELTA_PER_E_FOLD = 100
#     Pixels of `deltaY` the browser emits per e-fold of PINCH SCALE. macOS hands
#     the browser a pinch as a gesture carrying a scale and the browser turns it
#     into ctrl+wheel before the page sees it. Measured in Chrome 151 on macOS,
#     driven through CDP `Input.synthesizePinchGesture` with `gestureSourceType:
#     "mouse"` (the touchpad-pinch path a real trackpad goes down):
#
#         gesture scale   events   sum of deltaY      -100 * ln(scale)
#              2.00         11         -69.31             -69.31
#              1.50         10         -40.55             -40.55
#              1.25          6         -22.31             -22.31
#              0.50         17         +69.31             +69.31
#
#     — exact to five digits, and the same total however fast the gesture is run;
#     speed only changes how many events it is chopped into. So `sum(deltaY)` is
#     `-100 * ln(scale)`, and `zoom *= exp(-deltaY / 100)` follows the gesture's
#     own scale exactly. VERIFIED END TO END in the browser: one scale-2.0 pinch
#     moved the zoom x2.0003, against x1.0353 through the library's own wheel
#     path (`deltaY * 0.00025 * zoomSpeed`, zoomSpeed 2.0) — twenty gestures to
#     double the view — with the point under the cursor drifting 0.000 px.
#     TO RE-MEASURE: drive `Input.synthesizePinchGesture` at a few scales, sum
#     the `deltaY` of the resulting wheel events, and fit `sum = -k * ln(scale)`.
#     WHAT WOULD INVALIDATE IT: a browser that stops encoding the scale this way.
#
#   PROBE_PX = [7, 14, 26]
#     Ring radii, in CSS pixels, for sampling a face around the cursor. NOT to be
#     retuned by eye: `IdPicker.pickAt` renders its target at `width * dpr * 0.5`
#     — HALF resolution — so these radii are already coarser on the pick buffer
#     than they look on screen, and the smallest is a couple of texels at dpr 1.
#     Shrinking them collapses the ring onto the centre pixel and the cross
#     product it feeds becomes noise.
#
#   MIN_SPREAD = 0.2, MIN_SINE = 0.15
#     Sine between two ring samples below which the pair is too collinear to
#     trust, and ~8.6 degrees below which the clip normal points nearly straight
#     at the camera: its screen projection collapses and the px -> world factor
#     runs away to infinity. No drag beats a plane that teleports.
#
#   SECTION_BIAS = 1e-4
#     Depth bias when laying the plane on a face, as a fraction of the grid. A
#     plane laid EXACTLY on a face is coplanar with it and the library's stencil
#     cap then z-fights the face over every pixel — measured in a browser, the
#     whole part comes back covered in moving stripes and reads as broken. A
#     ten-thousandth of the grid clears it completely: 0.009 mm on a 90 mm part.
#     Relative to the grid so it scales with the model.
#
#   CLICK_PX = 4
#     Pointer travel below which a press counts as a click rather than a drag.
#
#   SECTION_INDEX = 0
#     Which of the library's three clip planes the tool drives.
#
#   IDLE_MS = 1200
#     How long after the last press or wheel the viewport still counts as busy. A
#     live swap re-renders the scene and re-seats the camera, and doing that
#     between a mousedown and the mouseup is pulling the model out from under the
#     pointer.
#
#   INPUT_KEY = "hammerola.pointing_device"
#     Where the one pointing-device answer is remembered. Same `hammerola.`
#     namespace as the rest of the site's keys. It is NOT `swipe_pan`, the name
#     it had first: that described one consequence of the answer rather than the
#     answer, and a key that has to be translated in the reader's head is a key
#     that gets misread.
GOLDEN = {
    "CLICK_PX": "4",
    "PROBE_PX": "[7, 14, 26]",
    "MIN_SPREAD": "0.2",
    "MIN_SINE": "0.15",
    "SECTION_BIAS": "1e-4",
    "SECTION_INDEX": "0",
    "PINCH_DELTA_PER_E_FOLD": "100",
    "INPUT_KEY": '"hammerola.pointing_device"',
    "IDLE_MS": "1200",
}


def value_of(source, pattern):
    match = re.search(pattern, source)
    assert match, f"no declaration matching {pattern!r}"
    # Everything up to the end of the line, minus a trailing comment and the
    # semicolon: these are numbers, short arrays and one string, and comparing
    # them as TEXT is what keeps `0.15` from being accepted as `0.150000001`.
    return re.sub(r"\s*(//.*)?$", "", match.group(1)).rstrip(";").strip()


def test_the_measured_constants_keep_the_values_they_were_measured_at():
    """Nobody may quietly retune a measurement.

    Every number in GOLDEN above came out of a browser or out of the library's
    own source, and the block above it is where each one's derivation now lives.
    A tidier-looking value is not a refactor here: it is a different measurement,
    and the way it fails is a viewport that behaves subtly wrong -- a plane that
    z-fights, a pick ring that reads noise, a pinch that needs twenty gestures --
    with nothing anywhere reporting a change.
    """
    options = (ADAPTER / "options.js").read_text(encoding="utf-8")

    for name, expected in GOLDEN.items():
        actual = value_of(options, rf"(?m)^export const {name} = (.+)$")
        assert actual == expected, (
            f"{name} in ui/src/viewport/options.js is {actual}, and the value it "
            f"was measured at is {expected}. This is a measurement rather than a "
            "preference -- the comment above GOLDEN in this file says how it was "
            "taken -- so a change is either a re-measurement, which moves both "
            "and rewrites that comment, or a mistake."
        )


def test_the_hold_key_is_the_key_the_library_leaves_free():
    """Which key is safe took reading the library's shortcut table to answer.

    The library binds a shortcut table of its own
    (`ViewerState.DISPLAY_DEFAULTS.keymap`), hangs `_handleKeyboardShortcut` on
    the CONTAINER, and answers a key it recognises with `preventDefault();
    stopPropagation()`. The container takes focus the moment anybody clicks the
    model, so from then on a colliding key never arrives at all. Its letters,
    read off the bundle rather than guessed: A 0 g G p t b R r 5 1 3 8 2 4 6 x L
    D P I h space Escape T C M Z S, plus a/v/e/f/s while the topo-filter dropdown
    is open and Backspace with the select tool.

    `x`, for "cross-section", was the first choice and was silently eaten after
    every click on the part until that table was found. `c` is free, `C` (shift)
    is the library's own Clip tab -- which this tool drives anyway -- and it is
    under the left hand while the right is on the mouse.

    Matched on `code` and not on `key`: `code` is the physical key, so the
    shortcut survives a Cyrillic layout, where that key produces "с". `key` is
    the fallback for the rare input path that reports no code at all.
    """
    holdkey = (ADAPTER / "holdkey.js").read_text(encoding="utf-8")
    for name, expected in (("HOLD_CODE", '"KeyC"'), ("HOLD_KEY", '"c"')):
        actual = value_of(holdkey, rf"(?m)^const {name} = (.+)$")
        assert actual == expected, (
            f"{name} in ui/src/viewport/holdkey.js is {actual} rather than "
            f"{expected}. Picking another letter means redoing the reading in "
            "this docstring, and the way a bad pick fails is a shortcut that "
            "silently does nothing on a page where the reader has touched the "
            "model -- i.e. always."
        )


def test_the_measured_constants_travel_with_their_measurements():
    """A calibration constant without its derivation is a number nobody may touch.

    GOLDEN above is one copy of that derivation, and this is the other: the
    module itself has to keep carrying the part that makes each number
    reproducible -- how it was measured, or what breaks without it -- because
    that is what the person editing options.js has in front of them.
    """
    options = (ADAPTER / "options.js").read_text(encoding="utf-8")
    head = options[:options.index("export const PINCH_DELTA_PER_E_FOLD")]
    pinch = head[head.rindex("/**"):]
    assert "synthesizePinchGesture" in pinch, (
        "the pinch rate's comment no longer says how it was measured, so the "
        "next reader cannot redo the measurement"
    )
    assert "-69.31" in pinch and "-40.55" in pinch, "the measured numbers are gone"
    assert "zoomSpeed" in pinch, "nothing says what would invalidate the number"

    probe = options[:options.index("export const PROBE_PX")]
    probe = probe[probe.rindex("/**"):]
    assert "HALF" in probe or "half" in probe, (
        "the probe radii no longer say that pickAt renders at half resolution. "
        "That is the whole reason they cannot be shrunk by eye: on the pick "
        "buffer the smallest ring is a couple of texels wide."
    )

    bias = options[:options.index("export const SECTION_BIAS")]
    bias = bias[bias.rindex("/**"):]
    assert "z-fight" in bias, (
        "the section bias no longer says what it prevents. A plane laid exactly "
        "on a face z-fights the library's stencil cap over every pixel, and the "
        "part comes back covered in moving stripes."
    )
