"""What the hub hands somebody who has just found it: the skill, the tool, the
template — and whether there is anything here yet.

Everything else on this service assumes `hammerola` on PATH, a model directory
and the secret. A first run has none of them, so the hub serves the three
things it needs, and one document that names them.

    GET /start                    the manifest: the three paths, the versions
                                  of the skill and of the client, and `empty`
    GET /start/skill.tar.gz       the agent instructions: `SKILL.md` and the
                                  `references/` it sends its reader to
    GET /start/hammerola          the client, one executable file
    GET /start/template.tar.gz    a model directory that builds as it stands

All four are public: they are the software, identical on every deployment,
and say nothing about what is published here. Behind `EDIT_TOKEN` they would be
circular, since the manifest is for somebody who has no token yet.

`empty` is the one statement about this instance made without authentication,
and it is a boolean on purpose: not a count (fleet size and growth), not a name
(the prefix of a permanent URL, which `/index.json` withholds).

What reads `empty` is the sign-in screen of a hub nobody has pushed to
(`ui/src/HammerolaEntry.jsx`): seven lines to hand to an agent, with the client's
path from the manifest and the address from the browser. The page asks lazily,
only when showing the form.

Every field has a reader: `hammerola create` follows `template`; the sign-in
screen reads `empty` and renders `client`, the one address its block hands over;
`hammerola skill` follows `skill` to the archive it installs and compares
`skill_version` with the installed copy; `hammerola build` and
`hammerola commit` refuse to publish from a client older than `client_version`.
Both versions are constants of the image, not of the deployment, and
`client_version` can already be read out of the client served here.

What counts as empty is "no project directory with anything in it"
(`Store.empty`). Not "no cards on the front page": a project with only a `dev`
build has no card (SPEC 7.6) but is not empty. And not "no project directory":
`build_staging` creates one that a failed first build leaves behind.

No address appears here. The paths are relative; the page reads the hub's
address from where it was loaded (`hubOrigin` in `ui/src/hub.js`), and this
repository never carries a deployment's address (AGENTS.md).
"""

import ast
import gzip
import io
import re
import tarfile
import zipfile
from functools import lru_cache
from pathlib import Path

from hammerola import VERSION as CLIENT_VERSION

ROOT = Path(__file__).resolve().parent.parent

# --- the routes, named once ------------------------------------------------
# The manifest carries them so that `hammerola create` and the sign-in page
# need no copies of these strings.
START_SEGMENT = "start"
SKILL_NAME = "skill.tar.gz"
CLIENT_NAME = "hammerola"
TEMPLATE_NAME = "template.tar.gz"

MANIFEST_URL = f"/{START_SEGMENT}"
SKILL_URL = f"/{START_SEGMENT}/{SKILL_NAME}"
CLIENT_URL = f"/{START_SEGMENT}/{CLIENT_NAME}"
TEMPLATE_URL = f"/{START_SEGMENT}/{TEMPLATE_NAME}"

# The key the client reads out of the manifest to find the template. A constant
# rather than a literal at the call site because both sides of that contract are
# in this repository and a test compares them.
TEMPLATE_KEY = "template"

# ...and the key carrying the version of the skill THIS image ships, which the
# client compares against the copy installed on a laptop (`hammerola skill`).
# Same arrangement, same reason: `hammerola/skill.py` names it too and a test
# holds the two strings together.
SKILL_VERSION_KEY = "skill_version"

# ...and the same for the client this image serves at `/start/hammerola`. The
# number is imported from `hammerola/__init__.py`, so the manifest and the
# served archive agree. `hammerola/update.py` reads this key to decide whether
# a `build` or a `commit` may go ahead.
CLIENT_VERSION_KEY = "client_version"

# The skill's version lives in its frontmatter. Two tight patterns rather than a
# YAML parser (none in the standard library; the value is one integer). The
# client carries a copy (`hammerola/skill.py`), and a test checks both agree on
# the shipped file.
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
_VERSION_LINE = re.compile(r"^version:[ \t]*(\d+)[ \t]*$", re.MULTILINE)

# The whole skill is served, not only its entry document: `SKILL.md` names the
# files under `references/` and a reader that had only the entry would follow
# those names to files it has not got.
SKILL_DIR = ROOT / "skill"
# The one member of that directory this half opens: the version is in its
# frontmatter, and the client looks for it under this same name after unpacking
# (`hammerola/skill.py`, which spells its own copy; a test compares the two).
SKILL_ENTRY = "SKILL.md"
SKILL_FILE = SKILL_DIR / SKILL_ENTRY
# `model_template/`, not `template/`: one letter from `templates/` (the page
# templates), which is copied into the image next to it.
TEMPLATE_DIR = ROOT / "model_template"

