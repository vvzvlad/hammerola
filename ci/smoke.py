"""Smoke gate for this project's image, run on the CI runner against an already-built image.

It sits between `docker build` and `docker push`: nothing is pressed between the push and the
rollout, so whatever reaches `:latest` is what production runs.

A plain `python3 ci/smoke.py` on the runner that drives `docker` against the tag in
$SMOKE_IMAGE. Nothing is imported from the application; the whole gate is `docker inspect`,
`docker run`, `docker exec` and `docker logs`.

What this gate checks
---------------------
The pytest suite checks the code against a checkout. This gate checks the ARTEFACT: that it
carries the code, starts on its own and is packaged as this repo says.

* (a) the image's declared contract: ENTRYPOINT, CMD, WORKDIR and PYTHONUNBUFFERED.
* (b) the required-variable guard still fires AND still names EVERY variable that is missing.
* (c) privileges are really dropped — the process is `app`, not root.
* (d) `.dockerignore` did its job: no tests, no `.env`, no `.venv` inside the image.
* (e) the image's own command starts and gets through its own startup.
* (f) the CAD kernel and the preview renderer import inside the image, and carry the versions
      requirements.txt declares (including the transitive `cadquery-ocp`, which cadquery
      constrains only by range). A missing system library fails only at `import cadquery`, and
      a broken preview stack only degrades builds to a warning, so neither shows anywhere else.
* (g) the templates, viewer assets and other required files are IN the image; without them
      the image still starts and `/health` still answers.
* (h) the three `/start` files are served by this image. Two of them are assembled per
      request (the client zipapp from `hammerola/`, the template tarball from
      `model_template/`), so (g) cannot cover them by path.
* (i) the build wrapper (`python -s -m src.buildproc.wrapper`, spawned by the hub for every
      push) resolves from /app as the `app` account and its rlimits really go on. The suite
      runs it on a checkout and strips ceilings the workstation refuses
      (`tests/buildproc/probes.py`), so it cannot answer this.

Constraints of this runner
--------------------------
This job and the docker daemon are not in the same network namespace: act_runner runs the job
inside its own container while `docker` drives the host's daemon. So NO PORT IS PUBLISHED and
nothing here talks to the runner's 127.0.0.1; anything inside a container is observed with
`docker exec`.

Two properties to keep:

* Failures leave through SystemExit, never `assert`, which vanishes under PYTHONOPTIMIZE=1.
* Every check runs before anything is reported, and a check that cannot run reports itself as
  FAILED; it is never skipped.

Renaming this template
-----------------------
STARTUP_MARKER has to keep matching the string `main.py` logs, and the container name prefixes
in both workflows have to keep matching each other. Nothing else here carries the project's
name.
"""

import json
import os
import subprocess
import sys
import time
import traceback

# The tag to test. Required rather than defaulted, so a mistyped `env:` block cannot gate some
# other image that happens to be on the daemon.
IMAGE_ENV = "SMOKE_IMAGE"
# Base name for every container this gate starts. Required because the runner's single daemon
# is shared by every repository: the workflows put the run id in it so concurrent runs never
# collide.
NAME_ENV = "SMOKE_NAME"

# The three containers this gate starts, by suffix on $SMOKE_NAME:
#   ""      the long-lived one checks (c), (d), (f), (g) and (i) `docker exec` into, started with
#           a sleeping command; its `sleep` has to outlast the last exec (see IDLE_COMMAND).
#   -guard  the short-lived one started with NO environment for check (b).
#   -cmd    the one started with the image's REAL command for check (e), which check (h) execs
#           into afterwards. No `--rm`: check (e) reads its logs and state after it exits.
# All three are named because a subprocess timeout kills the docker client, not the container;
# an unnamed survivor could never be removed and would pin the image on the shared daemon.
# Kept in step with the suffix list in both workflows' cleanup steps.
GUARD_SUFFIX = "-guard"
CMD_SUFFIX = "-cmd"

# A memory ceiling per container, because the runner's 19 GB are shared with every other
# repository's jobs. Each number is a pass/fail pair swept alone on the self-hosted runner
# (never a `memory.peak` reading, which rises with the limit), with ~4x margin:
#   PROBE  the sleeping one the CAD checks exec into: red at 192m, green at 256m -> 768m.
#   CMD    the hub under the image's own command: red at 32m, green at 48m -> 192m.
#   GUARD  the one meant to die at once with no environment: red at 24m, green at 32m -> 128m.
# Too low a number can hollow a check instead of failing it: an OOM-killed `-guard` still
# "exits non-zero", so only its wording rows go red.
# `--memory` and `--memory-swap` are always set TOGETHER and always EQUAL — see `memory_flags`.
PROBE_MEMORY = "768m"
CMD_MEMORY = "192m"
GUARD_MEMORY = "128m"

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
# it: the environment variable name in SCREAMING_CASE. Keep in step with src/settings.py.
# With a single entry, check (b) cannot prove the guard names every missing key, not just the
# first; tests/test_config_errors.py covers that. A second entry here restores it, and the
# declared count follows automatically.
REQUIRED_VARIABLES = ["EDIT_TOKEN"]

# Paths that must NOT be inside the image. .dockerignore excludes them; the Dockerfile also
# copies files one by one, so this is defence in depth against a widened COPY.
# One `__pycache__` entry per copied Python tree: those are inside copied trees and stay out
# only because .dockerignore says `**/__pycache__/` (docker's `*` does not cross `/`, so a bare
# `__pycache__/` would match only the context root).
EXCLUDED_PATHS = ["/app/tests", "/app/.env", "/app/.venv", "/app/src/__pycache__",
                  "/app/hammerola/__pycache__"]

