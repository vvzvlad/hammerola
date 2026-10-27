"""Publishing by `git push`: the pre-receive hook and what it answers.

Driven with the real `git` of the test image against a real hub, so the hook
that runs is `githooks/pre-receive` and the answer is `src/prereceive.py`.
The build is `copying_builder`'s, or a stand-in that fails on demand.
"""

import dataclasses
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

import pytest
from harness import (BROKEN, TOKEN, TOKEN_CONFIG, commit_all, copying_builder,
                     git, picky_builder, project_files, push, start_hub,
                     stop_hub, write_files)

from src import githttp, prereceive
from src.buildproc import STATUS_CPU_EXHAUSTED, STATUS_TIMEOUT

REPO_ROOT = Path(__file__).resolve().parent.parent

@pytest.fixture
def picky_hub(tmp_path):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder())
    yield hub
    stop_hub(hub)


def working_copy(path, pid, directory="", marker="a"):
    """A repository on `main` with the project in `directory`, committed."""
    git("init", "--quiet", "--initial-branch=main", path)
    write_files(path / directory, project_files(pid, marker))
    return commit_all(path, "first")


def jobs_made(hub):
    return len(list((hub.data / "jobs").iterdir()))


def remote_main(hub, work, pid):
    return git("-C", work, "-c", TOKEN_CONFIG, "ls-remote",
               f"{hub.url}/git/{pid}.git", "main").stdout.split()[:1]


def latest_commit(hub, pid):
    return hub.get(f"/project/{pid}/latest/meta.json").json()["commit"]


def test_a_push_publishes_the_commit_and_main_follows(picky_hub, tmp_path):
    work = tmp_path / "work"
    sha = working_copy(work, "push1")

    pushed = push(picky_hub, work, "push1")

    assert pushed.returncode == 0, pushed.stderr
    assert f"remote: building {sha[:12]} for refs/heads/main" in pushed.stderr
    assert "remote: copying builder:" in pushed.stderr
    assert f"remote: published: /project/push1/{sha}/" in pushed.stderr
    assert latest_commit(picky_hub, "push1") == sha
    assert picky_hub.builds("push1").json()["latest"] == sha
    [card] = picky_hub.index().json()
    assert (card["commit"], card["dev"]) == (sha, False)
    log = picky_hub.get(f"/api/v1/logs/push1/{sha}",
                        headers={"X-Hammerola-Token": TOKEN})
    assert log.text.startswith("copying builder:")
    assert picky_hub.get(f"/api/v1/logs/push1/{sha}").status_code == 403
    assert picky_hub.get("/api/v1/logs/push1/" + "0" * 40,
                         headers={"X-Hammerola-Token": TOKEN}
                         ).status_code == 404


def test_a_commit_that_breaks_the_build_is_refused(picky_hub, tmp_path):
    work = tmp_path / "work"
    good = working_copy(work, "fail1")
    assert push(picky_hub, work, "fail1").returncode == 0
    (work / BROKEN).write_text("x")
    commit_all(work, "break it")

    pushed = push(picky_hub, work, "fail1")

    assert pushed.returncode != 0
    assert "remote: build failed: no printables" in pushed.stderr
    assert "remote: the model or a gate refused the build" in pushed.stderr
    assert remote_main(picky_hub, work, "fail1") == [good]
    assert latest_commit(picky_hub, "fail1") == good


