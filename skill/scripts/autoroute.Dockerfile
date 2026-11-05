# usage: docker build -f autoroute.Dockerfile <dir with autoroute_run.sh and autoroute_board.py>   (autoroute.sh builds it itself)
# needs: docker build; contents: KiCad 10.0.6 with pcbnew and kicad-cli, fastroute 0.1.14 linux-x64 and its KiCad plugin, Java 25, Freerouting 2.5.0 jar
FROM kicad/kicad:10.0.6-full
USER root
COPY --from=eclipse-temurin:25-jre /opt/java/openjdk /opt/java/openjdk
# downloads in RUN, not ADD <url>: the layer cache is keyed by this command text (URLs and sha256),
# so a cached build needs no network (the legacy builder fetches every ADD <url> again and ignores ADD --checksum)
RUN python3 -c "import urllib.request as u; \
[u.urlretrieve(url, dst) for url, dst in ( \
('https://github.com/parisxmas/fastroute/releases/download/v0.1.14/fastroute-0.1.14-linux-x64.tar.gz', '/tmp/fastroute.tgz'), \
('https://github.com/parisxmas/fastroute/releases/download/v0.1.14/fastroute-kicad-0.1.14.zip', '/tmp/fastroute-kicad.zip'), \
('https://github.com/freerouting/freerouting/releases/download/v2.5.0/freerouting-2.5.0.jar', '/opt/freerouting.jar'))]" \
 && printf '%s  %s\n' \
      079a109f76d84836e7d7a54519e75759dcab9baacc9c58b4224b027b852e49c6 /tmp/fastroute.tgz \
      8e11f842480be00ba0426ff3e15dadebb2481bacde6efa0080598406f8fbfc43 /tmp/fastroute-kicad.zip \
      f6f51bb02245e8e717f9359bd260cc9c5c0b1bc0acc8b7cb2cd5b8ffeb5de3c7 /opt/freerouting.jar | sha256sum -c \
 && tar -xzf /tmp/fastroute.tgz -C /opt \
 && ln -s /opt/fastroute-0.1.14-linux-x64/fastroute /usr/local/bin/fastroute \
 && ln -s /opt/java/openjdk/bin/java /usr/local/bin/java \
 && python3 -m zipfile -e /tmp/fastroute-kicad.zip /opt/fastroute-kicad \
 && rm /tmp/fastroute.tgz /tmp/fastroute-kicad.zip \
 && chmod 0644 /opt/freerouting.jar \
 && mkdir /work && chown kicad:kicad /work
COPY autoroute_run.sh autoroute_board.py /opt/autoroute/
USER kicad
WORKDIR /work
