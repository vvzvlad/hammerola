"""Publication is atomic (SPEC 7.2).

At no step may `latest` point at a half-unpacked directory. Every implementation
looks correct once it has stopped moving, so these tests read while writing, or
assert on the syscalls. The mechanism is `os.symlink` to a temporary name followed
by `os.rename` over the old link; unlink-then-create opens a window with nothing in
it on every publish.
"""

import json
import os
import sys
import threading
import time

import pytest

from harness import DEFAULT_EXPORTS, meta_bytes, tar_gz, view_bytes

from src import store
from src.store import LEFTOVER_MAX_AGE_SECONDS, Store


def _build(marker, built, padding=0):
    files = {
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
        **DEFAULT_EXPORTS,
    }
    if padding:
        # Bulk makes unpacking take long enough that a reader has a real chance of
        # landing inside it. Without this the race window is too narrow to sample.
        files["bulk.json"] = b'{"pad":"' + (b"x" * padding) + b'"}'
    return tar_gz(files)


class _WatchedOs:
    """A stand-in for the `os` module, installed into `src.store` alone.

    Patching the real `os` module would also record `shutil.rmtree` and the server
    threads serving unrelated requests; swapping the name `os` inside one module
    keeps the observation on the store. Everything not overridden below falls
    through to the real module.
    """

    def __init__(self, unlinked, renamed_onto):
        self._unlinked = unlinked
        self._renamed_onto = renamed_onto

    def __getattr__(self, name):
        return getattr(os, name)

    def remove(self, path, *a, **kw):
        self._unlinked.append(str(path))
        return os.remove(path, *a, **kw)

    def unlink(self, path, *a, **kw):
        self._unlinked.append(str(path))
        return os.unlink(path, *a, **kw)

    def rename(self, src, dst, *a, **kw):
        self._renamed_onto.append(str(dst))
        return os.rename(src, dst, *a, **kw)


def test_latest_is_replaced_by_rename_and_never_unlinked(hub, monkeypatch):
    """The atomicity of the flip, tested deterministically.

    The gap opened by unlink-then-create is microseconds wide, so the reader-thread
    test below catches it only by luck. "`latest` is never absent" is equivalent to
    "the live path is never unlinked, only replaced by a rename onto it", which is a
    property of the syscalls and can be observed exactly.
    """
    pdir = hub.project_dir("proj1")
    pdir.mkdir(parents=True, exist_ok=True)
    # Joined, NOT resolved: once `latest` exists it is a symlink, and resolve()
    # would then report the build it points at instead of the link itself. That
    # only happens to be right here because the link does not exist yet, which is
    # precisely the kind of accident that makes a test stop testing anything.
    live = os.path.join(str(pdir), "latest")

    unlinked = []
    renamed_onto = []
    monkeypatch.setattr(store, "os", _WatchedOs(unlinked, renamed_onto))

    hub.publish("proj1", "c1", _build("v1", "2026-08-01T00:00:00Z"))
    hub.publish("proj1", "c2", _build("v2", "2026-08-02T00:00:00Z"))

    assert live in renamed_onto, (
        "`latest` was never replaced by a rename, so the flip cannot be atomic")
    assert live not in unlinked, (
        "`latest` was unlinked before being recreated, which leaves a window in "
        "which /project/<pid>/latest/ is a 404 — SPEC 7.2 requires symlink+rename")


def test_latest_is_a_symlink_not_a_copy(hub):
    """The flip is atomic only because `latest` is a symlink.

    A copied directory could not be swapped in one syscall, and it would also
    duplicate every build — ~2 MB per view, on every push (SPEC 3.2).
    """
    hub.publish("proj1", "abc123", _build("a", "2026-08-01T00:00:00Z"))
    link = hub.project_dir("proj1") / "latest"
    assert link.is_symlink()
    assert not os.path.isabs(os.readlink(link))


@pytest.mark.skipif(
    sys.platform == "darwin",
    reason="#70: APFS readlink returns EINVAL during the rename; Linux does not")