# Paths that MUST be inside the image. Their absence has no other symptom: the suite runs on a
# checkout, and an image missing them still builds, starts and answers `/health`.
# One template per page the hub serves (index, build page, pointer page), plus the viewer
# library, which the browser fetches at runtime by URL (`VIEWER_MODULE_URL` in
# ui/src/viewport/library.js) together with three's two files, so nothing in the build notices
# them missing. A tripwire on the COPY lines, not an inventory of every asset.
REQUIRED_PATHS = [
    "/app/templates/index.html",
    "/app/templates/build.html",
    "/app/templates/pointer.html",
    "/app/static/_v/three-cad-viewer.esm.js",
    # three itself, imported by URL from the row above; without either file the viewer's
    # module graph fails in the browser.
    "/app/static/_v/three.module.js",
    "/app/static/_v/three.core.js",
    # The palette, linked by every page. Missing, every page still answers 200 but every
    # `var(--…)` resolves to nothing.
    "/app/static/_v/tokens.css",
    # The top-level name every model.py imports, copied on a line of its own; missing, only
    # the first model build fails.
    "/app/checklib.py",
    # The browser bundle, compiled by the `ui` stage and copied out of it by name. One path
    # because vite emits one file (see ui/vite.config.mjs); a new output adds a row here and a
    # COPY line in the Dockerfile.
    "/app/static/_v/hammerola.js",
    # The onboarding files (src/onboarding.py), one per copied tree. Check (h) asks the same
    # route; this row names the missing file, (h) names the answer a visitor gets.
    # SKILL.md also survives `.dockerignore`'s root-only `*.md` rule; widening it to
    # `**/*.md` would fail this row.
    "/app/skill/SKILL.md",
    "/app/model_template/model.py",
    # Hidden, so easy for a COPY or an ignore rule to drop silently, and the template would
    # then be served without it.
    "/app/model_template/.gitignore",
]

# --- check (f): the CAD kernel -------------------------------------------------------------
# The imports the hub's own code makes, as (module, symbol); an empty symbol means a plain
# `import module`. Data, so the verdict count is derived from it.
# `ocp_tessellate.convert` is named down to the symbol because `import ocp_tessellate` alone
# would not notice a moved exporter.
# `src.cadbuild.build` pulls in the whole build half (package-relative imports, so it fails as
# a unit if a COPY line drifts); `checklib` must resolve from /app (see checklib.py).
# `src.cadbuild.preview_png` is not reached by `build`: it is imported lazily and a failure
# degrades to `warning: no previews`, so only this row would catch a broken matplotlib.
CAD_IMPORTS = (
    ("cadquery", ""),
    ("ocp_tessellate.convert", "export_three_cad_viewer_js"),
    ("trimesh", ""),
    ("src.cadbuild.build", "build"),
    ("src.cadbuild.preview_png", "render"),
    ("checklib", "pairwise_interference"),
)

# The versions the image must carry, keyed by DISTRIBUTION name (`cadquery-ocp` has no import
# name). Copied from requirements.txt on purpose, as the gate's own statement of the contract:
# keep the two in step in the same commit.
# `cadquery-ocp` matters most: cadquery constrains it only by range, so only the explicit pin
# keeps the geometry kernel fixed. matplotlib, numpy and pillow are the preview renderer's,
# which arrive transitively through vtk.
# A pin row reads metadata only and loads nothing; the import rows in CAD_IMPORTS are what
# load the compiled extensions.
PINS = {
    "cadquery": "2.8.0",
    "cadquery-ocp": "7.9.3.1.1",
    "ocp-tessellate": "3.4.1",
    "trimesh": "4.12.2",
    "matplotlib": "3.11.1",
    "numpy": "2.4.6",
    "pillow": "12.3.0",
}

# Marks the start of the CAD probe's verdicts on stdout. OpenCASCADE and VTK print warnings
# before the payload and from static destructors after it, so everything before the LAST
# sentinel is discarded and only the first non-empty line after it is parsed (see
# parse_cad_verdicts). Output without the sentinel is a probe that never reported.
CAD_SENTINEL = "---HAMMEROLA-CAD-PROBE-JSON---"

# The probe, run by the image's own interpreter inside the probe container. It takes one JSON
# argument (imports, pins, sentinel) and prints one JSON object mapping each key to a reason
# string or null; the prose stays in check_cad_kernel(). With `-c` the request is argv[1].
# The sentinel is printed only at the end, so a probe that died produces no verdicts rather
# than a truncated set.
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

# --- check (h): the onboarding routes ------------------------------------------------------
# The three files `/start` hands a newcomer, requested from inside the container running the
# image's own command. Two are assembled per request (`src/onboarding.py`): the client zipapp
# must carry every module reachable from `hammerola/cli.py` (`onboarding._refuse_unimportable`),
# and src/app.py answers a refused assembly with a logged 404. The suite builds these archives
# from the checkout, where every file is present, so only this check sees a missing one.
# `/start` itself is not listed: the only file it opens is `/app/skill/SKILL.md`, which check
# (g) requires by name, and a fourth route would not fit the probe's time budget
# (10 + 3 x 5 = 25 s against an EXEC_TIMEOUT of 30).
START_ROUTES = ["/start/skill.md", "/start/hammerola", "/start/template.tar.gz"]

