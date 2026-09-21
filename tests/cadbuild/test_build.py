"""`build()` driven end to end with the kernel replaced by fakes.

WHY THE WHOLE FUNCTION AND NOT A PIECE OF IT. What is worth holding here is a
branch: what `build` says, renders and DECLARES when a model has no `print`
view. Every one of those is decided in a different line of one function, and
the alternative — lifting the line into a helper so a test could call it —
would move the code to suit the test while leaving the branch around it just as
unwatched.

Nothing below is a stand-in for logic: each patched name is a step that needs a
CAD kernel (`export_printables`, `export_assembled`, `export_views`), reads the
project off disk (`load_project`, `load_model`) or is tested in its own file
(the gates, the metrics). `overview_meshes` and `preview_files` are deliberately
NOT patched — they are pure, and what they declare is the other half of the
branch under test.
"""

from pathlib import Path
from types import SimpleNamespace
import importlib.util
import json
import sys
import textwrap

import pytest

from src.cadbuild import build as build_module
from src.cadbuild import checklib
from src.cadbuild import paths
from src.cadbuild import provenance as real_provenance
from src.cadbuild.artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID,
                                    CARD_SUFFIX, PREVIEW_SUFFIX, PRINT_VIEW_ID)
from src.cadbuild.build import build
from src.cadbuild.errors import BuildError
from src.cadbuild.geometry import load_model as real_load_model
from src.cadbuild.metrics import METRICS_NAME, METRICS_VERSION
from src.cadbuild.metrics import collect_metrics as real_collect_metrics
from src.cadbuild.metrics import write_metrics as real_write_metrics
from src.cadbuild.modelchecks import run_checks as real_run_checks
from src.cadbuild.parts import catalogue_colors

from fakes import catalogue


def files_named_in(meta):
    """Every file meta.json offers a reader, wherever it is filed."""
    named = set()
    for view in meta["views"]:
        named.add(view["file"])
        named.update(view[key] for key in ("overview", "preview", "card")
                     if key in view)
    for part in meta["parts"].values():
        named.update(part.get("files", {}).values())
        if "preview" in part:
            named.add(part["preview"])
    return named


@pytest.fixture
def driven(monkeypatch):
    """Everything `build` reaches outside itself.

    Returns the state the tests steer and read back: `views` is which views the
    model has (a test that gives it a plate adds one), and `rendered`, `colors`
    and `scenes` collect what `render_previews` was asked for.

    `render_previews` is the one fake that answers rather than merely returns:
    it hands back a preview name per stem it was asked for, which is what the
    real one does and what makes `written` — and therefore the pictures and the
    file list — a consequence of the branch under test rather than a constant.

    IT ANSWERS THE CARDS THE SAME WAY, off `scenes` rather than off a list of
    its own: the real one writes a card for exactly the stems that name a scene,
    because those are the whole-view ones and a card is a picture of a project.
    A fake that handed one back for every stem would make `build` look as though
    it filed a card on a part.

    IT KEEPS `colors` AND `scenes` RATHER THAN DROPPING THEM, because those two
    arguments are the whole of what the pictures are drawn FROM and `build` is
    the only place they are assembled. Keying `scenes` by view id instead of by
    file stem, or handing the renderer no colour at all, puts the old flat-blue
    picture back with every test in this suite still green.

    `prepare_views` and `export_views` are wired to ONE list for the same
    reason: a build with a plate has a `print` view, and a fixture that let
    those two disagree would be testing a state no build can be in.
    """
    state = SimpleNamespace(rendered=[], views=[ASSEMBLED_VIEW_ID],
                            catalogue=catalogue(base="printable"),
                            colors=None, scenes=None)

    def render_previews(out_dir, stems, mode, parts=None, colors=None,
                        scenes=None):
        state.rendered.extend(stems)
        state.colors = colors
        state.scenes = scenes
        return ([f"{stem}{PREVIEW_SUFFIX}" for stem in stems],
                {stem: f"{stem}{CARD_SUFFIX}" for stem in stems
                 if stem in (scenes or {})})

    for name, value in (
        # A title in the form the hub asks for, because the test below asserts
        # this build warns about NOTHING: a title with no slug in its brackets
        # is one of the two things `build` now prints a `warning:` line for.
        ("load_project",
         lambda: ("abc123def456", "scratch", "Scratch (scratch)")),
        ("load_model", lambda: SimpleNamespace(parts=lambda: {},
                                               views=lambda: [])),
        ("read_catalogue", lambda model: state.catalogue),
        ("prepare_views", lambda views, cat: [{"id": vid} for vid in state.views]),
        ("check_print_layout", lambda prepared, cat: None),
        ("check_assembled_coverage", lambda prepared, cat: None),
        ("check_interference", lambda prepared, cat: None),
        ("export_printables", lambda cat, out_dir: (
            {"base": {"step": "base.step", "stl": "base.stl",
                      "3mf": "base.3mf"}}, {})),
        ("run_checks", lambda model, out_dir: (0, 0)),
        # `(parts, bbox)`, in the shape the real one hands back: the count the
        # preview needs, and the box that becomes `assembly.bbox_mm`. The box
        # is None here for the reason the plate's stubs pass None -- what
        # `collect_metrics` makes of it is that function's own test. It takes
        # the CATALOGUE too, because the box is the product's own envelope and
        # a leaf's kind is what keeps the scenery out of it.
        ("export_assembled", lambda prepared, out_dir, cat: (1, None)),
        ("export_views", lambda prepared, out_dir: [
            {"id": view["id"], "name": view["id"], "file": f"{view['id']}.json",
             "parts": ["base"]} for view in prepared]),
        # The provenance rule reads model.py back OFF DISK to find the line of
        # every number in it, and the model here is a SimpleNamespace with no
        # file behind it. Faked as ONE OBJECT rather than as its individual
        # names because `build` imports the module, not its functions -- so a
        # name added to the real module has to be added here too.
        ("provenance", SimpleNamespace(module_level_lines=lambda: {},
                                       collect=lambda model, lines=None: [],
                                       unwrapped=lambda model, lines=None: [],
                                       check=lambda entries, bare, root: None,
                                       report=lambda entries: {})),
        ("collect_metrics",
         lambda project, parts, passed, static, provenance, bbox, plate: {}),
        ("write_metrics", lambda out_dir, metrics: None),
        ("render_previews", render_previews),
    ):
        monkeypatch.setattr(build_module, name, value)
    return state


