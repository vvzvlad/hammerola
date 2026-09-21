"""Every container CI starts carries a memory ceiling, and it is a REAL one.

Two assertions, and both used to live only as sentences in a comment. The comment
is still there — the numbers and how they were measured have to be read by a
human — but the part that has to STAY TRUE is here, because it is now spread over
eleven places instead of two: `--memory=` appears eight times across the two
workflows and `memory_flags` is used at three `docker run` sites in `ci/smoke.py`.

    1. `--memory` WITHOUT `--memory-swap` IS NOT A CEILING. `--memory-swap` is the
       memory+swap TOTAL, so leaving it unset gives the container swap equal to
       the limit: a process that ran away would thrash to twice the number
       instead of being killed at it. The flag would still be written down while
       no longer being enforced, which is worse than not having one — the ceiling
       reads as measured and is not.

    2. A `docker run` in the gate WITHOUT a ceiling is the case issue #28 closed,
       so a fourth container added later must not quietly reopen it.

Neither can be caught by running CI: a build under a doubled effective ceiling
passes exactly like one under the right ceiling, and a gate container with no
limit at all passes best of all. They are only visible in the text.
"""

import ast
import re
from pathlib import Path

from ci.smoke import memory_flags

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = sorted((ROOT / ".gitea" / "workflows").glob("*.yml"))
SMOKE = ROOT / "ci" / "smoke.py"

# The flags as they are written on a command line. Only the `=` spelling is
# matched, which is what keeps the prose above each command — where both names
# appear bare, in backticks — out of the scan.
MEMORY = re.compile(r"--memory=(\S+)")
MEMORY_SWAP = re.compile(r"--memory-swap=(\S+)")


def test_every_memory_flag_in_the_workflows_has_an_equal_swap_flag():
    """Paired on the SAME LINE, which is how all eight are written.

    Same-line is a stricter rule than the danger requires — docker would honour
    the pair anywhere in the command — and deliberately so: the two flags being
    adjacent is what makes a later edit see them both. A file with none at all
    would pass vacuously, so the count is asserted too.
    """
    seen = 0
    for workflow in WORKFLOWS:
        for number, line in enumerate(workflow.read_text().splitlines(), 1):
            limits = MEMORY.findall(line)
            if not limits:
                assert not MEMORY_SWAP.search(line), (
                    f"{workflow.name}:{number} sets --memory-swap with no "
                    f"--memory beside it")
                continue
            seen += len(limits)
            where = f"{workflow.name}:{number}"
            assert limits == MEMORY_SWAP.findall(line), (
                f"{where}: --memory and --memory-swap must be set together and "
                f"be EQUAL. Unequal or missing, the container gets swap on top "
                f"of the limit and the ceiling stops being one: {line.strip()}")
    assert seen == 8, (
        f"expected eight ceilings across the workflows — the Python suite, the "
        f"build of the image it runs in, the JS suite and the build of the "
        f"shipped image, in each of the two files — found {seen}")


def run_arguments(tree):
    """The argument expression of every `docker([...run...], timeout)` call.

    By AST rather than by text because the three sites are written as a `+` of
    lists, over two lines each, and a regexp over that is a scan that passes
    whenever somebody reformats.
    """
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "docker":
            continue
        argv = node.args[0]
        dumped = ast.dump(argv)
        if "'run'" in dumped or '"run"' in dumped:
            found.append(dumped)
    return found


def test_the_gate_puts_a_ceiling_on_every_container_it_starts():
    """Three `docker run`s, three ceilings, each its own measured constant.

    The constants are asserted by NAME and not by value: the numbers belong next
    to the pass/fail pair they came from, and a test that repeated them here
    would have to be edited by whoever re-measures — which is exactly how a
    number stops being a measurement.
    """
    tree = ast.parse(SMOKE.read_text())
    runs = run_arguments(tree)
    assert len(runs) == 3, (
        f"this gate starts three containers; found {len(runs)} `docker run` "
        f"calls. A new one needs a swept ceiling of its own (issue #28), not a "
        f"borrowed number")
    for dumped in runs:
        assert "memory_flags" in dumped, (
            f"a `docker run` with no memory ceiling: {dumped}")
    used = {name for name in ("GUARD_MEMORY", "CMD_MEMORY", "PROBE_MEMORY")
            if any(name in dumped for dumped in runs)}
    assert used == {"GUARD_MEMORY", "CMD_MEMORY", "PROBE_MEMORY"}, (
        f"each container was swept separately and has a floor of its own; one "
        f"of the three constants is unused: {sorted(used)}")


def test_memory_flags_sets_both_and_sets_them_equal():
    """The helper the three sites above rely on, checked by value.

    The test above proves the sites CALL it; nothing there would notice if it
    started returning `--memory` alone.
    """
    assert memory_flags("512m") == ["--memory", "512m", "--memory-swap", "512m"]
