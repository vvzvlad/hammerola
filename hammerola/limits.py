"""What the hub will accept, as the client knows it, and what the client reads.

The hub's rules are COPIES: this file must import on a bare python3 (see
`hammerola/__init__.py`) and `src.store` pulls in the service. Each one is
compared against the module that enforces it in `tests/client/test_limits.py`,
so the two cannot drift silently.

The member rules — `SAFE_COMPONENT`, `MAX_PATH_DEPTH`, `MAX_MEMBERS` — are this
client's own: they hold the archives it reads back from the hub (`unpack.py`),
and the hub holds the archives it serves to them by importing them
(`src/onboarding.py`, `_refuse_unservable`).
"""

import re

# `<pid>` from project.json and a revision's name (SPEC 7.7); both become path
# segments. Authority: `src.store.SAFE_ID`.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# One `/`-separated component of a member path. It forbids a leading dot;
# `unpack.py` holds the archives this client reads to it.
SAFE_COMPONENT = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")

# Components in one member's path, the file name included.
MAX_PATH_DEPTH = 8

# Files in one archive.
MAX_MEMBERS = 1024

# Reserved build names: `latest` is a symlink the store moves, `dev` is the
# local slot. Authority: `src.store.RESERVED_BUILD_NAMES`. Revisions are commit
# shas, 40 hex characters, so they cannot collide; the names are used for
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
