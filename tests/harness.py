"""Helpers for driving a real hub over a real socket.

The suite talks HTTP to a `ThreadingHTTPServer` bound to an ephemeral port rather
than calling handler methods directly. That is deliberate: half of what this
service promises is in the RESPONSE — status codes, `Cache-Control`, `Location` —
and a test that reached past the HTTP layer could not observe any of it, which is
exactly the layer SPEC 7.4 makes claims about.

Two things here stand in for the build, so the rest of the suite can be about
publication rather than about geometry.

`copying_builder` replaces `src.buildproc.run_build`: it publishes the pushed
tree unchanged. Most tests push a FINISHED artefact — a meta.json and a view —
so the tree is the thing under test. The suite has no CadQuery, and a real
build would be minutes per test.

`Hub.publish` publishes an archive the way a hub did before git, under a name
the test chooses: the tree is built in the ordinary queue, the archive is filed
in `sources/`, and the import takes it into the project's repository, which is
what moves `latest`. Almost every test in this suite is about what ends up on
disk, not about the transport; `git push` itself is tested in
test_git_publish.py.
"""

import io
import json
import os
import shutil
import subprocess
import tarfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx

from src import onboarding
from src.app import create_server
from src.archive import unpack
from src.buildproc import STATUS_CRASHED, STATUS_FAILED, STATUS_OK, BuildOutcome
from src.errors import PublishError
from src.jobs import STATE_DONE, STATE_FAILED, SUBMIT_ACCEPTED, BuildTask
from src.store import (DEV_LINK, SOURCE_ARCHIVE_NAME, SOURCES_DIR_NAME,
                       _payload_digest, _read_digest)

# The one secret of the whole system. A test that wants "a token the hub does
# not know" spells one out on the spot rather than reaching for a second constant.
TOKEN = "test-edit-token"

# A sentinel for "this field was not supplied at all", as distinct from
# `payload=None`, which means "send the JSON literal null". Defined here rather
# than beside the other comment helpers below because it is a DEFAULT ARGUMENT of
# a method on Hub, and those are evaluated when the class body runs.
NOTHING = object()


def settings_for(data_dir, **overrides):
    """A settings-shaped object, without touching the process environment.

    src.settings builds its singleton at import time from real env vars; a test
    that needed to vary a ceiling would have to re-import the module. Everything
    downstream only reads attributes, so a namespace is a faithful stand-in.

    `overrides` carries the comment ceilings (SPEC 7A.4) — all three of them
    about SIZE — and the proposal body's. They are keyword arguments rather than named parameters because a
    test only ever varies one: a photo-size test wants
    `comment_max_photo_bytes=1024` and could not care less what the text ceiling
    is.
    """
    values = dict(
        edit_token=TOKEN,
        host="127.0.0.1",
        port=0,  # ask the OS for a free port, then read back which one
        data_dir=str(data_dir),
        comment_max_text_chars=4000,
        comment_max_photo_bytes=1024 * 1024,
        comment_max_body_bytes=4 * 1024 * 1024,
        proposal_max_body_bytes=256 * 1024,
        log_level="INFO",
    )
    unknown = set(overrides) - set(values)
    if unknown:
        # A typo in an override would otherwise be silently ignored and the test
        # would pass while exercising the default.
        raise TypeError(f"unknown settings override: {sorted(unknown)}")
    values.update(overrides)
    return SimpleNamespace(**values)


