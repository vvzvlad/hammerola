"""Serving the site: routes, cache headers, and what must never be reachable.

Cache-Control is the half of SPEC 3.2 / 7.4 that cannot be checked by looking at
the disk. `immutable` on a commit URL is a promise a browser acts on for a year
without revalidating, so it is only safe because a commit directory can never
change — and `latest` is the one thing that moves, so it is the one thing that may
not carry it. Getting these two backwards is invisible in development and
permanent in production.
"""

import json
import os
import re

import pytest
from harness import good_build, meta_bytes, tar_gz, view_bytes

from src.app import STATIC_DIR

IMMUTABLE = "public, max-age=31536000, immutable"


def test_health_is_ok(hub):
    r = hub.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_health_is_not_cached(hub):
    # The compose healthcheck polls this every 15s; a cached answer would keep
    # reporting healthy after the service stopped being so.
    assert hub.get("/health").headers["Cache-Control"] == "no-cache"


def test_commit_urls_are_immutable(hub):
    # The build's CONTENT — everything that can never change once published.
    hub.publish("proj1", "abc123", good_build())
    for path in ("/project/proj1/abc123/meta.json",
                 "/project/proj1/abc123/assembled.json"):
        assert hub.get(path).headers["Cache-Control"] == IMMUTABLE, path


def test_the_build_page_shell_is_never_immutable(hub):
    # The page itself is the one thing at a commit URL that is NOT part of the
    # build: it is generated from the image's template, identical everywhere, and
    # it changes whenever the viewer needs a new element. A year of `immutable`
    # on it would pin every already-published build to the markup of the day it
    # was pushed, and a build's permanent URL is the whole promise here.
    hub.publish("proj1", "abc123", good_build())
    for path in ("/project/proj1/abc123/", "/project/proj1/abc123/index.html"):
        r = hub.get(path)
        assert r.status_code == 200, path
        assert r.headers["Cache-Control"] == "no-cache", path
        assert r.headers["Content-Type"].startswith("text/html"), path
    # And it is not a file in the build directory at all, so a viewer change
    # reaches every build that was ever published.
    assert not (hub.project_dir("proj1") / "abc123" / "index.html").exists()


def test_an_uploaded_index_html_is_never_served(hub):
    # A push may contain a file called index.html. That URL belongs to the
    # generated page, so the uploaded one must not appear at it — serving it as
    # text/html would be a stored XSS on a permanent same-origin URL.
    hub.publish("proj1", "abc123", good_build(extra_files={
        "index.html": b"<script>alert(document.domain)</script>"}))
    for path in ("/project/proj1/abc123/", "/project/proj1/abc123/index.html"):
        body = hub.get(path).text
        assert "alert(document.domain)" not in body, path
        assert "/_v/hammerola.js" in body, path


def test_latest_urls_are_not_cached(hub):
    hub.publish("proj1", "abc123", good_build())
    for path in ("/project/proj1/latest/",
                 "/project/proj1/latest/meta.json",
                 "/project/proj1/latest/assembled.json"):
        assert hub.get(path).headers["Cache-Control"] == "no-cache", path


def test_the_vendored_bundle_is_immutable(hub):
    # Its name carries the library's identity: a new version arrives as a
    # differently named file, this one is never edited in place.
    r = hub.get("/_v/three-cad-viewer.css")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == IMMUTABLE


def test_our_own_assets_are_not_immutable(hub):
    # pointer.js and site.css DO change with the image under a stable name. An
    # immutable year on them means a deploy reaches nobody who has already loaded
    # the site, and there is no way to recall the cached copy.
    #
    # The browser BUNDLE is the same kind of file and is not named here, because
    # it cannot be: it is built rather than committed, so a checkout does not have
    # one and this suite runs against a checkout. What covers it is the rule
    # rather than the list -- `_serve_asset` decides the header from the path, and
    # `static/_v/` is `no-cache` whatever is in it.
    for path in ("/_v/site.css", "/_v/pointer.js"):
        r = hub.get(path)
        assert r.status_code == 200, path
        assert r.headers["Cache-Control"] == "no-cache", path
    assert hub.get("/_v/site.css").headers["Content-Type"].startswith("text/css")
    # A wrong Content-Type makes the browser refuse an ES module outright, and
    # every script this site loads is one (`<script type="module">`).
    for path in ("/_v/pointer.js", "/_v/pointer_pref.js"):
        assert hub.get(path).headers["Content-Type"].startswith("text/javascript"), path


