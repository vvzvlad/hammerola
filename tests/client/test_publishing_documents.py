"""Documents with no model, published by the real client to a real hub.

No `model.py` and no `meta.json` in the tree: `project.json` lists the files
under `documents`, and the hub builds the rest (`src/docsbuild.py`). What is
pinned is that the client asks for nothing a model has — `commit` and `build`
pack the tree as it is — and that `artifacts` fetches the documents back under
their paths, since they are what such a build ships.
"""

import json

import pytest

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


def run(root, *args):
    return main(["-C", str(root), *args, "--timeout", "60"])


def test_commit_publishes_documents_and_a_repeat_changes_nothing(
        hub, docs, capsys):
    assert run(docs, "commit") == 0
    out = capsys.readouterr().out
    assert "  list.md  markdown" in out
    assert "  docs/receipt.pdf  pdf" in out
    revision = next(line.split()[1].rstrip(":") for line in out.splitlines()
                    if line.startswith("revision "))
    assert out.rstrip().endswith(f"{hub.url}/project/docs0001/{revision}/")
    meta = json.loads((hub.project_dir("docs0001") / revision / "meta.json")
                      .read_text(encoding="utf-8"))
    assert [doc["file"] for doc in meta["documents"]] == list(FILES)

    assert run(docs, "commit") == 0
    assert "unchanged" in capsys.readouterr().out


def test_build_fills_the_draft_slot_with_documents(hub, docs):
    assert run(docs, "build") == 0
    slot = hub.project_dir("docs0001") / "dev"
    assert (slot / "list.md").read_bytes() == FILES["list.md"]
    assert (slot / "docs" / "receipt.pdf").read_bytes() == FILES["docs/receipt.pdf"]


def test_artifacts_fetches_the_documents_back_under_their_paths(
        hub, docs, tmp_path, capsys):
    assert run(docs, "commit") == 0
    capsys.readouterr()
    out_dir = tmp_path / "fetched"
    assert main(["-C", str(docs), "artifacts", "latest", "-o", str(out_dir)]) == 0
    fetched = {path.relative_to(out_dir).as_posix(): path.read_bytes()
               for path in out_dir.rglob("*") if path.is_file()}
    assert fetched == FILES
