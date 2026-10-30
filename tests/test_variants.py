"""Variants: every branch of a project's repository on the hub is a variant.

A variant has its own `latest`, draft slot, `builds.json` and label, under
`/project/<pid>/v/<branch>/`; `main` keeps the project's own addresses. Driven
with the real `git` of the test image against a real hub, as
test_git_publish.py is, the builds being `picky_builder`'s.
"""

import json
import os
import shutil
from pathlib import Path

import pytest
from harness import (BROKEN, TOKEN, commit_all, comment_payload, git,
                     picky_builder, project_files, push, start_hub, stop_hub,
                     write_files)

from src.prereceive import MAIN_DELETION_REFUSAL, VARIANT_NAME_REFUSAL

CEILING = "Потолочный корпус"
AUTH = {"X-Hammerola-Token": TOKEN}


@pytest.fixture
def hub(tmp_path):
    hub = start_hub(tmp_path / "data", build_runner=picky_builder())
    yield hub
    stop_hub(hub)


def files(pid, marker, label=None):
    """The project's tree with geometry `marker`, labelled `label`."""
    tree = project_files(pid, marker)
    if label is not None:
        document = json.loads(tree["project.json"])
        document["variant"] = label
        tree["project.json"] = json.dumps(document).encode("utf-8")
    return tree


def repository(work, pid):
    """A repository on `main` with the project at its root, committed."""
    git("init", "--quiet", "--initial-branch=main", work)
    write_files(work, files(pid, "a"))
    return commit_all(work, "first")


def branch(work, pid, name, label=None, marker="b"):
    """`git switch -c <name>` and a commit of its own geometry and label."""
    git("-C", work, "switch", "--quiet", "-c", name)
    write_files(work, files(pid, marker, label))
    return commit_all(work, f"{name}")


def draft(work, pid, marker, label=None):
    """A commit of the tree as `hammerola build` makes one, left off the
    branch. -> its sha, for `<sha>:refs/drafts/<branch>`."""
    write_files(work, files(pid, marker, label))
    sha = commit_all(work, "hammerola draft")
    git("-C", work, "reset", "--quiet", "--hard", "HEAD~1")
    return sha


def meta(hub, address):
    return hub.get(f"{address}meta.json").json()


def builds(hub, pid, variant):
    reply = hub.get(f"/project/{pid}/v/{variant}/builds.json", headers=AUTH)
    assert reply.status_code == 200, reply.text
    return reply.json()


def test_a_branch_publishes_its_own_latest_list_and_label(hub, tmp_path):
    """Criteria 1, 2 and 3, on the hub's side."""
    work = tmp_path / "work"
    first = repository(work, "var1")
    assert push(hub, work, "var1").returncode == 0
    assert [card["variants"] for card in hub.index().json()] == [1]
    ceiling = branch(work, "var1", "ceiling", CEILING)

    pushed = push(hub, work, "var1", "ceiling")

    assert pushed.returncode == 0, pushed.stderr
    on = meta(hub, "/project/var1/v/ceiling/latest/")
    assert (on["commit"], on["variant"], on["variant_label"]) == (
        ceiling, "ceiling", CEILING)
    assert hub.get("/project/var1/v/ceiling/latest/").status_code == 200
    assert meta(hub, "/project/var1/latest/")["commit"] == first
    own = builds(hub, "var1", "ceiling")
    assert (own["latest"], [b["commit"] for b in own["builds"]]) == (
        ceiling, [ceiling, first])
    assert [b["commit"] for b in hub.builds("var1").json()["builds"]] == [first]

    listing = hub.get("/project/var1/variants.json")
    assert listing.status_code == 200
    assert listing.json() == {"default": "main", "variants": [
        {"name": "main", "label": "main"},
        {"name": "ceiling", "label": CEILING}]}
    assert hub.get("/project/var1/v/ceiling/builds.json").status_code == 403
    assert hub.get("/project/var1/v/main/latest/").status_code == 404
    assert hub.get("/project/var1/v/main/builds.json",
                   headers=AUTH).status_code == 404
    assert hub.get("/project/var1/v/nothing/latest/").status_code == 404
    [card] = hub.index().json()
    assert (card["commit"], card["variants"]) == (first, 2)

    # The closed files of the variant's `latest` open with the key of its own
    # address, which its builds.json hands out under `latest`.
    stl = "/project/var1/v/ceiling/latest/lid.stl"
    assert hub.get(stl).status_code == 403
    key = own["files_keys"]["latest"]
    assert hub.get(f"{stl}?files={key}").status_code == 200
    assert key != hub.builds("var1").json()["files_keys"]["latest"]