@pytest.fixture
def with_the_real_rule(driven, monkeypatch, isolated_project):
    """`driven`, but with the REAL provenance module over a real model.py.

    THIS FIXTURE EXISTS BECAUSE THE RULE COULD BE DELETED FROM `build()` AND THE
    SUITE STAYED GREEN. Removing the `provenance.check(...)` line gave an
    identical green run of tests/cadbuild, tests/buildproc and
    tests/test_template.py: the fixture above replaces the whole module with a
    stub, `tests/cadbuild/test_provenance.py` calls `collect`/`check` through a
    helper of its own, and the one end-to-end witness -- the template build --
    is importorskip'ped wherever the CAD kernel is absent — which CI no longer is
    (issue #27), so that witness does run on a push now; what this file covers is
    the machine that has no kernel, where the rule was tested thoroughly and its
    CALL was not tested at all. Nothing here needs a kernel: everything that would touch one is already
    faked by `driven`, and what is real is the parse, the walk and the refusal.

    Returns a function that writes model.py and points `build` at it.
    """
    monkeypatch.setattr(build_module, "provenance", real_provenance)
    written = SimpleNamespace(passed=None)

    def collect_metrics(project, parts, checks_passed, checks_static, provenance,
                        bbox, print_bbox):
        # What `report()` handed back, captured where `build` puts it. It is the
        # third of the three calls, and the only one whose result leaves the
        # function -- so it is what says the three ran in the right order.
        written.passed = provenance
        return {}

    monkeypatch.setattr(build_module, "collect_metrics", collect_metrics)

    def write(source):
        path = isolated_project / "model.py"
        # The contract goes AFTER, so line 1 of the file is the first line the
        # test wrote and a test asserting a line number is not agreeing with the
        # length of a preamble. `read_catalogue` is faked, but `build` calls
        # `model.views()` itself.
        path.write_text(
            textwrap.dedent(source).lstrip("\n")
            + "\n\ndef parts():\n    return {}\n\n\ndef views():\n    return []\n",
            encoding="utf-8")
        spec = importlib.util.spec_from_file_location("model_under_build", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(build_module, "load_model", lambda: module)
        return written

    return write


def test_build_refuses_a_model_whose_numbers_declare_nothing(
        with_the_real_rule, out_dir, capsys):
    """The call, not the rule: `build()` itself, over a file on disk.

    A bare module-level UPPER_SNAKE float has to stop the build HERE, in the
    function that is supposed to ask. Delete the `provenance.check(...)` line
    from `build()` and this goes red -- which is the whole point of it, and is
    how it was verified.

    The model also carries a declared number, which pins the ORDER of the three
    lines: `check` refuses before `report` prints, so a build that is not going
    to happen does not first announce its estimates. Swap those two and the last
    assertion goes red.
    """
    with_the_real_rule("""
        import checklib

        BOSS_SLOP = 0.35
        WALL = checklib.estimated(2.4, "a first guess, nobody measured")
    """)

    with pytest.raises(BuildError) as exc:
        build(out_dir)

    message = str(exc.value)
    assert "BOSS_SLOP" in message
    assert "line 3" in message, "and it names where to go"
    assert "WALL" not in message, "the declared one is not on the list"
    assert "estimate:" not in capsys.readouterr().out


def test_build_accepts_the_same_number_once_it_is_declared(
        with_the_real_rule, out_dir, capsys):
    """The other direction, and it is not optional: a test that only proves a
    refusal is satisfied by a `check` that refuses everything."""
    state = with_the_real_rule("""
        import checklib

        BOSS_SLOP = checklib.estimated(0.35, "a first guess, nobody measured")
    """)

    build(out_dir)

    assert "estimate: BOSS_SLOP" in capsys.readouterr().out
    assert state.passed == {
        "measured": 0, "derived": 0, "estimated": 1,
        "estimates": ["BOSS_SLOP"],
        "notes": {"BOSS_SLOP": "a first guess, nobody measured"},
    }, ("the summary `report()` built reached metrics.json -- which is also "
        "what says `collect` ran before `report`, since a report of an empty "
        "list is `{}`")


def test_the_numbers_walk_answers_for_the_model_the_way_every_other_door_does(
        with_the_real_rule, out_dir):
    """Reading the numbers RUNS THE MODEL'S CODE, which is not obvious.

    Nothing in `provenance.collect` calls a function the author wrote -- it
    walks `vars(model)` and parses a file -- so the two lines look like a pass
    over data rather than a door. They are not: everything the walk touches
    inside a container is the model's, and `.items()` on a dict SUBCLASS is the
    plainest case of it. It can raise anything at all.

    THE VERDICT IS THE POINT AND NOT THE MESSAGE. Without `call_model` around
    them the raise leaves `build()` bare, which leaves the build PROCESS bare,
    which the hub reports as EXIT_CRASHED (4) -- the hub's own fault -- for a
    line the model wrote. `pytest.raises(BuildError)` is what says so here: the
    unwrapped ValueError fails this test rather than satisfying it.

    IT USED TO REACH THAT THROUGH A KEY'S `__repr__`, and that is no longer a
    raise at all -- `_one_level` renders the key with `modeltext.shown`, which
    answers `<unprintable: ValueError>` rather than taking the build down. The
    test beside this one is the witness for that half; this one had to move to a
    door the chokepoint does not stand in, because a walk over the model's own
    objects has more of them than rendering.
    """
    with_the_real_rule("""
        import checklib


        class Awkward(dict):
            def items(self):
                raise ValueError("the table decided not to say")


        TABLE = Awkward({"lid": checklib.estimated(1.0, "settled by eye")})
    """)

    with pytest.raises(BuildError) as exc:
        build(out_dir)

    message = str(exc.value)
    assert "raised ValueError" in message
    assert "the table decided not to say" in message
    assert "model.py:" in message, (
        "the refusal names the model's own line, which is the whole of what "
        "`fail_site` is doing in this path")


def test_a_key_that_will_not_render_costs_its_name_and_not_the_build(
        with_the_real_rule, out_dir, capsys):
    """The other half of the door above, and the reason `shown` swallows.

    `check()` exists to answer a model in ONE error listing every number that
    declares nothing, and `report()` to list every estimate. One `__repr__` with
    a bug in it, among fifty entries, must not reduce either to a line about a
    RuntimeError -- so the rendering of a value is where the exception stops,
    and what the author loses is that entry's NAME rather than the message.

    The placeholder names the exception on purpose: `<unprintable>` alone sends
    an author looking for a bug in the hub.
    """
    with_the_real_rule("""
        import checklib


        class Weird:
            def __repr__(self):
                raise ValueError("the key decided not to say")


        TABLE = {Weird(): checklib.estimated(1.0, "settled by eye"),
                 "lid": checklib.estimated(2.0, "settled by eye")}
    """)

    build(out_dir)

    printed = [line for line in capsys.readouterr().out.splitlines()
               if line.startswith("estimate:")]
    assert len(printed) == 2, (
        "the entry beside the broken one is what the swallow buys, and it is "
        "the whole argument for swallowing")
    assert any("<unprintable: ValueError>" in line for line in printed), printed


def test_the_rule_is_asked_about_the_project_being_built(
        with_the_real_rule, out_dir, isolated_project, monkeypatch):
    """The THIRD argument, asserted AS an argument and not through an outcome.

    `check` resolves every `measured()` source against the root it is handed, so
    a build passing the wrong one would report a journal as missing that is
    sitting right there -- or, worse, resolve against a directory that is not
    the push's.

    IT USED TO BE ASSERTED THROUGH THE OUTCOME -- a journal at the root, a build
    that does not raise -- and that could not tell the right argument from a
    lucky one: `isolated_project` chdirs into the root it pins, so `Path.cwd()`
    and `project_root()` are the same directory and replacing one with the other
    left this green.

    THE DECOY IS WHAT MOVES THE ASSERTION ONTO THE ARGUMENT. Chdir'ing away is
    enough to make the substitution fail, but it fails by not resolving the
    journal -- an outcome again, and one that says nothing about a root that
    resolves and is still the wrong directory. With the same journal reachable
    from the working directory too, `Path.cwd()` builds perfectly well and the
    only thing left that can tell the two apart is the spy.

    `paths.project_root()` and not `build_module.project_root`: the second is
    the very name under test, so a substituted one would be compared against
    itself and agree.
    """
    (isolated_project / "ref").mkdir(exist_ok=True)
    journal = "# Measurements\n\n## Lid fit\n\n0.25 mm on the calipers\n"
    (isolated_project / "ref" / "measurements.md").write_text(
        journal, encoding="utf-8")
    # The decoy, at the same relative path under the directory the build runs
    # IN rather than the directory it is ABOUT.
    (isolated_project / "ref" / "ref").mkdir()
    (isolated_project / "ref" / "ref" / "measurements.md").write_text(
        journal, encoding="utf-8")
    with_the_real_rule("""
        import checklib

        GAP = checklib.measured(0.25, "ref/measurements.md#lid-fit")
    """)

    handed = []
    real_check = real_provenance.check

    def spy(declared, bare, root):
        handed.append(root)
        return real_check(declared, bare, root)

    monkeypatch.setattr(build_module.provenance, "check", spy)
    # Somewhere INSIDE the project, so nothing else about the build moves: the
    # root is still found from here, and only the answer to "what is the working
    # directory" changes.
    monkeypatch.chdir(isolated_project / "ref")

    build(out_dir)  # no BuildError: the source resolved under the project root

    assert handed == [paths.project_root()]
    assert handed != [Path.cwd()], (
        "and the two are different directories here, which is what makes the "
        "assertion above discriminating rather than a coincidence")

    # And the outcome as well, so the argument is one `check` actually resolves
    # against rather than one it takes and ignores: the project's journal gone,
    # the decoy left where it is.
    (isolated_project / "ref" / "measurements.md").unlink()
    with pytest.raises(BuildError) as exc:
        build(out_dir)
    assert "ref/measurements.md" in str(exc.value)


@pytest.fixture
def with_a_plate(driven, monkeypatch):
    """The model that HAS a `print` view, laid out and exported."""
    driven.views.append(PRINT_VIEW_ID)
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: (2, None))
    return driven


