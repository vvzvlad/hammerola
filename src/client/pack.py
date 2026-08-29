"""The gzipped tar of a model's SOURCE tree, and the local refusals around it.

WHAT GOES IN is the source, not a build: `model.py`, `project.json`, whatever
`scripts/` and `ref/` the project keeps. The hub computes the geometry itself
now (SPEC 8A.2), so shipping an `out/` would be shipping the answer to the
question being asked.

NEVER SHELL OUT TO `tar`. Two things go wrong when you do, both of them
observed: `tar -czf x.tar.gz .` writes an entry for `.` itself and one per
subdirectory, and macOS `tar` adds an AppleDouble `._name` member beside every
file that carries an extended attribute. The hub skips directory entries and
refuses `._name` on the alphabet, so the first is noise and the second is a
publish that fails for a reason nobody can see in their own checkout. `tarfile`
writes exactly the members it is given.

HIDDEN ENTRIES ARE DROPPED, NOT REFUSED, and that single rule does most of the
excluding here. `SAFE_COMPONENT` requires an alphanumeric first character, so
`.git`, `.venv`, `.pytest_cache`, `.DS_Store`, an AppleDouble `._model.py` and
`.gitignore` are all names the hub CANNOT accept — and refusing on them would
mean no ordinary repository could ever be published. Dropping them is right on
the merits too: nothing a build reads is hidden.

The consequence worth saying out loud is `.env`. It is hidden, so it never
enters the archive, and that is not incidental — it is where the publish token
lives on a laptop. The token travels in one HTTP header and nowhere else; the
same rule is stated in `config.py` from the other end.

A NON-HIDDEN NAME THAT STILL CANNOT BE A MEMBER IS A REFUSAL, not a skip. A
skipped `My Model.py` produces a build that is missing a file and fails inside
the hub with a message about an import; a refusal names the file while the
author is still looking at it. Same reasoning as `Store._unpack`, which refuses
rather than skips for the same reason.

AND THE REFUSAL NAMES EVERY ONE OF THEM, in one message, from one run. The walk
collects what it cannot send instead of raising at the first thing it finds
(issue #42): the tree this was written for is a `ref/` holding nineteen
cyrillic file names, and one-at-a-time made that nineteen rounds of "renamed it,
ran it, learned about the next one". The path alphabet is not what gives here —
it is deliberate, and it stays (SPEC §7.1) — the QUALITY of the refusal is.
"""

import fnmatch
import io
import tarfile
from dataclasses import dataclass
from pathlib import Path

from src.client.limits import (
    MAX_BUILD_BYTES,
    MAX_MEMBERS,
    MAX_PATH_DEPTH,
    SAFE_COMPONENT,
)

# THESE TWO LISTS EXIST FOR WHAT REGENERATES, and for nothing else. A name
# belongs here when the tool that writes it will write it again after the next
# build, so asking the author to sweep it before every push would be absurd —
# `__pycache__` is the whole argument, and `node_modules`, a virtualenv, a
# package cache and the generic output names (`out`, `build`, `dist`,
# `htmlcov`) are the same argument. Every hidden one (`.git`, `.venv`, `.tox`,
# `.pytest_cache`) is already gone by the rule above; these are the ones that
# are not hidden and would otherwise be packed.
#
# `_out` MEETS THAT RULE AND IS DELIBERATELY NOT HERE, which is the one thing on
# this list worth reading carefully. An earlier version of this comment justified
# its removal with "the build happens on the server and nothing writes it any
# more", and that is FALSE — stated here so nobody restores it. `make build` in a
# model repository writes `_out/` and `_out.tar.gz` to this day, from the
# Makefile the project template still hands out, and `make clean` there is what
# removes them. This client has no local build of its own, so running the
# geometry and the gate before publishing is still done that way, and "built
# locally, then `hammerola build`" therefore meets this refusal EVERY time rather
# than once.
#
# It stays off the list anyway, and that is a price rather than a claim. What
# separates it from `__pycache__` is not how often the name comes back but WHOSE
# tool writes it: python is a tool the author goes on using for what it is for,
# while `_out` is the output of the publisher this client REPLACES (`cad_publish`
# moved inside the hub, SPEC 8A.2 step 3). Carrying it here would mean deciding
# what to pack partly by the conventions of the thing being retired — in code
# every later reader has to take on trust. A repository that has moved over drops
# the local build once and never sees the refusal again; one that has not is told,
# every time, exactly which two paths are in the way. The alternative is worse
# than the nuisance: excluding them silently lets a push go out while its author
# believes the `_out/` they are looking at went with it.
#
# `_out.tar.gz` was NEVER on the file list below, which is worth saying because
# the pair is easy to assume: the patterns there have only ever been the three
# that are still there.
#
# Neither name needs to be listed to be kept out of a push: both start with an
# underscore, so both fail SAFE_COMPONENT, and either one present is now refused
# by name like anything else the hub cannot accept.
EXCLUDED_DIRS = frozenset({
    "__pycache__", "node_modules", "venv", "out", "build", "dist",
    "htmlcov", "site-packages",
})

