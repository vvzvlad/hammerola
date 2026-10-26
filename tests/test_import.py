"""The import of the builds an older hub published, into each project's git.

`Hub.publish` publishes the way that hub did, and imports at once; a restart
on the same volume (`start_hub`) is a new process catching up
(`Store.catch_up`).
"""

import shutil

from harness import (TOKEN, TOKEN_CONFIG, commit_all, git, good_build,
                     project_files, push, start_hub, stop_hub, write_files)
from loguru import logger

from src.archive import unpack
from src.store import (IMPORT_TRAILER, LATEST_LINK, SOURCE_ARCHIVE_NAME,
                       SOURCE_LOG_NAME, SOURCES_DIR_NAME, _payload_digest)


def main_log(hub, pid):
    """`[(sha, import trailer value), ...]` of `main`, oldest first."""
    out = git("-C", hub.store.repo_dir(pid), "log", "--reverse",
              f"--format=%H %(trailers:key={IMPORT_TRAILER},valueonly)",
              "main").stdout
    return [tuple(line.split(" ", 1)) for line in out.splitlines() if line]


def refs_reply(hub, pid):
    return hub.get(f"/git/{pid}.git/info/refs?service=git-upload-pack",
                   headers={"X-Hammerola-Token": TOKEN})


def published_by_the_old_image(hub, monkeypatch, pid, name, body):
    """A build an older image published from an archive, with no import."""
    with monkeypatch.context() as patch:
        patch.setattr(hub.store, "ensure_repo", lambda pid: None)
        patch.setattr(hub.store, "recompute", lambda pid: None)
        assert hub.publish(pid, name, body).status_code == 201


def digest_of(body, tmp_path):
    archive = tmp_path / "body.tar.gz"
    archive.write_bytes(body)
    (tmp_path / "unpacked").mkdir()
    return _payload_digest(unpack(archive, tmp_path / "unpacked"))


def logged():
    said = []
    return said, logger.add(said.append, level="INFO")


def test_old_builds_become_commits_oldest_first_and_main_is_latest(hub):
    hub.publish("imp1", "cards-2026-09-14", good_build("a"),
                message="first cut")
    hub.publish("imp1", "b" * 64, good_build("a"))
    hub.publish("imp1", "c" * 64, good_build("c"))

    log = main_log(hub, "imp1")

    assert [value for _sha, value in log] == [
        "imp1/cards-2026-09-14", f"imp1/{'b' * 64}", f"imp1/{'c' * 64}"]
    assert hub.store.latest_commit("imp1") == "c" * 64
    first = git("-C", hub.store.repo_dir("imp1"), "log", "-1",
                "--format=%an <%ae>%n%s", log[0][0]).stdout.split("\n")
    assert first[:2] == ["hammerola import <import@hammerola>", "first cut"]
    # Twins: one tree, two commits.
    trees = [git("-C", hub.store.repo_dir("imp1"), "rev-parse",
                 f"{sha}^{{tree}}").stdout for sha, _ in log[:2]]
    assert trees[0] == trees[1]


def test_a_build_published_after_the_import_is_imported_at_the_next_start(
        tmp_path, monkeypatch):
    data = tmp_path / "data"
    hub = start_hub(data)
    hub.publish("imp2", "c1", good_build("a"))
    hub.publish("imp2", "c2", good_build("b"))
    before = [sha for sha, _ in main_log(hub, "imp2")]
    body = good_build("c")
    digest = digest_of(body, tmp_path)
    published_by_the_old_image(hub, monkeypatch, "imp2", digest, body)
    # That image kept the log beside the archive, not in the build.
    hub.store.build_log_path("imp2", digest).unlink()
    (data / SOURCES_DIR_NAME / digest / SOURCE_LOG_NAME).write_text("old log\n")
    stop_hub(hub)

    hub = start_hub(data)
    try:
        after = main_log(hub, "imp2")
        assert [sha for sha, _ in after[:2]] == before
        assert after[2][1] == f"imp2/{digest}"
        assert hub.store.latest_commit("imp2") == digest
        assert hub.get(f"/api/v1/logs/imp2/{digest}",
                       headers={"X-Hammerola-Token": TOKEN}).text == "old log\n"
        assert (data / SOURCES_DIR_NAME / digest / SOURCE_LOG_NAME).exists()
    finally:
        stop_hub(hub)


def test_a_missing_import_under_commits_of_the_author_is_an_error(
        tmp_path, monkeypatch):
    data = tmp_path / "data"
    hub = start_hub(data)
    hub.publish("imp3", "c1", good_build("a"))
    work = tmp_path / "work"
    git("-c", TOKEN_CONFIG, "clone", "--quiet", f"{hub.url}/git/imp3.git",
        work)
    write_files(work, project_files("imp3", marker="b"))
    commit_all(work, "the author's own")
    assert push(hub, work, "imp3").returncode == 0
    published_by_the_old_image(hub, monkeypatch, "imp3", "c3",
                               good_build("c"))
    # That image moved `latest` to its newest build.
    hub.store._point("imp3", LATEST_LINK, "c3")
    stop_hub(hub)

    said, handle = logged()
    try:
        hub = start_hub(data)
    finally:
        logger.remove(handle)
    try:
        assert any("import imp3: c3: it has no import commit" in line
                   and "ERROR" in line for line in said), said
        refused = refs_reply(hub, "imp3")
        assert refused.status_code == 503
        assert "c3" in refused.json()["error"]
        assert hub.store.latest_commit("imp3") == "c3"
    finally:
        stop_hub(hub)


def test_an_unreadable_archive_leaves_no_repository_and_answers_503(
        tmp_path):
    data = tmp_path / "data"
    hub = start_hub(data)
    hub.publish("imp4", "c1", good_build("a"))
    shutil.rmtree(hub.store.repo_dir("imp4"))
    [archive] = (data / SOURCES_DIR_NAME).glob(f"*/{SOURCE_ARCHIVE_NAME}")
    archive.write_bytes(b"not a gzip")
    (hub.store.project_dir("imp4") / ".tmp-dev-0123abcd").mkdir()
    stop_hub(hub)

    hub = start_hub(data)
    try:
        assert not hub.store.repo_dir("imp4").exists()
        refused = refs_reply(hub, "imp4")
        assert refused.status_code == 503
        assert "c1: its archive cannot be read" in refused.json()["error"]
        assert archive.read_bytes() == b"not a gzip"
        assert hub.get("/project/imp4/latest/meta.json").status_code == 200
    finally:
        stop_hub(hub)


def test_a_stray_staging_directory_does_not_stop_the_import(tmp_path):
    data = tmp_path / "data"
    hub = start_hub(data)
    hub.publish("imp5", "c1", good_build("a"))
    shutil.rmtree(hub.store.repo_dir("imp5"))
    (hub.store.project_dir("imp5") / ".tmp-dev-0123abcd").mkdir()
    stop_hub(hub)

    hub = start_hub(data)
    try:
        assert [value for _sha, value in main_log(hub, "imp5")] == ["imp5/c1"]
    finally:
        stop_hub(hub)