# Where the hub listens inside its own container (`src/settings.py` defaults: 0.0.0.0:8000).
# 127.0.0.1 is the CONTAINER's loopback, reached by `docker exec`.
START_ORIGIN = "http://127.0.0.1:8000"

# The prefix of every verdict line the probe prints. Line-marked output, because `docker()`
# folds stderr into stdout and warnings may surround the verdicts. A path with no verdict is a
# third answer and never a pass.
START_MARK = "start-route"
# Seconds the probe keeps retrying a refused connection: main.py logs the startup marker before
# it binds the socket, so "refused" may mean "not bound yet".
START_WAIT = 10
# Per-request timeout inside the container, and how much of each body is read (only "not
# empty" is asked). These must fit inside EXEC_TIMEOUT: the deadline is shared by all routes,
# so the ceiling is the wait once plus one read per route, 10 + 3 x 5 = 25 s against 30
# (measured: 20.6 s against a socket that never answers). A probe killed by the outer bound
# reports nothing, so raise EXEC_TIMEOUT together with these.
START_READ = 5
START_READ_BYTES = 4096

# Run by the image's own interpreter inside the `-cmd` container, so the hub it asks is the one
# production runs. Stdlib only; one JSON argument like the CAD probe. Every reason is collapsed
# to one line, since the parser reads one verdict per line.
START_PROBE_SOURCE = r"""
import json
import sys
import time
import urllib.error
import urllib.request

request = json.loads(sys.argv[1])
deadline = time.time() + request["wait"]


def one_line(text):
    return " | ".join(part.strip() for part in str(text).splitlines() if part.strip())


def report(path, reason):
    if reason is None:
        print("{} ok {}".format(request["mark"], path))
    else:
        print("{} bad {} {}".format(request["mark"], path, one_line(reason) or "(no detail)"))


for path in request["routes"]:
    url = request["origin"] + path
    while True:
        try:
            with urllib.request.urlopen(url, timeout=request["read"]) as reply:
                status = reply.status
                body = reply.read(request["bytes"])
        except urllib.error.HTTPError as error:
            report(path, "the hub answered {} {}".format(error.code, error.reason))
            break
        except Exception as error:
            if time.time() < deadline:
                time.sleep(0.5)
                continue
            report(path, "no answer within {} s: {}: {}".format(
                request["wait"], type(error).__name__, error))
            break
        if status != 200:
            report(path, "the hub answered {}".format(status))
        elif not body:
            report(path, "the hub answered 200 with an empty body")
        else:
            report(path, None)
        break
"""

# --- check (i): the build wrapper, and the ceilings it puts on ------------------------------
# The hub spawns every build as
# `python -s -m src.buildproc.wrapper '<rlimit-spec-json>' -- <target argv>` from /app
# (`runner.run_isolated`, `runner.HUB_ROOT`); the wrapper sets the rlimits on itself and then
# `execv`s the interpreter that imports the model. Two image properties must hold, and the
# suite cannot observe either:
#   * `-m src.buildproc.wrapper` resolves from /app;
#   * `setrlimit` succeeds for the `app` account here. `apply_process_limits` fails closed, so
#     a refused ceiling turns every push into a build that never runs.
# The probe asks the image for its own spec (`DEFAULT_LIMITS.rlimit_spec()`) rather than
# carrying a copy, because `Limits.cpu_seconds` is computed from the visible cores. It runs the
# real wrapper, since what matters is the code between `apply_process_limits` and `os.execv`.
BUILD_MARK = "build-ceiling"
# The three questions, in the order the probe answers them, as (key, target prose). Data, so
# the declared count is derived from it. Three because they point at three different faults:
# packaging, a refusal by the kernel, and a ceiling reported as applied that is not on.
BUILD_TARGETS = (
    ("resolve",
     "`python -s -m src.buildproc.wrapper` runs from {} as the `{}` account".format(
         APP_DIR, APP_USER)),
    ("apply",
     "...and it puts every ceiling the image's own spec asks for on, rather than refusing"),
    ("force",
     "...and the process it execs into really runs under them"),
)
# What the probe gives the wrapper before giving up. Must fit inside EXEC_TIMEOUT with room for
# the probe's own start and output, or all three rows go red over a merely slow image. The
# work is three stdlib interpreter starts (importing `src.buildproc` must not import cadquery).
BUILD_RUN_SECONDS = 20

