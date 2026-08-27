"""`hammerola source` and `hammerola log` — the code of a revision, and its log.

BOTH STAND ON ONE ROUTE PAIR the hub already serves (SPEC 7.8):

    GET /api/v1/sources/<revision>      the pushed body, byte for byte
    GET /api/v1/sources/<revision>/log  what that build printed

Behind the publishing secret, because the code is the one thing on this service
that is held and not shown: a build directory is public and cached for a year,
and the sources that produced it are not (SPEC 8, entry 17). That is the whole
reason `artifacts` is a separate verb rather than a flag on this one.

`source` NEVER WRITES OVER THE WORKING COPY BY DEFAULT, and that default is the
substance of the command rather than a preference. The obvious behaviour —
"restore this revision here" — eats whatever is uncommitted in the directory, and
the person running it is usually running it *because* they are unsure what state
the directory is in. So the ordinary form unpacks into a directory of its own and
the destructive form is a flag that additionally requires git to say the tree is
clean; then every file it replaces is one `git checkout` away.

`log` IS ADDRESSED THREE WAYS (SPEC 8, entry 26) because a build in the `dev`
slot has no revision at all:

    hammerola log              the newest revision this project has published
    hammerola log <revision>   that one
    hammerola log dev          what is in the local slot — see `_dev_log`, which
                               is the one of the three the hub cannot answer

The job id stays the emergency entrance for a build IN FLIGHT, where no revision
exists yet: `hammerola build` prints the id, and `GET /api/v1/jobs/<id>/log`
serves it.
"""

from pathlib import Path

from src.client import config, gitsuggest, pack, project, unpack
from src.client.errors import ClientError
from src.client.hub import QUERY_TIMEOUT, Hub
from src.client.limits import DEV_SLOT, SAFE_ID

# The moving name a revision argument may be spelled with. `dev` is deliberately
# not one of these: it is a slot, not a revision, and the two commands here are
# about things the store holds by revision.
LATEST = "latest"

# How much of a revision id goes into a default directory name. Twelve hex
# characters is the width of a project id (SPEC 3.1) and the width `git` shows a
# commit at — long enough to be unambiguous among a project's revisions, short
# enough to type and to read in a `ls`.
SHORT_ID_CHARS = 12

# What `hammerola log dev` has to say instead of a log. Spelled out here rather
# than inline because it is the one answer in this module that is about a
# LIMITATION, and it has to say what the limitation is rather than sounding like
# a failure of the command.
NO_DEV_LOG = (
    "the hub keeps no build log for the local slot.\n"
    "  `dev` is a slot and not a revision (SPEC 7.6): the next push overwrites "
    "it, there is\n"
    "  no history behind it, and the store is addressed by revision — so a "
    "`dev` build's log\n"
    "  exists only at the JOB that produced it.\n"
    "  `hammerola build` prints that log as it runs, and the job it names "
    "keeps serving it at\n"
    "  <hub>/api/v1/jobs/<id>/log. For a log that outlives the terminal, "
    "publish a revision:\n"
    "  `hammerola commit` stores the code and the log together.")


# Where anything this tool FETCHES lands by default, under the directory the
# command was run in. Hidden, and that is the whole point rather than tidiness:
# an unpacked revision written beside model.py is a directory `pack.collect`
# would put in the NEXT push — a source tree publishing a copy of an older
# source tree — and `pack` drops hidden entries, so a dot name is excluded by
# the rule that already exists instead of by a new list of names to remember.
SCRATCH_DIR = ".hammerola"

# Written into that directory the first time it is created. It makes git ignore
# the fetched trees AND the file itself, which matters for a second reason: the
# `git commit` this tool offers after a publish is `git add -A`, so an untracked
# directory here would otherwise be staged by the very command the tool printed.
SCRATCH_GITIGNORE = "# Written by hammerola. Fetched builds and sources.\n*\n"


def hub_for(root) -> Hub:
    return Hub(config.hub_url(root), config.publish_token(root),
               timeout=QUERY_TIMEOUT)


