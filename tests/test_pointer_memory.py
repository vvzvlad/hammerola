"""Remembering which pointer a reader was on, per project (SPEC 9).

Someone editing a model lives in `dev` and does not want to switch to it every
time. So `/project/<pid>/` — the URL that names no pointer — opens whichever of
`latest` and `dev` they were last on, falling back to `latest`.

THE TRAP THIS FILE IS MOSTLY ABOUT: a URL that names a pointer must win over the
remembered one, always. `/project/<pid>/latest/` is the link people paste to each
other, and a reader quietly moved to somebody else's `dev` sees something other
than what they were sent, with nothing on the page to tell them. So the pointer
pages record the choice and never act on it; only the pointer-less URL acts on
it. Half of that lives in the browser and is checked in a browser; what can be
pinned from here is the shape that makes it possible:

THE TWO HALVES LIVE IN DIFFERENT BUNDLES, which is the other thing this file
watches. The recording half is the interface (`ui/src/store.js`, called from the
build page); the reading half is `static/_v/pointer_pref.js`, imported by the
resolver — which cannot use the interface's copy, because pulling 3.6 MB of
bundle to read one key and leave is exactly what the resolver exists not to do.
So the key is spelled twice on purpose and compared from here.

  * the resolver is a PAGE, not a redirect — the answer is a localStorage key and
    the server cannot read one;
  * it is `no-cache`, like the pointers it hands over to: a cached decision page
    is a decision frozen;
  * it does not pull the viewer, and it leaves by `location.replace`, so the back
    button cannot land on it and be resolved forward again;
  * it still works with no script at all;
  * and the key is per project, because a general flag would open the model
    somebody is merely reading on the local build of the one they are editing.
"""

import json
import re
import shutil
from pathlib import Path

from harness import TOKEN, good_build

from src.store import DEV_LINK

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "static" / "_v"
PREF = ASSETS / "pointer_pref.js"
RESOLVER = ASSETS / "pointer.js"
TEMPLATE = ROOT / "templates" / "pointer.html"
# The recording half, which is the interface: the module that owns this origin's
# storage, and the component that decides a page is an arrival worth recording.
STORE_JS = ROOT / "ui" / "src" / "store.js"
COMPONENT = ROOT / "ui" / "src" / "HammerolaViewer.jsx"
# The front page, which is where the memory is most easily undone by accident.
# It used to be a committed script (`static/_v/index.js`); it is drawn by the
# compiled interface now, so the URL it links to is built in `hub.js` and used in
# the entry component, and this file follows it there.
HUB_JS = ROOT / "ui" / "src" / "hub.js"
ENTRY = ROOT / "ui" / "src" / "HammerolaEntry.jsx"


def _code(path):
    """A file with its `//` commentary stripped.

    These files explain at length why they do NOT do certain things — redirect
    from a pointer page, use `location.href`, build markup from a string — and a
    substring check cannot tell prose from code.
    """
    text = path.read_text(encoding="utf-8")
    return "\n".join(line.split("//")[0] for line in text.splitlines())


# -- the route ----------------------------------------------------------------
def test_the_pointerless_url_serves_a_page_and_not_a_redirect(hub):
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("text/html")
    assert "/_v/pointer.js" in r.text


def test_all_three_routes_carry_the_right_cache_header(hub):
    """The resolver joins the two pointers on `no-cache`; commits keep the year.

    It stands in for a redirect that used to be recomputed on every visit. A
    cached copy of it would send a reader to the pointer they preferred on the
    day the page was stored, and go on doing it for as long as the copy lived.
    """
    hub.publish("proj1", "abc123", good_build())
    hub.publish_dev("proj1", good_build())
    for path in ("/project/proj1/", "/project/proj1/latest/",
                 "/project/proj1/dev/"):
        assert hub.get(path).headers["Cache-Control"] == "no-cache", path
    # And the commit directory keeps its year. The page SHELL is `no-cache`
    # everywhere — it ships with the image, not with the build — so the promise
    # is on the build's own content.
    assert "immutable" in \
        hub.get("/project/proj1/abc123/meta.json").headers["Cache-Control"]


def test_the_resolver_is_reached_with_a_trailing_slash(hub):
    """It leaves by a RELATIVE url and its no-script link is a relative href.

    Without the slash both resolve one level up — `/project/latest/` — so the
    slash is load-bearing here for the same reason it is on a build URL.
    """
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1")
    assert r.status_code == 302
    assert r.headers["Location"] == "/project/proj1/"


def test_a_project_that_does_not_exist_is_a_404(hub):
    # Rather than a page that resolves to a 404 one navigation later.
    assert hub.get("/project/nosuch/").status_code == 404


