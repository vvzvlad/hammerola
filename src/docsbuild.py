"""The documents a project publishes to be read, beside its model or instead of one.

A project lists them in its `project.json`, in tab order:

    "documents": ["docs/cut-list.md", {"file": "ref/terr-raspil.svg", "title": "Saw plan"},
                  {"file": "hw/board.kicad_sch", "title": "Board, schematic"},
                  "hw/board.kicad_pcb", "hw/board.glb",
                  {"file": "ref/ne555.pdf", "hidden": true}]

Each is a path in the pushed tree, of a type the page can show
(`render.DOCUMENT_TYPES`: markdown, PDF, pictures, HTML, SVG, a KiCad
schematic, a KiCad board, the 3D model of a board, a zip of Gerbers), and it is published under
the same path, so a link between two of them works as it does in the tree.
Nothing is found by extension: a file is a document because the list says so.
An entry is the path alone, or an object with the path as `file`, a `title`,
the caption the page shows in place of the path, and `hidden`, which keeps the
document out of the page's list while it is still published and opened by its
address.

A KiCad schematic brings the sheets it names, found as KiCad finds them
(`_kicad_schematic`), and a schematic or a board brings the project with its
path minus the extension (`<stem>.kicad_pro`) when the tree has one. They are
published under their own paths, and the document's `kicad` in meta.json names
them. A project listed on its own is refused: it is not a view of anything.

What the tree holds decides the build (`jobs._build_and_publish`):

  * a model (`has_model`) — the model is built as always, and after it
    succeeds its documents are copied in beside it (`add_documents`);
  * no model and a list — the documents are the build (`run_documents_build`):
    no process and no import, since nothing in the tree is executed, and the
    same `BuildOutcome` a model's build answers with, so publication is the
    path every build takes;
  * neither — the model's build runs and says there is nothing to build
    (`cadbuild.geometry.load_model`).

The list is checked before anything runs (`declared_documents`), and a wrong
entry refuses the whole push with a 422 naming every offender; nothing is
skipped in silence. `project.json` is the build half's to read as well
(`cadbuild.project.load_project`), which takes the keys it knows and leaves
this one alone.
"""

import dataclasses
import json
import posixpath
import re
import shutil
import time
from pathlib import Path

from hammerola.buildnames import unservable_path_reason
from hammerola.projectslug import slug_from_title
from src.buildproc import STATUS_OK, BuildOutcome
from src.errors import PublishError
from src.render import (BOARD_TYPE, DOCUMENT_TYPES, DOCUMENTS_KIND,
                        GENERATED_FILES, KICAD_BOARD, KICAD_PROJECT,
                        KICAD_SCHEMATIC, MAX_KICAD_SHEETS, SCHEMATIC_TYPE,
                        document_id, document_type, project_title)
from src.store import BUILD_META_FILE

PROJECT_FILE = "project.json"
DOCUMENTS_FIELD = "documents"

# The keys an entry written as an object may hold.
ENTRY_KEYS = ("file", "title", "hidden")

# The two spellings `import model` resolves in a pushed tree: the module, or a
# package. A `model/` directory is a package to the import even without an
# `__init__.py`, so it counts as a model here too, and the build says what is
# wrong with it.
MODEL_FILE = "model.py"
MODEL_PACKAGE = "model"

# The first segment the hub routes as a comparison of two revisions
# (`app._serve_project`), so a document under it would never be served.
COMPARE_SEGMENT = "compare"

# How many levels below the listed schematic a sheet may sit.
MAX_KICAD_DEPTH = 8

# A sheet inside a schematic, as KiCad writes it: `(property "Sheetfile"
# "power.kicad_sch" ...)` from KiCad 7 on, `"Sheet file"` in KiCad 6 — both
# accepted, as the viewer accepts both. The path is relative to the directory of
# the schematic that names it. A string in a KiCad file escapes `"` and `\` with
# a backslash.
SHEETFILE = re.compile(r'\(property\s+"Sheet ?file"\s+"((?:[^"\\]|\\.)*)"')
ESCAPED = re.compile(r"\\(.)")


