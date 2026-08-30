"""Hostile archives (SPEC 7.1).

The uploaded tar is attacker-controlled the moment the publish token leaks, and it
is machine-generated even when it does not. Every test here sends a genuinely
malformed archive — built member by member with explicit TarInfo objects — and
then asserts twice: that the push was refused, AND that nothing was written where
it should not have been. The second assertion is the one that matters; a 422 with
a file already on disk outside the build directory would be a pass on the status
code and a compromise on the filesystem.
"""

import ast
import errno
import gzip
import inspect
import io
import json
import os
import socket
import subprocess
import tarfile
import textwrap
import tracemalloc
import uuid

import pytest
from harness import (TOKEN, chardev_entry, dir_entry, fifo_entry, file_entry,
                     hardlink_entry, meta_bytes, raw_tar_gz, symlink_entry,
                     view_bytes)
from loguru import logger

from src import store as store_module
# The client's copy of `_cut_middle` is driven by the tests here rather than from
# `tests/client/`, because that suite's conftest strips EDIT_TOKEN out of the
# environment for `src.settings` — and comparing the two copies needs both.
from src.client import pack as client_pack


def _payload():
    """The members a valid build carries, so only the hostile one is at fault."""
    return [
        file_entry("meta.json", meta_bytes()),
        file_entry("assembled.json", view_bytes()),
    ]


def _payload_build() -> bytes:
    """The same members, as a finished archive body."""
    return raw_tar_gz(_payload())


def _leftovers(hub, pid):
    """Every transient a refused push could have left behind, by name.

    There are two places to look since the push became asynchronous (SPEC 8A.2
    step 5), and a test that checked only one would go on passing while the other
    filled the volume: `.src-<uuid>` at the ROOT of the data directory, which is
    where a push is unpacked, and `.tmp-<commit>-<uuid>` inside the PROJECT,
    which is where a build writes its output.

    A project directory that does not exist at all is the strongest form of the
    same answer, not a hole in this check: a push refused before its build was
    ever queued never creates one, which is why it is not asserted to be there.
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
# Issue #42. The names in these messages are the SENDER'S text, so the
# tests come in pairs: one that the refusal says enough, one that it cannot be
# made to say too much. Both matter — a refusal that names one file at a time is
# the defect being fixed, and a refusal that echoes whatever it is handed is a
# way to write arbitrary bytes into this hub's log.
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
    """Two different faults, one answer. Depth used to raise on its own, so an
    archive with both was two pushes.

    Asserted on the NAME and on the per-entry annotation, never on the word
    "deep" alone: the opening sentence of every one of these refusals now
    contains "at most 8 components deep", so `"deep" in error` is true of a
    refusal that lost the depth check entirely.
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
    """The count is what keeps a 422 from becoming a broadcast channel.

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


def test_a_refusal_repeats_neither_control_characters_nor_a_giant_name(hub):
    """The two shapes that make an echo dangerous rather than merely long.

    A control character reaches an operator's terminal through
    `logger.warning`, where `\\r` and an ANSI sequence rewrite the line that was
    supposed to report the refusal. And a member name is NOT bounded by
    SAFE_COMPONENT — that is the rule it failed — so a PAX long-name header
    carries as many bytes as the sender likes.
    """
    # Long enough to be cut several times over, but still under the ceiling
    # above — a name past THAT is refused for its length instead, and would not
    # reach this message at all.
    giant = "z" * 500 + ".json"
    escapes = "ref/\x1b[2Jwiped\rboom.json"
    body = raw_tar_gz(_payload() + [file_entry(giant, b"x"),
                                    file_entry(escapes, b"x")])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "\x1b" not in error and "\r" not in error
    assert "\\x1b" in error and "\\r" in error
    assert giant not in error
    # Every name is cut to the ceiling, so the whole answer stays small however
    # much the sender put into the archive.
    assert len(error) < 1000


def test_a_survey_after_a_bad_name_still_stops_at_the_size_ceiling(hub_factory):
    """The bound on the walk that follows the first bad name.

    Collecting the rest of the names means iterating to the end of the archive,
    and `tarfile` reaches each header by decompressing past the previous
    member's data whether anyone reads it or not. Without counting declared
    sizes, "the first member is badly named" would go from the cheapest refusal
    there is to a free full decompression of a gzip bomb. 413 rather than the
    list of names is the deliberate outcome: the ceiling comes first.

    This is the case where the bad name is followed by WELL-named members; its
    twin below is the one that actually caught a hole.
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
    """The twin, and the one the first test could not have caught.

    The size was counted on the branch a badly-named member never reached, so it
    was only the WELL-named members of a refused archive that were charged for.
    Name every member badly and the running total stayed at zero however much
    the archive expanded: measured on a live hub, a 1 MB body decompressed to
    1.07 GB and came back 422 instead of 413. At a production ceiling of 64 MiB
    that is tens of gigabytes of decompression per request, times the number of
    publish slots.
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

    Derived from the pattern rather than from any constant, and that is the
    whole point of the function. Restating the width — `"z" * 128` beside a
    `{0,127}` in the regex beside a `128` in the ceiling — is three copies of one
    number, and they drift in the direction that refuses honest pushes: widen the
    alphabet and the ceiling is computed from the old width, so a member the
    hub's own `_member_parts` calls legal is turned away. Asking the pattern how
    wide it goes leaves nothing to drift.
    """
    width = 1
    while store_module.SAFE_COMPONENT.match("z" * (width + 1)):
        width += 1
        assert width < 100_000, "SAFE_COMPONENT no longer bounds a component"
    return "z" * width


def _longest_legal_member_name() -> str:
    """The longest name a member of an ACCEPTABLE archive can carry.

    Built rather than restated as a formula, and then run through the hub's own
    checkers below, so this cannot agree with `MAX_MEMBER_NAME_CHARS` merely by
    repeating its arithmetic — which is how the first version of these tests
    missed that the constant left out the `./`.
    """
    component = _widest_legal_component()
    deepest = "/".join(component for _ in range(store_module.MAX_PATH_DEPTH))
    # The prefix `tar czf x.tar.gz .` puts on every name, and that the hub
    # strips before checking. It is part of what a legal archive can send, so it
    # is part of the longest legal name.
    return "./" + deepest


def test_the_name_ceiling_is_exactly_the_longest_legal_name():
    """The arithmetic, checked against the checkers instead of against itself.

    Both directions matter and for different reasons: too small refuses honest
    pushes, too large stops bounding the memory it exists to bound. The first is
    the one that needs the care, because a ceiling that is too small fires only
    on the widest member anybody ever sends.
    """
    assert len(_widest_legal_component()) == store_module.MAX_COMPONENT_CHARS

    longest = _longest_legal_member_name()
    parts, fault = store_module._member_parts(longest[len("./"):])
    assert fault == "", "the name this calls legal is not"
    assert len(parts) == store_module.MAX_PATH_DEPTH

    assert len(longest) == store_module.MAX_MEMBER_NAME_CHARS
    # And what the per-name ceiling then bounds the whole walk to: about a
    # megabyte of names, whatever the archive does.
    assert (store_module.MAX_MEMBERS
            * store_module.MAX_MEMBER_NAME_CHARS) < 2 * 1024 * 1024


def test_the_longest_legal_member_name_is_unpacked(hub, tmp_path):
    """The `./` case, which is the one the ceiling used to refuse.

    A running total had to be compared against the largest sum a legal archive
    could reach, and that sum left the prefix out: 1024 members at maximum depth
    came to 1 057 792 characters against a ceiling of 1 056 768, so an archive
    breaking no rule of the hub's was refused. A per-name ceiling has no sum to
    get wrong, and this is the boundary from the accepting side.

    Driven at `_unpack` rather than through a publish, and the reason is worth
    keeping: a 1031-character member cannot be COPIED by an ordinary
    `shutil.copytree` on macOS, where PATH_MAX is 1024 rather than the 4096
    MAX_PATH_DEPTH was reasoned against — the test builder does exactly that and
    dies with ENAMETOOLONG. The hub itself does not: `_open_member_dir` walks
    one component at a time against a directory descriptor, so no long path ever
    reaches the kernel. So this asserts the unpacking, which is what the ceiling
    governs, and leaves the fake builder out of it.
    """
    longest = _longest_legal_member_name()
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(raw_tar_gz(_payload() + [file_entry(longest, b"{}")]))
    dest = tmp_path / "staging"
    dest.mkdir()

    files = hub.store._unpack(body_path, dest)

    assert longest[len("./"):] in files


