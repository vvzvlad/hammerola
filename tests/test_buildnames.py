"""One rule about file names, several callers, and no copy of it anywhere.

"What may a build file be called" is asked by the file server, by the declaration
side of a push and by the client that writes such a name to the author's disk. The
client cannot import the service (`hammerola` is stdlib-only, see
`hammerola/__init__.py`), so the rule lives in `hammerola/buildnames.py` and every
side imports it. These tests pin that nothing re-inlines a copy and that the shared
module stays importable on a laptop's bare python3.

The category scan inside the rule has a fourth reader: `_clean_title` in
`hammerola/project.py` refuses a project title before `hammerola create` writes it,
and must apply the same scan the build applies.

What the rule answers is pinned at its callers:
`tests/test_publish.py::test_the_file_server_and_a_push_agree_on_what_a_build_file_may_be_called`
walks a table of names through all three doors.
"""

import ast
import sys
from pathlib import Path

from src import app, records, render
from hammerola import artifacts, buildnames
from hammerola import project as client_project

SHARED = Path(buildnames.__file__)


def test_the_publishing_half_re_exports_the_shared_objects_and_not_copies():
    """`is`, not `==`: two functions with identical source are exactly what a
    copy looks like on the day it is made, and this has to fail then rather than
    a year later, when the two have quietly drifted apart."""
    assert render.unservable_reason is buildnames.unservable_reason
    assert render.unservable_path_reason is buildnames.unservable_path_reason
    assert render.first_nonprintable is buildnames.first_nonprintable
    # The fourth reader, and the only one that answers at a write door: both
    # helpers in `src/records.py` refuse a comment or a proposal field with a
    # 422. Its docstring says "the loop is `first_nonprintable`'s, and the whole
    # point is that there is one of it" -- which is a promise, until it is here.
    assert records.first_nonprintable is buildnames.first_nonprintable


def test_the_client_asks_the_hubs_own_rule_and_not_an_approximation_of_it():
    """`hammerola artifacts` re-checks names with the hub's own rule.

    It re-checks every name the hub's answer declares before writing it to disk, to
    defend against a dishonest hub. The non-printable clause matters most here,
    because this command prints the name and then saves the file.
    """
    assert artifacts.unservable_reason is buildnames.unservable_reason
    # A document's path, which `artifacts` writes into subdirectories.
    assert artifacts.unservable_path_reason is buildnames.unservable_path_reason


def test_the_client_scans_project_titles_with_the_shared_rule_too():
    """`_clean_title` scans project titles with the shared rule too.

    The build refuses all of Unicode category C; a narrower check (C0 controls and
    DEL only) would let U+202E RIGHT-TO-LEFT OVERRIDE through `create` and fail the
    build instead.
    """
    assert client_project.first_nonprintable is buildnames.first_nonprintable


def test_the_file_server_answers_through_the_same_module():
    """`app` calls the rule through the module rather than binding the function,
    so the identity assertion is on the module — and the behaviour of both doors
    is checked beside it (`_safe_name` for `/_v/`, `_safe_build_path` for a
    build's files), because a re-inlined door would still leave that import
    sitting there unused."""
    assert app.buildnames is buildnames
    for name in ("lid.png", ".payload.sha256", "a/b.png", "a/.b.png", "",
                 "lid\u202egnp.png", "lid\npreview.png"):
        assert app._safe_name(name) is (
            buildnames.unservable_reason(name) is None), name
        assert app._safe_build_path(name) is (
            buildnames.unservable_path_reason(name) is None), name


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
