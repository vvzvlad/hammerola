"""The one question asked of the working directory: WHICH PROJECT.

It is answered by `project.json` and by nothing else. Not by the directory name:
a checkout can be cloned into any directory, and a client that guessed would
publish over somebody else's project the first time a directory was renamed.
`project.json` is the file `hammerola create` writes — once, at the start — and
the one every model repository already carries.

THE ID IS WRITTEN ONCE AND THEN LEFT ALONE, and it is the id alone: SPEC §3.1
binds "not edited by hand" to that one key, because every permanent URL is built
from it. The other two are edited — `title` by `hammerola rename`, and `project`
by hand, which is the ONLY way to change the published slug once the key exists,
since nothing recomputes it. Minting the id belongs to this tool for the rule
that does hold: a rule about not typing something is kept by not having to type
it. `create_project` below is the only thing here that writes a NEW file, and it
refuses to write over an id that already exists; `write_project_title` rewrites
one key of an existing one and is the reason "left alone" cannot be said of the
whole file.

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

from hammerola.buildnames import first_nonprintable
from hammerola.limits import MAX_TEXT_CHARS, SAFE_ID
from hammerola.projectslug import slug_from_directory, slug_from_title

PROJECT_FILE = "project.json"

# The key that says what this project is CALLED, as against what it is
# identified by. It is written here and nowhere else, because here is the only
# machine where the answer exists: see `_project_slug`.
PROJECT_KEY = "project"

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
    same either way and this one arrives before a megabyte is uploaded.

    THE EMPTY ID IS A HAND-WRITTEN FILE and no longer a stage of the workflow.
    This used to say the template ships one and that a project nobody ran
    `make init` on lands here — both were true of `cad_publish`, whose template
    carried a `project.json` with `"id": ""` for a Makefile target to fill in.
    Neither survives: the id is minted by `hammerola create`
    (`new_project_id`), and `model_template/` carries no `project.json` at all —
    `tests/test_template.py` asserts that, because an id shared by every project
    made from a template is the one thing an id may never be. So what reaches
    this branch is a file somebody wrote or edited themselves, and the message
    below says so.
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
    # ABSENT RATHER THAN EMPTY when nothing here can name the project, and the
    # difference is what the hub reads: a missing key lets it answer with the
    # project id, while `""` would be this directory asserting that it has no
    # name and would still leave the hub to guess. See `_project_slug`.
    slug = _project_slug(root, payload["title"])
    if slug:
        payload[PROJECT_KEY] = slug
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


def _project_slug(root: Path, title: str) -> str:
    """The latin name this project publishes under, or "" when it has none.

    THIS IS THE ONE QUESTION ONLY THIS MACHINE CAN ANSWER, which is why the key
    is written at `create` time rather than worked out by the hub. The slug is
    the name of the author's directory and of their repository; on the hub a
    push is unpacked into `.src-<uuid4 hex>`, so the same question answered
    there gives the hub's own bookkeeping. It did, once, onto the front page:
    a project card reading `.src-89fb7abdeb1d48b5985bcb519850b284`.

    THE DIRECTORY BEFORE THE TITLE, and the hub then ranks the two the same way
    round rather than the opposite way. What this writes is the key the hub
    reads FIRST: `cadbuild.project.load_project` resolves the `project` key,
    then the title's brackets, then the id. So the directory's name reaches the
    build AS that key, ahead of the brackets there exactly as it is ahead of
    them here. The directory itself is in no chain on that side -- deliberately:
    `slug_from_directory` is the one name `cadbuild/project_title.py` does not
    re-export, because the answer there is the `.src-<uuid>` above. It goes
    first here because somebody chose it, and the convention `project_title`
    checks is that it and the title's brackets agree.

    Empty when neither is a slug (`Корпус/` titled "Корпус"), and that is not a
    failure: the id still names the project everywhere it matters, and the build
    log says so once. Refusing to create a project over the spelling of a folder
    would be a wall in front of the first command anybody runs.

    THE CEILING IS CHECKED HERE AND NOT LEFT TO THE HUB, and the candidate it
    can ever turn away is the DIRECTORY's. A path component may be 255
    characters long, `SLUG_RE` has no length in it, and a `project` past
    MAX_TEXT_CHARS is a BuildError raised inside the job -- so a directory named
    at the filesystem's limit would take every push of that project down. The
    BRACKET candidate cannot reach it at all: this function's one caller runs
    `_clean_title` first, which refuses a title over MAX_TEXT_CHARS, and what
    the brackets hold is a substring of that title. The condition still covers
    both because it is one test in the loop -- and it is what would go on
    holding if those two calls were ever run the other way round. A
    candidate that is too long is PASSED OVER rather than truncated: half a name
    is not the project's name, and the next candidate (or the id behind it) is a
    true answer where a cut one is not. `_clean_title` holds the same ceiling and
    REFUSES instead, because a title has nothing to fall through to; read the
    reason there before making these two agree.
    """
    for slug in (slug_from_directory(Path(root).resolve().name),
                 slug_from_title(title)):
        if slug and len(slug) <= MAX_TEXT_CHARS:
            return slug
    return ""


def _clean_title(title: str, root: Path) -> str:
    """The human-readable name, or the directory's own name as a stand-in.

    A single printable line, no longer than the hub will show. Both rules are
    the far side's, and a title that breaks either is a `BuildError` raised
    inside the job: `cadbuild.project.load_project` holds the title to the same
    ceiling and to the same character rule. Checking here keeps that refusal on
    the machine where the name is being chosen.

    THE CHARACTER RULE IS IMPORTED RATHER THAN RESTATED, and that import is the
    whole of it. This spelled the rule itself once — `ord(char) < 0x20 or
    ord(char) == 0x7F`, which is a SUBSET of Unicode category Cc (the C0
    controls and DEL, not the C1 block U+0080-U+009F) — while the far side
    refuses all of category C, so U+202E RIGHT-TO-LEFT OVERRIDE (Cf) was
    accepted here and refused inside the job. That is the same defect
    `src/cadbuild/project.py` records having fixed on the build side, in the
    same spelling, reintroduced on this one. `buildnames.first_nonprintable` is
    the scan both sides now ask, and nothing else comes with it: a title is
    allowed the angle brackets a part name is not, and that rule lives with the
    caller that wants it.

    THE LENGTH IS CHECKED EVEN THOUGH THE TITLE IS USUALLY TYPED, because the
    line above is where it stops being typed: with no `--title` the title is the
    DIRECTORY's name, and a path component may be 255 characters. Adding the
    ceiling to `_project_slug` alone moved that failure rather than fixing it —
    the `project` key was left out and the same over-long name went into `title`
    instead, so the push still died in the job.

    THAT REMEDY NAMES A FLAG, so the branch printing it has to belong to the one
    command that has the flag, and it does: `create_project` is the only caller
    that can reach the stand-in, because `write_project_title` refuses an empty
    title before calling this at all. Read its docstring before removing that
    guard — the two are one decision.

    REFUSED, where a too-long slug is passed over, and the difference is that
    there is nothing here to fall through to: the slug has a second source and
    the id behind that, while the only fallback for a title is a name nobody
    chose. So this one stops the command and says what to pass.
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

    AN EMPTY TITLE IS REFUSED HERE, one line before `_clean_title` would take it,
    and that guard is what keeps this path away from the stand-in below it. That
    function answers a missing title with the DIRECTORY's name, which is right
    for `create` — a fresh project has no other name — and a guess here, where
    the caller passed an argument saying what the title should be. It also put a
    message in front of the wrong reader: the stand-in carries the ceiling on a
    directory name, so `rename ""` under an over-long directory printed the
    remedy for `create`, naming a `--title` flag this command does not have.
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
