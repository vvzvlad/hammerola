"""What the hub hands somebody who has just found it: the skill, the tool, the
template — and whether there is anything here yet.

THE PROBLEM THIS SOLVES. Everything else on this service assumes you already
have `hammerola` on your PATH, a model directory to run it in and the secret to
present. A person who has just deployed a hub, or an agent sitting in an empty
model repository, has none of the three, and until now nothing on the service
said where to get them: the front page asks for a token, and the token is not
what is missing. So the hub serves the three things a first run needs, and one
document that names them.

    GET /start                    the manifest: the three paths, and `empty`
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

NOTHING READS `empty` YET, and it is worth knowing that before reading the
paragraph above as a description of a working page. Of the four fields, ONE has
a reader today: `hammerola create` follows `template`. The browser UI was not
touched on the branch that added this route — deliberately, because the page is
a separate piece of work — so the front page of a hub nobody has pushed to still
shows a login form and nothing else. What the boolean is FOR is the block that
page will grow; until then this module is the whole of the feature, and the
argument for making a fact about the deployment public is a debt that has not
yet bought anything. Whoever builds that block is who collects on it.

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
what this module names: a page rendering them will learn the hub's address from
the address it was loaded from, and this repository never carries the address of
a deployment (AGENTS.md).
"""

import gzip
import io
import tarfile
import zipfile
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- the routes, named once ------------------------------------------------
# The manifest carries them so that nothing else has to spell them: `hammerola
# create` asks the manifest where the template is rather than carrying a second
# copy of this string, and a front-page block, when there is one, will render
# its links out of what it fetched rather than out of a third copy. Only the
# first of those two readers exists today.
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
    """The document a first run is made of, and a front-page block would be.

    Four keys and no more, checked by a test: three relative paths that are
    constants of the image, and the ONE boolean about this deployment. Adding a
    field here is adding a statement the hub makes without authentication — read
    the module docstring before doing it.

    ONE OF THE FOUR HAS A READER TODAY. `hammerola create` follows `template`;
    `skill`, `client` and `empty` are fetched by nobody, because the page that
    would offer them has not been written (see the module docstring). That is
    the state of it, not a fact to be inferred from the shape of this function.
    """
    return {
        "empty": bool(empty),
        "skill": SKILL_URL,
        "client": CLIENT_URL,
        TEMPLATE_KEY: TEMPLATE_URL,
    }


@lru_cache(maxsize=1)
def skill_bytes() -> bytes:
    """The agent instructions, straight off the image.

    Cached like the page templates are and for the same reason: the file is
    immutable inside the image, so re-reading it per request would buy nothing.
    """
    return SKILL_FILE.read_bytes()


@lru_cache(maxsize=1)
def client_bytes() -> bytes:
    """`hammerola` as one executable file: shebang, then a zip of the modules."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        _add_zip_entry(archive, "__main__.py", CLIENT_MAIN.encode("utf-8"))
        for name, path in client_members():
            _add_zip_entry(archive, name, path.read_bytes())
    return CLIENT_SHEBANG + buffer.getvalue()


def client_members() -> list:
    """(archive name, path on disk) for every module the tool is made of.

    `src/client/*.py` is globbed rather than listed: a module added to the
    package is part of the tool by definition, and a list would be one more
    place to forget. What CANNOT be globbed is the second group — the modules
    outside the package that the client imports — so those are named above and
    checked by a test.
    """
    members = [(name, ROOT / name) for name in CLIENT_EXTRA_MODULES]
    members += [(f"src/client/{path.name}", path)
                for path in sorted((ROOT / "src" / "client").glob("*.py"))]
    return sorted(members)


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
