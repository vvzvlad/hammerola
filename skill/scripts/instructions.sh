#!/bin/bash
# usage: bash instructions.sh [PROJECT_DIR] [-o OUT.pdf]   (IKEA-style assembly instructions of the project's `assembled` view as a vector A4 PDF: steps from PROJECT_DIR/instructions.json, the model run by instructions.py in the hub image in docker, with the hub's KiCad service beside it for a model that places a board; the project is not modified)
# needs: bash, git, tar, docker that runs gitea.vvzvlad.xyz/projects/hammerola:latest and gitea.vvzvlad.xyz/projects/hammerola-kicad:latest (linux/amd64), instructions.py next to this script; PROJECT_DIR is in a git work tree and holds model.py, project.json and instructions.json, none of them ignored by git
# defaults: PROJECT_DIR = ., OUT = PROJECT_DIR/instructions.pdf; what goes into the container is `git ls-files -co --exclude-standard` of PROJECT_DIR (tracked files and untracked ones git does not ignore: what a commit could carry)
# exit: 0 = the PDF is written and its absolute path printed; 1 = instructions.json or the model refused, with "instructions: <what and where>", the KiCad service did not start, or instructions.py itself crashed (its traceback); 2 = bad arguments (an option without its value, PROJECT_DIR or the directory of OUT missing), no git work tree, or a missing or git-ignored file; otherwise the code of the failing docker command; 130/143 = interrupted (INT/TERM), the containers and their network are removed
set -eu
H="$(cd "$(dirname "$0")" && pwd)"
IMG=gitea.vvzvlad.xyz/projects/hammerola:latest
# the KiCad service `import kicadboard` exports a board through (kicadsvc/ in the hub repository)
KIMG=gitea.vvzvlad.xyz/projects/hammerola-kicad:latest
P=. OUT=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) [ $# -ge 2 ] || { echo "instructions: -o needs the PDF's path"; exit 2; }; OUT=$2; shift ;;
    -*) echo "unknown option: $1"; exit 2 ;;
    *) P=$1 ;;
  esac
  shift
done
[ -d "$P" ] || { echo "instructions: $P is not a directory"; exit 2; }
P="$(cd "$P" && pwd)"
git -C "$P" rev-parse --is-inside-work-tree > /dev/null 2>&1 \
  || { echo "instructions: $P is not in a git work tree; the container gets what git would commit there"; exit 2; }
for f in model.py project.json instructions.json; do
  [ -f "$P/$f" ] || { echo "instructions: $P has no $f"; exit 2; }
  [ -n "$(git -C "$P" ls-files -co --exclude-standard -- "$f")" ] \
    || { echo "instructions: $P/$f is ignored by git, so it does not go into the container"; exit 2; }
done
OUT="${OUT:-$P/instructions.pdf}"
[ -d "$(dirname "$OUT")" ] || { echo "instructions: $(dirname "$OUT") does not exist, so $OUT cannot be written"; exit 2; }
OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
T="$(mktemp -d "${TMPDIR:-/tmp}/instructions.XXXXXX")"
# the scratch dir, and from its creation on the container, go on any exit, a kill or Ctrl+C included
trap 'rm -rf "$T"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$T/job/project"
cp "$H/instructions.py" "$T/job/"
# the model and the KiCad service on a network of this run's alone, named after the scratch dir, so
# two runs on one daemon do not meet; each name goes on exit, the containers with -v
N="hammerola-$(basename "$T")"
docker network create "$N" > /dev/null
trap 'docker network rm "$N" > /dev/null; rm -rf "$T"' EXIT
docker run -d --name "$N-kicad" --network "$N" "$KIMG" > /dev/null
trap 'docker rm -f -v "$N-kicad" > /dev/null; docker network rm "$N" > /dev/null; rm -rf "$T"' EXIT
C="$(docker create --name "$N-model" --network "$N" --entrypoint python -e PYTHONPATH=/app \
  -e KICAD_URL="http://$N-kicad:8080" "$IMG" /job/instructions.py /job/project /tmp/instructions.pdf)"
trap 'docker rm -f -v "$C" "$N-kicad" > /dev/null; docker network rm "$N" > /dev/null; rm -rf "$T"' EXIT
# no bind mounts: files move with docker cp, so the daemon may run on another machine
docker cp -q "$T/job" "$C:/job"
# --no-xattrs: macOS tags downloaded and copied files (com.apple.quarantine, .provenance), and the
# daemon refuses to set those on extraction, failing the whole copy
git -C "$P" ls-files -co --exclude-standard -z \
  | COPYFILE_DISABLE=1 tar -C "$P" --no-xattrs -cf - --null -T - | docker cp -q - "$C:/job/project"
# the service listens a second or so after its start; the model's first export must not come sooner
for i in $(seq 30); do
  docker exec "$N-kicad" python3 -c 'import socket; socket.create_connection(("127.0.0.1", 8080), 1)' \
    2> /dev/null && break
  [ "$i" -lt 30 ] || { echo "instructions: the KiCad service ($KIMG) is not listening 30 s after its start"; exit 1; }
  sleep 1
done
# in the background so that a signal reaches the traps while bash waits
docker start -a "$C" &
wait $! || true
# the container's own exit code: a dropped attach to the docker host is not a failure of the run
docker wait "$C" > "$T/rc" &
wait $!
rc="$(cat "$T/rc")"
[ "$rc" -eq 0 ] || exit "$rc"
docker cp -q "$C:/tmp/instructions.pdf" "$OUT"
echo "$OUT"
