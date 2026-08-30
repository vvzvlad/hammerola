"""The `hammerola` command: its verbs, its dispatch, and its exit code.

    login                     store the hub's address and the one password
    create                    start a project: a fresh id, and the template
    build                     sources -> the dev slot, and print the build log
    commit -m "..."           sources -> an immutable revision the hub names
    status                    latest, dev, and the revisions that exist
    source <revision>         fetch the CODE of a revision, under the secret
    artifacts <revision>      fetch the STL/STEP/3MF, which are public
    diff <rev> <rev>          what moved: the geometry, and the source
    log [dev|<revision>]      read a build log again
    comments                  the project's comment queue
    comments resolve <id>     close one, with an optional note
    skill                     the agent instructions: this machine's, and the hub's
    skill update              write the hub's copy over the installed one
    rename "New title"        change the project's TITLE — never its id
    rm                        remove the project from the hub, whole

WHERE THE WORK LIVES. This module parses, dispatches and owns the publishing
flow (`build` and `commit`, which are one operation with one thing varying);
every other verb is a module, because none of them shares anything with
publishing but the configuration: `setup.py` (login, create), `status.py`,
`queue.py` (the comment queue), `sources.py` (source, log), `artifacts.py`,
`revdiff.py` (diff), `admin.py` (rename, rm), `skill.py` (skill, skill update).
Every one of them RAISES on refusal rather than printing and exiting, so there
is exactly one place in the tool that decides what a failure looks like — `main`
below.

FOUR OF THE VERBS ABOVE ARE WORTH READING TWICE, because the obvious reading of
each is the wrong one:

  * `source` and `artifacts` are two verbs over one build for one reason: the
    artefacts are PUBLIC and the code is not (issue #17). A flag would
    put both behind one word.
  * `source` unpacks into a directory of its own. Writing over the working copy
    is a flag, and that flag additionally requires git to call the tree clean.
  * `rename` changes the TITLE. There is no command and no flag that changes an
    id, because every permanent URL of the project is built from it and the
    builds behind those URLs cannot be recalled (SPEC §3.1).
  * `rm` removes the whole project and asks first. There is no way to remove one
    build: that would break a permanent URL and leave the project standing.

WHAT IS STILL NOT HERE. Self-update waits on the tool having a distribution name
of its own. `status` shows no "last job", and `log dev` cannot be answered at
all — both for reasons that are not going to lift on their own, see `status.py`
and `sources._dev_log`.

THE PUBLISHING FLOW, which is what the rest of this file is about. Pack the
working directory, POST it, poll the job, print what the build printed, and
return zero only if a build was published. What differs between the two verbs is
the last segment of the URL, and with it what the publication MEANS:

    build           -> <pid>/dev        the local slot. One directory per
                                        project, overwritten by every push, no
                                        history, `latest` untouched, served
                                        no-cache (SPEC 7.6). The working copy as
                                        it stands.
    commit          -> <pid>            an immutable revision. The URL carries no
                                        id, because the client has none: the HUB
                                        names the revision from the sources it
                                        receives and says so in the reply.
                                        Served for a year as immutable and never
                                        rewritten; `latest` moves to it.

`commit` MEANS "PUBLISH A VERSION OF THIS", and it has nothing to do with git.
Nothing here reads HEAD, nothing refuses a dirty tree, nothing needs a
repository to exist — a directory with a `project.json` in it can always publish.
What git gets afterwards is an OFFER: a finished `git commit` line, printed for
a person to run or ignore (`gitsuggest`). Publishing and recording are two acts
in that order, and this tool performs exactly one of them.

THE EXIT CODE IS THE POINT OF THE WHOLE FLOW, because this replaces a forge's
job status: zero means a build was published and nothing else does. A refused
push, a model that failed, a gate that said no, a hub that could not be reached
and a wait that ran out are all non-zero, each with the sentence that says which
one it was — and, when the build ran at all, with its log.
"""

import argparse
import sys

from src.client import (admin, artifacts, config, gitsuggest, project, queue,
                        revdiff, setup, skill, sources, status)
from src.client.errors import ClientError
from src.client.hub import (JOB_TIMEOUT, UNAUTHORIZED, Hub, HubError,
                            quoted)
from src.client.limits import DEV_SLOT
from src.client.pack import PackError, pack

EXIT_OK = 0
EXIT_FAILED = 1
# Conventional for an interrupted process, and it keeps Ctrl-C out of the
# "the build failed" bucket that a caller may act on.
EXIT_INTERRUPTED = 130


