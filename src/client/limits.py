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

# `<pid>` from project.json and the revision the HUB mints out of the sources it
# received (SPEC 7.7) — both end up as a path segment of the publish URL. git is
# not in either of them: the client stopped reading HEAD when the hub started
# naming revisions, so the only id this tool spells itself is the project's.
# Authority: `src.store.SAFE_ID`.
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
# `src.store.RESERVED_BUILD_NAMES`. Nothing this tool publishes can collide with
# either, and that is now true by construction rather than by luck: the client
# names no revision at all — the hub mints one out of the sources, 64 hex
# characters wide (SPEC 7.7). What the two names are still needed FOR is
# ADDRESSING, because a command that fetches takes a revision or one of these,
# and `dev` is the one the client spells itself.
DEV_SLOT = "dev"
RESERVED_BUILD_NAMES = frozenset({"latest", DEV_SLOT})

# Ceiling on the request body AND on the unpacked total. Authority: the DEFAULT
# of `src.settings.Settings.max_build_bytes`, and "default" is the whole
# caveat — a deployment may set MAX_BUILD_BYTES to anything, and the client
# cannot know which. So this is a courtesy check that catches the archive nobody
# would accept, not a promise: the hub answers 413 with its own number, and that
# answer is the one that counts.
MAX_BUILD_BYTES = 64 * 1024 * 1024

# What ONE FILE A BUILD PRODUCED may weigh. Authority:
# `src.buildproc.limits.Limits.file_bytes`, the RLIMIT_FSIZE a build runs under.
#
# IT IS FOUR TIMES THE PUSH CEILING, and that is not slack — it is the shape of
# the work. A push is source code; what comes back is meshes. The number is the
# argument, and it is the number a test compares directly; the comment beside it
# on the hub's side is NOT support for "such files are ordinary" and must not be
# cited that way — it says "an exported part an order of magnitude larger than
# the entire input is already pathological", i.e. 256 MiB was chosen to be
# unreachable. What follows from it is narrower and enough: a part that big is
# one the hub WILL serve, so holding `hammerola artifacts` to the push's number
# would refuse to fetch a file the hub is serving — a refusal with nothing wrong
# behind it.
#
# Kept apart from MAX_BUILD_BYTES rather than folded into one "big enough"
# number, because the two answer different questions: what may be SENT, and what
# a build may have MADE. Merging them would move both the day either is retuned.
MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
