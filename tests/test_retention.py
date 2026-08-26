"""Retention (SPEC 5.3, 7.3).

Every build is ~2 MB per view, so without a ceiling the volume grows linearly with
the number of pushes forever. The rule has two halves and the second one is the
one worth testing: keep the newest N *and never delete the build `latest` points
at*, even when it has fallen out of the window. A dangling `latest` would take the
project's only memorable URL offline in order to save 2 MB.
"""

import errno
import os
import time
from pathlib import Path

from harness import meta_bytes, tar_gz, view_bytes

from src import store as store_module
from src.store import Store


def _build(marker, built):
    return tar_gz({
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
    })


def _commits_on_disk(hub, pid):
    return sorted(p.name for p in hub.project_dir(pid).iterdir()
                  if p.is_dir() and not p.is_symlink()
                  and not p.name.startswith("."))


def test_builds_beyond_the_limit_are_pruned(hub_factory):
    hub = hub_factory(retention_builds=3)
    for day in range(1, 6):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    # Five pushed, three kept — the three newest by `built`.
    assert _commits_on_disk(hub, "proj1") == ["c3", "c4", "c5"]
    assert os.readlink(hub.project_dir("proj1") / "latest") == "c5"


def test_builds_json_lists_only_what_survived(hub_factory):
    import json
    hub = hub_factory(retention_builds=2)
    for day in range(1, 5):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    # A picker offering a commit that retention has deleted would 404 on click.
    assert [b["commit"] for b in builds["builds"]] == ["c4", "c3"]


def test_latest_always_resolves_after_pruning(hub_factory):
    """Whatever retention deletes, /latest/ still serves a build."""
    hub = hub_factory(retention_builds=2)
    for day in range(1, 6):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    target = os.readlink(hub.project_dir("proj1") / "latest")
    assert (hub.project_dir("proj1") / target).is_dir()
    # Resolving THROUGH the symlink: a dangling link is the failure being guarded.
    assert (hub.project_dir("proj1") / "latest" / "meta.json").is_file()


def test_prune_never_deletes_the_target_of_latest(hub_factory):
    """The carve-out in SPEC 7.3, exercised directly.

    Publishing cannot reach this state on its own: every push repoints `latest` at
    the newest build, so the symlink's target is always inside the window. The
    carve-out exists for the states publishing does not produce — a build pinned
    by hand, a rollback, a symlink restored from a backup — so the honest way to
    test it is to create that state and call retention against it, rather than to
    write a publish sequence that quietly never triggers the branch at all.
    """
    # Publish with a window wide enough that nothing is pruned on the way in.
    hub = hub_factory(retention_builds=10)
    for day in range(1, 5):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))
    pdir = hub.project_dir("proj1")
    assert _commits_on_disk(hub, "proj1") == ["c1", "c2", "c3", "c4"]

    # Pin `latest` to the OLDEST build — a rollback, or a link restored from a
    # backup. Publishing would immediately move it back, so nothing is published
    # after this point.
    os.remove(pdir / "latest")
    os.symlink("c1", pdir / "latest")

    # Now run retention with a window of 2 over the same tree. c1 is two builds
    # outside it and would go, if the symlink did not protect it.
    strict = Store(data_dir=hub.data, retention_builds=2,
                   max_build_bytes=8 * 1024 * 1024)
    strict._prune("proj1")

    assert (pdir / "c1").is_dir(), (
        "retention deleted the build `latest` points at, which SPEC 7.3 forbids")
    assert (pdir / "latest" / "meta.json").is_file()
    # c2 is out of the window and unprotected: its removal is what proves pruning
    # actually ran, rather than the whole call having been a no-op.
    assert not (pdir / "c2").exists()
    assert _commits_on_disk(hub, "proj1") == ["c1", "c3", "c4"]


def test_retention_is_per_project(hub_factory):
    hub = hub_factory(retention_builds=2)
    for day in range(1, 4):
        hub.publish("proj1", f"a{day}", _build(f"a{day}", f"2026-08-0{day}T00:00:00Z"))
    hub.publish("proj2", "b1", _build("b1", "2026-08-01T00:00:00Z"))

    # proj2 has one build and must not be affected by proj1 being over its limit.
    assert _commits_on_disk(hub, "proj2") == ["b1"]
    assert len(_commits_on_disk(hub, "proj1")) == 2


def test_under_the_limit_nothing_is_deleted(hub_factory):
    hub = hub_factory(retention_builds=20)
    for day in range(1, 4):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))
    assert _commits_on_disk(hub, "proj1") == ["c1", "c2", "c3"]


def test_latest_moves_before_retention_runs(hub_factory):
    """`_switch_latest` first, `_prune` second — the order publish() claims.

    Swapping the two lines passes every other test in the suite, because with a
    wide window the build `latest` still points at is inside it anyway. A window
    of ONE is what separates them: retention refuses to delete the target of
    `latest` (SPEC 7.3), so pruning BEFORE the switch protects the build that is
    about to stop being latest, and the project keeps one more build than it was
    configured for — forever, growing with every project on the volume.

    The serving half is the same bug from the other side: prune-then-switch
    leaves a window in which `latest` still points at a build retention has
    already decided to delete.
    """
    hub = hub_factory(retention_builds=1)
    for day in (1, 2):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    assert _commits_on_disk(hub, "proj1") == ["c2"], (
        "the previous build survived a window of one, which is what happens when "
        "retention runs while `latest` still points at it")
    assert os.readlink(hub.project_dir("proj1") / "latest") == "c2"


