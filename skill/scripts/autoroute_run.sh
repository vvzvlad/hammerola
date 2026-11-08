#!/bin/bash
# usage: bash autoroute_run.sh <name> <plain|plugin> <on|off> <draft_s> <none|freerouting> <finish_s> <diagnose on|off>   (inside the autoroute image: /work/in/<name>.kicad_pcb with .kicad_pro/.kicad_dru -> lock -> DSN -> fastroute draft -> finish -> SES import -> DRC with refill, geocheck.py, summary; routed copy in /work/out, logs in /work/run)
# needs: the autoroute image (autoroute.Dockerfile), /work/geocheck.py
# each stage S writes /work/run/S.log; /work/run/stage.txt names the stage that ran last; exit code = that of the failing command
set -euo pipefail  # a failed command must not hide behind tee
N=$1 EXP=$2 MINW=$3 DT=$4 FIN=$5 FT=$6 DIAG=$7
H=/opt/autoroute I=/work/in O=/work/out R=/work/run
B="$O/$N.kicad_pcb"
mkdir -p "$O" "$R"

prep() {
  {
    cp "$I"/* "$O/"
    python3 "$H/autoroute_board.py" lock "$B" "$R/locked.txt"
    python3 "$H/autoroute_board.py" dsn "$B" "$R/draft.dsn" "$EXP" "$MINW" > "$R/fastroute.args"
  } 2>&1 | tee "$R/prep.log"
}
draft() {
  # fastroute writes its best board on --max-time; the diagnosis (single-threaded, minutes on a big board) runs after it
  fastroute -de "$R/draft.dsn" -do "$R/draft.ses" --max-time="$DT" --report="$R/draft.json" \
    $([ "$DIAG" = on ] && echo --diagnose) $(cat "$R/fastroute.args") > "$R/draft.log" 2>&1
  tail -2 "$R/draft.log"
}
finish() {
  {
    case "$FIN" in
      none)
        cp "$R/draft.ses" "$R/final.ses"
        echo "none" > "$R/finish.txt" ;;
      freerouting)
        # Freerouting takes no session: the draft goes in as unlocked wiring of a fresh DSN
        mkdir -p "$R/draft_board"
        cp "$O/$N".kicad_* "$R/draft_board/"
        python3 "$H/autoroute_board.py" ses "$B" "$R/draft.ses" "$R/draft_board/$N.kicad_pcb"
        python3 "$H/autoroute_board.py" dsn "$R/draft_board/$N.kicad_pcb" "$R/finish.dsn" "$EXP" "$MINW" > /dev/null
        # job_timeout ends the autorouter at a pass boundary and still writes the session
        java -jar /opt/freerouting.jar --gui.enabled=false -da --router.fanout.enabled=false \
          --router.job_timeout="$(printf '%02d:%02d:%02d' $((FT / 3600)) $((FT % 3600 / 60)) $((FT % 60)))" \
          -de "$R/finish.dsn" -do "$R/final.ses"
        echo "$(grep -o -m1 'Freerouting v[0-9.]*' "$R/finish.log"), --router.job_timeout=$FT s" > "$R/finish.txt" ;;
    esac
  } > "$R/finish.log" 2>&1
}
import() {
  python3 "$H/autoroute_board.py" ses "$B" "$R/final.ses" "$B" "$R/locked.txt" 2>&1 | tee "$R/import.log"
}
check() {
  kicad-cli pcb drc --format json --severity-all --refill-zones --save-board -o "$R/drc.json" "$B" > "$R/check.log" 2>&1
  python3 /work/geocheck.py "$B" "$R/geo.json" > "$R/geo.log" 2>&1 || true  # exit 1 means findings; a crash leaves no geo.json
}
summary() {
  python3 "$H/autoroute_board.py" summary "$R" "$B" 2>&1 | tee "$O/summary.txt" "$R/summary.log"
}

for s in prep draft finish import check summary; do
  echo "== $s"
  echo "$s" > "$R/stage.txt"
  t0=$(date +%s%N)
  $s
  echo "$s $(( ($(date +%s%N) - t0) / 1000000 ))" >> "$R/times.txt"
done
