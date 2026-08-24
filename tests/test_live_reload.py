"""Live reload: a page on a pointer URL picking up the next build by itself.

The feature itself lives in `static/_v/viewer.js` and can only be judged in a
browser. What CAN be pinned from here is the contract it stands on, and every
assertion in this file is one half of a pair that has to keep agreeing:

  * the page polls `meta.json` under its own directory and compares
    `commit@published`, so a publish must change one of those two at a URL that
    does not move — `commit` under `latest`, and `published` in the local slot,
    which is one directory called `dev` for every build it will ever hold;
  * it does so ONLY under `latest` and `dev`, because a /<commit>/ page is
    immutable by contract and carries a year of `immutable` caching to say so —
    the list of pointer names in the viewer is checked against the server's;
  * it never reloads the page, because the whole point is keeping the camera
    where the reader put it, and a reload loses it along with everything else;
  * the header controls it drives exist in the template and start hidden.
"""

import re
from pathlib import Path

from harness import good_build, meta_bytes, tar_gz, view_bytes

from src.store import POINTER_NAMES

VIEWER = Path(__file__).resolve().parent.parent / "static" / "_v" / "viewer.js"


def _build(marker, built="2026-08-21T04:16:00Z"):
    return tar_gz({"meta.json": meta_bytes(built=built),
                   "assembled.json": view_bytes(marker)})


def _key(meta):
    """The viewer's `buildKey`, in Python. Kept identical on purpose."""
    return f"{meta['commit']}@{meta['published']}"


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


# -- the page side -----------------------------------------------------------
def test_the_build_page_ships_the_live_controls(hub):
    """All three are addressed by id from viewer.js and never checked."""
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    for element in ("live_cb", "live_row", "live_hint", "live_note"):
        assert f'id="{element}"' in body, element


def test_the_switch_is_a_setting_and_the_note_is_the_header(hub):
    """The two halves of live reload are not the same kind of thing.

    Turning it on is a decision made once — it belongs in Settings, next to the
    pointing device, and it is a checkbox there rather than a header button.
    What live reload has to SAY, though, is news about the model in front of
    somebody, so `#live_note` stays in the header where the build id it is
    talking about already is.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    bar = body[body.index('<div id="bar">'):body.index('<details id="setbox">')]
    assert 'id="live_note"' in bar, "the status line left the header"
    assert "live_cb" not in bar and "live_btn" not in body, \
        "the live switch is still a header button"
    panel = body[body.index('<details id="setbox">'):]
    assert 'id="live_cb"' in panel[:panel.index("</details>")]


def test_the_live_controls_start_hidden_in_the_template(hub):
    """A /<commit>/ page must never offer them.

    That build cannot change — that is what its year of `immutable` says — so a
    switch there could only ever be a switch that does nothing. The template
    ships them hidden and viewer.js unhides them only when the last path segment
    is a pointer, so `hidden` in the markup is the default that holds for every
    commit page. The whole ROW is hidden, not the checkbox: a stray label with
    nothing to tick is worse than no row.
    """
    hub.publish("proj1", "abc123", good_build())
    body = hub.get("/project/proj1/abc123/").text
    for pattern in (r"<div class=\"set_row\" id=\"live_row\"[^>]*>",
                    r"<div class=\"set_hint\" id=\"live_hint\"[^>]*>",
                    r"<span[^>]*id=\"live_note\"[^>]*>"):
        found = re.search(pattern, body)
        assert found and "hidden" in found.group(0), pattern
    source = VIEWER.read_text(encoding="utf-8")
    assert '$("live_row").hidden = false;' in source
    assert '$("live_hint").hidden = false;' in source


def test_the_viewer_watches_exactly_the_pointers_the_hub_has():
    """One list on each side of the wire, kept identical.

    A third pointer added to the store would otherwise get no live reload, and a
    name dropped from the store would leave the viewer polling a 404 forever —
    both silent, both only visible in a browser.

    The browser's copy lives in pointer_pref.js, which viewer.js imports: the
    same list decides what live reload watches and what the remembered choice
    (SPEC 9) is allowed to be, so there is one place to keep in step with the
    store rather than two that drift apart.
    """
    source = (VIEWER.parent / "pointer_pref.js").read_text(encoding="utf-8")
    found = re.search(r"export const POINTER_NAMES = \[([^\]]*)\];", source)
    assert found, "POINTER_NAMES is gone from pointer_pref.js"
    names = tuple(re.findall(r'"([^"]+)"', found.group(1)))
    assert names == POINTER_NAMES
    # And that viewer.js still takes it from there rather than reintroducing a
    # local list that this test would no longer be looking at.
    viewer = VIEWER.read_text(encoding="utf-8")
    assert 'from "/_v/pointer_pref.js"' in viewer
    assert "const POINTER_NAMES" not in viewer


def test_the_viewer_polls_the_two_fields_this_file_pins():
    """`_key` above is a copy of the viewer's `buildKey`; keep the two the same.

    Every assertion in the first half of this file is written against that copy,
    so if the viewer started comparing something else they would all keep passing
    while live reload quietly stopped firing in the local slot — the URL that
    needs it most, and the only one where a browser is the only other witness.
    """
    source = VIEWER.read_text(encoding="utf-8")
    found = re.search(r"function buildKey\(m\) \{(.*?)\n\}", source, re.S)
    assert found, "buildKey is gone from viewer.js"
    assert "`${m.commit}@${m.published}`" in found.group(1)


def test_the_viewer_never_reloads_the_page():
    """The camera is the state this feature exists to keep.

    `location.reload()` would throw away the angle, the tree state, the view and
    anything typed into the comment box — i.e. every single thing the swap goes
    out of its way to carry across — while looking like it works.
    """
    source = VIEWER.read_text(encoding="utf-8")
    for forbidden in ("location.reload", "window.reload", "history.go(0)"):
        assert forbidden not in source, forbidden


def test_the_viewer_holds_no_connection_open():
    """Polling, and deliberately not SSE or a websocket.

    The hub is a ThreadingHTTPServer: one thread per connection. A long-lived
    connection is a thread parked for as long as a tab stays open, competing with
    publishes for the very resource MAX_CONCURRENT_PUBLISHES and SOCKET_TIMEOUT
    exist to protect — and a forgotten tab holds it forever.
    """
    source = VIEWER.read_text(encoding="utf-8")
    for forbidden in ("EventSource", "WebSocket"):
        assert forbidden not in source, forbidden
