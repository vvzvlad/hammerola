#!/usr/bin/env python3
"""Take a model's source, compute its geometry, gate it, export the artefacts.

This is the build half of `cad_publish`, moved into the hub (SPEC 8A.2 step 3).
It used to run on a laptop and on a build node, push a finished `_out/` over
HTTP, and the hub only stored what arrived. Now the hub holds the CAD kernel,
so it holds this too, and the client side of that package -- the CLI, the
settings, the HTTP push, the local preview server -- stayed behind. The
build-node machinery stayed behind too, and it is not a half of anything any
more: with the hub building, there is no build node left for it to drive, and
step 7 -- closed -- retired it outright, replacing the whole client with
`hammerola/`, which has no local build path at all. Nothing here talks to a
network or reads a credential.

What a model.py must define:

    parts()       -> {key: {"shape": Workplane, "kind": "printable"|"hardware"
                            |"mock", "color"?, "note"?}}
    views()       -> [{"id", "name"?, "parts": [<references into parts()>], ...}]
    checks()      optional, and run after the geometry gate

THE CATALOGUE IS THE ONE PLACE GEOMETRY LIVES, and a view references it: the key
of an entry is the part's identity everywhere -- the file stem, the label in the
tree, the key in meta.json. It replaced a contract where views() carried shapes
of its own beside a separate printables() dict, and everything downstream had to
work out which shape in one was which entry in the other. Two ways of getting
that wrong were visible in published builds: a part renamed in a view lost its
own downloads, and a decoy solid answered for a real part in the coverage gate.

`import checklib` is the fourth part of that contract, and it is a top-level
name rather than something under this package for exactly that reason -- see
checklib.py at the repository root.

WIRED INTO THE SERVICE SINCE STEP 4, and only from one side. What imports this
package is `src/buildproc/child.py`, INSIDE the build process -- spawned, with
rlimits and a deadline -- and step 5 put that process on the push path. Nothing
on the SERVING side imports it, and that is still deliberate: the gate fires on
the receiving side -- step 6, closed.

Kept short on purpose: importing this must not import cadquery, matplotlib or
anything else heavy. Every CAD import inside the modules is made inside the
function that needs it.
"""

__all__ = ["BuildError"]

from .errors import BuildError