def view_named(meta, vid):
    return next(view for view in meta["views"] if view["id"] == vid)


def test_a_build_with_no_print_view_says_so_without_telling_the_author_off(
        driven, monkeypatch, out_dir, capsys):
    """The line carries NO `warning:` prefix, and that is load-bearing.

    `tests/test_template.py` turns every line of a build log that starts with
    `warning:` into a failure, and it is right to: a warning is something the
    author has to go and fix. Having no `print` view is not — a single-part
    model whose one part is already in print orientation legitimately has none.
    Prefix this line to "make it more visible" and every such project fails its
    own build test, in the author's repository, over a message about us.

    It also NAMES BOTH ABSENT FILES, and that is the other half of the pin. Two
    files go missing together, and the one somebody then goes looking for is
    `print.stl` — a line about the picture alone leaves them with no way back to
    the reason.

    So the words are pinned here, where the change would be made.
    """
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: None)

    _pid, meta, files = build(out_dir)

    out = capsys.readouterr().out
    # Indented like the rest of the `rendering:` section it is printed inside.
    assert f"  {PRINT_VIEW_ID} view: none, so no {PRINT_VIEW_ID}.stl and no " \
        f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}" in out.splitlines()
    assert [line for line in out.splitlines()
            if line.startswith("warning:")] == []
    # And the branch around the message: nothing is rendered from a plate that
    # was not written, and nothing about one is declared — on the file list or
    # anywhere in meta.json.
    assert PRINT_VIEW_ID not in driven.rendered
    assert f"{PRINT_VIEW_ID}.stl" not in files
    assert f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}" not in files
    assert [view["id"] for view in meta["views"]] == [ASSEMBLED_VIEW_ID]


