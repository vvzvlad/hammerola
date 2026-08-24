"""Smoke gate for this project's image, run on the CI runner against an already-built image.

It sits BETWEEN `docker build` and `docker push` and is the last point at which a broken
image can still be stopped: nobody presses a button between the push and the rollout, so
whatever reaches `:latest` is what production ends up running.

It is a plain `python3 ci/smoke.py` on the runner that drives `docker` against the tag it is
given in $SMOKE_IMAGE. Nothing here is imported from the application, and nothing here needs
the application's dependencies — the whole gate is `docker inspect`, `docker run`,
`docker exec` and `docker logs`.

What this gate is for, and what it is NOT for
----------------------------------------------
The pytest suite runs in its own job before the image is built. It answers "does the code
work" against a checkout, with collaborators mocked. What it cannot answer is whether the
ARTEFACT that gets deployed carries that code, comes up on its own, and is packaged the way
this repo says it is. Every check below is one of those, and every one of them is a way this
image has a realistic chance of shipping broken while the suite stays green:

* (a) the image's declared contract: ENTRYPOINT, CMD, WORKDIR and PYTHONUNBUFFERED.
* (b) the required-variable guard still fires AND still names EVERY variable that is missing.
* (c) privileges are really dropped — the process is `app`, not root.
* (d) `.dockerignore` did its job: no tests, no `.env`, no `.venv` inside the image.
* (e) the image's own command starts and gets through its own startup.
* (f) the CAD kernel imports inside the image, and carries the versions requirements.txt
      declares — including the transitive `cadquery-ocp`, which cadquery constrains only by
      RANGE. This one is not about packaging at all: `cadquery-ocp` is a native OpenCASCADE
      binding, and a base image missing one system library fails at `import cadquery` with
      `ImportError: libGL.so.1` — at import time, before any geometry, and therefore in
      production rather than in any test, because the suite runs on a checkout where the
      developer's own machine supplies those libraries.
* (g) the templates and the viewer assets are actually IN the image — the mirror image of (d),
      and the one this gate was missing. Losing a `COPY templates/`/`COPY static/` line from
      the Dockerfile breaks nothing any other check can see: the image builds, the container
      starts, `/health` answers with a literal string that reads no file, and every check above
      stays green while every page the hub serves is a 404 or a viewer with no viewer in it.

Constraints of this runner, which shaped every choice below
------------------------------------------------------------
**This job and the docker daemon are not in the same network namespace.** Gitea's act_runner
executes the job inside its own job container while the `docker` CLI it provides drives a
daemon that lives outside it. Two consequences, both load-bearing:

* NO PORT IS PUBLISHED by anything in this file and nothing here talks to 127.0.0.1. A
  published port would land in the HOST daemon's namespace, not in this job's, so `curl
  127.0.0.1:<port>` from here reaches the runner's own loopback and finds nothing. Everything
  that has to be observed from inside a container is observed with `docker exec`.
* the same reasoning is why the test job in both workflows streams the workspace into its
  container as a tar over stdin instead of bind-mounting it: `-v "$PWD:/src"` would ask the
  HOST to mount a path that means something entirely different there.

Two properties matter and are easy to lose, so they are stated where they can be checked:

* Failures leave through SystemExit, never `assert`. Asserts vanish under PYTHONOPTIMIZE=1,
  which would silently turn this gate permanently green.
* Every check runs before anything is reported, so one run shows the full extent of the
  breakage instead of only the first broken thing. A check that CANNOT run reports itself as
  FAILED; it is never quietly skipped, which is the classic way a gate keeps reporting success
  while proving less and less.

Renaming this template
-----------------------
When this skeleton is copied into a real project, STARTUP_MARKER below has to keep matching
the string `main.py` actually logs, and the container name prefixes in both workflows have to
keep matching each other. Nothing else here carries the project's name.
"""

import json
import os
import subprocess
import sys
import time
import traceback

# The tag to test. Required rather than defaulted: a default would let a mistyped `env:` block
# in a workflow silently gate some other image that happens to be on the daemon — and a gate
# that grades the wrong artefact is worse than no gate, because it is green.
IMAGE_ENV = "SMOKE_IMAGE"
# Base name for every container this gate starts. Required for the same reason plus one more:
# the runner has a single docker daemon shared by every repository, so two concurrent runs
# must not collide on a container name. The workflows put the run id in it; a default here
# would reintroduce exactly that collision, and it would show up as a random red run rather
# than as an error anybody could read.
NAME_ENV = "SMOKE_NAME"

# The three containers this gate starts, by suffix on $SMOKE_NAME:
#   ""      the long-lived one checks (c), (d), (f) and (g) `docker exec` into. Started with a
#           sleeping command rather than the image's own so that it is a stable place to exec
#           into. Its `sleep` has to outlast the LAST of those four execs — see IDLE_COMMAND.
#   -guard  the short-lived one started with NO environment for check (b).
#   -cmd    the one started with the image's REAL command for check (e). Deliberately NOT
#           started with `--rm`: check (e) reads `docker logs` and `docker inspect` AFTER it
#           has exited, and `--rm` would have taken it away first.
# All three are NAMED rather than left to docker's random name generator, and the reason is
# the one case that matters: `subprocess` hitting its timeout kills the docker CLIENT on the
# runner, not the container on the daemon. With no name nobody could ever remove the survivor
# — not the `finally` here, not the workflow's `if: always()` step — and it would go on
# pinning the image, so the `docker rmi` at the end of the job would fail too and leave both a
# container and a few hundred MB of image on the daemon the whole fleet shares.
# Kept in step with the suffix list in both workflows' cleanup steps: if you move one, move
# the others.
GUARD_SUFFIX = "-guard"
CMD_SUFFIX = "-cmd"

# The Dockerfile's contract with this repo. Hardcoded rather than read back out of the image:
# these are the terms, so a Dockerfile that quietly changes them has to go red here and be
# looked at, not be politely followed.
APP_DIR = "/app"
DATA_DIR = "/app/data"
EXPECTED_ENTRYPOINT = ["/entrypoint.sh"]
EXPECTED_CMD = ["python", "main.py"]

# The non-root account the entrypoint drops to, and its fixed uid. The uid is pinned in the
# Dockerfile (`useradd -m -u 1000 app`) because a named volume keeps the numeric owner across
# image rebuilds: a uid that drifted would leave an existing volume owned by a user that no
# longer exists, and the service would lose its own state directory.
APP_USER = "app"
APP_UID = 1000

# What the startup guard has to say when the environment is missing. Both fragments come from
# src/config_errors.py, which is THIS REPO'S OWN wording — that is what makes matching on them
# safe, unlike matching on a message pydantic is free to reword.
GUARD_FRAGMENT = "Missing required variable(s)"
# EVERY field src/settings.py declares with no default, spelled the way config_errors.py prints
# it: SCREAMING_CASE, i.e. the name of the ENVIRONMENT VARIABLE an operator has to set, not the
# lowercase field name pydantic reports internally.
#
# A LIST rather than one name, and check (b) below casts one verdict per entry, because the
# thing being proved is not "the guard mentioned a variable" — it is that whoever redeploys the
# stack is told about EACH key they dropped. config_errors.py collects all of them and prints
# them together, so a guard that regressed to naming only the first one would still satisfy a
# check that looked for a single name, and the operator would fix PUBLISH_TOKEN, redeploy, and
# meet the identical failure again over COMMENT_READ_TOKEN. Two variables is exactly where that
# regression becomes possible and invisible at the same time.
#
# Keep this in step with the no-default fields in src/settings.py: a credential added there
# without a line here is a key the gate never proves the guard names.
REQUIRED_VARIABLES = ["PUBLISH_TOKEN", "COMMENT_READ_TOKEN"]

# Paths that must NOT be inside the image. Every one of them is excluded by .dockerignore, and
# today the Dockerfile also copies its files one by one rather than with a blanket `COPY . .`
# — so this check is defence in depth for the day somebody widens that copy list, which is a
# one-line change that looks harmless in review.
EXCLUDED_PATHS = ["/app/tests", "/app/.env", "/app/.venv"]

# Paths that MUST be inside the image — the mirror of the list above, and it exists because the
# two failures are not symmetrical in how loudly they announce themselves. A file that should
# not be there is a leak nobody notices; a file that should be there and is not takes the whole
# site down, and yet it is the one this gate could not see.
#
# Nothing else in the pipeline covers it. The suite runs against a CHECKOUT, where `templates/`
# and `static/` are simply present, so it cannot be missing there; the Dockerfile copies those
# two trees on lines of their own (`COPY templates/ templates/`, `COPY static/ static/`), and
# dropping either one — or renaming a directory on one side of a COPY — still produces an image
# that builds, starts, drops privileges, prints its startup marker and answers `/health` with a
# literal string that touches no file on disk. Every check above therefore stays green, and the
# breakage surfaces on the first real request.
#
# The five entries are the ones whose absence has no other symptom: one template per page the
# hub serves — the index at `/`, one build's page, and the pointer page at `/project/<pid>/`,
# which `render.pointer_page_html()` serves as a PAGE rather than as a redirect — plus the two
# halves of the viewer payload. `three-cad-viewer.esm.js` is 3.5 MB and `viewer.js` is the hub's
# own driver for it — a page that loads one without the other renders an empty canvas with an
# error only in the browser console, i.e. nowhere CI can look.
# Deliberately not the whole tree: this is a tripwire on the COPY lines, not an inventory, and a
# list that had to be updated for every new asset would be edited to match the image rather than
# the other way round. Templates ARE listed one per page, though, because each of the three is
# reached by a different URL and a missing one breaks only that URL.
REQUIRED_PATHS = [
    "/app/templates/index.html",
    "/app/templates/build.html",
    "/app/templates/pointer.html",
    "/app/static/_v/three-cad-viewer.esm.js",
    "/app/static/_v/viewer.js",
]

