"""No git conflict marker may reach a commit.

This exists because one did. A `<<<<<<< HEAD` survived a merge resolution in
`templates/build.html`, and the suite — 191 tests at the time — stayed green:
every test asked whether the ids it needed were present, and they were. The
marker sat in the served page as visible text, and only a grep caught it.

That is the shape of the hole. Tests here assert that things ARE there; a
marker adds text without removing anything, so nothing that checks for presence
can see it. The check has to be about the file as a whole.

Deliberately a test and not a CI step: it then runs on a workstation before the
push, which is where the mistake is actually made and where fixing it is free.
"""

import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# Anchored at line start, which is where git writes them. `=======` gets a
# length bound for the same reason git does: a markdown table rule or a heading
# underline is a run of `=` too, and those are legitimate. Git emits exactly
# seven.
MARKERS = re.compile(r"(?m)^(<{7} |={7}$|>{7} |\|{7} )")

# None of these is hand-written, so there is no merge for a marker inside one to
# come out of. `three-cad-viewer.esm.js` and its stylesheet are OUR OWN build of
# the fork in `viewer/`, rewritten wholesale by `make viewer` — the source they
# are built from is tracked and swept like any other file here, which is where a
# conflict would actually have to be resolved. `three.module.js` and
# `three.core.js` are npm's builds of three, copied in unchanged: third-party,
# and not ours to merge.
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", "data", "_out"}
SKIP_FILES = {"three-cad-viewer.esm.js", "three-cad-viewer.css",
              "three.module.js", "three.core.js"}


def tracked_files():
    """Ask git, not the filesystem: only what is committed can reach prod.

    A stray file in the working tree is the author's business; a marker inside
    a TRACKED file is what ships. This also keeps the check honest about the
    thing it guards -- the commit -- rather than about local mess.
    """
    out = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
        capture_output=True, check=True,
    ).stdout
    for raw in out.split(b"\0"):
        if not raw:
            continue
        rel = Path(raw.decode("utf-8", "surrogateescape"))
        if SKIP_DIRS & set(rel.parts) or rel.name in SKIP_FILES:
            continue
        yield rel


def test_no_tracked_file_carries_a_conflict_marker():
    guilty = []
    for rel in tracked_files():
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8", errors="strict")
        except (OSError, UnicodeDecodeError):
            # Binary or unreadable: git would not have merged it as text either.
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if MARKERS.match(line):
                guilty.append(f"{rel}:{n}: {line[:60]}")
    assert not guilty, "conflict markers reached a tracked file:\n" + "\n".join(guilty)


def test_the_check_actually_sees_a_marker(tmp_path, monkeypatch):
    """The guard above passes trivially once the tree is clean.

    Without this, deleting the regex would leave a permanently green test that
    proves nothing -- which is exactly how the original escape happened.
    """
    for marker in ("<<<<<<< HEAD", "=======", ">>>>>>> main", "||||||| base"):
        assert MARKERS.match(marker), marker


def test_legitimate_lookalikes_are_not_flagged():
    """A markdown rule is not a conflict marker.

    `=======` under a heading, or a table rule, is ordinary prose. If those
    tripped the check, someone would weaken it until it stopped working.
    """
    for benign in ("=" * 20, "-" * 7, "===", "<<< not git", "> quoted"):
        assert not MARKERS.match(benign), benign


@pytest.mark.parametrize("name", sorted(SKIP_FILES))
def test_the_skipped_files_are_the_vendored_bundle(name):
    """The exemption must not outlive what it exempts.

    If the vendored viewer is ever removed or renamed, this skip silently starts
    covering nothing -- or worse, a file of ours that happens to take the name.
    """
    assert (ROOT / "static" / "_v" / name).is_file(), (
        f"{name} is exempted from the conflict-marker check but does not exist; "
        "drop the exemption or fix the path"
    )
