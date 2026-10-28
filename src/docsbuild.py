"""The documents a project publishes to be read, beside its model or instead of one.

A project lists them in its `project.json`, in tab order:

    "documents": ["docs/cut-list.md", {"file": "ref/terr-raspil.svg", "title": "Saw plan"},
                  {"file": "hw/board.kicad_sch", "title": "Board, schematic"},
                  "hw/board.kicad_pcb", "hw/board.glb", "cut/glass.dxf",
                  {"file": "logs/stand.zip", "download": true},
                  {"file": "ref/ne555.pdf", "hidden": true}]

Each is a path in the pushed tree, published under the same path, so a link
between two of them works as it does in the tree. Nothing is found by
extension: a file is a document because the list says so. The EXTENSION decides
only how the page shows it (`render.DOCUMENT_TYPES`: markdown, PDF, pictures,
HTML, SVG, a KiCad schematic, a KiCad board, the 3D model of a board, a zip of
Gerbers); any other extension publishes as `render.FILE_TYPE`, a row that
downloads the file instead of drawing it — a supplier's STEP, a CSV of
measurements.

A DXF, the one the glass shop cuts from, is such a file too, and the page
shows a picture of it: an SVG the hub draws of it
with ezdxf when the list is checked (`_draw_dxf`), published beside it at its
path plus `.svg` (`render.dxf_preview`) and named by the entry's `preview` in
meta.json. A DXF that ezdxf cannot read, or that holds nothing to draw,
refuses the push; listed with `download` it is published with no picture.

An entry is the path alone, or an object with the path as `file`, a `title`,
the caption the page shows in place of the path, `hidden`, which keeps the
document out of the page's list while it is still published and opened by its
address, and `download`, which publishes it as a plain file whatever its
extension. `download` is what tells a zip of logs from a board's Gerbers, which
share the one extension the page unpacks.

A KiCad schematic brings the sheets it names, found as KiCad finds them
(`_kicad_schematic`), and a schematic or a board brings the project with its
path minus the extension (`<stem>.kicad_pro`) when the tree has one. They are
published under their own paths, and the document's `kicad` in meta.json names
them. Under `download` they bring nothing: a file to be taken is not a design
to be drawn from. A project listed on its own is refused: it is not a view of
anything.

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

The same file's `"variant"` is the label of the branch's variant
(`variant_label`), and its `"views"`, `{"<view id>": "<name>"}`, names a
model's views in place of the names model.py gave them (`view_names`,
`name_views`), both read here because this module is the hub's reader of
project.json. A build of documents alone has no views and leaves `views`
unread.
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
from src.render import (BOARD_TYPE, DOCUMENTS_KIND, FILE_TYPE,
                        GENERATED_FILES, KICAD_BOARD, KICAD_PROJECT,
                        KICAD_SCHEMATIC, MAX_KICAD_SHEETS, SCHEMATIC_TYPE,
                        document_id, document_type, dxf_preview,
                        project_title, published_type)
from src import render
from src.store import BUILD_META_FILE

PROJECT_FILE = "project.json"
DOCUMENTS_FIELD = "documents"
VARIANT_FIELD = "variant"
VIEWS_FIELD = "views"

# The keys an entry written as an object may hold.
ENTRY_KEYS = ("file", "title", "hidden", "download")

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
    A DXF not listed with `download` has `preview`, the path its picture is
    published at, and `svg`, the picture, drawn when the list is checked; it is written rather than copied
    from the tree, so it is not one of `files`.
    `download` is the entry's own key and not a field of meta.json: what
    reaches the browser is the type `_copy` resolves from it.
    """

    path: str
    files: tuple
    kicad: dict | None = None
    title: str | None = None
    hidden: bool = False
    download: bool = False
    preview: str | None = None
    svg: str | None = None


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


def variant_label(sources) -> str | None:
    """The tree's `"variant"`, checked by `render.variant_label`, or None
    without one. Raises PublishError(422) for one that does not pass, which
    fails the build and refuses the push."""
    data = _project(Path(sources))
    if VARIANT_FIELD not in data:
        return None
    try:
        return render.variant_label(data[VARIANT_FIELD])
    except ValueError as error:
        raise PublishError(422, f"{PROJECT_FILE}: {error}") from error


