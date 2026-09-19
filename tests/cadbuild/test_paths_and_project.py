"""Finding the project, and reading project.json.

This is the part the packaging changed. The code used to be a script inside the
project, so its own location was the answer; now it lives somewhere else
entirely and has to find the project it is being run against. Getting that
wrong means building under someone else's id, and every published URL is
permanent.

What is NOT here any more: the two derived paths (`out_dir`, `archive_path`) and
`resolve_commit`. They addressed a local build writing `_out.tar.gz` beside the
model and a revision named after a git commit, and the hub does neither -- it
unpacks a pushed tree and mints the name from its digest.
"""

import json

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.paths import (
    find_project_root,
    project_root,
    set_project_root,
)
from src.cadbuild.hubspec import MEMBER_RE, TEST_ID
from src.cadbuild.project import load_project, refuse_test_id


def write_project(root, **fields):
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(json.dumps(fields), encoding="utf-8")
    return root


# --------------------------------------------------------------------------
# Finding the project
# --------------------------------------------------------------------------

def test_the_working_directory_is_the_project_when_it_holds_a_project_json(tmp_path):
    set_project_root(None)
    root = write_project(tmp_path / "widget", id="aabbccddeeff", title="x (widget)")
    assert find_project_root(root) == root


def test_a_subdirectory_finds_the_project_above_it(tmp_path):
    set_project_root(None)
    root = write_project(tmp_path / "widget", id="aabbccddeeff", title="x (widget)")
    deep = root / "cad" / "parts"
    deep.mkdir(parents=True)
    assert find_project_root(deep) == root


def test_no_project_json_anywhere_is_not_a_project(tmp_path):
    set_project_root(None)
    (tmp_path / "empty").mkdir()
    assert find_project_root(tmp_path / "empty") is None


def test_project_root_says_what_is_missing_rather_than_guessing(tmp_path, monkeypatch):
    set_project_root(None)
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.chdir(empty)
    with pytest.raises(BuildError) as exc:
        project_root()
    assert "project.json" in str(exc.value)


def test_an_explicit_root_wins_over_the_search(tmp_path):
    root = write_project(tmp_path / "widget", id="aabbccddeeff", title="x (widget)")
    set_project_root(root)
    assert project_root() == root.resolve()


# --------------------------------------------------------------------------
# project.json
# --------------------------------------------------------------------------

def test_a_complete_project_json_reads_back(isolated_project):
    pid, project, title = load_project()
    assert pid == "abc123def456"
    assert project == "scratch-project"
    assert title == "Тестовая деталь (scratch-project)"


def test_the_slug_comes_from_the_title_not_the_directory(tmp_path):
    """Inside the hub the directory is the unpack directory of one push."""
    root = write_project(tmp_path / "src", id="aabbccddeeff",
                         title="Насос для шликера (slip-pump)")
    set_project_root(root)
    _pid, project, _title = load_project()
    assert project == "slip-pump"


def test_a_project_nothing_names_publishes_under_its_id_and_never_the_directory(
        tmp_path):
    """THE INCIDENT, reproduced with the directory that caused it.

    `hammerola create` used to write only `id` and `title`, so a title with no
    brackets left `load_project` falling through to `root.name` — and inside the
    hub `root` is the directory a push was unpacked into,
    `.src-<uuid4 hex>` (`store.SOURCE_PREFIX`). The front page then carried a
    card called `.src-89fb7abdeb1d48b5985bcb519850b284`: a name belonging to
    nobody, different on the next push.

    The directory is named like the real one rather than like an abstraction,
    because the two halves of the failure are exactly that the name is
    unrecognisable and that it is the hub's own.
    """
    staging = tmp_path / ".src-89fb7abdeb1d48b5985bcb519850b284"
    root = write_project(staging, id="2486c8fd2b05",
                         title="Foam cover reverse-engineered from a 3D scan")
    set_project_root(root)
    _pid, project, _title = load_project()
    assert project == "2486c8fd2b05"
    assert project != root.name


def test_a_project_with_no_title_falls_back_to_its_id_as_well(tmp_path):
    """The same fallback one line up, and it was the same directory name.

    `title` is shown on the index card beside `project`, so a hand-written
    project.json with no title published the unpack directory's name there too.
    Here nothing names the project either, so both land on the id -- which is
    the id only because that is where `project` itself ended up; the next test
    is the one that separates the two.
    """
    root = write_project(tmp_path / ".src-89fb7abdeb1d48b5985bcb519850b284",
                         id="2486c8fd2b05")
    set_project_root(root)
    _pid, _project, title = load_project()
    assert title == "2486c8fd2b05"


