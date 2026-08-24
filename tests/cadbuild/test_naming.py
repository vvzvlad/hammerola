"""The rules about strings, and the reason they run before any geometry.

Every one of these is knowable from the source alone. They used to be applied
inside the export loop, so a name two characters over the hub's limit went red
only after every part ahead of it had been built, exported and meshed -- a whole
build spent arriving at an answer that was in model.py all along.
"""

import pytest

from src.cadbuild.errors import BuildError
from src.cadbuild.hubspec import LABEL_RE, MEMBER_RE, RESERVED_NAMES
from src.cadbuild.printables import collect_printables, download_labels

from fakes import part


class Model:
    def __init__(self, printables):
        self._printables = printables

    def printables(self):
        return self._printables

    def views(self):
        return []


def test_member_rule_matches_the_hub_spec():
    assert MEMBER_RE.match("body.stl")
    assert MEMBER_RE.match("a" * 128)
    assert not MEMBER_RE.match("a" * 129)
    assert not MEMBER_RE.match(".hidden")
    assert not MEMBER_RE.match("with space")
    assert not MEMBER_RE.match("dir/file")
    assert not MEMBER_RE.match("")


def test_label_rule_matches_the_hub_spec():
    assert LABEL_RE.match("stl")
    assert LABEL_RE.match("a" * 32)
    assert not LABEL_RE.match("a" * 33)
    assert not LABEL_RE.match("")
    assert not LABEL_RE.match("has space")


def test_reserved_names_cover_everything_the_build_writes_itself():
    assert RESERVED_NAMES == {"meta.json", "index.html", "metrics.json"}


def test_a_single_printable_gets_bare_extension_labels():
    assert download_labels({"body": None}) == {
        "step": "body.step", "stl": "body.stl", "3mf": "body.3mf",
    }


def test_several_printables_get_labels_that_name_the_part():
    labels = download_labels({"body": None, "lid": None})
    assert labels["body.stl"] == "body.stl"
    assert labels["lid.3mf"] == "lid.3mf"


def test_a_name_that_makes_an_over_long_label_is_refused_before_the_build():
    long = "a" * 30          # "<name>.step" is 35 characters, over the hub's 32
    with pytest.raises(BuildError) as exc:
        download_labels({long: None, "lid": None})
    assert "will not take" in str(exc.value)
    assert "Shorten the printable name" in str(exc.value)


def test_a_long_name_is_fine_when_it_is_the_only_printable():
    """One printable means bare `stl`/`step`/`3mf` labels: the name is not in them."""
    download_labels({"a" * 100: None})


def test_a_printable_name_that_is_not_a_filename_stem_is_refused():
    with pytest.raises(BuildError) as exc:
        collect_printables(Model({"my part": part()}))
    assert "not usable as a filename stem" in str(exc.value)


def test_a_printable_called_assembled_collides_with_the_build_output():
    with pytest.raises(BuildError) as exc:
        collect_printables(Model({"assembled": part()}))
    assert "collides with assembled.stl" in str(exc.value)


def test_printables_must_return_a_non_empty_dict():
    for bad in ({}, [], None, "body"):
        with pytest.raises(BuildError) as exc:
            collect_printables(Model(bad))
        assert "non-empty dict" in str(exc.value)


def test_something_that_is_not_geometry_is_refused_by_name():
    with pytest.raises(BuildError) as exc:
        collect_printables(Model({"body": "not a solid"}))
    assert "expected a CadQuery object" in str(exc.value)


def test_a_good_set_of_printables_comes_back_unchanged():
    printables = {"body": part(), "lid": part()}
    assert collect_printables(Model(printables)) is printables
