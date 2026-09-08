#!/usr/bin/env python3
"""Calling into the model: its checks(), counted -- and every other door.

A checks() that asserts nothing is a checks() that passes, so the number of
checks it performs is counted from its source and a zero is refused.

`call_model` below is the OTHER half, and it is here because it is the same
machinery: a model's own exception has to become a BuildError, and the message
has to name the line in the MODEL rather than a line of ours. `MODEL_DOORS`
lists where that is done per site; `raised_by_the_model` is what makes the
answer hold at the sites nobody wrapped -- wherever the author's own code left
a python frame to find, and no further than that.
"""

from pathlib import Path
import ast
import collections
import inspect
import operator
import os
import textwrap

from . import paths
from .errors import BuildError
# Rendering a value the model wrote, for a message of ours. Nothing in this
# file calls `repr()` or `str()` on one itself where the result reaches a
# message: a `__repr__` with a bug in it would then raise out of the `except`
# that is building the refusal. See `modeltext` for what those promise and,
# just as much, for what they do not.
from .modeltext import (MAX_MESSAGE_CHARS, shown, shown_and_rewritten,
                        shown_text)

# This package's own directory. A frame inside it is the HUB running, and the
# author of a model cannot act on its line number -- see `fail_site`.
_PACKAGE_DIR = Path(__file__).resolve().parent


# WHERE THE BUILD CALLS INTO A model.py, named once. Each entry is `(what the
# message calls it, the site)`, and the SITE IS DERIVED RATHER THAN DESCRIBED:
# it is `<module>.<function>` of the frame the BuildError left the door by, plus
# `/<module>.<function>` of the guarded callable when that callable is one of
# ours rather than the model's own. `tests/cadbuild/test_model_doors.py` reads
# both out of a real traceback, so a string here that stops matching where the
# guard actually is fails, and a door whose guard is deleted fails with it.
#
# WHAT A DOOR BUYS IS THE MESSAGE, and that is the whole of what it is for.
# `parts() raised TypeError (model.py:5): ...` names the entrance and the line
# the author has to open; the handler on `build.build` can only say that the
# model's own code raised something. Both end in EXIT_BUILD_FAILED -- "the model
# said no" -- rather than EXIT_CRASHED, which the hub reports to whoever pushed
# as "the build crashed".
#
# TWO OF THEM BUY THE EXIT CODE AS WELL, and they are the pair round `as_shape`
# and `as_shapes`. An object the model handed over raises inside the CAD kernel,
# not inside model.py, so there is no frame under the project root and
# `raised_by_the_model` answers False for a fault that is entirely the author's
# -- an empty stack asked for its one body, say. Round those two the door is the
# only thing that answers.
#
# THE LIST WAS ONCE MUCH LONGER, and it was shortened deliberately on
# 2026-09-07 rather than left to rot. It carried a door round the hub's own
# READING of every container a model hands back, and one round every attribute
# lookup on the model module. Those were written for an ADVERSARY -- a model.py
# fighting the hub -- and there is no adversary in this system: model.py is the
# owner's own code, pushed with the owner's own secret, from the owner's own
# repository (AGENTS.md, "код владельца"; SPEC 7.9). What they cost meanwhile
# was real and landed on the person the hub is for: a door round OUR OWN code
# reports OUR bug to the author as "the model said no". So this list holds
# calls INTO a model, and nothing else.
#
# TWO ENTRIES DO NOT GIVE THEIR ANSWER THROUGH `call_model`, and say why in
# their own docstrings: `geometry.load_model` (through `model_site`, which has
# no model frame to name when there is no model.py) and `run_checks` below (its
# own catching, so it can tell an AssertionError and a SystemExit apart).
MODEL_DOORS = (
    ("importing model.py", "geometry.load_model"),
    ("parts()", "parts.read_catalogue"),
    ("views()", "build.build"),
    ("reading a shape model.py handed over",
     "geometry.as_shape/geometry._first_body"),
    ("reading a shape model.py handed over",
     "geometry.as_shapes/geometry._every_body"),
    ("checks()", "modelchecks.run_checks"),
)


# One frame, reduced to the two things anything here asks of it. Named rather
# than a bare tuple so `_named` below reads the same as it did against
# `traceback.FrameSummary`.
_Frame = collections.namedtuple("_Frame", "filename lineno")


def _frames(exc):
    """The traceback as filenames and line numbers, TOUCHING NO SOURCE FILE.

    `traceback.extract_tb` is what this replaces, and nothing here wants what
    that function adds: it looks the source LINE up for every frame, through
    `linecache`, and the two readers below print a file and a number
    (`_named`) or compare a path (`raised_by_the_model`). Walking `tb_next`
    reads `co_filename` and `tb_lineno`, which the interpreter already holds,
    and opens no file at all.
    """
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        frames.append(_Frame(tb.tb_frame.f_code.co_filename, tb.tb_lineno))
        tb = tb.tb_next
    return frames


def _named(frame):
    """` (model.py:123)` for one frame of a traceback."""
    return f" ({Path(frame.filename).name}:{frame.lineno})"


def model_site(exc):
    """` (model.py:123)` for the deepest frame OUTSIDE this package, or ``.

    THE DEEPEST FRAME IS USUALLY OURS AND IS THE WRONG ONE TO NAME. A model
    writing `checklib.estimated(0.25, "...")` with a bad note raises inside
    `checklib.Number.__new__`, so the plain last frame made the message read
    `checks() raised ValueError (checklib.py:217)` -- a file the author did not
    write, cannot open and did not break, for a mistake sitting on one line of
    their own model. What they need is that line.

    So the frames belonging to this package are dropped and the deepest of what
    is left is named. Frames BELOW us are left alone: a model that breaks inside
    cadquery is still reported at the cadquery line, exactly as before, because
    there is no rule here that could tell a kernel frame from the model's own
    helper module -- and pretending to would be inventing a project boundary
    this file has no way to know.

    IT SAYS NOTHING RATHER THAN NAMING ONE OF OURS, which is the whole
    difference between this and `fail_site` below, and it is why the import door
    calls this one. `geometry.load_model` fails with no model frames at all when
    there is no model.py to import: every frame is ours, and a fallback there
    would answer `importing model.py failed (geometry.py:<line>)` -- pointing the
    author of a missing file at a file of the hub's, which is the exact defect
    the frame-dropping above exists to end.
    """
    frames = [frame for frame in _frames(exc)
              if Path(frame.filename).parent.resolve() != _PACKAGE_DIR]
    return _named(frames[-1]) if frames else ""


