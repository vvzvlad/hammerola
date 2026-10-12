"""`/start`: the four things a first run needs, and the one fact given for free.

Pinned here, in the order it would hurt to get wrong:

  * the manifest is PUBLIC and says whether this hub is empty; that boolean is
    the only statement about the deployment anybody gets without the token, and
    the test that matters most asserts nothing else rides along;
  * "empty" means "no project directory on the volume with anything in it". A
    project whose only build is in the `dev` slot makes the hub NOT empty though
    it has no card (so `index.json` is the wrong source), and a project directory
    a FAILED build left behind does not count (so it is not a count of
    directories);
  * the client really is a runnable program. It is assembled from the modules at
    request time, so it breaks as an ImportError on somebody's laptop for a module
    the archive did not carry, which the checkout on `sys.path` hides here. So it
    is run in a process that cannot see this checkout.

The five `lru_cache`s in `src/onboarding.py` are guarded by
`guard_onboarding_caches` in `tests/conftest.py`, autouse around every test in the
suite: `_import_verdict` caches the REFUSAL, so a test that hands the check a
doctored member list would make every later `/start/hammerola`, in any file,
answer 404. The determinism test reads timestamps out of the result, so a cached
answer is the same evidence as a fresh one. A test that plants a verdict on purpose
asks for `onboarding_cache_sandbox`, which clears the caches before and after.
"""

import ast
import io
import json
import re
import subprocess
import sys
import tarfile
import types
import zipfile
from pathlib import Path

import pytest
from harness import TOKEN, good_build

from src import onboarding
from src.buildproc.limits import DEFAULT_LIMITS
from src.cadbuild import checklib, checkunits
from hammerola import hub as hub_client

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def manifest(hub):
    """The manifest as an anonymous caller gets it."""
    reply = hub.get("/start")
    assert reply.status_code == 200
    return reply.json()


# -- the manifest ------------------------------------------------------------
def test_the_manifest_is_served_without_a_token(hub):
    """The whole point of the route: it is read by somebody who has none yet."""
    reply = hub.get("/start")
    assert reply.status_code == 200
    assert reply.headers["content-type"] == "application/json"
    # And a token is not refused either — the same document either way.
    with_token = hub.get("/start", headers={"Authorization": f"Bearer {TOKEN}"})
    assert with_token.json() == reply.json()


def test_the_manifest_says_nothing_about_this_hub_but_whether_it_is_empty(
        manifest):
    """THE ONE TEST THAT GUARDS THE DECISION.

    A field added here is a statement the hub makes to anybody who asks. A count
    would leak the size of the fleet and its growth rate; a project name or id is
    the prefix of every permanent URL that project will have, which `/index.json`
    is behind the token to withhold. So the shape is fixed: constants of the IMAGE,
    and one boolean about this deployment.

    `skill_version` and `client_version` are constants of the image like the three
    paths: two hubs on one image answer the same, and they change with the
    software, never with a push. `client_version` is also already inside the file
    `client` serves to anyone. `empty` is the only field about the deployment, and
    any new candidate has to make the same argument.
    """
    assert set(manifest) == {"empty", "skill", "client", "template",
                             "skill_version", "client_version"}
    assert manifest["empty"] is True
    assert isinstance(manifest["empty"], bool)
    assert manifest["skill"] == onboarding.SKILL_URL
    assert manifest["client"] == onboarding.CLIENT_URL
    assert manifest["template"] == onboarding.TEMPLATE_URL
    assert manifest[onboarding.SKILL_VERSION_KEY] == onboarding.skill_version()
    assert manifest[onboarding.CLIENT_VERSION_KEY] == onboarding.CLIENT_VERSION


def test_the_paths_it_names_are_relative(manifest):
    """No address of any deployment reaches this repository (AGENTS.md).

    The page learns where the hub is from the address it was loaded from; the
    manifest only says where on that hub each file lives.
    """
    for key in ("skill", "client", "template"):
        assert manifest[key].startswith("/")
        assert "//" not in manifest[key]
        assert "://" not in manifest[key]


def test_a_published_project_makes_the_hub_not_empty(hub):
    assert hub.get("/start").json()["empty"] is True
    assert hub.publish("demo0001", "c0ffee", good_build()).status_code == 201
    assert hub.get("/start").json()["empty"] is False


def test_a_project_with_only_a_dev_build_is_not_empty(hub):
    """The case that decides HOW emptiness is measured, and it is not obvious.

    `dev` is not a version of the project (SPEC 7.6): it is left out of
    `builds.json`, out of `latest` and out of the front page's `index.json`, so
    a hub in this state shows no cards at all. It is still a hub somebody has
    published to — an onboarding block would be handing them instructions for
    the push they just made — so `Store.empty` asks the directory tree and not
    the index.
    """
    assert hub.publish_dev("demo0002", good_build()).status_code == 201
    assert hub.get("/start").json() == onboarding.manifest(empty=False)
    assert hub.index().json() == [], (
        "the premise of this test is gone: the dev slot now produces a card, "
        "and `empty` would agree with the index either way")


def test_a_build_that_FAILED_leaves_the_hub_empty(hub):
    """A build that FAILED leaves the hub empty.

    `build_staging` creates `project/<pid>/` before the build runs and nothing
    removes it when the build fails the gate, so counting bare directories would
    turn `empty` false for good on a hub whose first push did not build: exactly
    the person the onboarding answer exists for.

    Staged by making the directory the way a failed build leaves it: what is under
    test is how the ANSWER is computed.
    """
    assert hub.get("/start").json()["empty"] is True
    (hub.store.projects_dir / "demo0001").mkdir(parents=True)
    assert hub.get("/start").json()["empty"] is True, (
        "a project directory left behind by a failed build reads as a hub "
        "somebody has published to")

    # ...and anything at all inside it is a hub that has been used: a build in
    # flight has its staging tree in there, and a `dev`-only project its slot.
    (hub.store.projects_dir / "demo0001" / "dev").mkdir()
    assert hub.get("/start").json()["empty"] is False


