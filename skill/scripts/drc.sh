#!/bin/bash
# usage: drc.sh <board.kicad_pcb> [extra.dru|-] [out_dir]   (DRC with zone refill on a copy; extra rules are appended to the copy's .kicad_dru)
# needs: bash, kicad-cli (KICAD_CLI overrides the macOS path), python3 for the summary; SAVE=--save-board keeps the refilled copy
# exit 1 on any error-severity violation, dangling track or via, or unconnected item; the full report is <out_dir>/drc.json
# the board is compared with <name>.kicad_sch when it lies beside the board; parity findings are printed, not in the exit code
set -eu
B="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
X="${2:--}"
OUT="${3:-$(mktemp -d "${TMPDIR:-/tmp}/drc.XXXXXX")}"
CLI="${KICAD_CLI:-/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli}"
TPL="${KICAD_TEMPLATE_DIR:-/Applications/KiCad/KiCad.app/Contents/SharedSupport/template}"
P="$(dirname "$B")"; N="$(basename "$B" .kicad_pcb)"
mkdir -p "$OUT"
# kicad-cli loads <name>.kicad_pro / <name>.kicad_dru only next to <name>.kicad_pcb
cp "$B" "$OUT/$N.kicad_pcb"
[ -f "$P/$N.kicad_pro" ] && cp "$P/$N.kicad_pro" "$OUT/"
[ -f "$P/$N.kicad_dru" ] && cp "$P/$N.kicad_dru" "$OUT/"
if [ "$X" != "-" ]; then
  [ -f "$OUT/$N.kicad_dru" ] || echo "(version 1)" > "$OUT/$N.kicad_dru"
  cat "$X" >> "$OUT/$N.kicad_dru"
fi
# schematics and project library tables are copied, library and model folders linked
for f in "$P"/*.kicad_sch "$P"/*-lib-table "$P"/*.kicad_sym; do [ -e "$f" ] && cp "$f" "$OUT/"; done
for d in "$P"/*/; do d="${d%/}"; [ -d "$d" ] || continue; [ -e "$OUT/$(basename "$d")" ] || ln -s "$d" "$OUT/$(basename "$d")"; done
# private KiCad config with the stock global lib tables (copperpour-gaps.md, Session and connection)
V="$("$CLI" version | cut -d. -f1-2)"
mkdir -p "$OUT/cfg/$V"
for t in sym-lib-table fp-lib-table; do [ -f "$TPL/$t" ] && cp "$TPL/$t" "$OUT/cfg/$V/"; done
rm -f "$OUT/drc.json"
# the board is compared with its schematic only when the schematic lies beside it
PAR=""; [ -f "$P/$N.kicad_sch" ] && PAR=--schematic-parity
KICAD_CONFIG_HOME="$OUT/cfg" "$CLI" pcb drc --format json --severity-all --refill-zones $PAR ${SAVE:-} \
  -o "$OUT/drc.json" "$OUT/$N.kicad_pcb" > "$OUT/drc.log" 2>&1 || true
[ -s "$OUT/drc.json" ] || { echo "kicad-cli wrote no report:"; tail -5 "$OUT/drc.log"; exit 2; }
# kicad-cli logs a parity check it could not run ("... parity tests ...") and still writes the report (JobExportDrc)
[ -n "$PAR" ] && grep -q "parity tests" "$OUT/drc.log" && PAR=failed
echo "copy: $OUT/$N.kicad_pcb"
python3 - "$OUT/drc.json" "$PAR" "$N" <<'EOF'
import json, sys, collections
d = json.load(open(sys.argv[1]))
v, u, sp = d.get("violations", []), d.get("unconnected_items", []), d.get("schematic_parity", [])
err = sum(1 for x in v if x["severity"] == "error")
# dangling tracks and vias are warnings in KiCad but fail the gate (PCBWorld counts them as errors)
dang = sum(1 for x in v if x["severity"] != "error" and x["type"] in ("track_dangling", "via_dangling"))
parity = {"": "not checked (no %s.kicad_sch beside the board)" % sys.argv[3],
          "failed": "not checked (kicad-cli could not compare with the schematic, see drc.log)"}
print("violations:", len(v), "errors:", err, "dangling:", dang, "unconnected:", len(u),
      "parity:", parity.get(sys.argv[2], len(sp)))
for k, n in sorted(collections.Counter((x["severity"], x["type"]) for x in v).items()):
    print("  %-8s %-32s %d" % (k[0], k[1], n))
for k, n in sorted(collections.Counter(x["type"] for x in sp).items()):
    print("  parity %-32s %d" % (k, n))
sys.exit(1 if err or dang or u else 0)
EOF