def test_readers_never_see_a_missing_or_partial_latest(hub):
    """Hammer /latest/ while builds are being published over the top of it.

    Two failures are being watched for, and they are different: a 404 means the
    symlink did not exist at that instant, i.e. the flip was not atomic; a build
    whose meta.json and assembled.json disagree means a reader was let into a
    directory that was still being filled.
    """
    hub.publish("proj1", "c0", _build("v0", "2026-08-01T00:00:00Z"))

    seen = []
    failures = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            try:
                meta = hub.get("/project/proj1/latest/meta.json")
                if meta.status_code != 200:
                    failures.append(f"meta.json -> HTTP {meta.status_code}")
                    continue
                payload = meta.json()
                commit = payload["commit"]
                # The view named by THIS meta.json has to be readable in the same
                # directory: that is what "not half-published" means.
                view = hub.get("/project/proj1/latest/" +
                               payload["views"][0]["file"])
                if view.status_code != 200:
                    failures.append(
                        f"{commit}: view -> HTTP {view.status_code}")
                    continue
                json.loads(view.content)
                seen.append(commit)
            except Exception as error:  # noqa: BLE001 - recorded, not raised
                failures.append(f"{type(error).__name__}: {error}")

    threads = [threading.Thread(target=reader, daemon=True) for _ in range(4)]
    for thread in threads:
        thread.start()
    try:
        for day in range(1, 8):
            hub.publish("proj1", f"c{day}",
                        _build(f"v{day}", f"2026-08-0{day}T00:00:00Z",
                               padding=400_000))
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=10)

    assert failures == [], f"readers saw a broken latest/: {failures[:5]}"
    assert seen, "the readers never managed to read anything"


# -- the local slot ----------------------------------------------------------
# `<pid>/dev/` is the one URL on the service whose CONTENT is rewritten (SPEC
# 7.6), so it is the one place where "a reader sees the old build or the new one,
# never a mixture" has to be established rather than assumed. It cannot be a
# symlink flip: the slot IS the build. So the tree is unpacked out of sight under
# a dot-name and swapped in by rename, and the two tests below pin both halves —
# the mechanism, deterministically, and the symptom, under load.


def _slot_build(marker, view):
    """A local build whose meta.json names a view file NOBODY else uses.

    The unique name makes a mixture observable: a meta.json naming `v3.json` read
    from a directory without `v3.json` means the two halves are from different
    builds. The size (two megabytes against ~900 bytes of meta.json) gives a reader
    time to land inside a build being filled file by file.

    The padding rides inside the leaf's `shape`, so the file is still a document the
    hub accepts (one keyed leaf per declared part, `render._match_selection`) and
    `shape` is dropped by the parser's `object_pairs_hook`, costing the walk nothing.
    """
    body = json.dumps({
        "name": "root", "id": "/root",
        "parts": [{"name": "lid", "id": "/root/lid", "key": "lid",
                   "shape": {"marker": marker, "pad": "x" * 2_000_000}}],
    }).encode()
    return tar_gz({
        "meta.json": meta_bytes(views=[{"id": "a", "name": "a",
                                        "file": view, "parts": ["lid"]}]),
        view: body,
        **DEFAULT_EXPORTS,
    })


def test_the_slot_is_filled_out_of_sight_and_swapped_in_by_rename(hub, monkeypatch):
    """The mechanism, asserted deterministically.

    "A reader is never inside a directory being filled" is equivalent to "the live
    path is never written into; a finished tree is renamed ONTO it", which is
    observable at the syscalls. The old slot is renamed AWAY rather than deleted in
    place, because `rmtree` on the live directory would take a reader through a
    half-emptied build.
    """
    pdir = hub.project_dir("proj1")
    pdir.mkdir(parents=True, exist_ok=True)
    slot = os.path.join(str(pdir), "dev")

    unlinked = []
    renamed_onto = []
    monkeypatch.setattr(store, "os", _WatchedOs(unlinked, renamed_onto))

    hub.publish_dev("proj1", _slot_build("v1", "v1.json"))
    hub.publish_dev("proj1", _slot_build("v2", "v2.json"))

    assert renamed_onto.count(slot) == 2, (
        "the slot was not put in place by a rename, so it was written into "
        "while readers could see it")
    assert not any(path.startswith(slot + os.sep) for path in unlinked), (
        "something inside the live slot was deleted, which means the previous "
        "build was emptied out in place instead of being renamed aside")


