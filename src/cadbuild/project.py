#!/usr/bin/env python3
"""project.json: finding it, reading it, and what it may say.

The revision a build is published under is NOT decided here -- the hub mints it
from the digest of the sources (SPEC 7.7), so nothing in the build half resolves
a commit.
"""

import json

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
            "project.json has no id. `hammerola create` mints one, and it "
            "refuses to write over a project.json that already exists -- so "
            "delete this one first, then commit what it writes."
        )
    if not MEMBER_RE.match(pid):
        raise BuildError(f"project id {pid!r} is not a safe path component")

    # Neither may fall back to `root.name`: the build runs in the hub's unpack
    # directory (`buildproc/child.py`, `store.SOURCE_PREFIX`), so that name is
    # `.src-<uuid4 hex>`, not the author's project.
    #
    # This mirrors the hub's own chain in `render.build_meta`:
    #
    #     project = raw["project"] or pid
    #     title   = raw["title"]   or project
    #
    # The project falls back to the slug in the RAW title's brackets (breaking
    # the circularity; `slug_from_title("")` is `""`), then to `pid`, which is
    # validated and non-empty. The `project` key comes first because the slug is
    # worked out in the author's directory (`hammerola/projectslug.py`). `build`
    # warns when it falls back to `pid` (`project_title`).
    raw_title = str(data.get("title") or "").strip()
    project = (str(data.get("project") or "").strip()
               or project_title.slug_from_title(raw_title)
               or pid)
    title = raw_title or project
    # Both go through the hub's own text rule (hub_text_problem), so e.g.
    # U+202E is refused here rather than by the hub after the build. Angle
    # brackets are allowed, as the hub allows them for these fields.
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
    """Stop before a run that would publish under the test id.

    Nothing writes this id; it reaches here from a hand-written or old
    project.json. It is a legal path component, so a push under it would put a
    project literally called "local-test-do-not-publish" on the hub.

    The message may name no local build, because there is none: checking a
    model IS publishing it, into a slot the next push overwrites.
    """
    pid, _project, _title = load_project()
    if pid != TEST_ID:
        return
    raise BuildError(
        f"project.json carries the test id {pid!r}, which marks a checkout "
        "that is not a project. Nothing is published under it.\n"
        "  there is no local build to run instead: `hammerola build` fills "
        "the project's dev slot, which the next push overwrites and which "
        "leaves the published revisions alone\n"
        "  to make this a real project: delete project.json, then "
        "`hammerola create --no-template --title \"...\"`"
    )
