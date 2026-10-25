# The browser bundle is built in a build-only stage, so node never reaches the runtime
# image, and the bundle in an image is always the bundle of that image's commit (it is not
# committed to the repository). The split COPY keeps `npm ci` cached across source edits.
FROM node:22-bookworm-slim AS ui
WORKDIR /ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM python:3.11-slim

WORKDIR /app

# Unbuffered stdout/stderr: Docker gives the container a pipe, which Python block-buffers,
# so a startup guard's last message before exiting could otherwise never reach `docker logs`.
ENV PYTHONUNBUFFERED=1

# curl is required by the compose healthcheck; add other system packages here (e.g. cups-client, libmagic).
# gosu is used by the entrypoint to drop privileges from root to the app user.
#
# The X/GL/expat libraries are for the CAD kernel: `cadquery-ocp` links OpenCASCADE's
# visualisation toolkits unconditionally, so without them `import cadquery` fails with e.g.
# `ImportError: libGL.so.1`. Read off the DT_NEEDED entries of the OCP wheel's ELF objects
# (not the manylinux allowlist, which does not cover libexpat), the required ones are:
#     libGL.so.1      -> libgl1        (libTKOpenGl)
#     libX11.so.6     -> libx11-6      (libTKOpenGl, libTKService)
#     libexpat.so.1   -> libexpat1     (the wheel's own vendored fontconfig, which libTKService
#                                       depends on)
# libexpat1 is listed explicitly although libgl1 currently pulls it in transitively: python:3.11-slim
# has none, so any replacement of libgl1 must keep it.
# libxext6, libxrender1, libsm6 and libice6 are margin, not requirements: nothing in the
# pinned OCP or VTK wheels needs them, but every OpenCASCADE recipe installs them.
# libglu1-mesa is deliberately not installed (no DT_NEEDED references libGLU.so.1);
# ci/smoke.py imports cadquery inside the built image, so a wrong reading fails the gate.
# fonts-dejavu-core is for the picture of a DXF (`docsbuild._draw_dxf`): ezdxf draws text
# with the system's TrueType fonts, and python:3.11-slim has none, so every text in the
# drawing would come out as an empty box.
# One RUN with `--no-install-recommends` and the apt lists removed in the same layer; the X
# libraries' recommends would pull in desktop packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fonts-dejavu-core \
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

# Dependencies as a separate layer: change less often than code → cached better.
# The lock is what is installed: requirements.txt is the hand-written intent, and
# requirements.lock is compiled from it by `make lock` with every distribution pinned and
# hashed (tests/test_requirements_lock.py checks the two agree). `--require-hashes` makes
# pip refuse any file whose bytes differ from the resolved ones and fail if any dependency
# is missing from the lock. Only the lock is in this layer, so editing requirements.txt
# does not reinstall the wheels.
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock

# Runtime state directory. When a named volume is first initialised from this
# image, docker copies the ownership of this dir — so the volume starts owned by app.
RUN mkdir -p data && chown app:app data

# Code and static assets
COPY src/ src/
COPY hammerola/ hammerola/
COPY templates/ templates/
COPY static/ static/
# Served by src/onboarding.py: the agent instructions at /start/skill.tar.gz and the starter
# model at /start/template.tar.gz. model_template/ is a real project the suite builds
# (tests/test_template.py). The instructions are a DIRECTORY — `skill/SKILL.md` and the
# reference files beside it — and all of it reaches the context despite the `*.md` line in
# .dockerignore, which is root-only. Check (g) in ci/smoke.py proves both arrived; without
# them the image passes everything else and the routes 404.
COPY skill/ skill/
COPY model_template/ model_template/
# The browser bundle, compiled by the `ui` stage above.
# It lands flat in static/_v because the hub serves `/_v/<one path component>` only
# (`_serve_asset`/`_safe_name` in src/app.py, a path-traversal defence).
# One COPY per file, named on both sides, rather than copying /ui/dist into static/_v: a
# directory copy would merge build output into the project's own assets, where a chunk
# named e.g. `pointer.js` would silently overwrite one.
# Keep this line below `COPY static/ static/`, so the stage's output wins over a
# workstation bundle that got into the context; .dockerignore excludes
# `static/_v/hammerola*` for files the stage no longer emits.
# A new emitted file needs a line here and a row in ci/smoke.py's REQUIRED_PATHS.
COPY --from=ui /ui/dist/hammerola.js static/_v/hammerola.js
COPY main.py .
# Every model.py opens with `import checklib`. This shim re-exports
# src/cadbuild/checklib.py and has to sit at /app, because a model is imported with its own
# directory first on sys.path. See checklib.py's docstring.
COPY checklib.py .
# Provenance only, nothing reads it: it records which of the locked distributions were
# chosen and why. Copied here rather than in the dependency layer so prose edits are cheap.
COPY requirements.txt .
# --chmod pins the executable bit: exec-form ENTRYPOINT fails with "permission
# denied" if the bit is lost in the build context (Windows checkout, tar copy).
COPY --chmod=0755 entrypoint.sh /entrypoint.sh

# No EXPOSE: the service is published by Traefik via docker-compose labels.

# No USER directive on purpose: the entrypoint starts as root, fixes /app/data
# ownership and drops to app via gosu.
# A compose `user:` override is respected (the entrypoint then just execs).
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "main.py"]
