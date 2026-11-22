"""The editor's chunk takes nothing from the entry.

`ui/src/editor/` is built into a file of its own, `static/_v/hammerola-editor.js`,
which the Files window imports the first time it opens a text file
(ui/vite.config.mjs). A module the entry holds too would reach the chunk through
the entry's minified export names, so a tab opened before a deploy would load the
new chunk against its old entry. So the folder imports CodeMirror, Lezer and its
own files, and nothing else. Read as text, like tests/test_ui_source.py: the
suite does not build the bundle.
"""

import re
from pathlib import Path

from test_ui_source import read, strip_comments

ROOT = Path(__file__).resolve().parent.parent
EDITOR = ROOT / "ui" / "src" / "editor"

# What a module names it imports from: `from '…'` (an import or a re-export)
# and `import '…'` / `import('…')`.
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]""")
PACKAGES = ("@codemirror/", "@lezer/")


def test_the_editor_folder_imports_only_codemirror_lezer_and_itself():
    modules = sorted(p for p in EDITOR.rglob("*.js*") if p.is_file())
    assert EDITOR / "editor.js" in modules, "ui/src/editor/editor.js, the chunk's entry, is gone"
    strays = {}
    for path in modules:
        for name in SPECIFIER.findall(strip_comments(read(path))):
            inside = name.startswith(".") and (path.parent / name).resolve().is_relative_to(EDITOR)
            if not (name.startswith(PACKAGES) or inside):
                strays.setdefault(str(path.relative_to(EDITOR)), []).append(name)
    assert not strays, (
        f"the editor's folder imports {strays}: only @codemirror/*, @lezer/* and its own "
        f"files may be imported there, or the chunk shares a module with the entry")