def test_a_name_longer_than_any_legal_one_is_refused_at_once(hub):
    """One character over, and the refusal is the LENGTH one, not the name list.

    Asserting which refusal is the whole point. A GNU/PAX long-name header is a
    pseudo-member: `tarfile` reads its data whole, never yields it, and hangs
    the string on the TarInfo it keeps for every entry it has seen. So name
    bytes reach neither `member.size` nor the unpacked total and they compress
    to nothing — 64 members with 200 000 characters of name each is a body of a
    few tens of kilobytes and 12.8 MB of names. Collecting these the way every
    other bad name is collected would read all 64; refusing at the first reads
    one. Both answer 422, so only the message tells them apart.
    """
    each = "z" * 200_000
    body = raw_tar_gz([file_entry(f"{each}-{i}.jpg", b"x") for i in range(64)])
    assert len(body) < 100 * 1024, "the body has to be the small half of this"

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert f"longer than {store_module.MAX_MEMBER_NAME_CHARS} characters" in error
    assert "of them" not in error, "collected as an ordinary bad name after all"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_giant_link_target_is_refused_on_an_ORDINARY_FILE(hub):
    """The hole that outlived the survey, and it is not about links at all.

    `linkname` arrives by the same mechanism as a long name (GNU `LONGLINK`, pax
    `linkpath`), hangs on the same retained TarInfo, reaches neither
    `member.size` nor the unpacked total, and compresses to nothing. Refusing
    links does NOT cover it: `tarfile` attaches a pending `LONGLINK` to whatever
    header comes next, and a REGULAR FILE takes it happily — so these members
    pass the alphabet, pass the type check, and on `main` they publish. Measured
    there: 200 of them are a 212 KB body and a 202 MB peak.

    The member names here are deliberately ordinary. If this test ever passes
    because the NAME was refused, it has stopped testing what it is named for.
    """
    entries = []
    for index in range(8):
        info = tarfile.TarInfo(f"f{index}.json")
        info.type = tarfile.REGTYPE
        info.size = 1
        info.mode = 0o644
        info.linkname = "L" * (store_module.MAX_MEMBER_NAME_CHARS + 1)
        entries.append((info, b"x"))
    body = raw_tar_gz(_payload() + entries)
    assert len(body) < 100 * 1024

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "link target" in error
    assert "L" * 50 not in error, "the link target was repeated back"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_giant_link_target_is_refused_during_a_survey_too(hub):
    """The same field, reached the other way.

    One badly named member first turns the walk into a survey, and the survey
    skips the type check on purpose — so without a ceiling on the field, a
    thousand symlinks behind one cyrillic filename are a gigabyte. Measured:
    0.7 MB on `main`, 1002.9 MB here before this.
    """
    entries = [file_entry("модель.py", b"x")]
    for index in range(8):
        entries.append(symlink_entry(
            f"link{index}.py",
            "L" * (store_module.MAX_MEMBER_NAME_CHARS + 1)))
    body = raw_tar_gz(_payload() + entries)

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "link target" in r.json()["error"]


def _pax_member(name, **fields):
    """One ordinary regular file carrying whatever header fields are asked for."""
    info = tarfile.TarInfo(name)
    info.type = tarfile.REGTYPE
    info.size = 1
    info.mode = 0o644
    for key, value in fields.items():
        if key == "pax_headers":
            info.pax_headers = value
        else:
            setattr(info, key, value)
    return info, b"x"


@pytest.mark.parametrize("field", ["uname", "gname", "pax_headers"])
def test_a_giant_header_field_is_refused_on_an_ORDINARY_FILE(hub, field):
    """The third field of the same nature, and the worst of the three.

    `tarfile` hangs `uname`, `gname` and the whole `pax_headers` dict on the same
    retained TarInfo as the name: same arrival mechanism, absent from
    `member.size` and from the unpacked total, compressing to nothing. And a
    GLOBAL pax header is applied to every member, so this does not even need a
    per-member record.

    Worse than the name and the link target because nothing about these members
    is irregular: legal names, regular files, no links. Measured on this branch
    before the ceiling — 300 members with a megabyte of `uname` each: a 315 KB
    body, 305 MB of process memory, and status 201. It PUBLISHED.

    The miss is worth remembering as a classification error rather than an
    oversight: this was written off as "pax values that are not names", when
    `uname` and `gname` are names and `pax_headers` holds `path` itself.
    """
    giant = "U" * (store_module.MAX_PAX_HEADER_CHARS + 1)
    value = {"SCHILY.xattr.user.x": giant} if field == "pax_headers" else giant
    entries = [_pax_member(f"f{index}.json", **{field: value})
               for index in range(8)]
    body = raw_tar_gz(_payload() + entries)
    assert len(body) < 100 * 1024

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "pax fields" in error
    assert "U" * 50 not in error, "the header value was repeated back"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def _octal(value, width):
    return ("%0*o" % (width - 1, value)).encode() + b"\0"


def _gnu_sparse_member(name, chain_blocks):
    """An old-GNU sparse member: type 'S' plus a chain of extended blocks.

    Hand-built because `tarfile` cannot write one. This is the route that matters:
    it carries NO pax records at all, so `_pax_header_chars` sees an empty dict
    and `name + linkname` is a dozen characters, while the chain fills
    `TarInfo.sparse` with 21 tuples per block.
    """
    header = bytearray(512)
    header[0:len(name)] = name.encode()
    header[100:108] = _octal(0o644, 8)
    header[108:116] = _octal(0, 8)
    header[116:124] = _octal(0, 8)
    header[124:136] = _octal(0, 12)          # size: no data blocks at all
    header[136:148] = _octal(0, 12)
    header[156:157] = b"S"                   # GNUTYPE_SPARSE
    header[257:265] = b"ustar  \0"
    header[482:483] = b"\1" if chain_blocks else b"\0"    # isextended
    header[483:495] = _octal(0, 12)          # realsize
    header[148:156] = b"        "
    header[148:156] = ("%06o\0 " % (sum(header) & 0o777777)).encode()

    # One block built and then repeated: every extended block is identical bar
    # the `isextended` flag on the last. Filling each of tens of thousands of
    # them entry by entry made a test that needs a long chain take seconds.
    block = bytearray(512)
    for slot in range(21):
        at = slot * 24
        block[at:at + 12] = _octal(1 + slot, 12)
        block[at + 12:at + 24] = _octal(1, 12)
    block[504:505] = b"\1"
    last = bytearray(block)
    last[504:505] = b"\0"
    if not chain_blocks:
        return bytes(header)
    return bytes(header) + bytes(block) * (chain_blocks - 1) + bytes(last)


