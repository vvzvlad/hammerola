"""The client against a REAL hub, over a real socket.

THIS IS THE TEST THE WHOLE MODULE EXISTS FOR. Publication is broken today
because the two halves of one contract lived in two repositories: step 5 moved
the hub to source trees and to 202, `cad_publish` went on packing a flat build
and waiting for 201, and each suite stayed green about its own half. Nothing
short of running both halves together can catch that, so every test below drives
`cli.main` — argv in, exit code out — at a hub started by `harness.start_hub`,
and then looks at what landed on the hub's disk.

The geometry is stood in for, not the protocol. `harness.copying_builder`
replaces the build (this suite has no CAD kernel and a real build is minutes),
so the tree the client packs is the tree that gets published; everything else —
the archive, the token, the 202, the job, the log, the pointers, the exit code —
is the real thing.
"""

import os
import shlex

import pytest
from modeldir import git, git_repo, make_model
from harness import TOKEN, failing_builder

from src.client import gitsuggest
from src.client.cli import main


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    """Point the client at the test hub, with the token that hub checks."""
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args, "--timeout", "60"])


def revisions_of(hub, pid="demo0001"):
    """Every published revision directory, `latest` and `dev` excluded.

    By listing rather than by name, because no test here can predict the name:
    that is the whole change — the id is minted by the hub out of the sources.
    """
    project = hub.project_dir(pid)
    if not project.exists():
        return []
    return sorted(entry.name for entry in project.iterdir()
                  if entry.is_dir() and not entry.is_symlink()
                  and entry.name not in ("dev", "latest"))


def printed_revision(out):
    """The revision id out of the run's own output, as a user would read it."""
    for line in out.splitlines():
        if line.startswith("revision "):
            return line.split()[1].rstrip(":")
    return None


# -- build: the dev slot -----------------------------------------------------
def test_build_publishes_the_dev_slot(hub, model, capsys):
    assert run(model, "build") == 0

    published = hub.project_dir("demo0001") / "dev"
    assert (published / "model.py").read_text().startswith("import cadquery")
    assert (published / "meta.json").is_file()

    out = capsys.readouterr().out
    # The address, printed by the thing that knows it, on a line of its own.
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/dev/")


def test_build_leaves_latest_and_the_public_index_alone(hub, model):
    """`dev` is the working copy, not a version: the public surfaces go on
    meaning "the project as of some commit" (SPEC 7.6)."""
    assert run(model, "build") == 0
    assert not (hub.project_dir("demo0001") / "latest").exists()
    assert hub.get("/index.json").json() == []


def test_the_whole_source_tree_arrives_including_subdirectories(hub, tmp_path):
    """Step 2's change, from the client's side: what is pushed is a TREE."""
    model = make_model(tmp_path / "demo", extra={
        "scripts/gen.py": "VALUE = 42\n",
        "ref/vendor/part.step": "ISO-10303-21;\n",
    })
    assert run(model, "build") == 0
    published = hub.project_dir("demo0001") / "dev"
    assert (published / "scripts" / "gen.py").read_text() == "VALUE = 42\n"
    assert (published / "ref" / "vendor" / "part.step").is_file()


def test_the_build_log_reaches_the_person_who_pushed(hub, model, capsys):
    """The replacement for a forge's job log, and the reason step 5 was built."""
    assert run(model, "build") == 0
    out = capsys.readouterr().out
    assert "--- build log ---" in out
    assert "copying builder:" in out


def test_a_second_identical_push_rebuilds_nothing(hub, model, capsys):
    """`Store.settled` answers 200 straight from the request, with no job at
    all — so the client has to recognise it rather than wait for a job id that
    is not coming."""
    assert run(model, "build") == 0
    capsys.readouterr()
    assert run(model, "build") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/dev/")


def test_the_client_runs_in_the_current_directory_too(hub, model, monkeypatch):
    """-C is a convenience; the ordinary invocation has no arguments at all."""
    monkeypatch.chdir(model)
    assert main(["build"]) == 0
    assert (hub.project_dir("demo0001") / "dev" / "model.py").is_file()