def fail_site(exc):
    """`model_site`, falling back to the deepest frame of ours when it is silent.

    EVERY DOOR BUT THE IMPORT CALLS THIS, and the import is why there are two
    functions at all. `call_model` below uses it for everything it guards, and
    `run_checks` below uses it on all three of its failure paths for `checks()`;
    the IMPORT door does neither of those things -- it is not below,
    it is `geometry.load_model`, and it calls `model_site` for the reason the
    last paragraph of that function gives. Where the others ARE concerned
    the model really is on the stack by the time it has been opened: whatever
    comes back names something, and naming a file of ours is better than naming
    nothing at all when the fault is ours to begin with. `call_model` catching a
    package function called straight from `call_model` is the shape that reaches
    the fallback in practice, and without it `(outside)[-1]` raises IndexError
    INSIDE the except handler -- which REPLACES the BuildError being built, so
    the build ends in EXIT_CRASHED (4) instead of EXIT_BUILD_FAILED (3).

    WHAT THE FRAME-DROPPING COSTS, said plainly and measured rather than
    argued: a bug in this package raised while the model is running is reported
    at the model's line, and NO FILE OF OURS IS NAMED ANYWHERE. This paragraph
    used to claim the exception type and its text still named the file when the
    fault was the hub's; they do not -- `parts() raised TypeError
    (model_y.py:5): 'NoneType' object is not iterable` is the whole of the
    message a hub bug on ordinary model data produces. The trade is still the
    right one, for a different reason than the one written here before: the line
    named is the model's own call INTO this package, which is where anybody
    debugging either fault starts reading, and a hub-to-model callback resolves
    to the model's line correctly besides. What is given up is a traceback --
    and the reader of a build log is not the person who can act on one.
    """
    site = model_site(exc)
    if site:
        return site
    frames = _frames(exc)
    if not frames:
        return ""
    return _named(frames[-1])


def raised_by_the_model(exc):
    """Is a frame from inside the project's own tree on this traceback?

    THE QUESTION THE EXIT CODE TURNS ON WHEREVER IT CAN BE ASKED, asked once at
    the top of the build instead of at every place somebody remembered.
    `build.build` is the caller: an exception with a model frame under it
    becomes a `BuildError` (EXIT_BUILD_FAILED -- "the model said no"), and one
    without keeps travelling and ends as EXIT_CRASHED -- "the build crashed",
    which is ours to look at. It is what carries the answer at every site nobody
    wrapped, and it does not care how the value was reached.

    A SUFFICIENT CONDITION AND NOT A NECESSARY ONE, which is the whole of what
    it may be relied on for. True means the fault is the author's; FALSE MEANS
    NOTHING. The ordinary way to reach a False that is wrong needs no trick at
    all: a model hands over an object, the CAD kernel raises while working with
    it, and every frame on the traceback belongs to cadquery or to us. That is
    why `as_shape` and `as_shapes` carry doors of their own -- see the comment
    on `MODEL_DOORS`.

    THE PROJECT'S TREE AND NOT "OUTSIDE THIS PACKAGE", which is the difference
    between this and `model_site` above and is why there are two predicates.
    `model_site` NAMES a frame, so it drops the hub's and takes whatever is
    left -- a cadquery frame included, because there is no way to tell a kernel
    frame from a helper module of the model's. Deciding blame that way would
    hand a hub bug that fails inside matplotlib to the author as "the model said
    no". Only the project's own tree is the model's own code, and a hub bug
    cannot have a frame there unless the hub was running model code, which is
    exactly when it IS the author's fault.

    An ABSOLUTE path is required, so `<string>`, `<frozen importlib._bootstrap>`
    and the rest of the interpreter's bracketed pseudo-filenames are not model
    frames -- they resolve relative to the working directory, which during a
    build IS the project root, and would otherwise make an import failure of the
    hub's read as the author's mistake.
    """
    try:
        root = paths.project_root()
    except BuildError:
        # No project root means no project tree to be inside of. Not reachable
        # from `build`, which has already read project.json by then.
        return False
    return any(_inside(frame.filename, root) for frame in _frames(exc))


def _inside(filename, root):
    """Is this frame's file under `root`? Two spellings of the path, no raises.

    THE NAME FIRST, THEN THE REAL PATH, and the second is not belt and braces:
    `root` is resolved (`paths.set_project_root`) while a frame carries whatever
    string the import used, and on a host where the project sits under a
    symlinked directory the two disagree for every file of the model's --
    `/var/folders/...` against `/private/var/folders/...` on macOS, measured. A
    predicate that missed that would answer "not the model's" for the whole
    tree, which is the safe direction only in the sense that it silently gives
    back what this handler exists to provide.

    `realpath` and not `resolve`: it normalizes a name that is not there rather
    than raising, and a `co_filename` need not name a file that exists.

    `test_a_frame_reached_through_a_symlink_is_still_the_models_own` is what
    holds the line, in both directions. It builds the link itself rather than
    waiting for a host that has one, which is the whole reason it exists:
    reached only through the ambient filesystem, this branch runs on a
    developer's macOS and never on Linux CI, so deleting it left the suite
    green.
    """
    if not os.path.isabs(filename):
        return False
    try:
        if Path(os.path.normpath(filename)).is_relative_to(root):
            return True
        return Path(os.path.realpath(filename)).is_relative_to(root)
    except (OSError, ValueError):
        return False


