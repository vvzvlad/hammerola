"""What the hub will accept, as the client knows it.

A COPY: this file must import on a bare python3 (see `hammerola/__init__.py`)
and `src.store` pulls in the service. Every constant is compared against the
module that enforces it in `tests/client/test_limits.py`, so the two cannot
drift silently.

The ceilings are enforced before anything is sent, naming the offending file.
The hub remains the authority: it re-checks every one and is the only side
that knows a deployment's real MAX_BUILD_BYTES.
"""

import re

# `<pid>` from project.json and the revision the hub mints from the sources
# (SPEC 7.7); both become path segments. Authority: `src.store.SAFE_ID`.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# One `/`-separated component of a member path. Authority:
# `src.store.SAFE_COMPONENT`. It forbids a leading dot, which is why `pack.py`
# drops hidden entries (`.git`, `.venv`, `.env`) rather than refusing them.
SAFE_COMPONENT = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")

# Components in one member's path, the file name included. Authority:
# `src.store.MAX_PATH_DEPTH`.
MAX_PATH_DEPTH = 8

# Files in one archive. Authority: `src.store.MAX_MEMBERS`.
MAX_MEMBERS = 1024

# Reserved build names: `latest` is a symlink the store moves, `dev` is the
# local slot. Authority: `src.store.RESERVED_BUILD_NAMES`. Revisions are 64 hex
# characters minted by the hub, so they cannot collide; the names are used for
# addressing.
DEV_SLOT = "dev"
RESERVED_BUILD_NAMES = frozenset({"latest", DEV_SLOT})

# What ONE piece of text the hub SHOWS may be, in characters. Authority:
# `src.render.MAX_TEXT`, which `_plain_text` measures every field of a meta.json
# against -- the title and the project name among them.
#
# `hammerola create` holds `project` and `title` to it, since both can come
# from the directory name (up to 255 characters); past it the build raises
# inside the job (`cadbuild.project.load_project`, MAX_TITLE_CHARS). A too-long
# slug is simply left out (the project id stands behind it); a too-long title
# stops the command and asks for `--title` rather than truncating.
MAX_TEXT_CHARS = 200

# Ceiling on the request body and on the unpacked total. Authority: the
# DEFAULT of `src.settings.Settings.max_build_bytes`; a deployment may set
# another, so this is a courtesy check and the hub's 413 is what counts.
MAX_BUILD_BYTES = 64 * 1024 * 1024
