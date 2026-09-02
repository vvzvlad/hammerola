"""One rule about file names, three callers, and no copy of it anywhere.

WHY THIS FILE EXISTS. "What may a build file be called" is asked by the file
server, by the declaration side of a push and by the client that writes such a
name to the author's disk — and the third of those cannot import either of the
first two: `hammerola` is stdlib-only and takes nothing from `requirements.txt`
or from the service (`src/client/__init__.py`). That is exactly the shape that
produced `cad_publish/hubspec.py`: somebody else's rules, copied into a place
that could not see the original, with nothing comparing the two. Here the copy
was real and had already gone wrong — the client's own re-check caught `/` and a
leading dot while the rule it was standing in for had grown two more clauses,
one of which names that very command as its beneficiary.

So the rule MOVED, to `src/buildnames.py`, and every side imports it. What these
tests pin is that this stays true: that nothing re-inlines a copy, and that the
shared module stays importable on a laptop's bare python3, which is the property
that made the move possible at all.

The CATEGORY SCAN inside that rule has a fourth reader, and it is pinned here
for the same reason: `_clean_title` in `src/client/project.py` refuses a project
title before `hammerola create` writes it, and it used to spell the scan itself
— narrower than the one the far side applies, so a title it accepted killed the
build.

What the rule ANSWERS is pinned where its callers are:
`tests/test_publish.py::test_the_file_server_and_a_push_agree_on_what_a_build_file_may_be_called`
walks a table of names through all three doors.
"""

import ast
import sys
from pathlib import Path

from src import app, buildnames, render
from src.client import artifacts
from src.client import project as client_project

SHARED = Path(buildnames.__file__)


def test_the_publishing_half_re_exports_the_shared_objects_and_not_copies():
    """`is`, not `==`: two functions with identical source are exactly what a
    copy looks like on the day it is made, and this has to fail then rather than
    a year later, when the two have quietly drifted apart."""
    assert render.unservable_reason is buildnames.unservable_reason
    assert render.first_nonprintable is buildnames.first_nonprintable


def test_the_client_asks_the_hubs_own_rule_and_not_an_approximation_of_it():
    """The copy that was really there, and the one the rule is written FOR.

    `hammerola artifacts` re-checks every name the hub's answer declares before
    writing it to a disk, and it does so because a name of that shape means the
    answer did not come from where it should have — i.e. it defends against a
    dishonest hub and against nothing else. Its two hand-rolled conditions
    caught `/` and a leading dot, so against that one case it did not work: the
    non-printable clause exists because this command prints the name and then
    saves the file, and it was the clause the copy did not have.
    """
    assert artifacts.unservable_reason is buildnames.unservable_reason


def test_the_client_scans_project_titles_with_the_shared_rule_too():
    """The second copy the client held, and the one that had already gone wrong.

    `_clean_title` refuses a title before `hammerola create` writes it, and it
    spelled the character rule itself: `ord(char) < 0x20 or ord(char) == 0x7F`,
    which is a SUBSET of Unicode category Cc — the C0 controls and DEL, but not
    C1 (U+0080-U+009F). The far side refuses all of category C,
    so U+202E RIGHT-TO-LEFT OVERRIDE passed `create` and killed the build
    instead — the same defect `src/cadbuild/project.py` records having fixed on
    the build side, in that same spelling.
    """
    assert client_project.first_nonprintable is buildnames.first_nonprintable


def test_the_file_server_answers_through_the_same_module():
    """`app` calls the rule through the module rather than binding the function,
    so the identity assertion is on the module — and the behaviour is checked
    beside it, because a re-inlined `_safe_name` would still leave that import
    sitting there unused."""
    assert app.buildnames is buildnames
    for name in ("lid.png", ".payload.sha256", "a/b.png", "",
                 "lid\u202egnp.png", "lid\npreview.png"):
        assert app._safe_name(name) is (
            buildnames.unservable_reason(name) is None), name


def test_the_shared_module_imports_nothing_but_the_standard_library():
    """What makes it importable by the client at all.

    The client runs under whatever python3 a laptop has and installs nothing, so
    a single import of anything outside the standard library here — loguru
    through `src.store`, or the CAD kernel through `src.cadbuild` — would break
    `hammerola artifacts` on every machine that is not a checkout of this
    repository, from an edit that looks entirely local to the hub.
    """
    imported = _imported_modules(SHARED)
    outside = sorted(name for name in imported
                     if name not in sys.stdlib_module_names)
    assert outside == [], (
        f"{SHARED.name} imports {outside}, and it may import only the standard "
        f"library: the client imports this module and installs nothing")


def _imported_modules(path: Path) -> set:
    """The TOP-LEVEL module name of every import in a file.

    Read out of the syntax tree rather than by importing and inspecting
    `sys.modules`: an import that only happens inside a function would be
    invisible to the second method until the day it runs, which is the day it
    breaks somebody's laptop.
    """
    names = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names
