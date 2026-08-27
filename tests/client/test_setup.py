"""`hammerola login` and `hammerola create` — the two commands run once.

Both are checked against the things that would be silent if they broke. For
`login` that is the FILE: the mode it lands with, and everything already in it
that has to survive — a password stored world-readable and a config quietly
truncated both keep working for months. For `create` it is the REFUSAL to write
over an existing id, and the fact that the id it mints is one the real hub
accepts: a client that generated an id the hub's alphabet rejects would fail on
the first push of every new project, which is the one push nobody has a working
one to compare against.

The password never appears in an argument here either, exactly as it never does
in real use: the prompt is driven by replacing `getpass`.
"""

import json
import os

import pytest
from harness import TOKEN
from modeldir import make_model

from src.client import config
from src.client.cli import main


@pytest.fixture
def env_file(tmp_path, monkeypatch):
    """Where this test's `login` writes. Never the developer's own file."""
    path = tmp_path / "machine" / "env"
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(path))
    return path


@pytest.fixture
def answers(monkeypatch):
    """Drive the two prompts. -> a dict the test fills in.

    `getpass` is replaced rather than fed on stdin because that is what the code
    calls, and the whole reason it calls it is that the password must not arrive
    any other way — a test that passed it as an argument would be testing an
    interface this tool deliberately does not have.
    """
    given = {"address": "", "password": TOKEN}
    monkeypatch.setattr("src.client.setup.getpass.getpass",
                        lambda *_a, **_kw: given["password"])
    monkeypatch.setattr("builtins.input", lambda *_a, **_kw: given["address"])
    return given


def mode_of(path) -> int:
    return os.stat(path).st_mode & 0o777


# -- login -------------------------------------------------------------------
def test_login_stores_both_settings_in_a_file_only_this_account_can_read(
        hub, env_file, answers, capsys):
    assert main(["login", hub.url]) == 0

    stored = config.parse_env_file(env_file)
    assert stored["HUB_URL"] == hub.url
    assert stored["EDIT_TOKEN"] == TOKEN
    # THE POINT OF THE COMMAND, and the thing that is invisible when it breaks:
    # the file holds the one secret of the whole system.
    assert mode_of(env_file) == 0o600

    out = capsys.readouterr().out
    assert TOKEN not in out
    assert str(len(TOKEN)) in out


def test_login_creates_its_directory_narrowly(tmp_path, hub, monkeypatch,
                                              answers):
    """A 0600 file inside a 0755 directory is still a file whose NAME and
    mtime anybody on the machine can read; the directory is created for this
    and gets the same treatment."""
    path = tmp_path / "fresh" / "hammerola" / "env"
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(path))
    assert main(["login", hub.url]) == 0
    assert mode_of(path.parent) == 0o700


def test_login_keeps_everything_else_in_the_file(hub, env_file, answers):
    """The file is the machine's, not this command's: a login rewrites two
    lines and leaves the rest — comments included — exactly where they were."""
    env_file.parent.mkdir(parents=True)
    env_file.write_text(
        "# my hub\n"
        "HUB_URL=https://the-old-one.example\n"
        "SOMETHING_ELSE=keep me\n",
        encoding="utf-8")

    assert main(["login", hub.url]) == 0

    text = env_file.read_text(encoding="utf-8")
    assert "# my hub" in text
    stored = config.parse_env_file(env_file)
    assert stored["SOMETHING_ELSE"] == "keep me"
    assert stored["HUB_URL"] == hub.url
    # Rewritten in place rather than appended twice, or the file grows a second
    # HUB_URL on every login and the parser then answers with the first.
    assert text.count("HUB_URL=") == 1


def test_login_rewrites_an_exported_line_as_an_exported_line(hub, env_file,
                                                             answers):
    """The file is also something a person can `source`."""
    env_file.parent.mkdir(parents=True)
    env_file.write_text("export EDIT_TOKEN=old\n", encoding="utf-8")
    assert main(["login", hub.url]) == 0
    assert "export EDIT_TOKEN=" in env_file.read_text(encoding="utf-8")


def test_the_address_is_asked_for_when_it_is_not_given(hub, env_file, answers):
    answers["address"] = hub.url
    assert main(["login"]) == 0
    assert config.parse_env_file(env_file)["HUB_URL"] == hub.url


def test_a_wrong_password_is_refused_and_nothing_is_stored(hub, env_file,
                                                           answers, capsys):
    """Checked BEFORE it is written, so the typo is found at the prompt and not
    minutes into a build somebody was waiting for."""
    answers["password"] = "not-the-token"
    assert main(["login", hub.url]) == 1
    assert "refused" in capsys.readouterr().err
    assert not env_file.exists()


def test_a_hub_that_cannot_be_reached_stores_nothing(env_file, answers, capsys):
    assert main(["login", "http://127.0.0.1:1"]) == 1
    error = capsys.readouterr().err
    assert "cannot reach" in error
    assert "Nothing was saved" in error
    assert not env_file.exists()


def test_an_address_without_a_scheme_is_refused_before_anything_else(
        env_file, answers, capsys):
    assert main(["login", "hub.example"]) == 1
    assert "https://hub.example" in capsys.readouterr().err
    assert not env_file.exists()


