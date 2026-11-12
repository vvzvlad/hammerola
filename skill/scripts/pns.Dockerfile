# usage: docker build -f pns.Dockerfile <dir with pns_engine.patch and pns_bridge.py>   (pns_mcp.py builds it itself)
# needs: docker build on linux/amd64; contents: PCBWorld-Engine d64b46e (KiCad 10.0.7 port, PR #1) with pns_engine.patch, its kicad_rl_router module built from KiCad 10.0.7, pns_bridge.py
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852 AS deps
# apt reads a dated snapshot of the Ubuntu archive, so this command text fixes every package version and a
# cached rebuild needs no network; the archive signature verifies the packages, the TLS peer check is off
# only because the base image has no CA store yet (ca-certificates arrives in this same step). The snapshot
# serves one connection slowly, so the packages come down eight connections at a time before the install.
# It also answers 502/503 on single files for hours at a time, so every fetch is retried with apt's backoff.
RUN sed -i 's#^URIs: .*#URIs: https://snapshot.ubuntu.com/ubuntu/20261101T000000Z/#' /etc/apt/sources.list.d/ubuntu.sources \
 && echo 'Acquire::Retries "10";' > /etc/apt/apt.conf.d/80retries \
 && P="ca-certificates git rsync build-essential cmake ninja-build pkg-config swig python3-dev python3-pybind11 \
      libwxgtk3.2-dev libwxgtk-webview3.2-dev libglm-dev libglew-dev libglu1-mesa-dev zlib1g-dev libzstd-dev \
      libcurl4-openssl-dev libspnav-dev libx11-dev libcairo2-dev libpixman-1-dev libgit2-dev libboost-dev \
      libboost-locale-dev libfreetype-dev libharfbuzz-dev libfontconfig-dev libprotobuf-dev protobuf-compiler \
      libnng-dev unixodbc-dev libsecret-1-dev libpoppler-dev libpoppler-cpp-dev libpoppler-glib-dev libexpat1-dev \
      libgtk-3-dev libwayland-dev libngspice0-dev" \
 && apt-get -o Acquire::https::Verify-Peer=false -q update \
 && cd /var/cache/apt/archives \
 && apt-get -s install --no-install-recommends $P | awk '/^Inst / { print $2 }' \
    | xargs -n 16 -P 8 apt-get -o Acquire::https::Verify-Peer=false -qq download \
 && DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::https::Verify-Peer=false -q install -y --no-install-recommends $P \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

FROM deps AS build
# sources by commit: the engine at PR #1's head, KiCad at the 10.0.7 commit build_rl_router.sh insists on, in
# the place where the script looks for it (the kicad-python submodule's own kicad checkout)
RUN git init -q /src/engine && cd /src/engine \
 && git fetch -q --depth 1 https://github.com/LGAI-Research/PCBWorld-Engine.git d64b46e0805649c3590431bb016471f3ee0de495 \
 && git checkout -q --detach FETCH_HEAD \
 && git init -q kicad-python/kicad && cd kicad-python/kicad \
 && git fetch -q --depth 1 https://gitlab.com/kicad/code/kicad.git 69cafb907ebc09e7722a2a464b1d466fc2e3608d \
 && git checkout -q --detach FETCH_HEAD
# ninja's default of one job per CPU runs a shared docker host out of memory on KiCad's sources; pns_mcp.py
# also caps the build's memory
RUN printf '#!/bin/sh\nexec /usr/bin/ninja -j 8 "$@"\n' > /usr/local/bin/ninja && chmod 0755 /usr/local/bin/ninja
# the engine as PR #1 has it, built once into this layer: a change to pns_engine.patch then recompiles only
# the files it touches
RUN cd /src/engine && BUILD_DIR=/src/build bash build_rl_router.sh > /src/build-base.log 2>&1 \
 || { tail -n 60 /src/build-base.log; exit 1; }
COPY pns_engine.patch /src/
RUN cd /src/engine && git apply /src/pns_engine.patch \
 && { BUILD_DIR=/src/build bash build_rl_router.sh > /src/build.log 2>&1 || { tail -n 60 /src/build.log; exit 1; }; } \
 && mkdir /opt/pns \
 && cp /src/build/pcbnew/python/rl/kicad_rl_router*.so /opt/pns/ \
 && ldd /opt/pns/kicad_rl_router*.so | awk '$3 ~ "^/src/build/" { print $3 }' | xargs -r cp -t /opt/pns/

FROM deps
COPY --from=build /opt/pns /opt/pns
COPY pns_bridge.py /opt/pns/
ENV PYTHONPATH=/opt/pns LD_LIBRARY_PATH=/opt/pns
RUN useradd -m pns && mkdir /work && chown pns:pns /work
USER pns
WORKDIR /work
