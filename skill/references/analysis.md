# Strength, vibration, heat and flow: computed on your machine

Read when the person asks whether a part holds a load, where it bends, at what
frequency it rings, how hot it gets, or how air or water flows through it.

The hub computes none of this. These analyses run where you work, on the STEP
the build publishes, with open solvers you install there:

- **Mesh**: Gmsh, tetrahedra, finer where the stress or the flow concentrates.
- **CalculiX** (`ccx`, Abaqus-style `.inp` input) for solids: linear static
  stress and displacement, natural frequencies and mode shapes, linear
  buckling, heat conduction steady or transient, thermal stress.
- **OpenFOAM** for fluids: incompressible flow laminar or turbulent
  (`simpleFoam` steady, `pimpleFoam` transient), heat between a fluid and the
  solids it touches (`chtMultiRegionSimpleFoam`), compressible gas
  (`rhoCentralFoam`). The space the fluid fills is modelled as a body of its
  own — the inside of a channel, or a box round the part with the part cut
  out — and exported as its own STEP.

What a result is worth:

- Linear only: one material with constant properties, one load case, small
  deflections; no contact, plasticity or fatigue.
- Supports must stop all six rigid-body motions, or a static solve has no
  answer.
- Check the solve before quoting it: reactions balance the applied load,
  heat in equals heat out, mass in equals mass out. Halve the mesh size and
  compare before trusting a peak.
- A printed part is weaker across its layers than along them; an isotropic
  material hides that. Say which strength you used and in which direction.
- Say how far the number is from the part: an analysis is an estimate, not a
  measurement.

Debian 13 has no `calculix-ccx` package (Debian 12 and sid do).
