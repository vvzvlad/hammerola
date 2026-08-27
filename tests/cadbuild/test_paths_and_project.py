"""Finding the project, and reading project.json.

This is the part the packaging changed. The code used to be a script inside the
project, so its own location was the answer; now it lives somewhere else
entirely and has to find the project it is being run against. Getting that
wrong means building under someone else's id, and every published URL is
permanent.

One test went back to cad_publish with its subject: `_out/` is also the name
the source tar excludes, and the list it was checked against lives in remote.py
-- build-node machinery that stayed on the client side and that step 7 removes,
now that the hub builds and there is no build node left to drive.
"""

import json

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.paths import (
    ARCHIVE_NAME,
    OUT_DIR_NAME,
    archive_path,
    find_project_root,
    out_dir,
    project_root,
    set_project_root,
)
from src.cadbuild.hubspec import MEMBER_RE, TEST_ID
from src.cadbuild.project import load_project, refuse_test_id, resolve_commit


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


def test_the_two_derived_paths_hang_off_the_root(isolated_project):
    assert out_dir() == isolated_project / OUT_DIR_NAME
    assert archive_path() == isolated_project / ARCHIVE_NAME


# --------------------------------------------------------------------------
# project.json
# --------------------------------------------------------------------------

def test_a_complete_project_json_reads_back(isolated_project):
    pid, project, title = load_project()
    assert pid == "abc123def456"
    assert project == "scratch-project"
    assert title == "Тестовая деталь (scratch-project)"


def test_the_slug_comes_from_the_title_not_the_directory(tmp_path):
    """Inside the builder image the directory is /src for every project."""
    root = write_project(tmp_path / "src", id="aabbccddeeff",
                         title="Насос для шликера (slip-pump)")
    set_project_root(root)
    _pid, project, _title = load_project()
    assert project == "slip-pump"


def test_an_explicit_project_field_wins_over_the_title(tmp_path):
    root = write_project(tmp_path / "src", id="aabbccddeeff",
                         title="Насос для шликера (slip-pump)", project="override")
    set_project_root(root)
    assert load_project()[1] == "override"


def test_a_project_without_an_id_says_to_run_init(tmp_path):
    root = write_project(tmp_path / "widget", id="", title="x (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        load_project()
    assert "make init" in str(exc.value)


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
    """The message has to name the way out, or the flag is just a wall."""
    root = write_project(tmp_path / "widget", id=TEST_ID, title="Тест (widget)")
    set_project_root(root)
    with pytest.raises(BuildError) as exc:
        refuse_test_id()
    message = str(exc.value)
    assert "NOPUBLISH=1" in message
    assert "make init" in message


# --------------------------------------------------------------------------
# The commit a snapshot is published under
# --------------------------------------------------------------------------

def test_an_explicit_commit_wins(monkeypatch):
    monkeypatch.setenv("COMMIT_SHA", "fromenv")
    assert resolve_commit("explicit") == "explicit"


def test_the_ci_environment_is_next(monkeypatch):
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    monkeypatch.setenv("COMMIT_SHA", "fromenv")
    assert resolve_commit(None) == "fromenv"


def test_github_sha_is_read_too(monkeypatch):
    monkeypatch.delenv("COMMIT_SHA", raising=False)
    monkeypatch.setenv("GITHUB_SHA", "fromgithub")
    assert resolve_commit(None) == "fromgithub"


def test_a_commit_that_is_not_a_safe_path_component_is_refused(monkeypatch):
    monkeypatch.setenv("COMMIT_SHA", "../../etc/passwd")
    with pytest.raises(BuildError) as exc:
        resolve_commit(None)
    assert "not a safe path component" in str(exc.value)


def test_outside_a_git_checkout_the_commit_has_to_be_given(monkeypatch, tmp_path):
    monkeypatch.delenv("COMMIT_SHA", raising=False)
    monkeypatch.delenv("GITHUB_SHA", raising=False)
    root = write_project(tmp_path / "loose", id="aabbccddeeff", title="x (loose)")
    # set_project_root() and nothing else. There used to be a
    # `monkeypatch.setattr(paths, "_root", root)` on the next line, which did
    # the same thing twice and made the second one impossible to undo:
    # monkeypatch records the value it found, which by then was already this
    # root, so its teardown put the root BACK after the conftest fixture had
    # cleared it -- and every test after this one started with paths._root
    # pointing at a tmp_path that no longer exists. Harmless while each test
    # overwrote it on the way in; not harmless the moment one does not.
    set_project_root(root)
    try:
        commit = resolve_commit(None)
    except BuildError as exc:
        assert "pass --commit" in str(exc)
    else:
        # A tmp_path that happens to sit inside a checkout answers with its sha.
        assert commit
