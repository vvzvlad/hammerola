# Strength, heat, flow and fit: computed on your machine

Read when the person asks whether a part holds a load, where it bends, at what
frequency it rings, how hot it or a board gets, how air or water flows through
it, whether a trace carries its current, whether a snap-fit snaps, or whether
a board fits its enclosure.

The hub computes none of this. These analyses run where you work, on the STEP
the build publishes and on the KiCad project, with open tools you install
there. Each section below names the cheapest method first; the next one is
worth running only when the cheaper one cannot answer.

## The tools

- **Mesh**: Gmsh (4.15.2 in Homebrew and sid, 4.13.1 in Debian 13, or
  `pip install gmsh`), tetrahedra, finer where the stress or the flow
  concentrates.
  It writes `.inp` for CalculiX and `msh2` for Elmer.
- **CalculiX** (`ccx`, Abaqus-style `.inp` input) for solids: static stress
  and displacement, natural frequencies and mode shapes, buckling, heat
  conduction steady or transient, thermal stress — and beyond the linear
  case, orthotropic materials, contact, large deflection (`NLGEOM`) and creep.
  Debian 12 has 2.20, Debian 13 has no `calculix-ccx`, sid has 2.23; on macOS
  it comes from conda-forge (`calculix`), Homebrew has none.
- **Elmer** for heat and for current in copper with its Joule heating. Not in
  Debian or conda-forge: the Ubuntu PPA `ppa:elmer-csc-ubuntu/elmer-csc-ppa`
  (`elmerfem-csc`), or `brew tap elmercsc/homebrew-elmerfem` and
  `brew install elmer --HEAD`.
- **OpenFOAM** for fluids. The two distributions name the solvers
  differently:

  | Case | ESI (openfoam.com, v2606) | Foundation (openfoam.org, v11 and later) |
  |---|---|---|
  | Incompressible, steady / transient | `simpleFoam` / `pimpleFoam` | `foamRun -solver incompressibleFluid` |
  | Heat between a fluid and solids | `chtMultiRegionSimpleFoam` | `foamMultiRun` with `fluid` and `solid` |
  | Compressible gas | `rhoCentralFoam` | the `shockFluid` module |

  Debian's own package is ESI 1912 from 2019; take the current ESI from its
  apt repository, or run it in Docker. The space the fluid fills is
  modelled as a body of its own — the inside of a channel, or a box round the
  part with the part cut out — and exported as its own STEP.
- **ngspice** for what a circuit dissipates (below).

## What a result is worth

- Start linear: one material with constant properties, one load case, small
  deflections. Contact, large deflection and creep are the solver's, but each
  needs data and a check of its own; use them when the question needs them (a
  snap-fit is large deflection and contact) and say so. No fatigue.
- Supports must stop all six rigid-body motions, or a static solve has no
  answer.
- Check the solve before quoting it: reactions balance the applied load,
  heat in equals heat out, mass in equals mass out. Halve the mesh size and
  compare before trusting a peak.
- A printed part is weaker across its layers than along them; an isotropic
  material hides that. Say which strength you used and in which direction
  (numbers under "Printed parts").
- Say how far the number is from the part: an analysis is an estimate, not a
  measurement.

## A board: how hot the parts and the copper get

The point is comparing layouts — more copper, more vias, another layer — and
finding the hot spots; the absolute temperature stays an estimate. KiCad has
no thermal solver, so it is a ladder, each step checked by the one before.

**1. A hand network of thermal resistances — always first, minutes.**
Tj ≈ Ta + P·(θJB or θJC + R of the vias + R of spreading + 1/(h·A)).

- θJA from a datasheet was measured on a JEDEC test board and does not carry
  over to this one: in still air 70–95 % of the heat leaves through the
  board, and the layout decides it (TI SPRA953C).
- The die temperature from a measured package top goes through ΨJT, not θJC.
- In a 3D model a package is the JEDEC two-resistor model: die, top and board
  nodes joined by θJC and θJB (JESD15-3).
