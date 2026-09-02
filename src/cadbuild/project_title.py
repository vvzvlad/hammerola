#!/usr/bin/env python3
"""The shape of a project title, and the single place that decides it.

A title is words saying WHAT the thing is and WHAT FOR, then the latin slug of
the folder and of the repository in brackets:

    Ford viscosity cup No.4, dip cup with a replaceable orifice (ford-cup-4)
    Насос для шликера (slip-pump)

Either language: the fleet has both, and the rule is about the FORM (see
`title_problem`, which used to demand Cyrillic and no longer does).

The descriptive half is what a human reads on the hub's index next to twenty
other projects; the slug is what ties that line to a directory and a repository.

The slug half is the one with teeth, and it is not decoration: it must equal the
name the project PUBLISHES under -- which, for a project.json written by
`hammerola create`, is the author's directory name only WHEN THAT NAME IS A SLUG
THE HUB WOULD PUBLISH: `_project_slug` in src/client/project.py asks `is_slug`
AND the ceiling on a displayed field, and either can turn it away. Otherwise the
name comes out of these very brackets -- `Корпус/` titled `Потолочный корпус
(t13-ceiling-mount)` publishes as `t13-ceiling-mount`, and so does a directory
named with 201 `a`s, which IS a slug (SLUG_RE carries no length at all) and
still loses on the ceiling. Stated on the alphabet alone this sentence was
wrong twice over: unqualified it said the directory always wins, and qualified
with `is_slug` it still promised a directory the ceiling refuses. It is asked
first and passed over when it cannot answer. Projects are made by
copying an existing one, and the title is the field the copy forgets to change
-- so a slug that does not match is, almost always, the previous project's title
still sitting in project.json. Nothing about a page reading "Насос для шликера"
over a ceiling bracket says which of the two is the mistake, and the title
travels into every published snapshot.

ONE CALLER, AND IT WARNS: `cadbuild.build` prints `title_problem` on the build
log, next to the line naming the project. Never an error, and that
is on purpose twice over. A part
that is modelled, gated and ready to print must not fail to publish over the
wording of its name. And an agent that hits an
error edits until it goes away, so a title check that could go red would be
"fixed" by rewriting the title, leaving whatever is really wrong in place behind
a green build.

THE RULE ITSELF LIVES IN `src/projectslug.py` and is imported back here, so the
four names this module used to define -- `SLUG_RE`, `BRACKET_RE`, `is_slug`,
`slug_from_title` -- go on resolving here. Two others were DELETED rather than
moved: `CYRILLIC_RE`, along with the clause of `title_problem` that was its only
reader and that the function's own comment now explains, and `form_hint` with
the `EXAMPLES` it printed, which nothing had ever called. It moved
because the slug gained a second reader that cannot import this one:
`hammerola create` derives it on
the author's machine, and the client is stdlib-only and never imports the build
half. Read that module's docstring for why a shared module beat a second copy.
The import is absolute for the same reason `metrics.py`'s is, and is safe for
the same reason -- see there.
"""

# `slug_from_directory` IS DELIBERATELY NOT IMPORTED, and its absence is the
# decision: nothing in this package may ask what its own directory is called.
# This code runs only inside the hub's build process, rooted at the directory a
# push was unpacked into, so that question has an answer here and the answer is
# `.src-<uuid>` -- the incident this whole module now warns about.
from src.projectslug import (
    BRACKET_RE,
    SLUG_RE,
    is_slug,
    slug_from_title,
)

# Listed explicitly for the same reason `cadbuild/metrics.py` lists its own: a
# linter that decides an unused import is dead would delete this module's public
# surface. ONE of the four is that import, not all four, and the difference is
# worth being exact about: `slug_from_title` is never called here -- its reader
# is `cadbuild/project.py`, which resolves it THROUGH this module -- while
# `is_slug`, `BRACKET_RE` and `SLUG_RE` are used below as well as re-exported.
# What is NOT here is `slug_from_directory`, and its absence is the decision the
# import comment above states.
__all__ = ["BRACKET_RE", "SLUG_RE", "is_slug", "slug_from_title",
           "title_problem"]