def test_index_page_and_index_json_are_not_cached(hub):
    assert hub.get("/").headers["Cache-Control"] == "no-cache"
    assert hub.index().headers["Cache-Control"] == "no-cache"


def test_index_json_is_an_empty_list_before_any_push(hub):
    # The index page fetches this on first load; a 404 would render an error box
    # on a hub that is simply new.
    r = hub.index()
    assert r.status_code == 200
    assert r.json() == []


def test_the_list_of_projects_needs_the_token(hub):
    """`/index.json` is the one READ on this service that is guarded.

    It is the only document that answers "what is on this hub", and every id in
    it is the prefix of every permanent URL that project will ever have. The
    front page draws the sign-in screen on the 401 — but the refusal is here,
    not there: a page that fetched the cards and declined to render them would
    be a decoration one devtools tab wide.
    """
    hub.publish("proj1", "abc123", good_build())
    assert hub.index(token=None).status_code == 401
    assert hub.index(token="wrong-token").status_code == 401
    assert hub.index().status_code == 200


def test_the_refusal_says_nothing_about_what_is_behind_it(hub):
    """A 401 before the file is read, so a full hub answers like an empty one.

    Reading `index.json` first and refusing afterwards would leave the answer
    identical and the TIMING different, on the one route whose whole subject is
    whether anything exists here at all.
    """
    empty = hub.index(token=None)
    hub.publish("proj1", "abc123", good_build())
    hub.publish("proj2", "def456", good_build())
    full = hub.index(token=None)
    assert empty.status_code == full.status_code == 401
    assert empty.content == full.content


def test_a_build_stays_public_while_the_list_does_not(hub):
    """The line, stated as a test, because the two halves look inconsistent.

    A build URL is a permanent link somebody was GIVEN and pasted into a chat;
    asking its recipient for a secret is not a thing this product can do. The
    enumeration is the opposite — nobody is handed it. Closing these by accident
    while closing the list is the mistake this stops.
    """
    hub.publish("proj1", "abc123", good_build())
    for path in ("/", "/project/proj1/", "/project/proj1/abc123/",
                 "/project/proj1/abc123/meta.json",
                 "/project/proj1/abc123/assembled.json",
                 "/project/proj1/builds.json",
                 "/project/proj1/latest/meta.json",
                 "/_v/site.css"):
        assert hub.get(path).status_code == 200, path


def test_the_front_page_shell_needs_no_token(hub):
    # It carries no data at all — a div and a <script>. Guarding it would mean
    # the browser had nothing to draw the sign-in screen WITH.
    r = hub.get("/")
    assert r.status_code == 200
    assert "hmr_index" in r.text


def test_index_page_is_served_from_templates(hub):
    """The shell comes from templates/, and it names the PROJECT.

    It used to assert on `3d.vvzvlad.xyz`, which is what the page said before
    the move — a hostname, and by then a hostname the service had already left.
    Asserting on one is how a template ends up carrying somebody's DNS: the
    test makes the wrong thing load-bearing, and the next reader keeps it
    because a test depends on it.
    """
    r = hub.get("/")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("text/html")
    assert "hammerola" in r.text
    assert "vvzvlad" not in r.text, (
        "a hostname is not the name of this service, and this one has moved "
        "once already")


def test_project_root_serves_the_pointer_resolver(hub):
    # It used to be a 302 to `latest`. It cannot be one any more: which pointer
    # to open is a localStorage answer (SPEC 9), and the server cannot read it.
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("text/html")
    assert "/_v/pointer.js" in r.text


def test_project_root_without_slash_redirects_to_the_directory(hub):
    # To the DIRECTORY, not to `latest`: the resolver leaves by a relative URL
    # and its no-script link is a relative href, so both need the trailing slash.
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1")
    assert r.status_code == 302
    assert r.headers["Location"] == "/project/proj1/"


def test_project_root_of_an_unknown_project_is_a_404(hub):
    # A page that resolves to a 404 one navigation later is worse than the 404.
    assert hub.get("/project/nosuch/").status_code == 404


