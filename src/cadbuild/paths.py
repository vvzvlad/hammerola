#!/usr/bin/env python3
"""Where the project being built lives, and how it is found.

The package lives apart from the project, so the project has to be found, the
same way from every entry point (including the hub's staging directory).

The rule: an explicitly set root wins; otherwise the nearest directory at or
above the working directory that holds a project.json. project.json is the
right marker and not, say, .git -- it is the file that carries the permanent
project id, every published URL contains that id, and a build that guessed the
wrong directory would publish under the wrong one. A worktree, a subdirectory
and a checkout with no git at all all land on the same answer.

Nothing here caches across a change: set_project_root() replaces the answer.
"""

from pathlib import Path

from .errors import BuildError

# The file that says "this directory is a model project" (hub SPEC 3.1).
PROJECT_FILE = "project.json"

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
