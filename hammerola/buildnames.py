"""What a build file may be called — the one rule, where every half can read it.

Three callers import the name rule (`unservable_reason`):

  * the file server, for every request for `/project/<pid>/<commit>/<name>`
    (`_safe_name` in src/app.py);
  * the publishing half, for every name a push DECLARES (`_check_declared_file`
    in src/render.py: a view's `file`, `overview`, `preview` and `card`, and a
    catalogue record's `files` and `preview`);
  * the client, for every name the hub's answer hands back, before writing it to
    the author's disk (`hammerola/artifacts.py`).

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
    # The file sits at the TOP LEVEL. Serving answers
    # `/project/<pid>/<commit>/<name>` and nothing deeper, so a name inside a
    # subdirectory has no URL on this service.
    if "/" in name:
        return ("is inside a subdirectory; it has to sit at the top level of "
                "the build, because that is the only place the hub serves from")
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