def test_build_url_without_trailing_slash_redirects(hub):
    # The page derives every relative fetch from its own directory, so without
    # the trailing slash meta.json would be looked for one level too high.
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/abc123")
    assert r.status_code == 302
    assert r.headers["Location"] == "/project/proj1/abc123/"


def test_build_page_is_the_viewer(hub):
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/abc123/")
    assert r.status_code == 200
    assert r.headers["Content-Type"].startswith("text/html")
    assert "/_v/hammerola.js" in r.text


def test_latest_serves_the_newest_build(hub):
    hub.publish("proj1", "aaa111", good_build("first"))
    hub.publish("proj1", "bbb222", tar_gz({
        "meta.json": meta_bytes(built="2026-08-22T10:00:00Z"),
        "assembled.json": view_bytes("second")}))

    served = hub.get("/project/proj1/latest/assembled.json").content
    assert served == view_bytes("second")
    meta = hub.get("/project/proj1/latest/meta.json").json()
    assert meta["commit"] == "bbb222"


def test_builds_json_is_served_and_not_cached(hub):
    hub.publish("proj1", "abc123", good_build())
    r = hub.get("/project/proj1/builds.json")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-cache"
    assert [b["commit"] for b in r.json()["builds"]] == ["abc123"]


def test_downloads_are_served_as_bytes(hub):
    hub.publish("proj1", "abc123", good_build(
        downloads={"stl": "model.stl"}, extra_files={"model.stl": b"solid demo"}))
    r = hub.get("/project/proj1/abc123/model.stl")
    assert r.status_code == 200
    assert r.content == b"solid demo"
    # A model format, not something the browser should try to render inline.
    assert r.headers["Content-Type"] == "model/stl"
    assert r.headers["X-Content-Type-Options"] == "nosniff"


def test_a_preview_is_served_as_a_picture_and_not_as_a_download(hub):
    """The build's PNGs are shown, not downloaded (issue #53).

    Off the whitelist a preview came back as `application/octet-stream` with
    `Content-Disposition: attachment`, so the one instruction that catches a
    part lying on the bed upside down — open the picture and look at it — saved
    a file instead of showing one. PNG is on the list because a browser handed
    one cannot be made to execute anything with it, which is exactly what the
    test below asserts about everything that is NOT on it.
    """
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    hub.publish("proj1", "abc123", good_build(
        previews={"assembled": "assembled_preview.png"},
        extra_files={"assembled_preview.png": png}))
    r = hub.get("/project/proj1/abc123/assembled_preview.png")
    assert r.status_code == 200
    assert r.content == png
    assert r.headers["Content-Type"] == "image/png"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    # Shown in the tab it is opened in, not saved to disk.
    assert "Content-Disposition" not in r.headers


def test_a_declared_preview_survives_publication_without_becoming_a_button(hub):
    """`previews` reaches the reader intact and `downloads` stays untouched.

    That is exactly what a per-part picture is: it is DECLARED, so a client can
    be told it exists without assembling its URL out of a part name and a
    suffix, and it carries no button, because ten parts would be ten buttons and
    the part is already on the page in 3D. The hub is what could conflate the
    two — it rewrites this document — so the split is asserted on the far side
    of a real publication rather than on what the build handed over.
    """
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    hub.publish("proj1", "abc123", good_build(
        previews={"base": "base_preview.png"},
        extra_files={"base_preview.png": png}))
    meta = hub.get("/project/proj1/abc123/meta.json").json()
    assert meta["previews"] == {"base": "base_preview.png"}
    assert "base_preview.png" not in meta.get("downloads", {}).values()
    assert "base_preview.png" not in [v["file"] for v in meta["variants"]]

    r = hub.get("/project/proj1/abc123/base_preview.png")
    assert r.status_code == 200
    assert r.content == png
    assert r.headers["Content-Type"] == "image/png"


def test_an_uploaded_html_file_can_never_be_active_content(hub):
    # The member-name whitelist says nothing about extensions, so a push CAN
    # contain page.html. A build URL is permanent, same-origin and immutable, so
    # serving that as text/html would be an unrecallable stored XSS against every
    # other project on the host.
    hub.publish("proj1", "abc123", good_build(extra_files={
        "page.html": b"<script>alert(document.domain)</script>",
        "logo.svg": b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
    }))
    for name in ("page.html", "logo.svg"):
        r = hub.get(f"/project/proj1/abc123/{name}")
        assert r.status_code == 200, name
        assert r.headers["Content-Type"] == "application/octet-stream", name
        assert r.headers["Content-Disposition"] == "attachment", name
        assert r.headers["X-Content-Type-Options"] == "nosniff", name


