"""Files changed on the page: `POST /api/v1/source/<pid>/blob` and `/commit`.

The window sends the bytes of a file to `blob`, then one `commit` naming blobs,
deletions and moves; the hub makes one commit on the tip of the variant's
branch, builds it in the background and moves the branch only once it has
published (`prereceive.commit_changes`, `BuildTask.after_publish`). Driven
against a real hub and the real `git`; the build is `picky_builder`'s, which
publishes the tree as it is, so a test reads back the commit the hub made.
"""

import hashlib
import json
import os
import time

import httpx
import pytest
from harness import (TOKEN, commit_all, failing_builder, git, picky_builder,
                     project_files, push, recording_publisher, start_hub,
                     stop_hub, write_files)

from src.prereceive import HUB_IDENTITY
from src.store import REPOS_DIR_NAME

PID = "page0001"
PUBLISHED = b"def published(hub):\n    pass\n"


@pytest.fixture
def script():
    """Steps run in place of the start of the next builds, one per build: a
    step answers an outcome, or None to let the build go on."""
    return []


@pytest.fixture
def publisher(tmp_path):
    return recording_publisher(repos=tmp_path / "data" / REPOS_DIR_NAME)


@pytest.fixture
def hub(tmp_path, script, publisher):
    build = picky_builder()

    def run(project_dir, out_dir, *, pid, **kw):
        outcome = script.pop(0)(project_dir, out_dir, pid=pid) if script else None
        return outcome or build(project_dir, out_dir, pid=pid, **kw)
    hub = start_hub(tmp_path / "data", build_runner=run,
                    published_runner=publisher)
    yield hub
    stop_hub(hub)


def seed(hub, work, files=None, directory=""):
    """`main` pushed with the project in `directory`. -> the commit, which is
    also the name of its build."""
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work / directory, {**project_files(PID), **(files or {})})
    sha = commit_all(work, "first")
    pushed = push(hub, work, PID)
    assert pushed.returncode == 0, pushed.stderr
    return sha


def hub_git(hub, *args):
    return git("--git-dir", hub.store.repo_dir(PID), *args).stdout


def tip(hub, branch="main"):
    return hub_git(hub, "rev-parse", f"refs/heads/{branch}").strip()


def files_of(hub, ref="main", directory=""):
    listing = hub_git(hub, "ls-tree", "-r", "-z", "--name-only",
                      f"{ref}:{directory}")
    return sorted(listing.split("\0")[:-1])


def jobs_made(hub):
    return len(list((hub.data / "jobs").iterdir()))


def post(hub, path, token=TOKEN, **kw):
    headers = {} if token is None else {"X-Hammerola-Token": token}
    return httpx.post(f"{hub.url}{path}", headers=headers, timeout=30,
                      trust_env=False, **kw)


def upload(hub, data):
    reply = post(hub, f"/api/v1/source/{PID}/blob", content=data)
    assert reply.status_code == 200, reply.text
    return reply.json()["blob"]


