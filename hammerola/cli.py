"""The `hammerola` command: its verbs, its dispatch, and its exit code.

    login                     store the hub's address and the one password
    create                    start a project: a fresh id, and the template
    build                     sources -> the dev slot, and print the build log
    commit -m "..."           sources -> an immutable revision the hub names
    status                    latest, dev, and the revisions that exist
    source <revision>         fetch the CODE of a revision, under the secret
    artifacts <revision>      fetch the STL/STEP/3MF, which a link can open
    diff <rev> <rev>          what moved: the geometry, and the source
    log [dev|<revision>]      read a build log again
    comments                  the project's comment queue
    comments resolve <id>     close one, with an optional note
    comments files <id>       save its photo and frame to disk
    proposal                  the rough body a person drew over the model
    proposal rm               remove it — asks for the project id to be typed
    skill                     the agent instructions: this machine's, and the hub's
    skill update              write the hub's copy over the installed one
    update                    write the hub's copy of THIS TOOL over itself
    rename "New title"        change the project's TITLE — never its id
    rm                        remove the project from the hub, whole

This module parses, dispatches and owns the publishing flow (`build` and
`commit`); every other verb lives in its own module: `setup.py` (login,
create), `status.py`, `queue.py` (comments), `proposal.py`, `sources.py`
(source, log), `artifacts.py`, `revdiff.py` (diff), `admin.py` (rename, rm),
`skill.py`, `update.py`. They all RAISE on refusal, so `main` below is the one
place that decides what a failure looks like.

  * `source` and `artifacts` are separate verbs because artefacts open to a
    link that carries their key and code opens to nothing but the secret.
  * `source` unpacks into its own directory; writing over the working copy is
    a flag that also requires a clean git tree.
  * `rename` changes the TITLE. Nothing changes an id: every permanent URL of
    the project is built from it (SPEC §3.1).
  * `rm` removes the whole project and asks first. A single build cannot be
    removed: that would break a permanent URL.
  * `update` writes the hub's zipapp over the running file, verified and via a
    rename (`update.py`). `build` and `commit` refuse to publish from a client
    older than the one the hub serves.

THE PUBLISHING FLOW. Pack the working directory, POST it, poll the job, print
the build log, and return zero only if a build was published:

    build           -> <pid>/dev        the local slot: overwritten by every
                                        push, no history, `latest` untouched,
                                        served no-cache (SPEC 7.6).
    commit          -> <pid>            an immutable revision. The HUB names it
                                        from the sources and says so in the
                                        reply; `latest` moves to it.

`commit` means "publish a version" and has nothing to do with git: nothing here
reads HEAD or needs a repository. Afterwards a `git commit` line is printed as
an offer (`gitsuggest`), never run.

The exit code replaces a forge's job status: zero means a build was published.
A refused push, a failed model, a gate, an unreachable hub and a timeout are all
non-zero, each with a sentence saying which, plus the log when the build ran.
"""

import argparse
import sys
from datetime import datetime

from hammerola import (admin, artifacts, config, gitsuggest, project, proposal,
                       queue, revdiff, setup, skill, sources, status, update)
from hammerola.errors import ClientError
from hammerola.hub import (JOB_TIMEOUT, PROXY_REFUSED, SLOW_BUILD_SECONDS,
                           UNAUTHORIZED, Hub, HubError, quoted)
from hammerola.limits import DEV_SLOT, MAX_TEXT_CHARS
from hammerola.pack import PackError, pack

EXIT_OK = 0
EXIT_FAILED = 1
# Conventional for an interrupted process, and it keeps Ctrl-C out of the
# "the build failed" bucket that a caller may act on.
EXIT_INTERRUPTED = 130