def _csp_sources(policy: str, directive: str) -> list[str]:
    """The source list that actually applies to `directive`, per CSP fallback.

    Parsed rather than string-compared on purpose: what matters about this header
    is what a browser would DO with it, and a test pinned to one exact spelling
    both breaks on a harmless reordering and passes on a rewrite that quietly
    drops a scheme.
    """
    parsed = {}
    for chunk in policy.split(";"):
        parts = chunk.split()
        if parts:
            parsed.setdefault(parts[0].lower(), parts[1:])
    return parsed.get(directive, parsed.get("default-src", []))


def test_html_pages_carry_a_content_security_policy(hub):
    # The pages build their DOM with textContent; the CSP is the backstop that
    # keeps an injected inline <script> from running if that ever slips.
    hub.publish("proj1", "abc123", good_build())
    for path in ("/", "/project/proj1/abc123/"):
        r = hub.get(path)
        policy = r.headers["Content-Security-Policy"]
        assert "'self'" in _csp_sources(policy, "default-src"), path
        assert r.headers["X-Content-Type-Options"] == "nosniff", path


def test_the_policy_allows_data_uri_images(hub):
    # SPEC 2.2/7.4: the vendored viewer css carries its entire toolbar as 74
    # `--tcv-icon-*: url("data:image/svg+xml,...")` properties, and `'self'` does
    # NOT cover the data: scheme. A policy without it blanks every toolbar button
    # in production while every test that only asserts "a CSP is present" stays
    # green, so the assertion is about what the policy PERMITS, not how it reads.
    hub.publish("proj1", "abc123", good_build())
    css = (STATIC_DIR / "_v" / "three-cad-viewer.css").read_text(encoding="utf-8")
    assert 'url("data:image/svg+xml' in css, "premise of this test is gone"
    for path in ("/", "/project/proj1/abc123/"):
        policy = hub.get(path).headers["Content-Security-Policy"]
        assert "data:" in _csp_sources(policy, "img-src"), policy
        # ...and the loophole is images only. Scripts stay on 'self': the build
        # page renders push-controlled strings, so a data:/inline escape hatch
        # here would hand every project a same-origin XSS on a permanent URL.
        scripts = _csp_sources(policy, "script-src")
        for forbidden in ("data:", "'unsafe-inline'", "'unsafe-eval'", "*"):
            assert forbidden not in scripts, policy


def test_the_policy_allows_inline_style_attributes(hub):
    # The other half of the same defect, and the half that hides: the page still
    # renders, so nothing looks broken. The vendored viewer lays its tab bar out
    # with `style="flex: 1"` ATTRIBUTES, and a policy without 'unsafe-inline' for
    # styles makes the browser keep the attribute text and never parse it — the
    # tabs collapse from 59px to 13px and read "T." "C" "M..." instead of
    # "Tree" "Clip" "Material". Measured on a live page before this was fixed.
    #
    # Asserted against the vendored bundle so the premise cannot rot silently: if
    # a future version stops laying out with inline attributes, this test says so
    # instead of pinning a concession nobody needs any more.
    # The bundle builds that markup inside a JS string, so the quotes arrive
    # ESCAPED (`style=\"flex: 1\"`). Searching for the plain form finds nothing
    # and the premise looks false — checked against the real file.
    bundle = (STATIC_DIR / "_v" / "three-cad-viewer.esm.js").read_text(
        encoding="utf-8", errors="replace")
    lays_out_inline = any(
        marker in bundle
        for marker in ('style=\\"flex', "style=\\'flex", 'style="flex', "style='flex")
    )
    assert lays_out_inline, (
        "the vendored viewer no longer lays out with inline style attributes; "
        "drop 'unsafe-inline' from style-src instead of keeping it out of habit")
    hub.publish("proj1", "abc123", good_build())
    for path in ("/", "/project/proj1/abc123/"):
        policy = hub.get(path).headers["Content-Security-Policy"]
        assert "'unsafe-inline'" in _csp_sources(policy, "style-src"), policy
        # Styles only. This must never leak into scripts, which the assertion
        # above already guards for img-src and guards here again by directive.
        assert "'unsafe-inline'" not in _csp_sources(policy, "script-src"), policy


