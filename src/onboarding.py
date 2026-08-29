"""What the hub hands somebody who has just found it: the skill, the tool, the
template — and whether there is anything here yet.

THE PROBLEM THIS SOLVES. Everything else on this service assumes you already
have `hammerola` on your PATH, a model directory to run it in and the secret to
present. A person who has just deployed a hub, or an agent sitting in an empty
model repository, has none of the three, and until now nothing on the service
said where to get them: the front page asks for a token, and the token is not
what is missing. So the hub serves the three things a first run needs, and one
document that names them.

    GET /start                    the manifest: the three paths, the skill's
                                  version, and `empty`
    GET /start/skill.md           the agent instructions, one Markdown file
    GET /start/hammerola          the client, one executable file
    GET /start/template.tar.gz    a model directory that builds as it stands

ALL FOUR ARE PUBLIC, and that is a decision rather than an oversight. The line
this service draws is written in `src/app.py`: a BUILD is public because a
permanent link is what the hub is for, and the LIST of what exists is not,
because nobody is handed it and every id in it prefixes a permanent URL. These
four are on neither side of that line — they are the software, byte for byte the
same on every deployment, and they say nothing whatever about what has been
published here. Putting them behind `EDIT_TOKEN` would also be circular: the
manifest exists to be read by somebody who does not have the token yet, and the
client is the thing that stores one.

`empty` IS THE ONE STATEMENT ABOUT THIS INSTANCE THAT IS MADE WITHOUT
AUTHENTICATION, and it is deliberately the smallest one that can be made. The
argument for it: a person who deploys a hub and opens it sees a login form and
nothing else, so the instance stays unused for want of one sentence about what
to do next. The argument against: it is a fact about the deployment, given to
anyone who asks. It is accepted at exactly this width — a boolean — and no
wider. NOT a count, not a name, not a date, not "when was the last push". A
count would leak the size of the fleet and its growth rate to anyone who polled;
a name is the prefix of a permanent URL, which is precisely what `/index.json`
is guarded to withhold.

WHAT READS `empty` IS THE DOOR — the sign-in screen of a hub nobody has pushed
to (`ui/src/HammerolaEntry.jsx`, issue #48). It draws five lines somebody
copies and hands to their agent: where the skill is, where the client is, what
this hub's address is, install the skill and follow it, ask the owner for the
token. The two paths in it come from the manifest and the address from the
browser, so nothing on that page names a deployment either. That is what the
argument above buys, and until it was written the argument was a debt: the
route answered a question about the deployment anonymously and no reader had
collected on it.

ALL FIVE FIELDS HAVE A READER NOW, `empty` included — it is the one the
paragraph above is about, and it is the gate on the two the door draws: the door
renders nothing unless it says `true`. `hammerola create` follows `template`;
`skill` and `client` are what the door renders; `skill_version` is what
`hammerola skill` compares against the copy installed on a laptop. The page asks
LAZILY, only when it is showing the form, so a hub with projects on it is not
polled by every reader who already has a token.

`skill_version` IS NOT A SECOND STATEMENT ABOUT THE DEPLOYMENT, and the test
guarding this route is written to say why: like the three paths it is a constant
of the IMAGE — two hubs running the same image answer with the same number — so
it tells a reader what software is running and nothing about what is published
here. That is the line, and `empty` is still the only thing on the far side of
it.

WHAT COUNTS AS EMPTY is "no project directory on the volume WITH ANYTHING IN IT"
(`Store.empty`), which differs from the obvious reading in two places. It is not
"no cards on the front page" — see below — and it is not "no project directory
either": `build_staging` creates one before the build runs and nothing removes it
when the build fails the gate, so counting bare directories made a hub
permanently non-empty the moment its FIRST push failed, which is precisely the
person this answer exists for. A project whose only
build is in the `dev` slot has no card — the index is built from committed
revisions (SPEC 7.6) — and this hub is not empty: somebody has published to it,
an onboarding block would be telling them what they have already done, and
`hammerola status` has something to say. Reading `index.json` instead would have
called that hub empty.

NO ADDRESS APPEARS HERE. The paths below are relative and that is the whole of
what this module names: the door reads the hub's address off the address it was
loaded from (`hubOrigin` in `ui/src/hub.js`), and this repository never carries
the address of a deployment (AGENTS.md).
"""