@dataclasses.dataclass(frozen=True)
class Document:
    """One listed document, and every file it is published as.

    `files` starts with `path`; a KiCad schematic adds its sheets and a
    schematic or a board its project, which `kicad` names for meta.json.
    """

    path: str
    files: tuple
    kicad: dict | None = None
    title: str | None = None
    hidden: bool = False


def _project(sources: Path) -> dict:
    """The tree's project.json as an object, or {} when it is not one.

    {} and not a refusal: a broken project.json is the build half's to report
    (`load_project`), in the words it already uses.
    """
    try:
        data = json.loads((sources / PROJECT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def has_model(sources) -> bool:
    """Does this pushed tree carry a model to build?"""
    sources = Path(sources)
    return ((sources / MODEL_FILE).is_file()
            or (sources / MODEL_PACKAGE).is_dir())


def declared_documents(sources) -> tuple:
    """The documents project.json lists under `documents`, checked against the tree.

    A tuple of `Document`, () when it lists none. Raises PublishError(422)
    naming every entry that cannot be published, before a model's build is
    spent on the push.
    """
    sources = Path(sources)
    listed = _project(sources).get(DOCUMENTS_FIELD)
    if listed is None:
        return ()
    if not isinstance(listed, list) or not all(
            isinstance(item, (str, dict)) for item in listed):
        raise PublishError(
            422, f"`{DOCUMENTS_FIELD}` in {PROJECT_FILE} has to be a list of "
                 f"paths in the tree, such as [\"docs/cut-list.md\"], each "
                 f"path optionally written as "
                 f"{{\"file\": \"docs/cut-list.md\", \"title\": \"Cut list\"}}, "
                 f"with \"hidden\": true to keep it out of the page's list")
    problems = []
    found = []
    seen: dict[str, str] = {}
    for item in listed:
        path, title, hidden, reason = _entry(item)
        if reason is None:
            reason = _unpublishable(sources, path)
        if reason is None and path in seen.values():
            reason = "is listed twice"
        if reason is None and document_id(path) in seen:
            reason = (f"gets the id {document_id(path)!r} that "
                      f"{seen[document_id(path)]!r} already has, so one "
                      f"address would name both")
        design = None
        if reason is None and document_type(path) == SCHEMATIC_TYPE:
            design, reason = _kicad_schematic(sources, path)
        elif reason is None and document_type(path) == BOARD_TYPE:
            design = {"project": _kicad_project(sources, path)}
        if reason is not None:
            problems.append(f"  {path!r}, which {reason}")
            continue
        seen[document_id(path)] = path
        found.append(Document(path, (path, *_besides(design)), design, title,
                              hidden))
    if problems:
        raise PublishError(
            422, f"{PROJECT_FILE} lists documents the hub cannot publish:\n"
                 + "\n".join(problems))
    return tuple(found)


def _entry(item) -> tuple:
    """(path, title, hidden, why not) of one entry of `documents`.

    An entry is a path, or an object holding the path as `file`, the caption
    as `title` and `hidden`, true or false; `title` is held to the rule a
    project's title is. A refused object comes back whole in place of the
    path, to be named by the caller.
    """
    if isinstance(item, str):
        return item, None, False, None
    path, title, hidden = item.get("file"), item.get("title"), item.get("hidden", False)
    unknown = sorted(set(item) - set(ENTRY_KEYS))
    if not isinstance(path, str):
        return item, None, False, "has no `file`, the path of the document"
    if unknown:
        return path, None, False, (
            f"has keys the hub does not read: {', '.join(unknown)}; an entry "
            f"holds {', '.join(f'`{key}`' for key in ENTRY_KEYS)}")
    if not isinstance(hidden, bool):
        return path, None, False, "has a `hidden` that is not true or false"
    if "title" in item:
        try:
            title = project_title(title)
        except ValueError as err:
            return path, None, False, f"has a title the page cannot show: {err}"
    return path, title, hidden, None


def _unpublishable(sources: Path, path: str) -> str | None:
    """Why one listed path cannot be a document, as the tail of "…, which"."""
    reason = unservable_path_reason(path)
    if reason is not None:
        return reason
    if Path(path).suffix.lower() == KICAD_PROJECT:
        stem = path[:-len(KICAD_PROJECT)]
        return (f"is a KiCad project and not a view of anything: list the "
                f"schematic {stem + KICAD_SCHEMATIC!r} or the board "
                f"{stem + KICAD_BOARD!r} instead, and each brings the "
                f"project with it")
    if document_type(path) is None:
        return (f"is none of the types the page shows: "
                f"{', '.join(DOCUMENT_TYPES)}")
    return _not_in_tree(sources, path)


def _not_in_tree(sources: Path, path: str) -> str | None:
    """Why `path` cannot be published as a file of the tree, or None."""
    reason = unservable_path_reason(path)
    if reason is not None:
        return reason
    if path in GENERATED_FILES:
        return ("is a name the hub writes itself, so the build would serve "
                "the hub's file instead of this one")
    if path.split("/", 1)[0] == COMPARE_SEGMENT and "/" in path:
        return (f"starts with `{COMPARE_SEGMENT}/`, which is the address of a "
                f"comparison of two revisions")
    target = sources / path
    if target.is_symlink() or not target.is_file():
        return "is not a file in the pushed tree"
    return None


def _kicad_schematic(sources: Path, root: str) -> tuple:
    """The files the listed schematic `root` is published with.

    -> ({"schematics": [root, ...], "project": path or None}, None), or
    (None, why) as the tail of "…, which".

    Every other schematic is found the way KiCad finds it: named by a sheet of
    a schematic already found, relative to that schematic's directory. A
    schematic found once is not read again, so a hierarchy that loops ends; one
    past `MAX_KICAD_SHEETS` files or `MAX_KICAD_DEPTH` levels below the root
    refuses it. The project is `_kicad_project`'s.
    """
    schematics = [root]

    def visit(sheet: str, depth: int) -> str | None:
        text = (sources / sheet).read_text(encoding="utf-8", errors="replace")
        for named in SHEETFILE.findall(text):
            child = posixpath.normpath(posixpath.join(
                posixpath.dirname(sheet), ESCAPED.sub(r"\1", named)))
            if child in schematics:
                continue
            where = f"reaches {child!r} through a sheet of {sheet!r}"
            if not child.endswith(KICAD_SCHEMATIC):
                return f"{where}, and that is not a `{KICAD_SCHEMATIC}` file"
            reason = _not_in_tree(sources, child)
            if reason is not None:
                return f"{where}, and that path {reason}"
            if depth + 1 > MAX_KICAD_DEPTH:
                return (f"{where}, more than {MAX_KICAD_DEPTH} levels below "
                        f"its root schematic")
            if len(schematics) >= MAX_KICAD_SHEETS:
                return f"brings more than {MAX_KICAD_SHEETS} schematics"
            schematics.append(child)
            reason = visit(child, depth + 1)
            if reason is not None:
                return reason
        return None

    reason = visit(root, 0)
    if reason is not None:
        return None, reason
    return {"schematics": schematics,
            "project": _kicad_project(sources, root)}, None


def _kicad_project(sources: Path, path: str) -> str | None:
    """The KiCad project a schematic or a board at `path` is published with:
    the `.kicad_pro` with its path minus the extension, or None when the tree
    holds none to publish. Read by the page's viewer, never shown on its own."""
    project = path[:-len(Path(path).suffix)] + KICAD_PROJECT
    return project if _not_in_tree(sources, project) is None else None


def _besides(design) -> tuple:
    """The files a KiCad document is published with besides its own: its
    sheets and its project, from its `kicad`; () for any other document."""
    if design is None:
        return ()
    sheets = design.get("schematics", [])[1:]
    project = [] if design["project"] is None else [design["project"]]
    return (*sheets, *project)


def _names(data: dict, pid: str) -> tuple:
    """(project, title), resolved the way a model's build resolves them.

    The same chain as `cadbuild.project.load_project`: the `project` key, else
    the slug in the title's brackets, else the id. Both are checked as text by
    `render.build_meta` on the way in.
    """
    raw_title = str(data.get("title") or "").strip()
    project = (str(data.get("project") or "").strip()
               or slug_from_title(raw_title) or pid)
    return project, raw_title or project


def _files(documents) -> tuple:
    """Every file the documents are published as, each once."""
    return tuple(dict.fromkeys(name for doc in documents for name in doc.files))


def _copy(sources: Path, out_dir: Path, documents) -> tuple:
    """Copy each document's files to their paths under `out_dir`.

    -> (meta.json entries, log lines).
    """
    entries, lines = [], []
    for doc in documents:
        size = 0
        for name in doc.files:
            target = out_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sources / name, target)
            size += target.stat().st_size
        shown_as = document_type(doc.path)
        entry = {"name": doc.title or doc.path, "type": shown_as,
                 "file": doc.path}
        what = shown_as
        if doc.hidden:
            entry["hidden"] = True
        if doc.kicad is not None:
            entry["kicad"] = doc.kicad
            if "schematics" in doc.kicad:
                sheets = len(doc.kicad["schematics"])
                what += f", {sheets} sheet{'' if sheets == 1 else 's'}"
            what += ", project" if doc.kicad["project"] else ", no project"
        if doc.hidden:
            what += ", hidden"
        entries.append(entry)
        lines.append(f"  {doc.path}  {what}  {size / 1e3:.1f} kB")
    return entries, lines


def run_documents_build(sources, out_dir, documents, *, pid) -> BuildOutcome:
    """The build of a tree with no model: its documents and a meta.json.

    `out_dir` is the staging directory `Store.build_staging` named; it is
    created here, as a model's build creates its own. `documents` come from
    `declared_documents`, already checked.
    """
    started = time.monotonic()
    sources, out_dir = Path(sources), Path(out_dir)
    project, title = _names(_project(sources), pid)
    out_dir.mkdir()
    entries, lines = _copy(sources, out_dir, documents)
    meta = {"project": project, "title": title, "kind": DOCUMENTS_KIND,
            "documents": entries}
    (out_dir / BUILD_META_FILE).write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log = "\n".join([f"documents of {project} ({pid})", *lines]) + "\n"
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=(BUILD_META_FILE, *_files(documents)),
        log=log, log_truncated=False, exit_code=None, signal=None,
        duration_seconds=time.monotonic() - started)


