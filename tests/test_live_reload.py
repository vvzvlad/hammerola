"""Live reload: a page on a pointer URL picking up the next build by itself.

The feature itself runs in a browser and can only be judged there. What CAN be
pinned from here is the SERVER's half of the contract it stands on:

  * the page polls `meta.json` under its own directory and compares a key built
    out of that file, so a publish must change that key at a URL that does not
    move — `commit` under `latest`, and `published` in the local slot, which is
    one directory called `dev` for every build it will ever hold;
  * it does so ONLY under `latest` and `dev`, because a /<commit>/ page is
    immutable by contract and carries a year of `immutable` caching to say so;
  * an unchanged rebuild must NOT move the key, or every rebuild of a model
    nobody touched would re-seat the camera of a page somebody is working in.

The browser's half of it is checked against the live sources in
tests/test_ui_source.py; `_key` below is pinned against the interface's own
`buildKey` so the assertions here keep describing what the page really compares.
"""

import re
from pathlib import Path

from harness import DEFAULT_EXPORTS, meta_bytes, tar_gz, view_bytes

from src.store import POINTER_NAMES

HUB_JS = Path(__file__).resolve().parent.parent / "ui" / "src" / "hub.js"


def _build(marker, built="2026-08-21T04:16:00Z"):
    return tar_gz({"meta.json": meta_bytes(built=built),
                   "assembled.json": view_bytes(marker), **DEFAULT_EXPORTS})


def _key(meta):
    """The interface's `buildKey`, in Python. Kept identical on purpose.

    Pinned by the test at the bottom of this file rather than trusted: every
    assertion here is written against this copy, so if the page started
    comparing something else they would all keep passing while live reload
    quietly stopped firing in the local slot — the URL that needs it most, and
    the one where a browser is the only other witness.
    """
    return meta["published"] if meta.get("dev") else meta["commit"]


# -- what the poll reads -----------------------------------------------------
def test_a_local_push_changes_the_polled_key_in_the_slot(hub):
    """The one comparison the poll makes, end to end, in the local slot.

    `commit` cannot carry it here and that is by design: the slot is ONE
    directory (SPEC 7.6), so the field reads `dev` for every build it ever
    holds. `published` is what moves — the moment the hub accepted the push,
    stamped only when the slot actually changed.

    Never `built`: that one is written by the model's own build script, is
    optional and has second resolution at best, so an edit-build-look loop
    produces ties and a poll comparing it would sit there showing the previous
    attempt. Both builds below carry the SAME `built` for exactly that reason.
    """
    hub.publish_dev("proj1", _build("first"))
    before = hub.get("/project/proj1/dev/meta.json").json()

    hub.publish_dev("proj1", _build("second"))
    after = hub.get("/project/proj1/dev/meta.json").json()

    assert before["built"] == after["built"], "the tie this test is built on"
    assert _key(before) != _key(after)
    assert after["commit"] == "dev"
    # And the geometry the viewer would re-fetch under the same relative name has
    # actually changed. Without this the keys could differ while the slot still
    # served the old view file, which is a swap that shows nothing.
    assert hub.get("/project/proj1/dev/assembled.json").content == view_bytes("second")


def test_a_commit_push_changes_the_commit_under_latest(hub):
    hub.publish("proj1", "aaa111", _build("first"))
    before = hub.get("/project/proj1/latest/meta.json").json()

    hub.publish("proj1", "bbb222", _build("second", built="2026-08-22T10:00:00Z"))
    after = hub.get("/project/proj1/latest/meta.json").json()

    assert before["commit"] == "aaa111"
    assert after["commit"] == "bbb222"


def test_the_polled_meta_is_never_cached(hub):
    """A poll a browser could answer out of its own cache is not a poll.

    The hub sends no ETag and no Last-Modified, so `no-cache` on the pointer is
    the whole of what makes the next request a real one. The commit URL is the
    opposite case and is asserted alongside, so the two cannot drift apart.
    """
    hub.publish("proj1", "aaa111", _build("first"))
    hub.publish_dev("proj1", _build("local"))
    for name in POINTER_NAMES:
        assert hub.get(f"/project/proj1/{name}/meta.json"
                       ).headers["Cache-Control"] == "no-cache", name
    assert hub.get("/project/proj1/aaa111/meta.json"
                   ).headers["Cache-Control"] == "public, max-age=31536000, immutable"


