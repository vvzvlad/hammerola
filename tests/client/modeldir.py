"""A model directory on disk, and a git repository around it.

A module of its own rather than helpers in `conftest.py`, for the same reason
`tests/buildproc/probes.py` and `tests/cadbuild/fakes.py` are: with no
`__init__.py` in the tests tree, `from conftest import ...` inside a test module
resolves against whichever `conftest` reached `sys.modules` first, and there are
three of them in this suite. A uniquely named module cannot be confused.
"""

import json
import subprocess

from harness import DEFAULT_EXPORTS, meta_bytes, view_bytes

MODEL_SOURCE = """\
import cadquery as cq


def views():
    return {"assembled": cq.Workplane("XY").box(10, 10, 10)}
"""


def make_model(root, pid="demo0001", title="Demo project", extra=None):
    """A model directory the way one arrives on the hub.

    `meta.json` and `assembled.json` sit beside the source because the suite's
    stand-in builder (`harness.copying_builder`) publishes the pushed tree
    UNCHANGED: with no CAD kernel here there is nothing to turn source into
    artefacts, so the tree that is pushed has to already be the tree that can be
    published. What is under test is the CLIENT's half of the contract — what it
    packs, what it refuses, what it does with a 202 — and that half does not care
    which of the files is source and which is output.
    """
    root.mkdir(parents=True, exist_ok=True)
    (root / "project.json").write_text(
        json.dumps({"id": pid, "title": title}), encoding="utf-8")
    (root / "model.py").write_text(MODEL_SOURCE, encoding="utf-8")
    (root / "meta.json").write_bytes(meta_bytes())
    (root / "assembled.json").write_bytes(view_bytes())
    # The exports the default catalogue names. A printable that declares none is
    # a 422 (`render._catalogue`), so the smallest publishable tree now carries
    # one file per printable — see `harness.DEFAULT_EXPORTS`, which is where the
    # names live, since the document naming them comes from there too.
    for name, data in DEFAULT_EXPORTS.items():
        (root / name).write_bytes(data)
    for name, data in (extra or {}).items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, str):
            data = data.encode("utf-8")
        path.write_bytes(data)
    return root


def git(root, *args, check=True):
    """`git -C <root> ...` with the machine's own configuration kept out of it.

    `user.*` because a CI runner has no identity configured and `git commit`
    refuses without one; `commit.gpgsign` because a developer who signs every
    commit would otherwise have this suite waiting on a passphrase prompt.
    """
    settings = [
        "-c", "user.name=hammerola tests",
        "-c", "user.email=tests@example.invalid",
        "-c", "commit.gpgsign=false",
    ]
    return subprocess.run(
        ["git", "-C", str(root), *settings, *args],
        capture_output=True, text=True, check=check)


def git_repo(root, message="initial"):
    """Turn a model directory into a clean repository. -> the HEAD sha."""
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", message)
    return git(root, "rev-parse", "HEAD").stdout.strip()
