"""`hammerola status` — what the hub has for this project, in one screen.

Built from what the site already serves: `builds.json` (the project page's
picker) and the local slot's `meta.json`, so it cannot disagree with the pages.

It does not show the last build job: jobs are addressable only by id and their
order is stored nowhere (SPEC §5.3, `src/jobs.py`). The dev slot's `meta.json`
names the job that filled it (`render.build_meta`), but only on success, so a
failed or in-flight build is absent from it.

THE THREE THINGS IT ANSWERS, in the order somebody asks them:

    latest    which revision the permanent name resolves to right now
    dev       whether the local slot is occupied, and when it was last written
    builds    the revisions that exist, newest first
"""

from hammerola import project
from hammerola.errors import ClientError
from hammerola.hub import Hub
from hammerola.limits import DEV_SLOT
from hammerola.sources import hub_for

# How many revisions are listed before the tail is summarised as a count.
DEFAULT_LIMIT = 10


def run(args) -> int:
    """Print what the hub has for the project in this directory. -> exit code."""
    limit = _limit(args.limit)
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    # The token is required: `builds.json`, the list read below, is behind it.
    hub = hub_for(root)

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

    Checked before the hub is asked: a negative value in `builds[:limit]`
    would count from the other end. The parser always sets `-n`
    (`default=DEFAULT_LIMIT`), so there is no None case.
    """
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
    # The slot's timestamp lives only in its own meta (SPEC 7.6). Best effort:
    # a slot being overwritten must not fail the command.
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
    # Newest first, as `builds.json` is written (`Store._write_builds_json`);
    # not re-sorted, so it matches the page's picker.
    for entry in builds[:limit]:
        mark = "  (latest)" if entry["commit"] == latest else ""
        print(f"  {entry['commit']}  {entry.get('built', '')}{mark}")
    remaining = len(builds) - limit
    if remaining > 0:
        print(f"  ... and {remaining} older")
