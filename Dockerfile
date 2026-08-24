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
