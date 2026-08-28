# The browser bundle is compiled HERE, in a stage that exists only during the
# build, so that node never reaches the runtime image — the service is Python,
# and a node toolchain in the published image would be several hundred megabytes
# of attack surface serving one static file.
#
# The stage is also the reason the bundle is not committed to the repository. A
# committed artefact has nothing forcing it to be rebuilt when the JSX beside it
# changes and nothing that reports it was not, so it drifts from its source in
# silence. Built here, the bundle in an image is by construction the bundle of
# that image's commit.
#
# The split COPY is the layer cache and not tidiness: package.json and the
# lockfile change rarely, the sources change constantly, and `npm ci` costs tens
# of seconds. Copying `ui/` wholesale before the install would invalidate that
# layer on every edit to a component.
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM python:3.11-slim

WORKDIR /app

# Unbuffered stdout/stderr. Docker gives a container a pipe rather than a terminal, and
# Python block-buffers a pipe — so anything written shortly before the process dies can be
# lost instead of reaching `docker logs`. That matters most for the one message an operator
# needs: a startup guard that reports a missing variable and exits. `os._exit()` and a
# signal-killed process both skip the flush entirely, so the container exits non-zero with
# no explanation at all. This has cost real debugging time twice; the cost of the setting
# is a syscall per write.
ENV PYTHONUNBUFFERED=1