def test_a_branch_s_draft_fills_its_own_slot_and_main_s_stays(
        hub, tmp_path, monkeypatch):
    """Criterion 4: the draft and the revision of `ceiling` go to its slot,
    and an unchanged file there is a hard link to the revision's."""
    work = tmp_path / "work"
    repository(work, "var2")
    assert push(hub, work, "var2").returncode == 0
    mine = draft(work, "var2", "main-draft")
    assert push(hub, work, "var2", f"{mine}:refs/drafts/main",
                extra=("--force",)).returncode == 0
    ceiling = branch(work, "var2", "ceiling", CEILING)
    assert push(hub, work, "var2", "ceiling").returncode == 0
    slot = hub.store.projects_dir / "var2" / ".variants" / "ceiling" / "dev"

    first = draft(work, "var2", "one", CEILING)
    pushed = push(hub, work, "var2", f"{first}:refs/drafts/ceiling",
                  extra=("--force",))
    assert pushed.returncode == 0, pushed.stderr
    assert "remote: published: /project/var2/v/ceiling/dev/" in pushed.stderr
    second = draft(work, "var2", "two", CEILING)
    assert push(hub, work, "var2", f"{second}:refs/drafts/ceiling",
                extra=("--force",)).returncode == 0

    served = hub.get("/project/var2/v/ceiling/dev/assembled.json").content
    assert b'"two"' in served and b'"one"' not in served
    assert meta(hub, "/project/var2/v/ceiling/dev/")["variant"] == "ceiling"
    assert b'"main-draft"' in hub.get("/project/var2/dev/assembled.json").content
    assert meta(hub, "/project/var2/v/ceiling/latest/")["commit"] == ceiling
    assert os.path.samefile(slot / "lid.stl",
                            hub.store.build_dir("var2", ceiling) / "lid.stl")

    # A later moment, so the same tree is a commit of its own: made within the
    # second of `second` it is that commit, and git never reaches the hook.
    for name in ("GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"):
        monkeypatch.setenv(name, "2030-01-01T00:00:00Z")
    again = draft(work, "var2", "two", CEILING)
    unchanged = push(hub, work, "var2", f"{again}:refs/drafts/ceiling",
                     extra=("--force",))
    assert "remote: unchanged: /project/var2/v/ceiling/dev/" in unchanged.stderr


def test_a_draft_of_a_branch_the_hub_lacks_is_served_and_not_listed(
        hub, tmp_path):
    work = tmp_path / "work"
    repository(work, "var3")
    assert push(hub, work, "var3").returncode == 0
    sha = draft(work, "var3", "wip")

    assert push(hub, work, "var3", f"{sha}:refs/drafts/wip",
                extra=("--force",)).returncode == 0

    assert b'"wip"' in hub.get("/project/var3/v/wip/dev/assembled.json").content
    assert builds(hub, "var3", "wip")["has_dev"] is True
    assert [v["name"] for v in hub.get("/project/var3/variants.json").json()
            ["variants"]] == ["main"]


