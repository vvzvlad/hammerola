#!/usr/bin/env python3
"""Every number in a model says where it came from, or the build refuses.

THE RULE, and it is deliberately one sentence: every module-level UPPER_SNAKE
name in model.py bound to a `float` has to be a `checklib.Number`. A bare float
refuses the build.

The boundary is drawn where it is DECIDABLE from the source, because a rule an
author cannot apply by reading their own file is a rule they work around:

  * UPPER_SNAKE, which is the form the template teaches and the form the fleet
    already writes -- and it leaves `from math import pi` alone, along with
    every other imported lowercase name;
  * `float` and not `int`, because an integer in a CAD model is a count, an
    index or a flag (`ANGLES = 24`, `MIN_STL_BYTES = 1024`) while a fractional
    number is a millimetre, a tolerance or a fit. A number that is fractional
    by accident is written `derived(0.5, "half, exactly")`;
  * the same walk `collect()` makes -- the globals plus one level into a dict,
    list or tuple -- so the inventory and the rule can never disagree about
    what they are looking at.

WHAT IS NOT GUESSED: nothing about a constant's NAME beyond its case. The
tempting heuristic -- "the fits and the clearances need a source and the rest
do not" -- is wrong in both directions at once: it misses `LIP` and `SLOP` and
demands a measurement for `NOZZLE_CLEARANCE_UNUSED`.

THE RULE APPLIES TO NAMES THE SYNTAX TREE SHOWS ASSIGNED IN model.py ITSELF,
and that is a decision rather than an implementation limit. A UPPER_SNAKE float
that arrived by `from helpers import MAX_WIDTH` is NOT refused: the rule is
about the numbers written in the model, the refusal names a LINE, and a refusal
whose line is in a file the author is not being shown is one they cannot act
on. The values still come from the module object -- the tree says WHICH names
the rule looks at and WHERE they are written, `vars(model)` says what they are
bound to, and no expression is ever evaluated to find out.

WHICH FILE THAT TREE IS PARSED FROM IS THE HUB'S ANSWER AND NEVER THE MODEL'S,
and it is the one thing here the model does not get a say in. It used to be
`model.__file__` -- an ordinary module global, so `__file__ = "clean.py"` on
line 1 of model.py aimed the parse at another file and BOTH halves of the rule
then found nothing at all: measured, two bare floats published with
`"provenance": {}` in metrics.json, which is what an honest model that declares
nothing writes. `_model_source` is where it comes from now, and why it cannot
be pointed anywhere.

BOTH HALVES READ THAT ONE WALK, which they did not always: `collect()` used to
sweep every name in `vars(model)`, so the same imported `MAX_WIDTH`, declared
`measured(10.0, "ref/gone.md")` in a helper, refused the build with a message
naming no line and no file -- the exact unactionable refusal the paragraph
above disclaims, arriving through the other half. What follows from making them
symmetric is that a number a helper module declares is neither refused nor
counted: provenance here is a statement about model.py, and a project that
wants its helpers under the rule moves the constants into the model.

IT IS NOT IN `checklib` because it reads files: `checklib` is what a model
imports and it touches no filesystem and knows nothing about a project root.
`Number` and the three constructors are there; the checking of them is here.
"""

import ast
import collections
import importlib.machinery
import re
from pathlib import Path

from . import checklib
from .errors import BuildError
from .geometry import checklib_shadow
from .hubspec import MEMBER_RE
# Rendering a value the model decides. This file is the reason the promise
# "never raises" is worth anything: `check` exists to list EVERY undeclared
# number in one refusal, so one broken `__repr__` among fifty must not reduce
# it to a line about that one. Nothing here renders a model's object itself.
from .modeltext import shown, shown_text
from .paths import PROJECT_FILE, project_root

# A measurement journal is text somebody wrote by hand. A megabyte is already a
# hundred times more than any of them, and the ceiling is here because the file
# is named by the model -- i.e. by the push -- and is read inside the build.
SOURCE_FILE_MAX_BYTES = 1 << 20

