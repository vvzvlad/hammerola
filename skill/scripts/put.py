"""Puts a checked copy of a board in place of the board KiCad has open, and KiCad reads it again from disk; refuses a copy with a footprint the open board lacks (an edit.py fp trial: footprints come from the schematic).
usage: uv run --with 'kicad-python==0.8.0' python put.py <copy.kicad_pcb>   (an edit.py apply output or an autoroute.sh routed copy; overwrites the open board's .kicad_pcb and leaves its project files; KiCad's unsaved edits are dropped, so save_project before taking the copy if the open board was edited; prints the file it overwrote)
needs: kicad-python 0.8.0 and a running KiCad with its IPC API and the board open"""
import os, re, shutil, sys
from kipy import KiCad

copy = sys.argv[1]
board = KiCad().get_board()
live = os.path.join(board.get_project().path, board.name)
refs = set(re.findall(r'\(property\s+"Reference"\s+"([^"]*)"', open(copy).read()))
extra = sorted(refs - {f.reference_field.text.value for f in board.get_footprints()})
if extra:
    sys.exit("put: footprints only in the copy: %s; nothing written" % ", ".join(extra))
shutil.copyfile(copy, live)
board.revert()
print("put %s in place of %s; KiCad read it again" % (copy, live))
