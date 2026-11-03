# A board an agent brings up and tests alone

Read when a schematic or a board is being designed that an agent will later
bring up, debug and test on a bench with no person at it — any board with a
microcontroller on it. The idea is boundary scan without the TAP: the
controller's own firmware drives and reads every pin, and since the agent
writes a firmware for every question, plain GPIO is enough (the owner's rule).
A note in brackets is a case from the Dionis-A8 bring-up, where the agent had
the board on a bench and the person in the room.

Contents: what the agent has and has not · every line reachable · power,
reset, heat · no hidden state · the host's grip on the board · the test
firmware and the bench · what GPIO does not cover · test points for a flying
probe (optional).

## What the agent has and has not

It has the controller's firmware, which it rewrites in minutes; the
controller's serial and USB; the bench's power supply and hub; instruments
over SCPI. It has no hands, no multimeter, no finger, and until the camera
bench exists no eyes on the board. Every rule below removes one thing it
would otherwise have to ask a person for. (One night of bring-up asked the
person to buzz three wires with a meter, feel a transistor for heat, confirm
a module was removed, check a jumper and an unfitted resistor, and unplug and
replug the board — six interruptions, each one a design item.)

## Every line reachable

**Every line between chips is a GPIO of the controller at least at one end**,
on a pin that is not a strap, not input-only, and has pull-up and pull-down.
A line is tested by reading it with pull-down, pull-up and floating: 0/1/0
means nothing holds it. (Three wires to an I2C bus read exactly that, and
the hour of "why no ACK" ended.)

**The other end is a chip whose pins read back through a register** — a
multipurpose/GPIO mode on its serial pins, or a test mode reachable over
I2C/SPI: loopback, pattern generator, PRBS with error counters. No chip in a
standalone or hardwired mode when a controlled mode exists. (The DSP's
multipurpose pins showed which frame-clock input the header really went to;
the DAC in standalone mode had nothing to read, and a marker had to be
planted in its volume register to see it reset.)

**Where neither end is a GPIO, a loopback.** The output comes back to the
controller by another path: a divider into an ADC, a level detector, a
loopback plug on the connector, for audio a microphone on the board. A
"listen and tell me" step is a person in the loop.

**Pull-ups are resistors.** A programmable pull is one firmware away from
being off, and the test that depends on it lies.

**Every clock is measurable.** Each oscillator has a tap to a pin with a
pulse counter (PCNT on ESP32): frequency is one read, not an inference from
which PLL divider happened to lock. (The oscillator was 12.288 MHz; the
schematic said 25, the first inference agreed with the schematic, and the DSP
ran at half rate for an evening.)

**Watchdogs can be switched off for test**, by a pin or a register.

## Power, reset, heat

**Each block sits behind a load switch the controller drives** — with quick
output discharge so OFF is 0 V, and with a power-good output on a GPIO.
Power sequencing becomes firmware, and "switch the blocks off one by one"
is a command, not a soldering iron. (The agent emulated it by loading or not
loading the DSP program and configuring or not configuring the DAC — a proxy
that cannot tell "powered and idle" from "configured".)

**The controller sees what a finger and a meter would.** Every rail to an
ADC through a divider; a current sense on the input (shunt and an INA-class
amplifier, or a PMIC with telemetry); a temperature sensor at the hot parts
— regulators, amplifier, the DSP's pass transistor. ("Looks like
overheating" and "the 3.3 V rail sags" were hypotheses; the only sensor was
the person's finger, and the answer was "near the oscillator, bearable for
two seconds".)

**Reset is seen and owned.** The supervisor's reset output goes to a
controller input with an interrupt and a timestamp; every other chip's reset
is a controller GPIO. The controller keeps the reset cause and a ring of
events in `.noinit` or RTC memory, writes core dumps to flash, and reports
them on boot. (The log held nothing of the hours before the failure.)

**The controller and its USB bridge are powered apart from the board's main
power**: when the board browns out, the log survives.

## No hidden state

**No jumpers, no "fit R107, not R108", no module whose presence is unknown.**
An option is a strap driven by a GPIO, an ID resistor on an ADC pin or a
board-detect line; a removable module sits behind its load switch and
announces itself. (Three questions to the person — an unfitted resistor, a
jumper, a removed module — each one bit the board could have reported.)

**The revision is readable and the pin table is generated.** A resistor
ladder on one ADC pin tells sixteen revisions apart, an ID EEPROM holds a
manifest; the firmware's pin definitions come from the KiCad netlist
(`kicad-cli sch export netlist --format kicadxml`, then a template into
`pindefs.h` — DLR's kicad_firmware_generation does exactly this), never
typed by hand. (The header went to serial input 0 on the board and to input
2 on the schematic; the program listened to silence until a pin-by-pin
experiment found it.)

## The host's grip on the board

**A path to EN and BOOT that no firmware can break.** On the ESP32-S3 the
USB Serial/JTAG port disappears when the firmware reconfigures the USB pins
or goes to deep sleep, and only GPIO0 low plus a reset brings it back — so a
second USB-UART with DTR/RTS on EN and GPIO0, or the bench's own switch,
reaches them.

**The board lives on a hub that truly cuts VBUS per port and on a
scriptable supply with a current limit.** Many "smart" hubs cut data only
(uhubctl keeps the list of ones that work). The first power-on is always
under a current limit: GPIO cannot find a short before there is power.

## The test firmware and the bench

**A resident test shell is a deliverable from day one**, generated from the
netlist: set, read and pulse a pin, read an ADC, count a frequency, switch a
block, dump the status registers. Without it every experiment costs a build
and a flash. (Each of a dozen experiments that night was temporary hooks in
the application, built and flashed anew.)

**The bench verifies, not the agent.** Pass thresholds are set before the
test and the agent cannot lower them; safety limits — supply current, PWM,
volume — live in the bench's code and refuse the command rather than trust
the prompt; instruments return features (frequency, duty, current over a
window), not raw arrays. (LoopHIL: hardware in the loop raised solved tasks
from 54 to 79 %, and every false pass came from a model that had invented
the measurement.)

**A test is a script with an exit code and a timeout**; the board keeps a
ring buffer of results; the checklist covers the outside too — every
connector, button and LED. An LED is read by a photodiode through a
capacitor: AC coupling rejects room light.

**In the schematic document every net and every pitfall has a column "how
the firmware checks it".** "Multimeter" or "finger" in that column is a gap
in the schematic, not in the method.

## What GPIO does not cover

Name the instrument instead of pretending:

* AC-coupled and differential lines (an A2B pair): the chip's own line
  diagnostics and PRBS.
* Values of passives: a flying probe or in-circuit tester, Kelvin. GPIO sees
  connected or not.
* Connectors — about a fifth of the joints on a board: loopback plugs, or
  the probe.
* Shorts before power-on: the current-limited first power-up.
* Analog quality (response, distortion): a calibrated microphone; the
  on-board one gives relative numbers only.

## Test points for a flying probe (optional)

For a board that will go onto the robotic bench: a gantry carrying a nine-pin
pogo head — every pin on a logic analyser that the bench can disconnect, any
one of them switched onto the oscilloscope by a reed relay — and a low-resolution thermal sensor that scans
the board in tiles. The board lies flat on a printed stand, parts down; a
camera finds zero, rotation and scale from the fiducials, so there is no
standard hole pattern, no fixture and no clamp strip. The fixed values the
bench relies on are the **probe contract**, `probe-1`, kept with its
footprints, symbol, DRC rules and the `probe.py check | export` script in the
owner's `kicad-house` skill (`references/probe-contract.md`, `lib/probe.*`,
`scripts/probe.py`); this section is what a designer needs to know before
opening it.

**What gets a pad**: every net on the board except GND, which is the centre
pad of every group, and the nets at mains potential or on an isolated side.
Each bus between chips goes whole onto one group — I2C, SPI with all its
chip selects, UART, I2S, SWD, CAN before its transceiver — so the logic
analyser sees the exchange; rails, clocks, resets and the remaining nets
fill the free pads of the nearest group of their voltage class (below). The
probe reads what GPIO cannot:
waveform, timing, analog, fast lines, the traffic on a bus. A net that also
leaves the board through a connector or a terminal block gets a pad all the
same: the head lands only on its groups and never reaches a connector's
pins.

**Pads come in groups of nine**: `TP_Probe_Group_3x3_P2.0mm`, a 3 × 3 grid of
Ø 1.0 mm pads at 2.0 mm pitch, 6 × 6 mm with its courtyard: eight nets around
the edge, GND in the centre. One group takes a whole bus in one landing —
SPI with its chip selects, I2S with MCLK, QSPI, SDIO, JTAG all fit in eight;
rails, resets and switching nodes go onto the free pads of the nearest
group of the same voltage class, and a group with one net on it is fine.
**Groups are split by voltage**: a logic group keeps every pad within −0.5 to
+5.5 V, the supply's protection trip included, and gets the logic analyser on
all eight pins; any net outside that goes onto a power group, where the bench
lands with the analyser disconnected from the pins and takes the pads one at
a time on the
oscilloscope. A bus never shares a group with such a net. The symbol's field
`ProbeVolts` ("0..3.3", "0..46.8") states the group's range, and the bench
reads the class from it. All nine pads always exist:
an unused pad is an unconnected copper island, so a pin lands on copper,
never on mask. Its symbol `TP_Probe` has pins 1–8 and GND, a no-connect flag
on every unused pin, and fields `Probe1`–`Probe8` that say what the bench
measures on each connected pad ("rail 3.3 V", "BCLK 3.072 MHz"); the check
refuses an empty one. A silkscreen frame with its pad-1 corner cut runs
round the pads: a person reads the group off the board, and the bench's
camera, beside the pins on the head, centres on the group itself — nine
pads and one cut corner give position and rotation — then the head shifts
by its calibrated camera-to-pins offset. No extra mark per group, and no
mark that encodes the head's geometry. The head does not turn: rotate a
group in 90° steps only; the grid is 90°-symmetric and the bench maps the
pins, tolerating about ±5° of board misalignment between the steps. All
groups on ONE side — the bottom when the assembly is single-sided — and every
pad ≥ 2.0 mm from any edge.

**Keep-out around a group**: 0.38 mm + 0.268 × the height of the neighbour
(the probe comes in at 16°) — 3 mm beside a 10 mm part. Nothing under
modules, BGAs or connectors. Heights are the designer's duty; the check
knows courtyards only (≥ 1.0 mm, DRC rules `probe_tp_*`).

**Fiducials**: `FID_Probe_D1.0mm`, copper Ø 1 mm in a Ø 2 mm zone free of
copper and mask, exactly three, in three corners, 4–10 mm from both edges,
with offsets that differ between them so orientation is unambiguous and the
camera tells boards apart. Copper, not silkscreen — silk is a separate print
with its own registration to the copper, and the targets are copper. Matte
finish (HASL glares at the camera), no via and no round pad within 3 mm (a
tented via or a mouse bite is found as a fiducial). Silkscreen carries the
identity: name, revision, a QR.

**Coordinates come from KiCad**: the aux origin at the bottom-left corner of
the outline; `probe.py export` writes `probe.json` (groups, their pads with
nets and what to measure, fiducials, mm from the origin), `kicad-cli pcb
export ipcd356`
lists every pad and via with its net; both go beside the Gerbers. A board
that breaks the contract is not exported.

**One probe is enough for continuity**: the controller drives the net
through its GPIO, the probe reads the level on the pad — boundary-scan
stimulus with a flying-probe meter, the way the industrial machines do it.

Sources for the numbers: XJTAG design-for-test guidelines
(xjtag.com/about-jtag/design-for-test-guidelines), Test Coach flying-probe
DFT rev C (testcoach.com), Takaya DFT guidelines (takayadownloads.com),
OpenPnP wiki on fiducials (github.com/openpnp/openpnp/wiki/Fiducials),
LoopHIL (arxiv.org/abs/2610.24231), ESP-IDF USB Serial/JTAG console guide,
DLR-RY/kicad_firmware_generation, mvp/uhubctl.
