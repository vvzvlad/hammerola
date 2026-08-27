"""What goes into the archive, and what the client refuses to send at all.

Two kinds of claim here, and they are answered differently on purpose:

  * a name the hub CANNOT accept but every repository has — anything hidden —
    is dropped silently. Refusing would make no ordinary checkout publishable;
  * a name the hub cannot accept that is NOT ordinary is a refusal, naming the
    file. Skipping it would produce a build missing a file, which fails later,
    inside the hub, as a confusing message about an import.

The archive itself is checked by unpacking it with the same `tarfile` the hub
opens it with, so what is asserted is the bytes that would be sent.
"""

import io
import os
import tarfile

import pytest
from modeldir import make_model

from src.client.limits import MAX_MEMBERS, MAX_PATH_DEPTH
from src.client.pack import PackError, collect, pack


def members(root, **kw):
    """The member names inside the real archive, in the order tar holds them."""
    archive = pack(root, **kw)
    with tarfile.open(fileobj=io.BytesIO(archive.body), mode="r:gz") as tar:
        return [info.name for info in tar]


# -- what is packed ----------------------------------------------------------
def test_the_source_tree_is_packed_with_relative_paths(tmp_path):
    root = make_model(tmp_path / "demo", extra={
        "scripts/gen.py": "print('hi')\n",
        "ref/vendor/part.step": "ISO-10303-21;\n",
    })
    assert members(root) == [
        "assembled.json", "meta.json", "model.py", "project.json",
        "ref/vendor/part.step", "scripts/gen.py",
    ]


def test_hidden_entries_are_dropped_rather_than_refused(tmp_path):
    """Every one of these is a name `SAFE_COMPONENT` forbids and every
    repository has. `.env` is the one that matters most: it is where the publish
    token lives on a laptop, and it must never leave the machine."""
    root = make_model(tmp_path / "demo")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    (root / ".venv").mkdir()
    (root / ".venv" / "pyvenv.cfg").write_text("home = /usr\n")
    (root / ".gitignore").write_text("_out/\n")
    (root / ".env").write_text("PUBLISH_TOKEN=super-secret\n")
    (root / ".DS_Store").write_bytes(b"\x00\x01")
    # An AppleDouble sidecar: what macOS `tar` adds beside a file carrying an
    # extended attribute, and the reason this tool never shells out to tar.
    (root / "._model.py").write_bytes(b"\x00\x05\x16\x07")

    packed = pack(root)
    assert packed.names == ("assembled.json", "meta.json", "model.py",
                            "project.json")
    assert b"super-secret" not in packed.body


def test_build_output_and_caches_are_dropped(tmp_path):
    root = make_model(tmp_path / "demo")
    for directory in ("__pycache__", "_out", "out", "build", "node_modules"):
        (root / directory).mkdir()
        (root / directory / "junk.json").write_text("{}")
    (root / "model.pyc").write_bytes(b"\x00")
    (root / "model.py~").write_text("older\n")

    assert members(root) == ["assembled.json", "meta.json", "model.py",
                             "project.json"]


def test_two_runs_over_an_unchanged_tree_produce_the_same_bytes(tmp_path):
    """Ownership and mtime are scrubbed, and the member order is sorted.

    Not something the hub cares about — it hashes file CONTENTS — but it is what
    makes "did anything change" answerable locally by comparing two archives.
    """
    root = make_model(tmp_path / "demo")
    assert pack(root).body == pack(root).body


def test_the_archive_carries_nothing_about_the_machine(tmp_path):
    root = make_model(tmp_path / "demo")
    with tarfile.open(fileobj=io.BytesIO(pack(root).body), mode="r:gz") as tar:
        for info in tar:
            assert (info.uid, info.gid, info.uname, info.gname) == (0, 0, "", "")
            assert info.mtime == 0
            assert info.isfile()


# -- what is refused ---------------------------------------------------------
def test_a_name_the_hub_cannot_accept_is_refused_by_name(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "My Model.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert "My Model.py" in str(caught.value)


def test_a_symlink_is_refused_rather_than_followed(tmp_path):
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 1\n")
    root = make_model(tmp_path / "demo")
    (root / "linked.py").symlink_to(outside)
    with pytest.raises(PackError) as caught:
        collect(root)
    assert "linked.py" in str(caught.value)
    assert "symlink" in str(caught.value)


def test_a_tree_deeper_than_the_hub_accepts_is_refused(tmp_path):
    """MAX_PATH_DEPTH counts the file name too, so eight components is the
    deepest member and the ninth level is where this has to stop."""
    root = make_model(tmp_path / "demo")
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH)])
    deep.mkdir(parents=True)
    (deep / "part.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert str(MAX_PATH_DEPTH) in str(caught.value)


def test_a_member_at_exactly_the_ceiling_is_accepted(tmp_path):
    root = make_model(tmp_path / "demo")
    deep = root.joinpath(*[f"d{n}" for n in range(MAX_PATH_DEPTH - 1)])
    deep.mkdir(parents=True)
    (deep / "part.py").write_text("x = 1\n")
    names = members(root)
    assert any(name.count("/") == MAX_PATH_DEPTH - 1 for name in names)


def test_too_many_files_are_refused_before_anything_is_sent(tmp_path):
    root = make_model(tmp_path / "demo")
    for index in range(MAX_MEMBERS):
        (root / f"part{index:04d}.py").write_text("x = 1\n")
    with pytest.raises(PackError) as caught:
        collect(root)
    assert str(MAX_MEMBERS) in str(caught.value)


def test_a_tree_over_the_size_ceiling_is_refused(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "big.bin").write_bytes(b"\x00" * 4096)
    with pytest.raises(PackError) as caught:
        pack(root, max_bytes=1024)
    assert "ceiling" in str(caught.value)


@pytest.mark.skipif(os.geteuid() == 0,
                    reason="root reads a 0000 directory regardless of its mode")
def test_a_directory_that_cannot_be_listed_is_refused_by_name(tmp_path):
    """An unreadable subdirectory is a message, not a traceback.

    `cli.main` prints exactly five exception families as a sentence, and an
    `OSError` out of `iterdir` is not one of them — so before this the whole
    command ended in a traceback that did not even name the directory, for
    somebody whose real problem is one `chmod`.
    """
    root = make_model(tmp_path / "demo")
    locked = root / "ref"
    locked.mkdir()
    (locked / "part.step").write_text("ISO-10303-21;\n")
    locked.chmod(0o000)
    try:
        with pytest.raises(PackError) as caught:
            collect(root)
        assert "ref" in str(caught.value)
    finally:
        # Restored whatever the assertion did, or pytest cannot clean tmp_path.
        locked.chmod(0o755)


def test_an_empty_tree_is_refused(tmp_path):
    """The hub answers 422 "archive is empty"; there is no reason to make it."""
    root = tmp_path / "nothing"
    root.mkdir()
    (root / ".hidden").write_text("x\n")
    with pytest.raises(PackError):
        collect(root)