def test_a_variant_s_build_is_compared_against_its_own_slot(tmp_path):
    """The metrics baseline a build is handed is its own variant's slot, read
    by content as `test_a_build_is_compared_against_the_previous_dev_and_not_
    against_itself` reads it: `ceiling` against `ceiling`, never `main`."""
    handed = []
    picky = picky_builder()

    def recording(project_dir, out_dir, *, pid, baseline=None, **kw):
        handed.append(None if baseline is None
                      else Path(baseline).read_text(encoding="utf-8"))
        return picky(project_dir, out_dir, pid=pid, **kw)

    hub = start_hub(tmp_path / "data", build_runner=recording)
    try:
        work = tmp_path / "work"
        repository(work, "varC")
        assert push(hub, work, "varC").returncode == 0
        write_files(work, {"metrics.json": b"main\n"})
        main_draft = draft(work, "varC", "m")
        assert push(hub, work, "varC", f"{main_draft}:refs/drafts/main",
                    extra=("--force",)).returncode == 0
        write_files(work, {"metrics.json": b"ceiling\n"})
        branch(work, "varC", "ceiling")
        assert push(hub, work, "varC", "ceiling").returncode == 0
        ceiling_draft = draft(work, "varC", "c")
        assert push(hub, work, "varC", f"{ceiling_draft}:refs/drafts/ceiling",
                    extra=("--force",)).returncode == 0
    finally:
        stop_hub(hub)

    # main's revision, main's draft, ceiling's revision, ceiling's draft.
    assert handed == [None, None, None, "ceiling\n"]


def test_a_refused_first_push_leaves_the_hub_empty(hub, tmp_path):
    """No branch, no `variants.json`: the sign-in page keeps its first steps
    after the push and after the recompute of a restart (`catch_up`)."""
    work = tmp_path / "work"
    repository(work, "var0")
    write_files(work, {BROKEN: b""})
    commit_all(work, "broken")

    assert push(hub, work, "var0").returncode != 0
    assert hub.get("/start").json()["empty"] is True
    hub.store.recompute("var0")
    assert hub.get("/start").json()["empty"] is True


def test_a_branch_name_that_is_no_variant_is_refused(hub, tmp_path):
    """Criterion 5: the branch and the draft of it, in the same words."""
    work = tmp_path / "work"
    sha = repository(work, "var4")
    assert push(hub, work, "var4").returncode == 0
    git("-C", work, "branch", "feature/x")
    jobs = len(list((hub.data / "jobs").iterdir()))

    for refspec in ("feature/x", f"{sha}:refs/drafts/feature/x"):
        pushed = push(hub, work, "var4", refspec)
        assert pushed.returncode != 0
        assert f"remote: {VARIANT_NAME_REFUSAL}" in pushed.stderr

    assert len(list((hub.data / "jobs").iterdir())) == jobs


def test_two_branches_of_one_push_on_one_commit_build_it_once(hub, tmp_path):
    work = tmp_path / "work"
    sha = repository(work, "varB")
    git("-C", work, "branch", "twin")

    pushed = push(hub, work, "varB", "main", "twin")

    assert pushed.returncode == 0, pushed.stderr
    assert len(list((hub.data / "jobs").iterdir())) == 1
    assert meta(hub, "/project/varB/v/twin/latest/")["commit"] == sha


def test_the_card_s_draft_status_is_the_default_variant_s(hub, tmp_path):
    """Criterion 6: neither a revision nor a draft of `ceiling` touches the
    state of `main`'s draft on the card."""
    work = tmp_path / "work"
    repository(work, "var5")
    assert push(hub, work, "var5").returncode == 0
    write_files(work, {BROKEN: b""})
    broken = commit_all(work, "broken draft")
    git("-C", work, "reset", "--quiet", "--hard", "HEAD~1")
    assert push(hub, work, "var5", f"{broken}:refs/drafts/main",
                extra=("--force",)).returncode != 0
    assert hub.index().json()[0]["status"] == "failed"

    branch(work, "var5", "ceiling")
    assert push(hub, work, "var5", "ceiling").returncode == 0
    ceiling_draft = draft(work, "var5", "c")
    assert push(hub, work, "var5", f"{ceiling_draft}:refs/drafts/ceiling",
                extra=("--force",)).returncode == 0

    [card] = hub.index().json()
    assert (card["status"], card["dev"], card["variants"]) == ("failed", False, 2)