def test_republishing_the_same_local_build_does_not_look_like_a_new_one(hub):
    """Building twice without changing anything must not look like a new build.

    This is the reason the store still compares payload digests even though
    nothing is addressed by one any more: an unchanged rebuild writes nothing,
    so `published` does not move, so the key does not move. Without it every
    rebuild of an untouched model would re-render the scene and re-seat the
    camera of a page somebody is working in front of.
    """
    hub.publish_dev("proj1", _build("first"))
    before = _key(hub.get("/project/proj1/dev/meta.json").json())

    again = hub.publish_dev("proj1", _build("first"))
    assert again.status_code == 200
    assert _key(hub.get("/project/proj1/dev/meta.json").json()) == before


# -- the browser's half, pinned against the sources it lives in ---------------
# What used to sit here read the old page viewer, which has been deleted. These
# three read the interface that replaced it, so they still fail on a change
# rather than on nothing.
UI_SRC = Path(__file__).resolve().parent.parent / "ui" / "src"


def _ui_sources():
    """Every module of the browser interface, as text.

    The bundle itself is built rather than committed, so the sources ARE the
    artefact from here: a check written against `static/_v/hammerola.js` would
    pass or fail depending on whether somebody had run `make ui`.
    """
    files = sorted(UI_SRC.rglob("*.js")) + sorted(UI_SRC.rglob("*.jsx"))
    assert files, "no interface sources found — has ui/src/ moved?"
    return {path.relative_to(UI_SRC).as_posix(): path.read_text(encoding="utf-8")
            for path in files}


def test_the_key_the_page_compares_is_the_key_this_file_pins():
    """`_key` above against the real `buildKey`, field by field.

    Read out of the source rather than executed — there is no JavaScript engine
    in this suite — so what is asserted is the shape of the expression: which
    field decides, and which one is read on each side of that decision.
    """
    source = HUB_JS.read_text(encoding="utf-8")
    found = re.search(r"export function buildKey\(meta\) \{(.*?)\n\}", source, re.S)
    assert found, "buildKey is gone from ui/src/hub.js"
    body = found.group(1)
    assert "meta.dev ?" in body, "the local slot and `latest` no longer differ"
    assert "meta.published" in body and "meta.commit" in body
    # `built` is the field that must NOT decide it: optional, written by the
    # model's own script, second resolution at best, so an edit-build-look loop
    # produces ties and the poll would sit on the previous attempt.
    assert "meta.built" not in body


def test_the_interface_watches_exactly_the_pointers_the_hub_has():
    """Three copies of one list, kept identical.

    A third pointer added to the store would otherwise get no live reload, and a
    name dropped from the store would leave the page polling a 404 forever —
    both silent, both only visible in a browser. The list decides two separate
    things and they are not in the same file: what live reload watches
    (ui/src/hub.js) and what the remembered choice may be (SPEC 9,
    static/_v/pointer_pref.js, which the pointer page's own script imports).
    """
    for path in (Path(__file__).resolve().parent.parent
                 / "static" / "_v" / "pointer_pref.js", HUB_JS):
        source = path.read_text(encoding="utf-8")
        found = re.search(r"(?:export )?const POINTER_NAMES = \[([^\]]*)\];", source)
        assert found, f"POINTER_NAMES is gone from {path.name}"
        names = tuple(re.findall(r"['\"]([^'\"]+)['\"]", found.group(1)))
        assert names == POINTER_NAMES, path.name


def test_the_interface_never_reloads_the_page():
    """The camera is the state this feature exists to keep.

    `location.reload()` would throw away the angle, the tree state, the view and
    anything typed into the comment box — i.e. every single thing the swap goes
    out of its way to carry across — while looking like it works.
    """
    for name, text in _ui_sources().items():
        for forbidden in ("location.reload", "window.reload", "history.go(0)"):
            assert forbidden not in text, f"{name}: {forbidden}"


def test_the_interface_holds_no_connection_open():
    """Polling, and deliberately not SSE or a websocket.

    The hub is a ThreadingHTTPServer: one thread per connection. A long-lived
    connection is a thread parked for as long as a tab stays open, competing with
    publishes for the very resource MAX_CONCURRENT_PUBLISHES and SOCKET_TIMEOUT
    exist to protect — and a forgotten tab holds it forever.
    """
    for name, text in _ui_sources().items():
        for forbidden in ("EventSource", "WebSocket"):
            assert forbidden not in text, f"{name}: {forbidden}"
