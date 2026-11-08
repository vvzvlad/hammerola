"""A project's version: what `version()` of its version.py gives, recorded on
every build, and the tags of a variant in its `builds.json`.

Driven with the real `git` against a real hub, as test_variants.py is. The
version is asked by the real `run_version`; the build is `copying_builder`'s.
"""

import json

import httpx
from harness import TOKEN, commit_all, git, project_files, push, write_files

AUTH = {"X-Hammerola-Token": TOKEN}
# A ChangeLog's version in miniature: read off a file beside it by a relative
# path, with the newline a file ends in, which the hub cleans away.
VERSION_PY = b'def version():\n    return open("VERSION").read()\n'


def commit(work, pid, marker, version, message):
    write_files(work, {**project_files(pid, marker), "version.py": VERSION_PY,
                       "VERSION": f"{version}\n".encode()})
    return commit_all(work, message)


def meta(hub, pid, name):
    return hub.get(f"/project/{pid}/{name}/meta.json").json()


def rows(hub, path):
    reply = hub.get(f"{path}builds.json", headers=AUTH)
    assert reply.status_code == 200, reply.text
    return {row["commit"]: (row.get("version"), row.get("tag"))
            for row in reply.json()["builds"]}


def test_a_tag_is_where_the_version_changes_on_the_first_parent_line(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    first = commit(work, "ver1", "a", "1.0", "first")
    assert push(hub, work, "ver1").returncode == 0
    same = commit(work, "ver1", "b", "1.0", "the same version")
    assert push(hub, work, "ver1").returncode == 0
    raised = commit(work, "ver1", "c", "1.1", "a new version")
    assert push(hub, work, "ver1").returncode == 0
    git("-C", work, "switch", "--quiet", "-c", "side")
    side = commit(work, "ver1", "d", "2.0", "on the side")
    assert push(hub, work, "ver1", "side").returncode == 0
    git("-C", work, "switch", "--quiet", "main")
    git("-C", work, "merge", "--quiet", "--no-ff", "-m", "merge side", "side")
    merge = git("-C", work, "rev-parse", "HEAD").stdout.strip()

    pushed = push(hub, work, "ver1")

    assert pushed.returncode == 0, pushed.stderr
    assert "remote: version: 2.0" in pushed.stderr
    # `side` is reached through the merge's second parent: listed, no tag.
    assert rows(hub, "/project/ver1/") == {
        first: ("1.0", True), same: ("1.0", None), raised: ("1.1", True),
        side: ("2.0", None), merge: ("2.0", True)}
    assert rows(hub, "/project/ver1/v/side/")[side] == ("2.0", True)


def test_every_way_a_build_is_published_carries_its_version(hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    first = commit(work, "ver2", "a", "1.0", "first")
    assert push(hub, work, "ver2").returncode == 0
    draft = commit(work, "ver2", "b", "1.1", "hammerola draft")
    assert push(hub, work, "ver2", f"{draft}:refs/drafts/main",
                extra=("--force",)).returncode == 0
    assert meta(hub, "ver2", "dev")["version"] == "1.1"

    # The commit of the draft's tree is the slot's build, not built again.
    pushed = push(hub, work, "ver2")
    assert "reused the draft build of this tree" in pushed.stderr
    renamed = httpx.post(f"{hub.url}/api/v1/projects/ver2/names",
                         json={"variant": "main", "kind": "project",
                               "name": "Renamed"},
                         headers=AUTH, timeout=30, trust_env=False)
    assert renamed.status_code == 200, renamed.text

    assert meta(hub, "ver2", first)["version"] == "1.0"
    assert meta(hub, "ver2", draft)["version"] == "1.1"
    assert meta(hub, "ver2", renamed.json()["commit"])["version"] == "1.1"


def test_a_version_py_that_fails_fails_the_push_and_publishes_nothing(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    good = commit(work, "ver3", "a", "1.0", "first")
    assert push(hub, work, "ver3").returncode == 0
    write_files(work, {"version.py": b"def version():\n"
                                     b"    raise RuntimeError('no entry')\n"})
    broken = commit_all(work, "break the version")

    pushed = push(hub, work, "ver3")

    assert pushed.returncode != 0
    assert "RuntimeError: no entry" in pushed.stderr
    assert "version.py did not give the project's version (failed)" in \
        pushed.stderr
    assert hub.get(f"/project/ver3/{broken}/meta.json").status_code == 404
    assert meta(hub, "ver3", "latest")["commit"] == good


def test_a_revision_without_a_version_does_not_make_the_same_version_a_tag_again(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    first = commit(work, "ver4", "a", "1.0", "first")
    assert push(hub, work, "ver4").returncode == 0
    git("-C", work, "rm", "--quiet", "version.py", "VERSION")
    write_files(work, project_files("ver4", "b"))
    bare = commit_all(work, "no version.py")
    assert push(hub, work, "ver4").returncode == 0
    again = commit(work, "ver4", "c", "1.0", "version.py back")
    assert push(hub, work, "ver4").returncode == 0

    assert rows(hub, "/project/ver4/") == {
        first: ("1.0", True), bare: (None, None), again: ("1.0", None)}


def test_a_tree_with_documents_and_no_model_gets_its_version_too(
        hub, tmp_path):
    work = tmp_path / "work"
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work, {
        "project.json": json.dumps({
            "id": "ver5", "title": "Board",
            "documents": [{"file": "notes.md", "title": "Notes"}]}).encode(),
        "notes.md": b"# Notes\n",
        "version.py": VERSION_PY, "VERSION": b"3.6\n"})
    revision = commit_all(work, "a board")

    pushed = push(hub, work, "ver5")

    assert pushed.returncode == 0, pushed.stderr
    assert "remote: version: 3.6" in pushed.stderr
    assert meta(hub, "ver5", revision)["kind"] == "documents"
    assert meta(hub, "ver5", revision)["version"] == "3.6"
