"""One path, written in five files, checked here for agreement.

The browser bundle is built rather than committed, so its path is an agreement
between five files that never import each other:

    ui/vite.config.mjs      names the FILE the build emits
    Makefile                names the files a workstation build copies, and where
    Dockerfile              names the same files again, one `COPY --from=ui` each
    ci/smoke.py             asserts the resulting paths are inside the image
    templates/*.html        the pages fetch the entry with a <script src>

Every way of breaking it is quiet: a renamed vite output leaves the gate checking
nothing; a changed Makefile destination breaks only workstations; a changed
Dockerfile destination breaks only the image; a changed <script src> leaves
everything green except a 404 in the browser console.

The checks derive the path from vite.config.mjs and the Makefile rather than
spelling it out, so this file is not a sixth copy.

Two checks keep a workstation's build from becoming the image's: the
`.dockerignore` exclusion and the Dockerfile's copy order.
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

# The directory the templates reach static assets through. The hub serves
# `static/_v/` at the URL `/_v/`, so a path under `static/` becomes a URL by
# dropping that first component.
STATIC_DIR = "static"

# The pages drawn by the bundle. Written out, not discovered, and checked against
# the templates (test_exactly_these_pages_load_the_bundle). pointer.html loads a
# committed script of its own and mounts nothing.
BUNDLE_PAGES = ("build.html", "index.html")

TEMPLATES = "templates"

# The directive the bundle must be copied in after (see the ordering test).
# Anchored to a line start because the Dockerfile's comments name it too.
STATIC_TREE_COPY_RE = re.compile(r"(?m)^COPY\s+static/\s+static/\s*$")

# `COPY [--flag ...] --from=<stage> [--flag ...] <src> <dest>`, one match per line.
# Flags such as `--link` and `--chown` are tolerated, so such a line is read
# rather than reported as absent.
COPY_FROM = re.compile(
    r"(?m)^COPY\s+(?:--\S+\s+)*--from=(\S+)\s+(?:--\S+\s+)*(\S+)\s+(\S+)\s*$")

# The same directive matched loosely. COPY_FROM reads exactly two operands, so a
# multi-source line matches nowhere; this pattern makes such a line visible so it
# fails the suite instead of leaving the list.
COPY_FROM_ANY = re.compile(r"(?m)^COPY\s+.*--from=.*$")

# An HTML comment, stripped before a page is searched so a `<script src>` quoted
# or commented out in prose cannot satisfy a check.
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)

# One parsed `COPY --from=` line. `dest` is the destination as written, `file` the
# path docker really writes (they differ when `dest` names a directory), None
# when the source is a directory. `at` is the line's offset, for the ordering
# test.
StageCopy = namedtuple("StageCopy", "stage src dest file at")


def read(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


def read_markup(*parts):
    """A template with its comments removed — see HTML_COMMENT."""
    return HTML_COMMENT.sub("", read(*parts))


def looks_like_a_file(src):
    """Whether a COPY source names a single FILE rather than a directory.

    Decided from the text (the path is inside a build stage). Every name this
    build emits has an extension (vite's `entryFileNames`, `chunkFileNames`,
    `assetFileNames`), plausible directories (`/ui/dist`) have none, and a
    trailing slash is always a directory.
    """
    return not src.endswith("/") and Path(src).suffix != ""


def dest_file(src, dest):
    """Where `COPY <src-file> <dest>` actually writes, with the directory form spelled out.

    `COPY <src-file> <dir>/<name>` and `COPY <src-file> <dir>/` are the same to
    docker, so both reduce to one path here before any comparison. (`Path` would
    drop the trailing slash and misread `static/_v/` as `static`.)
    """
    return f"{dest}{Path(src).name}" if dest.endswith("/") else dest


def targets_out_dir(dest, out_dir):
    """Whether a COPY destination writes into the bundle's directory, however spelled.

    Deliberately coarse: it decides which lines are this file's business, so it
    must say yes to every spelling, including ones the checks below cannot read —
    those then fail instead of being skipped.
    """
    return dest.rstrip("/") == out_dir or dest.startswith(f"{out_dir}/")


@pytest.fixture(scope="module")
def entry_name():
    """The file name vite is configured to emit for the entry chunk.

    The end of the chain the other four files follow. Matched as a whole line of
    the settings block, never as a substring: vite.config.mjs opens with prose
    naming these settings, and a `//` line cannot start with `entryFileNames:`.
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

    The parse is asserted complete: a multi-source line does not match
    COPY_FROM, and without this assertion it would be missing from the list and
    every "every stage copy is ..." check would pass over it.
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

    Selected by destination, not stage name, so a renamed stage shows up as a
    failure rather than dropping every assertion. A line naming this directory in
    a shape that does not reduce to one file is reported, never dropped.

    A directory as the source (the merging form) is let past here:
    test_the_bundle_is_copied_file_by_file reports it with its own message.
    """
    copies, stray = [], []
    for copy in stage_copies:
        if not targets_out_dir(copy.dest, out_dir) or copy.file is None:
            continue
        # The destination below the directory must be exactly one component;
        # anything else is reported.
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

    The COPY set must be a subset of the checked set, or a file can vanish from
    the build unnoticed; the entry-name test above covers the reverse for the one
    file that must exist.
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
    pointer_pref.js, the vendored viewer), so a directory copy can silently
    overwrite one (`index.js` is an ordinary bundler output name), and check (g)
    only asks whether a path exists. Per-file copies admit nothing unnamed.

    Reads the full list of stage copies: the merging form names no file, so any
    "copies of a file" filter would exclude exactly the line this test is about.
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

    The stage copy sits below `COPY static/ static/`, so a laptop's bundle carried
    in by the static tree is replaced by the one built from this commit; swapped,
    the laptop's copy wins silently. This still holds if the `.dockerignore` line
    is deleted (no build would fail); the exclusion, checked below, covers files
    this build no longer emits, which ordering cannot overwrite.

    The directive is matched at the start of a line: the Dockerfile's comments
    name it too.
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

    Ordering only settles files the stage also emits; a chunk an older vite
    config produced would ride in on `COPY static/ static/` and ship. Only the
    exclusion keeps that out.

    The pattern must cover today's entry and be a glob over the shared prefix:
    the file it must keep out is one this build no longer emits, so a made-up
    name is required to be covered too. The prefix is the entry's stem, which
    vite's three output settings share (`hammerola.js`, `hammerola-[name].js`,
    `hammerola.[ext]`).
    """
    prefix = entry_name.split(".")[0]
    entry = f"{out_dir}/{entry_name}"
    stale = f"{out_dir}/{prefix}-a-chunk-an-older-config-emitted.js"

    # A `!` line is an exception, never a covering pattern; docker strips a
    # leading slash. fnmatch is more permissive than docker's matcher (`*`
    # crosses `/`), which errs towards accepting, never towards passing with no
    # excluding line at all.
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

    Everything between `FROM` and `AS` is unconstrained, so
    `--platform=$BUILDPLATFORM` on the node stage is accepted.
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

    A name the Dockerfile copies and UI_FILES omits is silent: the image is
    complete, CI never runs the Makefile, and a workstation serves a page missing
    that chunk. One direction only: a name in UI_FILES the build does not emit
    already fails `make ui` on the spot.
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