def view_names(sources) -> dict:
    """The tree's `"views"`: view id -> the name the page shows in place of
    the model's, each checked by `render.view_name`; {} without one. Raises
    PublishError(422) naming every name that does not pass, which fails the
    build and refuses the push."""
    data = _project(Path(sources))
    listed = data.get(VIEWS_FIELD, {})
    if not isinstance(listed, dict):
        raise PublishError(
            422, f"`{VIEWS_FIELD}` in {PROJECT_FILE} has to be an object of "
                 f"view id to name, such as {{\"assembled\": \"Assembled\"}}")
    names, problems = {}, []
    for view_id, name in listed.items():
        try:
            names[view_id] = render.view_name(name)
        except ValueError as error:
            problems.append(f"  {view_id!r}: {error}")
    if problems:
        raise PublishError(
            422, f"{PROJECT_FILE} names views the page cannot show:\n"
                 + "\n".join(problems))
    return names


def name_views(staging, names: dict) -> None:
    """Lay `names` (`view_names`) over the names the model gave its views in
    the build's meta.json; an id no view has is left alone. A broken meta.json
    is left for publication to refuse in its own words (`Store._read_meta`)."""
    if not names:
        return
    meta_path = Path(staging) / BUILD_META_FILE
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    views = meta.get("views") if isinstance(meta, dict) else None
    if not isinstance(views, list):
        return
    for view in views:
        view_id = view.get("id") if isinstance(view, dict) else None
        if isinstance(view_id, str) and view_id in names:
            view["name"] = names[view_id]
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")


def has_model(sources) -> bool:
    """Does this pushed tree carry a model to build?"""
    sources = Path(sources)
    return ((sources / MODEL_FILE).is_file()
            or (sources / MODEL_PACKAGE).is_dir())