def test_the_resolver_page_is_not_the_build_page(hub):
    """It must not drag the viewer in to answer a question about a URL.

    A quarter-megabyte bundle, the 3.6 MB viewer it pulls in behind itself and a
    2 MB view, downloaded to read one localStorage key and leave — and every
    byte of it on the way to a page that will download them again.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/").text
    for asset in ("three-cad-viewer.esm.js", "/_v/hammerola.js"):
        assert asset not in body, asset
    # And no mount point either: the bundle does nothing without one, so a stray
    # #hmr_root here would be the one way this page could start rendering an
    # interface it has no business rendering.
    assert "hmr_root" not in body


def test_the_resolver_works_with_no_script_at_all(hub):
    """A link, not a blank page.

    Script blocked, an ES module that fails to parse, a hub that serves the page
    and then falls over: whatever the reason, what is left has to go somewhere.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/").text
    assert re.search(r'<a href="latest/"[^>]*>[^<]+</a>', body), \
        "the resolver has no working link left when the script does not run"


# -- what the resolver does ---------------------------------------------------
def test_the_resolver_leaves_by_replace_and_never_by_href():
    """`href` would put this page in the history between the reader and Back.

    Back lands on it, it resolves forward again, and the reader cannot leave —
    the classic redirect loop, and one that only shows up in a real browser.
    """
    code = _code(RESOLVER)
    assert "location.replace(" in code
    assert "location.href" not in code
    assert "location.assign" not in code


def test_only_dev_is_verified_and_the_fallback_is_latest():
    """A remembered `dev` is the one answer that can have gone stale.

    The slot is local, it may never have been filled, and it can be pruned — so
    it is checked against builds.json rather than assumed, and a project with no
    slot opens `latest` instead of a 404. `latest` and "nothing remembered" take
    the same path and pay no round trip for it, which is the common case.
    """
    code = _code(RESOLVER)
    assert 'if (saved !== "dev") {' in code
    assert 'go("latest");' in code
    assert 'go(await hasDev() ? "dev" : "latest");' in code
    assert 'fetch("builds.json"' in code
    assert "info.has_dev" in code
    # A hub mid-restart and a project that has never been pushed both land here,
    # and both have to resolve to `latest` rather than throw inside a module.
    assert "return false;" in _code(RESOLVER)


def test_builds_json_answers_has_dev_for_real(hub):
    """The flag the resolver leans on, from the live hub.

    Pinned here because the fallback is invisible when it works: a `has_dev` that
    silently stopped being written would send every reader who chose `dev` to a
    404 with nothing in a log to say why.
    """
    hub.publish("proj1", "abc123", good_build())
    # True from the first publish: a commit fills the slot with itself (#78).
    assert hub.get("/project/proj1/builds.json").json()["has_dev"] is True
    hub.publish_dev("proj1", good_build())
    assert hub.get("/project/proj1/builds.json").json()["has_dev"] is True

    # And it is read off the disk rather than assumed: with the slot taken away
    # the next rewrite of the file says so. A rename is what rewrites it without
    # publishing anything, since a publish would fill the slot again.
    shutil.rmtree(hub.project_dir("proj1") / DEV_LINK)
    assert hub.request("POST", "/api/v1/projects/proj1/title",
                       content=json.dumps({"title": "Renamed"}).encode(),
                       headers={"Content-Type": "application/json",
                                "Authorization": f"Bearer {TOKEN}"},
                       ).status_code == 200
    assert hub.get("/project/proj1/builds.json").json()["has_dev"] is False


# -- what records the choice --------------------------------------------------
def test_the_key_is_per_project():
    """A single flag would cross two projects that have nothing to do with
    each other: the one being edited, and the one merely being read."""
    code = _code(PREF)
    assert re.search(r'const KEY_PREFIX = "[^"]*\.pointer\."', code), \
        "the storage key is no longer a prefix — is it still per project?"
    assert "const key = (pid) => KEY_PREFIX + pid;" in code
    # Namespaced like the other two settings this site stores, so one project's
    # keys stay recognisable next to whatever else shares the origin.
    assert 'KEY_PREFIX = "hammerola.pointer."' in code


def test_the_writer_and_the_reader_spell_the_same_key():
    """One localStorage key, two files, and nothing in a browser to notice.

    They cannot share a module — see this file's header — so the spelling is
    compared here instead. Drift is invisible from both ends: the interface goes
    on writing, the resolver goes on reading null and falling back to `latest`,
    and the feature is simply gone with nothing logged anywhere.
    """
    prefix = re.search(r'const KEY_PREFIX = "([^"]+)"', _code(PREF))
    assert prefix, "the reader no longer declares KEY_PREFIX"

    store = _code(STORE_JS)
    namespace = re.search(r"const NS = '([^']+)'", store)
    assert namespace, "ui/src/store.js no longer declares the `hammerola.` namespace"
    built = re.search(r"const pointerKey = \(pid\) => `\$\{NS\}([^`$]*)\$\{pid\}`",
                      store)
    assert built, \
        "ui/src/store.js no longer builds the pointer key out of NS and the pid"

    assert namespace.group(1) + built.group(1) == prefix.group(1), (
        f"the interface writes `{namespace.group(1) + built.group(1)}<pid>` and "
        f"the resolver reads `{prefix.group(1)}<pid>`")


