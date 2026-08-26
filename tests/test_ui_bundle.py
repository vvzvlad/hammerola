"""One path, written in five files, checked here for agreement.

The browser bundle is built rather than committed, so its path is not a fact any
one file owns — it is an agreement between five that never import each other:

    ui/vite.config.mjs      names the FILE the build emits
    Makefile                names the files a workstation build copies, and where
    Dockerfile              names the same files again, one `COPY --from=ui` each
    ci/smoke.py             asserts the resulting paths are inside the image
    templates/build.html    fetches the entry over HTTP with a <script src>

Nothing makes them agree and nothing reports it when they stop. That is the
whole reason this file exists, because every way of breaking the agreement
breaks it QUIETLY:

  * rename the vite output and the gate looks for a file that is no longer
    produced -- the image build fails at its COPY line, which is the loud half,
    but nothing then verifies the real bundle at all;
  * change the Makefile's destination and a workstation serves 404 while CI
    stays perfectly green, because the image never used the Makefile;
  * change the Dockerfile's destination and it is the exact reverse -- the
    workstation is fine and only the published image is broken;
  * change the <script src> and EVERYTHING is green. The bundle is built, it is
    in the image, the gate finds it, the page loads, the old viewer works. The
    only symptom is a 404 in a browser console.

The last one is why this is a test and not a code review note.

The checks below DERIVE the path from vite.config.mjs and the Makefile instead
of spelling it out: a test that carried its own copy of the string would just be
a sixth place to forget, and it would pass while agreeing only with itself.

Two of the checks are about something else: not where the bundle goes, but what
keeps a WORKSTATION's build from becoming the image's — the `.dockerignore`
exclusion and the Dockerfile's copy order. They belong here because they are
derived from the same name, and their docstrings say why neither is redundant.
"""

import fnmatch
import re
from collections import namedtuple
from pathlib import Path

import pytest

from ci.smoke import REQUIRED_PATHS

ROOT = Path(__file__).resolve().parent.parent

# Where the image puts the application. Everything in REQUIRED_PATHS is absolute
# inside the container, and everything in this repository is relative to the
# checkout; this is the one constant that converts between them.
IMAGE_ROOT = "/app"

# The directory templates/build.html reaches static assets through. The hub
# serves `static/_v/` at the URL `/_v/`, so a path under `static/` becomes a URL
# by dropping that first component.
STATIC_DIR = "static"

# The directive the bundle must be copied in AFTER — see the ordering test below.
# Anchored to the start of a line rather than searched for as a substring because
# the Dockerfile's PROSE names this directive too, in the comment that explains
# the ordering. That comment travels with the stage copy when somebody moves it,
# so a substring search would find the moved text and pass.
STATIC_TREE_COPY_RE = re.compile(r"(?m)^COPY\s+static/\s+static/\s*$")

# `COPY [--flag ...] --from=<stage> [--flag ...] <src> <dest>`, one match per line.
# The flags are tolerated rather than required: `--link` and `--chown` are ordinary
# things to add to a `COPY --from`, and a pattern that only accepted the bare form
# would report the line as ABSENT instead of reporting what changed — which sends
# whoever reads the failure looking for a line that is right there.
COPY_FROM = re.compile(
    r"(?m)^COPY\s+(?:--\S+\s+)*--from=(\S+)\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$")

# The same directive matched LOOSELY, without caring about the shape of its
# operands. COPY_FROM reads exactly two, so `COPY --from=ui a.js b.js static/_v/` —
# the obvious thing to write the day this build emits a second file — matches it
# nowhere at all, and a line that matches nothing is a line that leaves the list
# every check here is built from. This pattern is what makes such a line VISIBLE,
# so a form nobody anticipated turns the suite red instead of shortening it.
COPY_FROM_ANY = re.compile(r"(?m)^COPY\s+.*--from=.*$")

# An HTML comment. Stripped before the page is searched, so that a check cannot be
# satisfied by PROSE: build.html explains itself at length, and a `<script src>`
# quoted in a comment — or commented out during a debugging session and left that
# way — would answer a search that reads the file whole while the browser fetches
# nothing. Same class of mistake as reading a setting out of vite's own comments,
# which is why the reads below are anchored.
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)

