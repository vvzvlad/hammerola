"""`hammerola rename` and `hammerola rm`, against a real hub.

WHAT THESE ARE REALLY ABOUT is what each command may NOT do, so that is what
most of the tests below assert:

  * `rename` moves the title in two places — `project.json`, which decides what
    the next push carries, and the hub, which decides what the site shows now —
    and it touches the ID in neither. There is no flag for that and there must
    never be one: the id is what every permanent URL of the project is built
    from, and the builds behind those URLs went out with a year of `immutable`;
  * `rm` asks before it acts, removes the whole project rather than a build, and
    deletes nothing on the local disk. The last one is not a nicety: the
    checkout belongs to whoever is running the command, and a tool that removed
    a directory because a server call returned 200 would be a different tool.
"""

import json
from pathlib import Path

import pytest
from harness import TOKEN, comment_payload, copying_builder
from modeldir import make_model

from src.client.cli import main


def titling_builder(project_dir, out_dir, *, pid, **kw):
    """`copying_builder`, plus the one thing a REAL build does with the title.

    The suite's ordinary stand-in publishes the pushed tree unchanged, so the
    meta.json that lands is the one the test wrote — and a real build does not
    work that way: it reads `project.json` and puts that title into the
    meta.json it writes (`cadbuild.project.load_project`, `cadbuild.build`).
    Two tests below are ABOUT that link, so they need a builder that has it;
    asserting it through a stand-in that skips it would be asserting nothing.

    Everything else stays the stand-in's: this suite has no CAD kernel.
    """
    outcome = copying_builder(project_dir, out_dir, pid=pid, **kw)
    meta_path = Path(out_dir) / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    project = json.loads(
        (Path(out_dir) / "project.json").read_text(encoding="utf-8"))
    meta["title"] = project.get("title") or meta.get("title")
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    return outcome


@pytest.fixture(autouse=True)
def configured(monkeypatch, hub):
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("PUBLISH_TOKEN", TOKEN)


def run(model, *args):
    return main(["-C", str(model), *args])


def publish(model, capsys):
    assert run(model, "commit") == 0
    for line in capsys.readouterr().out.splitlines():
        if line.startswith("revision "):
            return line.split()[1].rstrip(":")
    raise AssertionError("no revision was printed")


def project_json(model):
    return json.loads((model / "project.json").read_text())


# -- rename ------------------------------------------------------------------
def test_rename_moves_the_title_in_both_places(hub, model, capsys):
    publish(model, capsys)

    assert run(model, "rename", "The bracket, mk2") == 0
    out = capsys.readouterr().out

    assert project_json(model)["title"] == "The bracket, mk2"
    assert hub.get("/project/demo0001/builds.json").json()["title"] == \
        "The bracket, mk2"
    assert "The bracket, mk2" in out


def test_rename_never_touches_the_id(hub, model, capsys):
    """The whole reason the command exists in this shape. Renaming an id would
    not rename anything — it would abandon the project and start an empty one
    beside it."""
    publish(model, capsys)
    before = project_json(model)["id"]

    assert run(model, "rename", "Something else entirely") == 0
    out = capsys.readouterr().out

    assert project_json(model)["id"] == before
    assert hub.project_dir(before).is_dir()
    assert "the id is unchanged and cannot be changed" in out


def test_there_is_no_way_to_ask_for_an_id_rename(hub, model, capsys):
    """Pinned as a test because "add --id" is the obvious next request, and the
    answer is no rather than not-yet."""
    for attempt in (["rename", "--id", "newid1234"],
                    ["rename", "newid1234", "--id"]):
        with pytest.raises(SystemExit) as raised:
            run(model, *attempt)
        assert raised.value.code == 2
        assert "unrecognized arguments" in capsys.readouterr().err


def test_rename_keeps_everything_else_in_project_json(hub, model, capsys):
    """A project.json is a file people put things in; a rename may not be a
    quiet way of dropping them."""
    payload = project_json(model)
    payload["notes"] = {"printer": "X1C"}
    (model / "project.json").write_text(json.dumps(payload))
    publish(model, capsys)

    assert run(model, "rename", "Renamed") == 0
    capsys.readouterr()
    assert project_json(model)["notes"] == {"printer": "X1C"}


def test_renaming_a_project_that_was_never_pushed_still_works(hub_factory,
                                                              tmp_path, capsys,
                                                              monkeypatch):
    """A project exists on the hub from its first successful push. Renaming one
    that has not been pushed is an ordinary thing to do, and the new name is
    what the first push will carry."""
    building = hub_factory(build_runner=titling_builder)
    monkeypatch.setenv("HUB_URL", building.url)
    model = make_model(tmp_path / "demo")

    assert run(model, "rename", "Not yet published") == 0
    out = capsys.readouterr().out

    assert project_json(model)["title"] == "Not yet published"
    assert "nothing published for this project yet" in out

    assert run(model, "build") == 0
    capsys.readouterr()
    assert building.get("/project/demo0001/builds.json").json()["title"] == \
        "Not yet published"