# Run by the image's own interpreter, as `app`, from /app: as close to the process the hub
# spawns as a gate can get without pushing a model. Stdlib only, with the same marked-line
# output as check (h). The wrapper writes to stderr and the fenced process writes its JSON to
# stdout, and the probe keeps the two pipes apart, so no sentinel is needed.
BUILD_PROBE_SOURCE = r"""
import json
import os
import resource
import subprocess
import sys
import traceback

request = json.loads(sys.argv[1])
mark = request["mark"]

# The wrapper's target, and the whole of it: print the effective (soft, hard) pair of every
# ceiling the IMAGE names. This is the only thing that can answer "the ceilings really went on",
# because it runs on the far side of the execv, which is where the build itself runs.
READBACK = (
    "import json, resource, sys\n"
    "names = json.loads(sys.argv[1])\n"
    "print(json.dumps({name: list(resource.getrlimit(getattr(resource, name)))\n"
    "                  for name in names}))\n"
)

# Every message wrapper.py writes carries this prefix EXCEPT the bare `usage:` line it prints
# for a malformed invocation (wrapper.py's first branch) -- which this probe cannot reach,
# because the argv composed below always has the whole spec in argv[1] (one `json.dumps`, one
# element) and `--` in argv[2]. On every path the probe CAN take -- the ceilings it applied, or
# the refusal that stopped it -- the prefix is there. So its presence is the witness that the
# module resolved and ran at all, which is a different question from whether it then succeeded:
# `python -m` failing to find the module prints its own error and none of these.
#
# READ THIS BEFORE WIDENING THE PROBE'S ARGV: reaching the usage branch would cost this check
# its `resolve` verdict, and it would fail CLOSED (the row goes red), which is the right way
# round but not an obvious one.
VOICE = "buildproc:"


def one_line(text):
    return " | ".join(part.strip() for part in str(text).splitlines() if part.strip())


def report(key, reason):
    if reason is None:
        print("{} ok {}".format(mark, key))
    else:
        print("{} bad {} {}".format(mark, key, one_line(reason) or "(no detail)"))


def refuse(reason):
    # Every key still gets a verdict. A probe that answered fewer questions than it was asked
    # is what the verdict count in the gate exists to catch, and reporting nothing here would
    # hand it that case for no reason.
    for key in request["keys"]:
        report(key, reason)
    raise SystemExit(0)


try:
    from src.buildproc.limits import (
        DEFAULT_LIMITS,
        RLIMIT_FIELDS,
        RLIMIT_NAMES,
        WRAPPER_EXIT_CODES,
    )
except Exception:
    refuse("`import src.buildproc.limits` fails with the working directory at {}: {}".format(
        os.getcwd(), traceback.format_exc()))

# RLIMIT_FIELDS and RLIMIT_NAMES are built from the same table in the same order (limits.py),
# so this pairs each field of the spec with the resource the wrapper applies it to.
pairs = list(zip(RLIMIT_FIELDS, RLIMIT_NAMES))
spec = DEFAULT_LIMITS.rlimit_spec()
argv = [
    sys.executable, "-s", "-m", "src.buildproc.wrapper", json.dumps(spec), "--",
    sys.executable, "-s", "-c", READBACK, json.dumps([name for _field, name in pairs]),
]

try:
    run = subprocess.run(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=request["timeout"])
except Exception:
    refuse("the wrapper could not be run at all from {}: {}".format(
        os.getcwd(), traceback.format_exc()))

out = run.stdout or ""
err = run.stderr or ""
detail = "exit {}; stderr: {}; stdout: {}".format(
    run.returncode, one_line(err) or "(nothing)", one_line(out) or "(nothing)")

if not any(line.startswith(VOICE) for line in err.splitlines()):
    report("resolve", (
        "the interpreter never got as far as the wrapper's own first message, with the "
        "working directory at {} -- {}".format(os.getcwd(), detail)))
    blocked = "the wrapper never ran; the row above says what happened instead"
    report("apply", blocked)
    report("force", blocked)
    raise SystemExit(0)
report("resolve", None)

if run.returncode in WRAPPER_EXIT_CODES:
    report("apply", (
        "the wrapper refused, with one of its own exit codes -- {}".format(detail)))
    report("force", (
        "the wrapper never reached the process it fences; the row above says why"))
    raise SystemExit(0)
report("apply", None)

try:
    seen = json.loads(out)
except ValueError:
    seen = None
if not isinstance(seen, dict):
    report("force", (
        "the fenced process did not report the ceilings it runs under -- {}".format(detail)))
    raise SystemExit(0)

problems = []
verified = 0
for field, name in pairs:
    requested = spec[field]
    if requested is None:
        # Present in the spec and deliberately switched off -- `processes` is the standing
        # example, RLIMIT_NPROC being counted per uid. There is nothing to verify: whatever
        # this process inherited for it is legitimate.
        continue
    reading = seen.get(name)
    if not isinstance(reading, list) or len(reading) != 2:
        problems.append("{}: the fenced process reported {}".format(name, repr(reading)))
        continue
    soft, hard = reading
    if soft == resource.RLIM_INFINITY or hard == resource.RLIM_INFINITY:
        problems.append("{}: unlimited in the fenced process, though the spec asks for "
                        "{}={}".format(name, field, requested))
    elif soft != hard:
        # The wrapper sets (value, value) on purpose: at the SOFT limit RLIMIT_CPU raises
        # SIGXCPU, which a process may catch and ignore, while the HARD one is a SIGKILL it
        # may not. A gap between them is a ceiling with a documented way around it.
        problems.append("{}: soft {} and hard {} in the fenced process, so the ceiling can be "
                        "raised back from inside it".format(name, soft, hard))
    elif soft > requested:
        problems.append("{}: the fenced process has {}, looser than the {} the spec asks "
                        "for".format(name, soft, requested))
    else:
        # `soft < requested` is a PASS: apply_process_limits clamps down to an inherited hard
        # limit without complaining, and a container that already caps something lower than the
        # hub asks for is stricter rather than broken.
        verified += 1
if not verified:
    problems.append("the image's own spec asks for no ceiling at all, so this row would report "
                    "a build that runs entirely unfenced as a pass")
report("force", "; ".join(problems) if problems else None)
"""