def _fail(message: str) -> int:
    """Say why, on stderr, and hand back the failing exit code.

    Stdout is flushed first: it is block-buffered when piped and stderr is
    not, so otherwise the reason lands above the build log that explains it.
    """
    sys.stdout.flush()
    print(f"hammerola: {message}", file=sys.stderr)
    return EXIT_FAILED


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hammerola",
        description="Build a model on the hammerola hub and ask it questions.")
    parser.add_argument(
        "-C", "--directory", metavar="DIR", default=None,
        help="run as if started in DIR (default: the current directory)")

    commands = parser.add_subparsers(dest="command", required=True)

    enter = commands.add_parser(
        "login", help="store the hub's address and password on this machine, "
                      "and a password proxy's login if one stands in front")
    enter.add_argument(
        "url", nargs="?", default=None,
        help="the hub's address; asked for if it is not given. THE PASSWORD IS "
             "NEVER AN ARGUMENT — it is read from the terminal, because an "
             "argument reaches the shell's history and every `ps` on the "
             "machine")

    start = commands.add_parser(
        "create",
        help="start a project: a project.json with a fresh id, plus the "
             "starter template")
    start.add_argument(
        "--title", default=None,
        help="the name shown on the site (default: the directory's own name)")
    start.add_argument(
        "--no-template", action="store_true",
        help="write only the project.json. The id is minted locally either "
             "way; this is what makes `create` need no hub, no address and no "
             "secret — for a directory that already has a model, or a machine "
             "with nothing to reach")

    dev = commands.add_parser(
        "build", help="publish the working copy into the project's dev slot")
    _add_common(dev)

    revision = commands.add_parser(
        "commit", help="publish an immutable revision; the hub names it")
    revision.add_argument(
        "-m", "--message", default=None,
        help="what this revision is. It is stored with the revision and shown "
             "in the build picker, and it becomes the subject of the git "
             "commit suggested afterwards")
    _add_common(revision)

    state = commands.add_parser(
        "status", help="what the hub has for this project: latest, dev, builds")
    state.add_argument(
        "-n", "--limit", type=int, default=status.DEFAULT_LIMIT, metavar="COUNT",
        help=f"how many revisions to list (default: {status.DEFAULT_LIMIT})")

    code = commands.add_parser(
        "source", help="fetch the source tree a revision was built from")
    code.add_argument(
        "revision",
        help="a revision id, or `latest` for the newest one this project has")
    code.add_argument(
        "-o", "--output", metavar="DIR", default=None,
        help="unpack here instead of into `source-<revision>` (the directory "
             "has to be empty or absent)")
    code.add_argument(
        "--into-working-copy", action="store_true",
        help="write over the working copy instead. Refused unless this is a "
             "git repository with nothing uncommitted in it — that is the only "
             "thing that can undo it")

    models = commands.add_parser(
        "artifacts", help="fetch the STL/STEP/3MF files a build published")
    models.add_argument(
        "revision",
        help="a revision id, `latest`, or `dev` for the local slot")
    models.add_argument(
        "-o", "--output", metavar="DIR", default=None,
        help="write here instead of into `artifacts-<revision>`")

    changes = commands.add_parser(
        "diff", help="what changed between two revisions, in geometry and code")
    changes.add_argument("old", metavar="REVISION",
                         help="the older revision, or `latest`")
    changes.add_argument("new", metavar="REVISION",
                         help="the newer revision, or `latest`")
    # Mutually exclusive: `--json` is the whole output, and `--material` adds a
    # section to the printed output that `--json` replaces.
    answer = changes.add_mutually_exclusive_group()
    # The exit code is the same either way — `diff` returns 0 whether or not
    # anything moved, and something reading the JSON is reading it to find that
    # out.
    answer.add_argument(
        "--json", action="store_true",
        help="print only what moved in each PART's physical numbers — volume, "
             "bounding box, first layer, overhang — as one JSON document. The "
             "assembly's own numbers are not in it")
    # A flag, not the default: the hub fuses two solids per part in the CAD
    # kernel, which takes as long as a build.
    answer.add_argument(
        "--material", action="store_true",
        help="also ask the hub to measure how much material each part gained "
             "and lost, which runs the CAD kernel and takes as long as a build")

    logs = commands.add_parser(
        "log", help="print a build log again")
    logs.add_argument(
        "revision", nargs="?", default=None,
        help="a revision id, or `dev` for the local slot. Default: the newest "
             "revision this project has published")

    notes = commands.add_parser(
        "comments", help="read this project's comment queue")
    notes.add_argument(
        "--all", action="store_true",
        help="list resolved comments too (default: only the open ones)")
    notes.add_argument(
        "--since", default=None, metavar="TIMESTAMP",
        help="only comments written at or after this ISO-8601 moment")
    # A sub-subcommand rather than a `--resolve` flag, so a read never turns
    # into a write by a flag. Optional: `hammerola comments` alone still lists.
    queue_commands = notes.add_subparsers(dest="comment_command")
    close = queue_commands.add_parser(
        "resolve", help="mark one comment handled, so it is not done twice")
    close.add_argument(
        "id", help="the comment id, as `hammerola comments` prints it")
    close.add_argument(
        "-m", "--note", default=None,
        help="what was done about it; stored with the comment")
    attachments = queue_commands.add_parser(
        "files", help="download this comment's photo and frame")
    attachments.add_argument(
        "id", help="the comment id, as `hammerola comments` prints it")
    attachments.add_argument(
        "-o", "--output", metavar="DIR", default=None,
        help="write here instead of into `.hammerola/comments`")

    drawing = commands.add_parser(
        "proposal",
        help="the rough body somebody drew over this model in the browser — "
             "the motor it has to clear, the wall it bolts to — as numbers to "
             "design against. One per project, and it is never resolved")
    # A sub-subcommand rather than a `--rm` flag, as with `comments resolve`.
    # Optional: `hammerola proposal` alone still reads.
    proposal_commands = drawing.add_subparsers(dest="proposal_command")
    forget = proposal_commands.add_parser(
        "rm",
        help="remove the stored proposal. The project id has to be typed at "
             "the prompt, and this cannot be undone: somebody drew it by hand, "
             "the hub keeps no copy, and it is in no build")
    # `--yes` lives on `rm` alone and `proposal` takes no flag, so the
    # subparser-default trap described on `skill update` below does not arise.
    forget.add_argument(
        "--yes", action="store_true",
        help="do not ask. Without it the project id has to be typed at the "
             "prompt — nothing can bring the proposal back")

    # Nothing else in this tool looks at the agent's skills directory (see
    # `skill.py` for why there is no automatic check).
    instructions = commands.add_parser(
        "skill",
        help="the agent instructions: whether the copy installed here is the "
             "one the hub serves")
    instructions.add_argument(
        "--path", default=None, metavar="DIR",
        help=f"the directory the skill is installed in (default: "
             f"{skill.DEFAULT_PATH})")
    # A sub-subcommand rather than an `--update` flag, as with
    # `comments resolve`. Optional: `hammerola skill` alone still asks.
    skill_commands = instructions.add_subparsers(dest="skill_command")
    refresh = skill_commands.add_parser(
        "update", help="write the hub's copy over the installed skill")
    # SUPPRESS, not None: a subparser copies every key of its namespace onto
    # the parent's, defaults included, so `default=None` would make
    # `skill --path DIR update` silently drop DIR. With SUPPRESS the attribute
    # exists only when the flag is given, so both orders mean the same.
    refresh.add_argument(
        "--path", default=argparse.SUPPRESS, metavar="DIR",
        help=f"the directory to install into: a new or empty one, or an "
             f"earlier install of this skill, from which files the new "
             f"version no longer ships are removed "
             f"(default: {skill.DEFAULT_PATH})")

    # No `--path`: `update` always writes the file it is running from
    # (`update._target`).
    commands.add_parser(
        "update",
        help="write the hub's copy of this tool over the file it is running "
             "from, and print what changed between the two versions")

    # No `--id`: renaming an id would break every permanent URL (SPEC §3.1).
    title = commands.add_parser(
        "rename", help="change the project's title (never its id)")
    title.add_argument(
        "title", help="the new name, as it appears on the site")

    drop = commands.add_parser(
        "rm", help="remove this project from the hub, with everything in it")
    drop.add_argument(
        "--yes", action="store_true",
        help="do not ask. Without it the project id has to be typed at the "
             "prompt — this cannot be undone and the hub keeps no copy")

    return parser


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--timeout", type=float, default=JOB_TIMEOUT, metavar="SECONDS",
        help=f"how long to wait for the build (default: {JOB_TIMEOUT:.0f})")
    # Skips only the model's own `checks()` (most of a build's time). The hub's
    # gates — provenance, catalogue, view gates, per-part gates in
    # `export_printables` — still run and refuse a forced push like any other.
    parser.add_argument(
        "--force", action="store_true",
        help="publish without running the model's own checks(). The hub's own "
             "gates still run and still refuse")


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return HANDLERS[args.command](args)
    except (config.ConfigError, project.ProjectError, PackError,
            ClientError, HubError) as error:
        # Every deliberate refusal carries a finished sentence.
        return _fail(str(error))
    except KeyboardInterrupt:
        sys.stdout.flush()
        print("\nhammerola: interrupted. A build already queued goes on "
              "running on the hub.", file=sys.stderr)
        return EXIT_INTERRUPTED


