"""`hammerola skill` and `skill update` — the verb that dates the instructions.

WHAT IS WORTH PINNING HERE, in the order it would hurt to get wrong:

  * the COMPARISON, because a wrong answer to it is silent in both directions —
    "up to date" about a stale file teaches yesterday for another month, and
    "out of date" about a current one sends somebody to overwrite what they
    have. Neither fails anything anywhere else (issue #51);
  * that a MISSING file is not an error. It is the first state every machine is
    in, and a non-zero exit for it would make the ordinary case look broken;
  * that `update` writes where it was told, in BOTH argument orders. The flag
    sits on two parsers and argparse quietly prefers the inner one's default,
    which would put somebody's file in a place they did not name.

NOTHING HERE TOUCHES THE DEVELOPER'S `~/.claude`, and it is held that way twice
over. Nearly every test passes `--path` into `tmp_path`, because the default is
a real file on the machine running the suite and a test that wrote it would
replace the author's own instructions with whatever this hub happened to serve.
But a flag is discipline, so this directory's conftest also substitutes HOME —
and the one test below that runs the default path on purpose is what proves the
substitution is doing its job.

The hub is the REAL one over a real socket, like the rest of this directory —
the two halves of this contract are a route and a client, and the whole reason
the client lives in this repository is that no test could see both while they
lived in two.
"""

from pathlib import Path

import pytest
from harness import TOKEN

from src import onboarding
from hammerola import config, skill, sources
from hammerola.cli import main


@pytest.fixture
def installed(tmp_path):
    """Where these tests pretend the agent's skill lives. NEVER `~/.claude`.

    Two directories deep and neither of them created, because that is the state
    a fresh machine is in and `update` has to make them.
    """
    return tmp_path / "skills" / "hammerola" / "SKILL.md"


@pytest.fixture
def configured(hub, monkeypatch):
    """A machine that knows where its hub is — and holds no token.

    The conftest here has already taken `EDIT_TOKEN` out of the environment, so
    every test in this file also states, by passing, that these two commands
    need no secret: `/start` and the file it names are public on purpose.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    return hub


def shipped() -> str:
    """The skill as this checkout has it — the same bytes the hub serves."""
    return onboarding.SKILL_FILE.read_text(encoding="utf-8")


def dated(version) -> str:
    """A minimal skill document carrying `version` — or none at all."""
    line = "" if version is None else f"version: {version}\n"
    return f"---\nname: hammerola\ndescription: x\n{line}---\n\nbody\n"


# -- reading a version out of a file -----------------------------------------
@pytest.mark.parametrize("text,expected", [
    (dated(1), 1),
    (dated(12), 12),
    (dated(None), None),
    ("# not a skill at all\n", None),
    ("", None),
    # THE SHARP ONE: a `version:` line in the BODY is not the frontmatter's, and
    # a pattern that searched the whole document would date a file by a sentence
    # somebody wrote about versions.
    ("---\nname: hammerola\n---\n\nversion: 99\n", None),
])
def test_the_version_is_read_out_of_the_frontmatter_and_only_there(text,
                                                                   expected):
    assert skill.version_of(text) == expected


def test_the_shipped_skill_is_dated():
    """The file this repository serves has a version, so `skill` can compare it
    at all. A skill that lost the key would leave every reader "before
    versioning" forever, with nothing else going red."""
    assert skill.version_of(shipped()) == onboarding.skill_version()


def test_the_default_path_is_the_one_the_skill_tells_a_reader_to_write():
    """TWO PLACES SPELL THAT PATH and they have to be the same characters: the
    `curl -o` in the skill's own setup block, and the default this command
    reads. If they drift, `hammerola skill` reports on a file nobody installed
    while the real one goes stale beside it."""
    assert skill.DEFAULT_PATH == "~/.claude/skills/hammerola/SKILL.md"
    assert skill.DEFAULT_PATH in shipped()


