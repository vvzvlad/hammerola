#!/bin/bash
# usage: ready.sh <board.kicad_pcb>   (board-readiness gate: drc.sh -> geocheck.py -> inv.py -> probe-bench's probe.py check on a copy; the project is not modified)
# needs: bash, python3, kicad-cli (KICAD_CLI) and KiCad's bundled Python with pcbnew (KICAD_PY overrides the macOS path)
# exit 1 if DRC has an error, a dangling track or via, or an unconnected item, geocheck.py finds anything, a fitted footprint is neither SMD nor THT, or probe.py finds a contract violation
set -u
H="$(cd "$(dirname "$0")" && pwd)"
PY="${KICAD_PY:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3}"
B="${1:?usage: ready.sh <board.kicad_pcb>}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/ready.XXXXXX")"
C="$OUT/$(basename "$B")"
fail=0
echo "== DRC"
bash "$H/drc.sh" "$B" - "$OUT" || fail=1
echo "== track geometry (findings: $OUT/geo.json)"
"$PY" "$H/geocheck.py" "$C" "$OUT/geo.json" || fail=1
echo "== footprints (full list: $OUT/inv.txt)"
"$PY" "$H/inv.py" "$C" > "$OUT/inv.txt" || fail=1
grep -E '^(visible refs|mounting|unspec fitted)' "$OUT/inv.txt"
echo "== probe contract"
"$PY" "$H/../../probe-bench/scripts/probe.py" check "$C" || fail=1
if [ "$fail" -eq 0 ]; then echo "== ready.sh: PASS"; else echo "== ready.sh: FAIL"; fi
exit "$fail"
