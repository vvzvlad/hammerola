"""One slug rule, two machines, and no copy of it anywhere.

WHY THIS FILE EXISTS. "What is this project called, in latin" is asked on the
author's laptop, by `hammerola create` deciding what to write into project.json,
and inside the hub, by the build deciding what name to publish under — and the
first of those cannot import the second: the client is stdlib-only and takes
nothing from `requirements.txt` or from `src/cadbuild/` (`hammerola/__init__.py`).
That is exactly the shape that produced `cad_publish/hubspec.py`: somebody else's
rule, copied into a place that could not see the original, with nothing comparing
the two.

So the rule MOVED, to `hammerola/projectslug.py`, and both sides import it. What these
tests pin is that this stays true — that `src.cadbuild.project_title` re-exports
the very same objects instead of growing a copy again, and that the shared module
stays importable on a laptop's bare python3, which is the property that made the
move possible at all.

What the rule ANSWERS about a TITLE is pinned where its callers are
(`tests/cadbuild/test_paths_and_project.py`, `tests/cadbuild/test_project_title.py`).
What it answers about a DIRECTORY is pinned here, because the client is the only
caller and the answer that matters is the one it gives to the hub's own unpack
directory.
"""

import ast
import sys
from pathlib import Path

from hammerola import projectslug
from src.cadbuild import project_title

SHARED = Path(projectslug.__file__)

# What the build half is expected to go on exposing under its own name. The
# build and its tests are written against `cadbuild.project_title`, so moving
# the implementation had to leave those spellings working.
RE_EXPORTED = ("SLUG_RE", "BRACKET_RE", "is_slug", "slug_from_title")


def test_the_build_half_re_exports_the_shared_objects_and_not_copies():
    """`is`, not `==`: two regexes compiled from identical source are exactly
    what a copy looks like on the day it is made, and this test has to fail then
    rather than a year later."""
    for name in RE_EXPORTED:
        assert getattr(project_title, name) is getattr(projectslug, name), name


def test_the_client_and_the_build_read_a_title_with_the_same_function():
    """The whole point of the move, asserted from the CLIENT's side.

    `hammerola/project.py` derives the slug when a project is created;
    `src/cadbuild/project.py` reads a title's brackets when project.json names
    nothing else. One object, so the two can never disagree about what a slug is
    — which is the disagreement that would publish under one name and check
    against another.
    """
    from hammerola import project as client_project

    assert client_project.slug_from_title is projectslug.slug_from_title
    assert project_title.slug_from_title is projectslug.slug_from_title


def test_the_build_half_cannot_ask_what_its_own_directory_is_called():
    """The absence is the decision, so it is asserted rather than left implied.

    `slug_from_directory` is deliberately not re-exported: inside the hub the
    project root is the directory a push was unpacked into, so that question has
    an answer there and the answer is `.src-<uuid>` — the incident this module
    exists to end. A re-export would put the wrong answer one attribute away
    from the code that used to give it.
    """
    assert not hasattr(project_title, "slug_from_directory")


def test_the_hubs_own_unpack_directory_is_not_a_name_a_project_can_carry():
    """THE INCIDENT, at the rule that now refuses it.

    `store.SOURCE_PREFIX` is `.src-`, so every unpacked push is a directory
    starting with a dot — which the alphabet refuses on its first character.
    That refusal is what makes "derive it from the directory" safe to offer at
    all: the one caller runs on the author's machine, and a value that leaked in
    from anywhere else cannot pass this.
    """
    assert projectslug.slug_from_directory(
        ".src-89fb7abdeb1d48b5985bcb519850b284") == ""


def test_a_directory_name_a_project_can_be_published_under_comes_back_whole():
    for name in ("slip-pump", "t13-ceiling-mount", "wb_mge.v2", "Cover4"):
        assert projectslug.slug_from_directory(name) == name


def test_a_directory_nobody_could_publish_under_answers_with_nothing():
    """"" rather than a guess, and never a mangled version of the name.

    A slug is the name of a repository as well as of a folder, so inventing one
    out of `Корпус для T13` would be this tool naming somebody's project for
    them — and the invented name would then be permanent on the index.
    """
    for name in ("Корпус", "my model", "-leading", "trailing-", "", "  "):
        assert projectslug.slug_from_directory(name) == "", name


def test_the_shared_module_imports_nothing_but_the_standard_library():
    """What makes it importable by the client at all.

    The client runs under whatever python3 a laptop has and installs nothing, so
    a single `import numpy` here — or an import of anything under
    `src/cadbuild/`, which is the build half and exists to load a CAD kernel —
    would break `hammerola create` on every machine that has no CAD stack, from
    an edit that looks local to the hub. The zipapp does not catch it: the
    closure `onboarding._refuse_unimportable` walks skips every import that is
    not `hammerola`, so such a module is served with a 200 and dies on the
    laptop.
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