# -- what `hammerola skill` says ---------------------------------------------
def test_a_skill_that_is_not_installed_is_reported_and_is_not_a_failure(
        configured, installed, capsys):
    """The state every machine starts in. It says where the file would go, so
    the answer is actionable rather than merely true."""
    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "not installed" in out
    assert config.display_path(installed) in out
    assert "hammerola skill update" in out
    assert not installed.exists(), "a question wrote a file"


def test_the_same_version_on_both_sides_says_so(configured, installed, capsys):
    installed.parent.mkdir(parents=True)
    installed.write_text(shipped(), encoding="utf-8")

    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "up to date" in out
    assert f"version {onboarding.skill_version()}" in out
    assert "hammerola skill update" not in out, (
        "a current copy was told to update itself")


def test_an_older_copy_is_told_exactly_what_to_run(configured, installed,
                                                   capsys):
    """The point of the whole verb: the one line somebody acts on."""
    installed.parent.mkdir(parents=True)
    installed.write_text(dated(0), encoding="utf-8")

    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "out of date" in out
    assert "hammerola skill update" in out
    assert "version 0" in out
    assert f"version {onboarding.skill_version()}" in out


def test_a_copy_from_before_versioning_is_named_as_one(configured, installed,
                                                       capsys):
    """A file installed before the version existed. Not an error and not
    "up to date" either: it is undatable, which is its own sentence."""
    installed.parent.mkdir(parents=True)
    installed.write_text(dated(None), encoding="utf-8")

    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "no version" in out
    assert "hammerola skill update" in out


def test_a_hub_that_cannot_be_reached_still_says_what_is_installed(
        monkeypatch, installed, capsys):
    """WHY THE LOCAL LINE IS PRINTED FIRST. Half the answer needs no hub, and a
    machine on a train gets that half — the refusal lands under it rather than
    instead of it."""
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    installed.parent.mkdir(parents=True)
    installed.write_text(dated(3), encoding="utf-8")

    assert main(["skill", "--path", str(installed)]) == 1

    captured = capsys.readouterr()
    assert "version 3 installed" in captured.out
    assert "cannot reach" in captured.err


# -- what `hammerola skill update` does --------------------------------------
def test_update_writes_the_hubs_copy_and_makes_the_directory_for_it(
        configured, installed, capsys):
    assert not installed.parent.exists()

    assert main(["skill", "update", "--path", str(installed)]) == 0

    assert installed.read_bytes() == configured.get("/start/skill.md").content
    out = capsys.readouterr().out
    assert config.display_path(installed) in out
    assert "nothing installed" in out
    assert f"version {onboarding.skill_version()}" in out


def test_update_replaces_an_older_copy_and_says_what_it_went_from(
        configured, installed, capsys):
    installed.parent.mkdir(parents=True)
    installed.write_text(dated(0), encoding="utf-8")

    assert main(["skill", "update", "--path", str(installed)]) == 0

    assert skill.version_of(installed.read_text(encoding="utf-8")) == \
        onboarding.skill_version()
    out = capsys.readouterr().out
    assert "version 0" in out
    assert f"-> version {onboarding.skill_version()}" in out


def test_update_over_a_current_copy_says_it_was_unchanged(configured,
                                                          installed, capsys):
    """It writes anyway — the verb is "make this the hub's copy", not "apply a
    difference" — and the output says the version did not move, so a re-run
    does not read like it fixed something."""
    installed.parent.mkdir(parents=True)
    installed.write_text(shipped(), encoding="utf-8")

    assert main(["skill", "update", "--path", str(installed)]) == 0

    assert installed.read_text(encoding="utf-8") == shipped()
    assert "unchanged" in capsys.readouterr().out


