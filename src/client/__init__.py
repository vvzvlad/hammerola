"""`hammerola` — the tool that puts a model's source on the hub.

The single system-wide client described in SPEC §8, entry 26. Two commands
publish; the other four are the ones that need nothing new from the hub.

    hammerola login            -> checks the password, then writes HUB_URL and
                                  EDIT_TOKEN into ~/.config/hammerola/env
    hammerola create           -> a project.json with a fresh id (SPEC §3.1),
                                  and the starter template from GET /start —
                                  the one route this tool asks for with no
                                  token, because `--no-template` is what makes
                                  the id offline rather than the whole command
    hammerola build            -> POST /api/v1/publish/<pid>/dev
    hammerola commit -m "..."  -> POST /api/v1/publish/<pid>, and the hub
                                  answers with the revision id it minted
    hammerola status           -> GET /project/<pid>/builds.json, plus the dev
                                  slot's own meta.json
    hammerola source <rev>     -> GET /api/v1/sources/<rev>, unpacked into a
                                  directory of its own
    hammerola artifacts <rev>  -> GET /project/<pid>/<rev>/<file> for each entry
                                  of the build's `downloads`
    hammerola diff <a> <b>     -> both builds' metrics.json and both stored
                                  archives, compared
    hammerola log [dev|<rev>]  -> GET /api/v1/sources/<rev>/log
    hammerola comments         -> GET /api/v1/comments?project=<pid>, and
                                  `resolve` POSTs to .../<id>/resolve
    hammerola rename "..."     -> project.json, and POST
                                  /api/v1/projects/<pid>/title
    hammerola rm               -> DELETE /api/v1/projects/<pid>, after the id is
                                  typed

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

THREE VERBS ARE SHAPED BY WHAT THEY ARE NOT ALLOWED TO DO, and the shape is the
decision rather than a limitation of what was written:

  * `source` and `artifacts` are two verbs over one build because the RIGHTS
    differ: the artefacts are public, the code is behind the secret (SPEC §8
    entry 17). A single verb with a flag would put both behind one word.
    `source` also unpacks into a directory of its own — writing over the working
    copy is a flag, and that flag additionally requires git to call the tree
    clean, because a clean tree is the only thing that can undo it.
  * `rename` changes the TITLE. There is no command and no flag that changes an
    id, and there is no route for one either: every permanent URL of the project
    is built from the id, and the builds behind those URLs went out with a year
    of `immutable` (SPEC §3.1).
  * `rm` removes the whole project and asks for its id first. There is no way to
    remove one build: that breaks a permanent URL while leaving the project
    standing.

WHAT IS STILL NOT HERE, and for two different reasons worth telling apart.

  * `status` shows no "last job", and `log dev` cannot be answered at all.
    Neither is waiting on anybody's next commit: a job is addressable by its id
    alone and job order is stored nowhere (`src/jobs.py`), and the hub stores
    nothing for the local slot on purpose (SPEC §7.8), so the log of a `dev`
    build exists only at the job that produced it. Both are said out loud by the
    code that would otherwise have to guess — see `status.py` and
    `sources._dev_log`.
  * Self-update waits on the tool having a distribution name, and THAT waits on
    this repository not being an application. Its one importable top-level name
    is `src`, so a `[project.scripts]` entry point would mean `pip install`ing a
    package called `src` onto a laptop, where it would shadow every other
    project's. Giving the tool a real distribution name and layout is part of
    the self-update work (SPEC §8 entry 26), and doing half of it now would mean
    doing it twice. Until then there are two doors and no installed script:
    `python3 -m src.client`, STARTED IN THE CHECKOUT ROOT and pointed at the
    model with `-C` (`__main__.py` has both working forms and why the obvious
    one is not among them), and the zipapp the hub builds out of these modules
    and serves at `/start/hammerola` for everybody else — that one carries its
    own modules, so it runs from anywhere and needs no `-C`. This
    paragraph used to live in `bin/hammerola`, a third door that existed only to
    be symlinked onto PATH — and that symlink is exactly what the hub's own
    `curl -o ~/.local/bin/hammerola` wrote through, silently replacing the
    repository's copy with the download.

STDLIB ONLY, EVERY MODULE BELOW. This runs on the author's machine, under
whatever python3 is there, so it takes nothing from `requirements.txt` — not
loguru, not pydantic, and not the hub's own `src.store` or `src.cadbuild`.
`tests/client/test_stdlib_only.py` is what enforces that, because the test
environment has every dependency installed and would never notice on its own.
What the rule costs is one copy of the hub's ceilings (`limits.py`), paid for by
a test that compares it against the modules that enforce them; where a copy
could be avoided entirely it was — `src/metricsdiff.py` is the comparison
`hammerola diff` and the build both import, moved out of `src/cadbuild/` rather
than duplicated.
"""
