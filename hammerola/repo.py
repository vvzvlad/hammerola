"""`hammerola connect`, `hammerola build`, and the code of a revision for `diff`.

A version is published by git itself: `git commit`, then `git push
hammerola-<pid> main`. The hub's pre-receive hook builds the newest pushed
commit that touched the project's directory and refuses the push when that
build fails (src/prereceive.py). This module sets a repository up for that
(`connect`) and pushes the one thing git has no verb for: a draft of the
uncommitted tree (`build`).

The password reaches git through `~/.config/hammerola/gitconfig`, written by
`login` (0600), or by `connect` from the stored settings when it is missing,
and included from the repository's own `.git/config` by `connect`. It is never
an argument or an environment variable of git, so it reaches neither `ps` nor
a transcript. The global `~/.gitconfig` is not touched.

A variant of the project is a branch, and the variant a command works on is the
branch checked out here (`variant.py`): `git push hammerola-<pid> <branch>`
publishes a version of it, and `build` writes its draft, `refs/drafts/<branch>`.
A detached HEAD is no variant, and `build` refuses it. The hub's `main` is the
default variant; its history from before git is joined into the local `main`.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from hammerola import config, project, update
from hammerola.errors import ClientError
from hammerola.hub import build_path, git_headers
from hammerola.limits import DEFAULT_VARIANT
from hammerola.variant import current_branch, refusal, unfit

REMOTE_PREFIX = "hammerola-"
MAIN = DEFAULT_VARIANT
MAIN_REF = f"refs/heads/{MAIN}"
DRAFT_PREFIX = "refs/drafts/"
DRAFT_MESSAGE = "hammerola draft"

# How a build published before git is found in the history: the hub's import
# gives it a commit carrying this trailer, `<pid>/<build>` (src/store.py).
IMPORT_TRAILER = "Hammerola-Import"
# A revision published by `git push` is named by its commit.
COMMIT_NAME = re.compile(r"\A[0-9a-f]{40}\Z")
_RECORD = "\x1e"
_FIELD = "\x1f"


def remote_name(pid: str) -> str:
    return f"{REMOTE_PREFIX}{pid}"


def git(root, *args, env=None, check=True) -> subprocess.CompletedProcess:
    """`git <args>` in `root`, its output captured. Raises ClientError on failure."""
    try:
        done = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, encoding="utf-8",
            errors="replace", env=None if env is None else {**os.environ, **env})
    except OSError as error:
        raise ClientError(f"cannot run git: {error}") from error
    if check and done.returncode != 0:
        why = done.stderr.strip().splitlines()
        raise ClientError(f"`git {args[0]}` failed: "
                          f"{why[-1] if why else f'exit code {done.returncode}'}")
    return done


def _refuse_outside_a_repository(root) -> None:
    if git(root, "rev-parse", "--show-toplevel", check=False).returncode != 0:
        raise ClientError(
            f"{root} is not in a git repository, and the hub publishes "
            f"commits.\n"
            f"  `git init`, commit the project, then run `hammerola connect`.")


def _exists(root, ref: str) -> bool:
    return git(root, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}",
               check=False).returncode == 0


# -- connect -----------------------------------------------------------------
def connect(args) -> int:
    """Make this repository publish to the hub. -> exit code.

    Adds or corrects the remote `hammerola-<pid>`, includes the hub's headers
    (written first when the machine has none), fetches, and joins the hub's
    `main` into the local one when the two share no commit: a project
    published before git has its builds there as commits.
    """
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub_url = config.hub_url(root)
    _refuse_outside_a_repository(root)
    if not _exists(root, "HEAD"):
        raise ClientError(
            "this repository has no commit yet.\n"
            "  Commit the project (`git add -A && git commit`), then run "
            "`hammerola connect` again.")

    remote = remote_name(pid)
    url = f"{hub_url.rstrip('/')}/git/{pid}.git"
    if git(root, "remote", "get-url", remote, check=False).returncode == 0:
        git(root, "remote", "set-url", remote, url)
    else:
        git(root, "remote", "add", remote, url)

    settings = config.git_settings_file()
    if not settings.exists():
        # A machine logged in before `login` wrote git's headers: the same
        # headers, from the settings it stored.
        config.write_git_settings(hub_url, git_headers(
            config.edit_token(root), config.hub_basic_auth(root)))
    include = config.display_path(settings)
    included = git(root, "config", "--local", "--get-all", "include.path",
                   check=False).stdout.splitlines()
    if include not in included:
        git(root, "config", "--local", "--add", "include.path", include)

    # git's own progress and errors go to the terminal.
    if subprocess.run(["git", "fetch", remote], cwd=root).returncode != 0:
        raise ClientError(f"`git fetch {remote}` failed; its own words are "
                          f"above.")
    _join(root, pid, remote)

    branch = current_branch(root)
    print(f"connected {pid}: the remote {remote} is {url}")
    if unfit(branch):
        # No push to advise: the hub refuses this branch's push and draft.
        print(f"  {refusal(branch)}")
        return 0
    branch = branch or MAIN
    print(f"  A variant of the project is a branch. A version of {branch} is "
          f"a commit on it, published with")
    print(f"  git push {remote} {branch}")
    return 0


def _join(root, pid: str, remote: str) -> None:
    """Merge the hub's `main` into the local one, keeping the local tree.

    Into `main` whichever branch is checked out, and without a working copy:
    merging into the current branch of a worktree would leave `main` with no
    commit in common with the hub, and its push would be refused.
    """
    published = f"refs/remotes/{remote}/{MAIN}"
    if not _exists(root, published):
        # A new project: the hub's repository is empty.
        return
    if not _exists(root, MAIN_REF):
        raise ClientError(
            f"the hub has the published history of {pid} on {MAIN}, and this "
            f"repository has no\n"
            f"  branch {MAIN} to join it into. Create it (`git branch -m "
            f"<branch> {MAIN}` renames yours),\n"
            f"  then run `hammerola connect` again.")
    common = git(root, "merge-base", MAIN_REF, published, check=False)
    if common.returncode == 0:
        return
    if common.returncode != 1:
        git(root, "merge-base", MAIN_REF, published)
    old = git(root, "rev-parse", MAIN_REF).stdout.strip()
    joined = git(root, "commit-tree", f"{MAIN_REF}^{{tree}}", "-p", MAIN_REF,
                 "-p", published, "-m",
                 f"Join {pid}'s published history from the hub").stdout.strip()
    git(root, "update-ref", MAIN_REF, joined, old)
    print(f"joined the hub's published history into {MAIN}: {joined[:12]}, "
          f"with the tree of {MAIN} unchanged")


# -- build -------------------------------------------------------------------
def build(args) -> int:
    """Push the working copy as the draft of the branch checked out.
    -> git push's exit code.

    The draft is a commit made through a temporary index, so the author's
    index, HEAD and history are not touched; files git ignores are not in it,
    as they are not in a version. The hook builds it into the dev slot of the
    branch's variant, or answers `unchanged` when the slot already holds this
    tree. A branch name the hub cannot take as a variant is refused by the
    hook, in the same words as a push of that branch.
    """
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub_url = config.hub_url(root)
    _refuse_outside_a_repository(root)
    remote = remote_name(pid)
    if git(root, "remote", "get-url", remote, check=False).returncode != 0:
        raise ClientError(
            f"this repository has no remote {remote}: run `hammerola connect` "
            f"first.")
    branch = current_branch(root)
    if branch is None:
        raise ClientError(
            "HEAD is detached, and a draft is the draft of a branch: its "
            "variant.\n"
            "  `git switch <branch>` (or `git switch -c <name>`), then build.")
    update.refuse_if_behind(hub_url, root)

    commit = _draft_commit(root)
    command = ["git", "push", "--force"]
    if args.force:
        command += ["-o", "force"]
    command += [remote, f"{commit}:{DRAFT_PREFIX}{branch}"]
    pushed = subprocess.run(command, cwd=root)
    if pushed.returncode == 0:
        # The last line of the run: a bare URL, so it pastes as a link.
        print(f"{hub_url.rstrip('/')}{build_path(pid, 'dev', branch)}")
    return pushed.returncode


def _draft_commit(root) -> str:
    """A commit of the project directory as it is on disk, staged or not."""
    scratch = Path(tempfile.mkdtemp(prefix="hammerola-draft-"))
    try:
        index = scratch / "index"
        # Relative to `root`, where git was asked. No index yet leaves the copy
        # absent, which git reads as empty (an empty FILE it refuses).
        current = Path(root) / git(root, "rev-parse", "--git-path",
                                   "index").stdout.strip()
        if current.is_file():
            shutil.copyfile(current, index)
        env = {"GIT_INDEX_FILE": str(index)}
        git(root, "add", "-A", "--", ".", env=env)
        tree = git(root, "write-tree", env=env).stdout.strip()
        parent = ["-p", "HEAD"] if _exists(root, "HEAD") else []
        return git(root, "commit-tree", tree, *parent, "-m",
                   DRAFT_MESSAGE).stdout.strip()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# -- the code of a revision --------------------------------------------------
def revision_tree(root, pid: str, name: str) -> str:
    """`<commit>:<directory>`, the project's tree of one revision, for git.

    A revision published by a push is its commit, and the project is the
    directory holding the project.json with this id in that commit, wherever
    the project was then. A build published before git is the commit the
    import made of it, whose tree is the project's directory itself.
    """
    if COMMIT_NAME.match(name):
        if not _exists(root, name):
            _refuse_missing(pid, name)
        return f"{name}:{_project_directory(root, pid, name)}"
    wanted = f"{pid}/{name}"
    log = git(root, "log", "--all",
              f"--format=%H{_FIELD}%(trailers:key={IMPORT_TRAILER},valueonly,"
              f"separator=%x1f){_RECORD}").stdout
    for record in log.split(_RECORD):
        sha, _, values = record.strip("\n").partition(_FIELD)
        if wanted in values.split(_FIELD):
            return f"{sha}:"
    _refuse_missing(pid, name)


def _project_directory(root, pid: str, commit: str) -> str:
    """Where the project.json with id `pid` is in `commit`, "" for the root.

    The hub's pre-receive hook finds a pushed project the same way
    (`src/prereceive.py`), and refuses a commit holding more than one.
    `--full-tree`: from a subdirectory, `ls-tree` lists only what is below it.
    """
    listing = git(root, "ls-tree", "-r", "-z", "--full-tree", "--name-only",
                  commit).stdout
    for path in listing.split("\0"):
        if path != project.PROJECT_FILE and \
                not path.endswith(f"/{project.PROJECT_FILE}"):
            continue
        shown = git(root, "cat-file", "-p", f"{commit}:{path}", check=False)
        try:
            document = json.loads(shown.stdout)
        except ValueError:
            continue
        if isinstance(document, dict) and document.get("id") == pid:
            return path[:-len(project.PROJECT_FILE)].rstrip("/")
    raise ClientError(
        f"revision {commit} has no {project.PROJECT_FILE} with id {pid}, so "
        f"its code cannot be compared.")


def _refuse_missing(pid: str, name: str):
    raise ClientError(
        f"revision {name} is not in this repository.\n"
        f"  `git fetch {remote_name(pid)}` brings the hub's history "
        f"(`hammerola connect` sets that remote up).")


def code_diff(root, pid: str, old: str, new: str) -> str:
    """What `git diff` says between the project's trees of two revisions."""
    _refuse_outside_a_repository(root)
    return git(root, "diff", "--no-color", "--no-ext-diff",
               revision_tree(root, pid, old),
               revision_tree(root, pid, new)).stdout