# -- commit: a revision the hub names ---------------------------------------
def test_commit_publishes_a_revision_and_moves_latest(hub, model, capsys):
    """The whole contract in one run: no git anywhere, an id the client never
    chose, and `latest` pointing at it."""
    assert run(model, "commit", "-m", "first revision") == 0

    published = revisions_of(hub)
    assert len(published) == 1
    revision = published[0]
    assert (hub.project_dir("demo0001") / revision / "model.py").is_file()
    assert os.readlink(hub.project_dir("demo0001") / "latest") == revision

    out = capsys.readouterr().out
    assert printed_revision(out) == revision
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/{revision}/")


def test_the_revision_is_the_digest_of_the_sources(hub, model, capsys):
    """Not an opaque token the hub remembers: the name IS the payload digest,
    so the published directory carries its own name in `.payload.sha256`."""
    assert run(model, "commit") == 0
    revision = revisions_of(hub)[0]

    stamped = (hub.project_dir("demo0001") / revision /
               ".payload.sha256").read_text().strip()
    assert stamped == revision
    assert len(revision) == 64 and all(c in "0123456789abcdef" for c in revision)


def test_the_same_sources_publish_once(hub, model, capsys):
    """Idempotence, and now it cannot come apart from the identifier: the same
    tree hashes to the same name, so the second push finds itself already
    there. 200 from the request, no job, no second directory."""
    assert run(model, "commit") == 0
    first = printed_revision(capsys.readouterr().out)

    assert run(model, "commit") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert printed_revision(out) == first
    assert revisions_of(hub) == [first]


def test_changed_sources_get_a_different_revision(hub, model, capsys):
    assert run(model, "commit") == 0
    first = printed_revision(capsys.readouterr().out)

    (model / "model.py").write_text("# a different model\n")
    assert run(model, "commit") == 0
    second = printed_revision(capsys.readouterr().out)

    assert second != first
    assert revisions_of(hub) == sorted([first, second])
    assert os.readlink(hub.project_dir("demo0001") / "latest") == second


def test_a_repository_free_directory_publishes_normally(hub, model, capsys):
    """What used to be a refusal. `commit` means "publish a version of this",
    and a directory with no git in it can always do that."""
    assert not (model / ".git").exists()
    assert run(model, "commit", "-m", "no git here") == 0
    assert len(revisions_of(hub)) == 1
    # And nothing was offered, because there is no repository to offer it to.
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_the_job_id_and_the_revision_are_both_shown_and_told_apart(
        hub, model, capsys):
    """Two identifiers leave the hub on one 202 and they address different
    things. The run has to show both, and label which is which."""
    assert run(model, "commit") == 0
    out = capsys.readouterr().out

    revision = printed_revision(out)
    job_line = next(line for line in out.splitlines()
                    if line.startswith("queued as job "))
    job_id = job_line.split()[3].rstrip(":")

    assert job_id != revision
    assert "the version being published" in out
    assert "this build's progress" in job_line


# -- the git commit that is OFFERED afterwards -------------------------------
def test_a_dirty_repository_is_offered_a_commit_carrying_the_revision(
        hub, model, capsys):
    git_repo(model)
    (model / "model.py").write_text("# edited, never committed\n")

    assert run(model, "commit", "-m", "the bracket got thicker") == 0
    out = capsys.readouterr().out
    revision = printed_revision(out)

    assert gitsuggest.HEADLINE in out
    offered = next(line for line in out.splitlines()
                   if line.strip().startswith("git add -A"))
    argv = shlex.split(offered)
    assert "the bracket got thicker" in argv
    assert f"{gitsuggest.TRAILER}: {revision}" in argv

    # OFFERED, not made: the tree is as dirty as it was.
    assert git(model, "status", "--porcelain").stdout.strip()


