"""KiCad documents: a schematic, a board and a board's 3D model, each listed
on its own and published with what it needs.

The hub finds the rest itself (`docsbuild._kicad_schematic`,
`docsbuild._kicad_project`): every sheet a listed schematic names, and the
project with the listed path minus its extension. The trees here are tiny
synthetic s-expressions carrying only what that search reads,
`(property "Sheetfile" "<path>")` (`"Sheet file"` in KiCad 6); what the viewer
makes of a real design is checked in a browser, not here.
"""

import json
import re
from pathlib import Path

import pytest
from harness import tar_gz

from ci.smoke import REQUIRED_PATHS
from src import docsbuild, render
from src.app import BUILD_CONTENT_TYPES, OPEN_SUFFIXES
from src.errors import PublishError

ROOT = Path(__file__).resolve().parent.parent
TEXT = "text/plain; charset=utf-8"
GLB = b"glTF\x02\x00\x00\x00"


def sheet(*named: str, prop: str = "Sheetfile") -> bytes:
    """A schematic whose sheets name `named`, as KiCad writes a sheet: `prop`
    is `Sheetfile` from KiCad 7 on and `Sheet file` in KiCad 6."""
    return "\n".join(
        ["(kicad_sch", "\t(version 20250610)"]
        + [f'\t(sheet\n\t\t(property "Sheetname" "s{i}")\n'
           f'\t\t(property "{prop}" "{name}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)'
           for i, name in enumerate(named)]
        + [")"]).encode("utf-8")


# A design in a subdirectory whose sheets sit in a directory below it and in
# one beside it, and a sheet of a sheet: every way a `Sheetfile` is resolved.
DESIGN = {
    "hw/board.kicad_pro": b'{"meta": {"filename": "board.kicad_pro"}}\n',
    "hw/board.kicad_sch": sheet("sub/power.kicad_sch", "../common/logo.kicad_sch"),
    "hw/sub/power.kicad_sch": sheet("leaf.kicad_sch"),
    "hw/sub/leaf.kicad_sch": sheet(),
    "common/logo.kicad_sch": sheet(),
    "hw/board.kicad_pcb": b"(kicad_pcb (version 20250610))\n",
    "hw/board.glb": GLB,
}
SCHEMATICS = ["hw/board.kicad_sch", "hw/sub/power.kicad_sch",
              "hw/sub/leaf.kicad_sch", "common/logo.kicad_sch"]
LISTED = ("hw/board.kicad_sch", "hw/board.kicad_pcb", "hw/board.glb")


def project(documents) -> bytes:
    return json.dumps({"id": "kicad0001", "project": "board",
                       "documents": documents}).encode("utf-8")


def tree(tmp_path, files: dict, documents=LISTED) -> Path:
    for name, data in {"project.json": project(list(documents)), **files}.items():
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return tmp_path


def refusal(sources) -> str:
    with pytest.raises(PublishError) as caught:
        docsbuild.declared_documents(sources)
    assert caught.value.status == 422
    return str(caught.value)


def published(hub, files: dict, documents) -> str:
    reply = hub.publish("kicad0001", None, tar_gz(
        {"project.json": project(documents), **files}))
    assert reply.status_code == 201, reply.text
    return reply.json()["url"]


# -- finding what each is published with ---------------------------------------

def test_each_is_its_own_document_with_what_it_brings(tmp_path):
    schematic, board, model = docsbuild.declared_documents(tree(tmp_path, DESIGN))
    assert schematic.kicad == {"schematics": SCHEMATICS,
                               "project": "hw/board.kicad_pro"}
    assert schematic.files == (*SCHEMATICS, "hw/board.kicad_pro")
    assert board.kicad == {"project": "hw/board.kicad_pro"}
    assert board.files == ("hw/board.kicad_pcb", "hw/board.kicad_pro")
    assert (model.kicad, model.files) == (None, ("hw/board.glb",))


