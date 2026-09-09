#!/usr/bin/env python3
"""Where the project being built lives, and the two paths derived from it.

This code used to be a script inside the project, so `__file__` was the answer:
`Path(__file__).resolve().parent.parent` was the checkout, always. It stopped
being one when it became a package that lives nowhere near the project, so the
project has to be FOUND instead -- and it has to be found the same way from
every direction the build is entered from, which now includes the hub
unpacking somebody's source tree into a staging directory of its own.

The rule: an explicitly set root wins; otherwise the nearest directory at or
above the working directory that holds a project.json. project.json is the
right marker and not, say, .git -- it is the file that carries the permanent
project id, every published URL contains that id, and a build that guessed the
wrong directory would publish under the wrong one. A worktree, a subdirectory
and a checkout with no git at all all land on the same answer.

Nothing here caches across a change: set_project_root() replaces the answer,
which is what the tests use and what --root would use if it ever grows one.
"""

from pathlib import Path

from .errors import BuildError

# The file that says "this directory is a model project" (hub SPEC 3.1).
PROJECT_FILE = "project.json"

# Names of the two paths a LOCAL build writes, relative to the project root. A
# model repository that has not moved over still has a `make build` writing
# them and a `make clean` removing them; nothing in this repository does either,
# and the client deliberately does not exclude them from a push -- it refuses a
# push that carries them, so the author is told rather than quietly packed
# without the output they are looking at (`hammerola/pack.py`, pinned by
# `tests/client/test_pack.py`).
OUT_DIR_NAME = "_out"
ARCHIVE_NAME = "_out.tar.gz"

_root = None


def set_project_root(path):
    """Pin the project root. `None` puts the search back."""
    global _root
    _root = None if path is None else Path(path).resolve()
    return _root


def find_project_root(start=None):
    """The nearest directory at or above `start` holding a project.json.

    Returns None rather than raising: the caller decides whether a missing
    project.json is an error (a build) or a fact to report (`doctor`).
    """
    here = Path(start).resolve() if start is not None else Path.cwd().resolve()
    for candidate in (here, *here.parents):
        if (candidate / PROJECT_FILE).is_file():
            return candidate
    return None


def project_root():
    """The project this run is about, or a BuildError naming what is missing."""
    if _root is not None:
        return _root
    found = find_project_root()
    if found is None:
        raise BuildError(
            f"no {PROJECT_FILE} here or in any directory above "
            f"{Path.cwd()}. Run this from a model project -- the one whose "
            f"{PROJECT_FILE} carries the id every published URL contains."
        )
    return found


def out_dir():
    """`_out/` -- everything a build produces, and the only thing shipped."""
    return project_root() / OUT_DIR_NAME


def archive_path():
    """`_out.tar.gz` -- the flat archive a snapshot is POSTed as."""
    return project_root() / ARCHIVE_NAME
