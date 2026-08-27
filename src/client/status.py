"""`hammerola status` — what the hub has for this project, in one screen.

ASSEMBLED OUT OF WHAT THE SITE ALREADY SERVES, and no route was added for it:
`builds.json` is the file the project page fetches to build its picker, and the
local slot's `meta.json` is the file the viewer fetches to caption it. So this
command cannot come to disagree with the pages — there is one answer and both
read it — and the hub gained no endpoint that exists only for a CLI.

WHAT IT DELIBERATELY DOES NOT SHOW IS THE LAST BUILD JOB, which SPEC §8 entry 26
lists beside the rest. It is not an omission and it is not waiting on anybody's
next commit — the hub cannot be asked the question at all. A job is
addressable by its id and by nothing else (`GET /api/v1/jobs/<id>`), and the
order jobs were created in is stored NOWHERE — deliberately, because the only
thing that ever read it was retention, and there is no retention (SPEC §5.3, and
the docstring of `src/jobs.py`). "The last job" is therefore not a fact the hub
can be asked for today; showing the newest build is the honest neighbouring
answer, and the id of a job in flight is printed by the push that started it.

THE THREE THINGS IT ANSWERS, in the order somebody asks them:

    latest    which revision the permanent name resolves to right now
    dev       whether the local slot is occupied, and when it was last written
    builds    the revisions that exist, newest first
"""

from src.client import config, project
from src.client.errors import ClientError
from src.client.hub import QUERY_TIMEOUT, Hub
from src.client.limits import DEV_SLOT

# How many revisions are listed before the tail is summarised. A project with a
# year of history is a list nobody reads; the newest few plus a count is what
# the question "what is on the hub" actually wants.
DEFAULT_LIMIT = 10


def run(args) -> int:
    """Print what the hub has for the project in this directory. -> exit code."""
    limit = _limit(getattr(args, "limit", None))
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    # The token is required even though `builds.json` is public, and that is a
    # choice rather than an oversight: this tool has ONE secret and one login,
    # so a machine that cannot answer "as whom" is a machine that has not been
    # set up — and being told that here, by a command somebody runs first, is
    # better than being told it by the first push.
    hub = Hub(config.hub_url(root), config.edit_token(root),
              timeout=QUERY_TIMEOUT)

    title = project.read_project_title(root)
    print(f"{pid}  {title or '(no title)'}")

    picker = hub.builds(pid)
    if picker is None:
        print(f"  {hub.absolute(f'/project/{pid}/')}")
        print("  nothing published yet. `hammerola build` puts the working "
              "copy in the dev slot,\n  `hammerola commit` publishes a "
              "revision.")
        return 0

    print(f"  {hub.absolute(f'/project/{pid}/')}")
    print()
    _print_pointers(hub, pid, picker)
    _print_builds(picker, limit)
    return 0


def _limit(given) -> int:
    """How many revisions to list, refusing the numbers a slice would misread.

    CHECKED RATHER THAN CLAMPED, and checked BEFORE the hub is asked anything,
    because both bad values are silent: `-n 0` is falsy, so it used to fall
    through to the default and print ten revisions to somebody who asked for
    none, and a negative one goes straight into `builds[:limit]`, where Python
    reads it from the OTHER end — `-n -3` drops the three oldest and lists the
    rest, then reports `len(builds) + 3` more "older" ones that do not exist.
    Neither fails, and neither is what was asked for.
    """
    if given is None:
        return DEFAULT_LIMIT
    if not isinstance(given, int) or isinstance(given, bool) or given < 1:
        raise ClientError(
            f"-n takes a count of revisions to list, so it has to be 1 or more; "
            f"{given!r} is not.\n"
            f"  Without it the newest {DEFAULT_LIMIT} are listed and the rest "
            f"are summarised as a count.")
    return given


def _print_pointers(hub: Hub, pid: str, picker: dict) -> None:
    """`latest` and `dev` — the two names that move (SPEC 3.2)."""
    latest = picker.get("latest")
    print(f"  latest  {latest}" if latest else
          "  latest  none — no revision has been published yet")

    if not picker.get("has_dev"):
        print("  dev     empty")
        return
    # The slot's timestamp lives in its own meta and nowhere else: it is not
    # part of the project's HISTORY (SPEC 7.6), so `builds.json` carries only
    # the fact that the slot is occupied. Best effort — a slot being overwritten
    # while this runs is an ordinary thing, and it must not fail the command.
    meta = hub.build_meta(pid, DEV_SLOT) or {}
    built = meta.get("built") or meta.get("published")
    print(f"  dev     occupied, built {built}" if built else
          "  dev     occupied")


def _print_builds(picker: dict, limit: int) -> None:
    builds = [b for b in picker.get("builds") or []
              if isinstance(b, dict) and b.get("commit")]
    latest = picker.get("latest")
    print(f"  builds  {len(builds)} published")
    if not builds:
        return
    print()
    # Newest first, which is the order `builds.json` is written in
    # (`Store._write_builds_json`) — not re-sorted here, because the picker on
    # the page shows that order and the two must not disagree about which build
    # is the newest.
    for entry in builds[:limit]:
        mark = "  (latest)" if entry["commit"] == latest else ""
        print(f"  {entry['commit']}  {entry.get('built', '')}{mark}")
    remaining = len(builds) - limit
    if remaining > 0:
        print(f"  ... and {remaining} older")
