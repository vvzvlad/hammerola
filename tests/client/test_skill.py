"""`hammerola skill` and `skill update` — the verb that dates the instructions.

What is worth pinning here, in the order it would hurt to get wrong:

  * the COMPARISON, because a wrong answer to it is silent in both directions —
    "up to date" about a stale file teaches yesterday for another month, and
    "out of date" about a current one sends somebody to overwrite what they
    have. Neither fails anything anywhere else;
  * that a MISSING file is not an error. It is the first state every machine is
    in, and a non-zero exit for it would make the ordinary case look broken;
  * that `update` writes where it was told, in BOTH argument orders. The flag
    sits on two parsers and argparse quietly prefers the inner one's default,
    which would put somebody's file in a place they did not name.

Nothing here touches the developer's `~/.claude`, held that way twice over. Nearly every test passes `--path` into `tmp_path`, because the default is
a real file on the machine running the suite and a test that wrote it would
replace the author's own instructions with whatever this hub happened to serve.
But a flag is discipline, so this directory's conftest also substitutes HOME —
and the one test below that runs the default path on purpose is what proves the
substitution is doing its job.

The hub is the REAL one over a real socket, like the rest of this directory —
the two halves of this contract are a route and a client.
"""

import io
import shutil
import tarfile
from pathlib import Path

import pytest
from harness import TOKEN, one_text, skill_files

from src import onboarding
from hammerola import config, skill, sources
from hammerola import hub as hub_module
from hammerola.cli import main


@pytest.fixture
def installed(tmp_path):
    """The DIRECTORY these tests pretend the agent's skill lives in. NEVER `~/.claude`.

    Two directories deep and neither of them created, because that is the state
    a fresh machine is in and `update` has to make them.
    """
    return tmp_path / "skills" / "hammerola"


def plant(directory: Path, text: str, **others) -> None:
    """An installed skill: an entry document, plus whatever else is lying there."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / skill.ENTRY).write_text(text, encoding="utf-8")
    for name, body in others.items():
        path = directory.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")


def archive(files: dict) -> bytes:
    """`{member: text}` as the .tar.gz a hub would serve, for a doctored one."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return raw.getvalue()


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
    """The entry document as this checkout has it — the hub serves these bytes."""
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
    directory the skill's own setup block names, and the default this command
    writes. If they drift, `hammerola skill` reports on a directory nobody
    installed while the real one goes stale beside it."""
    assert skill.DEFAULT_PATH == "~/.claude/skills/hammerola"
    assert skill.DEFAULT_PATH in one_text(skill_files())


# -- what `hammerola skill` says ---------------------------------------------
def test_a_skill_that_is_not_installed_is_reported_and_is_not_a_failure(
        configured, installed, capsys):
    """The state every machine starts in. It says where the file would go, so
    the answer is actionable rather than merely true."""
    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "not installed" in out
    assert config.display_path(installed / skill.ENTRY) in out
    assert "hammerola skill update" in out
    assert not installed.exists(), "a question made a directory"


def test_the_same_version_on_both_sides_says_so(configured, installed, capsys):
    plant(installed, shipped())

    assert main(["skill", "--path", str(installed)]) == 0

    out = capsys.readouterr().out
    assert "up to date" in out
    assert f"version {onboarding.skill_version()}" in out
    assert "hammerola skill update" not in out, (
        "a current copy was told to update itself")


def test_an_older_copy_is_told_exactly_what_to_run(configured, installed,
                                                   capsys):
    """The point of the whole verb: the one line somebody acts on."""
    plant(installed, dated(0))

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
    plant(installed, dated(None))

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
    plant(installed, dated(3))

    assert main(["skill", "--path", str(installed)]) == 1

    captured = capsys.readouterr()
    assert "version 3 installed" in captured.out
    assert "cannot reach" in captured.err


def test_skill_asks_through_a_password_proxy(password_proxy, installed,
                                             monkeypatch, capsys):
    """`/start` is public to the hub and not to a password proxy in front of
    it: the right `HUB_BASIC_AUTH` gets the answer, and a wrong one is named
    as the proxy's refusal rather than as a hub without the route."""
    monkeypatch.setenv("HUB_URL", password_proxy.url)
    monkeypatch.setenv("HUB_BASIC_AUTH", password_proxy.basic_auth)
    assert main(["skill", "--path", str(installed)]) == 0

    monkeypatch.setenv("HUB_BASIC_AUTH", "zlo:not-the-password")
    assert main(["skill", "--path", str(installed)]) == 1
    assert hub_module.PROXY_REFUSED in capsys.readouterr().err


