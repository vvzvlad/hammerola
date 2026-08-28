"""`/start`: the four things a first run needs, and the one fact given for free.

WHAT IS BEING PINNED HERE, in the order it would hurt to get wrong:

  * the manifest is PUBLIC and says whether this hub is empty — that boolean is
    the only statement about the deployment anybody gets without the token, and
    the test that matters most is the one asserting nothing else rides along;
  * "empty" means "no project directory on the volume with anything in it", and
    both halves of that are load-bearing. A project whose only build is in the
    `dev` slot makes the hub NOT empty, though it has no card on the front page
    — which is why reading `index.json` for this would have given the wrong
    answer. A project directory a FAILED build left behind makes it not empty
    either, which is why the count is not of directories;
  * the client really is a runnable program. It is assembled out of the modules
    at request time, so the way it breaks is an ImportError on somebody's laptop
    for a module the archive did not carry — a thing no test of this repository
    could notice, because here the checkout is on `sys.path`. So it is run, in a
    process that cannot see this checkout at all.

NO GUARD FIXTURE FOR THE THREE `lru_cache`s in `src/onboarding.py`, on purpose.
The project's rule is about module-level MUTABLE state, and these are caches over
files inside the image: pure functions of bytes that cannot change while the
process runs, exactly like `render._template`, which is guarded by nothing for
the same reason. The determinism test below reaches for `__wrapped__` rather than
`cache_clear()` so that nothing here touches the cache at all.
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
from src.client import hub as hub_client

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
    would leak the size of the fleet and its growth rate to whoever polled; a
    project name or an id is the prefix of every permanent URL that project will
    ever have, which is precisely what `/index.json` is behind the token to
    withhold. So the shape is fixed: three paths that are constants of the
    image, and one boolean.
    """
    assert set(manifest) == {"empty", "skill", "client", "template"}
    assert manifest["empty"] is True
    assert isinstance(manifest["empty"], bool)
    assert manifest["skill"] == onboarding.SKILL_URL
    assert manifest["client"] == onboarding.CLIENT_URL
    assert manifest["template"] == onboarding.TEMPLATE_URL


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
    """The case the old rule got wrong, and it landed on the worst reader.

    `build_staging` creates `project/<pid>/` before the build runs and nothing
    removes it when the build then fails the gate — the caller takes the staging
    tree and leaves the shell. Counting bare directories therefore turned
    `empty` false FOREVER on a hub whose very first push did not build, i.e. for
    exactly the person the onboarding answer exists for.

    Staged by making the directory the way a failed build leaves it, rather than
    by failing a real build: what is under test is how the ANSWER is computed,
    and a real failure would drag the whole build path in to prove one
    directory.
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

    An onboarding block is what an empty hub will show, so a store that cannot
    be read has to answer "not empty" — telling somebody with forty projects
    that they have none, on the strength of an EACCES, is the worse of the two.
    Pinned now rather than when that block is built: it is a property of the
    answer, and the page that grows will inherit it.

    BOTH LEVELS, because there are now two `iterdir`s and only the outer one was
    covered: counting what is INSIDE each project directory (which is what keeps
    a failed build's leftovers from making the hub look used) added a second
    call, and wrapping it in a `try: ... except OSError: pass` left the suite
    green while turning an unreadable project into "not there".
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
    assert "src/client/cli.py" in names
    assert archive.testzip() is None


def test_the_client_archive_carries_every_module_it_imports(hub):
    """The failure this catches happens on somebody ELSE's machine.

    `src/client/*.py` is globbed into the archive, so a new client module is
    carried automatically. A module OUTSIDE that package — `src/metricsdiff.py`
    is the one today — is named by hand in `CLIENT_EXTRA_MODULES`, and a second
    one added without that line produces an archive that works perfectly here,
    where the whole checkout is on `sys.path`, and dies with an ImportError the
    first time somebody runs the downloaded file.
    """
    carried = {name for name, _path in onboarding.client_members()}
    wanted = set()
    for path in sorted((ROOT / "src" / "client").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        modules = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0:
                modules.append(node.module or "")
            elif isinstance(node, ast.Import):
                # EVERY name, not `names[0]`: `import os, src.foo` is one
                # statement with two of them, and reading only the first is how
                # the second gets carried by nothing.
                modules += [alias.name for alias in node.names]
        for module in modules:
            parts = module.split(".")
            if parts[0] != "src" or len(parts) < 2:
                continue
            # `from src.client import config, project` names the PACKAGE; the
            # modules it pulls are files in the glob above and are carried.
            wanted.add("/".join(parts) + ".py")
    missing = {name for name in wanted
               if name not in carried and (ROOT / name).is_file()}
    assert missing == set(), (
        f"the client imports {sorted(missing)}, which the downloadable archive "
        f"does not carry. Add them to onboarding.CLIENT_EXTRA_MODULES.")


def test_the_downloaded_client_runs_where_this_checkout_does_not_exist(
        hub, tmp_path):
    """The archive is a program, proven by running it as one.

    In a process that cannot see this repository: `-s` and `-E` keep the user
    site directory and PYTHONPATH out, the working directory is a scratch one,
    and the environment is built from nothing — so an `import src.client.x` that
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

    Comparing two builds a microsecond apart is what this test used to do, and
    it passed for a naive implementation: `tarfile.open(mode="w:gz")` stamps the
    moment into the gzip header and `writestr` stamps local time into every zip
    entry, and both runs land in the same second. So the timestamps themselves
    are read out of the bytes.

    What it buys: two hubs on one image serve identical files, and a client can
    compare what it downloaded against what it has.
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

    IT CANNOT BE CHECKED BY RUNNING THE FILE, which is the whole reason this is
    an AST walk: the suite has one interpreter, the venv's, and it is far newer
    than what the tool is downloaded onto. A test that ran the archive with
    `sys.executable` would say "it runs" about a python nobody onboarding has.

    The specific trap, and the one that was actually here: `str | None` in an
    annotation is PEP 604, i.e. 3.10, and an annotation is EVALUATED at def
    time — so under 3.9 the module raises `TypeError` on import, and with `cli`
    among the six that broke, not one verb worked. `/usr/bin/python3` is 3.9 on
    macOS and Debian 11.

    `feature_version` catches a second class of it (syntax the parser can be
    told to refuse), and it is not a substitute: it covers only what CPython's
    parser gates that way, which is why the explicit walk above it exists.
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
    """The same reasoning the python floor already gets, applied to the rest.

    The skill's "four rules that break a push" spells the path alphabet, the
    depth and the file count as LITERALS, and a reader acts on them: rule 1 is
    read while renaming files. They are the client's own constants, so they can
    be compared rather than trusted — and one of them has already moved once
    (`MAX_MEMBERS` went from 256 to 1024 in step 2 of the plan), which is
    exactly the edit that leaves a document quietly telling people the old
    number.

    The alphabet is compared without its anchors: the skill quotes the pattern
    a person matches a FILE NAME against, and `\\A`/`\\Z` are how a regex says
    "the whole string".
    """
    from src.client.limits import MAX_MEMBERS, MAX_PATH_DEPTH, SAFE_COMPONENT

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
    """They disagreed, and the direction of the disagreement is what mattered.

    The skill named five packages, the template named two — and the skill sends
    its reader to the template as the live source of the contract ("read it
    rather than this section"), so the authoritative half was the one
    understating the environment. An author who believes it writes an
    interpolation by hand instead of importing numpy.

    Both are checked against the same list, so neither can drift into being the
    optimistic one.
    """
    skill = hub.get("/start/skill.md").text
    template = (onboarding.TEMPLATE_DIR / "model.py").read_text(encoding="utf-8")
    missing = {
        "the skill": [p for p in MODEL_PACKAGES if p not in skill],
        "the template": [p for p in MODEL_PACKAGES if p not in template],
    }
    assert missing == {"the skill": [], "the template": []}, (
        f"one of the two documents understates what the image has: {missing}")