# --- check (f): the CAD kernel -------------------------------------------------------------
# The imports the hub's own code is entitled to make, as (module, symbol) — an empty symbol
# means a plain `import module`. Written as data rather than as three lines of probe source so
# that the verdict count below can be DERIVED from it and cannot go stale when one is added.
#
# `ocp_tessellate.convert` is named down to the symbol on purpose: `import ocp_tessellate` on
# its own succeeds without pulling in the half that matters, so it would keep passing on a
# release that moved or renamed the exporter, which is the whole viewer payload.
CAD_IMPORTS = (
    ("cadquery", ""),
    ("ocp_tessellate.convert", "export_three_cad_viewer_js"),
    ("trimesh", ""),
)

# The versions the image is required to carry, keyed by DISTRIBUTION name (what
# importlib.metadata knows them as) rather than by import name — `cadquery-ocp` has no import
# name at all, and `ocp-tessellate` imports as `ocp_tessellate`.
#
# Copied from requirements.txt on purpose rather than parsed out of it: this is the gate's OWN
# independent statement of the contract, so a requirements.txt edited without thought has to
# come here and disagree out loud. Keep the two in step — one edit in the same commit, and that
# is the price of the check.
#
# `cadquery-ocp` is the row that earns this check the most. cadquery 2.8.0 declares it as
# `cadquery-ocp<8.0,>=7.9.3.1` — a RANGE — so it is requirements.txt's explicit pin, and nothing
# in cadquery itself, that keeps the geometry kernel from moving under every model this hub
# serves between two builds of an unchanged Dockerfile. This row is what proves that pin
# actually took effect in the built image, which is a different question from whether it is
# written down.
PINS = {
    "cadquery": "2.8.0",
    "cadquery-ocp": "7.9.3.1.1",
    "ocp-tessellate": "3.4.1",
    "trimesh": "4.12.2",
}

# Marks the start of the CAD probe's machine-readable verdicts on the container's stdout. A
# sentinel rather than "parse the whole output as JSON" because the output is NOT clean:
# OpenCASCADE and VTK write warnings of their own accord, and neither this file nor the probe
# controls them. Everything before the LAST occurrence of this line is discarded, and of what
# follows it only the first non-empty line is parsed — noise arrives on BOTH sides, since OCCT's
# and VTK's static destructors print during interpreter finalisation, after the payload. A run
# that lacks the sentinel entirely is treated as a probe that never reported, not as an empty
# pass. parse_cad_verdicts() below spells out why each half of that matters.
CAD_SENTINEL = "---HAMMEROLA-CAD-PROBE-JSON---"

# The probe, run by the image's OWN interpreter inside the already-running probe container. It
# takes one JSON argument — the imports, the pins and the sentinel — so that the constants above
# stay the single place any of that is written on this side of the boundary, and it answers with
# one JSON object mapping the key it was given to a reason string or null.
#
# It reports FACTS and leaves the prose to check_cad_kernel() below: the runner knows which key
# is which and can say what a failure means, while everything in here has to survive being
# squeezed through `python -c`.
#
# Delivered as `-c` rather than on stdin because that keeps `docker()` a one-argument-list
# function; the script is a couple of kilobytes, far under any ARG_MAX. Note that with `-c` the
# script itself is NOT argv[0] — `python -c SRC arg` gives `sys.argv == ["-c", arg]` — so the
# request is argv[1].
#
# Every check is individually wrapped, and the sentinel is printed only at the very END: a probe
# that died unexpectedly therefore produces NO verdicts at all rather than a truncated set that
# would look like a smaller gate passing.
CAD_PROBE_SOURCE = r"""
import json
import sys
import traceback

request = json.loads(sys.argv[1])
verdicts = {}


def crash(error):
    return "{}: {}\n{}".format(type(error).__name__, error, traceback.format_exc())


for key, module, symbol in request["imports"]:
    try:
        # fromlist is what makes __import__ hand back the SUBMODULE rather than the top-level
        # package, which is the only form `ocp_tessellate.convert` can be checked through.
        imported = __import__(module, fromlist=["__name__"])
        if symbol:
            getattr(imported, symbol)
    except Exception as error:
        verdicts[key] = crash(error)
    else:
        verdicts[key] = None

metadata_problem = None
try:
    from importlib.metadata import version as dist_version
except Exception as error:
    dist_version = None
    metadata_problem = crash(error)

for key, name, expected in request["pins"]:
    if dist_version is None:
        verdicts[key] = "importlib.metadata is unavailable\n" + metadata_problem
        continue
    try:
        actual = dist_version(name)
    except Exception as error:
        verdicts[key] = (
            "it is not installed at all, or its metadata cannot be read\n" + crash(error))
        continue
    if actual == expected:
        verdicts[key] = None
    else:
        verdicts[key] = "the image has {} instead".format(actual)

print(request["sentinel"])
print(json.dumps(verdicts))
"""

# How many verdicts each probe below is REQUIRED to return, compared against what it actually
# returned before anything is reported. Every probe builds a local `targets` tuple first and
# returns exactly one row per target on every path it can take — including the paths where the
# container could not be started at all, which report every target as failed rather than
# returning nothing. So these numbers are a property of the SOURCE, not of a particular run,
# and any run that disagrees with them is a run in which a check went missing.
#
# What this defends against is this gate's own worst failure mode, and it is the one thing no
# other check in the pipeline can catch: a probe that quietly stops probing. A check dropped
# in a refactor, a new early-return path that forgets to emit its rows, an `if ...: return []`
# left behind after debugging — none of those print a thing, none of them contribute a
# failure, and the run still ends on `smoke ok: N/N targets`, because N is counted from the
# rows that happened to arrive and therefore agrees with itself no matter how few there are.
# The image then goes to the registry and to production with the gate reporting green about
# checks it is no longer performing.
#
# THE ONE WAY TO MISUSE THIS: when a mismatch fires, do NOT edit the number to match what the
# run produced. The number is the claim; the run is the evidence that the claim has become
# false. "Fixing" it that way converts the tripwire into a rubber stamp forever — it will
# agree with every future run, however many checks disappear afterwards, and it will do so
# silently. The fix is to work out WHICH probe stopped returning a verdict and why.
#
# MAINTENANCE CONTRACT: adding or removing a check means editing this constant IN THE SAME
# COMMIT as the probe. A commit that changes what a probe returns and leaves this line alone
# is precisely the commit this constant exists to catch, so the cost of keeping it honest is
# paid where the change is being made and reviewed, not months later.
#
# main() enforces that from three directions, not one, and the comments there say why each is
# needed: the NUMBER of probe groups, the count each individual group returns, and the sum of
# them all. Only the middle one is the obvious check, and on its own it has a hole exactly where
# it matters — a probe DELETED from the `produced` tuple, rather than left in place returning
# nothing, is compared against no declaration at all and so cannot disagree with one.
#
# The counts are derived from the source wherever a derivation exists — the excluded-path and
# required-path sweeps emit one row per path, so they are written as `len(EXCLUDED_PATHS)` and
# `len(REQUIRED_PATHS)` and cannot go stale when either list grows; (b) is its two fixed rows
# plus one per required variable, and (f) is one row per declared import plus one per pin for
# the same reason. The rest are literals because the `targets` tuples they count are literal,
# and a literal that has to be kept in step is the entire point here.
#
# Each label carries the probe's LETTER — the same (a)…(g) the list at the top of the module
# docstring uses and each probe's own docstring opens with. That prefix is not decoration: this
# label is the only thing a self-check failure gives whoever reads the run, and a label phrased
# in words of its own would make them grep for prose that appears nowhere else in this file.
# With the letter, the message points straight at the paragraph that says what the missing check
# was for.
EXPECTED_TARGETS = (
    ("(a) image contract", 4),
    # The exit code and the guard's own wording, plus one row per variable it has to name.
    ("(b) required-variable guard", 2 + len(REQUIRED_VARIABLES)),
    ("(c) privileges dropped", 4),
    ("(d) excluded paths", len(EXCLUDED_PATHS)),
    ("(e) startup", 2),
    ("(f) CAD kernel", len(CAD_IMPORTS) + len(PINS)),
    ("(g) required paths", len(REQUIRED_PATHS)),
)

# The environment the probe and real-command containers run with. The value is invented here
# and reaches nothing: this gate has to be runnable on a pull request, where the deployment's
# real token does not exist and should not. PUBLISH_TOKEN is a shared secret compared for
# equality against the `Authorization: Bearer` header, so it has no format to satisfy and any
# non-empty string starts the image. If a future variable here DOES get format-validated at
# construction time, give it a value of the right shape — otherwise startup fails for a reason
# that has nothing to do with the image this gate is meant to be judging.
SMOKE_ENV = [
    "PUBLISH_TOKEN=fake-smoke-token-not-real-0123456789abc",
    # The second credential, and the same reasoning applies to it: it guards
    # reading the comment queue (SPEC 7A.2), the hub only ever compares it, and
    # without it the container declines to start — which would make check (e)
    # fail for a reason that has nothing to do with the image.
    "COMMENT_READ_TOKEN=fake-smoke-comment-read-token-not-real",
]