# How many declarations metrics.json carries the NOTE of, and how many estimate
# names it lists. THE NOTE CEILING BOUNDS ONE NOTE AND NOT THE DOCUMENT, which
# is what `checklib.MAX_NOTE_CHARS` was justified by ("a 200 000 character note
# made a 200 kB metrics.json") and did not deliver: the number of declarations
# is unbounded, and
#
#     TABLE = {f"k{i}": checklib.estimated(1.0, "x" * 200) for i in range(50000)}
#
# -- seventy-five characters of source -- measured a 12 477 875-byte
# `provenance` block into
# a file that is public, immutable and never deleted, with only
# `limits.output_bytes` (512 MiB) above it. THAT FIGURE IS OF THE FILE, which is
# what makes it comparable to the ceiling above it: `metrics.write_metrics`
# dumps with `indent=2`, so the block as it lands on disk is 400 020 bytes wider
# than the same block dumped compact (12 077 855), and the compact number is
# what this comment used to give while calling it a file. So the aggregate is bounded here
# too, and the arithmetic is written down because the number is otherwise a
# guess: a name and a note are 200 characters each and metrics.json is dumped
# with `ensure_ascii=False`, so an entry is at most about 1.6 kB of four-byte
# characters, and 256 of them plus their names in `estimates` is roughly 600 kB
# in the worst case against a few kilobytes in every real one.
#
# HOW FAR UNDER A REAL MODEL SITS IS NOT WRITTEN HERE. It was -- "the starter
# template declares 28" -- and that is a live number about another file, kept in
# a comment, with nothing to fail on: the same shape as `checklib`'s "the
# longest note in the template is 130 characters", which was false by the end of
# the round that wrote it. So the claim is a test instead:
# `tests/test_template.py::test_the_template_declares_fewer_numbers_than_metrics_json_lists`
# holds the worked example every author copies under this ceiling, and reddens
# there rather than rotting here.
#
# THE COUNTS STAY EXACT. `measured`, `derived` and `estimated` are totalled
# before anything is dropped, and what the truncation removes is said out loud
# in `notes_omitted` / `estimates_omitted` rather than left for a reader to
# infer from a list that is shorter than the count beside it.
MAX_LISTED = 256

# The case that puts a name under the rule. A capital letter first, so `_MAX`
# and `pi` are outside it, and digits and underscores after.
UPPER_SNAKE = re.compile(r"\A[A-Z][A-Z0-9_]*\Z")

# An ATX markdown heading: up to three spaces, one to six hashes, the text, and
# the closing hashes some people write. Setext headings (a line underlined with
# `===`) are not read, and a journal that uses them will be told which slugs the
# file does have -- which is the message that gets somebody unstuck fastest.
_HEADING = re.compile(r"\A {0,3}#{1,6}\s+(.*?)\s*#*\s*\Z")

# One declared number, under the name it is bound to. The name is the module
# global (`WALL`) or, for one held in a container, the way to point at it
# (`CLEARANCES['lid']`, `SIZES[0]`).
#
# `line` IS EVERY LINE THAT BINDS THE NAME, as a tuple, and not the last one.
# It used to be the last, on the argument that python binds the name there and
# that is therefore the line holding the value -- which is true of straight-line
# code and false the moment a branch is involved. `DEBUG = True / if DEBUG: GAP
# = 0.2 / else: GAP = 0.4` binds GAP at the line the branch that RAN wrote, and
# no walk over a syntax tree can say which that was; naming the textually last
# one sent the author to the `else` of an `if` that took the other arm. Which
# binding produced the value is undecidable here, so all of them are named and
# none of them is claimed.
#
# It DEFAULTS TO NONE because a caller may know a Number without knowing a line
# -- `tests/test_template.py` resolves the sources of a file it never imports --
# and the message then simply says one less thing.
Entry = collections.namedtuple("Entry", "name number line", defaults=(None,))

# One number that declared nothing, with the lines the rule can point at. Same
# tuple, for the same reason.
Bare = collections.namedtuple("Bare", "name value line")

# One module-level binding: the line it is written on, and the expression the
# name draws its value FROM. NOTHING HERE IS EVALUATED -- `value` is an AST
# node, the thing a reader of the source would judge: the right-hand side of an
# `=`, the ITERABLE of a `for` (the name holds an element of it), the context
# manager of a `with`, and for `WALL += 0.2` a synthesized `WALL + 0.2`, which
# is the expression the name ends up holding. It is never None: a binding form
# this walk records is one whose value has an expression behind it.
Binding = collections.namedtuple("Binding", "line value")


def collect(model, lines=None):
    """Every `checklib.Number` model.py itself binds at module level, with its line.

    The names come off the SYNTAX TREE and the values off `vars(model)`, plus
    ONE level into a dict, list or tuple value -- a table of clearances is an
    ordinary way to hold them. Deeper than that is not walked, and that is
    written down rather than left to be discovered: a walk that follows
    arbitrary objects is a walk into a CAD kernel, and a `Number` nested two
    containers deep is simply not in the inventory. Dict KEYS are not looked at
    either.

    No filter on the case of the name: this is the inventory, and the rule that
    cares about UPPER_SNAKE is `unwrapped()` below.

    THE SAME NAMES AS `unwrapped()` AND NOT A WIDER SET, which is a correction
    rather than a limitation of the walk. It used to sweep every name in
    `vars(model)`, so a `MAX_WIDTH = checklib.measured(10.0, "ref/gone.md")`
    living in a helper module refused the build with a message naming no line
    and no file the author could open -- while a BARE float in that same helper
    was deliberately not refused at all (`unwrapped()` reads the tree). One rule
    cannot be about two sets of names. The consequence is worth knowing before
    reaching for it: a number a helper module declares is neither refused nor
    counted, so provenance is a statement about model.py.

    `lines` is `module_level_lines()`, taken once by a caller that also calls
    `unwrapped()`; left out, it is read here. Both halves walk the same file,
    so a build that asked for neither would parse model.py twice.
    """
    lines = module_level_lines() if lines is None else lines
    values = vars(model)
    found = []
    for name, line in lines.items():
        if name not in values:
            continue
        found.extend(Entry(shown_text(where), number, line)
                     for where, number in _declared_under(name, values[name]))
    return found