def test_a_missing_title_falls_back_to_the_project_and_not_to_the_id(tmp_path):
    """The title falls back to the PROJECT, exactly as the hub's own does.

    `render.build_meta` resolves `title = raw["title"] or project`, so a
    project.json naming a slug and no title has to show that slug -- not the
    twelve hex characters of the id. Reaching for `pid` here instead would be
    one half of the system silently correcting the other, which is the drift
    that made this whole change necessary.
    """
    root = write_project(tmp_path / ".src-89fb7abdeb1d48b5985bcb519850b284",
                         id="2486c8fd2b05", project="slip-pump")
    set_project_root(root)
    _pid, project, title = load_project()
    assert project == "slip-pump"
    assert title == "slip-pump"


def test_an_empty_project_key_is_the_same_as_no_key_at_all(tmp_path):
    """ABSENT RATHER THAN EMPTY, checked on the side that READS the key.

    `hammerola create` omits `project` when it cannot work a slug out, and
    `tests/client/test_setup.py` pins that it writes no key rather than an empty
    string. This is the other half: a project.json that DOES carry `""` -- from
    an older client, a hand edit, or a copied file -- must resolve exactly like
    one that carries nothing, i.e. fall through to the title's brackets. Without
    it the client's rule would be the only thing standing between an empty
    string and a card with no name on it.
    """
    root = write_project(tmp_path / ".src-89fb7abdeb1d48b5985bcb519850b284",
                         id="2486c8fd2b05", project="",
                         title="Slip pump (slip-pump)")
    set_project_root(root)
    _pid, project, _title = load_project()
    assert project == "slip-pump"


def test_an_explicit_project_field_wins_over_the_title(tmp_path):
    root = write_project(tmp_path / "src", id="aabbccddeeff",
                         title="Насос для шликера (slip-pump)", project="override")
    set_project_root(root)
    assert load_project()[1] == "override"


def test_a_project_without_an_id_names_the_command_that_mints_one(tmp_path):
    """It named `make init`, a target of a Makefile that no longer exists
    anywhere (issue #20). The id is minted by `hammerola create`."""
    root = write_project(tmp_path / "widget", id="", title="x (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    message = str(exc.value)
    assert "hammerola create" in message
    assert "make init" not in message


def test_an_id_that_is_not_a_safe_path_component_is_refused(tmp_path):
    root = write_project(tmp_path / "widget", id="../escape", title="x (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    assert "not a safe path component" in str(exc.value)


def test_a_project_json_that_is_not_json_is_refused(tmp_path):
    root = tmp_path / "widget"
    root.mkdir()
    (root / "project.json").write_text("{not json", encoding="utf-8")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    assert "not valid JSON" in str(exc.value)


def test_a_missing_project_json_under_an_explicit_root_is_refused(tmp_path):
    root = tmp_path / "widget"
    root.mkdir()
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    assert "project.json not found" in str(exc.value)


def test_a_control_character_in_the_title_is_refused(tmp_path):
    root = write_project(tmp_path / "widget", id="aabbccddeeff",
                         title="bad\x07title (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    assert "non-printable" in str(exc.value)


def test_an_over_long_title_is_refused(tmp_path):
    root = write_project(tmp_path / "widget", id="aabbccddeeff",
                         title="x" * 201 + " (widget)")
    set_project_root(root)
    with pytest.raises(BuildError):
        load_project()


# --------------------------------------------------------------------------
# The test id, and the refusal to publish under it
# --------------------------------------------------------------------------

def test_the_test_id_is_a_legal_project_id(tmp_path):
    """It has to pass MEMBER_RE, or the pipeline it exists to exercise stops
    at load_project() instead of at the refusal."""
    assert MEMBER_RE.match(TEST_ID)
    root = write_project(tmp_path / "widget", id=TEST_ID, title="Тест (widget)")
    set_project_root(root)
    assert load_project()[0] == TEST_ID


def test_the_test_id_is_not_a_generated_id():
    """Nobody may mistake it for the 12 hex characters `init` mints."""
    assert TEST_ID == "local-test-do-not-publish"
    assert len(TEST_ID) != 12


def test_a_real_id_publishes(isolated_project):
    """The scratch project carries a normal id: nothing to refuse."""
    assert refuse_test_id() is None


def test_the_test_id_refuses_to_publish(tmp_path):
    root = write_project(tmp_path / "widget", id=TEST_ID, title="Тест (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        refuse_test_id()
    assert TEST_ID in str(exc.value)


def test_the_refusal_says_how_to_run_the_pipeline_anyway(tmp_path):
    """The message has to name the way out, or the flag is just a wall -- and
    the way out has to be a command that exists.

    It named `make build LOCAL=1 NOPUBLISH=1` and `make init TITLE=...` long
    after both were dead (issue #20): the local build path was abolished, and
    the Makefile those targets belonged to went with the model repository. So
    both halves are asserted -- the surviving command is named, and the four
    dead strings are gone, because it is those that were printed at people for
    months with nothing failing.
    """
    root = write_project(tmp_path / "widget", id=TEST_ID, title="Тест (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        refuse_test_id()
    message = str(exc.value)
    assert "hammerola create" in message
    for dead in ("LOCAL=1", "NOPUBLISH", "make init", "make build"):
        assert dead not in message
