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
import ast
import inspect
import sys

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


# -- and every attribute a handler reads is one the parser sets --------------

def _reads(function: ast.FunctionDef) -> set:
    """`args.<name>` read anywhere inside this function.

    ATTRIBUTE ACCESS ONLY, so `getattr(args, "message", None)` is invisible
    here — which is the point. Two sites keep that form deliberately (#108):
    `build` has no `-m`, and a guarded read is a statement that the attribute
    may be missing. This test is about the seventeen that are NOT guarded.
    """
    return {node.attr for node in ast.walk(function)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name) and node.value.id == "args"}


def _handed_on(function: ast.FunctionDef) -> set:
    """Names of same-module functions this one calls with `args`."""
    return {node.func.id for node in ast.walk(function)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and any(isinstance(a, ast.Name) and a.id == "args"
                    for a in node.args)}


def _attributes_read(handler) -> set:
    """Everything `handler` reads off `args`, following one hand-on.

    One level is enough for this client and is checked rather than assumed:
    the helpers that take `args` (`_destination`, `_path`, `_fresh_directory`)
    read it and pass it to nobody.
    """
    tree = ast.parse(inspect.getsource(sys.modules[handler.__module__]))
    named = {node.name: node for node in ast.walk(tree)
             if isinstance(node, ast.FunctionDef)}
    entry = named[handler.__name__]
    wanted = _reads(entry)
    for name in _handed_on(entry):
        if name in named:
            wanted |= _reads(named[name])
    return wanted


def _sets(parser, verb: str) -> set:
    """Every dest this parser will put on the namespace for `verb`.

    THE PARENT'S ACTIONS COUNT, and that is not a detail: `skill update`
    declares `--path` with `argparse.SUPPRESS`, so the subparser sets nothing
    for it and the attribute survives because the `skill` parser above set it
    first. Asked structurally rather than by parsing an argv, so a verb with
    required positionals needs no invented values.
    """
    def own(node):
        """This parser's own dests — NOT its siblings' and NOT its children's."""
        return {action.dest for action in node._actions
                if action.default is not argparse.SUPPRESS}

    def below(node):
        """`own`, plus every sub-command's, for a verb that has sub-commands."""
        dests = own(node)
        for action in node._actions:
            if isinstance(action, argparse._SubParsersAction):
                for child in action.choices.values():
                    dests |= below(child)
        return dests

    dests = own(parser)
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction) and verb in action.choices:
            dests |= below(action.choices[verb])
    return dests


def test_every_attribute_a_handler_reads_is_one_the_parser_sets():
    """The invariant seventeen unguarded `args.x` reads now stand on (#108).

    Those were `getattr(args, "x", default)` until the defaults were shown to
    be repeats of argparse's own. What makes the plain reads safe is that the
    parser sets the attribute on every argv reaching the handler — and that was
    written down in a commit message, where nothing checks it. Remove a flag,
    or move one from the parent parser to a subparser that suppresses it, and
    the failure is an AttributeError out of a verb, on a path whose test may
    well not pass that flag.
    """
    parser = build_parser()
    missing = {}
    for verb, handler in sorted(HANDLERS.items()):
        unset = _attributes_read(handler) - _sets(parser, verb)
        if unset:
            missing[verb] = sorted(unset)
    assert not missing, (
        f"these handlers read attributes their parser never sets: {missing}. "
        f"Either the flag is gone, or the read has to go back to "
        f"`getattr(args, ..., default)` and say why")
