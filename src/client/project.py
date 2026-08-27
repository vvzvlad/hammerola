"""The one question asked of the working directory: WHICH PROJECT.

It is answered by `project.json` and by nothing else. Not by the directory name:
a checkout can be cloned into any directory, and a client that guessed would
publish over somebody else's project the first time a directory was renamed.
`project.json` is the file `hammerola create` writes — once, at the start — and
the one every model repository already carries.

WRITTEN ONCE AND THEN LEFT ALONE. SPEC §3.1 states the rule as "we do not edit
this file by hand", which is why minting the id belongs to this tool: a rule
about not typing something is kept by not having to type it. `create_project`
below is the only thing here that writes, and it refuses to write over an id
that already exists.

WHICH REVISION IS NOT ASKED HERE, and it is not asked of git anywhere. The
identifier of a revision is minted by the HUB, out of the sources it receives
(`Store.mint_revision`), so the client has nothing to work out and nothing to
refuse: `hammerola commit` means "publish a version of this", which is a thing a
directory can always do. Whether the directory happens to be a git repository,
whether it has commits, whether the tree is clean — none of it changes what gets
published or where it lands. git is consulted exactly once, afterwards and for a
different purpose: `gitsuggest` offers a commit that RECORDS what was published.
"""

import json
import os
import secrets
from pathlib import Path

from src.client.limits import SAFE_ID

PROJECT_FILE = "project.json"

# How wide the identifier is, in hex characters (SPEC §3.1: `7f3c1a9e04d2`).
# Twelve, so it is short enough to read out of a URL and wide enough that two
# projects created on two machines that never talk to each other do not collide:
# 48 bits, against a fleet of a few hundred projects.
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


def optional_project_root(start=None):
    """The project root, or None when there is none. Never raises.

    For the commands that address something by its own id — `source <revision>`,
    `log <revision>`, `diff <a> <b>`. A revision is named by the hub out of its
    sources and is unique across the whole service, so fetching one needs no
    project at all, and refusing to run outside a model directory would be a
    rule with nothing behind it. (`comments resolve` already works this way, for
    the same reason.)

    The root is still WORTH having when it is there: it is what `latest`
    resolves against, and it is the directory whose `.env` may override the
    machine's settings (`config.resolve`). So this asks, and the caller decides
    whether the answer was needed.
    """
    try:
        return find_project_root(start)
    except ProjectError:
        return None


def read_project_id(root: Path) -> str:
    """The `id` out of project.json, checked against the hub's alphabet.

    Checked HERE rather than left to the hub's 422 because the answer is the
    same either way and this one arrives before a megabyte is uploaded — and
    because the template ships an EMPTY id, so a project nobody ran `make init`
    on gets told that instead of "invalid project id: ''".
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
            f"  A fresh model directory has an empty one until the project is "
            f"given a name; fill in \"id\" before publishing."
        )
    if not SAFE_ID.match(pid):
        raise ProjectError(
            f"project id {pid!r} in {path} is not one the hub can serve: it "
            f"must match {SAFE_ID.pattern}"
        )
    return pid


def new_project_id() -> str:
    """A fresh identifier: twelve hex characters, minted here and never again.

    LOCAL AND RANDOM, not derived from anything (SPEC §3.1). Deriving it from
    the name is the one option that is ruled out on the merits: it would change
    exactly when a project is renamed, which is the moment the id exists to
    survive. Nothing is asked of the hub either — an id is not a registration,
    it is a name the repository carries, and a tool that had to reach the
    network to start a project could not start one on a train.
    """
    return secrets.token_hex(ID_HEX_CHARS // 2)


def create_project(root: Path, title: str = "") -> dict:
    """Write a `project.json` with a new id into `root`. Returns what it wrote.

    REFUSES TO OVERWRITE ONE, and that refusal is the whole safety of the
    command. The id is the only link between a checkout and everything the hub
    has ever published for it: every permanent URL is built from it, the comment
    queue is keyed on it, and the hub has no other way to recognise the project.
    Silently minting a second one would not fail anything — the next push would
    succeed, under a new identity, into an empty project — so the loss would be
    invisible until somebody went looking for the history.

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
    try:
        root.mkdir(parents=True, exist_ok=True)
        # `x` rather than `w`: `path.exists()` above answered a moment ago, and
        # this is the check that cannot be raced by a second `create` — or by
        # the `git clone` somebody started in the next window.
        with open(path, "x", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=1, ensure_ascii=False)
            stream.write("\n")
    except FileExistsError as error:
        raise ProjectError(f"{path} already exists") from error
    except OSError as error:
        raise ProjectError(f"cannot write {path}: {error}") from error
    return payload


def _clean_title(title: str, root: Path) -> str:
    """The human-readable name, or the directory's own name as a stand-in.

    A single printable line. The title is shown on the index card and on the
    build page, so a control character in it is a caption that rewrites the line
    around it — the hub applies the same rule to the title in `meta.json`
    (`render._plain_text`) and this keeps the refusal on the machine where the
    name is being chosen.
    """
    title = (title or "").strip() or root.resolve().name or "untitled"
    for char in title:
        if ord(char) < 0x20 or ord(char) == 0x7F:
            raise ProjectError(
                "the project title contains a control character; it is shown "
                "verbatim on the site and has to be one printable line")
    return title


def write_project_title(root: Path, title: str) -> str:
    """Change the `title` in project.json, and NOTHING else. -> the title written.

    THE ID IS NEVER TOUCHED, and this function is where that is enforced on the
    local side: it reads the file, replaces one key and writes it back, so an id
    cannot be changed by a command that says `rename`. Renaming an id would
    detach the directory from everything the hub has published for it and break
    every permanent URL of the project (SPEC 3.1) — which is why there is no
    command for it here and no route for it there.

    Every other key survives, including ones this tool does not know about: a
    project.json is a file people put things in, and a rename must not be a
    quiet way of dropping them.

    Written through a temporary file and renamed, so an interrupted rename leaves
    the previous file intact rather than a truncated one. This file carries the
    project id; a half-written one is a directory that can no longer publish.
    """
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
