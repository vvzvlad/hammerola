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
from src.buildproc import STATUS_CRASHED, STATUS_FAILED, STATUS_OK, BuildOutcome
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
        # OFF, like the real default: a hub in a test is a hub nobody configured,
        # and the whole point of the flag is that such a hub does not serve the
        # sketch panel. A test about the panel overrides it by name.
        sketch_panel=False,
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
        # A default, for the reason spelled out on `get` above: passed as a
        # keyword it collides with a caller's own `timeout=` and raises
        # TypeError instead of honouring it.
        kw.setdefault("timeout", 10)
        return httpx.request(method, self.url + path, **kw)

    def publish(self, pid, commit, body, token=TOKEN, headers=None):
        """Push, wait for the build, and answer as the synchronous endpoint did.

        201/200/409/422/413/401 come back exactly as they used to. A 202 is
        followed to its job and turned back into the answer that job reached,
        which is the one nearly every test in this suite is asking about. Use
        `publish_async` when the handover itself is the subject.

        `commit=None` posts to the MINTING route — the URL with no name in it,
        where the hub makes one out of the sources. The reply of a finished job
        carries the name it chose in `record["commit"]`; the reply of the PUSH
        carries it in `revision`, which only `publish_async` can show.

        `headers` are sent alongside the two this always sends, for the tests
        whose subject is a header the route reads — `X-Hammerola-Message` is the
        only one today (issue #67).
        """
        reply = self.publish_async(pid, commit, body, token=token,
                                   headers=headers)
        if reply.status_code != 202:
            return reply
        return self.await_job(reply.json()["job"], token=token)

    def publish_async(self, pid, commit, body, token=TOKEN, query="",
                      headers=None):
        """POST the push and return whatever the endpoint said, 202 included.

        `query` is appended verbatim, `?` and all, for the tests that are about
        what the route reads out of one — `?force=1` is the only such parameter
        today.
        """
        sent = {"Content-Type": "application/gzip"}
        if token is not None:
            sent["Authorization"] = f"Bearer {token}"
        sent.update(headers or {})
        path = f"/api/v1/publish/{pid}"
        if commit is not None:
            path = f"{path}/{commit}"
        path = f"{path}{query}"
        return httpx.post(f"{self.url}{path}",
                          content=body, headers=sent, timeout=30,
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
        # Both defaults through `setdefault`, so this reads like `get` and
        # `request` above and a caller's own `timeout=` is honoured rather than
        # colliding into a TypeError.
        kw.setdefault("trust_env", self.TRUST_ENV)
        kw.setdefault("timeout", 10)
        return httpx.request(method, f"{self.url}/api/v1/comments{path}",
                             headers=headers, **kw)

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

    IT REPORTS WHAT THE COPY ACTUALLY TOOK, and the flat `0.0` it used to
    declare was not a simplification but a false statement about a real clock.
    `duration_seconds` now reaches the client, which prints it after every build
    (`cli._print_duration`), so a hard zero here would have been a stand-in
    quietly deciding what the thing under test does — and it very nearly did:
    the honest reading of an absent duration is `is None`, and a truthiness test
    would have passed this suite in silence with the line never printed once.
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


def reading_comparer(old_dir, new_dir, *, pid, **_kw):
    """Stand in for `src.buildproc.run_compare`: name the two directories.

    The real comparer starts a child process that imports the CAD kernel and
    fuses two solids per part; this suite has neither the kernel nor minutes to
    spare, and the hub's half of a comparison — the route, the queue, the job
    record, the log — is the same whoever measured. So this reads the two
    directories only far enough to say what it was given and reports it as the
    log, which IS the answer a comparison produces: nothing is published.

    IT REPORTS A REAL DURATION, for the reason spelled out on `copying_builder`:
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
    hub = Hub(server)
    hub._thread = thread
    return hub


def stop_hub(hub):
    hub.server.shutdown()
    hub.server.server_close()
    hub._thread.join(timeout=5)


# -- archive building -------------------------------------------------------
# THE EXPORTS THE DEFAULT CATALOGUE NAMES, as archive members. Two rules the hub
# grew to mirror what a build can actually produce make these compulsory rather
# than decorative: a catalogue with no printable in it is a 422, and so is a
# printable that declares no `files` (`render._catalogue`) — while
# `cadbuild.printables.export_printables` writes STEP, STL and 3MF for every
# printable it finds. So the smallest archive this suite can publish is the
# document, the view file, and one export per printable.
#
# A CONSTANT AND NOT TWO LITERALS PER TEST, because a test builds its archive by
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
    """A meta.json in the wire format of SPEC 7, as issue #75 left it.

    TWO FIELDS CARRY THE WHOLE SHAPE and they are the two arguments here:
    `parts` is the catalogue — the one place a part exists, keyed by the name
    that IS its identity — and `views` is a list of tabs, each naming the
    catalogue keys it shows. The four flat maps the document used to carry
    (`downloads`, `overview`, `previews`, `notes`) are gone: a file now belongs
    to the part or the view it is OF, and a note sits inside the record it is
    about.

    The default pair is the smallest document the hub accepts, and the two
    halves agree by construction: the view shows both keys the catalogue
    declares.

    EVERY DEFAULT PRINTABLE CARRIES AN EXPORT, because a printable that carries
    none is a 422 (`render._catalogue`) and a catalogue with no printable in it
    is another — the two rules the hub grew to mirror what a build can actually
    produce, `export_printables` writing STEP, STL and 3MF for every printable
    it finds. ONE export each rather than three: what the fixture stands for is
    the SHAPE — a printable owns a non-empty `files` naming files this build
    published — and two more names per part would be two more archive members
    in every test that pushes one, for nothing. `good_build` is what puts
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

    IT NAMES KEYS NOW, and the reason is a check that did not exist when it did
    not. The hub holds a view file's leaves against the `parts` list its
    meta.json declares for that view, in both directions
    (`render._match_selection`), and refuses a leaf carrying no key at all — so
    a stand-in of unkeyed leaves is a document no push can carry, and one
    naming the wrong keys is a 422. The default is the default `meta_bytes`
    selection, so the two halves agree by construction exactly as they did
    before; a test that declares another selection passes its own keys here.

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

    Forwarded rather than enumerated, and that stays true through issue #75:
    the fields a test may want to put in the document are not a fixed list —
    `parts`, a `views` entry's `overview` or `preview`, a stray key the hub is
    supposed to drop — so this signature would otherwise grow a parameter per
    field. `downloads` was one such parameter until the map it named stopped
    existing, which is exactly the drift the forwarding avoids.

    `view_keys` IS THE ONE EXCEPTION AND IS NAMED RATHER THAN FORWARDED,
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
        # `tar_gz` directly and count their own members, exactly as they did
        # before.
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
