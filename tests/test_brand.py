"""A hub's own name and mark: `render.brand_page` on the real templates, and the
`/logo` route that serves the mark."""

import pytest

from src.render import TEMPLATES_DIR, brand_page

TEMPLATES = ("index.html", "build.html", "pointer.html")
LOGO_BYTES = b"<svg xmlns='http://www.w3.org/2000/svg'/>"


def template(name):
    return (TEMPLATES_DIR / name).read_text(encoding="utf-8")


@pytest.mark.parametrize("name", TEMPLATES)
def test_an_unbranded_hub_gets_the_page_as_it_is(name):
    assert brand_page(template(name), None, False) == template(name)


@pytest.mark.parametrize("name", TEMPLATES)
def test_the_name_replaces_the_title_and_reaches_the_bundle(name):
    page = brand_page(template(name), 'A <b>&"co', False)
    escaped = "A &lt;b&gt;&amp;&quot;co"
    assert f"<title>{escaped}</title>" in page
    assert "<title>hammerola</title>" not in page
    assert f'<meta name="hmr-brand-name" content="{escaped}">' in page
    assert page.index("hmr-brand-name") < page.index("</head>")
    assert "hmr-brand-logo" not in page
    assert '<link rel="icon" type="image/svg+xml" href="/_v/favicon.svg">' in page


@pytest.mark.parametrize("name", TEMPLATES)
def test_the_logo_replaces_the_icon_and_reaches_the_bundle(name):
    page = brand_page(template(name), None, True)
    assert '<link rel="icon" href="/logo">' in page
    assert "/_v/favicon.svg" not in page
    assert '<meta name="hmr-brand-logo" content="/logo">' in page
    assert "hmr-brand-name" not in page
    assert "<title>hammerola</title>" in page


def test_the_pointer_page_draws_the_operators_mark_and_name_itself():
    # It loads no bundle, so there is no script to read the meta tags.
    page = brand_page(template("pointer.html"), "A&B", True)
    assert '<img src="/logo" alt="" height="18"><b>A&amp;B</b>' in page
    assert '<svg width="18"' not in page
    assert "<b>hammerola</b>" not in page


def test_the_pointer_page_keeps_its_drawing_when_only_the_name_changes():
    page = brand_page(template("pointer.html"), "Acme", False)
    assert '<svg width="18"' in page
    assert "</svg><b>Acme</b>" in page


def test_the_pointer_page_keeps_its_name_when_only_the_logo_changes():
    page = brand_page(template("pointer.html"), None, True)
    assert '<img src="/logo" alt="" height="18"><b>hammerola</b>' in page


@pytest.mark.parametrize("name", ("index.html", "build.html"))
def test_the_bundle_pages_have_no_mark_to_rewrite(name):
    assert "<svg" not in brand_page(template(name), "Acme", True)


def test_logo_is_served_in_the_type_its_suffix_names(hub_factory, tmp_path):
    logo = tmp_path / "mark.svg"
    logo.write_bytes(LOGO_BYTES)
    hub = hub_factory(hub_logo=str(logo))
    r = hub.get("/logo")
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "image/svg+xml"
    assert r.content == LOGO_BYTES
    head = hub.request("HEAD", "/logo")
    assert int(head.headers["Content-Length"]) == len(LOGO_BYTES)
    assert head.content == b""
    again = hub.get("/logo", headers={"If-None-Match": r.headers["ETag"]})
    assert again.status_code == 304


def test_favicon_is_the_logo_on_a_hub_that_has_one(hub_factory, tmp_path):
    # A document opened on its own links no icon, so the browser asks here.
    # The stock icon of a hub without one is tests/test_favicon.py's.
    logo = tmp_path / "mark.svg"
    logo.write_bytes(LOGO_BYTES)
    r = hub_factory(hub_logo=str(logo)).get("/favicon.ico")
    assert (r.status_code, r.content) == (200, LOGO_BYTES)
    assert r.headers["Content-Type"] == "image/svg+xml"


def test_the_pages_of_a_branded_hub_carry_the_brand(hub_factory, tmp_path):
    logo = tmp_path / "mark.png"
    logo.write_bytes(b"x")
    hub = hub_factory(hub_name="Acme", hub_logo=str(logo))
    page = hub.get("/").text
    assert "<title>Acme</title>" in page
    assert 'content="/logo"' in page
    assert hub.get("/logo").headers["Content-Type"] == "image/png"


def test_logo_is_not_found_on_a_hub_without_one(hub):
    assert hub.get("/logo").status_code == 404
    assert hub.request("HEAD", "/logo").status_code == 404
    assert "hmr-brand" not in hub.get("/").text
