"""A model directory on disk, and a git repository around it.

A module of its own rather than helpers in `conftest.py`, for the same reason
`tests/buildproc/probes.py` and `tests/cadbuild/fakes.py` are: with no
`__init__.py` in the tests tree, `from conftest import ...` inside a test module
resolves against whichever `conftest` reached `sys.modules` first, and there are
three of them in this suite. A uniquely named module cannot be confused.
"""

import json
import subprocess
from pathlib import Path

from harness import DEFAULT_EXPORTS, meta_bytes, push, tar_gz, view_bytes

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
    reads back and what it refuses — and that half does not care which of the
    files is source and which is output.
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


def project_id(root) -> str:
    return json.loads(
        (Path(root) / "project.json").read_text(encoding="utf-8"))["id"]


def model_archive(root) -> bytes:
    """The model directory's regular files as one gzipped tar.

    Hidden entries (`.git`, `.hammerola`) are left out: the hub's path alphabet
    refuses a leading dot, and neither is part of the model.
    """
    root = Path(root)
    files = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.is_file() and not path.is_symlink():
            files[relative.as_posix()] = path.read_bytes()
    return tar_gz(files)


def publish_model(hub, root, commit=None) -> str:
    """Publish a model directory through the harness. -> the build's name.

    `harness.Hub.publish` builds the tree in the hub's queue as a hub before
    git did and imports it into the project's repository. `commit=None` names
    the revision by the digest of its tree; `dev` fills the draft slot.
    """
    reply = hub.publish(project_id(root), commit, model_archive(root))
    assert reply.status_code in (200, 201), reply.text
    return reply.json()["url"].rstrip("/").rsplit("/", 1)[1]


def push_version(hub, root, message="version") -> str:
    """Commit the model directory and publish it with `git push`. -> the commit.

    The repository is made on the first call. The push is `harness.push`,
    straight to the hub's address with the token; the hub's hook builds the
    commit and names the revision by it.
    """
    if not (Path(root) / ".git").exists():
        git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", message)
    sha = git(root, "rev-parse", "HEAD").stdout.strip()
    pushed = push(hub, root, project_id(root))
    assert pushed.returncode == 0, pushed.stderr
    return sha
