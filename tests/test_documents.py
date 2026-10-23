"""Documents: the files a project.json lists to be read, beside a model or alone.

Driven through a real hub over a real socket (`harness.start_hub`), because the
claims are about what reaches a reader: the meta.json a page reads, the type
and the headers each file is served with, the paths they are served under, and
the pointers and the card the publication moves.

A tree with no model never reaches a builder: the worker hands it to
`src/docsbuild.py`. A tree with a model goes to the builder as always, and
`model_builder` below stands in for it the way the suite's copying builder
does, minus the files a model's build never writes, so the documents are left
for the hub to add.
"""

import dataclasses
import http.client
import json
import re
import shutil
import time
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from harness import (DEFAULT_EXPORTS, PNG_BYTES, good_build, meta_bytes,
                     tar_gz, view_bytes)

from src import docsbuild, render
from src.app import BUILD_CONTENT_TYPES, OPEN_SUFFIXES, _safe_build_path
from src.buildproc import STATUS_OK, BuildOutcome
from src.store import FILE_DIGESTS_FILE, PAYLOAD_DIGEST_FILE
from hammerola import buildnames

ROOT = Path(__file__).resolve().parent.parent

# One file per type, two of them in subdirectories, with a page that runs a
# script and a drawing that carries one: both are served as written.
DOCUMENTS = {
    "list.md": b"# List\n\n- [x] [report](docs/report.pdf)\n\n![photo](ref/photo.png)\n",
    "docs/report.pdf": b"%PDF-1.4\n%%EOF\n",
    "ref/photo.png": PNG_BYTES,
    "page.html": b"<!doctype html><script>document.title = 'ran'</script>",
    "drawing.svg": b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
}
# The order project.json lists them in, which is the order of the rows in the list of views.
LISTED = ["list.md", "ref/photo.png", "docs/report.pdf", "page.html", "drawing.svg"]

TYPES = {"list.md": "text/markdown; charset=utf-8",
         "docs/report.pdf": "application/pdf",
         "ref/photo.png": "image/png",
         "page.html": "text/html; charset=utf-8",
         "drawing.svg": "image/svg+xml"}

# What the suite pushes in place of a model's geometry (`good_build`'s members).
ARTEFACTS = {"meta.json": meta_bytes(), "assembled.json": view_bytes("a"),
             **DEFAULT_EXPORTS}


def project(documents=LISTED, **extra) -> bytes:
    data = {"id": "docs0001", "project": "shopping",
            "title": "Shopping list (shopping)", **extra}
    if documents is not None:
        data["documents"] = documents
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def documents_tree(documents=LISTED, **extra) -> bytes:
    """A tree with no model: project.json, the documents and one file not listed."""
    return tar_gz({"project.json": project(documents), **DOCUMENTS,
                   "notes.md": b"# not listed\n", **extra})


def model_tree(documents=LISTED, **extra) -> bytes:
    """A tree with a model, its documents beside it."""
    return tar_gz({"project.json": project(documents), "model.py": b"# model\n",
                   **ARTEFACTS, **DOCUMENTS, **extra})


# What `model_builder` ships of a tree: the artefacts, and `clash.png`, which
# one test lists as a document to land on the model's own output.
SHIPPED = (*ARTEFACTS, "clash.png")


def model_builder(project_dir, out_dir, *, pid, **_kw):
    """A model's build, as the suite stands one in: its artefacts, nothing else.

    The copying builder ships the whole tree; a real build ships what it wrote,
    which is never model.py, project.json or the documents beside them. So
    only the files in `SHIPPED` are copied, and the documents are left for the
    hub to add.
    """
    started = time.monotonic()
    out = Path(out_dir)
    out.mkdir()
    names = []
    for name in SHIPPED:
        if (Path(project_dir) / name).is_file():
            shutil.copyfile(Path(project_dir) / name, out / name)
            names.append(name)
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=tuple(names),
        log=f"model builder: {len(names)} files\n", log_truncated=False,
        exit_code=0, signal=None, duration_seconds=time.monotonic() - started)


@pytest.fixture
def model_hub(hub_factory):
    return hub_factory(build_runner=model_builder)


def published(hub, body=None) -> str:
    """Publish under a minted name. -> the revision."""
    reply = hub.publish("docs0001", None, body or documents_tree())
    assert reply.status_code == 201, reply.text
    return reply.json()["url"].rstrip("/").rsplit("/", 1)[1]


