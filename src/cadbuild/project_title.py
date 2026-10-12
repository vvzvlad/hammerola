#!/usr/bin/env python3
"""The shape of a project title, and the single place that decides it.

A title is words saying WHAT the thing is and WHAT FOR, then the latin slug of
the folder and of the repository in brackets:

    Ford viscosity cup No.4, dip cup with a replaceable orifice (ford-cup-4)
    Насос для шликера (slip-pump)

Either language; the rule is about the form.

The descriptive half is what a human reads on the hub's index; the slug ties
that line to a directory and a repository.

The slug must equal the name the project publishes under. For a project.json
written by `hammerola create`, that is the author's directory name when
`_project_slug` in hammerola/project.py accepts it (`is_slug` and the display
ceiling), otherwise the slug in these brackets. Projects are made by copying an
existing one, so a mismatched slug is almost always the previous project's
title left in project.json.

One caller, `cadbuild.build`, prints `title_problem` as a warning, never an
error: a ready part must not fail to publish over its name, and an agent would
"fix" a red title check by rewriting the title.

The slug rule lives in `hammerola/projectslug.py` (the stdlib-only client
derives the slug too) and is re-exported here. The import is absolute for the
same reason as in `metrics.py`.
"""

# `slug_from_directory` is deliberately not imported: the build runs in the
# hub's unpack directory (`.src-<uuid>`), so its own directory name is never
# the project's.
from hammerola.projectslug import (
    BRACKET_RE,
    SLUG_RE,
    is_slug,
    slug_from_title,
)

# Explicit so a linter does not delete `slug_from_title`, which is unused here
# and re-exported for `cadbuild/project.py`.
__all__ = ["BRACKET_RE", "SLUG_RE", "is_slug", "slug_from_title",
           "title_problem"]


def title_problem(title, project, pid):
    """What is wrong with `title` for a project published as `project`.

    Returns one sentence, or None when the title is in the right form.

    `project` is the slug the build publishes under, as resolved by
    `load_project` from project.json (not the build's own directory name).

    `pid` is the project id, which can be the published name when nothing else
    names the project (twelve hex characters match SLUG_RE); see the clause
    below.
    """
    # The published name first: when it is not a slug, no title can satisfy the
    # rule, and the messages below would blame the title. Both the `project` key
    # and `pid` can land here (MEMBER_RE admits ids like `trailing-` that are
    # not slugs), so the message names both sources.
    if not is_slug(project):
        return (
            f"the project publishes as {str(project or '')!r}, which is not a "
            "latin slug, so neither it nor the title can carry one. That name "
            "is the \"project\" key of project.json -- the latin name of the "
            "directory and of the repository -- or, when the file names none, "
            "the project id standing in for it"
        )

    # The name is the id. Checked before the title, because the messages below
    # would tell the author to put the id in the brackets, silencing the warning
    # and cementing publication under the id. Both the brackets and the
    # `project` key accept a real name; only the id is wrong in either. (With a
    # hand-written `project` key holding the id, `rename` alone does not help;
    # "the id in either place" covers that.)
    if project == pid:
        return (
            f"this build publishes as {pid!r}, its own project id. An id is not "
            "a name: `hammerola rename \"<what and what for> (<slug>)\"` puts a "
            "latin one in the title's brackets, which is where the build takes "
            "the published name from when project.json has no \"project\" key. "
            "Setting that key is the other way round, and then the title's "
            "brackets have to carry the same slug. The id in either place only "
            "leaves publication under the id"
        )

    title = (title or "").strip()
    if not title:
        return "the project has no title"

    match = BRACKET_RE.search(title)
    if not match:
        # A bare slug (`hammerola create` without `--title` writes the name
        # into both fields) gets its own sentence; the general one would say
        # nothing ties the slug to itself.
        if title == project:
            return (
                f"the title is the bare slug {project!r}: it names the folder "
                "again and says nothing about what the thing is or what it is "
                f"for. `hammerola rename \"<what and what for> ({project})\"`"
            )
        # With no slug in the title and no `project` key, the published name
        # is whatever the build fell back to, so the message names it.
        return (
            f"the title {title!r} does not end with the project's slug in "
            f"brackets, so nothing in it ties the title to {project!r} -- the "
            f"name this build publishes under"
        )

    found = match.group(1).strip()
    described = title[:match.start()].strip()

    if not SLUG_RE.match(found):
        return (
            f"the title {title!r} ends with {found!r} in brackets, which is "
            "not a slug: that place carries the latin name of the directory "
            "and the repository, not a comment"
        )
    if found != project:
        # The reason this rule exists. Say both names, in that order: the one
        # in the title is the one that is probably wrong.
        return (
            f"the title says {found!r} but this build publishes as {project!r}. "
            "A slug from another project is what a title copied along with the "
            "rest of a project looks like -- check that the whole title is "
            "about THIS part and not about the one it was copied from"
        )
    # Any language is fine; only a title that is nothing but its slug is
    # refused.
    if not described:
        return (
            f"the title {title!r} is the slug and nothing else: the slug names "
            "the folder, and the words in front of it are what says what the "
            "thing is and what it is for"
        )
    return None
