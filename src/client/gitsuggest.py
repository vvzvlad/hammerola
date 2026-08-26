"""After a revision is published: the git commit this run OFFERS, and never makes.

`hammerola commit` means "publish a version of this" and nothing more. It does
not drive git, it does not stage, it does not commit — what it does is print a
finished command line and stop, leaving the decision with the person or the
agent reading the output. That distinction is the whole design of this module,
and it is why every function below is a question and none of them is an action.

WHY OFFER ANYTHING AT ALL. The hub publishes the WORKING COPY: whatever is in
the directory at the moment of the push, tracked or not, committed or not. So
straight after a publish there is a window in which the sources at a permanent
immutable URL and the sources in the author's editor are provably identical, and
that window closes on the next keystroke. A commit made inside it is the only
thing that ever ties the two together, and nothing later can reconstruct it.

THE LINK IS ONE-WAY, AND THAT FOLLOWS FROM THE ORDER OF THE TWO ACTS — write it
down here so nobody tries to close the loop and runs into the chicken and the
egg. Publication happens FIRST, so the hub cannot record a git sha: the commit
does not exist yet, and the sha of a commit that is about to be made cannot be
known before it is made. The commit happens SECOND, so its message CAN carry the
revision, and that is the direction this takes. `git log --grep=hammerola-revision`
therefore finds the publication from the history; nothing finds the history from
the publication, and no amount of extra machinery on the hub would change that
without making the revision mutable — which is exactly what its one-year
`immutable` cache promises it is not.

THE MESSAGE COMES FROM THE USER AND GOES INTO A SHELL COMMAND THEY WILL PASTE,
so every string that reaches the printed line goes through `shlex.quote` first.
A quote, a newline, a `$(...)` or a backtick in `-m` has to survive as text; the
one thing it must never do is execute. Two `-m` arguments rather than one with
an embedded blank line, because git joins them with exactly the blank line a
trailer paragraph needs and the command stays on one pasteable line.
"""

import shlex
import subprocess

# git is asked two short questions and each one is either answered at once or is
# not going to be. Ten seconds is far past a slow disk and far short of hanging
# the tool on a credential prompt.
GIT_TIMEOUT = 10

# The trailer key. A git trailer rather than a sentence in the body: it is the
# shape `git interpret-trailers` and every forge already understand, and it is
# what makes `git log --grep` a reliable way to find which commit published which
# revision.
TRAILER = "hammerola-revision"

# One sentence, said once, about why this is worth doing NOW. Not a lecture: the
# reader either acts on it or does not, and either way they have read it.
HEADLINE = ("git has not recorded this yet — what was published is this working "
            "copy as it stands right now:")


def _git(root, *args):
    """`git -C <root> ...` -> stdout, or None when git or the repo is not there.

    None for every kind of "cannot answer" — git is not installed, this is not a
    repository, the command failed, it timed out. The caller treats all of them
    the same way, because they all mean the same thing here: there is no commit
    to offer, which is not an error. The publish already happened and did not
    depend on git in the first place.
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

    Untracked ON PURPOSE, and that is the half a `git diff` would miss: an
    untracked `part.py` is packed and published like every other source file, so
    a commit that left it out would not record what was published. Files git
    ignores do not appear here and are not packed either, so the two agree.

    An empty list for a directory with no git in it, which the caller cannot tell
    apart from a clean tree and does not need to: both mean there is nothing to
    offer.
    """
    out = _git(root, "status", "--porcelain")
    if out is None:
        return []
    return [line for line in out.splitlines() if line.strip()]


def command(root, revision: str, message: str = None) -> str | None:
    """The `git commit` line to offer, or None when there is nothing to offer.

    None in the two cases that are both ordinary rather than failures: there is
    no git here at all, and there is nothing uncommitted. Offering a command
    that would fail is worse than offering none.

    `git add -A` and not `git commit -a`: what was published includes untracked
    files, and `-a` stages only modifications to tracked ones — the commit would
    silently record less than the push did.
    """
    if (_git(root, "rev-parse", "--is-inside-work-tree") or "").strip() != "true":
        return None
    if not uncommitted(root):
        return None

    parts = ["git", "add", "-A", "&&", "git", "commit"]
    if message:
        parts += ["-m", shlex.quote(message)]
    parts += ["-m", shlex.quote(f"{TRAILER}: {revision}")]
    return " ".join(parts)


def suggestion(root, revision: str, message: str = None) -> str | None:
    """The whole block to print — the sentence and the command — or None."""
    line = command(root, revision, message)
    if line is None:
        return None
    return f"{HEADLINE}\n  {line}"
