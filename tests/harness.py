"""Helpers for driving a real hub over a real socket.

The suite talks HTTP to a `ThreadingHTTPServer` bound to an ephemeral port rather
than calling handler methods directly. That is deliberate: half of what this
service promises is in the RESPONSE — status codes, `Cache-Control`, `Location` —
and a test that reached past the HTTP layer could not observe any of it, which is
exactly the layer SPEC 7.4 makes claims about.

TWO THINGS HERE STAND IN FOR THE BUILD, and both are load-bearing enough to say
out loud, because they are what lets the rest of the suite go on being about
publication rather than about geometry.

`copying_builder` replaces `src.buildproc.run_build`: it publishes the pushed
tree unchanged. Every test written before the hub built anything pushes a
FINISHED artefact — a meta.json and a view — so with this builder those pushes
mean exactly what they always meant, and the archive is still the thing under
test. The suite has no CadQuery, and a real build would be minutes per test.

`Hub.publish` posts and then WAITS, reconstructing the answer the endpoint gave
before the push became asynchronous (SPEC 8A.2 step 5). Almost every test in this
suite is about what ends up on disk, not about the handover; making each of them
poll a job would be two hundred copies of the same loop. The handover itself —
the 202, the job record, the log, the queue — is tested through `publish_async`
and the job helpers below, in test_jobs.py.
"""

import io
import json
import shutil
import tarfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import httpx

from src.app import create_server
from src.buildproc import STATUS_FAILED, STATUS_OK, BuildOutcome
from src.jobs import STATE_DONE, STATE_FAILED

# The one secret of the whole system (issue #26). There were two names
# here — TOKEN for pushes and READ_TOKEN for the comment queue — until step 0 of
# the plan collapsed them on the hub; a test that wants "a token the hub does not
# know" spells one out on the spot rather than reaching for a second constant.
TOKEN = "test-edit-token"

# A sentinel for "this field was not supplied at all", as distinct from
# `payload=None`, which means "send the JSON literal null". Defined here rather
# than beside the other comment helpers below because it is a DEFAULT ARGUMENT of
# a method on Hub, and those are evaluated when the class body runs.
NOTHING = object()


