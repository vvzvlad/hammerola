# Measurements

Every `checklib.measured(...)` in `model.py` points at a heading in this file,
as `"ref/measurements.md#screw"`. The build resolves both the file and the
heading and refuses the push when either is missing, so this document cannot
quietly fall behind the model.

Write down what you actually did: the DATE, the instrument, how many samples,
and where on the object. "3.0" is a number; "2026-08-14, caliper across the
shank, 3 samples, 2.98 / 2.99 / 3.00" is a measurement somebody else can repeat
or disagree with. That example is the `SCREW_DIA` row below, quoted rather than
invented, so this file answers one question once: a made-up example is a second
reading of the same screw, and a reader who follows a `measured()` here has no
way of telling which of the two the number came from. The date is what says
whether a figure predates the change that ought to have moved it — a batch, a
filament, a redrawn part — so every section below opens with one. A number
nobody took belongs in `checklib.estimated(...)` instead — that always builds,
and the build log says so.

The heading is matched by its slug: lowercased, every non-alphanumeric
character turned into `-`, repeats collapsed, the ends trimmed. `## Lid fit`
is `#lid-fit`.

## Screw

2026-08-14. M3x8 DIN912 socket cap, stainless, out of the bag of a hundred.
Three taken at random from the bag and measured with a digital caliper.

| what | mm | how |
| --- | --- | --- |
| `SCREW_DIA` | 3.0 | across the shank, midway down; 2.98 / 2.99 / 3.00 |
| `SCREW_LENGTH` | 8.0 | under the head to the tip; 7.96 / 7.98 / 7.99 |
| `SCREW_HEAD_DIA` | 5.5 | across the head; 5.48 / 5.49 / 5.50 |
| `SCREW_HEAD_HEIGHT` | 3.0 | head only, seat to top; 2.97 / 2.99 / 3.00 |

The figures in `model.py` are the nominal ones rather than the mean of the
three: the screw is bought to a standard, and the samples are here to say the
bag really holds what the label claims.

## Board

2026-08-15. The board the box closes over. One board, measured with a digital
caliper at three places along each edge.

| what | mm | how |
| --- | --- | --- |
| `BOARD_LENGTH` | 45.0 | long edge, three places; 44.9 / 45.0 / 45.0 |
| `BOARD_WIDTH` | 28.0 | short edge, three places; 27.9 / 28.0 / 28.0 |
| `BOARD_THICKNESS` | 1.6 | bare laminate away from a pad; 1.57 / 1.60 / 1.61 |

Thickness is taken off the laminate and not over a pad or a solder joint,
because it is what the board sits on inside the box that matters. The tallest
thing standing on it is a separate question this file does not answer yet —
`HEIGHT` in `model.py` is still an estimate for exactly that reason.