# How many verdicts each probe MUST return, checked before anything is reported. Every probe
# returns exactly one row per target on every path, including when its container could not
# start, so these numbers are a property of the source. A probe that quietly stops probing
# would otherwise still end on `smoke ok: N/N`.
# When a mismatch fires, do NOT edit the number to match the run: find which probe stopped
# returning a verdict. Adding or removing a check means editing this in the same commit.
# main() checks the number of groups, each group's count, and the total (see there).
# Counts are derived from the source wherever possible; the literals count literal `targets`
# tuples. Each label carries the probe's letter from the module docstring.
EXPECTED_TARGETS = (
    ("(a) image contract", 4),
    # The exit code and the guard's own wording, plus one row per variable it has to name.
    ("(b) required-variable guard", 2 + len(REQUIRED_VARIABLES)),
    ("(c) privileges dropped", 4),
    ("(d) excluded paths", len(EXCLUDED_PATHS)),
    ("(e) startup", 2),
    ("(f) CAD kernel", len(CAD_IMPORTS) + len(PINS)),
    ("(g) required paths", len(REQUIRED_PATHS)),
    ("(h) onboarding routes", len(START_ROUTES)),
    ("(i) build ceilings", len(BUILD_TARGETS)),
)

# The environment the probe and real-command containers run with. The value is invented and
# reaches nothing, so the gate runs on pull requests too; EDIT_TOKEN is only compared for
# equality, so any non-empty string starts the image.
SMOKE_ENV = [
    "EDIT_TOKEN=fake-smoke-token-not-real-0123456789abc",
]

# The command the probe container runs instead of the image's own. It still goes through
# ENTRYPOINT (docker only replaces CMD), so PID 1 is `gosu app sleep 900`, which is what check
# (c) inspects. The 900 s count from this container's start and must outlast the last exec into
# it, check (i): in the worst case it starts at 240 s and that exec ends at 735 s, using 495 s.
# Check (h) execs into the `-cmd` container and costs this nothing.
IDLE_COMMAND = ["sleep", "900"]

# The first line `main.py` logs. Its presence proves the settings parsed (every required
# variable arrived) and logging was configured. RENAME THIS TOGETHER WITH main.py when the
# template is copied.
STARTUP_MARKER = "Starting hammerola"
# The markers check (e) waits for, in the order main.py emits them. The poll waits for the
# whole list, so a second marker is not judged against a log snapshot taken right after the
# first line.
STARTUP_MARKERS = (STARTUP_MARKER,)

# Bounds. Every docker call gets one: a hung gate holds a shared runner until the step timeout
# kills it, and a killed step never runs its own cleanup. The numbers are generous against the
# real cost. Their worst-case SUM, in call order, is what the smoke step's `timeout-minutes` in
# both workflows has to exceed:
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
#  + 30 (exec: /start routes, into the -cmd container)
#  + 30 (exec: build wrapper and its ceilings)
#  + 30 (rm probe, finally) + 30 (rm cmd, finally)
#  = 795 s, a little over 13 minutes. Both workflows allow 14 (840 s); the remaining 45 s is
# what a further exec would spend, so adding one means raising `timeout-minutes` in both
# workflows. tests/test_workflow_steps.py reads this line.
# Three of the `rm`s are pre-run cleanups: a re-run from the Gitea UI keeps the same run id,
# hence the same $SMOKE_NAME.
INSPECT_TIMEOUT = 30
REMOVE_TIMEOUT = 30
GUARD_TIMEOUT = 90
START_TIMEOUT = 60
EXEC_TIMEOUT = 30
LOGS_TIMEOUT = 15
# The CAD probe gets three times the bound: the first `import cadquery` in a fresh image reads
# ~222 MB of OpenCASCADE and VTK off a cold overlay.
CAD_TIMEOUT = 90

# The startup-marker poll, bounded in wall clock rather than attempts, since each attempt is a
# `docker logs` with its own 15 s timeout. The marker normally arrives within a second.
STARTUP_BUDGET = 30
STARTUP_PAUSE = 0.5

# How much of an unexpected output reaches the log. Container logs can run to thousands of
# lines when something loops, and an unbounded dump would bury the verdict.
EXCERPT_CHARS = 4000

# Exit codes. A broken check and a gate that could not start are different problems for
# whoever reads the run list, so they are different codes.
EXIT_CHECKS_FAILED = 1
EXIT_MISCONFIGURED = 2
# The gate itself is broken: a probe returned a different number of verdicts than declared, or
# the script crashed (the `__main__` block). Separate from 1, because 1 means "the image is
# broken" and 3 means "the gate has not graded the image".
EXIT_SELF_CHECK = 3