def settings_for(data_dir, max_build_bytes=8 * 1024 * 1024, **overrides):
    """A settings-shaped object, without touching the process environment.

    src.settings builds its singleton at import time from real env vars; a test
    that needed to vary a ceiling would have to re-import the module. Everything
    downstream only reads attributes, so a namespace is a faithful stand-in.

    `overrides` carries the comment ceilings (SPEC 7A.4) — all three of them
    about SIZE, since the count ceilings and the rate limit were removed on
    2026-08-27. They are keyword arguments rather than named parameters because a
    test only ever varies one: a photo-size test wants
    `comment_max_photo_bytes=1024` and could not care less what the text ceiling
    is.
    """
    values = dict(
        edit_token=TOKEN,
        host="127.0.0.1",
        port=0,  # ask the OS for a free port, then read back which one
        data_dir=str(data_dir),
        max_build_bytes=max_build_bytes,
        comment_max_text_chars=4000,
        comment_max_photo_bytes=1024 * 1024,
        comment_max_body_bytes=4 * 1024 * 1024,
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
        # inheriting one it cannot see — see the fifo test in test_serving.py,
        # where a hung handler thread has to fail rather than wedge the suite.
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
        headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
        return self.get("/index.json", headers=headers)

    def request(self, method, path, **kw):
        """For the verbs the two helpers above do not cover (HEAD, mostly)."""
        kw.setdefault("trust_env", self.TRUST_ENV)
        return httpx.request(method, self.url + path, timeout=10, **kw)

    def publish(self, pid, commit, body, token=TOKEN):
        """Push, wait for the build, and answer as the synchronous endpoint did.

        201/200/409/422/413/401 come back exactly as they used to. A 202 is
        followed to its job and turned back into the answer that job reached,
        which is the one nearly every test in this suite is asking about. Use
        `publish_async` when the handover itself is the subject.

        `commit=None` posts to the MINTING route — the URL with no name in it,
        where the hub makes one out of the sources. The reply of a finished job
        carries the name it chose in `record["commit"]`; the reply of the PUSH
        carries it in `revision`, which only `publish_async` can show.
        """
        reply = self.publish_async(pid, commit, body, token=token)
        if reply.status_code != 202:
            return reply
        return self.await_job(reply.json()["job"], token=token)

    def publish_async(self, pid, commit, body, token=TOKEN):
        """POST the push and return whatever the endpoint said, 202 included."""
        headers = {"Content-Type": "application/gzip"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        path = f"/api/v1/publish/{pid}"
        if commit is not None:
            path = f"{path}/{commit}"
        return httpx.post(f"{self.url}{path}",
                          content=body, headers=headers, timeout=30,
                          trust_env=self.TRUST_ENV)

    def job(self, job_id, token=TOKEN):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        return httpx.get(f"{self.url}/api/v1/jobs/{job_id}", headers=headers,
                         timeout=10, trust_env=self.TRUST_ENV)

    def job_log(self, job_id, token=TOKEN):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
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

    def publish_dev(self, pid, body, token=TOKEN):
        """POST /api/v1/publish/<pid>/dev — into the local slot (SPEC 7.6).

        Deliberately routed through `publish` with the literal segment rather
        than given its own URL builder: the whole claim is that `dev` is an
        ordinary last path segment which the router treats specially, and a test
        that bypassed the router could not observe that.
        """
        return self.publish(pid, "dev", body, token=token)

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
            sent["Authorization"] = f"Bearer {token}"
        sent.update(headers or {})
        return httpx.post(f"{self.url}/api/v1/comments/{pid}/{commit}",
                          content=body, headers=sent, timeout=30,
                          trust_env=self.TRUST_ENV)

    def read_comments(self, path="", token=TOKEN, method="GET", **kw):
        headers = kw.pop("headers", {}) or {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.request(method, f"{self.url}/api/v1/comments{path}",
                             headers=headers, timeout=10,
                             trust_env=self.TRUST_ENV, **kw)

    def comment_dir(self, pid):
        return self.data / "comments" / pid


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


class PublishReply:
    """A finished job, shaped like the reply the push used to get.

    Not an httpx response and deliberately not pretending to be one: it carries
    the three things a test asks a publish reply for — the status, the JSON body
    and its text — and nothing else, so a test that wants a HEADER off the push
    has to use `publish_async` and look at the real one.
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
    suite pushes the ARTEFACTS — that is what every test written before the hub
    built anything sends, and it is what keeps those tests about the archive and
    the publication rather than about geometry — so the stand-in copies the tree
    into the output directory and declares every file in it.

    `copytree` and not a move: the sources belong to the job, which removes them
    when it is done, and a build that consumed its own input would hide the fact
    that the two directories are separate on purpose.
    """
    shutil.copytree(project_dir, out_dir)
    names = tuple(
        str(path.relative_to(out_dir))
        for path in sorted(Path(out_dir).rglob("*"))
        if path.is_file() and not path.is_symlink())
    return BuildOutcome(
        status=STATUS_OK, pid=pid, files=names,
        log=f"copying builder: {len(names)} files\n", log_truncated=False,
        exit_code=0, signal=None, duration_seconds=0.0)


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


def start_hub(data_dir, build_runner=None, build_workers=None,
              build_queue_size=None, **kw):
    """Bind, serve on a daemon thread, and hand back a Hub. Caller stops it."""
    server = create_server(
        settings_for(data_dir, **kw),
        build_runner=copying_builder if build_runner is None else build_runner,
        build_workers=build_workers, build_queue_size=build_queue_size)
    # `shutdown()` blocks until serve_forever notices, which it only does once per
    # poll interval — the 0.5 s default would add half a second to every test that
    # uses a hub, which is most of them.
    thread = threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    hub = Hub(server)
    hub._thread = thread
    return hub


def stop_hub(hub):
    hub.server.shutdown()
    hub.server.server_close()
    hub._thread.join(timeout=5)


# -- archive building -------------------------------------------------------
def meta_bytes(views=None, downloads=None, **extra):
    """A meta.json in the wire format of SPEC 7 (`views`, not `variants`)."""
    payload = {
        "project": "demo",
        "title": "Demo project",
        "built": "2026-08-21T04:16:00Z",
        "views": views if views is not None else [
            {"id": "assembled", "name": "assembled",
             "file": "assembled.json", "parts": 2},
        ],
    }
    if downloads is not None:
        payload["downloads"] = downloads
    payload.update(extra)
    return json.dumps(payload).encode("utf-8")


def view_bytes(marker="a"):
    """Stand-in for a tessellation. Only its bytes matter to the hub."""
    return json.dumps({"shapes": [marker], "name": "root"}).encode("utf-8")


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


def good_build(marker="a", downloads=None, extra_files=None, **extra) -> bytes:
    """A publishable archive. `**extra` goes straight into meta.json.

    Forwarded rather than enumerated, because `downloads` is no longer the only
    map a build declares files in: `overview` and `previews` are read by the
    client and drawn by nothing, so a test about them has to be able to put one
    in the document without this signature growing a parameter per field.
    """
    files = {
        "meta.json": meta_bytes(downloads=downloads, **extra),
        "assembled.json": view_bytes(marker),
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