def unwrapped(model, lines=None):
    """Every module-level UPPER_SNAKE name bound to a PLAIN float, with its line.

    The other half of `collect()`, over exactly the same walk. A `Number` is a
    float subclass, so it is tested for FIRST; a `bool` is not a float subclass
    at all and therefore enters neither half, which is a fact about python
    rather than a line of code here (`tests/cadbuild/test_provenance.py` says
    so, since nothing in the source can).

    `lines` is `collect()`'s, handed over rather than taken again.
    """
    lines = module_level_lines() if lines is None else lines
    values = vars(model)
    bare = []
    for name, line in lines.items():
        if not UPPER_SNAKE.match(name):
            continue
        if name not in values:
            continue
        bare.extend(Bare(shown_text(where), value, line)
                    for where, value in _plain_floats_under(name, values[name]))
    return bare


def check(entries, bare, root):
    """Resolve every `measured()` source; refuse every undeclared number.

    ONE error listing every failure of both kinds, never one per build: the
    author fixes a journal once rather than four times, and declares five
    constants in one pass rather than in five red builds.

    THAT IS ALSO WHY THE VALUES GO THROUGH `shown` RATHER THAN THROUGH `!r`.
    Every `Bare.value` here is an object the model chose, and
    `_plain_floats_under` admits any `isinstance(x, float)` -- a float SUBCLASS
    included, whose `__repr__` is the author's code and may have a bug in it. A
    `__repr__` that raises took the whole refusal away and left a bare
    RuntimeError, i.e. EXIT_CRASHED for a class the author wrote; swallowing it
    in `shown` is what keeps the list whole. That matters HERE more than
    anywhere, because this message exists to list every failure at once: one
    broken value among twenty must not cost the author the other nineteen.
    """
    read = {}
    unresolved = []
    for entry in entries:
        if entry.number.kind != checklib.MEASURED:
            continue
        problem = _source_problem(entry.number.source, root, read)
        if problem is not None:
            # The line where it is known, the way the bare-number block below
            # says it. It is the same file and the same kind of fix, and a
            # message that says it for one half and not the other reads as if
            # the line could not be worked out for this one.
            where = "" if entry.line is None else f"{at_lines(entry.line)}: "
            unresolved.append(
                f"    {where}{entry.name}: {shown(entry.number.source)} "
                f"-- {problem}")

    blocks = []
    if bare:
        listed = "\n".join(
            f"    {at_lines(item.line)}: {item.name} = {shown(item.value)}"
            for item in bare)
        blocks.append(
            f"{len(bare)} number(s) in model.py do not say where they came "
            f"from. Every module-level UPPER_SNAKE name bound to a float has "
            f"to be a checklib.Number:\n{listed}\n{_three_ways_out(bare[0])}"
            f"{_shadow_note()}")
    if unresolved:
        blocks.append(
            f"{len(unresolved)} measurement(s) point at a source that is not "
            f"there:\n" + "\n".join(unresolved) + "\n"
            "  Write the measurement down in that file under that heading, or "
            "-- until somebody takes it -- say "
            "checklib.estimated(<value>, \"what would settle it\"), which "
            "always builds.")
    if blocks:
        raise BuildError("\n".join(blocks))


