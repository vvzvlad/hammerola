"""After a revision is published: the git commit this run OFFERS, and never makes.

Nothing here drives git: the module prints a finished command line and leaves
the decision to whoever reads the output.

The hub publishes the WORKING COPY, tracked or not, so right after a publish the
sources at the immutable URL and the sources on disk are identical; a commit
made then is the only thing that ties them together.

The link is one-way: publication happens first, so the hub cannot know a git
sha, but the commit message can carry the revision as a trailer, found with
`git log --grep=hammerola-revision`.

The message is user input pasted into a shell, so every string goes through
`shlex.quote`. Two `-m` arguments, because git joins them with the blank line a
trailer paragraph needs. A newline in the message stays a quoted newline, so
the printed command may span several lines (`tests/client/test_gitsuggest.py`).
"""

import shlex
import subprocess
# `Optional[str]`, not `str | None`: the client must import on python 3.9
# (`src/onboarding.MIN_PYTHON`), enforced by `tests/test_onboarding.py`.
from typing import Optional

# Long enough for a slow disk, short enough not to hang on a credential prompt.
GIT_TIMEOUT = 10

# A git trailer, so `git interpret-trailers` and `git log --grep` find it.
TRAILER = "hammerola-revision"

HEADLINE = ("git has not recorded this yet — what was published is this working "
            "copy as it stands right now:")


def _git(root, *args):
    """`git -C <root> ...` -> stdout, or None when git or the repo is not there.

    None for every kind of "cannot answer" (no git, not a repository, failure,
    timeout): all mean there is no commit to offer, which is not an error.
    """
    try:
        done = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True, text=True, timeout=GIT_TIMEOUT,
            stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout


def uncommitted(root) -> list:
    """Everything `git status --porcelain` reports, untracked files included.

    Untracked files count because they are packed and published too; ignored
    files are neither listed nor packed. Empty for a directory with no git,
    which, like a clean tree, means there is nothing to offer.
    """
    out = _git(root, "status", "--porcelain")
    if out is None:
        return []
    return [line for line in out.splitlines() if line.strip()]


def is_repository(root) -> bool:
    """Is this directory inside a git work tree?

    Asked by `hammerola source --into-working-copy`, which must know whether
    git can undo it; `uncommitted` cannot tell a clean tree from no repository.
    """
    return (_git(root, "rev-parse", "--is-inside-work-tree") or "").strip() == "true"


def tracked_files(root) -> list:
    """Every path git tracks, relative to `root`, `/`-separated.

    A tracked file is safely removable: `git checkout` can put it back. Empty
    for a directory with no git; the caller removes only files listed here.
    """
    out = _git(root, "ls-files", "-z")
    if out is None:
        return []
    return [name for name in out.split("\0") if name]


def command(root, revision: str, message: str = None) -> Optional[str]:
    """The `git commit` line to offer, or None when there is nothing to offer.

    None when there is no git here or nothing uncommitted. `git add -A`, not
    `git commit -a`: the published tree includes untracked files.
    """
    if not is_repository(root):
        return None
    if not uncommitted(root):
        return None

    parts = ["git", "add", "-A", "&&", "git", "commit"]
    if message:
        parts += ["-m", shlex.quote(message)]
    parts += ["-m", shlex.quote(f"{TRAILER}: {revision}")]
    return " ".join(parts)


def suggestion(root, revision: str, message: str = None) -> Optional[str]:
    """The whole block to print — the sentence and the command — or None."""
    line = command(root, revision, message)
    if line is None:
        return None
    return f"{HEADLINE}\n  {line}"