def test_the_url_is_still_the_last_line_after_the_offer(hub, model, capsys):
    """The offer is two lines of prose in the middle of the output; the bare
    URL still has to be the thing a terminal leaves selected at the end."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "commit") == 0

    out = capsys.readouterr().out
    revision = printed_revision(out)
    assert out.rstrip().endswith(f"{hub.url}/project/demo0001/{revision}/")


def test_a_clean_repository_is_offered_nothing(hub, model, capsys):
    git_repo(model)
    assert run(model, "commit") == 0
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_build_never_offers_a_commit(hub, model, capsys):
    """`dev` is the working copy, not a version. There is nothing to record."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "build") == 0
    assert gitsuggest.HEADLINE not in capsys.readouterr().out


def test_an_unchanged_revision_still_offers_the_commit(hub, model, capsys):
    """The second push published nothing, but git still has not recorded the
    first one — the offer is about the repository, not about the rebuild."""
    git_repo(model)
    (model / "model.py").write_text("# edited\n")
    assert run(model, "commit", "-m", "same again") == 0
    capsys.readouterr()

    assert run(model, "commit", "-m", "same again") == 0
    out = capsys.readouterr().out
    assert "unchanged" in out
    assert gitsuggest.HEADLINE in out


# -- failures ----------------------------------------------------------------
def test_a_failed_build_is_a_non_zero_exit_with_its_log(hub_factory, model,
                                                        monkeypatch, capsys):
    broken = hub_factory(build_runner=failing_builder(
        log="gate: model.py declares no printables\n"))
    monkeypatch.setenv("HUB_URL", broken.url)

    assert run(model, "build") == 1
    captured = capsys.readouterr()
    assert "gate: model.py declares no printables" in captured.out
    assert "the build failed" in captured.err
    # Nothing was published: the slot was never created.
    assert not (broken.project_dir("demo0001") / "dev").exists()


def test_a_bad_token_fails_with_the_hubs_own_answer(hub, model, monkeypatch,
                                                    capsys):
    monkeypatch.setenv("PUBLISH_TOKEN", "not-the-token")
    assert run(model, "build") == 1
    assert "401" in capsys.readouterr().err


def test_a_missing_hub_url_fails_before_anything_is_packed(model, monkeypatch,
                                                           capsys):
    monkeypatch.delenv("HUB_URL", raising=False)
    assert run(model, "build") == 1
    assert "HUB_URL is not set" in capsys.readouterr().err


def test_a_missing_token_fails_before_anything_is_packed(model, monkeypatch,
                                                         capsys):
    monkeypatch.delenv("PUBLISH_TOKEN", raising=False)
    assert run(model, "build") == 1
    assert "PUBLISH_TOKEN is not set" in capsys.readouterr().err


def test_a_tree_the_hub_would_refuse_is_refused_locally(hub, model, capsys):
    """The ceilings are checked before the upload, so the answer names the file
    instead of arriving as a 422 about an archive member."""
    (model / "My Model.py").write_text("x = 1\n")
    assert run(model, "build") == 1
    assert "My Model.py" in capsys.readouterr().err
    assert not hub.project_dir("demo0001").exists()


def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    """No traceback: a hub that is down is an ordinary thing to run into."""
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    assert run(model, "build") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_project_with_no_id_is_refused_before_the_push(hub, tmp_path, capsys):
    model = make_model(tmp_path / "demo")
    (model / "project.json").write_text('{"id": "", "title": ""}')
    assert run(model, "build") == 1
    assert "no project id" in capsys.readouterr().err


def test_waiting_can_time_out_without_pretending_to_have_published(
        hub_factory, model, monkeypatch, capsys):
    """A job that never finishes must not become a zero exit. The build is not
    cancelled by giving up, and the message says so."""
    import threading

    release = threading.Event()

    def slow_builder(project_dir, out_dir, *, pid, **kw):
        release.wait(timeout=30)
        from harness import copying_builder
        return copying_builder(project_dir, out_dir, pid=pid, **kw)

    slow = hub_factory(build_runner=slow_builder)
    monkeypatch.setenv("HUB_URL", slow.url)
    try:
        assert main(["-C", str(model), "build", "--timeout", "0.3"]) == 1
        assert "still" in capsys.readouterr().err
    finally:
        # The worker is holding a build slot; the hub cannot be stopped until it
        # lets go, and the fixture's teardown is what would otherwise hang.
        release.set()
