# Modelling in SolidCraft

Read when the owner asks for the part to be modelled in SolidCraft, or the
project already holds a `.solidcraft` design. The part is built in SolidCraft
through its MCP server; the hub builds from the STEP files exported from it,
with the same gates, viewer and downloads as a model written in CadQuery.

## The server

The MCP server is `solidcraft` (`solidcraft-cli mcp`). With the SolidCraft app
open on the same machine it drives that window and the owner watches the part
being built; with none open it models headless. Its instructions end with
`Backend: connected to the SolidCraft app` or `Backend: headless`.

Before the first command call `skill_reference {"skill": "solidcraft-modeling"}`
(to change an existing design, also `{"skill": "solidcraft-editing", "file":
"SKILL.md"}`): SolidCraft's own rules for building in a few `batch` calls and
checking each stage with `measure`.

No `solidcraft` among your tools: set the machine up once, then start a new
session.

```sh
claude mcp add -s user solidcraft -- /Applications/SolidCraft.app/Contents/MacOS/solidcraft-cli mcp --allow-any-path
```

On Linux the deb and rpm packages put `solidcraft-cli` in `/usr/bin`. Without
`--allow-any-path` the server refuses to save or export into the project's
directory (`outside the folders this agent may use`).

## The files

```text
plate.solidcraft   # the design: parameters and feature history, opened in SolidCraft
plate.step         # one STEP per catalogue record, exported from it: what the hub reads
model.py           # loads the STEP files
project.json
```

**Export after every change, and commit both files.** The hub reads the STEP
and nothing else: a design saved without a fresh export publishes the previous
part, green. `save {"path": "<abs>/plate.solidcraft"}`, then
`export {"path": "<abs>/plate.step", "bodies": ["Body1"]}`; `measure` names the
bodies, and paths are absolute.

**One body, one STEP, one record.** A `printable` is one fused body
(`references/model-py.md`), so each body is exported on its own with `bodies`
and gets its own record; so do `hardware` and `mock` bodies.

**`model.py` only loads them.** The catalogue key, not SolidCraft's body name,
is the part's identity:

```python
"""Plate modelled in SolidCraft (plate.solidcraft); the hub builds from its STEP export."""
import cadquery as cq


def parts():
    return {"plate": {"shape": cq.importers.importStep("plate.step"), "kind": "printable"}}


def views():
    return [{"id": "assembled", "name": "Assembled", "parts": ["plate"]}]
```

The path is relative to the project's directory, where the build runs. The
rest of `references/model-py.md` holds for a loaded shape as for any other:
record types, `views` with `at`, the `print` bed, `checks()` and `checklib`.
Build the part in SolidCraft in the orientation it is printed in
(`references/printing.md`): `print` may only move it and turn it about Z.
