"""Every flag the parser accepts is a flag the skill teaches.

The skill goes stale without going red: it goes on naming a flag that was
renamed or dropped, and the agent reading it gets a refusal whose cause is a
document on its own disk (`skill.py`).

The pairing runs both ways, and the two directions are different failures. A
parser flag the document does not carry is a capability the reader never learns
it has, which is how a person ends up told "the queue has nothing" by an agent
that did not know about `--all`. A flag the DOCUMENT carries and the parser does
not is the louder half: the agent types it, argparse refuses the whole command,
and the reason is a sentence written for an older client.

Long spellings only, and the second test is what makes that honest rather than
convenient. A short option is one character and this document also shows the
`curl` and `mkdir` a machine is set up with, so scanning for `-o` or `-p` finds
THEIR flags and proves nothing about ours. Every option this parser offers has a
long spelling beside its short one, so covering the long form covers all of them
— and that is asserted below rather than believed, because it is the premise the
scope stands on.

Both halves are read off the parser and off the shipped documents rather than
written out here, so a flag added tomorrow is covered without anybody
remembering this file. The skill is a DIRECTORY, and every document in it is
read: a verb documented in `references/cli.md` is documented, and a pairing that
looked only at the entry document would report every one of those flags as
untaught. Its `scripts/` are not documents but programs with parsers of their
own (argparse in `bq.py`, a `case` in `autoroute.sh`) and the command lines of
the tools they drive, so what they spell is not a flag of the `hammerola` CLI.
"""

import argparse
import re

from harness import one_text, skill_files
from hammerola.cli import build_parser

# Every `--flag` spelling in the document, which is also every shape a mention
# can take: the file is hard-wrapped markdown and names flags inside backticks,
# inside `sh` blocks and in running prose. A table rule (`|---|`) does not match,
# because a third dash is not a letter.
MENTIONED = re.compile(r"--[a-z][a-z0-9-]*")

# Flags the document deliberately does not carry, each with the reason. Checked
# against the parser below, so a name that leaves `build_parser` cannot go on
# sitting here as an excuse for a flag nobody has.
NOT_FOR_THE_AGENT = {
    # `rm` and `proposal rm` ask for the project id at a prompt, and the skill
    # says in both places that the decision belongs to the owner and not to the
    # agent. `--yes` is precisely the bypass of that prompt, so teaching it
    # would hand over the one refusal those two sections are built around.
    "--yes",
}

# Flags of OTHER programs the document shows a command of: the `kicad-cli` lines
# that make the 3D model and the Gerbers of a board, which are the author's to
# type on his own machine, and the `git` a version is published with (`git pull
# --no-rebase` after a refused push, `git status --ignored`, the `git push
# --delete` that removes a variant), and the
# `solidcraft-cli mcp` line that registers SolidCraft's MCP server. The
# `hammerola` parser has none of them (asserted below, so a name that comes to
# mean one of its flags is no longer excused).
OTHER_PROGRAMS = {
    "--board-plot-params", "--excellon-separate-th",
    "--include-pads", "--include-silkscreen", "--include-soldermask",
    "--include-tracks", "--include-zones", "--subst-models", "--format",
    "--delete", "--ignored", "--no-rebase", "--rebase",
    "--allow-any-path",
    # The KiCad references: kicad-cli's DRC and assembly exports (`pcb drc
    # --format json --schematic-parity --severity-all --refill-zones
    # --save-board`, `export
    # bom/pos --exclude-dnp`, `pos --smd-only`, the 3D export's `--no-dnp`),
    # Freerouting's `--gui.enabled` and `--router.fanout.enabled`, Copperpour's
    # `--config`, and the skill's own KiCad scripts (`autoroute.sh --draft-time
    # --finish --finish-time --diagnose`, `view.py --px --drc --marks`,
    # `silk.py apply --live`, `bq.py zones --at`, `findings.py --type --by`).
    "--schematic-parity", "--severity-all", "--refill-zones", "--save-board",
    "--exclude-dnp", "--smd-only", "--no-dnp",
    "--gui", "--router", "--config",
    "--draft-time", "--finish", "--finish-time", "--diagnose",
    "--px", "--drc", "--marks", "--live", "--at", "--type", "--by",
    # `references/analysis.md`: kicad-cli's STEP and XAO export of the board
    # body or its copper alone, for a thermal or current model.
    "--board-only", "--no-components", "--include-inner-copper",
    "--fuse-shapes", "--net-filter",
}


