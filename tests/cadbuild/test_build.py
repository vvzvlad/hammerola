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
from src.cadbuild.artifacts import ASSEMBLED_STEM, PREVIEW_SUFFIX
from src.cadbuild.build import build
from src.cadbuild.views import PRINT_VIEW_ID

from fakes import part


@pytest.fixture
def driven(monkeypatch):
    """Everything `build` reaches outside itself. -> the `rendered` stems list.

    `render_previews` is the one fake that answers rather than merely returns:
    it hands back a preview name per stem it was asked for, which is what the
    real one does and what makes `written` — and therefore the download map and
    the file list — a consequence of the branch under test rather than a
    constant.
    """
    rendered = []

    def render_previews(out_dir, stems, mode, parts=None):
        rendered.extend(stems)
        return [f"{stem}{PREVIEW_SUFFIX}" for stem in stems]

    for name, value in (
        ("load_project", lambda: ("abc123def456", "scratch", "Scratch")),
        ("load_model", lambda: SimpleNamespace(views=lambda: [])),
        ("collect_printables", lambda model: {"base": part()}),
        ("prepare_views", lambda views, printables: []),
        ("check_print_layout", lambda prepared: None),
        ("check_printables_shown", lambda prepared, printables: None),
        ("export_printables", lambda printables, out_dir: (
            {"base.stl": "base.stl"}, {})),
        ("run_checks", lambda model, out_dir: 0),
        ("export_assembled", lambda prepared, printables, out_dir: 1),
        ("export_views", lambda prepared, out_dir: [
            {"file": f"{ASSEMBLED_STEM}.json"}]),
        ("collect_notes", lambda prepared: {}),
        ("collect_metrics", lambda project, parts, passed: {}),
        ("write_metrics", lambda out_dir, metrics: None),
        ("render_previews", render_previews),
    ):
        monkeypatch.setattr(build_module, name, value)
    return rendered


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
    download buttons and two files go missing together, and the one somebody
    then goes looking for is `print.stl` — a line about the picture alone leaves
    them with no way back to the reason.

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
    # in either of the two maps that name a whole-build artefact.
    assert PRINT_VIEW_ID not in driven
    assert f"{PRINT_VIEW_ID}.stl" not in files
    assert f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}" not in files
    assert PRINT_VIEW_ID not in meta["overview"]
    assert PRINT_VIEW_ID not in meta["previews"]


def test_a_build_with_a_print_view_declares_the_plate_and_says_nothing(
        driven, monkeypatch, out_dir, capsys):
    """The other side of the same branch: the plate is DECLARED, not stowed away.

    Being written into the output directory is not what gets a file published —
    it is what got these files to the site without being hashed by
    `store._hash_output` or name-checked by `runner._verified_files` (issue
    #53). `files` is the declaration, and this is what says the plate and its
    picture are on it.
    """
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: (2, None))

    _pid, meta, files = build(out_dir)

    assert f"{PRINT_VIEW_ID} view: none" not in capsys.readouterr().out
    # The plate is rendered too, which is why it is exported BEFORE the
    # pictures: a stem whose STL is missing is refused by `render_previews`.
    assert PRINT_VIEW_ID in driven
    assert f"{PRINT_VIEW_ID}.stl" in files
    assert f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}" in files
    assert f"base{PREVIEW_SUFFIX}" in files
    # Declared in the map that says a file EXISTS, and in neither the map that
    # draws buttons nor the one that carries the meshes. `downloads` is read as
    # per-part in the browser, so a whole-build name in it lands on a part row;
    # `overview` is separate from `previews` because both are keyed by the stem
    # and `print` names two files, one in each.
    assert meta["previews"][PRINT_VIEW_ID] == f"{PRINT_VIEW_ID}{PREVIEW_SUFFIX}"
    assert meta["previews"]["base"] == f"base{PREVIEW_SUFFIX}"
    assert meta["overview"][PRINT_VIEW_ID] == f"{PRINT_VIEW_ID}.stl"
    assert meta["downloads"] == {"base.stl": "base.stl"}


def test_every_file_the_maps_offer_is_on_the_list_that_gets_verified(
        driven, monkeypatch, out_dir):
    """The two halves of one declaration, built apart and compared here.

    THIS REPLACES AN ASSERTION THAT COULD NOT FAIL. `len(files) == len(set(files))`
    was written as though the collapse in `build` folded a real overlap, and no
    build can produce one: the download values arrive as a set, a view file is
    `<vid>.json` under a unique id that cannot be `meta` or `metrics`, both
    whole-build stems are refused to printables, and the pictures are the only
    `.png`s. Deleting `dict.fromkeys` left it green.

    What really holds the line is the other direction. `files` is the
    VERIFICATION list — what `runner._verified_files` checks and
    `store._hash_output` hashes — and the hub refuses any declared name that is
    not a key of that hash, so a file offered by a map and missing from the list
    is a 422 on the push with the build itself reporting success. `build`
    assembles the list from the same evidence the maps come from (`plate`,
    `written`) rather than FROM the maps, deliberately, so the two are free to
    disagree — and this is what notices.
    """
    monkeypatch.setattr(build_module, "export_print_plate",
                        lambda prepared, out_dir: (2, None))

    _pid, meta, files = build(out_dir)

    offered = (set(meta["downloads"].values()) | set(meta["overview"].values())
               | set(meta["previews"].values()))
    assert offered <= set(files), (
        f"declared but not verified: {sorted(offered - set(files))}")
    # The collapse still does its job, and it is defence against the next writer
    # of that function rather than the folding of an overlap that exists today.
    assert len(files) == len(set(files))
    # And meta.json is the document the viewer reads, so it has to be there.
    assert json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