def refused(hub, body) -> dict:
    """Push asynchronously and wait. -> the job record of a refusal."""
    reply = hub.publish_async("docs0001", None, body)
    record = hub.await_job(reply.json()["job"]).record
    assert record["state"] == "failed", record
    assert not hub.project_dir("docs0001").joinpath("latest").exists()
    return record


# -- a tree with no model ------------------------------------------------------

def test_a_tree_with_no_model_publishes_what_it_lists_in_that_order(hub):
    revision = published(hub)
    meta = hub.get(f"/project/docs0001/{revision}/meta.json").json()

    assert meta["kind"] == "documents"
    assert (meta["project"], meta["title"]) == ("shopping",
                                                "Shopping list (shopping)")
    assert "views" not in meta and "parts" not in meta
    assert [doc["file"] for doc in meta["documents"]] == LISTED
    for doc in meta["documents"]:
        assert set(doc) == {"id", "name", "type", "file", "bytes"}
        assert doc["id"] == doc["file"].replace("/", "__")
        assert doc["name"] == doc["file"]
        assert doc["type"] == render.document_type(doc["file"])
        assert doc["bytes"] == len(DOCUMENTS[doc["file"]])
    # Neither the tree's own description nor a file it does not list is
    # published: a file is a document because the list says so.
    for absent in ("project.json", "notes.md"):
        assert hub.get(f"/project/docs0001/{revision}/{absent}").status_code == 404


def test_every_document_is_served_at_its_path_as_its_own_type_without_a_key(hub):
    revision = published(hub)
    for name, ctype in TYPES.items():
        reply = hub.get(f"/project/docs0001/{revision}/{name}")
        assert reply.status_code == 200, name
        assert reply.content == DOCUMENTS[name], name
        assert reply.headers["Content-Type"] == ctype, name
        assert "Content-Disposition" not in reply.headers, name
        assert reply.headers["Cache-Control"] == (
            "public, max-age=31536000, immutable"), name


def test_a_published_page_carries_no_csp_and_the_shell_keeps_it(hub):
    """The author's HTML runs as written (SPEC §4); the hub's own page does not
    give up its policy for it."""
    revision = published(hub)
    page = hub.get(f"/project/docs0001/{revision}/page.html")
    assert "Content-Security-Policy" not in page.headers
    assert page.headers["X-Content-Type-Options"] == "nosniff"

    shell = hub.get(f"/project/docs0001/{revision}/")
    assert shell.headers["Content-Type"].startswith("text/html")
    assert "default-src 'self'" in shell.headers["Content-Security-Policy"]


def test_publication_moves_latest_the_picker_and_the_card(hub):
    revision = published(hub)
    assert hub.get("/project/docs0001/latest/meta.json").json()["commit"] == revision
    assert hub.get("/project/docs0001/latest/ref/photo.png").content == PNG_BYTES
    assert [b["commit"] for b in hub.builds("docs0001").json()["builds"]] == [revision]

    card, = hub.index().json()
    total = sum(len(data) for data in DOCUMENTS.values())
    assert (card["documents"], card["views"], card["printables"]) == (5, 0, 0)
    assert card["mb"] == f"{total / 1e6:.1f}"
    assert card["preview"] is None


def test_the_same_documents_publish_once(hub):
    revision = published(hub)
    again = hub.publish("docs0001", None, documents_tree())
    assert again.status_code == 200
    assert again.json()["url"] == f"/project/docs0001/{revision}/"
    revisions = [p.name for p in hub.project_dir("docs0001").iterdir()
                 if p.is_dir() and not p.is_symlink()
                 and p.name not in ("dev", "latest")]
    assert revisions == [revision]


def test_the_draft_slot_takes_documents_too(hub):
    reply = hub.publish_dev("docs0001", documents_tree())
    assert reply.status_code == 201, reply.text
    meta = hub.get("/project/docs0001/dev/meta.json").json()
    assert (meta["kind"], meta["dev"]) == ("documents", True)
    assert hub.get("/project/docs0001/dev/docs/report.pdf").status_code == 200


# -- a model with documents ----------------------------------------------------