# File patterns, matched against the base name. Same line as the directories:
# `*.pyc` and `*.pyo` come back with the next import, and `*~` is written by an
# editor behind the author's back.
EXCLUDED_FILES = ("*.pyc", "*.pyo", "*~")

# How many paths of one kind a refusal lists before it stops counting them out.
#
# A hundred is well above any honest `ref/` — the tree that prompted this held
# nineteen — and below the point where a list stops being a to-do list and
# becomes a wall. Past it the problem is not a directory that needs renaming but
# one that should not be packed at all, and the tail line says so.
MAX_REFUSALS_LISTED = 100

# And how much of ONE path is printed.
#
# THESE NAMES ARE NOT THE AUTHOR'S OWN, whatever it looks like from a laptop. A
# model directory is normally a clone, and putting a file into a clone is not an
# attack that needs anything — `\x1b[2Jwiped\rboom.py` clears the terminal and
# rewrites the line that was supposed to report it, and a name holding a newline
# breaks the indentation this message is read by. The hub spent a ceiling and a
# double cut on exactly this (`src/store.py`, MAX_REFUSED_NAME_CHARS); the
# client is the other end of the same wire and the same reasoning reaches it.
#
# The mechanism is the hub's, deliberately not shared with it: `src/store.py`
# imports loguru and pydantic, and every module here is stdlib only. What is
# NOT shared is the number, and that is not an oversight either — the hub's 80
# is about how much attacker text a 422 and a log line may repeat, while this
# one only has to keep a path readable on a terminal.
#
# Nor is the cut the same SHAPE, and the difference is the point: the hub cuts
# the raw name before escaping it as well, because a tar member's name is
# bounded by nothing. A path here is bounded by the filesystem — 255 bytes a
# component, MAX_PATH_DEPTH components — so escaping is handed kilobytes at
# worst and one cut, on the escaped result, is the whole job. See `_shown`.
MAX_REFUSAL_PATH_CHARS = 160


class PackError(Exception):
    """The tree cannot be sent as it stands, and here is which file is why."""


@dataclass(frozen=True)
class Refusal:
    """One thing in the tree that cannot be sent, and which group it is in."""

    kind: str
    path: str
    detail: str = ""


# The kinds, in the order a message lists them: the sentence introducing the
# group, and inside it the ONE action that clears every line under it.
#
# THEY ARE ALL COLLECTED TOGETHER rather than split into "the batched kind" and
# "the kinds that still stop the walk", and that is the decision. A refusal that
# still raised on the spot would reinstate the defect for any tree that has one
# of those AND a bad name — the author would fix the symlink, push, and only
# then hear about the nineteen names. The groups keep them apart in the message
# instead, because the fix differs: a file is renamed, a directory is renamed OR
# deleted, a depth is flattened, a symlink is replaced by the file, a mode is
# chmod-ed. One list with one instruction would have been the wrong shape for
# all but the first.
#
# A FILE AND A DIRECTORY ARE TWO GROUPS, and what separates them is NOT the
# advice. Both say "rename it, or delete it if it is build output", because the
# pair that prompted the split is `_out/` and `_out.tar.gz` — a directory and a
# FILE, written by one and the same `make build`. An earlier version of this told
# the directory both and the file only "rename them", which is the wrong
# instruction for exactly the half of the pair a `ls` puts first.
#
# NEITHER SENTENCE CALLS IT A LEFTOVER, and that word was in both until this was
# measured against what model repositories actually run: `make build` still
# writes that pair, so an author who builds locally before publishing meets this
# refusal after every build rather than once (see EXCLUDED_DIRS). "Delete it" is
# the right action either way; "left over from an older way of publishing" was a
# promise that it would not happen again, and it is not this tool's to make.
#
# What the directory group says on top of it is the thing only a directory has:
# nothing INSIDE it was looked at, so dealing with it uncovers more (see
# `_walk`). That is what keeps the two apart.
REFUSAL_GROUPS = (
    ("name",
     f"These files cannot be published under the names they have — every "
     f"component of a path has to match {SAFE_COMPONENT.pattern}. Rename each "
     f"one, or delete it if it is build output: only sources are published, and "
     f"a local build writes its output back every time it runs. The hub applies "
     f"the same rule and would refuse the whole push:"),
    ("dirname",
     f"These directories cannot be published under the names they have, by the "
     f"same rule ({SAFE_COMPONENT.pattern}). Rename each one, or delete it if "
     f"it is build output, which a local build writes back every time it runs — "
     f"nothing inside them was looked at, so expect more once they are dealt "
     f"with:"),
    ("depth",
     f"These are nested deeper than the hub accepts — a file's path may be at "
     f"most {MAX_PATH_DEPTH} components, the file name included. Move them up; "
     f"what is inside them was not looked at:"),
    ("symlink",
     "These are symlinks, and the hub refuses links whatever they point at: it "
     "has no way to know the file is inside the push. Replace each with the "
     "file itself:"),
    ("special",
     "These are not regular files, and only regular files can be published:"),
    ("unreadable",
     "These directories cannot be listed by this account, so what is inside "
     "them is unknown:"),
)

