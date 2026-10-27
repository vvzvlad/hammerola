"""The pass at start over `data/sources/`, the archives of the builds published
before git (`Store.drop_sources`).

`Hub.publish` leaves a build as such a build stands on a hub now: built from
the archive's tree, recorded by its `.payload.sha256`, with its import commit
in `main` and its `.build.log`. `published` files the archive and its log in
`sources/` as the older hub kept them.
"""

import hashlib
import io
import json
import os
import shutil
import tarfile

from harness import (DEFAULT_EXPORTS, good_build, meta_bytes, start_hub,
                     stop_hub, tar_gz, view_bytes)
from loguru import logger

from src.store import (MAIN_REF, PAYLOAD_DIGEST_FILE, SOURCE_LOG_NAME,
                       SOURCES_DIR_NAME, _commit_digest, _payload_digest,
                       _read_digest, _trailed_log)


def published(hub, pid, name, body, log=True):
    """Publish `body` as `<pid>/<name>` and file its archive by its digest.

    -> the archive's directory in `sources/`.
    """
    assert hub.publish(pid, name, body).status_code == 201
    directory = (hub.data / SOURCES_DIR_NAME
                 / _read_digest(hub.store.build_dir(pid, name)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "source.tar.gz").write_bytes(body)
    if log:
        (directory / SOURCE_LOG_NAME).write_text("old log\n")
    return directory


def logged():
    """A sink for the log, one `<level> <message>` per entry.

    -> (lines, handle)."""
    said = []
    return said, logger.add(lambda line: said.append(str(line).strip()),
                            level="INFO", format="{level} {message}")


def swept(hub):
    """Run the pass once. -> what it logged."""
    said, handle = logged()
    try:
        hub.store.drop_sources()
    finally:
        logger.remove(handle)
    return said


def errors(said):
    return [line for line in said if line.startswith("ERROR")]


def tar_bytes(files: dict) -> bytes:
    """An uncompressed tar of `files`, as `git archive` writes one."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def test_an_archive_its_import_commits_give_back_is_deleted_at_start(tmp_path):
    """Two builds of one tree share its archive: either commit verifies it."""
    data = tmp_path / "data"
    hub = start_hub(data)
    try:
        directory = published(hub, "src1", "first", good_build("a"))
        assert hub.publish("src1", "twin", good_build("a")).status_code == 201
    finally:
        stop_hub(hub)

    said, handle = logged()
    try:
        hub = start_hub(data)
    finally:
        logger.remove(handle)
    try:
        assert not directory.exists()
        assert "INFO sources: deleted 1, kept 0, not imported 0" in said, said
        assert errors(said) == []
        # Only the archive went.
        assert hub.store.build_log_path("src1", "first").is_file()
        assert hub.get("/project/src1/first/meta.json").status_code == 200
        assert [values for _sha, values in
                _trailed_log(hub.store.repo_dir("src1"), MAIN_REF)] == [
            ["src1/twin"], ["src1/first"]]
    finally:
        stop_hub(hub)


def test_an_archive_is_kept_while_one_of_its_builds_has_no_import_commit(hub):
    """One tree published in two projects: the first project's commit gives
    the digest back, the second has none, and every build has to have one."""
    directory = published(hub, "shr1", "first", good_build("a"))
    published(hub, "shr2", "first", good_build("a"))
    shutil.rmtree(hub.store.repo_dir("shr2"))

    said = swept(hub)

    assert directory.is_dir()
    assert errors(said) == [f"ERROR sources {directory.name}: shr2/first has "
                            f"no import commit in main"]
    assert "INFO sources: deleted 0, kept 1, not imported 0" in said, said


def test_an_archive_whose_import_commit_gives_another_digest_is_kept(hub):
    """The build carries a digest its import commit does not give back."""
    assert hub.publish("src2", "first", good_build("a")).status_code == 201
    other = "f" * 64
    build = hub.store.build_dir("src2", "first")
    (build / PAYLOAD_DIGEST_FILE).write_text(other)
    directory = hub.data / SOURCES_DIR_NAME / other
    directory.mkdir(parents=True)
    (directory / "source.tar.gz").write_bytes(good_build("a"))

    said = swept(hub)

    assert directory.is_dir()
    [error] = errors(said)
    assert error.startswith(f"ERROR sources {other}: no import commit gives "
                            f"this digest: src2/first "), error
    assert "INFO sources: deleted 0, kept 1, not imported 0" in said, said


def test_an_archive_no_build_carries_is_kept_without_an_error(hub):
    published(hub, "src3", "first", good_build("a"))
    stray = hub.data / SOURCES_DIR_NAME / ("e" * 64)
    stray.mkdir()
    (stray / "source.tar.gz").write_bytes(good_build("b"))

    said = swept(hub)

    assert (stray / "source.tar.gz").is_file()
    assert errors(said) == []
    assert "INFO sources: deleted 1, kept 0, not imported 1" in said, said


def test_an_archive_whose_build_has_no_build_log_is_kept(hub):
    """Its `log.txt` is the build's only log until `.build.log` is there; an
    archive kept without a `log.txt` asks for no `.build.log`."""
    directory = published(hub, "src4", "first", good_build("a"))
    hub.store.build_log_path("src4", "first").unlink()
    no_log = published(hub, "src4b", "first", good_build("b"), log=False)
    hub.store.build_log_path("src4b", "first").unlink()

    said = swept(hub)

    assert (directory / SOURCE_LOG_NAME).is_file()
    assert errors(said) == [
        f"ERROR sources {directory.name}: src4/first has no .build.log"]
    assert not no_log.exists()
    assert "INFO sources: deleted 1, kept 1, not imported 0" in said, said


def test_an_archive_of_a_build_of_an_older_format_is_checked_too(hub):
    """A meta.json without `views`, which `builds_of` skips, is still a build
    with an import commit to hold its archive to; such a directory without a
    `.payload.sha256` is a restore that ran out halfway and not a build."""
    directory = published(hub, "src5", "first", good_build("a"))
    meta_path = hub.store.build_meta_path("src5", "first")
    meta = json.loads(meta_path.read_text())
    del meta["views"]
    meta_path.write_text(json.dumps(meta))
    half = hub.store.build_dir("src5", "half")
    half.mkdir()
    (half / meta_path.name).write_text(json.dumps({**meta, "commit": "half"}))
    assert hub.store.builds_of("src5") == []
    assert [build["commit"] for build in
            hub.store._imported_builds("src5")] == ["first"]

    said = swept(hub)

    assert not directory.exists()
    assert "INFO sources: deleted 1, kept 0, not imported 0" in said, said


def test_the_digest_of_a_commit_with_nested_directories_is_the_builds(hub):
    """`git archive` writes an entry per directory, and they are not files."""
    files = {"meta.json": meta_bytes(), "assembled.json": view_bytes("a"),
             **DEFAULT_EXPORTS,
             "ref/vendor/rev2/part.step": b"ISO-10303-21;\n",
             "scripts/gen.py": b"print(1)\n"}
    assert hub.publish("src6", "first", tar_gz(files)).status_code == 201
    expected = _payload_digest({name: hashlib.sha256(data).hexdigest()
                                for name, data in files.items()})
    repo = hub.store.repo_dir("src6")
    [(sha, values)] = _trailed_log(repo, MAIN_REF)

    assert values == ["src6/first"]
    assert _read_digest(hub.store.build_dir("src6", "first")) == expected
    assert _commit_digest(repo, sha) == expected


def test_the_digest_waits_for_git_archive_to_write_its_last_bytes(
        tmp_path, monkeypatch):
    """git writes the padding of its last record after the end-of-archive
    blocks `tarfile` stops at; cut off there, it dies of SIGPIPE."""
    files = {"a/b.txt": b"x\n"}
    archive = tmp_path / "archive.tar"
    archive.write_bytes(tar_bytes(files))
    fake = tmp_path / "bin" / "git"
    fake.parent.mkdir()
    fake.write_text(f"#!/bin/sh\ncat '{archive}'\nsleep 0.5\n"
                    f"head -c 10240 /dev/zero\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake.parent}:{os.environ['PATH']}")

    assert _commit_digest(tmp_path, "HEAD") == _payload_digest(
        {name: hashlib.sha256(data).hexdigest()
         for name, data in files.items()})