class Hub:
    """A running server plus the client conveniences the tests keep needing."""

    def __init__(self, server):
        self.server = server
        self.store = server.store
        self.data = server.store.root
        host, port = server.server_address[:2]
        self.url = f"http://{host}:{port}"

    # The hub under test is on 127.0.0.1, so the machine's proxy settings are
    # never right for it and reading them can be actively fatal: httpx parses
    # every NO_PROXY entry as a URL, and a perfectly ordinary `::1` in there
    # raises before the request is even attempted. `make test` on a laptop
    # behind a corporate proxy would fail in a way that has nothing to do with
    # the code being tested.
    TRUST_ENV = False

    def get(self, path, **kw):
        # `timeout` is a default rather than fixed, so a test whose SUBJECT is
        # the request coming back at all can name its own deadline instead of
        # inheriting one it cannot see.
        kw.setdefault("trust_env", self.TRUST_ENV)
        kw.setdefault("timeout", 10)
        return httpx.get(self.url + path, follow_redirects=False, **kw)

    def index(self, token=TOKEN):
        """GET /index.json, which takes the token (SPEC 3, and src/app.py).

        A helper rather than a header spelled out at twenty call sites: the list
        of what is on this hub is the one READ that is guarded, so every test
        about the front page's data has to carry it, and `token=None` is how a
        test asks the interesting question instead.
        """
        headers = {"X-Hammerola-Token": token} if token is not None else {}
        return self.get("/index.json", headers=headers)

    def builds(self, pid, token=TOKEN):
        """GET /project/<pid>/builds.json, which takes the token like `index`.

        It lists every revision of the project and its draft, so a shared build
        link must not open it; `token=None` asks what an anonymous reader gets.
        """
        headers = {"X-Hammerola-Token": token} if token is not None else {}
        return self.get(f"/project/{pid}/builds.json", headers=headers)

    def request(self, method, path, **kw):
        """For the verbs the two helpers above do not cover (HEAD, mostly)."""
        kw.setdefault("trust_env", self.TRUST_ENV)
        # A default, for the reason spelled out on `get` above: passed as a
        # keyword it collides with a caller's own `timeout=` and raises
        # TypeError instead of honouring it.
        kw.setdefault("timeout", 10)
        return httpx.request(method, self.url + path, **kw)

    def publish(self, pid, commit, body, force=False, message=None):
        """Publish one archive's tree as `<pid>/<commit>`, and wait. -> a reply.

        `commit` is `dev` for a draft, and None for the name a hub before git
        minted, the digest of the tree. A revision's archive is filed in
        `sources/` as a hub before git kept it, and the import takes it into the
        project's repository, after which `latest` follows `main`
        (`Store.ensure_repo`, `Store.recompute`).

        The archive is filed BEFORE the build is handed over, and taken away
        again if the build is refused: a build on disk without its archive is
        an import that fails, and of two publishes running at once, the one
        finishing first imports the other's build too.
        """
        submitted = self._submit(pid, commit, body, force, message, keep=True)
        if submitted.status_code != 202:
            return submitted
        reply = self.await_job(submitted.payload["job"])
        if submitted.name == DEV_LINK:
            return reply
        if reply.status_code in (200, 201):
            self.store.ensure_repo(pid)
            self.store.recompute(pid)
        elif submitted.kept is not None:
            shutil.rmtree(submitted.kept, ignore_errors=True)
        return reply

    def publish_async(self, pid, commit, body, force=False, message=None):
        """Hand one archive's tree to the build queue, as the hook hands a
        commit's. -> 202 `{"job"}`, or the answer given instead of a job.

        The archive is unpacked by the rules the import reads old archives
        with, and a refusal is the answer (422). A draft whose tree the slot
        already holds is answered 200 with no job, as the hook answers it; a
        full or stopped queue is 503. Nothing is filed in `sources/`, so a
        later `publish` to the same project would fail to import this build.
        """
        return self._submit(pid, commit, body, force, message, keep=False)

    def _submit(self, pid, commit, body, force, message, keep):
        """`publish_async`, and with `keep` the archive filed first."""
        spool = self.data / f".wip-body-{uuid.uuid4().hex}"
        sources = self.data / f".src-{uuid.uuid4().hex}"
        spool.write_bytes(body)
        try:
            sources.mkdir()
            try:
                digest = _payload_digest(unpack(spool, sources))
            except PublishError as error:
                shutil.rmtree(sources, ignore_errors=True)
                return Submitted(error.status, {"error": error.message})
        finally:
            spool.unlink(missing_ok=True)
        name = digest if commit is None else commit
        if name == DEV_LINK and digest == _read_digest(
                self.store.build_dir(pid, DEV_LINK)):
            shutil.rmtree(sources, ignore_errors=True)
            return Submitted(200, {"url": f"/project/{pid}/dev/"})
        kept = None
        archive = self.data / SOURCES_DIR_NAME / digest / SOURCE_ARCHIVE_NAME
        if keep and name != DEV_LINK and not archive.exists():
            archive.parent.mkdir(parents=True, exist_ok=True)
            archive.write_bytes(body)
            kept = archive.parent
        job_id = self.server.jobs.create(pid, name)["id"]
        verdict = self.server.builds.submit(BuildTask(
            job_id=job_id, pid=pid, commit=name, sources=sources,
            digest=digest, force=force, message=message))
        if verdict != SUBMIT_ACCEPTED:
            if kept is not None:
                shutil.rmtree(kept, ignore_errors=True)
            return Submitted(503, {"error": verdict})
        return Submitted(202, {"job": job_id}, name, kept)

    def job(self, job_id, token=TOKEN):
        headers = {"X-Hammerola-Token": token} if token else {}
        return httpx.get(f"{self.url}/api/v1/jobs/{job_id}", headers=headers,
                         timeout=10, trust_env=self.TRUST_ENV)

    def job_log(self, job_id, token=TOKEN):
        headers = {"X-Hammerola-Token": token} if token else {}
        return httpx.get(f"{self.url}/api/v1/jobs/{job_id}/log", headers=headers,
                         timeout=10, trust_env=self.TRUST_ENV)

    def await_job(self, job_id, token=TOKEN, timeout=30):
        """Poll one job to a terminal state and report it as a publish reply."""
        deadline = time.monotonic() + timeout
        record = None
        while time.monotonic() < deadline:
            record = self.job(job_id, token=token).json()
            if record["state"] in (STATE_DONE, STATE_FAILED):
                return PublishReply(record)
            time.sleep(0.005)
        raise AssertionError(
            f"job {job_id} never finished within {timeout}s: {record}")

    def publish_dev(self, pid, body, force=False):
        """A draft: the tree into the local slot (SPEC 7.6)."""
        return self.publish(pid, DEV_LINK, body, force=force)

    def project_dir(self, pid):
        return self.store.projects_dir / pid

    # -- comments (SPEC 7A) ------------------------------------------------
    def post_comment(self, pid, commit, payload=NOTHING, photo=None, shot=None,
                     headers=None, body=None, content_type=None, token=TOKEN):
        """POST a comment. The token goes with it (SPEC 7A.2, step 0).

        `token=None` omits the header, which is what the tests about the door
        use; every other test here is about what happens AFTER it, so sending
        the secret is the default.

        `body`/`content_type` bypass the encoder entirely, which is what lets a
        test send a body no ordinary client would produce.
        """
        if body is None:
            fields = {}
            if payload is not NOTHING:
                fields["comment"] = json.dumps(payload)
            files = {}
            if photo is not None:
                files["photo"] = photo
            if shot is not None:
                files["shot"] = shot
            body, content_type = multipart_body(fields, files)
        sent = {"Content-Type": content_type} if content_type else {}
        if token is not None:
            sent["X-Hammerola-Token"] = token
        sent.update(headers or {})
        return httpx.post(f"{self.url}/api/v1/comments/{pid}/{commit}",
                          content=body, headers=sent, timeout=30,
                          trust_env=self.TRUST_ENV)

    def read_comments(self, path="", token=TOKEN, method="GET", **kw):
        headers = kw.pop("headers", {}) or {}
        if token is not None:
            headers["X-Hammerola-Token"] = token
        # Both defaults through `setdefault`, so this reads like `get` and
        # `request` above and a caller's own `timeout=` is honoured rather than
        # colliding into a TypeError.
        kw.setdefault("trust_env", self.TRUST_ENV)
        kw.setdefault("timeout", 10)
        return httpx.request(method, f"{self.url}/api/v1/comments{path}",
                             headers=headers, **kw)

    def comment_dir(self, pid):
        return self.data / "comments" / pid

    # -- the stored proposal -----------------------------------------------
    def proposal(self, pid, method="GET", payload=NOTHING, token=TOKEN, **kw):
        """One request to /api/v1/proposals/<pid>, with the token on it.

        All three verbs through one helper, because all three answer to the
        same URL and the tests here are mostly about the door: `token=None`
        omits the header, which is what those ask with. `payload` is encoded as
        the JSON body; a test that wants to send bytes no client would produce
        passes `content=` instead and leaves it alone.
        """
        headers = kw.pop("headers", {}) or {}
        if token is not None:
            headers["X-Hammerola-Token"] = token
        if payload is not NOTHING:
            kw["content"] = json.dumps(payload)
            headers.setdefault("Content-Type", "application/json")
        # Both defaults through `setdefault`, so a caller's own `timeout=` is
        # honoured rather than colliding into a TypeError.
        kw.setdefault("trust_env", self.TRUST_ENV)
        kw.setdefault("timeout", 10)
        return httpx.request(method, f"{self.url}/api/v1/proposals/{pid}",
                             headers=headers, **kw)

    def proposal_path(self, pid):
        return self.data / "proposals" / f"{pid}.json"