# The last resort of `_refusal_message`, and it is here so that a kind added to
# `_walk` without a group cannot go MISSING from the message. Silently dropping
# one would print a header over an empty list while `collect` still refused —
# the least debuggable shape this could take. `tests/client/test_pack.py` also
# compares the two sets, so the mismatch fails at the commit rather than at the
# push; this is what happens if that test is ever removed.
UNGROUPED_HEADLINE = "These cannot be published, and this tool has no advice:"


@dataclass(frozen=True)
class Packed:
    """One archive, ready to POST."""

    body: bytes
    names: tuple
    unpacked_bytes: int

    @property
    def size(self) -> int:
        return len(self.body)


def collect(root: Path) -> list:
    """Every file that goes into the archive, as (member path, real path).

    Sorted, so two runs over an unchanged tree produce byte-identical archives
    and a diff of two of them means something.

    A tree that cannot be sent is refused with EVERY reason it has, in one
    message (issue #42), rather than with whichever one the walk met
    first.
    """
    root = Path(root)
    found = []
    refusals = []
    _walk(root, root, (), found, refusals)

    if refusals:
        # BEFORE the two checks below, and not merely for tidiness. A tree whose
        # every file is unpublishable leaves `found` empty, and "holds no source
        # files to publish (everything under it is hidden or excluded)" would
        # then be a flatly wrong answer: nothing was excluded, everything was
        # refused, and the author would go looking for a `.gitignore`.
        raise PackError(_refusal_message(root, refusals))

    found.sort(key=lambda item: item[0])
    if not found:
        raise PackError(
            f"{root} holds no source files to publish (everything under it is "
            f"hidden or excluded)")
    if len(found) > MAX_MEMBERS:
        raise PackError(
            f"{len(found)} files to publish, and the hub accepts at most "
            f"{MAX_MEMBERS} per push.\n"
            f"  Something that is not source is being packed — check for an "
            f"output or cache directory this tool does not know to skip.")
    return found