# The command the probe container runs INSTEAD of the image's own. It still goes through
# ENTRYPOINT (docker only replaces CMD), which is the entire point: the entrypoint runs as
# root, heals /app/data and execs `gosu app sleep 900`, so PID 1 in that container is exactly
# what check (c) wants to look at. Check (e) covers the real command separately, in its own
# container, which is where that question belongs.
# 900 s is measured from the moment THIS container starts, so it is not a bound on the gate as
# a whole and the two must not be confused. What it has to outlast is the last `docker exec`
# into it — check (g), the required-path sweep — and the arithmetic below puts the start of this
# container at 240 s and the end of that exec at 675 s in the worst case, i.e. 435 s of its own
# life used out of 900. Adding another exec into this container eats into that margin; adding a
# call BEFORE it starts does not. The container is removed in a `finally` regardless, and the
# workflow removes it again under `if: always()`.
IDLE_COMMAND = ["sleep", "900"]

# The first line `main.py` logs. Its presence proves the settings parsed — i.e. every required
# variable arrived (both of them: PUBLISH_TOKEN and COMMENT_READ_TOKEN, the two SMOKE_ENV
# supplies) and validation was satisfied — and that logging was configured at the declared
# LOG_LEVEL. RENAME THIS TOGETHER WITH main.py when the template is copied.
STARTUP_MARKER = "Starting hammerola"
# The markers check (e) waits for, in the order main.py emits them. There is only one today,
# and the poll below still waits for the WHOLE list rather than for the first entry. That is
# not tidiness, it is the fix for a real bug the moment a second marker is added: separate log
# lines are written by separate statements, so a poll that stopped at the FIRST marker would
# then judge the rest against a snapshot of the log taken microseconds after that first line
# was flushed. Locally the gap is milliseconds, which is why it looks fine; on the runner the
# container starts on a freshly written overlay and anything that fsyncs between the lines
# grows the gap by orders of magnitude. What that buys is a FALSE RED on the gate that blocks
# publication — intermittently refusing to ship a perfectly good image, which is the most
# expensive kind of flake there is, because the second run passes and everybody learns that a
# red gate means nothing.
STARTUP_MARKERS = (STARTUP_MARKER,)

# Bounds. Every docker call gets one, because a gate that hangs is worse than a gate that
# fails: it holds a slot on a runner the whole fleet queues for until the step timeout kills
# it, and a killed step never runs its own cleanup.
# The numbers are generous against the real cost — this image starts in about a second — and
# are sized for a shared runner under load right after a build. Their worst-case SUM is what
# the smoke step's `timeout-minutes` in both workflows has to exceed, so it is spelled out
# here, in the order the calls actually happen:
#    30 (inspect image config)
#  + 30 (rm guard)          + 90 (guard run, no environment)
#  + 30 (rm probe)          + 60 (probe run -d)
#  + 30 (exec: /proc/1/status)                + 30 (exec: getent passwd)
#  + 30 (exec: stat /app/data)                + 30 (exec: write test as app)
#  + 30 (exec: excluded-path sweep)
#  + 30 (rm cmd)            + 60 (cmd run -d)
#  + 45 (startup poll: 30 s budget + one final 15 s `logs`)
#  + 30 (inspect cmd state)
#  + 90 (exec: CAD kernel probe)
#  + 30 (exec: required-path sweep)
#  + 30 (rm probe, finally) + 30 (rm cmd, finally)
#  = 735 s, a little over 12 minutes. Both workflows allow 14 (840 s), and that headroom was
# raised together with the CAD probe below — a step timeout that does not exceed this sum turns
# a slow-but-healthy run into a killed step whose own container cleanup never executes. The
# remaining 105 s of margin is what a further exec into the probe container would spend, so
# adding one means revisiting `timeout-minutes` in both workflows rather than only this sum.
# Three of these `rm`s are PRE-run cleanups: every container is removed by name before it is
# started, so a re-run from the Gitea UI — which keeps the same run id, hence the same
# $SMOKE_NAME — cannot die on "name already in use".
INSPECT_TIMEOUT = 30
REMOVE_TIMEOUT = 30
GUARD_TIMEOUT = 90
START_TIMEOUT = 60
EXEC_TIMEOUT = 30
LOGS_TIMEOUT = 15
# The CAD probe gets a bound of its own, three times the others, and the reason is the size of
# what it touches rather than the work it does. `import cadquery` maps ~222 MB of OpenCASCADE
# shared objects plus VTK, and the FIRST time that happens in a freshly built image every one
# of those pages is read off a cold overlay on a runner the whole fleet shares. Warm, the probe
# takes a couple of seconds; the margin is for the cold case, and it is the one call in this
# file where a 30 s bound could produce a red gate on a perfectly good image.
CAD_TIMEOUT = 90

# The startup-marker poll, bounded in WALL CLOCK rather than in attempts: each attempt shells
# out to `docker logs`, whose own timeout is 15 s, so an attempt-counted bound would multiply
# into minutes the moment the daemon got slow. The marker is the first thing main.py logs, so
# it arrives within a second of the container starting; 30 s is roughly thirty times that.
STARTUP_BUDGET = 30
STARTUP_PAUSE = 0.5

# How much of an unexpected output reaches the log. Container logs can run to thousands of
# lines when something loops, and an unbounded dump would bury the verdict.
EXCERPT_CHARS = 4000

# Exit codes. A broken check and a gate that could not start are different problems for
# whoever reads the run list, so they are different codes.
EXIT_CHECKS_FAILED = 1
EXIT_MISCONFIGURED = 2
# A third code, for the EXPECTED_TARGETS self-check finding that a probe returned fewer (or
# more) verdicts than it declares. Deliberately NOT folded into EXIT_CHECKS_FAILED, because
# the two demand opposite reactions from whoever reads the run. A 1 means "this image is
# broken, do not ship it", and the next commit fixes the image; a 3 means "this gate has been
# lying, find out since when", and the question it opens is about every image that already
# went out while a check was silently not running. Sharing one code would file the second
# question under the first and it would never get asked.
#
# The `__main__` block at the bottom of this file exits 3 for an UNHANDLED EXCEPTION too, and
# that is the same statement rather than a second meaning bolted onto the code: a gate that
# crashed did not grade the image either. Without that block CPython would exit 1 on a
# traceback, i.e. report a broken GATE as a broken IMAGE and send whoever reads the run to
# inspect an artefact that may be perfectly fine — the exact confusion this third code exists
# to prevent.
EXIT_SELF_CHECK = 3

# Fed to `sh -c` inside the container to answer "which of these paths exist". Written as a
# script plus positional arguments rather than as an interpolated string: subprocess passes
# argv straight to exec with no shell on the runner side, so `sh -c SCRIPT sh path1 path2`
# puts the paths in "$@" untouched — nothing here can be broken by a path that contains a
# space, a quote or a `$`.
# Shared by checks (d) and (g), which ask opposite questions of the same script: it reports
# `present`/`absent` per path and says nothing about which of the two is wanted, so each caller
# supplies its own verdict. That is also why neither of them treats a MISSING line as a pass —
# "the sweep said nothing about this path" is a third answer, and reading it as either of the
# other two is how a sweep that silently stopped covering a path would go green.
PRESENCE_SCRIPT = (
    'for p in "$@"; do '
    'if [ -e "$p" ]; then echo "present $p"; else echo "absent $p"; fi; '
    'done'
)

# Fed to `sh -c` to prove the data directory is writable by creating and removing one file.
# `set -e` so a failed truncate is a non-zero exit rather than a silently ignored line.
WRITE_SCRIPT = 'set -e; : > "$1"; rm -f "$1"'
WRITE_PROBE_FILE = DATA_DIR + "/.smoke-write-check"


def excerpt(text):
    """Bound what reaches the log, and say so when something was cut."""
    if text is None:
        return ""
    if isinstance(text, bytes):
        # subprocess.TimeoutExpired.output is str under text=True on every version this runs
        # on, but this is the one path whose whole value is showing the output of a call that
        # went wrong — a TypeError here would destroy exactly the evidence it was fetched for.
        text = text.decode("utf-8", "replace")
    if len(text) <= EXCERPT_CHARS:
        return text
    return text[:EXCERPT_CHARS] + "\n[... truncated at {} characters]".format(EXCERPT_CHARS)


def describe(error):
    """Type and message of an exception, for a report row."""
    return "{}: {}".format(type(error).__name__, error)


def docker(args, timeout):
    """Run a docker command.

    Returns (status, output) with stderr folded into stdout, because everything here is read
    by a human out of a CI log where the interleaving is the useful part.

    A status of None means the command produced NO EXIT CODE AT ALL — it ran out its timeout,
    or docker is not on PATH — and `output` then explains which. That is deliberately not the
    same thing as a non-zero exit and is never reported with the same wording: "the container
    exited 1" is a finding about the image, while "the docker client never came back" is a
    finding about the runner, and folding them together is how a broken runner starts looking
    like a broken application.
    """
    argv = ["docker"] + args
    try:
        completed = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            text=True)
    except FileNotFoundError:
        return None, (
            "`docker` is not on PATH. This gate drives the daemon from the runner, so it "
            "cannot run anywhere the docker CLI is missing")
    except subprocess.TimeoutExpired as error:
        return None, "`{}` did not finish within {} s. Output so far:\n{}".format(
            " ".join(argv), timeout, excerpt(error.output))
    return completed.returncode, completed.stdout or ""


