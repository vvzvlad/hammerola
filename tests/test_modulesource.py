"""The sweep that decides which modules a scratch project left behind.

WHY A TEST HELPER HAS TESTS. `modulesource` is asked in a `finally`, by three
sweeps that delete from `sys.modules`, and both of its failure directions are
silent. Too narrow and a module survives the test that created it, answering
every later `import mocks` in the session out of a directory that has been
deleted -- which is the bug it was written to fix. Too wide and it deletes
somebody else's modules, and the failure lands on whichever test happened to run
next. Neither shows up as a red test in the run that caused it, so the only
place either can be caught is here.

TWO OF ITS SHAPES WERE MEASURED AND FOUND FALSE, and those two are the reason
this file exists rather than a note: a string `__path__` came back as one
location per CHARACTER, and a `pathlib.Path` `__file__` came back as nothing at
all. Both are things a stub or an importer writes without meaning anything by
it, and both are silent.
"""

import pathlib
import sys
import types

import modulesource


def a_module(**attributes):
    """A module object with exactly the attributes named, and no others.

    `__file__` is not set by `ModuleType`, so a name absent here is genuinely
    absent rather than None -- which is the difference between the ordinary
    module and the namespace package below.
    """
    module = types.ModuleType("planted")
    for name, value in attributes.items():
        setattr(module, name, value)
    return module


# --------------------------------------------------------------------------
# What counts as a location
# --------------------------------------------------------------------------

def test_an_ordinary_module_is_found_by_its_file():
    assert modulesource.module_locations(
        a_module(__file__="/tmp/proj/mocks.py")) == ["/tmp/proj/mocks.py"]


def test_a_regular_package_is_found_by_both():
    assert modulesource.module_locations(a_module(
        __file__="/tmp/proj/pkg/__init__.py",
        __path__=["/tmp/proj/pkg"])) == [
        "/tmp/proj/pkg/__init__.py", "/tmp/proj/pkg"]


def test_a_namespace_package_is_found_by_its_path_alone():
    """The hole this module was written for: `__file__` is None, not missing.

    `import mocks` over a `mocks/` directory with no `__init__.py` binds one of
    these, and `geometry.load_model` puts a model project's root FIRST on
    sys.path precisely so that a model's own `mocks/` wins -- so this is the
    ordinary shape of a real project, not an exotic one.
    """
    assert modulesource.module_locations(
        a_module(__file__=None, __path__=["/tmp/proj/mocks"])) == [
        "/tmp/proj/mocks"]


def test_a_pathlib_file_is_a_path_and_not_a_module_with_no_location():
    """MEASURED AND FOUND FALSE, which is why this test is here.

    The check used to be `isinstance(origin, str)`, so a `__file__` holding a
    `Path` -- an ordinary thing for a stub or a test to write -- was dropped in
    silence and the module became invisible to every sweep. That is the same
    outcome as the namespace hole above, reached from the other side.
    """
    assert modulesource.module_locations(
        a_module(__file__=pathlib.Path("/tmp/proj/mocks.py"))) == [
        "/tmp/proj/mocks.py"]


def test_a_string_path_is_refused_whole_rather_than_read_letter_by_letter():
    """The other measurement: `__path__ = "abcdef"` used to be six locations.

    A string is iterable and every character of one is a string, so the
    per-entry `isinstance(entry, str)` guard let all six through -- and
    `came_from` then compared each single character against a base path. It is
    not that a module with a string `__path__` is likely; it is that the
    docstring above the function promised this could not happen.
    """
    assert modulesource.module_locations(a_module(__path__="abcdef")) == []
    assert modulesource.module_locations(a_module(__path__=b"/tmp/proj")) == []


def test_a_path_that_is_not_iterable_at_all_is_no_location():
    assert modulesource.module_locations(a_module(__path__=17)) == []


def test_a_file_that_is_not_a_path_at_all_is_no_location():
    assert modulesource.module_locations(a_module(__file__=17)) == []
    assert modulesource.came_from(a_module(__file__=17), "/tmp/proj") is False


# --------------------------------------------------------------------------
# What counts as being under a base
# --------------------------------------------------------------------------

def test_a_sibling_directory_sharing_a_prefix_is_not_under_the_base():
    """MEASURED AND FOUND FALSE: the comparison was a bare `startswith`.

    `tmp_path` names run `test_a_thing_0`, `test_a_thing_1`, so two scratch
    projects in one session are exactly this shape -- and the sweep for one of
    them deleted the modules of the other, in a `finally`, with the failure
    landing on whichever test ran next.
    """
    other = a_module(__file__="/tmp/proj-other/mocks.py")
    assert not modulesource.came_from(other, "/tmp/proj")
    assert modulesource.came_from(other, "/tmp/proj-other")


def test_a_file_under_the_base_is_under_it():
    assert modulesource.came_from(
        a_module(__file__="/tmp/proj/mocks.py"), "/tmp/proj")


def test_the_base_itself_counts():
    """A namespace package rooted AT the base came from it.

    The equal case has to be decided one way or the other, and letting it fall
    through would leave exactly the module a scratch project's own root
    directory produced -- the one most worth sweeping.
    """
    assert modulesource.came_from(a_module(__path__=["/tmp/proj"]), "/tmp/proj")


def test_a_module_with_nowhere_to_have_come_from_came_from_nowhere():
    assert not modulesource.came_from(a_module(), "/tmp/proj")


# --------------------------------------------------------------------------
# The sweep itself
# --------------------------------------------------------------------------

def test_the_sweep_names_what_is_under_the_base_and_skips_a_none(monkeypatch):
    """`sys.modules` holds None for a submodule import that failed part way.

    It is not a module and cannot be judged; asking it for `__file__` is a
    `getattr` on None, which answers nothing rather than raising -- so this is
    about the walk being explicit rather than about it crashing.
    """
    monkeypatch.setitem(sys.modules, "planted_here",
                        a_module(__file__="/tmp/proj/mocks.py"))
    monkeypatch.setitem(sys.modules, "planted_elsewhere",
                        a_module(__file__="/tmp/proj-other/mocks.py"))
    monkeypatch.setitem(sys.modules, "planted_none", None)

    found = modulesource.modules_from("/tmp/proj")
    assert "planted_here" in found
    assert "planted_elsewhere" not in found
    assert "planted_none" not in found


def test_the_sweep_survives_being_walked_while_sys_modules_changes(monkeypatch):
    """The caller is about to delete from the very dict this walks.

    `list(sys.modules.items())` is the snapshot that makes that safe, and this
    is the assertion that keeps it from being simplified away: a plain
    `.items()` raises RuntimeError the moment the caller's loop deletes
    anything, which is what every one of the three sweeps does.
    """
    monkeypatch.setitem(sys.modules, "planted_here",
                        a_module(__file__="/tmp/proj/mocks.py"))
    for name in modulesource.modules_from("/tmp/proj"):
        sys.modules.pop(name, None)
    assert modulesource.modules_from("/tmp/proj") == []
