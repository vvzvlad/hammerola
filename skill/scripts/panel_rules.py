"""Carries a board's net classes and custom DRC rules over to its KiKit panel in the board's own names: KiKit renames the nets Board_<n>-<name> and the rule areas <name>_1 and copies the classes and rules once per copy under Board_<n>- names, but leaves intersectsArea('<name>') conditions as written, so a rule tied to a rule area matches nothing on the panel; this writes the panel's .kicad_pro with the board's net settings (patterns, and the nets the schematic assigns a class to, as patterns prefixed Board_?-) and the panel's .kicad_dru from the board's (NetName conditions prefixed Board_?-, rule areas matched as <name>*, NetClass conditions as written: the panel keeps the board's class names).
usage: python3 panel_rules.py <board.kicad_pcb> <panel.kicad_pcb>   (reads both .kicad_pro and the board's .kicad_dru before writing anything; the panel's old files go to *.bak; a board without .kicad_dru skips that step with a message; run after every KiKit rebuild, which overwrites the panel's .kicad_pro)
needs: python3"""
# Ported from Wiren Board's kikit_panel_rules.py (wb-agent-tools, wb-panelize skill), under the MIT License:
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
import json
import re
import shutil
import sys
from pathlib import Path

PREFIX = "Board_?-"   # KiCad's wildcard: '?' is the copy number, one digit


def stem(path):
    """The path without .kicad_pcb (Path.with_suffix trips over dots inside the name)."""
    return Path(re.sub(r"\.kicad_pcb$", "", path))


def convert_pro(panel_pro, board_pro):
    """The panel's project with the board's net settings, patterns prefixed Board_?-.

    A class the schematic assigns (netclass_assignments) is looked up by the exact net name, which no panel net has,
    so each assignment becomes a pattern too; KiKit's own per-copy classes (Board_<n>-<class>) go away with the rest
    of the panel's net settings."""
    pro = json.loads(json.dumps(panel_pro))
    ns = json.loads(json.dumps(board_pro["net_settings"]))
    patterns = ns.setdefault("netclass_patterns", [])
    for pat in patterns:
        if not pat["pattern"].startswith(PREFIX):
            pat["pattern"] = PREFIX + pat["pattern"]
    for net, classes in (ns.get("netclass_assignments") or {}).items():
        patterns.extend({"netclass": nc, "pattern": PREFIX + net} for nc in classes)
    ns["netclass_assignments"] = None
    pro["net_settings"] = ns
    return pro


def convert_dru(dru):
    """The board's .kicad_dru for the panel: net names prefixed Board_?-, rule areas matched as <name>*."""
    dru = re.sub(r"intersectsArea\('([^'*]+)'\)", r"intersectsArea('\1*')", dru)
    return re.sub(r"\.NetName\s*([=!]=)\s*'(?!Board_\?-)([^']+)'", r".NetName \1 'Board_?-\2'", dru)


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    src, dst = stem(argv[1]), stem(argv[2])
    src_pro_p, src_dru_p = Path(f"{src}.kicad_pro"), Path(f"{src}.kicad_dru")
    panel_pro_p, panel_dru_p = Path(f"{dst}.kicad_pro"), Path(f"{dst}.kicad_dru")
    # read everything before writing anything
    for p in (src_pro_p, panel_pro_p):
        if not p.exists():
            sys.exit(f"no {p}: both the board's and the panel's .kicad_pro are needed (KiKit writes the panel's)")
    src_pro = json.loads(src_pro_p.read_text(encoding="utf-8"))
    panel_pro = json.loads(panel_pro_p.read_text(encoding="utf-8"))
    dru = src_dru_p.read_text(encoding="utf-8") if src_dru_p.exists() else None
    new_pro = convert_pro(panel_pro, src_pro)
    new_dru = convert_dru(dru) if dru is not None else None
    # write
    shutil.copy(panel_pro_p, Path(f"{panel_pro_p}.bak"))
    panel_pro_p.write_text(json.dumps(new_pro, indent=2, ensure_ascii=False), encoding="utf-8")
    written = [panel_pro_p.name]
    if new_dru is not None:
        if panel_dru_p.exists():
            shutil.copy(panel_dru_p, Path(f"{panel_dru_p}.bak"))
        panel_dru_p.write_text(new_dru, encoding="utf-8")
        written.append(panel_dru_p.name)
    else:
        print(f"the board has no {src_dru_p.name}: no custom DRC rules, the .kicad_dru step is skipped")
    print("written:", " and ".join(written))


if __name__ == "__main__":
    main(sys.argv)