- Electrically isolated copper — traces running across the heat flow —
  barely conducts. Smearing its conductivity over the volume errs by an order
  of magnitude; count solid layers and pours only.
- Radiation is as large as convection on a small board: leaving it out
  overstates the temperature.

Reference values (R = L/(k·A), copper k = 385 W/(m·K)):

| What | Value |
|---|---|
| Via 0.3 mm, 25 µm plating, 1.6 mm board | 192 K/W; 16 in parallel 12 K/W |
| The same with 20 µm plating | 236 K/W |
| FR4 1.6 mm under a 1 cm² pad | 53–64 K/W (k = 0.30–0.25) |
| Two layers 1/1 oz, solid copper: k in plane / through | 17.3 / 0.26 W/(m·K) |
| Four layers 1/0.5/0.5/1 oz (JLCPCB's default inner 0.5 oz) | 25.7 / 0.27 W/(m·K) |
| 50×50 mm board, ΔT 30 K, convection plus radiation (ε 0.9) | h ≈ 13 W/(m²·K): at least ~15 K per watt even for an isothermal board |

A horizontal board that small sits below the range of the convection
correlations (Ra ≈ 4.5·10³ against 10⁴ and up), so its h is extrapolated; a
vertical one is inside the range.

**2. 2.5D on the real copper: the ThermalSim plugin**
([KiCad_Thermal_Sim](https://github.com/PoeAlex/KiCad_Thermal_Sim), MIT).
Conduction in each copper layer from a raster of its tracks, pads, vias and
pours, coupled through the FR4 and the vias; power set on pads, constant or
as a PWL profile; one h on each side (10 by default). Its current mode gives
the effective resistance, the voltage drop and the loss map of a net. It does
not model packages, radiation, uneven airflow, AC and skin effect, or copper
resistance rising with temperature.

- Headless: `THERMALSIM_HEADLESS=1` and `pcbnew.LoadBoard()`; its
  `benchmark_real_board.py` is the example.
- It needs numpy and scipy in the Python that imports `pcbnew`. On macOS that
  is the KiCad.app bundle's own Python, which ships without them.
- Refine the grid (0.5 mm, then 0.3 mm) until the peak stops moving.

**3. 3D FEM: Gmsh with CalculiX or Elmer.** Two ways to model the board:

- *Homogenized*: an orthotropic plate with its in-plane and through
  conductivity per zone, vias smeared into a higher through conductivity
  under their pad, packages as two-resistor blocks. Cheap mesh.
- *Hybrid*: explicit copper, vias and solder near the sources, orthotropic
  far from them. Fully explicit 35 µm copper is too big: a 100×100 mm,
  six-layer board at 0.25 mm comes to about 10⁶ nodes.

The steps:

1. Powers per part: datasheets, or ngspice (below).
2. Geometry. `kicad-cli pcb export step --board-only` gives the board body;
   `kicad-cli pcb export xao` (or `step`) with `--no-components
   --include-tracks --include-pads --include-zones --include-inner-copper
   --fuse-shapes` gives the copper, `--net-filter` one net of it; part
   positions from `kicad-cli pcb export pos`.
3. Gmsh: import the STEP through OCC, `BooleanFragments` for one conformal
   mesh, Physical groups for materials and boundaries.
4. CalculiX: `*CONDUCTIVITY, TYPE=ORTHO` for the board,
   `*HEAT TRANSFER, STEADY STATE`, `*FILM` for convection, `*DFLUX` for the
   heat on a pad or package face, `*RADIATE` for radiation.
   Elmer: `ElmerGrid 14 2 board.msh -autoclean`, with
   `-scale 0.001 0.001 0.001` when the mesh is in mm; a boundary is
   `Heat Transfer Coefficient` plus `External Temperature`, radiation
   `Idealized`. **Elmer's `Heat Source` is per unit mass, not volume** — put
   the power in as a `Heat Flux` on a face.
5. Boundaries: h on the top and the bottom separately, ε ≈ 0.9 for solder
   mask; standoffs left out (conservative). Inside an enclosure Ta is the air
   in it (next section), not the room.

Pipelines to copy from, not depend on:
[pcb-thermal-lab](https://github.com/gerhardmalberg/pcb-thermal-lab)
(Apache-2.0: kicad-cli → Gmsh → Elmer in containers, the hybrid model, h swept
over 5/10/20/50, a result taken only below 1 % heat imbalance) and
[KiPIDA](https://github.com/kbralten/KiPIDA) (AGPL-3.0: voltage drop, current
density and heating inside KiCad 9 and later, through its IPC API).

**4. The board with the air round it: OpenFOAM**, heat between fluid and
solids — Foundation's `foamMultiRun` has the tutorial
`multiRegion/CHT/circuitBoardCooling` with the board as a baffle; ESI's is
`chtMultiRegionSimpleFoam`. Only when vents, a fan or layered air matter.

Checking the answer:

- Heat balance: what leaves equals the power put in, within 1 %.
- Halve the mesh and compare the peak.
- Run h = 5, 10 and 20 W/(m²·K). If the answer moves by more than the
  margin, the air has to be computed (step 4).
- Model the package on the JESD51-7 test board (76.2×114.3 mm, 1.6 mm, two
  inner 1 oz planes) and compare with the datasheet's θJA.
- The hand network and the model within a factor of 2, or look for the
  error.
- On the hardware: a thermocouple, or a thermal camera on a strip of
  electrical tape (ε 0.95; it reads ±2 °C or 2 %, and cannot read bare copper
  or anything else under ε 0.6); the die through ΨJT from the package top.

No published comparison of a KiCad → Elmer model with measurements was found:
the hardware check is the one that settles it.

## An enclosure: how hot the air inside gets

The air temperature is the Ta of the board inside, and it says whether the
printed enclosure itself survives.

ΔT of the air = P / (k·A), with A the faces exposed to the room
(IEC 60890): k ≈ 5.5 W/(m²·K) for painted steel (Rittal), about 3.5 for
plastic (secondary sources only).

Example: 2 W in a closed PETG box of 100×60×30 mm warms its air by 26 K by
the k = 3.5 rule, and by 28–56 K computed through a 2 mm wall with h inside
from 5 down to 2 W/(m²·K). Prusament PETG's heat deflection temperature
(0.45 MPa) is
68 °C, so in a 25 °C room that box is at the material's limit and the board
runs hotter than the air.

Vents or a fan: OpenFOAM, the air as its own body. Neither method shows the
layered air or the hot spot on a wall over a hot part; that takes the CFD.

## Current in copper

- KiCad's PCB Calculator sizes a track by IPC-2221
  (I = k·ΔT^0.44·A^0.725), noticeably more conservative than IPC-2152.
  IPC-2152 is a paid standard; open calculators approximate it.
  [twc](https://github.com/ymich9963/twc) (GPL-3.0, built from source)
  computes both, with corrections for a nearby plane, the board thickness and
  its conductivity.
- On the real copper: ThermalSim's current mode, KiPIDA, or Elmer's
  StatCurrentSolver — the XAO of one net (`--net-filter`), a potential at
  the source, a current density I/S at the sink, Calculate Joule Heating on.
  The losses are a power for the board's heat.
- Check: the effective resistance against ρL/(w·t) on one plain track, the
  currents of sources and sinks summing to zero, a halved mesh.

## What each part dissipates: ngspice

`kicad-cli sch export netlist --format spice -o board.cir board.kicad_sch`,
then `ngspice -b -r board.raw board.cir`; the models come from the symbols'
`Sim.*` fields. KiCad's macOS app carries the ngspice library; the command
line is `brew install ngspice` (47), or Debian's `ngspice` (44.2 in trixie,
47 in trixie-backports). It does not see the layout's parasitics or the heat
between parts.

## Printed parts: snap-fits, layers, inserts

**Snap-fits** (Covestro, "Snap-Fit Joints for Plastics"), a cantilever of
length l, width b and thickness h at the root:

- deflection y = 0.67·ε·l²/h at constant section, y = 1.09·ε·l²/h tapered to
  h/2 at the tip;
- force to deflect it P = b·h²·Es·ε/(6l), Es the secant modulus;
- force to push it home W = P·(µ + tan α)/(1 − µ·tan α), α the lead-in
  angle;
- allowable strain ε for an amorphous plastic (PETG is taken as one): about
  70 % of the yield strain for a one-time assembly, 60 % of that for one
  taken apart often.

PETG's yield strain (Prusament TDS v1.0) is 5.1 % bending in the layer plane
and 2.5 % across the layers. An arm 15 mm long and 1.5 mm thick then
deflects 3.6 mm (5.8 mm tapered) in the layer plane and 1.8 mm (2.9 mm
tapered) across the layers, for a one-time assembly. Computing a snap-fit in
CalculiX is large deflection and contact: `NLGEOM`, `*CONTACT PAIR`.

**Layers.** Prusament PETG's yield strength:

| Source | Horizontal / vertical in XY / along Z | Modulus |
|---|---|---|
| TDS v1.0 (2018) | 47 ± 2 / 50 ± 1 / 30 ± 5 MPa | 1.5 / 1.5 / 1.4 GPa |
| TDS v1.1 (2022) | no Z specimens; interlayer adhesion 18 ± 4 MPa | — |

The two editions disagree across the layers (30 against 18): name the one
used. Orthotropic stiffness in CalculiX is
`*ELASTIC, TYPE=ENGINEERING CONSTANTS`; strength per direction is checked by
hand against the stresses.

**Heat-set inserts** (CNC Kitchen, brass M3 in PLA, about 50 pulls): about
1400 N to pull one out; a 4.0 mm nominal hole wants 4.2 mm in CAD, his rule is
+0.2…0.3 mm — the same as the hole shrinkage in `printing.md`.

**Creep**: CalculiX has Norton's law (`*CREEP`), but there are no open
constants for printed PETG; a part under constant load is tested as a sample.
Warping and the life of a printed living hinge have no open method either —
print a sample.

## Tolerance stack-ups

Will the board go into the enclosure, the lid sit, the holes line up. Worst
case, RSS (independent, centred, normal deviations) and Monte Carlo — a
twenty-line script. Inputs:

- board outline at JLCPCB ±0.1 mm (precision routing), ±0.2 mm (routed),
  ±0.4 mm (V-scored);
- thickness ±10 % from 1.0 mm up: a 1.6 mm board is 1.44–1.76 mm;
- the printing corrections in `printing.md`.

Compute it both ways: a fit that passes by RSS and fails worst case is the
person's decision, not arithmetic.

## Vibration of a mounted board

Only for a device on a vehicle or next to a motor. The modal analysis above,
with the board a plate held at its mounting holes and the parts' mass smeared
over it, gives the first frequency. Steinberg's criterion gives the centre
deflection a board survives for 20 million cycles: Z = 0.00022·B/(C·h·r·√L)
in inches, symbols as in his "Vibration Analysis for Electronic Equipment".
It is empirical, for simple supports.

## Impedance and signal integrity

Only for USB, Ethernet and RF. KiCad's PCB Calculator (TransLine) computes
microstrip, coplanar, stripline and coupled lines.
[gerber2ems](https://github.com/antmicro/gerber2ems) (Apache-2.0) runs openEMS
on the Gerbers, a `stackup.json` and a positions file with the ports, and
gives S-parameters and impedance; capacitors are shorted, and it computes a
cut-out region, not the whole board. openEMS: Debian has a 2019 snapshot,
Homebrew's formula is broken — MacPorts or a build from source.