def report(entries):
    """Print the estimates. Returns the summary metrics.json carries.

    `estimate:` and NOT `warning:`, deliberately: a warning is something the
    author has to go and fix, and an honest estimate is not. The prefix is also
    load-bearing outside this file -- `tests/test_template.py` turns every
    `warning:` line of a build log into a failure, and the template has to be
    able to carry an estimate.

    WHAT IT RETURNS IS BOUNDED AND WHAT IT PRINTS IS NOT, and the asymmetry is
    deliberate: the log has a ceiling of its own on the way to the job (SPEC
    §7.4), while metrics.json is served as a file, is immutable and is never
    deleted. So `MAX_LISTED` cuts the two author-text lists and the counts above
    them stay exact -- see the comment on that constant for the arithmetic.

    THE NUMBER AND ITS NOTE ARE RENDERED BY `shown` AND NOT BY THE F-STRING,
    and the reason is the DOCUMENT rather than the line: what this returns is
    written into metrics.json, which is public, immutable and never deleted, so
    a note that is not text or not bounded is a file nobody can correct. The
    printed lines get the same treatment for the cheaper reason -- one estimate
    per line, and a note with a newline in it reads as two.
    """
    if not entries:
        # Absent rather than empty, the way every optional key in a build's
        # documents is: a model that declares nothing says nothing.
        return {}
    counts = {kind: 0 for kind in checklib.KINDS}
    estimates = []
    for entry in entries:
        counts[entry.number.kind] += 1
        if entry.number.kind == checklib.ESTIMATED:
            estimates.append(entry)
    for entry in estimates:
        print(f"estimate: {entry.name} = {shown(entry.number, format)} "
              f"-- {shown(entry.number.note, str)}")
    summary = dict(counts)
    # THE NOTES THEMSELVES, because `derived()` tells the author "the note
    # travels into metrics.json, where the next reader finds it" and until this
    # went in nothing carried one anywhere: the counts said how many numbers
    # followed from other numbers, and not one of them said from WHICH -- which
    # is the entire output of `derived()`. Every kind's note and not only
    # derived's: it is one field, written for one reader. Only where there is
    # one, since `note` is optional on `measured()` and an empty string asserts
    # nothing. Sorted, so two builds of one source produce one file -- and
    # sorted BEFORE the cut, so which of them survives is a property of the
    # source and not of the order this happened to walk it in.
    listed = sorted(entry.name for entry in estimates)
    # `shown` here is what keeps ONE broken `__str__` among fifty notes from
    # costing the other forty-nine their line in metrics.json -- the same
    # promise it makes at every other site (see `modeltext`).
    noted = sorted((entry.name, shown(entry.number.note, str))
                   for entry in entries if entry.number.note)
    summary["estimates"] = listed[:MAX_LISTED]
    summary["notes"] = dict(noted[:MAX_LISTED])
    # ABSENT WHEN NOTHING WAS DROPPED, like every optional key here, and a count
    # rather than a marker inside the list: a reader comparing `estimated: 4000`
    # against 256 names can see that something is missing, and only this says
    # how much. It counts what is not IN the document, so two names that the cap
    # in `modeltext.shown_text` truncated to the same string are one entry and
    # one omission.
    if len(listed) > len(summary["estimates"]):
        summary["estimates_omitted"] = len(listed) - len(summary["estimates"])
    if len(noted) > len(summary["notes"]):
        summary["notes_omitted"] = len(noted) - len(summary["notes"])
    return summary


def heading_slug(text):
    """`## Lid fit` -> `lid-fit`. Lowercase, non-alphanumeric to `-`, collapsed.

    `str.isalnum()` rather than an ASCII class, so a journal written in a
    language other than English still has headings that can be pointed at.
    """
    replaced = "".join(char if char.isalnum() else "-" for char in text.lower())
    return re.sub(r"-+", "-", replaced).strip("-")


# --------------------------------------------------------------------------
# The walk, made once and read by both halves
# --------------------------------------------------------------------------

def _declared_under(name, value):
    """`(how to point at it, the Number)` at `name` or one level inside it."""
    if isinstance(value, checklib.Number):
        return [(name, value)]
    return [(where, item) for where, item in _one_level(name, value)
            if isinstance(item, checklib.Number)]


def _plain_floats_under(name, value):
    """Every float that is NOT a Number at `name`, or one level inside it.

    A `Number` is a `float`, so it has to be excluded by type rather than by
    hoping the two branches never meet.
    """
    if isinstance(value, checklib.Number):
        return []
    if isinstance(value, float):
        return [(name, value)]
    return [(where, item) for where, item in _one_level(name, value)
            if isinstance(item, float) and not isinstance(item, checklib.Number)]


def _one_level(name, value):
    """`(how to point at it, the item)` for one level of a dict, list or tuple.

    THE KEY IS RENDERED BY `shown` AND NOT BY `!r`, and it is doing two jobs.
    `repr()` on a model's own key runs the author's `__repr__`, which may have
    a bug in it and would then take the whole inventory down rather than
    costing one entry its name; and an identifier or a dict key has no length
    limit anywhere in python, so `{"k" * 500000: derived(1.0, "...")}` -- a
    line of source -- measured a half-megabyte `provenance` block into a public,
    immutable metrics.json. Nothing else bounds it.

    THE WALK GOES THROUGH THE CONTAINER'S OWN CLASS, so what a `dict` subclass
    reports from `items()` is what the inventory holds. Worth knowing before
    reading the inventory as a census of a model that uses one; not worth
    working around, because the rule exists so an author can see which of THEIR
    numbers has no source.
    """
    if isinstance(value, dict):
        return [(f"{name}[{shown(key)}]", item) for key, item in value.items()]
    if isinstance(value, (list, tuple)):
        return [(f"{name}[{index}]", item) for index, item in enumerate(value)]
    return []


# --------------------------------------------------------------------------
# Which names the rule looks at, and where they are written
# --------------------------------------------------------------------------

# A statement whose body is a scope of its own. Names bound inside one are not
# module globals -- a function's locals are not, and a class body's are the
# class's -- so the walk stops at them.
_OWN_SCOPE = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)

