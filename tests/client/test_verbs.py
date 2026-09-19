"""Every verb the parser accepts is a verb something implements (issue #98).

THE SENTENCE OVER `cli.HANDLERS`, WRITTEN AS A TEST. That table exists so a
verb nothing implements "is a KeyError on the first run instead of a fall
through into the publishing path" — which is a promise about a failure, and
nothing was checking either half of it.

A verb the parser defines and the table does not is that KeyError: `main` looks
the command up with `[]`, so the run ends in a traceback out of a tool whose
every other refusal is one finished sentence — on a verb `hammerola --help`
lists and offers. The other direction is quieter and is what a verb RENAMED on
one side only looks like: a handler under a name no command line can produce
is dead code, and the name that replaced it lands in the KeyError above.

Nothing here runs a command. The pairing is between the two tables, and both
halves are read off the module rather than written out here, so a verb added
tomorrow is covered without anybody remembering this file.
"""

import argparse

from hammerola.cli import HANDLERS, build_parser


def _verbs(parser) -> set:
    """The commands the parser's own subparser table accepts."""
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return set(action.choices)
    raise AssertionError(
        "hammerola.cli.build_parser no longer adds its verbs through "
        "`add_subparsers`, so this test is comparing HANDLERS against nothing")


def test_every_verb_the_parser_defines_is_one_handlers_names_and_back():
    defined = _verbs(build_parser())
    handled = set(HANDLERS)

    assert defined == handled, (
        f"the parser accepts {sorted(defined - handled)} that HANDLERS does "
        f"not name — `hammerola --help` offers those and running one is a "
        f"KeyError out of `main` — and HANDLERS names "
        f"{sorted(handled - defined)} that no command line can reach")