import ast
import gzip
import io
import re
import tarfile
import zipfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- the routes, named once ------------------------------------------------
# The manifest carries them so that nothing else has to spell them: `hammerola
# create` asks the manifest where the template is rather than carrying a second
# copy of this string, and the door's block for an agent renders its two
# addresses out of what it fetched rather than out of a third copy.
START_SEGMENT = "start"
SKILL_NAME = "skill.md"
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
# Same arrangement, same reason: `src/client/skill.py` names it too and a test
# holds the two strings together.
SKILL_VERSION_KEY = "skill_version"

# THE VERSION LIVES IN THE FILE, and this is the whole of what reads it. Two
# tight patterns rather than a YAML parser: there is no YAML in the standard
# library, the frontmatter is written in this repository, and the value is one
# integer. The client carries a second copy of exactly these two patterns
# (`src/client/skill.py`) because it may import nothing from here — and a test
# runs both over the shipped file and compares the answers, which is what keeps
# the copies from drifting into disagreeing about a version number.
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
_VERSION_LINE = re.compile(r"^version:[ \t]*(\d+)[ \t]*$", re.MULTILINE)

SKILL_FILE = ROOT / "skill" / "SKILL.md"
# `model_template/` and NOT `template/`, which is what this was called for
# exactly one review: one letter from `templates/`, the page templates next to
# it, and both copied to the root of the image by adjacent COPY lines. Two names
# that differ by a letter are how a COPY or an ignore rule ends up pointing at
# the wrong one — and each still resolves, so nothing fails loudly. The name also
# says what the directory is: a template for a MODEL, not for a page.
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
# (`src/client/__init__.py`, and `tests/client/test_stdlib_only.py` enforces
# it): a zipapp cannot carry a compiled dependency, so a client that grew one
# would break here rather than on somebody's laptop.
#
# WHAT GOES IN is every module under `src/client/`, plus the parts of `src/` the
# client is allowed to reach — `metricsdiff` today. That list is closed under
# imports and a test proves it (`tests/test_onboarding.py`), because a module
# added outside `src/client/` and imported from inside it would produce an
# archive that runs on this machine, where the checkout is on `sys.path`, and
# dies with an ImportError on the laptop this is built for.
CLIENT_EXTRA_MODULES = ("src/__init__.py", "src/metricsdiff.py")

# The module the generated `__main__.py` imports, and therefore the root of the
# closure `_refuse_unimportable` walks. Anything the tool needs is reachable from
# here by imports; anything that is not reachable is not part of the tool.
CLIENT_ENTRY = "src/client/cli.py"

CLIENT_SHEBANG = b"#!/usr/bin/env python3\n"

# THE PYTHON THIS TOOL IS HELD TO, and the one place that floor is written. It
# is not an aspiration: `/usr/bin/python3` is 3.9 on macOS and on Debian 11, and
# 3.8 on Ubuntu 20.04, so a machine's stock interpreter is what the FIRST
# command of the onboarding runs under — a tool that needs a newer one fails at
# the very step whose whole purpose is that nothing has to be installed.
#
# 3.9 rather than 3.8 because the checks below cannot honestly claim more: what
# is enforced is the syntax the archive's modules use (`tests/test_onboarding.py`
# walks their syntax trees and refuses PEP 604 `X | Y` in an annotation, which is
# 3.10, and parses everything with `feature_version` at this floor). Nothing
# proves the LIBRARY calls are 3.8-safe, and 3.9 is the oldest interpreter this
# was actually run under.
#
# Three things read this: the guard in the generated entry point below, so a too
# old interpreter says so instead of dying inside an import; the skill, which
# tells the reader what they need; and the tests that check both.
MIN_PYTHON = (3, 9)
MIN_PYTHON_TEXT = ".".join(str(part) for part in MIN_PYTHON)