def remove_container(name):
    """Remove one of this gate's containers by name, together with its anonymous volumes.

    Best effort: the result is deliberately not inspected and this is never the reason a check
    fails. A container that is already gone, or a docker that is momentarily unhappy, must not
    turn into a red verdict about the image.

    `-v` is here even though this template's Dockerfile declares no `VOLUME` yet, and this is
    the removal path where it matters MOST rather than a copy of the flag the workflows carry.
    Two different things remove these containers: this function — before each container is
    started, and again in main()'s `finally` — and the `if: always()` cleanup step in both
    workflows. On every normal run it is THIS one that removes the two containers started
    without `--rm` (the probe and the `-cmd` one; the `-guard` one runs with `--rm`, so the
    daemon removes it and takes its anonymous volumes along), so the workflow step finds
    nothing left and its own `-v` applies to nothing; that step exists for the run where this
    process was killed by the smoke step's `timeout-minutes` and never reached its `finally`.
    So on the day a project adds a `VOLUME` to its Dockerfile, a `-v` present only in the
    workflows would cover exactly the runs that do not normally happen, while every ordinary
    run leaked one anonymous volume for each of those two containers onto a daemon the whole
    fleet shares — nothing names it, nothing ever collects it, and the disk grows forever.
    Both paths carry the flag; if you change one, change the other. It cannot take anything
    else with it: `docker rm -v` removes only the anonymous volumes belonging to that one
    container, never a named volume such as the ones docker-compose creates.
    """
    docker(["rm", "-f", "-v", name], REMOVE_TIMEOUT)


def environment_flags():
    """SMOKE_ENV as `-e VAR=value` pairs for a `docker run` argument list."""
    flags = []
    for pair in SMOKE_ENV:
        flags.extend(["-e", pair])
    return flags


def check_image_contract(image):
    """(a) What the image DECLARES: how it is started, where it runs, how it is buffered.

    All four come out of one `docker inspect`, so a failure to inspect at all fails all four
    rather than being reported once and leaving three checks unaccounted for.
    """
    entrypoint_target = "the image's ENTRYPOINT is {}".format(EXPECTED_ENTRYPOINT)
    cmd_target = "the image's CMD is {}".format(EXPECTED_CMD)
    workdir_target = "the image's WORKDIR is {}".format(APP_DIR)
    unbuffered_target = "the image declares PYTHONUNBUFFERED=1"
    targets = (entrypoint_target, cmd_target, workdir_target, unbuffered_target)

    status, output = docker(
        ["inspect", "--format", "{{json .Config}}", image], INSPECT_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for target in targets]
    if status != 0:
        reason = (
            "docker inspect exited {} — the tag does not exist on this daemon, so the build "
            "step and this step disagree about what was built. Output:\n{}".format(
                status, excerpt(output)))
        return [(target, reason) for target in targets]
    try:
        config = json.loads(output)
    except ValueError as error:
        reason = "docker inspect returned something that is not JSON ({}): {}".format(
            describe(error), excerpt(output))
        return [(target, reason) for target in targets]

    rows = []

    # The ENTRYPOINT is the whole privilege-drop mechanism (see check (c)): docker prepends it
    # to whatever command it is given, so losing it turns every `docker run` of this image —
    # here and in production — into a process that keeps running as root.
    entrypoint = config.get("Entrypoint")
    rows.append((entrypoint_target, None if entrypoint == EXPECTED_ENTRYPOINT else (
        "it is {!r}. The entrypoint is what drops privileges and what heals /app/data "
        "ownership; without it the container runs whatever it was given, as root".format(
            entrypoint))))

    # Production runs the image's own command and so does check (e) below — a silent change
    # here means the gate and the deployment are describing two different programs.
    cmd = config.get("Cmd")
    rows.append((cmd_target, None if cmd == EXPECTED_CMD else (
        "it is {!r}. Check (e) below starts the container with the image's own command "
        "precisely so that the gate cannot drift from what production runs".format(cmd))))

    # Not cosmetic: `src/settings.py` defaults `data_dir` to the RELATIVE path `data`, and
    # `Store` resolves it with `Path(data_dir).resolve()` — i.e. against the process's working
    # directory. Moving the WORKDIR therefore puts every build, every pointer and every comment
    # somewhere that is not the mounted volume, which looks like it works right up until the
    # container is recreated and all of it is gone.
    #
    # The other two trees this image is made of do NOT depend on this row, and the difference is
    # worth stating because the reflex is to assume they do: `render.TEMPLATES_DIR` and
    # `app.STATIC_DIR` are both `Path(__file__).resolve().parent.parent / ...`, so `templates/`
    # and `static/` are anchored to where the CODE lives (/app) and survive a changed WORKDIR
    # untouched. That is exactly why they need a check of their own rather than this one, and
    # check (g) below is it — it asks for those files at their absolute paths.
    working_dir = config.get("WorkingDir")
    rows.append((workdir_target, None if working_dir == APP_DIR else (
        "it is {!r}. Relative paths — the data directory above all — resolve against the "
        "working directory, so state ends up outside the mounted volume and is lost on the "
        "next redeploy".format(working_dir))))

    # This one exists to protect check (b) rather than to protect production directly, which
    # is why it lives up here in the contract check.
    # Docker gives a container a pipe, not a terminal, and CPython block-buffers a pipe. The
    # only thing check (b) can observe is the text that actually made it OUT of the container,
    # and a process that is killed by a signal or leaves through `os._exit()` skips the flush
    # entirely — so the guard would exit non-zero with no explanation at all, and check (b)
    # would have nothing to match on and no way to tell "the guard fired" from "something else
    # broke". Dropping this ENV line from the Dockerfile is a one-line edit that costs no test
    # anywhere else in this repo; this row is what makes it cost a red gate.
    env = config.get("Env") or []
    rows.append((unbuffered_target, None if "PYTHONUNBUFFERED=1" in env else (
        "it does not. Container stdout is a pipe and CPython block-buffers a pipe, so "
        "anything written shortly before the process dies can be lost instead of reaching "
        "`docker logs` — including the startup guard's own message, which is the only thing "
        "check (b) below has to look at. Declared Env: {!r}".format(env))))

    return rows


def check_required_variable_guard(image, name):
    """(b) The image refuses to start without its required variables, AND NAMES EVERY ONE.

    Started with NO environment at all — no `-e` of any kind — which is the shape of the real
    accident: a stack redeployed after somebody dropped a variable out of the compose file or
    the `.env`.

    Separate rows, because the exit code ALONE is worth very little here. A typo in an
    import, a wheel that failed to install, a syntax error in a module — every one of those
    also exits non-zero with no environment set, and every one of them would let this check
    report success while the guard it claims to be testing had quietly stopped existing. So
    the exit code is one row and the things the message has to contain are the rest:

      * the class of the problem (`Missing required variable(s)`), which is what tells an
        operator this is a configuration fault and not a crash;
      * the NAME of the variable, which is the difference between a five-second fix and
        reading the source of a container that will not start.

    That second bullet is ONE ROW PER VARIABLE rather than one row for the set, and with two
    credentials that is no longer a formality. config_errors.py collects every missing key and
    prints them together; a regression to naming only the first — a `[0]`, a `next(...)`, a
    loop rewritten as a lookup — would still satisfy a check that searched the output for a
    single name, and the operator would then set PUBLISH_TOKEN, redeploy, and meet the exact
    same failure again over COMMENT_READ_TOKEN, one round trip per variable. Asking about each
    one separately is also what makes the failure readable: the row names the key the guard
    stopped mentioning.

    With `restart: always` in production the container gets restarted either way, so that
    message is the ONLY signal that separates "somebody dropped a variable" from an image that
    is simply broken.
    """
    exit_target = "the image exits non-zero when started with no environment at all"
    class_target = "...and its output says {!r}".format(GUARD_FRAGMENT)
    variable_targets = [
        (variable, "...and its output names {}".format(variable))
        for variable in REQUIRED_VARIABLES
    ]
    targets = [exit_target, class_target] + [target for _, target in variable_targets]

    # Pre-run removal: a re-run from the UI keeps the same run id and therefore the same
    # container name, and `--rm` does not help when a previous run was killed mid-flight.
    remove_container(name)

    status, output = docker(
        ["run", "--rm", "--name", name, image], GUARD_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for target in targets]

    rows = []
    if status == 0:
        rows.append((exit_target, (
            "it exited 0. The image came up with no configuration at all, which means the "
            "guard in src/config_errors.py no longer fires — a variable dropped from the "
            "compose file would now produce a running container pointed at nothing instead "
            "of a loud failure. Output:\n{}".format(excerpt(output)))))
    else:
        rows.append(("{} (exit {})".format(exit_target, status), None))

    if GUARD_FRAGMENT in output:
        rows.append((class_target, None))
    else:
        rows.append((class_target, (
            "it does not. The container exited {} without the configuration guard's own "
            "wording, so this failure is indistinguishable from an import error or a missing "
            "wheel — and the exit code above therefore proves nothing about the guard. "
            "Output:\n{}".format(status, excerpt(output)))))

    for variable, variable_target in variable_targets:
        if variable in output:
            rows.append((variable_target, None))
        else:
            rows.append((variable_target, (
                "it does not. Whoever redeploys the stack is told that something is missing "
                "but not that {} is part of it, which turns a five-second fix into reading the "
                "source of a container that will not start — or, when the guard names some of "
                "the missing keys and not this one, into fixing them one redeploy at a time. "
                "Output:\n{}".format(variable, excerpt(output)))))

    return rows