def add_documents(sources, staging, documents, outcome: BuildOutcome) -> BuildOutcome:
    """Put a model's documents beside its successful build. -> the outcome with them.

    The model's meta.json gains `documents`, which `render.build_meta` checks
    like any pointer and rebuilds; the files join the outcome's list, which is
    what is hashed and published. A document may not land on anything the
    model's build wrote: that is a 422 naming both, never an overwrite.
    """
    sources, staging = Path(sources), Path(staging)
    clashes = [path for path in _files(documents) if _occupied(staging, path)]
    if clashes:
        raise PublishError(
            422, "documents listed in project.json would overwrite what the "
                 "model's build wrote: "
                 + ", ".join(repr(path) for path in clashes))
    meta_path = staging / BUILD_META_FILE
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        # The build's own meta.json is broken: publication refuses it in its
        # own words (`Store._read_meta`), which beat any said here.
        return outcome
    if not isinstance(meta, dict):
        return outcome
    entries, lines = _copy(sources, staging, documents)
    meta[DOCUMENTS_FIELD] = entries
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return dataclasses.replace(
        outcome, files=(*outcome.files, *_files(documents)),
        log=outcome.log + "\n".join(["documents", *lines]) + "\n")


def _occupied(staging: Path, path: str) -> bool:
    """Is there already something at `path`, or anything but a plain directory
    where one of its directories goes?

    A symlinked directory counts as occupied: copying through it would write
    outside the build.
    """
    target = staging / path
    if target.exists() or target.is_symlink():
        return True
    for parent in Path(path).parents:
        if parent == Path("."):
            continue
        here = staging / parent
        if here.is_symlink() or (here.exists() and not here.is_dir()):
            return True
    return False