def test_a_build_with_a_print_view_declares_the_plate_and_says_nothing(
        with_a_plate, out_dir, capsys):
    """The other side of the same branch: the plate is DECLARED, not stowed away.

    Being written into the output directory is not what gets a file published —
    it is what got these files to the site without being hashed by
    `store._hash_output` or name-checked by `runner._verified_files` (issue
    #53). `files` is the declaration, and this is what says the plate and its
    picture are on it.
    """
    _pid, meta, files = build(out_dir)

    assert f"{PRINT_VIEW_ID} view: none" not in capsys.readouterr().out
    # The plate is rendered too, which is why it is exported BEFORE the
    # pictures: a stem whose STL is missing is refused by `render_previews`.
    assert PRINT_VIEW_ID in with_a_plate.rendered
    assert f"{PRINT_VIEW_ID}.stl" in files
    assert f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}" in files
    assert f"base{PREVIEW_SUFFIX}" in files


def test_a_whole_view_is_drawn_from_the_document_the_browser_itself_loads(
        driven, out_dir):
    """`scenes` is what makes the assembly picture the picture of the assembly.

    The view DOCUMENT carries a colour, an alpha and a placement per part where
    the STL beside it carries none of the three, so a whole-view stem is handed
    the file the browser loads and the renderer draws THAT. Without the map
    reaching the renderer at all, it falls back to the mesh and the old flat
    blue blob comes back with every test in this suite still green -- which is
    what this holds: that `scenes` is passed, that it names the right FILE, and
    that it carries exactly the whole-view stems and no others.

    WHAT IT CANNOT TELL APART is the two keyings, and that is worth saying
    rather than leaving to be discovered: `ASSEMBLED_STEM` and
    `ASSEMBLED_VIEW_ID` are both "assembled" and "print" is one word doing both
    jobs, so a map keyed by view id is the same dict as one keyed by file stem,
    today. The two namespaces meet only because the strings happen to be equal;
    `build`'s own `stem_of_view` is the translation, says so at length, and is
    what stops compiling on the rename that would make them differ.

    A printable is NOT in it: its own picture is drawn from its own STL, which
    is what `colors` below is for.
    """
    build(out_dir)

    assert driven.scenes == {ASSEMBLED_STEM: f"{ASSEMBLED_VIEW_ID}.json"}
    # The catalogue's colour per part, so the picture of a printable and that
    # same part inside the assembly are one colour and a reader can pair them.
    assert driven.colors == catalogue_colors(driven.catalogue)
    assert driven.colors["base"], "the printable reached the renderer unpainted"