def scratch_dir(base, name: str):
    """`<base>/.hammerola/<name>`, with the directory and its .gitignore made.

    Shared with `artifacts`, because both commands bring something back from the
    hub and neither may drop it where the next push would pick it up.
    """
    root = Path(base) / SCRATCH_DIR
    try:
        root.mkdir(parents=True, exist_ok=True)
        marker = root / ".gitignore"
        if not marker.exists():
            marker.write_text(SCRATCH_GITIGNORE, encoding="utf-8")
    except OSError as error:
        raise ClientError(f"cannot create {root}: {error}") from error
    return root / name


def resolve_revision(hub: Hub, root, name: str) -> str:
    """A revision argument to the id the store is addressed by.

    `latest` is resolved HERE rather than passed through, because the store has
    no such name: it holds one directory per revision and the moving pointer
    lives in the project (`builds.json`). Resolving it needs the project, which
    is why a directory with no project.json can only ask for a revision by id.
    """
    if name == LATEST:
        return _latest_of(hub, root)
    if name == DEV_SLOT:
        raise ClientError(
            f"`{DEV_SLOT}` is the local slot, not a revision, and the hub "
            f"stores neither its code nor its log.\n"
            f"  Publish a revision with `hammerola commit` to get either.")
    if not SAFE_ID.match(name or ""):
        raise ClientError(
            f"{name!r} is not a revision id.\n"
            f"  A revision is named by the hub from the digest of its sources "
            f"(SPEC 7.7) — 64 hex\n"
            f"  characters. `hammerola status` lists the ones this project has, "
            f"or pass `{LATEST}`.")
    return name


def _latest_of(hub: Hub, root) -> str:
    """What `latest` points at for the project in this directory."""
    if root is None:
        raise ClientError(
            f"`{LATEST}` names the newest revision OF A PROJECT, and there is "
            f"no project.json here or\n"
            f"  in any parent directory. Run this in a model's directory, or "
            f"pass a revision id.")
    pid = project.read_project_id(root)
    picker = hub.builds(pid)
    if picker is None:
        raise ClientError(
            f"the hub has nothing for project {pid} yet — nothing has been "
            f"published from here.")
    latest = picker.get(LATEST)
    if not latest:
        raise ClientError(
            f"project {pid} has no published revision yet: `{LATEST}` points at "
            f"nothing.\n"
            f"  `hammerola build` fills the dev slot without publishing one; "
            f"`hammerola commit` publishes.")
    return latest


# -- source ------------------------------------------------------------------
def run_source(args) -> int:
    """Fetch one revision's code and unpack it. -> exit code."""
    root = project.optional_project_root(args.directory)
    hub = hub_for(root)
    revision = resolve_revision(hub, root, args.revision)

    body = hub.revision_archive(revision)

    if getattr(args, "into_working_copy", False):
        return _into_working_copy(root, revision, body)

    dest = _fresh_directory(args, f"source-{revision[:SHORT_ID_CHARS]}")
    names = unpack.extract(body, dest, where=f"the code of {revision}")
    print(f"{revision}")
    print(f"  {len(names)} files -> {dest}")
    print(f"  {len(body) / 1e3:.1f} kB as it was pushed")
    return 0


