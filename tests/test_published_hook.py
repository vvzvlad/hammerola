"""`published(hub)`: when the hub calls the model's function after a push.

Driven with the real `git` against a real hub, as test_variants.py is, the
builds being `picky_builder`'s and the call `recording_publisher`'s: what is the
hub's here is WHEN the function is called (by the post-receive hook, once git
has written the refs), with what tree and environment, and that nothing it does
refuses a push. What the function does in its process is
tests/buildproc/test_published_child.py.
"""

import pytest
from harness import (BROKEN, commit_all, git, picky_builder, project_files, push,
                     recording_publisher, start_hub, stop_hub, write_files)

from src import prereceive
from src.buildproc import STATUS_FAILED
from src.store import REPOS_DIR_NAME, SOURCE_PREFIX

PUBLISHED = b"def published(hub):\n    pass\n"


@pytest.fixture
def publisher(tmp_path):
    return recording_publisher(repos=tmp_path / "data" / REPOS_DIR_NAME)


@pytest.fixture
def hub(tmp_path, publisher):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(),
                    published_runner=publisher)
    yield hub
    stop_hub(hub)


def commit(work, pid, marker, model=PUBLISHED):
    """A commit of the project with geometry `marker` and the given model.py
    (none for None). -> its sha."""
    files = project_files(pid, marker)
    if model is not None:
        files["model.py"] = model
    write_files(work, files)
    return commit_all(work, marker)


def repository(work):
    git("init", "--quiet", "--initial-branch=main", work)


def latest(hub, pid, variant="main"):
    address = (f"/project/{pid}/latest/meta.json" if variant == "main"
               else f"/project/{pid}/v/{variant}/latest/meta.json")
    return hub.get(address).json()["commit"]


def sources_left(hub):
    return [entry.name for entry in hub.store.root.iterdir()
            if entry.name.startswith(SOURCE_PREFIX)]


