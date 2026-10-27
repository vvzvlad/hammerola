"""`hammerola log` — a build log read again — and what the verbs that address a
revision share.

`log` is addressed three ways, because a build in the `dev` slot has no
revision:

    hammerola log              the newest revision this project has published
    hammerola log <revision>   that one, from `GET /api/v1/logs/<pid>/<revision>`
    hammerola log dev          what is in the local slot — see `_dev_log`, which
                               reaches the log through the JOB the slot names

`latest` and `dev` are those of the variant of the branch checked out
(`variant.current_variant`), as everywhere in the client.

The code of a revision is in git: a revision is a commit, and a build
published before git is the commit the hub's import made of it
(`repo.revision_tree`).
"""

from pathlib import Path

from hammerola import config, project
from hammerola.errors import ClientError
from hammerola.hub import QUERY_TIMEOUT, Hub, HubError
from hammerola.limits import DEV_SLOT, SAFE_ID
from hammerola.variant import current_variant

# The moving name a revision argument may be spelled with. `dev` is a slot,
# not a revision.
LATEST = "latest"

# How much of a revision id goes into a default directory name: the width of a
# project id (SPEC 3.1).
SHORT_ID_CHARS = 12


# Where anything this tool fetches lands by default. Hidden, and ignored by git
# through the file below, so fetched files never end up in a commit.
SCRATCH_DIR = ".hammerola"

# Makes git ignore the directory, so `git add -A` does not stage it.
SCRATCH_GITIGNORE = "# Written by hammerola. Fetched builds and sources.\n*\n"


def hub_for(root) -> Hub:
    """The hub handle every project-addressing verb builds. -> Hub.

    Shared by `admin`, `artifacts`, `proposal`, `queue`, `revdiff`, `sources`
    and `status`.
    """
    return Hub(config.hub_url(root), config.edit_token(root),
               timeout=QUERY_TIMEOUT, basic_auth=config.hub_basic_auth(root))


def public_hub(hub_url: str, root=None) -> Hub:
    """The hub handle for the routes that present no secret. -> Hub.

    Used by `create`'s template download, `skill`, `skill update`, `update` and
    the version check before a draft is pushed. The empty token is deliberate: `/start`
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

    `latest` is resolved here from the project's `builds.json`.
    """
    if name == LATEST:
        return _latest_of(hub, root)
    if name == DEV_SLOT:
        # The slot is no commit; its log is read via `_dev_log`.
        raise ClientError(
            f"`{DEV_SLOT}` is the local slot, not a revision.\n"
            f"  A revision is a commit published with `git push`. The slot's "
            f"build log is read\n"
            f"  with `hammerola log {DEV_SLOT}`, through the job the slot "
            f"names.")
    if not SAFE_ID.match(name or ""):
        raise ClientError(
            f"{name!r} is not a revision id.\n"
            f"  A revision is named by its commit (40 hex characters), or by "
            f"the name a build\n"
            f"  published before git had. `hammerola status` lists the ones "
            f"this project has, or pass `{LATEST}`.")
    return name


def _latest_of(hub: Hub, root) -> str:
    """What `latest` of this directory's variant points at."""
    pid = project.read_project_id(root)
    variant = current_variant(root)
    picker = hub.builds(pid, variant)
    if picker is None:
        raise ClientError(
            f"the hub has nothing for variant {variant} of project {pid} yet — "
            f"nothing has been published from here.")
    latest = picker.get(LATEST)
    if not latest:
        raise ClientError(
            f"variant {variant} of project {pid} has no published revision "
            f"yet: `{LATEST}` points at nothing.\n"
            f"  `hammerola build` fills the dev slot without publishing one; "
            f"`git push` publishes.")
    return latest


# -- log ---------------------------------------------------------------------
def run_log(args) -> int:
    """Print the build log of a revision, of `latest`, or of the local slot."""
    root = project.find_project_root(args.directory)
    target = args.revision or LATEST
    hub = hub_for(root)
    if target == DEV_SLOT:
        return _dev_log(hub, root)

    revision = resolve_revision(hub, root, target)
    text = hub.build_log(project.read_project_id(root), revision)

    print(f"--- build log of {revision} ---")
    if text.strip():
        print(text if text.endswith("\n") else text + "\n", end="")
    else:
        # A build can publish without printing anything.
        print("(the build printed nothing)")
    print("--- end of build log ---")
    return 0


def _dev_log(hub: Hub, root) -> int:
    """The log of the build that last filled the local slot of this
    directory's variant.

    Logs are stored per revision (SPEC 7.8), so the slot's meta.json names the
    job that filled it, and that job serves the log.

    The header says which kind of push filled the slot: a `build` leaves `dev`
    as its job's commit, a version mirrors itself into the slot with its
    revision.
    """
    pid = project.read_project_id(root)
    variant = current_variant(root)
    meta = hub.build_meta(pid, DEV_SLOT, variant)
    if meta is None:
        raise ClientError(
            f"variant {variant} of project {pid} has no `{DEV_SLOT}` slot on "
            f"{hub.url}: nothing has filled it yet.\n"
            f"  `hammerola build` fills it with the working copy as it stands, "
            f"and `git push`\n"
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
