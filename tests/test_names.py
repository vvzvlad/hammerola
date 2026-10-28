"""A name changed on the page, and `views` in project.json.

`POST /api/v1/projects/<pid>/names` commits the new name into project.json on
the variant's branch, publishes that commit as a copy of a build of the tip's
project with the name rewritten — the tip's own build, or the variant's
`latest` built from the same project tree; it is built only where neither
holds that tree — and moves the branch only once it has published
(`prereceive.commit_name`).
Driven against a real hub and the real `git`; the build is `picky_builder`'s,
which publishes the tree as it is, so what a test reads back is the committed
file and the meta.json the hub made of it.
"""

import json

import httpx
import pytest
from harness import (TOKEN, commit_all, failing_builder, git,
                     picky_builder, project_files, push, start_hub, stop_hub,
                     write_files)

from src.prereceive import HUB_IDENTITY

PID = "name0001"
NAME = "Bracket mk2"


@pytest.fixture
def script():
    """Steps run in place of the start of the next builds, one per build: a
    step answers an outcome, or None to let the build go on."""
    return []


@pytest.fixture
def hub(tmp_path, script):
    build = picky_builder()

    def run(project_dir, out_dir, *, pid, **kw):
        outcome = script.pop(0)(project_dir, out_dir, pid=pid) if script else None
        return outcome or build(project_dir, out_dir, pid=pid, **kw)
    hub = start_hub(tmp_path / "data", build_runner=run)
    yield hub
    stop_hub(hub)


def published(hub, work, files=None, directory="", **project):
    """`main` pushed, the project in `directory`, its project.json the id, a
    title and `project`."""
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work / directory, {
        **project_files(PID), **(files or {}),
        "project.json": json.dumps({"id": PID, "title": "Demo project",
                                    **project}).encode()})
    commit_all(work, "first")
    pushed = push(hub, work, PID)
    assert pushed.returncode == 0, pushed.stderr


def hub_git(hub, *args):
    return git("--git-dir", hub.store.repo_dir(PID), *args).stdout


def tip(hub, branch="main"):
    return hub_git(hub, "rev-parse", f"refs/heads/{branch}").strip()


def jobs_made(hub):
    return len(list((hub.data / "jobs").iterdir()))


def rename(hub, pid=PID, token=TOKEN, **body):
    headers = {} if token is None else {"X-Hammerola-Token": token}
    return httpx.post(f"{hub.url}/api/v1/projects/{pid}/names", json=body,
                      headers=headers, timeout=30, trust_env=False)


def test_a_rename_wants_the_token_a_name_and_something_to_name(hub, tmp_path):
    published(hub, tmp_path / "work")
    before = tip(hub)

    assert rename(hub, token=None, variant="main", kind="project",
                  name=NAME).status_code == 403
    for body, said in [
            ({"kind": "colour"}, "`kind` must be one of project, variant, view, document"),
            ({"kind": "view"}, "`id` must name the view"),
            ({"kind": "project", "name": " "}, "`name` must be a non-empty string"),
            ({"kind": "project", "name": "a‮b"}, "`name` contains a non-printable")]:
        reply = rename(hub, **{"variant": "main", "name": NAME, **body})
        assert (reply.status_code, reply.json()["error"].startswith(said)) == \
            (422, True), reply.text
    for pid, body in [("nope0001", {"variant": "main", "kind": "project"}),
                      (PID, {"variant": "ceiling", "kind": "variant"}),
                      (PID, {"variant": "main", "kind": "view", "id": "print"}),
                      (PID, {"variant": "main", "kind": "document", "id": "a.md"})]:
        assert rename(hub, pid=pid, name=NAME, **body).status_code == 404, body
    assert tip(hub) == before


@pytest.mark.parametrize("kind,item,project,files,changed,subject,shown", [
    ("project", None, {}, {}, {"title": NAME},
     f'Rename the project to "{NAME}"', ("title",)),
    ("variant", None, {}, {}, {"variant": NAME},
     f'Rename the variant to "{NAME}"', ("variant_label",)),
    ("view", "assembled", {"views": {"print": "Flat"}}, {},
     {"views": {"print": "Flat", "assembled": NAME}},
     f'Rename the view "assembled" to "{NAME}"', ("views", 0, "name")),
    ("document", "notes__cut.md",
     {"documents": ["notes/cut.md", {"file": "b.md", "title": "B"}]},
     {"notes/cut.md": b"# cut\n", "b.md": b"# b\n"},
     {"documents": [{"file": "notes/cut.md", "title": NAME},
                    {"file": "b.md", "title": "B"}]},
     f'Rename the document "notes/cut.md" to "{NAME}"', ("documents", 0, "name")),
])
def test_a_rename_commits_one_key_and_publishes_the_tip_s_build_renamed(
        hub, tmp_path, kind, item, project, files, changed, subject, shown):
    published(hub, tmp_path / "work", files, **project)
    before = tip(hub)
    made = jobs_made(hub)

    # The project's name goes on `main` whatever variant the page shows.
    reply = rename(hub, variant="elsewhere" if kind == "project" else "main",
                   kind=kind, id=item, name=NAME)

    assert reply.status_code == 200, reply.text
    commit = reply.json()["commit"]
    assert reply.json()["build_url"] == f"/project/{PID}/{commit}/"
    assert tip(hub) == commit
    # The rest of the file as it was, in its order, written as the client
    # writes it.
    assert hub_git(hub, "show", f"{commit}:project.json") == json.dumps(
        {"id": PID, "title": "Demo project", **project, **changed},
        indent=1, ensure_ascii=False) + "\n"
    assert hub_git(hub, "diff", "--name-only", before, commit) == "project.json\n"
    identity = (f"{HUB_IDENTITY['GIT_AUTHOR_NAME']} <{HUB_IDENTITY['GIT_AUTHOR_EMAIL']}>|"
                f"{HUB_IDENTITY['GIT_COMMITTER_NAME']} <{HUB_IDENTITY['GIT_COMMITTER_EMAIL']}>")
    assert hub_git(hub, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s|%P",
                   commit).strip() == f"{identity}|{subject}|{before}"
    # Not built: the tip's files, under a meta.json of the commit's own.
    assert jobs_made(hub) == made
    built, copied = (hub.store.build_dir(PID, name) for name in (before, commit))
    shipped = json.loads((built / ".files.sha256").read_text())
    assert shipped and all((copied / name).read_bytes() == (built / name).read_bytes()
                           for name in shipped)
    # The copy shares the source's files; the source's own meta.json stays its own.
    assert hub.get(f"/project/{PID}/{before}/meta.json").json()["commit"] == before
    meta = hub.get(f"/project/{PID}/latest/meta.json").json()
    assert (meta["commit"], meta["message"]) == (commit, subject)
    for key in shown:
        meta = meta[key]
    assert meta == NAME


