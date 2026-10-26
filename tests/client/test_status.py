"""`hammerola status` against a real hub, with real publications behind it.

Every fact this command prints is one the hub worked out — which revision
`latest` resolves to, whether the local slot is occupied, how many revisions
exist — so a test that fed it a hand-written `builds.json` would be checking the
formatter and nothing else. The builds here are therefore published through
the hub's own queue (`harness.Hub.publish`), and `status` is asked afterwards.

The one thing NOT asserted anywhere below is the last build job, and its absence
is deliberate: the hub cannot be asked for it (see the docstring of
`hammerola/status.py`).
"""

import shutil

import pytest
from modeldir import make_model, publish_model

from hammerola import hub as hub_module
from hammerola.cli import main

# The address and the token, from tests/client/conftest.py.
pytestmark = pytest.mark.usefixtures("configured")


def run(model, *args):
    return main(["-C", str(model), *args])


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


def test_status_reads_through_a_password_proxy(password_proxy, model,
                                               monkeypatch, capsys):
    """The reading verbs share one handle (`sources.hub_for`), and it carries
    `HUB_BASIC_AUTH` too: `builds.json` is behind the proxy and the token. A
    wrong login is named as the proxy's, not as a status the hub answered."""
    monkeypatch.setenv("HUB_URL", password_proxy.url)
    monkeypatch.setenv("HUB_BASIC_AUTH", password_proxy.basic_auth)
    assert run(model, "status") == 0
    assert "nothing published yet" in capsys.readouterr().out

    monkeypatch.setenv("HUB_BASIC_AUTH", "zlo:not-the-password")
    assert run(model, "status") == 1
    assert hub_module.PROXY_REFUSED in capsys.readouterr().err


# -- the ordinary case -------------------------------------------------------
def test_the_client_runs_in_the_current_directory_too(hub, model, monkeypatch,
                                                       capsys):
    """-C is a convenience; the ordinary invocation has no arguments at all."""
    monkeypatch.chdir(model)
    assert main(["status"]) == 0
    assert f"{hub.url}/project/demo0001/" in capsys.readouterr().out


def test_status_shows_latest_the_dev_slot_and_every_revision(hub, model,
                                                             capsys):
    publish_model(hub, model)
    (model / "model.py").write_text("# second\n")
    publish_model(hub, model)
    publish_model(hub, model, "dev")

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
    publish_model(hub, model, "dev")
    assert run(model, "status") == 0
    first = capsys.readouterr().out.splitlines()[0]
    assert "demo0001" in first
    assert "Demo project" in first


def test_an_empty_dev_slot_is_said_out_loud(hub, model, capsys):
    """An empty slot is a LINE reading `empty`, not a missing line — an absent
    one reads as an absent feature.

    A revision fills the slot with itself, so the state has to be made
    rather than published into: the slot goes off the volume, and a rename is
    what rewrites the picker without publishing anything back into it.
    """
    publish_model(hub, model)
    shutil.rmtree(hub.project_dir("demo0001") / "dev")
    assert run(model, "rename", "Demo project") == 0
    capsys.readouterr()
    assert run(model, "status") == 0
    out = capsys.readouterr().out
    assert "dev     empty" in out


def test_the_revision_list_is_capped_and_says_what_is_left(hub, model, capsys):
    for marker in ("a", "b", "c"):
        (model / "model.py").write_text(f"# {marker}\n")
        publish_model(hub, model)

    assert run(model, "status", "-n", "2") == 0
    out = capsys.readouterr().out
    assert "builds  3 published" in out
    assert "and 1 older" in out


@pytest.mark.parametrize("count", ["0", "-3"])
def test_a_count_a_slice_would_misread_is_refused(model, capsys, count):
    """Zero and negative counts are refused.

    `0` is falsy, so it would fall through to the default and list ten
    revisions to somebody who asked for none; a negative one in
    `builds[:limit]` is read from the other end — `-3` drops the three OLDEST.
    """
    assert run(model, "status", "-n", count) == 1
    error = capsys.readouterr().err
    assert "1 or more" in error


def test_a_count_is_checked_before_the_hub_is_asked_anything(tmp_path, capsys,
                                                             monkeypatch):
    """No project, no reachable hub, and the refusal is still about `-n`: the
    check happens on the argument, before anything is looked up."""
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    assert main(["-C", str(elsewhere), "status", "-n", "0"]) == 1
    assert "1 or more" in capsys.readouterr().err


# -- failures ----------------------------------------------------------------
def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    assert run(model, "status") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_machine_that_has_not_logged_in_is_told_to(model, monkeypatch,
                                                     capsys):
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    assert run(model, "status") == 1
    error = capsys.readouterr().err
    assert "EDIT_TOKEN is not set" in error
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