def parse_pid1_uid(status_text):
    """Real uid of PID 1, out of the `Uid:` line of /proc/1/status.

    The kernel writes that file, so it is present in every image regardless of what userland
    it ships — unlike `ps`, which python:3.11-slim does not carry at all.
    Returns (uid, None) or (None, reason).
    """
    for line in status_text.splitlines():
        if not line.startswith("Uid:"):
            continue
        fields = line.split()
        # `Uid:  <real> <effective> <saved> <fs>`
        if len(fields) < 2:
            return None, "the Uid line of /proc/1/status is {!r}".format(line)
        try:
            return int(fields[1]), None
        except ValueError as error:
            return None, "the Uid line of /proc/1/status does not parse ({}): {!r}".format(
                describe(error), line)
    return None, "/proc/1/status has no Uid line at all:\n{}".format(excerpt(status_text))


def check_privileges_dropped(name, blocked=None):
    """(c) The container's own process is `app`, not root, and owns its state directory.

    This is the ONLY reason entrypoint.sh exists. There is no `USER` line in the Dockerfile —
    on purpose, because the entrypoint has to start as root to fix the ownership of a volume
    that older images left owned by root — so nothing in the image DECLARES a non-root user
    and no `docker inspect` can answer this question. If the entrypoint stops dropping
    privileges, absolutely nothing else changes: the image builds, the container starts, the
    service works, the logs look the same. It just runs as root, and it goes on running as
    root for as long as nobody happens to look.

    Note what is being asked and of which process. `docker exec` does NOT go through the
    ENTRYPOINT and does NOT inherit the gosu drop — it runs as the image's configured user,
    which here is root, because the Dockerfile deliberately declares none. So an `id -u` in
    the exec'd shell would print 0 in a perfectly healthy container and 0 in a broken one, and
    would be worth nothing. The question is about PID 1 — the process the entrypoint exec'd
    into — and it is answered by reading /proc/1/status, which the kernel writes.

    One branch of the entrypoint is NOT exercised here and it is worth knowing which: the
    `chown -R app:app /app/data` that heals a volume left owned by root. Reaching it needs a
    root-owned mount, and a bind mount named from this job container does not resolve on the
    host daemon (see the module docstring). What is checked is the state that matters at
    runtime — the process is `app` and it can write its own data directory.
    """
    uid_target = "the container's main process runs as uid {}".format(APP_UID)
    account_target = "uid {} is the `{}` account inside the image".format(APP_UID, APP_USER)
    owner_target = "{} is owned by {}".format(DATA_DIR, APP_USER)
    write_target = "{} is writable by the {} account".format(DATA_DIR, APP_USER)
    targets = (uid_target, account_target, owner_target, write_target)

    if blocked is not None:
        return [(target, blocked) for target in targets]

    rows = []

    status, output = docker(["exec", name, "cat", "/proc/1/status"], EXEC_TIMEOUT)
    if status is None:
        rows.append((uid_target, "not attempted: " + output))
    elif status != 0:
        rows.append((uid_target, (
            "/proc/1/status could not be read (docker exec exited {}):\n{}".format(
                status, excerpt(output)))))
    else:
        uid, reason = parse_pid1_uid(output)
        if uid is None:
            rows.append((uid_target, reason))
        elif uid == 0:
            rows.append((uid_target, (
                "it runs as uid 0. The entrypoint is no longer dropping privileges, so this "
                "image runs its whole service as root — and nothing else about it looks any "
                "different, which is why this can go unnoticed for years")))
        elif uid != APP_UID:
            rows.append((uid_target, (
                "it runs as uid {}. The uid is pinned in the Dockerfile because a named "
                "volume keeps the numeric owner across rebuilds: a drifted uid leaves the "
                "existing volume owned by somebody else and the service loses its own state "
                "directory".format(uid))))
        else:
            rows.append((uid_target, None))

    status, output = docker(["exec", name, "getent", "passwd", str(APP_UID)], EXEC_TIMEOUT)
    # `getent` rather than `id -nu`: it comes from libc-bin, which is present in every Debian
    # image by construction, and it answers the question in the direction that matters — which
    # account owns the pinned uid.
    if status is None:
        rows.append((account_target, "not attempted: " + output))
    elif status != 0:
        rows.append((account_target, (
            "there is no passwd entry for uid {} at all (getent exited {}). The Dockerfile's "
            "`useradd -m -u {} {}` is gone or did not run, so the uid the volume is owned by "
            "belongs to nobody".format(APP_UID, status, APP_UID, APP_USER))))
    else:
        # `app:x:1000:1000::/home/app:/bin/sh`
        account = output.strip().split(":", 1)[0]
        if account == APP_USER:
            rows.append((account_target, None))
        else:
            rows.append((account_target, (
                "uid {} belongs to {!r} instead. The entrypoint drops to `{}` by name while "
                "the volume is owned by number, so the two have to keep agreeing".format(
                    APP_UID, account, APP_USER))))

    status, output = docker(["exec", name, "stat", "-c", "%U", DATA_DIR], EXEC_TIMEOUT)
    if status is None:
        rows.append((owner_target, "not attempted: " + output))
    elif status != 0:
        rows.append((owner_target, (
            "{} could not be stat'd (docker exec exited {}). The Dockerfile creates it with "
            "`mkdir -p data`, and docker seeds a fresh named volume from it — a missing "
            "directory means a volume that starts owned by root:\n{}".format(
                DATA_DIR, status, excerpt(output)))))
    else:
        owner = output.strip()
        if owner == APP_USER:
            rows.append((owner_target, None))
        else:
            rows.append((owner_target, (
                "it is owned by {!r}. Docker copies this directory's ownership into a named "
                "volume the first time that volume is initialised, so the wrong owner here "
                "is baked into every deployment's volume from its first start".format(owner))))

    # Run as the account itself — `-u app` resolves through the image's own passwd file and so
    # picks up the account's real primary group, which a numeric `-u 1000` would not. Asking
    # root whether the directory is writable would answer yes in every case, including the
    # broken ones.
    status, output = docker(
        ["exec", "-u", APP_USER, name, "sh", "-c", WRITE_SCRIPT, "sh", WRITE_PROBE_FILE],
        EXEC_TIMEOUT)
    if status is None:
        rows.append((write_target, "not attempted: " + output))
    elif status != 0:
        rows.append((write_target, (
            "it is not (exit {}). The service writes all of its mutable state under {}, so a "
            "container that cannot write there comes up and then fails at the first thing it "
            "tries to persist:\n{}".format(status, DATA_DIR, excerpt(output)))))
    else:
        rows.append((write_target, None))

    return rows


def sweep_paths(name, paths):
    """Ask the container which of `paths` exist. Shared by checks (d) and (g).

    Returns (seen, None, output) where `seen` maps each path the sweep reported to "present" or
    "absent", or (None, reason, output) when the sweep could not be run at all. Both callers
    fail EVERY one of their rows on that second shape: a sweep that did not run has not proved
    anything about any path, and reporting fewer rows than declared is what the self-check in
    main() exists to catch.

    The parsing lives here rather than in each caller because the two ask OPPOSITE questions of
    the same output — (d) wants "absent", (g) wants "present" — and a copy of this loop that
    drifted would let one of them start reading a missing line as its own good answer. The
    verdict stays with the caller; only the facts are shared.
    """
    status, output = docker(
        ["exec", name, "sh", "-c", PRESENCE_SCRIPT, "sh"] + list(paths), EXEC_TIMEOUT)
    if status is None:
        return None, "not attempted: " + output, output
    if status != 0:
        return None, "the path sweep could not be run (docker exec exited {}):\n{}".format(
            status, excerpt(output)), output

    seen = {}
    for line in output.splitlines():
        fields = line.split(None, 1)
        if len(fields) == 2 and fields[0] in ("present", "absent"):
            seen[fields[1]] = fields[0]
    return seen, None, output