def test_the_plate_picture_is_drawn_from_the_plate_s_own_document(
        with_a_plate, out_dir):
    """The other side of that branch: a build WITH a plate names two documents.

    `print.json` is a different arrangement of the same parts — laid out flat on
    the bed — so a plate drawn from the assembled document would be a picture of
    the wrong thing, and `print_preview.png` is exactly the picture somebody
    opens to catch a part lying face down.
    """
    build(out_dir)

    assert with_a_plate.scenes == {
        ASSEMBLED_STEM: f"{ASSEMBLED_VIEW_ID}.json",
        PRINT_VIEW_ID: f"{PRINT_VIEW_ID}.json"}


def test_every_phase_of_a_build_is_timed_and_the_marks_run_end_to_end(
        driven, monkeypatch, out_dir):
    """The timing itself, held on the CALL rather than on the log text.

    NOTHING HELD IT BEFORE. The phase table is how somebody with no CAD kernel
    on their machine finds out where a slow build went, and every
    assertion about it lived in a comment: a phase could be dropped, or its mark
    reset to the start of the build, and the suite would not have moved. Reading
    it back off the printed lines would be a test of the format instead — the
    fact worth holding is that `build` ASKS for each phase, in order, from the
    mark the phase before it handed back.

    THE MARK IS A COUNTER AND NOT A CLOCK, which is what makes the second
    assertion exact rather than approximate: `_phase`'s return value is only
    ever passed straight back in as the next `since`, so a stand-in may hand
    back anything it can recognise later. A wall clock would only support "the
    numbers go up".

    `total` IS THE EXCEPTION AND IS ASSERTED AS ONE: it is measured from the
    beginning of the build rather than from the phase before it, so it is the
    one call whose `since` is `build`'s own starting mark.

    AND THIS IS WHERE A REORDER SURFACES, which it did: `previews` comes AFTER
    `tessellation` rather than inside `rendering`, because a picture of a whole
    view is drawn from the view DOCUMENT the tessellation writes. Put back the
    other way round it would draw from files that do not exist yet, and the only
    other thing that would notice is somebody opening the PNG.
    """
    calls = []

    def phase(name, since):
        calls.append((name, since))
        return len(calls)

    monkeypatch.setattr(build_module, "_phase", phase)

    build(out_dir)

    assert [name for name, _since in calls] == [
        "model", "geometry", "printables", "checks", "rendering",
        "tessellation", "previews", "total"], (
        "a phase was dropped, renamed or reordered; the log's table is the only "
        "account of where a slow build spent its time")
    assert [since for _name, since in calls[1:-1]] == [1, 2, 3, 4, 5, 6], (
        "a phase is the gap between two marks, and one of these was measured "
        "from somewhere other than the end of the phase before it")
    assert calls[-1][1] == calls[0][1], (
        "`total` is measured from the start of the build, which is the same "
        "mark the first phase was measured from")


def test_a_build_reports_its_metrics_and_it_is_the_CALL_that_is_held(
        driven, monkeypatch, out_dir, isolated_project):
    """`report_metrics` existed, was documented in five places and was called
    from NOWHERE, for as long as nothing held the call (issue #59).

    So what this asserts is the call itself: that `build()` makes it, with its
    own output directory, and with the baseline it was handed — read through
    `read_baseline`, which is the other half of the wire. A test that looked for
    a line in the log would be satisfied by a line printed from anywhere at all,
    and what broke was never the format.

    BOTH BRANCHES, because the summary is unconditional now: a build with a
    baseline reports against it, and a build with none reports anyway and
    carries the reason there is nothing to compare with.
    """
    calls = []
    monkeypatch.setattr(
        build_module, "report_metrics",
        lambda out, previous, why: calls.append((out, previous, why)))
    published = {"version": METRICS_VERSION, "parts": {}}
    baseline = isolated_project / "baseline.json"
    baseline.write_text(json.dumps(published), encoding="utf-8")

    build(out_dir, baseline=str(baseline))
    build(out_dir)

    assert calls[0] == (out_dir, published, None), (
        "the build did not hand `report_metrics` its own output directory and "
        "the parsed baseline it was given")
    where, previous, why = calls[1]
    assert (where, previous) == (out_dir, None)
    assert why, "a build with no baseline still reports, and says why it cannot diff"


def test_a_whole_build_mesh_is_filed_under_the_view_it_is_of(
        with_a_plate, out_dir):
    """`assembled.stl` and `print.stl` are pictures of a VIEW, so they hang off
    the view rather than sitting in a flat map keyed by a stem that was
    sometimes a part and sometimes a view id."""
    _pid, meta, _files = build(out_dir)

    assembled = view_named(meta, ASSEMBLED_VIEW_ID)
    assert assembled["overview"] == f"{ASSEMBLED_STEM}.stl"
    assert assembled["preview"] == f"{ASSEMBLED_STEM}{PREVIEW_SUFFIX}"
    plate = view_named(meta, PRINT_VIEW_ID)
    assert plate["overview"] == f"{PRINT_VIEW_ID}.stl"
    assert plate["preview"] == f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}"