def test_a_model_carries_its_documents_beside_its_views(model_hub):
    revision = published(model_hub, model_tree())
    meta = model_hub.get(f"/project/docs0001/{revision}/meta.json").json()

    assert "kind" not in meta and meta["views"] and meta["parts"]
    assert [doc["file"] for doc in meta["documents"]] == LISTED
    for name in LISTED:
        reply = model_hub.get(f"/project/docs0001/{revision}/{name}")
        assert reply.content == DOCUMENTS[name], name
    # The card is the model's: documents do not turn it into a list of them.
    card, = model_hub.index().json()
    assert card["documents"] is None and card["views"] == 1
    # The job's log ends with what the hub added.
    record = model_hub.await_job(
        model_hub.publish_async("docs0001", None, model_tree(LISTED[:1]))
        .json()["job"]).record
    log = model_hub.job_log(record["id"]).text
    assert log.startswith("model builder: ")
    assert "documents\n  list.md  markdown" in log


def test_a_model_that_lists_no_documents_publishes_what_it_always_did(
        hub, monkeypatch):
    """Nothing of this change reaches a model's build that lists nothing.

    The two documents paths are made to fail the job if they run at all, and
    what was published is held to the build's own files and the document a
    model's build always produced.
    """
    def untouched(*_args, **_kwargs):
        raise AssertionError("the documents path ran for a model listing none")

    monkeypatch.setattr(docsbuild, "add_documents", untouched)
    monkeypatch.setattr(docsbuild, "run_documents_build", untouched)
    reply = hub.publish_async("proj1", "abc123", good_build())
    record = hub.await_job(reply.json()["job"]).record
    assert (record["state"], record["code"]) == ("done", 201), record

    build = hub.project_dir("proj1") / "abc123"
    meta = json.loads((build / "meta.json").read_text(encoding="utf-8"))
    assert set(meta) == {"pid", "project", "title", "commit", "dev", "built",
                         "published", "views", "parts"}
    assert sorted(path.name for path in build.iterdir()) == sorted(
        {*ARTEFACTS, PAYLOAD_DIGEST_FILE, FILE_DIGESTS_FILE})
    assert hub.job_log(record["id"]).text == (
        f"copying builder: {len(ARTEFACTS)} files\n")


def test_a_document_may_not_land_on_what_the_model_wrote(model_hub):
    """`clash.png` is a top-level file, so the stand-in ships it as the
    model's own output, and listing it as a document would overwrite it."""
    record = refused(model_hub, model_tree(
        LISTED + ["clash.png"], **{"clash.png": PNG_BYTES}))
    assert record["code"] == 422
    assert "would overwrite what the model's build wrote: 'clash.png'" in (
        record["error"])


# A KiCad design is several files under one entry: the project, a root sheet
# naming a second one, and the board.
BOARD = {
    "hw/board.kicad_pro": b"{}\n",
    "hw/board.kicad_sch": b'(kicad_sch (sheet (property "Sheetfile" "power.kicad_sch")))\n',
    "hw/power.kicad_sch": b"(kicad_sch)\n",
    "hw/board.kicad_pcb": b"(kicad_pcb)\n",
}


def test_a_kicad_design_beside_a_model_is_published_with_every_file(model_hub):
    revision = published(model_hub, model_tree(["hw/board.kicad_pro"], **BOARD))
    meta = model_hub.get(f"/project/docs0001/{revision}/meta.json").json()

    doc, = meta["documents"]
    assert doc["kicad"] == {"schematics": ["hw/board.kicad_sch", "hw/power.kicad_sch"],
                            "pcb": "hw/board.kicad_pcb"}
    for name, data in BOARD.items():
        served = model_hub.get(f"/project/docs0001/{revision}/{name}")
        assert (served.status_code, served.content) == (200, data), name


def test_a_file_of_a_design_may_not_land_on_what_the_model_wrote(hub_factory):
    def builder(project_dir, out_dir, *, pid, **kwargs):
        outcome = model_builder(project_dir, out_dir, pid=pid, **kwargs)
        wrote = Path(out_dir) / "hw" / "board.kicad_sch"
        wrote.parent.mkdir()
        wrote.write_bytes(b"the model's own")
        return dataclasses.replace(outcome, files=(*outcome.files, "hw/board.kicad_sch"))

    record = refused(hub_factory(build_runner=builder),
                     model_tree(["hw/board.kicad_pro"], **BOARD))
    assert record["code"] == 422
    assert "would overwrite what the model's build wrote: 'hw/board.kicad_sch'" in (
        record["error"])


# -- what a list may say -------------------------------------------------------