def _publish(args) -> int:
    root = project.find_project_root(args.directory)

    # Read before the tree is walked, so a missing HUB_URL fails in a second.
    # The address has no default.
    hub_url = config.hub_url(root)
    token = config.edit_token(root)

    pid = project.read_project_id(root)
    # `dev` for the slot, nothing for a revision: no last path segment asks the
    # hub to name it (`Hub.publish`).
    slot = DEV_SLOT if args.command == "build" else None
    # `getattr`: both verbs land here and only `commit` has `-m`.
    message = getattr(args, "message", None)
    # A courtesy that saves packing a push the hub will refuse; the hub's 400
    # (`render.revision_message`) is the authority and the only place the other
    # rules (control characters, angle brackets) live. Stripped before it is
    # measured, as the hub does, so a trailing newline is not counted.
    if message is not None:
        subject = message.strip()
        if not subject:
            # `-m ""` never becomes a header, so the hub cannot refuse it.
            raise ClientError(
                "the revision message must not be empty.\n"
                "  Say what this revision is, or leave `-m` off.")
        if len(subject) > MAX_TEXT_CHARS:
            raise ClientError(
                f"the revision message is {len(subject)} characters; the hub "
                f"shows at most {MAX_TEXT_CHARS} and refuses a longer one.\n"
                f"  Shorten it.")

    # Built before `pack`: `Hub.__init__` validates the address and the token
    # (`hub._origin`) without opening a connection, so a malformed one fails
    # before the tree is packed.
    hub = Hub(hub_url, token, basic_auth=config.hub_basic_auth(root))

    # Before packing, so an outdated client fails fast. Only publishing verbs
    # ask (see `update.refuse_if_behind`). Takes the address, not `hub`, which
    # carries the push's five-minute timeout.
    update.refuse_if_behind(hub_url, root)

    archive = pack(root)

    title = project.read_project_title(root)
    # Where, which project, into what: printed right before the upload so a
    # transcript shows which project was written to.
    print(f"publishing to {hub_url} as {title or '?'} ({pid}) -> "
          f"{slot or 'a new revision'}")
    print(f"  {len(archive.names)} files, {archive.size / 1e3:.1f} kB packed")
    sys.stdout.flush()

    # `code` and not `status`, because `status` is a module of this package.
    code, payload = hub.publish(pid, archive.body, slot=slot, force=args.force,
                                message=message)

    if code == 200:
        # `Store.settled`: this exact source tree is already published under
        # this name, so nothing was rebuilt. A revision's name is the digest of
        # its sources, so "unchanged" and "already published" coincide.
        print("unchanged: the hub already has this exact source, nothing rebuilt")
        _print_revision(payload.get("revision"))
        return _published(hub, payload.get("url"), root,
                          revision=payload.get("revision"), message=message)

    # Named separately: the fix is a different command (`login`).
    if code == 401:
        return _fail(PROXY_REFUSED)
    if code == 403:
        return _fail(UNAUTHORIZED)

    if code != 202:
        # Quoted, like every place a reply's own words reach the terminal.
        return _fail(f"the hub refused the push with HTTP {code}: "
                     f"{quoted(payload.get('error', payload))}")

    # Revision and job look alike; both are labelled so a job id is not
    # mistaken for a revision.
    _print_revision(payload.get("revision"))
    job_id = payload.get("job")
    if not job_id:
        raise HubError(
            f"the hub accepted the push but named no job: {quoted(payload)}")
    print(f"queued as job {job_id}: this build's progress and its log")
    sys.stdout.flush()

    # Build states go to stdout; connection notices go to stderr.
    record = hub.await_job(job_id, timeout=args.timeout,
                           on_state=lambda state: print(f"  {state}",
                                                        flush=True),
                           on_notice=lambda note: print(f"  {note}",
                                                        file=sys.stderr,
                                                        flush=True))

    _print_log(hub, job_id, record)
    # Before the verdict, so failed builds report their duration too.
    _print_duration(record)

    if record.get("state") == "done":
        return _published(hub, record.get("build_url"), root,
                          revision=payload.get("revision"), message=message)

    why = record.get("error")
    return _fail(f"the build failed (HTTP {record.get('code')}): "
                 f"{quoted(why) if why else 'no reason given'}")