def _pax_padded_member(index, declared=200_000_000):
    """A pax header DECLARING `declared` bytes that holds one record and NULs.

    The shape that defeats a ceiling on the parsed result: parsing stops at the
    first NUL, so the dict `_pax_header_chars` measures holds a single tiny
    record however large the header claimed to be. Only a bound on what was READ
    can see it.
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

    record = b"30 mtime=1700000000.0000\n"
    payload = record + b"\0" * (declared - len(record))
    return (header("././@PaxHeader", declared, b"x") + payload
            + b"\0" * ((-declared) % 512)
            + header(f"f{index}.json", 0, b"0"))


def test_a_header_declaring_more_than_the_hub_unpacks_is_refused(hub_factory,
                                                                 tmp_path):
    """`_CountingReader`, and the case the field ceilings structurally cannot see.

    A pax header may declare any size it likes and `tarfile` reads it in ONE
    call. Pad the declaration with NULs and parsing stops at the first one, so
    the dict stays tiny and MAX_PAX_HEADER_CHARS never fires — while the process
    has already held whatever was declared.

    Two things are asserted, and the second is the one that took a correction:
    that it is refused, and that the memory was never spent. A reader that counts
    AFTER reading refuses just as loudly and peaks identically to having no
    ceiling at all (measured: 400.2 MB either way), which is a report rather than
    a bound. Asking about the REQUEST is what makes it one.
    """
    cap = 8 * 1024 * 1024
    small = hub_factory(max_build_bytes=cap)
    raw = b"".join(_pax_padded_member(index) for index in range(4))
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(gzip.compress(raw + b"\0" * 1024))
    dest = tmp_path / "staging"
    dest.mkdir()

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        with pytest.raises(store_module.PublishError) as caught:
            small.store._unpack(body_path, dest)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert caught.value.status == 413
    assert peak < cap, (
        f"peaked at {peak} bytes for an archive the hub caps at {cap}: the "
        f"declared header was read before it was refused")


def test_the_reader_bounds_reads_that_add_up_as_well_as_single_ones():
    """The other half of the reader: a ceiling reached by ACCUMULATION.

    A single enormous request is refused by arithmetic alone, so a reader that
    never added anything to its running total would still turn one away. What
    only the total catches is a long run of SMALL reads — which is exactly how
    `tarfile` walks a sparse chain, 512 bytes at a time.

    Driven against the reader directly rather than through an archive: the
    ceiling it enforces is `max_build_bytes` plus the whole archive overhead
    allowance, so an end-to-end version has to manufacture tens of megabytes to
    reach it, and would then be measuring the constants rather than the rule.
    """
    reader = store_module._CountingReader(io.BytesIO(b"x" * 5000), cap=1000)

    for _ in range(10):
        assert len(reader.read(100)) == 100      # exactly the ceiling, allowed
    assert reader.total == 1000

    with pytest.raises(store_module.PublishError) as caught:
        reader.read(1)
    assert caught.value.status == 413


def test_the_reader_refuses_a_single_read_bigger_than_it_serves():
    """MAX_SINGLE_READ_BYTES, which is a different question from the walk's total.

    A budget for the WALK permits any one request that fits in what is left, and
    at the first header that is the entire archive allowance. `tarfile` asks for
    a pax header's DECLARED size in one call, so that alone let a 67.9 KiB body
    reach 1907.9 MiB — and the variant whose records collapse into one dict entry
    reached 1059.3 MiB and PUBLISHED, because the ceiling on the parsed result
    saw a handful of characters. Refusing on the request size is what stops the
    bytes ever being held.
    """
    reader = store_module._CountingReader(io.BytesIO(b"x" * 10), cap=1 << 40)

    with pytest.raises(store_module.PublishError) as caught:
        reader.read(store_module.MAX_SINGLE_READ_BYTES + 1)

    assert caught.value.status == 413
    assert reader.total == 0, "the oversized read was performed anyway"


def _heaviest_legal_pax_headers():
    """Pax records filling MAX_PAX_HEADER_CHARS at the worst WIRE cost.

    TWO PROPERTIES COMPOUND and the filler needs both, which is what two earlier
    versions of it each got half of. A record is `<len> <key>=<value>\\n`, so the
    SHORTER the key the more often the framing is paid — long keys hide the ratio
    entirely, a filler of 30 keys x 100 characters costing barely more than it
    measures. And the ceiling counts CHARACTERS while the wire carries BYTES, so
    a key outside ASCII pays its UTF-8 width on every one of those records.

    ONE-CHARACTER KEYS OF THREE OR FOUR BYTES ARE THEREFORE THE WORST CASE, and
    the previous filler — astral, but widening from two characters to four
    because 36 letters do not make 4 114 keys any other way — was not it.
    Measured at exactly the ceiling: keys of two to four characters cost 18 944
    bytes in ASCII and in two-byte BMP alike, 29 184 in three-byte BMP (U+4E00)
    and in astral, and one-character keys 39 424 in either of the last two — so
    it is the UTF-8 width that decides, not the plane. A factor reasoned from
    framing alone allows 22 618 bytes an entry, which covers 119% of the first
    figure and only 57% of the last; a filler stopping at the middle number left
    `PAX_WIRE_BYTES_PER_CHAR = 8` passing while a legal archive of one-character
    keys answered 413.

    Those three figures are what the method below measures, padding of the stream
    to RECORDSIZE included — which is what the assertion has to compare against,
    since the allowance is per entry and one entry is what is built. The entry's
    own cost behind the last of them is 34 304 bytes; the comment beside
    PAX_WIRE_BYTES_PER_CHAR uses that number instead, for the ratios that are
    about a whole archive rather than about one entry.

    The alphabet is one contiguous astral block, big enough that every key is one
    character: nothing in the declared rules forbids such a key, and a pax key may
    hold anything but `=` and a newline. Astral rather than CJK only because the
    block is unambiguous; the two measure the same.
    """
    budget = store_module.MAX_PAX_HEADER_CHARS
    headers = {chr(0x10000 + index): "" for index in range(budget)}
    assert len(headers) == budget, "the alphabet is not one key per character"
    return headers


def test_the_overhead_allowance_covers_the_heaviest_entry_on_the_wire():
    """PER_ENTRY_OVERHEAD_BYTES against a MEASURED entry, not against its formula.

    The allowance was a flat 4096 while the pax ceiling admitted 4114 characters,
    and the two constants were never compared. Measuring one entry at the
    heaviest legal header is what makes the comparison real: restating the
    arithmetic on both sides would agree with itself however wrong it was.
    """
    headers = _heaviest_legal_pax_headers()
    assert (sum(len(k) + len(v) for k, v in headers.items())
            == store_module.MAX_PAX_HEADER_CHARS), (
        "the filler stopped filling the ceiling exactly"
    )

    info = tarfile.TarInfo("f.bin")
    info.type = tarfile.REGTYPE
    info.mode = 0o644
    info.size = 512
    info.pax_headers = headers
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        tar.addfile(info, io.BytesIO(b"x" * 512))

    stream = len(gzip.decompress(buffer.getvalue()))
    # Everything the entry costs beyond its own file bytes and the two 512-byte
    # blocks tar always ends with.
    overhead = stream - 512 - 1024
    assert overhead > 0
    assert store_module.PER_ENTRY_OVERHEAD_BYTES >= overhead, (
        f"one legal entry costs {overhead} bytes of framing and the allowance "
        f"is {store_module.PER_ENTRY_OVERHEAD_BYTES}: a full archive of these "
        f"would be refused")


def test_a_single_read_between_the_two_ceilings_is_still_refused(hub_factory,
                                                                 tmp_path):
    """What tells the single-read ceiling from the walk's total.

    A declared size ABOVE the whole budget is refused either way — the
    cumulative check catches it without reading. The single-read ceiling earns
    its place in the gap between the two: five megabytes is more than this hub
    reads at a time and less than the archive is allowed in total, so without it
    the bytes are read and parsed, and with it they never arrive.
    """
    cap = 8 * 1024 * 1024
    declared = 5 * 1024 * 1024
    assert declared > store_module.MAX_SINGLE_READ_BYTES
    assert declared < cap + store_module.ARCHIVE_OVERHEAD_BYTES, (
        "the cumulative ceiling would catch this on its own"
    )

    small = hub_factory(max_build_bytes=cap)
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(gzip.compress(
        _pax_padded_member(0, declared=declared) + b"\0" * 1024))
    dest = tmp_path / "staging"
    dest.mkdir()

    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        with pytest.raises(store_module.PublishError) as caught:
            small.store._unpack(body_path, dest)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert caught.value.status == 413
    assert peak < declared, "the declared header was read before being refused"


def test_the_single_read_ceiling_still_admits_our_own_reads():
    """The floor under it: the extraction loop asks for CHUNK at a time, so a
    ceiling below that would refuse the hub's own reading of a normal file."""
    assert store_module.MAX_SINGLE_READ_BYTES >= store_module.CHUNK


def test_the_gzip_stream_is_closed_even_when_the_archive_is_refused(
        hub, tmp_path, monkeypatch):
    """The file object is ours now, so releasing it is ours too.

    A TarFile closes only a fileobj it opened itself. Handing one in moved this
    from explicit release to whenever the collector reaches it — which works
    until something keeps the tarball alive, and one traceback frame held by a
    log handler does that, in a process that stays up for weeks.
    """
    opened = []
    real_open = store_module.gzip.open

    def recording_open(*args, **kwargs):
        stream = real_open(*args, **kwargs)
        opened.append(stream)
        return stream

    monkeypatch.setattr(store_module.gzip, "open", recording_open)

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


