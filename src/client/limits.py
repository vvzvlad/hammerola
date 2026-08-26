"""What the hub will accept, as the client knows it.

A COPY of six numbers and two patterns — and the copy is deliberate, because
this file has to import on a laptop's bare python3 (see `src/client/__init__.py`
for why the client takes nothing from requirements.txt) and `src.store` pulls in
loguru and half the service.

WHAT MAKES IT A DIFFERENT KIND OF COPY FROM THE ONE THAT BROKE PUBLICATION.
`cad_publish/hubspec.py` held these same values with nothing checking them, in a
repository that could not see the hub's. This one is checked: every constant
below is compared against the module that actually enforces it in
`tests/client/test_limits.py`, which runs in the same suite as the hub's own
tests and in the same CI job. Edit one side without the other and the suite
fails at that commit — which is exactly what nothing could do before.

The ceilings are enforced BEFORE anything is sent, so a tree that cannot
possibly be accepted is refused on the machine that can still do something about
it, with the offending file named. The hub remains the authority: it re-checks
every one of these and it is the only side that knows a deployment's real
MAX_BUILD_BYTES.
"""

import re

# `<pid>` from project.json and `<commit>` from git, both of which end up as a
# path segment of the publish URL. Authority: `src.store.SAFE_ID`.
SAFE_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")

# ONE `/`-separated component of a file's path inside the archive. Authority:
# `src.store.SAFE_COMPONENT`. Note what it forbids that a source tree is full
# of: a leading dot. `.git`, `.venv`, `.gitignore` and `.env` can never be
# members, which is why `pack.py` drops hidden entries rather than refusing on
# them.
SAFE_COMPONENT = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")

# Components in one member's path, the file name included. Authority:
# `src.store.MAX_PATH_DEPTH`.
MAX_PATH_DEPTH = 8

# Files in one archive. Authority: `src.store.MAX_MEMBERS`.
MAX_MEMBERS = 1024

# The publish route reserves these as build names: `latest` is a symlink the
# store moves and `dev` is the local slot itself. Authority:
# `src.store.RESERVED_BUILD_NAMES`. A git sha can never collide with either, but
# a hand-passed revision id could, and the refusal is worth more here than the
# hub's 422 minutes later.
DEV_SLOT = "dev"
RESERVED_BUILD_NAMES = frozenset({"latest", DEV_SLOT})

# Ceiling on the request body AND on the unpacked total. Authority: the DEFAULT
# of `src.settings.Settings.max_build_bytes`, and "default" is the whole
# caveat — a deployment may set MAX_BUILD_BYTES to anything, and the client
# cannot know which. So this is a courtesy check that catches the archive nobody
# would accept, not a promise: the hub answers 413 with its own number, and that
# answer is the one that counts.
MAX_BUILD_BYTES = 64 * 1024 * 1024
