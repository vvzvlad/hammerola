"""The documents a project publishes to be read, beside its model or instead of one.

A project lists them in its `project.json`, in tab order:

    "documents": ["docs/cut-list.md", "ref/terr-raspil.svg"]

Each is a path in the pushed tree, of a type the page can show
(`render.DOCUMENT_TYPES`: markdown, PDF, pictures, HTML, SVG), and it is
published under the same path, so a link between two of them works as it does
in the tree. Nothing is found by extension: a file is a document because the
list says so.

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
import shutil
import time
from pathlib import Path

from hammerola.buildnames import unservable_path_reason
from hammerola.projectslug import slug_from_title
from src.buildproc import STATUS_OK, BuildOutcome
from src.errors import PublishError
from src.render import (DOCUMENT_TYPES, DOCUMENTS_KIND, GENERATED_FILES,
                        document_id, document_type)
from src.store import BUILD_META_FILE

PROJECT_FILE = "project.json"
DOCUMENTS_FIELD = "documents"

# The two spellings `import model` resolves in a pushed tree: the module, or a
# package. A `model/` directory is a package to the import even without an
# `__init__.py`, so it counts as a model here too, and the build says what is
# wrong with it.
MODEL_FILE = "model.py"
MODEL_PACKAGE = "model"

# The first segment the hub routes as a comparison of two revisions
# (`app._serve_project`), so a document under it would never be served.
COMPARE_SEGMENT = "compare"


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
    """The paths project.json lists under `documents`, checked against the tree.

    () when it lists none. Raises PublishError(422) naming every entry that
    cannot be published, before a model's build is spent on the push.
    """
    sources = Path(sources)
    listed = _project(sources).get(DOCUMENTS_FIELD)
    if listed is None:
        return ()
    if not isinstance(listed, list) or not all(
            isinstance(path, str) for path in listed):
        raise PublishError(
            422, f"`{DOCUMENTS_FIELD}` in {PROJECT_FILE} has to be a list of "
                 f"paths in the tree, such as [\"docs/cut-list.md\"]")
    problems = []
    seen: dict[str, str] = {}
    for path in listed:
        reason = _unpublishable(sources, path)
        if reason is None and path in seen.values():
            reason = "is listed twice"
        if reason is None and document_id(path) in seen:
            reason = (f"gets the id {document_id(path)!r} that "
                      f"{seen[document_id(path)]!r} already has, so one "
                      f"address would name both")
        if reason is not None:
            problems.append(f"  {path!r}, which {reason}")
        else:
            seen[document_id(path)] = path
    if problems:
        raise PublishError(
            422, f"{PROJECT_FILE} lists documents the hub cannot publish:\n"
                 + "\n".join(problems))
    return tuple(listed)


def _unpublishable(sources: Path, path: str) -> str | None:
    """Why one listed path cannot be a document, as the tail of "…, which"."""
    reason = unservable_path_reason(path)
    if reason is not None:
        return reason
    if document_type(path) is None:
        return (f"is none of the types the page shows: "
                f"{', '.join(DOCUMENT_TYPES)}")
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


def _copy(sources: Path, out_dir: Path, paths) -> tuple:
    """Copy each document to its path under `out_dir`. -> (entries, log lines)."""
    entries, lines = [], []
    for path in paths:
        target = out_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(sources / path, target)
        shown_as = document_type(path)
        entries.append({"name": path, "type": shown_as, "file": path})
        lines.append(f"  {path}  {shown_as}  "
                     f"{target.stat().st_size / 1e3:.1f} kB")
    return entries, lines


def run_documents_build(sources, out_dir, paths, *, pid) -> BuildOutcome:
    """The build of a tree with no model: its documents and a meta.json.

    `out_dir` is the staging directory `Store.build_staging` named; it is
    created here, as a model's build creates its own. `paths` come from
    `declared_documents`, already checked.
    """
    started = time.monotonic()
    sources, out_dir = Path(sources), Path(out_dir)
    project, title = _names(_project(sources), pid)
    out_dir.mkdir()
    entries, lines = _copy(sources, out_dir, paths)
    meta = {"project": project, "title": title, "kind": DOCUMENTS_KIND,
            "documents": entries}
    (out_dir / BUILD_META_FILE).write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log = "\n".join([f"documents of {project} ({pid})", *lines]) + "\n"
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=(BUILD_META_FILE, *paths), log=log,
        log_truncated=False, exit_code=None, signal=None,
        duration_seconds=time.monotonic() - started)


def add_documents(sources, staging, paths, outcome: BuildOutcome) -> BuildOutcome:
    """Put a model's documents beside its successful build. -> the outcome with them.

    The model's meta.json gains `documents`, which `render.build_meta` checks
    like any pointer and rebuilds; the files join the outcome's list, which is
    what is hashed and published. A document may not land on anything the
    model's build wrote: that is a 422 naming both, never an overwrite.
    """
    sources, staging = Path(sources), Path(staging)
    clashes = [path for path in paths if _occupied(staging, path)]
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
    entries, lines = _copy(sources, staging, paths)
    meta[DOCUMENTS_FIELD] = entries
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return dataclasses.replace(
        outcome, files=(*outcome.files, *paths),
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
