# Agent Instructions

This project is a CAD model. `model.py` is the whole of it: the geometry is
written as code, and a hammerola hub builds it in its own image and serves the
result as a browser viewer with STL/STEP/3MF downloads. Nothing is built here,
so this machine needs no CAD kernel.

**The working discipline lives in the `hammerola` skill, not in this file.**
The client's commands, what to measure before drawing anything, how to read a
failed build, and every rule that keeps a part from being printed wrong are
there. Read it before touching `model.py`; do not restate it here.

## The three entry points

Everything the hub asks of this directory is these three functions, and
`model.py` documents each of them where it defines it:

- `parts()` — the catalogue: every part of the model under the name it is known
  by, and the one place its geometry lives.
- `views()` — what the browser shows, one entry per tab, each a list of
  REFERENCES into the catalogue.
- `checks()` — optional, and the only place this project's own rules live: what
  a review or a printed part taught you, one assert per lesson.

`ref/measurements.md` is the other half of the parameter block: every number
written as `checklib.measured(...)` names a heading in it, and the build refuses
a source that points at no such heading.