def title_problem(title, project, pid):
    """What is wrong with `title` for a project published as `project`.

    Returns one sentence, or None when the title is in the right form.

    THE SECOND ARGUMENT CHANGED MEANING when this function finally got a caller,
    and the old meaning is named here so nobody restores it. It used to be the
    NAME OF THE PROJECT DIRECTORY, read off the filesystem by a tool that ran on
    the author's machine. Nothing runs there any more: this package only ever
    executes inside the hub's build process, rooted at the directory a push was
    unpacked into (`.src-<uuid>`), so the old argument has no value here that is
    not the hub's own bookkeeping. What it is handed instead is the slug the
    build PUBLISHES under -- which, for a project.json `hammerola create` wrote,
    is the `project` key in that file: the author's directory name when it is a
    slug, and the title's own brackets when it is not. Either way it is CARRIED
    ACROSS in the file rather than read off a disk the hub cannot see.

    THE THIRD IS THE PROJECT ID, and it is here because the id can BE the
    published name: `load_project` falls back to it when nothing else names the
    project, and twelve hex characters match SLUG_RE. Without it this function
    asked for the published name to be repeated in the brackets -- advice that
    silences the warning permanently and puts the id in the title as well. See
    the clause below.
    """
    # THE PUBLISHED NAME FIRST, before the title is picked apart at all. When it
    # is not a slug no title can satisfy the rule, so every message below would
    # be blaming the wrong half -- a project published as `Корпус` and titled
    # `Корпус (Корпус)` used to be told that the brackets carry "not a slug",
    # which reads as an instruction to edit the title.
    #
    # TWO OF THE THREE SOURCES CAN LAND HERE, and an earlier version of this
    # comment claimed only one could. `load_project` resolves the name from the
    # `project` key, then the title's brackets, then `pid` -- and only the
    # middle one is a slug by construction (`slug_from_title` returns what
    # SLUG_RE matched or nothing). `pid` is held to MEMBER_RE, which is weaker on
    # the ALPHABET and stricter on LENGTH, so NEITHER implies the other:
    # `foo--bar`, `trailing-`, `a_-b` and `wb.mge..v2` are all legal path
    # components and none of them is a slug, while `'a' * 200` is a slug that
    # MEMBER_RE's 128-character cap refuses -- SLUG_RE has no length in it at
    # all. Only the alphabet half matters here. So a hand-written `"id":
    # "trailing-"` reaches this branch with no `project` key in the file at all,
    # which is why the message NAMES BOTH SOURCES instead of telling somebody to
    # edit a key that may not be there.
    if not is_slug(project):
        return (
            f"the project publishes as {str(project or '')!r}, which is not a "
            "latin slug, so neither it nor the title can carry one. That name "
            "is the \"project\" key of project.json -- the latin name of the "
            "directory and of the repository -- or, when the file names none, "
            "the project id standing in for it"
        )

    # THE NAME IS THE ID, and this clause comes before the title is looked at
    # because every message below would teach the wrong repair. `pid` is twelve
    # hex characters, so it matches SLUG_RE and satisfies the rule: an author
    # told that the title must end with the name the build publishes under
    # writes `(2486c8fd2b05)`, the warning goes quiet for good, and publication
    # under the id is now cemented -- with the id in the human-readable line on
    # the card as well.
    #
    # WHAT THE MESSAGE MAY NOT SAY is that the brackets are the wrong PLACE. It
    # said exactly that -- "not in the title's brackets, where it would only
    # silence this line" -- and that was false: the brackets are the SECOND
    # source `load_project` reads, so a latin name put there clears this warning
    # outright. And the advice it DID give does not finish: the `project` key on
    # its own clears this clause and lands on the general no-brackets sentence
    # below, which demands the very brackets the first message called useless.
    # Both places take a name; only the ID is the wrong value for either, and
    # that is the whole of what this clause knows.
    #
    # THE REMEDY IT NAMES FIRST IS INERT IN ONE REACHABLE STATE, and the message
    # is qualified rather than lengthened to cover it: with the `project` key
    # PRESENT and holding the id, the key wins over the brackets, so `rename`
    # writes them and this same sentence comes back. That state has to be typed
    # by hand -- `create` only ever puts a slug in the key -- so it does not buy
    # a clause in a message every author with the ORDINARY cause reads. What
    # already covers it is the last sentence, "the id in either place", plus
    # `tests/cadbuild/test_project_title.py`, which walks both start states.
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
        # THE BARE SLUG GETS ITS OWN SENTENCE, because the general one is
        # incoherent for it: `hammerola create` with no `--title` in
        # `t13-ceiling-mount/` writes that name into BOTH fields, and the reader
        # is then told that nothing ties `'t13-ceiling-mount'` to
        # `'t13-ceiling-mount'`. The warning stays -- a name with no words
        # around it says nothing about what the thing is, which is the whole job
        # of the half in front of the brackets -- but it has to say the thing
        # that is actually wrong.
        if title == project:
            return (
                f"the title is the bare slug {project!r}: it names the folder "
                "again and says nothing about what the thing is or what it is "
                f"for. `hammerola rename \"<what and what for> ({project})\"`"
            )
        # The incident this warning exists for reaches here: with no slug in the
        # title and no `project` key, the name on the card is whatever the build
        # fell back to, and saying which is half the message.
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
    # WHAT THIS CLAUSE USED TO DEMAND WAS RUSSIAN -- `CYRILLIC_RE.search(described)`
    # -- and the demand is gone rather than softened. It came from a fleet whose
    # titles happened to all be Russian; the caller is now the build log of
    # every project on this hub, one of which is titled "Foam cover
    # reverse-engineered from a 3D scan". A warning that fires on correct work
    # is a warning that stops being read, and it would take the two clauses
    # above it out of circulation with it. What survives is the part that is
    # about the FORM and not about a language: a title that is nothing but its
    # own slug says nothing the slug has not already said.
    if not described:
        return (
            f"the title {title!r} is the slug and nothing else: the slug names "
            "the folder, and the words in front of it are what says what the "
            "thing is and what it is for"
        )
    return None