@pytest.mark.parametrize("level", ["the projects directory", "one project"])
def test_emptiness_is_reported_rather_than_guessed_when_the_volume_is_unreadable(
        hub, monkeypatch, level):
    """Fails CLOSED: an error must not be reported as "your hub is empty".

    An onboarding block is what an empty hub shows, so a store that cannot be read
    answers "not empty"; telling somebody with forty projects they have none, on
    the strength of an EACCES, is the worse error.

    Both levels: counting what is INSIDE each project directory is a second
    `iterdir`, and swallowing its OSError would turn an unreadable project into
    "not there".
    """
    # Patched on the class and narrowed to one directory, rather than arranged
    # with a `chmod`: the CI container runs the suite as root, where a mode of
    # 000 stops nothing and this test would quietly pass for no reason.
    real_iterdir = Path.iterdir
    project = hub.store.projects_dir / "demo0001"
    project.mkdir(parents=True)
    (project / "latest").mkdir()
    refuse_at = hub.store.projects_dir if level == "the projects directory" \
        else project

    def refusing(self):
        if self == refuse_at:
            raise OSError("permission denied")
        return real_iterdir(self)

    monkeypatch.setattr(Path, "iterdir", refusing)
    assert hub.store.empty() is False, level


# -- the three files ---------------------------------------------------------
def test_the_skill_is_served_as_markdown_with_its_frontmatter(hub):
    reply = hub.get("/start/skill.md")
    assert reply.status_code == 200
    assert reply.headers["content-type"] == "text/markdown; charset=utf-8"
    text = reply.text
    # A Claude Code skill is recognised by the frontmatter, so a file served
    # without it installs and never fires.
    assert text.startswith("---\n")
    assert "\nname: hammerola\n" in text
    assert "\ndescription: " in text


def test_the_manifest_states_the_version_of_the_SKILL_IT_SERVES(hub):
    """The manifest states the version of the skill this hub serves.

    `hammerola skill` compares a laptop's copy against the manifest's number, so a
    number that stopped matching the served file would silently report "up to
    date" wrongly, or the reverse. Parsed here with a pattern written in this
    test: using either side's parser would compare it with itself.
    """
    served = hub.get("/start/skill.md").text
    block = served.split("\n---\n", 1)[0]
    found = re.search(r"^version:[ \t]*(\d+)[ \t]*$", block, re.MULTILINE)
    assert found, ("the skill this hub serves names no version in its "
                   "frontmatter")
    assert int(found.group(1)) == hub.get("/start").json()["skill_version"]


def test_a_skill_with_no_version_is_refused_rather_than_read_as_the_first(
        tmp_path, monkeypatch, onboarding_cache_sandbox):
    """NO DEFAULT, and that is the decision this test holds.

    A missing version read as 1 would make a shipped file that LOST its version
    indistinguishable from a fresh one, and the tool would say "up to date" about
    a skill nobody can date. So it raises, and `src/app.py` turns that into a
    logged 404 on the route. Both shapes, because they fail at different lines: no
    frontmatter at all, and frontmatter with everything but the version.
    """
    for text in ("# no frontmatter here\n",
                 "---\nname: hammerola\ndescription: x\n---\n\nbody\n"):
        path = tmp_path / "SKILL.md"
        path.write_text(text, encoding="utf-8")
        monkeypatch.setattr(onboarding, "SKILL_FILE", path)
        onboarding.skill_bytes.cache_clear()
        onboarding.skill_version.cache_clear()
        with pytest.raises(ValueError) as raised:
            onboarding.skill_version()
        assert "version" in str(raised.value)


def test_a_skill_the_hub_cannot_date_is_a_404_and_not_a_dropped_socket(
        hub, monkeypatch):
    """The manifest opens a file, so it can fail like the other routes.

    `_handle_get` has no blanket `except`, so a ValueError out of the version
    parse must be turned into a 404 rather than reach the caller as a closed
    connection. The STATUS is asserted: "not 200" would pass on a dropped socket.
    """
    def refuse():
        raise ValueError("planted: no version in the frontmatter")

    monkeypatch.setattr(onboarding, "skill_version", refuse)
    assert hub.get("/start").status_code == 404
    # The file itself is untouched by it: only the manifest reads a version.
    assert hub.get("/start/skill.md").status_code == 200


def test_the_skill_names_no_deployment(hub):
    """It is written for whoever downloads it, from a hub whose address it may
    not carry — the reader substitutes their own.

    A scheme is the obvious spelling and not the only one: `hub.example.xyz/start`
    is an address too, and it is the shape a copy-paste out of a browser leaves.
    So the second check looks for a hostname in front of any path this service
    actually serves.
    """
    text = hub.get("/start/skill.md").text
    assert "://" not in text
    bare = re.findall(
        r"[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(?=/(?:start|api|project|index))",
        text)
    assert bare == [], (
        f"the skill carries what reads as a hub address: {bare}. It is written "
        f"for every deployment; the reader substitutes their own `<hub>`.")


def test_the_client_is_one_executable_file(hub):
    reply = hub.get("/start/hammerola")
    assert reply.status_code == 200
    assert reply.headers["content-disposition"] == "attachment"
    body = reply.content
    assert body.startswith(b"#!/usr/bin/env python3\n")
    # ...and everything after the shebang is a zip, which is what a zipapp is.
    archive = zipfile.ZipFile(io.BytesIO(body))
    names = set(archive.namelist())
    assert "__main__.py" in names
    assert "hammerola/cli.py" in names
    assert archive.testzip() is None


