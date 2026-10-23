"""A KiCad design as a document: listed by its `.kicad_pro`, published whole.

The hub finds the rest of the design itself (`docsbuild._kicad_design`): the
root schematic and the board beside the project, and every sheet a schematic
names. The trees here are tiny synthetic s-expressions carrying only what that
search reads, `(property "Sheetfile" "<path>")` (`"Sheet file"` in KiCad 6);
what the viewer makes of a
real design is checked in a browser, not here.
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
}
SCHEMATICS = ["hw/board.kicad_sch", "hw/sub/power.kicad_sch",
              "hw/sub/leaf.kicad_sch", "common/logo.kicad_sch"]


def project(documents) -> bytes:
    return json.dumps({"id": "kicad0001", "project": "board",
                       "documents": documents}).encode("utf-8")


def tree(tmp_path, files: dict, documents=("hw/board.kicad_pro",)) -> Path:
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


# -- finding the design --------------------------------------------------------

def test_the_sheets_are_found_beside_below_and_above_the_root(tmp_path):
    doc, = docsbuild.declared_documents(tree(tmp_path, DESIGN))
    assert doc.kicad == {"schematics": SCHEMATICS, "pcb": "hw/board.kicad_pcb"}
    assert doc.files == ("hw/board.kicad_pro", *SCHEMATICS, "hw/board.kicad_pcb")


def test_a_design_without_a_board_has_none(tmp_path):
    files = {k: v for k, v in DESIGN.items() if not k.endswith(".kicad_pcb")}
    doc, = docsbuild.declared_documents(tree(tmp_path, files))
    assert doc.kicad["pcb"] is None


def test_a_sheet_is_found_by_either_spelling_kicad_has_written(tmp_path):
    files = {"hw/board.kicad_pro": b"{}",
             "hw/board.kicad_sch": sheet("six.kicad_sch", prop="Sheet file"),
             "hw/six.kicad_sch": sheet("seven.kicad_sch"),
             "hw/seven.kicad_sch": sheet()}
    doc, = docsbuild.declared_documents(tree(tmp_path, files))
    assert doc.kicad["schematics"] == [
        "hw/board.kicad_sch", "hw/six.kicad_sch", "hw/seven.kicad_sch"]


def test_a_hierarchy_that_loops_ends_and_lists_each_sheet_once(tmp_path):
    files = {"hw/board.kicad_pro": b"{}",
             "hw/board.kicad_sch": sheet("a.kicad_sch", "./a.kicad_sch"),
             "hw/a.kicad_sch": sheet("board.kicad_sch", "a.kicad_sch")}
    doc, = docsbuild.declared_documents(tree(tmp_path, files))
    assert doc.kicad["schematics"] == ["hw/board.kicad_sch", "hw/a.kicad_sch"]


@pytest.mark.parametrize("change, named", [
    (lambda f: f.pop("hw/sub/leaf.kicad_sch"),
     "reaches 'hw/sub/leaf.kicad_sch' through a sheet of 'hw/sub/power.kicad_sch', "
     "and that path is not a file in the pushed tree"),
    (lambda f: f.pop("hw/board.kicad_sch"),
     "needs its root schematic 'hw/board.kicad_sch', which is not a file"),
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
    assert "'hw/board.kicad_pro', which " in message
    assert named in message, message


def test_sixty_four_sheets_and_eight_levels_below_the_root_are_the_ceilings(
        tmp_path):
    def fan(count):
        names = [f"s{i}.kicad_sch" for i in range(count)]
        return {"hw/board.kicad_pro": b"{}", "hw/board.kicad_sch": sheet(*names),
                **{f"hw/{name}": sheet() for name in names}}

    def chain(levels):
        return {"hw/board.kicad_pro": b"{}", "hw/board.kicad_sch": sheet("l1.kicad_sch"),
                **{f"hw/l{i}.kicad_sch": sheet(f"l{i + 1}.kicad_sch") if i < levels
                   else sheet() for i in range(1, levels + 1)}}

    doc, = docsbuild.declared_documents(tree(tmp_path / "63", fan(63)))
    assert len(doc.kicad["schematics"]) == render.MAX_KICAD_SHEETS == 64
    assert "brings more than 64 schematics" in refusal(tree(tmp_path / "64", fan(64)))

    doc, = docsbuild.declared_documents(tree(tmp_path / "8", chain(8)))
    assert doc.kicad["schematics"][-1] == "hw/l8.kicad_sch"
    assert ("reaches 'hw/l9.kicad_sch' through a sheet of 'hw/l8.kicad_sch', more "
            "than 8 levels below its root schematic") in refusal(
                tree(tmp_path / "9", chain(9)))


@pytest.mark.parametrize("listed", ["hw/board.kicad_sch", "hw/board.kicad_pcb"])
def test_a_schematic_or_a_board_listed_on_its_own_is_refused(tmp_path, listed):
    message = refusal(tree(tmp_path, DESIGN, [listed]))
    assert (f"{listed!r}, which is a part of a KiCad design: list its "
            f"`.kicad_pro`") in message


# -- publishing and serving it -------------------------------------------------

def test_a_design_publishes_every_file_open_and_as_text(hub):
    files = {**DESIGN, "hw/board.kicad_prl": b"{}"}
    reply = hub.publish("kicad0001", None, tar_gz(
        {"project.json": project(["hw/board.kicad_pro"]), **files}))
    assert reply.status_code == 201, reply.text
    build = reply.json()["url"]

    doc, = hub.get(f"{build}meta.json").json()["documents"]
    assert doc == {"id": "hw__board.kicad_pro", "name": "hw/board.kicad_pro",
                   "type": "kicad", "file": "hw/board.kicad_pro",
                   "bytes": sum(len(data) for data in DESIGN.values()),
                   "kicad": {"schematics": SCHEMATICS, "pcb": "hw/board.kicad_pcb"}}
    for name, data in DESIGN.items():
        served = hub.get(f"{build}{name}")
        assert (served.status_code, served.content) == (200, data), name
        assert served.headers["Content-Type"] == TEXT, name
        assert served.headers["Cache-Control"] == (
            "public, max-age=31536000, immutable"), name
    # What the design does not name is not published.
    revision = build.rstrip("/").rsplit("/", 1)[1]
    assert not (hub.project_dir("kicad0001") / revision / "hw").joinpath(
        "board.kicad_prl").exists()
    assert (hub.project_dir("kicad0001") / revision / "hw" / "board.kicad_pro").is_file()


def test_every_kicad_suffix_is_open_and_served_as_text():
    for suffix in render.KICAD_SUFFIXES:
        assert suffix in OPEN_SUFFIXES
        assert BUILD_CONTENT_TYPES[suffix] == TEXT
    assert render.document_type("x.kicad_pro") == docsbuild.KICAD_TYPE


@pytest.mark.parametrize("kicad, message", [
    ({"schematics": ["hw/sub/power.kicad_sch", "hw/board.kicad_sch"], "pcb": None},
     "lists 'hw/sub/power.kicad_sch' first, and its root schematic is"),
    ({"schematics": ["hw/board.kicad_sch"], "pcb": "hw/other.kicad_pcb"},
     "names the board 'hw/other.kicad_pcb'"),
    ({"schematics": ["hw/board.kicad_sch", "hw/gone.kicad_sch"], "pcb": None},
     "points at 'hw/gone.kicad_sch', which this build did not declare"),
    ({"schematics": ["hw/board.kicad_sch", "hw/board.kicad_pcb"], "pcb": None},
     "lists 'hw/board.kicad_pcb' as a schematic"),
    ({"schematics": ["hw/board.kicad_sch"] * 2, "pcb": None}, "a schematic twice"),
    ({"schematics": ["hw/board.kicad_sch"] * 65, "pcb": None}, "between 1 and 64"),
    (None, "with no `kicad` object"),
])
def test_a_kicad_entry_in_meta_json_is_rebuilt_and_checked(tmp_path, kicad, message):
    for name, data in DESIGN.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_bytes(data)
    files = {name: "0" * 64 for name in [*DESIGN, "hw/other.kicad_pcb"]}
    raw = {"kind": "documents", "documents": [
        {"name": "x", "type": "kicad", "file": "hw/board.kicad_pro", "kicad": kicad}]}
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
