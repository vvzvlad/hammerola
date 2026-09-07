"""Every door into a model.py answers for it in the same terms.

`modelchecks.MODEL_DOORS` IS THE LIST, and this file deliberately does not say
how long it is -- `len(MODEL_DOORS)` is the only spelling of that number. The
rule every entry owes is one rule: whatever the author's own code raises leaves
as a `BuildError`, which the build process turns into EXIT_BUILD_FAILED -- "the
model said no" -- rather than into EXIT_CRASHED, which the hub reports to
whoever pushed as "the build crashed".

IT WAS TRUE OF HALF OF THEM, and the half it was false of was the half nobody
had written a test for. `checklib.measured/derived/estimated` refuse a note that
cannot be published with a `ValueError`, and refusing THERE is only worth
anything because the build then blames the model; written inside `parts()` or
`views()`, the identical typo travelled out as a bare ValueError and the pusher
was told the hub had fallen over.

WHAT THIS FILE IS NOT ABOUT, said plainly because most of it used to be: a
model.py that is fighting the hub. There is nobody here to fight it -- the file
is the owner's own code, pushed with the owner's own secret, from the owner's
own repository -- so everything below is about the author who made a MISTAKE and
has to be told which line it is on. AGENTS.md and SPEC 7.9 carry the reasoning
and what it cost to learn.

EACH DOOR IS DRIVEN, AND THE DRIVER IS WHAT MAKES THE LIST WORTH ANYTHING. The
first version of this file held a table mapping each entry to the NAME of a
test, and asserted that some file defined a function by that name. That is a
check on spelling: it went green with `call_model` deleted from a door, and
green again with `return` inserted as the first line of the test it named.
`DRIVERS` below holds callables instead -- one per entry, each of which reaches
ITS door and no other -- and the parametrised test drives them.

THE SITE IS READ OUT OF THE TRACEBACK rather than written down twice.
`MODEL_DOORS` gives each entry a site, and `door_site` below derives the same
string from the exception the driver produced -- the frame the BuildError left
the door by, plus the guarded callable when it is one of ours. So a guard that
MOVES fails here, which a test asserting only "a BuildError came out" cannot
notice; and the list stops being a description of the code and becomes a
measurement of it.

The same bad note is used at every door that can take one -- a lone surrogate,
which is what `bytes.decode(errors="surrogateescape")` hands back without
anybody meaning harm.

The end-to-end witness for the import -- the exit code the message becomes --
lives where an exit code exists, in
`tests/buildproc/test_build_child.py::test_a_note_that_cannot_be_published_is_a_failed_build`.
"""

from types import SimpleNamespace
import importlib.util
import pathlib
import sys
import textwrap
import traceback

import pytest

from src.cadbuild import build as build_module
from src.cadbuild import modelchecks, paths
from src.cadbuild.build import build
from src.cadbuild.errors import BuildError
from src.cadbuild.gate import check_print_layout
from src.cadbuild.geometry import as_shape, as_shapes, load_model
from src.cadbuild.modelchecks import MODEL_DOORS, run_checks
from src.cadbuild.parts import read_catalogue

from fakes import node, view

# A note that cannot be encoded, written the way an author meets it. The
# constructor refuses it with a ValueError, and where that ValueError lands is
# the whole subject of this file.
BAD_NOTE = '"\\ud800 decoded loosely"'

# This package's own directory, for telling a frame of the hub's from a frame of
# the model's.
PACKAGE = pathlib.Path(modelchecks.__file__).resolve().parent


