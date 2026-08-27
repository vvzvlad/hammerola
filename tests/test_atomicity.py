"""Publication is atomic (SPEC 7.2).

The claim is precise: "at no step must there be a moment when `latest` points at a
half-unpacked directory". A test that only inspected the tree AFTER a publish
finished could not observe that at all — every implementation looks correct once
it has stopped moving. So these tests read WHILE writing, and assert on what the
reader saw.

The mechanism under test is `os.symlink` to a temporary name followed by
`os.rename` over the old link. The tempting alternative — unlink the old link,
then create the new one — is wrong in a way that is invisible in development: the
window where nothing exists is microseconds wide on an idle laptop and opens on
every single publish in production.
"""

import json
import os
import threading
import time

from harness import meta_bytes, tar_gz, view_bytes

from src import store
from src.store import Store


def _build(marker, built, padding=0):
    files = {
        "meta.json": meta_bytes(built=built),
        "assembled.json": view_bytes(marker),
    }
    if padding:
        # Bulk makes unpacking take long enough that a reader has a real chance of
        # landing inside it. Without this the race window is too narrow to sample.
        files["bulk.json"] = b'{"pad":"' + (b"x" * padding) + b'"}'
    return tar_gz(files)


class _WatchedOs:
    """A stand-in for the `os` module, installed into `src.store` alone.

    Patching `os.rename` on the os module itself would reach the whole
    interpreter: `shutil.rmtree` calls `os.unlink`, so do the server threads
    serving unrelated requests, and the recording would then be a mixture of what
    the store did and what everything else did. Swapping the NAME `os` inside one
    module keeps the observation where the claim is.

    Everything not overridden below falls through to the real module.
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

    A concurrency test cannot carry this one. The gap opened by
    "unlink the old link, then create the new one" is a few MICROSECONDS wide, so
    the reader-thread test below samples it only by luck — it may well go red on
    a broken implementation, but it is probabilistic, and a test that certifies a
    fix only most of the time is not what this property deserves.

    So the mechanism is asserted instead of its symptom. "There is never a moment
    when `latest` is absent" is exactly equivalent to "the live path is never
    unlinked — it is only ever replaced by a rename onto it", and that is a
    property of the syscalls, which can be observed exactly.
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
                               payload["variants"][0]["file"])
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

    Two properties, both load-bearing for the concurrency test below. The unique
    NAME is what makes a mixture observable at all: if a reader's meta.json says
    `v3.json` and the directory it came from does not hold `v3.json`, the two
    halves are from different builds — invisible when every build ships the same
    `assembled.json`, which is why the `latest` test above cannot see it either.

    The SIZE is what gives a reader time to land inside a build being assembled.
    Two megabytes is far more than the ~900 bytes of meta.json, so an
    implementation that filled the live directory file by file would be caught
    with the view half-written rather than only in the instant between two
    renames.
    """
    body = json.dumps({"shapes": [marker], "pad": "x" * 2_000_000}).encode()
    return tar_gz({
        "meta.json": meta_bytes(views=[{"id": "a", "name": "a",
                                        "file": view, "parts": 1}]),
        view: body,
    })


