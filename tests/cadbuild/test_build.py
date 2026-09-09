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
import textwrap

import pytest

from src.cadbuild import build as build_module
from src.cadbuild import paths
from src.cadbuild import provenance as real_provenance
from src.cadbuild.artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID,
                                    PREVIEW_SUFFIX, PRINT_VIEW_ID)
from src.cadbuild.build import build
from src.cadbuild.errors import BuildError

from fakes import catalogue


def files_named_in(meta):
    """Every file meta.json offers a reader, wherever it is filed."""
    named = set()
    for view in meta["views"]:
        named.add(view["file"])
        named.update(view[key] for key in ("overview", "preview") if key in view)
    for part in meta["parts"].values():
        named.update(part.get("files", {}).values())
        if "preview" in part:
            named.add(part["preview"])
    return named


@pytest.fixture
def driven(monkeypatch):
    """Everything `build` reaches outside itself.

    Returns the state the tests steer and read back: `views` is which views the
    model has (a test that gives it a plate adds one), and `rendered` collects
    the stems `render_previews` was asked for.

    `render_previews` is the one fake that answers rather than merely returns:
    it hands back a preview name per stem it was asked for, which is what the
    real one does and what makes `written` — and therefore the pictures and the
    file list — a consequence of the branch under test rather than a constant.

    `prepare_views` and `export_views` are wired to ONE list for the same
    reason: a build with a plate has a `print` view, and a fixture that let
    those two disagree would be testing a state no build can be in.
    """
    state = SimpleNamespace(rendered=[], views=[ASSEMBLED_VIEW_ID],
                            catalogue=catalogue(base="printable"))

    def render_previews(out_dir, stems, mode, parts=None):
        state.rendered.extend(stems)
        return [f"{stem}{PREVIEW_SUFFIX}" for stem in stems]

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
        # file behind it. Faked as one object rather than three names because
        # `build` imports the module, not its functions.
        ("provenance", SimpleNamespace(collect=lambda model: [],
                                       unwrapped=lambda model: [],
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
    is importorskip'ped wherever the CAD kernel is absent, i.e. in both CI
    containers. So the rule was tested thoroughly and its CALL was not tested at
    all. Nothing here needs a kernel: everything that would touch one is already
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