def bundle_url(entry_name, out_dir):
    """The URL a page has to fetch the bundle from, derived like everything here."""
    return f"/{out_dir.split('/', 1)[1]}/{entry_name}"


def script_sources(page):
    """Every `<script src>` on one template, comments stripped."""
    return re.findall(r"<script[^>]*\bsrc=[\"']([^\"']+)[\"']",
                      read_markup(TEMPLATES, page))


@pytest.mark.parametrize("page", BUNDLE_PAGES)
def test_the_page_loads_the_bundle_from_that_path(page, entry_name, out_dir):
    """Each page drawn by the bundle against the same derived path.

    This is the failure with no symptom anywhere but a browser console: the
    build, the image, the gate and the rest of the page are all unaffected by a
    wrong `src`.
    """
    url = bundle_url(entry_name, out_dir)
    sources = script_sources(page)

    assert url in sources, (
        f"templates/{page} loads no script from {url!r}. It currently loads "
        f"{sources!r}. Nothing else in this repository would notice: the bundle "
        "is still built, still copied into the image and still found by the "
        "publish gate -- the page just never fetches it."
    )


@pytest.mark.parametrize("page", BUNDLE_PAGES)
def test_the_page_loads_nothing_but_the_bundle(page, entry_name, out_dir):
    """And no second script beside it, whatever it is called.

    A stray page script would not fail loudly: it could 404 on every load, or
    mount into elements the template no longer has while the interface renders
    over it, and on the build page bind the keymap and pointer-preference key a
    second time. The test above only asserts the bundle's `src` is present, and
    the publish gate only asks whether paths exist.
    """
    url = bundle_url(entry_name, out_dir)
    sources = script_sources(page)

    assert sources == [url], (
        f"templates/{page} loads {sources!r}; the only script it may load is "
        f"{url!r}. A page script beside the bundle is a 404 or a second driver "
        "for the same page, and neither shows up as a broken page."
    )


