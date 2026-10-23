"""What a build file may be called — the one rule, where every half can read it.

Three callers import the name rule (`unservable_reason`):

  * the file server, for every segment of a request for
    `/project/<pid>/<commit>/<path>` (`_safe_build_path` in src/app.py, through
    `unservable_path_reason`) and for `/_v/<name>` (`_safe_name`);
  * the publishing half, for every name a push DECLARES (`_check_declared_file`
    in src/render.py: a view's `file`, `overview`, `preview` and `card`, and a
    catalogue record's `files` and `preview`, each a single name at the top of
    the build; a document's `file`, a path);
  * the client, for every name the hub's answer hands back, before writing it to
    the author's disk (`hammerola/artifacts.py`).

A DOCUMENT keeps its place in the tree (`docs/cut-list.md`), so its path is
asked of `unservable_path_reason`: the name rule applied to each segment.

`first_nonprintable`, the category-C scan, has further readers: `render._plain_text`,
`_clean_title` in hammerola/project.py, and `src/records.py` (a 422 on the comment
and proposal write paths).

One module, because a name the declaration accepts and the server refuses would
publish into an immutable directory and then 404 forever. `tests/test_buildnames.py`
pins that all sides hold the same objects. It cannot live in `render.py` (the
client imports nothing from the service, and the file server should not depend on
the publishing half) or in `store.py` (the import edge runs `app -> store ->
render`).

STDLIB ONLY: the client imports this module, and through hammerola/project.py so
does every `hammerola` command, so a dependency here breaks the whole tool on any
machine that is not a checkout.

Deliberately not here:

  * `store.SAFE_COMPONENT`, a different rule: the alphabet of archive member
    path components on the way in, capped at 128 characters.
  * a length ceiling. `MEMBER_RE`'s 128 characters do not apply to a build's
    output names, and the scan, the only costly part (~6 ms on a 64 KiB segment),
    runs last and stops at the first offender.
"""

import unicodedata
from typing import Optional


def first_nonprintable(value: str):
    """The first character Unicode files under C, or None if there is none.

    One loop shared by four answers (a ValueError in `_plain_text`, a file-name
    reason in `unservable_reason`, a title refusal in `_clean_title`, a 422 in
    src/records.py), so they all agree on what "printable" means: all of category
    C, including C1 controls and format characters such as U+202E, not just C0
    and DEL.

    Public because `src/render.py` imports it across the package boundary; the hub
    imports the client's module, never the other way round.
    """
    for char in value:
        # Cc control, Cf format, Cs surrogate, Co private use, Cn unassigned.
        if unicodedata.category(char).startswith("C"):
            return char
    return None


def unservable_reason(name) -> Optional[str]:
    """Why `/project/<pid>/<commit>/<name>` would not answer — or None if it would.

    The one place that decides what a build file may be called, shared by the file
    server, the publishing half and the client (see the module docstring);
    `tests/test_publish.py` pins their answers against a table of names.

    The reasons read as the tail of "…, which {reason}", because the caller that
    refuses a push has to say which name and why, and the caller that serves a
    request only has to know whether there is one.

    Ownership is not checked here: `render.GENERATED_FILES` (`meta.json`,
    `index.html`, `.payload.sha256`) is the declaration's own concern and stays
    with it.
    """
    if not isinstance(name, str) or not name:
        return "is not a file name at all"
    # The file sits at the TOP LEVEL. A model's build writes its files there
    # (`cadbuild.build`), the viewer and `hammerola artifacts` look for them
    # there, and only a document keeps a path of its own
    # (`unservable_path_reason` below).
    if "/" in name:
        return ("is inside a subdirectory; a model's files sit at the top "
                "level of its build, and only a document keeps its path in "
                "the tree")
    # A leading dot is refused by the file server: that is how `.` and `..` die
    # and how `.payload.sha256` beside a build stays unreadable. Nothing on the
    # build path restricts output names (`runner._verify_output_file`), so the
    # declaration has to refuse it too.
    if name.startswith("."):
        return ("starts with a dot, and the hub serves no such name: that is "
                "how `.` and `..` die and how the digest file beside a build "
                "stays unreadable")
    # The same category rule every displayed field is held to: `hammerola
    # artifacts` prints the name and writes it to disk, and a U+202E would reverse
    # the line that reports it.
    bad = first_nonprintable(name)
    if bad is not None:
        return (f"carries the non-printable character {bad!r}; a file name is "
                f"read by a person and written to their disk, and the C "
                f"category is where U+202E RIGHT-TO-LEFT OVERRIDE lives")
    return None


def unservable_path_reason(path) -> Optional[str]:
    """Why `/project/<pid>/<commit>/<path>` would not answer — or None if it would.

    The rule for a path that may go into subdirectories, as a document's does
    (`docs/cut-list.md`): every segment is held to `unservable_reason`, which
    is how `..` and `.` die and how nothing under a build is reached through a
    dot-name. An empty segment is refused too. The file server drops empty
    segments from a request (`_split` in src/app.py), so it answers
    `docs//x.md` as `docs/x.md`; it is a DECLARATION that must not carry one:
    `/x.md` joined onto the tree is an absolute path outside it, and
    `docs//x.md` is the file `docs/x.md` under a second id.
    """
    if not isinstance(path, str) or not path:
        return "is not a file name at all"
    for segment in path.split("/"):
        if not segment:
            return "has an empty segment: a leading, trailing or doubled slash"
        reason = unservable_reason(segment)
        if reason is not None:
            return (reason if segment == path
                    else f"has the segment {segment!r}, which {reason}")
    return None