def test_the_client_archive_carries_every_module_it_imports(hub):
    """The failure this catches happens on somebody ELSE's machine.

    The archive is assembled by the same glob this test walks, `hammerola/*.py`,
    so a module directly in the package is carried by construction. A SUBPACKAGE
    is not: `import hammerola.sub.mod` works here, where the checkout is on
    `sys.path`, and dies with an ImportError in the downloaded file. Only the
    dotted spellings reach this check (`import hammerola.sub.mod`,
    `from hammerola.sub.mod import X`); `from hammerola.sub import mod` names the
    package, is dropped below, and is caught when the archive is built
    (`_refuse_unimportable` reports it missing from the closure).

    Imports from outside the package are held by
    `tests/client/test_stdlib_only.py`, which allows `hammerola` and the standard
    library and refuses everything else.
    """
    carried = {name for name, _path in onboarding.client_members()}
    wanted = set()
    for path in sorted((ROOT / "hammerola").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        modules = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0:
                modules.append(node.module or "")
            elif isinstance(node, ast.Import):
                # EVERY name, not `names[0]`: `import os, hammerola.foo` is one
                # statement with two of them, and reading only the first is how
                # the second gets carried by nothing.
                modules += [alias.name for alias in node.names]
        for module in modules:
            parts = module.split(".")
            if parts[0] != "hammerola" or len(parts) < 2:
                continue
            # `from hammerola import config, project` names the PACKAGE; the
            # modules it pulls are files in the glob above and are carried.
            wanted.add("/".join(parts) + ".py")
    missing = {name for name in wanted
               if name not in carried and (ROOT / name).is_file()}
    assert missing == set(), (
        f"the client imports {sorted(missing)}, which the downloadable archive "
        f"does not carry.")


def test_the_downloaded_client_runs_where_this_checkout_does_not_exist(
        hub, tmp_path):
    """The archive is a program, proven by running it as one.

    In a process that cannot see this repository: `-s` and `-E` keep the user
    site directory and PYTHONPATH out, the working directory is a scratch one,
    and the environment is built from nothing — so an `import hammerola.x` that
    the archive failed to carry cannot be answered by the checkout.

    `create --no-template` is the verb chosen for it because it exercises the
    parser, the config and the project half while reaching no network.
    """
    tool = tmp_path / "hammerola"
    tool.write_bytes(hub.get("/start/hammerola").content)
    tool.chmod(0o755)
    project = tmp_path / "fresh-part"

    finished = subprocess.run(
        [sys.executable, "-s", "-E", str(tool), "-C", str(project),
         "create", "--no-template", "--title", "Downloaded"],
        capture_output=True, text=True, timeout=120, cwd=str(tmp_path),
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path)})

    assert finished.returncode == 0, (
        f"the downloaded client would not run:\n{finished.stdout}\n"
        f"{finished.stderr}")
    payload = json.loads((project / "project.json").read_text(encoding="utf-8"))
    assert payload["title"] == "Downloaded"
    assert len(payload["id"]) == 12


def test_the_template_is_a_tar_a_fresh_project_can_be_made_of(hub):
    reply = hub.get("/start/template.tar.gz")
    assert reply.status_code == 200
    assert reply.headers["content-type"] == "application/gzip"
    assert reply.headers["content-disposition"] == "attachment"

    with tarfile.open(fileobj=io.BytesIO(reply.content), mode="r:gz") as tar:
        members = {info.name: info for info in tar.getmembers()}
    assert "model.py" in members
    # The one thing a push could never carry, and the reason this archive is
    # read under rules of its own (`unpack.TEMPLATE_RULES`) — which allow that
    # one NAME in the last position and nothing else, because a per-component
    # relaxation also accepts `.git/config`.
    assert ".gitignore" in members
    # `create` mints the id; a project.json in here would either be overwritten
    # or would refuse the command that is supposed to write it.
    assert "project.json" not in members
    for info in members.values():
        assert info.isfile(), f"{info.name} is not a regular file"
        assert info.mtime == 0 and info.uid == 0 and info.uname == ""


def test_the_archives_carry_nothing_about_when_they_were_built():
    """The PROPERTY, not two builds compared with each other.

    Two builds a microsecond apart land in the same second, so comparing them
    would pass a naive implementation: `tarfile.open(mode="w:gz")` stamps the
    moment into the gzip header and `writestr` stamps local time into every zip
    entry. So the timestamps themselves are read out of the bytes. Two hubs on one
    image then serve identical files, and a client can compare what it downloaded
    against what it has.
    """
    # Bytes 4..8 of a gzip member are MTIME, little-endian. Zero means "no
    # timestamp", which is what `GzipFile(mtime=0)` writes and what
    # `tarfile.open("w:gz")` cannot.
    header = onboarding.template_bytes()[:8]
    assert header[:2] == b"\x1f\x8b", "not a gzip stream at all"
    assert header[4:8] == b"\x00\x00\x00\x00", (
        "the template archive carries the moment it was built in its gzip "
        "header, so two hubs on one image serve different bytes")

    with tarfile.open(fileobj=io.BytesIO(onboarding.template_bytes()),
                      mode="r:gz") as tar:
        assert [info.mtime for info in tar.getmembers()] == \
            [0] * len(tar.getmembers())

    archive = zipfile.ZipFile(io.BytesIO(
        onboarding.client_bytes()[len(onboarding.CLIENT_SHEBANG):]))
    stamps = {info.date_time for info in archive.infolist()}
    assert stamps == {onboarding.ZIP_EPOCH}, (
        f"the client archive stamps its entries with {sorted(stamps)} rather "
        f"than the fixed epoch")