def test_a_build_is_followed_by_the_call_with_the_revision_s_tree_and_context(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    sha = commit(work, "pub1", "a")

    pushed = push(hub, work, "pub1")

    assert pushed.returncode == 0, pushed.stderr
    [call] = publisher.calls
    assert call["pid"] == "pub1"
    assert call["model"] == PUBLISHED.decode()
    assert call["environment"] == {
        "HAMMEROLA_PROJECT": "pub1", "HAMMEROLA_VARIANT": "main",
        "HAMMEROLA_REVISION": sha}
    # Called once git has written the branch, not before (pre-receive): a push
    # git refuses after the hook's answer must not have exported anything.
    assert call["branch"] == sha
    assert f"remote: published() for main at {sha[:12]}" in pushed.stderr
    assert "remote: published(): stub" in pushed.stderr
    # After the build's own lines and its address, and the tree is gone.
    assert pushed.stderr.index("remote: published: /project/pub1/") < \
        pushed.stderr.index("remote: published() for main")
    assert not call["tree"].exists()
    assert sources_left(hub) == []


def test_a_variant_is_called_with_its_own_name(hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    commit(work, "pub2", "a")
    assert push(hub, work, "pub2").returncode == 0
    git("-C", work, "switch", "--quiet", "-c", "ceiling")
    side = commit(work, "pub2", "b")

    assert push(hub, work, "pub2", "ceiling").returncode == 0

    assert [(call["environment"]["HAMMEROLA_VARIANT"],
             call["environment"]["HAMMEROLA_REVISION"])
            for call in publisher.calls][1:] == [("ceiling", side)]


def test_a_draft_is_not_published_and_the_commit_of_its_tree_is(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    commit(work, "pub3", "a")
    assert push(hub, work, "pub3").returncode == 0
    publisher.calls.clear()
    draft = commit(work, "pub3", "b")
    git("-C", work, "reset", "--quiet", "--hard", "HEAD~1")

    pushed = push(hub, work, "pub3", f"{draft}:refs/drafts/main",
                  extra=("--force",))
    assert pushed.returncode == 0, pushed.stderr
    assert publisher.calls == []

    # The same tree on the branch is the draft's build, not built again, and
    # still a revision that becomes `latest`.
    git("-C", work, "reset", "--quiet", "--hard", draft)
    pushed = push(hub, work, "pub3")
    assert "reused the draft build of this tree" in pushed.stderr
    [call] = publisher.calls
    assert call["environment"]["HAMMEROLA_REVISION"] == draft


def test_a_branch_moved_onto_a_commit_built_on_another_is_published(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    commit(work, "pub4", "a")
    assert push(hub, work, "pub4").returncode == 0
    git("-C", work, "switch", "--quiet", "-c", "side")
    side = commit(work, "pub4", "b")
    assert push(hub, work, "pub4", "side").returncode == 0
    publisher.calls.clear()
    git("-C", work, "switch", "--quiet", "main")
    git("-C", work, "merge", "--quiet", "--ff-only", "side")

    pushed = push(hub, work, "pub4")

    assert pushed.returncode == 0, pushed.stderr
    assert "building" not in pushed.stderr
    [call] = publisher.calls
    assert (call["environment"]["HAMMEROLA_VARIANT"],
            call["environment"]["HAMMEROLA_REVISION"]) == ("main", side)
    assert latest(hub, "pub4") == side


def test_nothing_is_called_when_latest_does_not_move(hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    sha = commit(work, "pub5", "a")
    assert push(hub, work, "pub5").returncode == 0
    publisher.calls.clear()
    # A commit that leaves the project's files as they were builds nothing.
    git("-C", work, "commit", "--quiet", "--allow-empty", "-m", "nothing")

    pushed = push(hub, work, "pub5")

    assert pushed.returncode == 0, pushed.stderr
    assert latest(hub, "pub5") == sha
    assert publisher.calls == []


@pytest.mark.parametrize("model", [
    None,
    b"async def published(hub):\n    pass\n",
    b"# def published(hub):\n",
    b"class Site:\n    def published(self):\n        pass\n",
    b"def published(hub:\n",
], ids=["no model.py", "a coroutine", "a comment", "a method",
         "a syntax error"])
def test_a_model_without_a_top_level_published_is_not_called(
        hub, publisher, tmp_path, model):
    work = tmp_path / "work"
    repository(work)
    commit(work, "pub6", "a", model)

    pushed = push(hub, work, "pub6")

    assert pushed.returncode == 0, pushed.stderr
    assert publisher.calls == []
    assert "published()" not in pushed.stderr


def test_two_branches_pushed_together_are_each_called_with_their_own_name(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    main = commit(work, "pub9", "a")
    git("-C", work, "switch", "--quiet", "-c", "side")
    side = commit(work, "pub9", "b")

    pushed = push(hub, work, "pub9", "main", "side")

    assert pushed.returncode == 0, pushed.stderr
    assert sorted((call["environment"]["HAMMEROLA_VARIANT"],
                   call["environment"]["HAMMEROLA_REVISION"])
                  for call in publisher.calls) == [("main", main),
                                                   ("side", side)]


def test_the_call_is_decided_by_the_refs_not_by_the_latest_pointer(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    old = commit(work, "pub11", "a")
    assert push(hub, work, "pub11").returncode == 0
    new = commit(work, "pub11", "b")
    assert push(hub, work, "pub11").returncode == 0
    publisher.calls.clear()
    # `latest` already points at `new`, as after a recompute that ran between
    # git writing the ref and the post-receive hook.
    assert latest(hub, "pub11") == new

    prereceive.run_after(
        hub.store, hub.server.jobs, hub.server.builds,
        prereceive.HookRequest("pub11", ((old, new, "refs/heads/main"),), {},
                               ()),
        lambda line: None)

    [call] = publisher.calls
    assert call["environment"]["HAMMEROLA_REVISION"] == new


def test_a_git_failure_in_the_decision_warns_and_the_next_branch_is_called(
        hub, publisher, tmp_path, monkeypatch):
    work = tmp_path / "work"
    repository(work)
    main = commit(work, "pub12", "a")
    git("-C", work, "switch", "--quiet", "-c", "side")
    side = commit(work, "pub12", "b")
    nearest = hub.store.nearest_build

    def broken_for_main(pid, rev):
        if rev == main:
            raise OSError("git is gone")
        return nearest(pid, rev)

    monkeypatch.setattr(hub.store, "nearest_build", broken_for_main)

    pushed = push(hub, work, "pub12", "main", "side")

    assert pushed.returncode == 0, pushed.stderr
    assert ("remote: warning: published() for main was not called: internal "
            "error; the push is in without it") in pushed.stderr
    assert [(call["environment"]["HAMMEROLA_VARIANT"],
             call["environment"]["HAMMEROLA_REVISION"])
            for call in publisher.calls] == [("side", side)]


def test_a_refused_push_calls_published_for_none_of_its_branches(
        hub, publisher, tmp_path):
    work = tmp_path / "work"
    repository(work)
    commit(work, "pub10", "a")
    git("-C", work, "switch", "--quiet", "-c", "side")
    commit(work, "pub10", "b")
    write_files(work, {BROKEN: b"x"})
    commit_all(work, "breaks the build")

    pushed = push(hub, work, "pub10", "main", "side")

    # `main` was built before `side` failed; its revision stays, and the
    # branch refs never moved, so nothing became `latest` to be exported.
    assert pushed.returncode != 0
    assert publisher.calls == []
    assert "published()" not in pushed.stderr


def test_a_published_that_fails_warns_and_the_push_goes_through(
        tmp_path):
    failing = recording_publisher(status=STATUS_FAILED,
                                  log="published() raised OSError: no route\n")
    hub = start_hub(tmp_path / "data", build_runner=picky_builder(),
                    published_runner=failing)
    try:
        work = tmp_path / "work"
        repository(work)
        sha = commit(work, "pub7", "a")

        pushed = push(hub, work, "pub7")

        assert pushed.returncode == 0, pushed.stderr
        assert "remote: published() raised OSError: no route" in pushed.stderr
        assert ("remote: warning: published() for main did not finish "
                "(failed); the push is in without it") in pushed.stderr
        assert latest(hub, "pub7") == sha
        assert sources_left(hub) == []
    finally:
        stop_hub(hub)


def test_a_published_that_raises_in_the_pool_warns_too(tmp_path):
    def broken(project_dir, **_kw):
        raise RuntimeError("the runner itself broke")

    hub = start_hub(tmp_path / "data", build_runner=picky_builder(),
                    published_runner=broken)
    try:
        work = tmp_path / "work"
        repository(work)
        sha = commit(work, "pub8", "a")

        pushed = push(hub, work, "pub8")

        assert pushed.returncode == 0, pushed.stderr
        assert "remote: warning: published() for main did not finish" \
            in pushed.stderr
        assert latest(hub, "pub8") == sha
        assert sources_left(hub) == []
    finally:
        stop_hub(hub)
