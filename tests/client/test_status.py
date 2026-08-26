"""`hammerola status` against a real hub, with real publications behind it.

Every fact this command prints is one the hub worked out — which revision
`latest` resolves to, whether the local slot is occupied, how many revisions
exist — so a test that fed it a hand-written `builds.json` would be checking the
formatter and nothing else. The builds here are therefore published by the
client itself, through the same `build` and `commit` the previous file covers,
and `status` is asked afterwards.

The one thing NOT asserted anywhere below is the last build job, and its absence
is deliberate: the hub cannot be asked for it (see the docstring of
`src/client/status.py`).
"""

import pytest
from harness import TOKEN
from modeldir import make_model

from src.client.cli import main


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args])


def publish(model, *args):
    assert main(["-C", str(model), *args, "--timeout", "60"]) == 0


def revisions_of(hub, pid="demo0001"):
    project = hub.project_dir(pid)
    return sorted(entry.name for entry in project.iterdir()
                  if entry.is_dir() and not entry.is_symlink()
                  and entry.name not in ("dev", "latest"))


# -- a project the hub has never heard of ------------------------------------
def test_a_project_with_nothing_published_is_told_so_and_is_not_a_failure(
        hub, model, capsys):
    """A directory created five minutes ago is in exactly this state; it is an
    answer, not an error."""
    assert run(model, "status") == 0
    out = capsys.readouterr().out
    assert "nothing published yet" in out
    assert f"{hub.url}/project/demo0001/" in out


# -- the ordinary case -------------------------------------------------------
def test_status_shows_latest_the_dev_slot_and_every_revision(hub, model,
                                                             capsys):
    publish(model, "commit", "-m", "first")
    (model / "model.py").write_text("# second\n")
    publish(model, "commit", "-m", "second")
    publish(model, "build")
    capsys.readouterr()

    assert run(model, "status") == 0
    out = capsys.readouterr().out

    published = revisions_of(hub)
    assert len(published) == 2
    for revision in published:
        assert revision in out
    # The newest is the one `latest` resolves to, and the line that says so is
    # what somebody reads this command to find out.
    latest_line = next(line for line in out.splitlines()
                       if line.strip().startswith("latest"))
    assert latest_line.split()[1] in published
    assert "(latest)" in out

    assert "builds  2 published" in out
    dev_line = next(line for line in out.splitlines()
                    if line.strip().startswith("dev"))
    assert "occupied" in dev_line
    # The slot's timestamp is in its own meta and nowhere else, so printing it
    # proves the second request was made and read.
    assert "built" in dev_line


def test_the_project_is_named_by_its_id_and_its_title(hub, model, capsys):
    publish(model, "build")
    capsys.readouterr()
    assert run(model, "status") == 0
    first = capsys.readouterr().out.splitlines()[0]
    assert "demo0001" in first
    assert "Demo project" in first


def test_an_empty_dev_slot_and_no_revision_are_both_said_out_loud(hub, model,
                                                                  capsys):
    """A commit and no local build: `latest` is set, the slot is empty, and
    neither may be silently omitted — an absent line reads as an absent
    feature."""
    publish(model, "commit")
    capsys.readouterr()
    assert run(model, "status") == 0
    out = capsys.readouterr().out
    assert "dev     empty" in out


def test_the_revision_list_is_capped_and_says_what_is_left(hub, model, capsys):
    for marker in ("a", "b", "c"):
        (model / "model.py").write_text(f"# {marker}\n")
        publish(model, "commit")
    capsys.readouterr()

    assert run(model, "status", "-n", "2") == 0
    out = capsys.readouterr().out
    assert "builds  3 published" in out
    assert "and 1 older" in out


# -- failures ----------------------------------------------------------------
def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    assert run(model, "status") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_machine_that_has_not_logged_in_is_told_to(model, monkeypatch,
                                                     capsys):
    monkeypatch.delenv("PUBLISH_TOKEN", raising=False)
    assert run(model, "status") == 1
    error = capsys.readouterr().err
    assert "PUBLISH_TOKEN is not set" in error
    assert "hammerola login" in error


def test_status_outside_a_project_says_which_file_is_missing(tmp_path, capsys):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    assert main(["-C", str(elsewhere), "status"]) == 1
    assert "project.json" in capsys.readouterr().err


def test_a_project_id_the_hub_would_refuse_is_refused_here(tmp_path, capsys):
    model = make_model(tmp_path / "demo")
    (model / "project.json").write_text('{"id": "../escape"}')
    assert run(model, "status") == 1
    assert "../escape" in capsys.readouterr().err