CLIENT_MAIN = '''\
"""hammerola, as one file. Built by the hub from src/client/ (src/onboarding.py).

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

from src.client.cli import main  # noqa: E402  (the guard above must run first)

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

    Five keys and no more, checked by a test: three relative paths and a version
    number, all four constants of the IMAGE, and the ONE boolean about this
    deployment. Adding a field here is adding a statement the hub makes without
    authentication — read the module docstring before doing it, and note which
    side of that line a candidate falls on. `skill_version` is on the safe side
    for the same reason the paths are: it is byte-identical on every deployment
    running this image, so it says what the software IS and nothing about what
    has been published here or who runs it.

    ALL FIVE HAVE A READER. `hammerola create` follows `template`; the sign-in
    page reads `empty` — that is the whole of the gate on its block — and
    follows `skill` and `client` when it says there is nothing here yet;
    `hammerola skill` reads `skill_version` to tell a stale copy of the
    instructions from a current one, which is the one thing in this system that
    used to go wrong in total silence (issue #51).
    `template` is the one the BROWSER deliberately ignores — a page cannot
    unpack a starter project into anybody's directory, and the block that would
    name it says "install the skill and follow it" instead — but it is read all
    the same, by the client, which is where unpacking belongs.

    IT OPENS A FILE NOW, which it did not before: `skill_version` reads the
    shipped `SKILL.md`. So this can fail the way the three artefact routes can —
    an image whose skill is missing or whose frontmatter lost its version — and
    `src/app.py` answers that with the same logged 404 rather than dropping the
    socket.
    """
    return {
        "empty": bool(empty),
        "skill": SKILL_URL,
        "client": CLIENT_URL,
        TEMPLATE_KEY: TEMPLATE_URL,
        SKILL_VERSION_KEY: skill_version(),
    }


@lru_cache(maxsize=1)
def skill_bytes() -> bytes:
    """The agent instructions, straight off the image.

    Cached like the page templates are and for the same reason: the file is
    immutable inside the image, so re-reading it per request would buy nothing.
    """
    return SKILL_FILE.read_bytes()


@lru_cache(maxsize=1)
def skill_version() -> int:
    """The version of the instructions this image ships. Off the file itself.

    WHY THE SKILL IS VERSIONED AT ALL, when the client, the template and the
    model contract are not versioned by hand: those three break LOUDLY. A stale
    contract fails the build, a stale client is refused by the hub and says so.
    A stale skill keeps confidently teaching yesterday — a command that was
    renamed, a ceiling that was raised — and the agent following it gets a
    refusal whose cause is a file on its own disk, with nothing anywhere going
    red. So the file states which one it is, the manifest repeats it, and
    `hammerola skill` compares the two (issue #51).

    IN THE FRONTMATTER and not in a comment in the body, because that is the
    part of the document a Claude Code skill already has a parser for: extra
    keys beside `name` and `description` are ordinary there — Anthropic's own
    plugin skills carry `version`, `license` and `allowed-tools` — so the number
    travels with the file wherever it is copied, and no reader has to know a
    convention of ours to find it.

    STRICTLY PARSED, WITH NO DEFAULT. A file with no version is a ValueError and
    not a 1: defaulting would make a shipped skill that lost its version
    indistinguishable from a fresh one, which is the exact silence this whole
    entry exists to end. Cached like `skill_bytes` and for the same reason — the
    file cannot change while the process runs.
    """
    text = skill_bytes().decode("utf-8")
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

    THE POINT IS THAT A REFUSAL IS CACHED AT ALL. `lru_cache` stores a returned
    value and never a raised exception, so caching `client_bytes` covered the
    healthy image and nothing else: on a broken one the parse ran again on every
    request. `/start/hammerola` is public, is dispatched before the token check,
    is throttled by nothing (`src/app.py`) and is served by a thread per
    connection, so that was 22 ms of CPU for an 80-byte anonymous GET —
    measured, twenty requests and twenty parses — and a HEAD bought the same,
    because the archive is built before `with_body` is looked at. It also made
    the paragraph in `_refuse_unimportable` about being able to AFFORD a parse
    false on precisely the image that paragraph exists for.

    MEASURED AFTER, on the same broken image over the same socket: twenty GETs,
    ONE parse, 4.5 ms per request — which is what a 404 on this hub costs when
    it computes nothing, since the healthy route with its archive already built
    answers in 4.7 ms. A broken image is no longer a cheaper request to make
    than a working one.

    REMEMBERING A REFUSAL IS SAFE HERE because there is nothing to recover
    from: the modules are inside the image, the image cannot change while the
    process runs, and the verdict reached on the first request is the verdict
    for every later one. That is the same property that lets the caches around
    this one go unguarded by a fixture.

    ONLY ValueError BECOMES A VERDICT. An OSError — one of the modules named in
    `CLIENT_EXTRA_MODULES` missing from the image outright — is left to
    propagate as itself: `_serve_start` tells the two apart in its log line, and
    it costs one failed `open` rather than twenty parses, so there is nothing
    here for a cache to buy.
    """
    try:
        _refuse_unimportable(client_members())
    except ValueError as error:
        return str(error)
    return None


def client_members() -> list:
    """(archive name, path on disk) for every module the tool is made of.

    `src/client/*.py` is globbed rather than listed: a module added to the
    package is part of the tool by definition, and a list would be one more
    place to forget. What CANNOT be globbed is the second group — the modules
    outside the package that the client imports — so those are named above and
    checked by a test.

    A GLOB IS ALSO WHY THIS LIST CANNOT BE TRUSTED ON ITS OWN, and the reason
    `client_bytes` runs `_refuse_unimportable` over what comes back: a file that
    is not there does not appear in a glob, so a client module `.dockerignore`
    kept out of the image subtracts itself from this list in complete silence.
    The two named above are different — they are read by name, so a missing one
    raises OSError out of `client_bytes` — and that asymmetry is exactly what
    made the glob the dangerous half.
    """
    members = [(name, ROOT / name) for name in CLIENT_EXTRA_MODULES]
    members += [(f"src/client/{path.name}", path)
                for path in sorted((ROOT / "src" / "client").glob("*.py"))]
    return sorted(members)


def _refuse_unimportable(members) -> None:
    """Refuse to serve a client that would die on `import` where it is run.

    THE FAILURE THIS EXISTS FOR HAS NO OTHER WITNESS. `src/client/*.py` is
    globbed, so a module `.dockerignore` (or a mistyped COPY) kept out of the
    image is not an error here — it is simply not in the glob, and the archive
    is built, served with a 200 and a plausible size, and dies with an
    ImportError on the laptop that downloaded it. The suite cannot see it
    either: `tests/test_onboarding.py` builds this archive out of the CHECKOUT,
    where every module is present by construction.

    So the archive is held to a property the glob cannot express: everything
    reachable by imports from `CLIENT_ENTRY` has to be IN it. That is derived
    from the modules themselves rather than from a list, which keeps the
    property of the glob that is worth keeping — a module added to the package
    needs no second edit — while removing the one that is not. A module nothing
    reaches is not required, and that is honest rather than lax: nothing imports
    it, so its absence breaks nothing.

    TWO OF THE TWENTY ARE OUTSIDE THE CLOSURE and they are outside it for
    different reasons — this said "one" until 2026-08-28 and named only the
    first, which is the kind of miscount a test now makes impossible
    (`tests/test_onboarding.py`). `src/client/__main__.py` is unreachable ON
    PURPOSE: the zipapp's entry point is the generated `CLIENT_MAIN` at the
    archive's root, because a zip's entry point has to sit there. `src/__init__.py`
    is unreachable by ACCIDENT of how the one import out of the package resolves
    — `from src.metricsdiff import …` lands on `src/metricsdiff.py` directly, so
    `src` as a package is never looked up — and unlike `__main__.py` it really
    is required. What requires it is not this walk but `CLIENT_EXTRA_MODULES`,
    where it is named and therefore read BY NAME; an image without it raises
    OSError out of `client_bytes` and reaches the same 404.

    AND IT IS REQUIRED ON THE INTERPRETERS THAT MATTER, WHICH ARE NOT THE ONE
    THE SUITE RUNS. Measured by building the archive without `src/__init__.py`
    and running it: `No module named 'src'` under python 3.9 (`MIN_PYTHON`, the
    floor a laptop's stock python3 sits at) and under 3.11 (the image's own),
    because zipimport resolves no namespace package there — and a clean `ok`
    under 3.14, which resolves one happily. So the newest interpreter is
    precisely the one that cannot witness this, and a test asserting it would
    say the opposite thing on a new enough venv. Do not turn this paragraph
    into an assertion without pinning the interpreter it is true of.

    IT RAISES ValueError, LIKE `_refuse_unservable`, and that type is part of
    the contract with `src/app.py`: `_serve_start` catches it and answers 404
    with a log line naming the artefact's defect. Anything raised here that it
    does not catch would reach the socket as a dropped connection instead — so
    a file that will not even parse is re-raised as ValueError too rather than
    left as SyntaxError.

    WHAT IT DOES NOT DO is decide whether the tool WORKS: an import that
    resolves says nothing about what the module does. This is the packaging
    question — did every module the tool imports reach the image — and it is
    asked here because the image is the only place it can go wrong.

    WHAT IT COSTS, measured on 20 modules: 16 ms, and once per process WHATEVER
    THE ANSWER IS. Both halves of that need a cache and they are different ones:
    `client_bytes` remembers the archive, which covers the healthy image, and
    `_import_verdict` remembers the refusal, which covers the broken one —
    `lru_cache` stores no exception, so without the second a broken image paid
    this on every anonymous request to a public, unthrottled route. That is the
    whole reason this can afford to parse rather than guess; a per-request cost
    would have bought a cheaper and weaker check instead.
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

    NOT `tree.body`, which is what this used to be and what made a legitimate
    `__init__.py` read as an empty one: a name bound inside `try/except
    ImportError` — the commonest shape there is — or inside `if/else`, `for` or
    `with` is bound at import exactly like one at the top level, and a walk of
    the body alone sees none of them. NOT `ast.walk` either, because that
    descends into function and class bodies, which bind nothing until they run.
    """
    stack = list(tree.body)
    while stack:
        node = stack.pop()
        yield node
        if not isinstance(node, _OWN_SCOPE):
            stack.extend(ast.iter_child_nodes(node))


def _import_closure(members):
    """(reachable modules, missing ones) walking imports from `CLIENT_ENTRY`.

    Split out of `_refuse_unimportable` so the SIZE of the closure can be
    asserted by a test. Without that, the two edges this walk does not follow —
    a relative import (refused below) and a name reached through
    `importlib.import_module` (not refused, see `wanted`) — would each shrink
    the closure silently, and a suite that only checks "a module removed from
    the list is refused" stays green while the list of modules it can still
    speak for gets shorter.
    """
    carried = dict(members)
    trees = {}

    def tree(name):
        if name not in trees:
            try:
                source = carried[name].read_text(encoding="utf-8")
            except UnicodeDecodeError as error:
                # A UnicodeDecodeError is already a ValueError, so `_serve_start`
                # answered 404 either way; what it did not do was name the file,
                # and the log line on that 404 is the only thing the reader gets.
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
        """(module, imported name or None) for every `src` import in one module.

        `import a.b` and `from a.b import c` are collected the same way, and the
        second yields the imported names as well, because `from src.client
        import project` names a MODULE while `from src.client.hub import Hub`
        names an object in one. Which of the two it is cannot be told from the
        statement, so the caller asks the package instead.

        `ast.walk` rather than the module's top level: an import inside a
        function is an import the tool makes, and one that is only reached on
        some paths is the worst kind to discover on a laptop.

        A RELATIVE IMPORT IS REFUSED RATHER THAN SKIPPED, and that one branch is
        the difference between a blind spot and an answer. `from . import x`
        carries no module name to resolve, so following it would mean
        reimplementing the interpreter's own resolution against the archive's
        layout; skipping it — which is what `node.level == 0` used to do
        silently — shrinks the closure without shrinking what the refusal
        CLAIMS. Measured: rewriting `cli.py`'s imports as relative, a change no
        runtime behaviour depends on, took the closure from 18 modules to 1 and
        left a client tree missing `status.py` being served with a 200. The
        client is written with absolute imports; this says so out loud instead
        of quietly meaning less.

        TWO EDGES ARE NOT FOLLOWED AND NOT REFUSED EITHER, because neither is a
        FORM this could recognise and both are absent from the client today.
        `importlib.import_module("src.client.x")` is a call with a string in it,
        so a module reached only that way is not required here and would fail on
        the laptop. And `if TYPE_CHECKING:` runs the other way round — the
        import is collected and the module required, though at runtime it is
        never executed — which refuses an image that would have worked.
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
                        f"`from src.…`, or teach this to resolve `level` "
                        f"against the archive layout")
                if not node.module:
                    continue
                yield node.module, None
                for alias in node.names:
                    # `from src.client import *` names no submodule: it binds
                    # whatever `__init__` bound, and the package itself is
                    # already required by the line above. Treating `*` as a
                    # name asked for `src.client.*` and reported a module by
                    # that invented spelling.
                    if alias.name != "*":
                        yield node.module, alias.name

    def bound(name):
        """The names a package's `__init__.py` binds — or None for "unknowable".

        What tells `from src.client import project` (a submodule, which has to
        be carried) from `from src.client import SOMETHING` (a name defined in
        the package itself, which does not). Today `src/client/__init__.py` is
        one docstring and binds nothing at all, so this answers the empty set;
        it is here so that the day the package DOES bind something, a healthy
        image is not refused for shipping without a module that no longer has
        to exist.

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
            if module != "src" and not module.startswith("src."):
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

    ONE HIDDEN FILE IS IN IT, and that is the only way this archive differs from
    a push: `.gitignore` belongs in a fresh project, and the hub's own path
    alphabet cannot carry a leading dot (`src/store.SAFE_COMPONENT`) — which is
    why `pack.py` DROPS hidden entries on the way up rather than refusing them.
    The client reads this archive under `unpack.TEMPLATE_RULES`, which allows
    that one NAME in the LAST component and nothing else; `_refuse_unservable`
    below holds this side to the same rule, so a hidden directory added to the
    template tree is refused here rather than served to a client that would then
    refuse it — or, worse, to an older one that would not.

    Written through `gzip.GzipFile(mtime=0)` rather than `tarfile.open("w:gz")`,
    which would stamp the moment of the request into the gzip header and make
    the bytes differ between two hubs running the same image.
    """
    members = template_members()
    _refuse_unservable(members)
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


def _refuse_unservable(members) -> None:
    """Refuse to build an archive the client would refuse to unpack.

    THE CLIENT IS THE CONTROL and this is not a second one: what may be written
    into somebody's directory is decided on their machine (`unpack`), because
    "the server checked it" is a statement about the server. What this adds is
    that the two sides cannot silently disagree — anything dropped into the
    template tree that a client will not write would otherwise ship, and the
    failure would land on whoever ran `create`, as a refusal naming a file they
    never chose.

    IT CALLS THE CLIENT'S OWN CHECK rather than repeating it, and that is the
    fix for how this went wrong the first time: written out by hand it covered
    the alphabet and forgot the depth, so a template nine directories deep was
    built here, served, and then refused on the other side — the exact outcome
    the paragraph above claims is impossible. The ceilings that are properties of
    the SET rather than of one name are checked here, because `unpack` applies
    those to a tar and this side has files.
    """
    from src.client.limits import MAX_BUILD_BYTES, MAX_MEMBERS
    from src.client.unpack import TEMPLATE_RULES, check_name
    from src.client.errors import ClientError

    if len(members) > MAX_MEMBERS:
        raise ValueError(
            f"{TEMPLATE_DIR} holds {len(members)} files and a client unpacks at "
            f"most {MAX_MEMBERS}")
    total = 0
    for name, path in members:
        try:
            check_name(name, f"the template in {TEMPLATE_DIR}", TEMPLATE_RULES)
        except ClientError as error:
            raise ValueError(str(error)) from error
        try:
            total += path.stat().st_size
        except OSError as error:
            raise ValueError(f"cannot measure {path}: {error}") from error
    if total > MAX_BUILD_BYTES:
        raise ValueError(
            f"{TEMPLATE_DIR} unpacks to {total} bytes, over the "
            f"{MAX_BUILD_BYTES} a client accepts")


def _add_zip_entry(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=ZIP_EPOCH)
    info.compress_type = zipfile.ZIP_DEFLATED
    # 0644, and the file mode of a zip member is where zipimport does not care
    # but a person unpacking the archive by hand does.
    info.external_attr = 0o644 << 16
    archive.writestr(info, data)