def call_model(name, func, *args):
    """Call one function of the model's, and answer for it in BuildError terms.

    THE RULE IS UNIVERSAL OR IT IS NOTHING, and it was not: `checklib.measured`,
    `derived` and `estimated` refuse a bad note with a ValueError, and the whole
    point of refusing there is that the build then blames the MODEL. Only the
    import (in `geometry.load_model`) and `checks()` (in `run_checks` below)
    turned that ValueError into a BuildError, so the identical typo written
    inside `parts()` or `views()` left a bare
    ValueError travelling out of the build process as EXIT_CRASHED, which the
    hub reports to whoever pushed as "the build crashed". A note with a typo in
    it then looked exactly like OCCT falling over, which is precisely the
    diagnosis the refusal exists to give.

    A BuildError is re-raised untouched: everything below this call that refuses
    the catalogue or a view already speaks in those terms, and wrapping one
    again would prefix a considered message with "parts() raised BuildError".

    `BaseException` is deliberately NOT caught. `SystemExit` from a model is
    already terminal on every path -- `buildproc.child` catches BaseException and
    ends the build as EXIT_CRASHED -- so there is no green-and-published outcome
    to guard against here, which is the one thing that earns `run_checks` its
    own SystemExit branch below.

    THE EXCEPTION'S OWN TEXT IS AUTHOR PROSE and reaches the build log through
    `modeltext`: a message written across three lines would otherwise turn one
    refusal into what reads as three, and `MAX_MESSAGE_CHARS` rather than the
    note ceiling because `checklib._text_problem` answers a bad note in about
    300 characters and the actionable half is the second half.
    """
    try:
        return func(*args)
    except BuildError:
        raise
    except Exception as exc:
        raise BuildError(f"{name} raised {type(exc).__name__}{fail_site(exc)}: "
                         f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}") from exc


# Expressions that build a list of problems out of something this cannot read
# statement by statement. A comprehension is a loop, a conditional expression
# is a branch; either can hold any number of checks, including none, and the
# honest answer to "how many" is that it is not visible from here.
UNCOUNTABLE_NODES = (ast.ListComp, ast.SetComp, ast.DictComp,
                     ast.GeneratorExp, ast.IfExp)


def opaque_verdict(node):
    """Does this `return` hand back a verdict of a size we cannot see?

    `return ["..."]` is a verdict written out by hand: a real check, whose
    count is not a number of statements. `return [p for p in problems if p]`
    and `return problems if strict else []` are the same thing through a loop
    and through a branch. `return`, `return None` and `return problems` say
    nothing either way -- what filled `problems` is what counts, and that is
    counted separately.
    """
    if node is None:
        return False
    if isinstance(node, UNCOUNTABLE_NODES):
        return True
    return isinstance(node, (ast.List, ast.Tuple, ast.Set)) and bool(node.elts)


def _reraises(tree):
    """ids of the `raise` statements that sit inside an `except` block.

    Re-raising, or turning one exception into another with a better message.
    Error handling around a check is not a second check, and counting it as one
    inflates the number this prints. It is only ever taken *away* from the
    count, so it can never invent a check that is not there -- but it can drive
    the count to zero, and zero fails the build, so the caller treats a body
    whose only raises were these as uncountable rather than as empty.
    """
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ExceptHandler):
            for inner in ast.walk(node):
                if isinstance(inner, ast.Raise):
                    out.add(id(inner))
    return out


def _collected_names(tree):
    """Names that end up in a `return` -- the problem lists of this function.

    Anything pushed into one of them is a check reporting itself, which is the
    other half of how checks are written.
    """
    returns = [n for n in ast.walk(tree) if isinstance(n, ast.Return)]
    names = {name.id
             for node in returns if node.value is not None
             for name in ast.walk(node.value) if isinstance(name, ast.Name)}
    return returns, names


def _fills_list(node, collected):
    """Is this statement a check writing its verdict into the returned list?

    Three spellings, all of them real and all of them in use:

        problems += checklib.mating_face_flat(...)   AugAssign
        problems.append("...")                       Call on the list
        problems = checklib.mating_face_flat(...)    Assign whose value calls out

    The last one is the one that used to be missed, and missing it was not a
    wrong number but a red build: `problems = checklib.mating_face_flat(...)`
    followed by `return problems` counted zero, and zero is refused below.
    """
    if isinstance(node, ast.AugAssign):
        return isinstance(node.target, ast.Name) and node.target.id in collected
    if isinstance(node, ast.Assign):
        targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if not any(t in collected for t in targets):
            return False
        # `problems = []` sets the thing up; `problems = f()` is the check.
        return any(isinstance(inner, ast.Call) for inner in ast.walk(node.value))
    return False


def _opaque_fill(node, collected):
    """Is this statement putting problems in the list in a way we cannot count?

    `problems = ["the wall is thin"] if thin else []` is a real check and holds
    no call at all, so the counter above says no and the count came out zero --
    and zero is a failed build. Same for a comprehension. Neither can be
    counted, and neither is nothing.
    """
    if not isinstance(node, ast.Assign):
        return False
    targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
    if not any(t in collected for t in targets):
        return False
    if isinstance(node.value, UNCOUNTABLE_NODES):
        return True
    # `problems = []` is setup and says nothing; `problems = ["..."]` is a
    # verdict written out by hand.
    return (isinstance(node.value, (ast.List, ast.Tuple, ast.Set))
            and bool(node.value.elts))


