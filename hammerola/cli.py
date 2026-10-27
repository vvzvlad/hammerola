"""The `hammerola` command: its verbs, its dispatch, and its exit code.

    login                     store the hub's address and the one password
    create                    start a project: a fresh id, and the template
    connect                   make this git repository publish to the hub
    build                     push the working copy as the draft of this branch
    status                    latest, dev, the revisions, and the variants
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

This module parses and dispatches; every verb lives in its own module:
`setup.py` (login, create), `repo.py` (connect, build), `status.py`, `queue.py`
(comments), `proposal.py`, `sources.py` (log), `artifacts.py`, `revdiff.py`
(diff), `admin.py` (rename, rm), `skill.py`, `update.py`. They all RAISE on
refusal, so `main` below is the one place that decides what a failure looks
like.

  * `rename` changes the TITLE. Nothing changes an id: every permanent URL of
    the project is built from it (SPEC §3.1).
  * `rm` removes the whole project and asks first. A single build cannot be
    removed: that would break a permanent URL.
  * `update` writes the hub's zipapp over the running file, verified and via a
    rename (`update.py`). `build` refuses to publish from a client older than
    the one the hub serves.

A VERSION IS A GIT COMMIT. It is published by `git push hammerola-<pid>
<branch>`, which the hub answers once the commit is built, and refuses when the
build fails; `connect` sets that remote up. A branch is a variant of the
project, `main` the default one. `build` pushes a draft of the uncommitted tree
into the dev slot of the branch checked out the same way, and its exit code is
`git push`'s: zero means the draft was published or was already there.
`status`, `log`, `artifacts` and `diff` read `latest` and `dev` of that
branch's variant too.
"""

import argparse
import sys

from hammerola import (admin, artifacts, config, project, proposal, queue,
                       repo, revdiff, setup, skill, sources, status, update)
from hammerola.errors import ClientError
from hammerola.hub import HubError

EXIT_FAILED = 1
# Conventional for an interrupted process, and it keeps Ctrl-C out of the
# "the build failed" bucket that a caller may act on.
EXIT_INTERRUPTED = 130

# Verbs removed in 0.5.0, each with what replaced it. An agent following a
# skill written for an older client still types them, and argparse's bare
# `invalid choice` reads like a broken tool; `_gone` answers instead.
GONE = {
    "commit": "A version is a git commit: run `hammerola connect` once in the "
              "project's git repository, then `git commit` and `git push "
              "hammerola-<pid> main` for each version",
    "source": "The code of a revision is its commit in git: run `hammerola "
              "connect` once in the project's git repository, then `git fetch "
              "hammerola-<pid>`",
}


def _fail(message: str) -> int:
    """Say why, on stderr, and hand back the failing exit code.

    Stdout is flushed first: it is block-buffered when piped and stderr is
    not, so otherwise the reason lands above the output that explains it.
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

    commands.add_parser(
        "connect",
        help="make this git repository publish to the hub: the remote "
             "hammerola-<pid>, the hub's headers, and the hub's history joined "
             "into main")

    dev = commands.add_parser(
        "build", help="push the working copy as the draft of the branch "
                      "checked out, into its variant's dev slot")
    # Skips only the model's own `checks()` (most of a build's time). The hub's
    # gates — provenance, catalogue, view gates, per-part gates in
    # `export_printables` — still run and refuse a forced push like any other.
    dev.add_argument(
        "--force", action="store_true",
        help="publish without running the model's own checks(). The hub's own "
             "gates still run and still refuse")

    state = commands.add_parser(
        "status", help="what the hub has for this branch's variant: latest, "
                       "dev, builds; and the project's variants")
    state.add_argument(
        "-n", "--limit", type=int, default=status.DEFAULT_LIMIT, metavar="COUNT",
        help=f"how many revisions to list (default: {status.DEFAULT_LIMIT})")

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

    # Besides this verb, only `update` and a client refused as older than its
    # hub look at the agent's skills directory (see `skill.py`).
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

    # The verbs in `GONE`, with no help line. Every word after one is taken as
    # it comes, the old verb's flags included (`commit -m`, `source -o`): no
    # argument can begin with a NUL, so with it as the only prefix character a
    # `-m` is a word rather than an undeclared option, and the command an old
    # skill taught reaches `_gone` instead of `unrecognized arguments`.
    for verb in GONE:
        gone = commands.add_parser(verb, add_help=False, prefix_chars="\0")
        gone.add_argument("words", nargs="*")
    # Left out of `-h` and the usage line. argparse's `invalid choice` still
    # lists them under `choose from`; typed, they reach `_gone`.
    commands.metavar = "{" + ",".join(
        name for name in commands.choices if name not in GONE) + "}"

    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return HANDLERS[args.command](args)
    except (config.ConfigError, project.ProjectError, ClientError,
            HubError) as error:
        # Every deliberate refusal carries a finished sentence.
        return _fail(str(error))
    except KeyboardInterrupt:
        sys.stdout.flush()
        print("\nhammerola: interrupted. A build already queued goes on "
              "running on the hub.", file=sys.stderr)
        return EXIT_INTERRUPTED


def _gone(args) -> int:
    """A verb in `GONE`: what replaced it, and that the skill naming it is stale."""
    raise ClientError(
        f"`hammerola {args.command}` was removed in version 0.5.0. "
        f"{GONE[args.command]}.\n"
        f"  A skill that names `hammerola {args.command}` is out of date: run "
        f"`{skill.UPDATE_HINT}` and read it again.")


# A verb the parser accepts but nothing implements is a KeyError.
HANDLERS = {
    "login": setup.login,
    "create": setup.create,
    "connect": repo.connect,
    "build": repo.build,
    "status": status.run,
    "artifacts": artifacts.run,
    "diff": revdiff.run,
    "log": sources.run_log,
    "comments": queue.run,
    "proposal": proposal.run,
    "skill": skill.run,
    "update": update.run,
    "rename": admin.rename,
    "rm": admin.remove,
    "commit": _gone,
    "source": _gone,
}