# -- what `hammerola skill update` does --------------------------------------
def test_update_writes_the_whole_set_and_makes_the_directory_for_it(
        configured, installed, capsys):
    """Every document of the skill, under the paths the entry one points at.

    The references are what the entry document SENDS A READER TO, so a copy
    that arrived without them is an install whose own links lead nowhere.
    """
    assert not installed.exists()

    assert main(["skill", "update", "--path", str(installed)]) == 0

    on_disk = {path.relative_to(installed).as_posix(): path.read_text(
        encoding="utf-8") for path in installed.rglob("*") if path.is_file()}
    assert on_disk == skill_files()
    out = capsys.readouterr().out
    assert config.display_path(installed) in out
    assert "nothing installed" in out
    assert f"version {onboarding.skill_version()}" in out


def test_update_replaces_an_older_copy_and_says_what_it_went_from(
        configured, installed, capsys):
    plant(installed, dated(0))

    assert main(["skill", "update", "--path", str(installed)]) == 0

    entry = (installed / skill.ENTRY).read_text(encoding="utf-8")
    assert skill.version_of(entry) == onboarding.skill_version()
    out = capsys.readouterr().out
    assert "version 0" in out
    assert f"-> version {onboarding.skill_version()}" in out


def test_update_removes_what_this_version_does_not_have(configured, installed,
                                                        capsys):
    """THE REASON THE DIRECTORY BELONGS TO THE SKILL, not to whoever edits it.

    A reference withdrawn in a later version would otherwise sit there being
    read: an agent finds it with `ls`, and a rule that was taken back reads as
    one that still stands, with a current entry document beside it saying
    nothing about it. The removals are printed, because a verb that deletes
    says what it deleted.
    """
    plant(installed, dated(0), **{"references/withdrawn.md": "an old rule\n"})

    assert main(["skill", "update", "--path", str(installed)]) == 0

    assert not (installed / "references" / "withdrawn.md").exists()
    on_disk = {path.relative_to(installed).as_posix() for path in
               installed.rglob("*") if path.is_file()}
    assert on_disk == set(skill_files())
    assert "references/withdrawn.md" in capsys.readouterr().out


def test_update_into_the_skills_directory_itself_refuses(configured, installed,
                                                         capsys):
    """`--path ~/.claude/skills` is a typo one level up, and it is refused.

    That directory holds every skill the agent has. Written into, it would hold
    our entry document among them, and the run after it would read the place as
    our installation and remove the others as stale. Both runs are asserted:
    the second is the one the accident needs.
    """
    stranger = installed / "konnect"
    stranger.mkdir(parents=True)
    (stranger / "SKILL.md").write_text("another skill\n", encoding="utf-8")

    for run in ("first", "second"):
        assert main(["skill", "update", "--path", str(installed)]) == 1, \
            f"the {run} run wrote into the skills directory"
        assert "konnect" in capsys.readouterr().err
        assert (stranger / "SKILL.md").read_text(encoding="utf-8") == \
            "another skill\n"
        assert not (installed / "SKILL.md").exists()