def test_the_slot_is_filled_out_of_sight_and_swapped_in_by_rename(hub, monkeypatch):
    """The mechanism, asserted deterministically.

    "A reader is never inside a directory being filled" is exactly equivalent to
    "the live path is never written into — a finished tree is renamed ONTO it",
    and that is a property of the syscalls, which can be observed exactly. The
    concurrency test below samples the symptom, but only by luck; this one is the
    certificate.

    The old slot is renamed AWAY rather than deleted in place for the same
    reason: `rmtree` on the live directory would take a reader through a
    half-emptied build on the way to the new one.
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

    Two failures are being watched for. A torn file — a meta.json or a view that
    does not parse — means a reader was let into a directory that was still being
    filled, and needs no interpretation. A view file that is MISSING while the
    meta.json naming it is the one the slot currently holds means the directory
    is part one build and part another.

    Two things are deliberately not failures. A bare 404, because POSIX cannot
    replace a non-empty directory under a fixed name in one step: the swap is two
    renames and the name is absent between them. That is the price of the slot
    being the build itself rather than a symlink to one — `latest`, which has to
    survive being pasted into chat, pays the other way. And a 404 on a view whose
    meta.json has since been replaced, because that is not a mixture at all: it
    is a moving URL that moved between two requests, which is what it is for.
    Hence the confirming re-read — every build here ships a view file nobody else
    ships, so if the slot still names the missing one, it really is broken.
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
            return meta.json()["variants"][0]["file"]
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

    # Every refusal path, in the order they occur during a publish.
    assert hub.publish("proj1", "bad1", b"not a tarball").status_code == 422
    assert hub.publish("proj1", "bad2",
                       tar_gz({"meta.json": b"{broken"})).status_code == 422
    assert hub.publish("proj1", "bad3", _build("x", "2026-09-01T00:00:00Z"),
                       token="wrong").status_code == 401

    assert os.readlink(hub.project_dir("proj1") / "latest") == before
    assert hub.get("/project/proj1/latest/meta.json").json()["commit"] == "good1"
    for name in ("bad1", "bad2", "bad3"):
        assert not (hub.project_dir("proj1") / name).exists()


def test_a_damaged_meta_on_disk_does_not_break_the_next_publish(hub):
    """One unusable build must not take the project down with it.

    Reachable from the very scenario the `latest` carve-out is there for: a
    restore from backup that ran out halfway, or a meta.json truncated by a
    crash. Everything downstream of `builds_of` subscripts these dicts, so a
    `{}` used to reach `_switch_latest` and come back as a 500 — with the new
    build already unpacked on disk and `latest` still on the old one, so the
    retry answered 200 by idempotency and `latest` silently never moved.
    """
    hub.publish("proj1", "good1", _build("good", "2026-08-01T00:00:00Z"))
    pdir = hub.project_dir("proj1")

    damaged = {
        "empty": "{}",
        "notdict": "[]",
        "novariants": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "novariants",
            "built": "2026-08-02T00:00:00Z", "published": "2026-08-02T00:00:00Z",
            "variants": []}),
        "wrongdir": json.dumps({
            "pid": "proj1", "project": "p", "title": "t", "commit": "elsewhere",
            "built": "2026-08-02T00:00:00Z", "published": "2026-08-02T00:00:00Z",
            "variants": [{"parts": 1, "gzip": 10}]}),
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
    on_disk = {p.name for p in hub.project_dir("proj1").iterdir()
               if p.is_dir() and not p.is_symlink() and not p.name.startswith(".")}
    assert on_disk == {f"c{day}" for day in range(1, 7)}

    # And the derived state agrees with the tree rather than with whichever
    # publish happened to finish last.
    builds = json.loads((hub.project_dir("proj1") / "builds.json").read_text())
    assert {b["commit"] for b in builds["builds"]} == on_disk
    assert os.readlink(hub.project_dir("proj1") / "latest") == "c6"


def test_stale_leftovers_are_swept_at_startup(tmp_path):
    """A SIGKILL mid-push leaves dot-prefixed debris nothing else ever removes.

    `builds_of` skips it and the file server refuses it, so a spooled 64 MiB
    body sits on the volume until somebody notices by hand. The sweep runs in
    Store.__init__, which is the one moment no publish of ours is in flight.

    It lives beside the atomicity tests because it is the other half of the same
    mechanism (SPEC 7.2): every one of these names exists because a publish is
    made of a temporary thing plus a rename, and this is what collects the
    temporary thing when the rename never happened.
    """
    data = tmp_path / "data"
    store = Store(data_dir=data, max_build_bytes=1024 * 1024)
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

    Store(data_dir=data, max_build_bytes=1024 * 1024)

    for path in stale:
        assert not path.exists(), path
    assert not link.is_symlink()
    assert (pdir / "c1" / "meta.json").is_file()
    assert fresh.is_dir(), "a leftover younger than an hour may still be in use"
