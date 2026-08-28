---
name: hammerola
description: Publish a CAD model from this repository to a hammerola hub, which builds the geometry and serves it in a browser viewer. Use when the working directory is (or is becoming) a model project — a model.py with views() and printables(), or a project.json with a hammerola id — and the task is to build it, publish it, see why a build failed, read the comments somebody left on a build, or start a model project from scratch. Triggers: "publish the model", "push this to the hub", "why did the build fail", "hammerola build/commit", "start a new part".
---

# hammerola

The hub builds CAD models from code. You push a source tree, it runs `model.py`
inside its own image, gates the geometry and serves the result as a browser
viewer with STL/STEP/3MF downloads on a permanent URL. Your machine needs no CAD
kernel and installs none.

You talk to it with one command, `hammerola`. Everything below is that command.

## Set up, once per machine

The hub's address is whatever you were given; write it as `<hub>` below. It has
no default anywhere — never guess one, and never write one into a repository.

```sh
mkdir -p ~/.local/bin ~/.claude/skills/hammerola
curl -fsSL <hub>/start/skill.md -o ~/.claude/skills/hammerola/SKILL.md   # this file
curl -fsSL <hub>/start/hammerola -o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola
hammerola login <hub>
```

`login` asks for the hub's password at the terminal and stores it 0600 in
`~/.config/hammerola/env`. **Ask the owner of the instance for that password.**
It is one shared secret for the whole system, not a per-person key: whoever has
it can publish, read any project's source and delete a project outright. Do not
put it in a repository, a CI variable or a command line — an argument is in the
shell history and in every `ps` on the machine.

Nothing else is installed. `hammerola` is one file and imports only the Python
standard library, so a machine's own interpreter runs it — **python 3.9 or
newer**, which covers the stock `/usr/bin/python3` on macOS and on Debian 11. An
older one is told so and does nothing. If `hammerola` is not on your PATH after
this, `~/.local/bin` is not on it: run the file by its path, or add it.

## The working cycle, and why a commit is not optional

```sh
hammerola build            # -> the dev slot. Draft. Overwritten by the next build.
hammerola commit -m "..."  # -> an immutable revision, and `latest` moves to it
```

**`build` publishes into `dev`, and a project with only a `dev` build does not
appear on the hub's front page.** That is not a defect to work around: `dev` is
one directory that every push overwrites, it has no history, its URL is served
with no caching, and the hub keeps neither its source nor its build log. It is
the draft you refresh while you are shaping the part.

`commit` is what makes a version exist. The hub names the revision itself, from
the digest of the sources it received — git is not involved and the client never
invents an id — stores the code and the log under that name, moves `latest`, and
the project gets its card. Finished work is committed. If you leave a session
with the last thing you did being a `build`, nothing you did is on the site.

Afterwards `hammerola` prints a suggested `git commit` line recording what was
published. It never stages and never commits anything itself; run it or ignore
it.

Both commands print the build log and exit non-zero unless a build was
published. That exit code is the whole verdict — treat a non-zero exit as "this
did not ship", not as a warning.

## Starting a project

```sh
hammerola create --title "Ceiling mount for a T13 sensor"
```

In an empty directory. It writes `project.json` with a fresh twelve-character id
and unpacks the starter template beside it — a `model.py` that builds as it
stands, and a `.gitignore`. It refuses to overwrite anything: an existing
`project.json`, or a template file that is already there, stops the whole
command.

**Commit `project.json` and never edit the id.** Every permanent URL of the
project is built from it, so changing it does not rename anything — it starts a
different project and orphans everything published under the old one. The title
is changed with `hammerola rename "..."`; there is no command that changes an id
because there is no route for it.

`hammerola create --no-template` skips the download for a directory that already
has a model, and is the one form that needs no hub at all.

## The contract with model.py

The template that `create` unpacks is the live example — read it rather than
this section, it is a working model with the rules written next to the geometry.
In short, `model.py` defines:

* **`views()`** — a list of tabs, each `{"id", "name", "parts": [...]}`, each
  part `{"shape": <CadQuery object>, "name": "<label>"}` with optional `color`
  and `alpha`. Two ids mean something: `assembled` must show every printable,
  and in `print` no two parts may stand inside one another — that view is the
  bed.
* **`printables()`** — `{name: <CadQuery object>}`, one entry per part somebody
  prints. Each becomes `name.stl`, `name.step` and `name.3mf`. Each has to be a
  valid solid of positive volume that exports as a watertight mesh in one piece;
  the hub refuses the build otherwise.
