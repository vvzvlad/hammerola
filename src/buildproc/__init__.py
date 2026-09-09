#!/usr/bin/env python3
"""Running a pushed model in a process of its own, under ceilings (SPEC 8A.2 step 4).

The hub stopped being a thing that only PARSES untrusted data and became one
that EXECUTES it. This package is the fence that decision needs: the model runs
in a separate, freshly exec'd interpreter, with an environment built key by key
and holding no credential, under rlimits put on by an outer wrapper, with a
wall-clock deadline the parent enforces with SIGKILL over the whole process
group, and with its output captured and capped.

    limits.py     the ceilings, and the code that puts them on a process
    wrapper.py    `python -m` entry that applies them to itself and execs the child
    child.py      `python -m` entry that arms faulthandler, caps OCCT, and builds
    runner.py     the parent: spawn, deadline, kill, capture, CHECK the result
    hardening.py  the one call that runs in the HUB: hide its /proc entry

    from src.buildproc import run_build
    outcome = run_build(unpacked_tree, staging_out, pid=accepted_push_id)

NOTHING THE BUILD PROCESS SAYS IS BELIEVED. The model runs inside it, so the
exit code, the log and the result file are all things the model can write: the
parent takes the project id from the push it accepted and checks every file name
against the output directory before repeating it (`runner._verified_files`).
This is not theoretical -- a model reading `--result` out of `sys.argv` and
writing its own result was a working forgery until the check existed.

WHAT THIS FENCE DOES NOT CLOSE, stated here because a fence is read as covering
everything inside it:

  * THE DATA VOLUME IS FULLY WRITABLE TO A BUILD. `/app/data` is one volume, the
    build runs as `app`, and so does the hub: a model can write, overwrite and
    delete anywhere under it -- another project's builds, its `latest` pointer,
    the comment queue. `Limits.output_bytes`/`output_files` cap what the build
    puts in ITS OWN output directory, which is a ceiling on volume exhaustion
    and not a boundary; nothing here confines a build to that directory. Doing
    that needs a uid of its own or a mount namespace per build, and neither is
    available to a process inside this container (SPEC 8A.4).
  * THE PROCESS GROUP DOES NOT COVER A `setsid()` DESCENDANT. See runner.py.
  * THE HUB'S OWN ENVIRONMENT is closed, but only because `hardening.py` runs at
    startup -- same uid and same pid namespace mean `/proc/<hub>/environ` is
    otherwise readable by every build. If that call is ever dropped, the token
    is back within reach and nothing else here would notice.

WIRED TO HTTP SINCE STEP 5. `src/jobs.py` calls `run_build` from a worker
thread, with the pushed source tree as the project and the staging directory
that becomes `<pid>/<commit>` as the output. The gate refuses a build AFTER it
has been accepted -- step 6, closed.

WHAT THE PYTEST SUITE CANNOT SEE, THE GATE DOES. The suite runs against a
checkout, so it can never tell whether the ceilings really go on INSIDE the
image, under the `app` account, or whether `-m src.buildproc.*` resolves from
/app. `ci/smoke.py` asks the process on the far side of the `execv` what its
rlimits actually are, inside the built image, as `app` -- check (i), and it is
counted in the gate's own verdict table. Until step 4 was wired up there was
nothing for a broken image to break, because nothing in the running service
called this package; a build lands on the request path now, which is why that
probe had to exist and not merely be planned for.

Everything here is stdlib. Importing it must not import cadquery, and it must
not import `src.settings` -- the whole point is a process that has never had a
token anywhere near it.
"""

from src.buildproc.hardening import HardeningFailed, hide_process_from_same_uid
from src.buildproc.limits import DEFAULT_LIMITS, Limits, LimitsUnavailable
from src.buildproc.runner import (
    BuildOutcome,
    ProcessResult,
    STATUS_BAD_RESULT,
    STATUS_CPU_EXHAUSTED,
    STATUS_CRASHED,
    STATUS_FAILED,
    STATUS_HANG,
    STATUS_KILLED,
    STATUS_LIMITS_ERROR,
    STATUS_OK,
    STATUS_OUTPUT_LIMIT,
    STATUS_TIMEOUT,
    child_environment,
    run_build,
    run_isolated,
)

__all__ = [
    "BuildOutcome",
    "DEFAULT_LIMITS",
    "HardeningFailed",
    "Limits",
    "LimitsUnavailable",
    "ProcessResult",
    "STATUS_BAD_RESULT",
    "STATUS_CPU_EXHAUSTED",
    "STATUS_CRASHED",
    "STATUS_FAILED",
    "STATUS_HANG",
    "STATUS_KILLED",
    "STATUS_LIMITS_ERROR",
    "STATUS_OK",
    "STATUS_OUTPUT_LIMIT",
    "STATUS_TIMEOUT",
    "child_environment",
    "hide_process_from_same_uid",
    "run_build",
    "run_isolated",
]