def check_excluded_paths(name, blocked=None):
    """(d) `.dockerignore` did its job: the build context left the wrong things behind.

    `.env` is the one that matters most here, and it is not really about image size. A `.env`
    baked into an image that gets PUSHED to the registry is a credential leak that leaves no
    trace whatsoever: the container behaves identically, the logs are identical, the compose
    file is identical, and the only way anybody ever finds out is by unpacking the published
    layers by hand.

    `.venv` is worth stating precisely, because the reason that suggests itself is the wrong
    one: a `.venv` inside the image does NOT shadow what the image installed. The container runs
    the image's own /usr/local/bin/python with VIRTUAL_ENV unset and WORKDIR /app, so
    /app/.venv/lib/*/site-packages never enters sys.path at all and cannot displace a single
    package — the same statement both workflows make about the `--exclude=./.venv` on their tar,
    and it holds in both directions. What it costs directly is size: tens of megabytes of wheels
    built for a developer's own platform and interpreter version, none of which that container
    could load. What makes the row worth having is what its PRESENCE would mean rather than what
    the directory does. A `.venv` cannot reach the image unless the build context was not what
    whoever wrote the Dockerfile believed it was — a COPY widened to `COPY . .`, a .dockerignore
    that stopped applying — and that is the SAME fault that puts `.env` in there, which is the
    one that leaks credentials. So this row going red is a packaging fault to investigate, not a
    dependency problem to debug.

    `tests/` is the mild one: dead weight, plus fixtures that were never written with
    publication in mind.

    Today the Dockerfile copies its files one by one, so these paths could not appear even
    without .dockerignore. That is exactly why the check is worth keeping: widening that to a
    blanket `COPY . .` is a one-line change that looks tidier in review, and .dockerignore is
    then the only thing standing between the working tree and the registry.

    One `docker exec` answers all three, so the paths stay in one list and a failure to run it
    fails every row rather than silently covering fewer of them than it claims.
    """
    targets = ["{} is not in the image".format(path) for path in EXCLUDED_PATHS]

    if blocked is not None:
        return [(target, blocked) for target in targets]

    seen, problem, output = sweep_paths(name, EXCLUDED_PATHS)
    if seen is None:
        return [(target, problem) for target in targets]

    rows = []
    for path, target in zip(EXCLUDED_PATHS, targets):
        state = seen.get(path)
        if state == "absent":
            rows.append((target, None))
        elif state == "present":
            rows.append((target, (
                "it IS in the image. .dockerignore lists it, so either that file changed or "
                "the Dockerfile's COPY lines were widened — and in the case of .env the "
                "credentials are now inside an artefact that gets pushed to the registry, "
                "where nothing about the running container would ever reveal it")))
        else:
            # Neither answer came back for this path: the sweep ran but did not report on it,
            # which is not the same as "it is absent" and must not be reported as a pass.
            rows.append((target, (
                "the sweep returned no verdict for this path. Full output:\n{}".format(
                    excerpt(output)))))
    return rows


def check_required_paths(name, blocked=None):
    """(g) The templates and the viewer assets really are in the image.

    The mirror of (d), and the asymmetry between the two is the reason this exists. A file that
    should not be in the image is invisible from outside and needs a check to be found at all;
    a file that should be there and is not takes down every page the hub serves — and was, until
    this check, equally invisible to the pipeline.

    Nothing else covers it, in either direction:

      * the pytest suite runs against a CHECKOUT, where `templates/` and `static/` are simply
        present. It cannot observe a Dockerfile that stopped copying them.
      * check (a) does not reach it either: `render.TEMPLATES_DIR` and `app.STATIC_DIR` are
        anchored to `Path(__file__).parent.parent`, not to the working directory, so a correct
        WORKDIR says nothing about whether those two trees were copied.
      * checks (b), (c) and (e) all pass on an image with no templates at all. That is the sharp
        part: `/health` answers with a literal string that opens no file, so the container comes
        up, drops privileges, logs its startup marker and looks completely healthy while `GET /`
        is a traceback and the viewer is an empty canvas.

    So `COPY static/ static/` deleted from the Dockerfile — or a directory renamed on one side
    of a COPY — reaches `:latest` green. This is the row that stops it.

    One `docker exec` answers all five, so a failure to run it fails every row rather than
    silently covering fewer paths than it claims. `sh -c` with the paths as positional arguments
    is the same mechanism check (d) uses; only the verdict is inverted.
    """
    targets = ["{} is in the image".format(path) for path in REQUIRED_PATHS]

    if blocked is not None:
        return [(target, blocked) for target in targets]

    seen, problem, output = sweep_paths(name, REQUIRED_PATHS)
    if seen is None:
        return [(target, problem) for target in targets]

    rows = []
    for path, target in zip(REQUIRED_PATHS, targets):
        state = seen.get(path)
        if state == "present":
            rows.append((target, None))
        elif state == "absent":
            rows.append((target, (
                "it is NOT. The Dockerfile copies `templates/` and `static/` on lines of their "
                "own, so a missing COPY, a renamed directory or a file dropped from the tree "
                "produces an image that builds, starts and reports itself healthy while the "
                "page that needs this file is broken for every visitor. Nothing else in this "
                "pipeline can see that: the suite runs against a checkout, where the file is "
                "always there")))
        else:
            # Same reasoning as in check (d), and it matters more here: "the sweep said nothing
            # about this path" read as a pass would silently un-check the very file this row
            # exists for.
            rows.append((target, (
                "the sweep returned no verdict for this path. Full output:\n{}".format(
                    excerpt(output)))))
    return rows


def check_startup(image, name):
    """(e) The image's OWN command starts and gets through its own startup.

    Two rows, and the second one is the one to read carefully before changing it.

    The healthy set is deliberately BOTH of these:
      * reached the marker and is still running — which is what THIS service does: `main.py`
        binds the port and hands control to serve_forever();
      * reached the marker and exited 0 — a one-shot command that did its job and returned.
    The unhealthy set is: a non-zero exit, or no marker at all.

    Both are kept even though only the first shape occurs today. Narrowing this to "must still
    be running" would buy nothing — the marker plus a zero exit already means startup
    succeeded — and it would turn any future one-shot entrypoint (a migration, a `--check`
    mode) into a red smoke gate for a container that did exactly what it was asked. What is
    actually being asserted is "it got through its own startup and did not fall over", and
    that statement is true of both shapes.
    """
    marker_target = "the image's own command logs {!r}".format(STARTUP_MARKER)
    state_target = "...and the container then either keeps running or exits 0"
    targets = (marker_target, state_target)

    remove_container(name)

    # No `--rm`: both rows below are read AFTER the container may already have exited, and
    # `--rm` would have taken its logs and its exit code away with it.
    status, output = docker(
        ["run", "-d", "--name", name] + environment_flags() + [image], START_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for target in targets]
    if status != 0:
        reason = "the container could not be started (docker run exited {}):\n{}".format(
            status, excerpt(output))
        return [(target, reason) for target in targets]

    rows = []
    deadline = time.time() + STARTUP_BUDGET
    logs = ""
    logs_problem = None
    while True:
        log_status, log_output = docker(["logs", name], LOGS_TIMEOUT)
        if log_status is None:
            # No exit code at all — the docker client is gone or timed out. Stop immediately
            # rather than spending the rest of the budget on a call that cannot answer.
            logs_problem = log_output
            break
        if log_status != 0:
            # Kept rather than discarded: if every attempt fails this way, the verdict below
            # has to say the log could not be READ, which is a different finding from a
            # startup that produced no marker.
            logs_problem = "`docker logs {}` exited {}:\n{}".format(
                name, log_status, excerpt(log_output))
        else:
            logs_problem = None
            logs = log_output
            # Exit on the LAST expected marker, not the first: see the note on
            # STARTUP_MARKERS. With a single marker the two are the same thing; the loop is
            # written this way so that adding a second marker does not silently reintroduce
            # the race.
            if all(marker in logs for marker in STARTUP_MARKERS):
                break
        if time.time() >= deadline:
            break
        time.sleep(STARTUP_PAUSE)

    if logs_problem is not None:
        rows.append((marker_target, "not attempted: " + logs_problem))
    else:
        missing = [marker for marker in STARTUP_MARKERS if marker not in logs]
        if not missing:
            rows.append((marker_target, None))
        else:
            rows.append((marker_target, (
                "{!r} never appeared within {} s. The container was started with the image's "
                "own command and a complete environment, so it did not get through its own "
                "startup. Log so far:\n{}".format(
                    missing, STARTUP_BUDGET, excerpt(logs) or "(empty)"))))

    state_status, state_output = docker(
        ["inspect", "--format", "{{json .State}}", name], INSPECT_TIMEOUT)
    if state_status is None:
        rows.append((state_target, "not attempted: " + state_output))
        return rows
    if state_status != 0:
        rows.append((state_target, (
            "the container's state could not be read (docker inspect exited {}):\n{}".format(
                state_status, excerpt(state_output)))))
        return rows
    try:
        state = json.loads(state_output)
    except ValueError as error:
        rows.append((state_target, (
            "docker inspect returned something that is not JSON ({}): {}".format(
                describe(error), excerpt(state_output)))))
        return rows

    if state.get("Running"):
        rows.append(("{} (still running)".format(state_target), None))
        return rows
    exit_code = state.get("ExitCode")
    if exit_code == 0:
        rows.append(("{} (exited 0)".format(state_target), None))
        return rows
    rows.append((state_target, (
        "it exited {}. Status {!r}, error {!r}. Whatever it logged above, the process fell "
        "over rather than finishing — production restarts it and it falls over again. "
        "Log:\n{}".format(
            exit_code, state.get("Status"), state.get("Error") or "", excerpt(logs) or "(empty)"))))
    return rows


def cad_import_statement(module, symbol):
    """The import line the hub's own code would write, spelled out for a report row."""
    if symbol:
        return "from {} import {}".format(module, symbol)
    return "import {}".format(module)