# --- the client, as one file ----------------------------------------------
# A zipapp (PEP 441): a plain zip of the modules with `__main__.py` at its root
# and a shebang glued on the front, which is exactly what `python -m zipapp`
# produces. One file rather than an archive to unpack, because the whole
# instruction is then `curl -o ~/.local/bin/hammerola && chmod +x` — no
# directory to choose, nothing left behind to update later, and the name the
# file lands under is the name of the command.
#
# It works because the tool imports nothing outside the standard library
# (`tests/client/test_stdlib_only.py` enforces it).
#
# Every module under `hammerola/` goes in, and nothing else; the modules shared
# with the hub (`buildnames`, `metricsdiff`, `projectslug`) live in that package
# too. `tests/test_onboarding.py` proves the set is closed under imports.

# The module the generated `__main__.py` imports, and therefore the root of the
# closure `_refuse_unimportable` walks. Anything the tool needs is reachable from
# here by imports; anything that is not reachable is not part of the tool.
CLIENT_ENTRY = "hammerola/cli.py"

CLIENT_SHEBANG = b"#!/usr/bin/env python3\n"

# The minimum Python for the client: a machine's stock `/usr/bin/python3` runs
# the first onboarding command (3.9 on macOS and Debian 11). Only syntax is
# enforced (`tests/test_onboarding.py` parses with `feature_version` at this
# floor and refuses PEP 604 `X | Y` annotations); 3.9 is the oldest interpreter
# it was actually run under.
#
# Three things read this: the guard in the generated entry point below, so a too
# old interpreter says so instead of dying inside an import; the skill, which
# tells the reader what they need; and the tests that check both.
MIN_PYTHON = (3, 9)
MIN_PYTHON_TEXT = ".".join(str(part) for part in MIN_PYTHON)

CLIENT_MAIN = '''\
"""hammerola, as one file. Built by the hub from hammerola/ (src/onboarding.py).

Run it, or put it on PATH: the shebang is `/usr/bin/env python3`, and this tool
imports nothing outside the standard library, so a machine's own python3 is
enough — from {version} up.
"""

import sys

# BEFORE the import below, and that order is the point: what an interpreter
# older than this does with the package is raise somewhere inside it, and the
# message names an operator rather than the version it belongs to.
if sys.version_info < {floor!r}:
    sys.exit(
        "hammerola needs python {version} or newer, and this is "
        "%d.%d (%s).\\n"
        "  Nothing was run. Install a newer python3, or run the tool with one "
        "you already have:\\n"
        "    python3.11 %s ..." % (sys.version_info[0], sys.version_info[1],
                                   sys.executable, sys.argv[0]))

from hammerola.cli import main  # noqa: E402  (the guard above must run first)

sys.exit(main())
'''.format(version=MIN_PYTHON_TEXT, floor=MIN_PYTHON)

# Every entry in the zip gets this stamp instead of the file's own mtime, and
# every archive this module builds is deterministic for the same reason: the
# bytes are then a function of the image, not of when a request arrived, so two
# hubs running one image serve the identical file and a client can compare what
# it downloaded against what it has. 1980-01-01 is the earliest a zip can carry.
ZIP_EPOCH = (1980, 1, 1, 0, 0, 0)


def manifest(*, empty: bool) -> dict:
    """The document a first run is made of, and the door's block is drawn from.

    Six keys, checked by a test: three relative paths and two versions, all
    constants of the image, plus the one boolean about this deployment. Adding
    a field adds an unauthenticated statement; see the module docstring.

    It reads the shipped `SKILL.md` for `skill_version`, so it can fail like
    the artefact routes; `src/app.py` answers that with a logged 404.
    `client_version` is imported at startup and adds no such failure.
    """
    return {
        "empty": bool(empty),
        "skill": SKILL_URL,
        "client": CLIENT_URL,
        TEMPLATE_KEY: TEMPLATE_URL,
        SKILL_VERSION_KEY: skill_version(),
        CLIENT_VERSION_KEY: CLIENT_VERSION,
    }


