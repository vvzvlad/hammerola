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

from hammerola import config, limits, pack, project, setup
from hammerola.cli import main


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
    monkeypatch.setattr("hammerola.setup.getpass.getpass",
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
# EVERY TEST BELOW THAT DOES NOT NAME A HUB PASSES `--no-template`, and that is
# the shape of the command rather than a convenience for the suite: `create`
# fetches the starter template, so the flag is what makes it the offline command
# it used to be. The tests about the download itself are at the bottom.
def test_create_writes_a_fresh_id_and_takes_the_directory_name_as_the_title(
        tmp_path, capsys):
    root = tmp_path / "t13-ceiling-mount"
    assert main(["-C", str(root), "create", "--no-template"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload["title"] == "t13-ceiling-mount"
    # SPEC 3.1: twelve hex characters, minted locally.
    assert len(payload["id"]) == 12
    assert all(c in "0123456789abcdef" for c in payload["id"])
    assert payload["id"] in capsys.readouterr().out


def test_create_names_the_project_after_the_directory_it_is_made_in(
        tmp_path, capsys):
    """THE KEY THAT WAS NOT BEING WRITTEN, and the machine that is the only one
    able to write it.

    The slug is the name of the author's directory and of their repository. On
    the hub a push is unpacked into `.src-<uuid4 hex>`, so a build that worked
    the answer out for itself published a card called
    `.src-89fb7abdeb1d48b5985bcb519850b284`. It travels in project.json because
    this is where the question has an answer.

    Printed as well as written: it is the name the index card carries, so
    somebody reading the output of `create` has to be able to see it.
    """
    root = tmp_path / "t13-ceiling-mount"
    assert main(["-C", str(root), "create", "--no-template"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == "t13-ceiling-mount"
    # The LINE, not the string: with no `--title` the title is the directory
    # name too, so anything looser would pass on the title alone.
    assert [line for line in capsys.readouterr().out.splitlines()
            if line.startswith("  project")] == ["  project  t13-ceiling-mount"]


def test_a_directory_that_cannot_be_a_slug_falls_back_to_the_titles_brackets(
        tmp_path):
    """The directory first, the title second — and the second is what is left
    when somebody works in `Корпус/`."""
    root = tmp_path / "Корпус"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Потолочный корпус (t13-ceiling-mount)"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == "t13-ceiling-mount"


def test_a_project_nothing_here_can_name_gets_no_key_rather_than_an_empty_one(
        tmp_path, capsys):
    """ABSENT, NOT `""`, and the difference is what the hub reads.

    A missing key lets `load_project` answer with the project id, which at least
    names this project; an empty one is a project.json ASSERTING it has no name
    and leaves the hub in the same position with a field to explain. Creating
    the project still succeeds — refusing over the spelling of a folder would be
    a wall in front of the first command anybody runs.
    """
    root = tmp_path / "Корпус"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Потолочный корпус"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert project.PROJECT_KEY not in payload
    assert [line for line in capsys.readouterr().out.splitlines()
            if line.startswith("  project")] == []


def test_a_directory_name_too_long_to_publish_is_passed_over(tmp_path):
    """The one name in project.json nobody typed, so the ceiling is checked here.

    A path component may be 255 characters and `SLUG_RE` has no length in it, so
    a directory can be a perfectly good slug that the hub will not take: over
    MAX_TEXT_CHARS `load_project` raises, inside the job, on every push of that
    project. The title's brackets are asked next — they are a name somebody DID
    type — and this is the case that separates "passed over" from "truncated":
    a cut directory name would win here and would be nobody's project.
    """
    root = tmp_path / ("a" * (limits.MAX_TEXT_CHARS + 1))
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Ceiling mount (t13-ceiling-mount)"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == "t13-ceiling-mount"


def test_a_name_at_the_ceiling_is_still_written(tmp_path):
    """The other side of the same line: 200 characters is a name the hub takes."""
    name = "b" * limits.MAX_TEXT_CHARS
    root = tmp_path / name
    assert main(["-C", str(root), "create", "--no-template"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == name


def test_a_directory_name_too_long_to_BE_a_title_stops_the_command(
        tmp_path, capsys):
    """WHERE THE CEILING ON THE SLUG ALONE ONLY MOVED THE FAILURE.

    With no `--title` the title is the directory name too, so passing an
    over-long name over for the `project` key left the same string in `title`
    and the push still died inside the job — after the upload, with `hammerola`
    having said nothing. Refused here instead, on the machine that can still fix
    it, and the message has to name the flag that does: there is no shorter name
    for this command to fall back to.
    """
    root = tmp_path / ("c" * (limits.MAX_TEXT_CHARS + 1))
    assert main(["-C", str(root), "create", "--no-template"]) == 1

    error = capsys.readouterr().err
    assert str(limits.MAX_TEXT_CHARS) in error
    assert "--title" in error
    # Nothing written: a directory holding an id and no model is the state
    # `create` is built never to leave behind.
    assert not (root / "project.json").exists()


def test_a_title_somebody_typed_too_long_is_refused_as_well(tmp_path, capsys):
    """Same ceiling, different remedy: this one was typed, so it can be
    shortened, and the flag has nothing to do with it."""
    root = tmp_path / "demo"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "x" * (limits.MAX_TEXT_CHARS + 1)]) == 1

    error = capsys.readouterr().err
    assert str(limits.MAX_TEXT_CHARS) in error
    assert "--title" not in error
    assert not (root / "project.json").exists()


def test_a_title_carrying_u202e_is_refused_here_and_not_inside_the_job(
        tmp_path, capsys):
    """THE CLIENT'S OWN SPELLING OF "PRINTABLE" LET THIS THROUGH.

    It read `ord(char) < 0x20 or ord(char) == 0x7F` — a SUBSET of Unicode
    category Cc, the C0 controls and DEL but not C1 (U+0080-U+009F) — while the
    build refuses all of category C, so U+202E
    RIGHT-TO-LEFT OVERRIDE (Cf) was accepted by `create` and killed the job
    after the sources had been uploaded. The same defect is recorded as fixed on
    the build side in `src/cadbuild/project.py`; the fix here is to import that
    scan rather than spell it again.
    """
    root = tmp_path / "slip-pump"
    # Escaped rather than pasted: the literal character reverses the rest of
    # this line in every editor that renders it, including this file.
    title = "Slip pump \u202epmup (slip-pump)"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", title]) == 1

    error = capsys.readouterr().err
    assert repr("\u202e") in error
    assert not (root / "project.json").exists()


def test_a_directory_and_a_title_naming_two_slugs_is_said_here(tmp_path, capsys):
    """THE DISAGREEMENT IS ONLY VISIBLE ON THIS MACHINE, so it is said here.

    In `mount/` with a title ending `(t13-ceiling-mount)` the directory wins
    silently, and every later build then prints a warning that reads as a title
    copied from another project — which is not what happened, and the log it
    prints in never says that one of the two names is a directory. The project
    is still created: the two names disagreeing is not an error, it is a thing
    to know.
    """
    root = tmp_path / "mount"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Ceiling mount (t13-ceiling-mount)"]) == 0

    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == "mount"
    out = capsys.readouterr().out
    note = [line for line in out.splitlines() if line.startswith("note:")]
    assert len(note) == 1, out
    assert "mount" in note[0] and "t13-ceiling-mount" in note[0]
    # The remedy it offers has to be one that moves the key — see the test
    # below for the one it used to offer, which does not.
    assert "hammerola rename" in out


def test_renaming_the_directory_afterwards_does_not_move_the_key(tmp_path):
    """WHAT THE NOTE ABOVE USED TO RECOMMEND, AND WHY IT NO LONGER DOES.

    "rename the directory" was a remedy that produces no change whatsoever:
    `create_project` writes the `project` key once, and `cadbuild.project`
    reads that key before it looks at anything else — so once the file exists,
    the directory can be called anything and the project goes on publishing
    under the name it was created with. The two remedies the note names now are
    the two that do reach the disagreement: the title's brackets, which
    `hammerola rename` rewrites, and the key itself.
    """
    root = tmp_path / "mount"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Ceiling mount (t13-ceiling-mount)"]) == 0

    renamed = tmp_path / "t13-ceiling-mount"
    root.rename(renamed)
    payload = json.loads((renamed / "project.json").read_text(encoding="utf-8"))
    assert payload[project.PROJECT_KEY] == "mount"


def test_two_names_that_agree_are_not_remarked_on(tmp_path, capsys):
    """The ordinary case, and the reason the note is conditional: a line printed
    every time is a line nobody reads."""
    root = tmp_path / "t13-ceiling-mount"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Ceiling mount (t13-ceiling-mount)"]) == 0

    assert [line for line in capsys.readouterr().out.splitlines()
            if line.startswith("note:")] == []


def test_two_projects_do_not_get_the_same_id(tmp_path):
    assert main(["-C", str(tmp_path / "a"), "create", "--no-template"]) == 0
    assert main(["-C", str(tmp_path / "b"), "create", "--no-template"]) == 0
    ids = {json.loads((tmp_path / name / "project.json").read_text())["id"]
           for name in ("a", "b")}
    assert len(ids) == 2


def test_the_title_can_be_given(tmp_path):
    root = tmp_path / "demo"
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "T13 ceiling mount"]) == 0
    payload = json.loads((root / "project.json").read_text(encoding="utf-8"))
    assert payload["title"] == "T13 ceiling mount"


def test_create_refuses_over_an_existing_project(tmp_path, capsys):
    """The id is the only link between this directory and everything the hub
    has published for it. Replacing it silently would not fail anything — the
    next push would land in a new, empty project."""
    root = make_model(tmp_path / "demo", pid="demo0001")
    assert main(["-C", str(root), "create", "--no-template"]) == 1
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

    assert main(["-C", str(inner), "create", "--no-template"]) == 1
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
    assert main(["-C", str(tmp_path / "new"), "create", "--no-template"]) == 0
    assert (tmp_path / "new" / "project.json").is_file()


def test_a_created_project_is_one_the_hub_accepts(hub, tmp_path, monkeypatch):
    """End to end, because the alphabet is the hub's: an id this tool minted
    and the hub refuses would break the first push of every new project.

    `--no-template` because this directory already HAS a model — it is the
    "existing repository adopts hammerola" case, and the refusal tested below is
    what would otherwise stop it."""
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)

    root = make_model(tmp_path / "demo")
    (root / "project.json").unlink()
    assert main(["-C", str(root), "create", "--no-template",
                 "--title", "Fresh"]) == 0

    pid = json.loads((root / "project.json").read_text(encoding="utf-8"))["id"]
    assert main(["-C", str(root), "build", "--timeout", "60"]) == 0
    assert (hub.project_dir(pid) / "dev" / "model.py").is_file()


# -- create, and the template it fetches -------------------------------------
def test_create_unpacks_the_template_the_hub_serves(hub, tmp_path, monkeypatch):
    """The whole point of the download: a fresh directory holds a model.

    Against the REAL hub over a real socket, because the two halves of this are
    a route and a client and they used to live in two repositories where nothing
    could see both.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    root = tmp_path / "fresh-part"

    assert main(["-C", str(root), "create", "--title", "Fresh part"]) == 0

    assert (root / "project.json").is_file()
    assert (root / "model.py").is_file()
    # The hidden file is the one a push could never carry, and the reason the
    # template is read with an alphabet of its own.
    assert (root / ".gitignore").is_file()
    assert "def views(" in (root / "model.py").read_text(encoding="utf-8")


def test_the_template_needs_no_token(hub, tmp_path, monkeypatch):
    """`create` never reads the secret, so a project can be started against a
    hub this machine has never logged in to. The conftest here has already
    removed EDIT_TOKEN from the environment; this states that it stays out."""
    monkeypatch.setenv("HUB_URL", hub.url)
    assert main(["-C", str(tmp_path / "part"), "create"]) == 0
    assert (tmp_path / "part" / "model.py").is_file()


def test_create_refuses_rather_than_writing_over_a_file_that_is_there(
        hub, tmp_path, monkeypatch, capsys):
    """ALL OR NOTHING, and not even the project.json is written.

    A half-created project holds a permanent id and no model, and the second run
    then refuses over the project.json the first one left behind — so the
    refusal has to land before anything is written at all.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    root = tmp_path / "mine"
    root.mkdir()
    (root / "model.py").write_text("# mine\n", encoding="utf-8")

    assert main(["-C", str(root), "create"]) == 1

    error = capsys.readouterr().err
    assert "model.py" in error
    assert "--no-template" in error
    assert not (root / "project.json").exists()
    assert (root / "model.py").read_text(encoding="utf-8") == "# mine\n"


def test_a_dangling_symlink_is_a_collision_and_not_a_way_out_of_the_project(
        hub, tmp_path, monkeypatch, capsys):
    """`exists()` follows a link, so a link to NOWHERE was not a collision — and
    the write that followed opened the link's target, landing the template's
    file outside the project. Both halves are closed: the check uses `lexists`,
    and the write uses `O_CREAT|O_EXCL|O_NOFOLLOW`, which cannot open a link at
    all.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    root = tmp_path / "part"
    root.mkdir()
    outside = tmp_path / "outside.py"
    (root / "model.py").symlink_to(outside)

    assert main(["-C", str(root), "create"]) == 1

    assert "model.py" in capsys.readouterr().err
    assert not outside.exists(), (
        "the template was written through the symlink, outside the project")
    assert not (root / "project.json").exists()


def test_a_template_written_over_a_symlink_that_appeared_late_is_refused(
        tmp_path):
    """THE OTHER HALF OF THE SYMLINK STORY, and the one no `create` can stage.

    The test above plants the link before the command runs, so `lexists` in
    `_refuse_to_overwrite` sees it and nothing downstream is exercised —
    replacing the write with a plain `write_bytes` leaves that test green. The
    window the flags exist for is the one BETWEEN the check and the write, so it
    is staged the only way it can be: by calling the writer with the link
    already there, which is the state that check cannot promise anything about
    by the time the bytes move.

    `O_CREAT|O_EXCL` refuses because the path exists — a symlink is a path that
    exists, dangling or not — and `O_NOFOLLOW` says the same a second way.
    Checked at the far end as well: the file OUTSIDE the project is what the
    write would have landed in, so it is what must be untouched.
    """
    root = tmp_path / "part"
    root.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text("not the template\n", encoding="utf-8")
    (root / "model.py").symlink_to(outside)

    with pytest.raises(project.ProjectError) as raised:
        setup._write_template(root, (("model.py", b"# the template\n"),))

    assert "model.py" in str(raised.value)
    assert outside.read_text(encoding="utf-8") == "not the template\n", (
        "the write followed the symlink and landed outside the project")


def test_a_template_written_over_a_DANGLING_symlink_creates_nothing_anywhere(
        tmp_path):
    """The same window with nothing at the other end of the link.

    Worth its own case because the two fail differently in the mutation: a
    `write_bytes` here CREATES the target rather than overwriting one, so the
    assertion has to be that the path outside never came into existence.
    """
    root = tmp_path / "part"
    root.mkdir()
    outside = tmp_path / "nothing-here.py"
    (root / "model.py").symlink_to(outside)

    with pytest.raises(project.ProjectError):
        setup._write_template(root, (("model.py", b"# the template\n"),))

    assert not outside.exists(), (
        "the write followed a dangling link and created a file outside the "
        "project")


def test_a_hub_that_cannot_be_reached_creates_nothing_and_says_what_to_do(
        tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:1")
    root = tmp_path / "part"

    assert main(["-C", str(root), "create"]) == 1

    error = capsys.readouterr().err
    assert "cannot reach" in error
    assert "--no-template" in error
    assert not (root / "project.json").exists()


def test_a_template_the_client_cannot_read_says_what_to_do_as_well(
        hub, tmp_path, monkeypatch, capsys):
    """The last refusal of `create` that lost the way forward.

    A corrupt archive, or one naming a member no client will unpack, raises
    `ClientError` from `read_members` — a different class from the HubError
    every other failure here carries, and it stood outside the wrapper that
    appends the sentence. So the ONE reader who most needs "you can start
    without a hub" was the one who did not get it.
    """
    from hammerola import setup as setup_module

    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setattr(setup_module.Hub, "fetch_path",
                        lambda self, path: b"not a tar at all")
    root = tmp_path / "part"

    assert main(["-C", str(root), "create"]) == 1

    error = capsys.readouterr().err
    assert "--no-template" in error
    assert not (root / "project.json").exists()


@pytest.mark.parametrize("password, why", [
    ("СЕКРЕТНОЕЗНАЧЕНИЕ", "Cyrillic: the file takes it, an HTTP header cannot"),
    ("secret\tvalue", "a tab, which this refuses by decision"),
])
def test_a_password_that_could_never_be_sent_is_refused_at_the_PROMPT(
        answers, env_file, tmp_path, capsys, password, why):
    """The loop this closes: `login` telling somebody to run `login`.

    `check_storable` answers for the FILE, which is UTF-8 and takes a Cyrillic
    password happily. The `Authorization` header is latin-1 and cannot, so such
    a password passed the prompt, was tried against the hub, and came back from
    `Hub.__init__` as "the stored secret ... run `hammerola login`" — said to
    somebody in the middle of running `hammerola login`, about a secret that had
    not been stored. The refusal now happens at the question that produced it.
    """
    answers["password"] = password

    # The address is an argument so only the password is under test, and it
    # points at a port nothing answers on: the refusal has to land BEFORE the
    # hub is asked anything, which is the whole story.
    assert main(["login", "http://127.0.0.1:1"]) == 1

    error = capsys.readouterr().err
    assert "EDIT_TOKEN" in error, why
    assert password not in error, "the refusal echoed the password"
    assert not env_file.exists(), "a password that cannot be sent was stored"


@pytest.mark.parametrize("value", [
    "plain-token", "ok-token_1", "with.dots-and_dashes",
    "СЕКРЕТ", "with\ttab", "with\nbreak", "with\x00nul", " padded ",
    "'quoted'", "",
])
def test_nothing_login_would_STORE_is_something_the_hub_would_refuse(value):
    """THE PROPERTY, and it is one-directional on purpose.

    `login` runs two checks at the prompt; `Hub.__init__` runs a third when a
    token arrives some other way. Anything the prompt ACCEPTS has to be
    something the constructor will send — otherwise a password is stored, and
    then every command including `login`'s own hub check refuses it, advising
    the reader to run `hammerola login`. That is the loop this closes.

    The converse is deliberately NOT asserted: `login` is allowed to be
    stricter, and is — surrounding quotes and edge whitespace are refused for
    the FILE's sake and would travel in a header perfectly well.

    Not a tautology despite the shared predicate: the two sides are reached
    through different code (`check_storable` runs first at the prompt and
    rejects things the header check does not), so this compares outcomes rather
    than one function with itself.
    """
    from hammerola import hub as hub_module

    try:
        config.check_storable(config.EDIT_TOKEN_VAR, value)
        config.check_sendable_as_header(config.EDIT_TOKEN_VAR, value)
    except config.ConfigError:
        return  # login refuses it; the hub never sees it

    hub_module._refuse_unsendable_token(value)  # must not raise


def test_a_hub_address_that_cannot_be_requested_says_what_to_do_as_well(
        tmp_path, monkeypatch, capsys):
    """An address with a typo IN IT, as against one that answers nothing.

    `http://127.0.0.1:8O80` is refused before a socket is opened
    (`hub._origin`), which is a different code path from the unreachable hub
    above and reaches `create` as a different exception. It has to arrive with
    the same way forward: this is the first command somebody runs, and the
    branch is worthless if it merely reports the typo.
    """
    monkeypatch.setenv("HUB_URL", "http://127.0.0.1:8O80")
    root = tmp_path / "part"

    assert main(["-C", str(root), "create"]) == 1

    error = capsys.readouterr().err
    assert "HUB_URL" in error
    assert "--no-template" in error
    assert not (root / "project.json").exists()


def test_without_a_hub_address_the_flag_is_what_starts_a_project(
        tmp_path, capsys):
    """The id is minted locally and always was (SPEC §3.1); what needs a hub is
    the template. So an unconfigured machine is told which of the two it is
    missing, and the flag gets it a project anyway.

    THE MESSAGE HAS TO NAME THE FLAG, and that is the assertion that matters
    here rather than the exit code: this is the first command a new person ever
    runs, on a machine that is not configured yet, so a refusal that only says
    "HUB_URL is not set" leaves them with the one thing this branch exists to
    give them — a way to start anyway — undiscoverable.
    """
    root = tmp_path / "part"
    assert main(["-C", str(root), "create"]) == 1
    error = capsys.readouterr().err
    assert "HUB_URL" in error
    assert "--no-template" in error
    assert not (root / "project.json").exists()

    assert main(["-C", str(root), "create", "--no-template"]) == 0
    assert (root / "project.json").is_file()
    assert not (root / "model.py").exists()


def test_what_create_unpacked_is_a_tree_that_can_be_pushed_again(
        hub, tmp_path, monkeypatch):
    """The round trip: what the hub served, unpacked, packs back up.

    The claim the template makes is that it builds AS IT STANDS, and the first
    half of that is that it can be sent at all — the names have to survive the
    hub's own path alphabet on the way up, and `.gitignore` has to be DROPPED
    rather than refuse the push. (The build itself is `tests/test_template.py`,
    which needs a CAD kernel; this does not, and runs everywhere.)

    Not driven through `hammerola build`, and the reason is the suite rather
    than the tool: the stand-in builder publishes the pushed tree unchanged
    (`harness.copying_builder`), so a SOURCE tree with no meta.json in it is
    refused at publication for want of one — which says nothing about the
    template.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    root = tmp_path / "fresh-part"
    assert main(["-C", str(root), "create"]) == 0

    packed = pack.pack(root)
    assert "model.py" in packed.names
    assert "project.json" in packed.names
    assert ".gitignore" not in packed.names