def test_readers_of_the_slot_never_see_a_mixture(hub):
    """Hammer /dev/ while it is being overwritten.

    Failures: a torn file (a meta.json or view that does not parse), meaning a
    reader got into a directory still being filled; or a view MISSING while the
    meta.json naming it is the one the slot currently holds, meaning the directory
    mixes two builds.

    Not failures: a bare 404, because POSIX cannot replace a non-empty directory in
    one step, so the swap is two renames with the name absent between them (the
    price of the slot being the build itself rather than a symlink); and a 404 on a
    view whose meta.json has since been replaced, which is a moving URL that moved.
    Hence the confirming re-read.
    """
    hub.publish_dev("proj1", _slot_build("v0", "v0.json"))

    seen = []
    mixtures = []
    stop = threading.Event()

    def named_view():
        """The view file the slot names RIGHT NOW, or None if it cannot say."""
        meta = hub.get("/project/proj1/dev/meta.json")
        if meta.status_code != 200:
            return None
        try:
            return meta.json()["views"][0]["file"]
        except Exception as error:  # noqa: BLE001 - recorded, not raised
            mixtures.append(f"torn meta.json: {type(error).__name__} {error}")
            return None

    def reader():
        while not stop.is_set():
            name = named_view()
            if name is None:
                continue        # the two-rename window; see the docstring
            view = hub.get(f"/project/proj1/dev/{name}")
            if view.status_code != 200:
                if named_view() == name:
                    mixtures.append(
                        f"{name}: HTTP {view.status_code} while the slot still "
                        f"names it")
                continue
            try:
                json.loads(view.content)
            except ValueError as error:
                mixtures.append(f"{name}: torn ({error})")
                continue
            seen.append(name)

    threads = [threading.Thread(target=reader, daemon=True) for _ in range(4)]
    for thread in threads:
        thread.start()
    try:
        for i in range(1, 8):
            hub.publish_dev("proj1", _slot_build(f"v{i}", f"v{i}.json"))
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=10)

    assert mixtures == [], f"readers saw a half-swapped slot: {mixtures[:5]}"
    assert seen, "the readers never managed to read anything"
    # And they really did read across the swaps, so the window was sampled.
    assert len(set(seen)) > 1, f"only ever saw {set(seen)}"


def test_a_failed_publish_leaves_latest_untouched(hub):
    """A refused push must not disturb what is already being served."""
    hub.publish("proj1", "good1", _build("good", "2026-08-01T00:00:00Z"))
    before = os.readlink(hub.project_dir("proj1") / "latest")

    # A build whose document the hub cannot read.
    assert hub.publish("proj1", "bad1",
                       tar_gz({"meta.json": b"{broken"})).status_code == 422

    assert os.readlink(hub.project_dir("proj1") / "latest") == before
    assert hub.get("/project/proj1/latest/meta.json").json()["commit"] == "good1"
    assert not (hub.project_dir("proj1") / "bad1").exists()


