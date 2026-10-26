"""What a project is CALLED, in latin — the one rule, on both sides of the wire.

`hammerola create` works the slug out on the author's machine and writes it
into project.json (`hammerola/project.py`); the build reads it back inside the
hub (`src/cadbuild/project.py`). Both import this one module;
`src/cadbuild/project_title.py` re-exports everything except
`slug_from_directory`.

The slug has to travel because the directory exists only on the author's
machine: on the hub a pushed commit's tree is checked out into
`.src-<uuid4 hex>` (`store.SOURCE_PREFIX`) and the build runs there
(`buildproc/child.py`).

STDLIB ONLY: the client installs nothing. Enforced by
`tests/test_projectslug.py` and `tests/client/test_stdlib_only.py`; the
zipapp's own import check (`onboarding._refuse_unimportable`) only looks at
`hammerola.*` imports and would not catch a third-party one.
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

    ONLY THE CLIENT MAY ASK THIS: inside the hub the answer would be the unpack
    directory's `.src-<uuid>`, which is why the build half does not re-export
    it (see `src/cadbuild/project_title.py`).

    Empty when the name is not a slug (`Корпус/`, `my model/`);
    `create_project` then leaves the key out and the hub uses the project id.
    """
    return str(name or "").strip() if is_slug(name) else ""
