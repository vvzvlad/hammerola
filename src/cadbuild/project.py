#!/usr/bin/env python3
"""project.json, and the commit a snapshot is published under."""

import json
import os
import subprocess

from . import project_title
from .errors import BuildError
from .paths import PROJECT_FILE, project_root
from .hubspec import MEMBER_RE, TEST_ID
from .views import hub_text_problem


# The ceiling on both names this file produces, and it is the HUB's: `title`
# and `project` travel in meta.json and are measured there against
# `render.MAX_TEXT` (`_plain_text`), so a longer one is a 422 answering a build
# that already ran. tests/cadbuild/test_views.py holds this number against the
# hub's along with the other three.
MAX_TITLE_CHARS = 200


# --------------------------------------------------------------------------
# Project metadata
# --------------------------------------------------------------------------

def load_project():
    root = project_root()
    path = root / PROJECT_FILE
    if not path.exists():
        raise BuildError("project.json not found")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BuildError(f"project.json is not valid JSON: {exc}") from exc

    pid = str(data.get("id") or "").strip()
    if not pid:
        raise BuildError(
            "project.json has no id. Run `make init` once to generate it, "
            "then commit project.json."
        )
    if not MEMBER_RE.match(pid):
        raise BuildError(f"project id {pid!r} is not a safe path component")

    title = str(data.get("title") or "").strip() or root.name
    # The slug out of the title BEFORE the directory name, and that order is
    # the whole point. This value is what gets written into metrics.json as the
    # name of the project, and metrics.json is written where the geometry is
    # computed -- inside the builder image, where the sources live in /src and
    # root.name is `src` for every project in the fleet. The title travels in
    # project.json, so the slug in its brackets is the same string on both
    # sides of the container, and it is the only thing here that identifies
    # which project a published snapshot belongs to.
    project = (str(data.get("project") or "").strip()
               or project_title.slug_from_title(title)
               or root.name)
    # Both go through the hub's own text rule, transcribed once in views.py.
    # This used to be a check of its own -- a ceiling plus `ord(ch) < 32 or
    # ord(ch) == 127` -- and that spelling covered Unicode category Cc and
    # nothing else, so U+202E RIGHT-TO-LEFT OVERRIDE (Cf) went through here and
    # was refused by the hub after the geometry had been computed. Not a
    # cosmetic difference either: that character reverses the text AROUND the
    # field it sits in, i.e. the rest of the card. Angle brackets are allowed
    # through, exactly as the hub allows them here -- see hub_text_problem.
    for field, value in (("title", title), ("project", project)):
        problem = hub_text_problem(value, MAX_TITLE_CHARS,
                                   angle_brackets_ok=True)
        if problem:
            raise BuildError(
                f"{field} {problem}: {value!r}. It is shown on the index card "
                "and in the build page header, and the hub checks it again on "
                f"the way in -- edit \"{field}\" in {PROJECT_FILE} to plain, "
                "printable text.")
    return pid, project, title


def refuse_test_id():
    """Stop before a run that would publish under the `make init-test` id.

    That id is written by a flag whose entire purpose is to let somebody run
    the pipeline without a project -- on the template itself, on a throwaway
    checkout, on a worktree opened to change `checklib.py`. The convenience is
    real and so is the hazard it creates: the very next command in that session
    is `make build`, which publishes, and on a machine where the hub and the
    token do resolve it would put a project literally called
    "local-test-do-not-publish" on the hub, or push a throwaway build over
    whatever else answers to that name.

    So the id is inert rather than merely odd-looking: nothing can be published
    under it, and the message says which flag to use instead.
    """
    pid, _project, _title = load_project()
    if pid != TEST_ID:
        return
    raise BuildError(
        f"project.json carries the test id {pid!r}, which `make init-test` "
        "writes so the pipeline can be run on a checkout that is not a "
        "project. Nothing is published under it.\n"
        "  to run the whole build and gate locally:  make build LOCAL=1 NOPUBLISH=1\n"
        "  to make this a real project:              clear \"id\" in "
        "project.json, then `make init TITLE=\"...\"`"
    )


def resolve_commit(explicit):
    """Commit sha for the URL: CLI flag, then CI env, then local git."""
    for candidate in (explicit, os.environ.get("COMMIT_SHA"),
                      os.environ.get("GITHUB_SHA")):
        value = str(candidate or "").strip()
        if value:
            if not MEMBER_RE.match(value):
                raise BuildError(f"commit {value!r} is not a safe path component")
            return value
    try:
        out = subprocess.run(
            ["git", "-C", str(project_root()), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise BuildError(
            "cannot determine the commit: pass --commit, or set COMMIT_SHA"
        ) from exc
    return out.stdout.strip()
