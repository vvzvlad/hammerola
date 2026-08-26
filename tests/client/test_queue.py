"""`hammerola comments` and `... comments resolve`, against a real queue.

The comments here are POSTED THE WAY A VIEWER POSTS THEM — multipart, no token,
at a build that was published a moment earlier by the client itself — so what
the command prints is a record the hub validated, stored and read back, not a
fixture. That matters more here than anywhere else in this suite: the text comes
from a stranger's keyboard (SPEC 7A.4), and the reason it is safe to print is
that the hub already refused everything that would not be.

WHY THE HUB IN MOST OF THESE IS BUILT WITH `comment_read_token=TOKEN`. The
client keeps ONE secret for the whole system (SPEC §8 entry 26, decided
2026-08-27), and the hub still has two variables until step 0 of the plan
removes the second, so a deployment sets both to the same value. That is the
configuration these tests run in. The one test that does NOT — the last one —
pins the state of the world today: with the two variables set differently, the
queue refuses the token and the message has to name the variable, because
nothing else on the machine tells the reader which of the two is wrong.
"""

import pytest
from harness import PNG_BYTES, TOKEN, comment_payload
from modeldir import make_model

from src.client.cli import main


@pytest.fixture
def hub(hub_factory, monkeypatch):
    """A hub running the way SPEC §8 entry 26 says a deployment runs: one
    secret, spelled into both of the hub's variables."""
    instance = hub_factory(comment_read_token=TOKEN)
    monkeypatch.setenv("HUB_URL", instance.url)
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)
    return instance


def run(model, *args):
    return main(["-C", str(model), *args])


def publish_dev(model):
    assert main(["-C", str(model), "build", "--timeout", "60"]) == 0


def leave_comment(hub, model, pid="demo0001", commit="dev", **extra):
    """Post one comment the way the build page does, and return its id."""
    publish_dev(model)
    reply = hub.post_comment(pid, commit, payload=comment_payload(**extra))
    assert reply.status_code == 201, reply.text
    return reply.json()["id"]


# -- reading -----------------------------------------------------------------
def test_the_queue_shows_what_is_really_in_it(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out

    assert "1 comment on demo0001" in out
    # The id first, because it is the argument `resolve` takes.
    assert cid in out
    assert "the bracket fouls the standoff" in out
    assert "build dev" in out
    assert "part /root/bracket" in out
    assert "view assembled" in out
    assert "hammerola comments resolve" in out


def test_several_comments_are_all_listed(hub, model, capsys):
    first = leave_comment(hub, model, text="the first one")
    second = leave_comment(hub, model, text="the second one")
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "2 comments on demo0001" in out
    for cid in (first, second):
        assert cid in out


def test_an_empty_queue_is_a_success(hub, model, capsys):
    publish_dev(model)
    capsys.readouterr()
    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "no open comments on demo0001" in out
    assert "--all" in out


def test_only_this_projects_queue_is_read(hub, tmp_path, capsys):
    """The queue is per project, and the filter is applied by the hub."""
    mine = make_model(tmp_path / "mine", pid="mine0001")
    theirs = make_model(tmp_path / "theirs", pid="theirs01")
    ours = leave_comment(hub, mine, pid="mine0001", text="about mine")
    yours = leave_comment(hub, theirs, pid="theirs01", text="about theirs")
    capsys.readouterr()

    assert run(mine, "comments") == 0
    out = capsys.readouterr().out
    assert ours in out
    assert yours not in out


def test_an_attachment_is_reported_as_the_url_that_serves_it(hub, model,
                                                             capsys):
    """The bytes are behind the same token as the queue, and a photo of a
    printed part is not something a terminal shows."""
    publish_dev(model)
    reply = hub.post_comment("demo0001", "dev", payload=comment_payload(),
                             photo=("part.png", PNG_BYTES, "image/png"))
    assert reply.status_code == 201, reply.text
    cid = reply.json()["id"]
    capsys.readouterr()

    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert f"{hub.url}/api/v1/comments/{cid}/photo" in out


def test_since_is_the_hubs_filter_and_reaches_it(hub, model, capsys):
    """Applied at the hub, not after the fact — and it is the one filter with a
    format the hub has to normalise, so it is worth sending a real one."""
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "--since", "2000-01-01T00:00:00Z") == 0
    assert cid in capsys.readouterr().out

    assert run(model, "comments", "--since", "2999-01-01T00:00:00Z") == 0
    assert "no open comments" in capsys.readouterr().out


