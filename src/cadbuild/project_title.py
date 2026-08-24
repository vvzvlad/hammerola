#!/usr/bin/env python3
"""The shape of a project title, and the single place that decides it.

A title is Russian words saying WHAT the thing is and WHAT FOR, then the latin
slug of the folder and of the repository in brackets:

    Насос для шликера (slip-pump)
    Потолочный корпус для T13-750W и WB-MGE (t13-ceiling-mount)

The Russian half is what a human reads on the hub's index next to twenty other
projects; the slug is what ties that line to a directory and a repository.

The slug half is the one with teeth, and it is not decoration: it must equal
the NAME OF THE PROJECT DIRECTORY. Projects are made by copying an existing
one, and the title is the field the copy forgets to change -- so a slug that
does not match the folder is, almost always, the previous project's title still
sitting in project.json. Nothing about a page reading "Насос для шликера" over
a ceiling bracket says which of the two is the mistake, and the title travels
into every published snapshot.

Two callers, deliberately different in severity:

    cad-publish init          refuses a title that breaks the rule. It is the
                              one moment the title is being written, it costs
                              nothing to get right, and the id generated next
                              to it is permanent.
    cad-publish build         warns and goes on. A part that is modelled,
                              gated and ready to print must not fail to publish
                              over the wording of its name. Nothing here is
                              ever an error there, and that is on purpose: an
                              agent that hits an error edits until it goes
                              away, so a title check that could go red would
                              be "fixed" by rewriting the title -- leaving a
                              wrong `id` in place behind a green build. What
                              guards the id is metrics.py's own comparison
                              against the slug recorded on the hub, and that
                              one reads the slug through slug_from_title
                              below rather than off the directory: inside the
                              builder image the sources live in /src and the
                              directory name means nothing.
"""

import re

# Latin, and separated rather than run together: `slip-pump`, `t13-ceiling-mount`,
# `wb_mge.v2`. Case is allowed through because the rule below compares the slug
# with a real directory name and that is the authority on how it is spelled.
SLUG_RE = re.compile(r"\A[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*\Z")
# Cyrillic anywhere in the descriptive half. Not "is it Russian" -- that is not
# decidable here -- just that somebody wrote words for a human and not only the
# slug over again.
CYRILLIC_RE = re.compile(r"[А-Яа-яЁё]")
# The trailing `(...)`, and only a trailing one: `Корпус (v2) для T13 (t13-case)`
# has to resolve to `t13-case`, not to `v2`.
BRACKET_RE = re.compile(r"\(([^()]*)\)\s*\Z")

EXAMPLES = (
    "Насос для шликера (slip-pump)",
    "Потолочный корпус для T13-750W и WB-MGE (t13-ceiling-mount)",
)


def is_slug(value):
    """True when `value` has the shape of a directory and repository name."""
    return bool(SLUG_RE.match(str(value or "").strip()))


def slug_from_title(title):
    """The latin slug a title ends with, or "" when it carries none.

    The same two regexes title_problem uses, deliberately: this value is
    written into the published metrics.json as the name of the project, and
    it must not be able to drift from the one the form check accepts.
    """
    match = BRACKET_RE.search(str(title or "").strip())
    if not match:
        return ""
    found = match.group(1).strip()
    return found if SLUG_RE.match(found) else ""


def form_hint(slug):
    """The rule and two examples, ready to print under an error or a warning."""
    examples = "\n".join(f"    {example}" for example in EXAMPLES)
    if not is_slug(slug):
        # There is no correct title to show for a directory that is not a slug,
        # and printing `<...> (Корпус)` here would contradict the message this
        # hint sits under -- that one is asking for the directory to be
        # renamed, not for the bad name to be copied into the title.
        return (
            "The form is: what it is and what it is for, in Russian, then the\n"
            "  directory's own slug in brackets:\n\n"
            f"{examples}"
        )
    return (
        "The form is: what it is and what it is for, in Russian, then the\n"
        f"  directory's own slug in brackets -- for this project ({slug}):\n\n"
        f"{examples}\n\n"
        f"    <по-русски, что и для чего> ({slug})"
    )


def title_problem(title, slug):
    """What is wrong with `title` for a project living in a folder named `slug`.

    Returns one sentence, or None when the title is in the right form. `slug`
    is the project directory's name, which is also the repository's name.
    """
    # THE DIRECTORY FIRST, before the title is picked apart at all. When the
    # folder is not a slug no title can satisfy the rule, so every message
    # below would be blaming the wrong half -- a project in `Корпус/` titled
    # `Корпус (Корпус)` used to be told that the brackets carry "not a slug",
    # which reads as an instruction to edit the title. This check used to sit
    # after the comparison with `found` and was unreachable from there: getting
    # that far required the two names to be equal AND `found` to be a slug,
    # which makes `slug` one too.
    if not is_slug(slug):
        return (
            f"the project directory is named {str(slug or '')!r}, which is not "
            "a latin slug, so neither the folder nor the title can carry one. "
            "Rename the directory (and the repository) first"
        )

    title = (title or "").strip()
    if not title:
        return "the project has no title"

    match = BRACKET_RE.search(title)
    if not match:
        return (
            f"the title {title!r} does not end with the project's slug in "
            "brackets"
        )

    found = match.group(1).strip()
    described = title[:match.start()].strip()

    if not SLUG_RE.match(found):
        return (
            f"the title {title!r} ends with {found!r} in brackets, which is "
            "not a slug: that place carries the latin name of the directory "
            "and the repository, not a comment"
        )
    if found != slug:
        # The reason this rule exists. Say both names, in that order: the one
        # in the title is the one that is probably wrong.
        return (
            f"the title says {found!r} but this project's directory is "
            f"{slug!r}. A slug from another project is what a title copied "
            "along with the rest of a project looks like -- check that the "
            "whole title is about THIS part and not about the one it was "
            "copied from"
        )
    if not CYRILLIC_RE.search(described):
        return (
            f"the title {title!r} carries the slug but nothing in Russian in "
            "front of it: the slug names the folder, and the words before it "
            "are what says what the thing is and what it is for"
        )
    return None
