"""What a build file may be called — the one rule, where every half can read it.

THREE CALLERS, IN THREE DIFFERENT WORLDS, which is the whole reason this is a
module of its own rather than a function beside any one of them:

  * the file server asks it of every request for
    `/project/<pid>/<commit>/<name>` (`_safe_name` in src/app.py);
  * the publishing half asks it of every name a push DECLARES
    (`_check_declared_file` in src/render.py, on all four of its maps);
  * the client asks it of every name the hub's answer hands back, before
    writing that name to the author's disk (`src/client/artifacts.py`).

IT WAS WRITTEN OUT THREE TIMES BEFORE THIS FILE EXISTED — once inside each of
those three callers, and no two of the copies said the same thing.
`app._safe_name` was self-contained and refused a leading dot: `bool(name) and
not name.startswith(".") and "/" not in name`. The DECLARATION asked a different
question inline in `build_meta` — membership in what the build wrote, `/`, and
`GENERATED_FILES` — and so ACCEPTED a leading dot. The client held a third,
weaker copy again: `"/" in filename or filename.startswith(".")`, with nothing
about the non-printable category, which is the clause written FOR it.

Two copies of one rule disagreeing in silence is the entire subject of issue
#53: a name the declaration accepts and the server refuses publishes with a 201
into an immutable directory under a year of cache and then 404s on every GET — a
build accepted and impossible to open, from a push that can never be taken back.
So the rule is one module all three import. `src/metricsdiff.py` is the worked
example of the same move, and `tests/test_buildnames.py` pins that all three
sides hold the same object rather than a copy of it.

A MODULE OF ITS OWN because none of the three could host it. `render.py` is out
because the client cannot import the service at all — the tool is stdlib-only
and takes nothing from `requirements.txt` (`src/client/__init__.py`) — and
because the file server would then be depending on the publishing half for a
rule about its own URLs. `store.py`, the obvious address next door to
`SAFE_COMPONENT`, is out for a different reason: the import edge runs `app ->
store -> render`, so `render` may import neither of those two.

STDLIB ONLY, and that is a rule rather than a coincidence: the client imports
this module and installs nothing, so one dependency here breaks `hammerola
artifacts` on every laptop that is not a checkout of this repository.

TWO THINGS ARE DELIBERATELY NOT HERE, named so the next reader does not reopen
them:

  * `store.SAFE_COMPONENT` does NOT move beside this. It is a different rule
    about a different door: the alphabet each component of an ARCHIVE MEMBER's
    path is held to on the way in, capped at 128 characters. This one is about
    the name of a file a build already wrote, on the way out. It stays in
    `store.py` with the rest of the archive-security surface, which has a suite
    of its own.
  * There is no LENGTH ceiling in the rule below, though the category scan is
    the one part of it that costs anything (~6 ms on a 64 KiB URL segment). The
    honest bound is `MEMBER_RE`'s 128 characters and it does NOT apply to a
    build's OUTPUT names — that is the premise this whole rule rests on, see
    `unservable_reason` — so any number written here would be a second ceiling
    invented to sit beside a real one, which is exactly what
    `render._check_map_size`'s docstring argues against. The scan runs LAST,
    after the cheap comparisons, and returns on the first offender.
"""

import unicodedata
from typing import Optional


def _first_nonprintable(value: str):
    """The first character Unicode files under C, or None if there is none.

    A function of its own because two different answers are built out of one
    loop: a ValueError naming a field (`_plain_text` in src/render.py, which
    imports this) and a reason a FILE NAME cannot be served
    (`unservable_reason`, below). Written twice, the two would be free to
    disagree about what "printable" means — and the second one is the half that
    decides what a build may call a file it publishes.
    """
    for char in value:
        # Cc control, Cf format, Cs surrogate, Co private use, Cn unassigned.
        if unicodedata.category(char).startswith("C"):
            return char
    return None


def unservable_reason(name) -> Optional[str]:
    """Why `/project/<pid>/<commit>/<name>` would not answer — or None if it would.

    THE ONE PLACE THAT DECIDES WHAT A BUILD FILE MAY BE CALLED, and it is one
    place because it was two. The file server asks this question of every
    request (`_safe_name` in src/app.py); the publishing half asks it of every
    name a push DECLARES (`_check_declared_file` in src/render.py); and the
    client asks it of every name it is about to write to a disk
    (`src/client/artifacts.py`). Two copies of it disagreed for as long as they
    existed, and the failure that costs is silent: a name the declaration
    accepts and the server refuses publishes with a 201 into an immutable
    directory under a year of cache, and then 404s on every GET — a build that
    is accepted and cannot be opened, from a push that can never be taken back.
    So the rule sits here, where all three callers can reach it, and
    `tests/test_publish.py` pins their answers against a table of names.

    The reasons read as the tail of "…, which {reason}", because the caller that
    refuses a push has to say which name and why, and the caller that serves a
    request only has to know whether there is one.

    Nothing here is about WHOSE file it is. `GENERATED_FILES` — `meta.json`,
    `index.html`, `.payload.sha256` — is a question the DECLARATION asks and the
    server needs no help with: two of those three it answers from the hub's own
    copies, and the third it refuses outright, through the leading-dot clause
    below. The declaration has to refuse all three for a reason of its own —
    what would be served is not what its checks measured — so that list stays
    with the caller that needs it (`render.GENERATED_FILES`) rather than coming
    in here.
    """
    if not isinstance(name, str) or not name:
        return "is not a file name at all"
    # The file sits at the TOP LEVEL. Serving answers
    # `/project/<pid>/<commit>/<name>` and nothing deeper, so a name inside a
    # subdirectory has no URL on this service.
    if "/" in name:
        return ("is inside a subdirectory; it has to sit at the top level of "
                "the build, because that is the only place the hub serves from")
    # A leading dot is refused by the file server outright, and that refusal is
    # load-bearing twice over: it is how `.` and `..` die, and how the hub's own
    # bookkeeping beside a build — `.payload.sha256` above all — stays
    # unreadable. A build CAN write such a file (nothing on the build path
    # applies an alphabet to an output name — see `runner._verify_output_file`),
    # which is exactly why the declaration has to refuse it here.
    if name.startswith("."):
        return ("starts with a dot, and the hub serves no such name: that is "
                "how `.` and `..` die and how the digest file beside a build "
                "stays unreadable")
    # And the same category rule every displayed field is held to. This one is
    # about the READER rather than the browser: the name is printed by
    # `hammerola artifacts` and then written to the author's disk, so a U+202E
    # smuggled into it reverses the line that reports it. That command asks this
    # very function about the name before writing it, which is the half that
    # used to be a copy catching neither this nor anything else.
    bad = _first_nonprintable(name)
    if bad is not None:
        return (f"carries the non-printable character {bad!r}; a file name is "
                f"read by a person and written to their disk, and the C "
                f"category is where U+202E RIGHT-TO-LEFT OVERRIDE lives")
    return None