def test_a_comment_on_a_variant_s_draft_names_the_variant(hub, tmp_path):
    """Criterion 8, on the hub's side."""
    work = tmp_path / "work"
    repository(work, "var6")
    assert push(hub, work, "var6").returncode == 0
    branch(work, "var6", "ceiling")
    assert push(hub, work, "var6", "ceiling").returncode == 0

    posted = hub.post_comment("var6", "v/ceiling/dev", comment_payload())

    assert posted.status_code == 201, posted.text
    [record] = hub.read_comments("?project=var6").json()["comments"]
    assert (record["commit"], record["variant"]) == ("dev", "ceiling")
    # `main`'s slot, which its revision filled, is the bare `dev`.
    assert hub.post_comment("var6", "dev", comment_payload()).status_code == 201
    assert sorted(str(r["variant"]) for r in hub.read_comments(
        "?project=var6").json()["comments"]) == ["None", "ceiling"]
    for wrong in ("v/main/dev", "v/ceiling/latest", "v/nothing/dev"):
        assert hub.post_comment("var6", wrong,
                                comment_payload()).status_code == 404


def test_a_label_the_hub_would_not_show_fails_the_build(hub, tmp_path):
    """Criterion 10."""
    work = tmp_path / "work"
    repository(work, "var7")
    assert push(hub, work, "var7").returncode == 0
    branch(work, "var7", "ceiling", "a‮b")

    pushed = push(hub, work, "var7", "ceiling")

    assert pushed.returncode != 0
    assert "`variant`" in pushed.stderr
    assert hub.get("/project/var7/v/ceiling/latest/").status_code == 404


def test_a_branch_with_no_commit_of_its_own_stands_on_main_s(hub, tmp_path):
    """Criterion 11: its `latest` and history are `main`'s up to where it
    branched, and it is called by its own name."""
    work = tmp_path / "work"
    first = repository(work, "var8")
    assert push(hub, work, "var8").returncode == 0
    write_files(work, files("var8", "second", "Wall bracket"))
    second = commit_all(work, "second")
    assert push(hub, work, "var8").returncode == 0
    git("-C", work, "branch", "bare")
    assert push(hub, work, "var8", "bare").returncode == 0
    write_files(work, files("var8", "third", "Wall bracket"))
    third = commit_all(work, "third")
    assert push(hub, work, "var8").returncode == 0

    bare = builds(hub, "var8", "bare")
    assert (bare["latest"], [b["commit"] for b in bare["builds"]]) == (
        second, [second, first])
    assert meta(hub, "/project/var8/v/bare/latest/")["commit"] == second
    assert hub.builds("var8").json()["latest"] == third
    assert hub.get("/project/var8/variants.json").json()["variants"] == [
        {"name": "main", "label": "Wall bracket"},
        {"name": "bare", "label": "bare"}]


def test_a_branch_named_compare_is_a_variant_and_no_comparison(hub, tmp_path):
    """Criterion 12."""
    work = tmp_path / "work"
    repository(work, "var9")
    assert push(hub, work, "var9").returncode == 0
    mine = branch(work, "var9", "compare")

    assert push(hub, work, "var9", "compare").returncode == 0

    assert meta(hub, "/project/var9/v/compare/latest/")["commit"] == mine
    page = hub.get("/project/var9/v/compare/latest/")
    assert page.status_code == 200
    assert f"revision {mine[:12]}" in page.text


