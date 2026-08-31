"""Importing the model, and reading the geometry it hands over.

The two things worth pinning down here are both about the packaging. The
project root has to go on sys.path FIRST, so a model's `import mocks` finds the
project's own mocks.py -- and that same precedence is what lets a
half-migrated project shadow checklib, which is silent and lossy, so it is
detected and said out loud.
"""

import sys

import pytest

from src.cadbuild import geometry
from src.cadbuild.errors import BuildError
from src.cadbuild.geometry import as_shape, as_shapes, load_model

from fakes import Shape, Workplane


@pytest.fixture(autouse=True)
def forget_the_model():
    """Each test gets a fresh import of whatever model.py it wrote."""
    for name in ("model", "checklib", "mocks"):
        sys.modules.pop(name, None)
    before = list(sys.path)
    yield
    for name in ("model", "checklib", "mocks"):
        sys.modules.pop(name, None)
    sys.path[:] = before


def write_model(root, body="", extra=""):
    (root / "model.py").write_text(
        f"{extra}\n"
        "def parts():\n    return {}\n"
        "def views():\n    return []\n"
        f"{body}\n",
        encoding="utf-8",
    )


# --------------------------------------------------------------------------
# Importing the model
# --------------------------------------------------------------------------

def test_the_model_is_imported_from_the_project(isolated_project):
    write_model(isolated_project)
    assert load_model().parts() == {}


