#!/usr/bin/env python3
"""Take a model's source, compute its geometry, gate it, export the artefacts.

The build half of `cad_publish`, run inside the hub (SPEC 8A.2 step 3); the
client is `hammerola/`, which has no local build path. Nothing here talks to a
network or reads a credential.

What a model.py must define:

    parts()       -> {key: {"shape": Workplane, "kind": "printable"|"hardware"
                            |"mock", "color"?, "note"?}}
    views()       -> [{"id", "name"?, "parts": [<references into parts()>], ...}]
    checks()      optional, and run after the geometry gate

The catalogue is the one place geometry lives, and views reference it: an
entry's key is the part's identity everywhere -- the file stem, the label in
the tree, the key in meta.json.

`import checklib` is the fourth part of that contract, a top-level name rather
than something under this package -- see checklib.py at the repository root.

Imported only by `src/buildproc/child.py`, inside the isolated build process.
Nothing on the serving side imports it.

Kept short on purpose: importing this must not import cadquery, matplotlib or
anything else heavy. Every CAD import inside the modules is made inside the
function that needs it.
"""

__all__ = ["BuildError"]

from .errors import BuildError