def test_update_with_no_path_writes_where_the_default_points(configured,
                                                             tmp_path, capsys):
    """THE ONE TEST THAT LETS THE DEFAULT RUN, and it is two things at once.

    It covers the branch every other test here steps around: `_path` falls back
    to `DEFAULT_PATH` and expands the `~`, and with a flag always present that
    line was never executed by anything.

    And it is the standing proof that the home substitution in this directory's
    conftest works. Without it this call would write over the instructions of
    whoever is running the suite — quietly, with a green run — which is exactly
    the accident a forgotten `--path` in some future test would cause.
    """
    home = Path.home()
    assert home.is_relative_to(tmp_path), (
        "HOME is not the one this directory's conftest substitutes, so "
        "`skill update` is about to write over a real ~/.claude")

    assert main(["skill", "update"]) == 0

    written = Path(skill.DEFAULT_PATH).expanduser()
    assert written.read_bytes() == configured.get("/start/skill.md").content
    # Spelled out as well as expanded, so a DEFAULT_PATH that moved somewhere
    # else under the same home would still be caught here.
    assert written == home / ".claude" / "skills" / "hammerola" / "SKILL.md"
    assert config.display_path(written) in capsys.readouterr().out


@pytest.mark.parametrize("argv", [
    ["skill", "update", "--path", "{path}"],
    ["skill", "--path", "{path}", "update"],
])
def test_the_path_is_honoured_whichever_side_of_the_subcommand_it_is_on(
        configured, installed, argv):
    """ARGPARSE COPIES A SUBPARSER'S DEFAULTS OVER THE PARENT'S VALUES, so the
    second form quietly wrote to `~/.claude` while accepting the flag. The fix
    is `default=argparse.SUPPRESS` on the inner one (`cli.build_parser`), and
    this is what holds it: the failure has no other symptom, since the file it
    lands in is a real one on the machine running the suite."""
    assert main([part.format(path=installed) for part in argv]) == 0
    assert installed.is_file()


def test_update_refuses_a_document_it_cannot_read_a_version_out_of(
        configured, installed, monkeypatch, capsys):
    """CHECKED BEFORE IT IS WRITTEN. A proxy's login page, or an error document
    served with a 200, would otherwise land on disk AS the agent's instructions
    — and the only later symptom is `skill` saying the file names no version.

    Only the FILE route is doctored: the manifest still answers, so what is
    under test is the client's reading of what came back rather than a hub that
    is down.
    """
    monkeypatch.setattr(onboarding, "skill_bytes", lambda: b"<html>hello\n")
    assert configured.get("/start").status_code == 200, (
        "the premise is gone: the manifest went down with the file, so this "
        "no longer reaches the client's reading of what came back")
    installed.parent.mkdir(parents=True)
    installed.write_text(dated(0), encoding="utf-8")

    assert main(["skill", "update", "--path", str(installed)]) == 1

    assert "Nothing was written" in capsys.readouterr().err
    assert skill.version_of(installed.read_text(encoding="utf-8")) == 0


def test_neither_verb_presents_a_secret(configured, installed, monkeypatch):
    """NO `Authorization` GOES OUT, which is what lets the reader of the
    instructions fetch them before anybody has handed them a password.

    Asserted on the token the commands construct their `Hub` with, and not by
    watching the hub answer: `/start` and the file it names are public, so a
    request carrying a secret would be answered exactly the same way and the
    experiment would prove nothing. A wrong value is put in the environment so
    that "never read" is what passes rather than "there was nothing to read".

    Watched where the handle is BUILT, which since #108 is
    `sources.public_hub` — both verbs reach it through that one factory, and a
    token creeping into it would be a secret presented by `create` and `update`
    as well.
    """
    presented = []
    real = sources.Hub

    class Watched(real):
        def __init__(self, url, token, **kw):
            presented.append(token)
            super().__init__(url, token, **kw)

    monkeypatch.setattr(sources, "Hub", Watched)
    monkeypatch.setenv("EDIT_TOKEN", "not-" + TOKEN)

    assert main(["skill", "update", "--path", str(installed)]) == 0
    assert main(["skill", "--path", str(installed)]) == 0
    assert presented == ["", ""]