def test_exactly_these_pages_load_the_bundle(entry_name, out_dir):
    """BUNDLE_PAGES is the real list, checked rather than trusted.

    Every check in this section iterates that tuple, so a page dropping out of it
    would pass them all while rendering nothing. In the other direction,
    pointer.html reads one localStorage key and leaves (SPEC 9); a React bundle
    there would be hundreds of kilobytes on the page whose job is to be quick.
    """
    url = bundle_url(entry_name, out_dir)
    pages = sorted(path.name for path in (ROOT / TEMPLATES).glob("*.html")
                   if url in script_sources(path.name))

    assert pages == sorted(BUNDLE_PAGES), (
        f"the templates loading {url!r} are {pages!r}, and BUNDLE_PAGES in this "
        f"file says {sorted(BUNDLE_PAGES)!r}. Whichever moved, both have to: a "
        "page that quietly stopped loading the bundle renders nothing at all, "
        "and every other check here would go on passing over the pages that did "
        "not move."
    )


def test_every_mount_point_is_on_exactly_one_page():
    """The ids ui/src/main.jsx looks up against the pages that carry them.

    main.jsx mounts only where it finds an id, so a missing or renamed mount point
    is an empty page with no error; it is checked from the HTML side. Exactly one
    page per id, because the id is what tells the bundle which page it is on.

    Both reads skip comments: main.jsx's header names the ids in prose.
    """
    main = re.sub(r"^\s*//.*$", "", read("ui", "src", "main.jsx"), flags=re.M)
    mount_ids = re.findall(
        r"\bdocument\.getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", main)

    assert sorted(mount_ids) == sorted(set(mount_ids)), (
        f"ui/src/main.jsx looks the same id up twice: {mount_ids!r}")
    assert len(mount_ids) == len(BUNDLE_PAGES), (
        f"ui/src/main.jsx mounts into {mount_ids!r} -- {len(mount_ids)} ids for "
        f"{len(BUNDLE_PAGES)} pages drawn by this bundle ({list(BUNDLE_PAGES)!r}). "
        "An id with no page is a component nothing renders; a page with no id is "
        "a blank screen."
    )

    for mount_id in mount_ids:
        carrying = [page for page in BUNDLE_PAGES
                    if re.search(rf"""id=["']{re.escape(mount_id)}["']""",
                                 read_markup(TEMPLATES, page))]
        assert len(carrying) == 1, (
            f"ui/src/main.jsx mounts into #{mount_id}, and the pages carrying "
            f"that id are {carrying!r} -- there has to be exactly one. With none, "
            "the bundle loads and renders nothing, silently; with two, both pages "
            "draw the same component."
        )