def _fresh_directory(args, default_name: str) -> Path:
    """Where to unpack, and the refusal to unpack into something already there.

    A directory that exists and is EMPTY is fine — `mkdir out && hammerola
    source <rev> -o out` is an ordinary thing to type. One with anything in it is
    refused rather than merged into: a merge produces a tree that is neither the
    revision nor what was there before, and nothing afterwards can tell which
    file came from where.

    `-o` is taken as given, including a path inside the project: somebody who
    names a directory has said where they want it. Only the DEFAULT is steered
    into `.hammerola/`, because a default is what lands somewhere nobody chose.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = getattr(args, "output", None)
    dest = (Path(given).expanduser() if given
            else scratch_dir(base, default_name))
    if not dest.is_absolute():
        dest = (base / dest).resolve()
    if dest.exists():
        if not dest.is_dir():
            raise ClientError(f"{dest} exists and is not a directory")
        if any(dest.iterdir()):
            raise ClientError(
                f"{dest} already has something in it, and this will not unpack "
                f"into a directory\n"
                f"  that is not empty. Pass `-o DIR` for somewhere else, or "
                f"empty that one first.")
    return dest


def _into_working_copy(root, revision: str, body: bytes) -> int:
    """Make the working copy BE this revision. Only on a clean git tree.

    THE FLAG IS NOT THE SAFETY, GIT IS. What this does is destructive by
    definition — it replaces the files in a directory somebody is working in —
    and the only reason it is offered at all is that a clean tree makes every
    byte it touches recoverable with `git checkout`. Without a repository there
    is no undo, so there is no way to ask for this.

    WHAT IT REMOVES is the narrowest set that still makes the answer true: files
    git TRACKS, which `pack` would publish, and which this revision does not
    have. Tracked, because those are exactly the ones git can give back;
    publishable, because those are the ones that decide what the next push is.
    Anything else — a gitignored `data.csv`, `.env`, `out/`, `.venv` — is left
    where it is and named in the output, because deleting a file git cannot
    restore is not something a `--flag` should be able to buy.
    """
    if root is None:
        raise ClientError(
            "there is no project.json here or in any parent directory, so "
            "there is no working copy\n"
            "  to write over. Run this in a model's directory.")
    if not gitsuggest.is_repository(root):
        raise ClientError(
            f"{root} is not a git repository, so nothing here can be undone.\n"
            f"  Without git this flag has no safety net at all — unpack into a "
            f"directory of its own\n"
            f"  instead (that is what this command does without the flag).")
    dirty = gitsuggest.uncommitted(root)
    if dirty:
        listed = "\n".join(f"    {line}" for line in dirty[:10])
        more = f"\n    ... and {len(dirty) - 10} more" if len(dirty) > 10 else ""
        raise ClientError(
            f"the working copy has uncommitted changes, and writing over it "
            f"would eat them:\n{listed}{more}\n"
            f"  Commit or stash first. Without the flag this unpacks into a "
            f"directory of its own,\n"
            f"  which needs nothing to be clean.")

    members = unpack.read_members(body, where=f"the code of {revision}")
    tracked = set(gitsuggest.tracked_files(root))
    publishable = {name for name, _path in pack.collect(root)}

    removed = sorted((tracked & publishable) - set(members))
    left = sorted(publishable - tracked - set(members))

    for name in removed:
        try:
            (root / name).unlink()
        except OSError as error:
            raise ClientError(f"cannot remove {name}: {error}") from error
    unpack.extract(body, root, where=f"the code of {revision}")

    print(f"{revision}")
    print(f"  {len(members)} files written into {root}")
    if removed:
        print(f"  {len(removed)} removed (tracked by git, not in this "
              f"revision): {', '.join(removed)}")
    if left:
        # Named rather than removed: git cannot give these back.
        print(f"  {len(left)} left alone (git does not track them, so nothing "
              f"could restore them): {', '.join(left)}")
    print("  `git diff` now shows what this revision changed against the "
          "commit you were on.")
    return 0


# -- log ---------------------------------------------------------------------
def run_log(args) -> int:
    """Print the build log of a revision, of `latest`, or explain `dev`."""
    root = project.optional_project_root(args.directory)
    target = getattr(args, "revision", None) or LATEST
    if target == DEV_SLOT:
        return _dev_log()

    hub = hub_for(root)
    revision = resolve_revision(hub, root, target)
    text = hub.revision_log(revision)

    print(f"--- build log of {revision} ---")
    if text.strip():
        print(text if text.endswith("\n") else text + "\n", end="")
    else:
        # An empty log is a real answer: the hub stores one for every published
        # revision, and a build can publish without printing anything.
        print("(the build printed nothing)")
    print("--- end of build log ---")
    return 0


def _dev_log() -> int:
    """The one address of the three that the hub cannot answer, said plainly.

    Not a bug and not an oversight: nothing is stored for the local slot, on
    purpose (SPEC 7.8 — an entry in the store that no published revision points
    at is one the store cannot answer for). Answering with `latest`'s log
    instead would be worse than refusing: the two are different builds, and a
    log that silently belongs to something else is how an afternoon goes.
    """
    raise ClientError(NO_DEV_LOG)
