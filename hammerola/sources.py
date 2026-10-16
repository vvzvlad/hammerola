"""`hammerola source` and `hammerola log` — the code of a revision, and its log.

BOTH STAND ON ONE ROUTE PAIR the hub already serves (SPEC 7.8):

    GET /api/v1/sources/<revision>      the pushed body, byte for byte
    GET /api/v1/sources/<revision>/log  what that build printed

Behind the token: a build directory is public, the sources that produced it
are not (hence `artifacts` is a separate verb).

`source` never writes over the working copy by default: it unpacks into its own
directory. Writing over the working copy is a flag that also requires a clean
git tree, so every replaced file is one `git checkout` away.

`log` is addressed three ways, because a build in the `dev` slot has no
revision:

    hammerola log              the newest revision this project has published
    hammerola log <revision>   that one
    hammerola log dev          what is in the local slot — see `_dev_log`, which
                               reaches the log through the JOB the slot names

A build in flight has no revision yet: `hammerola build` prints its job id,
and `GET /api/v1/jobs/<id>/log` serves the log.
"""

from pathlib import Path

from hammerola import config, gitsuggest, pack, project, unpack
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError
from hammerola.limits import DEV_SLOT, SAFE_ID

# The moving name a revision argument may be spelled with. `dev` is a slot,
# not a revision.
LATEST = "latest"

# How much of a revision id goes into a default directory name: the width of a
# project id (SPEC 3.1).
SHORT_ID_CHARS = 12


# Where anything this tool fetches lands by default. Hidden, so `pack` drops it
# and fetched trees never end up in the next push.
SCRATCH_DIR = ".hammerola"

# Makes git ignore the directory, so the offered `git add -A` does not stage
# it.
SCRATCH_GITIGNORE = "# Written by hammerola. Fetched builds and sources.\n*\n"


def hub_for(root) -> Hub:
    """The hub handle every project-addressing verb builds. -> Hub.

    Shared by `admin`, `artifacts`, `proposal`, `queue`, `revdiff`, `sources`
    and `status`. Publishing does not use it: `cli.py` builds its own with the
    longer push timeout.
    """
    return Hub(config.hub_url(root), config.edit_token(root),
               timeout=QUERY_TIMEOUT, basic_auth=config.hub_basic_auth(root))


def public_hub(hub_url: str, root=None) -> Hub:
    """The hub handle for the routes that present no secret. -> Hub.

    Used by `create`'s template download, `skill`, `skill update`, `update` and
    the version check before a publish. The empty token is deliberate: `/start`
    and the files it names are public (`src/onboarding.py`). Takes an address:
    none of these verbs addresses a project. `root` is only where to look for
    `HUB_BASIC_AUTH`, since a password proxy in front of the hub stands in front
    of the public routes too; `create` passes the directory it is making.
    """
    return Hub(hub_url, "", timeout=QUERY_TIMEOUT,
               basic_auth=config.hub_basic_auth(root))


def scratch_dir(base, name: str):
    """`<base>/.hammerola/<name>`, with the directory and its .gitignore made.

    Shared with `artifacts` and `queue`.
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

    `latest` is resolved here from the project's `builds.json` (the store has
    no such name), so it needs a project.json.
    """
    if name == LATEST:
        return _latest_of(hub, root)
    if name == DEV_SLOT:
        # The slot has no stored code; its log is read via `_dev_log`.
        raise ClientError(
            f"`{DEV_SLOT}` is the local slot, not a revision, and the hub "
            f"stores no code for it.\n"
            f"  Publish a revision with `hammerola commit` to read the "
            f"sources. The slot's build log\n"
            f"  needs no commit: `hammerola log {DEV_SLOT}` reads it through "
            f"the job the slot names.")
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

    if args.into_working_copy:
        return _into_working_copy(root, revision, body)

    dest = _fresh_directory(args, f"source-{revision[:SHORT_ID_CHARS]}")
    names = unpack.extract(body, dest, where=f"the code of {revision}")
    print(f"{revision}")
    print(f"  {len(names)} files -> {dest}")
    print(f"  {len(body) / 1e3:.1f} kB as it was pushed")
    return 0


