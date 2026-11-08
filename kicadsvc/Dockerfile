# The hub's KiCad: the official image with kicad-cli and the stock 3D library, plus
# server.py, which runs it per request (see there). Kept out of the hub's own image,
# which it would grow by 7.5 GB. Built and gated in image-check-publish.yml and
# published as gitea.vvzvlad.xyz/projects/hammerola-kicad.
FROM kicad/kicad:10.0.6-full

WORKDIR /srv
# Unbuffered, so the request log reaches `docker logs` as it happens.
ENV PYTHONUNBUFFERED=1
COPY server.py .

# The image's own unprivileged account; kicad-cli needs nothing more.
USER kicad
CMD ["python3", "server.py"]
