"""`hammerola diff` — what changed between two revisions, in geometry and in code.

Prints the measurements first (what moved) and the source diff under them
(why).

The measurements come from each build's public `metrics.json`, compared by
`hammerola/metricsdiff.metrics_diff`, the same function the build uses against
`dev` (`src/cadbuild/metrics.report_metrics`). The source diff is `git diff`
between the project's trees of the two revisions in the local repository
(`repo.revision_tree`): a revision is a commit, and the hub's history is
fetched with `git fetch hammerola-<pid>`.

`--material` adds a section the hub computes: fusing the two solids per part in
the CAD kernel to say how much material was added and removed. It is a job,
costs what a build costs, and its log is printed under the heading.

`--json` prints only which PART physical numbers moved, as one document: no
source diff, and no `assembly` block, so an empty `moved` means "no part changed
shape", not "the build is the same".
"""

import json
import sys

from hammerola import project, repo
from hammerola.hub import HubError
from hammerola.sources import SHORT_ID_CHARS, hub_for, resolve_revision
from hammerola.metricsdiff import (METRICS_NAME, PHYSICAL_FIELDS, metrics_diff,
                                   moved_fields, unchanged_code_moved_geometry)


def run(args) -> int:
    """Print what moved between two revisions. -> exit code."""
    # A project is required: metrics.json is addressed by `<pid>/<revision>`.
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    old = resolve_revision(hub, root, args.old)
    new = resolve_revision(hub, root, args.new)
    # Before anything is printed: with `--json` the whole output is one
    # document.
    if args.json:
        return _print_json(hub, pid, old, new)
    if old == new:
        # Not an error: `hammerola diff <rev> latest` asks "is latest still
        # that one".
        print(f"{old} and {new} are the same revision — nothing to compare.")
        return 0

    print(f"{pid}: {old[:SHORT_ID_CHARS]} -> {new[:SHORT_ID_CHARS]}")
    print(f"  {old}\n  {new}")

    before, after = _metrics(hub, pid, old), _metrics(hub, pid, new)
    print()
    _print_geometry(before, after)
    # Order: what moved, how much material moved, then why (the code).
    if args.material:
        print()
        _print_material(hub, pid, old, new)
    print()
    _print_code(root, pid, old, new)
    return 0


def _metrics(hub, pid: str, revision: str):
    """One revision's metrics.json, or None when that build shipped none.

    None rather than a refusal: older builds may have none, which costs only
    the geometry section.
    """
    body = hub.build_file(pid, revision, METRICS_NAME)
    if body is None:
        return None
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _print_json(hub, pid: str, old: str, new: str) -> int:
    """`{"moved": [...], "compared": n}` -- a part's physical numbers, for a script.

    Only PHYSICAL_FIELDS, per part; the assembly block is not included. A
    revision without metrics.json compares as an empty document (`compared: 0`).
    """
    before = _metrics(hub, pid, old) or {}
    after = _metrics(hub, pid, new) or {}
    print(json.dumps(moved_fields(before, after, PHYSICAL_FIELDS)))
    return 0


def _print_material(hub, pid: str, old: str, new: str) -> None:
    """How much material each part gained and lost, measured BY THE HUB.

    A job like a build (the CAD kernel runs on the hub): submit, wait, print
    its log indented. Connection notices go to stderr.
    """
    print("material:")
    try:
        payload = hub.compare(pid, old, new)
        job_id = payload.get("job")
        if not job_id:
            raise HubError(
                f"the hub accepted the comparison but named no job: {payload}")
        record = hub.await_job(
            job_id,
            on_notice=lambda note: print(f"  {note}", file=sys.stderr,
                                         flush=True))
        log = hub.job_log(job_id)
    except HubError as exc:
        # Fails this section only: the code diff below does not depend on it.
        print(f"  the hub could not be asked for it: {exc}")
        return
    for line in log.splitlines():
        print(f"  {line}")
    if record.get("state") != "done":
        # The log is printed regardless: a partial comparison is still useful.
        print(f"  the hub could not finish the comparison: "
              f"{record.get('error') or 'no reason given'}")


def _print_geometry(before, after) -> None:
    print("geometry:")
    missing = [name for name, value in (("the older", before), ("the newer", after))
               if value is None]
    if missing:
        print(f"  {' and '.join(missing)} revision published no {METRICS_NAME}, "
              f"so there is nothing to compare.")
        return
    lines = metrics_diff(before, after)
    if not lines:
        # The count tells "the same" apart from "nothing comparable". It counts
        # part fields only (`moved_fields` walks `parts`), hence "part numbers".
        compared = moved_fields(before, after)["compared"]
        print(f"  every measured number is the same "
              f"({compared} part numbers compared).")
    for line in lines:
        print(f"  {line}")

    # Same comment-stripped source, different solid: the cause is outside the
    # source.
    shifted = unchanged_code_moved_geometry(before, after)
    if shifted:
        print(f"  ! the geometry moved while the model's code did not "
              f"({', '.join(shifted)}).")
        print("    The same source built into a different solid: compare the "
              "CAD stack the two")
        print("    builds ran on, or the model is not deterministic.")


def _print_code(root, pid: str, old: str, new: str) -> None:
    print("code:")
    text = repo.code_diff(root, pid, old, new)
    if not text.strip():
        # Two builds of one tree, such as a build published before git under a
        # name of its author's and its twin named by the digest.
        print("  the same code in both.")
    for line in text.splitlines():
        print(f"  {line}")