# CARRIES STATEMENTS AND IS NOT ONE. `ast.ExceptHandler` and `ast.match_case`
# are the two nodes in the grammar that hold a body of statements without being
# an `ast.stmt` themselves -- verified rather than assumed, in
# tests/cadbuild/test_provenance.py, because the whole of this constant rests on
# it. The walk used to gather its children with `isinstance(child, ast.stmt)`
# and therefore stepped over both in silence, which took the rule off an
# everyday idiom:
#
#     try:
#         import calibration
#         GAP = calibration.GAP
#     except ImportError:
#         GAP = 0.2
#
# -- a bare float, module level, UPPER_SNAKE, and `unwrapped()` reported
# nothing at all.
_CARRIES_STATEMENTS = (ast.ExceptHandler, ast.match_case)

# What the walk descends into: statements, plus the two above.
_DESCENDED_INTO = (ast.stmt,) + _CARRIES_STATEMENTS


def module_bindings(tree):
    """`{name: [Binding, ...]}` -- every module-level binding, in python's order.

    THE ONE WALK, PUBLIC, because the second copy of it went wrong. The guard in
    `tests/test_template.py` needed the same boundary this draws and the VALUE
    besides, and it drew that boundary itself: written out a second time, it
    yielded only `ast.Assign` and `ast.AnnAssign` and dropped tuple targets, so
    four shapes the hub refuses passed it -- `A, B = 0.4, 0.3`, `WALL += 0.2`,
    `for STEP in (0.05, 0.10):` and `if (SLOP := 0.35) > 0:`. That guard runs the
    real rule over the real template now, and the file's OTHER walk --
    `declared_in`, which asks which constants the template declares so the two
    documents about it can be checked -- was the same copy with the same holes
    and calls this instead. Both of those are the argument for staying public
    and staying ONE function: an approximation of this agreed with it on
    everything anybody had written down, and was wrong on four shapes nobody
    thought to write down.

    A module-level `if`, `for`, `while`, `try` -- its `except`, `else` and
    `finally` included -- `with` and `match` is walked into: a name bound in one
    is a module global like any other. A `def` and a `class` are not.

    WHICH STATEMENTS BIND is `_bind_targets` below, and it is every form that
    binds a plain name: `=`, an annotated `=` THAT HAS A VALUE, `+=` and its
    family, the loop variable of a `for`, the `as` of a `with`, and `:=`
    wherever it is written. THREE ARE DELIBERATELY OUT OF SCOPE, and they are
    named here so the next reader knows the difference between a decision and a
    gap. A `global NAME` inside a function does bind a module global, and this
    walk does not follow it: the value is written where the refusal cannot
    usefully point, and a function that assigns a module constant is not the
    shape the rule is about. Neither are the captures of a `match` pattern
    (`case [x]:`), for the same reason and with far less of a case for changing
    it. NOR IS A WALRUS WRITTEN IN A `def`, `class` OR `lambda` HEADER -- a
    decorator, a default argument, an annotation: `def f(x=(GAP := 0.2)): ...`
    really does bind GAP at module level, and it is missed because the walk
    stops at `_OWN_SCOPE` and `_bind_walruses` stops at `ast.Lambda`. Left as a
    gap rather than closed: the shape appears in no model anybody has written,
    and following the header of a scope this walk otherwise never enters is a
    second boundary to keep right. A name bound only one of those three ways is
    outside the rule ENTIRELY -- neither refused when it is bare nor counted
    when it is declared -- because both halves read this one walk.
    """
    bindings = {}
    _walk_statements(tree.body, bindings)
    return bindings


def _model_source(root):
    """The file `import model` resolves to under `root`.

    THE PATH IS ASKED OF THE IMPORT SYSTEM BECAUSE THAT IS THE CORRECT ANSWER,
    and `root / "model.py"` is not: `import model` also resolves to
    `model/__init__.py`, and python's order between a package and a module of
    the same name is not a rule worth transcribing a second time.
    `PathFinder.find_spec` with the project root as the entire search path runs
    the resolution `geometry.load_model` ran -- the root goes FIRST on sys.path
    there, so this is the entry that answered.

    THIS FUNCTION IS GIVEN THE ROOT AND NOT THE MODULE, which is why it asks
    the finder rather than reading `model.__file__`: `module_level_lines`
    below has no module object to read one off. Not
    `importlib.util.find_spec`, which consults `sys.modules` and answers with
    the cached module's own spec instead of resolving anything.
    """
    spec = importlib.machinery.PathFinder.find_spec("model", [str(root)])
    origin = None if spec is None else spec.origin
    if origin is None:
        # Nothing importable, or a namespace package -- a `model/` directory
        # with no `__init__.py`, which has no source of its own to read.
        # `load_model` imports one of those perfectly well and its
        # parts()/views() check is what refuses it, so this branch is reached
        # by the walks called directly rather than by a build.
        raise BuildError(
            "there is no model.py in this project to read the numbers back "
            "out of, so there is no line to point at for a number that "
            "declares nothing")
    return Path(origin)