def test_a_pruned_build_is_gone_and_leaves_nothing_parked(hub_factory):
    """The ordinary case: pruning both retires and finishes the job."""
    hub = hub_factory(retention_builds=2)
    for day in range(1, 5):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    assert _commits_on_disk(hub, "proj1") == ["c3", "c4"]
    for gone in ("c1", "c2"):
        assert hub.get(f"/project/proj1/{gone}/meta.json").status_code == 404
    assert [p.name for p in hub.project_dir("proj1").iterdir()
            if p.name.startswith(".trash-")] == []


def test_a_pruned_build_stops_being_served_even_when_the_delete_fails(
        hub_factory, monkeypatch):
    """Retention retires a build by RENAME, and only then deletes it.

    This is the test the ordinary case above cannot be: when every delete
    succeeds, `rmtree(victim, ignore_errors=True)` in place looks exactly the
    same from outside — build gone, nothing parked — so a rewrite to it passes.
    The difference only shows when a delete cannot finish, which is why one is
    injected here.

    `rmtree(ignore_errors=True)` gets it backwards. A partial failure leaves a
    directory that still has files in it — so it is still SERVED — but has lost
    its meta.json, so `builds_of` no longer lists it, retention never considers
    it again and nothing will ever finish the job. The rename is the atomic step
    that takes the build out of service; whether the recursive delete then
    succeeds only decides how long the bytes linger.
    """
    hub = hub_factory(retention_builds=2)
    for day in range(1, 4):
        hub.publish("proj1", f"c{day}", _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))

    def partial_rmtree(path, ignore_errors=False, **kw):
        """A delete that removes meta.json and then cannot continue.

        Shaped like the real failure — EACCES or EBUSY partway through a tree,
        with meta.json gone first because retention is what makes a directory
        invisible to `builds_of`. `ignore_errors` is honoured exactly as
        shutil.rmtree honours it, so an implementation that passes it gets what
        it asked for: a half-deleted directory and no exception.
        """
        (Path(path) / "meta.json").unlink(missing_ok=True)
        if not ignore_errors:
            raise OSError(errno.EACCES, "permission denied")

    monkeypatch.setattr(store_module.shutil, "rmtree", partial_rmtree)
    hub.publish("proj1", "c4", _build("v4", "2026-08-04T00:00:00Z"))

    pdir = hub.project_dir("proj1")
    # The delete really did fail: the bytes are still on the volume, parked under
    # a swept name. Without this the assertions below could pass on a tree that
    # was simply deleted successfully.
    parked = [p for p in pdir.iterdir() if p.name.startswith(".trash-")]
    assert parked, "the injected failure did not happen; the rest proves nothing"
    assert any((p / "assembled.json").is_file() for p in parked)

    # And yet nothing of the pruned builds is reachable, by any name. This is the
    # assertion `rmtree(ignore_errors=True)` cannot satisfy: it would leave
    # `c1/assembled.json` in place and still being served.
    for gone in ("c1", "c2"):
        assert not (pdir / gone).exists(), f"{gone} was left where it was served"
        assert hub.get(f"/project/proj1/{gone}/meta.json").status_code == 404
        assert hub.get(f"/project/proj1/{gone}/assembled.json").status_code == 404


def test_stale_leftovers_are_swept_at_startup(tmp_path):
    """A SIGKILL mid-push leaves dot-prefixed debris nothing else ever removes.

    `builds_of` skips it, the file server refuses it and retention never sees it,
    so a spooled 64 MiB body sits on the volume until somebody notices by hand.
    The sweep runs in Store.__init__, which is the one moment no publish of ours
    is in flight.
    """
    data = tmp_path / "data"
    store = Store(data_dir=data, retention_builds=5, max_build_bytes=1024 * 1024)
    pdir = store.projects_dir / "proj1"
    pdir.mkdir(parents=True, exist_ok=True)

    stale = [
        data / ".upload-deadbeef",
        data / ".wip-index.json-deadbeef",
        pdir / ".wip-builds.json-deadbeef",
        pdir / ".trash-deadbeef",
        pdir / ".tmp-abc123-deadbeef",
    ]
    for path in stale[:3]:
        path.write_bytes(b"x" * 16)
    for path in stale[3:]:
        path.mkdir()
        (path / "meta.json").write_text("{}")
    link = pdir / ".latest-deadbeef"
    os.symlink("nowhere", link)  # deliberately dangling, like a real leftover

    # Age them past the hour: anything younger might belong to a live publish.
    old = time.time() - 2 * 3600
    for path in stale:
        os.utime(path, (old, old))
    os.utime(link, (old, old), follow_symlinks=False)

    # Two things that must SURVIVE: a real build, and fresh debris that could
    # belong to a publish running right now.
    (pdir / "c1").mkdir()
    (pdir / "c1" / "meta.json").write_text("{}")
    fresh = pdir / ".tmp-c9-cafebabe"
    fresh.mkdir()

    Store(data_dir=data, retention_builds=5, max_build_bytes=1024 * 1024)

    for path in stale:
        assert not path.exists(), path
    assert not link.is_symlink()
    assert (pdir / "c1" / "meta.json").is_file()
    assert fresh.is_dir(), "a leftover younger than an hour may still be in use"
