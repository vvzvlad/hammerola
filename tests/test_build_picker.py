"""The build picker: three destinations, and they are not the same kind.

`dev` and `latest` are NAMES that resolve to whatever is current and are
rewritten under the reader; a commit is a build with a permanent URL. The picker
has to offer all three, mark which one the page is currently on, and never offer
a name that resolves to nothing.

Half of that lives in `static/_v/viewer.js` and can only be judged in a browser.
What can be pinned from here is the contract the two halves meet on: what
`builds.json` promises, and that the viewer reads exactly those fields and
selects by the URL rather than by the build that answered it.
"""

import re
from pathlib import Path

from harness import meta_bytes, tar_gz, view_bytes

VIEWER = Path(__file__).resolve().parent.parent / "static" / "_v" / "viewer.js"


def _build(marker, built="2026-08-21T04:16:00Z"):
    return tar_gz({"meta.json": meta_bytes(built=built),
                   "assembled.json": view_bytes(marker)})


def _picker(hub, pid="proj1"):
    r = hub.get(f"/project/{pid}/builds.json")
    assert r.status_code == 200, r.text
    return r.json()


# -- what the server promises ------------------------------------------------
def test_the_picker_carries_the_slot_the_pointer_and_the_history(hub):
    hub.publish("proj1", "aaa111", _build("c1", "2026-08-01T00:00:00Z"))
    hub.publish("proj1", "bbb222", _build("c2", "2026-08-02T00:00:00Z"))
    hub.publish_dev("proj1", _build("local"))

    info = _picker(hub)
    assert info["has_dev"] is True
    assert info["latest"] == "bbb222"
    # Newest first, and commits only — the slot is a destination, not an entry.
    assert [b["commit"] for b in info["builds"]] == ["bbb222", "aaa111"]


def test_a_name_that_resolves_to_nothing_is_not_offered(hub):
    """An entry leading to a 404 is worse than a missing entry.

    Both halves of this are reachable: a project CI has pushed to and nobody has
    built locally, and a project that only exists on somebody's laptop.
    """
    hub.publish("proj1", "aaa111", _build("c1"))
    assert _picker(hub)["has_dev"] is False

    hub.publish_dev("proj2", _build("local"))
    info = _picker(hub, "proj2")
    assert info["latest"] is None
    assert info["builds"] == []
    assert info["has_dev"] is True


def test_the_picker_exists_for_a_project_that_has_only_a_local_build(hub):
    """It used to be written only when there was a commit build to list.

    A local-only project would then have had no builds.json at all, and the
    picker would have had nothing to read — including the fact that the slot it
    is currently showing exists.
    """
    hub.publish_dev("proj1", _build("local"))
    info = _picker(hub)
    assert info["pid"] == "proj1"
    assert info["project"] == "demo"      # taken from the slot's own meta.json
    assert info["has_dev"] is True


def test_the_slot_appearing_updates_the_picker_of_a_project_that_had_none(hub):
    hub.publish("proj1", "aaa111", _build("c1"))
    assert _picker(hub)["has_dev"] is False
    hub.publish_dev("proj1", _build("local"))
    assert _picker(hub)["has_dev"] is True


def test_the_picker_is_never_cached(hub):
    """It changes on every publish, so a cached copy offers a stale history."""
    hub.publish("proj1", "aaa111", _build("c1"))
    assert hub.get("/project/proj1/builds.json"
                   ).headers["Cache-Control"] == "no-cache"


def test_every_offered_destination_actually_answers(hub):
    """The promise, end to end: everything the picker names is reachable.

    Each option's value goes straight into `location.href` as
    `/project/<pid>/<value>/`, so this is the same walk the reader makes.
    """
    hub.publish("proj1", "aaa111", _build("c1", "2026-08-01T00:00:00Z"))
    hub.publish("proj1", "bbb222", _build("c2", "2026-08-02T00:00:00Z"))
    hub.publish_dev("proj1", _build("local"))

    info = _picker(hub)
    destinations = [b["commit"] for b in info["builds"]]
    if info["has_dev"]:
        destinations.append("dev")
    if info["latest"]:
        destinations.append("latest")
    for name in destinations:
        r = hub.get(f"/project/proj1/{name}/")
        assert r.status_code == 200, name
        assert hub.get(f"/project/proj1/{name}/meta.json").status_code == 200, name


# -- what the viewer reads ---------------------------------------------------
def _source():
    return VIEWER.read_text(encoding="utf-8")


def test_the_viewer_reads_the_two_fields_the_picker_publishes():
    """One name on each side of the wire, kept identical.

    A rename on either side would silently stop offering the destination — the
    picker would simply be missing a row, which no test that only reads JSON can
    see.
    """
    source = _source()
    found = re.search(r"function fillBuilds\(info\) \{(.*?)\n\}", source, re.S)
    assert found, "fillBuilds is gone from viewer.js"
    body = found.group(1)
    assert "info.has_dev" in body
    assert "info.latest" in body
    assert '"dev"' in body and '"latest"' in body, (
        "the two options must navigate to the pointer URLs by name")


def test_the_viewer_selects_the_picker_by_the_URL_it_is_on():
    """Selected by the URL, not by which build answered it.

    On /dev/ the build's own id is `dev`, which is in no list; on /latest/ it is
    a commit that has its own row further down. Selecting by `meta.commit` would
    therefore leave the picker blank on one and pointing at the wrong row on the
    other — and the row it points at is what the reader navigates away from.
    """
    source = _source()
    assert re.search(r"const SLOT = location\.pathname\.split\(\"/\"\)\[3\];",
                     source), "SLOT is no longer read from the URL"
    assert "bsel.value = SLOT;" in source
    assert "bsel.value = meta.commit" not in source


def test_the_viewer_builds_the_picker_without_innerHTML():
    """Two stored XSS holes in this project came in through pushed strings.

    Everything in the picker — the commit id, `built`, the project name — comes
    out of an uploaded meta.json, and every project on this host shares one
    origin, so one push writing markup into the picker would script the whole
    site. `new Option` and `createElement` set text, never markup.
    """
    source = _source()
    assert not re.search(r"innerHTML\s*=", source)
    assert not re.search(r"insertAdjacentHTML", source)
    # And the optgroup label, which is the one string here that is NOT pushed —
    # asserted anyway, because the safe spelling is what keeps it that way.
    assert re.search(r"og\.label = label;", source)


def test_the_viewer_survives_a_picker_it_cannot_read():
    """`builds` must be treated as maybe-absent.

    builds.json is fetched with no status check, so a 404 body reaches
    `fillBuilds` as an ordinary object. Before, that threw inside the bootstrap
    and took the whole page down — including the model, which had already
    loaded.
    """
    assert "Array.isArray(info.builds)" in _source()


def test_the_page_shell_ships_the_picker(hub):
    """Addressed by id from viewer.js and never checked for existence."""
    hub.publish("proj1", "aaa111", _build("c1"))
    assert 'id="build"' in hub.get("/project/proj1/aaa111/").text
