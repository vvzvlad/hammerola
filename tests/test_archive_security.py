"""Malformed archives (SPEC 7.1).

Every test sends a malformed archive, built member by member with explicit TarInfo
objects, and asserts twice: the push was refused, and nothing was written outside the
build directory. The second assertion is the one that matters.
"""

import errno
import gzip
import io
import json
import os
import socket
import subprocess
import tarfile
import uuid

import pytest
from harness import (DEFAULT_EXPORTS, TOKEN, chardev_entry, dir_entry,
                     fifo_entry, file_entry, hardlink_entry, meta_bytes,
                     raw_tar_gz, symlink_entry, view_bytes)
from loguru import logger

# A monkeypatch rebinds a name in one module's globals, and the reader in
# `src/archive.py` looks its own names up there, so patches of those names go on
# `archive_module`; the same patch on `store_module` (which re-exports them) would
# take effect nowhere. `store_module.os` and `store_module.uuid` are the shared
# module objects, so an attribute set on them is seen everywhere.
from src import archive as archive_module
from src import store as store_module


def _payload():
    """The members a valid build carries, so only the hostile one is at fault."""
    return [
        file_entry("meta.json", meta_bytes()),
        file_entry("assembled.json", view_bytes()),
        # The exports the default catalogue names. Without them the document is
        # a 422 in its own right (a printable that declares no `files`), and
        # every test here would then be watching the wrong refusal.
        *(file_entry(name, data) for name, data in DEFAULT_EXPORTS.items()),
    ]


def _payload_build() -> bytes:
    """The same members, as a finished archive body."""
    return raw_tar_gz(_payload())


def _leftovers(hub, pid):
    """Every transient a refused push could have left behind, by name.

    Two places: `.src-<uuid>` at the root of the data directory, where a push is
    unpacked, and `.tmp-<commit>-<uuid>` inside the project, where a build writes
    its output. A missing project directory counts as clean: a push refused before
    its build was queued never creates one.
    """
    found = [p.name for p in hub.data.iterdir()
             if p.name.startswith(store_module.LEFTOVER_PREFIXES)]
    project = hub.project_dir(pid)
    if project.is_dir():
        found += [p.name for p in project.iterdir()
                  if p.name.startswith(store_module.LEFTOVER_PREFIXES)]
    return found


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


# -- one 422 for EVERY unusable name, and what it may repeat back ------------
# The refusal names every bad file at once; what it repeats back is held to
# MAX_REFUSED_NAMES_REPORTED names, each escaped.
def test_every_unusable_member_name_is_named_at_once(hub):
    bad = [f"ref/сифон-{index}-чертёж.jpg" for index in range(5)]
    body = raw_tar_gz(_payload() + [file_entry(name, b"x") for name in bad])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert [name for name in bad if name not in error] == []
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_the_refusal_says_that_nothing_else_in_the_archive_was_checked(hub):
    """Because it changes what a green retry means, and it is not obvious.

    From the first bad name onwards the walk looks at NAMES only — links,
    duplicates and member types all go unexamined. So fixing every name the
    message lists can be answered by a different refusal rather than by a
    publish, and a pusher who was not told that reads it as the hub changing its
    mind.
    """
    body = raw_tar_gz(_payload() + [
        file_entry("модель.py", b"x"),
        symlink_entry("link.py", "/etc/passwd"),
    ])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    # The link went unmentioned, which is exactly why the sentence is there.
    assert "link" in error and "duplicate" in error
    assert "Nothing else about this archive was checked" in error


def test_a_depth_refusal_and_a_name_refusal_travel_together(hub):
    """Two different faults, one answer: depth and name refusals are reported together.

    Asserted on the name and the per-entry annotation, never on the word "deep"
    alone: every one of these refusals opens with "at most 8 components deep".
    """
    deep = "/".join(f"d{i}" for i in range(store_module.MAX_PATH_DEPTH)) + "/x.json"
    body = raw_tar_gz(_payload() + [file_entry(deep, b"{}"),
                                    file_entry("модель.py", b"x")])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "(9 path components deep)" in error
    assert "d0/d1" in error          # the deep member is NAMED, not just counted
    assert "модель.py" in error


