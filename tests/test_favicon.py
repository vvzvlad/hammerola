"""The site icon, and the two ways a client can ask for it.

Every browser asks for an icon on every visit, and until there was one to give it
the hub answered 404 twice per page load. That is cosmetic in the response and
not in the log, which is where it showed up.

The fix has two halves and this file covers both, because either one alone leaves
the 404 in place for somebody: the `<link rel="icon">` in the templates is what
stops a browser asking for `/favicon.ico` at all, and the `/favicon.ico` route is
what answers the clients that never parsed a page to see that link.
"""

from src.app import FAVICON_ASSET, STATIC_DIR
from src.render import TEMPLATES_DIR

SVG_TYPE = "image/svg+xml"
FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="/_v/favicon.svg">'


def test_favicon_ico_serves_the_svg(hub):
    # The URL says .ico and the bytes are SVG, deliberately: the content type is
    # what a browser renders by, and generating a binary .ico for a path almost
    # nothing takes buys nothing. If this ever has to become a real .ico, this
    # assertion is the one that has to change with it.
    r = hub.get("/favicon.ico")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == SVG_TYPE
    assert r.content.startswith(b"<svg")


def test_favicon_ico_answers_head_without_a_body(hub):
    # curl -I, a monitor and a link checker all use HEAD, and every handler here
    # threads `with_body` for exactly that reason. A Content-Length that did not
    # match the bytes GET would send breaks keep-alive on an HTTP/1.1 connection.
    body = hub.get("/favicon.ico").content
    r = hub.request("HEAD", "/favicon.ico")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == SVG_TYPE
    assert int(r.headers["Content-Length"]) == len(body)
    assert r.content == b""


def test_the_icon_is_served_under_its_own_name_too(hub):
    # This is the URL the pages actually link, so it is the one that matters for
    # every real visitor; /favicon.ico is the fallback, not the other way round.
    r = hub.get(f"/_v/{FAVICON_ASSET}")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == SVG_TYPE
    assert len(r.content) > 0


def test_the_icon_is_not_cached_forever(hub):
    # It is one of OUR assets, not the vendored bundle: it changes with the image
    # under a stable name, so an immutable year would leave everyone who ever
    # loaded the site on the old icon with no way to recall it.
    assert hub.get("/favicon.ico").headers["Cache-Control"] == "no-cache"
    assert hub.get(f"/_v/{FAVICON_ASSET}").headers["Cache-Control"] == "no-cache"


def test_the_icon_ships_in_the_repository():
    # `static/_v/hammerola*` is gitignored (it is the generated bundle), and a
    # name that fell under that prefix would work on the machine that made it and
    # be absent from every checkout and every image.
    path = STATIC_DIR / "_v" / FAVICON_ASSET
    assert path.is_file()
    assert not path.name.startswith("hammerola")


def test_every_page_links_the_icon():
    # All three, because a browser only skips /favicon.ico on the pages that told
    # it where to look — one template left out means the 404s come back for
    # whichever URL it serves.
    for name in ("index.html", "build.html", "pointer.html"):
        markup = (TEMPLATES_DIR / name).read_text(encoding="utf-8")
        assert FAVICON_LINK in markup, name