def test_the_index_page_has_no_inline_script(hub):
    # An inline script would be blocked by our own CSP, i.e. a blank index page.
    # The front page is drawn by the React bundle now, exactly like the build
    # page; which file it must be is checked in tests/test_ui_bundle.py, so all
    # this asks is that the page reaches for a script FILE rather than carrying
    # one.
    r = hub.get("/")
    assert re.search(r'<script[^>]*\bsrc="/_v/[^"]+"', r.text), r.text
    assert "<script type=\"module\">" not in r.text


def test_head_returns_headers_without_a_body(hub):
    hub.publish("proj1", "abc123", good_build())
    r = hub.request("HEAD", "/project/proj1/abc123/meta.json")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == IMMUTABLE
    assert int(r.headers["Content-Length"]) > 0
    assert r.content == b""


# -- what must not be reachable ---------------------------------------------
def test_the_payload_digest_file_is_not_served(hub):
    # It is what distinguishes a retry from a collision. Exposing it hands an
    # attacker the value they would need to forge an identical-content claim.
    hub.publish("proj1", "abc123", good_build())
    assert (hub.project_dir("proj1") / "abc123" / ".payload.sha256").is_file()
    assert hub.get("/project/proj1/abc123/.payload.sha256").status_code == 404


@pytest.mark.skipif(not hasattr(os, "mkfifo"),
                    reason="this platform has no os.mkfifo, so no fifo can "
                           "reach a build directory in the first place")
def test_a_fifo_in_a_build_is_refused_rather_than_waited_on(hub):
    """A file the name rule and the type whitelist both let through.

    Model code writes its own output directory and nothing on the build path
    stops it from calling mkfifo there. The name need not be DECLARED — nothing
    prunes an undeclared file and publication moves the directory whole — so it
    lands at a public URL, and a plain `open()` on it blocks until a writer
    appears: a serving thread gone for good, from one GET, with no vulnerability
    involved. `_send_file` refuses it on `S_ISREG`, and it can only get there
    because the open is `O_NONBLOCK`.

    The timeout is spelled out here rather than inherited from `Hub.get`, and
    it is as much of the assertion as the status code is: without one a
    regression would hang this test instead of failing it, and a test that
    hangs is not a test.
    """
    hub.publish("proj1", "abc123", good_build())
    os.mkfifo(hub.project_dir("proj1") / "abc123" / "pipe.json")
    assert hub.get("/project/proj1/abc123/pipe.json",
                   timeout=5).status_code == 404


def test_a_directory_in_a_build_is_refused_without_leaking_a_descriptor(hub):
    """The refusal was never wrong; only the descriptor count could show this.

    A directory under a build answers 404 both before and after the fix, so
    nothing about a response can tell the two apart. What the old shape did was
    `os.fdopen(os.open(...))`: `os.open` SUCCEEDS on a directory, `os.fdopen`
    then raises `IsADirectoryError` and does NOT close the descriptor it was
    handed, and the `except OSError` around it turned that into the same correct
    404 — one descriptor lost per request, forever, on a public unauthenticated
    route, until `accept()` in socketserver quietly stopped taking connections
    with the hub still looking alive.

    It is reachable because a model writes its own output directory: `os.makedirs`
    in `model.py`, publication moves the directory whole, and nothing prunes what
    was never declared (see `store._hash_output`), so the directory lands at a
    permanent public URL that anyone can GET in a loop.

    The hub runs in this process, so its descriptors are this process's; the
    delta is measured rather than compared to zero because httpx opens and
    closes sockets of its own while the loop runs.
    """
    hub.publish("proj1", "abc123", good_build())
    os.mkdir(hub.project_dir("proj1") / "abc123" / "subdir.json")
    requests = 50
    before = len(os.listdir("/dev/fd"))
    for _ in range(requests):
        assert hub.get("/project/proj1/abc123/subdir.json").status_code == 404
    grew = len(os.listdir("/dev/fd")) - before
    # A leak is exactly one per request; connection churn is a handful either
    # way. Anything at or above a fifth of the run is the defect back.
    assert grew < requests // 5, (
        f"{grew} descriptors left open across {requests} requests for a "
        f"directory — the open is leaking one per refusal")