def test_a_schematic_or_a_board_without_a_project_works_alone(tmp_path):
    files = {k: v for k, v in DESIGN.items() if not k.endswith(".kicad_pro")}
    schematic, = docsbuild.declared_documents(
        tree(tmp_path / "s", files, ["hw/board.kicad_sch"]))
    assert schematic.kicad["project"] is None
    assert schematic.files == tuple(SCHEMATICS)
    board, = docsbuild.declared_documents(
        tree(tmp_path / "b", files, ["hw/board.kicad_pcb"]))
    assert (board.kicad, board.files) == ({"project": None}, ("hw/board.kicad_pcb",))


def test_the_sheets_are_found_for_each_listed_schematic_from_where_it_sits(tmp_path):
    """A sheet listed as a schematic of its own finds ITS sheets, relative to
    its own directory, and none of its parent's."""
    power, = docsbuild.declared_documents(
        tree(tmp_path, DESIGN, ["hw/sub/power.kicad_sch"]))
    assert power.kicad == {"schematics": ["hw/sub/power.kicad_sch",
                                          "hw/sub/leaf.kicad_sch"],
                           "project": None}


def test_a_sheet_is_found_by_either_spelling_kicad_has_written(tmp_path):
    files = {"hw/board.kicad_sch": sheet("six.kicad_sch", prop="Sheet file"),
             "hw/six.kicad_sch": sheet("seven.kicad_sch"),
             "hw/seven.kicad_sch": sheet()}
    doc, = docsbuild.declared_documents(tree(tmp_path, files, ["hw/board.kicad_sch"]))
    assert doc.kicad["schematics"] == [
        "hw/board.kicad_sch", "hw/six.kicad_sch", "hw/seven.kicad_sch"]


def test_a_hierarchy_that_loops_ends_and_lists_each_sheet_once(tmp_path):
    files = {"hw/board.kicad_sch": sheet("a.kicad_sch", "./a.kicad_sch"),
             "hw/a.kicad_sch": sheet("board.kicad_sch", "a.kicad_sch")}
    doc, = docsbuild.declared_documents(tree(tmp_path, files, ["hw/board.kicad_sch"]))
    assert doc.kicad["schematics"] == ["hw/board.kicad_sch", "hw/a.kicad_sch"]


@pytest.mark.parametrize("change, named", [
    (lambda f: f.pop("hw/sub/leaf.kicad_sch"),
     "reaches 'hw/sub/leaf.kicad_sch' through a sheet of 'hw/sub/power.kicad_sch', "
     "and that path is not a file in the pushed tree"),
    (lambda f: f.update({"hw/sub/leaf.kicad_sch": sheet("../../../x.kicad_sch")}),
     "reaches '../x.kicad_sch'"),
    (lambda f: f.update({"hw/sub/leaf.kicad_sch": sheet("old.sch")}),
     "and that is not a `.kicad_sch` file"),
])
def test_a_sheet_that_is_not_in_the_tree_refuses_the_push_naming_it(
        tmp_path, change, named):
    files = dict(DESIGN)
    change(files)
    message = refusal(tree(tmp_path, files))
    assert "'hw/board.kicad_sch', which " in message
    assert named in message, message


def test_sixty_four_sheets_and_eight_levels_below_the_listed_one_are_the_ceilings(
        tmp_path):
    def fan(count):
        names = [f"s{i}.kicad_sch" for i in range(count)]
        return {"hw/board.kicad_sch": sheet(*names),
                **{f"hw/{name}": sheet() for name in names}}

    def chain(levels):
        return {"hw/board.kicad_sch": sheet("l1.kicad_sch"),
                **{f"hw/l{i}.kicad_sch": sheet(f"l{i + 1}.kicad_sch") if i < levels
                   else sheet() for i in range(1, levels + 1)}}

    listed = ["hw/board.kicad_sch"]
    doc, = docsbuild.declared_documents(tree(tmp_path / "63", fan(63), listed))
    assert len(doc.kicad["schematics"]) == render.MAX_KICAD_SHEETS == 64
    assert "brings more than 64 schematics" in refusal(
        tree(tmp_path / "64", fan(64), listed))

    doc, = docsbuild.declared_documents(tree(tmp_path / "8", chain(8), listed))
    assert doc.kicad["schematics"][-1] == "hw/l8.kicad_sch"
    assert ("reaches 'hw/l9.kicad_sch' through a sheet of 'hw/l8.kicad_sch', more "
            "than 8 levels below its root schematic") in refusal(
                tree(tmp_path / "9", chain(9), listed))


