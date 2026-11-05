# Reviews, critics and subagent briefs

## Changes to kicad-review text

DRC errors (Running checks → DRC):

**Every DRC error must be resolved or explicitly justified before manufacturing** —
justified only as in layout-rules.md "DRC errors: fix or prove, never expected".

Severity: these two findings are WARNING, not SUGGESTION.

| Finding                            | Why a Warning                                   |
|------------------------------------|-------------------------------------------------|
| Missing silkscreen designators     | Harder to assemble and debug manually           |
| No board name/revision marking     | No traceability for manufacturing runs          |

## Layout critics (subagents)

- Lenses: power/decoupling, ground/return, analog, mains/isolation, RF/USB,
  geometry/silk/DFM, mechanics (tolerance stack-ups, plug insertion, enclosure
  openings), and assembly data (LCSC/MPN, DNP flags, stock, the assembler's
  part-to-edge rules).
- Every finding needs a severity, evidence measured on the saved file, a failure
  scenario and a fix. The critic tries to refute it before reporting.
- Never list a defect class the owner has complained about under "known, do not
  re-report", and rate such a class at least MAJOR.
- Before passing a finding to the owner, check it against the recorded owner decisions.
- Write each finding to a file as soon as it is seen. A claim such as "all designators
  visible" comes from a script count, not from memory.
- After a topology change (boards merged or split, a bus position changed), give every
  connector, jumper and option part its current reason, and remove those without one.

The lenses with their sources and script hints: `lens-checklist.md`.

## Briefs and fixers

- A brief for placement, routing, silkscreen or zone work tells the agent to load
  `konnect`, `kicad-pcb` and `hammerola`. A critic that is not `kicad-design-review-agent` loads
  `kicad-review`. Name the skills in the brief: subagents do not load them on their own.
- A placement brief gives the functional groups taken from the schematic sheets (which parts
  form each cell and what each cell connects to), not example boards: in OmniLayout
  (arXiv 2607.03261) schematic information improved grouping in all 15 comparisons, example
  layouts in the prompt changed it by −0.006.
- Fix review findings with one agent per board area or MAJOR cluster, MAJORs first. A
  fixer that cannot finish a MAJOR reports it at once instead of spending its budget on
  MINORs.
