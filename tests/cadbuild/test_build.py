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

from types import SimpleNamespace
import json

import pytest

from src.cadbuild import build as build_module
from src.cadbuild.artifacts import (ASSEMBLED_STEM, ASSEMBLED_VIEW_ID,
                                    PREVIEW_SUFFIX, PRINT_VIEW_ID)
from src.cadbuild.build import build

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
        ("load_project", lambda: ("abc123def456", "scratch", "Scratch")),
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
        ("run_checks", lambda model, out_dir: 0),
        ("export_assembled", lambda prepared, out_dir: 1),
        ("export_views", lambda prepared, out_dir: [
            {"id": view["id"], "name": view["id"], "file": f"{view['id']}.json",
             "parts": ["base"]} for view in prepared]),
        ("collect_metrics", lambda project, parts, passed: {}),
        ("write_metrics", lambda out_dir, metrics: None),
        ("render_previews", render_previews),
    ):
        monkeypatch.setattr(build_module, name, value)
    return state


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
