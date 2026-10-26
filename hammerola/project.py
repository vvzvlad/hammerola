"""The one question asked of the working directory: WHICH PROJECT.

Answered by `project.json` alone, never by the directory name (a checkout can
live in any directory). `hammerola create` writes it once.

THE ID IS WRITTEN ONCE AND NEVER CHANGED (SPEC §3.1): every permanent URL is
built from it. `title` is changed by `hammerola rename`; `project` (the slug)
only by hand, since nothing recomputes it. `create_project` refuses to write
over an existing file; `write_project_title` rewrites only the title.

The revision is not asked here: it is the commit `git push` publishes.
"""

import json
import os
import secrets
from pathlib import Path

from hammerola.buildnames import first_nonprintable
from hammerola.limits import MAX_TEXT_CHARS, SAFE_ID
from hammerola.projectslug import slug_from_directory, slug_from_title

PROJECT_FILE = "project.json"

# The key that says what this project is CALLED, as against its id. Written
# only here: see `_project_slug`.
PROJECT_KEY = "project"

# Identifier width in hex characters (SPEC §3.1: `7f3c1a9e04d2`): 48 bits,
# short in a URL and collision-free across a few hundred independently minted
# projects.
ID_HEX_CHARS = 12


class ProjectError(Exception):
    """The working directory is not something that can be published."""


def find_project_root(start=None) -> Path:
    """The nearest directory at or above `start` holding a project.json."""
    here = Path(start).resolve() if start is not None else Path.cwd().resolve()
    for candidate in (here, *here.parents):
        if (candidate / PROJECT_FILE).is_file():
            return candidate
    raise ProjectError(
        f"no {PROJECT_FILE} here or in any parent of {here}.\n"
        f"  Run this in a model's directory: {PROJECT_FILE} is what says which "
        f"project the hub should publish under."
    )


def read_project_id(root: Path) -> str:
    """The `id` out of project.json, checked against the hub's alphabet.

    Checked here so the refusal arrives before anything is sent. An empty id means a
    hand-written file: `hammerola create` always mints one, and
    `model_template/` carries no `project.json` (`tests/test_template.py`).
    """
    path = root / PROJECT_FILE
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ProjectError(f"cannot read {path}: {error}") from error
    try:
        payload = json.loads(raw)
    except ValueError as error:
        raise ProjectError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ProjectError(f"{path} must hold a JSON object")

    pid = payload.get("id")
    if not isinstance(pid, str) or not pid:
        raise ProjectError(
            f"{path} carries no project id.\n"
            f"  `hammerola create` writes one and never leaves it blank, so "
            f"this file was written or edited\n"
            f"  by hand. Fill in \"id\" before publishing — every permanent URL "
            f"of this project is built\n"
            f"  from it, so it must not change afterwards."
        )
    if not SAFE_ID.match(pid):
        raise ProjectError(
            f"project id {pid!r} in {path} is not one the hub can serve: it "
            f"must match {SAFE_ID.pattern}"
        )
    return pid


