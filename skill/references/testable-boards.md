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

For a board that will go onto the robotic bench: a gantry carrying a pogo
probe on coax to the oscilloscope and a low-resolution thermal sensor that
scans the board in tiles. The board lies in any clamp; a camera finds zero,
rotation and scale from the fiducials, so there is no standard hole pattern
and no fixture.

**What gets a pad**: every rail, clock, reset and inter-chip line, every
switching node, the amplifier outputs — and every net whose "how the
firmware checks it" column is empty. The probe reads what GPIO cannot:
waveform, timing, analog, fast lines.

**Pad and spacing** (industrial flying-probe rules): pad ≥ 0.5 mm (0.25 mm
is the floor), pitch ≥ 0.84 mm; a via as a target has an annular ring
≥ 0.25 mm and a mask relief ≥ 0.13 mm; all points on ONE side, ground pads
on both; a ground pad beside each group of points, since the shortest
ground path makes the measurement; power and ground pads > 1.14 mm for a
fixed contact that the probe need not visit; 3 mm free along two opposite
edges for the clamp.

**Keep-out around a pad**: 0.38 mm + 0.268 × the height of the neighbour
(the probe comes in at 16°) — 3 mm beside a 10 mm part. Nothing under
modules, BGAs or connectors.

**Fiducials**: copper Ø 1 mm in a Ø 2 mm zone free of copper and mask, three
or four by the corners on the diagonal. Copper, not silkscreen — silk is a
separate print with its own registration to the copper, and the targets are
copper. Matte finish (HASL glares at the camera), no round features nearby
(a tented via or a mouse bite is found as a fiducial), and at different
positions on different boards, so the camera also tells the boards apart.
Silkscreen carries the identity: name, revision, a QR.

**Coordinates come from KiCad**: `kicad-cli pcb export ipcd356` lists every
pad and via with its net, from the aux origin; the bench selects `TP*`. A
DRC rule keeps them apart:
`(rule "TP spacing" (constraint courtyard_clearance (min 1.5mm)) (condition "A.Reference == 'TP*' && B.Reference == 'TP*'"))`.

**One probe is enough for continuity**: the controller drives the net
through its GPIO, the probe reads the level on the pad — boundary-scan
stimulus with a flying-probe meter, the way the industrial machines do it.

Sources for the numbers: XJTAG design-for-test guidelines
(xjtag.com/about-jtag/design-for-test-guidelines), Test Coach flying-probe
DFT rev C (testcoach.com), Takaya DFT guidelines (takayadownloads.com),
OpenPnP wiki on fiducials (github.com/openpnp/openpnp/wiki/Fiducials),
LoopHIL (arxiv.org/abs/2610.24231), ESP-IDF USB Serial/JTAG console guide,
DLR-RY/kicad_firmware_generation, mvp/uhubctl.