def test_a_since_the_hub_cannot_read_is_a_clean_failure(hub, model, capsys):
    assert run(model, "comments", "--since", "yesterday") == 1
    assert "invalid since" in capsys.readouterr().err


def test_a_comment_of_several_lines_stays_one_comment(hub, model, capsys):
    """Every line of the text is indented, so prose cannot be misread as the
    start of the next entry."""
    leave_comment(hub, model, text="first line\nsecond line")
    capsys.readouterr()
    assert run(model, "comments") == 0
    out = capsys.readouterr().out
    assert "  first line" in out
    assert "  second line" in out


# -- resolving ---------------------------------------------------------------
def test_resolving_closes_it_and_the_next_read_says_so(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()

    assert run(model, "comments", "resolve", cid, "-m", "fixed the standoff") == 0
    assert "resolved" in capsys.readouterr().out

    # Gone from the default listing — which is the point of the command.
    assert run(model, "comments") == 0
    assert "no open comments" in capsys.readouterr().out

    # And still there, with the note, for whoever asks what was done.
    assert run(model, "comments", "--all") == 0
    out = capsys.readouterr().out
    assert cid in out
    assert "resolved" in out
    assert "note: fixed the standoff" in out


def test_a_note_is_optional(hub, model, capsys):
    cid = leave_comment(hub, model)
    capsys.readouterr()
    assert run(model, "comments", "resolve", cid) == 0
    assert run(model, "comments", "--all") == 0
    assert "resolved" in capsys.readouterr().out


def test_resolving_needs_no_project_directory(hub, model, tmp_path, capsys):
    """A comment id is unique across the hub, and whoever closes an item is
    often not sitting in the model that produced it."""
    cid = leave_comment(hub, model)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    capsys.readouterr()
    assert main(["-C", str(elsewhere), "comments", "resolve", cid]) == 0


def test_an_id_the_hub_does_not_have_is_a_clean_failure(hub, model, capsys):
    assert run(model, "comments", "resolve", "0" * 32) == 1
    assert "no comment" in capsys.readouterr().err


# -- failures ----------------------------------------------------------------
def test_an_unreachable_hub_is_a_clean_failure(model, monkeypatch, capsys):
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)
    assert run(model, "comments") == 1
    assert "cannot reach" in capsys.readouterr().err


def test_a_machine_that_has_not_logged_in_is_told_to(hub, model, monkeypatch,
                                                     capsys):
    monkeypatch.delenv("PUBLISH_TOKEN", raising=False)
    assert run(model, "comments") == 1
    assert "hammerola login" in capsys.readouterr().err


def test_a_hub_still_running_two_secrets_names_the_second_one(
        hub_factory, model, monkeypatch, capsys):
    """TODAY'S STATE OF THE WORLD, pinned so it is not discovered in the dark:
    the hub checks COMMENT_READ_TOKEN on this route and PUBLISH_TOKEN on the
    push, and a deployment that has not set them to the same value refuses a
    token that publishes perfectly well. Nothing on the machine says which of
    the two variables is wrong except this message.

    Delete this test — and the sentence it checks — when step 0 of the plan
    merges the two on the hub.
    """
    split = hub_factory(comment_read_token="a-different-secret")
    monkeypatch.setenv("HUB_URL", split.url)
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)

    assert run(model, "comments") == 1
    error = capsys.readouterr().err
    assert "COMMENT_READ_TOKEN" in error
    assert "401" in error