def test_a_model_that_will_not_import_says_why(isolated_project):
    (isolated_project / "model.py").write_text("import nonexistent_module\n",
                                               encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        load_model()
    assert "importing model.py failed" in str(exc.value)


def test_a_project_with_a_src_of_its_own_is_named_when_an_import_of_src_fails(
        isolated_project):
    """`No module named 'src....'` from a model.py points at the model.

    It is the project root -- first on sys.path, deliberately -- that owns the
    name, so the failure is about the directory layout and not about the line
    it was raised from. checklib is immune to this by construction; anything
    else reaching for `src.` from inside a build is not.
    """
    (isolated_project / "src").mkdir()
    (isolated_project / "model.py").write_text(
        "import src.cadbuild.does_not_exist\n", encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        load_model()
    message = str(exc.value)
    assert "importing model.py failed" in message
    assert "carries a `src` of its own" in message


def test_the_src_hint_is_not_offered_for_an_unrelated_failure(isolated_project):
    """A project may keep a src/; most of what breaks a model has nothing to do
    with it, and a hint on every failure is a hint nobody reads."""
    (isolated_project / "src").mkdir()
    (isolated_project / "model.py").write_text("import nonexistent_module\n",
                                               encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        load_model()
    assert "carries a `src` of its own" not in str(exc.value)


def test_the_src_hint_is_not_offered_when_the_project_has_no_src(isolated_project):
    (isolated_project / "model.py").write_text(
        "import src.cadbuild.does_not_exist\n", encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        load_model()
    assert "carries a `src` of its own" not in str(exc.value)


def test_a_model_missing_half_the_contract_is_refused(isolated_project):
    (isolated_project / "model.py").write_text(
        "def parts():\n    return {}\n", encoding="utf-8")
    with pytest.raises(BuildError) as exc:
        load_model()
    assert "does not define views()" in str(exc.value)


def test_the_project_root_goes_on_sys_path_first(isolated_project):
    """`import mocks` in a model.py must find the project's own mocks.py."""
    (isolated_project / "mocks.py").write_text("MARKER = 'the project one'\n",
                                               encoding="utf-8")
    write_model(isolated_project, extra="import mocks")
    model = load_model()
    assert sys.path[0] == str(isolated_project)
    assert model.mocks.MARKER == "the project one"


def test_the_root_is_not_added_twice(isolated_project):
    write_model(isolated_project)
    load_model()
    sys.modules.pop("model", None)
    load_model()
    assert sys.path.count(str(isolated_project)) == 1


# --------------------------------------------------------------------------
# The checklib the model actually got
# --------------------------------------------------------------------------

def test_the_packaged_checklib_is_used_when_the_project_has_none(isolated_project,
                                                                 capsys):
    write_model(isolated_project, extra="import checklib")
    load_model()
    assert "shadows it" not in capsys.readouterr().out


def test_a_project_copy_of_checklib_is_said_out_loud(isolated_project, capsys):
    """Silent and lossy: the model fills one record, metrics reads the other."""
    (isolated_project / "checklib.py").write_text(
        "def recorded_interference():\n    return {}\n", encoding="utf-8")
    write_model(isolated_project, extra="import checklib")
    load_model()
    printed = capsys.readouterr().out
    assert "shadows it" in printed
    assert "Delete\nchecklib.py" in printed or "Delete checklib.py" in printed


def test_a_model_that_never_imports_checklib_is_not_warned_about(isolated_project,
                                                                 capsys):
    write_model(isolated_project)
    load_model()
    assert "shadows it" not in capsys.readouterr().out


# --------------------------------------------------------------------------
# Reading what the model handed over
# --------------------------------------------------------------------------

def test_as_shape_unwraps_a_workplane():
    shape = Shape()
    assert as_shape(Workplane(shape), "where") is shape


def test_as_shape_accepts_a_bare_shape():
    shape = Shape()
    assert as_shape(shape, "where") is shape


def test_as_shape_refuses_something_that_is_not_geometry():
    with pytest.raises(BuildError) as exc:
        as_shape("not a solid", "printable 'body'")
    assert "printable 'body'" in str(exc.value)


def test_as_shapes_returns_every_body_not_just_the_first():
    """`val()` is the first body only, which is how .add() parts got missed."""
    first, second = Shape(), Shape()
    assert as_shapes(Workplane(first, second), "where") == [first, second]


def test_as_shapes_wraps_a_bare_shape():
    shape = Shape()
    assert as_shapes(shape, "where") == [shape]


def test_an_empty_stack_is_refused():
    with pytest.raises(BuildError) as exc:
        as_shapes(Workplane(), "view 'print'")
    assert "holds no geometry at all" in str(exc.value)


def test_a_stack_holding_something_that_is_not_geometry_is_refused():
    with pytest.raises(BuildError):
        as_shapes(Workplane(Shape(), "not a solid"), "view 'print'")


def test_drop_mesh_walks_every_body(monkeypatch):
    """Per body, not `val()`: each body carries its own triangulation, so one
    left meshed makes the next BoundingBox() read that body off its mesh.

    THE WALK IS ALL THIS CAN SEE. `Clean_s` is a stub here, so nothing about
    what a mesh does to a box, or about which copies of a shape share one, can
    be asserted from this test -- that used to be a sentence in this docstring
    ("a shape shares its triangulation through the TShape") standing in for
    evidence, and it was half wrong: a `translate()` copy shares nothing.
    `test_drop_mesh.py` is where those claims are measured on the real kernel.
    """
    cleaned = []
    monkeypatch.setitem(
        sys.modules, "OCP",
        type(sys)("OCP"),
    )
    module = type(sys)("OCP.BRepTools")
    module.BRepTools = type("BRepTools", (), {"Clean_s": staticmethod(cleaned.append)})
    monkeypatch.setitem(sys.modules, "OCP.BRepTools", module)

    class Meshed(Shape):
        def __init__(self, tag):
            super().__init__()
            self.wrapped = tag

    geometry.drop_mesh(Workplane(Meshed("first"), Meshed("second")))
    assert cleaned == ["first", "second"]


def test_drop_mesh_leaves_a_shape_with_nothing_wrapped_alone(monkeypatch):
    module = type(sys)("OCP.BRepTools")
    module.BRepTools = type("BRepTools", (), {"Clean_s": staticmethod(_never)})
    monkeypatch.setitem(sys.modules, "OCP", type(sys)("OCP"))
    monkeypatch.setitem(sys.modules, "OCP.BRepTools", module)
    geometry.drop_mesh(Workplane(Shape(), Shape()))


def _never(_wrapped):
    raise AssertionError("nothing to clean here")