def test_a_rename_survives_the_next_push_because_the_file_moved_too(
        hub_factory, model, capsys, monkeypatch):
    """The hub takes its title from whatever the newest build declared, and a
    push CLEARS a rename for that reason — so a rename made only on the hub
    would be undone by the next push. Writing `project.json` is what makes it
    stick, and this is the test that the client writes both."""
    building = hub_factory(build_runner=titling_builder)
    monkeypatch.setenv("HUB_URL", building.url)
    publish(model, capsys)

    assert run(model, "rename", "Sticks") == 0
    capsys.readouterr()
    assert building.get("/project/demo0001/builds.json").json()["title"] == \
        "Sticks"

    (model / "model.py").write_text("# another revision\n")
    publish(model, capsys)
    assert building.get("/project/demo0001/builds.json").json()["title"] == \
        "Sticks"


def test_a_title_the_site_would_have_to_render_verbatim_is_refused(hub, model,
                                                                   capsys):
    publish(model, capsys)
    assert run(model, "rename", "two\nlines") == 1
    assert "control character" in capsys.readouterr().err
    assert project_json(model)["title"] == "Demo project"


# -- rm ----------------------------------------------------------------------
def test_rm_removes_the_project_after_the_id_is_typed(hub, model, capsys,
                                                      monkeypatch):
    revision = publish(model, capsys)
    posted = hub.post_comment("demo0001", revision, payload=comment_payload())
    assert posted.status_code == 201

    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")
    assert run(model, "rm") == 0
    out = capsys.readouterr().out

    assert not hub.project_dir("demo0001").exists()
    assert not hub.comment_dir("demo0001").exists()
    assert not (hub.data / "sources" / revision).exists()
    assert "removed demo0001" in out


def test_rm_does_nothing_until_the_id_is_typed(hub, model, capsys, monkeypatch):
    """Not a y/n: a y/n is answered by reflex, and this cannot be undone."""
    revision = publish(model, capsys)

    for answer in ("y", "yes", "", "demo000"):
        monkeypatch.setattr("builtins.input", lambda _prompt, a=answer: a)
        assert run(model, "rm") == 1
        assert "cancelled" in capsys.readouterr().err
        assert hub.project_dir("demo0001").is_dir()
    assert hub.get(f"/project/demo0001/{revision}/meta.json").status_code == 200


def test_rm_yes_skips_the_prompt(hub, model, capsys, monkeypatch):
    publish(model, capsys)

    def refuse(_prompt):
        raise AssertionError("--yes must not ask")

    monkeypatch.setattr("builtins.input", refuse)
    assert run(model, "rm", "--yes") == 0
    capsys.readouterr()
    assert not hub.project_dir("demo0001").exists()


def test_rm_with_nothing_to_read_refuses_rather_than_assuming_yes(hub, model,
                                                                  capsys,
                                                                  monkeypatch):
    publish(model, capsys)

    def eof(_prompt):
        raise EOFError

    monkeypatch.setattr("builtins.input", eof)
    assert run(model, "rm") == 1
    assert "--yes" in capsys.readouterr().err
    assert hub.project_dir("demo0001").is_dir()


def test_rm_leaves_the_local_checkout_alone(hub, model, capsys, monkeypatch):
    """The one thing it must never do. `rm` is a command about the hub."""
    publish(model, capsys)
    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")

    assert run(model, "rm") == 0
    out = capsys.readouterr().out

    assert (model / "project.json").is_file()
    assert (model / "model.py").is_file()
    assert "was NOT touched" in out


def test_rm_says_what_it_is_about_to_remove_before_asking(hub, model, capsys):
    """The prompt is only a safety if what it is confirming has been read."""
    publish(model, capsys)
    asked = {}

    def answer(prompt):
        asked["prompt"] = prompt
        return "no"

    import builtins
    original = builtins.input
    builtins.input = answer
    try:
        assert run(model, "rm") == 1
    finally:
        builtins.input = original

    out = capsys.readouterr().out
    assert "about to remove demo0001" in out
    assert "1 published revisions" in out
    assert "cannot be undone" in out
    assert "project id" in asked["prompt"]


def test_rm_of_a_project_the_hub_never_had_is_a_failure(hub, tmp_path, capsys,
                                                        monkeypatch):
    """Nothing was removed, so the exit code says so — and the local file is
    still there to be deleted by hand if that is what was meant."""
    model = make_model(tmp_path / "demo")
    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")

    assert run(model, "rm") == 1
    assert "no project demo0001" in capsys.readouterr().err
    assert (model / "project.json").is_file()


def test_rm_needs_the_right_secret(hub, model, capsys, monkeypatch):
    publish(model, capsys)
    monkeypatch.setenv("PUBLISH_TOKEN", "not-the-token")
    monkeypatch.setattr("builtins.input", lambda _prompt: "demo0001")

    assert run(model, "rm") == 1
    assert "401" in capsys.readouterr().err
    assert hub.project_dir("demo0001").is_dir()
