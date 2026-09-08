#!/usr/bin/env python3
"""project.json, and the commit a snapshot is published under."""

import json
import os
import subprocess

from . import project_title
from .errors import BuildError
from .paths import PROJECT_FILE, project_root
from .hubspec import MEMBER_RE, TEST_ID, hub_text_problem


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

    # NEITHER OF THESE MAY FALL BACK TO `root.name`, and the line that did is
    # named here so it is not put back. This package runs in exactly one place
    # -- the hub's build process, chdir'd into the directory a push was unpacked
    # into (`buildproc/child.py`, `store.SOURCE_PREFIX`) -- so `root.name` is
    # `.src-<uuid4 hex>`: the hub's own bookkeeping, different on every push,
    # never evidence about the author's project. It published a card reading
    # `.src-89fb7abdeb1d48b5985bcb519850b284` on the front page.
    #
    # WHAT REPLACES IT IS THE HUB'S OWN CHAIN, transcribed. `render.build_meta`
    # resolves the same two fields out of a meta.json that leaves them empty:
    #
    #     project = raw["project"] or pid
    #     title   = raw["title"]   or project
    #
    # so the title falls back to the PROJECT and not to the id. Reaching for
    # `pid` here instead was one side silently correcting the other -- exactly
    # the drift this comment claims to prevent: `{"id": "2486c8fd2b05",
    # "project": "slip-pump"}` with no title published `2486c8fd2b05` where the
    # hub's rule gives `slip-pump`.
    #
    # THE ORDER OF THE TWO STATEMENTS IS THE PART THAT NEEDS CARE, because the
    # chain is circular if either is read off the other's resolved value: the
    # title falls back to the project, and the project falls back to the slug in
    # the title's brackets. It is broken on the RAW title -- a title that is
    # absent has no brackets to read, and `slug_from_title("")` is `""`, so
    # nothing is lost by asking before the fallback rather than after it.
    #
    # WHAT SHOULD NAME THE PROJECT is the `project` key, which is why it is
    # first: the slug is a fact about the AUTHOR's directory, so it is worked out
    # where that directory exists and travels in project.json (`hammerola
    # create`, `hammerola/projectslug.py`). The title's own brackets are the second
    # chance -- the same string, in a field written by hand -- and `pid` is what
    # is left when a project.json names it nowhere. It is the honest last
    # resort: already validated (MEMBER_RE, above) and always non-empty. `build`
    # warns on the log when it comes to that (`project_title`).
    raw_title = str(data.get("title") or "").strip()
    project = (str(data.get("project") or "").strip()
               or project_title.slug_from_title(raw_title)
               or pid)
    title = raw_title or project
    # Both go through the hub's own text rule, transcribed once in views.py.
    # This used to be a check of its own -- a ceiling plus `ord(ch) < 32 or
    # ord(ch) == 127` -- and that spelling covered only PART of Unicode category
    # Cc (the C0 controls and DEL, not the C1 block U+0080-U+009F), so U+202E
    # RIGHT-TO-LEFT OVERRIDE (Cf) went through here and
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
