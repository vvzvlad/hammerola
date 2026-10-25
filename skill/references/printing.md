# What the printer does to your numbers

Read when putting dimensions on the part: what the process takes off a
dimension, the minimums a wall and a hole have to clear, the orientation the
part is printed in, and fasteners, countersinks and threads.

This was measured on ONE machine (calipers on PETG, 0.4 nozzle), not on your
part, so a constant carrying one of these corrections is
`checklib.derived(value, note)` naming it, never `measured`.

| Feature | Comes out | Measured on |
|---|---|---|
| Hole | **0.22 mm under** nominal | Ø5.00 bore printed 4.78 |
| Straight wall | **0.18 mm under** nominal | a 4.60 D-flat printed 4.42 |
| Outside diameter | **0.20 mm under** nominal | Ø8.00 journal printed 7.80 |

Holes and shafts alike come out smaller. A **hole** gains interference for free:
a Ø22 seat at zero nominal clearance pressed onto a 608 bearing exactly right —
the shrinkage IS the press fit, so it is not corrected. A **shaft** loses it:
the Ø8 journal printed 7.80 against an 8.05 bore and needed Ø8.35 nominal to
land at 8.15. So `nominal = what you want measured + the loss above`, and **do
not carry over "holes shrink, shafts grow"**: here it gets the shaft backwards.

Bias each correction toward the error cheaper to rescue: a fat shaft is
sandpaper, a binding round hole takes a drill, but **a flat wall cannot be
rescued** — leave it the loosest. That is rescuing a bad print, not designing
for one: an unnamed operation still does not exist.

**The minimums for a 0.4 nozzle are checked by nothing.** One that matters on
THIS part is an `assert` in `checks()`.

| Property | Minimum | Comfortable |
|---|---|---|
| Wall thickness | 1.2 mm | 2.0 mm |
| Layer height | 0.08 mm | 0.2 mm |
| Hole clearance | 0.2 mm | 0.3 mm |
| Press-fit interference | 0.1 mm | 0.15 mm |
| Feature size | 0.4 mm (the nozzle) | 0.8 mm |
| Fillet radius on the bottom | 0.5 mm | 1.0 mm |
| Unsupported bridge | — | under 20 mm |
| Overhang | — | under 45° from vertical |

TPU wants ~0.5 mm clearances, PETG takes +0.1 mm on a fit, ABS shrinks
0.5–0.7 % so critical dimensions scale up. For a fit that must work on the
FIRST print, use the measured offsets above instead.

**The orientation you model is the one it prints in**, Z up, as `checklib`
assumes: `print` may only move a part and turn it about Z. A part modelled
upside down publishes green, and only the render shows it. Design around
overhangs rather than supports, keep a flat face down, chamfer the bottom edges
rather than filleting them (a bed-edge fillet needs support), and write the
orientation next to the geometry.

**Fasteners: M3, unless the part is tiny or bought hardware dictates
otherwise.** M2 threads in printed PETG strip almost at once.

| | |
|---|---|
| Clearance hole | 3.4 |
| Self-tapping pilot, PETG/PLA | 2.5 |
| Socket cap head, DIN 912 | Ø5.5 × 3.0 |
| Countersunk, cross-recessed, DIN 965 | head Ø**5.6** max, cone depth **1.65** |
| Countersunk, hex socket, ISO 10642 / DIN 7991 | head Ø**6.0** nominal (5.81 max), cone depth **1.70** |

**Never type a countersink depth — derive it.** The cone is 90°, so
`depth = (head diameter − clearance diameter) / 2`, a `checklib.derived(...)`
of the two constants. Cut deeper and the head lands on the mouth's sharp lip
and wedges the plate apart.

**Name the standard, and WHICH diameter.** DIN 965 M3 is Ø5.6 and ISO 10642 is
Ø6.0, so a socket head in a DIN 965 pocket stands ~0.2 mm proud — not cosmetic
on a face that must seat flat. DIN and its ISO "equivalent" differ (at M4, Ø7.5
against Ø8.4), and one screw has three published head diameters — ISO 10642 M3:
6.72 theoretical, 6.0 nominal, 5.81 dk max — of which only the last two are
metal. `ref/hardware/` names the standard AND which one a number is.
fasteners.eu serves the DIN 7991 table under an address saying ISO 10642.
