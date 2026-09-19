"""`hammerola` — the tool that puts a model's source on the hub.

The single system-wide client described in issue #26. WHAT THE VERBS ARE, AND
WHAT EACH ONE IS NOT ALLOWED TO DO, is the docstring of `hammerola/cli.py` —
next to `build_parser`, which is where a verb is actually added and therefore
the only place a list of them stays true. What is below holds for the package as
a whole rather than for any one command.

NOTHING HERE READS GIT TO DECIDE WHAT TO PUBLISH. `commit` means "publish a
version of this", the hub names that version out of the sources it receives, and
a directory that is not a repository publishes exactly like one that is. git is
touched once, after the fact and for a different job: `gitsuggest` prints a
`git commit` line that RECORDS what was published, for a person to run or
ignore.

WHY IT IS IN THIS REPOSITORY AND NOT BESIDE THE MODELS. Two reasons, and the
first one is the reason publication is broken today. The client and the hub
share a CONTRACT — the archive shape, the path alphabet, the ceilings, the
status codes, the job states — and until now the two halves lived in two
repositories with nothing able to see both. When step 5 moved the hub to source
trees and to 202, `cad_publish` went on packing a flat build and waiting for
201, and no test anywhere could notice: each repository's suite was green about
its own half. Here the suite holds both, so `tests/client/` drives the REAL hub
over a real socket and a contract change that breaks the client fails at the
commit that makes it.

The second reason is issue #26's own: the finished tool updates itself
from the hub, over the same authenticated channel it already pushes on. The hub
can only serve what is inside its image, and `COPY hammerola/ hammerola/` already
puts this there.

ONE SECRET FOR THE WHOLE SYSTEM (decided 2026-08-27, issue #26), which
is what `login` stores and what every command here presents. It is worth saying
plainly what that is NOT: the hub compares one shared value for equality and has
no idea who presented it, so `login` means "remember the system's password on
this machine" and not "authenticate this person". Per-person keys — issuing,
revoking, expiry — do not exist, and calling this a login should not make them
look as though they do.

SELF-UPDATE IS HERE (issue #77) AND IT IS ONE VERB. `hammerola update` fetches
the zipapp the hub serves at `/start/hammerola` and writes it over the file this
process is running from, printing what changed between the two versions
(`update.py`, `changelog.py`). The number both sides compare is `VERSION` below:
the hub repeats it in its manifest as `client_version`, and `build` and `commit`
refuse to publish from a client older than that. It applies to ONE of the three
doors, which is why the doors are worth listing: the installed `hammerola`
script; `python3 -m hammerola` out of a checkout, pointed at the model with `-C`
(`__main__.py` has the working forms and why the obvious one is not among them);
and the zipapp, for a machine with neither. Only the last is a single file this
tool can replace — a checkout is updated with git and an installed distribution
with pip, and `update` says so rather than writing into either. The first and
the last carry their own modules, so they run from anywhere and need no `-C`.

STDLIB ONLY, EVERY MODULE BELOW. This runs on the author's machine, under
whatever python3 is there, so it takes nothing from `requirements.txt` — not
loguru, not pydantic, and not the hub's own `src.store` or `src.cadbuild`.
`tests/client/test_stdlib_only.py` is what enforces that, because the test
environment has every dependency installed and would never notice on its own.
What the rule costs is one copy of the hub's ceilings (`limits.py`), paid for by
a test that compares it against the modules that enforce them; where a copy
could be avoided entirely it was — `hammerola/metricsdiff.py` is the comparison
`hammerola diff` and the build both import, moved out of `src/cadbuild/` rather
than duplicated.
"""

# WHICH VERSION OF THE TOOL THIS IS, and a constant rather than metadata because
# of how the tool is usually installed: the zipapp carries no `pyproject.toml`
# and was never `pip install`ed, so `importlib.metadata` has nothing to answer
# with on the machine that matters most. A module-level literal is readable
# three ways that all have to work — imported by the running program, read out
# of the served archive by an older client before it replaces itself
# (`update._member_value`), and imported by the hub to state `client_version` in
# its manifest (`src/onboarding.py`).
#
# IT IS THE SAME NUMBER AS `pyproject.toml`'s, held there by
# `tests/test_packaging.py`: the two would otherwise disagree the first time
# somebody installed the distribution, and the version an installed copy reports
# is exactly the one `build` refuses to publish from.
VERSION = "0.1.0"
