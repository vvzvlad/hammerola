"""Identical files across a project's builds are one file on disk (SPEC 5.3).

A part that did not change between two revisions ships the same bytes twice, and
with no retention every copy stays on the volume for good. After every publish
`Store._dedupe` hard-links such files to one inode. That is safe only while no
published file is written in place, so the tests below also push a revision
through everything the hub writes after publication and check every file still
holds the bytes its build recorded.
"""

import errno
import hashlib
import json
import os
from pathlib import Path

from harness import DEFAULT_EXPORTS, good_build, meta_bytes, tar_gz, view_bytes

from src import store as store_module
from src.store import DEV_LINK, FILE_DIGESTS_FILE

NOTES = {"docs/notes.txt": b"the same notes in every revision\n"}


def _inode(path):
    return os.stat(path).st_ino


def _build_dirs(pdir):
    return [entry for entry in pdir.iterdir()
            if entry.is_dir() and not entry.is_symlink()
            and not entry.name.startswith(".")]


def test_a_file_unchanged_between_revisions_is_one_file_on_disk(hub):
    assert hub.publish("proj1", "c1", good_build("v1", extra_files=NOTES)
                       ).status_code == 201
    assert hub.publish("proj1", "c2", good_build("v2", extra_files=NOTES)
                       ).status_code == 201
    pdir = hub.project_dir("proj1")

    # The exports and the nested file are the same bytes in both pushes; the
    # view is not.
    for name, data in {**DEFAULT_EXPORTS, **NOTES}.items():
        assert _inode(pdir / "c1" / name) == _inode(pdir / "c2" / name), name
        assert _inode(pdir / DEV_LINK / name) == _inode(pdir / "c2" / name), name
        assert (pdir / "c1" / name).read_bytes() == data
    assert (_inode(pdir / "c1" / "assembled.json")
            != _inode(pdir / "c2" / "assembled.json"))
    assert (pdir / "c1" / "assembled.json").read_bytes() == view_bytes("v1")
    assert (pdir / "c2" / "assembled.json").read_bytes() == view_bytes("v2")
    # The slot is a copy of the newest revision, so it shares that one's view.
    assert (_inode(pdir / DEV_LINK / "assembled.json")
            == _inode(pdir / "c2" / "assembled.json"))


def test_meta_json_is_never_shared_even_when_two_builds_wrote_the_same_one(hub):
    """The hub hashes a build's own meta.json and then rewrites it with the
    commit in it. Linked on that hash, two revisions would share one document
    naming one of the two commits."""
    meta = meta_bytes()
    for commit, marker in (("c1", "v1"), ("c2", "v2")):
        assert hub.publish("proj1", commit, tar_gz({
            "meta.json": meta, "assembled.json": view_bytes(marker),
            **DEFAULT_EXPORTS})).status_code == 201
    pdir = hub.project_dir("proj1")

    for build in ("c1", "c2", DEV_LINK):
        assert json.loads((pdir / build / "meta.json").read_text())["commit"] == build
    assert _inode(pdir / "c1" / "meta.json") != _inode(pdir / "c2" / "meta.json")


def test_nothing_written_after_publication_reaches_a_linked_copy(hub):
    """The paths that write into a project after publication, run over linked
    builds: a draft push into the slot, the next commit mirroring itself into
    it. Every file still hashes to what its build recorded, and every meta.json
    still names its own directory."""
    hub.publish("proj1", "c1", good_build("v1"))
    hub.publish("proj1", "c2", good_build("v2"))
    assert hub.publish_dev("proj1", good_build("draft")).status_code == 201
    assert hub.publish("proj1", "c3", good_build("v3")).status_code == 201
    pdir = hub.project_dir("proj1")
    assert _inode(pdir / "c1" / "lid.stl") == _inode(pdir / "c3" / "lid.stl")

    for build in _build_dirs(pdir):
        recorded = json.loads((build / FILE_DIGESTS_FILE).read_text())
        assert recorded, build.name
        for name, sha in recorded.items():
            assert hashlib.sha256((build / name).read_bytes()).hexdigest() == sha, (
                f"{build.name}/{name} no longer holds the bytes its build "
                f"published")
        assert json.loads((build / "meta.json").read_text())["commit"] == build.name


def test_a_file_that_will_not_link_keeps_its_own_copy(hub, monkeypatch):
    """A refused link costs that file's saving and nothing else: the publish
    lands, the file keeps its bytes, the files after it are still linked, and
    the temporary link already made for it is removed."""
    real = os.rename

    def refusing(src, dst, *args, **kwargs):
        # The rename that would put the temporary link over `lid.stl`, which
        # every build lists before `pin.stl`.
        if Path(src).name.startswith(".wip-") and Path(dst).name == "lid.stl":
            raise OSError(errno.EXDEV, "refused")
        return real(src, dst, *args, **kwargs)

    monkeypatch.setattr(store_module.os, "rename", refusing)
    assert hub.publish("proj1", "c1", good_build("v1")).status_code == 201
    assert hub.publish("proj1", "c2", good_build("v2")).status_code == 201
    pdir = hub.project_dir("proj1")

    assert _inode(pdir / "c1" / "lid.stl") != _inode(pdir / "c2" / "lid.stl")
    assert (pdir / "c2" / "lid.stl").read_bytes() == DEFAULT_EXPORTS["lid.stl"]
    assert _inode(pdir / "c1" / "pin.stl") == _inode(pdir / "c2" / "pin.stl")
    assert _inode(pdir / DEV_LINK / "pin.stl") == _inode(pdir / "c2" / "pin.stl")
    assert not [p for p in pdir.iterdir() if p.name.startswith(".wip-")]


def test_a_build_without_a_digest_record_is_hashed_and_linked_at_the_next_publish(
        hub, monkeypatch):
    """What a volume written before the record existed holds: separate copies
    and no `FILE_DIGESTS_FILE`. The record written for it then puts its
    temporary where the startup sweep looks, never inside the build."""
    hub.publish("proj1", "c1", good_build("v1"))
    pdir = hub.project_dir("proj1")
    (pdir / "c1" / FILE_DIGESTS_FILE).unlink()
    stl = pdir / "c1" / "lid.stl"
    data = stl.read_bytes()
    stl.unlink()
    stl.write_bytes(data)

    written = []
    real = store_module.atomic_write_bytes

    def recording(path, payload, *, tmp_dir=None):
        written.append((path, Path(tmp_dir) if tmp_dir else path.parent))
        return real(path, payload, tmp_dir=tmp_dir)

    monkeypatch.setattr(store_module, "atomic_write_bytes", recording)
    hub.publish("proj1", "c2", good_build("v2"))

    assert _inode(stl) == _inode(pdir / "c2" / "lid.stl")
    assert stl.read_bytes() == data
    recorded = json.loads((pdir / "c1" / FILE_DIGESTS_FILE).read_text())
    assert recorded["lid.stl"] == hashlib.sha256(data).hexdigest()
    assert "meta.json" not in recorded
    assert [tmp for path, tmp in written if path.name == FILE_DIGESTS_FILE] == [pdir]