def blob_of(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def commit(hub, base, *changes, message="Edit files", variant="main",
           token=TOKEN, **extra):
    return post(hub, f"/api/v1/source/{PID}/commit", token=token, json={
        "variant": variant, "base": base, "message": message,
        "changes": list(changes), **extra})


def settle(hub, reply):
    """The record of the job a 202 named, once it has ended."""
    assert reply.status_code == 202, reply.text
    return hub.await_job(reply.json()["job"]).record


def put(hub, path, data, **extra):
    """A change writing `data` at `path`, the bytes uploaded."""
    return {"path": path, "blob": upload(hub, data), **extra}


def test_nothing_is_read_without_the_token(hub, tmp_path):
    base = seed(hub, tmp_path / "work")

    assert post(hub, f"/api/v1/source/{PID}/blob", token=None,
                content=b"x").status_code == 403
    assert commit(hub, base, {"path": "a", "blob": None},
                  token=None).status_code == 403
    assert post(hub, "/api/v1/source/nope0001/blob",
                content=b"x").status_code == 404


def test_a_blob_is_stored_as_it_came_whatever_git_would_have_made_of_it(
        hub, tmp_path):
    seed(hub, tmp_path / "work")
    data = b"\x00\xff\r\nline\r\n$Id$\n" * 1000

    sha = upload(hub, data)

    assert sha == blob_of(data)
    assert hub.store.source_blob(PID, sha) == data
    assert [name for name in os.listdir(hub.store.root)
            if name.startswith(".wip-blob-")] == []


def test_a_commit_is_built_first_and_the_branch_moves_when_it_has_published(
        hub, tmp_path):
    base = seed(hub, tmp_path / "work")
    image = b"\x89PNG\r\n"

    reply = commit(hub, base, put(hub, "img/x.png", image),
                   message="Add a picture\n\nand a body")

    assert reply.status_code == 202
    answer = reply.json()
    assert answer["status_url"] == f"/api/v1/jobs/{answer['job']}"
    record = settle(hub, reply)
    assert (record["state"], record["code"]) == ("done", 201)
    new = answer["commit"]
    assert tip(hub) == new
    assert "img/x.png" in files_of(hub)
    assert hub_git(hub, "ls-tree", new, "img/x.png").split()[2] == blob_of(image)
    identity = (f"{HUB_IDENTITY['GIT_AUTHOR_NAME']} <{HUB_IDENTITY['GIT_AUTHOR_EMAIL']}>|"
                f"{HUB_IDENTITY['GIT_COMMITTER_NAME']} <{HUB_IDENTITY['GIT_COMMITTER_EMAIL']}>")
    assert hub_git(hub, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s|%P",
                   new).strip() == f"{identity}|Add a picture|{base}"
    assert hub_git(hub, "log", "-1", "--format=%B", new).strip() == \
        "Add a picture\n\nand a body"
    # Its own revision, which `latest` follows.
    assert record["build_url"] == f"/project/{PID}/{new}/"
    assert hub.get(f"/project/{PID}/latest/meta.json").json()["commit"] == new


def test_a_delete_and_a_move_in_one_commit_keep_the_moved_file_s_mode(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work, {**project_files(PID), "old.txt": b"old\n",
                       "tool.sh": b"#!/bin/sh\n"})
    os.chmod(work / "tool.sh", 0o755)
    base = commit_all(work, "first")
    assert push(hub, work, PID).returncode == 0

    reply = commit(hub, base, {"path": "old.txt", "blob": None},
                   {"path": "bin/tool.sh", "from": "tool.sh"})

    assert settle(hub, reply)["state"] == "done"
    assert files_of(hub) == sorted(
        [*project_files(PID), "bin/tool.sh"])
    assert hub_git(hub, "ls-tree", "main", "bin/tool.sh").split()[:3] == [
        "100755", "blob", blob_of(b"#!/bin/sh\n")]


def test_a_move_with_bytes_and_a_file_whose_name_has_quotes_and_a_space(
        hub, tmp_path):
    base = seed(hub, tmp_path / "work", {"a.txt": b"a\n"})
    quoted = '"q" name.txt'

    reply = commit(hub, base, put(hub, "b.txt", b"b\n", **{"from": "a.txt"}),
                   put(hub, quoted, b"q\n"))

    assert settle(hub, reply)["state"] == "done"
    assert "a.txt" not in files_of(hub)
    assert {"b.txt", quoted} <= set(files_of(hub))
    assert hub_git(hub, "ls-tree", "main", "b.txt").split()[2] == blob_of(b"b\n")


def agent_edits(hub, work, name, data=b"agent\n", delete=False):
    """The author's push of one file changed, or deleted."""
    if delete:
        git("-C", work, "rm", "-q", name)
    else:
        write_files(work, {name: data})
    commit_all(work, f"agent: {name}")
    assert push(hub, work, PID).returncode == 0


def test_a_file_the_agent_changed_conflicts_unless_the_change_says_over(
        hub, tmp_path):
    work = tmp_path / "work"
    base = seed(hub, work, {"README.md": b"r\n", "other.md": b"o\n"})
    agent_edits(hub, work, "README.md")
    agents = tip(hub)

    refused = commit(hub, base, put(hub, "README.md", b"mine\n"))

    assert refused.status_code == 409
    assert refused.json() == {
        "error": "changed on the hub since the editor opened: README.md",
        "conflicts": ["README.md"]}
    assert tip(hub) == agents

    # Another file of the same page edit goes in beside the agent's.
    reply = commit(hub, base, put(hub, "other.md", b"mine\n"))
    assert settle(hub, reply)["state"] == "done"
    assert hub_git(hub, "show", "main:README.md") == "agent\n"
    assert hub_git(hub, "show", "main:other.md") == "mine\n"

    reply = commit(hub, base, put(hub, "README.md", b"mine\n", over=True))
    assert settle(hub, reply)["state"] == "done"
    assert hub_git(hub, "show", "main:README.md") == "mine\n"


def test_a_move_of_a_file_the_agent_deleted_conflicts_and_does_not_revive_it(
        hub, tmp_path):
    work = tmp_path / "work"
    base = seed(hub, work, {"a.txt": b"a\n"})
    agent_edits(hub, work, "a.txt", delete=True)

    refused = commit(hub, base, {"path": "b.txt", "from": "a.txt"})

    assert refused.status_code == 409
    assert refused.json()["conflicts"] == ["b.txt", "a.txt"]
    assert "b.txt" not in files_of(hub)


def test_a_repeat_of_a_commit_that_went_through_makes_no_second_one(
        hub, tmp_path):
    base = seed(hub, tmp_path / "work", {"a.txt": b"a\n", "d.txt": b"d\n"})
    changes = [put(hub, "new.txt", b"n\n"), {"path": "d.txt", "blob": None},
               {"path": "b.txt", "from": "a.txt"}]
    assert settle(hub, commit(hub, base, *changes))["state"] == "done"
    done, made = tip(hub), jobs_made(hub)

    again = commit(hub, base, *changes)

    assert (again.status_code, again.json()) == (
        200, {"commit": done, "already": True})
    assert tip(hub) == done and jobs_made(hub) == made


@pytest.mark.parametrize("changes,status,said", [
    ([{"path": "project.json", "blob": None}], 422,
     f"project.json with id {PID} must stay in the repository root"),
    ([{"path": "p.json", "from": "project.json"}], 422,
     f"project.json with id {PID} must stay in"),
    ([{"path": "project.json", "blob": "<broken>"}], 422,
     "project.json is not valid JSON: "),
    ([{"path": "copy/project.json", "blob": "<twin>"}], 422,
     f"more than one project.json with id {PID}"),
    ([{"path": "docs/a.md", "blob": "<any>"}], 422,
     "a file exists where you’re trying to create a subdirectory: docs"),
    ([{"path": "dir", "blob": "<any>"}], 422,
     "a directory exists where you’re trying to create a file: dir"),
    ([{"path": "b.txt", "from": "a.txt"}], 422, "b.txt already exists"),
    ([{"path": "x", "from": "ghost.txt"}], 422, "ghost.txt is not in build "),
    ([{"path": "x", "blob": "ab" * 20}], 422,
     f"blob {'ab' * 20} was not uploaded"),
    ([{"path": "x", "blob": "<any>"}, {"path": "x", "blob": None}], 422,
     "x is both removed and written"),
    ([{"path": "x", "blob": "<any>"}, {"path": "x", "blob": "<any>"}], 422,
     "x is written twice"),
    ([{"path": "a.txt", "blob": None}, {"path": "q", "from": "a.txt"}], 422,
     "a.txt is removed twice"),
    ([{"path": ".git/config", "blob": "<any>"}], 422, "not a path"),
    ([{"path": ".GIT/x", "blob": "<any>"}], 422, "not a path"),
    ([{"path": "a//b", "blob": "<any>"}], 422, "not a path"),
    ([{"path": "../x", "blob": "<any>"}], 422, "not a path"),
    ([{"path": "/x", "blob": "<any>"}], 422, "not a path"),
    ([{"path": "x/", "blob": "<any>"}], 422, "not a path"),
    ([{"path": "x"}], 422, "`blob` is missing"),
    ([{"path": "x", "from": "a.txt", "blob": None}], 422, "a move takes"),
    ([{"path": "x", "blob": "<any>", "over": False}], 422,
     "`over` must be true or absent"),
    ([], 422, "`changes` must be a non-empty list"),
])
def test_a_set_that_cannot_be_committed_is_refused_and_nothing_moves(
        hub, tmp_path, changes, status, said):
    base = seed(hub, tmp_path / "work", {
        "a.txt": b"a\n", "b.txt": b"b\n", "docs": b"a file\n",
        "dir/inner.txt": b"i\n"})
    named = {"<any>": upload(hub, b"any\n"), "<broken>": upload(hub, b"{no"),
             "<twin>": upload(hub, json.dumps({"id": PID}).encode())}
    changes = [{**change, "blob": named.get(change.get("blob"), change.get("blob"))}
               if "blob" in change else change for change in changes]
    before, made = tip(hub), jobs_made(hub)

    reply = commit(hub, base, *changes)

    assert reply.status_code == status, reply.text
    assert reply.json()["error"].startswith(said), reply.text
    assert tip(hub) == before and jobs_made(hub) == made


def test_the_request_itself_is_checked_before_the_changes(hub, tmp_path):
    base = seed(hub, tmp_path / "work")
    change = {"path": "x", "blob": upload(hub, b"x")}

    for body, status, said in [
            ({"message": " "}, 422, "the commit needs a message"),
            ({"variant": "nope"}, 404, "not found"),
            ({"variant": 7}, 404, "not found"),
            ({"base": "nobuild"}, 422, "no files of build nobuild"),
            ({"base": "latest"}, 422, "no files of build latest"),
            ({"base": None}, 422, "no files of build None")]:
        reply = post(hub, f"/api/v1/source/{PID}/commit", json={
            "variant": "main", "base": base, "message": "m",
            "changes": [change], **body})
        assert (reply.status_code, reply.json()["error"]) == (status, said), body
    for raw in (b"[]", b"nope"):
        assert post(hub, f"/api/v1/source/{PID}/commit",
                    content=raw).status_code == 422
    assert post(hub, "/api/v1/source/nope0001/commit",
                json={}).status_code == 404
    assert commit(hub, base, change, variant="elsewhere").status_code == 404


def test_a_model_that_does_not_build_fails_the_job_and_leaves_the_branch(
        hub, tmp_path, script):
    base = seed(hub, tmp_path / "work")
    script.append(failing_builder(log="SyntaxError in model.py\n"))
    before = tip(hub)

    reply = commit(hub, base, put(hub, "model.py", b"def ("))
    record = settle(hub, reply)

    assert record["state"] == "failed" and record["error"]
    assert "SyntaxError in model.py" in hub.job_log(record["id"]).text
    assert tip(hub) == before
    assert hub.get(f"/project/{PID}/latest/meta.json").json()["commit"] == base


def test_a_branch_pushed_meanwhile_wins_and_the_page_commit_stays_a_revision(
        hub, tmp_path, script):
    work = tmp_path / "work"
    base = seed(hub, work, {"README.md": b"r\n"})

    def push_meanwhile(project_dir, out_dir, *, pid):
        agent_edits(hub, work, "README.md")
    script.append(push_meanwhile)

    reply = commit(hub, base, put(hub, "notes.md", b"n\n"))
    record = settle(hub, reply)

    assert (record["state"], record["code"]) == ("failed", 409)
    assert record["error"] == ("the branch moved while this commit was "
                               "building; commit again")
    agents = git("-C", work, "rev-parse", "HEAD").stdout.strip()
    assert tip(hub) == agents
    assert reply.json()["commit"] in json.dumps(hub.builds(PID).json())


def test_the_paths_are_under_the_project_directory_and_the_neighbour_is_left(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work, {"other/project.json": b'{"id": "other0001"}',
                       "other/n.txt": b"n\n"})
    write_files(work / "hub", {**project_files(PID), "x.txt": b"x\n"})
    base = commit_all(work, "first")
    assert push(hub, work, PID).returncode == 0
    neighbour = hub_git(hub, "rev-parse", "main:other").strip()

    reply = commit(hub, base, put(hub, "notes.md", b"n\n"),
                   {"path": "moved.txt", "from": "x.txt"})

    assert settle(hub, reply)["state"] == "done"
    assert {"notes.md", "moved.txt"} <= set(files_of(hub, directory="hub"))
    assert "x.txt" not in files_of(hub, directory="hub")
    assert hub_git(hub, "rev-parse", "main:other").strip() == neighbour
    assert hub_git(hub, "ls-tree", "-r", "--name-only", "main").count(
        "notes.md") == 1


def test_a_moved_file_s_old_path_keeps_the_new_file_written_there(
        hub, tmp_path):
    # The new x.txt holds the bytes the tip already has there, so on its own it
    # would count as done; the move still takes the old x.txt away.
    base = seed(hub, tmp_path / "work", {"x.txt": b"x\n"})

    reply = commit(hub, base, {"path": "x.old", "from": "x.txt"},
                   put(hub, "x.txt", b"x\n"))

    assert settle(hub, reply)["state"] == "done"
    assert {"x.txt", "x.old"} <= set(files_of(hub))


def test_the_new_revision_gets_its_published_call_without_anyone_waiting(
        publisher, tmp_path):
    # One worker: a commit job that waited for its published() job, queued
    # behind it on the same worker, would never end.
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(),
                    published_runner=publisher, build_workers=1)
    try:
        base = seed(hub, tmp_path / "work", {"model.py": PUBLISHED})
        publisher.calls.clear()

        reply = commit(hub, base, put(hub, "notes.md", b"n\n"))
        record = settle(hub, reply)
        assert record["state"] == "done"

        deadline = time.monotonic() + 10
        while not publisher.calls and time.monotonic() < deadline:
            time.sleep(0.01)
        [call] = publisher.calls
        assert call["environment"] == {
            "HAMMEROLA_PROJECT": PID, "HAMMEROLA_VARIANT": "main",
            "HAMMEROLA_REVISION": reply.json()["commit"]}
        assert call["model"] == PUBLISHED.decode()
    finally:
        stop_hub(hub)
