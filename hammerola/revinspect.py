"""`hammerola snapshot` and `hammerola measure` — a published build, pictured
from any angle or measured between two of its parts, without building it again.

Both ask the hub, which answers with a job (`_handle_inspect` in `src/app.py`):
what the build already stores is read on the hub, in a process of its own, and
nothing is rebuilt. The job's log is the answer; a snapshot's picture is
fetched after it and written here, and its path printed so it can be opened.

REVISION is what `artifacts` takes: a revision id, or `latest` or `dev` of the
variant of the branch checked out.

    snapshot  --view (the build's `assembled` view, else its first), --angle
              (a view of the six-view sheet by name, `multi` for the whole
              sheet, or ELEV,AZIM in degrees), --hide NAME as often as
              needed, -o FILE (default: `.hammerola/snapshots/`).
    measure   two part names and --view. Two printable parts are measured
              exactly, on their STEP files; a pair with a part that is not
              printable, on the view's mesh. The answer says which.
"""

import argparse
import re
import sys
from pathlib import Path

# `artifacts` as `cli` imports it: its REVISION is this module's REVISION.
from hammerola import artifacts, project
from hammerola.errors import ClientError
from hammerola.hub import HubError
from hammerola.limits import DEFAULT_VARIANT, SAFE_COMPONENT
from hammerola.sources import SHORT_ID_CHARS, hub_for, scratch_dir
from hammerola.variant import current_variant

# Copies of `ANGLE_NAMES` and `SHEET_ANGLE` in `src/cadbuild/preview_png.py`,
# which reads `--angle` on the hub; `tests/cadbuild/test_preview_png.py` holds
# them equal.
ANGLE_NAMES = ("iso", "front", "right", "back", "top", "bottom")
SHEET_ANGLE = "multi"
# The rest of what `--angle` takes: ELEV,AZIM in degrees.
CAMERA = re.compile(r"\A-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\Z")

# Where a snapshot lands by default, under `.hammerola/`.
SNAPSHOT_DIR = "snapshots"


def camera(text: str) -> str:
    """`--angle`, checked before anything is sent (an argparse `type`)."""
    if text in ANGLE_NAMES or text == SHEET_ANGLE or CAMERA.match(text):
        return text
    raise argparse.ArgumentTypeError(
        f"{text!r} is none of {', '.join(ANGLE_NAMES)}, {SHEET_ANGLE} or "
        f"ELEV,AZIM in degrees (a negative ELEV is written --angle=-30,45)")


def run_snapshot(args) -> int:
    """Picture one build from one angle and save the PNG. -> exit code."""
    root, pid, hub, name, variant = _target(args)
    request = {"view": args.view, "angle": args.angle,
               "hide": args.hide or []}
    job, view = _ask(hub, "snapshot", pid, name, variant, request)
    picture = hub.job_snapshot(job)
    if not SAFE_COMPONENT.match(view or ""):
        raise ClientError(
            f"the hub named the view {view!r}, which is not a name a build's "
            f"view can have, so this answer did not come from a build the hub "
            f"published. Nothing was written.")
    dest = _destination(args, root, name, view)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(picture)
    except OSError as error:
        raise ClientError(f"cannot write {dest}: {error}") from error
    print(f"wrote {dest}")
    return 0


def run_measure(args) -> int:
    """Print how near two parts of one build come. -> exit code."""
    _root, pid, hub, name, variant = _target(args)
    request = {"view": args.view, "parts": [args.part_a, args.part_b]}
    _ask(hub, "measure", pid, name, variant, request)
    return 0


def _target(args):
    """`(root, pid, hub, name, variant)`: the build REVISION names, addressed
    as `artifacts` addresses it."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)
    name = artifacts._build_name(args.revision)
    variant = (current_variant(root) if name in artifacts.POINTER_NAMES
               else DEFAULT_VARIANT)
    return root, pid, hub, name, variant


def _ask(hub, kind: str, pid: str, name: str, variant: str, request: dict):
    """Submit, wait, print the job's log. -> `(job id, view)`.

    The log is printed whatever the job's ending: a refusal is a sentence in
    it. A job that did not finish is a ClientError after it.
    """
    payload = hub.inspect(kind, pid, name, variant, request)
    job = payload.get("job")
    if not job:
        raise HubError(f"the hub accepted the {kind} but named no job: "
                       f"{payload}")
    record = hub.await_job(
        job, on_notice=lambda note: print(note, file=sys.stderr, flush=True))
    log = hub.job_log(job)
    print(log if log.endswith("\n") else log + "\n", end="")
    if record.get("state") != "done":
        raise ClientError(f"the hub could not finish the {kind}: "
                          f"{record.get('error') or 'no reason given'}")
    return job, payload.get("view")


def _destination(args, root, name: str, view: str) -> Path:
    """`-o FILE`, or `.hammerola/snapshots/<build>-<view>-<angle>.png`.

    Under `.hammerola/` for the reason `artifacts` lands there: a picture
    beside model.py is a file the next push would carry.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    if args.output:
        dest = Path(args.output).expanduser()
    else:
        short = (name if name in artifacts.POINTER_NAMES
                 else name[:SHORT_ID_CHARS])
        dest = (scratch_dir(base, SNAPSHOT_DIR)
                / f"{short}-{view}-{args.angle}.png")
    return dest if dest.is_absolute() else (base / dest).resolve()