def declared_documents(sources) -> tuple:
    """The documents project.json lists under `documents`, checked against the tree.

    A tuple of `Document`, () when it lists none. Raises PublishError(422)
    naming every entry that cannot be published, before a model's build is
    spent on the push. A DXF's picture is drawn here (`_draw_dxf`), so a DXF
    that cannot be drawn is among them.
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
                 f"with \"hidden\": true to keep it out of the page's list "
                 f"and \"download\": true to publish it as a plain file")
    problems = []
    found = []
    seen: dict[str, str] = {}
    for item in listed:
        path, title, hidden, download, reason = _entry(item)
        if reason is None:
            reason = _unpublishable(sources, path)
        if reason is None and path in seen.values():
            reason = "is listed twice"
        if reason is None and document_id(path) in seen:
            reason = (f"gets the id {document_id(path)!r} that "
                      f"{seen[document_id(path)]!r} already has, so one "
                      f"address would name both")
        design = None
        # A design brings its other files because the page draws it FROM them;
        # under `download` the page draws nothing, so the sheets and the
        # project have no reader and are not published. Asked only of an entry
        # still standing: a refused one may carry the whole object in place of
        # the path (`_entry`), which is not a name to take an extension from.
        drawn_as = (None if reason is not None or download
                    else document_type(path))
        if reason is None and drawn_as == SCHEMATIC_TYPE:
            design, reason = _kicad_schematic(sources, path)
        elif reason is None and drawn_as == BOARD_TYPE:
            design = {"project": _kicad_project(sources, path)}
        # A DXF stays a plain file and brings a picture of itself; under
        # `download` the page shows none, so none is drawn.
        preview = (None if reason is not None or download
                   else dxf_preview(path))
        picture = None
        if preview is not None:
            picture, reason = _draw_dxf(sources / path)
        if reason is not None:
            problems.append(f"  {path!r}, which {reason}")
            continue
        seen[document_id(path)] = path
        found.append(Document(path, (path, *_besides(design)), design, title,
                              hidden, download, preview, picture))
    # A picture is published at a path of its own, which may not be another
    # document's file.
    owners = {name: doc.path for doc in found for name in doc.files}
    for doc in found:
        if doc.preview is not None and doc.preview in owners:
            problems.append(f"  {doc.path!r}, which publishes its preview as "
                            f"{doc.preview!r}, and the document "
                            f"{owners[doc.preview]!r} publishes a file at "
                            f"that path")
    if problems:
        raise PublishError(
            422, f"{PROJECT_FILE} lists documents the hub cannot publish:\n"
                 + "\n".join(problems))
    return tuple(found)


def _entry(item) -> tuple:
    """(path, title, hidden, download, why not) of one entry of `documents`.

    An entry is a path, or an object holding the path as `file`, the caption
    as `title`, and `hidden` and `download`, each true or false; `title` is
    held to the rule a project's title is. A refused object comes back whole
    in place of the path, to be named by the caller.
    """
    if isinstance(item, str):
        return item, None, False, False, None
    path, title = item.get("file"), item.get("title")
    flags = {key: item.get(key, False) for key in ("hidden", "download")}
    unknown = sorted(set(item) - set(ENTRY_KEYS))
    if not isinstance(path, str):
        return (item, None, False, False,
                "has no `file`, the path of the document")
    if unknown:
        return path, None, False, False, (
            f"has keys the hub does not read: {', '.join(unknown)}; an entry "
            f"holds {', '.join(f'`{key}`' for key in ENTRY_KEYS)}")
    # One rule for the two flags: each is written true or false, and nothing
    # else is read as either — `"hidden": "yes"` is a push that means to hide
    # a document and does not.
    for key, value in flags.items():
        if not isinstance(value, bool):
            return (path, None, False, False,
                    f"has a `{key}` that is not true or false")
    if "title" in item:
        try:
            title = project_title(title)
        except ValueError as err:
            return (path, None, False, False,
                    f"has a title the page cannot show: {err}")
    return path, title, flags["hidden"], flags["download"], None


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


def _draw_dxf(target: Path) -> tuple:
    """The picture of the DXF at `target`: its model space as SVG, on white,
    in the drawing's own colours, the page fitted to it with a 2 mm margin.

    -> (svg text, None), or (None, why) as the tail of "…, which". ezdxf
    refuses a file that is no DXF with an OSError, a broken one with a
    DXFError, and one with nothing to draw with a ValueError (an empty
    bounding box leaves no page to fit).
    """
    # Imported here rather than at the top: ezdxf brings numpy with it, and
    # only a push that lists a DXF needs either in the hub's process.
    import ezdxf
    from ezdxf.addons.drawing import (Frontend, RenderContext, config,
                                      layout, svg)
    try:
        drawing = ezdxf.readfile(target)
        backend = svg.SVGBackend()
        Frontend(RenderContext(drawing), backend, config=config.Configuration(
            background_policy=config.BackgroundPolicy.WHITE),
        ).draw_layout(drawing.modelspace())
        text = backend.get_string(layout.Page(
            0, 0, layout.Units.mm, margins=layout.Margins.all(2)))
    except (OSError, ezdxf.DXFError, ValueError) as err:
        # ezdxf names the file by its full path, which is the hub's staging
        # directory and means nothing to the pusher: the file's name stays.
        said = str(err).replace(str(target), target.name)
        return None, (f"is a DXF the hub cannot draw a preview of ({said}); "
                      f"list it with \"download\": true to publish it as a "
                      f"plain file")
    return text, None


def project_names(data: dict, pid: str) -> tuple:
    """(project, title), resolved the way a model's build resolves them.

    The same chain as `cadbuild.project.load_project`: the `project` key, else
    the slug in the title's brackets, else the id. On a build both are checked
    as text by `render.build_meta`. Public for a rename of the project, which
    writes them into a copy of a build (`prereceive.commit_name`) without that
    check: the title was checked by `render.name_text` in the route, and
    `project` is the key a build already carried or a slug (`SLUG_RE`).
    """
    raw_title = str(data.get("title") or "").strip()
    project = (str(data.get("project") or "").strip()
               or slug_from_title(raw_title) or pid)
    return project, raw_title or project


def _files(documents) -> tuple:
    """Every file the documents are published as, each once: their own and
    the pictures drawn of them."""
    return tuple(dict.fromkeys(
        name for doc in documents
        for name in (*doc.files, *([] if doc.preview is None else [doc.preview]))))


def _copy(sources: Path, out_dir: Path, documents) -> tuple:
    """Copy each document's files to their paths under `out_dir`, and write
    the picture of each DXF beside it.

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
        # Beside the DXF, whose directory the copy above made.
        if doc.preview is not None:
            (out_dir / doc.preview).write_text(doc.svg, encoding="utf-8")
        # The type the browser reads, rebuilt and checked again by
        # `render._documents`: what the extension draws as, unless the entry
        # asked for the plain file every document may be published as.
        shown_as = FILE_TYPE if doc.download else published_type(doc.path)
        entry = {"name": doc.title or doc.path, "type": shown_as,
                 "file": doc.path}
        what = shown_as
        if doc.hidden:
            entry["hidden"] = True
        if doc.preview is not None:
            entry["preview"] = doc.preview
            what += ", preview"
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
    project, title = project_names(_project(sources), pid)
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
