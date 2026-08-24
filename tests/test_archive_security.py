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

import pytest
from harness import (chardev_entry, dir_entry, fifo_entry, file_entry,
                     hardlink_entry, meta_bytes, raw_tar_gz, symlink_entry,
                     view_bytes)

from src import store as store_module


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


# -- names, now that a name is a PATH ---------------------------------------
# SPEC 8A.2 step 2. Every one of these was impossible to express while a member
# name could not contain a `/` at all; each is refused by the SAME clause — a
# component has to match `SAFE_COMPONENT` — which is why they are asserted
# individually rather than trusted to fall out of one regexp read carefully.
def test_a_dotdot_component_in_the_middle_of_a_path_is_refused(hub):
    # The shape a flat whitelist could not even describe, and the reason the
    # tree rules are per-component rather than "no leading ../".
    body = raw_tar_gz(_payload() + [
        file_entry("scripts/../../escaped.txt", b"pwned")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "escaped.txt").exists()
    assert not (hub.store.projects_dir / "escaped.txt").exists()
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_leading_slash_is_refused(hub):
    # Distinct from the absolute-path test above: this one looks relative apart
    # from the first character, which is exactly what a `lstrip("/")` "fix"
    # would quietly turn into an accepted member.
    body = raw_tar_gz(_payload() + [file_entry("/escaped.txt", b"pwned")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_an_empty_path_component_is_refused(hub):
    # `a//b.json` is `a/b.json` to most path handling and a different string to
    # a duplicate check, which is the whole reason it is refused rather than
    # normalized: normalizing would give two spellings of one member.
    body = raw_tar_gz(_payload() + [file_entry("a//b.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_dot_component_is_refused(hub):
    # Same argument as the empty component: `a/./b.json` names the same file as
    # `a/b.json` and must not be a second way to spell it. The leading `./` a
    # plain `tar` produces is stripped once, before this, and is the one
    # exception (its own test, further down).
    body = raw_tar_gz(_payload() + [file_entry("a/./b.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_trailing_slash_on_a_file_member_is_refused(hub):
    # A REGTYPE member whose name ends in `/`: not a directory entry, so it is
    # not skipped, and its last component is empty.
    body = raw_tar_gz(_payload() + [file_entry("sub/", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_backslash_in_a_member_name_is_refused(hub):
    # Not a separator here, which is precisely why it is worth a test: it is a
    # separator to anything that later reads this tree on a different platform,
    # and it is not in the component alphabet.
    body = raw_tar_gz(_payload() + [file_entry("sub\\..\\escaped.txt", b"x")])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_non_ascii_member_name_is_refused(hub):
    # Two of them: a plainly non-ASCII name, and a homoglyph — U+2044 FRACTION
    # SLASH — which is the interesting one, because it is what a whitelist
    # written against "does it contain a slash" would let through.
    for name in ("модель.py", "scripts⁄..⁄escaped.txt"):
        body = raw_tar_gz(_payload() + [file_entry(name, b"x")])
        r = hub.publish("proj1", "abc123", body)
        assert r.status_code == 422, name
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_dotfile_inside_a_subdirectory_is_refused(hub):
    # The no-leading-dot rule has to hold per component, not just for the first
    # one: `.payload.sha256` is what tells an identical retry from a colliding
    # one, and burying it a level down must not be a way to smuggle one in.
    body = raw_tar_gz(_payload() + [
        file_entry("sub/.payload.sha256", b"0" * 64)])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_case_collision_across_directories_is_refused(hub):
    # `a/File.json` and `A/file.json` are one file on APFS and on a Docker
    # Desktop bind mount. Folding only the last component would call these two
    # different members, and the second one would then land on the first — or,
    # with the directory folded too, die on O_EXCL as a 500.
    body = raw_tar_gz(_payload() + [
        file_entry("a/File.json", b"first"),
        file_entry("A/file.json", b"second"),
    ])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "twice" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_symlink_to_a_directory_cannot_be_written_through(tmp_path, hub):
    # The tree version of the classic two-step, and the one the move to trees
    # made expressible at all: plant a link where a DIRECTORY component goes,
    # then address a member through it. Refusing the link member kills it at the
    # first step; the directory walk would refuse it at the second even if the
    # link were somehow already there (its own test, further down).
    outside = tmp_path / "outside"
    outside.mkdir()
    body = raw_tar_gz(_payload() + [
        symlink_entry("sub", str(outside)),
        file_entry("sub/escaped.txt", b"pwned"),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 422
    assert list(outside.iterdir()) == []
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_name_claimed_by_both_a_file_and_a_directory_is_a_422(hub):
    """Not a 500, which is what an unhandled EEXIST/ENOTDIR would have been.

    Both orders, because they fail in different syscalls: `a` then `a/b.json`
    dies opening `a` as a directory (ENOTDIR), and `a/b.json` then `a` dies
    creating `a` on top of a directory (EEXIST). The duplicate map cannot see
    either one — the two names genuinely differ — so this is the filesystem
    answering, and the whole question is whether the answer is classified as the
    pusher's problem or as ours.
    """
    for extra in ([file_entry("a", b"x"), file_entry("a/b.json", b"{}")],
                  [file_entry("a/b.json", b"{}"), file_entry("a", b"x")]):
        r = hub.publish("proj1", "abc123", raw_tar_gz(_payload() + extra))
        assert r.status_code == 422, r.text
        assert r.json()["error"] != "internal error"
        assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_view_file_inside_a_subdirectory_is_refused(hub):
    """A tree is unpacked, but what the browser fetches is still a flat name.

    Serving answers `/project/<pid>/<commit>/<name>` and nothing deeper, so a
    view pointing into a subdirectory would pass every archive check, publish
    with a 201 and then 404 in the viewer — a build accepted and unopenable.
    This is the one place where accepting a tree could have opened a hole in
    something that was previously guaranteed by the flatness itself.
    """
    body = raw_tar_gz([
        file_entry("meta.json", meta_bytes(views=[
            {"id": "assembled", "name": "assembled",
             "file": "views/assembled.json", "parts": 2}])),
        file_entry("views/assembled.json", view_bytes()),
    ])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "subdirectory" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_download_inside_a_subdirectory_is_refused(hub):
    # The same rule for the other kind of reference in meta.json: a download is
    # a button that links to a build URL, and those are flat too.
    body = raw_tar_gz([
        file_entry("meta.json", meta_bytes(downloads={"step": "out/model.step"})),
        file_entry("assembled.json", view_bytes()),
        file_entry("out/model.step", b"ISO-10303-21;\n"),
    ])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "subdirectory" in r.json()["error"]


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
    # Extended for SPEC 8A.2 step 2 rather than rewritten: the tree the real
    # `tar` walks now has a subdirectory in it, so what is asserted is the
    # `./sub/file` spelling as the tar binary actually emits it — leading `./`,
    # a directory entry for `./scripts` we ignore, and the file under it.
    src = tmp_path / "build"
    (src / "scripts").mkdir(parents=True)
    (src / "meta.json").write_bytes(meta_bytes())
    (src / "assembled.json").write_bytes(view_bytes())
    (src / "scripts" / "build.py").write_bytes(b"# build\n")
    archive = tmp_path / "build.tar.gz"
    subprocess.run(["tar", "-czf", str(archive), "."], cwd=src, check=True)

    assert hub.publish("proj1", "abc123", archive.read_bytes()).status_code == 201
    build = hub.project_dir("proj1") / "abc123"
    assert (build / "assembled.json").is_file()
    assert (build / "scripts" / "build.py").read_bytes() == b"# build\n"


def test_a_file_inside_a_directory_member_lands_in_a_directory_of_ours(hub):
    # REWRITTEN for SPEC 8A.2 step 2. It used to assert that a file inside a
    # directory member was refused, which was the whole point while the archive
    # was flat. What survives the move is the half that was always the reason:
    # the directory ENTRY is not trusted. It is skipped, the directory is created
    # by the hub from the path of the file that needs it, and it gets OUR mode —
    # so an entry claiming 0o777, or claiming to be a setgid directory, changes
    # nothing about what appears on disk.
    hostile = dir_entry("subdir")
    hostile[0].mode = 0o777
    body = raw_tar_gz(_payload() + [
        hostile, file_entry("subdir/nested.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 201

    subdir = hub.project_dir("proj1") / "abc123" / "subdir"
    assert subdir.is_dir() and not subdir.is_symlink()
    assert subdir.stat().st_mode & 0o777 == 0o755, (
        "the directory took its mode from the archive instead of from the hub")
    assert (subdir / "nested.json").read_bytes() == b"{}"


def test_a_nested_member_needs_no_directory_entry_at_all(hub):
    # REWRITTEN for SPEC 8A.2 step 2: `sub/nested.json` used to be the canonical
    # refusal. It is now the canonical ACCEPTANCE, and the property worth
    # asserting is that it does not depend on the archive listing `sub/` first —
    # `tar` can be told to store files only, and a model's source is still a tree.
    body = raw_tar_gz(_payload() + [file_entry("sub/nested.json", b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    assert (hub.project_dir("proj1") / "abc123" / "sub" / "nested.json"
            ).read_bytes() == b"{}"


def test_a_source_tree_publishes_whole(hub):
    """The shape step 2 exists for: a model's source, not a build's output.

    `model.py` beside `scripts/` and `ref/`, several levels deep, in one push.
    Without this the rest of the file could all pass with tree support removed
    again — every other new test here asserts a refusal.
    """
    body = raw_tar_gz(_payload() + [
        file_entry("model.py", b"import cadquery\n"),
        file_entry("enclosure.py", b"# lid\n"),
        file_entry("scripts/build.py", b"# build\n"),
        file_entry("scripts/lib/geometry.py", b"# helpers\n"),
        file_entry("ref/vendor/rev2/part.step", b"ISO-10303-21;\n"),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 201

    build = hub.project_dir("proj1") / "abc123"
    assert (build / "model.py").read_bytes() == b"import cadquery\n"
    assert (build / "scripts" / "lib" / "geometry.py").is_file()
    assert (build / "ref" / "vendor" / "rev2" / "part.step").is_file()


def test_two_files_of_the_same_name_in_different_directories_both_arrive(hub):
    """The other side of the case-folding rule: it must not over-fold.

    `a/model.py` and `b/model.py` are two files, not a duplicate — a duplicate
    check written against the last component instead of the whole path would
    refuse an ordinary source tree, and it would do it with the confident message
    the real duplicate check prints.
    """
    body = raw_tar_gz(_payload() + [
        file_entry("a/model.py", b"# a\n"),
        file_entry("b/model.py", b"# b\n"),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    build = hub.project_dir("proj1") / "abc123"
    assert (build / "a" / "model.py").read_bytes() == b"# a\n"
    assert (build / "b" / "model.py").read_bytes() == b"# b\n"


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


def test_no_member_and_no_directory_of_one_is_opened_through_a_symlink(
        hub, monkeypatch):
    # The flags are the whole reason a member cannot land on something that is
    # already there — a planted symlink, or a name the extractor has already
    # written. Nothing else in this file can see them: swapping O_EXCL for
    # O_TRUNC leaves the entire suite green, because no other test ever gets two
    # members as far as one name. So they are asserted directly, at the syscall.
    #
    # REWRITTEN for SPEC 8A.2 step 2, in two places, and both were forced by the
    # move to `openat`. The old version selected the calls it cared about by
    # looking for the staging prefix in the PATH — but a member is now opened
    # relative to a directory descriptor, so the path is a bare component like
    # `gen.py` and the filter matched nothing at all, silently. Selecting on
    # O_CREAT instead is both narrower and impossible to make vacuous: it names
    # the flag the check is about. And the walk down the directories is asserted
    # as well, because that is where a tree can be led out of staging.
    original = os.open
    opened = []

    def recording_open(path, flags, *args, **kw):
        opened.append((os.fspath(path), flags, kw.get("dir_fd")))
        return original(path, flags, *args, **kw)

    monkeypatch.setattr(store_module.os, "open", recording_open)
    body = raw_tar_gz(_payload() + [file_entry("scripts/gen.py", b"# x\n")])
    assert hub.publish("proj1", "abc123", body).status_code == 201

    created = [(path, flags) for path, flags, _ in opened if flags & os.O_CREAT]
    assert created, "no archive member was created through os.open at all"
    for path, flags in created:
        assert flags & os.O_EXCL, f"{path} was opened without O_EXCL"
        assert not flags & os.O_TRUNC, f"{path} was opened with O_TRUNC"
        assert flags & os.O_NOFOLLOW, f"{path} was opened without O_NOFOLLOW"

    # Every directory the walk descends into is opened relative to the one above
    # it (`dir_fd`), so the kernel resolves exactly one component per call and
    # O_NOFOLLOW decides what happens if that component is a link. The staging
    # root itself is opened by absolute path and carries no dir_fd — it is ours,
    # not the archive's — which is what this filter leaves out.
    walked = [(path, flags) for path, flags, dir_fd in opened
              if flags & os.O_DIRECTORY and dir_fd is not None]
    assert [path for path, _ in walked] == ["scripts"], (
        "the directory of a nested member was not opened one component at a "
        "time relative to the staging descriptor")
    for path, flags in walked:
        assert flags & os.O_NOFOLLOW, f"{path} was descended into with a follow"


def test_a_symlink_planted_in_the_staging_tree_is_not_followed():
    """The walk refuses to write THROUGH a symlink, not merely to land on one.

    Unreachable from an archive — a link member is refused outright, two tests
    up — so the situation is built by hand, exactly the way the serving-side
    test below plants one: a directory component that is a link out of staging,
    which is what a member of the same archive would have left behind if links
    ever got through. The point is that this does not depend on the archive
    checks at all. `openat` with O_NOFOLLOW makes the escape structurally
    impossible rather than merely rejected, including against something planted
    between two members by a process we do not control.
    """
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        staging = os.path.join(tmp, "staging")
        outside = os.path.join(tmp, "outside")
        os.mkdir(staging)
        os.mkdir(outside)
        os.symlink(outside, os.path.join(staging, "sub"))

        dest_fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY)
        try:
            with pytest.raises(store_module.PublishError) as caught:
                store_module._open_member_dir(dest_fd, ["sub"], "sub/escaped.txt")
        finally:
            os.close(dest_fd)
        assert caught.value.status == 422
        assert os.listdir(outside) == []


def test_the_realpath_check_holds_on_its_own_when_the_whitelist_is_relaxed(
        hub, monkeypatch):
    """The second line of defence, with the first one deliberately removed.

    SPEC 7.1 calls the realpath check INDEPENDENT of the name whitelist, and
    until now nothing tested that claim: no archive could reach it, because the
    whitelist refused everything interesting first. So the whitelist is widened
    to accept anything and a `../escaped.txt` is pushed through it. This is the
    only test here that can see the check at all — delete the check and every
    other test in this file still passes, while this one writes a file into the
    project directory.

    It matters more after step 2 than before it: the check moved from "the
    member lands DIRECTLY in staging" to "the member lands INSIDE staging",
    which is a strictly weaker question and had to be asked without loosening
    into "anywhere whose path happens to start with these characters" (the test
    below).
    """
    import re

    monkeypatch.setattr(store_module, "SAFE_COMPONENT", re.compile(r"\A.*\Z", re.S))
    body = raw_tar_gz(_payload() + [file_entry("../escaped.txt", b"pwned")])
    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / "escaped.txt").exists()
    assert not (hub.store.projects_dir / "escaped.txt").exists()
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_containment_is_by_path_component_and_not_by_string_prefix(
        hub, monkeypatch):
    """`<staging>-evil/` is not inside `<staging>/`, and only the separator says so.

    The natural way to write "inside staging" for a tree is
    `realpath(target).startswith(real_dest)` — and that also accepts every
    SIBLING whose name merely begins with the staging directory's name. The
    escape is real rather than theoretical: it lands in the project directory,
    under a `.tmp-` name, which is dot-prefixed and therefore invisible to
    `builds_of`, to the file server and to retention, i.e. it would sit on the
    volume unnoticed until the next startup sweep.

    Naming the sibling requires knowing the staging directory's random half, so
    the uuid is pinned for the length of the request — the same trick the test
    above uses on the whitelist, for the same reason: the check cannot be
    reached from an archive any other way.
    """
    import re
    import uuid as uuid_module

    pinned = uuid_module.UUID(int=0x5EC0DE)
    monkeypatch.setattr(store_module.uuid, "uuid4", lambda: pinned)
    monkeypatch.setattr(store_module, "SAFE_COMPONENT", re.compile(r"\A.*\Z", re.S))

    sibling = f"{store_module.STAGING_PREFIX}abc123-{pinned.hex}-evil"
    body = raw_tar_gz(_payload() + [
        file_entry(f"../{sibling}/escaped.txt", b"pwned")])
    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / sibling).exists()


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
    wrote = []

    def fdopen_on_a_full_disk(fd, *args, **kw):
        handle = real_fdopen(fd, *args, **kw)

        class Full:
            """The real file object, with every write answered by ENOSPC.

            `fileno` is NOT scaffolding and must not be dropped as an unused
            method: the extractor calls `os.fchmod(out.fileno(), 0o644)` BEFORE
            its first write, so a fake without it dies of AttributeError one
            line short of the write loop, and no ENOSPC is ever raised. That
            still answers 500 — for the wrong reason — which is exactly how this
            test spent a while asserting nothing at all after the extractor
            started unpacking a tree. `wrote` below is the guard against the
            next such edit: it fails the test if the write loop is not reached,
            instead of letting some other exception hand back the same 500.

            It delegates to the descriptor of the real staging file rather than
            inventing one, so `fchmod` acts on the file the extractor thinks it
            is acting on.
            """

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                handle.close()
                return False

            def fileno(self):
                return handle.fileno()

            def write(self, data):
                wrote.append(len(data))
                raise OSError(errno.ENOSPC, "No space left on device")

        return Full()

    monkeypatch.setattr(store_module.os, "fdopen", fdopen_on_a_full_disk)
    r = hub.publish("proj1", "abc123", raw_tar_gz(_payload()))
    assert wrote, "the write loop was never reached, so no ENOSPC was raised"
    assert r.status_code == 500, r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_full_disk_during_the_directory_walk_is_not_a_bad_archive(
        hub, monkeypatch):
    """The same rule, one call earlier: the walk that creates the DIRECTORIES.

    `_open_member_dir` classifies the errno it gets from `openat` — a symlink, a
    regular file or an over-long name in the middle of the path is the pusher's
    fault and a 422 — and everything outside that set has to stay an OSError.
    Nothing looked in here before, so widening `LAYOUT_ERRNOS` by one entry was
    an invisible change: adding ENOSPC to it turns a full volume into "your
    archive cannot be unpacked", told to whoever pushed a perfectly good tree.

    The errno is injected at `openat` rather than at `mkdir` because `openat` is
    the call whose handler consults `LAYOUT_ERRNOS`; what is pinned is the
    classification of a disk-level errno arriving from the walk, not any one
    kernel path to it.
    """
    real_open = os.open
    refused = []

    def open_on_a_full_disk(path, flags, *args, **kw):
        # Only the walk's own openat: one path COMPONENT, opened relative to a
        # directory descriptor. The staging directory itself is opened without a
        # `dir_fd`, and the member's file is opened under its own leaf name, so
        # both go through untouched.
        if kw.get("dir_fd") is not None and path == "scripts":
            refused.append(path)
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_open(path, flags, *args, **kw)

    monkeypatch.setattr(store_module.os, "open", open_on_a_full_disk)
    body = raw_tar_gz(_payload() + [file_entry("scripts/gen.py", b"print(1)\n")])
    r = hub.publish("proj1", "abc123", body)

    assert refused, "the directory walk never opened 'scripts'"
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
    # REWRITTEN for SPEC 8A.2 step 2: the literal 300 was chosen to clear a
    # ceiling of 256, and the ceiling moved to 1024 because a source tree with a
    # `scripts/` and a `ref/` is legitimately larger than a build's output was.
    # The count is now derived from the constant, so the test goes on asserting
    # "the ceiling is enforced" rather than "the ceiling is 256" — the number
    # itself is argued for in store.py, in the one place it can be maintained.
    entries = _payload() + [
        file_entry(f"file{i}.json", b"{}")
        for i in range(store_module.MAX_MEMBERS + 1)]
    r = hub.publish("proj1", "abc123", raw_tar_gz(entries))
    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_tree_deeper_than_the_ceiling_is_refused(hub):
    # Depth is counted in components including the file name, so this is one
    # over. Nothing legitimate is anywhere near it; what the ceiling actually
    # buys is that no accepted archive can build a path long enough to fail with
    # ENAMETOOLONG halfway through unpacking, which would be a 500 on an archive
    # that broke no rule.
    deep = "/".join(f"d{i}" for i in range(store_module.MAX_PATH_DEPTH)) + "/x.json"
    body = raw_tar_gz(_payload() + [file_entry(deep, b"{}")])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "deep" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_tree_at_the_depth_ceiling_is_accepted(hub):
    # The boundary from the other side, so the ceiling cannot be tightened by
    # one and go unnoticed.
    ok = "/".join(f"d{i}" for i in range(store_module.MAX_PATH_DEPTH - 1)) + "/x.json"
    body = raw_tar_gz(_payload() + [file_entry(ok, b"{}")])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    assert (hub.project_dir("proj1") / "abc123" / ok).is_file()


def test_a_tree_that_expands_past_the_cap_is_refused(hub_factory):
    """The unpacked-size ceiling counts the WHOLE tree, not one file.

    A ceiling applied per member, or reset when the extractor moves into a
    subdirectory, would let a tree of individually modest files fill the volume.
    Every one of these is a quarter of the cap and they sit in different
    directories, so only a running total across the walk catches them.
    """
    cap = 128 * 1024
    small = hub_factory(max_build_bytes=cap)
    chunk = b"\0" * (cap // 4)
    body = raw_tar_gz(_payload() + [
        file_entry(f"ref/part{i}/blob.step", chunk) for i in range(8)])
    assert len(body) < cap, "the compressed body must pass the size gate"

    assert small.publish("proj1", "abc123", body).status_code == 413
    assert not (small.project_dir("proj1") / "abc123").exists()
    assert [p for p in small.project_dir("proj1").iterdir()
            if p.name.startswith(".tmp-")] == []


def test_empty_archive_is_refused(hub):
    assert hub.publish("proj1", "abc123", raw_tar_gz([])).status_code == 422


def test_a_leading_dot_slash_prefix_is_accepted(hub):
    # `tar cf - ./meta.json` is an ordinary thing for a CI script to produce, and
    # the prefix is not a traversal. Stripping it must not weaken anything else,
    # so this is the one hostile-looking name that is allowed through.
    body = raw_tar_gz([
        file_entry("./meta.json", meta_bytes()),
        file_entry("./assembled.json", view_bytes()),
        file_entry("./scripts/gen.py", b"# gen\n"),
    ])
    assert hub.publish("proj1", "abc123", body).status_code == 201
    build = hub.project_dir("proj1") / "abc123"
    assert (build / "assembled.json").is_file()
    # Stripped ONCE, at the front, and the rest of the path is checked as it
    # stands — so the prefix does not become a way to sneak a `.` component in
    # (`a/./b.json` has its own test above and is refused).
    assert (build / "scripts" / "gen.py").is_file()


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