def _fail(message: str) -> int:
    """Say why, on stderr, and hand back the failing exit code.

    STDOUT IS FLUSHED FIRST, and that is not cosmetic. The build log goes to
    stdout, which is block-buffered the moment the run is piped into a file or
    read by an agent, while stderr is not buffered at all — so without this the
    reason lands ABOVE the log that explains it, and the two streams read as if
    the tool complained before the build said anything.
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
        "login", help="store the hub's address and password on this machine")
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
        help="what this revision is; becomes the subject of the git commit "
             "suggested afterwards")
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
    # A sub-subcommand rather than a `--resolve <id>` flag on the listing: they
    # are two different acts, one of which WRITES, and a flag that quietly turns
    # a read into a write is the shape of a mistake nobody catches in review.
    # Optional, so `hammerola comments` on its own still lists.
    queue_commands = notes.add_subparsers(dest="comment_command")
    close = queue_commands.add_parser(
        "resolve", help="mark one comment handled, so it is not done twice")
    close.add_argument(
        "id", help="the comment id, as `hammerola comments` prints it")
    close.add_argument(
        "-m", "--note", default=None,
        help="what was done about it; stored with the comment")

    # ASKED FOR BY NAME OR NOT AT ALL. Nothing else in this tool looks at the
    # agent's skills directory, and nothing else prints a word about the
    # instructions — see `skill.py` for why an automatic check was refused.
    instructions = commands.add_parser(
        "skill",
        help="the agent instructions: which version is installed here, and "
             "which the hub serves")
    instructions.add_argument(
        "--path", default=None, metavar="FILE",
        help=f"the installed skill file (default: {skill.DEFAULT_PATH})")
    # A sub-subcommand and not a `--update` flag, exactly as `comments resolve`
    # is one: reading and WRITING are two acts, and a flag that turns a question
    # into a write into somebody's `~/.claude` is the shape of a mistake nobody
    # catches in review. Optional, so `hammerola skill` on its own still asks.
    skill_commands = instructions.add_subparsers(dest="skill_command")
    refresh = skill_commands.add_parser(
        "update", help="write the hub's copy over the installed skill")
    # SUPPRESS AND NOT `None`, and this is the one line here that cannot be
    # simplified. A subparser parses into a namespace of its own and then copies
    # EVERY key of it onto the parent's, defaults included, so a plain
    # `default=None` would make `skill --path FILE update` write to the default
    # location — the flag accepted, silently discarded, and the file landing
    # somewhere the caller did not name. With SUPPRESS the attribute is only
    # created when the flag is actually given, so both orders mean the same
    # thing.
    refresh.add_argument(
        "--path", default=argparse.SUPPRESS, metavar="FILE",
        help=f"the file to write (default: {skill.DEFAULT_PATH})")

    # THE TITLE IS THE ONLY THING THIS TAKES, and there is deliberately no
    # `--id` beside it: an id that could be renamed would break every permanent
    # URL of the project on the day it was used (SPEC §3.1).
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


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return HANDLERS[args.command](args)
    except (config.ConfigError, project.ProjectError, PackError,
            ClientError, HubError) as error:
        # One handler for every refusal the tool makes on purpose. Each of those
        # exceptions carries a finished sentence — sometimes several lines of
        # one — so there is nothing to add here but the program's name.
        return _fail(str(error))
    except KeyboardInterrupt:
        sys.stdout.flush()
        print("\nhammerola: interrupted. A build already queued goes on "
              "running on the hub.", file=sys.stderr)
        return EXIT_INTERRUPTED


def _publish(args) -> int:
    root = project.find_project_root(args.directory)

    # BEFORE the tree is walked and long before it is packed: a machine with no
    # HUB_URL must be told so in a second, not after a minute of work it was
    # never going to be able to send. AGENTS.md: the address of our own service
    # has no default.
    hub_url = config.hub_url(root)
    token = config.edit_token(root)

    pid = project.read_project_id(root)
    # `dev` for the slot, and NOTHING for a revision: the absence of a last path
    # segment is how the hub is asked to name it (`Hub.publish`).
    slot = DEV_SLOT if args.command == "build" else None

    # BUILT HERE AND NOT AT THE PUSH, which is the second half of the paragraph
    # above. Reading the two settings early only catches the variable being
    # ABSENT; a typo IN it — a letter in the port, a missing scheme, an
    # unclosed bracket — is caught by `Hub.__init__` (`hub._origin`), and with
    # that line below `pack` the whole tree was walked, hashed and compressed
    # before the tool said the address was unusable. Constructing a Hub opens
    # nothing and sends nothing, so there is no cost to doing it here. The same
    # goes for the token: a stored secret with a newline in it is refused here
    # rather than after the packing.
    hub = Hub(hub_url, token)

    archive = pack(root)

    title = project.read_project_title(root)
    # WHERE, AS WHOM, INTO WHAT — said once, immediately before the bytes leave,
    # and from here rather than from a caller so that no path can push without
    # printing it. Each of the three is resolved somewhere else, and until this
    # line no output has shown them together; it is the line somebody reading a
    # transcript afterwards uses to see which project was written to.
    print(f"publishing to {hub_url} as {title or '?'} ({pid}) -> "
          f"{slot or 'a new revision'}")
    print(f"  {len(archive.names)} files, {archive.size / 1e3:.1f} kB packed")
    sys.stdout.flush()

    # `code` and not `status`, because `status` is a module of this package.
    code, payload = hub.publish(pid, archive.body, slot=slot)

    if code == 200:
        # `Store.settled`: this exact source tree is already published under
        # this name, so nothing was rebuilt. A success, and worth distinguishing
        # in the output — otherwise a re-run that changed nothing looks exactly
        # like one that shipped, which is the question actually being asked when
        # a change does not show up in the browser.
        #
        # On a revision this is not a coincidence to be explained away: the name
        # IS the digest of the sources, so identical sources cannot land
        # anywhere else. "Unchanged" and "already published" are the same
        # sentence here.
        print("unchanged: the hub already has this exact source, nothing rebuilt")
        _print_revision(payload.get("revision"))
        return _published(hub, payload.get("url"), root,
                          revision=payload.get("revision"),
                          message=getattr(args, "message", None))

    if code == 401:
        # Named rather than shown as one more refusal code: it is the only one
        # of them the person running this can fix in ten seconds, and the fix is
        # a different command.
        return _fail(UNAUTHORIZED)

    if code != 202:
        # QUOTED, like every other place a reply's own words are printed. This
        # one and the two below are on the ordinary push path — the commonest
        # route in the tool — and they were writing whatever the far end sent
        # straight to a terminal, bounded only by the 64 MiB reply ceiling.
        return _fail(f"the hub refused the push with HTTP {code}: "
                     f"{quoted(payload.get('error', payload))}")

    # THE REVISION FIRST AND THE JOB SECOND, and both labelled with what they
    # address. They arrive in the same reply and they look alike — two opaque
    # strings — but one is the version being published and the other is this
    # attempt at building it. Printing them unlabelled is how somebody ends up
    # pasting a job id into a URL.
    _print_revision(payload.get("revision"))
    job_id = payload.get("job")
    if not job_id:
        raise HubError(
            f"the hub accepted the push but named no job: {quoted(payload)}")
    print(f"queued as job {job_id}: this build's progress and its log")
    sys.stdout.flush()

    # STATE GOES TO STDOUT AND TROUBLE GOES TO STDERR, like the log's own
    # failure line below: the states are the progress of the build, which is
    # what this command is reporting, while a notice is about the CONNECTION to
    # the hub and belongs with the other things that went wrong on the way.
    record = hub.await_job(job_id, timeout=args.timeout,
                           on_state=lambda state: print(f"  {state}",
                                                        flush=True),
                           on_notice=lambda note: print(f"  {note}",
                                                        file=sys.stderr,
                                                        flush=True))

    _print_log(hub, job_id, record)

    if record.get("state") == "done":
        return _published(hub, record.get("build_url"), root,
                          revision=payload.get("revision"),
                          message=getattr(args, "message", None))

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
    """Print what the build printed. THIS IS WHY STEP 5 EXISTS.

    The hub builds out of process, so its log is the only account of what
    happened to the model — the gate's complaint, the traceback, the part that
    came out empty. Printed on success as well as on failure: a build that
    published can still have warned about something.

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