# Fed to `sh -c` inside the container to answer "which of these paths exist", with the paths as
# positional arguments so no quoting can break them. Shared by checks (d) and (g), which want
# opposite answers; neither treats a missing line as a pass.
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
        # Defensive: this path exists to show the output of a failed call, so a TypeError here
        # would destroy the evidence.
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

    A status of None means there was NO EXIT CODE (timeout, or docker not on PATH) and `output`
    says which. That is a finding about the runner and is never worded like a non-zero exit,
    which is a finding about the image.
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

    Best effort: the result is not inspected and is never the reason a check fails.

    `-v` removes only that container's anonymous volumes (none today), never a named one. This
    function is what removes the two non-`--rm` containers on every normal run; the workflows'
    `if: always()` cleanup covers a run killed by its timeout. Both paths carry `-v`; if you
    change one, change the other.
    """
    docker(["rm", "-f", "-v", name], REMOVE_TIMEOUT)


def environment_flags():
    """SMOKE_ENV as `-e VAR=value` pairs for a `docker run` argument list."""
    flags = []
    for pair in SMOKE_ENV:
        flags.extend(["-e", pair])
    return flags


def memory_flags(limit):
    """One container's ceiling, as `--memory` AND `--memory-swap`, always equal.

    `--memory-swap` is the memory+swap TOTAL, so leaving it out gives the container swap equal
    to the limit and the ceiling stops being one. `tests/test_ci_memory_ceilings.py` holds the
    same rule over the workflows, where the flags are literal text.
    """
    return ["--memory", limit, "--memory-swap", limit]


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

    # `src/settings.py` defaults `data_dir` to the relative path `data`, resolved against the
    # working directory, so a moved WORKDIR puts all state outside the mounted volume.
    # templates/ and static/ are anchored to the code's location instead; check (g) covers them.
    working_dir = config.get("WorkingDir")
    rows.append((workdir_target, None if working_dir == APP_DIR else (
        "it is {!r}. Relative paths — the data directory above all — resolve against the "
        "working directory, so state ends up outside the mounted volume and is lost on the "
        "next redeploy".format(working_dir))))

    # Protects check (b): container stdout is a pipe, which CPython block-buffers, so without
    # this the guard's message could be lost and check (b) would have nothing to match.
    env = config.get("Env") or []
    rows.append((unbuffered_target, None if "PYTHONUNBUFFERED=1" in env else (
        "it does not. Container stdout is a pipe and CPython block-buffers a pipe, so "
        "anything written shortly before the process dies can be lost instead of reaching "
        "`docker logs` — including the startup guard's own message, which is the only thing "
        "check (b) below has to look at. Declared Env: {!r}".format(env))))

    return rows


def check_required_variable_guard(image, name):
    """(b) The image refuses to start without its required variables, AND NAMES EVERY ONE.

    Started with NO environment at all — the shape of the real accident: a stack redeployed
    after a variable was dropped from the compose file or `.env`.

    The exit code alone proves little (an import error also exits non-zero), so the message
    is checked too: one row for the class of the problem (`Missing required variable(s)`) and
    one row per variable name, so a regression to naming only the first missing key fails a
    row that names the key. With `restart: always` in production, that message is the only
    thing that separates a dropped variable from a broken image.
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
        ["run", "--rm", "--name", name] + memory_flags(GUARD_MEMORY) + [image],
        GUARD_TIMEOUT)
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

    There is no `USER` line in the Dockerfile (the entrypoint starts as root to fix volume
    ownership and drops to `app` via gosu), so no `docker inspect` can answer this, and a broken
    drop changes nothing else visible.

    `docker exec` does not go through the ENTRYPOINT and runs as root here, so the question is
    asked of PID 1 by reading /proc/1/status.

    Not exercised: the entrypoint's `chown -R app:app /app/data` on a root-owned volume, which
    would need a bind mount the host daemon cannot resolve from this job.
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

    Returns (seen, None, output) where `seen` maps each reported path to "present" or "absent",
    or (None, reason, output) when the sweep could not run; callers then fail every row. The
    verdict stays with each caller, since (d) and (g) want opposite answers.
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

    `.env` matters most: baked into a pushed image it is a credential leak with no visible trace.
    `.venv` does not shadow the image's packages (it never enters sys.path); its presence would
    mean the build context is not what the Dockerfile assumes, the same fault that leaks `.env`.
    `tests/` is dead weight.

    The Dockerfile copies files one by one today, so this guards against a future `COPY . .`.
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
    """(g) The templates, viewer assets and other required files really are in the image.

    The mirror of (d). The suite runs against a checkout, check (a) says nothing about trees
    anchored to the code's location, and (b), (c) and (e) all pass without templates because
    `/health` answers with a literal string. So a deleted `COPY static/ static/` would reach
    `:latest` green without this check.
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
                "it is NOT. Some line of the Dockerfile is supposed to put it there and has "
                "stopped: a deleted COPY, a renamed directory, a file dropped from a tree, a "
                "build stage that no longer emits it. Whichever it is, the image still builds, "
                "still starts and still reports itself healthy, while the page that needs this "
                "file is broken for every visitor. Nothing else in this pipeline can see that: "
                "the suite runs against a CHECKOUT and never looks inside the artefact")))
        else:
            # As in check (d): no verdict for a path is not a pass.
            rows.append((target, (
                "the sweep returned no verdict for this path. Full output:\n{}".format(
                    excerpt(output)))))
    return rows


def check_startup(image, name):
    """(e) The image's OWN command starts and gets through its own startup.

    Healthy is either: reached the marker and still running (this service, which serves
    forever), or reached the marker and exited 0 (a one-shot command that did its job). A
    non-zero exit or no marker at all is unhealthy.
    """
    marker_target = "the image's own command logs {!r}".format(STARTUP_MARKER)
    state_target = "...and the container then either keeps running or exits 0"
    targets = (marker_target, state_target)

    remove_container(name)

    # No `--rm`: both rows below are read AFTER the container may already have exited, and
    # `--rm` would have taken its logs and its exit code away with it.
    status, output = docker(
        ["run", "-d", "--name", name] + memory_flags(CMD_MEMORY)
        + environment_flags() + [image], START_TIMEOUT)
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
            # Exit on the LAST expected marker, not the first: see STARTUP_MARKERS.
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

    Returns (verdicts, None) or (None, reason). OpenCASCADE and VTK print noise before the
    payload and, from static destructors at interpreter exit, after it, so everything before
    the LAST sentinel is dropped and only the first non-empty line after it is parsed (the
    payload is one `json.dumps` line).
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

    The suite runs on a checkout with the host's X and GL libraries, so a system library missing
    from the Dockerfile's apt list shows up only here, as `ImportError: libGL.so.1`. The
    installed versions are read back too: cadquery constrains OCP only by range, and kernel
    drift would silently change published geometry hashes.

    Execs into the probe container rather than starting another (the image is ~2 GB). Not run
    with `-u app`: linking and metadata are the same for both accounts, and `docker exec -u app`
    lacks the environment gosu would set (HOME).
    """
    imports = [
        ("import:{}:{}".format(module, symbol), module, symbol)
        for module, symbol in CAD_IMPORTS
    ]
    # sorted() so the pin rows come out in the same order on every run, for comparing logs.
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
            # The probe reports failures through the map and exits 0, so a non-zero exit means
            # the interpreter could not finish, likely killed by a signal in a native import.
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