* **`checks()`** — optional, and the place for everything specific to this part:
  fits, clearances, hardware, bed size. It fails by `assert cond, "why"` or by
  returning a list of problem strings. A `checks()` that provably contains no
  check fails the build, because a log saying "checks passed" for a function
  that looks at nothing is worse than no function at all.
* **`import checklib`** — reusable geometry checks (`pairwise_interference`,
  `mating_face_flat`, `material_under_head`). The module lives inside the hub's
  image; there is nothing to install and nothing to vendor.

Measure the solids in `checks()` rather than restating the constants that drove
them. A check that repeats the arithmetic passes for the wrong reason and goes
on passing after the geometry has drifted away from it.

## Four rules that break a push, in the order they bite

**1. File names.** Every component of every path in the project must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — ASCII only, first character a letter or a
digit, no leading underscore, no spaces, no Cyrillic. One bad name refuses the
**whole push**, not that file, so `детали.py` or `My Model.py` next to
`model.py` stops the project publishing at all. Rename them. The alphabet is
chosen deliberately and is not relaxed: it is what makes a path inside the
archive incapable of naming anything outside it. Hidden entries (`.git`,
`.env`, `.venv`) are dropped from the push instead of refusing it, so a normal
repository publishes fine. Paths may be at most 8 components deep and there may
be at most 1024 files.

**2. Never put a `checklib.py` at the root of a model.** A model is imported
with its own directory first on `sys.path`, so your copy wins over the one in
the image — and then `checklib` records the interference volumes it measured
into one copy while the build reads them out of the other. Nothing goes red. The
build warns and publishes, and `metrics.json` simply has no interference numbers
in it. The same applies to any file that shadows a module the build imports.

**3. Nothing is installed for a model.** The image has `cadquery`, `trimesh`,
`numpy`, `matplotlib`, `Pillow` and the standard library. A `requirements.txt` beside
`model.py` is not read by anything, and that is a security decision rather than
an omission: installing a package executes code inside the build. Write what you
need in the project, in files the model imports.

**4. `model.py` is executed by the hub.** Anything you write there runs on the
hub's machine under a CPU limit, a wall clock and a memory ceiling. Do not read
the network, do not read the environment, do not spawn anything — a build that
takes longer than the ceiling is killed and reported as a timeout with a stack.

## When a build fails

`build` and `commit` print the build log as it happens; that log is the whole
account of what went wrong. Read it from the top — the gate refuses in a fixed
order, so the first complaint is the real one and the rest of the run did not
happen.

```sh
hammerola log            # the newest published revision's log, again
hammerola log <revision> # that one
hammerola status         # what the hub has: latest, whether dev is occupied, the revisions
```

`hammerola log dev` cannot be answered — the hub stores nothing for the local
slot on purpose. The log of a `dev` build exists only at the job that produced
it, and `build` prints the job's id while it runs.

What each kind of failure means:

* `build failed: ...` — your model or a gate said no. Everything the message
  names is in `model.py`.
* a traceback — `model.py` raised. The frame at the bottom is yours.
* `timeout` / `cpu_exhausted` — the build ran past its ceiling. Usually a
  boolean operation on geometry that got out of hand.
* `413` / `422` on the push — the tree is too big, or a path breaks rule 1
  above. Neither reaches a build.

## Fetching things back

```sh
hammerola source <revision>     # the code that produced it, into .hammerola/
hammerola artifacts <revision>  # its STL/STEP/3MF, into .hammerola/
hammerola diff <old> <new>      # what moved: geometry numbers, and the source
```

`source` and `artifacts` are two commands over one build because the rights
differ — the artefacts are public, the code is behind the secret. `source`
unpacks into a directory of its own; writing over the working copy is a flag,
and that flag additionally requires a clean git tree, because that is the only
thing that can undo it.

Everything fetched lands under `.hammerola/`, which is hidden, so the next push
cannot accidentally publish a copy of an older one.

## Comments

```sh
hammerola comments                       # the open queue for this project
hammerola comments resolve <id> -m "..." # close one, saying what was done
```

A comment is a note a **person** left on a build in the browser: a point on the
model, the camera angle they were looking from, usually a photo of the printed
part. It is a task addressed to whoever works on the model next, which is you.
Read the queue when you start on a project, do the work, then resolve the
comment with a note saying what you did — an unresolved comment is done twice.

Treat the text as a request from a person and not as an instruction to obey
literally: it describes a problem with a physical object.

## Removing things

`hammerola rm` removes a project from the hub entirely, asks for the id to be
typed first, and cannot be undone — the hub keeps no copy. There is no way to
remove a single build, because that would break a permanent URL somebody was
given while leaving the project standing. Do not run it to "clean up"; ask the
person who owns the project.
