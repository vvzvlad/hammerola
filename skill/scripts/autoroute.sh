#!/bin/bash
# usage: bash autoroute.sh <board.kicad_pcb> [--export plain|plugin] [--min-width on|off] [--draft-time S] [--finish none|freerouting] [--finish-time S] [--diagnose]   (routes a copy of the saved board in docker: existing tracks/vias locked, copper layers typed Power plane that carry a zone (with --export plain: every Power-plane layer) get no new tracks of other nets than their planes', fastroute draft, finish, DRC with refill, geocheck.py, unrouted list; --diagnose adds fastroute's congestion/blocked class to each unrouted connection; the project is not modified)
# needs: bash, docker that runs linux/amd64 images (fastroute ships linux-x64 only), autoroute.Dockerfile, autoroute_run.sh, autoroute_board.py and geocheck.py next to this script
# defaults: --export plugin --min-width on --draft-time 300 --finish none --finish-time 600, no --diagnose; the routed copy and the run logs land in a new ${TMPDIR:-/tmp}/autoroute.XXXXXX, the board as it was before routing in its in/; the routed copy keeps the board's own track locks; put.py puts it in place of the open board
# exit: 0 = the run finished (unrouted connections and DRC errors are in the summary, not in the exit code); otherwise the code of the failing stage or docker command, with "autoroute failed (exit N) at stage S" and the tail of run/S.log; 2 = unknown option; 130/143 = interrupted (INT/TERM), the container is removed and the result is lost
set -eu
H="$(cd "$(dirname "$0")" && pwd)"
B="${1:?usage: bash autoroute.sh <board.kicad_pcb> [options]}"; shift
EXP=plugin MINW=on DT=300 FIN=none FT=600 DIAG=off
while [ $# -gt 0 ]; do
  case "$1" in
    --export) EXP=$2; shift ;; --min-width) MINW=$2; shift ;; --draft-time) DT=$2; shift ;;
    --finish) FIN=$2; shift ;; --finish-time) FT=$2; shift ;; --diagnose) DIAG=on ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
P="$(cd "$(dirname "$B")" && pwd)"; N="$(basename "$B" .kicad_pcb)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/autoroute.XXXXXX")"
mkdir "$OUT/in"
cp "$P/$N.kicad_pcb" "$OUT/in/"
[ -f "$P/$N.kicad_pro" ] && cp "$P/$N.kicad_pro" "$OUT/in/"
[ -f "$P/$N.kicad_dru" ] && cp "$P/$N.kicad_dru" "$OUT/in/"
# no bind mounts: the build context goes as a tar stream and files move with docker cp, so the daemon may run on another machine
IMG="$(COPYFILE_DISABLE=1 tar -C "$H" -cf - autoroute.Dockerfile autoroute_run.sh autoroute_board.py | docker build --force-rm -q -t kicad-autoroute -f autoroute.Dockerfile -)"
C="$(docker create "$IMG" bash /opt/autoroute/autoroute_run.sh "$N" "$EXP" "$MINW" "$DT" "$FIN" "$FT" "$DIAG")"
# the container goes on any exit, a kill or Ctrl+C included
trap 'docker rm -f "$C" > /dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker cp -q "$OUT/in" "$C:/work/in"
docker cp -q "$H/geocheck.py" "$C:/work/geocheck.py"
# in the background so that a signal reaches the traps while bash waits
docker start -a "$C" &
wait $! || true
# the container's own exit code: a dropped attach to the docker host is not a stage failure,
# docker wait returns at once when the container has ended and keeps waiting while it still runs
docker wait "$C" > "$OUT/rc" &
wait $!
rc="$(cat "$OUT/rc")"
docker cp -q "$C:/work/out/." "$OUT/"
docker cp -q "$C:/work/run" "$OUT/run"
if [ "$rc" -eq 0 ]; then
  echo "routed copy: $OUT/$N.kicad_pcb   (summary: $OUT/summary.txt, logs: $OUT/run)"
else
  S="$(cat "$OUT/run/stage.txt")"
  echo "autoroute failed (exit $rc) at stage $S; the end of $OUT/run/$S.log:"
  tail -n 15 "$OUT/run/$S.log"
fi
exit "$rc"