@lru_cache(maxsize=1)
def skill_bytes() -> bytes:
    """The agent instructions, as the .tar.gz the client unpacks into a directory.

    The whole of `skill/` under the paths the reader's own directory has to
    carry — `SKILL.md`, `references/<name>.md` — because the entry document
    points at its references by relative path.

    Built like `template_bytes` and held to the same rules, minus the hidden
    file: an archive the client would refuse to unpack fails here instead.

    Cached like the page templates are and for the same reason: the files are
    immutable inside the image, so rebuilding it per request would buy nothing.
    """
    members = skill_members()
    _refuse_unservable(members, SKILL_DIR)
    return _archive(members)


def skill_members() -> list:
    """(member path, path on disk) for the skill, sorted, files only.

    Globbed rather than listed, like `client_members`: a reference added to the
    directory is part of the skill by definition, and a list would be one more
    place to forget. Directory entries are left out exactly as
    `template_members` leaves them out.
    """
    members = []
    for path in sorted(SKILL_DIR.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        members.append((path.relative_to(SKILL_DIR).as_posix(), path))
    return sorted(members)


@lru_cache(maxsize=1)
def skill_version() -> int:
    """The version of the instructions this image ships. Off the file itself.

    The skill is versioned because a stale one fails silently: it keeps
    teaching renamed commands and old ceilings. The file states its version,
    the manifest repeats it, and `hammerola skill` compares them.

    In the frontmatter of the entry document, where Claude Code skills already
    accept extra keys, so the number travels with the file. One version for the
    whole set: `SKILL.md` and its references move together.

    Strictly parsed, with no default: a missing version must not read as the
    first one. Cached; the file cannot change while the process runs.
    """
    text = SKILL_FILE.read_text(encoding="utf-8")
    block = _FRONTMATTER.match(text)
    if block is None:
        raise ValueError(
            f"{SKILL_FILE} has no frontmatter block, so it names no version — "
            f"and a Claude Code skill without one does not install either")
    found = _VERSION_LINE.search(block.group(1))
    if found is None:
        raise ValueError(
            f"{SKILL_FILE} names no `version:` in its frontmatter. It is one "
            f"integer, raised by hand whenever what the skill TEACHES changes; "
            f"there is no default, because a missing version would read as the "
            f"first one")
    return int(found.group(1))


@lru_cache(maxsize=1)
def client_bytes() -> bytes:
    """`hammerola` as one executable file: shebang, then a zip of the modules."""
    verdict = _import_verdict()
    if verdict is not None:
        raise ValueError(verdict)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        _add_zip_entry(archive, "__main__.py", CLIENT_MAIN.encode("utf-8"))
        for name, path in client_members():
            _add_zip_entry(archive, name, path.read_bytes())
    return CLIENT_SHEBANG + buffer.getvalue()


@lru_cache(maxsize=1)
def _import_verdict() -> str | None:
    """The refusal `_refuse_unimportable` would raise, or None — REMEMBERED.

    `lru_cache` stores returned values, not exceptions, so caching
    `client_bytes` alone would re-parse on every request to a public,
    unthrottled route when the image is broken. Remembering a refusal is safe:
    the image cannot change while the process runs.

    Only ValueError becomes a verdict; an OSError (a member vanished between the
    glob and the read) propagates, and `_serve_start` logs the two differently.
    """
    try:
        _refuse_unimportable(client_members())
    except ValueError as error:
        return str(error)
    return None


def client_members() -> list:
    """(archive name, path on disk) for every module the tool is made of.

    `hammerola/*.py` is globbed rather than listed: a module added to the
    package is part of the tool by definition, and a list would be one more
    place to forget. Nothing outside the package is carried, because the tool is
    one distribution and reaches into nothing else.

    A module missing from the image (e.g. via `.dockerignore`) silently drops
    out of the glob, which is why `client_bytes` runs `_refuse_unimportable`.
    """
    return sorted((f"hammerola/{path.name}", path)
                  for path in sorted((ROOT / "hammerola").glob("*.py")))


def _refuse_unimportable(members) -> None:
    """Refuse to serve a client that would die on `import` where it is run.

    A module kept out of the image is simply absent from the glob, and the
    archive would be served and fail with ImportError on the laptop. The suite
    builds from the checkout, where every module exists, so it cannot see this.

    So everything reachable by imports from `CLIENT_ENTRY` must be in the
    archive. A module nothing reaches is not required.

    One member is outside the closure on purpose, pinned by
    `tests/test_onboarding.py`: `hammerola/__main__.py`, since the zipapp's entry
    point is the generated `CLIENT_MAIN` at the archive root.

    Raises ValueError (as does `_refuse_unservable`), which `_serve_start`
    answers with a logged 404; a file that will not parse is re-raised as
    ValueError too.

    It answers a packaging question only, not whether the tool works. Cost is
    about 16 ms once per process, cached by `client_bytes` (healthy image) and
    `_import_verdict` (broken one).
    """
    _, missing = _import_closure(members)
    if missing:
        raise ValueError(
            "the client in this image is incomplete: " + "; ".join(
                f"{module} is imported by {by} and is not here"
                for module, by in sorted(set(missing))))


# Nodes whose body is a SCOPE OF ITS OWN, and therefore binds nothing in the
# module that contains them. `_module_scope` stops at each: a name assigned in a
# function body is bound when the function is CALLED, and the question here is
# what a package binds when it is imported.
_OWN_SCOPE = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda,
              ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _module_scope(tree):
    """Every node a module's own body owns, at any depth inside a statement.

    Not `tree.body`: names bound inside `try/except`, `if`, `for` or `with` are
    bound at import too. Not `ast.walk` either: function and class bodies bind
    nothing until they run.
    """
    stack = list(tree.body)
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, _OWN_SCOPE):
            stack.extend(ast.iter_child_nodes(node))