def count_checks(func):
    """How many checks the function's source holds -- in either style.

    Checks get written two ways, and the count has to see both. `assert` is
    one, and `raise` with it. The other is a list of problems built up and
    handed back, where the checks are the statements that fill it; counting
    only asserts reports a bare `passed` for those and hides that the number
    might be zero.

    The number is of check *sites* in this function: one
    `problems += checklib.pairwise_interference(...)` is one, whatever it looks
    at, and a helper called from here contributes none of its own.

    Returns None when the number cannot be known -- no source (a C function, an
    exec'd module), a verdict written out as a literal, a comprehension or a
    conditional expression standing in for the list, or a body that calls
    things this cannot recognise as check sites: a helper handed the problem
    list to fill, `return checklib.mating_face_flat(...)`, a loop over a table of
    checks. The caller prints "count unknown" for that.

    Zero is reserved for a body with no call, no assert and no raise anywhere
    in it -- a function that demonstrably does nothing. That distinction is the
    whole point: this file is shared by every project in the organisation, and
    a wrong "empty checks()" would go red on somebody's working model, which is
    far more expensive than failing to print a number. Every rule here is
    written so that an unreadable body ends at None and never at 0.
    """
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    except (OSError, TypeError, SyntaxError):
        return None

    returns, collected = _collected_names(tree)
    reraises = _reraises(tree)

    total = 0
    calls = False
    unknown = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Assert):
            total += 1
        elif isinstance(node, ast.Raise):
            if id(node) in reraises:
                # `raise` inside `except` is this function handling an error,
                # not checking the model. Not a check -- but not proof of an
                # empty body either, so it keeps the answer off zero.
                unknown = True
            else:
                total += 1
        elif _fills_list(node, collected):
            total += 1
        elif _opaque_fill(node, collected):
            unknown = True
        elif isinstance(node, ast.Call):
            attribute = node.func.attr if isinstance(node.func, ast.Attribute) else ""
            target = node.func.value if isinstance(node.func, ast.Attribute) else None
            if (attribute in ("append", "extend")
                    and isinstance(target, ast.Name) and target.id in collected):
                total += 1
            else:
                # Something is being called. Whatever it does, it is not
                # nothing -- so the answer below is "cannot count", never zero.
                calls = True

    if total:
        return total
    if calls or unknown or any(opaque_verdict(node.value) for node in returns):
        return None
    return 0


# --------------------------------------------------------------------------
# Asserts the constants settle on their own
# --------------------------------------------------------------------------
#
# `count_checks` above counts check SITES, and an assert whose both sides are
# module constants is a site that proves nothing: it holds however the geometry
# came out, and it goes on holding after the model has drifted away from it.
# What follows finds those, and the caller WARNS about each and takes them off
# the number it prints.
#
# IT NEVER REFUSES A BUILD, and that is the whole shape of it. `assert FIT_MIN <
# FIT_MAX` is a deliberate guard on the parameter table and is the identical
# shape; this file is shared by every project in the organisation, and a false
# red on somebody's working model costs far more than an unprinted number.
# Every rule here ends at "nothing to say".

# The sentinel `static_value` answers with. An object rather than None, because
# None is a value an expression can honestly have -- `assert X is None` decided
# by a constant is exactly the shape being looked for.
NOT_STATIC = object()

# Builtins an assert may call and still be decidable from the source. Pure,
# total, and cheap: nothing here can have a side effect or refuse to return.
STATIC_BUILTINS = {"abs": abs, "min": min, "max": max, "round": round, "len": len}

# The biggest exponent a static `**` may carry. `2 ** 10 ** 10` is a legal
# expression and evaluating it is how this analysis would hang a build.
MAX_STATIC_POW = 64

# What a name may hold and still settle an expression. A tuple of them too: a
# model writes `SIZES = (10, 20)` and asks `len(SIZES) == 2`.
_STATIC_TYPES = (bool, int, float, str, type(None))

_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg,
              ast.Not: operator.not_}

# `LShift` and `RShift` are deliberately absent. The exponent cap above is
# named for `**` alone, and `1 << 10 ** 10` is the same bomb through a door
# that cap does not watch. Leaving them out costs a warning nobody would have
# written and buys the guarantee that nothing here can be slow.
_BINARY_OPS = {ast.Add: operator.add, ast.Sub: operator.sub,
               ast.Mult: operator.mul, ast.Div: operator.truediv,
               ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
               ast.Pow: operator.pow, ast.BitOr: operator.or_,
               ast.BitXor: operator.xor, ast.BitAnd: operator.and_}

# `Is` and `IsNot` are deliberately absent: identity between two literals is
# decided by what the interpreter happened to intern, which is not a fact about
# the source.
_COMPARE_OPS = {ast.Eq: operator.eq, ast.NotEq: operator.ne,
                ast.Lt: operator.lt, ast.LtE: operator.le,
                ast.Gt: operator.gt, ast.GtE: operator.ge,
                ast.In: lambda a, b: a in b,
                ast.NotIn: lambda a, b: a not in b}


def _bounded(value):
    """`value`, or NOT_STATIC when carrying it any further is the hazard.

    The ceiling is `MAX_STATIC_POW` used as an exponent of two, so that the one
    number this file declares is the one number that decides how big anything
    here may get. It is about the MAGNITUDE of a number and about nothing else.

    A LARGE SEQUENCE IS DELIBERATELY NOT GUARDED HERE, and the ceiling above
    never was one: `"x" * BIG` is already built by the time its length could be
    measured, so a branch measuring it costs the allocation and prevents
    nothing. The boundary against a model that allocates is the separate build
    process -- `rlimit`, the watchdog, the SIGKILL (SPEC §7.9) -- and not a
    check running inside it.
    """
    ceiling = 2 ** MAX_STATIC_POW
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if abs(value) > ceiling:
                return NOT_STATIC
        except (OverflowError, ValueError):
            return NOT_STATIC
    return value