def test_the_variants_come_back_whole_at_start(tmp_path):
    """What `.variants/` holds is derived: a start writes it again."""
    data = tmp_path / "data"
    hub = start_hub(data, build_runner=picky_builder())
    work = tmp_path / "work"
    repository(work, "varA")
    try:
        assert push(hub, work, "varA").returncode == 0
        ceiling = branch(work, "varA", "ceiling", CEILING)
        assert push(hub, work, "varA", "ceiling").returncode == 0
    finally:
        stop_hub(hub)
    shutil.rmtree(data / "project" / "varA" / ".variants")
    (data / "project" / "varA" / "variants.json").unlink()

    hub = start_hub(data, build_runner=picky_builder())
    try:
        assert meta(hub, "/project/varA/v/ceiling/latest/")["commit"] == ceiling
        assert hub.get("/project/varA/variants.json").json()["variants"][1] == {
            "name": "ceiling", "label": CEILING}
    finally:
        stop_hub(hub)


def test_a_deleted_branch_takes_its_variant_and_only_what_it_alone_has(
        hub, tmp_path):
    """`git push --delete` of a branch removes its revision, its draft and
    its addresses; the revision it shares with `main` stays."""
    work = tmp_path / "work"
    first = repository(work, "varD")
    assert push(hub, work, "varD").returncode == 0
    own = branch(work, "varD", "stand", "Стенд проверки")
    assert push(hub, work, "varD", "stand").returncode == 0
    wip = draft(work, "varD", "wip")
    assert push(hub, work, "varD", f"{wip}:refs/drafts/stand",
                extra=("--force",)).returncode == 0

    pushed = push(hub, work, "varD", "stand", extra=("--delete",))

    assert pushed.returncode == 0, pushed.stderr
    assert ("remote: removing the variant stand with every revision no other "
            "variant has") in pushed.stderr
    assert [v["name"] for v in hub.get("/project/varD/variants.json").json()
            ["variants"]] == ["main"]
    assert hub.get(f"/project/varD/{own}/meta.json").status_code == 404
    assert hub.get("/project/varD/v/stand/latest/").status_code == 404
    assert hub.get(f"/project/varD/{first}/meta.json").status_code == 200
    assert hub.get("/project/varD/latest/").status_code == 200
    assert git("--git-dir", hub.store.repo_dir("varD"), "for-each-ref",
               "refs/drafts/").stdout == ""


def test_a_revision_merged_into_another_variant_outlives_its_branch(
        hub, tmp_path):
    """The deleted variant published both revisions; `main` reaches the
    first, so only the second goes."""
    work = tmp_path / "work"
    repository(work, "varF")
    assert push(hub, work, "varF").returncode == 0
    merged = branch(work, "varF", "stand", "Стенд проверки")
    assert push(hub, work, "varF", "stand").returncode == 0
    git("-C", work, "switch", "--quiet", "main")
    git("-C", work, "merge", "--quiet", "--ff-only", "stand")
    assert push(hub, work, "varF", "main").returncode == 0
    git("-C", work, "switch", "--quiet", "stand")
    write_files(work, files("varF", "c", "Стенд проверки"))
    alone = commit_all(work, "stand alone")
    assert push(hub, work, "varF", "stand").returncode == 0

    pushed = push(hub, work, "varF", "stand", extra=("--delete",))

    assert pushed.returncode == 0, pushed.stderr
    assert hub.get(f"/project/varF/{alone}/meta.json").status_code == 404
    assert meta(hub, "/project/varF/latest/")["commit"] == merged
    listed = hub.get("/project/varF/builds.json", headers=AUTH)
    assert merged in [b["commit"] for b in listed.json()["builds"]]