def parse_cad_verdicts(output):
    """Pull check (f)'s verdict map out of the container's stdout.

    Returns (verdicts, None) or (None, reason). Noise on BOTH sides of the payload is discarded,
    and both sides really do occur: OpenCASCADE and VTK print warnings of their own accord, the
    probe cannot silence them, and `docker()` folds stderr into stdout — so the output around the
    payload is not under this gate's control. Everything before the LAST sentinel goes, and of
    what follows only the FIRST NON-EMPTY LINE is parsed.

    That last part is the difference between a working gate and seven false failures. The payload
    comes from `json.dumps`, which never emits a newline, so it is always exactly one line; but
    OCCT's and VTK's static destructors run during interpreter finalisation, i.e. AFTER that line
    has been printed. Feeding the whole remainder to json.loads would meet those bytes as
    `JSONDecodeError: Extra data` and report all seven CAD targets as failed over an image that
    is perfectly fine — the most expensive kind of red there is, because it blocks publication
    and the next run behaves differently.
    """
    if CAD_SENTINEL not in output:
        return None, (
            "the probe never printed its sentinel, so it produced no verdicts. It prints that "
            "line only after every check has run, which means it died partway — note that a "
            "native import can take the interpreter down with a SIGSEGV and no traceback at "
            "all, which is a fault in the image's own libraries. Full container output:\n"
            "{}".format(excerpt(output)))
    payload = output.rsplit(CAD_SENTINEL, 1)[1]
    lines = [line for line in payload.splitlines() if line.strip()]
    if not lines:
        return None, (
            "the probe printed its sentinel and then nothing at all. Those are two consecutive "
            "print() calls, so the interpreter died between them — after every check had run "
            "but before their verdicts were serialised, which points at json.dumps choking on a "
            "verdict value or at the process being killed at exactly that moment. Full container "
            "output:\n{}".format(excerpt(output)))
    try:
        verdicts = json.loads(lines[0])
    except ValueError as error:
        return None, (
            "the probe's verdicts did not parse as JSON ({}). First non-empty line after the "
            "sentinel:\n{}".format(describe(error), excerpt(lines[0])))
    if not isinstance(verdicts, dict):
        return None, "the probe's verdicts are a {}, not an object".format(
            type(verdicts).__name__)
    return verdicts, None


def check_cad_kernel(name, blocked=None):
    """(f) The geometry kernel is in the image, imports, and is the version that was pinned.

    This is the check the whole of step 1 exists for, and it answers something no test in this
    repository can. The suite runs against a CHECKOUT on a machine that already has X and GL
    libraries lying around; `cadquery-ocp` is a native OpenCASCADE binding, so the one thing
    that can be wrong here — a system library missing from the Dockerfile's apt list — is
    invisible to every one of those tests and surfaces as `ImportError: libGL.so.1` at import
    time, in production, on the first request that tries to build anything.

    It also reads the installed versions back. requirements.txt pinning `cadquery-ocp` is a
    STATEMENT; whether the resolver honoured it is a fact about the artefact, and only the
    artefact can be asked. That matters more than the usual "did pip do what it was told",
    because cadquery constrains OCP by range: an unnoticed drift there moves the geometry
    kernel under every model the hub serves, and the symptom is not an error at all — it is a
    rebuilt model whose STL and whose per-part buffer hashes quietly stop matching the ones
    already published.

    Runs by `docker exec` into the long-lived probe container that checks (c) and (d) already
    started, rather than starting a fourth container: this image is around two gigabytes, so
    starting one more would add the slowest thing this gate does for no extra coverage.

    Deliberately NOT run with `-u app`, unlike the write probe in check (c). What is being
    asked here is whether the dynamic linker can satisfy OCP and what the installed metadata
    says — both identical for either account, since pip installed into a world-readable
    site-packages — while `docker exec -u app` does not go through the entrypoint and so
    supplies none of the environment gosu would have set. Running as the unprivileged account
    would therefore buy nothing and risk a red gate over a missing HOME.
    """
    imports = [
        ("import:{}:{}".format(module, symbol), module, symbol)
        for module, symbol in CAD_IMPORTS
    ]
    # sorted() so the pin rows come out in the same order on every run and across python
    # versions: these rows get read side by side with a previous run's log when a bump goes
    # wrong.
    pins = [("pin:{}".format(dist), dist, PINS[dist]) for dist in sorted(PINS)]

    import_targets = [
        (key, "`{}` succeeds inside the image".format(cad_import_statement(module, symbol)))
        for key, module, symbol in imports
    ]
    pin_targets = [
        (key, "the image carries {} {}".format(dist, expected))
        for key, dist, expected in pins
    ]
    targets = import_targets + pin_targets

    if blocked is not None:
        return [(target, blocked) for _, target in targets]

    request = json.dumps({
        "imports": [[key, module, symbol] for key, module, symbol in imports],
        "pins": [[key, dist, expected] for key, dist, expected in pins],
        "sentinel": CAD_SENTINEL,
    })

    status, output = docker(
        ["exec", name, "python", "-c", CAD_PROBE_SOURCE, request], CAD_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for _, target in targets]

    verdicts, problem = parse_cad_verdicts(output)
    if verdicts is None:
        if status != 0:
            # A non-zero exit is NOT by itself a verdict — the probe reports its own failures
            # through the map and exits 0 having done so. It means the interpreter could not
            # finish at all, and for a native binding the likeliest cause is a signal rather
            # than an exception, which is why the two facts are reported together.
            problem = "the container exited {} and {}".format(status, problem)
        return [(target, problem) for _, target in targets]

    rows = []
    missing = object()

    for key, target in import_targets:
        reason = verdicts.get(key, missing)
        if reason is missing:
            rows.append((target, (
                "the probe returned no verdict for this import. Full container "
                "output:\n{}".format(excerpt(output)))))
        elif reason is None:
            rows.append((target, None))
        else:
            rows.append((target, (
                "it raised. This is where a system library missing from the Dockerfile shows "
                "up: OCP is a native OpenCASCADE binding, so an image without libGL/X11 fails "
                "at THIS line rather than at any geometry call. Check the apt list in the "
                "Dockerfile against the DT_NEEDED sweep documented there — and if the message "
                "names libGLU.so.1, that list's one explicit omission is what was "
                "wrong.\n{}".format(reason))))

    for key, target in pin_targets:
        reason = verdicts.get(key, missing)
        if reason is missing:
            rows.append((target, (
                "the probe returned no verdict for this pin. Full container output:\n"
                "{}".format(excerpt(output)))))
        elif reason is None:
            rows.append((target, None))
        else:
            rows.append((target, (
                "{}. requirements.txt and this file's PINS have drifted apart, or the resolver "
                "picked something else — and for cadquery-ocp that means the geometry kernel "
                "under every model this hub serves has moved without a file being "
                "touched.".format(reason))))

    return rows