def parse_marked_verdicts(output, mark):
    """Pull a probe's line-marked verdicts out of a container's stdout.

    The wire format is `<mark> ok <key>` and `<mark> bad <key> <one-line reason>`, shared by
    checks (h) and (i). Returns {key: None or reason} for every key reported; a missing key is
    a third answer that every caller treats as a failure. Unmarked lines (warnings folded in
    from stderr) are ignored.
    """
    seen = {}
    for line in output.splitlines():
        fields = line.split(None, 3)
        if len(fields) < 3 or fields[0] != mark:
            continue
        if fields[1] == "ok":
            seen[fields[2]] = None
        elif fields[1] == "bad" and len(fields) == 4:
            seen[fields[2]] = fields[3]
    return seen


def parse_start_routes(output):
    """Pull check (h)'s verdicts out of the probe's stdout, keyed by route."""
    return parse_marked_verdicts(output, START_MARK)


def check_start_routes(name):
    """(h) The `/start` routes answer, asked of the container running the image's own command.

    The only check that makes a request; two of the three files are assembled from
    `hammerola/` and `model_template/` per request, so this is the only way to check them.

    No `blocked` parameter: it execs into check (e)'s container, and if that container is gone
    `docker exec` fails every row on its own.

    Narrower than (e) by one case: a one-shot command that exits 0 leaves no container to ask.
    If the image's command ever takes that shape, this check needs its own long-running
    container rather than a relaxed verdict.
    """
    targets = ["{} answers 200 with a body".format(path) for path in START_ROUTES]

    request = json.dumps({
        "routes": list(START_ROUTES),
        "origin": START_ORIGIN,
        "mark": START_MARK,
        "wait": START_WAIT,
        "read": START_READ,
        "bytes": START_READ_BYTES,
    })

    status, output = docker(
        ["exec", name, "python", "-c", START_PROBE_SOURCE, request], EXEC_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for target in targets]
    if status != 0:
        reason = (
            "the onboarding probe could not be run (docker exec exited {}). Either the "
            "container the image's own command was started in is gone — check (e) above says "
            "whether it ever came up — or the probe itself died:\n{}".format(
                status, excerpt(output)))
        return [(target, reason) for target in targets]

    seen = parse_start_routes(output)

    rows = []
    for path, target in zip(START_ROUTES, targets):
        if path not in seen:
            rows.append((target, (
                "the probe returned no verdict for this route. Full container output:\n"
                "{}".format(excerpt(output)))))
        elif seen[path] is None:
            rows.append((target, None))
        else:
            # The reason says whether the hub answered at all, so both cases are named.
            rows.append((target, (
                "{}.\n"
                "  If the hub did not answer at all, this says nothing about the route: the "
                "container is gone or was never listening, and check (e) above is what says "
                "whether the image's own command came up.\n"
                "  If it DID answer and the answer was wrong, the route is the finding. These "
                "two are assembled when they are asked — the client out of the modules "
                "reachable from hammerola/cli.py, the template out of model_template/ — and "
                "src/app.py answers 404 when that assembly refuses, so a module .dockerignore "
                "kept out of the image or a template path no client would unpack shows up HERE "
                "and nowhere else: check (g) names three onboarding paths and cannot see the "
                "rest, and the suite builds these archives from the checkout, where they are "
                "all present".format(seen[path]))))
    return rows


def check_build_ceilings(name, blocked=None):
    """(i) The build wrapper runs inside the image, as `app`, and its ceilings really go on.

    Runs the exact command the hub spawns for every push, then asks the process on the far side
    of the wrapper's `execv` which ceilings it is under (see the constants above).

    `-u app` is the point: `docker exec` skips the entrypoint, and root may raise hard limits
    and avoid the refusals that matter. `-w /app` because `-m` resolves against the working
    directory, as at `runner.HUB_ROOT`.

    It never runs a model: the build itself (child, cadquery, gates) belongs to the suite and
    check (f). Execs into the probe container rather than starting another.
    """
    targets = [target for _key, target in BUILD_TARGETS]

    if blocked is not None:
        return [(target, blocked) for target in targets]

    request = json.dumps({
        "mark": BUILD_MARK,
        "keys": [key for key, _target in BUILD_TARGETS],
        "timeout": BUILD_RUN_SECONDS,
    })

    status, output = docker(
        ["exec", "-u", APP_USER, "-w", APP_DIR, name, "python", "-c", BUILD_PROBE_SOURCE,
         request],
        EXEC_TIMEOUT)
    if status is None:
        return [(target, "not attempted: " + output) for target in targets]
    if status != 0:
        # The probe reports through marked lines and exits 0, so this means it could not finish.
        reason = (
            "the build probe could not be run (docker exec exited {}). It answers its own "
            "questions and exits 0 whatever they answer, so this is the probe dying rather "
            "than a ceiling being wrong:\n{}".format(status, excerpt(output)))
        return [(target, reason) for target in targets]

    seen = parse_marked_verdicts(output, BUILD_MARK)

    rows = []
    for key, target in BUILD_TARGETS:
        if key not in seen:
            # No verdict is a third answer, never a pass.
            rows.append((target, (
                "the probe returned no verdict for this one. Full container output:\n"
                "{}".format(excerpt(output)))))
        elif seen[key] is None:
            rows.append((target, None))
        else:
            rows.append((target, (
                "{}.\n"
                "  The hub spawns this command for every push (src/buildproc/runner.py), so an "
                "image this row is red about builds NOTHING — the wrapper refuses before a "
                "line of the model has been read, or it runs it with a ceiling that is not "
                "there. Every check above stays green either way: the image starts, drops "
                "privileges, serves every page and imports the CAD kernel, and the first "
                "person to push is the one who finds out.".format(seen[key]))))
    return rows


