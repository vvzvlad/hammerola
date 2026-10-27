# Projects, revisions, and setting up a machine

Starting a project, fetching a revision's artifacts and code back, removing
things, and the one-time setup of a machine.

## Starting a project

```sh
mkdir t13-ceiling-mount && cd t13-ceiling-mount
hammerola create --title "Ceiling mount for a T13 sensor (t13-ceiling-mount)"
```

In an empty directory `create` writes `project.json` (a fresh twelve-character
`id`) and unpacks the starter template, a `model.py` that builds as it stands;
it overwrites nothing. `--no-template` skips the template for a directory that
has a model, and needs no hub.

**The title is what it is and what for, then the directory's slug in
brackets**: a copied project forgets its title, and a mismatched slug shows it.
A title without one gets a `warning:`.

`create` also writes the slug as `project`, the name the hub publishes under,
taken from the directory — so **name the directory first**. One the hub cannot
publish (spaces, Cyrillic, a leading dot, over 200 characters) falls back to
the title's slug; with neither, the project publishes under its bare id.

**Commit `project.json`, and never edit its `id`**: every permanent URL is
built from it, so a new id is a new project orphaning the old.
`hammerola rename "..."` changes the title only. `project` has no command —
edit the line, and only later builds carry it.

Then, once per project, in its git repository:

```sh
git init -b main && git add -A && git commit -m "..."   # unless it is in one already
hammerola connect
```

`connect` adds the remote `hammerola-<pid>`, includes the hub's password for
git from `~/.config/hammerola/gitconfig` in the repository's own config,
fetches, and — for a project published before git — joins the hub's history
into the local `main` with one merge commit that changes no file, whichever
branch is checked out. It refuses without a local `main` then: create one, or
rename yours (`git branch -m <branch> main`). The project is the directory
holding `project.json` with its id; one repository may hold several projects,
each with its own remote, and a commit that touches only one of them builds
only that one.

`connect` prints the push for the branch checked out: a branch is a variant
(`SKILL.md`). `status`, `log [latest|dev]`, `artifacts latest|dev` and
`latest` in `diff` are of that branch's variant too, and `status` lists the variants. On a
branch whose name the hub refuses (`feat/x`) they read `main` and say so in one
line, and neither `connect` nor `status` advises a push.

## Fetching things back

```sh
hammerola artifacts <revision>  # its STL/STEP/3MF and pictures, into .hammerola/
hammerola diff <old> <new>      # what moved: geometry numbers, and the source
```

A revision's code is its commit: `git show <revision>:<file>`, after `git fetch
hammerola-<pid>`. A build published before git is the commit with the trailer
`Hammerola-Import: <pid>/<revision>`, its tree the project's directory. `diff`
reads the code from the local repository the same way, and says to fetch when a
revision is missing.

Artefacts take the secret or a link that includes them. `.hammerola/` ignores
itself in git, so no commit picks up what you fetched; `-o DIR` (`--output`)
lands it elsewhere, where git may not ignore it. `diff --json` prints a
document for code; `--material` adds material gained and lost per part, costing
about a build; not both.

## Removing things

`hammerola rm` deletes a project from the hub, asks for its id to be typed, and
cannot be undone. One build cannot be removed: that would break a permanent URL.
Never run it to "clean up"; ask the owner.

## Set up, once per machine

`<hub>` is the address you were given. It has no default: never guess one, or
write one into a repository.

```sh
mkdir -p ~/.local/bin
curl -fsSL <hub>/start/hammerola -o ~/.local/bin/hammerola && chmod +x ~/.local/bin/hammerola
hammerola login <hub>
hammerola skill update        # writes this skill into ~/.claude/skills/hammerola/
```

Behind a password proxy, add `-u <login>` to the `curl` line (curl asks the
password); `hammerola login` notices the proxy and asks its login and password.

The client installs the skill and updates it: `hammerola skill` compares a
digest of the installed files with the hub's, `hammerola skill update` writes
the hub's copy over the whole directory — the file you are reading and every
file beside it — and removes what the new version no longer ships. A stale
skill teaches commands that no longer exist; the client says so only from
`hammerola update`, from the refusal of a client older than the hub, and from
a verb that is gone, so ask `hammerola skill` when you start on a project.
Installed somewhere else? Pass `--path DIR`, or both verbs act on a directory
nobody reads. `hammerola update` replaces the client, which `build` refuses
when older than the hub, and says when the skill in
`~/.claude/skills/hammerola/` is stale.

`login` asks for the password at the terminal and stores it 0600 in
`~/.config/hammerola/env`, and for git, as the header it sends to the hub, 0600
in `~/.config/hammerola/gitconfig`. **Ask the instance's owner for it.** One shared
secret publishes, reads any project's source and deletes any project: never put
it in a repository, a CI variable or a command line.

`hammerola` is one stdlib-only file: **python 3.9 or newer** (stock on macOS
and Debian 11). Not on PATH means `~/.local/bin` is not: run it by path.
