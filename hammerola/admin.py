"""`hammerola rename` and `hammerola rm` — the two commands that unmake something.

`rename` CHANGES THE TITLE AND NOTHING ELSE, and the absence of the other command
is the design rather than an omission. A project has an id and a name, separated
on purpose (SPEC 3.1): the id may not be derived from the name, because it would
then change at exactly the moment it exists to survive. Every permanent URL of
the project is built from that id, the builds behind those URLs went out with a
year of `immutable` and cannot be recalled, so renaming an id would not rename
anything — it would abandon a project and start an empty one beside it. There is
no flag for it here, no route for it on the hub, and neither is an oversight.

It writes in TWO PLACES, in this order:

    project.json in the working directory   the name the NEXT push will carry
    the hub                                 the name the site shows right now

Both, because each answers a different question and neither implies the other.
The hub takes its title from whatever the newest build declared, so a rename made
only there is undone by the next push; `project.json` is what a build reads, so a
rename made only in it does not show up until something is published. The local
file goes first: it is the one that survives, and a project that has never been
pushed has nothing on the hub to rename at all — which is reported as the
ordinary situation it is, not as a failure.

`rm` REMOVES THE PROJECT WHOLE, AND ONLY THE PROJECT. There is deliberately no
way to remove one build: a build's URL is permanent, so deleting one turns a
promise into a 404 while the project goes on standing. Removing the project takes
the promise away with everything it was about. There is no retention anywhere on
this service (SPEC 5.3), so this is the ONLY thing that ever takes bytes off the
volume — which is the argument for it being big, rare and loud rather than a
tidying tool (issue #26).

IT ASKS BEFORE IT DOES IT. Not a y/n — the id has to be typed, because a y/n is
answered by reflex and this cannot be undone: the hub keeps no copy, and the
builds, the comment queue, the PROPOSAL somebody drew over the model and the
stored code of every revision go together. `--yes` exists for a script, and it
is the flag a person should have to think about typing.

NOTHING LOCAL IS DELETED, ever. `rm` is a command about the hub; the checkout on
the disk belongs to whoever is running it, and a tool that removed a directory
because a server call succeeded would be a different and much worse tool.
"""

from hammerola import project
from hammerola.errors import ClientError
from hammerola.sources import hub_for

# What has to be typed to confirm a removal. The ID rather than the title: it is
# unambiguous, it is what the hub is addressed by, and it is printed two lines
# above the prompt — so confirming means having read what is about to go.
CONFIRM_PROMPT = "type the project id to remove it (anything else cancels): "

_NOTHING_TO_READ = (
    "`hammerola rm` asks for confirmation on the terminal and there is nothing "
    "to read.\n"
    "  Pass `--yes` to remove without being asked — but read what it removes "
    "first: the\n"
    "  builds, the comment queue, the proposal and the stored code of every "
    "revision, with no\n"
    "  copy kept.")


def rename(args) -> int:
    """Change the project's title, locally and on the hub. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    was = project.read_project_title(root)

    # Local first: this is the file a build reads, so it is the one that decides
    # what the project is called from the next push onwards.
    title = project.write_project_title(root, args.title)

    hub = hub_for(root)
    answer = hub.rename_project(pid, title, missing_ok=True)

    print(f"{pid}")
    print(f"  was  {was or '(no title)'}")
    print(f"  now  {title}")
    print(f"  {project.PROJECT_FILE} rewritten — commit it, or the next "
          f"checkout still has the old name.")
    if answer is None:
        print("  the hub has nothing published for this project yet, so there "
              "was nothing to rename\n"
              "  there. The first push carries this name.")
    else:
        print(f"  {hub.absolute(f'/project/{pid}/')} shows it now.")
    # The id is not part of any of this, and saying so is cheap: it is the
    # question somebody asks next.
    print("  the id is unchanged and cannot be changed — every published URL "
          "is built from it.")
    return 0


def remove(args) -> int:
    """Delete the project from the hub, after confirmation. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    title = project.read_project_title(root)
    hub = hub_for(root)

    picker = hub.builds(pid)
    print(f"about to remove {pid}  {title or '(no title)'}")
    print(f"  {hub.absolute(f'/project/{pid}/')}")
    if picker is None:
        # Said before the prompt, because it changes what is being confirmed:
        # there may still be a project directory on the volume with no build in
        # it, and the hub will answer for that.
        print("  the hub lists no builds under this id.")
    else:
        builds = [b for b in picker.get("builds") or [] if isinstance(b, dict)]
        print(f"  {len(builds)} published revisions"
              f"{', a dev slot' if picker.get('has_dev') else ''}"
              f", their comment queue, and the stored code of each revision")
    # NAMED ON BOTH ARMS, and outside the `else` for a reason: a proposal is
    # stored per PROJECT and the route that writes it never asks whether
    # anything was published, so an id the hub lists no builds under can still
    # have somebody's drawing behind it. The inventory in front of an
    # irreversible confirmation is the one thing that has to be complete — this
    # is what `_confirm` exists to make somebody read.
    print("  and the proposal drawn over this project, if somebody drew one: "
          "no build contains it,\n"
          "  so nothing can bring it back.")
    print("  this cannot be undone: the hub keeps no copy, and the permanent "
          "URLs stop resolving.")

    _confirm(pid, args.yes)

    removed = hub.remove_project(pid)
    print(f"removed {pid}")
    # The proposal is a boolean rather than a count — there is one per project
    # at most (`src/proposals.py`) — so it is reported as the fact it is. Said
    # in both directions, because "no proposal" is an answer somebody who just
    # confirmed a removal that named one is owed.
    print(f"  {removed.get('builds', 0)} builds, "
          f"{removed.get('comments', 0)} comments, "
          f"{removed.get('sources', 0)} stored source trees, and "
          f"{'the proposal' if removed.get('proposal') else 'no proposal'}")
    # The stored code is addressed by the digest of a source tree rather than by
    # project (SPEC 7.8), so a tree published in two projects is one directory
    # serving both. The hub removes only what nothing else points at, and the
    # difference between that count and the number of builds is exactly the
    # shared ones — worth saying, since otherwise it reads like a miscount.
    print("  code shared with another project was kept: it is stored by "
          "content, not by project.")
    print(f"  {root / project.PROJECT_FILE} was NOT touched. Pushing from here "
          f"again recreates the\n"
          f"  project under the same id, empty. Delete the file by hand if that "
          f"is not what you want.")
    return 0


def _confirm(pid: str, skip: bool) -> None:
    """Make the person say the id out loud, unless they passed `--yes`."""
    if skip:
        return
    try:
        answer = input(CONFIRM_PROMPT).strip()
    except EOFError as error:
        raise ClientError(_NOTHING_TO_READ) from error
    if answer != pid:
        raise ClientError("cancelled: that is not the project id. Nothing was "
                          "removed.")