def test_an_empty_password_is_refused(hub, env_file, answers, capsys):
    answers["password"] = ""
    assert main(["login", hub.url]) == 1
    assert "no password" in capsys.readouterr().err
    assert not env_file.exists()


def test_a_password_that_would_not_read_back_leaves_the_old_one_alone(
        hub, env_file, answers, capsys):
    """The check happens on the text BEFORE it is written, so the config still
    holds what it held. Quotes are the case that reaches it: the parser strips
    one layer of them, so a password that is quoted at both ends would come
    back as something else."""
    env_file.parent.mkdir(parents=True)
    env_file.write_text("EDIT_TOKEN=the-old-one\n", encoding="utf-8")
    answers["password"] = "'quoted'"

    assert main(["login", hub.url]) == 1
    assert "cannot be stored" in capsys.readouterr().err
    assert config.parse_env_file(env_file)["EDIT_TOKEN"] == "the-old-one"


def test_login_says_when_the_environment_will_shadow_what_it_wrote(
        hub, env_file, answers, monkeypatch, capsys):
    """The one way a correct login still publishes to the wrong hub: `resolve`
    takes the environment first, on purpose."""
    monkeypatch.setenv("HUB_URL", "https://somewhere-else.example")
    assert main(["login", hub.url]) == 0
    assert "wins over the file" in capsys.readouterr().out


def test_a_password_the_file_format_cannot_carry_is_refused_without_echoing_it(
        hub, env_file, answers, capsys):
    answers["password"] = "two\nlines"
    assert main(["login", hub.url]) == 1
    error = capsys.readouterr().err
    assert "line break" in error
    assert "two" not in error


# -- create ------------------------------------------------------------------
def test_create_writes_a_fresh_id_and_takes_the_directory_name_as_the_title(
        tmp_path, capsys):
    root = tmp_path / "t13-ceiling-mount"
    assert main(["-C", str(root), "create"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload["title"] == "t13-ceiling-mount"
    # SPEC 3.1: twelve hex characters, minted locally.
    assert len(payload["id"]) == 12
    assert all(c in "0123456789abcdef" for c in payload["id"])
    assert payload["id"] in capsys.readouterr().out


def test_two_projects_do_not_get_the_same_id(tmp_path):
    assert main(["-C", str(tmp_path / "a"), "create"]) == 0
    assert main(["-C", str(tmp_path / "b"), "create"]) == 0
    ids = {json.loads((tmp_path / name / "project.json").read_text())["id"]
           for name in ("a", "b")}
    assert len(ids) == 2


def test_the_title_can_be_given(tmp_path):
    root = tmp_path / "demo"
    assert main(["-C", str(root), "create", "--title", "T13 ceiling mount"]) == 0
    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload["title"] == "T13 ceiling mount"


def test_create_refuses_over_an_existing_project(tmp_path, capsys):
    """The id is the only link between this directory and everything the hub
    has published for it. Replacing it silently would not fail anything — the
    next push would land in a new, empty project."""
    root = make_model(tmp_path / "demo", pid="demo0001")
    assert main(["-C", str(root), "create"]) == 1
    assert "already exists" in capsys.readouterr().err
    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload["id"] == "demo0001"


def test_create_refuses_inside_an_existing_project(tmp_path, capsys):
    """The case the refusal above cannot see, and the one that costs something.

    In a SUBDIRECTORY there is no file to overwrite, so nothing fails: a second
    id is minted, `find_project_root` walks up and stops at the nearest
    project.json — now the inner one — and every command run from there
    addresses a project the hub has nothing for. The next `build` publishes a
    subtree of the model under it.
    """
    root = make_model(tmp_path / "demo", pid="demo0001")
    inner = root / "scripts"
    inner.mkdir()

    assert main(["-C", str(inner), "create"]) == 1
    error = capsys.readouterr().err
    assert "already inside the project" in error
    # Names WHICH project, because "you are inside one" is only actionable if it
    # says which one.
    assert str(root.resolve()) in error
    assert not (inner / "project.json").exists()


def test_create_still_works_in_a_directory_that_is_not_inside_a_project(tmp_path):
    """The refusal above must not spread to the ordinary case: a new project
    next to an old one, sharing nothing but a parent directory."""
    make_model(tmp_path / "old", pid="demo0001")
    assert main(["-C", str(tmp_path / "new"), "create"]) == 0
    assert (tmp_path / "new" / "project.json").is_file()


def test_a_created_project_is_one_the_hub_accepts(hub, tmp_path, monkeypatch):
    """End to end, because the alphabet is the hub's: an id this tool minted
    and the hub refuses would break the first push of every new project."""
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)

    root = make_model(tmp_path / "demo")
    (root / "project.json").unlink()
    assert main(["-C", str(root), "create", "--title", "Fresh"]) == 0

    pid = json.loads((root / "project.json").read_text(encoding="utf-8"))["id"]
    assert main(["-C", str(root), "build", "--timeout", "60"]) == 0
    assert (hub.project_dir(pid) / "dev" / "model.py").is_file()