# curl is required by the compose healthcheck; add other system packages here (e.g. cups-client, libmagic).
# gosu is used by the entrypoint to drop privileges from root to the app user.
#
# The seven X/GL/expat libraries after them are for the CAD kernel. `cadquery-ocp` is a native
# OpenCASCADE binding, and without the three it actually needs (libGL, libX11, libexpat — the
# derivation is below) `import cadquery` fails OUTRIGHT — the classic symptom is
# `ImportError: libGL.so.1: cannot open shared object file`, raised at import time, long before
# any geometry is attempted. Nothing here draws anything on screen; OpenCASCADE simply links its
# visualisation toolkits unconditionally.
#
# THE LIST DOES NOT COME FROM THE MANYLINUX POLICY, and the derivation that suggests itself is
# false. OCP ships as a manylinux wheel, so it is tempting to argue that `auditwheel` vendored
# every shared library it links against into `cadquery_ocp.libs/` EXCEPT the ones on the policy allowlist,
# and to read the required system packages straight off that allowlist. This very wheel refutes
# it: `libexpat.so.1` is not on the allowlist and was not vendored either — the vendored
# `libfontconfig-ebabad56.so.1.12.0` still carries an unpatched `DT_NEEDED libexpat.so.1`, so the
# system is expected to supply it. Everything below therefore comes from READING the wheels' ELF
# headers, not from what the packaging policy implies.
#
# What that sweep over the 70 ELF objects in the OCP wheel shows is genuinely needed from outside:
#     libGL.so.1      -> libgl1        (libTKOpenGl)
#     libX11.so.6     -> libx11-6      (libTKOpenGl, libTKService)
#     libexpat.so.1   -> libexpat1     (the wheel's own vendored fontconfig, which libTKService
#                                       depends on)
#
# `libexpat1` is the row to be careful with, and it is listed explicitly for a reason. Debian
# trixie's python:3.11-slim carries NO libexpat at all, and today the package still arrives —
# purely transitively — as libgl1 -> libglx-mesa0 -> libexpat1. That is somebody else's dependency
# graph holding up our import: after `import cadquery` inside the built image,
# `/usr/lib/x86_64-linux-gnu/libexpat.so.1` is really mapped into the process. Naming it here is
# what keeps the next attempt to replace `libgl1` with something lighter from silently breaking
# `import cadquery` — any such swap must keep libexpat1.
#
# The remaining four — libxext6, libxrender1, libsm6, libice6 — are kept WITH MARGIN, not derived:
# `libXext.so.6`, `libXrender.so.1`, `libSM.so.6` and `libICE.so.6` appear in the DT_NEEDED of
# nothing at all, neither in the OCP wheel (70 objects) nor in the VTK wheel (370). They cost a
# few hundred kilobytes, they are what every OpenCASCADE recipe installs, and they insure against
# a future release linking its X stack differently. Do not repeat that they are required: as of
# these pinned versions they are not.
#
# DELIBERATELY NOT INSTALLED: `libglu1-mesa` (libGLU.so.1) — the one library commonly named in
# this recipe that really is unnecessary here. `libGLU.so.1` occurs in no DT_NEEDED of any of the
# 70 ELF objects in the OCP wheel; that is a result of reading them, not an inference from the
# packaging policy the libexpat case just disproved. It is still a claim about somebody else's
# wheel, so it is also checked empirically: ci/smoke.py imports cadquery INSIDE the built image
# before anything is pushed, so a wrong reading turns the gate red and no broken image reaches the
# registry. If that ever happens with a `libGLU.so.1` message, add `libglu1-mesa` back to the list
# and delete this paragraph.
#
# ONE `RUN`, with `--no-install-recommends` and the apt lists removed in the SAME layer. Removing
# them in a later RUN would shrink nothing: the lists would already be committed into the layer
# above, and the `rm` would only add a whiteout on top of them. `--no-install-recommends` matters
# more than usual for the X libraries — their recommends pull in a chain of desktop packages this
# container has no use for.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        gosu \
        libgl1 \
        libx11-6 \
        libexpat1 \
        libxext6 \
        libxrender1 \
        libsm6 \
        libice6 \
    && rm -rf /var/lib/apt/lists/*

# Fixed uid keeps volume ownership stable across image rebuilds.
RUN useradd -m -u 1000 app

# Dependencies as a separate layer: change less often than code → cached better
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Runtime state directory. When a named volume is first initialised from this
# image, docker copies the ownership of this dir — so the volume starts owned by app.
RUN mkdir -p data && chown app:app data

# Code and static assets
COPY src/ src/
COPY templates/ templates/
COPY static/ static/
# What the hub hands somebody who has just found it (src/onboarding.py serves
# both): the agent instructions at /start/skill.md, and the starter model
# directory at /start/template.tar.gz. Two trees rather than one, because they
# are two different things with two different readers — and `model_template/` is
# a real project that the test suite BUILDS (tests/test_template.py), which is
# what keeps it from going stale against the gate it has to pass.
#
# `skill/SKILL.md` reaches the context despite the `*.md` line in .dockerignore:
# a pattern there is matched with `*` not crossing a `/`, so that line is
# root-only and takes AGENTS.md, CLAUDE.md and README.md. Check (g) in
# ci/smoke.py is what proves both of these arrived, because nothing else can:
# the image starts, serves and passes every other check without them, and the
# routes simply 404.
COPY skill/ skill/
COPY model_template/ model_template/
# The browser bundle, compiled by the `ui` stage above.
#
# It lands FLAT beside the committed assets rather than in a subdirectory of its
# own, and that is forced rather than chosen: the hub serves `/_v/<one path
# component>` and nothing deeper — `_serve_asset`/`_safe_name` in src/app.py,
# which is a path-traversal defence. A nested bundle would build, ship, satisfy
# the gate and then 404 in the browser.
#
# ONE COPY PER FILE, NAMED ON BOTH SIDES, and not `COPY --from=ui /ui/dist
# static/_v`. The directory form would MERGE the build output into a directory
# that already holds this project's own assets — site.css, pointer.js,
# pointer_pref.js, the vendored three-cad-viewer bundle — where a name collision
# is a silent overwrite. `pointer.js` is an entirely ordinary name for a bundler
# to emit as a chunk, and the gate could not see it happen: check (g) asks whether a path
# EXISTS, and after such an overwrite it still does. Copying by name means
# nothing the build emits can reach the image unless a line here asks for it.
#
# It is also the second of two defences over which copy wins. .dockerignore
# excludes `static/_v/hammerola*`, so a workstation's `make ui` output should not
# reach the build context at all; this line runs AFTER `COPY static/ static/`, so
# a bundle that got in anyway is overwritten by the stage's output. KEEP THIS
# LINE BELOW THAT ONE.
#
# Both are needed, because neither covers the other's case. Order can only settle
# a file the stage ALSO emits — winning here means being copied over the same
# name — so a chunk an older vite config produced and this build no longer does
# arrives with nothing to overwrite it, and only the .dockerignore line keeps it
# out. In the other direction, that line is a string somebody can delete without
# any build failing, and this ordering is what still holds afterwards.
#
# When the build starts emitting a second file, it gets a line of its own here
# and a row in ci/smoke.py's REQUIRED_PATHS. Getting that wrong is loud in both
# directions: a file listed here and no longer produced fails the build at this
# line, and a file produced but not listed never enters the image, which is what
# REQUIRED_PATHS catches.
COPY --from=ui /ui/dist/hammerola.js static/_v/hammerola.js
COPY main.py .
# The one top-level module in this image, and it is not a stray file: every
# model.py in the fleet opens with `import checklib`, exactly as it opens with
# `def views()`. It re-exports src/cadbuild/checklib.py under that name, and it
# has to be at /app rather than inside the package because a model is imported
# with its own directory FIRST on sys.path — so the name has to resolve on the
# path behind it, which /app is. See checklib.py's own docstring.
COPY checklib.py .
# --chmod pins the executable bit: exec-form ENTRYPOINT fails with "permission
# denied" if the bit is lost in the build context (Windows checkout, tar copy).
COPY --chmod=0755 entrypoint.sh /entrypoint.sh

# No EXPOSE: the service is published by Traefik via docker-compose labels.

# No USER directive on purpose: the entrypoint starts as root, heals /app/data
# ownership (migration from older root-based images) and drops to app via gosu.
# A compose `user:` override is respected (the entrypoint then just execs).
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "main.py"]