@pytest.mark.parametrize("listed, named", [
    (LISTED + ["missing.md"], "'missing.md', which is not a file in the pushed tree"),
    (LISTED + ["notes.txt"], "'notes.txt', which is none of the types"),
    (LISTED + ["index.html"], "'index.html', which is a name the hub writes"),
    (LISTED + ["../list.md"], "'../list.md', which has the segment '..'"),
    (LISTED + ["docs//report.pdf"], "which has an empty segment"),
    (LISTED + ["list.md"], "'list.md', which is listed twice"),
    (LISTED + ["compare/x.md"], "'compare/x.md', which starts with `compare/`"),
    (LISTED + ["docs__report.pdf"],
     "'docs__report.pdf', which gets the id 'docs__report.pdf' that "
     "'docs/report.pdf' already has"),
])
def test_an_entry_the_hub_cannot_publish_refuses_the_push_before_any_build(
        hub_factory, listed, named):
    calls = []

    def builder(*args, **kwargs):
        calls.append(args)
        return model_builder(*args, **kwargs)

    hub = hub_factory(build_runner=builder)
    extra = {"notes.txt": b"x", "index.html": b"<p>mine</p>",
             "compare/x.md": b"# x\n", "docs__report.pdf": b"%PDF-1.4\n"}
    for body in (documents_tree(listed, **extra), model_tree(listed, **extra)):
        record = refused(hub, body)
        assert record["code"] == 422
        assert record["error"].startswith(
            "project.json lists documents the hub cannot publish:\n")
        assert named in record["error"], record["error"]
    assert calls == [], "a model was built for a push its list refuses"


def test_a_list_that_is_not_a_list_of_paths_is_refused(hub):
    record = refused(hub, documents_tree("list.md"))
    assert record["code"] == 422
    assert "`documents` in project.json has to be a list of paths" in (
        record["error"])


TITLED = [{"file": "list.md", "title": "Список покупок"}, "ref/photo.png",
          {"file": "drawing.svg", "title": "Схема распила"}]


@pytest.mark.parametrize("tree", [documents_tree, model_tree])
def test_a_title_is_the_caption_of_its_document_and_the_path_stays_its_address(
        model_hub, tree):
    revision = published(model_hub, tree(TITLED))
    meta = model_hub.get(f"/project/docs0001/{revision}/meta.json").json()

    assert [(d["name"], d["file"], d["id"]) for d in meta["documents"]] == [
        ("Список покупок", "list.md", "list.md"),
        ("ref/photo.png", "ref/photo.png", "ref__photo.png"),
        ("Схема распила", "drawing.svg", "drawing.svg")]
    # The document is served where the path says, whatever it is called.
    assert model_hub.get(
        f"/project/docs0001/{revision}/drawing.svg").status_code == 200


@pytest.mark.parametrize("entry, named", [
    ({"title": "Список"}, "has no `file`, the path of the document"),
    ({"file": "list.md", "titel": "Список"},
     "'list.md', which has keys the hub does not read: titel"),
    ({"file": "list.md", "title": "   "},
     "'list.md', which has a title the page cannot show: `title` must be a "
     "non-empty string"),
    ({"file": "list.md", "title": None}, "`title` must be a non-empty string"),
    ({"file": "list.md", "title": "two\nlines"}, "non-printable character"),
    ({"file": "list.md", "title": "x" * 201}, "is longer than"),
    ({"file": "nope.md", "title": "Список"},
     "'nope.md', which is not a file in the pushed tree"),
])
def test_a_titled_entry_the_hub_cannot_publish_refuses_the_push(
        hub, entry, named):
    record = refused(hub, documents_tree([entry]))
    assert record["code"] == 422
    assert record["error"].startswith(
        "project.json lists documents the hub cannot publish:\n")
    assert named in record["error"], record["error"]


def test_a_tree_with_no_model_and_no_list_goes_to_the_model_build(hub_factory):
    """The hub does not decide "nothing to build" itself: the model's build
    says so (`cadbuild.geometry._nothing_to_build_hint`), in the words its
    other refusals use."""
    calls = []

    def builder(*args, **kwargs):
        calls.append(args)
        return model_builder(*args, **kwargs)

    hub = hub_factory(build_runner=builder)
    hub.publish("docs0001", None, documents_tree(None))
    assert len(calls) == 1


# -- paths and ids -------------------------------------------------------------