def test_the_card_picture_hangs_on_the_view_and_never_on_a_part(
        with_a_plate, out_dir):
    """The front page's own picture, filed where `preview` is filed.

    A card shows one picture of a PROJECT, so the only pictures that can be one
    are the whole-view renders — the assembly and the plate. A part's render is
    a picture of a part and no card ever shows it, which is why nothing writes
    one for it and why the record must not carry the key: a part entry with a
    `card` on it would be a file the build never wrote, and the hub refuses a
    pointer at a name the build did not declare (422 on the push).

    DECLARED AS WELL AS NAMED. `files` is what `runner._verified_files` checks
    and `store._hash_output` hashes, and the hub answers for nothing outside it
    — so a card named in meta.json and missing from that list publishes with a
    201 and 404s on the front page, which is the exact failure issue #53 was.
    """
    _pid, meta, files = build(out_dir)

    assert view_named(meta, ASSEMBLED_VIEW_ID)["card"] == \
        f"{ASSEMBLED_STEM}{CARD_SUFFIX}"
    assert view_named(meta, PRINT_VIEW_ID)["card"] == \
        f"{PRINT_VIEW_ID}{CARD_SUFFIX}"
    assert f"{ASSEMBLED_STEM}{CARD_SUFFIX}" in files
    assert f"{PRINT_VIEW_ID}{CARD_SUFFIX}" in files
    # The printable keeps its own picture and gains no card, and no card of its
    # name is declared either.
    assert meta["parts"]["base"]["preview"] == f"base{PREVIEW_SUFFIX}"
    assert "card" not in meta["parts"]["base"]
    assert f"base{CARD_SUFFIX}" not in files


def test_a_view_named_after_a_part_does_not_get_that_part_s_picture(
        driven, monkeypatch, out_dir):
    """The collision the explicit `stem_of_view` translation closed.

    `previews` is keyed by a FILE STEM and a printable's stem is its catalogue
    key, so a view whose id happens to equal a part's name used to be handed
    that PART's picture for its tab -- a plain `entry["id"] in previews` finds
    it, and the tab then shows one part where the view shows the assembly.
    Nothing in the contract stops an author calling a view after a part: view
    ids are held to the member alphabet and to the hub's reserved FILE names,
    neither of which knows what the catalogue holds.
    """
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: None)
    driven.views.append("base")

    _pid, meta, _files = build(out_dir)

    named_after_a_part = view_named(meta, "base")
    assert "preview" not in named_after_a_part
    assert "overview" not in named_after_a_part
    # ...and the part still has its own, so this is about which side the file
    # was filed under and not about a picture that stopped being rendered.
    assert meta["parts"]["base"]["preview"] == f"base{PREVIEW_SUFFIX}"


def test_a_part_carries_its_own_files_and_nothing_else_does(
        with_a_plate, out_dir):
    """The ownership is STATED rather than parsed. It used to be a flat
    `downloads` map keyed by `<part>.<ext>`, which every reader had to cut back
    apart — and the viewer did that by splitting at a dot, so a part with a dot
    in its name landed on another part's row."""
    with_a_plate.catalogue = catalogue(base="printable", screw="hardware",
                                       wall="mock")
    _pid, meta, _files = build(out_dir)

    assert meta["parts"]["base"]["kind"] == "printable"
    assert meta["parts"]["base"]["files"] == {
        "step": "base.step", "stl": "base.stl", "3mf": "base.3mf"}
    # Nothing is exported for what is bought or for what is only scenery, so
    # neither carries the key at all -- an empty map would be a build SAYING it
    # has files for a screw.
    assert "files" not in meta["parts"]["screw"]
    assert "files" not in meta["parts"]["wall"]
    assert meta["parts"]["screw"]["kind"] == "hardware"
    assert meta["parts"]["wall"]["kind"] == "mock"


def test_the_whole_catalogue_reaches_meta_json(with_a_plate, out_dir):
    """A reader given only the printed parts could never reconstruct the rest."""
    with_a_plate.catalogue = catalogue(base="printable", screw="hardware")
    _pid, meta, _files = build(out_dir)
    assert set(meta["parts"]) == {"base", "screw"}


def test_an_author_s_note_travels_with_the_part_it_is_about(
        with_a_plate, out_dir):
    """It has nowhere else to go: the tessellated view file is the
    tessellator's own document, and the catalogue does not leave the build."""
    with_a_plate.catalogue["base"]["note"] = "PETG, 4 walls"
    _pid, meta, _files = build(out_dir)
    assert meta["parts"]["base"]["note"] == "PETG, 4 walls"


def test_a_part_nobody_wrote_a_note_about_carries_no_note_key(
        with_a_plate, out_dir):
    _pid, meta, _files = build(out_dir)
    assert "note" not in meta["parts"]["base"]


