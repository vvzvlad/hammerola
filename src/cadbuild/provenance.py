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

The rule applies to names the syntax tree shows assigned in model.py itself. A
float imported via `from helpers import MAX_WIDTH` is not refused, because the
refusal names a line in model.py. The tree says which names and where; the
values come from `vars(model)`; nothing is evaluated.

Which file is parsed is the hub's answer (`_model_source`), never the model's
`__file__`, which model.py could reassign.

Both halves (`collect` and `unwrapped`) read the same walk, so a number declared
in a helper module is neither refused nor counted: provenance is a statement
about model.py.

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
# Rendering a value the model decides: `check` lists every undeclared number in
# one refusal, so one broken `__repr__` must not take the rest down.
from .modeltext import shown, shown_text
from .paths import PROJECT_FILE, project_root

# A measurement journal is text somebody wrote by hand. A megabyte is already a
# hundred times more than any of them, and the ceiling is here because the file
# is named by the model -- i.e. by the push -- and is read inside the build.
SOURCE_FILE_MAX_BYTES = 1 << 20

# How many declarations metrics.json carries the note of, and how many estimate
# names it lists. `checklib.MAX_NOTE_CHARS` bounds one note, not the number of
# declarations: a one-line comprehension of 50000 estimates measured a 12.5 MB
# `provenance` block in a public, immutable metrics.json. Worst case with this
# cap: a name and a note are 200 characters each, dumped with
# `ensure_ascii=False`, so about 1.6 kB per entry and roughly 600 kB in total.
#
# `tests/test_template.py::test_the_template_declares_fewer_numbers_than_metrics_json_lists`
# keeps the template under this ceiling.
#
# The counts stay exact: `measured`, `derived` and `estimated` are totalled
# before truncation, and what is dropped is reported in `notes_omitted` /
# `estimates_omitted`.
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
# `line` is every line that binds the name, as a tuple: with a branch
# (`if DEBUG: GAP = 0.2 / else: GAP = 0.4`) which binding produced the value is
# undecidable from the tree, so all are named and none is claimed.
#
# It defaults to None because a caller may know a Number without a line
# (`tests/test_template.py` resolves sources of a file it never imports).
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
    cares about UPPER_SNAKE is `unwrapped()` below. It walks the same names as
    `unwrapped()`, so a helper module's declarations are not counted.

    `lines` is `module_level_lines()`, taken once by a caller that also calls
    `unwrapped()`; left out, it is read here.
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

    Values go through `shown` rather than `!r`: a `Bare.value` may be a float
    subclass whose `__repr__` raises, and one broken value must not take the
    whole list down.
    """
    read = {}
    unresolved = []
    for entry in entries:
        if entry.number.kind != checklib.MEASURED:
            continue
        problem = _source_problem(entry.number.source, root, read)
        if problem is not None:
            # The line where it is known, as the bare-number block says it.
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

    The return value is bounded and the printed lines are not: the log has its
    own ceiling (SPEC §7.4), while metrics.json is immutable. `MAX_LISTED` cuts
    the two author-text lists; the counts stay exact.

    Numbers and notes are rendered by `shown`, so what reaches metrics.json is
    bounded text and each printed estimate stays on one line.
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
    # The notes of every kind, where there is one (`derived()` promises its
    # note travels into metrics.json). Sorted before the cut, so the output and
    # which entries survive depend only on the source.
    listed = sorted(entry.name for entry in estimates)
    noted = sorted((entry.name, shown(entry.number.note, str))
                   for entry in entries if entry.number.note)
    summary["estimates"] = listed[:MAX_LISTED]
    summary["notes"] = dict(noted[:MAX_LISTED])
    # Absent when nothing was dropped. It counts what is not in the document,
    # so two names truncated to the same string are one entry and one omission.
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

    The key is rendered by `shown`, not `!r`: a buggy `__repr__` must not take
    the inventory down, and a dict key has no length limit, so it must be
    bounded before it reaches metrics.json.

    The walk uses the container's own `items()`, so a `dict` subclass reports
    what it chooses.
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

# Nodes that hold a body of statements without being an `ast.stmt` (verified in
# tests/cadbuild/test_provenance.py). Without them the walk would miss e.g.
#
#     try:
#         import calibration
#         GAP = calibration.GAP
#     except ImportError:
#         GAP = 0.2
_CARRIES_STATEMENTS = (ast.ExceptHandler, ast.match_case)

# What the walk descends into: statements, plus the two above.
_DESCENDED_INTO = (ast.stmt,) + _CARRIES_STATEMENTS


def module_bindings(tree):
    """`{name: [Binding, ...]}` -- every module-level binding, in python's order.

    Public so other readers (`tests/test_template.py`) use this one walk
    rather than an approximation of it.

    A module-level `if`, `for`, `while`, `try` -- its `except`, `else` and
    `finally` included -- `with` and `match` is walked into: a name bound in one
    is a module global like any other. A `def` and a `class` are not.

    Which statements bind is `_bind_targets`: `=`, an annotated `=` with a
    value, `+=` and its family, a `for` target, a `with ... as`, and `:=`
    anywhere. Deliberately out of scope: `global NAME` inside a function,
    `match` pattern captures, and a walrus in a `def`/`class`/`lambda` header
    (the walk stops at `_OWN_SCOPE` and `ast.Lambda`). A name bound only those
    ways is outside the rule entirely, neither refused nor counted.
    """
    bindings = {}
    _walk_statements(tree.body, bindings)
    return bindings


def _model_source(root):
    """The file `import model` resolves to under `root`.

    Asked of the import system rather than `root / "model.py"`, since
    `import model` may resolve to `model/__init__.py`. `PathFinder.find_spec`
    with the root as the whole search path repeats `geometry.load_model`'s
    resolution (the root is first on sys.path there). Not
    `importlib.util.find_spec`, which answers from `sys.modules`.
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

    Every line, not the last one (see the comment on `Entry`).

    No model argument: the file comes from `_model_source`, never from the
    module's own `__file__`.
    """
    source = _model_source(project_root())
    try:
        text = source.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(source))
    except (OSError, UnicodeDecodeError, SyntaxError, ValueError) as error:
        # It imported a moment ago, so this is a file that changed underneath
        # the build.
        # A SyntaxError quotes the author's own line, so it goes through `shown`.
        raise BuildError(f"cannot read {shown(source, str)} back to check its "
                         f"numbers: {shown(error, str)}") from error
    # `dict.fromkeys` rather than a set, for a deterministic `Entry.line`.
    return {name: tuple(dict.fromkeys(binding.line for binding in found))
            for name, found in module_bindings(tree).items()}


def _walk_statements(body, bindings):
    """Record what these statements bind, in the order python binds it.

    Three steps per statement, in this order: walruses in the statement's own
    expressions (they bind before the body they guard), then its own targets,
    then the nested statements.
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

    `AugAssign` rebinds: provenance does not survive arithmetic, so
    `WALL += 0.5` makes a bare float, and the refusal must point at that line.
    It is recorded as the BinOp the name ends up holding.

    An `AnnAssign` with no value (`GAP: float`) binds nothing.
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

    Reusing the statement's target (`ctx=Store`) would make the synthesized
    `WALL + 0.5` uncompilable. Anything but a plain name is returned untouched:
    it binds no module-level name.
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

    The path is held to `hubspec.MEMBER_RE` componentwise, like a pushed
    archive's members: a source must be a relative file inside the project, so
    `..`, a leading slash and anything outside `[A-Za-z0-9._-]` fail.

    `read` is a per-run cache of the files already opened: five constants under
    one heading in one journal is the ordinary case, and it is one read.

    The anchor is optional: a file with no heading named resolves once the file
    exists (`test_a_source_with_no_anchor_asks_nothing_of_the_headings`).

    Every piece of the source that reaches a message goes through `shown_text`
    to bound its length.
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
    # Bounded: a journal may have thousands of headings.
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

    Sorted and deduplicated here, so one input has one answer. Ascending rather
    than binding order: which binding produced the value is undecidable (see
    `Entry`), so the order only helps the author find the lines.
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

    Shadowing is supported (`geometry._warn_if_checklib_shadowed` only warns),
    but `unwrapped()` recognises only the image's `Number`, so declarations
    made through the project's own copy are listed as bare floats. The refusal
    stands; this adds the cause and the fix. An old copy may lack
    `estimated()` entirely.

    The detection is `geometry`'s, called rather than repeated.
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

    A concrete name and its own value, so the lines can be copied back.
    `estimated` is named last as the one that always builds. The value is
    rendered once, by `shown`, so it is safe and on one line.
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
