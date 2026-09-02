"""What a project is CALLED, in latin — the one rule, on both sides of the wire.

TWO READERS, AND THEY RUN ON DIFFERENT MACHINES. `hammerola create` works the
slug out on the AUTHOR's laptop, out of the directory the project lives in, and
writes it into project.json (`src/client/project.py`); the build reads that key
back inside the hub and publishes under it (`src/cadbuild/project.py`). The
client is stdlib-only and may not import the build half at all
(`src/client/__init__.py`), so the choice was between a second copy of these two
regexes and a module both sides import. It is the module, and
`src/cadbuild/project_title.py` re-exports what the build half is allowed to ask
— everything below except `slug_from_directory`, which is not a question that
package may ask at all (its own docstring says why, and a test holds it out).
`src/metricsdiff.py` is the worked
example of the same move; `cad_publish/hubspec.py` is what the copy costs —
somebody else's rule, in a place that could not see the original, with nothing
comparing the two, and publication broke when they drifted.

WHY THE SLUG HAS TO TRAVEL rather than being worked out where it is used. It is
a fact about the author's machine — the name of the directory, and of the
repository — and inside the hub that directory does not exist. A push is
unpacked into `.src-<uuid4 hex>` (`store.SOURCE_PREFIX`), a name that is the
hub's own bookkeeping and is different on every push, and the build process is
chdir'd into it (`buildproc/child.py`). A build that answered this question from
its own directory published a project called
`.src-89fb7abdeb1d48b5985bcb519850b284` onto the front page — a name that
belonged to nobody and changed on the next push. That is the failure this module
ends, and it is why `slug_from_directory` below carries a warning about who may
call it.

STDLIB ONLY, and that is a rule rather than a coincidence: the client imports
this and installs nothing, so one dependency here breaks `hammerola create` on
every laptop that is not a checkout of this repository. TWO TESTS ARE WHAT
ENFORCE IT (`tests/test_projectslug.py` and, through
`onboarding.client_members()`, `tests/client/test_stdlib_only.py`), because the
zipapp's own refusal cannot: `onboarding._refuse_unimportable` walks only
imports of `src`, so a `numpy` added here enters no closure, refuses nothing and
is served with a 200 — and the laptop that downloaded it is what breaks.
"""

import re

# Latin, and separated rather than run together: `slip-pump`, `t13-ceiling-mount`,
# `wb_mge.v2`. Case is allowed through because a directory name is the authority
# on how a project is spelled, and this rule has to accept the ones that exist.
SLUG_RE = re.compile(r"\A[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\Z")
# The trailing `(...)`, and only a trailing one: `Корпус (v2) для T13 (t13-case)`
# has to resolve to `t13-case`, not to `v2`.
BRACKET_RE = re.compile(r"\(([^()]*)\)\s*\Z")


def is_slug(value):
    """True when `value` has the shape of a directory and repository name."""
    return bool(SLUG_RE.match(str(value or "").strip()))


def slug_from_title(title):
    """The latin slug a title ends with, or "" when it carries none.

    The same two regexes `project_title.title_problem` uses, deliberately: this
    value is what a build publishes under when project.json names nothing else,
    and it must not be able to drift from the one the form check accepts.
    """
    match = BRACKET_RE.search(str(title or "").strip())
    if not match:
        return ""
    found = match.group(1).strip()
    return found if SLUG_RE.match(found) else ""


def slug_from_directory(name):
    """The slug a directory's own name already is, or "" when it cannot be one.

    ONLY THE CLIENT MAY ASK THIS, and the restriction is the point rather than a
    convention. A directory name is evidence about a project on exactly one
    machine — the author's, where they chose it and where the repository carries
    it. Inside the hub the same question has an answer and the answer is the
    unpack directory's `.src-<uuid>`, which is why the build half deliberately
    does not re-export this name (see `src/cadbuild/project_title.py`).

    Empty rather than a guess when the name is not a slug: `Корпус/`,
    `my model/` and `.src-89fb…/` are all directories somebody can legitimately
    have, and none of them is a name a project can be published under. The
    caller decides what to do with nothing — `create_project` leaves the key
    out, so the hub answers with the project id instead of a lie.
    """
    return str(name or "").strip() if is_slug(name) else ""