def test_a_damaged_meta_on_disk_does_not_break_the_next_publish(hub):
    """One unusable build must not take the project down with it.

    A restore from backup that ran out halfway, or a meta.json truncated by a
    crash, produces such a build. Everything downstream of `builds_of` subscripts
    these dicts, so an unusable meta must be skipped there; otherwise the next
    publish fails with the new build already unpacked and `latest` never moves.
    """
    hub.publish("proj1", "good1", _build("good", "2026-08-01T00:00:00Z"))
    pdir = hub.project_dir("proj1")

    stamps = {"built": "2026-08-02T00:00:00Z",
              "published": "2026-08-02T00:00:00Z"}
    catalogue = {"lid": {"kind": "printable"}}
    damaged = {
        "empty": "{}",
        "notdict": "[]",
        "noviews": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "noviews",
            "parts": catalogue, "views": [], **stamps}),
        # A truncated meta.json can carry a whole `views` and no catalogue, since
        # both are written by one pass, and every view's part list would then
        # resolve against nothing. `_usable_meta` refuses it like it refuses no
        # views, and `render._catalogue` refuses the same shape from the other end;
        # that pairing has to stay true.
        "noparts": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "noparts",
            "views": [{"parts": ["lid"], "gzip": 10}], **stamps}),
        "emptyparts": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "emptyparts",
            "views": [{"parts": ["lid"], "gzip": 10}], "parts": {}, **stamps}),
        # The two fields `index_card` subscripts, each a clause of `_usable_meta`.
        # `_refresh_index` does not wrap `index_card` per project, so a KeyError from
        # one damaged build breaks the rewrite of the whole index and answers the
        # next publish of any project with a 500.
        #
        # What goes red here is the listing, not that 500: these builds are stamped
        # older than `good2` and `index_card` only sees the newest meta, so a
        # missing clause shows up as a build appearing in `builds.json`.
        "nogzip": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "nogzip",
            "views": [{"parts": ["lid"]}], "parts": catalogue, **stamps}),
        # A record with no `kind` is the same failure one level down: the card
        # counts the printables, so it reads `kind` off every record.
        "nokind": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "nokind",
            "views": [{"parts": ["lid"], "gzip": 10}],
            "parts": {"lid": {}}, **stamps}),
        "wrongdir": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "elsewhere",
            "views": [{"parts": ["lid"], "gzip": 10}], "parts": catalogue,
            **stamps}),
    }
    for name, text in damaged.items():
        (pdir / name).mkdir()
        (pdir / name / "meta.json").write_text(text, encoding="utf-8")

    r = hub.publish("proj1", "good2", _build("g2", "2026-08-03T00:00:00Z"))
    assert r.status_code == 201, r.text
    # And the publish COMPLETED rather than just returning: latest moved, the
    # picker was rewritten, and the index lists the project.
    assert os.readlink(pdir / "latest") == "good2"
    listed = json.loads((pdir / "builds.json").read_text())["builds"]
    assert [b["commit"] for b in listed] == ["good2", "good1"]
    assert hub.get("/project/proj1/latest/meta.json").json()["commit"] == "good2"


def test_staging_directories_are_never_served(hub):
    """The unpacking directory must be unreachable even while it exists.

    It is named `.tmp-<commit>-<uuid>`, and the leading dot is not decoration: the
    file server refuses every path segment that starts with one, so a half-written
    build has no URL at any point in its life.
    """
    hub.publish("proj1", "abc123", _build("a", "2026-08-01T00:00:00Z"))

    # Really put them on disk. Asking for paths that do not exist proves nothing:
    # a 404 would come back from a server with no dot rule at all, so the old
    # version of this test passed for the wrong reason.
    pdir = hub.project_dir("proj1")
    staging = pdir / ".tmp-abc123-deadbeef"
    staging.mkdir()
    (staging / "meta.json").write_text('{"commit": "abc123"}')
    (staging / "index.html").write_text("<p>half-written</p>")
    os.symlink("abc123", pdir / ".latest-deadbeef")
    # Also the digest file, which lives inside a PUBLISHED build and is the one
    # dot-entry an attacker would actually want (it decides retry vs collision).
    assert (pdir / "abc123" / ".payload.sha256").is_file()

    for path in ("/project/proj1/.tmp-abc123-deadbeef/meta.json",
                 "/project/proj1/.tmp-abc123-deadbeef/index.html",
                 "/project/proj1/.tmp-abc123-deadbeef/",
                 "/project/proj1/.tmp-abc123-deadbeef",
                 "/project/proj1/.latest-deadbeef",
                 "/project/proj1/.latest-deadbeef/meta.json",
                 "/project/proj1/abc123/.payload.sha256"):
        assert hub.get(path).status_code == 404, path

    # And they really were reachable on disk the whole time.
    assert (staging / "meta.json").is_file()
    assert (pdir / ".latest-deadbeef").is_symlink()