def multipart_body(fields=None, files=None, boundary="TestBoundary--123"):
    """Encode a multipart/form-data body by hand. -> (bytes, content type).

    Hand-rolled rather than delegated to httpx because half of what these tests
    do is send something a well-behaved client cannot: a photo whose declared
    Content-Type disagrees with its bytes, a duplicate field, a truncated body.
    `files` values are (filename, bytes, declared content type).
    """
    marker = f"--{boundary}".encode("ascii")
    chunks = []
    for name, value in (fields or {}).items():
        data = value.encode("utf-8") if isinstance(value, str) else value
        chunks.append(
            marker + b"\r\n"
            + f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            + data + b"\r\n")
    for name, (filename, data, ctype) in (files or {}).items():
        chunks.append(
            marker + b"\r\n"
            + (f'Content-Disposition: form-data; name="{name}"; '
               f'filename="{filename}"\r\n').encode()
            + f"Content-Type: {ctype}\r\n\r\n".encode()
            + data + b"\r\n")
    chunks.append(marker + b"--\r\n")
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


# -- attachment fixtures ----------------------------------------------------
# Real magic bytes, because that is the whole mechanism under test: a PNG is a
# PNG here because its first eight bytes say so, not because of its name.
PNG_BYTES = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
             + b"\x00" * 32)
JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 32
WEBP_BYTES = b"RIFF" + b"\x24\x00\x00\x00" + b"WEBPVP8 " + b"\x00" * 32
SVG_BYTES = (b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg">'
             b'<script>alert(1)</script></svg>')
GIF_BYTES = b"GIF89a" + b"\x00" * 32


def comment_payload(**extra):
    """The JSON half of a comment, in the shape the build page sends (SPEC 7A.1)."""
    payload = {
        "text": "the bracket fouls the standoff",
        "view": "assembled",
        "part": "/root/bracket",
        "point": [1.0, 2.0, 3.5],
        "camera": {
            "position": [10.0, 10.0, 10.0],
            "quaternion": [0.0, 0.0, 0.0, 1.0],
            "target": [0.0, 0.0, 0.0],
            "zoom": 1.25,
        },
    }
    payload.update(extra)
    return payload


class Submitted:
    """What `Hub.publish_async` answered: a status and a JSON body.

    `name` is what the build is published under; `kept` is the directory in
    `sources/` this submission filed, or None.
    """

    def __init__(self, status, payload, name=None, kept=None):
        self.status_code = status
        self.payload = payload
        self.text = json.dumps(payload)
        self.name = name
        self.kept = kept

    def json(self):
        return self.payload


class PublishReply:
    """A finished job, shaped like a synchronous publish reply.

    Not an httpx response and deliberately not pretending to be one: it carries
    the three things a test asks a publish reply for — the status, the JSON body
    and its text — and nothing else.
    """

    def __init__(self, record):
        self.record = record
        self.status_code = record["code"]
        self.payload = ({"url": record["build_url"]}
                        if record["build_url"] is not None
                        else {"error": record["error"]})
        self.text = json.dumps(self.payload)

    def json(self):
        return self.payload