def test_a_project_listed_on_its_own_is_refused_naming_what_to_list(tmp_path):
    message = refusal(tree(tmp_path, DESIGN, ["hw/board.kicad_pro"]))
    assert ("'hw/board.kicad_pro', which is a KiCad project and not a view of "
            "anything: list the schematic 'hw/board.kicad_sch' or the board "
            "'hw/board.kicad_pcb' instead") in message


# -- publishing and serving them -----------------------------------------------

def test_each_publishes_with_its_own_title_open_and_as_its_type(hub):
    titled = [{"file": "hw/board.kicad_sch", "title": "Схема"},
              {"file": "hw/board.kicad_pcb", "title": "Плата"},
              {"file": "hw/board.glb", "title": "Плата в 3D"}]
    build = published(hub, {**DESIGN, "hw/board.kicad_prl": b"{}"}, titled)

    schematic, board, model = hub.get(f"{build}meta.json").json()["documents"]
    size = {name: len(data) for name, data in DESIGN.items()}
    assert schematic == {
        "id": "hw__board.kicad_sch", "name": "Схема", "type": "schematic",
        "file": "hw/board.kicad_sch",
        "bytes": sum(size[name] for name in SCHEMATICS) + size["hw/board.kicad_pro"],
        "kicad": {"schematics": SCHEMATICS, "project": "hw/board.kicad_pro"}}
    assert board == {
        "id": "hw__board.kicad_pcb", "name": "Плата", "type": "board",
        "file": "hw/board.kicad_pcb",
        "bytes": size["hw/board.kicad_pcb"] + size["hw/board.kicad_pro"],
        "kicad": {"project": "hw/board.kicad_pro"}}
    assert model == {"id": "hw__board.glb", "name": "Плата в 3D", "type": "board3d",
                     "file": "hw/board.glb", "bytes": len(GLB)}
    for name, data in DESIGN.items():
        served = hub.get(f"{build}{name}")
        assert (served.status_code, served.content) == (200, data), name
        assert served.headers["Content-Type"] == (
            "model/gltf-binary" if name.endswith(".glb") else TEXT), name
        assert served.headers["Cache-Control"] == (
            "public, max-age=31536000, immutable"), name
    # What no listed document names is not published.
    revision = build.rstrip("/").rsplit("/", 1)[1]
    assert not (hub.project_dir("kicad0001") / revision / "hw").joinpath(
        "board.kicad_prl").exists()


def test_two_designs_in_one_project_are_four_documents(hub):
    files = {"a/main.kicad_pro": b"{}\n", "a/main.kicad_sch": sheet(),
             "a/main.kicad_pcb": b"(kicad_pcb)\n",
             "b/psu.kicad_sch": sheet(), "b/psu.kicad_pcb": b"(kicad_pcb)\n"}
    listed = ["a/main.kicad_sch", "a/main.kicad_pcb", "b/psu.kicad_sch",
              "b/psu.kicad_pcb"]
    build = published(hub, files, listed)
    documents = hub.get(f"{build}meta.json").json()["documents"]
    assert [(d["file"], d["type"], d["kicad"]["project"]) for d in documents] == [
        ("a/main.kicad_sch", "schematic", "a/main.kicad_pro"),
        ("a/main.kicad_pcb", "board", "a/main.kicad_pro"),
        ("b/psu.kicad_sch", "schematic", None),
        ("b/psu.kicad_pcb", "board", None)]


def test_every_kicad_suffix_is_open_and_served_as_text():
    for suffix in render.KICAD_SUFFIXES:
        assert suffix in OPEN_SUFFIXES
        assert BUILD_CONTENT_TYPES[suffix] == TEXT
    assert [render.document_type(f"x{suffix}") for suffix in render.KICAD_SUFFIXES] == [
        None, "schematic", "board"]


