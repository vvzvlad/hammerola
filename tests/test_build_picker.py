"""The build picker: three destinations, and they are not the same kind.

`dev` and `latest` are NAMES that resolve to whatever is current and are
rewritten under the reader; a commit is a build with a permanent URL. The picker
has to offer all three, mark which one the page is currently on, and never offer
a name that resolves to nothing.

What is pinned here is the SERVER's half of that: what `builds.json` promises,
and that every destination it names actually answers. The browser's half — that
the interface reads exactly these field names and selects by the URL it is on
rather than by the build that answered — is checked against the live sources in
tests/test_ui_source.py (`test_the_build_picker_reads_the_fields_builds_json_carries`),
which is where it stayed live when the old page viewer was deleted.
"""

from harness import DEFAULT_EXPORTS, meta_bytes, tar_gz, view_bytes


def _build(marker, built="2026-08-21T04:16:00Z"):
    return tar_gz({"meta.json": meta_bytes(built=built),
                   "assembled.json": view_bytes(marker), **DEFAULT_EXPORTS})


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