def _suggest_git(root, revision, message) -> None:
    """Offer a git commit that records what was just published. Never runs one.

    Only after `commit`, and only when there is a repository with something
    uncommitted in it — `gitsuggest` answers None for everything else, and a
    directory with no git in it is one of those: the publication already
    happened and never depended on git (see the module docstring).

    Printed BEFORE `_published` writes the URL, because that URL has to stay the
    last line of the run.
    """
    if not revision:
        return
    try:
        offer = gitsuggest.suggestion(root, revision, message)
    except Exception:
        # A publication that landed must not be reported as a failure because
        # asking git a question went wrong. There is no honest suggestion to
        # print, so there is none.
        return
    if offer:
        print(offer)


def _published(hub: Hub, build_url, root, revision=None, message=None) -> int:
    if not build_url:
        raise HubError("the build is published but the hub named no URL for it")
    _suggest_git(root, revision, message)
    # THE LAST LINE OF THE RUN, and a bare URL on a line of its own: no quotes,
    # no brackets, nothing in front of it. It gets copied out of a terminal and
    # pasted into a chat, where anything around it stops it being a link. It is
    # also the answer to "where did it go" that nobody then has to ASSEMBLE out
    # of a hub name and an id — one such guess, a short sha the hub does not
    # serve, has already cost an afternoon.
    print(hub.absolute(build_url))
    return EXIT_OK


# WHICH FUNCTION EACH VERB IS. A table rather than a chain of `if`s, so a verb
# the parser accepts and nothing implements cannot exist quietly: it is a
# KeyError on the first run instead of a fall through into the publishing path.
#
# At the BOTTOM of the module because it names `_publish`, which is defined
# above it — `main` only reads this at call time, so the position is free, and
# the alternative (a dict of lambdas next to `main`) buys nothing but a layer of
# indirection over the same two names.
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
    "skill": skill.run,
    "rename": admin.rename,
    "rm": admin.remove,
}