def _applied(func, *args):
    """`func(*args)`, or NOT_STATIC when it will not answer.

    THE BLANKET CATCH IS THE POINT and is not this file's usual style. The
    operands are values out of the model's own module, and every way arithmetic
    can refuse -- a division by zero, a str beside an int, a comparison between
    two types that do not order, a result too big to build -- is the same answer
    here: not decidable from the source. Enumerating them would be a list that
    goes stale into a raise, and a raise from here travels out of a function
    whose whole promise is that it never refuses a build.
    """
    try:
        return _bounded(func(*args))
    except Exception:
        return NOT_STATIC


def _from_the_module(value):
    """Is this something a name may hold and still settle an expression?"""
    if isinstance(value, _STATIC_TYPES):
        return True
    return (isinstance(value, tuple)
            and all(isinstance(item, _STATIC_TYPES) for item in value))


def local_names(tree):
    """Every name the function binds itself.

    A name bound in here is NOT a constant, whatever the module has under the
    same spelling -- `gap` in `for axis, gap in (...)` shadows a `gap` at the
    top of model.py, and reading the module's one is how this analysis would
    call a real check a tautology. THAT IS THE MAIN SOURCE OF FALSE POSITIVES,
    so this covers more forms than are obvious: assignment in all three
    spellings and through tuple unpacking, loop targets, `with ... as`,
    comprehension targets, the walrus, `except ... as`, parameters, the three
    binders a `match` pattern can carry (`case WALL:`, `case [*REST]:`,
    `case {**REST}:`) -- and nested `def`/`class` names, imports, and
    `global`/`nonlocal` declarations, each of which puts a name in this body
    that the module dict may also hold.

    Subscripts and attributes on the left of an `=` contribute their names too
    (`table[i] = x` yields `table` and `i`). They are not bindings, and
    counting them is deliberate: the cost is a warning not printed, and the
    alternative cost is a warning printed about a working model.
    """
    names = set()

    def bound(target):
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                names.add(node.id)

    def parameters(args):
        names.update(node.arg for node in ast.walk(args)
                     if isinstance(node, ast.arg))

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                bound(target)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign, ast.NamedExpr)):
            bound(node.target)
        elif isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            bound(node.target)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars is not None:
                    bound(item.optional_vars)
        elif isinstance(node, ast.ExceptHandler):
            if node.name:
                names.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            # A capture pattern binds as surely as an `=` does, and `_` is a
            # MatchAs with no name at all -- hence the guard.
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
            parameters(node.args)
        elif isinstance(node, ast.Lambda):
            parameters(node.args)
        elif isinstance(node, ast.ClassDef):
            names.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names.update(node.names)
    return names


def static_value(node, constants):
    """The value of an expression decidable from `constants`, or NOT_STATIC.

    NOT_STATIC is a sentinel object rather than None, because None is a value an
    expression can honestly have.

    What is accepted is deliberately small: a literal, a name the module holds a
    scalar or a tuple of scalars under, the unary operators, arithmetic, a
    comparison (chained included, short-circuited the way Python does it), `and`
    / `or`, a tuple or list of static elements, and a call to one of
    STATIC_BUILTINS with arguments that are themselves static. EVERYTHING ELSE
    IS NOT_STATIC -- an attribute, a subscript, an f-string, a call to anything
    of the model's own. A name that resolves to NOT_STATIC in `constants` is one
    the function binds itself (see `static_asserts`), and is refused for the
    builtins too: a model that defines its own `min` is not calling this one.
    """
    if isinstance(node, ast.Constant):
        return _bounded(node.value)

    if isinstance(node, ast.Name):
        value = constants.get(node.id, NOT_STATIC)
        return value if _from_the_module(value) else NOT_STATIC

    if isinstance(node, ast.UnaryOp):
        func = _UNARY_OPS.get(type(node.op))
        if func is None:
            return NOT_STATIC
        operand = static_value(node.operand, constants)
        if operand is NOT_STATIC:
            return NOT_STATIC
        return _applied(func, operand)

    if isinstance(node, ast.BinOp):
        func = _BINARY_OPS.get(type(node.op))
        if func is None:
            return NOT_STATIC
        left = static_value(node.left, constants)
        right = static_value(node.right, constants)
        if left is NOT_STATIC or right is NOT_STATIC:
            return NOT_STATIC
        if isinstance(node.op, ast.Pow) and not _small_exponent(right):
            return NOT_STATIC
        return _applied(func, left, right)

    if isinstance(node, ast.Compare):
        left = static_value(node.left, constants)
        if left is NOT_STATIC:
            return NOT_STATIC
        for op, side in zip(node.ops, node.comparators):
            func = _COMPARE_OPS.get(type(op))
            right = static_value(side, constants)
            if func is None or right is NOT_STATIC:
                return NOT_STATIC
            outcome = _applied(func, left, right)
            if outcome is NOT_STATIC or not outcome:
                return outcome
            left = right
        return True

    if isinstance(node, ast.BoolOp):
        wants_all = isinstance(node.op, ast.And)
        value = NOT_STATIC
        for side in node.values:
            value = static_value(side, constants)
            if value is NOT_STATIC:
                return NOT_STATIC
            if bool(value) is not wants_all:
                # `and` stops at the first falsy operand and `or` at the first
                # truthy one, and both hand back that operand rather than a
                # bool. Anything after it is never evaluated, so it need not be
                # decidable.
                return value
        return value

    if isinstance(node, (ast.Tuple, ast.List)):
        elements = []
        for element in node.elts:
            value = static_value(element, constants)
            if value is NOT_STATIC:
                return NOT_STATIC
            elements.append(value)
        return _bounded(tuple(elements) if isinstance(node, ast.Tuple)
                        else elements)

    if isinstance(node, ast.Call):
        if node.keywords or not isinstance(node.func, ast.Name):
            return NOT_STATIC
        name = node.func.id
        if name not in STATIC_BUILTINS or name in constants:
            return NOT_STATIC
        arguments = []
        for argument in node.args:
            value = static_value(argument, constants)
            if value is NOT_STATIC:
                return NOT_STATIC
            arguments.append(value)
        return _applied(STATIC_BUILTINS[name], *arguments)

    return NOT_STATIC


