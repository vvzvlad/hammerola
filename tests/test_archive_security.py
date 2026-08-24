"""Hostile archives (SPEC 7.1).

The uploaded tar is attacker-controlled the moment the publish token leaks, and it
is machine-generated even when it does not. Every test here sends a genuinely
malformed archive — built member by member with explicit TarInfo objects — and
then asserts twice: that the push was refused, AND that nothing was written where
it should not have been. The second assertion is the one that matters; a 422 with
a file already on disk outside the build directory would be a pass on the status
code and a compromise on the filesystem.
"""

import errno
import gzip
import io
import json
import os
import subprocess
import tarfile
import uuid

from harness import (chardev_entry, dir_entry, fifo_entry, file_entry,
                     hardlink_entry, meta_bytes, raw_tar_gz, symlink_entry,
                     view_bytes)


def _payload():
    """The members a valid build carries, so only the hostile one is at fault."""
    return [
        file_entry("meta.json", meta_bytes()),
        file_entry("assembled.json", view_bytes()),
    ]


def _payload_build() -> bytes:
    """The same members, as a finished archive body."""
    return raw_tar_gz(_payload())


def test_parent_traversal_member_is_refused(hub):
    body = raw_tar_gz(_payload() + [file_entry("../escaped.txt", b"pwned")])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422

    # Where it would have landed: one level up from the staging directory, i.e.
    # straight into the project directory.
    assert not (hub.project_dir("proj1") / "escaped.txt").exists()
    assert not (hub.store.projects_dir / "escaped.txt").exists()
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_deep_traversal_member_is_refused(hub):
    body = raw_tar_gz(_payload() + [
        file_entry("../../../escaped.txt", b"pwned")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.data / "escaped.txt").exists()
    assert not (hub.data.parent / "escaped.txt").exists()


def test_absolute_path_member_is_refused(tmp_path, hub):
    target = tmp_path / f"absolute-{uuid.uuid4().hex}.txt"
    body = raw_tar_gz(_payload() + [file_entry(str(target), b"pwned")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not target.exists()


def test_symlink_member_is_refused(tmp_path, hub):
    # The classic two-step: drop a symlink pointing outside, then write "through"
    # it with a second member. Refusing the link member kills the whole technique.
    outside = tmp_path / "outside.txt"
    outside.write_text("original")
    body = raw_tar_gz(_payload() + [symlink_entry("link.json", str(outside))])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert outside.read_text() == "original"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_symlink_plus_write_through_it_is_refused(tmp_path, hub):
    outside = tmp_path / "outside.txt"
    outside.write_text("original")
    body = raw_tar_gz(_payload() + [
        symlink_entry("link.json", str(outside)),
        file_entry("link.json", b"overwritten"),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert outside.read_text() == "original"


def test_hardlink_member_is_refused(tmp_path, hub):
    outside = tmp_path / "outside.txt"
    outside.write_text("original")
    body = raw_tar_gz(_payload() + [hardlink_entry("hard.json", str(outside))])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert outside.read_text() == "original"


def test_directory_members_are_skipped_not_refused(hub):
    # `tar -czf build.tar.gz .` stores an entry for the directory itself, and
    # that is the first command any model's CI will reach for. Directory entries
    # are therefore ignored rather than fatal — nothing is extracted from them,
    # and a file inside one is still refused on its own name (below).
    body = raw_tar_gz(_payload() + [dir_entry("subdir")])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    assert not (hub.project_dir("proj1") / "abc123" / "subdir").exists()
    assert sorted(p.name for p in (hub.project_dir("proj1") / "abc123").iterdir()
                  if not p.name.startswith(".")) == [
        "assembled.json", "meta.json"]


def test_an_archive_made_by_plain_tar_of_a_directory_publishes(hub, tmp_path):
    # The end-to-end version of the case above, built by the real `tar` binary
    # exactly the way a CI job would: cd into the build output and `tar -czf x .`.
    src = tmp_path / "build"
    src.mkdir()
    (src / "meta.json").write_bytes(meta_bytes())
    (src / "assembled.json").write_bytes(view_bytes())
    archive = tmp_path / "build.tar.gz"
    subprocess.run(["tar", "-czf", str(archive), "."], cwd=src, check=True)

    assert hub.publish("proj1", "abc123", archive.read_bytes()).status_code == 201
    assert (hub.project_dir("proj1") / "abc123" / "assembled.json").is_file()


def test_a_file_inside_a_directory_member_is_still_refused(hub):
    # Skipping the directory entry must not smuggle its contents in with it.
    body = raw_tar_gz(_payload() + [
        dir_entry("subdir"), file_entry("subdir/nested.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_nested_path_member_is_refused(hub):
    body = raw_tar_gz(_payload() + [file_entry("sub/nested.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_dotfile_member_cannot_forge_the_payload_digest(hub):
    # `.payload.sha256` is what tells an identical retry from a colliding one. If
    # an upload could supply its own, it could claim to match a build it differs
    # from — turning the 409 into a silent overwrite of an immutable, permanently
    # cached URL.
    body = raw_tar_gz(_payload() + [file_entry(".payload.sha256", b"0" * 64)])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_dotdot_only_member_is_refused(hub):
    assert hub.publish("proj1", "abc123",
                       raw_tar_gz(_payload() + [file_entry("..", b"x")])
                       ).status_code == 422


def test_a_member_name_with_a_trailing_newline_is_refused(hub):
    # Same anchor trap as the pid: `$` matches before a trailing newline, so
    # `^[A-Za-z0-9._-]+$` would accept "model.stl\n" and create a file whose name
    # carries an LF straight into every URL and header that mentions it.
    body = raw_tar_gz(_payload() + [file_entry("model.stl\n", b"solid")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_fifo_and_device_members_are_refused(hub):
    # Neither is something a build contains, and a FIFO in the build directory
    # would block the next reader of that path forever.
    for entry in (fifo_entry("pipe.json"), chardev_entry("null.json")):
        body = raw_tar_gz(_payload() + [entry])
        r = hub.publish("proj1", "abc123", body)
        assert r.status_code == 422, entry[0].name
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_symlink_planted_inside_data_does_not_leak_files(tmp_path, hub):
    """Defence in depth for the serving side, not the publish side.

    The archive checks stop a link from ever being unpacked, so this plants one
    by hand — the situation an operator restoring a build by hand, or any future
    hole in extraction, would produce — and asserts that serving still refuses to
    follow it out of the store.
    """
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    hub.publish("proj1", "abc123", _payload_build())

    build = hub.project_dir("proj1") / "abc123"
    os.symlink(outside, build / "leak.json")
    assert (build / "leak.json").read_text() == "secret"  # the link really works

    assert hub.get("/project/proj1/abc123/leak.json").status_code == 404
    assert hub.get("/project/proj1/latest/leak.json").status_code == 404


def test_duplicate_member_is_refused(hub):
    body = raw_tar_gz(_payload() + [file_entry("assembled.json", b"second copy")])
    assert hub.publish("proj1", "abc123", body).status_code == 422


def test_a_member_repeated_in_another_case_is_refused(hub):
    # APFS and a Docker Desktop bind mount both fold case, so these two members
    # are one file on the filesystem `make test` runs on. An exact-match check
    # passed them both, and the second one then died on O_EXCL — a 500 with a
    # stack trace for what is plainly a bad archive.
    body = raw_tar_gz(_payload() + [file_entry("ASSEMBLED.JSON", b"second copy")])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "twice" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_member_is_created_exclusively_and_without_following_a_symlink(
        hub, monkeypatch):
    # The flags are the whole reason a member cannot land on something that is
    # already there — a planted symlink, or a name the extractor has already
    # written. Nothing else in this file can see them: swapping O_EXCL for
    # O_TRUNC leaves the entire suite green, because no other test ever gets two
    # members as far as one name. So they are asserted directly, at the syscall.
    from src import store as store_module

    original = os.open
    opened = []

    def recording_open(path, flags, *args):
        recorded = os.fspath(path)
        if store_module.STAGING_PREFIX in recorded:
            opened.append((recorded, flags))
        return original(path, flags, *args)

    monkeypatch.setattr(store_module.os, "open", recording_open)
    assert hub.publish("proj1", "abc123", raw_tar_gz(_payload())).status_code == 201
    assert opened, "no archive member was extracted through os.open at all"
    for path, flags in opened:
        assert flags & os.O_EXCL, f"{path} was opened without O_EXCL"
        assert not flags & os.O_TRUNC, f"{path} was opened with O_TRUNC"
        assert flags & os.O_NOFOLLOW, f"{path} was opened without O_NOFOLLOW"


# -- damaged archives -------------------------------------------------------
# SPEC 7: a broken archive is a 422 with a message CI can act on. Opening the
# file only proves the gzip header is there; the member table, the member data
# and the trailing CRC are all read later, and every one of those used to escape
# as a 500 with a stack trace and `{"error": "internal error"}`.
def test_a_member_whose_data_is_cut_short_is_refused(hub):
    # The header declares 100000 bytes and the archive simply ends.
    header = tarfile.TarInfo("assembled.json")
    header.type = tarfile.REGTYPE
    header.mode = 0o644
    header.size = 100_000

    body = _tar_blocks(*_payload()[0]) + header.tobuf() + b"{" * 4096
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb") as gz:
        gz.write(body)

    r = hub.publish("proj1", "abc123", buffer.getvalue())
    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_truncated_gzip_stream_is_refused(hub):
    # Cut in half: the gzip header survives, so tarfile.open succeeds and the
    # failure lands in the middle of the walk instead.
    whole = raw_tar_gz(_payload() + [file_entry("big.json", b"{}" + b" " * 200_000)])
    r = hub.publish("proj1", "abc123", whole[: len(whole) // 2])
    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"


def test_a_body_of_random_bytes_is_refused(hub):
    r = hub.publish("proj1", "abc123", os.urandom(4096))
    assert r.status_code == 422, r.text


def test_a_full_disk_is_not_reported_as_a_bad_archive(hub, monkeypatch):
    # The other half of the rule above. Widening the corrupt-archive catch until
    # it swallows OSError too would be easy and wrong: ENOSPC is the volume
    # filling up, and telling CI its archive is broken sends somebody to debug a
    # file that is fine while the disk quietly stays full. It stays a 500.
    from src import store as store_module

    real_fdopen = os.fdopen

    def fdopen_on_a_full_disk(fd, *args, **kw):
        handle = real_fdopen(fd, *args, **kw)

        class Full:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                handle.close()
                return False

            def write(self, data):
                raise OSError(errno.ENOSPC, "No space left on device")

        return Full()

    monkeypatch.setattr(store_module.os, "fdopen", fdopen_on_a_full_disk)
    r = hub.publish("proj1", "abc123", raw_tar_gz(_payload()))
    assert r.status_code == 500, r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_corrupt_archive_leaves_no_staging_tree(hub):
    whole = raw_tar_gz(_payload() + [file_entry("big.json", b"{}" + b" " * 200_000)])
    hub.publish("proj1", "abc123", whole[: len(whole) // 2])
    assert [p for p in hub.project_dir("proj1").iterdir()
            if p.name.startswith(".tmp-")] == []


def test_gzip_bomb_is_refused_without_filling_the_disk(hub_factory):
    """A small body that claims to expand far beyond the ceiling.

    The compressed body passes the Content-Length check easily — that is the whole
    trick — so the only thing standing between this and a full volume is the
    running total kept while extracting.
    """
    small = hub_factory(max_build_bytes=256 * 1024)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for info, data in _payload():
            tar.addfile(info, io.BytesIO(data))
        bomb = b"\0" * (4 * 1024 * 1024)  # compresses to a few KB
        info = tarfile.TarInfo("bomb.json")
        info.size = len(bomb)
        tar.addfile(info, io.BytesIO(bomb))
    body = buffer.getvalue()

    assert len(body) < 256 * 1024, "the compressed body must pass the size gate"
    assert small.publish("proj1", "abc123", body).status_code == 413
    assert not (small.project_dir("proj1") / "abc123").exists()
    # And the staging directory it was writing into is gone with it.
    assert [p for p in small.project_dir("proj1").iterdir()
            if p.name.startswith(".tmp-")] == []


def _tar_blocks(info, data: bytes) -> bytes:
    """One member as raw tar blocks: header, content, padding to 512."""
    return info.tobuf() + data + b"\0" * (-len(data) % 512)


def test_a_header_understating_its_size_cannot_smuggle_bytes_past_the_cap(
        hub_factory):
    """The cap counts the bytes WRITTEN, not the size the header declares.

    Assembled block by block, because tarfile will not produce it: the member's
    header declares 16 bytes while a megabyte of content follows it. The header's
    checksum is computed over that lie, so it is a perfectly well-formed header.

    The property being asserted is NOT a particular status code — the extractor
    is free to hand back only the 16 bytes the header promised, in which case the
    push is ordinary and succeeds. It is that no amount of lying in a header can
    put more than max_build_bytes on disk. A ceiling written against
    `member.size`, or one that trusted the extractor's framing, would fail here.
    """
    cap = 128 * 1024
    small = hub_factory(max_build_bytes=cap)
    payload = b"\0" * (1024 * 1024)

    header = tarfile.TarInfo("big.json")
    header.type = tarfile.REGTYPE
    header.mode = 0o644
    header.size = 16

    body = b"".join(_tar_blocks(info, data) for info, data in _payload())
    body += _tar_blocks(header, payload)
    body += b"\0" * 1024  # end-of-archive marker

    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb") as gz:
        gz.write(body)

    small.publish("proj1", "abc123", buffer.getvalue())
    build = small.project_dir("proj1") / "abc123"
    if build.exists():
        written = sum(p.stat().st_size for p in build.iterdir() if p.is_file())
        assert written <= cap, (
            f"a lying header put {written} bytes on disk against a {cap} cap")
    # Whatever happened, no staging tree was left holding the megabyte either.
    assert [p for p in small.project_dir("proj1").iterdir()
            if p.name.startswith(".tmp-")] == []


def test_a_member_larger_than_the_cap_is_refused_while_extracting(hub_factory):
    """The honest version: a member that declares, and carries, too much.

    Compresses to a few KB, so the body sails through the Content-Length gate —
    the running total kept while extracting is the only thing that stops it.
    """
    small = hub_factory(max_build_bytes=128 * 1024)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for info, data in _payload():
            tar.addfile(info, io.BytesIO(data))
        big = b"\0" * (1024 * 1024)
        info = tarfile.TarInfo("big.json")
        info.size = len(big)
        tar.addfile(info, io.BytesIO(big))
    body = buffer.getvalue()
    assert len(body) < 128 * 1024, "the compressed body must pass the size gate"
    assert small.publish("proj1", "abc123", body).status_code == 413
    assert not (small.project_dir("proj1") / "abc123").exists()


def test_too_many_members_is_refused(hub):
    entries = _payload() + [
        file_entry(f"file{i}.json", b"{}") for i in range(300)]
    assert hub.publish("proj1", "abc123", raw_tar_gz(entries)).status_code == 422


def test_empty_archive_is_refused(hub):
    assert hub.publish("proj1", "abc123", raw_tar_gz([])).status_code == 422


def test_a_leading_dot_slash_prefix_is_accepted(hub):
    # `tar cf - ./meta.json` is an ordinary thing for a CI script to produce, and
    # the prefix is not a traversal. Stripping it must not weaken anything else,
    # so this is the one hostile-looking name that is allowed through.
    body = raw_tar_gz([
        file_entry("./meta.json", meta_bytes()),
        file_entry("./assembled.json", view_bytes()),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    assert (hub.project_dir("proj1") / "abc123" / "assembled.json").is_file()


def test_a_valid_build_still_publishes(hub):
    """The control: none of the checks above reject an ordinary archive.

    Without this, every test in this file would still pass if publishing were
    broken outright and refused everything.
    """
    body = raw_tar_gz(_payload())
    assert hub.publish("proj1", "abc123", body).status_code == 201
    meta = json.loads(
        (hub.project_dir("proj1") / "abc123" / "meta.json").read_text())
    assert meta["variants"][0]["file"] == "assembled.json"
    assert os.readlink(hub.project_dir("proj1") / "latest") == "abc123"