def test_concurrent_publishes_to_one_project_all_land(hub):
    """Parallel pushes must not lose builds or corrupt the shared state.

    builds.json, the symlink and index.json are all read-modify-write over the
    whole project, so two pushes arriving together are exactly the case that
    interleaves badly.
    """
    results = {}

    def publish(day):
        r = hub.publish("proj1", f"c{day}",
                        _build(f"v{day}", f"2026-08-0{day}T00:00:00Z"))
        results[day] = r.status_code

    threads = [threading.Thread(target=publish, args=(day,))
               for day in range(1, 7)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert set(results.values()) == {201}, results
    # The slot is not one of the builds: every commit mirrors itself into it, so
    # it is there whichever of these six finished last.
    on_disk = {p.name for p in hub.project_dir("proj1").iterdir()
               if p.is_dir() and not p.is_symlink()
               and not p.name.startswith(".") and p.name != store.DEV_LINK}
    assert on_disk == {f"c{day}" for day in range(1, 7)}

    # And the derived state agrees with the tree rather than with whichever
    # publish happened to finish last.
    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert {b["commit"] for b in builds["builds"]} == on_disk
    assert os.readlink(hub.project_dir("proj1") / "latest") == "c6"


def test_stale_leftovers_are_swept_at_startup(tmp_path):
    """A SIGKILL mid-push leaves dot-prefixed debris nothing else ever removes.

    `builds_of` skips it and the file server refuses it, so a whole source tree
    checked out of a push would sit on the volume indefinitely. The sweep runs in Store.__init__, the one
    moment no publish of ours is in flight. Every one of these names is the
    temporary half of a temporary-plus-rename publish (SPEC 7.2).
    """
    data = tmp_path / "data"
    store = Store(data_dir=data)
    pdir = store.projects_dir / "proj1"
    pdir.mkdir(parents=True, exist_ok=True)
    # A variant's directory, where its slot is swapped and its `latest` moved.
    vdir = pdir / ".variants" / "ceiling"
    vdir.mkdir(parents=True)

    stale = [
        data / ".wip-index.json-deadbeef",
        pdir / ".wip-builds.json-deadbeef",
        vdir / ".wip-builds.json-deadbeef",
        data / ".src-deadbeef",
        pdir / ".trash-deadbeef",
        pdir / ".tmp-abc123-deadbeef",
        vdir / ".trash-deadbeef",
    ]
    for path in stale[:3]:
        path.write_bytes(b"x" * 16)
    for path in stale[3:]:
        path.mkdir()
        (path / "meta.json").write_text("{}")
    links = [pdir / ".latest-deadbeef", vdir / ".latest-deadbeef"]
    for link in links:
        os.symlink("nowhere", link)  # deliberately dangling, like a real leftover

    # Age them past the ceiling: anything younger might belong to a live publish.
    # Read off the constant, which follows the queue wait and so `Limits.wall_seconds`.
    # `.variants` and its entry too: they survive by name, not by age.
    old = time.time() - 2 * LEFTOVER_MAX_AGE_SECONDS
    for path in [*stale, vdir, vdir.parent]:
        os.utime(path, (old, old))
    for link in links:
        os.utime(link, (old, old), follow_symlinks=False)

    # Two things that must SURVIVE: a real build, and fresh debris that could
    # belong to a publish running right now.
    (pdir / "c1").mkdir()
    (pdir / "c1" / "meta.json").write_text("{}")
    fresh = pdir / ".tmp-c9-cafebabe"
    fresh.mkdir()

    Store(data_dir=data)

    for path in stale:
        assert not path.exists(), path
    for link in links:
        assert not link.is_symlink(), link
    assert vdir.is_dir(), "a variant's directory is no leftover"
    assert (pdir / "c1" / "meta.json").is_file()
    assert fresh.is_dir(), "a leftover younger than an hour may still be in use"
