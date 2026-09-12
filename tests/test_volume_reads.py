"""ONE RULE, KEPT BY A SCAN: nothing in the hub reads the volume bare.

    `data/` is one volume and a build can write anywhere in it, so a plain
    `open()` / `read_text()` / `read_bytes()` on a path under it can land on a
    fifo — and a plain open on a fifo never returns. Every such read goes
    through `src/safeio.py`, which opens `O_NONBLOCK` and refuses anything that
    is not a regular file.

WHY THIS IS A TEST AND NOT A PARAGRAPH IN `docs/`. Issue #74 opened as one
defect, was answered with an inventory of three, and that inventory was stale
within an hour — the second review found five, in two families the first had not
looked at, and the worst of them fired on the LISTING route an agent calls in
ordinary work. Two of the five were written by somebody who had the premise
right ("`data/` is writable by every build") in a comment directly above the
line, and had carried it as far as the file's SIZE without carrying it as far as
the file's TYPE. A rule that a reader has to re-derive at each site is a rule
that holds at the sites somebody remembered.

So the closing criterion is not a list. It is this scan coming back empty.

WHAT IT LOOKS AT, exactly, and the limits are worth knowing because a detector
that is trusted for more than it does is worse than none:

  * `src/*.py` and `src/buildproc/*.py`. NOT `src/cadbuild/`, deliberately: that
    half runs inside the build process, on the build's own tree, where the
    reader and the writer are the same program — and a build that wedges itself
    is capped by its own timeout and killed with its process group, which is
    exactly what a wedged hub thread is not.
  * four spellings — `open(...)` by bare name, `.read_text(...)`,
    `.read_bytes(...)`, and `.open(...)` on anything that is not an imported
    module. An `open()` carrying `opener=` is ours by construction
    (`safeio.nonblocking`, and `app._send_file`, which streams the handle
    itself); an `open()` whose literal mode asks for `w`, `a` or `x` is a write.

    THE FOURTH IS THERE BECAUSE IT IS THE LIKELY ONE. Every path in these
    modules is a `Path`, so `(staging / "meta.json").open("rb")` is how the
    next read gets written by somebody who never sees this file — and it read
    as `os.open`'s harmless cousin to the scan until it was taught otherwise.
  * NOT `os.open`, `gzip.open` or `tarfile.open` — an attribute call whose
    receiver is a name BOUND BY AN IMPORT in this file is skipped, which is what
    keeps those three out while `path.open()` is caught. Bound by an import, not
    proven to be a module, and that is the limit — in the indicative, because it
    is not hypothetical: `src/onboarding.py` already imports `io`, so an
    `io.open(p)` written there would pass this scan, and `io.open` IS
    `builtins.open`. A `from x import SOME_PATH` binding a `Path` object would
    pass for the same reason; no `from` import in these modules binds one today.
    What stands behind the three that ARE argued for, read rather than assumed:
      - `store` has four `os.open`, none of them a read of a file a build put
        there. Two are the unpack path, both under `dir_fd`:
        `_open_member_dir` walks each component `O_RDONLY|O_DIRECTORY|
        O_NOFOLLOW`, and `_create_member_file` creates the leaf `O_CREAT|O_EXCL|
        O_WRONLY|O_NOFOLLOW`, so it never opens a name that already exists. The
        other two open a DIRECTORY: in `_extract_members`, the uuid4 staging
        directory `Store.accept_sources` created a moment earlier, and in
        `atomic_write_bytes`, `path.parent`, reached only after a `rename` INTO
        that directory has succeeded. A directory open does not block, and a
        fifo cannot be at either name.
      - `tarfile.open` here is always given a `fileobj`, never a path.
      - the single `gzip.open` reads the request body this process spooled a
        moment earlier under a uuid4 name, which nothing can aim at.
    If a fifth spelling appears, this is where it has to be taught.
  * it reads SOURCE, so it can say a read is not `safeio`'s. It cannot say
    whether the path was on the volume — that is the judgement in `ALLOWED`
    below, and every entry there carries the reason it is not.

`ALLOWED` IS KEYED BY FUNCTION, so an entry covers every read in that function.
That is why each one is small and each one says what it reads: allowlisting a
long function would hide the next read added to it.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

# Discovered, not listed: a module added to either directory tomorrow is scanned
# from its first commit without anybody remembering to add it here.
SCANNED = sorted(SRC.glob("*.py")) + sorted((SRC / "buildproc").glob("*.py"))

READ_METHODS = frozenset({"read_text", "read_bytes"})

# A mode asking for any of these is a write, and a write to a fifo has the
# mirror-image problem but not this one — nothing in the hub writes to a path a
# build chose. Checked only on a LITERAL mode: a computed one is unknown and is
# reported, which is the right way round.
WRITE_MODE_LETTERS = ("w", "a", "x")

# Reads that are NOT on the data volume. `(module, function)` -> what it reads
# and why a build cannot reach it.
ALLOWED = {
    # `/_v/<file>` is the shared viewer bundle, served out of `static/` INSIDE
    # THE IMAGE. The Dockerfile copies that tree in as root with no `--chown`
    # and the service runs as non-root `app`, so no build has anything to write
    # there with. (It fstats `S_ISREG` all the same; what it does not need is
    # the non-blocking open, because nothing can put a fifo in the image.)
    ("src/app.py", "make_handler.HubHandler._serve_asset"):
        "static/_v, which lives in the image",

    # The page templates, likewise from the image and cached for the life of
    # the process.
    ("src/render.py", "_template"):
        "templates/, which lives in the image",

    # Everything `/start` hands out is assembled from files under the
    # repository root in the image: the agent instructions, the client's own
    # modules, the project template. None of it is under `data/`.
    ("src/onboarding.py", "skill_bytes"):
        "skill/SKILL.md, which lives in the image",
    ("src/onboarding.py", "client_bytes"):
        "the client's modules, which live in the image",
    ("src/onboarding.py", "_import_closure.tree"):
        "the client's modules, which live in the image",
    ("src/onboarding.py", "template_bytes"):
        "model_template/, which lives in the image",

    # Kernel pseudo-files. Not a path anything in this system writes, and the
    # answer is needed before any build has started at all.
    ("src/buildproc/limits.py", "_cgroup_cpu_quota"):
        "/sys/fs/cgroup, which the kernel writes",
}


def module_name(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def imported_modules(tree: ast.AST) -> set:
    """Every name an import binds in this module: `os`, `gzip`, `tarfile`, ...

    What it is FOR is the difference between `os.open(p, 0)` and `p.open("rb")`,
    which are the same shape to the parser and opposite answers to this scan.
    Each of the three module `open`s is argued for in this file's docstring; a
    name no import bound is a path, and a path is what this scan is about.

    BOUND BY AN IMPORT is the test, not "is a module" — this reads names, not
    types. The docstring's limits paragraph says what that lets through, `io`
    being one such name, already imported in `src/onboarding.py`.
    """
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                names.add(alias.asname or alias.name)
    return names


def literal_mode(call: ast.Call, index: int):
    """The mode this call asks for, when it is written out as a literal.

    `index` is where the positional mode sits, and it differs between the two
    spellings: `open(path, "rb")` puts it second, `path.open("rb")` first. A
    computed mode comes back None and the call is reported, which is the right
    way round -- an unreadable mode is not a reason to assume a write.
    """
    mode = None
    if len(call.args) > index and isinstance(call.args[index], ast.Constant):
        mode = call.args[index].value
    for keyword in call.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value
    return mode


def is_a_write_or_ours(call: ast.Call, index: int) -> bool:
    """A write, or an open this repository already owns the opener of."""
    if any(keyword.arg == "opener" for keyword in call.keywords):
        return True
    mode = literal_mode(call, index)
    return isinstance(mode, str) and any(c in mode for c in WRITE_MODE_LETTERS)


def bare_read(call: ast.Call, modules: set) -> str | None:
    """What this call is, if it is a read this module is about. None otherwise."""
    func = call.func
    if isinstance(func, ast.Attribute):
        if func.attr in READ_METHODS:
            return f".{func.attr}()"
        if func.attr != "open":
            return None
        if isinstance(func.value, ast.Name) and func.value.id in modules:
            return None
        return None if is_a_write_or_ours(call, 0) else ".open()"
    if isinstance(func, ast.Name) and func.id == "open":
        return None if is_a_write_or_ours(call, 1) else "open()"
    return None


def reads_in(source: str) -> list:
    """[(qualified name, line, spelling)] for every bare read in this source.

    The qualified name is built on the way down rather than from parent
    pointers, and it includes classes, so the handler methods inside
    `app.make_handler` come out as `make_handler.HubHandler._serve_asset` —
    stable across every edit that is not a rename.
    """
    found = []
    tree = ast.parse(source)
    modules = imported_modules(tree)

    def walk(node, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef,
                                  ast.ClassDef)):
                walk(child, f"{prefix}.{child.name}" if prefix else child.name)
                continue
            if isinstance(child, ast.Call):
                spelling = bare_read(child, modules)
                if spelling is not None:
                    found.append((prefix or "<module>", child.lineno, spelling))
            walk(child, prefix)

    walk(tree, "")
    return found


# -- the guards on the check itself ------------------------------------------

def test_the_scan_found_the_modules_it_is_about():
    """An empty file list passes every check below by looking at nothing.

    This file's own worst failure, and the one it is least able to notice: a
    renamed directory or a moved module and the sweep goes green over nothing.
    So the modules the rule is actually about are named once, here, and their
    absence is a failure rather than a quiet pass.
    """
    names = {module_name(path) for path in SCANNED}
    assert {"src/app.py", "src/comments.py", "src/jobs.py", "src/store.py",
            "src/render.py", "src/safeio.py",
            "src/buildproc/runner.py"} <= names, (
        f"the scan no longer covers the hub's modules: {sorted(names)}")


def test_the_detector_notices_the_four_spellings():
    """The method itself, on a sample carrying one of everything.

    Without this the whole file degrades into a check that passes because it
    finds nothing — which is indistinguishable, from the outside, from a repo
    that is clean.

    THE IMPORTS AT THE TOP ARE PART OF THE SAMPLE, not decoration: what tells
    `os.open` from `p.open` is whether the receiver was imported, so a sample
    without them would be testing a different rule than the one the scan runs.
    Both spellings carry a keyword `mode=` for the same reason — the positional
    mode sits second in `open(p, "rb")` and first in `p.open("rb")`, and the
    keyword form is the one that does not care which.
    """
    sample = (
        "import gzip\n"
        "import os\n"
        "from pathlib import Path\n"
        "\n"
        "def f(p):\n"
        "    a = p.read_text(encoding='utf-8')\n"
        "    b = p.read_bytes()\n"
        "    c = open(p, 'rb').read()\n"
        "    d = open(p, 'rb', opener=nonblocking)\n"
        "    e = open(p, 'wb')\n"
        "    g = open(p, mode='w')\n"
        "    h = os.open(p, 0)\n"
        "    i = p.open('rb')\n"
        "    o = p.open(mode='rb')\n"
        "    j = (p / 'meta.json').open()\n"
        "    k = p.open('w')\n"
        "    m = gzip.open(p, 'rb')\n"
        "    n = Path(p).open('rb')\n"
    )
    assert reads_in(sample) == [
        ("f", 6, ".read_text()"),
        ("f", 7, ".read_bytes()"),
        ("f", 8, "open()"),
        ("f", 13, ".open()"),
        ("f", 14, ".open()"),
        ("f", 15, ".open()"),
        ("f", 18, ".open()"),
    ]


def test_every_allowance_is_still_pointing_at_something():
    """No stale entries: an allowance for a read that is gone means nothing.

    A list that outlives what it excused is how the next reader learns that
    these entries are decoration. Removing the read is the moment to remove
    the line.
    """
    found = {(module_name(path), qualname)
             for path in SCANNED
             for qualname, _, _ in reads_in(path.read_text(encoding="utf-8"))}
    stale = sorted(key for key in ALLOWED if key not in found)
    assert not stale, (
        f"{stale} are allowed to read a file without `safeio`, and no longer "
        f"read one at all — drop the entries")


# -- the rule ----------------------------------------------------------------

def test_nothing_reads_the_data_volume_without_safeio():
    """The scan that has to come back empty. See this module's docstring.

    A NEW READ IS NOT A BUG BY ITSELF, and the failure says so: what it asks is
    that whoever wrote it decide which of two things it is. A read of a path
    under `data/` goes through `src/safeio.py` — `open_regular`,
    `read_regular_bytes`, `read_regular_text`. A read of something the image
    ships, or of a kernel file, gets a line in `ALLOWED` above saying what it
    reads and why a build cannot reach it. What must not happen is the third
    thing, which is what this issue was: neither, decided by nobody, discovered
    when a thread stopped coming back.
    """
    offenders = []
    for path in SCANNED:
        module = module_name(path)
        for qualname, lineno, spelling in reads_in(
                path.read_text(encoding="utf-8")):
            if (module, qualname) in ALLOWED:
                continue
            offenders.append(f"{module}:{lineno} in {qualname}: {spelling}")
    assert not offenders, (
        "these read a file without going through `src/safeio.py`:\n  "
        + "\n  ".join(offenders)
        + "\n\n`data/` is one volume and every build can write anywhere in it "
          "(src/buildproc), so a path under it can be a fifo and a plain open "
          "on a fifo never returns — the thread is gone, silently. Read it "
          "with `safeio.open_regular` / `read_regular_bytes` / "
          "`read_regular_text`, or, if the file is not on that volume, add the "
          "function to ALLOWED in this file with the reason.")


# -- what safeio itself promises ---------------------------------------------

def test_safeio_is_importable_without_the_hub():
    """`src/buildproc/runner.py` reads a file and imports no hub module.

    The build half of the package is kept clear of `store`/`app`/`jobs`, so a
    helper that reached for one would be a helper the runner could not use and
    the rule would have a hole exactly where the untrusted code runs. Asserted
    against the SOURCE rather than by importing, because by the time this test
    runs the hub is already imported and every import would succeed.
    """
    tree = ast.parse((SRC / "safeio.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            imported.add(node.module or "")
    ours = sorted(name for name in imported
                  if name.split(".")[0] in ("src", "hammerola"))
    assert not ours, (
        f"src/safeio.py imports {ours}; it is imported BY "
        f"src/buildproc/runner.py, which must not pull the hub in behind it")