def test_only_the_newest_commit_touching_the_project_is_built(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    working_copy(work, "dir1", directory="hub")
    assert push(picky_hub, work, "dir1").returncode == 0
    write_files(work / "hub", {"notes.md": b"one"})
    commit_all(work, "first change")
    write_files(work / "hub", {"notes.md": b"two"})
    second = commit_all(work, "second change")
    write_files(work / "other", {"x.txt": b"x"})
    commit_all(work, "the other project")
    before = jobs_made(picky_hub)

    assert push(picky_hub, work, "dir1").returncode == 0

    assert jobs_made(picky_hub) == before + 1
    assert latest_commit(picky_hub, "dir1") == second

    write_files(work / "other", {"x.txt": b"y"})
    commit_all(work, "only the neighbour")
    pushed = push(picky_hub, work, "dir1")
    assert pushed.returncode == 0, pushed.stderr
    assert jobs_made(picky_hub) == before + 1
    assert [b["commit"] for b in picky_hub.builds("dir1").json()["builds"]
            ].count(second) == 1


def test_a_project_at_the_root_and_one_in_a_directory_both_publish(
        picky_hub, tmp_path):
    for pid, directory in (("root1", ""), ("sub1", "hub")):
        work = tmp_path / pid
        sha = working_copy(work, pid, directory=directory)
        assert push(picky_hub, work, pid).returncode == 0
        assert latest_commit(picky_hub, pid) == sha


def test_a_forced_push_is_refused_before_anything_is_built(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    working_copy(work, "ff1")
    assert push(picky_hub, work, "ff1").returncode == 0
    write_files(work, {"notes.md": b"rewritten"})
    git("-C", work, "add", "-A")
    git("-C", work, "commit", "--quiet", "--amend", "-m", "rewritten")
    before = jobs_made(picky_hub)

    pushed = push(picky_hub, work, "ff1", extra=("--force",))

    assert pushed.returncode != 0
    assert "remote: non-fast-forward: pull first" in pushed.stderr
    assert jobs_made(picky_hub) == before


def test_a_symlink_is_refused_with_its_path_and_a_gitignore_is_not(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    working_copy(work, "link1", directory="hub")
    (work / "hub" / ".gitignore").write_text("/*.stl.bak\n")
    commit_all(work, "ignore some")
    assert push(picky_hub, work, "link1").returncode == 0

    os.symlink("meta.json", work / "hub" / "alias.json")
    commit_all(work, "a link")
    pushed = push(picky_hub, work, "link1")

    assert pushed.returncode != 0
    assert "hub/alias.json" in pushed.stderr
    assert "symlink" in pushed.stderr


def test_a_deleted_ref_is_refused(picky_hub, tmp_path):
    work = tmp_path / "work"
    sha = working_copy(work, "del1")
    assert push(picky_hub, work, "del1", "main",
                f"{sha}:refs/drafts/main").returncode == 0

    pushed = push(picky_hub, work, "del1", ":refs/drafts/main")

    assert pushed.returncode != 0
    assert "refs/drafts/main cannot be deleted" in pushed.stderr


def test_a_draft_goes_to_the_slot_and_an_unchanged_one_builds_nothing(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    sha = working_copy(work, "draft1")
    assert push(picky_hub, work, "draft1").returncode == 0
    write_files(work, project_files("draft1", marker="b"))
    draft = commit_all(work, "hammerola draft")
    refspec = f"{draft}:refs/drafts/main"

    pushed = push(picky_hub, work, "draft1", refspec, extra=("--force",))

    assert pushed.returncode == 0, pushed.stderr
    assert "remote: published: /project/draft1/dev/" in pushed.stderr
    assert latest_commit(picky_hub, "draft1") == sha
    assert b'"b"' in picky_hub.get("/project/draft1/dev/assembled.json").content
    [card] = picky_hub.index().json()
    assert card["dev"] is True
    before = jobs_made(picky_hub)

    same_tree = commit_all(work, "hammerola draft, again")
    again = push(picky_hub, work, "draft1", f"{same_tree}:refs/drafts/main",
                 extra=("--force",))
    assert "remote: unchanged: /project/draft1/dev/" in again.stderr
    assert jobs_made(picky_hub) == before


def test_a_failing_draft_refuses_the_push_but_main_is_published(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    first = working_copy(work, "pair1")
    assert push(picky_hub, work, "pair1").returncode == 0
    write_files(work, {"notes.md": b"next"})
    main = commit_all(work, "next")
    (work / BROKEN).write_text("x")
    draft = commit_all(work, "broken draft")

    pushed = push(picky_hub, work, "pair1", f"{main}:refs/heads/main",
                  f"{draft}:refs/drafts/main")

    assert pushed.returncode != 0
    assert picky_hub.store.build_dir("pair1", main).is_dir()
    # The card is the build `latest` is, not the newest one on disk.
    [card] = picky_hub.index().json()
    assert card["commit"] == first
    before = jobs_made(picky_hub)
    again = push(picky_hub, work, "pair1", f"{main}:refs/heads/main")
    assert again.returncode == 0, again.stderr
    assert jobs_made(picky_hub) == before
    assert latest_commit(picky_hub, "pair1") == main


def test_a_build_of_a_push_git_never_finished_becomes_latest_on_the_next_push(
        picky_hub, tmp_path):
    """The first push of a project publishes `main`'s commit, and a failing
    draft in the same push keeps git from ever writing the branch."""
    work = tmp_path / "work"
    sha = working_copy(work, "lost1")
    (work / BROKEN).write_text("x")
    draft = commit_all(work, "broken draft")
    refused = push(picky_hub, work, "lost1", f"{sha}:refs/heads/main",
                   f"{draft}:refs/drafts/main")
    assert refused.returncode != 0
    assert picky_hub.store.build_dir("lost1", sha).is_dir()
    assert git("-C", picky_hub.store.repo_dir("lost1"), "rev-parse", "--verify",
               "--quiet", "main", check=False).returncode != 0

    pushed = push(picky_hub, work, "lost1", f"{sha}:refs/heads/main")

    assert pushed.returncode == 0, pushed.stderr
    assert latest_commit(picky_hub, "lost1") == sha


def test_a_build_says_how_long_it_took_between_its_log_and_its_verdict(
        picky_hub, tmp_path):
    work = tmp_path / "work"
    working_copy(work, "time1")
    published = push(picky_hub, work, "time1").stderr
    (work / BROKEN).write_text("x")
    commit_all(work, "break it")
    refused = push(picky_hub, work, "time1").stderr

    assert (published.index("remote: copying builder:")
            < published.index("remote: built in 0s")
            < published.index("remote: published:"))
    assert (refused.index("remote: build failed: no printables")
            < refused.index("remote: built in 0s")
            < refused.index("remote: the model or a gate refused the build"))
    assert "warning:" not in published + refused


def test_a_slow_build_is_warned_about_and_still_publishes(tmp_path):
    def slow(project_dir, out_dir, *, pid, **kw):
        return dataclasses.replace(
            copying_builder(project_dir, out_dir, pid=pid, **kw),
            duration_seconds=200)

    hub = start_hub(tmp_path / "data", build_runner=slow)
    try:
        work = tmp_path / "work"
        sha = working_copy(work, "slow1")

        pushed = push(hub, work, "slow1")

        assert pushed.returncode == 0, pushed.stderr
        assert "remote: built in 3m20s" in pushed.stderr
        assert ("remote: warning: 3m20s is over the 3m00s a build should "
                "need. It published —" in pushed.stderr)
        assert "references/checks.md, has all three." in pushed.stderr
        assert latest_commit(hub, "slow1") == sha
    finally:
        stop_hub(hub)


def test_two_racing_pushes_and_the_loser_pulls_and_pushes_again(tmp_path):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(delay=1.5))
    try:
        first = tmp_path / "first"
        working_copy(first, "race1")
        assert push(hub, first, "race1").returncode == 0
        second = tmp_path / "second"
        git("clone", "--quiet", first, second)
        write_files(first, {"a.md": b"a"})
        winner_or_loser = {commit_all(first, "a"): first}
        write_files(second, {"b.md": b"b"})
        winner_or_loser[commit_all(second, "b")] = second
        results = {}
        threads = [threading.Thread(
            target=lambda work=work: results.update(
                {work: push(hub, work, "race1")}))
            for work in (first, second)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        codes = sorted(result.returncode for result in results.values())
        assert codes[0] == 0 and codes[1] != 0, results
        loser = next(work for work, result in results.items()
                     if result.returncode != 0)
        assert "[remote rejected]" in results[loser].stderr
        lost = git("-C", loser, "rev-parse", "HEAD").stdout.strip()
        built = hub.store.build_dir("race1", lost)
        assert built.is_dir()
        inode = built.stat().st_ino

        git("-C", loser, "-c", TOKEN_CONFIG, "pull", "--quiet", "--no-rebase",
            "--no-edit", f"{hub.url}/git/race1.git", "main")
        merge = git("-C", loser, "rev-parse", "HEAD").stdout.strip()
        again = push(hub, loser, "race1")

        assert again.returncode == 0, again.stderr
        assert f"remote: building {merge[:12]}" in again.stderr
        assert again.stderr.count("remote: building") == 1
        assert built.stat().st_ino == inode
        assert git("-C", loser, "merge-base", "--is-ancestor", lost,
                   merge).returncode == 0
        assert latest_commit(hub, "race1") == merge
    finally:
        stop_hub(hub)


def test_an_interrupted_push_still_publishes(tmp_path):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(delay=2))
    try:
        work = tmp_path / "work"
        sha = working_copy(work, "int1")
        process = subprocess.Popen(
            ["git", "-C", str(work), "-c", TOKEN_CONFIG, "push",
             f"{hub.url}/git/int1.git", "main"],
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        deadline = time.monotonic() + 30
        while jobs_made(hub) == 0:
            assert time.monotonic() < deadline
            time.sleep(0.05)
        # As a terminal's Ctrl-C does: to the whole process group.
        os.killpg(process.pid, signal.SIGINT)
        process.wait(timeout=30)

        while not hub.store.build_dir("int1", sha).is_dir():
            assert time.monotonic() < deadline, "the revision never appeared"
            time.sleep(0.05)
    finally:
        stop_hub(hub)


def test_the_hook_route_wants_the_secret_and_a_missing_hub_refuses(
        hub, tmp_path):
    reply = hub.request("POST", githttp.HOOK_PATH, content=b"{}",
                        headers={"X-Hammerola-Token": TOKEN})
    assert reply.status_code == 403

    hook = Path(githttp.HOOKS_DIR) / "pre-receive"
    refused = subprocess.run(
        [str(hook)], input="0 1 refs/heads/main\n", capture_output=True,
        text=True, cwd=tmp_path, timeout=30,
        env={"PATH": os.environ["PATH"],
             "HAMMEROLA_HOOK_URL": "http://127.0.0.1:9/internal/pre-receive",
             "HAMMEROLA_HOOK_SECRET": "x"})
    assert refused.returncode == 1
    assert refused.stderr.strip() == "hook could not reach the hub"


def test_the_archive_routes_are_gone(hub):
    headers = {"X-Hammerola-Token": TOKEN}
    assert hub.request("POST", "/api/v1/publish/gone1", content=b"x",
                       headers=headers).status_code == 404
    assert hub.get("/api/v1/sources/" + "a" * 64,
                   headers=headers).status_code == 404


def said_about(record):
    lines = []
    prereceive._say_duration(record, lines.append)
    return lines


@pytest.mark.parametrize("status", [STATUS_TIMEOUT, STATUS_CPU_EXHAUSTED])
def test_a_build_killed_by_a_ceiling_is_not_asked_to_optimise(status):
    assert said_about({"duration_seconds": 900.0, "status": status}) == [
        "built in 15m00s"]


def test_a_build_at_the_threshold_is_not_warned_about():
    record = {"duration_seconds": float(prereceive.SLOW_BUILD_SECONDS),
              "status": "ok"}
    assert said_about(record) == [
        f"built in {prereceive._clock(prereceive.SLOW_BUILD_SECONDS)}"]


def test_the_queue_wait_goes_in_a_bracket():
    record = {"duration_seconds": 72.0, "status": "ok",
              "created": "2026-10-27T10:00:00Z",
              "started": "2026-10-27T10:00:08Z"}
    assert said_about(record) == ["built in 1m12s (queued 8s)"]


def test_the_warning_points_at_a_file_and_a_heading_that_exist():
    checks = (REPO_ROOT / "skill" / "references" / "checks.md").read_text(
        encoding="utf-8")
    assert "references/checks.md" in prereceive.SLOW_BUILD_WARNING
    assert '"Keeping checks fast enough to run"' in prereceive.SLOW_BUILD_WARNING
    assert "\n## Keeping checks fast enough to run\n" in checks