def test_a_stored_value_that_is_not_a_pointer_reads_as_nothing():
    """An old name, a hand-set key, a name this site no longer has.

    All of them have to fall back to `latest`, and the check is the same list the
    hub publishes under — which is what test_live_reload pins to the store.
    """
    assert "POINTER_NAMES.includes(saved) ? saved : null" in _code(PREF)


def test_the_writer_refuses_anything_that_is_not_one_of_the_two_names():
    """The same list, applied on the way IN.

    A commit id stored here is the failure that looks like nothing: the resolver
    compares against the two moving names, reads an unknown value as nothing, and
    sends every later visit to `latest` — so a reader who lives in `dev` loses
    the memory by opening one pinned build.
    """
    store = _code(STORE_JS)
    assert "POINTER_NAMES.includes(name)" in store
    assert re.search(r"import \{ POINTER_NAMES \} from '\./hub\.js'", store), (
        "ui/src/store.js spells the two names itself instead of importing them, "
        "so this side can now disagree with what the hub publishes under")


def test_storage_being_unavailable_is_not_an_error():
    """Private mode and storage turned off are ordinary, not a broken page.

    One guard per side. The reader has its own try/catch; the writer has none of
    its own and must not grow one — it goes through `write()`, which is the one
    guarded door `tests/test_ui_source.py` holds the whole interface to.
    """
    code = _code(PREF)
    assert code.count("try {") == 1 and code.count("catch") == 1
    assert "write(pointerKey(pid), name)" in _code(STORE_JS), (
        "rememberPointer no longer writes through store.js's guarded helper")


def test_the_interface_records_the_pointer_the_page_was_opened_under():
    """The build page is the arrival, and the arrival is the fact recorded.

    Not the build picker's click: reaching /dev/ by the picker, by a pasted link
    or by the back button is the same thing, and all three are a page load. And
    only on a pointer page — a pinned commit is not a choice between the two
    moving names, so recording one there would be remembering a build.
    """
    code = _code(COMPONENT)
    assert re.search(r"if \(isPointerPage\(\)\)\s*rememberPointer\(PAGE\.pid, "
                     r"PAGE\.slot\);", code), (
        "the interface no longer records the pointer it was opened under, or no "
        "longer guards the write with isPointerPage() — the first leaves "
        "/project/<pid>/ on `latest` forever, the second remembers commit ids")


def test_the_index_links_to_the_project_and_not_to_a_pointer():
    """A card is "open this model", and it is the route somebody browsing their
    own projects takes most.

    Linking it straight to `latest` would overwrite the remembered choice on
    every visit to the front page — the feature quietly undone by its own index.

    Checked in two places because the link is now built in one file and used in
    another, and either half can break it alone: a `projectUrl` that grew a
    pointer would overwrite the memory everywhere at once, and a card that stopped
    calling it would do the same on the one page that matters most.
    """
    url = _code(HUB_JS)
    built = re.search(r"export const projectUrl = \(pid\) => (.+);", url)
    assert built, "ui/src/hub.js no longer builds the card's URL in one place"
    assert "encodeURIComponent(pid)" in built.group(1), built.group(1)
    for name in ("latest", "dev"):
        assert name not in built.group(1), (
            f"projectUrl names the `{name}` pointer: {built.group(1)}. The URL a "
            "card points at has to name NO pointer — that is the only one the "
            "resolver is allowed to apply a remembered choice to.")

    entry = _code(ENTRY)
    assert "href={projectUrl(" in entry, (
        "the front page's cards no longer take their href from projectUrl")
    assert "/latest/" not in entry


# -- the house rules ----------------------------------------------------------
def test_the_new_files_build_no_markup_from_a_string():
    """Same rule as the rest of the site (SPEC 7A.4), applied on the way in."""
    for path in (PREF, RESOLVER, TEMPLATE):
        text = path.read_text(encoding="utf-8")
        for forbidden in (".innerHTML", ".outerHTML", ".insertAdjacentHTML(",
                          "document.write("):
            assert forbidden not in text, f"{path.name}: {forbidden}"


def test_the_resolver_script_is_a_file_and_not_inline(hub):
    """The HTML responses carry `default-src 'self'`, which refuses inline
    script — and that refusal is what stops smuggled content from executing."""
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/")
    assert "default-src 'self'" in r.headers["Content-Security-Policy"]
    assert not re.search(r"<script(?![^>]*\bsrc=)", r.text), \
        "the resolver page has an inline script the CSP will refuse"
