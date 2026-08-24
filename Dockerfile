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
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gosu \
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
COPY main.py .
# --chmod pins the executable bit: exec-form ENTRYPOINT fails with "permission
# denied" if the bit is lost in the build context (Windows checkout, tar copy).
COPY --chmod=0755 entrypoint.sh /entrypoint.sh

# No EXPOSE: the service is published by Traefik via docker-compose labels.

# No USER directive on purpose: the entrypoint starts as root, heals /app/data
# ownership (migration from older root-based images) and drops to app via gosu.
# A compose `user:` override is respected (the entrypoint then just execs).
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "main.py"]