def main():
    image = os.environ.get(IMAGE_ENV)
    name = os.environ.get(NAME_ENV)
    missing = [variable for variable, value in ((IMAGE_ENV, image), (NAME_ENV, name))
               if not value]
    if missing:
        # Refused rather than defaulted, and refused BEFORE anything is started. A default tag
        # would gate whatever image happened to be on this shared daemon and report green; a
        # default container name would collide with a concurrent run on the same daemon and
        # report red at random. Both are worse than a step that will not start.
        print("smoke cannot run: {} not set. The workflow has to provide {} (the exact tag "
              "that was just built) and {} (a base container name unique to this run).".format(
                  ", ".join(missing), IMAGE_ENV, NAME_ENV))
        raise SystemExit(EXIT_MISCONFIGURED)

    probe_name = name
    guard_name = name + GUARD_SUFFIX
    cmd_name = name + CMD_SUFFIX

    # Each probe's rows are kept in a local of their own rather than poured straight into one
    # shared list, purely so that the self-check below can still tell them apart: once they are
    # concatenated there is no way to know which probe contributed how many, which is exactly
    # the information needed to name the probe that went quiet.
    contract_rows = check_image_contract(image)
    guard_rows = check_required_variable_guard(image, guard_name)

    try:
        # One long-lived container serves both (c) and (d): they ask about the same running
        # instance, and starting two would double the slowest part of this gate for nothing.
        remove_container(probe_name)
        start_status, start_output = docker(
            ["run", "-d", "--name", probe_name] + environment_flags() + [image] + IDLE_COMMAND,
            START_TIMEOUT)
        if start_status is None:
            blocked = "not attempted: " + start_output
        elif start_status != 0:
            blocked = (
                "not attempted: the probe container could not be started (docker run exited "
                "{}):\n{}".format(start_status, excerpt(start_output)))
        else:
            blocked = None
        # `blocked` is passed rather than skipping these two: a probe container that never
        # started still has to produce its full set of rows, all of them failed. That is what
        # keeps the counts below meaningful in exactly the case where a gate is most tempted
        # to fall silent.
        privileges_rows = check_privileges_dropped(probe_name, blocked=blocked)
        excluded_rows = check_excluded_paths(probe_name, blocked=blocked)

        startup_rows = check_startup(image, cmd_name)

        # Last, and inside the `try` because it execs into the probe container started above —
        # so it has to be covered by the same `finally`. Running it here rather than beside the
        # other two execs keeps this list in the same order as EXPECTED_TARGETS, which is what
        # the positional pairing below depends on; the cost is that it is the call furthest
        # from the probe container's own `sleep`, and the arithmetic at IDLE_COMMAND is where
        # that margin is checked.
        cad_rows = check_cad_kernel(probe_name, blocked=blocked)

        # Also an exec into the probe container, and therefore also inside this `try`. Placed
        # after the CAD probe so that this list keeps the same order as EXPECTED_TARGETS, which
        # the positional pairing below depends on. Being the LAST exec makes it the call the
        # probe container's `sleep` has to outlast — the arithmetic at IDLE_COMMAND accounts for
        # it, and moving another call after this one means redoing that arithmetic.
        required_rows = check_required_paths(probe_name, blocked=blocked)
    finally:
        # Both long-lived containers, removed whatever happened above. The workflow removes
        # them again under `if: always()` for the case where this process itself was killed by
        # the step timeout and never reached this line.
        remove_container(probe_name)
        remove_container(cmd_name)

    # SAME ORDER AS EXPECTED_TARGETS, and that is a requirement rather than a convention: the
    # pairing below is positional, so a group moved here without moving its declaration is
    # compared against somebody else's count. THREE of these groups return 4 verdicts each —
    # (a), (c) and (g) — so swapping any two of those would still satisfy every check below and
    # go green while each probe's failures were being reported under another one's name. Nothing
    # in this file can detect that; keeping the two tuples in step by eye is what prevents it,
    # which is why the letters are on the labels.
    produced = (contract_rows, guard_rows, privileges_rows, excluded_rows, startup_rows,
                cad_rows, required_rows)

    # Three self-checks, and they are three because each one catches a break the others cannot
    # see. They are collected in two lists rather than one because they are REPORTED
    # differently: `wiring` holds free-text findings about this file's own consistency — the
    # arity in (1) and the total in (3) — while `miscounted` holds one entry per disagreeing
    # probe, printed as a label with its declared and actual counts. Both are printed, and the
    # run fails if either is non-empty.
    wiring = []

    # (1) SAME NUMBER OF PROBE GROUPS. It comes first and it is its own check, because the
    # per-probe comparison below is structurally incapable of making it: `zip` stops at the
    # shorter of its arguments and says nothing about the surplus. So a refactor that drops a
    # probe from the `produced` tuple — rather than leaving it in place returning [], which the
    # per-probe check would catch — pairs the 6 survivors against the first 6 declarations, finds
    # every one of them consistent, and reports `miscounted == []`.
    #
    # What this check buys there is the DIAGNOSIS, not the verdict. That run is refused either
    # way: dropping the required-path group that way leaves 6 groups contributing 24 rows against
    # a declared total of 28, so (3) below fires and the gate exits 3 with or without this check.
    # But (3) can only report that the arithmetic between the probes and `rows` came out wrong,
    # and its own wording points at the other way that happens — a group extended into `rows`
    # twice, or one left out of the loop — which is the wrong place to start looking. This
    # check names the fault in one line: the two
    # lists no longer have the same number of entries, so a probe was added or removed without
    # its declaration moving in the same commit. Both lines are printed together; this is the one
    # that points at the commit. (`zip(..., strict=True)` would express this in one word and is
    # deliberately not used: the runner's `python3` is whatever the image ships and is not pinned
    # anywhere, and `strict` needs 3.10 — on an older interpreter this file would die with a
    # TypeError before it graded anything.)
    arity_agrees = len(produced) == len(EXPECTED_TARGETS)
    if not arity_agrees:
        wiring.append(
            "this gate's own wiring is inconsistent: EXPECTED_TARGETS declares {} probe "
            "group(s) and `produced` in main() carries {}. A probe was added or removed "
            "without updating the constant in the same commit, so the surviving groups are "
            "no longer even paired with the declarations they are being compared against — "
            "every count below (and every count that did NOT appear below) is meaningless "
            "until the two lists line up again".format(
                len(EXPECTED_TARGETS), len(produced)))

    # (2) PER PROBE: which specific probe returned the wrong number of verdicts. Only
    # attempted when the arity agrees — pairing two lists of different lengths positionally
    # would attribute counts to the wrong labels and send the reader after the wrong probe.
    # Gated on `arity_agrees` rather than on `wiring` being empty, so that a wiring check added
    # here later cannot suppress this one as a side effect of existing.
    if arity_agrees:
        miscounted = [
            (label, expected, len(actual))
            for (label, expected), actual in zip(EXPECTED_TARGETS, produced)
            if len(actual) != expected
        ]
    else:
        miscounted = []

    rows = []
    for group in produced:
        rows.extend(group)

    # (3) THE TOTAL, against the sum of the declarations. Belt and braces over (1) and (2), and
    # it earns its place on a case neither of them can see: a probe group poured into `rows` a
    # SECOND time — a duplicated `rows.extend(...)`, a copy-paste while adding a probe — leaves
    # the arity right and leaves every per-probe count right, because both of those inspect
    # `produced` and this mistake happens after it. Duplicating the 4-verdict guard group that
    # way collects 32 rows where 28 are declared, and without this check the run would end on
    # `smoke ok: 32/32`, which reads as a gate doing MORE work when it is in fact grading one
    # probe twice and counting that probe's verdicts twice over.
    declared_total = sum(count for _, count in EXPECTED_TARGETS)
    if len(rows) != declared_total:
        wiring.append(
            "the verdicts actually collected do not add up to what is declared: "
            "EXPECTED_TARGETS sums to {} and this run concatenated {}. If no probe is named "
            "below, the arithmetic broke between the probes and `rows` — a group extended "
            "into `rows` twice, or one left out of the loop entirely".format(
                declared_total, len(rows)))

    failures = []
    for target, reason in rows:
        if reason is None:
            print("ok   {}".format(target))
        else:
            print("FAIL {} -> {}".format(target, reason))
            failures.append(target)

    # Reported first, and reported in full even when the self-check below is also going to
    # fire: "the image is broken" and "the gate lost a check" are two independent facts, and a
    # run that shows only one of them sends whoever reads it after half of the problem.
    if failures:
        print("")
        print("smoke FAILED: {}/{} targets broken".format(len(failures), len(rows)))
        for target in failures:
            print("  - {}".format(target))

    # The self-check comes BEFORE the success line, so `smoke ok` can never be printed by a run
    # that returned fewer verdicts than it promised — which is the whole scenario this exists
    # for, since a shrinking gate reports success by construction (see EXPECTED_TARGETS).
    # It fails the run on its own, independently of `failures`: every remaining verdict passing
    # is not evidence of a healthy image when some of the verdicts were never cast.
    if wiring or miscounted:
        print("")
        print("smoke SELF-CHECK FAILED: this gate did not return the verdicts it declares.")
        for problem in wiring:
            print("  - {}".format(problem))
        for label, expected, actual in miscounted:
            print("  - {}: declared {} verdict(s), returned {}".format(label, expected, actual))
        print("")
        print("This is a finding about THIS SCRIPT, not about the image: either a probe stopped "
              "returning one of its verdicts, or a probe was added to (or removed from) this "
              "file without EXPECTED_TARGETS being updated in the same commit. Either way a "
              "check was not performed and nothing above reports on it in either direction. "
              "Whatever the rows above say, the run proves less than it claims. Work out which "
              "check went missing and when — do NOT reconcile EXPECTED_TARGETS with the number "
              "this run produced, which would make the gate agree with itself forever.")
        raise SystemExit(EXIT_SELF_CHECK)

    if failures:
        raise SystemExit(EXIT_CHECKS_FAILED)

    print("")
    print("smoke ok: {}/{} targets".format(len(rows), len(rows)))


if __name__ == "__main__":
    # Every verdict this gate reaches leaves through SystemExit, and every one of those exit
    # codes still means exactly what it says above: `except Exception` does not catch SystemExit
    # (nor KeyboardInterrupt), so 0, 1, 2 and the self-check's own 3 all pass through here
    # untouched. What is caught is the OTHER way this script can end — an exception nobody
    # planned for. `docker inspect` answering with the JSON literal `null` so that
    # `config.get(...)` blows up on None, a docker CLI whose output format changed, an
    # AttributeError introduced by a refactor: any of those unwinds out of main() as a
    # traceback, and CPython's default for an unhandled exception is exit status 1 — the code
    # this gate reserves for "the image is broken, do not ship it".
    #
    # That is a lie about which artefact is at fault, and an expensive one: whoever reads the
    # run goes off inspecting an image that may be perfectly fine, and the actual defect — in
    # THIS FILE, on the runner — is the last place they look. A crash of the gate is a fact
    # about the gate, so it exits with the gate's own code.
    #
    # The traceback is NOT swallowed: it is the only diagnostic there is for a failure nobody
    # anticipated, and a bare "the gate crashed" would leave the next person with no line
    # number. stdout is block-buffered when it is a pipe — which it is on the runner — so it is
    # flushed first, otherwise every row printed by main() would land in the log AFTER the
    # traceback of the call that produced them and read as if it came from somewhere else.
    try:
        main()
    except Exception:
        sys.stdout.flush()
        traceback.print_exc()
        print(
            "\nsmoke CRASHED: the exception above came out of this script, not out of the "
            "image. Nothing here graded the artefact, so this run says nothing about whether "
            "the image is fit to publish — exiting {} (`the gate is broken`) rather than {} "
            "(`the image is broken`), because sending anybody to inspect the image would be "
            "sending them to the wrong place.".format(EXIT_SELF_CHECK, EXIT_CHECKS_FAILED),
            file=sys.stderr)
        raise SystemExit(EXIT_SELF_CHECK)