def test_encoded_traversal_in_the_url_is_refused(hub):
    hub.publish("proj1", "abc123", good_build())
    # %2e%2e decodes to `..`. Decoding happens before validation precisely so that
    # this is seen and rejected rather than passed through as an opaque segment.
    for path in ("/project/proj1/abc123/%2e%2e%2fmeta.json",
                 "/project/proj1/%2e%2e/%2e%2e/index.json",
                 "/_v/%2e%2e%2f%2e%2e%2fmain.py"):
        assert hub.get(path).status_code == 404, path


def test_traversal_out_of_the_assets_directory_is_refused(hub):
    for path in ("/_v/../../main.py", "/_v/../templates/build.html"):
        assert hub.get(path).status_code == 404, path


def test_unknown_paths_are_404(hub):
    for path in ("/nope", "/project", "/project/proj1/abc123/missing.json",
                 "/api/v1/publish"):
        assert hub.get(path).status_code == 404, path


def test_publish_route_rejects_get(hub):
    assert hub.get("/api/v1/publish/proj1/abc123").status_code == 404


def test_index_json_lists_projects_after_pushes(hub):
    hub.publish("proj1", "abc123", good_build())
    hub.publish("proj2", "def456", good_build())
    cards = hub.index().json()
    assert {c["pid"] for c in cards} == {"proj1", "proj2"}
    for card in cards:
        # Everything the index page renders must be present, or the card shows
        # "undefined" and nothing in the console says why.
        assert set(card) >= {"pid", "project", "title", "commit", "built",
                             "first_built", "dev", "parts", "variants", "mb"}


def test_a_card_says_whether_the_project_has_a_dev_slot(hub):
    """`dev` on the card — that the slot is occupied, and nothing about it.

    The front page shows a chip from this, and the chip is the whole of what the
    front page is allowed to say about the local slot: the card still describes
    the newest COMMIT (SPEC 7.6), because that is what the link promises.
    """
    hub.publish("proj1", "abc123", good_build())
    hub.publish("proj2", "def456", good_build())
    hub.publish_dev("proj2", good_build(marker="b"))

    cards = {c["pid"]: c for c in hub.index().json()}
    assert cards["proj1"]["dev"] is False
    assert cards["proj2"]["dev"] is True
    # The slot is not a build: it moves neither the commit on the card nor the
    # timestamp, or the front page would start describing somebody's laptop.
    assert cards["proj2"]["commit"] == "def456"


def test_a_card_carries_the_oldest_build_as_well_as_the_newest(hub):
    """`first_built` — as close to "since when" as this hub can honestly get.

    Nothing records when a project was created (`hammerola create` mints an id in
    the author's own directory), so the card carries the earliest build it holds
    and the page labels it "first built" rather than "created". It is stable
    because there is no retention: builds are never swept (SPEC 5.3), so the
    oldest one stays the oldest.
    """
    # Two builds, deliberately published newest-first, so that a card reading
    # "the first one I saw" instead of "the oldest one there is" fails here.
    hub.publish("proj2", "newer", good_build(extra_files={
        "meta.json": meta_bytes(built="2026-08-21T04:16:00Z")}))
    hub.publish("proj2", "older", good_build(extra_files={
        "meta.json": meta_bytes(built="2024-01-02T03:04:00Z")}))

    card = {c["pid"]: c for c in hub.index().json()}["proj2"]
    assert card["commit"] == "newer"
    assert card["built"] == "2026-08-21T04:16:00Z"
    assert card["first_built"] == "2024-01-02T03:04:00Z"


def test_a_single_build_is_its_own_first(hub):
    # The ordinary case, and the one where the two fields agreeing is right
    # rather than a bug: one build is both the newest and the oldest.
    hub.publish("proj1", "abc123", good_build())
    card = hub.index().json()[0]
    assert card["first_built"] == card["built"]


def test_served_meta_matches_the_file_on_disk(hub):
    hub.publish("proj1", "abc123", good_build())
    on_disk = json.loads(
        (hub.project_dir("proj1") / "abc123" / "meta.json").read_text())
    assert hub.get("/project/proj1/abc123/meta.json").json() == on_disk