def test_the_number_of_names_a_refusal_repeats_is_capped(hub):
    """The count is what keeps a 422 readable when a tar packed by hand carries
    hundreds of bad names.

    The TOTAL is still reported, so the pusher knows the list was cut — and the
    side that names every one of them is the client, before anything is sent.
    """
    over = 7
    count = store_module.MAX_REFUSED_NAMES_REPORTED + over
    bad = [f"ref/чертёж-{index:03d}.jpg" for index in range(count)]
    body = raw_tar_gz(_payload() + [file_entry(name, b"x") for name in bad])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert error.count("чертёж") == store_module.MAX_REFUSED_NAMES_REPORTED
    assert f"{count} of them" in error
    assert f"and {over} more" in error


def test_a_refusal_repeats_no_control_characters(hub):
    """A control character reaches an operator's terminal through
    `logger.warning`, where `\\r` and an ANSI sequence rewrite the line that was
    supposed to report the refusal."""
    escapes = "ref/\x1b[2Jwiped\rboom.json"
    body = raw_tar_gz(_payload() + [file_entry(escapes, b"x")])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "\x1b" not in error and "\r" not in error
    assert "\\x1b" in error and "\\r" in error


def test_a_survey_after_a_bad_name_still_stops_at_the_size_ceiling(hub_factory):
    """The walk after the first bad name still stops at the size ceiling.

    Collecting the remaining names iterates to the end of the archive, and
    `tarfile` decompresses past each member's data to reach the next header, so
    declared sizes are counted: a bad first name must not buy a free decompression
    of a gzip bomb. 413 wins over the list of names. Here the bad name is followed
    by well-named members.
    """
    cap = 64 * 1024
    small = hub_factory(max_build_bytes=cap)
    entries = _payload() + [file_entry("ref/чертёж.jpg", b"x")]
    entries += [file_entry(f"f{i}.bin", b"\0" * (cap // 2)) for i in range(4)]

    r = small.publish("proj1", "abc123", raw_tar_gz(entries))
    assert r.status_code == 413, r.text
    assert not (small.project_dir("proj1") / "abc123").exists()


def test_a_survey_of_nothing_but_bad_names_still_stops_at_the_size_ceiling(
        hub_factory):
    """The same ceiling when every member is badly named.

    Sizes are charged on the bad-name branch too; otherwise the running total stays
    at zero however far the archive expands (a 1 MB body decompressed to 1.07 GB and
    was answered 422 instead of 413).
    """
    cap = 64 * 1024
    small = hub_factory(max_build_bytes=cap)
    entries = [file_entry(f"чертёж-{i}.bin", b"\0" * (cap // 2))
               for i in range(4)]

    r = small.publish("proj1", "abc123", raw_tar_gz(entries))
    assert r.status_code == 413, r.text
    assert not (small.project_dir("proj1") / "abc123").exists()


def _widest_legal_component() -> str:
    """The widest component `SAFE_COMPONENT` accepts, found by ASKING it.

    Derived from the pattern rather than from any constant: asking the pattern
    how wide it goes leaves nothing to drift.
    """
    width = 1
    while store_module.SAFE_COMPONENT.match("z" * (width + 1)):
        width += 1
        assert width < 100_000, "SAFE_COMPONENT no longer bounds a component"
    return "z" * width


def _longest_legal_member_name() -> str:
    """The longest name a member of an ACCEPTABLE archive can carry.

    Built from the hub's own rules — the widest component, MAX_PATH_DEPTH of
    them, and the `./` plain `tar` prefixes — rather than restated as a number.
    """
    component = _widest_legal_component()
    deepest = "/".join(component for _ in range(store_module.MAX_PATH_DEPTH))
    # The prefix `tar czf x.tar.gz .` puts on every name, and that the hub
    # strips before checking. It is part of what a legal archive can send, so it
    # is part of the longest legal name.
    return "./" + deepest


def test_the_longest_legal_member_name_is_unpacked(hub, tmp_path):
    """The longest name the path rules admit, `./` prefix included, is unpacked.

    Driven at `_unpack` rather than through a publish: the fake builder copies the
    tree with `shutil.copytree`, which dies with ENAMETOOLONG on macOS (PATH_MAX
    1024) for a 1031-character member. The hub walks one component at a time
    against a directory descriptor, so no long path reaches the kernel.
    """
    longest = _longest_legal_member_name()
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(raw_tar_gz(_payload() + [file_entry(longest, b"{}")]))
    dest = tmp_path / "staging"
    dest.mkdir()

    files = hub.store._unpack(body_path, dest)

    assert longest[len("./"):] in files


def _octal(value, width):
    return ("%0*o" % (width - 1, value)).encode() + b"\0"


def test_the_gzip_stream_is_closed_even_when_the_archive_is_refused(
        hub, tmp_path, monkeypatch):
    """The file object is ours now, so releasing it is ours too.

    A TarFile closes only a fileobj it opened itself. Handing one in moved this
    from explicit release to whenever the collector reaches it — which works
    until something keeps the tarball alive, and one traceback frame held by a
    log handler does that, in a process that stays up for weeks.
    """
    opened = []
    real_open = archive_module.gzip.open

    def recording_open(*args, **kwargs):
        stream = real_open(*args, **kwargs)
        opened.append(stream)
        return stream

    monkeypatch.setattr(archive_module.gzip, "open", recording_open)

    dest = tmp_path / "ok"
    dest.mkdir()
    good = tmp_path / "good.tar.gz"
    good.write_bytes(_payload_build())
    hub.store._unpack(good, dest)

    bad = tmp_path / "bad.tar.gz"
    bad.write_bytes(gzip.compress(b"not a tar at all" * 100))
    refused = tmp_path / "refused"
    refused.mkdir()
    with pytest.raises(store_module.PublishError):
        hub.store._unpack(bad, refused)

    assert len(opened) == 2, "the archives did not go through gzip.open"
    assert [stream.closed for stream in opened] == [True, True]


def _pax_record(key, value):
    """One pax record, `<len> <key>=<value>\\n`, with the length prefix correct.

    The length counts its own digits; a record whose prefix is off by one is
    rejected as a bad header and never reaches the parsing under test.
    """
    body = f" {key}={value}\n".encode()
    length = len(body) + 1
    while len(str(length)) + len(body) != length:
        length = len(str(length)) + len(body)
    record = str(length).encode() + body
    assert len(record) == int(record.split(b" ")[0])
    return record


def _chained_pax_headers(links):
    """`links` pax pseudo-headers in a row, then one ordinary member.

    Parsing a pax header ends by reading the NEXT header, so this recurses once
    per link.
    """
    def header(name, size, kind):
        h = bytearray(512)
        h[0:len(name)] = name.encode()
        h[100:108] = _octal(0o644, 8)
        h[108:116] = _octal(0, 8)
        h[116:124] = _octal(0, 8)
        h[124:136] = _octal(size, 12)
        h[136:148] = _octal(0, 12)
        h[156:157] = kind
        h[257:265] = b"ustar\0" + b"00"
        h[148:156] = b"        "
        h[148:156] = ("%06o\0 " % (sum(h) & 0o777777)).encode()
        return bytes(h)

    record = _pax_record("mtime", "1700000000.0")
    link = (header("././@PaxHeader", len(record), b"x")
            + record + b"\0" * (512 - len(record)))
    return link * links + header("f.json", 0, b"0") + b"\0" * 1024


def test_a_chain_of_extended_headers_is_refused_and_not_a_crash(hub):
    """A chain of pax headers recurses in the parser and must not exhaust the stack.

    Four hundred links (about 1.8 KB compressed) raise `RecursionError`, which is
    not in CORRUPT_ARCHIVE_ERRORS and must not surface as a 500. Chained headers are
    not members, so the member-count ceiling never sees them.
    """
    body = gzip.compress(_chained_pax_headers(400))
    assert len(body) < 4096, "the body has to be the small half of this"

    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"
    assert not (hub.project_dir("proj1") / "abc123").exists()


@pytest.mark.parametrize("lead", [0, 2], ids=["at-open", "during-the-walk"])
def test_a_chain_of_extended_headers_is_not_a_crash_wherever_it_sits(
        hub, lead):
    """`RecursionError` is not a TarError, not a ValueError, and not in
    CORRUPT_ARCHIVE_ERRORS; catching by FACT is the only thing between it and a
    500.

    Parametrized over WHERE the chain sits, because there are two catches and
    they are in different places: `TarFile.__init__` parses the first member, so
    a chain at the head is consumed at open and a chain behind a valid member is
    consumed during the walk.
    """
    chain = _chained_pax_headers(400)
    if lead:
        # Every trailing zero BLOCK has to go, not just the two that mark the
        # end: `tarfile` pads a stream out to its record size, so splicing after
        # a fixed 1024 bytes leaves zero blocks in the middle and the archive
        # simply ends there — which it did, and the push published.
        head = gzip.decompress(raw_tar_gz(_payload()))
        while head.endswith(b"\0" * 512):
            head = head[:-512]
        chain = head + _chained_pax_headers(400)
    body = gzip.compress(chain)

    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_malformed_sparse_map_is_a_refusal_and_not_a_crash(hub):
    """A sparse map whose numbers are not numbers is a refusal, not a 500.

    It raises a bare `ValueError` inside `tarfile`'s own header parsing, outside
    CORRUPT_ARCHIVE_ERRORS, so `tarfile.open` is caught by fact rather than by type.
    The message repeats the archive's own bytes, so the refusal escapes it like a
    member name.
    """
    entry = tarfile.TarInfo("f.json")
    entry.type = tarfile.REGTYPE
    entry.size = 1
    entry.mode = 0o644
    # No comma: the whole value is then the literal `int()` chokes on, and the
    # whole value is what the exception repeats.
    entry.pax_headers = {"GNU.sparse.map": "\x1b[2Jwiped\r",
                         "GNU.sparse.size": "9",
                         "GNU.sparse.name": "f.json"}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        tar.addfile(entry, io.BytesIO(b"x"))

    r = hub.publish("proj1", "abc123", buffer.getvalue())

    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert error != "internal error"
    # Escaped: the terminal-clearing sequence reaches neither the body nor the
    # log line beside it.
    assert "\x1b" not in error and "\r" not in error


def test_a_sparse_member_with_data_is_unpacked_hole_and_all(hub, tmp_path):
    """A sparse member is `tarfile`'s to expand, and it comes out byte for byte.

    pax `GNU.sparse` 1.0, the format bsdtar writes, unasked, for a file with a
    hole: the map at the head of the member's data, then the data the map places
    after the hole. The hole has to come back as zeros and the data after it
    intact. A member with no data proves nothing here — an empty file matches
    whether the expansion works or not. Members after it check that the walk
    finds the next header where the sparse one ends.
    """
    hole = 3 * store_module.CHUNK + 123
    data = bytes(range(256)) * 8
    sparse_map = f"1\n{hole}\n{len(data)}\n".encode()
    stored = (sparse_map + b"\0" * (-len(sparse_map) % tarfile.BLOCKSIZE)
              + data)
    info = tarfile.TarInfo("GNUSparseFile.0/holey.bin")
    info.type = tarfile.REGTYPE
    info.mode = 0o644
    info.size = len(stored)
    info.pax_headers = {"GNU.sparse.major": "1", "GNU.sparse.minor": "0",
                        "GNU.sparse.name": "holey.bin",
                        "GNU.sparse.realsize": str(hole + len(data))}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        tar.addfile(info, io.BytesIO(stored))
        for entry, content in _payload():
            tar.addfile(entry, io.BytesIO(content))
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(buffer.getvalue())
    dest = tmp_path / "staging"
    dest.mkdir()

    files = hub.store._unpack(body_path, dest)

    assert (dest / "holey.bin").read_bytes() == b"\0" * hole + data
    assert sorted(files) == sorted(
        ["holey.bin", "assembled.json", "meta.json", *DEFAULT_EXPORTS])


@pytest.mark.parametrize("member", [0, 1], ids=["at-open", "during-the-walk"])
def test_a_read_error_from_the_disk_is_not_dressed_up_as_a_corrupt_archive(
        hub, tmp_path, monkeypatch, member):
    """A disk read error inside `tarfile` is not reported as a corrupt archive.

    Both broad catches refuse by where the failure happened rather than by type,
    but `tarfile` reads the body while it parses, so a genuine read error is raised
    from inside those calls; `_is_the_disk` passes it to the `except OSError` arm
    instead of answering "archive is corrupt".

    Parametrized over the two catches: `TarFile.__init__` parses the first member,
    so a failure at the head is consumed at open and one behind a valid member
    during the walk (armed on the second member's header, read inside
    `_members_of`). The log line naming `dest` and the filesystem is asserted for
    both, since the status is a 500 either way.
    """
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(_payload_build())
    dest = tmp_path / "staging"
    dest.mkdir()
    with tarfile.open(body_path, mode="r:gz") as tar:
        header_at = tar.getmembers()[member].offset

    class Failing:
        """The real gzip stream, failing where that header is read."""

        def __init__(self, wrapped):
            self._wrapped = wrapped

        def read(self, size=-1):
            if self._wrapped.tell() == header_at:
                raise OSError(errno.EIO, "Input/output error")
            return self._wrapped.read(size)

        def __getattr__(self, name):
            return getattr(self._wrapped, name)

    real_open = archive_module.gzip.open

    def failing_open(*args, **kwargs):
        return Failing(real_open(*args, **kwargs))

    monkeypatch.setattr(archive_module.gzip, "open", failing_open)

    said = []
    sink = logger.add(said.append, level="ERROR")
    try:
        with pytest.raises(OSError) as caught:
            hub.store._unpack(body_path, dest)
    finally:
        logger.remove(sink)

    # A PublishError is not an OSError, so `pytest.raises` alone already rules
    # out the 422 — asserted anyway, because the day somebody gives PublishError
    # a different base this test would otherwise start passing on the wrong
    # exception.
    assert not isinstance(caught.value, store_module.PublishError)
    assert caught.value.errno == errno.EIO
    assert len(said) == 1, (
        f"a read failure at member {member} wrote {len(said)} error lines; "
        f"without this one all that is left is app.py's traceback, which records "
        f"the failure but does not say the filesystem is what refused")
    assert "failed on the filesystem" in said[0]


def test_a_body_that_cannot_be_opened_is_attributed_to_the_filesystem(
        hub, tmp_path):
    """A body `gzip.open` cannot open is attributed to the filesystem.

    `gzip.open` sits outside the arm because it creates the stream the `finally`
    closes, but it is the first filesystem touch in `_unpack` and fails in ordinary
    ways (EMFILE/ENFILE under concurrent publishes, EIO, ENOENT); this test uses a
    missing spool. Asserted on the log line naming the file and the filesystem,
    since the status is a 500 either way.
    """
    dest = tmp_path / "staging"
    dest.mkdir()
    missing = tmp_path / "gone.tar.gz"

    said = []
    sink = logger.add(said.append, level="ERROR")
    try:
        with pytest.raises(OSError) as caught:
            hub.store._unpack(missing, dest)
    finally:
        logger.remove(sink)

    assert not isinstance(caught.value, store_module.PublishError)
    assert caught.value.errno == errno.ENOENT
    assert len(said) == 1, (
        f"opening the body wrote {len(said)} error lines; this is the one call "
        f"in `_unpack` the OSError arm cannot cover, so without a line of its "
        f"own the only record is app.py's traceback")
    # The same phrase the arm below it uses, deliberately: one grep finds every
    # way unpacking failed on the disk rather than on the archive.
    assert "failed on the filesystem" in said[0]
    assert str(missing) in said[0]


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
    """A tree is unpacked, but a model's files sit at the top of its build.

    The hub serves a subdirectory (a document keeps its path there), and a
    model's pointers are held to the top level all the same
    (`buildnames.unservable_reason`): a view pointing into a subdirectory is a
    422 naming it.
    """
    body = raw_tar_gz([
        file_entry("meta.json", meta_bytes(views=[
            {"id": "assembled", "name": "assembled",
             "file": "views/assembled.json", "parts": ["lid"]}])),
        file_entry("views/assembled.json", view_bytes()),
        # The default catalogue's own exports, so the only thing wrong with
        # this document is where the VIEW file sits.
        *(file_entry(name, data) for name, data in DEFAULT_EXPORTS.items()),
    ])
    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "subdirectory" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_download_inside_a_subdirectory_is_refused(hub):
    # The same rule for downloads: a model's export sits at the top of its
    # build. The reference hangs off its part in meta.json; a name is checked
    # the same wherever the document names one.
    body = raw_tar_gz([
        file_entry("meta.json", meta_bytes(
            parts={"lid": {"kind": "printable",
                           "files": {"step": "out/model.step"}}},
            views=[{"id": "assembled", "name": "assembled",
                    "file": "assembled.json", "parts": ["lid"]}])),
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
                  if not p.name.startswith(".")) == sorted(
        ["assembled.json", "meta.json", *DEFAULT_EXPORTS])


def test_an_archive_made_by_plain_tar_of_a_directory_publishes(hub, tmp_path):
    # Built by the real `tar` binary the way a CI job would: cd into the build
    # output and `tar -czf x .`. Asserts the spelling tar emits: a leading `./`, a
    # directory entry for `./scripts` that is ignored, and the file under it.
    src = tmp_path / "build"
    (src / "scripts").mkdir(parents=True)
    (src / "meta.json").write_bytes(meta_bytes())
    (src / "assembled.json").write_bytes(view_bytes())
    for name, data in DEFAULT_EXPORTS.items():
        (src / name).write_bytes(data)
    (src / "scripts" / "build.py").write_bytes(b"# build\n")
    archive = tmp_path / "build.tar.gz"
    subprocess.run(["tar", "-czf", str(archive), "."], cwd=src, check=True)

    assert hub.publish("proj1", "abc123", archive.read_bytes()).status_code == 201
    build = hub.project_dir("proj1") / "abc123"
    assert (build / "assembled.json").is_file()
    assert (build / "scripts" / "build.py").read_bytes() == b"# build\n"


def test_a_file_inside_a_directory_member_lands_in_a_directory_of_ours(hub):
    # The directory ENTRY is not trusted: it is skipped and the hub creates the
    # directory from the path of the file that needs it, with OUR mode, so an entry
    # claiming 0o777 or setgid changes nothing on disk.
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
    # A nested member needs no `sub/` entry before it: `tar` can be told to store
    # files only, and a model's source is still a tree.
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
    # The open flags are why a member cannot land on a planted symlink or a name
    # already written, and no other test gets two members to one name, so they are
    # asserted at the syscall. Calls are selected by O_CREAT, because members are
    # opened relative to a directory descriptor and the path is a bare component.
    # The walk down the directories is asserted too: that is where a tree can be
    # led out of staging.
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

    Unreachable from an archive (link members are refused), so the link is planted
    by hand as a directory component pointing out of staging. `openat` with
    O_NOFOLLOW makes the escape impossible independently of the archive checks,
    including against something planted between two members by another process.
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
    """The realpath check holds on its own when the name whitelist is relaxed.

    SPEC 7.1 makes the realpath check independent of the whitelist, but no archive
    reaches it past the whitelist, so the whitelist is widened and `../escaped.txt`
    is pushed through. Deleting the check fails only this test. The check asks
    whether the member lands inside staging, which must not loosen into a
    string-prefix test (the test below).
    """
    import re

    monkeypatch.setattr(
        archive_module, "SAFE_COMPONENT", re.compile(r"\A.*\Z", re.S))
    body = raw_tar_gz(_payload() + [file_entry("../escaped.txt", b"pwned")])
    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / "escaped.txt").exists()
    assert not (hub.store.projects_dir / "escaped.txt").exists()
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_containment_is_by_path_component_and_not_by_string_prefix(
        hub, monkeypatch):
    """`<staging>-evil/` is not inside `<staging>/`, and only the separator says so.

    `realpath(target).startswith(real_dest)` also accepts every sibling whose name
    begins with the staging directory's name. Such an escape lands in the project
    directory under a dot-prefixed `.tmp-` name, invisible to `builds_of`, the file
    server and retention until the next startup sweep. The uuid is pinned for the
    request so the sibling can be named.
    """
    import re
    import uuid as uuid_module

    pinned = uuid_module.UUID(int=0x5EC0DE)
    monkeypatch.setattr(store_module.uuid, "uuid4", lambda: pinned)
    monkeypatch.setattr(
        archive_module, "SAFE_COMPONENT", re.compile(r"\A.*\Z", re.S))

    sibling = f"{store_module.STAGING_PREFIX}abc123-{pinned.hex}-evil"
    body = raw_tar_gz(_payload() + [
        file_entry(f"../{sibling}/escaped.txt", b"pwned")])
    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert not (hub.project_dir("proj1") / sibling).exists()


# -- damaged archives -------------------------------------------------------
# SPEC 7: a broken archive is a 422 with a message CI can act on, not a 500.
# Opening the file only proves the gzip header is there; the member table, the
# member data and the trailing CRC are all read later.
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

            `fileno` is required: the extractor calls `os.fchmod(out.fileno(),
            0o644)` before its first write, and without it the test dies of
            AttributeError, which also answers 500. `wrote` below fails the test if
            the write loop is not reached. It delegates to the real staging file's
            descriptor, so `fchmod` acts on the file the extractor expects.
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

    `_open_member_dir` classifies the errno from `openat`: a symlink, a regular
    file or an over-long name mid-path is the pusher's fault (422), and anything
    outside `LAYOUT_ERRNOS` stays an OSError, so a full volume must not become
    "your archive cannot be unpacked". Injected at `openat` because that is the
    call whose handler consults `LAYOUT_ERRNOS`.
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
    assert _leftovers(hub, "proj1") == []


def _record_spools_at_reply_time(hub, monkeypatch):
    """Every reply this hub writes, as (status, spool files present right then).

    The snapshot is taken in the server thread just before the status line is
    sent, which keeps the test deterministic: looking at the volume after the
    client has its answer races the handler's own `finally`. Wrapped at `_send`,
    the single funnel every reply goes through (`_json` and `_error` end here),
    which runs before `end_headers`.
    """
    handler = hub.server.RequestHandlerClass
    original = handler._send
    seen = []

    def recording_send(self, status, body, content_type, *args, **kw):
        seen.append((status, sorted(
            p.name for p in hub.data.iterdir()
            if p.name.startswith(store_module.UPLOAD_PREFIX))))
        return original(self, status, body, content_type, *args, **kw)

    monkeypatch.setattr(handler, "_send", recording_send)
    return seen


def test_a_refusal_is_answered_only_after_the_spool_is_gone(hub, monkeypatch):
    """The spooled body is unlinked BEFORE the refusal is written, on every path.

    Otherwise a client just told 400, 422 or 500 can still find its own
    `.upload-<uuid>` in the data directory. All three refusal exits are driven: the
    problem `_spool_body` reports, the PublishError the store raises, and an
    unexpected exception. BrokenPipeError answers nobody, so it is not here.
    """
    seen = _record_spools_at_reply_time(hub, monkeypatch)

    # (1) The store's own refusal: a truncated archive, the case CI failed on.
    whole = raw_tar_gz(_payload() + [file_entry("big.json", b"{}" + b" " * 200_000)])
    assert hub.publish_async(
        "proj1", "abc123", whole[: len(whole) // 2]).status_code == 422

    # (2) The body itself ending early, reported by `_spool_body` rather than
    # raised. Over a raw socket because httpx cannot under-deliver a body it has
    # already announced, and under-delivering is the whole point.
    host, port = hub.server.server_address[:2]
    with socket.create_connection((host, port), timeout=30) as sock:
        sock.sendall(
            b"POST /api/v1/publish/proj1/abc123 HTTP/1.1\r\n"
            b"Host: hub\r\n"
            b"X-Hammerola-Token: " + TOKEN.encode() + b"\r\n"
            b"Content-Length: 100000\r\n"
            b"\r\n" + b"\0" * 4096)
        sock.shutdown(socket.SHUT_WR)  # EOF long before the declared length
        reply = sock.recv(4096)
    assert reply.startswith(b"HTTP/1.1 400"), reply[:200]

    # (3) The hub's own fault, which must not be answered any sloppier. Last,
    # because the patch stays on for the rest of the test — `monkeypatch.undo()`
    # would take the recorder off with it.
    def boom(*args, **kw):
        raise RuntimeError("the volume went away mid-accept")

    monkeypatch.setattr(hub.store, "accept_sources", boom)
    assert hub.publish_async(
        "proj1", "abc123", _payload_build()).status_code == 500

    # The recorder has to have SEEN all three, or the assertion below is an
    # assertion about an empty list — the failure this suite counts verdicts to
    # avoid everywhere else.
    assert {status for status, _ in seen} >= {400, 422, 500}, seen
    late = [(status, spools) for status, spools in seen if spools]
    assert late == [], (
        f"these replies were written while the pushed body was still spooled on "
        f"the volume: {late}")


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
    # And the tree it was unpacking into is gone with it.
    assert _leftovers(small, "proj1") == []


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
    assert _leftovers(small, "proj1") == []


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
    # The member and its own annotation, not the word "deep": that word is in
    # the sentence stating the rule, so it survives the check being deleted.
    error = r.json()["error"]
    assert deep in error
    assert f"({store_module.MAX_PATH_DEPTH + 1} path components deep)" in error
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
    assert _leftovers(small, "proj1") == []


def test_empty_archive_is_refused(hub):
    assert hub.publish("proj1", "abc123", raw_tar_gz([])).status_code == 422


def test_a_leading_dot_slash_prefix_is_accepted(hub):
    # `tar cf - ./meta.json` is an ordinary thing for a CI script to produce, and
    # the prefix is not a traversal. Stripping it must not weaken anything else,
    # so this is the one hostile-looking name that is allowed through.
    body = raw_tar_gz([
        file_entry("./meta.json", meta_bytes()),
        file_entry("./assembled.json", view_bytes()),
        *(file_entry(f"./{name}", data)
          for name, data in DEFAULT_EXPORTS.items()),
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
    assert meta["views"][0]["file"] == "assembled.json"
    assert os.readlink(hub.project_dir("proj1") / "latest") == "abc123"