def test_update_over_somebody_elses_skill_refuses_and_writes_nothing(
        configured, installed, capsys):
    """`--path` at a skill somebody else wrote is refused, both times.

    It has an entry document like ours and references like ours; what it does
    not have is our name in it. Writing our document there would gain nothing
    AND would make the directory look like ours to the next run, which would
    then sweep their files — so the refusal is what keeps the second run out,
    and the second run is asserted here rather than assumed.
    """
    installed.mkdir(parents=True, exist_ok=True)
    theirs = "---\nname: konnect\nversion: 4\n---\n\nnot ours\n"
    (installed / "SKILL.md").write_text(theirs, encoding="utf-8")
    (installed / "references").mkdir()
    (installed / "references" / "wiring.md").write_text("theirs\n",
                                                        encoding="utf-8")

    for run in ("first", "second"):
        assert main(["skill", "update", "--path", str(installed)]) == 1, \
            f"the {run} run did not refuse"
        out = capsys.readouterr()
        assert "another skill's" in out.err
        assert (installed / "SKILL.md").read_text(encoding="utf-8") == theirs
        assert (installed / "references" / "wiring.md").read_text(
            encoding="utf-8") == "theirs\n"
        assert not (installed / "references" / "brief.md").exists()


def test_update_into_a_directory_of_files_that_are_not_a_skill_refuses(
        configured, installed, capsys):
    """Somebody's folder is refused BEFORE the first write, not after it.

    A directory with no entry document at all is the other way into the same
    accident: written into once, it holds our document, and the run after that
    reads it as our installation and removes everything beside it as stale. So
    occupied-and-not-ours is refused, twice over — and the refusal LISTS what
    it found, because the surprising case is one `ls` shows as empty.
    """
    installed.mkdir(parents=True, exist_ok=True)
    (installed / ".DS_Store").write_bytes(b"\x00")
    (installed / "notes.txt").write_text("somebody's\n", encoding="utf-8")

    for run in ("first", "second"):
        assert main(["skill", "update", "--path", str(installed)]) == 1, \
            f"the {run} run did not refuse"
        error = capsys.readouterr().err
        assert ".DS_Store" in error and "notes.txt" in error
        assert (installed / "notes.txt").exists()
        assert not (installed / "SKILL.md").exists()


def test_update_over_an_entry_document_it_cannot_read_names_the_way_out(
        configured, installed, capsys):
    """Ours with a broken header is refused, and the message names a way out
    that WORKS on the shape this verb itself leaves on disk.

    It cannot be told from another skill's — that is what the header is for —
    so it is not written over blind. The way out is the directory and not the
    file: an installation has `references/` beside its entry document, and a
    directory left holding those and nothing else is refused in its turn.
    """
    installed.mkdir(parents=True, exist_ok=True)
    (installed / "SKILL.md").write_text("no frontmatter at all\n",
                                        encoding="utf-8")
    (installed / "references").mkdir()
    (installed / "references" / "brief.md").write_text("old\n",
                                                       encoding="utf-8")

    assert main(["skill", "update", "--path", str(installed)]) == 1
    error = capsys.readouterr().err
    assert "names no skill" in error
    assert "delete that whole directory" in error

    shutil.rmtree(installed)
    assert main(["skill", "update", "--path", str(installed)]) == 0
    assert (installed / "references" / "brief.md").read_text(
        encoding="utf-8") != "old\n"


def test_the_old_file_form_of_path_is_refused_where_the_file_is_missing(
        configured, installed, capsys):
    """`--path …/SKILL.md` on a machine that has no such file is refused.

    It is the form the previous skill taught, so the copy an agent is most
    likely to be reading when it runs this is the one that writes it. Taken
    as given, it would install into a DIRECTORY named `SKILL.md`, which no
    agent reads, and say it succeeded.
    """
    target = installed / "SKILL.md"

    assert main(["skill", "update", "--path", str(target)]) == 1
    error = capsys.readouterr().err
    assert "names the entry document" in error
    assert f"try `--path {config.display_path(installed)}`" in error
    assert not target.exists()