def copying_builder(project_dir, out_dir, *, pid, **_kw):
    """Stand in for `src.buildproc.run_build`: ship the pushed tree unchanged.

    The push carries a source tree that a real build turns into artefacts. This
    suite pushes the ARTEFACTS, which keeps the tests about the archive and the
    publication rather than about geometry, so the stand-in copies the tree into
    the output directory and declares every file in it.

    `copytree` and not a move: the sources belong to the job, which removes them
    when it is done, and a build that consumed its own input would hide the fact
    that the two directories are separate on purpose.

    It reports what the copy actually took: `duration_seconds` goes into the
    job record, and a hard zero here would be a stand-in deciding what the
    thing under test does.
    """
    started = time.monotonic()
    shutil.copytree(project_dir, out_dir)
    names = tuple(
        str(path.relative_to(out_dir))
        for path in sorted(Path(out_dir).rglob("*"))
        if path.is_file() and not path.is_symlink())
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=names,
        log=f"copying builder: {len(names)} files\n", log_truncated=False,
        exit_code=0, signal=None, duration_seconds=time.monotonic() - started)


def failing_builder(status=STATUS_FAILED, log="build failed: no printables\n",
                    exit_code=3):
    """A builder that refuses, the way a broken model does. -> a runner."""
    def run(project_dir, out_dir, *, pid, **_kw):
        # The output directory is created and left EMPTY, because that is what a
        # build that got part way and gave up leaves behind — and the point of
        # the test using this is that nothing of it is ever published.
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        return BuildOutcome(
            status=status, pid=pid, files=(), log=log, log_truncated=False,
            exit_code=exit_code, signal=None, duration_seconds=0.25)
    return run


# The file whose presence makes `picky_builder` fail a build.
BROKEN = "BROKEN"


def picky_builder(delay=0.0):
    """`copying_builder`, unless the tree holds a file named BROKEN.

    For the tests of `git push`, where a commit that breaks the build is one
    more commit. `delay` holds every build that long, for races.
    """
    fail = failing_builder()

    def run(project_dir, out_dir, *, pid, **kw):
        time.sleep(delay)
        if (Path(project_dir) / BROKEN).exists():
            return fail(project_dir, out_dir, pid=pid, **kw)
        return copying_builder(project_dir, out_dir, pid=pid, **kw)
    return run


def reading_comparer(old_dir, new_dir, *, pid, **_kw):
    """Stand in for `src.buildproc.run_compare`: name the two directories.

    The real comparer starts a child process that imports the CAD kernel and
    fuses two solids per part; this suite has neither the kernel nor minutes to
    spare, and the hub's half of a comparison — the route, the queue, the job
    record, the log — is the same whoever measured. So this reads the two
    directories only far enough to say what it was given and reports it as the
    log, which IS the answer a comparison produces: nothing is published.

    It reports a real duration, for the reason spelled out on `copying_builder`:
    the number reaches the job record and a stand-in must not be the thing that
    decides what it looks like.
    """
    started = time.monotonic()
    parts = sorted({path.stem for path in Path(old_dir).glob("*.step")}
                   | {path.stem for path in Path(new_dir).glob("*.step")})
    log = (f"comparing {Path(old_dir).name} -> {Path(new_dir).name}, "
           f"{len(parts)} parts\n")
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=(), log=log, log_truncated=False,
        exit_code=0, signal=None, duration_seconds=time.monotonic() - started)


