# usage: docker build -f gerbdiff.Dockerfile <dir with gerber_diff.py>   (references/panel.md, Checks, builds and runs it)
# needs: docker build; contents: Debian 13 slim with gerbv, python3, numpy and pillow from its packages, gerber_diff.py in /opt
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gerbv python3-numpy python3-pil \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /work
COPY gerber_diff.py /opt/
WORKDIR /work