# One row per path, and whether the path rule takes it: `_safe_build_path`,
# which the file server asks of the path it rebuilds from a request's non-empty
# segments, and a document's declaration. A request never carries an empty
# segment to the rule (the server answers `docs//x.md` as `docs/x.md`); a
# declaration is refused one, because `/x.md` joined onto the tree leaves it and
# `docs//x.md` would name `docs/x.md` under a second id.
PATHS = (
    ("docs/cut-list.md", True),
    ("a/b/c.png", True),
    ("list.md", True),
    ("docs//x.md", False),
    ("/x.md", False),
    ("docs/", False),
    ("../x.md", False),
    ("docs/.hidden.md", False),
    (".git/x.md", False),
    ("docs/‮x.md", False),
    ("", False),
)


def test_the_file_server_and_a_document_agree_on_what_a_path_may_be(tmp_path):
    """The path rule's three doors over one table: the file server, the
    declaration (a document's `file`), and the shared function itself."""
    for path, servable in PATHS:
        assert _safe_build_path(path) is servable, path
        assert (buildnames.unservable_path_reason(path) is None) is servable, path
        try:
            render._check_declared_file(path, {path: "d"}, "document", path=True)
            declarable = True
        except ValueError:
            declarable = False
        assert declarable is servable, path


def test_a_path_through_a_dot_segment_is_not_served(hub):
    """Over `http.client`, which sends the path as written: httpx would remove
    the dot segments before the hub saw them."""
    revision = published(hub)
    where = urlsplit(hub.url)
    for path in ("ref/../meta.json", "ref/%2e%2e/meta.json", "ref/.photo.png"):
        connection = http.client.HTTPConnection(where.hostname, where.port,
                                                timeout=10)
        try:
            connection.request("GET", f"/project/docs0001/{revision}/{path}")
            assert connection.getresponse().status == 404, path
        finally:
            connection.close()
    assert hub.get(f"/project/docs0001/{revision}/ref/photo.png").status_code == 200


def test_a_document_id_is_its_path_and_two_paths_never_share_one(tmp_path):
    assert render.document_id("docs/cut-list.md") == "docs__cut-list.md"
    assert render.document_id("list.md") == "list.md"
    # The one way two paths meet, refused on the way in as well as here.
    for name in ("a/b.md", "a__b.md"):
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# x\n", encoding="utf-8")
    raw = {"kind": "documents", "documents": [
        {"name": n, "type": "markdown", "file": n} for n in ("a/b.md", "a__b.md")]}
    with pytest.raises(ValueError, match=re.escape(
            "documents 'a/b.md' and 'a__b.md' get the same id 'a__b.md'")):
        render.build_meta(pid="docs0001", commit="abc", raw=raw,
                          staging=tmp_path, published="now",
                          files={"a/b.md": "0" * 64, "a__b.md": "0" * 64})


@pytest.mark.parametrize("change, message", [
    (lambda doc: doc.update(type="image"), "extension makes it 'markdown'"),
    (lambda doc: doc.update(file="notes.txt"), "none of the types"),
    (lambda doc: doc.update(file="../list.md"), "has the segment '..'"),
])
def test_a_document_entry_that_lies_about_its_file_is_refused(
        tmp_path, change, message):
    (tmp_path / "list.md").write_text("# x\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    doc = {"name": "list.md", "type": "markdown", "file": "list.md"}
    change(doc)
    raw = {"kind": "documents", "documents": [doc]}
    files = {"list.md": "0" * 64, "notes.txt": "0" * 64, "../list.md": "0" * 64}
    with pytest.raises(ValueError, match=re.escape(message)):
        render.build_meta(pid="docs0001", commit="abc", raw=raw,
                          staging=tmp_path, files=files, published="now")


def test_the_document_types_are_open_and_served_as_themselves():
    # Two tables in app.py that a new document type has to reach, or its file
    # is a 403 to the link that shows it or an attachment instead of a page.
    assert set(render.DOCUMENT_TYPES) <= OPEN_SUFFIXES
    assert set(render.DOCUMENT_TYPES) <= set(BUILD_CONTENT_TYPES)


def test_the_page_and_the_hub_spell_the_kind_the_same_way():
    source = (ROOT / "ui" / "src" / "DocShell.jsx").read_text(encoding="utf-8")
    spelled = re.search(r"export const DOCUMENTS_KIND = '([^']+)'", source)
    assert spelled and spelled.group(1) == render.DOCUMENTS_KIND