def test_the_gzip_stream_is_closed_when_our_own_setup_raises(hub, tmp_path,
                                                             monkeypatch):
    """The same ownership, on the path between the open and the `try`.

    Owning the stream is the whole point of opening the two layers separately,
    and the release lives in a `finally`. So every line between `gzip.open` and
    that `try` is a line on which the stream leaks — and the reader's own
    constructor used to be one of them. Nothing in it can raise today, which is
    exactly why the test has to plant the failure: an unreachable leak is still a
    leak, and this file's whole history is guards nothing could distinguish.

    The construction is monkeypatched rather than provoked, because provoking it
    would mean giving the constructor something that can fail — which is the
    change this is here to make unnecessary.
    """
    opened = []
    real_open = store_module.gzip.open

    def recording_open(*args, **kwargs):
        stream = real_open(*args, **kwargs)
        opened.append(stream)
        return stream

    monkeypatch.setattr(store_module.gzip, "open", recording_open)

    def exploding_reader(*args, **kwargs):
        raise RuntimeError("a bug in our own setup")

    monkeypatch.setattr(store_module, "_CountingReader", exploding_reader)

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(_payload_build())
    dest = tmp_path / "staging"
    dest.mkdir()

    with pytest.raises(RuntimeError):
        hub.store._unpack(body_path, dest)

    assert len(opened) == 1, "the archive did not go through gzip.open"
    assert opened[0].closed, (
        "our own failure between the open and the `try` leaked the stream")