@pytest.mark.parametrize("entry, message", [
    ({"type": "schematic", "file": "hw/board.kicad_sch",
      "kicad": {"schematics": ["hw/sub/power.kicad_sch", "hw/board.kicad_sch"]}},
     "lists 'hw/sub/power.kicad_sch' first, and has to list itself first"),
    ({"type": "schematic", "file": "hw/board.kicad_sch",
      "kicad": {"schematics": ["hw/board.kicad_sch", "hw/gone.kicad_sch"]}},
     "points at 'hw/gone.kicad_sch', which this build did not declare"),
    ({"type": "schematic", "file": "hw/board.kicad_sch",
      "kicad": {"schematics": ["hw/board.kicad_sch", "hw/board.kicad_pcb"]}},
     "lists 'hw/board.kicad_pcb' as a schematic"),
    ({"type": "schematic", "file": "hw/board.kicad_sch",
      "kicad": {"schematics": ["hw/board.kicad_sch"] * 2}}, "a schematic twice"),
    ({"type": "schematic", "file": "hw/board.kicad_sch",
      "kicad": {"schematics": ["hw/board.kicad_sch"] * 65}}, "between 1 and 64"),
    ({"type": "board", "file": "hw/board.kicad_pcb",
      "kicad": {"project": "hw/other.kicad_pro"}},
     "names the project 'hw/other.kicad_pro', and its project is "
     "'hw/board.kicad_pro'"),
    ({"type": "board", "file": "hw/board.kicad_pcb"},
     "is a KiCad board with no `kicad` object"),
])
def test_a_kicad_entry_in_meta_json_is_rebuilt_and_checked(tmp_path, entry, message):
    for name, data in DESIGN.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(data)
    files = {name: "0" * 64 for name in [*DESIGN, "hw/other.kicad_pro"]}
    raw = {"kind": "documents", "documents": [{"name": "x", **entry}]}
    with pytest.raises(ValueError, match=re.escape(message)):
        render.build_meta(pid="kicad0001", commit="abc", raw=raw,
                          staging=tmp_path, files=files, published="now")


def test_the_page_loads_the_viewer_from_files_the_image_ships():
    """The viewer is fetched by URL at runtime, its worker beside it, so only
    these rows notice either missing from the image."""
    source = (ROOT / "ui" / "src" / "KicadView.jsx").read_text(encoding="utf-8")
    url = re.search(r"export const ECAD_VIEWER_URL = '/_v/([^'/]+)';", source)
    assert url, "KicadView.jsx no longer declares ECAD_VIEWER_URL"
    for name in (url.group(1), "parser.worker.js"):
        assert (ROOT / "static" / "_v" / name).is_file(), name
        assert f"/app/static/_v/{name}" in REQUIRED_PATHS, name


def test_the_3d_view_loads_three_from_files_the_image_ships():
    """BoardView3D.jsx imports three and its add-ons by URL (board3d.js), so a
    renamed file is a 404 in the browser that no build notices."""
    source = (ROOT / "ui" / "src" / "board3d.js").read_text(encoding="utf-8")
    names = re.findall(r"export const \w+_URL = '/_v/([^'/]+)';", source)
    assert len(names) == 4, names
    for name in names:
        assert (ROOT / "static" / "_v" / name).is_file(), name
        assert f"/app/static/_v/{name}" in REQUIRED_PATHS, name


def test_the_page_and_the_hub_name_the_types_of_a_design_alike():
    """KicadView.jsx groups a design's members by their `type`; a type renamed
    on one side only would leave that member out of its design."""
    source = (ROOT / "ui" / "src" / "KicadView.jsx").read_text(encoding="utf-8")
    spelled = re.search(r"export const DESIGN_VIEWS = \{([^}]*)\}", source)
    assert spelled, "KicadView.jsx no longer declares DESIGN_VIEWS"
    assert re.findall(r"(\w+):", spelled.group(1)) == [
        render.DOCUMENT_TYPES[suffix] for suffix in (".kicad_sch", ".kicad_pcb", ".glb")]