def _small_exponent(value):
    """Is this an exponent `**` may be worked out with? See MAX_STATIC_POW."""
    return isinstance(value, (int, float)) and abs(value) <= MAX_STATIC_POW


def static_asserts(func, namespace):
    """`[(lineno, source)]` for the asserts whose truth the constants settle.

    `namespace` is the model module's own `vars()`. Line numbers are the ones
    in model.py, so an author can open the line; the source is the assert as
    they wrote it, with its whitespace collapsed -- a `warning:` line at the
    start of a log line is read as a verdict by tooling, and an assert written
    across four lines would turn one note into four.

    `[]` when the source cannot be read -- a `checks` that is not a python
    function, one built by `exec`, a file that has moved since it was imported.
    NEVER AN EXCEPTION: this runs on a build whose checks have already passed,
    and nothing about a printed note is worth failing that build over.

    THE CATCH IS BLANKET AND COVERS THE ANALYSIS ITSELF, not just the reading,
    which is what makes the promise above true rather than intended. `_applied`
    above is the precedent and the argument is the same one: enumerating the
    ways an analysis of somebody else's source can refuse is a list that goes
    stale into a raise. It went stale here -- `static_value` recurses by
    expression DEPTH, so about twelve hundred nested terms in one assert raise
    RecursionError, which is neither OSError, TypeError nor SyntaxError. That
    escaped into `run_checks` AFTER every check of the model had passed and
    turned a green build into a crash, for a printed note. "Could not work it
    out" means "found nothing", on every path.
    """
    try:
        lines, first = inspect.getsourcelines(func)
        source = textwrap.dedent("".join(lines))
        tree = ast.parse(source)

        # The locals go in as the sentinel rather than being kept in a second
        # set: one lookup then answers both questions a name raises -- "what
        # does the module hold" and "did this body bind it first" -- and the
        # builtins branch of `static_value` gets the same answer for free.
        constants = dict(namespace)
        for name in local_names(tree):
            constants[name] = NOT_STATIC

        found = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assert):
                continue
            if static_value(node.test, constants) is NOT_STATIC:
                continue
            text = ast.get_source_segment(source, node) or ""
            found.append((first + node.lineno - 1, " ".join(text.split())))
        return found
    except Exception:   # advisory analysis: it may find nothing, never fail a build
        return []


# Seconds. A section shorter than this gets one shared line at the bottom
# instead of a line of its own. THE NUMBER IS THE PRECISION OF THE COLUMN BESIDE
# IT: the rows print as `%.1f`s, like every other timing this build prints
# (assembly.render_previews, views.export_views), so anything under 0.1 s comes
# out as `0.0s` and says only that it existed. A model marking a section inside
# a loop can produce dozens of those, and dozens of `0.0s` rows would bury the
# one row the table is read for.
SECTION_FLOOR = 0.1


def print_check_sections():
    """Print what each `checklib.section(...)` block of checks() cost.

    THE CORE PRINTS THIS, NOT THE MODEL, and that placement is the feature: the
    call site is wrapped in try/finally, so the table comes out of a build that
    FAILED its checks as well -- which is the log anybody reads. A model that
    printed its own timings would print them only on the runs that got that far.

    Longest first, because the question is always which one to look at. Sections
    below SECTION_FLOOR collapse into one line: their count is what matters
    (twelve tiny sections is a shape worth seeing), not twelve labels.

    checklib is imported HERE rather than at module level so this reaches the
    module the MODEL filled. The model's own `import checklib` may be what loads
    it, through the shim at the repository root, and there must be exactly one
    module: two would mean the model records into one and this reads the other,
    printing an empty table for a run that measured itself (the same trap
    `geometry._warn_if_checklib_shadowed` exists for).
    """
    from . import checklib

    recorded = checklib.recorded_sections()
    if not recorded:
        return
    ranked = sorted(recorded.items(), key=lambda item: item[1], reverse=True)
    # Sorted descending, so everything at or above the floor comes first and the
    # rest is the tail -- no second pass, and the two halves cannot disagree.
    named = [row for row in ranked if row[1] >= SECTION_FLOOR]
    rest = ranked[len(named):]

    print("check sections:")
    for label, seconds in named:
        # THE LABEL IS THE MODEL'S, and it is the one field of this table that
        # is. `checklib.section(label)` refuses a non-string and scans it for
        # nothing else, so a label with a newline in it turns one row into two
        # and a table read as a ranking into a list nobody can rank -- on the
        # build that already failed, which is the log somebody is reading.
        print(f"  {shown_text(label)}: {seconds:.1f}s")
    if rest:
        print(f"  other {len(rest)} sections: "
              f"{sum(seconds for _, seconds in rest):.1f}s")


# What the hub says when it rewrote a check's own words, and the whole of what
# turns a silent mangling into a trade an author can act on. It is ONE sentence
# under the whole list rather than one per problem: what an author needs to know
# is that the hub did this and how to stop it, and repeating that under four
# messages would bury the four messages.
#
# INDENTED LIKE THE PROBLEMS ABOVE IT and deliberately NOT prefixed `warning:` --
# the build is already failing on the check itself, and a second prefix in a
# refusal would read as a second verdict.
#
# IT IS A HINT AND NOT A VERDICT, WHICH IS JUST AS WELL: a check may return this
# very text as a problem of its own, and the copy would differ from the real one
# by the `  - ` prefix alone. Nothing here can tell the two apart, so nothing
# here should be written as though it could -- what the escape defends is the
# START of a line, and this sentence is not load-bearing for that.
_ESCAPE_NOTE = (
    "\n  (the hub rewrote a line break or an invisible character in the "
    "text above. A build-log line beginning `warning:` is read as a verdict "
    "by tooling, so a check's own words are shown on one line; write the "
    "message as one line to choose how it reads.)")


