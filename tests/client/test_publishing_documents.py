"""Documents with no model, fetched back by the real client from a real hub.

No `model.py` and no `meta.json` in the tree: `project.json` lists the files
under `documents`, and the hub builds the rest (`src/docsbuild.py`). What is
pinned is that `artifacts` fetches the documents back under their paths, since
they are what such a build ships. Publishing them is the hub's half
(`tests/test_documents.py`); here the hub's own queue does it
(`harness.Hub.publish`).
"""

import json

import pytest
from modeldir import publish_model

from hammerola.cli import main

pytestmark = pytest.mark.usefixtures("configured")

FILES = {
    "list.md": b"# Shopping\n\n- milk\n- [the receipt](docs/receipt.pdf)\n",
    "docs/receipt.pdf": b"%PDF-1.4\n%%EOF\n",
}


@pytest.fixture
def docs(tmp_path):
    root = tmp_path / "shopping"
    (root / "docs").mkdir(parents=True)
    (root / "project.json").write_text(json.dumps(
        {"id": "docs0001", "project": "shopping",
         "title": "Shopping list (shopping)", "documents": list(FILES)}),
        encoding="utf-8")
    for name, data in FILES.items():
        (root / name).write_bytes(data)
    return root


@pytest.mark.parametrize("listed, fetched", [
    (["hw/board.kicad_sch", "hw/board.kicad_pcb"],
     ["hw/board.kicad_pro", "hw/board.kicad_sch", "hw/sub/power.kicad_sch",
      "hw/board.kicad_pcb"]),
    # Each alone brings what it is published with, and no more.
    (["hw/board.kicad_sch"],
     ["hw/board.kicad_pro", "hw/board.kicad_sch", "hw/sub/power.kicad_sch"]),
    (["hw/board.kicad_pcb"], ["hw/board.kicad_pro", "hw/board.kicad_pcb"]),
])
def test_artifacts_fetches_what_a_kicad_schematic_and_board_are_published_with(
        hub, tmp_path, listed, fetched):
    # A schematic naming a second sheet in a subdirectory, a board, and the
    # project beside them, which neither lists.
    design = {
        "hw/board.kicad_pro": b"{}\n",
        "hw/board.kicad_sch": b'(kicad_sch (sheet (property "Sheetfile" "sub/power.kicad_sch")))\n',
        "hw/sub/power.kicad_sch": b"(kicad_sch)\n",
        "hw/board.kicad_pcb": b"(kicad_pcb)\n",
    }
    root = tmp_path / "board"
    for name, data in design.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_bytes(data)
    (root / "project.json").write_text(json.dumps(
        {"id": "docs0002", "project": "board", "title": "Board (board)",
         "documents": listed}), encoding="utf-8")
    publish_model(hub, root)

    out_dir = tmp_path / "fetched"
    assert main(["-C", str(root), "artifacts", "latest", "-o", str(out_dir)]) == 0
    got = {path.relative_to(out_dir).as_posix(): path.read_bytes()
           for path in out_dir.rglob("*") if path.is_file()}
    assert got == {name: design[name] for name in fetched}


def test_artifacts_fetches_the_documents_back_under_their_paths(
        hub, docs, tmp_path):
    publish_model(hub, docs)
    out_dir = tmp_path / "fetched"
    assert main(["-C", str(docs), "artifacts", "latest", "-o", str(out_dir)]) == 0
    fetched = {path.relative_to(out_dir).as_posix(): path.read_bytes()
               for path in out_dir.rglob("*") if path.is_file()}
    assert fetched == FILES
