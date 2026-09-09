"""requirements.txt and requirements.lock, held to one story.

The image installs the LOCK — `pip install --no-cache-dir --require-hashes -r
requirements.lock` in the Dockerfile — and the lock is compiled from
requirements.txt by `make lock`, by hand and on purpose (the Makefile's `lock`
target carries the reasoning). Two files that have to agree and nothing making
them is the arrangement this project keeps out everywhere else, and here the
disagreement is silent in the worst direction: a version raised in
requirements.txt with a lock nobody regenerated means the bump reached no build
at all, while the commit that carries it reads exactly like one that did.

THE GATE COVERS PART OF THIS AND CANNOT COVER THIS PART. ci/smoke.py reads seven
versions back out of the BUILT IMAGE — the four kernel ones and the three the
preview picture needs — and compares them against its own `PINS`, so it catches
a three-edit bump done in two: PINS ahead of the image (the lock was never
regenerated) or the image ahead of PINS. What it cannot see
is the bump done in ONE — requirements.txt edited alone changes nothing in the
image, so the gate reads back exactly what it read before and says so. That is
the case this file is for, and it is cheap, because both files are text.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIREMENTS = (ROOT / "requirements.txt").read_text(encoding="utf-8")
LOCK = (ROOT / "requirements.lock").read_text(encoding="utf-8")
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")

# `name==version` at the START of a line, which is what makes the same expression
# usable on both files: in requirements.txt the pins are the only such lines, and
# in the lock every `--hash=` continuation is indented, so nothing but a pinned
# distribution can match it.
PIN_RE = re.compile(r"(?m)^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;#\\]+)")

# The one line in the Dockerfile that decides what the image's environment IS.
# Both halves are asserted: the file it reads, and `--require-hashes` — dropping
# the flag would still install the locked versions today and would quietly stop
# refusing a file whose bytes are not the ones that were resolved.
INSTALL_RE = re.compile(
    r"(?m)^RUN pip install\b[^\n]*--require-hashes\b[^\n]*-r requirements\.lock\b")

# The gate's own list of versions, counted rather than read: what the count below
# is about is how MANY pins ci/smoke.py reads back out of the image, and the names
# and versions are already compared against the image by the gate itself.
PINS_BLOCK_RE = re.compile(r"(?ms)^PINS = \{(.*?)^\}")
PINS_KEY_RE = re.compile(r'(?m)^\s*"([^"]+)":')

# Every count requirements.txt states in prose, as the sentence that carries it.
# EVERY number in these sentences is captured, including the ones that are only
# repeating a total established elsewhere: an uncaptured `\d+` reads as though it
# were checked and is not, and "Ten of those 56" is exactly where the file's size
# would go stale next. Spelled-out numbers are matched as words because that is
# how the file writes them, and WORDS below is the whole vocabulary needed.
COUNTS = {
    "resolved": r"four names out of the (\w+) distributions this file resolves to",
    "resolved again": r"The lock states all (\w+) with",
    "named here": r"(\w+) of those (\d+) are named here",
    "pinned up the tree": r"(\w+) more are pinned for us further up the tree",
    "transitive": r"the other (\w+) arrive transitively",
    "transitive again": r"THOSE (\w+) ARE PINNED TOO",
    "read back by the gate": r"ci/smoke\.py states (\w+) of this file's versions",
    "not read back": r"remaining (\w+) — what declares those is the lock",
}

# The three distributions the "pinned up the tree" sentence names in its own
# parenthesis, spelled `name==version` inside backticks. Counting them is what
# turns that sentence from a number into a claim with names behind it: the
# packages `cadquery-ocp` and `pydantic` are backticked there too and carry no
# `==`, so requiring the operator picks out exactly the three being counted.
INHERITED_RE = re.compile(r"further up the tree \(([^)]*)\)")
INHERITED_PIN_RE = re.compile(r"`([A-Za-z0-9][A-Za-z0-9._-]*)==([^`]+)`")

WORDS = {"three": 3, "four": 4, "seven": 7, "ten": 10}

# The prose with its wrapping taken out. requirements.txt is a comment file wrapped
# at ~99 columns, so a sentence routinely crosses a line break and picks up a `# `
# on the far side — "Ten of\n# those 56 are named here". Unwrapping is what lets the
# patterns above be written as the sentences a reader sees.
PROSE = re.sub(r"\s+", " ", re.sub(r"(?m)^#\s?", "", REQUIREMENTS))


def number(word):
    """`43` or `SEVEN`, whichever the sentence happened to use."""
    if word.isdigit():
        return int(word)
    assert word.lower() in WORDS, (
        f"requirements.txt spells a count as {word!r} and WORDS above does not "
        f"have that word — add it there rather than rewording the file")
    return WORDS[word.lower()]


def counts(key):
    """Every number the sentence for `key` states, in the order it states them."""
    found = re.search(COUNTS[key], PROSE)
    assert found, (
        f"requirements.txt no longer states the {key!r} count in the words this "
        f"test reads it by ({COUNTS[key]!r}). The sentence may have been reworded "
        f"rather than broken — check, then update the pattern above")
    return [number(group) for group in found.groups()]


def stated(key):
    """The one number that sentence is about."""
    return counts(key)[0]


def normalise(name):
    """PEP 503 name folding: `Pillow` here is `pillow` in the lock."""
    return re.sub(r"[-_.]+", "-", name).lower()


def pins(text):
    return {normalise(m.group(1)): m.group(2) for m in PIN_RE.finditer(text)}


def test_every_pin_in_requirements_is_the_version_the_lock_resolved():
    """A bump made without `make lock` reaches no image, and this says so."""
    locked = pins(LOCK)
    declared = pins(REQUIREMENTS)

    assert declared, "requirements.txt pins nothing at all — the parse is wrong"

    drifted = {
        name: (version, locked.get(name))
        for name, version in declared.items()
        if locked.get(name) != version
    }

    assert not drifted, (
        f"requirements.txt and requirements.lock disagree, as "
        f"{{package: (requirements.txt, requirements.lock)}}: {drifted!r}. The "
        f"image installs the LOCK, so whatever requirements.txt says here has "
        f"not reached a build and will not. Run `make lock` and commit the "
        f"result in the same commit as the pin."
    )


def test_the_dockerfile_installs_the_lock_and_requires_hashes():
    """The mechanism itself, which a one-line edit could undo in silence.

    Restoring `-r requirements.txt` there leaves every check in this repository
    green: the seven pins the gate reads back are stated in requirements.txt too,
    so the image would pass it while the other distributions went back to
    floating. (Since the dependency layer copies the lock ALONE, that swap now
    also needs the COPY line changed to bring requirements.txt back up there —
    which is a second edit, not a second check.)
    """
    assert INSTALL_RE.search(DOCKERFILE), (
        "the Dockerfile has no `RUN pip install ... --require-hashes -r "
        "requirements.lock` line. The lock is the whole point of having a lock: "
        "installing requirements.txt directly pins the ten packages named there "
        "and lets the rest of the environment — numpy included — float again."
    )


def test_the_counts_requirements_txt_states_are_the_counts_that_exist():
    """The arithmetic in that file's prose, which has been wrong twice.

    Before the lock it said "60 distributions … the remaining 53"; with the lock
    it said the gate repeats "these same four versions … the other 52" while
    ci/smoke.py's PINS held seven. Each version was internally consistent and
    externally false, which is precisely the failure a reader cannot catch: the
    paragraph reads as though somebody counted.

    Nothing else could hold these. The numbers move on a `make lock` that added
    or dropped a transitive package — an edit nobody makes to this file at all —
    and AGENTS.md is explicit that an assertion which has to stay true belongs
    in a test. So this is the test, and it counts what the prose asserts:

      * the lock's size, all three times the file states it;
      * the split of that size into named-here + inherited + transitive, with
        two of the three terms counted rather than taken on trust — only
        `transitive` is left to the sum, and it is the term nobody hand-edits;
      * how many of them the gate reads back out of the built image, and how
        many it therefore says nothing about.

    A REWORDING FAILS THIS, and that is deliberate: `counts()` says so in as
    many words, and the sentences are quoted above it. Re-checking the number
    while re-checking the pattern is the point.
    """
    resolved = len(pins(LOCK))
    assert resolved > 0, "requirements.lock parses to nothing — the regex is wrong"

    recount = (
        "A `make lock` that added or dropped a distribution is the usual reason, "
        "and the CAD-kernel block in requirements.txt has to be recounted with it")

    assert stated("resolved") == resolved, (
        f"requirements.txt says the lock resolves to {stated('resolved')} "
        f"distributions and it has {resolved}. {recount}")
    assert stated("resolved again") == resolved, (
        f"requirements.txt says the lock states all "
        f"{stated('resolved again')} and it states {resolved}. {recount}")

    named, and_of_those = counts("named here")
    assert and_of_those == resolved, (
        f"the same sentence calls the lock's size {and_of_those} and it is "
        f"{resolved}. {recount}")
    assert named == len(pins(REQUIREMENTS)), (
        f"requirements.txt says {named} of its distributions are named in it and "
        f"{len(pins(REQUIREMENTS))} are")

    # The three inherited pins are counted from the names the sentence itself
    # gives, and each is then looked for in the lock at that version and checked
    # NOT to be one of the ten named here. Without this the split would only have
    # to add up, and moving a package from `inherited` to `transitive` in the same
    # breath would pass while saying something false about both.
    parenthesis = INHERITED_RE.search(PROSE)
    assert parenthesis, (
        "requirements.txt no longer names the distributions pinned further up "
        "the tree in a parenthesis after that phrase")
    up_the_tree = dict(INHERITED_PIN_RE.findall(parenthesis.group(1)))

    inherited = stated("pinned up the tree")
    assert len(up_the_tree) == inherited, (
        f"the sentence says {inherited} distributions are pinned further up the "
        f"tree and then names {len(up_the_tree)} of them: {sorted(up_the_tree)}")

    locked = pins(LOCK)
    here = pins(REQUIREMENTS)
    for name, version in up_the_tree.items():
        assert locked.get(normalise(name)) == version, (
            f"requirements.txt says {name} arrives pinned at {version} from "
            f"further up the tree, and the lock has "
            f"{locked.get(normalise(name))!r}. {recount}")
        assert normalise(name) not in here, (
            f"{name} is counted as inherited AND named in requirements.txt "
            f"itself, so the split double-counts it")

    transitive = stated("transitive")
    assert stated("transitive again") == transitive, (
        f"requirements.txt calls the transitive remainder {transitive} in one "
        f"place and {stated('transitive again')} in the next")
    assert named + inherited + transitive == resolved, (
        f"the split does not add up: {named} named here + {inherited} pinned "
        f"further up the tree + {transitive} transitive is not the {resolved} "
        f"the lock resolved. {recount}")

    block = PINS_BLOCK_RE.search((ROOT / "ci" / "smoke.py").read_text(encoding="utf-8"))
    assert block, "ci/smoke.py no longer has a `PINS = {...}` block to count"
    read_back = len(PINS_KEY_RE.findall(block.group(1)))

    assert stated("read back by the gate") == read_back, (
        f"requirements.txt says the gate states {stated('read back by the gate')} "
        f"of its versions independently and ci/smoke.py's PINS has {read_back}")
    assert stated("not read back") == resolved - read_back, (
        f"requirements.txt says the gate is silent about "
        f"{stated('not read back')} distributions and it is silent about "
        f"{resolved - read_back} — the lock's {resolved} less the {read_back} "
        f"in PINS")