def test_every_file_meta_json_offers_is_on_the_list_that_gets_verified(
        with_a_plate, out_dir):
    """The two halves of one declaration, built apart and compared here.

    THIS REPLACES AN ASSERTION THAT COULD NOT FAIL. `len(files) == len(set(files))`
    was written as though the collapse in `build` folded a real overlap, and no
    build can produce one: the part files arrive as a set, a view file is
    `<vid>.json` under a unique id that cannot be `meta` or `metrics`, both
    whole-build stems are refused to the catalogue, and the pictures are the
    only `.png`s. Deleting `dict.fromkeys` left it green.

    What really holds the line is the other direction. `files` is the
    VERIFICATION list — what `runner._verified_files` checks and
    `store._hash_output` hashes — and the hub refuses any declared name that is
    not a key of that hash, so a file offered by meta.json and missing from the
    list is a 422 on the push with the build itself reporting success. `build`
    assembles the list from the same evidence meta.json's names come from
    (`plate`, `written`) rather than FROM meta.json, deliberately, so the two
    are free to disagree — and this is what notices.
    """
    _pid, meta, files = build(out_dir)

    offered = files_named_in(meta)
    assert offered <= set(files), (
        f"declared but not verified: {sorted(offered - set(files))}")
    # The collapse still does its job, and it is defence against the next writer
    # of that function rather than the folding of an overlap that exists today.
    assert len(files) == len(set(files))
    # And meta.json is the document the viewer reads, so it has to be there.
    assert json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))


def test_a_title_carrying_no_slug_is_warned_about_next_to_the_name_it_publishes(
        driven, monkeypatch, out_dir, capsys):
    """The wiring, not the rule — `title_problem` is pinned in its own file.

    What this holds is that the warning is REACHED and that it is printed as a
    warning: it is the only thing on a build log that says the card on the front
    page will carry an id where a name should be, and the whole failure it
    reports is one nobody looked at.
    """
    monkeypatch.setattr(build_module, "load_project",
                        lambda: ("2486c8fd2b05", "2486c8fd2b05",
                                 "Foam cover reverse-engineered from a 3D scan"))
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: (2, None))

    build(out_dir)

    warnings = [line for line in capsys.readouterr().out.splitlines()
                if line.startswith("warning:")]
    assert len(warnings) == 1, warnings
    assert "2486c8fd2b05" in warnings[0]


def test_a_build_publishing_under_the_slug_its_title_carries_says_nothing(
        driven, monkeypatch, out_dir, capsys):
    """The other side, and the one that matters more: every project already on
    this hub is in this shape, and a warning that fires on all of them is a
    warning nobody reads."""
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: (2, None))

    build(out_dir)

    assert [line for line in capsys.readouterr().out.splitlines()
            if line.startswith("warning:")] == []


# -- force: the model's own checks(), and nothing else -----------------------
@pytest.fixture
def with_real_checks(driven, monkeypatch):
    """`driven`, but with the REAL `run_checks` over a model that has checks().

    The fixture above stands `run_checks` in with a constant, which is right for
    every test written about something else — and useless for the two below,
    where what is under test is whether that function is CALLED. So the real one
    goes back, and the model gets a checks() of the caller's choosing.

    Returns a function that installs one and hands back what it wrote.
    """
    monkeypatch.setattr(build_module, "run_checks", real_run_checks)
    counted = SimpleNamespace(checks=None)

    def collect_metrics(project, parts, checks_passed, checks_static,
                        provenance, bbox, print_bbox):
        counted.checks = (checks_passed, checks_static)
        return {}

    monkeypatch.setattr(build_module, "collect_metrics", collect_metrics)

    def install(checks):
        monkeypatch.setattr(
            build_module, "load_model",
            lambda: SimpleNamespace(parts=lambda: {}, views=lambda: [],
                                    checks=checks))
        return counted

    return install


def test_a_failing_check_stops_an_ordinary_build_and_not_a_forced_one(
        with_real_checks, out_dir, capsys):
    """The whole point of the flag: an unfinished model publishes anyway.

    Both directions in one test, because either on its own says nothing —
    a check that never fails would pass the forced arm, and a build that never
    completes would pass the other.
    """
    def checks():
        assert False, "the boss is 0.2 mm into the wall"

    counted = with_real_checks(checks)

    with pytest.raises(BuildError) as exc:
        build(out_dir)
    assert "the boss is 0.2 mm into the wall" in str(exc.value)
    capsys.readouterr()

    build(out_dir, force=True)

    out = capsys.readouterr().out
    # One line, where the checks' own verdict would have been, and it is not a
    # warning: `tests/test_template.py` fails a build log that carries one.
    assert ("checks: not run -- this push asked for the model's own checks "
            "to be skipped") in out.splitlines()
    assert [line for line in out.splitlines()
            if line.startswith("warning:")] == []
    # The phase line is still printed, so the table does not read as a build
    # that stopped in the checks.
    assert any(line.startswith("  checks: ") for line in out.splitlines())
    # And nothing was counted, which is what None says here.
    assert counted.checks == (None, None)