def _fresh_directory(args, default_name: str) -> Path:
    """Where to unpack, and the refusal to unpack into something already there.

    An existing empty directory is fine; a non-empty one is refused rather
    than merged into. `-o` is taken as given; only the default goes under
    `.hammerola/`.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = args.output
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

    The safety is git: a clean tree makes every touched byte recoverable with
    `git checkout`, so there is no way to ask for this without a repository.

    It removes only files that git tracks, `pack` would publish, and this
    revision lacks. Anything else (gitignored files, `.env`, `out/`) is left
    and named, because git could not restore it.
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
    """Print the build log of a revision, of `latest`, or of the local slot."""
    root = project.optional_project_root(args.directory)
    target = args.revision or LATEST
    hub = hub_for(root)
    if target == DEV_SLOT:
        # The slot belongs to a project, unlike a globally unique revision.
        return _dev_log(hub, project.find_project_root(args.directory))

    revision = resolve_revision(hub, root, target)
    text = hub.revision_log(revision)

    print(f"--- build log of {revision} ---")
    if text.strip():
        print(text if text.endswith("\n") else text + "\n", end="")
    else:
        # A build can publish without printing anything.
        print("(the build printed nothing)")
    print("--- end of build log ---")
    return 0


def _dev_log(hub: Hub, root) -> int:
    """The log of the build that last filled the local slot.

    Logs are stored per revision (SPEC 7.8), so the slot's meta.json names the
    job that filled it, and that job serves the log.

    The header says which kind of push filled the slot: a `build` leaves `dev`
    as its job's commit, a `commit` mirrors itself into the slot with its
    revision.
    """
    pid = project.read_project_id(root)
    meta = hub.build_meta(pid, DEV_SLOT)
    if meta is None:
        raise ClientError(
            f"project {pid} has no `{DEV_SLOT}` slot on {hub.url}: nothing has "
            f"filled it yet.\n"
            f"  `hammerola build` fills it with the working copy as it stands, "
            f"and `hammerola commit`\n"
            f"  fills it with the revision it publishes.")
    job = meta.get("job")
    if not job:
        raise ClientError(
            f"the `{DEV_SLOT}` slot of project {pid} does not say which job "
            f"filled it, so there is\n"
            f"  nothing to read the log of: it was written before the hub "
            f"recorded that. `hammerola build`\n"
            f"  fills the slot again and records the job with it.")

    # The record only decorates the header; failing to get it is not fatal.
    record = None
    try:
        record = hub.job(job)
    except HubError:
        pass

    try:
        text = hub.job_log(job)
    except HubError as error:
        # Only a 404 means the job is gone. Other failures (stale token,
        # unreachable hub) already carry their own sentence and are passed
        # through.
        if error.status != 404:
            raise ClientError(
                f"the `{DEV_SLOT}` slot of project {pid} names job {job}, and "
                f"reading its log from\n"
                f"  {hub.url} failed:\n"
                f"  {error}") from error
        raise ClientError(
            f"the `{DEV_SLOT}` slot of project {pid} names job {job}, and "
            f"{hub.url} does not have it.\n"
            f"  A job id means nothing on another hub, and jobs are kept with "
            f"no retention at all — so\n"
            f"  the usual causes are a configured hub that is not the one that "
            f"built this, and a volume\n"
            f"  that has been wiped. `hammerola build` fills the slot "
            f"again.") from error

    print(f"--- build log of job {job}{_filled_the_slot(record)} ---")
    if text.strip():
        print(text if text.endswith("\n") else text + "\n", end="")
    else:
        # Unlike a revision's, a job's log is empty while it is still queued or
        # building.
        print("(nothing in this job's log yet)")
    print("--- end of build log ---")
    return 0


def _filled_the_slot(record) -> str:
    """The parenthesis of the header: which push this was, and how it ended."""
    if record is None:
        return ""
    commit = record.get("commit")
    push = "build" if commit == DEV_SLOT else f"commit {commit}"
    return f" ({push}, state {record.get('state')})"