def _walk(root: Path, directory: Path, prefix: tuple, found: list,
          refusals: list) -> None:
    """One directory, appending its files to `found` and its faults to `refusals`.

    NOTHING HERE RAISES. Every branch that used to end the walk now records what
    it found and carries on, so one run sees the whole tree — which is the point
    of the exercise (issue #42) and the reason the caller, not this, is
    where the PackError is built.
    """
    try:
        entries = sorted(directory.iterdir(), key=lambda path: path.name)
    except OSError as error:
        # A directory this account cannot list, or one that went away between
        # the parent's listing and this call. Recorded rather than raised like
        # everything else, and turned into a PackError by the caller because
        # that is the only family `cli.main` prints as a sentence: an
        # unconverted PermissionError leaves a traceback on the terminal of
        # somebody whose real problem is one `chmod`, and the traceback does not
        # say which directory. `strerror` rather than `str(error)`, which
        # repeats the path this line already names.
        refusals.append(Refusal("unreadable", _shown(root, directory),
                                _shown_text(error.strerror or str(error))))
        return
    for entry in entries:
        name = entry.name
        if name.startswith("."):
            continue

        if entry.is_symlink():
            # The hub refuses links outright, whatever they point at, so a tree
            # that relies on one cannot be published as it stands. Said here,
            # naming the link, instead of as a 422 after the upload. Not
            # followed, either — a link to a directory would walk somebody
            # else's tree, and a link into this one would walk it twice.
            refusals.append(Refusal("symlink", _shown(root, entry)))
            continue

        if entry.is_dir():
            if name in EXCLUDED_DIRS:
                continue
            if not SAFE_COMPONENT.match(name):
                # AND DO NOT GO INSIDE, which is a decision and not an
                # oversight. The tempting argument is that renaming a directory
                # changes neither which files are under it nor what any of them
                # is called, so its contents are still worth listing — and that
                # argument is sound for `чертежи/` and wrong for `_out/`. This
                # tool cannot tell the two apart: one is a directory the author
                # wants published, the other is what a local `make build` writes
                # and the fix for it is `rm -rf` (or `make clean`), not a
                # rename. Walking into the second prints dozens
                # of lines about files that are about to disappear, every one of
                # them labelled with an instruction that does not apply. The
                # cost of stopping is one extra round for the first case only,
                # and the group's own sentence says so out loud.
                refusals.append(Refusal("dirname", _shown(root, entry)))
                continue
            if len(prefix) + 1 >= MAX_PATH_DEPTH:
                # +1 for the directory itself, `>=` because anything inside it
                # would be one deeper still. Recorded at the directory rather
                # than at each of its files, so the message names the level that
                # has to move rather than one arbitrary leaf.
                #
                # THE ONE REFUSAL THAT DOES NOT WALK ON, and for two reasons
                # that are both load-bearing. Flattening a tree destroys every
                # path underneath it, so a list of names from down there is
                # advice about paths that are about to stop existing — unlike a
                # rename, which leaves the shape alone. And this ceiling is the
                # only thing bounding the recursion: descending past it would
                # let a pathological tree end in a RecursionError instead of a
                # message.
                refusals.append(Refusal("depth", _shown(root, entry)))
                continue
            _walk(root, entry, prefix + (name,), found, refusals)
            continue

        if not entry.is_file():
            refusals.append(Refusal("special", _shown(root, entry)))
            continue
        if any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES):
            continue
        if not SAFE_COMPONENT.match(name):
            refusals.append(Refusal("name", _shown(root, entry)))
            continue
        found.append(("/".join(prefix + (name,)), entry))


def _refusal_message(root: Path, refusals: list) -> str:
    """Everything the walk refused, grouped, in the order REFUSAL_GROUPS sets.

    Grouped rather than listed one line per refusal with its own explanation:
    with nineteen of them the explanation is the same nineteen times, and what
    the author needs is the list of paths under it.
    """
    lines = [f"{root} cannot be published as it stands, and every path below "
             f"has to be dealt with before the next push."]
    known = {kind for kind, _ in REFUSAL_GROUPS}
    groups = list(REFUSAL_GROUPS)
    # Anything `_walk` produced that no group claims goes in one final section
    # rather than nowhere; see UNGROUPED_HEADLINE.
    if any(item.kind not in known for item in refusals):
        groups.append((None, UNGROUPED_HEADLINE))
    for kind, headline in groups:
        listed = [item for item in refusals
                  if (item.kind == kind if kind is not None
                      else item.kind not in known)]
        if not listed:
            continue
        lines.append("")
        lines.append(f"  {headline}")
        for item in listed[:MAX_REFUSALS_LISTED]:
            suffix = f" ({item.detail})" if item.detail else ""
            lines.append(f"    {item.path}{suffix}")
        if len(listed) > MAX_REFUSALS_LISTED:
            lines.append(
                f"    ... and {len(listed) - MAX_REFUSALS_LISTED} more. That is "
                f"past the point of fixing them one by one — look for a "
                f"directory that should not be packed at all.")
    return "\n".join(lines)


ELLIPSIS = "..."


def _cut_middle(text: str, cap: int) -> str:
    """`text` reduced to AT MOST `cap` characters, with the middle taken out.

    A second copy of `store._cut_middle` and it has to be: every module here
    imports the standard library and nothing else, while `src/store.py` brings
    in loguru and pydantic. The reasoning behind the shape — why the middle and
    not the tail, and why a cap no bigger than the ellipsis needs a branch of its
    own rather than the arithmetic below — lives there, with the ceiling it
    serves.
    """
    if cap <= len(ELLIPSIS):
        return text[:cap]
    keep = cap - len(ELLIPSIS)
    head = keep // 2
    tail = keep - head
    return text[:head] + ELLIPSIS + text[-tail:]


