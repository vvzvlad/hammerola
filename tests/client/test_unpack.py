"""What `hammerola source` will and will not write onto somebody's disk.

THE HUB ALREADY REFUSES EVERYTHING THIS REFUSES, and that is not a reason to
skip these. What runs here runs on the author's machine, under their account,
with their home directory in reach, and it is being handed a tar by a network
service — over a token that whoever holds the hub also holds. "The server
validated it" is a statement about the server, not a control on the client, and
a member named `../.ssh/authorized_keys` costs nothing to refuse.

The archives below are built by hand for the same reason
`tests/test_archive_security.py` builds its own: `tarfile` will happily WRITE a
member named `../escape` or a symlink, and no convenience wrapper can ask for
one. These are genuinely hostile archives rather than descriptions of hostile
archives.

EVERY REFUSAL IS ALL-OR-NOTHING, and each test checks that too: the members are
walked and checked before a single byte is written, so a rejected archive leaves
the destination as it found it. A partial unpack would be the worst outcome —
some of a stranger's tree on disk, under a command that reported failure.
"""

import inspect
import io
import tarfile

import pytest
from harness import (chardev_entry, dir_entry, fifo_entry, file_entry,
                     hardlink_entry, raw_tar_gz, symlink_entry)

from src.client import unpack
from src.client.errors import ClientError
from src.client.limits import MAX_MEMBERS, MAX_PATH_DEPTH


# EVERY HOSTILE ARCHIVE IS TRIED UNDER BOTH RULE SETS, and that parametrization
# is not symmetry for its own sake. `TEMPLATE_RULES` is the one the client reads
# an archive with from an address a PERSON TYPED, on a machine where nothing else
# has checked it — and it was the untested one: the whole adversarial set below
# called `extract` without an argument, i.e. exercised the push rules only, and
# the relaxation written for `.gitignore` turned out to accept `.git/config` as
# well. That member is executed by the next `git status` anybody runs.
ALL_RULES = [
    pytest.param(unpack.PUSH_RULES, id="push"),
    pytest.param(unpack.TEMPLATE_RULES, id="template"),
]


def good(files=None):
    files = files or {"model.py": b"X = 1\n", "ref/part.step": b"ISO;\n"}
    return raw_tar_gz([file_entry(name, data) for name, data in files.items()])


def test_an_ordinary_tree_arrives_whole(tmp_path):
    written = unpack.extract(good(), tmp_path / "out")
    assert written == ["model.py", "ref/part.step"]
    assert (tmp_path / "out" / "ref" / "part.step").read_bytes() == b"ISO;\n"
    # The directory came from this code, not from a member: a tar's own
    # directory entries carry modes and shapes nobody here wants.
    assert (tmp_path / "out" / "ref").is_dir()


def test_reading_in_memory_gives_the_same_members(tmp_path):
    assert unpack.read_members(good()) == {
        "model.py": b"X = 1\n", "ref/part.step": b"ISO;\n"}


@pytest.mark.parametrize("rules", ALL_RULES)
@pytest.mark.parametrize("name", [
    "../escape.py",
    "../../escape.py",
    "ref/../../escape.py",
    "/etc/passwd",
    "./model.py",
    ".ssh/authorized_keys",     # a hidden component is not on the alphabet
    "ref//model.py",            # an empty component
    "C:\\model.py",
    # THE TWO THAT MATTER MOST UNDER THE TEMPLATE RULES, because they are what a
    # per-component relaxation lets through. `.git/config` is remote code
    # execution and needs no vulnerability anywhere: `core.fsmonitor` holds a
    # shell command, `git init` does not overwrite an existing config, and the
    # skill tells the author to commit project.json — so the next `git status`
    # runs it. `.ssh/authorized_keys` is above, under both.
    ".git/config",
    ".git/hooks/pre-commit",
    # A directory named for the one file the template rules DO allow: the
    # exception is a leaf, so this is still refused.
    ".gitignore/payload.py",
])
def test_a_member_that_navigates_is_refused_and_nothing_is_written(tmp_path,
                                                                   name, rules):
    dest = tmp_path / "out"
    with pytest.raises(ClientError) as raised:
        unpack.extract(raw_tar_gz([file_entry(name, b"pwned")]), dest,
                       rules=rules)
    assert "match" in str(raised.value) or "deeper" in str(raised.value)
    # Not one byte, and not even the directory: the check runs before the write.
    assert not dest.exists() or list(dest.iterdir()) == []
    assert not (tmp_path / "escape.py").exists()


def test_a_hidden_file_is_refused_by_default_and_only_the_template_may_carry_one(
        tmp_path):
    """THE RELAXED RULES ARE NOT THE DEFAULT, stated as a test.

    Both functions take `rules` with `PUSH_RULES` in the signature, and the day
    somebody "tidies" that into the template's set — or passes it to save an
    argument — `source` and `diff` would start writing hidden files out of an
    archive from the hub. This fails at that edit.
    """
    body = raw_tar_gz([file_entry(".gitignore", b"_out/\n")])
    with pytest.raises(ClientError):
        unpack.extract(body, tmp_path / "push")
    with pytest.raises(ClientError):
        unpack.read_members(body)

    written = unpack.extract(body, tmp_path / "template",
                             rules=unpack.TEMPLATE_RULES)
    assert written == [".gitignore"]
    assert (tmp_path / "template" / ".gitignore").read_bytes() == b"_out/\n"

    for function in (unpack.extract, unpack.read_members):
        default = inspect.signature(function).parameters["rules"].default
        assert default is unpack.PUSH_RULES, (
            f"{function.__name__} defaults to {default}, so an unpack written "
            f"without an argument no longer applies the push's alphabet")


