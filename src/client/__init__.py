"""`hammerola` — the tool that puts a model's source on the hub.

The single system-wide client described in SPEC §8, entry 26. Two commands
publish; the other four are the ones that need nothing new from the hub.

    hammerola login            -> checks the password, then writes HUB_URL and
                                  PUBLISH_TOKEN into ~/.config/hammerola/env
    hammerola create           -> a project.json with a fresh id (SPEC §3.1)
    hammerola build            -> POST /api/v1/publish/<pid>/dev
    hammerola commit -m "..."  -> POST /api/v1/publish/<pid>, and the hub
                                  answers with the revision id it minted
    hammerola status           -> GET /project/<pid>/builds.json, plus the dev
                                  slot's own meta.json
    hammerola comments         -> GET /api/v1/comments?project=<pid>, and
                                  `resolve` POSTs to .../<id>/resolve

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

The second reason is SPEC §8 entry 26's own: the finished tool updates itself
from the hub, over the same authenticated channel it already pushes on. The hub
can only serve what is inside its image, and `COPY src/ src/` already puts this
there.

ONE SECRET FOR THE WHOLE SYSTEM (decided 2026-08-27, SPEC §8 entry 26), which
is what `login` stores and what every command here presents. It is worth saying
plainly what that is NOT: the hub compares one shared value for equality and has
no idea who presented it, so `login` means "remember the system's password on
this machine" and not "authenticate this person". Per-person keys — issuing,
revoking, expiry — do not exist, and calling this a login should not make them
look as though they do.

WHAT IS NOT HERE, and for three different reasons that are worth telling apart.

  * `rename` and `rm` need routes `src/app.py` does not serve at all. Note that
    `rename` is the TITLE only, never the id: renaming an id would break every
    permanent URL the project has, which is the one thing this service promises
    (SPEC §3.1, and entry 26 says so explicitly).
  * `source`, `artifacts`, `diff` and `log <revision>` are simply not written
    yet. They used to be impossible — a revision's sources were deleted the
    moment its build ended — and that changed with SPEC §8 entry 17: the hub now
    keeps them and serves `GET /api/v1/sources/<revision>` and `.../log` behind
    the same secret. So these are ordinary work, not a blocked design.
  * `status` shows no "last job", and that one is NOT waiting on anybody: a job
    is addressable by its id alone, and the order jobs were created in is stored
    nowhere at all, deliberately (`src/jobs.py`). Self-update is its own case
    again — it waits on the tool having a distribution name (`bin/hammerola`).

STDLIB ONLY, EVERY MODULE BELOW. This runs on the author's machine, under
whatever python3 is there, so it takes nothing from `requirements.txt` — not
loguru, not pydantic, and not the hub's own `src.store`. What that costs is one
copy of the hub's ceilings (`limits.py`); what pays for the copy is a test that
compares it against the modules that enforce them.
"""