def main():
    image = os.environ.get(IMAGE_ENV)
    name = os.environ.get(NAME_ENV)
    missing = [variable for variable, value in ((IMAGE_ENV, image), (NAME_ENV, name))
               if not value]
    if missing:
        # Refused before anything starts: a default tag could grade the wrong image, and a
        # default name could collide with a concurrent run on the shared daemon.
        print("smoke cannot run: {} not set. The workflow has to provide {} (the exact tag "
              "that was just built) and {} (a base container name unique to this run).".format(
                  ", ".join(missing), IMAGE_ENV, NAME_ENV))
        raise SystemExit(EXIT_MISCONFIGURED)

    probe_name = name
    guard_name = name + GUARD_SUFFIX
    cmd_name = name + CMD_SUFFIX

    # Each probe's rows stay in their own local so the self-check can name a probe that went
    # quiet.
    contract_rows = check_image_contract(image)
    guard_rows = check_required_variable_guard(image, guard_name)

    try:
        # One long-lived container serves (c), (d), (f), (g) and (i).
        remove_container(probe_name)
        start_status, start_output = docker(
            ["run", "-d", "--name", probe_name] + memory_flags(PROBE_MEMORY)
            + environment_flags() + [image] + IDLE_COMMAND,
            START_TIMEOUT)
        if start_status is None:
            blocked = "not attempted: " + start_output
        elif start_status != 0:
            blocked = (
                "not attempted: the probe container could not be started (docker run exited "
                "{}):\n{}".format(start_status, excerpt(start_output)))
        else:
            blocked = None
        # `blocked` makes a probe whose container never started still return its full set of
        # rows, all failed, so the counts stay meaningful.
        privileges_rows = check_privileges_dropped(probe_name, blocked=blocked)
        excluded_rows = check_excluded_paths(probe_name, blocked=blocked)

        startup_rows = check_startup(image, cmd_name)

        # The calls below run in EXPECTED_TARGETS order, which the positional pairing depends
        # on. They exec into the probe container, so they sit inside this `finally`.
        cad_rows = check_cad_kernel(probe_name, blocked=blocked)

        required_rows = check_required_paths(probe_name, blocked=blocked)

        # Into the `-cmd` container, so the hub asked is the program production runs.
        start_rows = check_start_routes(cmd_name)

        # The last exec into the probe container, so its `sleep` must outlast this call (see
        # IDLE_COMMAND).
        build_rows = check_build_ceilings(probe_name, blocked=blocked)
    finally:
        # The workflow removes these again under `if: always()` in case this process is killed.
        remove_container(probe_name)
        remove_container(cmd_name)

    # SAME ORDER AS EXPECTED_TARGETS: the pairing is positional, and groups with equal arity
    # could be swapped without any check below noticing.
    produced = (contract_rows, guard_rows, privileges_rows, excluded_rows, startup_rows,
                cad_rows, required_rows, start_rows, build_rows)

    # Three self-checks, each catching a break the others cannot. `wiring` holds free-text
    # findings about this file's own consistency; `miscounted` holds one entry per probe
    # whose count disagrees.
    wiring = []

    # (1) Same number of probe groups. `zip` silently stops at the shorter list, so a probe
    # removed from `produced` would otherwise pass the per-probe check. (3) would catch it too,
    # but this line names the cause. `zip(..., strict=True)` needs Python 3.10, and the
    # runner's python3 is not pinned.
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

    # (2) Per probe, only when the arity agrees: pairing lists of different lengths would blame
    # the wrong labels.
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

    # (3) The total, against the sum of the declarations: catches a group extended into `rows`
    # twice, which leaves (1) and (2) correct.
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

    # Reported in full even when the self-check also fires: they are independent facts.
    if failures:
        print("")
        print("smoke FAILED: {}/{} targets broken".format(len(failures), len(rows)))
        for target in failures:
            print("  - {}".format(target))

    # The self-check comes before the success line, so `smoke ok` is never printed by a run
    # that returned fewer verdicts than it declares.
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
    # SystemExit passes through `except Exception` untouched, so exit codes 0-3 keep their
    # meaning. An unplanned exception would otherwise exit 1, which means "the image is broken";
    # a crash of the gate exits 3 instead. stdout is flushed first so the printed rows precede
    # the traceback in the log.
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