def module_level_lines():
    """`{name: (every line that binds it,)}`, off the source.

    EVERY LINE, not the last one. Which binding put the value in `vars(model)`
    is undecidable from the tree the moment a branch is involved -- see the
    comment on `Entry` -- so the message names them all and asserts nothing
    about which ran.

    NO MODEL ARGUMENT, deliberately: the file is `_model_source`'s answer about
    the project root, and taking the module here would put the attribute the
    rule used to hang off back within reach.
    """
    source = _model_source(project_root())
    try:
        text = source.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(source))
    except (OSError, UnicodeDecodeError, SyntaxError, ValueError) as error:
        # It imported a moment ago, so this is a file that changed underneath
        # the build.
        # THE PATH IS THE HUB'S AND THE ERROR TEXT IS THE MODEL'S: `source` was
        # resolved under the project root and cannot be aimed by the model, but
        # a SyntaxError quotes the offending LINE of the file, which is the
        # author's own text either way.
        raise BuildError(f"cannot read {shown(source, str)} back to check its "
                         f"numbers: {shown(error, str)}") from error
    # `dict.fromkeys` rather than a set, and it is no longer about the MESSAGE:
    # `at_lines` sorts and deduplicates what it is given, so what comes out of
    # here decides nothing a reader sees. What it still buys is a value that is
    # the same object for the same file however the walk visited it -- an
    # `Entry.line` two builds can be compared on -- which a set does not give.
    return {name: tuple(dict.fromkeys(binding.line for binding in found))
            for name, found in module_bindings(tree).items()}


def _walk_statements(body, bindings):
    """Record what these statements bind, in the order python binds it.

    THREE STEPS PER STATEMENT AND THE ORDER IS THE CORRECTNESS. A walrus written
    in a statement's own expressions binds BEFORE the body that statement
    guards, so it goes first: `if (GAP := 0.2) > 0:` with a `GAP = 0.4` inside
    it binds line 1 and then line 2. The walrus pass used to run LAST, after the
    descent, which recorded those two the other way round -- the same inversion
    the `AugAssign` had, arriving through the other half. Then the statement's
    own targets, then the statements nested inside it, so `for X in ...:` is
    written before an `X = ...` in its own body.
    """
    for node in body:
        if isinstance(node, _OWN_SCOPE):
            continue
        children = list(ast.iter_child_nodes(node))
        for child in children:
            if not isinstance(child, _DESCENDED_INTO):
                _bind_walruses(child, bindings)
        _bind_targets(node, bindings)
        _walk_statements([child for child in children
                          if isinstance(child, _DESCENDED_INTO)], bindings)


def _bind_targets(node, bindings):
    """Every module-level name this ONE statement binds, at its own line.

    `AugAssign` is on this list and it is the one whose absence produced a WRONG
    MESSAGE rather than a miss. Provenance deliberately does not survive
    arithmetic, so `WALL += 0.5` turns a declared number into a bare one -- and
    with the name not rebound here, the refusal pointed at the line of the
    PREVIOUS assignment, which holds a perfectly correct `checklib.estimated(...)`.
    Being sent to correct code is worse than not being sent anywhere. What it is
    bound TO is written out as the BinOp it is, because that is the expression
    the name ends up holding and a reader of the source judges it as one.

    AN `AnnAssign` WITH NO VALUE IS NOT A BINDING. `GAP: float` is an
    annotation: nothing is evaluated, `vars(model)` never grows the name, and
    recording it added a line to the refusal pointing at a statement that holds
    no number -- and, while the last line won, replaced the line that does.
    """
    if isinstance(node, ast.Assign):
        for target in node.targets:
            _bind(target, node.lineno, node.value, bindings)
    elif isinstance(node, ast.AnnAssign):
        if node.value is not None:
            _bind(node.target, node.lineno, node.value, bindings)
    elif isinstance(node, ast.AugAssign):
        combined = ast.copy_location(
            ast.BinOp(left=_as_load(node.target), op=node.op, right=node.value),
            node)
        _bind(node.target, node.lineno, combined, bindings)
    elif isinstance(node, (ast.For, ast.AsyncFor)):
        # The loop variable is a module global, and it holds the LAST item
        # after the loop -- an ordinary way to end up with a bare float. The
        # expression recorded is the ITERABLE: the name holds an element of it,
        # and the elements are what a reader of the source can see.
        _bind(node.target, node.lineno, node.iter, bindings)
    elif isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                _bind(item.optional_vars, node.lineno, item.context_expr,
                      bindings)


def _as_load(target):
    """The same name, as something that READS it rather than assigns to it.

    `WALL += 0.5` is recorded as the expression `WALL + 0.5`, and the obvious
    way to build that is to reuse the statement's own target as the left
    operand. It prints correctly and its position is right, but the node carries
    `ctx=Store`, so the synthesized expression is not a legal expression:
    `compile(ast.Expression(body=combined), "<x>", "eval")` raises
    `ValueError: expression must have Load context but has Store instead`.

    NO CONSUMER COMPILES ONE TODAY -- both readers of a `Binding.value` unparse
    it or look at its type -- so this is latent rather than a bug anybody has
    met. It is fixed anyway because the cost is one node: a `Binding.value` is
    documented as "the expression the name draws its value from", and one that
    cannot be evaluated is not that. Anything but a plain name is handed back
    untouched: an attribute or a subscript target binds no module-level name, so
    nothing downstream reads the expression built around it.
    """
    if isinstance(target, ast.Name):
        return ast.copy_location(ast.Name(id=target.id, ctx=ast.Load()), target)
    return target


