#!/bin/bash
# usage: step.sh <in.kicad_pcb> <cand.json> <tag>   (one stitching step: add the vias of cand.json, refill + DRC, dump, measure)
# needs: bash, python3, KiCad's Python (KICAD_PY) and, in the current directory, the helpers edit.py, drccmp.py, gdump.py,
#        measure.py and venv/ (not part of this skill), plus work/ and a baseline report drc/base0/drc.json
set -e
H="$(cd "$(dirname "$0")" && pwd)"
PY="${KICAD_PY:-/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3}"
python3 -c "
import json,sys; c=json.load(open('$2'))
ops=[dict(op='addvia',at=[v['x'],v['y']],net=v.get('net',c.get('net'))) for v in c['vias']]
json.dump(ops,open('work/ops_$3.json','w')); print('ops',len(ops))
"
$PY edit.py "$1" work/ops_$3.json work/$3.kicad_pcb 2>&1 | grep -v "^op \|assert" | tail -5
SAVE=--save-board bash "$H/drc.sh" work/$3.kicad_pcb - drc/$3 | grep -v lib_footprint
python3 drccmp.py drc/base0/drc.json drc/$3/drc.json
$PY gdump.py drc/$3/$3.kicad_pcb work/g_$3.json 2>&1 | grep -v assert
venv/bin/python measure.py work/g_$3.json work/m_$3.json | grep -v "^    piece"