def _pax_record(key, value):
    """One pax record, `<len> <key>=<value>\\n`, with the length prefix correct.

    Solved rather than guessed: the length counts its own digits, so a record
    whose prefix is off by one is rejected as a bad header and never reaches the
    parsing this is built to exercise — which is how an earlier version of the
    chained-header test measured nothing at all.
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
    """The stack, which none of the other ceilings can see.

    Parsing a pax header ends by reading the next one, so a chain of them
    recurses. Four hundred links — 1 813 bytes compressed — exhausted the
    interpreter, and `RecursionError` is not a TarError, not a ValueError, and
    not in CORRUPT_ARCHIVE_ERRORS, so the pusher got a 500 and the log got a
    187 KB traceback about an archive of their own making.

    Nothing else here could have caught it: chained headers are not members, so
    the member count never rises; each link is a kilobyte, so neither the
    single-read ceiling nor the walk's budget stirs.
    """
    body = gzip.compress(_chained_pax_headers(400))
    assert len(body) < 4096, "the body has to be the small half of this"

    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert r.json()["error"] != "internal error"
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_chain_is_refused_by_the_read_count_before_the_stack_gives_out(hub):
    """And refused by COUNTING, not by surviving the crash.

    Catching the RecursionError makes the answer correct; the read ceiling makes
    it cheap, and keeps the refusal out of the region where the interpreter is
    already out of stack. A chain far shorter than the recursion limit is enough
    to show which of the two fired.
    """
    links = store_module.MAX_HEADER_READS_PER_MEMBER + 10
    body = gzip.compress(_chained_pax_headers(links))

    r = hub.publish("proj1", "abc123", body)

    assert r.status_code == 422, r.text
    assert "chains extended headers" in r.json()["error"]


@pytest.mark.parametrize("lead", [0, 2], ids=["at-open", "during-the-walk"])
def test_a_chain_that_outruns_the_read_ceiling_is_still_not_a_crash(
        hub, monkeypatch, lead):
    """The catch behind the ceiling, with the ceiling deliberately lifted.

    The read ceiling fires first, which is what makes the refusal cheap — and it
    also means the broad `except` behind it is never reached by an ordinary test,
    so both of them survived a mutation to a narrow list of exception types. That
    is the shape this review keeps finding: a guard nothing can distinguish.

    So the ceiling is raised out of the way and the archive is allowed to reach
    the interpreter's own limit. `RecursionError` is not a TarError, not a
    ValueError, and not in CORRUPT_ARCHIVE_ERRORS; catching by FACT is the only
    thing between it and a 500.

    Parametrized over WHERE the chain sits, because there are two catches and
    they are in different places: `TarFile.__init__` parses the first member, so
    a chain at the head is consumed at open and a chain behind a valid member is
    consumed during the walk.
    """
    monkeypatch.setattr(store_module, "MAX_HEADER_READS_PER_MEMBER", 1_000_000)

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


def test_an_ordinary_member_is_nowhere_near_the_header_read_ceiling(hub, tmp_path):
    """The floor under that ceiling: real archives must not come close.

    A member costs one read for its header and a few more if it carries a long
    name or a pax record. Measured against the archive our own client packs, so
    the ceiling cannot be tightened onto real traffic unnoticed.

    RECORDED ON `end_header`, WHICH IS NOT INTERCHANGEABLE WITH `begin_header`.
    Reading a window's count at the START of the next one never sees the LAST
    window of the walk — the one that runs into `StopIteration` and reads the
    archive's trailing zero blocks on the way — because nothing opens a window
    after it. That window is the one whose size depends on the tail of the
    archive, i.e. on what the sender chose to put there, so it is precisely the
    one worth measuring.
    """
    seen = []
    real_reader = store_module._CountingReader

    class Recording(real_reader):
        def end_header(self):
            seen.append(self.header_reads)
            super().end_header()

    monkeypatched = pytest.MonkeyPatch()
    monkeypatched.setattr(store_module, "_CountingReader", Recording)
    try:
        body_path = tmp_path / "body.tar.gz"
        body_path.write_bytes(_payload_build())
        dest = tmp_path / "staging"
        dest.mkdir()
        hub.store._unpack(body_path, dest)
    finally:
        monkeypatched.undo()

    assert seen, "no header windows were observed"
    assert max(seen) * 4 <= store_module.MAX_HEADER_READS_PER_MEMBER, (
        f"an ordinary member already takes {max(seen)} reads against a ceiling "
        f"of {store_module.MAX_HEADER_READS_PER_MEMBER}")


def test_a_large_member_is_not_mistaken_for_a_chain_of_headers(hub_factory,
                                                               tmp_path):
    """`parsing_header`, the flag that keeps the read ceiling off member DATA.

    The window is opened and closed by the walk and the counter runs only inside
    it. Drop the flag — make the `if` read `if True:` — and every read counts, so
    a member big enough to take more than the ceiling's worth of reads comes back
    422 "chains extended headers": a verdict about a header, for a file whose
    only fault is its size. Nothing else in this suite can see that, because the
    biggest member anything here sends is 256 KiB.

    THE SIZE IS COMPUTED FROM THE CONSTANTS, NOT WRITTEN DOWN, and that is most
    of what makes this test worth having. What arrives at the reader is one
    buffer fill, and the buffer is the larger of CHUNK and the interpreter's own
    default — 65 536 on 3.11 (the image, and CI) and 131 072 on 3.14 (a
    workstation), so the threshold is 4 MiB there and 8 MiB here. A hard-coded
    number would exercise the flag on one interpreter and prove nothing on the
    other; it is the same trap
    `test_no_ordinary_archive_reads_more_at_once_than_the_ceiling_allows`
    documents from the opposite side.
    """
    window = max(store_module.CHUNK, io.DEFAULT_BUFFER_SIZE)
    # Four whole buffer fills past the ceiling rather than one byte past it. What
    # is pinned is that data reads are not counted AT ALL, so the margin costs
    # nothing, and a member sized exactly at the boundary would start failing for
    # arithmetic reasons the day `tarfile` asks for one block differently.
    size = window * (store_module.MAX_HEADER_READS_PER_MEMBER + 4)
    body = raw_tar_gz(_payload() + [file_entry("big.bin", b"x" * size)])

    roomy = hub_factory(max_build_bytes=size + store_module.CHUNK)
    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(body)
    dest = tmp_path / "staging"
    dest.mkdir()

    files = roomy.store._unpack(body_path, dest)

    assert sorted(files) == ["assembled.json", "big.bin", "meta.json"]
    assert (dest / "big.bin").stat().st_size == size


def test_no_ordinary_archive_reads_more_at_once_than_the_ceiling_allows(
        hub, tmp_path):
    """The floor under MAX_SINGLE_READ_BYTES, MEASURED rather than reasoned.

    The comment used to derive it from CHUNK, which is not the floor: the
    extraction loop asks through a BUFFERED reader, so what arrives is the larger
    of CHUNK and the interpreter's buffer size — 65 536 on 3.11, 131 072 on 3.14.
    That number moved sixteenfold in one release, and if it ever passes the
    ceiling then every ordinary push is refused, on a base-image upgrade, with a
    message blaming the archive.

    So it is measured, on whichever interpreter is running, and asserted with a
    fourfold margin: the next jump fails here, in CI, and not in production.
    """
    readers = []
    real_reader = store_module._CountingReader

    class Recording(real_reader):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            readers.append(self)

    monkeypatched = pytest.MonkeyPatch()
    monkeypatched.setattr(store_module, "_CountingReader", Recording)
    try:
        body_path = tmp_path / "body.tar.gz"
        body_path.write_bytes(raw_tar_gz(
            _payload() + [file_entry("big.bin", b"x" * (4 * store_module.CHUNK))]))
        dest = tmp_path / "staging"
        dest.mkdir()
        hub.store._unpack(body_path, dest)
    finally:
        monkeypatched.undo()

    assert readers, "the archive did not go through the counting reader"
    largest = max(reader.largest_request for reader in readers)
    assert largest > 0
    assert largest * 4 <= store_module.MAX_SINGLE_READ_BYTES, (
        f"the largest request an ordinary archive makes is {largest} against a "
        f"ceiling of {store_module.MAX_SINGLE_READ_BYTES}: the interpreter's "
        f"buffer size has grown and this ceiling has to grow with it")


def test_the_reader_refuses_a_read_with_no_length():
    """The branch that used to be dead AND wrong.

    It set `size = room + 1`, which fails the very next check, so an unbounded
    read raised 413 unconditionally — including on an empty stream under a huge
    ceiling. Nothing on this path performs one, so nothing noticed. It is now an
    explicit refusal rather than a fallback that happens to look like one: a
    silent cap would be a ceiling nobody could see working, and a short return
    would corrupt the parse.
    """
    reader = store_module._CountingReader(io.BytesIO(b"x" * 10), cap=1 << 40)

    with pytest.raises(store_module.PublishError) as caught:
        reader.read(-1)
    assert caught.value.status == 413
    assert reader.total == 0
    # THE TEXT, which is the only thing that distinguishes this branch. The
    # status and the counter are identical to the arithmetic it replaced —
    # `room + 1 > room` is true for every input, so the old line also raised 413
    # every time — and an earlier round called the two equivalent on exactly that
    # evidence. They are not: this branch exists to SAY that a library started
    # doing something it never did, and asserting only what it shares with the
    # old code leaves the one reason it was written unguarded.
    assert "without a length" in caught.value.message
    assert "in one read" not in caught.value.message


def test_a_malformed_sparse_map_is_a_refusal_and_not_a_crash(hub):
    """`_members_of`, and the claim it had to narrow.

    "Checking the field covers every route" was true only of maps that PARSE. A
    map whose numbers are not numbers raises a bare `ValueError` inside
    `tarfile`'s own header parsing — before the field check, and out of the reach
    of CORRUPT_ARCHIVE_ERRORS, which lists `TarError` and friends. So the pusher
    got a 500 and a stack trace about an archive of their own making, which is
    the exact failure that list exists to prevent.

    Its message carries the sender's own bytes — `invalid literal for int() with
    base 10: '<whatever they sent>'` — so the refusal has to escape and cap it
    like any other untrusted string. That is asserted rather than the absence of
    the text: some detail is what makes the message useful, and the rule here has
    only ever been that it must not be arbitrary or unbounded.

    WHICH HALF DOES THE WORK HERE IS WORTH KNOWING, because it is not the
    obvious one: `int()` builds its message with `repr()`, so the control
    characters are already escaped by the time this sees them, and only the
    LENGTH cap is load-bearing for this particular exception. The escaping is
    kept because nothing promises the next exception will be so careful; the cap
    is what this test can actually distinguish, so it asserts on the length.
    """
    entry = tarfile.TarInfo("f.json")
    entry.type = tarfile.REGTYPE
    entry.size = 1
    entry.mode = 0o644
    # Control characters at the FRONT so they survive a middle cut, and five
    # thousand characters behind them so the cut is what the length assertion
    # measures. No comma: the whole value is then the literal `int()` chokes on,
    # and the whole value is what the exception repeats.
    entry.pax_headers = {"GNU.sparse.map": "\x1b[2Jwiped\r" + "z" * 5000,
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
    # log line beside it. Capped: 5 000 characters of the sender's choosing do
    # not become 5 000 characters of ours.
    assert "\x1b" not in error and "\r" not in error
    # No assertion that the escape sequence is VISIBLE in the message: the
    # exception's own prefix fills the head the cut keeps, so what the sender
    # sent is cut out entirely here. The length is the property this can measure.
    assert len(error) < 200


@pytest.mark.parametrize("window", [1, 2], ids=["at-open", "during-the-walk"])
def test_a_read_error_from_the_disk_is_not_dressed_up_as_a_corrupt_archive(
        hub, tmp_path, monkeypatch, window):
    """The exception to "catch by fact", and the rule `_unpack` states absolutely.

    Both broad catches refuse by WHERE the failure happened rather than by its
    type, because enumerating types is what let a `RecursionError` out as a 500.
    But `tarfile` READS the body off the disk while it parses, so a genuine read
    error is raised from inside those very calls — and answering "archive is
    corrupt" to it sends the pusher off to debug a file that is fine, which is
    exactly what the `except OSError` arm a few lines below exists to prevent.
    `_is_the_disk` is what keeps that rule from having a silent exception.

    PARAMETRIZED OVER WHICH CATCH, because there are two and they are in
    different places: `TarFile.__init__` parses the first member, so a failure at
    the head of the archive is consumed at open and one behind a valid member is
    consumed during the walk. The failure is armed by header WINDOW rather than
    by a read number, since how many reads an open costs is `tarfile`'s business
    and has already differed between interpreters.

    AND THE LOG LINE IS ASSERTED FOR BOTH, which is the half of the arm that
    does any work. The status is the same either way — a 500 is what an
    uncaught OSError becomes regardless — so a test that stopped at the status
    could not tell a covered path from an uncovered one, and did not: while the
    `except OSError` arm sat around the extraction alone, a read failure at open
    went past it and the only record of a dying volume was the traceback
    `app.py` logs for every unhandled exception. So the arm does not rescue this
    from silence — it never was silent — it buys ATTRIBUTION: one line naming
    `dest` and the filesystem, rather than a stack somebody has to read before
    they can tell a dying volume from a bug in the hub.
    """
    counted = {"windows": 0}

    class Failing(store_module._CountingReader):
        def begin_header(self):
            super().begin_header()
            counted["windows"] += 1

        def read(self, size=-1):
            if self.parsing_header and counted["windows"] >= window:
                raise OSError(errno.EIO, "Input/output error")
            return super().read(size)

    monkeypatch.setattr(store_module, "_CountingReader", Failing)

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(_payload_build())
    dest = tmp_path / "staging"
    dest.mkdir()

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
        f"a read failure in window {window} wrote {len(said)} error lines; "
        f"without this one all that is left is app.py's traceback, which records "
        f"the failure but does not say the filesystem is what refused")
    assert "failed on the filesystem" in said[0]


def test_a_body_that_cannot_be_opened_is_attributed_to_the_filesystem(
        hub, tmp_path):
    """The gap the test above left: `gzip.open`, the one line outside the arm.

    It has to stay outside — it CREATES the stream the block's `finally` closes,
    and pulling it in would leave that `finally` over an unbound name, which is
    the trade the comment beside it explains. What does not follow is that the
    line may go unattributed. It is the FIRST touch of the filesystem in
    `_unpack` and it fails in the ordinary ways: EMFILE/ENFILE while several
    pushes are unpacked at once (MAX_CONCURRENT_PUBLISHES), EIO on a volume that
    is going, ENOENT if the spool went away underneath us — which is what this
    test arranges, because it needs no monkeypatching to do it.

    ASSERTED ON THE LOG LINE rather than the status, for the reason the test
    above states: an uncaught OSError is a 500 either way and `app.py` writes a
    traceback for it either way, so the status cannot tell a covered line from an
    uncovered one. Only the sentence naming the file and the filesystem can.
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


def test_a_decided_refusal_survives_the_header_window_closing(hub, tmp_path):
    """Why closing the window is NOT in a `finally`, pinned so it stays that way.

    A `finally` runs with an exception already in flight, and anything it raises
    REPLACES that exception. Put `end_header()` in one and a body that is simply
    not a tar — already answered, 422, by name — comes back as a 500 about the
    filesystem instead, describing a failure that has nothing to do with why the
    push was refused.

    `end_header()` cannot raise today; it assigns `False` to a flag. That is
    exactly the reasoning the comment above the counting reader's constructor
    refuses to accept there, and the two blocks cannot live by opposite rules —
    so this one is closed rather than excused, which costs nothing here: every
    arm around `tarfile.open` raises, so the only way past it is with `tar`
    bound, and a plain call after the block runs on exactly the path that needs
    it. `_members_of` keeps its `finally` because there it is load-bearing — the
    window has to close on the `StopIteration` return as well.

    MONKEYPATCHED TO RAISE, because there is no other way to reach it. That is
    the point of the test rather than a weakness of it: it pins a structural
    choice that no ordinary input can exercise.
    """
    class Failing(store_module._CountingReader):
        def end_header(self):
            raise OSError(errno.EIO, "Input/output error")

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(gzip.compress(b"this is not a tar archive at all"))
    dest = tmp_path / "staging"
    dest.mkdir()

    monkeypatched = pytest.MonkeyPatch()
    monkeypatched.setattr(store_module, "_CountingReader", Failing)
    try:
        with pytest.raises(store_module.PublishError) as caught:
            hub.store._unpack(body_path, dest)
    finally:
        monkeypatched.undo()

    assert caught.value.status == 422
    assert "not a gzipped tar" in caught.value.message


def test_the_overhead_allowance_admits_a_full_archive_of_heavy_headers(
        hub_factory, tmp_path):
    """The two ceilings against each other, which no test compared before.

    ARCHIVE_OVERHEAD_BYTES was a flat 4096 an entry while MAX_PAX_HEADER_CHARS
    admitted 4114 CHARACTERS — more than that before a byte of framing. So an
    archive breaking no declared rule (MAX_MEMBERS members, the heaviest legal
    header on each, contents inside the ceiling) read to 14 663 680 bytes against
    a budget of 12 582 912 and came back 413: the late, corruption-shaped failure
    the comment beside the pax ceiling warns about, arriving from the constant
    next door.
    """
    cap = 1024 * 1024
    small = hub_factory(max_build_bytes=cap)
    filler = {f"SCHILY.xattr.user.k{index:03d}": "v" * 100 for index in range(30)}
    heaviest = store_module.MAX_PAX_HEADER_CHARS
    assert sum(len(k) + len(v) for k, v in filler.items()) <= heaviest

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        for entry, data in _payload():
            tar.addfile(entry, io.BytesIO(data))
        for index in range(store_module.MAX_MEMBERS - len(_payload())):
            info = tarfile.TarInfo(f"f{index:05d}.bin")
            info.type = tarfile.REGTYPE
            info.mode = 0o644
            info.size = 512
            info.pax_headers = dict(filler)
            tar.addfile(info, io.BytesIO(b"x" * 512))

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(buffer.getvalue())
    dest = tmp_path / "staging"
    dest.mkdir()

    files = small.store._unpack(body_path, dest)
    assert len(files) == store_module.MAX_MEMBERS


def test_the_reader_leaves_room_for_the_tar_around_the_files(hub_factory,
                                                             tmp_path):
    """ARCHIVE_OVERHEAD_BYTES, and why the reader's budget is not just the cap.

    `max_build_bytes` bounds the FILE bytes; the reader sees the whole stream,
    which is larger — a 512-byte header per entry and padding to the next block.
    An archive whose contents sit just under the ceiling therefore reads to just
    OVER it, and without the slack the hub would refuse a push it had every
    reason to accept. Sized deliberately so the file bytes fit and the stream
    does not.
    """
    cap = 64 * 1024
    small = hub_factory(max_build_bytes=cap)
    members = [file_entry(f"f{index:02d}.bin", b"x" * 5000) for index in range(12)]
    body = raw_tar_gz(_payload() + members)

    file_bytes = sum(len(data) for _, data in members)
    assert file_bytes < cap, "the files themselves must fit under the ceiling"
    assert len(gzip.decompress(body)) > cap, (
        "the tar stream must NOT fit, or this proves nothing")

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(body)
    dest = tmp_path / "staging"
    dest.mkdir()

    files = small.store._unpack(body_path, dest)
    assert len(files) == len(members) + len(_payload())


def test_the_reader_lets_an_ordinary_archive_through(hub):
    """The other side of the reader: its budget has to clear a real push.

    `max_build_bytes` bounds the FILE bytes, and a tar is bigger than the sum of
    its files — a 512-byte header apiece, padding to the next block, and a pax
    pseudo-member for any long or non-ASCII name. ARCHIVE_OVERHEAD_BYTES is that
    slack, and a ceiling drawn without it would refuse an archive whose contents
    fit exactly.
    """
    assert hub.publish("proj1", "abc123", _payload_build()).status_code == 201


def test_a_sparse_member_from_the_system_tar_is_refused(hub, tmp_path):
    """The refusal, pinned against the `tar` on this machine rather than a theory.

    The justification for refusing used to say that no `tar` writes a sparse
    member without a special flag. That is false: bsdtar detects holes by itself.
    This is the archive it actually produces, so the refusal is recorded as a
    decision about real input instead of surfacing later as a surprise.
    """
    # 32 MB because the detection has a floor: measured on this machine, an 8 MB
    # hole is stored whole and 16 MB is the smallest that comes out sparse. A
    # test sized under that skips every run and proves nothing — which is what
    # the first version of it did. The file costs no disk; it is all hole.
    hole = 32 * 1024 * 1024
    source = tmp_path / "proj"
    source.mkdir()
    with (source / "holey.bin").open("wb") as handle:
        handle.truncate(hole)
        handle.seek(hole)
        handle.write(b"end")
    archive = tmp_path / "holey.tar.gz"
    subprocess.run(["tar", "-czf", str(archive), "proj"], cwd=tmp_path, check=True)

    with tarfile.open(archive, mode="r:gz") as tar:
        sparse = [m.name for m in tar if m.sparse is not None]
    if not sparse:
        # GNU tar, unlike bsdtar, writes a sparse member only under `--sparse`,
        # so this is a real platform difference and not a broken test. The
        # mechanism itself is covered unconditionally by the hand-built archive
        # in `test_a_sparse_member_is_refused`; what skips here is only the
        # evidence that an everyday `tar` produces one.
        pytest.skip("this platform's tar does not detect holes on its own")

    r = hub.publish("proj1", "abc123", archive.read_bytes())
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "sparse" in error
    # And it names the file, which is the only thing an author can act on.
    assert "holey.bin" in error


def test_a_sparse_member_is_refused(hub):
    """The fourth field, and the one no ceiling above can see.

    `TarInfo.sparse` is a list of tuples rather than text, which is how three
    rounds of hunting for name-shaped fields walked past it. It is filled while
    the header is parsed, never reaches `member.size` or the unpacked total, and
    compresses to almost nothing: measured, an old-GNU chain turns a 447 KB body
    into 4.2 million tuples and 303.8 MB, and the archive was ACCEPTED — with
    `name + linkname` at 10 characters and an empty pax dict, so every other
    ceiling here was looking straight at it and measuring zero.

    Refused rather than capped: nothing legitimate is sparse. Neither this
    project's client nor `tar` without `--sparse` writes one, and what a push
    carries is small text files.
    """
    body = gzip.compress(_gnu_sparse_member("sparse.bin", 4) + b"\0" * 1024)

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "sparse" in r.json()["error"]
    assert not (hub.project_dir("proj1") / "abc123").exists()


def test_a_sparse_member_is_invisible_to_every_other_ceiling():
    """Why the check has to be on the field itself, not on a size.

    If this ever starts passing because one of the OTHER ceilings caught it, the
    test above has stopped testing what it is named for.
    """
    raw = _gnu_sparse_member("sparse.bin", 200)
    with tarfile.open(fileobj=io.BytesIO(raw + b"\0" * 1024), mode="r") as tar:
        member = next(iter(tar))

    assert member.sparse is not None and len(member.sparse) > 100
    assert len(member.name) + len(member.linkname) < 32
    assert store_module._pax_header_chars(member) == 0


def test_an_ordinary_member_is_not_mistaken_for_a_sparse_one(hub):
    """The refusal keys off `sparse is not None`, so this is the other half of
    it: every ordinary member has to leave that attribute alone, or no archive
    would publish at all. Also the canary for a `tarfile` that renames it."""
    with tarfile.open(fileobj=io.BytesIO(raw_tar_gz(_payload())), mode="r:gz") as tar:
        for member in tar:
            assert member.sparse is None

    assert hub.publish("proj1", "abc123", _payload_build()).status_code == 201


@pytest.mark.parametrize("field", ["uname", "gname"])
def test_a_large_owner_name_can_only_arrive_as_a_pax_record(field):
    """Why counting `pax_headers` alone covers `uname` and `gname`.

    The claim is about the FORMAT, not about `tarfile`: ustar and GNU give each
    of these a fixed 32-byte field, so anything larger has to be a pax record —
    and a pax record is in the dict, under the same key. Summing the attributes
    on top would be a second guard for a case the first already covers, and no
    test could tell whether it still worked.

    Pinned here because it is the reasoning the ceiling rests on. If a future
    format or `tarfile` version carries a large owner name some other way, this
    fails and `_pax_header_chars` has to grow the term back.
    """
    giant = "U" * 100_000
    for fmt in (tarfile.USTAR_FORMAT, tarfile.GNU_FORMAT, tarfile.PAX_FORMAT):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz", format=fmt) as tar:
            info = tarfile.TarInfo("f.json")
            info.type = tarfile.REGTYPE
            info.size = 1
            info.mode = 0o644
            setattr(info, field, giant)
            tar.addfile(info, io.BytesIO(b"x"))
        with tarfile.open(fileobj=io.BytesIO(buffer.getvalue()),
                          mode="r:gz") as tar:
            member = next(iter(tar))
        held = len(getattr(member, field))
        if held > 32:
            assert member.pax_headers.get(field) == giant, (
                f"format {fmt} kept {held} characters of {field} outside "
                f"pax_headers — _pax_header_chars cannot see them")


def test_the_pax_ceiling_admits_the_heaviest_legal_header(hub, tmp_path):
    """MAX_PAX_HEADER_CHARS from ABOVE, which nothing pinned before.

    The comment used to cite a test by a name no file contained, and the nearest
    real one packs short names — every member came out with zero pax overhead, so
    a ceiling of 1100 passed the whole suite while refusing a legal archive.

    The heaviest legal header is the longest legal NAME (which forces a pax
    `path` mirroring it, 1037 characters) plus the timestamps GNU tar writes in
    pax format. Built with `tarfile` rather than the `tar` binary because a
    1031-character path cannot exist on a filesystem with PATH_MAX of 1024, which
    is the machine `make test` runs on — the archive is the subject here, not the
    filesystem.
    """
    longest = _longest_legal_member_name()
    info = tarfile.TarInfo(longest)
    info.type = tarfile.REGTYPE
    info.size = 1
    info.mode = 0o644
    # Timestamps as GNU tar writes them in pax format, plus extended attributes
    # as bsdtar writes them — TWICE each, once under `LIBARCHIVE.xattr.` and
    # once under `SCHILY.xattr.`, which is measured behaviour and doubles what
    # they cost. Without the attributes this case came to 1106 characters
    # against a ceiling of 4114, so a ceiling quietly lowered to 1200 passed the
    # whole suite while refusing a real archive; the first person to notice
    # would have been whoever pushed one carrying xattrs.
    attributes = {}
    for name in ("user.one", "user.two"):
        for prefix in ("LIBARCHIVE.xattr.", "SCHILY.xattr."):
            attributes[prefix + name] = "A" * 300
    info.pax_headers = {"mtime": "1700000000.0000000",
                        "atime": "1700000000.0000000",
                        "ctime": "1700000000.0000000",
                        **attributes}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
        for entry, data in _payload():
            tar.addfile(entry, io.BytesIO(data))
        tar.addfile(info, io.BytesIO(b"x"))

    body_path = tmp_path / "body.tar.gz"
    body_path.write_bytes(buffer.getvalue())
    dest = tmp_path / "staging"
    dest.mkdir()

    # Unpacked directly for the same reason the twin above is: a 1031-character
    # member cannot be COPIED by the test builder on macOS, though the hub's own
    # component-at-a-time walk handles it.
    files = hub.store._unpack(body_path, dest)
    assert longest[len("./"):] in files

    # And the headroom this leaves, so a future edit can see what it is spending.
    with tarfile.open(fileobj=io.BytesIO(buffer.getvalue()), mode="r:gz") as tar:
        heaviest = max(store_module._pax_header_chars(m) for m in tar)
    # Tied to the arithmetic the ceiling is built from rather than to a bare
    # number: MAX_PAX_HEADER_CHARS clears twice MAX_MEMBER_NAME_CHARS plus slack,
    # and this case has to sit above the first term or it is not exercising it.
    assert heaviest > 2 * store_module.MAX_MEMBER_NAME_CHARS, (
        "this stopped being the heavy case")
    assert heaviest <= store_module.MAX_PAX_HEADER_CHARS


def test_the_name_and_the_link_target_are_one_ceiling_and_not_two(hub):
    """Each field legal on its own, the two together over.

    Both of the tests above put the whole excess in ONE field and leave the other
    empty, so two independent ceilings would pass them exactly as the sum does.
    What is being bounded is what one entry can make the process hold, which is
    the fields together — this is the only test that says so.
    """
    half = store_module.MAX_MEMBER_NAME_CHARS * 2 // 3
    assert half < store_module.MAX_MEMBER_NAME_CHARS, "each field must be legal"
    assert 2 * half > store_module.MAX_MEMBER_NAME_CHARS, "the sum must not be"

    body = raw_tar_gz(_payload() + [symlink_entry("z" * half, "L" * half)])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    assert "link target" in r.json()["error"]


def test_the_length_refusal_says_which_entry_without_repeating_it(hub):
    """Position and kind are OURS; the name is the sender's.

    Refusing without either leaves a message that names nothing at all — the one
    fault here whose subject cannot be quoted, so the two facts that cost the
    sender nothing are the whole of what makes it actionable.
    """
    over = "z" * (store_module.MAX_MEMBER_NAME_CHARS + 1)
    body = raw_tar_gz(_payload() + [file_entry(over, b"x")])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    assert "member number 2" in error       # after the two payload members
    assert "zzz" not in error


def _oversized_name_dir_entry():
    return dir_entry("d" * (store_module.MAX_MEMBER_NAME_CHARS + 1) + "/")


def _oversized_pax_dir_entry():
    entry, data = dir_entry("subdir/")
    entry.pax_headers = {"SCHILY.xattr.user.x":
                         "X" * (store_module.MAX_PAX_HEADER_CHARS + 1)}
    return entry, data


@pytest.mark.parametrize("make_entry", [_oversized_name_dir_entry,
                                        _oversized_pax_dir_entry],
                         ids=["name", "pax-header"])
def test_the_header_ceilings_cover_directory_entries_too(hub, make_entry):
    """Nothing else looks at a directory entry, so BOTH ceilings had to.

    They are skipped before the depth check and before the alphabet, so an
    archive may carry one named fifty components deep and still publish —
    `tarfile` holds a directory entry's name and pax dict exactly like a file's.
    Checking them here is a deliberate narrowing of what is accepted: what it
    turns away is a directory no member of a legal archive could live in.

    Parametrized because the name ceiling had this twin and the pax ceiling did
    not, so "skip the check for directories" survived on the newer of the two.
    """
    body = raw_tar_gz(_payload() + [make_entry()])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    # "directory entry", not "member": the kind is the only thing distinguishing
    # this refusal from the one about a file, and it is one of the two facts the
    # message can carry without repeating a byte of the sender's.
    assert "directory entry number 2" in r.json()["error"]


def test_an_ordinary_directory_entry_is_still_skipped_without_complaint(hub):
    """The other side of that narrowing: a directory entry a real tree produces
    is shorter than any member under it, so nothing changed for it."""
    body = raw_tar_gz(_payload() + [dir_entry("scripts/"),
                                    file_entry("scripts/gen.py", b"x = 1\n")])

    assert hub.publish("proj1", "abc123", body).status_code == 201


def test_a_giant_name_is_cut_before_it_is_escaped_and_not_after():
    """The ORDER, and it IS visible in the output — through the quote `repr`
    picks.

    `repr` uses double quotes when the string holds an apostrophe and no
    quotation mark. Put the only apostrophe in the middle, where the cut removes
    it, and the two orders disagree: cut-then-escape never sees it and quotes
    with `'`, escape-then-cut sees it and quotes with `"`. An apostrophe is not
    in the path alphabet, so a name carrying one is exactly what reaches here.

    Worth the trouble because the alternative was a `tracemalloc` measurement of
    the same claim — slower, environment-dependent, and it mutated tracing for
    the rest of the session.

    THE APOSTROPHE IS PLACED BY THE FUNCTION'S ARITHMETIC, not by a number that
    happens to suit today's ceiling. At a fixed index 40 this test failed the
    moment MAX_REFUSED_NAME_CHARS moved to 120 — and failed claiming the name had
    been escaped before it was cut, which is a false diagnosis of code nobody had
    touched. A string four ceilings long with the apostrophe at the halfway mark
    is inside the removed middle for any ceiling at all.
    """
    cap = store_module.MAX_REFUSED_NAME_CHARS
    raw = "a" * (2 * cap) + "'" + "b" * (2 * cap)

    shown = store_module._shown_untrusted(raw)

    assert len(shown) <= store_module.MAX_REFUSED_NAME_CHARS
    assert shown.startswith("'"), (
        "repr chose double quotes, so it saw the apostrophe — the name was "
        "escaped before it was cut")
    assert "'" not in shown[1:-1]


@pytest.mark.parametrize("raw", [
    "\U0001d173" * 200,   # astral non-printable: ten characters once escaped
    "\x1b" * 500,         # control: four
    "\udc80" * 500,       # the lone surrogate `tarfile` decodes bad bytes into
    "‮" * 500,       # right-to-left override, and the rest of Cf with it
    "z" * 5000,
])
def test_a_shown_untrusted_never_exceeds_the_ceiling(raw):
    """The ceiling is on WHAT IS PRINTED, which is the escaped form.

    Cutting only the raw name capped a string nobody ever sees: escaping
    expands, and ten legal names of 200 astral characters came to 7 892
    characters under a message announcing a ceiling of 80.
    """
    shown = store_module._shown_untrusted(raw)
    assert len(shown) <= store_module.MAX_REFUSED_NAME_CHARS
    assert shown.isprintable()


# Both copies of `_cut_middle`, driven by the same tests. The client cannot
# import `src.store` — it is stdlib-only — so the function exists twice, and a
# round that fixed only the hub's copy and claimed both is the reason these are
# parametrized rather than written once against one of them.
CUT_MIDDLE = [
    pytest.param(store_module._cut_middle, id="hub"),
    pytest.param(client_pack._cut_middle, id="client"),
]


@pytest.mark.parametrize("cut_middle", CUT_MIDDLE)
@pytest.mark.parametrize("cap", [0, 1, 2, 3, 4, 5, 10, 80, 200])
@pytest.mark.parametrize("text", ["", "a", "abcdef", "z" * 5000, "\x1b" * 500])
def test_cutting_a_string_never_makes_it_longer_than_the_cap(
        cut_middle, text, cap):
    """The ceiling `_cut_middle` declares, held at every cap rather than at the
    two it is called with.

    At a cap of 3 or less there is no middle to keep either side of, and the
    arithmetic ran backwards: `text[-0:]` is the whole string, not the empty one,
    so the function returned its entire input with `...` in front — a ceiling
    that lengthened its argument. Unreachable from either call site today, which
    is exactly why it needed a test rather than a reading. A cap of 0 is in the
    list because it is the one value where the correct answer and the naive slice
    agree by accident.
    """
    cut = cut_middle(text, cap)

    assert len(cut) <= cap
    if len(text) > cap > len(store_module.ELLIPSIS):
        assert len(cut) == cap, "a cut that fits should use the whole ceiling"


@pytest.mark.parametrize("cut_middle", CUT_MIDDLE)
def test_cutting_takes_the_middle_and_not_the_tail(cut_middle):
    """WHICH end survives, which nothing else here asserts.

    Cutting the tail instead passes every other test in this file — including
    the one about escaping before cutting, because an apostrophe in the middle
    disappears under either. What a tail cut destroys is the file's own name,
    which is the half of a path that identifies it; the head alone would leave
    `ref/vendor/rev2/…` for every file in the directory.
    """
    cut = cut_middle("HEAD" + "z" * 5000 + "TAIL", 80)

    assert cut.startswith("HEAD")
    assert cut.endswith("TAIL")
    assert store_module.ELLIPSIS in cut


def test_the_two_copies_of_cut_middle_have_not_drifted():
    """One function, two files, and no import that could keep them in step.

    Compared as syntax trees with the docstrings dropped, since the docstrings
    differ on purpose: each says what its own side needs. This is a TEXTUAL
    check and its failure says exactly that and no more — renaming a local
    variable on one side trips it, and that is a difference worth a moment even
    though it changes no behaviour. What the message must not do is diagnose:
    the previous wording announced that the ceilings had diverged, which is a
    conclusion this test cannot reach and was wrong every time a rename tripped
    it.
    """
    def body(function):
        tree = ast.parse(textwrap.dedent(inspect.getsource(function))).body[0]
        # Drop the docstring, which is the first statement when there is one.
        if (isinstance(tree.body[0], ast.Expr)
                and isinstance(tree.body[0].value, ast.Constant)
                and isinstance(tree.body[0].value.value, str)):
            tree.body = tree.body[1:]
        return ast.dump(tree)

    assert body(store_module._cut_middle) == body(client_pack._cut_middle), (
        "the two copies of _cut_middle are no longer textually identical. That "
        "is all this knows — it has NOT established that they behave "
        "differently. If the difference is deliberate, say so in the docstring "
        "of each and record why one side needs it; if it is a stray rename, "
        "make them match again.")
    assert store_module.ELLIPSIS == client_pack.ELLIPSIS, (
        "the hub and the client cut with different ellipsis text")


def test_a_short_printable_name_is_neither_escaped_nor_cut():
    """The other end of the same function, and it has to be asserted rather than
    assumed: a rule that mangled every cyrillic name would make the refusal
    useless for exactly the tree this was all written for."""
    raw = "ref/сифон-1.5x40-чертёж.jpg"

    shown = store_module._shown_untrusted(raw)

    assert shown == repr(raw)
    assert raw in shown          # letters intact, nothing escaped
    assert "..." not in shown    # short enough that nothing was cut


def test_an_answer_stays_small_however_much_escaping_expands_the_names(hub):
    """The end-to-end form of the test above, on the worst expansion there is."""
    bad = ["\U0001d173" * 200 + f"{index}.jpg" for index in range(20)]
    body = raw_tar_gz(_payload() + [file_entry(name, b"x") for name in bad])

    r = hub.publish("proj1", "abc123", body)
    assert r.status_code == 422, r.text
    error = r.json()["error"]
    ceiling = store_module.MAX_REFUSED_NAMES_REPORTED * (
        store_module.MAX_REFUSED_NAME_CHARS + 2)
    assert len(error) < ceiling + 400
    assert error.isprintable()


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
    assert _leftovers(hub, "proj1") == []


def _record_spools_at_reply_time(hub, monkeypatch):
    """Every reply this hub writes, as (status, spool files present right then).

    THE SNAPSHOT IS TAKEN IN THE SERVER THREAD, one statement before the status
    line reaches the socket, which is what makes the test below deterministic
    where `_leftovers` after a request is not. A test that looks at the volume
    once the client has its answer is racing the handler's own `finally`: on an
    idle laptop the request thread finishes cleaning up first and the assertion
    passes for a reason that has nothing to do with the code, and on a loaded CI
    runner it does not. The ORDER is the property; observe the order.

    Wrapped at `_send` because it is the single funnel every reply goes through
    (`_json` and `_error` both end here) and because it runs BEFORE
    `end_headers`, which is where the first byte actually leaves.
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

    The successful path has always had this order — `_queue_build` sits below the
    `finally` — and the refusals did not: they answered from inside the `try`,
    so a client that had just been told 400, 422 or 500 could look at the data
    directory and still find the `.upload-<uuid>` its own push was spooled into.
    That is what `test_a_corrupt_archive_leaves_no_staging_tree` failed on in CI
    while passing everywhere else.

    All three refusal clauses are driven, because they are three separate exits
    and the fix is only worth anything if it covers each: the problem
    `_spool_body` reports, the PublishError the store raises, and the unexpected
    exception. The BrokenPipeError clause is deliberately not here — it answers
    nobody at all, which is the one case with no reply to be ordered against.
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
            b"Authorization: Bearer " + TOKEN.encode() + b"\r\n"
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