def _shown(root: Path, path: Path) -> str:
    """One path as a refusal prints it: relative, escaped, and cut to size.

    THE ONE PLACE every refused path passes through, so the escaping is here
    rather than at each of the six places that record one. It is the relative
    path that is this function's own business; the escaping and the cut below it
    are in `_shown_text`, because a refusal prints one string that is not a path
    (see there).

    ESCAPED because these names are not the author's own, whatever it looks like
    from a laptop — see MAX_REFUSAL_PATH_CHARS. `repr` escapes exactly what
    `str.isprintable()` rejects, so a control character or a newline becomes
    visible text while a cyrillic name still reads as one; and the quotes it
    adds earn their place separately, since a name with a trailing space is
    otherwise a line that looks right and cannot be typed.

    CUT AFTER ESCAPING AND ONLY THEN, which is where this parts company with
    `store._shown_untrusted`. That one cuts the raw name first as well,
    because a tar member's name is bounded by nothing at all and `repr` of a
    megabyte of control characters builds four megabytes before anything gets to
    cut it. A path out of this walk cannot be that: the filesystem bounds a
    component at 255 bytes and MAX_PATH_DEPTH bounds the components, so what
    `repr` is handed here is a couple of kilobytes at worst. The pre-cut would
    be a second mechanism guarding against something that cannot arrive — and
    nothing could tell whether it still worked.
    """
    try:
        shown = path.relative_to(root).as_posix()
    except ValueError:
        shown = str(path)
    return _shown_text(shown)


def _shown_text(text: str) -> str:
    """The escaping and the cut on their own, for the strings that are not paths.

    THE `detail` OF A REFUSAL IS ONE OF THEM, and it was the single string a
    message printed raw. `_walk` records `error.strerror or str(error)` for a
    directory it cannot list, and the fallback half of that is an OSError's own
    text — which carries the FULL PATH the exception was raised for, so an
    unlistable directory whose name holds an escape sequence put it on the
    terminal through the one line that never went through `_shown`. That is the
    shape this module keeps finding: a second way in that skips the one place
    everything was supposed to pass through.

    The quotes `repr` adds are visible in the message for a `strerror` too, and
    they earn their place there as much as on a path: "Permission denied" and
    anything with a trailing space or a newline in it read the same otherwise.
    """
    quoted = repr(text)
    if len(quoted) > MAX_REFUSAL_PATH_CHARS:
        quoted = _cut_middle(quoted, MAX_REFUSAL_PATH_CHARS)
    return quoted


def pack(root: Path, max_bytes: int = MAX_BUILD_BYTES) -> Packed:
    """Collect the tree and gzip it. Raises PackError, never writes to disk.

    In memory rather than through a temporary file: what a source tree weighs is
    kilobytes, the body has to be held for the POST anyway, and a file written
    into the project would be one more thing to exclude from the NEXT push.

    Both ceilings the hub applies are checked here — the unpacked total and the
    body — with its DEFAULT number, since the deployment's real one is unknown
    (see `limits.MAX_BUILD_BYTES`).
    """
    members = collect(Path(root))

    total = 0
    for member, path in members:
        try:
            total += path.stat().st_size
        except OSError as error:
            raise PackError(f"cannot read {member}: {error}") from error
    if total > max_bytes:
        raise PackError(
            f"the source tree unpacks to {total / 1e6:.1f} MB and the hub's "
            f"ceiling is {max_bytes / 1e6:.0f} MB")

    buffer = io.BytesIO()
    try:
        with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
            for member, path in members:
                tar.add(str(path), arcname=member, recursive=False,
                        filter=_scrub)
    except OSError as error:
        raise PackError(f"cannot pack {root}: {error}") from error

    body = buffer.getvalue()
    if len(body) > max_bytes:
        raise PackError(
            f"the archive is {len(body) / 1e6:.1f} MB and the hub's ceiling is "
            f"{max_bytes / 1e6:.0f} MB")
    return Packed(body=body, names=tuple(name for name, _ in members),
                  unpacked_bytes=total)


def _scrub(info: tarfile.TarInfo) -> tarfile.TarInfo:
    """Strip everything about the machine that packed this.

    The hub reads a member's name, type and content and nothing else, so uid,
    group, mode and mtime are pure leakage — whose laptop, which user, when. Two
    of them are also the reason an unchanged tree used to produce a different
    archive on every run: with mtime and ownership zeroed, the same sources pack
    to the same bytes, which makes a local comparison of two archives mean
    something. It does not affect the hub's own idea of "the same push" either
    way — its digest is over the file CONTENTS (`Store.accept_sources`).
    """
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mode = 0o644
    info.mtime = 0
    return info