def _documents() -> dict:
    """The skill's documents: every member but the programs under `scripts/`."""
    return {name: text for name, text in skill_files().items()
            if not name.startswith("scripts/")}


def _long_options(parser) -> set:
    """Every long option this parser and its sub-commands accept. `--help` out.

    Recursive because the flags that matter most are two levels down —
    `comments resolve --note`, `proposal rm --yes`, `skill update --path` — and a
    sweep that stopped at the top level would find `--directory` and call the job
    done.
    """
    found = set()
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for child in action.choices.values():
                found |= _long_options(child)
        found |= {name for name in action.option_strings
                  if name.startswith("--")}
    return found - {"--help"}


def _shorthand_only(parser) -> set:
    """Options this parser offers ONLY in a short spelling, if any."""
    found = set()
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            for child in action.choices.values():
                found |= _shorthand_only(child)
            continue
        if action.option_strings and not any(
                name.startswith("--") for name in action.option_strings):
            found |= set(action.option_strings)
    return found


def test_every_flag_the_parser_accepts_is_one_the_skill_teaches_and_back():
    declared = _long_options(build_parser())
    mentioned = set(MENTIONED.findall(one_text(_documents()))) - OTHER_PROGRAMS

    # BOTH SIDES ARE NON-EMPTY AND OVERLAP, asserted before they are compared:
    # a parser read through a renamed argparse internal, or a document moved out
    # from under `skill/`, would otherwise make one of the two sets empty and
    # pass this whole file in silence.
    assert {"--force", "--title"} <= declared & mentioned, (
        f"the pairing is comparing against nothing: the parser offered "
        f"{len(declared)} long flags and the skill mentioned {len(mentioned)}. "
        f"Either `build_parser` no longer declares its flags through "
        f"`add_argument`, or `onboarding.skill_members()` no longer reaches "
        f"the documents")
    assert not OTHER_PROGRAMS & declared, (
        f"{sorted(OTHER_PROGRAMS & declared)} is excused as another program's "
        f"flag and the parser has it, so the document has to teach it")
    assert NOT_FOR_THE_AGENT <= declared, (
        f"{sorted(NOT_FOR_THE_AGENT - declared)} is excused from the skill and "
        f"the parser does not have it, so the exception outlived the flag")

    untaught = sorted(declared - mentioned - NOT_FOR_THE_AGENT)
    invented = sorted(mentioned - declared)
    assert not untaught and not invented, (
        f"the skill does not teach {untaught}, which the parser accepts — "
        f"an agent reading the file never learns those exist — and it names "
        f"{invented}, which the parser refuses, so a reader who types one gets "
        f"argparse's usage instead of the command. Document the flag where the "
        f"verb is already described, or, if it is deliberately not for an "
        f"agent, put it in NOT_FOR_THE_AGENT with the reason")


def test_no_flag_reaches_the_command_line_in_a_short_spelling_only():
    """The premise the test above stands on, since it reads long flags only.

    An option added as `-x` alone would be invisible to that pairing and to the
    document both, and the failure would look exactly like a flag nobody needed:
    green run, no mention, no agent that knows.
    """
    lonely = sorted(_shorthand_only(build_parser()))
    assert not lonely, (
        f"{lonely} are offered without a long spelling, and the pairing above "
        f"reads long spellings only — so nothing checks that the skill teaches "
        f"them. Add the long form, or widen that test deliberately")