def _print_revision(revision) -> None:
    """The name the hub gave this revision. Absent on the `dev` route."""
    if not revision:
        return
    print(f"revision {revision}: the version being published, named by the hub "
          f"from these sources")


def _print_log(hub: Hub, job_id: str, record: dict) -> None:
    """Print what the build printed, on success as well as on failure.

    The log is the only account of what happened to the model: the gate's
    complaint, the traceback, the empty part, or a warning on a published build.

    A log that cannot be fetched is reported and does not change the outcome:
    the build is already over and its verdict is in the record.
    """
    try:
        text = hub.job_log(job_id)
    except HubError as error:
        print(f"  (the build log could not be fetched: {error})",
              file=sys.stderr)
        return
    if not text.strip():
        return
    print("--- build log ---")
    print(text if text.endswith("\n") else text + "\n", end="")
    if record.get("log_truncated"):
        print("--- log truncated by the hub ---")
    print("--- end of build log ---")


# The stamps the hub writes into a job record (`store.utcnow_iso`).
_STAMP = "%Y-%m-%dT%H:%M:%SZ"

# Endings that already carry their own diagnosis, so no slow-build warning
# (`buildproc.runner.STATUS_TIMEOUT` and `STATUS_CPU_EXHAUSTED`, copied because
# the client may not import them; `tests/client/test_buildtime.py` compares).
SELF_DIAGNOSING = ("timeout", "cpu_exhausted")


