#!/usr/bin/env python3
"""The model's own checks(), run and counted.

A checks() that asserts nothing is a checks() that passes, so the number of
checks it performs is counted from its source and a zero is refused.
"""

from pathlib import Path
import ast
import inspect
import textwrap
import traceback

from .errors import BuildError


def fail_site(exc):
    """` (model.py:123)` for the deepest frame of an exception, or ``."""
    frames = traceback.extract_tb(exc.__traceback__)
    if not frames:
        return ""
    last = frames[-1]
    return f" ({Path(last.filename).name}:{last.lineno})"


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


def checks_call_args(checks, out_dir):
    """Nothing, or the build directory -- whichever the signature asks for.

    The contract is zero or exactly one parameter, and the directory goes over
    positionally. Keyword-only parameters count towards that one: a signature
    like `def checks(*, out_dir)` asks for an argument no positional call can
    fill, and waving it through means a bare TypeError blamed on this file
    instead of a word about the contract it broke.
    """
    try:
        params = list(inspect.signature(checks).parameters.values())
    except (TypeError, ValueError):
        return ()
    accepted = [p for p in params
                if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD,
                              p.KEYWORD_ONLY)]
    required = [p for p in accepted if p.default is inspect.Parameter.empty]
    if len(required) > 1:
        raise BuildError(
            f"checks() asks for {len(required)} arguments "
            f"({', '.join(p.name for p in required)}). It must take either "
            "none, or exactly one -- the build directory."
        )
    if required and required[0].kind is inspect.Parameter.KEYWORD_ONLY:
        name = required[0].name
        raise BuildError(
            f"checks() asks for {name!r} keyword-only, and the build directory "
            f"is passed positionally. Write it as `def checks({name})`, or "
            "take no arguments at all."
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


def run_checks(model, out_dir):
    """Run the model's own checks(), the project-specific half of the gate.

    Returns how many checks passed -- None when the body could not be counted
    (see count_checks), and 0 for a model that defines no checks() at all.
    metrics.json carries the number so the next build can say that a project
    lost a check, which is a thing that happens quietly during a refactor.

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
    """
    checks = getattr(model, "checks", None)
    if checks is None:
        return 0
    if not callable(checks):
        raise BuildError(f"model.py defines checks, but it is a {type(checks).__name__}, "
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
        message = str(exc).strip() or "assertion failed (no message given)"
        raise BuildError(f"check failed{fail_site(exc)}: {message}") from exc
    except SystemExit as exc:
        # SystemExit is a BaseException, so `except Exception` below never sees
        # it: left alone it unwinds straight past pack() and post(). With code
        # 0 that is the worst outcome there is -- a green CI step that
        # published nothing. A check reports by returning or by raising.
        raise BuildError(
            f"checks() called sys.exit({exc.code!r}){fail_site(exc)}. "
            "A check reports problems by returning them or by raising; "
            "ending the process here would skip publishing and still leave "
            "the build green."
        ) from exc
    except Exception as exc:
        raise BuildError(f"checks() raised {type(exc).__name__}{fail_site(exc)}: "
                         f"{exc}") from exc

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
        listed = "\n".join(f"  - {p}" for p in problems)
        raise BuildError(f"{len(problems)} check(s) failed:\n{listed}")

    # Say the number when it is known, and say that it is not when it is not.
    # A bare `passed` reads like "many" and can mean "none".
    print(f"checks: {count} passed" if count is not None
          else "checks: passed (count unknown)")
    return count