def failing_comparer(status=STATUS_CRASHED, log="compareproc: the kernel died\n",
                     exit_code=4):
    """A comparison that ends badly, the way a crashed child does. -> a runner.

    CRASHED AND NOT FAILED, unlike `failing_builder` one heading up. That status
    means "the model's build() raised", which a comparison has no equivalent of:
    `_compare_outcome` can return ok, timeout, cpu_exhausted, killed,
    limits_error or crashed, and nothing else. A stand-in handing out a state
    the real runner cannot produce is a test passing against a hub that never
    happens.
    """
    def run(old_dir, new_dir, *, pid, **_kw):
        return BuildOutcome(
            status=status, pid=pid, files=(), log=log, log_truncated=False,
            exit_code=exit_code, signal=None, duration_seconds=0.25)
    return run


def start_hub(data_dir, build_runner=None, compare_runner=None,
              build_workers=None, build_queue_size=None, **kw):
    """Bind, serve on a daemon thread, and hand back a Hub. Caller stops it."""
    server = create_server(
        settings_for(data_dir, **kw),
        build_runner=copying_builder if build_runner is None else build_runner,
        compare_runner=(reading_comparer if compare_runner is None
                        else compare_runner),
        build_workers=build_workers, build_queue_size=build_queue_size)
    # `shutdown()` blocks until serve_forever notices, which it only does once per
    # poll interval — the 0.5 s default would add half a second to every test that
    # uses a hub, which is most of them.
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    # A hub on a fresh volume has nothing to catch up on; one restarted on a
    # used one is asked about only once `Store.catch_up` is through.
    server.catching_up.join(timeout=30)
    hub = Hub(server)
    hub._thread = thread
    return hub


def stop_hub(hub):
    hub.server.shutdown()
    hub.server.server_close()
    hub._thread.join(timeout=5)


