#!/bin/bash
# usage: bash gerbers.sh <board.kicad_pcb> <outdir> [--panel|--single] [--vcuts] [--force]   (Gerbers with the job file and Excellon drills, mm, decimal, PTH and NPTH apart, from the plot settings saved in the board, the same way for a board and its KiKit panel, which inherits them; names <board>-<layer>.<ext>, <board>-PTH.drl, <board>-NPTH.drl, as gerber_diff.py reads them; lists the files written)
# needs: bash, kicad-cli of KiCad 8+ (KICAD_CLI overrides; else the macOS app's, else the one on PATH); KiCad 10's 'assert "m_choices...' lines on stderr are noise and are dropped
# exit: 0 = written (no non-plated hole on a board, or on a panel with --vcuts, is a note); 1 = no kicad-cli, a failed kicad-cli export, no job file (the board's plot settings have it off), no PTH drill, or --panel without --vcuts and no hole in the NPTH drill (mouse bites missing; kicad-cli writes the file even without a hole); 2 = bad arguments, no board, or a non-empty outdir without --force
# Ported from Wiren Board's gerbers-kicad.sh (wb-agent-tools, wb-panelize skill), under the MIT License:
#
# Copyright (c) 2026 Wiren Board
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
set -euo pipefail
PCB=${1:?board.kicad_pcb}; OUT=${2:?outdir}; shift 2
MODE=single; VCUTS=; FORCE=
while [ $# -gt 0 ]; do case "$1" in
  --panel) MODE=panel; shift;; --single) MODE=single; shift;; --vcuts) VCUTS=1; shift;; --force) FORCE=1; shift;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done
[ -f "$PCB" ] || { echo "no file $PCB" >&2; exit 2; }
CLI="${KICAD_CLI:-/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli}"
[ -x "$CLI" ] || CLI=kicad-cli
command -v "$CLI" >/dev/null || { echo "no kicad-cli (KiCad 8+)" >&2; exit 1; }
if [ -d "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ] && [ -z "$FORCE" ]; then echo "$OUT is not empty (overwrite only with --force)" >&2; exit 2; fi
mkdir -p "$OUT"
run_cli() {
  # kicad-cli's own status is the verdict (with --force the old files would otherwise pass the checks below); the grep
  # only drops the assert noise, and its own status (1 when every line was noise) must not count
  local rc
  "$CLI" "$@" 2>&1 | grep -v 'assert "m_choices' && rc=0 || rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || { echo "kicad-cli $1 $2 $3 failed (exit $rc)" >&2; exit 1; }
}
run_cli pcb export gerbers --board-plot-params -o "$OUT/" "$PCB"
run_cli pcb export drill --excellon-separate-th -o "$OUT/" "$PCB"
ls "$OUT"/*.gbrjob >/dev/null 2>&1 || { echo "no job file: the board's plot settings have «Generate Gerber job file» off — turn it on, gerber_diff.py takes the layers from it" >&2; exit 1; }
ls "$OUT"/*-PTH.drl >/dev/null 2>&1 || { echo "no PTH.drl" >&2; exit 1; }
# kicad-cli writes NPTH.drl even without a hole: a tool definition (T1C0.600) means there is one
if ! grep -qs '^T[0-9][0-9]*C' "$OUT"/*-NPTH.drl; then
  if [ "$MODE" = panel ] && [ -z "$VCUTS" ]; then echo "the panel's NPTH drill has no holes: the mouse bites did not reach the drill file (for V-cuts pass --vcuts)" >&2; exit 1; fi
  echo "  no holes in NPTH.drl: no non-plated holes${VCUTS:+ (V-cut, as expected)}"
fi
( cd "$OUT" && ls -1 )