def test_a_variant_cut_from_a_deleted_one_takes_its_revision_with_it(
        hub, tmp_path):
    """`stand2` was cut from `stand`; once both are gone, so is the revision
    `stand` published that only `stand2` still reached."""
    work = tmp_path / "work"
    repository(work, "varG")
    assert push(hub, work, "varG").returncode == 0
    inherited = branch(work, "varG", "stand", "Стенд проверки")
    assert push(hub, work, "varG", "stand").returncode == 0
    branch(work, "varG", "stand2", "Стенд 2", marker="c")
    assert push(hub, work, "varG", "stand2").returncode == 0

    assert push(hub, work, "varG", "stand",
                extra=("--delete",)).returncode == 0
    assert hub.get(f"/project/varG/{inherited}/meta.json").status_code == 200
    assert push(hub, work, "varG", "stand2",
                extra=("--delete",)).returncode == 0

    assert hub.get(f"/project/varG/{inherited}/meta.json").status_code == 404
    listed = hub.get("/project/varG/builds.json", headers=AUTH)
    assert inherited not in [b["commit"] for b in listed.json()["builds"]]


def test_a_variant_whose_branch_is_still_there_is_not_removed(hub, tmp_path):
    """What `remove_variant` is handed when git kept the branch after the
    hook accepted its deletion."""
    work = tmp_path / "work"
    repository(work, "varH")
    assert push(hub, work, "varH").returncode == 0
    own = branch(work, "varH", "stand", "Стенд проверки")
    assert push(hub, work, "varH", "stand").returncode == 0

    assert hub.store.remove_variant("varH", "stand", own) is None
    assert hub.get(f"/project/varH/{own}/meta.json").status_code == 200
    assert hub.get("/project/varH/v/stand/latest/").status_code == 200


def test_a_revision_a_refused_push_left_survives_another_variant_s_removal(
        hub, tmp_path):
    """`other`'s revision published before its push was refused has no
    branch on the hub, and it is no revision of `stand`."""
    work = tmp_path / "work"
    repository(work, "varI")
    assert push(hub, work, "varI").returncode == 0
    branch(work, "varI", "stand", "Стенд проверки")
    assert push(hub, work, "varI", "stand").returncode == 0
    git("-C", work, "switch", "--quiet", "main")
    stray = branch(work, "varI", "other", marker="c")
    write_files(work, {BROKEN: b"x"})
    broken = commit_all(work, "broken draft")
    assert push(hub, work, "varI", f"{stray}:refs/heads/other",
                f"{broken}:refs/drafts/other").returncode != 0
    assert hub.get(f"/project/varI/{stray}/meta.json").status_code == 200

    assert push(hub, work, "varI", "stand",
                extra=("--delete",)).returncode == 0

    assert hub.get(f"/project/varI/{stray}/meta.json").status_code == 200


def test_a_revision_of_a_refused_push_goes_with_its_variant(hub, tmp_path):
    """`stand`'s second revision published before the push was refused, so
    its branch never reached it; it is still `stand`'s."""
    work = tmp_path / "work"
    repository(work, "varJ")
    assert push(hub, work, "varJ").returncode == 0
    branch(work, "varJ", "stand", "Стенд проверки")
    assert push(hub, work, "varJ", "stand").returncode == 0
    write_files(work, files("varJ", "c", "Стенд проверки"))
    lost = commit_all(work, "lost")
    write_files(work, {BROKEN: b"x"})
    broken = commit_all(work, "broken draft")
    assert push(hub, work, "varJ", f"{lost}:refs/heads/stand",
                f"{broken}:refs/drafts/stand").returncode != 0
    assert hub.get(f"/project/varJ/{lost}/meta.json").status_code == 200

    assert push(hub, work, "varJ", "stand",
                extra=("--delete",)).returncode == 0

    assert hub.get(f"/project/varJ/{lost}/meta.json").status_code == 404


def test_the_default_variant_cannot_be_deleted(hub, tmp_path):
    work = tmp_path / "work"
    first = repository(work, "varE")
    assert push(hub, work, "varE").returncode == 0

    pushed = push(hub, work, "varE", "main", extra=("--delete",))

    assert pushed.returncode != 0
    assert f"remote: {MAIN_DELETION_REFUSAL}" in pushed.stderr
    assert git("--git-dir", hub.store.repo_dir("varE"), "rev-parse",
               "refs/heads/main").stdout.strip() == first
    assert meta(hub, "/project/varE/latest/")["commit"] == first