def test_the_downloaded_client_refuses_an_interpreter_that_is_too_old():
    """The generated entry point is RUN, against a `sys` that says 3.8.

    Grepping the source for the comparison is what this used to do, and it was
    not an observation of anything: `if False and sys.version_info < ...` passes
    a grep and a line-order check alike. The old interpreter is not on this
    machine, so the interpreter is what gets replaced — `sys` is swapped in
    `sys.modules` for the length of one `exec`, which is the narrowest window
    that still lets the generated `import sys` find the fake.

    What is being observed: it exits, it exits BEFORE the import (a real 3.8
    would raise inside `cli` rather than exiting), and the message names both
    versions.
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
    """The guard that makes the two sides agree, and it was covered by nothing.

    A mutation turning `_refuse_unservable` into a no-op left the suite green,
    and the guard was also narrower than it claimed: it checked the alphabet and
    not the depth, so a template nine directories deep was built here, served,
    and refused on the other side — the one outcome it exists to prevent. It now
    calls the client's own `check_name`, and this is parametrized over what that
    covers.
    """
    with pytest.raises(ValueError):
        onboarding._refuse_unservable([(name, Path(__file__))])


def test_the_hub_refuses_a_template_of_more_files_than_a_client_unpacks():
    """The first of the two ceilings that belong to the SET rather than a name.

    They are checked on this side rather than delegated, because `unpack`
    applies them to a tar and this side is holding files — which is exactly the
    kind of "nearly the same check" that drifts, so both are asserted here. The
    other one is the test below; this docstring used to promise both while only
    this one existed, which is how `if total > MAX_BUILD_BYTES` came to survive
    being turned into `if False`.
    """
    from src.client.limits import MAX_MEMBERS

    many = [(f"f{index}.py", Path(__file__)) for index in range(MAX_MEMBERS + 1)]
    with pytest.raises(ValueError) as raised:
        onboarding._refuse_unservable(many)
    assert str(MAX_MEMBERS) in str(raised.value)


def test_the_hub_refuses_a_template_that_unpacks_to_more_than_a_push_may_be(
        tmp_path):
    """The second one: the VOLUME, which no other test here could reach.

    It cannot be staged with many files — `MAX_MEMBERS` fires first, which is
    the whole reason this ceiling needs a case of its own — so it is one member
    that is bigger than the ceiling on its own. The file is made with
    `truncate`, i.e. sparse: `st_size` is what `_refuse_unservable` measures and
    what this has to be big, and no 64 MB is ever written to the disk.
    """
    from src.client.limits import MAX_BUILD_BYTES

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
    """Both sides of the string, which this used to miss entirely.

    It compared `onboarding.TEMPLATE_KEY` against `onboarding.manifest(...)` —
    the hub against itself — while the client had the key as a bare literal that
    nothing here could see. The client now names it, so the comparison is the
    one the title claims: the same arrangement `hub.START_PATH` has with
    `onboarding.MANIFEST_URL`.
    """
    from src.client import setup

    assert setup.TEMPLATE_KEY == onboarding.TEMPLATE_KEY
    assert onboarding.TEMPLATE_KEY in onboarding.manifest(empty=True)