def checks_call_args(checks, out_dir):
    """Nothing, or the build directory -- whichever the signature asks for.

    The contract is zero or exactly one parameter, and the directory goes over
    positionally. Keyword-only parameters count towards that one: a signature
    like `def checks(*, out_dir)` asks for an argument no positional call can
    fill, and waving it through means a bare TypeError blamed on this file
    instead of a word about the contract it broke.

    `(TypeError, ValueError)` is what the documentation for `inspect.signature`
    names, and an argumentless call is the right answer to both -- the contract
    is zero or one parameter, and a signature nobody can read is not evidence of
    the one.
    """
    try:
        params = list(inspect.signature(checks).parameters.values())
    except (TypeError, ValueError):
        return ()
    accepted = [p for p in params
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD,
                              p.KEYWORD_ONLY)]
    required = [p for p in accepted if p.default is inspect.Parameter.empty]
    # A parameter name reaching these messages is a real identifier:
    # `inspect.Parameter` refuses a name that is not one, and that is what makes
    # it safe to print without going through `modeltext` -- an identifier holds
    # no newline and nothing invisible.
    if len(required) > 1:
        raise BuildError(
            f"checks() asks for {len(required)} arguments "
            f"({', '.join(p.name for p in required)}). It must take "
            "either none, or exactly one -- the build directory."
        )
    if required and required[0].kind is inspect.Parameter.KEYWORD_ONLY:
        name = required[0].name
        raise BuildError(
            f"checks() asks for {name!r} keyword-only, and the build "
            f"directory is passed positionally. Write it as `def "
            f"checks({name})`, or take no arguments at all."
        )
    positional = [p for p in accepted
                  if p.kind is not inspect.Parameter.KEYWORD_ONLY]
    return (out_dir,) if positional else ()


def describe_returned(result):
    """Name what came back -- and, for a list, the element that spoils it.

    Saying just `list` sends the author to inspect the container when the
    container was right all along and one element in it is an int.
    """
    kind = type(result).__name__
    if isinstance(result, (list, tuple)):
        for item in result:
            if not isinstance(item, str):
                return f"a {kind} containing {type(item).__name__}"
    return kind


# What run_checks answers with: how many checks passed, and how many of the
# counted sites the constants settled on their own. `passed` is None for TWO
# reasons -- the body could not be counted, and every site that was counted
# turned out to be settled by the constants (see run_checks) -- so a caller has
# to tell "none" from "unknown" either way and a bare number was never enough.
CheckReport = collections.namedtuple("CheckReport", "passed static")