def new_project_id() -> str:
    """A fresh identifier: twelve hex characters, minted here and never again.

    Local and random (SPEC §3.1): not derived from the name, which changes on
    rename, and not registered with the hub, so `create` works offline.
    """
    return secrets.token_hex(ID_HEX_CHARS // 2)


def create_project(root: Path, title: str = "") -> dict:
    """Write a `project.json` with a new id into `root`. Returns what it wrote.

    Refuses to overwrite an existing one: the id is the only link to
    everything the hub has for the project, and a new one would silently push
    into an empty project.

    The directory is NOT required to exist beforehand; `hammerola create` in a
    new directory is the ordinary way to start.
    """
    root = Path(root)
    path = root / PROJECT_FILE
    if path.exists():
        raise ProjectError(
            f"{path} already exists.\n"
            f"  Its id is what every published URL of this project is built "
            f"from, so this tool will not replace it — a new one would silently "
            f"detach the directory from everything the hub has for it. Delete "
            f"the file by hand if that is genuinely what you want."
        )

    payload = {"id": new_project_id(), "title": _clean_title(title, root)}
    # Absent rather than empty when nothing names the project, so the hub
    # falls back to the project id. See `_project_slug`.
    slug = _project_slug(root, payload["title"])
    if slug:
        payload[PROJECT_KEY] = slug
    try:
        root.mkdir(parents=True, exist_ok=True)
        # `x`, not `w`: the race-free version of the `exists()` check above.
        with open(path, "x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=1, ensure_ascii=False)
            stream.write("\n")
    except FileExistsError as error:
        raise ProjectError(f"{path} already exists") from error
    except OSError as error:
        raise ProjectError(f"cannot write {path}: {error}") from error
    return payload


def _project_slug(root: Path, title: str) -> str:
    """The latin name this project publishes under, or "" when it has none.

    Written at `create` time because only this machine knows the directory
    name: on the hub a pushed commit's tree is checked out into
    `.src-<uuid4 hex>`.

    The directory before the title's brackets, matching the order
    `cadbuild.project.load_project` reads (the `project` key, then the
    brackets, then the id). Empty when neither is a slug (`Корпус/` titled
    "Корпус"): the id then names the project.

    A candidate over MAX_TEXT_CHARS (a directory name can be 255 characters) is
    passed over rather than truncated, since the build would refuse it.
    `_clean_title` refuses instead, because a title has no fallback.
    """
    for slug in (slug_from_directory(Path(root).resolve().name),
                 slug_from_title(title)):
        if slug and len(slug) <= MAX_TEXT_CHARS:
            return slug
    return ""


def _clean_title(title: str, root: Path) -> str:
    """The human-readable name, or the directory's own name as a stand-in.

    A single printable line no longer than MAX_TEXT_CHARS: the same rules
    `cadbuild.project.load_project` enforces inside the job, checked here where
    the name is chosen. The character rule is `buildnames.first_nonprintable`,
    shared with the build (all of Unicode category C).

    The length matters for the stand-in: a directory name can be 255
    characters. The remedy names `--title`, which only `create` has;
    `write_project_title` never reaches the stand-in because it refuses an
    empty title first.
    """
    given = (title or "").strip()
    title = given or root.resolve().name or "untitled"
    bad = first_nonprintable(title)
    if bad is not None:
        raise ProjectError(
            f"the project title carries the non-printable character {bad!r}; "
            f"the build refuses one, and a title has to be one line a person "
            f"can read")
    if len(title) > MAX_TEXT_CHARS:
        remedy = (
            "  Shorten it."
            if given else
            f"  It was taken from the directory name, which is "
            f"{len(title)} characters long.\n"
            f"  Pass `--title \"<what it is and what it is for> (<slug>)\"`."
        )
        raise ProjectError(
            f"the project title is {len(title)} characters; the hub shows at "
            f"most {MAX_TEXT_CHARS} and a build refuses a longer one.\n"
            f"{remedy}")
    return title


def write_project_title(root: Path, title: str) -> str:
    """Change the `title` in project.json, and NOTHING else. -> the title written.

    The id is never touched (SPEC 3.1) and every other key, known or not,
    survives. Written through a temporary file and renamed, so an interrupted
    rename leaves the previous file intact.

    An empty title is refused here, so `_clean_title` never substitutes the
    directory name (right for `create`, a guess for `rename`).
    """
    if not (title or "").strip():
        raise ProjectError(
            "the new title is empty.\n"
            "  Pass the name the project should have: "
            "\"<what it is and what it is for> (<slug>)\".")

    path = root / PROJECT_FILE
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ProjectError(f"cannot read {path}: {error}") from error
    except ValueError as error:
        raise ProjectError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ProjectError(f"{path} must hold a JSON object")

    payload["title"] = _clean_title(title, root)
    tmp = path.parent / f".{path.name}.wip"
    try:
        with open(tmp, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=1, ensure_ascii=False)
            stream.write("\n")
        os.replace(tmp, path)
    except OSError as error:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise ProjectError(f"cannot write {path}: {error}") from error
    return payload["title"]


def read_project_title(root: Path) -> str:
    """The project's title, or "". Cosmetic — it only appears in the banner."""
    try:
        payload = json.loads((root / PROJECT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    title = payload.get("title") if isinstance(payload, dict) else None
    return title if isinstance(title, str) else ""