# -- the python the downloaded tool has to run under -------------------------
def _annotations(tree):
    """Every annotation expression in one module."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found += [node.returns] if node.returns else []
        elif isinstance(node, (ast.arg, ast.AnnAssign)):
            found += [node.annotation] if node.annotation else []
    return found


def test_no_module_in_the_archive_uses_syntax_the_declared_python_lacks():
    """The floor is `MIN_PYTHON`, and this is what holds the code to it.

    It cannot be checked by running the file: the suite's interpreter is far newer
    than what the tool is downloaded onto. Hence an AST walk.

    The main trap: `str | None` in an annotation is PEP 604 (3.10), and an
    annotation is EVALUATED at def time, so under 3.9 the module raises
    `TypeError` on import. `/usr/bin/python3` is 3.9 on macOS and Debian 11.
    `feature_version` catches a second class (syntax the parser can be told to
    refuse) but only what CPython's parser gates that way, so the explicit walk
    stays.
    """
    offenders = {}
    for name, path in onboarding.client_members():
        source = path.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source, feature_version=onboarding.MIN_PYTHON)
        except SyntaxError as error:
            offenders[name] = f"does not parse under python "
            offenders[name] += f"{onboarding.MIN_PYTHON_TEXT}: {error}"
            continue
        for annotation in _annotations(tree):
            for node in ast.walk(annotation):
                if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
                    offenders[name] = (
                        f"line {node.lineno} annotates with `X | Y`, which is "
                        f"python 3.10 and is evaluated at import")
    assert offenders == {}, (
        f"the downloadable client would not import under python "
        f"{onboarding.MIN_PYTHON_TEXT}: {offenders}. Either write the "
        f"annotation as `Optional[...]` or raise MIN_PYTHON deliberately — and "
        f"the skill's own sentence about it with it.")


def test_the_skill_states_the_same_python_floor(hub):
    """One constant, and the sentence a reader acts on says the same number."""
    text = hub.get("/start/skill.md").text
    assert f"python {onboarding.MIN_PYTHON_TEXT}" in text.lower(), (
        f"the skill does not tell the reader they need python "
        f"{onboarding.MIN_PYTHON_TEXT}")


# -- what the skill promises about the contract ------------------------------
def test_the_skill_quotes_the_contract_numbers_that_are_actually_enforced(hub):
    """The skill quotes the contract numbers that are actually enforced.

    The skill's "four rules that break a push" spells the path alphabet, the depth
    and the file count as LITERALS, and a reader acts on them (rule 1 while
    renaming files). They are the client's own constants, so they are compared
    rather than trusted.

    The alphabet is compared without its anchors: the skill quotes the pattern
    a person matches a FILE NAME against, and `\\A`/`\\Z` are how a regex says
    "the whole string".
    """
    from hammerola.limits import MAX_MEMBERS, MAX_PATH_DEPTH, SAFE_COMPONENT

    text = hub.get("/start/skill.md").text
    alphabet = SAFE_COMPONENT.pattern[2:-2]
    assert alphabet in text, (
        f"the skill does not quote the alphabet it tells people to rename "
        f"files to match: {alphabet}")
    assert f"{MAX_PATH_DEPTH} components" in text, (
        f"the skill does not say a path may be {MAX_PATH_DEPTH} components deep")
    assert f"{MAX_MEMBERS} files" in text, (
        f"the skill does not say a push may carry {MAX_MEMBERS} files")


# What a model may import, and the ONE place the answer is settled: the image is
# built from `requirements.txt`, so that file is the authority and the two
# documents quote it. Named here rather than derived from the file because most
# of what is pinned there is the SERVICE's (pydantic, loguru, httpx) and no
# model may import any of it — the list is a decision, and the test below is
# what keeps the decision, the image and both documents in one story.
MODEL_PACKAGES = ("cadquery", "trimesh", "numpy", "matplotlib", "Pillow")


@pytest.mark.parametrize("package", MODEL_PACKAGES)
def test_every_package_a_model_may_import_is_really_in_the_image(package):
    """The list is worth nothing if the image stopped carrying one of them."""
    pins = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(rf"(?mi)^{re.escape(package)}==", pins), (
        f"{package} is named to model authors as being in the image, and "
        f"requirements.txt does not pin it")


def test_the_skill_and_the_template_describe_the_SAME_image(hub):
    """The skill and the template list the same packages in the image.

    The skill sends its reader to the template as the live source of the contract,
    so a template that understated the environment would have authors hand-write
    an interpolation instead of importing numpy. Both are checked against the same
    list, so neither can drift into being the optimistic one.
    """
    skill = hub.get("/start/skill.md").text
    template = (onboarding.TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    missing = {
        "the skill": [p for p in MODEL_PACKAGES if p not in skill],
        "the template": [p for p in MODEL_PACKAGES if p not in template],
    }
    assert missing == {"the skill": [], "the template": []}, (
        f"one of the two documents understates what the image has: {missing}")


# The bullet of the skill that inventories `checklib`, found by its own opening
# words rather than by the names inside it -- the names are what is being
# checked, so a pattern spelling them out would be checking itself. Every
# backticked identifier in that bullet is read as a claim that `checklib` has a
# helper by that name.
SKILL_CHECKLIB_BULLET = re.compile(
    r"^\* \*\*`import checklib`\*\*(.*?)(?=^\* |^\n\S|\Z)",
    re.MULTILINE | re.DOTALL)
BACKTICKED_NAME = re.compile(r"`([a-z_][a-z0-9_]*)`")


def test_the_skill_names_no_checklib_helper_that_does_not_exist(hub):
    """The inventory the skill hands an author, against the module itself.

    A skill claiming a check does not exist makes an author write it by hand out of
    primitives, or not at all, and the document is served to every agent that
    installs the skill. The other direction is caught too: a helper renamed in
    `checklib` leaves the skill telling authors to call something that raises
    AttributeError.
    """
    skill = hub.get("/start/skill.md").text
    bullet = SKILL_CHECKLIB_BULLET.search(skill)
    assert bullet, (
        "the skill no longer has a bullet inventorying `checklib`, so either "
        "the section was reworded past this pin or the inventory is gone. "
        "Re-aim the pattern, or say here why the inventory no longer needs one")

    named = set(BACKTICKED_NAME.findall(bullet.group(1)))
    assert named, "the checklib bullet names no helper at all"
    missing = sorted(n for n in named if not hasattr(checklib, n))
    assert not missing, (
        f"skill/SKILL.md tells a model author to call {missing}, and "
        f"src/cadbuild/checklib.py has no such name")


# The two numbers the skill quotes about check units, each as the sentence that
# carries it. They are in the skill because an author sizing a check needs them,
# and they are pinned here because nothing about editing `checkunits.py` would
# send anybody to a document served over HTTP from another directory.
#
# `\s+` and not a space: the skill is hard-wrapped markdown served verbatim, so
# either sentence may cross a line break at any word.
SKILL_WORKERS = re.compile(r"drains\s+the\s+queue\s+across\s+(\w+)\s+worker\s+processes")
SKILL_BUDGET = re.compile(r"its\s+own\s+budget:\s+(\d+)\s+seconds")

# The BUILD ceilings, and ALL FOUR sentences that carry them. The wall is stated
# three times on purpose (in minutes as the heading an author reads first, in
# seconds where the four clocks are laid out, and in minutes again where a hung
# check is costed); pinning two would leave the third to go stale alone.
#
# The document states the wall nowhere else, and that is a property to preserve:
# prose that recomputes a ceiling (e.g. off the slow-build threshold) belongs on
# this side of the HTTP boundary.
SKILL_WALL_MINUTES = re.compile(r"A\s+build\s+has\s+(\w+)\s+minutes\s+of\s+wall\s+clock")
SKILL_WALL = re.compile(r"kills\s+a\s+build\s+at\s+(\d+)\s+seconds")
SKILL_WALL_WHOLE = re.compile(r"whole\s+(\w+)-minute\s+wall\s+clock")
SKILL_CLIENT_CEILING = re.compile(r"its\s+own\s+ceiling\s+is\s+(\d+)\s+seconds")

# Read for the worker count and for the wall in minutes alike.
SPELLED = {"two": 2, "three": 3, "four": 4, "five": 5, "ten": 10,
           "twelve": 12, "fifteen": 15}


def test_the_skill_quotes_the_unit_ceilings_the_hub_actually_runs(hub):
    """Two numbers an author sizes their checks against, held to the code.

    A check written to fit a budget that has since moved is killed on a ceiling the
    instructions said was elsewhere, and the build reports the unit failed. The
    worker count is the same kind of claim: it is what "two run at once" is worth,
    and the reason to split a `checks()` into units. Neither number is derivable
    from the skill, and editing `src/cadbuild/checkunits.py` sends nobody to a
    markdown file served out of `skill/`.
    """
    skill = hub.get("/start/skill.md").text

    workers = SKILL_WORKERS.search(skill)
    assert workers, (
        "the skill no longer says how many workers drain the unit queue in the "
        "words this reads it by — reword the pattern with the sentence")
    said = SPELLED.get(workers.group(1).lower())
    assert said == checkunits.CHECK_WORKERS, (
        f"skill/SKILL.md tells an author {workers.group(1)} workers run the "
        f"units and CHECK_WORKERS is {checkunits.CHECK_WORKERS}")

    budget = SKILL_BUDGET.search(skill)
    assert budget, (
        "the skill no longer states a unit's budget in the words this reads it "
        "by — reword the pattern with the sentence")
    assert int(budget.group(1)) == checkunits.UNIT_BUDGET_SECONDS, (
        f"skill/SKILL.md tells an author a unit gets {budget.group(1)}s and "
        f"UNIT_BUDGET_SECONDS is {checkunits.UNIT_BUDGET_SECONDS}")


def test_the_skill_quotes_the_build_ceilings_the_hub_actually_enforces(hub):
    """The wall an author sizes `checks()` against, and the client's own wait.

    A stale wall is not a document error an author can catch: they calibrate
    `checks()` against the ceiling they were handed and the build is killed on a
    lower number with a timeout naming nothing, while the instructions live in a
    directory nobody edits alongside `limits.py`.

    The client's ceiling is pinned for the reason `test_build_ceilings.py` gives:
    `hammerola/` is stdlib-only and cannot import the wall, so the skill's copy of
    that literal is a copy of a copy.

    Not covered: the skill also quotes the hub's concurrency ("four builds at a
    time", `MAX_CONCURRENT_BUILDS`) and the slow-build threshold ("past three
    minutes", `SLOW_BUILD_SECONDS`), and nothing reads those copies back;
    `tests/test_build_ceilings.py` asserts the constants, not this document.
    """
    skill = hub.get("/start/skill.md").text

    spelled = SKILL_WALL_MINUTES.search(skill)
    assert spelled, (
        "the skill no longer opens the section with the wall in minutes in the "
        "words this reads it by — reword the pattern with the sentence")
    minutes = SPELLED.get(spelled.group(1).lower())
    assert minutes is not None, (
        f"the skill spells the wall as {spelled.group(1)!r} minutes and SPELLED "
        f"cannot read that word — add it rather than loosening the pattern")
    assert minutes * 60 == DEFAULT_LIMITS.wall_seconds, (
        f"skill/SKILL.md tells an author a build has {spelled.group(1)} minutes "
        f"and wall_seconds is {DEFAULT_LIMITS.wall_seconds}")

    wall = SKILL_WALL.search(skill)
    assert wall, (
        "the skill no longer states the wall in seconds in the words this reads "
        "it by — reword the pattern with the sentence")
    assert int(wall.group(1)) == DEFAULT_LIMITS.wall_seconds, (
        f"skill/SKILL.md tells an author the hub kills a build at "
        f"{wall.group(1)}s and wall_seconds is {DEFAULT_LIMITS.wall_seconds}")

    # The third spelling, where the unit budget is argued for against what a hung
    # check costs. It reads as background rather than as a ceiling, which makes it
    # the easiest of the four to leave stale.
    whole = SKILL_WALL_WHOLE.search(skill)
    assert whole, (
        "the skill no longer costs a hung check against the whole wall in the "
        "words this reads it by — reword the pattern with the sentence")
    whole_minutes = SPELLED.get(whole.group(1).lower())
    assert whole_minutes is not None, (
        f"the skill spells that wall as {whole.group(1)!r} minutes and SPELLED "
        f"cannot read that word — add it rather than loosening the pattern")
    assert whole_minutes * 60 == DEFAULT_LIMITS.wall_seconds, (
        f"skill/SKILL.md costs a hung check at {whole.group(1)} minutes and "
        f"wall_seconds is {DEFAULT_LIMITS.wall_seconds}")

    ceiling = SKILL_CLIENT_CEILING.search(skill)
    assert ceiling, (
        "the skill no longer states the client's own ceiling in the words this "
        "reads it by — reword the pattern with the sentence")
    assert int(ceiling.group(1)) == hub_client.JOB_TIMEOUT, (
        f"skill/SKILL.md tells an author the client waits {ceiling.group(1)}s "
        f"and JOB_TIMEOUT is {hub_client.JOB_TIMEOUT}")


def test_the_downloaded_client_refuses_an_interpreter_that_is_too_old():
    """The generated entry point is RUN, against a `sys` that says 3.8.

    A grep would pass `if False and sys.version_info < ...`. The old interpreter
    is not on this machine, so `sys` is swapped in `sys.modules` for one `exec`,
    the narrowest window that still lets the generated `import sys` find the fake.

    Observed: it exits, it exits BEFORE the import (a real 3.8 would raise inside
    `cli` rather than exiting), and the message names both versions.
    """
    fake = types.ModuleType("sys")
    fake.version_info = (3, 8, 10)
    fake.executable = "/usr/bin/python3"
    fake.argv = ["/home/somebody/.local/bin/hammerola"]
    fake.exit = sys.exit
    # Set, so a guard that let 3.8 through would try the import and be caught
    # below by the ImportError rather than passing silently.
    fake.path = []

    real = sys.modules["sys"]
    sys.modules["sys"] = fake
    try:
        with pytest.raises(SystemExit) as raised:
            exec(compile(onboarding.CLIENT_MAIN, "__main__.py", "exec"),
                 {"__name__": "__main__"})
    finally:
        sys.modules["sys"] = real

    message = str(raised.value)
    assert onboarding.MIN_PYTHON_TEXT in message
    assert "3.8" in message, "the message does not say what it found"
    assert "/usr/bin/python3" in message, (
        "the message does not name the interpreter that has to be replaced")


# -- what the hub refuses to serve -------------------------------------------
@pytest.mark.parametrize("name", [
    ".git/config",              # the RCE the template rules exist to refuse
    ".ssh/authorized_keys",
    ".gitignore/payload.py",    # the allowed name, used as a directory
    "a/b/c/d/e/f/g/h/i.py",     # deeper than a client will unpack
    "../escape.py",
])
def test_the_hub_refuses_to_build_a_template_a_client_would_refuse(name):
    """The hub refuses to build a template a client would refuse.

    `_refuse_unservable` calls the client's own `check_name` (alphabet and depth),
    so a template the client would refuse is never built, served and then refused
    on the other side. Parametrized over what `check_name` covers.
    """
    with pytest.raises(ValueError):
        onboarding._refuse_unservable([(name, Path(__file__))])


def test_the_hub_refuses_a_template_of_more_files_than_a_client_unpacks():
    """The first of the two ceilings that belong to the SET rather than a name.

    They are checked on this side rather than delegated, because `unpack` applies
    them to a tar while this side holds files: a "nearly the same check" that can
    drift, so both are asserted (the other is the test below).
    """
    from hammerola.limits import MAX_MEMBERS

    many = [(f"f{index}.py", Path(__file__)) for index in range(MAX_MEMBERS + 1)]
    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unservable(many)
    assert str(MAX_MEMBERS) in str(raised.value)


def test_the_hub_refuses_a_template_that_unpacks_to_more_than_a_push_may_be(
        tmp_path):
    """The second one: the VOLUME.

    It cannot be staged with many files (`MAX_MEMBERS` fires first), so it is one
    member bigger than the ceiling on its own, made with `truncate`: sparse, so
    `st_size`, which `_refuse_unservable` measures, is big while no 64 MB is
    written to disk.
    """
    from hammerola.limits import MAX_BUILD_BYTES

    huge = tmp_path / "huge.py"
    with open(huge, "wb") as handle:
        handle.truncate(MAX_BUILD_BYTES + 1)

    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unservable([("huge.py", huge)])
    assert str(MAX_BUILD_BYTES) in str(raised.value)


def test_what_the_template_really_holds_is_servable():
    """...and the guard says yes to the tree that ships, so it is not a no-op
    the other way either."""
    onboarding._refuse_unservable(onboarding.template_members())


def test_a_template_the_hub_cannot_serve_is_a_404_and_not_a_500(hub,
                                                                monkeypatch):
    """An artefact defect is answered as one. Patched at `template_bytes` rather
    than by planting a file, so the module's cache is never asked to hold a
    value built from anything but the real directory."""
    def refuse():
        raise ValueError("planted")

    monkeypatch.setattr(onboarding, "template_bytes", refuse)
    assert hub.get("/start/template.tar.gz").status_code == 404
    # The other two are untouched by it.
    assert hub.get("/start/skill.md").status_code == 200


def test_a_start_route_that_cannot_import_is_a_404_and_not_a_dropped_socket(
        hub, monkeypatch):
    """A start route that cannot import is a 404, not a dropped socket.

    `template_bytes` borrows the client's unpacking rules at call time
    (`_refuse_unservable` imports `hammerola.limits`, `unpack` and `errors`), so a
    client module `.dockerignore` kept out of the image fails this route with a
    ModuleNotFoundError: neither the OSError of a missing file nor the ValueError
    of a refused template. `_handle_get` has no blanket `except`, so `_serve_start`
    must catch it. The STATUS is asserted: "not 200" would pass on a dropped socket.
    """
    def refuse():
        raise ModuleNotFoundError("No module named 'hammerola.limits'")

    monkeypatch.setattr(onboarding, "template_bytes", refuse)
    assert hub.get("/start/template.tar.gz").status_code == 404


# -- the client the hub refuses to assemble ----------------------------------
# `_refuse_unimportable` is handed a member LIST rather than a stripped
# directory, and the two are the same experiment: `client_members()` globs
# `hammerola/*.py`, so a module .dockerignore kept out of the image is
# subtracted from that list and from nothing else. Dropping a row is what the
# image does.
@pytest.mark.parametrize("gone", [
    "hammerola/hub.py",       # reached from cli.py through a dotted import
    "hammerola/project.py",   # reached ONLY as `from hammerola import project`
    "hammerola/errors.py",
    # The three the hub shares with the client, and the rows are the point:
    # they are the modules a reader is likeliest to think of as somebody
    # else's, so a refusal that stopped covering them would go unnoticed.
    "hammerola/metricsdiff.py",
    "hammerola/buildnames.py",
    "hammerola/projectslug.py",
])
def test_the_hub_refuses_a_client_that_is_missing_a_module_it_imports(gone):
    """THE FAILURE HAS NO OTHER WITNESS, which is why the refusal exists.

    The archive is built from a glob rather than a list (a module added to
    `hammerola/` is part of the tool by definition), so a missing module is
    invisible: served with a 200 and a plausible size, dying with an ImportError on
    the laptop. So the closure is computed from the modules themselves.

    `project.py` is here because it is imported only as
    `from hammerola import project`, which names the PACKAGE; a check of dotted
    module names alone would miss it, and most of the package, since that is how
    `cli.py` reaches most modules.
    """
    members = [(name, path) for name, path in onboarding.client_members()
               if name != gone]
    assert len(members) == len(onboarding.client_members()) - 1, (
        f"{gone} is not in client_members(), so this case is testing nothing")

    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unimportable(members)
    assert gone.replace("/", ".")[:-3] in str(raised.value), (
        "the refusal does not name the module that is missing, which is the "
        "only thing the log line on the 404 can pass on")


def test_a_broken_image_parses_the_client_once_and_not_once_per_request(
        hub, monkeypatch, onboarding_cache_sandbox):
    """A broken image parses the client once, not once per request.

    `lru_cache` remembers a returned value and never a raised exception, so caching
    `client_bytes` alone would leave a broken image re-parsing twenty modules on
    EVERY request: a public route dispatched before the token check, throttled by
    nothing (`src/app.py`), on a thread-per-connection server, about 22 ms of CPU
    per 80-byte request. HEAD is covered too: the archive is built before
    `with_body` is looked at.

    `onboarding_cache_sandbox` makes this test legal: proving the refusal is
    remembered means remembering one, which `guard_onboarding_caches` otherwise
    fails a test for. The fixture hands over cleared caches and clears them again
    afterwards; `monkeypatch` cannot, since restoring `client_members` does not
    unremember what it returned.
    """
    calls = []
    real_refuse = onboarding._refuse_unimportable
    broken = [(name, path) for name, path in onboarding.client_members()
              if name != "hammerola/metricsdiff.py"]

    def counting(members):
        calls.append(1)
        return real_refuse(members)

    monkeypatch.setattr(onboarding, "_refuse_unimportable", counting)
    monkeypatch.setattr(onboarding, "client_members", lambda: broken)
    for _ in range(5):
        assert hub.get("/start/hammerola").status_code == 404
    assert hub.request("HEAD", "/start/hammerola").status_code == 404
    assert len(calls) == 1, (
        f"six requests to a broken image ran the check {len(calls)} times; "
        f"the refusal is being recomputed per request")


def test_what_the_client_really_carries_is_importable():
    """...and it says yes to the tree that ships, so it is not a no-op the other
    way either. Every other test here that fetches `/start/hammerola` depends on
    this being true; this one is what says so out loud."""
    onboarding._refuse_unimportable(onboarding.client_members())


def test_a_module_no_import_reaches_is_not_required():
    """The boundary, asserted rather than left to be discovered.

    The closure starts at `CLIENT_ENTRY` and requires what it can reach, so a
    module nothing imports is not required: its absence breaks nothing.
    `__main__.py` is unreachable ON PURPOSE: the zipapp's entry point is the
    generated `CLIENT_MAIN` at the archive's root, because a zip's entry point has
    to sit there. This test is about one module being droppable; the test below
    counts the modules outside the closure.
    """
    members = [(name, path) for name, path in onboarding.client_members()
               if name != "hammerola/__main__.py"]
    onboarding._refuse_unimportable(members)


def test_the_closure_reaches_every_module_but_the_one_nothing_imports():
    """HOW MANY modules the refusal can speak for.

    Every case above removes a module and asserts a refusal, and all of them keep
    passing while the closure SHRINKS: an import form the walk does not follow
    takes modules out of it in silence (relative imports in one module would drop
    it to one), and a name bound in an unexpected way can refuse a healthy image.

    So the SET is asserted. The one name outside it is `hammerola/__main__.py`, by
    design (the zipapp's entry point is the generated `CLIENT_MAIN` at the
    archive's root). A name appearing here means the refusal stopped covering a
    module; a name disappearing means the walk follows something new, and the list
    is updated deliberately.
    """
    members = onboarding.client_members()
    reached, missing = onboarding._import_closure(members)
    assert missing == []
    assert set(dict(members)) - reached == {
        "hammerola/__main__.py",
    }


# -- the import forms the walk has to understand, and the one it refuses ------
def _client_with(tmp_path, source, dropped="hammerola/artifacts.py"):
    """The member list of an image whose `hammerola/__init__.py` is `source`.

    `dropped` is a module `cli.py` reaches ONLY as `from hammerola import
    artifacts`, so an image without it is healthy exactly when the package binds
    that name itself, which is the question `bound()` answers.

    `VERSION` is prepended to every case: `update.py` imports that name out of the
    package, so an `__init__.py` without it would be refused for a reason none of
    these cases is about. The value is nonsense on purpose; only the name being
    BOUND is under test.
    """
    fake = tmp_path / "__init__.py"
    fake.write_text('VERSION = "0.0.0"\n' + source, encoding="utf-8")
    return sorted((name, fake if name == "hammerola/__init__.py" else path)
                  for name, path in onboarding.client_members()
                  if name != dropped)


@pytest.mark.parametrize("label, source", [
    # The commonest shape in any __init__.py, and the one that was refused.
    ("try/except ImportError",
     "try:\n    from hammerola.hub import artifacts\n"
     "except ImportError:\n    artifacts = None\n"),
    ("if/else", "import os\nif os.environ.get('X'):\n    artifacts = 1\n"
                "else:\n    artifacts = 2\n"),
    ("a for loop", "for artifacts in ('a',):\n    pass\n"),
    ("a with block", "import contextlib\n"
                     "with contextlib.suppress(Exception):\n    artifacts = 1\n"),
    # These two bind no name statically at all, so "not bound" is not an answer
    # and `bound()` abstains instead of refusing.
    ("PEP 562 lazy __getattr__", "def __getattr__(name):\n    return None\n"),
    ("a star import", "from hammerola.hub import *\n"),
    ("the top level (the control)", "artifacts = None\n"),
])
def test_a_package_that_binds_a_name_is_not_called_incomplete(tmp_path, label,
                                                              source):
    """A FALSE REFUSAL IS A 404 ON A HEALTHY IMAGE, and a red gate (h).

    Each case binds its name at import somewhere other than the top level of a
    statement list, so `bound()` must look beyond `tree.body`. The control is last,
    and it keeps this from passing because the check became a no-op.
    """
    onboarding._refuse_unimportable(_client_with(tmp_path, source))


def test_a_package_that_binds_nothing_still_refuses_the_missing_module(tmp_path):
    """...and the other direction, or the test above would pass on a no-op.

    An `__init__.py` that binds nothing OF THE NAME BEING ASKED ABOUT cannot
    excuse a module that is not in the image, whatever else it contains — and
    this one does contain other bindings, which is the whole shape being tested.
    The compound statements are here so the walk has something to walk.
    """
    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unimportable(_client_with(
            tmp_path,
            "try:\n    import os\nexcept ImportError:\n    os = None\n"
            "for unrelated in ():\n    pass\n"))
    assert "hammerola.artifacts" in str(raised.value)


def test_a_relative_import_is_refused_rather_than_ignored(tmp_path):
    """A relative import is refused, because the walk cannot answer it.

    `from . import x` carries no module name, so skipping it would cost the closure
    every module that import reaches, with nothing failing (a tree missing
    `status.py` would be served with a 200). Staged on a module the entry point
    reaches, so the walk is observed arriving there and refusing, not a special
    case at the root.
    """
    original = dict(onboarding.client_members())["hammerola/revdiff.py"]
    mutated = original.read_text(encoding="utf-8").replace(
        "from hammerola.metricsdiff import", "from ..metricsdiff import")
    assert mutated != original.read_text(encoding="utf-8"), (
        "revdiff.py no longer imports hammerola.metricsdiff, so this stages nothing")
    fake = tmp_path / "revdiff.py"
    fake.write_text(mutated, encoding="utf-8")
    members = [(name, fake if name == "hammerola/revdiff.py" else path)
               for name, path in onboarding.client_members()]

    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unimportable(members)
    message = str(raised.value)
    assert "hammerola/revdiff.py" in message, (
        "the refusal does not name the file to fix")
    assert "relative" in message


def test_a_client_module_that_will_not_parse_is_refused_as_one(tmp_path):
    """A file that is not python is an artefact defect like any other here.

    `ast.parse` raises SyntaxError, which is neither ValueError nor OSError and
    would escape `_serve_start` onto the socket. Re-raised as ValueError it becomes
    the logged 404 the route promises.
    """
    broken = tmp_path / "cli.py"
    broken.write_text("def main(:\n", encoding="utf-8")
    members = [(name, path) for name, path in onboarding.client_members()
               if name != onboarding.CLIENT_ENTRY]
    members.append((onboarding.CLIENT_ENTRY, broken))

    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unimportable(members)
    assert onboarding.CLIENT_ENTRY in str(raised.value)


# -- the route itself --------------------------------------------------------
def test_an_unknown_name_under_start_is_a_404(hub):
    # The third one is percent-encoded on purpose: a plain `..` is collapsed by
    # the client before it is sent, so the encoded form is the only way to ask
    # this hub the question a traversal actually asks.
    for path in ("/start/nothing", "/start/skill.md/more",
                 "/start/%2e%2e/index.json"):
        assert hub.get(path).status_code == 404, path


def test_head_answers_without_a_body(hub):
    for path in ("/start", "/start/skill.md", "/start/hammerola",
                 "/start/template.tar.gz"):
        reply = hub.request("HEAD", path)
        assert reply.status_code == 200, path
        assert reply.content == b""
        assert int(reply.headers["content-length"]) > 0, path


def test_nothing_under_start_is_cached(hub):
    """All four change with the image under a stable name, and `empty` changes
    with the first push — the same reasoning `site.css` gets."""
    for path in ("/start", "/start/skill.md", "/start/hammerola",
                 "/start/template.tar.gz"):
        assert hub.get(path).headers["cache-control"] == "no-cache", path


def test_the_client_and_the_hub_agree_on_where_the_manifest_is():
    """The client spells this path itself (it takes nothing from the service
    half), so the two copies are compared here — the arrangement `limits.py`
    already has with the hub's ceilings."""
    assert hub_client.START_PATH == onboarding.MANIFEST_URL


def test_the_manifest_key_the_client_follows_is_the_one_the_hub_writes():
    """Both sides of the string: the client's key against the hub's.

    The same arrangement `hub.START_PATH` has with `onboarding.MANIFEST_URL`.
    """
    from hammerola import setup

    assert setup.TEMPLATE_KEY == onboarding.TEMPLATE_KEY
    assert onboarding.TEMPLATE_KEY in onboarding.manifest(empty=True)


def test_the_two_keys_the_skill_command_follows_are_the_ones_the_hub_writes():
    """The same arrangement for `hammerola skill`.

    `hammerola skill` reads two fields out of the manifest, where the file is and
    which version it is, and spells both itself, because the client imports
    nothing from the serving half.
    """
    from hammerola import skill as client_skill

    document = onboarding.manifest(empty=True)
    assert client_skill.VERSION_KEY == onboarding.SKILL_VERSION_KEY
    assert client_skill.VERSION_KEY in document
    assert client_skill.SKILL_KEY in document
    assert document[client_skill.SKILL_KEY] == onboarding.SKILL_URL


def test_the_keys_and_the_bytes_the_update_command_follows_are_the_hubs_own():
    """The same arrangement for `hammerola update`.

    `hammerola update` reads two fields out of the manifest (where the client is
    and which version the hub serves) and checks that what comes back begins with
    the shebang a zipapp begins with. It spells all three itself, and a drifted
    copy would fail nothing by itself: a key that stopped matching turns the
    refusal to publish into silence, and a shebang that stopped matching turns
    every update into "that is not the tool".
    """
    from hammerola import update as client_update

    document = onboarding.manifest(empty=True)
    assert client_update.VERSION_KEY == onboarding.CLIENT_VERSION_KEY
    assert client_update.VERSION_KEY in document
    assert client_update.CLIENT_KEY in document
    assert document[client_update.CLIENT_KEY] == onboarding.CLIENT_URL
    assert client_update.SHEBANG == onboarding.CLIENT_SHEBANG


def test_the_version_the_manifest_states_is_the_one_inside_the_client_it_serves():
    """TWO STATEMENTS ABOUT ONE NUMBER, and this is what keeps them the same.

    The hub STATES a version in the manifest, and it SERVES an archive with a
    version inside it. A client asks the first before a push and reads the
    second while replacing itself, so a disagreement between them is a machine
    told it is out of date, updating, and being told the same thing again — a
    loop with nothing anywhere going red.

    Read out of the archive with the client's own reader, over the bytes that
    really ship, exactly as the skill's two parsers are compared over the file
    that really ships.
    """
    from hammerola import update as client_update

    archive = zipfile.ZipFile(io.BytesIO(
        onboarding.client_bytes()[len(onboarding.CLIENT_SHEBANG):]))
    inside = client_update._member_value(archive,
                                         client_update.VERSION_MEMBER,
                                         client_update.VERSION_NAME)
    assert inside == onboarding.manifest(empty=True)[
        onboarding.CLIENT_VERSION_KEY]


def test_the_client_reads_the_SAME_version_out_of_the_skill_as_the_hub():
    """TWO PARSERS OVER ONE FILE, and this is what keeps them honest.

    The client may import nothing from `src/onboarding.py`, so it carries its
    own copy of the frontmatter patterns. A copy that drifted would not fail
    anything by itself — it would make `hammerola skill` compare a number it
    read differently against the hub's, and print "out of date" about a file
    that is current, or the reverse. Neither goes red anywhere else.

    Run over the file that actually ships, rather than over an invented one:
    what has to agree is the reading of THIS document.
    """
    from hammerola import skill as client_skill

    text = onboarding.SKILL_FILE.read_text(encoding="utf-8")
    assert client_skill.version_of(text) == onboarding.skill_version()


def test_the_skill_tells_the_reader_how_to_update_it(hub):
    """The file arrives by `curl` once and is refreshed by the client after.

    The raw download stays — it is how the skill gets there before there is a
    client at all — but a reader who only ever saw that line has no way of
    knowing the file goes stale, which is the failure this whole entry is
    about. Both verbs are named, and the check is against the SERVED copy so
    that a hub is not handing out instructions with a command it does not have.
    """
    text = hub.get("/start/skill.md").text
    assert "hammerola skill update" in text
    assert re.search(r"`hammerola skill`", text), (
        "the skill does not tell its reader how to ask whether it is stale")