def _print_duration(record: dict) -> None:
    """How long this build took, and a word when that is long enough to matter.

    The build time is the hub's `duration_seconds`, measured on a monotonic
    clock; it is never computed from the wall-clock stamps, which can jump. The
    queue wait is the gap between two wall-clock stamps. Not called for a 200
    (`unchanged`) push, which has no job.
    """
    seconds = _whole_seconds(record.get("duration_seconds"))
    # `is None`, not falsiness: a build can measure zero seconds.
    if seconds is None:
        return
    waited = _queue_wait(record)
    bracket = f" (queued {_clock(waited)})" if waited is not None else ""
    print(f"built in {_clock(seconds)}{bracket}")
    if (seconds > SLOW_BUILD_SECONDS
            and record.get("status") not in SELF_DIAGNOSING):
        # A warning, not a refusal: a slow build publishes. Both numbers use the
        # same format so they compare by eye.
        print(f"warning: {_clock(seconds)} is over the "
              f"{_clock(SLOW_BUILD_SECONDS)} a "
              f"build should need. It published —\n"
              f"  this is a warning and not a refusal.\n"
              f"  Most of a slow build is checks(): ask about a point with\n"
              f"  `checklib.material_at` rather than a boolean intersect, put "
              f"`@cache` on the\n"
              f"  builders, and do not filter pairs by hand in front of "
              f"`pairwise_interference`.\n"
              f"  \"Keeping checks fast enough to run\", in the skill's\n"
              f"  references/checks.md, has all three.")