# -- a git client -------------------------------------------------------------
# The real `git` of the test image, because what has to work is what that client
# sends. Its own configuration: none from the system or the user, an identity
# for the commits the tests make, and no prompt for a password the hub never
# asks for.
TOKEN_CONFIG = f"http.extraHeader=X-Hammerola-Token: {TOKEN}"
GIT_CLIENT_ENV = {
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_NAME": "test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def git(*args, env=None, check=True, timeout=120):
    return subprocess.run(
        ["git", *map(str, args)],
        env={**os.environ, **GIT_CLIENT_ENV, **(env or {})},
        capture_output=True, text=True, check=check, timeout=timeout)


def project_files(pid, marker="a", **extra) -> dict:
    """A project's directory as a test commits it: project.json and a build.

    The build is the finished artefact `good_build` carries, which
    `copying_builder` publishes as it is.
    """
    return {"project.json": json.dumps({"id": pid, "title": "Demo project"}
                                       ).encode("utf-8"),
            "meta.json": meta_bytes(**extra),
            "assembled.json": view_bytes(marker),
            **DEFAULT_EXPORTS}


def write_files(directory, files: dict) -> None:
    for name, data in files.items():
        path = Path(directory) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def commit_all(work, message="change") -> str:
    """Commit everything in the working copy. -> the commit's sha."""
    git("-C", work, "add", "-A")
    git("-C", work, "commit", "--quiet", "--allow-empty", "-m", message)
    return git("-C", work, "rev-parse", "HEAD").stdout.strip()


def push(hub, work, pid, *refspecs, extra=()):
    """`git push` of the working copy to the project's repository on `hub`."""
    return git("-C", work, "-c", TOKEN_CONFIG, "push", *extra,
               f"{hub.url}/git/{pid}.git", *(refspecs or ("main",)),
               check=False)


# -- the skill, which is a DIRECTORY -----------------------------------------
# The hub serves `skill/` as one archive (`onboarding.skill_bytes`), so a test
# pinning a sentence of the instructions has to look in every document of the
# set: a rule that moved from the entry document into `references/` is the same
# rule and must go on being pinned, while a pin aimed at one file would stop
# finding it. Reading the set is these three functions' whole job; which file a
# sentence is in is the author's business and no test's.


def skill_files() -> dict:
    """The skill as this checkout has it: `{member path: text}`."""
    return {name: path.read_text(encoding="utf-8")
            for name, path in onboarding.skill_members()}


def served_skill_files(hub) -> dict:
    """The skill the hub SERVES, unpacked: `{member path: text}`.

    Over HTTP, because what a pin of this kind is about is the document an
    agent installs — not the file beside the test.
    """
    reply = hub.get(onboarding.SKILL_URL)
    assert reply.status_code == 200, (
        f"the hub did not serve the skill: HTTP {reply.status_code}")
    with tarfile.open(fileobj=io.BytesIO(reply.content), mode="r:gz") as tar:
        return {info.name: tar.extractfile(info).read().decode("utf-8")
                for info in tar.getmembers() if info.isfile()}


def one_text(files: dict) -> str:
    """Every document of a skill as one string, entry document first.

    For a pin that is about what the skill SAYS rather than about where it says
    it. Joined with a blank line, so a pattern anchored to a line start still
    matches the first line of each file.
    """
    ordered = sorted(files,
                     key=lambda name: (name != onboarding.SKILL_ENTRY, name))
    return "\n\n".join(files[name] for name in ordered)


# -- archive building -------------------------------------------------------
# THE EXPORTS THE DEFAULT CATALOGUE NAMES, as archive members. A rule the hub
# grew to mirror what a build can actually produce makes these compulsory rather
# than decorative: a printable that declares no `files` is a 422
# (`render._catalogue`) — while `cadbuild.printables.export_printables` writes
# STEP, STL and 3MF for every printable it finds. So the smallest archive with
# a printable this suite can publish is the document, the view file, and one
# export per printable.
#
# A constant and not two literals per test, because a test builds its archive by
# hand exactly when it wants to vary ONE thing about it: spelling the exports
# out at each of those sites would put the fixture's own invariant — the
# catalogue names these two names — in a hundred places that are about something
# else. `good_build` splices it in; a test using `tar_gz` directly writes
# `**DEFAULT_EXPORTS` beside its own members. A test that hands `meta_bytes` its
# OWN `parts` names its own files and carries them itself.
DEFAULT_EXPORTS = {
    "lid.stl": b"solid lid\nendsolid lid\n",
    "pin.stl": b"solid pin\nendsolid pin\n",
}


def meta_bytes(views=None, parts=None, **extra):
    """A meta.json in the wire format of SPEC 7.

    Two fields carry the whole shape and they are the two arguments here:
    `parts` is the catalogue — the one place a part exists, keyed by the name
    that IS its identity — and `views` is a list of tabs, each naming the
    catalogue keys it shows. A file belongs to the part or the view it is OF,
    and a note sits inside the record it is about.

    The default pair is the smallest document the hub accepts, and the two
    halves agree by construction: the view shows both keys the catalogue
    declares.

    EVERY DEFAULT PRINTABLE CARRIES AN EXPORT, because a printable that carries
    none is a 422 (`render._catalogue`) — the rule the hub grew to mirror what a
    build can actually produce, `export_printables` writing STEP, STL and 3MF
    for every printable it finds. ONE export each rather than three: what the
    fixture stands for is the SHAPE — a printable owns a non-empty `files`
    naming files this build published — and two more names per part would be
    two more archive members in every test that pushes one, for nothing. `good_build` is what puts
    `lid.stl` and `pin.stl` in the archive; a test that hands this its own
    `parts` names its own files and takes them there too.
    """
    payload = {
        "project": "demo",
        "title": "Demo project",
        "built": "2026-08-21T04:16:00Z",
        "views": views if views is not None else [
            {"id": "assembled", "name": "assembled",
             "file": "assembled.json", "parts": ["lid", "pin"]},
        ],
        "parts": parts if parts is not None else {
            "lid": {"kind": "printable", "files": {"stl": "lid.stl"}},
            "pin": {"kind": "printable", "files": {"stl": "pin.stl"}},
        },
    }
    payload.update(extra)
    return json.dumps(payload).encode("utf-8")


def view_bytes(marker="a", keys=("lid", "pin")):
    """Stand-in for a tessellation: a root group over one keyed leaf per key.

    It names keys: the hub holds a view file's leaves against the `parts` list its
    meta.json declares for that view, in both directions
    (`render._match_selection`), and refuses a leaf carrying no key at all — so
    a stand-in of unkeyed leaves is a document no push can carry, and one
    naming the wrong keys is a 422. The default is the default `meta_bytes`
    selection, so the two halves agree by construction; a test that declares another selection passes its own keys here.

    The shape is the exported one: a node with `parts` is a GROUP and carries no
    key of its own, and each leaf under it names the catalogue record it is of.
    `marker` is what makes two of these differ by bytes, which several tests
    read back off the wire.
    """
    return json.dumps({
        "name": "root",
        "id": "/root",
        "parts": [{"name": key, "id": f"/root/{key}", "key": key,
                   "shape": {"marker": marker}} for key in keys],
    }).encode("utf-8")


def tar_gz(files: dict) -> bytes:
    """A flat, well-formed gzipped tar — the shape CI is supposed to send."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def good_build(marker="a", extra_files=None, view_keys=None, **extra) -> bytes:
    """A publishable archive. `**extra` goes straight into meta.json.

    Forwarded rather than enumerated: the fields a test may want to put in the
    document are not a fixed list — `parts`, a `views` entry's `overview` or
    `preview`, a stray key the hub is supposed to drop — so this signature
    would otherwise grow a parameter per field.

    `view_keys` is the one exception and is named rather than forwarded,
    because it goes into the OTHER file: the hub holds the view file's leaves
    against the `parts` the meta declares for that view, so a test narrowing
    the catalogue has to narrow the stand-in view with it. It is not derived
    from `views` on purpose — several tests here hand the hub a document that
    is meant to be refused, and a helper that quietly repaired the halves into
    agreement would take the refusal away.
    """
    files = {
        "meta.json": meta_bytes(**extra),
        "assembled.json": (view_bytes(marker) if view_keys is None
                           else view_bytes(marker, keys=view_keys)),
        # THE TWO EXPORTS THE DEFAULT CATALOGUE NAMES. They are here
        # unconditionally rather than only when `parts` was left alone, because
        # `extra` is forwarded rather than inspected and this would otherwise
        # have to guess what the caller's own catalogue points at. The cost of
        # a member nobody's document names is two more names in `files`, which
        # is the ceiling `_check_map_size` and `_spend_file_budget` derive from
        # — so the tests ABOUT those ceilings build their archives with
        # `tar_gz` directly and count their own members.
        **DEFAULT_EXPORTS,
    }
    files.update(extra_files or {})
    return tar_gz(files)


def raw_tar_gz(entries) -> bytes:
    """Build an archive from explicit TarInfo objects.

    `tar_gz` above cannot express the interesting cases: tarfile will happily
    WRITE a member named `../escape` or a symlink, but the convenience wrapper has
    no way to ask for one. These builders do, which is what lets the security
    tests send a genuinely hostile archive rather than a description of one.
    """
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for info, data in entries:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    return buffer.getvalue()


def file_entry(name, data):
    info = tarfile.TarInfo(name)
    info.type = tarfile.REGTYPE
    info.size = len(data)
    info.mode = 0o644
    return info, data


def symlink_entry(name, target):
    info = tarfile.TarInfo(name)
    info.type = tarfile.SYMTYPE
    info.linkname = target
    info.size = 0
    return info, None


def hardlink_entry(name, target):
    info = tarfile.TarInfo(name)
    info.type = tarfile.LNKTYPE
    info.linkname = target
    info.size = 0
    return info, None


def dir_entry(name):
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    info.size = 0
    return info, None


def fifo_entry(name):
    info = tarfile.TarInfo(name)
    info.type = tarfile.FIFOTYPE
    info.mode = 0o644
    info.size = 0
    return info, None


def chardev_entry(name, major=1, minor=3):
    """A character device — /dev/null by default."""
    info = tarfile.TarInfo(name)
    info.type = tarfile.CHRTYPE
    info.mode = 0o644
    info.size = 0
    info.devmajor = major
    info.devminor = minor
    return info, None