def _import_closure(members):
    """(reachable modules, missing ones) walking imports from `CLIENT_ENTRY`.

    Split out so a test can assert the size of the closure, which would shrink
    silently through edges this walk does not follow (see `wanted`).
    """
    carried = dict(members)
    trees = {}

    def tree(name):
        if name not in trees:
            try:
                source = carried[name].read_text(encoding="utf-8")
            except UnicodeDecodeError as error:
                # Re-raised to name the file in `_serve_start`'s 404 log line.
                raise ValueError(f"{name} in this image is not utf-8 text: "
                                 f"{error}") from error
            try:
                trees[name] = ast.parse(source)
            except SyntaxError as error:
                raise ValueError(f"{name} in this image will not parse: "
                                 f"{error}") from error
        return trees[name]

    def resolve(dotted):
        """(archive name, is it a package) for a dotted module name, or (None, False)."""
        stem = dotted.replace(".", "/")
        if stem + ".py" in carried:
            return stem + ".py", False
        if stem + "/__init__.py" in carried:
            return stem + "/__init__.py", True
        return None, False

    def wanted(name):
        """(module, imported name or None) for every `hammerola` import in one module.

        `import a.b` and `from a.b import c` are collected the same way, and the
        second yields the imported names as well, because `from hammerola
        import project` names a MODULE while `from hammerola.hub import Hub`
        names an object in one. Which of the two it is cannot be told from the
        statement, so the caller asks the package instead.

        `ast.walk` rather than the module's top level: an import inside a
        function is an import the tool makes, and one that is only reached on
        some paths is the worst kind to discover on a laptop.

        A relative import is refused rather than skipped: it carries no module
        name to resolve, and skipping it would shrink the closure silently. The
        client is written with absolute imports.

        Two edges are neither followed nor refused, and neither occurs in the
        client today: `importlib.import_module("hammerola.x")` (not required
        here, would fail on the laptop), and imports under `if TYPE_CHECKING:`
        (required here though never executed).
        """
        for node in ast.walk(tree(name)):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    yield alias.name, None
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    dots = "." * node.level
                    raise ValueError(
                        f"{name} line {node.lineno} imports relatively "
                        f"(`from {dots}{node.module or ''} import ...`), and "
                        f"this check does not follow relative imports: the "
                        f"client is written with absolute ones so the closure "
                        f"can be computed from the names alone. Write it as "
                        f"`from hammerola.…`, or teach this to resolve `level` "
                        f"against the archive layout")
                if not node.module:
                    continue
                yield node.module, None
                for alias in node.names:
                    # `from hammerola import *` names no submodule; the
                    # package itself is already required above.
                    if alias.name != "*":
                        yield node.module, alias.name

    def bound(name):
        """The names a package's `__init__.py` binds — or None for "unknowable".

        What tells `from hammerola import project` (a submodule, which has to
        be carried) from `from hammerola import VERSION` (a name defined in
        the package itself, which does not).

        None means the namespace cannot be enumerated at all, and the caller
        then abstains rather than refusing. Two forms do that, and both would
        otherwise be a false refusal on a working package: a module-level
        `__getattr__` (PEP 562) manufactures names on demand, and `from x
        import *` binds whatever the other module happened to export. Neither
        can be answered with "that name is not bound", so neither is answered.
        """
        names = set()
        for node in _module_scope(tree(name)):
            if isinstance(node, ast.alias):
                if node.name == "*":
                    return None
                names.add(node.asname or node.name.split(".")[0])
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                # One branch for every assigning form there is: `x = `, `x: T =`,
                # `x += `, a `for` target, a `with ... as`, a walrus, and every
                # shape of unpacking.
                names.add(node.id)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                   ast.ClassDef)):
                names.add(node.name)
        if "__getattr__" in names:
            return None
        return names

    if CLIENT_ENTRY not in carried:
        raise ValueError(
            f"{CLIENT_ENTRY} is not in this image, so there is no client to "
            f"serve")

    missing = []
    seen = set()
    pending = [CLIENT_ENTRY]
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        for module, imported in wanted(name):
            if module != "hammerola" and not module.startswith("hammerola."):
                continue
            found, package = resolve(module)
            if found is None:
                missing.append((module, name))
                continue
            pending.append(found)
            if imported is None or not package:
                continue
            child, _ = resolve(f"{module}.{imported}")
            if child is not None:
                pending.append(child)
                continue
            exported = bound(found)
            if exported is not None and imported not in exported:
                missing.append((f"{module}.{imported}", name))

    return seen, missing


