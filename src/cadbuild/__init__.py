#!/usr/bin/env python3
"""Take a model's source, compute its geometry, gate it, export the artefacts.

This is the build half of `cad_publish`, moved into the hub (SPEC 8A.2 step 3).
It used to run on a laptop and on a build node, push a finished `_out/` over
HTTP, and the hub only stored what arrived. Now the hub holds the CAD kernel,
so it holds this too, and the client side of that package -- the CLI, the
settings, the HTTP push, the build-node machinery, the local preview server --
stayed behind. Nothing here talks to a network or reads a credential.

What a model.py must define is unchanged and will stay unchanged: nine projects
are written against it.

    views()       -> [{"id", "name", "parts": [{"shape", "name", ...}], ...}]
    printables()  -> {name: Workplane}
    checks()      optional, and run after the geometry gate

`import checklib` is the fourth part of that contract, and it is a top-level
name rather than something under this package for exactly that reason -- see
checklib.py at the repository root.

NOT WIRED INTO THE SERVICE YET, on purpose. Running a model is step 4 (a
separate process, spawned, with rlimits and a deadline) and the gate firing on
the receiving side is step 6. Until those land, nothing under src/ imports this
package.

Kept short on purpose: importing this must not import cadquery, matplotlib or
anything else heavy. Every CAD import inside the modules is made inside the
function that needs it.
"""

__all__ = ["BuildError"]

from .errors import BuildError