def test_a_checks_that_holds_no_check_publishes_under_force(with_real_checks,
                                                            out_dir):
    """The other refusal `run_checks` makes, and it is not a failed check.

    An empty checks() is refused for saying the model was checked when nothing
    looked at it. That verdict is reached before any check runs, so a flag that
    only ignored FAILURES would leave this build red — and a model being cut
    down to a stub is exactly the state somebody pushes unfinished work from.
    """
    def checks():
        x = 1
        return None

    with_real_checks(checks)

    with pytest.raises(BuildError) as exc:
        build(out_dir)
    assert "contains no check" in str(exc.value)

    build(out_dir, force=True)


@pytest.fixture
def after_a_real_model_import():
    """Undo what importing a real model.py leaves behind in THIS process.

    Three things, and every one of them is read by something a long way from the
    test that left it:

      * the unit registry and the three records. `tests/cadbuild/conftest.py`
        asserts both are empty either side of every test, and a build that runs
        check units fills both legitimately -- the model is imported here as
        well as in every worker, because here is where `run_units` reads the
        names from, and the records the workers measured are merged back into
        this process on purpose.
      * `sys.modules["model"]`. `import model` is one name for every project, so
        a model left behind is the file some later test's build gets instead of
        its own.
      * `sys.path`. `geometry.load_model` puts the project root on it and never
        takes it off, so a scratch project stays importable for the rest of the
        session -- and pytest's tmp directories outlive the run. That is how
        this was found: `test_geometry`'s "there is no model.py" test imported
        the one THIS test had written, three files earlier, and did not raise.
    """
    saved_path = list(sys.path)
    yield
    checklib._UNITS.clear()
    checklib._take_records()
    sys.modules.pop("model", None)
    sys.path[:] = saved_path


def test_a_model_with_a_check_unit_counts_it_and_keeps_what_it_measured(
        driven, monkeypatch, isolated_project, out_dir,
        after_a_real_model_import):
    """`build()` OVER A MODEL THAT REGISTERS A UNIT -- the feature's one door.

    Everything else about check units is tested from `run_units` inwards, which
    leaves the call itself unwatched: the line in `build()` could be deleted and
    nothing outside tests/cadbuild/test_checkunits.py would move. What this
    holds is the three things that call has to get right, and each of them has
    failed on its own:

      * THE UNITS ARE COUNTED. One registered unit is one check, so a model with
        one `checks()` assert and one unit reports two. `run_checks` answering
        `None` for a counted zero is what made that number `null` for a model
        that had moved every check into units, and `report_metrics` then could
        not say a project had lost one.
      * THE UNITS RUN BEFORE THE METRICS ARE WRITTEN, and their records are
        merged before `collect_metrics` reads them. The interference number here
        is measured in a WORKER PROCESS and reaches metrics.json only across
        that boundary -- left in the worker it comes out empty, on a build that
        measured it, with nothing going red.
      * THE MODEL IS THE REAL ONE, imported off disk by the real `load_model`,
        because that import is what fills the registry `run_units` reads.
    """
    monkeypatch.setattr(build_module, "load_model", real_load_model)
    monkeypatch.setattr(build_module, "run_checks", real_run_checks)
    monkeypatch.setattr(build_module, "collect_metrics", real_collect_metrics)
    monkeypatch.setattr(build_module, "write_metrics", real_write_metrics)
    (isolated_project / "model.py").write_text(textwrap.dedent("""
        import checklib

        # The private record, because the real writer of it -- pairwise_interference
        # -- wants a CAD kernel this suite does not have. What is under test is
        # the crossing back out of the worker, not the measuring.
        from src.cadbuild import checklib as record


        def parts():
            return {}


        def views():
            return []


        def build_lid():
            return 4


        @checklib.check("lip joint", needs={"lid": build_lid})
        def check_lip(lid):
            record._INTERFERENCE["body|lid"] = 0.5


        def checks(out_dir):
            assert build_lid() == 4, "the lid stopped being the lid"
    """), encoding="utf-8")
    sys.modules.pop("model", None)

    build(out_dir)

    metrics = json.loads((out_dir / METRICS_NAME).read_text(encoding="utf-8"))
    assert metrics["checks_passed"] == 2, (
        "one assert in checks() and one registered unit are two checks; a "
        "count that cannot say so is a count metrics.json cannot compare")
    assert metrics["assembly"]["interference_mm3"] == {"body|lid": 0.5}, (
        "measured in a worker process and never merged back, this comes out "
        "empty on a build that measured it and nothing goes red")


def test_the_hubs_own_gate_still_refuses_a_forced_build(driven, monkeypatch,
                                                        out_dir):
    """`--force` waives the AUTHOR's checks; the hub's rules are not the
    author's to waive.

    `check_interference` stands here for all of them — it is the cheapest one to
    trip — and it is on the same side of the build as the checks that were
    skipped, so a flag that had been read as "publish whatever happens" would
    show up right here.
    """
    def refuse(prepared, catalogue):
        raise BuildError("two parts share space")

    monkeypatch.setattr(build_module, "check_interference", refuse)

    with pytest.raises(BuildError) as exc:
        build(out_dir, force=True)
    assert "two parts share space" in str(exc.value)