def _bind_walruses(node, bindings):
    """Bind every `(N := ...)` written in this expression, at its own line.

    A walrus binds where it is WRITTEN, so `if (GAP := 0.2) > 0:` binds a module
    global -- and so does one inside a comprehension, which is a scope for its
    loop variable and not for this. A `lambda` IS one, so its body is left
    alone; so are its defaults, which is the gap named in `module_bindings`.
    """
    if isinstance(node, ast.Lambda):
        return
    if isinstance(node, ast.NamedExpr):
        _bind(node.target, node.lineno, node.value, bindings)
    for child in ast.iter_child_nodes(node):
        _bind_walruses(child, bindings)


def _bind(target, line, value, bindings):
    """Every name one assignment target binds. `A, B = ...` binds two.

    A TUPLE TARGET IS PAIRED WITH A TUPLE VALUE element by element, so
    `A, B = 0.4, 0.3` records `0.4` under A and `0.3` under B rather than
    handing both names the whole tuple. Only where the shapes line up: a
    starred target consumes an unknown number of elements, and a value that is
    not written out as a tuple cannot be taken apart at all, so both fall back
    to the whole expression -- which is a superset of what each name gets and
    therefore never claims less than the truth.
    """
    if isinstance(target, ast.Name):
        bindings.setdefault(target.id, []).append(Binding(line, value))
    elif isinstance(target, (ast.Tuple, ast.List)):
        for element, piece in zip(target.elts, _paired(target.elts, value)):
            _bind(element, line, piece, bindings)
    elif isinstance(target, ast.Starred):
        _bind(target.value, line, value, bindings)
    # An attribute or a subscript target binds no module-level name.


def _paired(elements, value):
    """One expression per target element -- theirs where that is decidable."""
    if (isinstance(value, (ast.Tuple, ast.List))
            and len(value.elts) == len(elements)
            and not any(isinstance(item, ast.Starred) for item in elements)):
        return value.elts
    return [value] * len(elements)


# --------------------------------------------------------------------------
# Resolving a measurement's source
# --------------------------------------------------------------------------

def _source_problem(source, root, read):
    """Why `"<path>[#<anchor>]"` does not resolve under `root`, or None.

    The path is held to `hubspec.MEMBER_RE` COMPONENTWISE -- the same alphabet
    a pushed archive's members are held to, and for the reason that alphabet
    exists: a source is a file the PUSH CARRIES, and only a relative path inside
    the project is one. `../notes.md` and `/home/me/notes.md` resolve on the
    laptop that wrote them and are simply absent on the hub, so following them
    would build locally and fail remotely; the refusal says so at the line that
    wrote it instead. `..`, a leading slash and anything outside
    `[A-Za-z0-9._-]` all fail it.

    `read` is a per-run cache of the files already opened: five constants under
    one heading in one journal is the ordinary case, and it is one read.

    THE ANCHOR IS OPTIONAL AND ITS ABSENCE IS NOT A PROBLEM -- a `measured()`
    naming a file and no heading resolves the moment the file is there, even one
    with no headings in it at all. That is deliberate (a journal is often one
    document per measurement), it is the half README.md used to state too
    strictly, and `test_a_source_with_no_anchor_asks_nothing_of_the_headings` is
    what holds it.

    EVERY PIECE OF THE SOURCE THAT REACHES A MESSAGE GOES THROUGH `shown_text`
    FOR ITS LENGTH. The alphabet check above says what characters a path may
    hold and nothing about how many, and the anchor is held to nothing at all
    -- so a `measured()` naming a thousand-character heading would put the whole
    of it in a refusal, once per constant that names it.
    """
    path_part, _, anchor = source.partition("#")
    components = path_part.split("/")
    if not path_part or any(not MEMBER_RE.match(part) for part in components):
        return ("is not a path this build will follow. A source is a file in "
                "the project, written relative to the directory holding "
                f"{PROJECT_FILE} -- letters, digits, dot, dash and underscore, "
                "no `..` and no leading slash -- with an optional #heading "
                "after it")

    named = shown_text(path_part)
    path = root.joinpath(*components)
    text = read.get(path_part)
    if text is None:
        if not path.is_file():
            return f"there is no {named} in this project"
        try:
            size = path.stat().st_size
        except OSError as error:
            return f"{named} cannot be measured: {shown(error, str)}"
        if size > SOURCE_FILE_MAX_BYTES:
            return (f"{named} is {size} bytes, over the "
                    f"{SOURCE_FILE_MAX_BYTES} a measurement journal may be")
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            return f"{named} cannot be read as UTF-8 text: {shown(error, str)}"
        read[path_part] = text

    if not anchor:
        return None
    slugs = _heading_slugs(text)
    if anchor in slugs:
        return None
    # THE SLUGS COME OUT OF A FILE THE PUSH CARRIED, and the LENGTH is a
    # journal's business: a file of ten thousand headings would otherwise put
    # all of them in one refusal.
    return (f"{named} has no heading whose slug is {shown(anchor)}. It has "
            f"{shown_text(', '.join(sorted(slugs))) if slugs else 'no headings at all'}")