def hub_commit(hub, tmp_path, parent, path, data):
    """A commit of `parent` with `data` at `path`, written straight into the
    hub's repository: no hook ran, so no build holds it. -> its sha."""
    repo = hub.store.repo_dir(PID)
    index = {"GIT_INDEX_FILE": str(tmp_path / f"index-{parent}")}
    (tmp_path / "blob").write_bytes(data)
    blob = hub_git(hub, "hash-object", "-w", tmp_path / "blob").strip()
    git("--git-dir", repo, "read-tree", parent, env=index)
    git("--git-dir", repo, "update-index", "--add", "--cacheinfo",
        f"100644,{blob},{path}", env=index)
    tree = git("--git-dir", repo, "write-tree", env=index).stdout.strip()
    return hub_git(hub, "commit-tree", tree, "-p", parent, "-m", path).strip()


def test_a_tip_that_did_not_touch_the_project_is_published_from_latest(
        hub, tmp_path):
    """A commit outside the project's directory has no build of its own, and
    `latest` holds its project's very tree: that build is copied."""
    work = tmp_path / "work"
    published(hub, work, directory="proj")
    first = tip(hub)
    write_files(work, {"README.md": b"readme\n"})
    commit_all(work, "readme")
    assert push(hub, work, PID).returncode == 0
    made = jobs_made(hub)

    reply = rename(hub, variant="main", kind="project", name=NAME)

    assert reply.status_code == 200, reply.text
    commit = reply.json()["commit"]
    assert jobs_made(hub) == made
    assert tip(hub) == commit
    meta = hub.get(f"/project/{PID}/latest/meta.json").json()
    assert (meta["commit"], meta["title"]) == (commit, NAME)
    built = hub.store.build_dir(PID, first)
    assert (hub.store.build_dir(PID, commit) / "assembled.json").read_bytes() == \
        (built / "assembled.json").read_bytes()


def test_a_tip_no_build_holds_is_built_and_a_push_meanwhile_wins(
        hub, tmp_path, script):
    published(hub, tmp_path / "work")
    changed = hub_commit(hub, tmp_path, "main", "notes.md", b"changed\n")
    hub_git(hub, "update-ref", "refs/heads/main", changed)
    moved = hub_commit(hub, tmp_path, changed, "notes.md", b"moved\n")

    def push_meanwhile(*_args, **_kw):
        hub_git(hub, "update-ref", "refs/heads/main", moved)
    script.append(push_meanwhile)
    reply = rename(hub, variant="main", kind="project", name=NAME)

    assert reply.status_code == 409
    assert reply.json()["error"] == "the branch moved while renaming; rename again"
    assert tip(hub) == moved

    script.append(failing_builder())
    reply = rename(hub, variant="main", kind="project", name=NAME)

    assert reply.status_code == 422
    assert reply.json()["error"].startswith("the model or a gate refused the build")
    assert tip(hub) == moved

    made = jobs_made(hub)
    reply = rename(hub, variant="main", kind="project", name=NAME)

    assert reply.status_code == 200, reply.text
    assert jobs_made(hub) == made + 1
    assert tip(hub) == reply.json()["commit"]
    assert hub.get(f"/project/{PID}/latest/meta.json").json()["commit"] == \
        reply.json()["commit"]


def test_views_in_project_json_name_the_model_s_views_and_a_bad_one_refuses(
        hub, tmp_path):
    work = tmp_path / "work"
    published(hub, work, views={"assembled": "Built up", "gone": "Not a view"})

    meta = hub.get(f"/project/{PID}/latest/meta.json").json()
    assert [view["name"] for view in meta["views"]] == ["Built up"]

    project = json.loads((work / "project.json").read_text())
    (work / "project.json").write_text(json.dumps({**project,
                                                   "views": {"assembled": " "}}))
    commit_all(work, "blank")
    pushed = push(hub, work, PID)

    assert pushed.returncode != 0
    assert "remote: project.json names views the page cannot show:" in pushed.stderr
    assert "'assembled': `view name` must be a non-empty string" in pushed.stderr
