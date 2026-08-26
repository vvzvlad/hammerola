"""Which project — the one answer the working directory has to give.

There used to be a second one here, WHICH REVISION, worked out from git HEAD
with a refusal on a dirty tree. It is gone with the machinery: the hub names a
revision out of the sources it receives, so there is nothing for the client to
derive and nothing for it to refuse. What remains is `project.json` and the
reasons it, and not the directory name, decides where a push lands.
"""

import json

import pytest
from modeldir import make_model

from src.client.project import (
    ProjectError,
    find_project_root,
    read_project_id,
    read_project_title,
)


# -- which project -----------------------------------------------------------
def test_the_project_is_found_from_a_subdirectory(tmp_path):
    root = make_model(tmp_path / "demo", extra={"scripts/gen.py": "x = 1\n"})
    assert find_project_root(root / "scripts") == root.resolve()


def test_no_project_json_anywhere_is_a_refusal(tmp_path):
    empty = tmp_path / "elsewhere"
    empty.mkdir()
    with pytest.raises(ProjectError) as caught:
        find_project_root(empty)
    assert "project.json" in str(caught.value)


def test_the_id_comes_from_project_json_and_not_from_the_directory(tmp_path):
    """A checkout can be cloned into any directory. A client that guessed from
    the directory name would publish over somebody else's project the first
    time one was renamed."""
    root = make_model(tmp_path / "some-other-name", pid="realproject")
    assert read_project_id(root) == "realproject"
    assert read_project_title(root) == "Demo project"


def test_the_templates_empty_id_is_named_as_such(tmp_path):
    """`model_template` ships `{"id": "", "title": ""}`; a directory copied from
    it and never initialised has to be told that, not "invalid project id"."""
    root = make_model(tmp_path / "demo")
    (root / "project.json").write_text(json.dumps({"id": "", "title": ""}))
    with pytest.raises(ProjectError) as caught:
        read_project_id(root)
    assert "no project id" in str(caught.value)


def test_an_id_the_hub_would_refuse_is_refused_here(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "project.json").write_text(json.dumps({"id": "../escape"}))
    with pytest.raises(ProjectError) as caught:
        read_project_id(root)
    assert "../escape" in str(caught.value)


def test_project_json_that_is_not_json_says_so(tmp_path):
    root = make_model(tmp_path / "demo")
    (root / "project.json").write_text("{not json")
    with pytest.raises(ProjectError) as caught:
        read_project_id(root)
    assert "not valid JSON" in str(caught.value)