def test_the_version_report_does_not_recommend_an_update_that_would_refuse(
        configured, installed, capsys):
    """`hammerola skill` answers with the same reason `skill update` would.

    Otherwise it sends the reader at a command that refuses: `out of date,
    skill update writes the hub's copy over it` on somebody else's skill, or
    `skill update installs it` on a folder of somebody's files.
    """
    installed.mkdir(parents=True, exist_ok=True)
    (installed / "SKILL.md").write_text(
        "---\nname: konnect\nversion: 4\n---\n\nnot ours\n", encoding="utf-8")
    assert main(["skill", "--path", str(installed)]) == 0
    out = capsys.readouterr().out
    assert "will not write here" in out and "another skill's" in out
    assert "writes the hub's copy over it" not in out

    (installed / "SKILL.md").unlink()
    (installed / "notes.txt").write_text("somebody's\n", encoding="utf-8")
    assert main(["skill", "--path", str(installed)]) == 0
    out = capsys.readouterr().out
    assert "will not write here" in out and "notes.txt" in out
    assert "installs it" not in out


def test_update_over_a_current_copy_says_it_was_unchanged(configured,
                                                          installed, capsys):
    """It writes anyway — the verb is "make this the hub's copy", not "apply a
    difference" — and the output says the version did not move, so a re-run
    does not read like it fixed something."""
    plant(installed, shipped())

    assert main(["skill", "update", "--path", str(installed)]) == 0

    assert (installed / skill.ENTRY).read_text(encoding="utf-8") == shipped()
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
    assert (written / skill.ENTRY).read_text(encoding="utf-8") == shipped()
    # Spelled out as well as expanded, so a DEFAULT_PATH that moved somewhere
    # else under the same home would still be caught here.
    assert written == home / ".claude" / "skills" / "hammerola"
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
    this is what holds it: the failure has no other symptom, since the
    directory it lands in is a real one on the machine running the suite."""
    assert main([part.format(path=installed) for part in argv]) == 0
    assert (installed / skill.ENTRY).is_file()


@pytest.mark.parametrize("served,why,said", [
    (b"<html>hello\n", "a proxy's login page, served with a 200",
     "not a readable .tar.gz"),
    (lambda: archive({"references/brief.md": "a rule\n"}),
     "an archive with no entry document in it", "Nothing was written"),
    (lambda: archive({"SKILL.md": dated(None)}),
     "an entry document naming no version", "Nothing was written"),
])
def test_update_refuses_what_it_cannot_read_a_version_out_of(
        served, why, said, configured, installed, monkeypatch, capsys):
    """CHECKED BEFORE ANYTHING IS WRITTEN. Any of these would otherwise land on
    disk AS the agent's instructions — and the only later symptom is `skill`
    saying the installed copy names no version.

    That nothing was written is the whole claim, and the directory that was
    there before is still there, untouched: this verb also REMOVES, so a
    refusal that pruned first would take a working skill away and put nothing
    in its place. The refusal says so in the two cases this command phrases
    itself; the unreadable archive is refused by `unpack` in its own words.

    Only the ARCHIVE route is doctored: the manifest still answers, so what is
    under test is the client's reading of what came back rather than a hub that
    is down.
    """
    monkeypatch.setattr(onboarding, "skill_bytes",
                        served if callable(served) else lambda: served)
    assert configured.get("/start").status_code == 200, (
        "the premise is gone: the manifest went down with the archive, so this "
        f"no longer reaches the client's reading of {why}")
    plant(installed, dated(0), **{"references/mine.md": "kept\n"})

    assert main(["skill", "update", "--path", str(installed)]) == 1

    assert said in capsys.readouterr().err
    entry = (installed / skill.ENTRY).read_text(encoding="utf-8")
    assert skill.version_of(entry) == 0
    assert (installed / "references" / "mine.md").is_file()


def test_neither_verb_presents_a_secret(configured, installed, monkeypatch):
    """NO TOKEN GOES OUT, which is what lets the reader of the instructions
    fetch them before anybody has handed them the hub's password.

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