def _heading_slugs(text):
    slugs = set()
    for line in text.splitlines():
        match = _HEADING.match(line)
        if match:
            slugs.add(heading_slug(match.group(1)))
    slugs.discard("")
    return slugs


def at_lines(lines):
    """`line 3`, or `lines 3, 5` when the name is bound in more than one place.

    SORTED AND DEDUPLICATED HERE, so one input has one answer. It used to be
    neither, and the caller made up the difference: `module_level_lines` runs
    the lines through `dict.fromkeys` on the way in, so the hub's own messages
    were mostly tidy by accident -- but the walk records a statement's walruses
    BEFORE its own targets, which is the order python binds them, and that is
    not the order somebody reads a file in. `GAP = (\\n    GAP := 0.5\\n)`
    therefore came out as `lines 2, 1`. A raw call answered `lines 1, 1` for
    `X, X = 1.0, 2.0`. Neither is anything to show an author, and neither was
    the function's fault to leave to a caller: this is the phrase, so this is
    where it is settled.

    ASCENDING AND NOT IN BINDING ORDER, deliberately. The order the walk found
    them in is real, but nothing in the message claims it -- see the comment on
    `Entry`: which binding produced the value is undecidable, so all of them are
    named and none of them is asserted about. What is left for the order to do
    is help somebody find the lines in their file, and for that the file's own
    order is the only useful one.
    """
    if isinstance(lines, int):
        # A caller that knows one line and says so plainly, rather than having
        # to remember to wrap it in a tuple.
        lines = (lines,)
    lines = sorted(set(lines))
    label = "line" if len(lines) == 1 else "lines"
    return f"{label} {', '.join(str(number) for number in lines)}"


def _shadow_note():
    """The sentence a project carrying its own checklib.py needs, or ''.

    SHADOWING IS A SUPPORTED SITUATION -- `geometry._warn_if_checklib_shadowed`
    warns and the build publishes, and `skill/SKILL.md` says "nothing goes red"
    -- and it turns this rule into a refusal whose remedy is the line already in
    the file. `unwrapped()` recognises the `Number` of the copy IN THE IMAGE, so
    a `WALL = checklib.estimated(2.4, "a guess")` resolved through the project's
    own module is not one: it is a plain float, and the message tells its author
    to write the declaration they have already written.

    The refusal STANDS -- by this rule those really are bare floats, and the
    numbers the project's copy records never reach metrics.json either -- so
    what this adds is the cause. Worse without it where the shadowing copy is
    the old one out of `cad_publish`, which has no `estimated()` at all: doing
    what the message asks ends in an AttributeError, i.e. a dead end reached in
    two steps.

    The detection is `geometry`'s, called rather than repeated: a second way of
    asking whether checklib is shadowed is a second answer to disagree with.
    """
    shadow = checklib_shadow()
    if shadow is None:
        return ""
    return (
        f"\n  AND model.py imported checklib from {shadow}, which is the "
        f"project's own copy rather than the one in the image. This rule "
        f"recognises only the image's checklib.Number, so a number this "
        f"project DID declare through that copy is listed above as a bare one. "
        f"If those lines already say checklib.measured/derived/estimated, that "
        f"is what happened, and rewriting them changes nothing: delete "
        f"{shadow} instead -- `import checklib` goes on working and resolves to "
        f"the image's copy, which is also the one metrics.json reads the "
        f"interference volumes out of. An older copy may not define "
        f"estimated() at all, so following the advice above would fail with "
        f"AttributeError.")


def _three_ways_out(item):
    """The three declarations, written out on a name from the file being refused.

    A concrete name and its own value, because a refusal answered with a
    template is a refusal somebody has to translate. `estimated` is named last
    and named as the one that always builds: it is the way out of every one of
    these, and leaving it implicit is how a mandatory rule becomes a rule
    people route around.

    THE VALUE IS THE MODEL'S OBJECT and is rendered once, by `shown`. A
    `__repr__` that raises would otherwise take away the whole refusal these
    three lines are the useful half of, and this message's purpose is to be
    copied back into the file -- so what goes in it has to be one line.
    """
    value = shown(item.value)
    return (
        f"  Take {item.name}. Write its value as one of these, whichever is "
        f"true of it:\n"
        f"    checklib.measured({value}, \"ref/measurements.md#the-heading\") "
        f"-- somebody measured it, and it is written down there\n"
        f"    checklib.derived({value}, \"what it follows from\") "
        f"-- it follows from other numbers by a stated rule\n"
        f"    checklib.estimated({value}, \"what would settle it\") "
        f"-- nobody measured it. This one always builds: the log says so and "
        f"metrics.json counts it")