# One parsed `COPY --from=` line. `dest` is the destination AS WRITTEN, `file` is
# the path docker really writes — the two differ whenever `dest` names a directory
# — and `file` is None when the SOURCE is a directory, because a copy of a tree has
# no single written path to speak of. `at` is the line's offset in the Dockerfile,
# carried along because the ordering test's whole subject is where the line sits.
StageCopy = namedtuple("StageCopy", "stage src dest file at")


def read(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def read_markup(*parts):
    """A template with its comments removed — see HTML_COMMENT."""
    return HTML_COMMENT.sub("", read(*parts))


def looks_like_a_file(src):
    """Whether a COPY source names a single FILE rather than a directory.

    Decided from the TEXT, because that is all there is: the source is a path
    inside a build stage that nothing in this suite can stat. The signal is the
    extension, and it answers this particular question reliably — every name this
    build can emit carries one by construction (vite's `entryFileNames`,
    `chunkFileNames` and `assetFileNames` all end in `.js`, `.css` or the asset's
    own extension), while the directories anybody would plausibly write here
    (`/ui/dist`, `/ui/dist/assets`) carry none. A trailing slash settles it
    outright: docker reads that as a directory whatever the name in front says.
    """
    return not src.endswith("/") and Path(src).suffix != ""


def dest_file(src, dest):
    """Where `COPY <src-file> <dest>` actually writes, with the directory form spelled out.

    `COPY <src-file> <dir>/<name>` and `COPY <src-file> <dir>/` are the same
    directive to docker — a destination ending in a slash is a directory, and the
    source keeps its own name inside it — so both have to reduce to one path before
    anything here compares one. Normalising in a single place is what keeps the
    trailing-slash spelling INSIDE the checks below rather than outside all of them:
    `Path("static/_v/").parent` is `static`, so the filter this file used to run
    dropped that line, and the file it puts in the image ended up checked by
    nothing — not the gate, not UI_FILES, not the page.
    """
    return f"{dest}{Path(src).name}" if dest.endswith("/") else dest


def targets_out_dir(dest, out_dir):
    """Whether a COPY destination writes into the bundle's directory, however spelled.

    Deliberately coarse, and asked BEFORE the line is understood: this is what
    decides which lines are this file's business, so it has to say yes to every
    spelling that reaches that directory — including the ones the checks below
    cannot read. A line that names the directory and is not understood has to become
    a failure; a line quietly not recognised as naming it is the exact silence this
    file exists to remove.
    """
    return dest.rstrip("/") == out_dir or dest.startswith(f"{out_dir}/")


@pytest.fixture(scope="module")
def entry_name():
    """The file name vite is configured to emit for the entry chunk.

    Read out of the config rather than assumed, because this is the end of the
    chain everything else has to follow: rollup writes whatever this says, and
    the other four files are only correct relative to it.

    Matched as a whole LINE of the settings block, never as a substring anywhere in
    the file. vite.config.mjs opens with twenty-seven lines of prose that name these
    settings, and a `//` comment cannot begin a line with `entryFileNames:` — so
    anchoring is what keeps this read on the setting rollup obeys. A substring
    search takes the FIRST occurrence, so the day the setting is renamed and the
    comment above it keeps the old name, all five files agree on a name vite no
    longer emits, and the failure surfaces at a `COPY` or a `cp` instead of here.
    """
    config = read("ui", "vite.config.mjs")
    match = re.search(r"(?m)^\s*entryFileNames:\s*['\"]([^'\"]+)['\"],?\s*$", config)
    assert match, (
        "ui/vite.config.mjs does not set rollupOptions.output.entryFileNames. "
        "Without it vite emits a CONTENT-HASHED name, which no other file here "
        "can predict -- see the comment beside the setting."
    )
    name = match.group(1)
    assert "[" not in name, (
        f"the vite entry name {name!r} contains a rollup placeholder, so the "
        "built file's name is not knowable from the source. The four files that "
        "hard-code this path cannot follow a name that changes per build."
    )
    return name


@pytest.fixture(scope="module")
def out_dir():
    """The directory `make ui` copies the build into, as written in the Makefile."""
    makefile = read("Makefile")
    match = re.search(r"(?m)^UI_OUT\s*:?=\s*(\S+)\s*$", makefile)
    assert match, (
        "the Makefile no longer defines UI_OUT. It is the single place the "
        "bundle's destination directory is written; if the `ui` target grew its "
        "own literal path instead, this whole file stopped checking anything."
    )
    directory = match.group(1)
    parts = directory.split("/")
    assert parts[0] == STATIC_DIR, (
        f"UI_OUT is {directory!r}, which is not under {STATIC_DIR}/. The hub only "
        "serves assets from there, so a bundle anywhere else is unreachable over "
        "HTTP no matter how correctly it is built."
    )
    assert len(parts) == 2, (
        f"UI_OUT is {directory!r}, which is not `{STATIC_DIR}/<one name>`. The URL "
        "test below derives what the page must fetch by dropping the leading "
        f"`{STATIC_DIR}/`, and that only makes sense for exactly two components: "
        "the hub serves `/_v/<one path component>` and nothing deeper. Checked "
        "here so the mismatch is this sentence rather than an IndexError there."
    )
    return directory


@pytest.fixture(scope="module")
def ui_files():
    """The file names `make ui` copies out of the build, as written in the Makefile.

    Read once and shared, because two tests check this list against two different
    files — vite's entry name and the Dockerfile's `COPY --from=ui` lines — and a
    second copy of the pattern is a second thing to forget.
    """
    makefile = read("Makefile")
    match = re.search(r"(?m)^UI_FILES\s*:?=\s*(.+?)\s*$", makefile)
    assert match, (
        "the Makefile no longer defines UI_FILES. It is the explicit list of "
        "what `make ui` copies into static/_v/, and it is a list rather than a "
        "glob or a `cp -R` for the same reason the Dockerfile copies by name: "
        "that directory also holds committed assets a wildcard could clobber."
    )
    return match.group(1).split()


@pytest.fixture(scope="module")
def stage_copies():
    """Every `COPY --from=` in the Dockerfile, parsed into StageCopy.

    The parse is asserted to be COMPLETE, and that assertion is the fixture's real
    job rather than a precaution. COPY_FROM reads exactly two operands, so a
    multi-source line does not match it at all and would simply be missing from this
    list; every check below then reads "every stage copy is ..." over a list the
    line in question is not in, passes, and reports nothing. Nothing else here can
    tell "there is no such line" from "there is one and it was not understood", so
    the difference is made once, in front of all of them.
    """
    dockerfile = read("Dockerfile")
    unparsed = [m.group(0) for m in COPY_FROM_ANY.finditer(dockerfile)
                if not COPY_FROM.fullmatch(m.group(0))]
    assert not unparsed, (
        f"these `COPY --from=` lines are not `<source> <destination>`: {unparsed!r}. "
        "Every check in this file reads the stage copies as that pair, so a line in "
        "any other shape -- several sources, a JSON array -- is absent from the list "
        "rather than checked, and whatever it brings into the image is covered by "
        "nothing at all. Give each source a line of its own, or teach COPY_FROM the "
        "new shape in the same commit."
    )
    return [
        StageCopy(
            stage=m.group(1),
            src=m.group(2),
            dest=m.group(3),
            file=dest_file(m.group(2), m.group(3)) if looks_like_a_file(m.group(2))
            else None,
            at=m.start(),
        )
        for m in COPY_FROM.finditer(dockerfile)
    ]


@pytest.fixture(scope="module")
def bundle_copies(stage_copies, out_dir):
    """The stage copies that put ONE NAMED FILE into the bundle's directory.

    Selected by DESTINATION rather than by stage name, so that a renamed stage shows
    up as a broken destination here instead of quietly dropping every assertion
    below -- a filter on a name nobody checks is how a test stops testing without
    failing. The selection itself is written the same way, because it is where that
    very failure happened: a line that names this directory in a shape which does
    not reduce to one file is REPORTED here, never dropped. The filter this fixture
    used to carry compared `Path(dest).parent` against the directory, and `Path`
    normalises a trailing slash away -- so `static/_v/` came out as `static`, the
    entirely ordinary `COPY --from=ui /ui/dist/x.js static/_v/` fell out of the
    list, and every assertion below went on passing over the shortened one.

    The merging form -- a DIRECTORY as the source -- is the one shape deliberately
    let past. test_the_bundle_is_copied_file_by_file reads the full list and says
    what a directory copy does to this directory; raising it here as well would bury
    that message under fixture errors on four other tests.
    """
    copies, stray = [], []
    for copy in stage_copies:
        if not targets_out_dir(copy.dest, out_dir) or copy.file is None:
            continue
        # What is left of the destination once the directory is taken off the front.
        # Exactly one component with no slash in it is the shape everything below
        # assumes; anything else is reported rather than dropped.
        inside = (copy.file[len(out_dir) + 1:]
                  if copy.file.startswith(f"{out_dir}/") else "")
        if inside and "/" not in inside:
            copies.append(copy)
        else:
            stray.append(copy)

    assert not stray, (
        f"these `COPY --from=` lines write into {out_dir} in a form that is not one "
        f"named file inside it: {[(c.src, c.dest) for c in stray]!r}. Every check "
        f"below is written over the list of files the stage places in {out_dir}/, so "
        "a destination that cannot be reduced to exactly one name there is a file "
        "the gate, UI_FILES and the page all know nothing about. A destination that "
        "IS the directory, written without a trailing slash, is ambiguous to docker "
        "as well; one with a further path component cannot be served at all, since "
        "the hub serves `/_v/<one path component>` and nothing deeper."
    )
    assert copies, (
        f"the Dockerfile has no `COPY --from=<stage> <src> {out_dir}/<file>` "
        f"line, so nothing puts a built bundle in the image. Stage copies found: "
        f"{[(c.stage, c.src, c.dest) for c in stage_copies]!r}."
    )
    return copies


def test_the_gate_looks_for_the_file_vite_actually_builds(entry_name, out_dir):
    """ci/smoke.py check (g) against vite's output name and the Makefile's directory.

    The gate is the only thing that ever looks INSIDE the published image, so a
    path that drifts here is a check that quietly proves nothing about the file
    it is named after.
    """
    expected = f"{IMAGE_ROOT}/{out_dir}/{entry_name}"

    assert expected in REQUIRED_PATHS, (
        f"REQUIRED_PATHS in ci/smoke.py does not contain {expected!r}, which is "
        f"where vite's entryFileNames ({entry_name!r}) and the Makefile's UI_OUT "
        f"({out_dir!r}) say the bundle ends up. Whichever of the three moved, the "
        "other two have to move with it in the same commit."
    )


def test_every_copied_bundle_file_is_checked_by_the_gate(bundle_copies):
    """Each `COPY --from=ui` destination has a row in REQUIRED_PATHS.

    The two lists answer opposite questions and only together cover the pair of
    mistakes available here. A file the Dockerfile copies but the gate does not
    check can vanish from the build and reach the registry unnoticed; a file the
    gate checks but no COPY brings in fails every build. Requiring the COPY set
    to be a subset of the checked set closes the first; the entry-name test above
    closes the second for the one file that must always exist.
    """
    unchecked = [
        copy.file for copy in bundle_copies
        if f"{IMAGE_ROOT}/{copy.file}" not in REQUIRED_PATHS
    ]

    assert not unchecked, (
        f"the Dockerfile copies {unchecked!r} into the image, and REQUIRED_PATHS "
        "in ci/smoke.py does not check for it. Nothing else looks inside the "
        "artefact, so a build that stopped producing that file would publish an "
        "image missing it with every check green."
    )


def test_the_bundle_is_copied_file_by_file(stage_copies, out_dir):
    """No `COPY --from=ui /ui/dist static/_v` — the merging form.

    static/_v/ holds committed assets (site.css, index.js, pointer.js,
    pointer_pref.js, the vendored viewer) and the build output lands among them,
    so a directory copy MERGES the two. `index.js` is an entirely ordinary name for a bundler to
    emit, and a collision there silently replaces the hub's own file. The publish
    gate cannot see it: check (g) asks whether a path EXISTS, and after such an
    overwrite it still does.

    A per-file copy makes that impossible -- nothing enters the image unless a
    line asks for it by name. This test is what keeps someone from collapsing the
    lines back into one when a second output file appears, which is exactly when
    it will look like an obvious tidy-up.

    It reads the FULL list of stage copies, not the bundle ones, and that is the
    difference between a check and a decoration. The merging form names no file, so
    ANY filter that selects "copies of a file into static/_v/" excludes precisely
    the line this test is about -- run over the filtered list it inspects a set the
    offending line is by definition not in, and passes. That is what it did until
    now, including with the merging line written directly beside the per-file one it
    was supposed to catch.
    """
    merging = [(copy.src, copy.dest) for copy in stage_copies
               if targets_out_dir(copy.dest, out_dir) and copy.file is None]

    assert not merging, (
        f"these `COPY --from=` lines copy a DIRECTORY into {out_dir}: {merging!r}. "
        f"That merges the build output into {out_dir}/, where it lands among this "
        "project's committed assets and a name collision -- `index.js` is an "
        "entirely ordinary thing for a bundler to emit -- silently replaces one of "
        "them. Copy each built file by name, on a line of its own, so that nothing "
        "enters the image unless a line asks for it."
    )


def test_the_stage_copy_runs_after_the_static_tree(bundle_copies):
    """Ordering is what makes the image's own build win.

    Two defences keep a workstation's `make ui` output from becoming the image's
    bundle, and each covers exactly what the other cannot. `.dockerignore`
    excludes `static/_v/hammerola*`, and that is the only one that can keep out a
    file THIS build no longer emits — a chunk from an older vite config would
    otherwise ride in on `COPY static/ static/` and stay, because there is nothing
    of that name left to overwrite it. Ordering is what still holds when somebody
    deletes that line, which no build would fail: the stage copy sits BELOW
    `COPY static/ static/`, so a laptop's bundle carried in by the static tree is
    replaced by the one built from THIS commit. Swap the two and the laptop's copy
    wins instead, and nothing reports it: both are valid JavaScript, the page
    works, and the gate only asks whether the path exists.

    The directive is matched at the START OF A LINE, not as a substring: the
    Dockerfile's own prose names `COPY static/ static/` while explaining this
    ordering, and that comment moves together with the stage copy.

    The other defence is checked by the test below, and neither of the two is
    redundant — the reasoning is written out there.
    """
    dockerfile = read("Dockerfile")
    matches = list(STATIC_TREE_COPY_RE.finditer(dockerfile))
    assert len(matches) == 1, (
        f"the Dockerfile has {len(matches)} lines matching "
        f"{STATIC_TREE_COPY_RE.pattern!r}, not one. This test's whole premise is "
        "that the static tree is copied once, at a position the bundle copy has "
        "to sit after; with the directive gone, or written twice, there is no "
        "single such position and the premise needs rechecking against whatever "
        "replaced it."
    )
    static_at = matches[0].start()

    for copy in bundle_copies:
        assert copy.at > static_at, (
            f"`COPY --from=... {copy.dest}` appears BEFORE `COPY static/ static/`, so "
            "a bundle left in the build context by a local `make ui` would "
            "overwrite the one this image just built. Move the stage copy back "
            "below the static tree."
        )


def test_the_context_excludes_a_workstation_build(entry_name, out_dir):
    """`.dockerignore` keeps a local `make ui` out of the build context.

    The sibling of the ordering test above, and both are checked because neither
    covers the other's case. Ordering can only settle a file the stage ALSO emits --
    winning there means being copied over the same name -- so a chunk an older vite
    config produced and this build no longer does rides in on `COPY static/ static/`
    with nothing left to overwrite it, and ships inside the image as a file no
    commit can account for. Only the exclusion keeps that one out. In the other
    direction the exclusion is a string SOMEBODY CAN DELETE WITHOUT ANY BUILD
    FAILING -- the image still builds, the gate still passes, the page still works
    -- and the ordering is what still holds afterwards. A line whose removal breaks
    nothing at all is exactly the kind that needs a test rather than a comment.

    Two things are asked of the pattern, and the second is not pedantry. It has to
    cover today's entry file, and it has to be a GLOB over the shared prefix rather
    than that file's own name: the file this line exists to keep out is the one the
    build NO LONGER emits, whose name is by definition not knowable from anything in
    this repository. So the check hands it a name that exists nowhere and requires
    that to be covered too.

    The prefix is derived from the entry name rather than written out, for the
    reason the module docstring gives -- a copy of that string here would be one
    more place to forget -- and it is the entry's stem because that is what vite's
    three output settings share: `hammerola.js`, `hammerola-[name].js`,
    `hammerola.[ext]`.
    """
    prefix = entry_name.split(".")[0]
    entry = f"{out_dir}/{entry_name}"
    stale = f"{out_dir}/{prefix}-a-chunk-an-older-config-emitted.js"

    # A `!` line is an exception -- the opposite of a net -- so it can never be the
    # pattern that covers anything, and a leading slash is one docker itself strips.
    # The matcher is fnmatch rather than docker's own, and it is the more permissive
    # of the two (`*` crosses a `/` here and does not there), so this can accept a
    # pattern docker would read more narrowly. That is the safe direction for the one
    # thing it must never do: pass with no excluding line in the file at all.
    patterns = [line.strip().lstrip("/") for line in read(".dockerignore").splitlines()]
    patterns = [p for p in patterns if p and not p.startswith(("#", "!"))]
    covering = [p for p in patterns
                if fnmatch.fnmatchcase(entry, p) and fnmatch.fnmatchcase(stale, p)]

    assert covering, (
        f".dockerignore has no pattern covering both {entry!r} and {stale!r}, so a "
        "workstation's `make ui` output reaches the build context and is carried "
        "into the image by `COPY static/ static/`. Today's file is merely overwritten "
        "a few lines later by the stage's own copy; a chunk this build stopped "
        "emitting has nothing to overwrite it and ships in the published image as a "
        f"file no commit can account for. Patterns read from the file: {patterns!r}."
    )


def test_the_copy_names_a_stage_the_dockerfile_defines(bundle_copies):
    """`COPY --from=x` with no `AS x` is read by docker as an IMAGE name.

    Everything between `FROM` and `AS` is left unconstrained on purpose. The
    node stage is a natural place for `--platform=$BUILDPLATFORM`, which is the
    correct way to keep a cross-build from running node under qemu, and a pattern
    that insisted on a bare image reference would answer that edit with "names a
    stage the Dockerfile does not define" — a message pointing at the wrong file.
    """
    dockerfile = read("Dockerfile")
    for copy in bundle_copies:
        assert re.search(rf"(?mi)^FROM\s+.*\bAS\s+{re.escape(copy.stage)}\s*$",
                         dockerfile), (
            f"`COPY --from={copy.stage}` names a stage the Dockerfile does not "
            "define. Docker would try to pull it as an image."
        )


def test_the_makefile_copies_the_same_files_by_name(entry_name, out_dir, ui_files):
    """UI_FILES against vite's entry.

    The Makefile is the half of the build the image never runs, so a divergence
    here is invisible to CI entirely: everything published stays correct while a
    workstation serves a stale file, or none.
    """
    assert entry_name in ui_files, (
        f"UI_FILES is {ui_files!r} and does not include {entry_name!r}, the entry "
        "vite is configured to emit. `make ui` would build the bundle and then "
        "not copy it."
    )
    assert not any(any(ch in name for ch in "*?[") for name in ui_files), (
        f"UI_FILES contains a wildcard: {ui_files!r}. It has to be literal names. "
        f"The recipe copies each one out of ui/dist/ into {out_dir}/ by name, so a "
        "pattern either matches nothing and fails the copy on a build that was "
        "fine, or matches more than the build emitted and drags it in. And this "
        "list is what the Dockerfile's `COPY --from=ui` destinations are compared "
        "against below, which is only meaningful while both sides name files."
    )


def test_the_makefile_copies_every_file_the_image_does(bundle_copies, ui_files):
    """UI_FILES against the Dockerfile's per-file `COPY --from=ui` rules.

    The two halves of the build are written in different files and neither reads
    the other, so a second output can be added to one and forgotten in the other.
    A name the Dockerfile copies and UI_FILES omits is the silent direction: the
    image is complete, the gate is green, CI never runs the Makefile at all — and
    a workstation serves a page missing that chunk, which only a browser console
    reports.

    ONE DIRECTION ONLY, deliberately. The reverse — a name in UI_FILES the
    Dockerfile does not copy — is already loud: `make ui` copies each name out of
    ui/dist/ and the copy fails on the spot when the build did not emit it. This
    test covers the half that has no such symptom, and the asymmetry is the reason
    rather than an oversight.
    """
    missing = sorted({Path(copy.file).name for copy in bundle_copies}
                     - set(ui_files))

    assert not missing, (
        f"the Dockerfile copies {missing!r} out of the `ui` stage and UI_FILES in "
        f"the Makefile is {ui_files!r}, which does not name it. The image and the "
        "publish gate both know about that file; `make ui` does not, so a "
        "workstation would serve the page without it while every check stays "
        "green."
    )


def test_the_page_loads_the_bundle_from_that_path(entry_name, out_dir):
    """templates/build.html against the same derived path.

    This is the failure with no symptom anywhere but a browser console: the
    build, the image, the gate and the rest of the page are all unaffected by a
    wrong `src`.
    """
    url = f"/{out_dir.split('/', 1)[1]}/{entry_name}"
    html = read_markup("templates", "build.html")
    sources = re.findall(r"<script[^>]*\bsrc=[\"']([^\"']+)[\"']", html)

    assert url in sources, (
        f"templates/build.html loads no script from {url!r}. It currently loads "
        f"{sources!r}. Nothing else in this repository would notice: the bundle "
        "is still built, still copied into the image and still found by the "
        "publish gate -- the page just never fetches it."
    )


def test_the_page_loads_nothing_but_the_bundle(entry_name, out_dir):
    """And no second script beside it — the old page viewer above all.

    The build page used to be driven by a page script of its own, which built the
    header, the panels and the comment form out of the markup the template
    carried. Both are gone: the interface draws all of it, and that script is not
    in the repository or the image any more.

    What this guards is the shape of the failure if it comes back. The two would
    not conflict loudly — the old script mounted into a `#cad_viewer` this
    template no longer has, so it would fail somewhere in the console while the
    interface rendered over the top of it and the page LOOKED right. Meanwhile
    the browser would fetch a 404 on every load, both would bind the library's
    keymap and the wheel, and the pointer-preference key would get two writers.
    Nothing else here would notice: the bundle test above only asserts its own
    `src` is PRESENT, and the publish gate asks whether paths exist rather than
    which ones the page asks for.

    So this asserts the whole list rather than the absence of one name: any
    second `<script src>` on this page is the thing worth stopping, whatever it
    is called.
    """
    url = f"/{out_dir.split('/', 1)[1]}/{entry_name}"
    html = read_markup("templates", "build.html")
    sources = re.findall(r"<script[^>]*\bsrc=[\"']([^\"']+)[\"']", html)

    assert sources == [url], (
        f"templates/build.html loads {sources!r}; the only script it may load is "
        f"{url!r}. A page script beside the bundle is a 404 or a second driver "
        "for the same viewer, and neither shows up as a broken page."
    )


def test_the_page_carries_the_mount_point():
    """The <div> the bundle looks for, and the reason a wrong `src` is silent.

    ui/src/main.jsx mounts only when it finds this id and does nothing at all
    when it does not -- deliberately, so the pages that do not carry it stay
    clean. That tolerance is exactly what makes a missing mount point invisible
    from the JavaScript side, so it is checked from the HTML side instead.

    Both reads skip the files' COMMENTS, for the same reason the entry name is read
    off an anchored line: main.jsx's own header names #hmr_root while explaining why
    the mount is conditional, so a search that reads prose could agree with a
    paragraph about the id long after the call below it stopped using it.
    """
    html = read_markup("templates", "build.html")
    main = read("ui", "src", "main.jsx")

    match = re.search(
        r"(?m)^(?!\s*//).*\bdocument\.getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)",
        main)
    assert match, "ui/src/main.jsx no longer looks its mount point up by id"
    mount_id = match.group(1)

    assert re.search(rf"""id=["']{re.escape(mount_id)}["']""", html), (
        f"ui/src/main.jsx mounts into #{mount_id}, which templates/build.html "
        "does not contain. The bundle would load and render nothing, silently."
    )