@lru_cache(maxsize=1)
def template_bytes() -> bytes:
    """The starter model directory, as a .tar.gz the client unpacks.

    One hidden file is in it, `.gitignore`, which a push could not carry (the
    hub's alphabet has no leading dot, `src/store.SAFE_COMPONENT`; `pack.py`
    drops hidden entries). The client unpacks under `unpack.TEMPLATE_RULES`,
    which allows that one name in the last component; `_refuse_unservable`
    holds this side to the same rule.
    """
    members = template_members()
    _refuse_unservable(members, TEMPLATE_DIR, hidden_leaves=True)
    return _archive(members)


def _archive(members) -> bytes:
    """`(member path, path on disk)` pairs as one .tar.gz, byte for byte the same.

    Written through `gzip.GzipFile(mtime=0)` rather than `tarfile.open("w:gz")`,
    which would stamp the moment of the request into the gzip header and make
    the bytes differ between two hubs running the same image.
    """
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for name, path in members:
                info = tarfile.TarInfo(name)
                data = path.read_bytes()
                info.size = len(data)
                # Nothing about the machine that built the image: no owner, no
                # mtime, one mode for every file. The same scrubbing `pack.py`
                # applies in the other direction, for the same reasons.
                info.mode = 0o644
                info.mtime = 0
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, io.BytesIO(data))
    return raw.getvalue()


def template_members() -> list:
    """(member path, path on disk) for the template, sorted, files only.

    Directory entries are left out deliberately, exactly as `pack.py` leaves
    them out: the unpacker creates the directories it needs from the member
    paths, so a tar's own directory entries would only carry modes nobody asked
    for.
    """
    members = []
    for path in sorted(TEMPLATE_DIR.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        members.append((path.relative_to(TEMPLATE_DIR).as_posix(), path))
    return sorted(members)


def _refuse_unservable(members, directory, hidden_leaves: bool = False) -> None:
    """Refuse to build an archive the client would refuse to unpack.

    The client's `unpack` is the control; this keeps the two sides from
    disagreeing, so a bad directory fails here rather than on the laptop.

    `hidden_leaves` picks the client's `TEMPLATE_RULES`, which allow the one
    hidden file the template carries; the skill is held to `PUSH_RULES`, the
    hub's own alphabet with no exception at all.

    It calls the client's own check rather than repeating it. The one ceiling
    on the set rather than one name, `MAX_MEMBERS`, is checked here, since
    `unpack` applies it to a tar and this side has files.
    """
    from hammerola.limits import MAX_MEMBERS
    from hammerola.unpack import PUSH_RULES, TEMPLATE_RULES, check_name
    from hammerola.errors import ClientError

    rules = TEMPLATE_RULES if hidden_leaves else PUSH_RULES
    if len(members) > MAX_MEMBERS:
        raise ValueError(
            f"{directory} holds {len(members)} files and a client unpacks at "
            f"most {MAX_MEMBERS}")
    for name, _path in members:
        try:
            check_name(name, f"the directory {directory}", rules)
        except ClientError as error:
            raise ValueError(str(error)) from error


def _add_zip_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    # 0644, and the file mode of a zip member is where zipimport does not care
    # but a person unpacking the archive by hand does.
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)