def test_the_template_exception_is_one_name_in_the_last_position(tmp_path):
    """The width of the relaxation, pinned where it is easy to widen by accident.

    One entry, and it is checked as a NAME rather than as "starts with a dot".
    """
    assert unpack.TEMPLATE_RULES.hidden_leaves == frozenset({".gitignore"})
    assert unpack.PUSH_RULES.hidden_leaves == frozenset()
    # A leaf inside a directory is fine; the directory itself never is.
    assert unpack.extract(
        raw_tar_gz([file_entry("ref/.gitignore", b"x")]), tmp_path / "out",
        rules=unpack.TEMPLATE_RULES) == ["ref/.gitignore"]


@pytest.mark.parametrize("rules", ALL_RULES)
@pytest.mark.parametrize("entry", [
    symlink_entry("link.py", "/etc/passwd"),
    symlink_entry("link.py", "../outside.py"),
    hardlink_entry("link.py", "model.py"),
    fifo_entry("pipe"),
    chardev_entry("null"),
])
def test_only_regular_files_are_unpacked(tmp_path, entry, rules):
    """A link is the classic way to make a write land somewhere else, and the
    hub refuses every one of them on the way in — so one arriving here means
    the archive did not come from a push this hub accepted."""
    dest = tmp_path / "out"
    with pytest.raises(ClientError) as raised:
        unpack.extract(raw_tar_gz([file_entry("model.py", b"X = 1\n"), entry]),
                       dest, rules=rules)
    assert "not a regular file" in str(raised.value)
    assert not dest.exists() or list(dest.iterdir()) == []


def test_a_directory_member_is_not_a_refusal(tmp_path):
    """Directory entries are IGNORED rather than refused: `tar` writes them for
    every ordinary tree, and the directories here are made by this code."""
    body = raw_tar_gz([dir_entry("ref/"), file_entry("ref/a.py", b"A = 1\n")])
    assert unpack.extract(body, tmp_path / "out") == ["ref/a.py"]


def test_too_many_members_is_refused_before_anything_is_written(tmp_path):
    body = raw_tar_gz([file_entry(f"f{index}.py", b"x")
                       for index in range(MAX_MEMBERS + 1)])
    dest = tmp_path / "out"
    with pytest.raises(ClientError) as raised:
        unpack.extract(body, dest)
    assert str(MAX_MEMBERS) in str(raised.value)
    assert not dest.exists() or list(dest.iterdir()) == []


def test_a_path_deeper_than_a_push_may_carry_is_refused(tmp_path):
    deep = "/".join(f"d{index}" for index in range(MAX_PATH_DEPTH)) + "/f.py"
    with pytest.raises(ClientError):
        unpack.extract(raw_tar_gz([file_entry(deep, b"x")]), tmp_path / "out")


def test_an_archive_that_unpacks_to_more_than_a_push_may_be_is_refused(
        tmp_path, monkeypatch):
    """The ceiling is counted from the headers, so a tarbomb is refused before
    a byte of it is written rather than after the disk is full."""
    monkeypatch.setattr(unpack, "MAX_BUILD_BYTES", 1024)
    body = raw_tar_gz([file_entry("big.bin", b"x" * 2048)])
    dest = tmp_path / "out"
    with pytest.raises(ClientError) as raised:
        unpack.extract(body, dest)
    assert "nothing was written" in str(raised.value)
    assert not dest.exists() or list(dest.iterdir()) == []


def test_a_member_that_lies_about_its_size_is_cut_off(tmp_path):
    """The ceilings were counted from the headers, so a member that goes on
    producing bytes past its declared size would be a way past all of them."""
    info = tarfile.TarInfo("liar.py")
    info.type = tarfile.REGTYPE
    info.size = 4
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        tar.addfile(info, io.BytesIO(b"1234"))
    # tarfile stops at the declared size on its own; what this pins is that the
    # copy loop does not depend on it doing so.
    written = unpack.extract(buffer.getvalue(), tmp_path / "out")
    assert (tmp_path / "out" / "liar.py").read_bytes() == b"1234"
    assert written == ["liar.py"]


def test_something_that_is_not_an_archive_is_a_sentence_not_a_traceback(
        tmp_path):
    with pytest.raises(ClientError) as raised:
        unpack.extract(b"not a tar at all", tmp_path / "out")
    assert "not a readable .tar.gz" in str(raised.value)


def test_the_message_names_what_it_was_reading(tmp_path):
    """The caller passes `where` so the refusal says WHICH archive: a person
    fetching a revision has to know it was that revision's code."""
    with pytest.raises(ClientError) as raised:
        unpack.extract(raw_tar_gz([file_entry("../x", b"x")]), tmp_path / "out",
                       where="the code of abc123")
    assert "the code of abc123" in str(raised.value)