def a_model(root, body):
    """A model.py on disk, imported the way the build imports one.

    On disk rather than as a namespace built by hand, because half of what is
    under test is the FILE the message names: the point of `fail_site` is that
    the author is sent to a line of their own model and not to a line of
    `checklib.py`, and only a real file can show that. `provenance` needs the
    file for a second reason -- it reads the source back to find the line a
    number is bound on.
    """
    path = root / "model.py"
    path.write_text(textwrap.dedent(body).lstrip("\n"), encoding="utf-8")
    spec = importlib.util.spec_from_file_location("model_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(root))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(root))
        sys.modules.pop("model_under_test", None)
    return module


def names_the_model_and_not_the_hub(message):
    """The message sends the author to their own file.

    `checklib.py` is where the refusal is RAISED -- it is the deepest frame --
    and it is a file the author did not write and cannot open. Naming it was the
    defect `fail_site` was changed to fix, so both halves are asserted: the
    model's file is named, and ours is not.
    """
    assert "model.py:" in message, message
    assert "checklib.py" not in message, message


# --------------------------------------------------------------------------
# Where a BuildError came from, read out of the traceback
# --------------------------------------------------------------------------

def _where(frame):
    """`<module>.<function>` for one frame of a traceback."""
    return f"{pathlib.Path(frame.filename).stem}.{frame.name}"


def _is_ours(frame):
    return pathlib.Path(frame.filename).resolve().parent == PACKAGE


def _is_the_wrapper(frame):
    """The frame of `modelchecks.call_model` itself, which names no door."""
    return frame.name == "call_model" and _is_ours(frame)


def door_site(error):
    """The site of the door a BuildError came out of, as MODEL_DOORS spells it.

    TWO TRACEBACKS ARE READ AND THEY ANSWER DIFFERENT HALVES. The BuildError's
    own gives the frame it was RAISED in, minus `call_model`, which is a wrapper
    and not a place -- that is the function whose body the door is written into.
    The original exception's, reachable because every door raises `from exc`,
    gives what was being CALLED: its first frame is `call_model` at
    `func(*args)` and the next one is the callable that was guarded.

    THE SECOND HALF IS ONLY WRITTEN DOWN WHEN THE CALLABLE IS OURS, which is
    what makes the notation say something. `geometry.as_shape` guards
    `geometry._first_body` -- this package reading the object the model handed
    over -- and `geometry.as_shapes` guards `geometry._every_body` beside it, so
    one label ("reading a shape model.py handed over") names two doors that only
    the site tells apart. A door whose guarded callable is the model's own
    function has nothing useful to add, so it is the bare caller:
    `parts.read_catalogue` guards `model.parts` and is written with no slash.

    `run_checks` and `load_model` do their own catching rather than going
    through `call_model`, and they fall out of this correctly without a special
    case: their cause's first frame is themselves, not the wrapper, so no
    guarded callable is recorded and the site is the function's own name.
    """
    frames = [frame for frame in traceback.extract_tb(error.__traceback__)
              if not _is_the_wrapper(frame)]
    assert frames, "a BuildError with no traceback outside call_model"
    caller = _where(frames[-1])

    cause = error.__cause__
    if cause is None:
        return caller
    inner = traceback.extract_tb(cause.__traceback__)
    if len(inner) < 2 or not _is_the_wrapper(inner[0]):
        return caller
    guarded = inner[1]
    return f"{caller}/{_where(guarded)}" if _is_ours(guarded) else caller


# --------------------------------------------------------------------------
# What a driver is given
# --------------------------------------------------------------------------

# `build()` with the numbers walk taken out, for the doors that are further in.
# A namespace rather than a monkeypatch of each function, because `build.py`
# reaches them through the module object.
NO_NUMBERS = SimpleNamespace(collect=lambda model: [],
                             unwrapped=lambda model: [],
                             check=lambda entries, bare, root: None,
                             report=lambda entries: {})


@pytest.fixture
def forget_the_model():
    """`load_model` does a real `import model`; each test gets a fresh one.

    sys.path is restored too, because `load_model` puts the project root on it
    and deliberately never takes it off -- see there.
    """
    before = list(sys.path)
    sys.modules.pop("model", None)
    yield
    sys.modules.pop("model", None)
    sys.path[:] = before


class Doors:
    """What every driver below needs: a model on disk, and a build to drive."""

    def __init__(self, root, out_dir, monkeypatch):
        self.root = root
        self.out_dir = out_dir
        self.monkeypatch = monkeypatch

    def model(self, body):
        return a_model(self.root, body)

    def write(self, body):
        """A model.py that is NOT imported here -- for the import door itself."""
        (self.root / "model.py").write_text(
            textwrap.dedent(body).lstrip("\n"), encoding="utf-8")

    def build(self, body, real_numbers=False):
        """`build()` reaching one door, with everything before it faked away.

        Deliberately not the whole of `test_build.py`'s `driven`: a build that
        stops at a door never reaches an export, a gate or a metric.
        `read_catalogue` is faked because it is ANOTHER door and would otherwise
        answer first, and the numbers walk is faked for the same reason unless
        the door under test is in it.
        """
        model = self.model(body)
        for name, value in (
            ("load_project",
             lambda: ("abc123def456", "scratch", "Scratch (scratch)")),
            ("load_model", lambda: model),
            ("read_catalogue",
             lambda _: {"base": {"shape": None, "kind": "printable",
                                 "color": None, "note": None}}),
        ):
            self.monkeypatch.setattr(build_module, name, value)
        if not real_numbers:
            self.monkeypatch.setattr(build_module, "provenance", NO_NUMBERS)
        build(self.out_dir)


@pytest.fixture
def doors(isolated_project, out_dir, monkeypatch, forget_the_model):
    return Doors(isolated_project, out_dir, monkeypatch)

# --------------------------------------------------------------------------
# One driver per door
# --------------------------------------------------------------------------

def _drive_the_import(doors):
    """The door that was right about the ERROR and silent about the LINE.

    `importing model.py failed: <the ValueError>` carried no file and no line
    while every other door answered `(model.py:5)`, and this is where that
    silence landed most often: `provenance` looks only at module-level names, so
    a refused note is almost always written at the top of the file and raised
    during the import.

    Not written through `a_model`: the whole point of this door is that the
    model is executed by `load_model` itself, so a helper that imported the file
    first would take the exception before the door ever opened.
    """
    doors.write(f"""
        import checklib

        WALL = checklib.estimated(2.4, {BAD_NOTE})

        def parts():
            return {{}}

        def views():
            return []
    """)
    load_model()




def _drive_the_parts_call(doors):
    """The catalogue is read by CALLING the model, and that call was bare."""
    read_catalogue(doors.model(f"""
        import checklib

        def parts():
            gap = checklib.estimated(0.25, {BAD_NOTE})
            return {{"lid": {{"shape": None, "kind": "printable"}}}}
    """))




def _drive_the_views_call(doors):
    doors.build(f"""
        import checklib

        def parts():
            return {{}}

        def views():
            offset = checklib.estimated(1.5, {BAD_NOTE})
            return []
    """)



def _drive_one_shape(doors):
    """`as_shape` asks an object the model built for the geometry it is."""
    model = doors.model("""
        class Awkward:
            def val(self):
                raise ValueError("the shape decided not to say")
    """)
    as_shape(model.Awkward(), "the lid")


def _drive_every_shape(doors):
    """`as_shapes`, the same question spelled for a whole stack."""
    model = doors.model("""
        class Awkward:
            def vals(self):
                raise ValueError("the shape decided not to say")
    """)
    as_shapes(model.Awkward(), "the lid")



def _drive_the_checks_call(doors):
    """The door that was already right -- and the one whose MESSAGE was not.

    It read `checks() raised ValueError (checklib.py:217)`, naming the file the
    refusal is raised in rather than the line the author wrote.
    """
    run_checks(doors.model(f"""
        import checklib

        def checks(out_dir):
            gap = checklib.estimated(0.25, {BAD_NOTE})
            assert gap > 0, "the gap closed"
    """), doors.out_dir)



# WHAT DRIVES EACH ENTRY OF `modelchecks.MODEL_DOORS`. Keyed by the whole entry,
# because the label alone is not unique -- the point of the site is that one
# label can name doors in two places.
#
# ADDING AN ENTRY TO `MODEL_DOORS` NOW COSTS A DRIVER, which is the whole
# purpose: the previous version of this table held the NAME of a test and was
# satisfied by a `def` with that name existing anywhere in two files.
DRIVERS = {
    ("importing model.py", "geometry.load_model"): _drive_the_import,
    ("parts()", "parts.read_catalogue"): _drive_the_parts_call,
    ("views()", "build.build"): _drive_the_views_call,
    ("reading a shape model.py handed over",
     "geometry.as_shape/geometry._first_body"): _drive_one_shape,
    ("reading a shape model.py handed over",
     "geometry.as_shapes/geometry._every_body"): _drive_every_shape,
    ("checks()", "modelchecks.run_checks"): _drive_the_checks_call,
}


def _door_id(door):
    label, site = door
    return f"{label} at {site}"


@pytest.mark.parametrize("door", MODEL_DOORS, ids=_door_id)
def test_every_door_answers_for_the_model_in_build_error_terms(doors, door):
    """One test per entry, and each one drives ITS door.

    THREE THINGS ARE ASSERTED AND THEY FAIL FOR THREE DIFFERENT EDITS. A guard
    deleted stops the `BuildError` coming out at all. A guard MOVED -- to the
    call site, or round a narrower expression -- keeps the BuildError and
    changes the site, which nothing else here would notice. And a message that
    stops naming the model's own line takes the author back to reading forty
    constants to find the one that is wrong.
    """
    label, site = door
    drive = DRIVERS[door]

    with pytest.raises(BuildError) as caught:
        drive(doors)

    error = caught.value
    assert str(error).startswith(label), (
        f"the message does not open with what MODEL_DOORS calls this door "
        f"({label!r}): {str(error)[:200]!r}")
    assert door_site(error) == site, (
        f"the guard for {label!r} is no longer where MODEL_DOORS says it is. "
        f"The traceback says {door_site(error)!r}")
    names_the_model_and_not_the_hub(str(error))


def test_every_door_on_the_list_has_a_driver():
    """An entry with nobody behind it is the failure this list exists to catch.

    `MODEL_DOORS` was added because a number in prose had rotted eight times;
    the list fixes the COUNT and not the coverage, and an entry can be appended
    to it just as easily as a sentence could be edited. This is the half that
    makes appending one cost something.
    """
    assert set(DRIVERS) == set(MODEL_DOORS), (
        "MODEL_DOORS and the drivers standing for it have diverged. Doors with "
        f"no driver: {sorted(set(MODEL_DOORS) - set(DRIVERS))}. Drivers for "
        f"doors that are gone: {sorted(set(DRIVERS) - set(MODEL_DOORS))}")



# --------------------------------------------------------------------------
# What the wrapping must NOT do
# --------------------------------------------------------------------------

def test_a_build_error_from_inside_the_model_is_not_wrapped_again(
        isolated_project):
    """`parts() raised BuildError: ...` would prefix a considered message.

    Everything below the call refuses in BuildError terms already, and a model
    may reach one itself -- `checklib` raises none, but a project's own helper
    importing the build half can. Re-raised untouched, the message stays the one
    somebody wrote.
    """
    model = SimpleNamespace(
        parts=lambda: (_ for _ in ()).throw(BuildError("the lid has no shape")))
    with pytest.raises(BuildError) as exc:
        read_catalogue(model)
    assert str(exc.value) == "the lid has no shape"



SHAPE_THAT_REFUSES = """
    class Refusing:
        def isValid(self):
            return True

        def vals(self):
            return [self]

        def BoundingBox(self):
            raise ValueError("the shape decided not to say")

    def parts():
        return {}

    def views():
        return []
"""


def test_the_shape_itself_is_outside_every_door(isolated_project):
    """The plainest place the per-site guard stops, MEASURED at both levels.

    `as_shape` and `as_shapes` ask for nothing but `hasattr(shape, "isValid")`,
    so the class below -- which holds no cadquery at all -- is accepted as
    geometry, and `gate._bodies` asks the object that passed for a
    `BoundingBox()` one line later, outside every entry in `MODEL_DOORS`. That
    is an ORDINARY ROAD and not an edge: every object a model hands over travels
    it.

    THE PER-SITE GUARD STILL STOPS HERE, and the first half below is what says
    so: a bare `ValueError` comes out of the gate, because wrapping the geometry
    would mean wrapping essentially the whole of `build()` and reporting a
    genuine bug of the hub's to the author as "the model said no".

    WHAT CHANGED IS WHAT THAT COSTS. It used to decide the exit code -- the hub
    telling whoever pushed that it had fallen over, for a class they wrote --
    and the second half is what says it no longer does: driven through `build()`
    with the same class written in a real model.py, the top-level handler sees
    the author's own frame on the traceback and answers in BuildError terms. The
    per-site door is now about the MESSAGE, and this is the shape of what it
    costs when one is missing: `model.py's own code raised ValueError` instead
    of a sentence naming the entrance.
    """
    class Refusing:
        def isValid(self):
            return True

        def vals(self):
            return [self]

        def BoundingBox(self):
            raise ValueError("the shape decided not to say")

    prepared = [view("print", [node("lid", Refusing()),
                               node("cap", Refusing())])]
    parts_read = {key: {"shape": Refusing(), "kind": "printable",
                        "color": None, "note": None}
                  for key in ("lid", "cap")}

    with pytest.raises(ValueError):
        check_print_layout(prepared, parts_read)


def test_the_shape_that_the_gate_chokes_on_is_still_the_authors_fault(
        doors, monkeypatch):
    """The other half of the boundary above, through the whole of `build()`.

    The class is written into a real model.py so that its frame is under the
    project root -- which is the entire question `raised_by_the_model` asks.
    `read_catalogue` and `prepare_views` are faked because they are doors of
    their own and would answer first; the gate they hand their answer to is the
    real one.

    THE PREMISE IS A PYTHON FRAME, and it is a premise rather than a
    guarantee -- a callable that is not a python function leaves none, and the
    handler then has nothing to read. That is why `raised_by_the_model` is
    documented as sufficient and not necessary, and why the two shape doors
    round `as_shape`/`as_shapes` exist at all: an object of the author's that
    raises inside the CAD kernel leaves no frame either.
    """
    model = doors.model(SHAPE_THAT_REFUSES)
    refusing = model.Refusing

    monkeypatch.setattr(build_module, "load_project",
                        lambda: ("abc123def456", "scratch", "Scratch (scratch)"))
    monkeypatch.setattr(build_module, "load_model", lambda: model)
    monkeypatch.setattr(build_module, "provenance", NO_NUMBERS)
    monkeypatch.setattr(build_module, "read_catalogue", lambda _: {
        key: {"shape": refusing(), "kind": "printable", "color": None,
              "note": None}
        for key in ("lid", "cap")})
    monkeypatch.setattr(build_module, "prepare_views", lambda views, cat: [
        view("print", [node("lid", refusing()), node("cap", refusing())])])

    with pytest.raises(BuildError) as caught:
        build(doors.out_dir)

    assert "model.py's own code raised ValueError" in str(caught.value)
    names_the_model_and_not_the_hub(str(caught.value))




def test_a_bug_of_the_hubs_is_not_handed_to_the_author(doors, monkeypatch):
    """The direction that makes the handler safe to have at all.

    A blanket `except Exception` at the top of the build that answered
    "the model said no" to everything would report every bug of ours as the
    author's -- which is the one distinction the whole of `MODEL_DOORS` exists
    to draw. So the handler asks about the TRACEBACK, and an exception with no
    frame from the project's tree on it travels on unchanged and ends as
    EXIT_CRASHED.
    """
    def broken(prepared, cat):
        raise TypeError("a bug of the hub's, with no model frame under it")

    doors.model("""
        def parts():
            return {}

        def views():
            return []
    """)
    monkeypatch.setattr(build_module, "load_project",
                        lambda: ("abc123def456", "scratch", "Scratch (scratch)"))
    monkeypatch.setattr(build_module, "provenance", NO_NUMBERS)
    monkeypatch.setattr(build_module, "read_catalogue", lambda _: {
        "lid": {"shape": None, "kind": "printable", "color": None,
                "note": None}})
    monkeypatch.setattr(build_module, "prepare_views", lambda views, cat: [])
    monkeypatch.setattr(build_module, "check_print_layout", broken)

    with pytest.raises(TypeError):
        build(doors.out_dir)


def test_what_counts_as_a_frame_of_the_models_own(isolated_project):
    """`raised_by_the_model`, at the four answers that decide a build's verdict.

    The project's tree and nothing else: a file of the hub's is not the model,
    and neither is the interpreter's bracketed pseudo-filename for code with no
    file behind it -- `<string>` and `<frozen importlib._bootstrap>` are
    relative, and a build's working directory IS the project root, so taking
    them as paths would read an import failure of the hub's as the author's
    mistake.

    A HELPER OF THE MODEL'S OWN COUNTS, which is the second assertion: the
    question is the project's TREE and not the one file, so a fault raised in a
    `helpers.py` the author wrote beside model.py is still theirs to fix.
    """
    def raised(filename):
        try:
            exec(compile("raise ValueError('boom')", filename, "exec"), {})
        except ValueError as exc:
            return exc

    inside = raised(str(isolated_project / "model.py"))
    assert modelchecks.raised_by_the_model(inside)

    helper = raised(str(isolated_project / "deep" / "helper.py"))
    assert modelchecks.raised_by_the_model(helper)

    elsewhere = raised(str(PACKAGE / "geometry.py"))
    assert not modelchecks.raised_by_the_model(elsewhere)

    nowhere = raised("<string>")
    assert not modelchecks.raised_by_the_model(nowhere)


def test_a_frame_reached_through_a_symlink_is_still_the_models_own(tmp_path):
    """The `realpath` half of `_inside`, which no test had ever run.

    `paths.set_project_root` RESOLVES what it is given, while a frame carries
    whatever string the import used -- so on a host where the project sits under
    a symlinked directory the two spellings disagree for every file of the
    model's, and comparing names alone answers "not the model's" for the whole
    tree. That is the failure the second comparison exists to prevent, and
    deleting the line left the suite green.

    THE LINK IS BUILT HERE rather than borrowed from the host, and that is the
    test rather than a convenience. Left to the ambient filesystem the branch
    runs on a developer's macOS (`/var/...` against `/private/var/...`) and
    never on Linux CI, where `/tmp` is not a link -- so a check that merely
    happened to reach it would be a check that exists on one machine.

    BOTH DIRECTIONS, because a fallback that answers True is not a fallback.
    `realpath` has to bring an outside path INSIDE the root and leave an inside
    path OUTSIDE it; a `return True` passes the first assertion on its own.
    """
    real = tmp_path / "real"
    real.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)
    away = tmp_path / "away"
    away.symlink_to(outside, target_is_directory=True)

    def raised(filename):
        try:
            exec(compile("raise ValueError('boom')", str(filename), "exec"), {})
        except ValueError as exc:
            return exc

    paths.set_project_root(real)
    assert modelchecks.raised_by_the_model(raised(link / "model.py"))
    assert not modelchecks.raised_by_the_model(raised(away / "model.py"))