def _whole_seconds(value):
    """`value` rounded to whole seconds, or None when it is not a duration.

    The far end chooses this field, so a string, a NaN or an infinity has to
    fall out here rather than end a run whose build has already finished — that
    is what the three exceptions are: `int(round(nan))` raises ValueError and
    `int(round(inf))` raises OverflowError.
    """
    try:
        seconds = int(round(float(value)))
    except (TypeError, ValueError, OverflowError):
        return None
    return seconds if seconds >= 0 else None


def _queue_wait(record: dict):
    """Seconds spent waiting for a worker, or None when there is nothing to say.

    None in all three cases where the bracket would be a lie or a distraction:
    a job that never started (no stamp), a difference that came out NEGATIVE
    (the stamps are wall-clock and can jump backwards), and a wait under a
    second, which is the ordinary case on an idle hub and says nothing.

    The stamps carry whole seconds, so the difference is a whole number and
    nothing here rounds.
    """
    try:
        created = datetime.strptime(record.get("created"), _STAMP)
        started = datetime.strptime(record.get("started"), _STAMP)
    except (TypeError, ValueError):
        return None
    waited = int((started - created).total_seconds())
    return waited if waited >= 1 else None


def _clock(seconds: int) -> str:
    """Whole seconds as `8s`, `4m12s`, `1h02m03s`.

    Zero-padded past the first field so two durations line up by eye.
    """
    hours, rest = divmod(seconds, 3600)
    minutes, whole = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{whole:02d}s"
    if minutes:
        return f"{minutes}m{whole:02d}s"
    return f"{whole}s"


def _suggest_git(root, revision, message) -> None:
    """Offer a git commit that records what was just published. Never runs one.

    Only after `commit`, and only when there is a repository with something
    uncommitted in it (`gitsuggest` answers None otherwise). Printed before the
    URL, which must stay the last line of the run.
    """
    if not revision:
        return
    try:
        offer = gitsuggest.suggestion(root, revision, message)
    except Exception:
        # A git problem must not turn a landed publication into a failure.
        return
    if offer:
        print(offer)


def _published(hub: Hub, build_url, root, revision=None, message=None) -> int:
    if not build_url:
        raise HubError("the build is published but the hub named no URL for it")
    _suggest_git(root, revision, message)
    # The last line of the run: a bare URL with nothing around it, so it pastes
    # as a link and nobody has to assemble one from a hub name and an id.
    print(hub.absolute(build_url))
    return EXIT_OK


# A verb the parser accepts but nothing implements is a KeyError, not a fall
# through into the publishing path. At the bottom because it names `_publish`.
HANDLERS = {
    "login": setup.login,
    "create": setup.create,
    "build": _publish,
    "commit": _publish,
    "status": status.run,
    "source": sources.run_source,
    "artifacts": artifacts.run,
    "diff": revdiff.run,
    "log": sources.run_log,
    "comments": queue.run,
    "proposal": proposal.run,
    "skill": skill.run,
    "update": update.run,
    "rename": admin.rename,
    "rm": admin.remove,
}
