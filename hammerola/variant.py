"""The variant a command works on: the branch checked out where it runs.

A variant of a project is a branch of its repository on the hub, `main` the
default one (`src/store.py`). `build` pushes the draft of this branch, and
`status`, `log`, `artifacts` and `diff` read `latest` and `dev` of its variant.

A branch whose name the hub refuses as a variant's (`feat/use-cad-publish`)
has no variant to read: the reading verbs read the default one, and say so in
one line in the hook's own words.

A module of its own because those verbs reach it from `sources.py`, which
`repo.py` cannot be imported by: `repo` imports `update`, and `update` imports
`sources`.
"""

import subprocess
import sys

from hammerola.limits import DEFAULT_VARIANT, SAFE_ID, VARIANT_NAME_REFUSAL


def current_branch(root):
    """The branch checked out in `root`, or None: a detached HEAD, no git
    repository there, or no git at all."""
    try:
        done = subprocess.run(
            ["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=root,
            capture_output=True, encoding="utf-8", errors="replace")
    except OSError:
        return None
    if done.returncode != 0:
        return None
    return done.stdout.strip() or None


def unfit(branch) -> bool:
    """Whether the hub refuses `branch` as a variant: its name fails `SAFE_ID`.
    False for no branch at all."""
    return branch is not None and not SAFE_ID.match(branch)


def refusal(branch) -> str:
    """The line about a branch the hub refuses, in the hook's words."""
    return f"branch {branch}: {VARIANT_NAME_REFUSAL}"


def variant_of(branch) -> str:
    """The variant the verbs that read the hub show on `branch`: the branch
    itself, and the default variant for a detached HEAD (None) and for a
    branch the hub refuses, which one line on stderr then says."""
    if unfit(branch):
        print(f"hammerola: {refusal(branch)}; reading {DEFAULT_VARIANT}",
              file=sys.stderr)
        return DEFAULT_VARIANT
    return branch or DEFAULT_VARIANT


def current_variant(root) -> str:
    """`variant_of` the branch checked out in `root`."""
    return variant_of(current_branch(root))
