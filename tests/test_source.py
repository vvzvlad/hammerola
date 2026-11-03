"""The code of a build: `GET /api/v1/source/`, the files of the project
directory in the commit the build was made from (SPEC 7.8).

Pushed with the real `git` of the test image, as test_git_publish.py pushes; a
build published before git is `Hub.publish`'s, imported at once.
"""

from harness import (TOKEN, commit_all, git, good_build, project_files, push,
                     write_files)

AUTH = {"X-Hammerola-Token": TOKEN}
CODE = b"print('part')\n"


def pushed(hub, work, pid):
    """A repository with the project in `hub/` and a file beside it, pushed.
    -> the project directory's files."""
    git("init", "--quiet", "--initial-branch=main", work)
    files = {**project_files(pid), "src/part.py": CODE}
    write_files(work / "hub", files)
    write_files(work, {"beside.txt": b"not the project's"})
    commit_all(work, "first")
    assert push(hub, work, pid).returncode == 0
    return files


def source(hub, address, **kw):
    return hub.get(f"/api/v1/source/{address}", **{"headers": AUTH, **kw})


def sized(files):
    return sorted((path, len(data)) for path, data in files.items())


def listed(reply):
    assert reply.status_code == 200, reply.text
    return sorted((f["path"], f["size"]) for f in reply.json()["files"])


def test_a_revision_lists_its_project_directory_and_hands_over_a_file(
        hub, tmp_path):
    files = pushed(hub, tmp_path / "work", "src1")
    sha = hub.get("/project/src1/latest/meta.json").json()["commit"]

    assert listed(source(hub, f"src1/{sha}")) == sized(files)
    assert listed(source(hub, "src1/latest")) == sized(files)
    one = source(hub, f"src1/{sha}?path=src/part.py")
    assert (one.status_code, one.content) == (200, CODE)
    assert one.headers["content-type"] == "application/octet-stream"
    assert one.headers["content-disposition"] == "attachment"


def test_only_a_file_of_the_list_is_handed_over(hub, tmp_path):
    pushed(hub, tmp_path / "work", "src2")
    for path in ("nothing.py", "../beside.txt", "src", ""):
        assert source(hub, f"src2/latest?path={path}").status_code == 404, path
    assert source(hub, "src2/" + "0" * 40).status_code == 404


def test_a_build_whose_tree_the_repository_lacks_has_no_code(hub, tmp_path):
    pushed(hub, tmp_path / "work", "src6")
    sha = hub.get("/project/src6/latest/meta.json").json()["commit"]
    (hub.store.build_dir("src6", sha) / ".payload.sha256").write_text("1" * 40)

    reply = source(hub, f"src6/{sha}")
    assert reply.status_code == 404
    assert reply.json()["error"] == (
        "the repository of this project holds no code of this build")


def test_the_token_is_asked_before_anything_else(hub, tmp_path):
    pushed(hub, tmp_path / "work", "src3")
    for headers in ({}, {"X-Hammerola-Token": "wrong"}):
        for address in ("src3/latest", "src3/latest?path=src/part.py",
                        "nosuch/latest"):
            assert source(hub, address, headers=headers).status_code == 403


def test_a_variant_pointer_lists_its_own_branch(hub, tmp_path):
    work = tmp_path / "work"
    files = pushed(hub, work, "src4")
    git("-C", work, "switch", "--quiet", "-c", "ceiling")
    write_files(work / "hub", {"ceiling.py": CODE})
    commit_all(work, "ceiling")
    assert push(hub, work, "src4", "ceiling").returncode == 0

    assert listed(source(hub, "src4/v/ceiling/latest")) == sized(
        {**files, "ceiling.py": CODE})
    assert listed(source(hub, "src4/latest")) == sized(files)


def test_a_build_published_before_git_lists_its_import_commit(hub):
    hub.publish("src5", "cards-2026-09-14", good_build("a"))

    assert [path for path, _size in listed(
        source(hub, "src5/cards-2026-09-14"))] == [
        "assembled.json", "lid.stl", "meta.json", "pin.stl"]
    assert source(hub, "src5/cards-2026-09-14?path=lid.stl").content == (
        b"solid lid\nendsolid lid\n")