def run_checks(model, out_dir):
    """Run the model's own checks(), the project-specific half of the gate.

    Returns a CheckReport: how many checks passed -- None when the body could
    not be counted (see count_checks), and `CheckReport(0, 0)` for a model that
    defines no checks() at all -- beside how many of the counted sites were
    decided by the constants alone (see static_asserts).
    metrics.json carries both numbers so the next build can say that a project
    lost a check, which is a thing that happens quietly during a refactor.

    THE STATIC ONES ARE SUBTRACTED FROM THE NUMBER AND NEVER REFUSE THE BUILD.
    `assert FIT_MIN < FIT_MAX` is a deliberate guard on the parameter table and
    has the identical shape, so each one is a printed note and nothing more.
    When every counted site turns out static the count goes to None -- "count
    unknown" -- rather than to 0, because 0 is the refusal above and this is
    deliberately not one. It mirrors how `_reraises` is subtracted in
    count_checks without being allowed to reach zero.

    Optional: a model.py without checks() builds exactly as it did before.
    Called after the geometry gate and before anything is packed, so a check
    can measure the exported files in out_dir and not only the geometry.

    A check fails by raising (an `assert` with a message is the intended way)
    or by returning a list of strings, one per problem found. Either way it
    becomes a BuildError: the build goes red and nothing gets published.

    A checks() that demonstrably holds no check at all is itself a failure. It
    is the one outcome worse than having no checks(): the log says the model
    was checked and it was not. "Demonstrably" is doing work in that sentence
    -- see count_checks.

    THE CALL IS A DOOR THIS FUNCTION KEEPS ITSELF rather than one of
    `call_model`'s, and the reason is the two branches below it: an
    AssertionError has to be reported as the check's own verdict rather than as
    a crash, and a SystemExit has to be turned into a refusal instead of
    unwinding past the packing with the build still green. `call_model` catches
    neither of those specially -- it does not catch `SystemExit` at all -- so
    this is the one entrance where the generic answer is the wrong one.
    """
    checks = getattr(model, "checks", None)
    if checks is None:
        return CheckReport(0, 0)
    if not callable(checks):
        raise BuildError(
            f"model.py defines checks, but it is a {type(checks).__name__}, "
            "not a function")

    count = count_checks(checks)
    if count == 0:
        raise BuildError(
            "checks() is defined but contains no check: no assert, no raise, "
            "nothing filling the list it returns, not even a call to anything. "
            "An empty checks() is worse than none -- every run prints that the "
            "checks passed, for a model nothing looked at. Write the checks, "
            "or delete the function."
        )

    args = checks_call_args(checks, out_dir)
    try:
        result = checks(*args)
    except AssertionError as exc:
        # Show the assert that blew up, not a traceback: the message and the
        # line it came from are the whole point of writing checks as asserts.
        # `str(exc)` runs the model's code -- an assert message is often an
        # f-string over the author's own objects -- so it is `shown` that calls
        # it, and `.strip()` comes afterwards because there is nothing to strip
        # until then.
        message = shown(exc, str, limit=MAX_MESSAGE_CHARS).strip()
        if not message:
            message = "assertion failed (no message given)"
        raise BuildError(f"check failed{fail_site(exc)}: {message}") from exc
    except SystemExit as exc:
        # SystemExit is a BaseException, so `except Exception` below never sees
        # it: left alone it unwinds straight past pack() and post(). With code
        # 0 that is the worst outcome there is -- a green CI step that
        # published nothing. A check reports by returning or by raising.
        # `repr(exc.code)` is the author's code when the code is an object of
        # theirs, and a raise in here would REPLACE the BuildError being built,
        # ending the build in EXIT_CRASHED for a line the model wrote. Hence
        # `shown`.
        raise BuildError(
            f"checks() called sys.exit({shown(exc.code)}){fail_site(exc)}. "
            "A check reports problems by returning them or by raising; "
            "ending the process here would skip publishing and still leave "
            "the build green."
        ) from exc
    except Exception as exc:
        raise BuildError(f"checks() raised {type(exc).__name__}{fail_site(exc)}: "
                         f"{shown(exc, str, limit=MAX_MESSAGE_CHARS)}") from exc
    finally:
        # AFTER the failure paths above, not instead of them: the timings are
        # most wanted on the build that went red, and a `finally` is the only
        # place that covers the raise as well as the return.
        #
        # NOTHING IN HERE MAY RAISE. An exception leaving a `finally` REPLACES
        # the exception on its way out, so a printing bug would swallow the
        # BuildError naming the check that failed and report itself instead --
        # the build would go red for the wrong reason and the real one would be
        # gone. Hence the blanket catch, which is otherwise not this file's
        # style.
        #
        # AND THE RESCUE PRINT IS WRAPPED TOO, which is the half that was
        # missing: the one realistic way a function whose whole job is printing
        # fails is that WRITING fails -- a closed or broken stdout -- and in
        # exactly that case the `print` in the handler raises the same error
        # again, out of the `finally`, doing the substitution this block exists
        # to prevent. It was reproduced: the build reported `ValueError: I/O
        # operation on closed file` instead of the assert that failed, and a
        # build whose checks all passed went red with nothing wrong in it. The
        # inner handler is deliberately empty -- there is nowhere left to
        # report to, and the timing table is worth nothing against the verdict.
        try:
            print_check_sections()
        except Exception as printing_error:  # never mask the verdict above
            try:
                print(f"warning: the check section timings could not be printed "
                      f"({type(printing_error).__name__}: "
                      f"{shown(printing_error, str, limit=MAX_MESSAGE_CHARS)}). "
                      "The checks themselves are unaffected -- this is the "
                      "timing table only.")
            except Exception:
                pass

    if result is None:
        problems = []
    elif isinstance(result, (list, tuple)) and all(isinstance(x, str) for x in result):
        problems = [x.strip() for x in result if x.strip()]
    else:
        raise BuildError(
            "checks() must return None (assert on failure) or a list of "
            f"strings, one per failed check. It returned {describe_returned(result)}."
        )

    if problems:
        # A PROBLEM STRING IS PROSE THE AUTHOR WROTE TO BE READ, and it is still
        # escaped. What that buys is THIS message's shape: the refusal is a
        # numbered list, one problem per line, and a newline inside any of them
        # turns `3 check(s) failed` into a list of five -- the author's own
        # multi-line message, read as three separate verdicts.
        # `MAX_MESSAGE_CHARS` per problem, because a check reporting a
        # measurement has more to say than a note does.
        #
        # AND THE ESCAPE SAYS SO WHEN IT FIRED, which is the half that makes it
        # a trade rather than a mangling. `checklib` refuses a bad note with
        # several hundred characters of explanation; this used to hand back a
        # rearranged message and not one word saying the hub had touched it.
        #
        # ONE CALL DECIDES BOTH, and it has to be one: the sentence used to be
        # decided by re-rendering the value a second time, so a `__str__` that
        # answers differently on two calls showed one string and reported about
        # another.
        shown_problems = [shown_and_rewritten(p, str, limit=MAX_MESSAGE_CHARS)
                          for p in problems]
        listed = "\n".join(f"  - {text}" for text, _ in shown_problems)
        rewritten = (_ESCAPE_NOTE
                     if any(changed for _, changed in shown_problems) else "")
        raise BuildError(f"{len(problems)} check(s) failed:\n{listed}{rewritten}")

    # `vars(model)` is the module's own namespace: the constants at the top of
    # model.py, which is exactly what "decided by the constants alone" means.
    static = static_asserts(checks, vars(model))
    passed = count
    if passed is not None:
        # `or None` is the "never 0" above: an all-static checks() reports an
        # unknown count, not a refusal.
        passed = (passed - len(static)) or None

    # Say the number when it is known, and say that it is not when it is not.
    # A bare `passed` reads like "many" and can mean "none". The bracket appears
    # only when there is something in it, so a build with nothing to say prints
    # the line it has always printed.
    if passed is not None:
        # "MORE" AND NOT "OF THEM": the static ones have already been taken off
        # `passed`, so they are not among the number the bracket sits beside.
        # "2 of them" next to a 5 that is the REMAINDER says three real checks
        # are left where there are five, and with more static asserts than real
        # ones it prints a bracket whose number is the larger of the two.
        aside = (f" ({len(static)} more decided by the constants alone)"
                 if static else "")
        print(f"checks: {passed} passed{aside}")
    else:
        aside = (f", {len(static)} decided by the constants alone"
                 if static else "")
        print(f"checks: passed (count unknown{aside})")

    # After the count, because they are a note about it. One line each, and each
    # one is a NOTE rather than a verdict -- the build is already green here.
    for lineno, source in static:
        print(f"warning: checks() line {lineno}: `{source}` is decided by the "
              "constants at the top of model.py alone -- it holds no matter "
              "what the geometry came out as, and it will go on holding after "
              "the model has drifted away from it. A check about the shape has "
              "to READ the shape: measure the two faces and compare what came "
              "out. (A deliberate guard on the parameter table -- `assert "
              "FIT_MIN < FIT_MAX` -- is this same shape and is fine; this line "
              "is a note, not a refusal.)")
    return CheckReport(passed, len(static))
