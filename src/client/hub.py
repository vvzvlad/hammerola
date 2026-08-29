"""Talking to the hub: one POST, then a job polled to its end.

WHY `urllib.request` AND NOT httpx. The client is installed on the author's
machine, so every dependency it declares is one more thing that has to be
present there and one more thing the self-update of SPEC §8 entry 26 has to
carry — and what is needed here is a POST of a byte string with two headers and
two GETs. `urllib` does that, and the client stays importable under any
python3.

This does NOT contradict the note in `requirements.txt` that an outbound call in
`src/` is what moves httpx up into the runtime dependencies. That note is about
the SERVICE, whose whole point is that it makes no outbound request; the
condition it names — needing an HTTP CLIENT LIBRARY — is not met, because
nothing here imports one. httpx stays where it is, in requirements-dev.txt,
driving a real socket in the tests.

THE PROTOCOL, as `src/app.py` and `src/jobs.py` define it:

    POST /api/v1/publish/<pid>            Bearer, body = tar.gz. The HUB names
                                          the revision, out of the sources in
                                          the body.
      202 {"job", "status_url", "log_url", "revision"} + Location -> queued
      200 {"url", "revision"}                          -> this exact push is
                                                          already published, and
                                                          nothing was rebuilt
      413 / 422 / 401 / 503 {"error"}                  -> refused, here is why
    POST /api/v1/publish/<pid>/dev        the same, into the local slot, whose
                                          name is the constant `dev` and which
                                          therefore has no `revision` to report

    GET  /api/v1/jobs/<id>                Bearer -> the record, `state` in
                                          queued|building|done|failed
    GET  /api/v1/jobs/<id>/log            Bearer -> text/plain, what the build
                                          printed

TWO IDENTIFIERS COME BACK FROM A 202 AND THEY ANSWER DIFFERENT QUESTIONS. `job`
is this attempt — its progress, its log, unpredictable, gone from the pusher's
interest the moment the build ends. `revision` is what the build will publish —
permanent, immutable, the string that ends up in a URL somebody pastes. Push the
same sources twice and the job is different both times while the revision is the
same, which is the property the whole scheme is for. Never print one where the
other is meant.

And the routes the READ-ONLY commands stand on, none of which is new — `status`
and `comments` are spelled out of what the browser already fetches:

    GET  /project/<pid>/builds.json       PUBLIC. `{pid, project, title,
                                          has_dev, latest, builds[]}`, and
                                          404 for a project that has never
                                          published anything.
    GET  /project/<pid>/<name>/meta.json  PUBLIC. One build's own record;
                                          `<name>` is `dev`, `latest` or a
                                          revision.
    GET  /project/<pid>/<name>/<file>     PUBLIC. Any file the build ships —
                                          the STL and STEP the `downloads` of
                                          meta.json name, and metrics.json.
    GET  /api/v1/comments?project=<pid>   Bearer -> `{"comments": [...]}`
    POST /api/v1/comments/<id>/resolve    Bearer, `{"note": ...}` -> the record

And the one route this tool asks for with NO token at all, because it is read by
somebody who does not have one yet:

    GET  /start                           `{"empty", "skill", "client",
                                          "template"}` — three relative paths,
                                          and whether this hub has anything on
                                          it. `create` follows the `template`
                                          one and fetches nothing else.

The code of a revision, and the two routes that unmake something:

    GET    /api/v1/sources/<revision>     Bearer -> the pushed body, byte for
                                          byte, as an opaque attachment
    GET    /api/v1/sources/<revision>/log Bearer -> what that build printed
    POST   /api/v1/projects/<pid>/title   Bearer, `{"title": ...}` -> renames
    DELETE /api/v1/projects/<pid>         Bearer -> removes the project whole

WHICH SIDE OF THE TOKEN A THING IS ON IS THE WHOLE REASON `source` AND
`artifacts` ARE TWO VERBS. The build a revision produced is public — it is what
the site is for — and the code that produced it is not (SPEC 8, entry 17). One
verb with a flag would put the two behind one word and make the difference a
matter of remembering.

EVERY ROUTE HERE CHECKS THE SAME SECRET, `EDIT_TOKEN` — one for the whole
system (SPEC §8 entry 26), on both sides since step 0 of the plan. There used to
be a second sentence in this file, `UNAUTHORIZED_QUEUE`, for the one 401 that
did NOT mean "wrong token": the hub checked `COMMENT_READ_TOKEN` on the queue
and `PUBLISH_TOKEN` on a push, so a deployment that set them differently gave a
client that published fine and answered 401 on `hammerola comments`. There is
one variable now, so there is one message.

A 4xx is returned to the caller rather than raised: 200, 202, 409 and 422 are
all meaningful answers to a push and the caller is the one that knows what to do
with each. Only "the hub could not be reached at all" is an exception.
"""

import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from src.client.config import header_value_problem
from src.client.limits import MAX_ARTIFACT_BYTES, MAX_BUILD_BYTES

# One request. Generous because the request that matters carries the whole
# archive up a domestic uplink; the WAIT for a build is a separate budget
# entirely (`await_job` below), because it is bounded by the queue and not by
# the network.
HTTP_TIMEOUT = 300

# The budget for a command that only ASKS something — status, the comment queue,
# a login's check. Nothing is uploaded, so the generous ceiling above buys
# nothing here and costs five minutes of a terminal looking hung when the
# address is wrong in a way that black-holes packets instead of refusing them.
QUERY_TIMEOUT = 30

# How the status endpoint is polled. Fast at first so a push that is already
# published, or a model that fails in two seconds, answers immediately; then
# backing off, because past the first few seconds the build is minutes long and
# a poll a second is pointless load on a hub with two build workers.
POLL_FIRST_SECONDS = 0.25
POLL_MAX_SECONDS = 2.0
POLL_BACKOFF = 1.5

# How long `await_job` waits by default. The worst honest wait is the queue
# ahead of you: MAX_QUEUED_JOBS (16) builds at buildproc's `wall_seconds` (900,
# raised from 120 on 2026-08-29) over MAX_CONCURRENT_BUILDS (2) workers is about
# two hours, and this is that with a little room. `--timeout` moves it; a person
# presses Ctrl-C long before either.
#
# THIS NUMBER IS A COPY AND CANNOT IMPORT ITS SOURCE -- the client is stdlib-only
# and may not reach into `src.buildproc` -- so it goes stale the moment
# `wall_seconds` moves and nothing anywhere says so. When it does go stale the
# symptom is not an error: the client reports a timeout on a build that is still
# legitimately queued, and the build then publishes with nobody watching. Move
# `wall_seconds`, come back here.
JOB_TIMEOUT = 8100

TERMINAL_STATES = ("done", "failed")

# TWO CEILINGS ON WHAT ONE REPLY MAY WEIGH, applied as the bytes are read rather
# than after them. The unpacker's ceilings are counted from the tar headers,
# which is a check that happens once the whole body is already in memory — so a
# hub answering with a gigabyte is a gigabyte of the author's RAM before anything
# looks at it.
#
# They are two because the replies are two KINDS. Everything this tool parses —
# a manifest, a job record, a build log, a source archive — is bounded by what a
# push may be, since a source tree is what produced it. A BUILD ARTEFACT is not:
# an STL is OUTPUT, and the hub lets one build write a file four times the size
# of any archive it would accept (`buildproc.Limits.file_bytes`, 256 MiB against
# this tool's 64). The reasoning rests on that number and on the shape — a push
# is source, a reply here is meshes — and NOT on any claim that such exports are
# routine. `file_bytes` says the opposite in as many words: "The whole upload is
# capped at 64 MiB elsewhere (MAX_BUILD_BYTES), so an exported part an order of
# magnitude larger than the entire input is already pathological." It is a
# ceiling chosen to be unreachable, and the point here is only that the hub will
# serve anything under it. One number for both would mean the hub publishing a
# part that `hammerola artifacts` then refuses to fetch, with a message claiming
# no reply may be that big — which, for that reply, would be false.
#
# NEITHER IS A STATEMENT ABOUT THE HUB. Both are copies of a default (see
# `limits.py`), and a deployment may be configured differently; what they bound
# is how much THIS TOOL will hold in memory. The honest alternative for the
# artefact half is to stream it to a file and have no ceiling at all — worth
# doing the day a fetch is written that way, and not worth restructuring
# `artifacts.py` for today.
MAX_REPLY_BYTES = MAX_BUILD_BYTES
MAX_ARTIFACT_REPLY_BYTES = MAX_ARTIFACT_BYTES

# Loopback is never reached through a proxy, and a machine whose environment or
# system settings name one would otherwise send the whole push into it. This is
# the shape that breaks `make test` on a laptop behind a corporate proxy — the
# suite's own httpx client sets `trust_env=False` for exactly this — and it is
# equally wrong for a developer running a hub of their own on 127.0.0.1. Every
# other address keeps the machine's proxy configuration, which is what somebody
# publishing from inside a corporate network actually needs.
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")

# The two schemes urllib can open and this tool has any business using. Checked
# when a Hub is made rather than left to fail later: `//hub.example` parses into
# a perfectly good host with no scheme, and `Request` then raises a bare
# ValueError two layers away from anything that could explain it.
ALLOWED_SCHEMES = ("http", "https")

# What a 401 means, on any route. ONE sentence for all of them, because there
# is one secret and therefore exactly one thing to do about it. Do not grow a
# per-route variant: the only reason the old one existed was that a 401 on the
# queue could also mean "the deployment set its SECOND variable to something
# else", and that variable is gone.
UNAUTHORIZED = (
    "the hub refused the token (HTTP 401).\n"
    "  Run `hammerola login` to store the right one, or check EDIT_TOKEN in "
    "the environment.")

# The manifest of what a first run needs, and the ONE route this tool asks for
# without a token. Spelled here rather than imported from `src.onboarding`,
# which is the hub's: the client takes nothing from the service half (see
# `src/client/__init__.py`), and `tests/test_onboarding.py` compares this string
# against the route the hub serves — the same arrangement `limits.py` has with
# the hub's ceilings. Every other path this tool fetches is READ OUT of the
# manifest rather than spelled again.
START_PATH = "/start"

# An id no job can have. `JobStore.create` names a job with
# `secrets.token_urlsafe(16)`, so this matches the alphabet and the length the
# hub accepts — which is the point: it gets past the shape check and reaches the
# lookup, where it is guaranteed to miss. Used by `check_token`, where 404 means
# "the token was accepted and the id was not found" and 401 means the opposite.
IMPOSSIBLE_JOB_ID = "0" * 22


class HubError(Exception):
    """The hub could not be reached, or answered something unusable."""


class Hub:
    """One hub, one token. Nothing here logs or prints the token."""

    def __init__(self, url: str, token: str, timeout: int = HTTP_TIMEOUT):
        self.url = url.rstrip("/")
        # BOTH INPUTS ARE CHECKED HERE, before a single request is attempted,
        # and each gets the sentence that belongs to IT: `_origin` answers for
        # the address, `_refuse_unsendable_token` for the secret. They are
        # checked in two places rather than one because the two failures need
        # opposite advice — "check HUB_URL" against "run `hammerola login`" —
        # and telling somebody to replace the one secret of the system over a
        # typo in an address is the specific harm this arrangement exists to
        # prevent.
        self._origin = _origin(self.url)
        _refuse_unsendable_token(token)
        self._token = token
        self.timeout = timeout
        self._opener = _opener_for(self._origin)

    # -- transport ---------------------------------------------------------
    def _call(self, path: str, *, method: str = "GET", body=None,
              content_type=None, max_bytes=None):
        """(status, bytes). Raises HubError only when there was no answer.

        `max_bytes` is how much of the answer this call will hold; it defaults to
        `MAX_REPLY_BYTES`, and the ONE caller that raises it is the one fetching
        a build's artefacts (see the constants above).

        THE HEADER IS OMITTED WHEN THERE IS NO TOKEN, rather than sent empty.
        `create` reaches the hub for the starter template and deliberately never
        reads the secret (see `Hub.start`), so it builds a Hub with none; a
        `Bearer ` with nothing behind it would be a credential-shaped header
        that means nothing, and every guarded route answers exactly the same
        401 to it as to no header at all.
        """
        cap = MAX_REPLY_BYTES if max_bytes is None else max_bytes
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if content_type is not None:
            headers["Content-Type"] = content_type
        if body is not None:
            headers["Content-Length"] = str(len(body))
        try:
            request = urllib.request.Request(
                self.url + path, data=body, method=method, headers=headers)
            # THE ERROR BODY IS READ IN HERE TOO, INSIDE `_exchange`, and that
            # is what the split is for. It used to be read in the `except
            # HTTPError` clause of THIS try — and an exception raised in a
            # handler is not offered to the handlers beside it, so a 500 whose
            # chunked body stopped early went straight past every clause below
            # as a traceback. Putting the body ceiling on error replies made
            # that path more reachable, not less. One statement in the try, and
            # both reads are behind the same diagnosis.
            return self._exchange(request, self.url + path, cap)
        except ValueError as error:
            # THE LAST RESORT, AND DELIBERATELY NEUTRAL. It used to say "the
            # token contains a character that cannot be sent in an HTTP header"
            # and to tell the reader to run `hammerola login` — a sentence that
            # was true of one cause and asserted of every ValueError on this
            # path. It was wrong at least twice: an address with no scheme
            # (`Request` raises "unknown url type") and an unparseable
            # `Location` from the other end both arrived here, and both told
            # somebody to replace the one secret of the system over a header
            # they did not write.
            #
            # Each of those now has a check of its own, ahead of this line —
            # `_origin` for the address, `_refuse_unsendable_token` for the
            # secret, `_SameOriginRedirects.http_error_302` for the Location —
            # so what reaches here is something none of the three anticipated.
            # It says so, and names nothing it cannot know.
            #
            # THE EXCEPTION'S OWN TEXT IS NOT REPEATED, and that is the whole
            # care in this clause: `http.client` puts the offending header in
            # its message, and the offending header here would be
            # `Bearer <the token>`. Printing it would put the secret in the
            # scrollback of every run that hit this.
            raise HubError(
                f"the request to {self.url} could not be built "
                f"({type(error).__name__}), and was not sent.\n"
                f"  The address, the stored secret and any path the hub named "
                f"are all checked before\n"
                f"  this point, so this is none of them — please report it.")\
                from error
        except http.client.InvalidURL as error:
            # NARROW ON PURPOSE, and the width is the whole correctness of the
            # sentence below. `InvalidURL` is raised while the request line is
            # being assembled, so "nothing was sent" is a fact about it. Its
            # PARENT, `HTTPException`, is not: `RemoteDisconnected` inherits
            # from it as well as from `ConnectionResetError`, and that fires
            # AFTER the request has gone — a hub restarting mid-push, http
            # spoken at an https port, a proxy dropping the connection. Catching
            # the parent told the pusher their archive was never sent while the
            # build it started was already queued, and took those cases out of
            # the "cannot reach" branch that described them honestly. They
            # belong there; only this one belongs here.
            #
            # THE CASE THAT MATTERS IS UNTRUSTED INPUT. `fetch_path` follows a
            # path the HUB named, and a path carrying `\r\n` is an attempt to
            # append a header of somebody else's choosing; `http.client` refuses
            # it, and this turns that refusal into a sentence instead of a
            # traceback out of every clause around it.
            #
            # THE TEXT GOES THROUGH `quoted`, and the reason this clause used
            # to say it did not need to was WRONG. It read "safe, because what
            # it quotes is the URL, repr-escaped by http.client" — true of the
            # control-character message and false of the other one, which is
            # `"nonnumeric port: '%s'"`, a plain interpolation of a string that
            # came off a `Location` header. No text from the far end is printed
            # raw anywhere on this path any more; the rule is cheaper to keep
            # than the case analysis was to get right.
            raise HubError(
                f"{self.url} would not take this request: "
                f"{quoted(error)}\n"
                f"  Nothing was sent.") from error
        except urllib.error.URLError as error:
            raise HubError(f"cannot reach {self.url}: {error.reason}") from error
        except OSError as error:
            raise HubError(f"cannot reach {self.url}: {error}") from error
        except http.client.IncompleteRead as error:
            # A BODY THAT STOPPED, AND IT IS NOT THE SAME STORY AS THE ONE
            # BELOW. `Content-Length` truncation is caught in `_read_capped`;
            # this is its CHUNKED twin, where the framing is in the stream and
            # `http.client` raises rather than returning short. It shares that
            # clause's meaning, not this file's "not HTTP" one — the far end
            # spoke HTTP perfectly well and then stopped, which is a proxy, a
            # restart or a timeout, and telling that reader to check their
            # SCHEME is a correct refusal with somebody else's cause on it.
            # That is the exact defect this round was fixing elsewhere.
            #
            # Its text is counts (`IncompleteRead(10 bytes read, 30 more
            # expected)`), not far-end bytes, but it goes through `quoted`
            # anyway: no exception text is printed raw on this path, so nobody
            # has to re-derive which ones are safe.
            raise HubError(
                f"{self.url} stopped sending part-way through its reply "
                f"({quoted(error)}).\n"
                f"  Nothing was kept. The connection ended mid-body — a proxy, "
                f"a restart or a timeout\n"
                f"  at the other end. Try again.") from error
        except http.client.HTTPException as error:
            # THE REST OF THAT FAMILY, AND ITS POSITION IS THE WHOLE DESIGN.
            # What actually lands here, each checked against the sentence below:
            #   BadStatusLine    the far end's first line is not a status line
            #   LineTooLong      a header or chunk-size line over 65536 bytes
            #   UnknownProtocol  a version that is not HTTP/0.9, 1.0 or 1.1
            #   UnknownTransferEncoding, CannotSendHeader and the
            #                    connection-state ones — unreachable here, one
            #                    connection per request and no reuse, and all of
            #                    them still mean "this is not a working HTTP
            #                    conversation", which is what is printed
            # and what does NOT, each caught above on purpose:
            #   InvalidURL       its own clause — nothing was sent, and that is
            #                    a fact about it and not about these
            #   RemoteDisconnected  `OSError` — a dropped connection is a
            #                    network failure and reads as one
            #   IncompleteRead   the clause above — the reply STARTED
            #
            # LAST, BELOW `OSError`, because `RemoteDisconnected` is both an
            # HTTPException and a `ConnectionResetError`: catching this family
            # earlier would take an ordinary dropped connection out of the
            # honest "cannot reach" branch, which is exactly the regression
            # that narrowing `InvalidURL` was fixing. Order is what keeps both
            # true at once.
            #
            # WHAT IT USUALLY IS: `http://` where the hub speaks `https://`.
            # The far end answers with a TLS alert, or a captive portal or a
            # proxy answers with something that is not a status line at all, and
            # `http.client` refuses to parse it. That is the same class of typo
            # `_origin` exists for, so the message points at the same variable.
            # Nothing is claimed about whether the request was sent — it was.
            #
            # `quoted` IS LOAD-BEARING HERE ABOVE EVERYWHERE ELSE.
            # `BadStatusLine` carries the line the far end sent, decoded and
            # unescaped, up to `http.client._MAXLINE` — 65536 bytes. Printed
            # raw that is a 65 kB message on stderr with whatever ANSI escapes
            # the sender chose in it, and the threat model is the redirect
            # handler's: an address typed with one character wrong, at a domain
            # somebody has registered.
            raise HubError(
                f"{self.url} answered something that is not HTTP "
                f"({type(error).__name__}: {quoted(error)}).\n"
                f"  Check HUB_URL: an `http://` address where the hub speaks "
                f"`https://` looks exactly\n"
                f"  like this, and so does a captive portal or a proxy "
                f"answering in its place.") from error

    def _exchange(self, request, where: str, cap: int):
        """Send it, and read the body — of a 2xx and of an error alike.

        ONE PLACE, so that both reads sit inside `_call`'s single `try` and get
        the same diagnosis. The error read used to live in `_call`'s own
        `except HTTPError` clause, and Python does not offer an exception raised
        inside a handler to the handlers beside it — so a 500 whose chunked body
        stopped early escaped every clause as a traceback, while the identical
        200 was named properly. Anything raised here reaches all of them.

        An HTTP status IS an answer, and every 4xx this hub gives carries the
        sentence explaining it, so the code and the body are returned rather
        than raised — raising would throw that sentence away and report
        "HTTP Error 422" instead. The body is capped like a 200's: an error body
        is a body, and a hub answering 500 with a gigabyte fills the same
        memory.
        """
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return response.status, _read_capped(response, where, cap)
        except urllib.error.HTTPError as error:
            try:
                return error.code, _read_capped(error, where, cap)
            finally:
                error.close()

    @staticmethod
    def _payload(status: int, raw: bytes) -> dict:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict):
            raise HubError(
                f"the hub answered HTTP {status} with something that is not "
                f"JSON: {quoted(raw)}")
        return payload

    # -- the two routes ----------------------------------------------------
    def publish(self, pid: str, body: bytes, *, slot: str = None):
        """POST one archive. -> (status, payload dict).

        `slot` is the last path segment, and the only thing that differs between
        the two commands: `dev` for the local slot, and NOTHING for a revision.
        The absence is what asks the hub to name it — there is no id to send,
        because the client has none and never invents one.
        """
        path = f"/api/v1/publish/{urllib.parse.quote(pid)}"
        if slot is not None:
            path = f"{path}/{urllib.parse.quote(slot)}"
        status, raw = self._call(path, method="POST", body=body,
                                 content_type="application/gzip")
        return status, self._payload(status, raw)

    def job(self, job_id: str) -> dict:
        status, raw = self._call(f"/api/v1/jobs/{urllib.parse.quote(job_id)}")
        if status != 200:
            raise HubError(
                f"the hub answered HTTP {status} for job {job_id}: "
                f"{quoted(raw)}")
        return self._payload(status, raw)

    def job_log(self, job_id: str) -> str:
        status, raw = self._call(
            f"/api/v1/jobs/{urllib.parse.quote(job_id)}/log")
        if status != 200:
            raise HubError(f"the hub answered HTTP {status} for the log of "
                           f"job {job_id}")
        return raw.decode("utf-8", "replace")

    def await_job(self, job_id: str, timeout: float = JOB_TIMEOUT,
                  on_state=None) -> dict:
        """Poll until the job is `done` or `failed`. Raises HubError on timeout.

        `on_state` is called once per NEW state, so a run prints "building" when
        the build starts and not once a second for as long as it lasts.
        """
        deadline = time.monotonic() + timeout
        wait = POLL_FIRST_SECONDS
        seen = None
        record = None
        while True:
            record = self.job(job_id)
            state = record.get("state")
            if state != seen:
                seen = state
                if on_state is not None:
                    on_state(state)
            if state in TERMINAL_STATES:
                return record
            if time.monotonic() >= deadline:
                raise HubError(
                    f"job {job_id} was still {state!r} after {timeout:.0f}s.\n"
                    f"  The build is not cancelled by giving up here — the hub "
                    f"kills it on its own ceiling. Check "
                    f"{self.url}/api/v1/jobs/{job_id} later, or pass a longer "
                    f"--timeout.")
            time.sleep(min(wait, max(0.0, deadline - time.monotonic())))
            wait = min(wait * POLL_BACKOFF, POLL_MAX_SECONDS)

    # -- what the hub already knows about a project ------------------------
    def builds(self, pid: str):
        """`builds.json`, or None when the hub has nothing under this id.

        None rather than an exception, because "nobody has ever pushed this
        project" is an ANSWER to `hammerola status` and not a failure of it — a
        directory that was created five minutes ago is in exactly that state.

        No new route was added for this: it is the file the project page itself
        fetches, so `status` reads what the browser reads and cannot drift into
        showing something the site does not.
        """
        return self._json_or_none(
            f"/project/{urllib.parse.quote(pid)}/builds.json")

    def build_meta(self, pid: str, name: str):
        """One build's `meta.json` — `dev`, `latest` or a revision, or None.

        Wanted for the local slot above all: `builds.json` says only WHETHER the
        slot is occupied (`has_dev`), because the slot is not part of the
        project's history, so the only place its timestamp exists is its own
        meta.
        """
        return self._json_or_none(
            f"/project/{urllib.parse.quote(pid)}/{urllib.parse.quote(name)}"
            f"/meta.json")

    def _json_or_none(self, path: str):
        status, raw = self._call(path)
        if status == 404:
            return None
        if status != 200:
            raise HubError(
                f"the hub answered HTTP {status} for {path}: "
                f"{quoted(raw)}")
        return self._payload(status, raw)

    def build_file(self, pid: str, name: str, filename: str):
        """One file out of a published build, or None when it is not there.

        PUBLIC, and no token is presented for it — this is the same URL the
        viewer fetches. That asymmetry is the point of `artifacts` being a verb
        of its own next to `source`: a build's STL is served to the world, while
        the code that produced it is not (SPEC 8, entry 26).

        None for a 404 rather than an exception, because "this revision ships no
        such file" is an answer several callers act on: a build published before
        the model wrote metrics.json is an ordinary thing to run into.

        THE ONE CALL WITH A CEILING OF ITS OWN, and the reason is above
        `MAX_ARTIFACT_REPLY_BYTES`: what comes back here is a build's OUTPUT, and
        the hub lets a build write files several times the size of any archive it
        would accept. Holding this to the push's number would refuse to fetch a
        part the hub is serving.
        """
        code, raw = self._call(
            f"/project/{urllib.parse.quote(pid)}/{urllib.parse.quote(name)}"
            f"/{urllib.parse.quote(filename)}",
            max_bytes=MAX_ARTIFACT_REPLY_BYTES)
        if code == 404:
            return None
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for {name}/{filename} of {pid}")
        return raw

    # -- the code of a revision --------------------------------------------
    def revision_archive(self, revision: str) -> bytes:
        """The body that was pushed to produce one revision (SPEC 7.8).

        Byte for byte what the pusher sent, so this is the code that built the
        revision rather than a repacking of it.
        """
        code, raw = self._call(
            f"/api/v1/sources/{urllib.parse.quote(revision)}")
        return self._sources_reply(code, raw, revision)

    def revision_log(self, revision: str) -> str:
        """What the build of one revision printed."""
        code, raw = self._call(
            f"/api/v1/sources/{urllib.parse.quote(revision)}/log")
        return self._sources_reply(code, raw, revision).decode("utf-8", "replace")

    def _sources_reply(self, code: int, raw: bytes, revision: str) -> bytes:
        """The two answers this endpoint gives, told apart for the reader.

        The hub answers the SAME 404 for a revision that was never published,
        one whose build failed, one whose code somebody removed by hand and a
        segment that is not a revision id at all — deliberately, so the reply
        confirms nothing about what is on the volume. The message therefore has
        to name all of them rather than guess at one.
        """
        if code == 401:
            raise HubError(UNAUTHORIZED)
        if code == 404:
            raise HubError(
                f"the hub has no stored code for revision {revision}.\n"
                f"  It answers the same for a revision that was never "
                f"published, one whose build\n"
                f"  failed, and one published before the hub started keeping "
                f"sources. `hammerola status`\n"
                f"  lists the revisions this project has.")
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for the code of {revision}")
        return raw

    # -- the project itself ------------------------------------------------
    def rename_project(self, pid: str, title: str, missing_ok: bool = False):
        """Give the project a new TITLE. Never an id — there is no route for it.

        `missing_ok` answers None instead of raising when the hub has no such
        project, because for a rename that is not a failure: a project exists on
        the hub from its first successful push, and renaming one that has not
        been pushed yet is an ordinary thing to do — the new name is in
        `project.json` and the first push will carry it.
        """
        body = json.dumps({"title": title}).encode("utf-8")
        code, raw = self._call(
            f"/api/v1/projects/{urllib.parse.quote(pid)}/title",
            method="POST", body=body, content_type="application/json")
        if code == 404 and missing_ok:
            return None
        return self._project_reply(code, raw, pid, "rename")

    def remove_project(self, pid: str) -> dict:
        """Delete the project and everything under it. -> what the hub removed."""
        code, raw = self._call(
            f"/api/v1/projects/{urllib.parse.quote(pid)}", method="DELETE")
        return self._project_reply(code, raw, pid, "remove")

    def _project_reply(self, code: int, raw: bytes, pid: str,
                       verb: str) -> dict:
        if code == 401:
            raise HubError(UNAUTHORIZED)
        if code == 404:
            raise HubError(
                f"the hub has no project {pid}.\n"
                f"  A project exists on the hub from its first successful push; "
                f"until then there is\n"
                f"  nothing there to {verb}.")
        if code != 200:
            raise HubError(
                f"the hub refused to {verb} {pid} with HTTP {code}: "
                f"{quoted(self._payload(code, raw).get('error', ''))}")
        return self._payload(code, raw)

    # -- the comment queue -------------------------------------------------
    def comments(self, pid: str, *, status: str = None, since: str = None):
        """The queue for one project, oldest first (SPEC 7A.2).

        The filters are the hub's own, applied THERE rather than here: a queue
        filtered after the fact would still have carried every resolved comment
        of the project's whole life over the wire to be thrown away.
        """
        query = {"project": pid}
        if status is not None:
            query["status"] = status
        if since is not None:
            query["since"] = since
        code, raw = self._call(
            f"/api/v1/comments?{urllib.parse.urlencode(query)}")
        if code == 401:
            raise HubError(UNAUTHORIZED)
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for the comment queue: "
                f"{quoted(self._payload(code, raw).get('error', ''))}")
        payload = self._payload(code, raw)
        records = payload.get("comments")
        if not isinstance(records, list):
            raise HubError(
                f"the hub answered with no comment list: {quoted(payload)}")
        return records

    def resolve_comment(self, cid: str, note: str = None) -> dict:
        """Mark one comment handled. Returns the record as it now stands.

        The note is sent even when it is None — as `{"note": null}`, which is
        what the endpoint reads for "no note". A POST with no body at all would
        mean the same thing to this hub, and would stop meaning it the day
        anything in front of it insisted on a Content-Length.
        """
        body = json.dumps({"note": note}).encode("utf-8")
        code, raw = self._call(
            f"/api/v1/comments/{urllib.parse.quote(cid)}/resolve",
            method="POST", body=body, content_type="application/json")
        if code == 401:
            raise HubError(UNAUTHORIZED)
        if code == 404:
            raise HubError(
                f"the hub has no comment {cid}.\n"
                f"  Ids come from `hammerola comments`; a resolved comment "
                f"keeps its id, so this is a wrong id rather than a stale one.")
        if code != 200:
            raise HubError(
                f"the hub refused to resolve {cid} with HTTP {code}: "
                f"{quoted(self._payload(code, raw).get('error', ''))}")
        return self._payload(code, raw)

    # -- getting started ---------------------------------------------------
    def start(self) -> dict:
        """`GET /start` — the manifest of what a first run needs. NO TOKEN.

        Public on the hub, and asked for without a credential here: `create`
        never reads the secret, so a project can be started against a hub the
        machine is not logged in to. The reply is `{"empty", "skill", "client",
        "template"}` — three relative paths and one boolean about the hub
        (`src/onboarding.py` has the whole argument for why that boolean is
        public and why nothing wider is).
        """
        code, raw = self._call(START_PATH)
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for {START_PATH}, so it did not "
                f"say where the starter template is.\n"
                f"  A hub older than this tool has no such route; "
                f"`hammerola create --no-template` needs neither.")
        return self._payload(code, raw)

    def fetch_path(self, path: str) -> bytes:
        """One file the manifest NAMED, by its path on this hub.

        The path comes back from the hub, so its SHAPE is checked before it is
        used: one leading slash and no second one. What that buys is precision
        about the reading, not safety — be exact about it, because the sentence
        that used to stand here was not. `//elsewhere.example/x` does NOT
        become another host: this fetch concatenates the path onto the base
        address, so what urllib is handed is `http://hub//elsewhere.example/x`,
        whose host is the hub. The check refuses a manifest that WROTE
        something host-shaped anyway — a path that reads as an address is not a
        path this hub is naming on itself, and answering it would be reading
        the manifest as something other than what it says.

        ITS SENDABILITY IS CHECKED IN THE SAME PLACE, and that is why the two
        checks sit together rather than one here and one in the transport. This
        is the ONLY path in the client that is not spelled locally and run
        through `quote`, so it is the only one that can be unsendable at all —
        and `_call`'s last-resort clause says "the address, the secret and any
        path the hub named are all checked before this point", which was a claim
        with a hole in it while this checked shape alone. Two ways through:
        a control character, which `http.client` refuses while assembling the
        request line, and a NON-ASCII one, which fails earlier still because the
        request line is encoded as ASCII (`UnicodeEncodeError`, a ValueError, so
        it landed in the "please report it" clause — for untrusted input).

        WHAT ACTUALLY HOLDS THE CREDENTIAL is `_SameOriginRedirects`, installed
        on the opener for every request this tool makes: a hub can name a path
        on itself and then answer it with a redirect, and urllib follows a 3xx
        carrying the request's headers. Do not read the shape check as that
        protection; it is one refusal earlier, and cheaper.
        """
        if not path.startswith("/") or path.startswith("//"):
            raise HubError(
                f"the hub named {quoted(path)}, which is not a path on this "
                f"hub. Nothing was fetched.")
        if not path.isascii() or any(ord(char) < 32 or ord(char) == 127
                                     for char in path):
            raise HubError(
                f"the hub named {quoted(path)}, which is not a path this tool "
                f"can request:\n"
                f"  a request line is ASCII and carries no control characters. "
                f"Nothing was fetched.")
        code, raw = self._call(path)
        if code != 200:
            raise HubError(f"the hub answered HTTP {code} for {quoted(path)}")
        return raw

    # -- credentials -------------------------------------------------------
    def check_token(self) -> bool:
        """Is this token the one the hub checks on a push?

        Asked of the JOBS route, because it is the only one that answers the
        question without doing anything: it needs the token, it changes nothing,
        and an id that cannot exist separates the two answers cleanly — 401 is
        "wrong secret", 404 is "right secret, and no such job". Every other
        route either takes no token (the site) or would have to publish
        something to be asked.

        Any other status is treated as accepted rather than refused: this runs
        inside `hammerola login`, and a hub answering something unexpected is
        not evidence that the operator typed the password wrong.
        """
        status, _raw = self._call(f"/api/v1/jobs/{IMPOSSIBLE_JOB_ID}")
        return status != 401

    def absolute(self, url: str) -> str:
        """A `build_url` from the hub (`/project/<pid>/<name>/`) made clickable."""
        if not url:
            return ""
        if url.startswith(("http://", "https://")):
            return url
        return f"{self.url}{url}"


# How much of anything the FAR END wrote is ever put in a message. Two hundred
# characters is enough to recognise a TLS alert, a captive portal's HTML or a
# proxy's complaint, and short enough that a screenful stays a screenful.
QUOTE_LIMIT = 200


def quoted(text, limit: int = QUOTE_LIMIT) -> str:
    """Something the other end wrote, made safe to print. Trimmed, then escaped.

    THE RULE IS FLAT ON PURPOSE: nothing that came off the wire is printed raw,
    with no per-case reasoning about which library messages happen to be
    escaped already. That reasoning was tried and it was wrong twice in one
    file — `http.client` repr-escapes the URL in one `InvalidURL` message and
    interpolates a raw string in the other, and `BadStatusLine` carries up to
    65536 bytes of whatever the far end sent, decoded and untouched. A 65 kB
    error message full of ANSI escapes is what that produced, on stderr, from a
    server reached because an address was typed with one character wrong.

    ONE CALLER IS DELIBERATELY NOT HERE: `job_log` and `revision_log` return the
    build's own output, which the CLI prints in full. That is the whole point of
    those verbs — a log this trimmed would be useless — and it is the one text
    from the hub that a person asked to see.

    BE EXACT ABOUT WHAT THAT EXEMPTION COSTS, because it is two things and only
    the first is obvious. The log is unbounded up to the reply ceiling (64 MiB),
    AND it is unescaped: whatever control characters and terminal escapes it
    carries go to the terminal as they are. For the log of your own model that
    is the right trade — the log is the product of the command. For a "log"
    served by a host reached through a typo in HUB_URL it is not a trade at all,
    and nothing here distinguishes the two. It is accepted, not overlooked.

    THE SOURCE IS CUT BEFORE IT IS ESCAPED, and the order matters in a module
    whose ceilings exist because "a gigabyte in a reply is a gigabyte of the
    author's RAM": escaping first built a second copy of the whole string —
    several times its size, since `repr` expands — only to throw all but 200
    characters away. A manifest path is bounded by the reply ceiling, which is
    megabytes. The cut takes `limit` characters, which is a generous margin
    because escaping only ever grows a string, and the LENGTH reported is the
    source's, which is the number a reader wants anyway.

    `bytes` are decoded HERE rather than at each call site, and the reason is
    that there are three of them holding a response body — one decoding rule in
    one place beats three that drift. The cut still happens before the decode,
    which does cut a multi-byte character in half; `errors="replace"` is what
    makes that a visible replacement character at the end of a quotation rather
    than a failure, and a quotation is all this is. Doing it the other way round
    would decode the whole body to throw nearly all of it away, which is the
    thing the paragraph above is about.

    The unit in the message follows the input: bytes are counted in bytes and
    text in characters. They are not the same number for anything non-ASCII,
    and the one place this is read is a message about a size.
    """
    if isinstance(text, (bytes, bytearray)):
        source = bytes(text[:limit]).decode("utf-8", "replace")
        total, unit = len(text), "bytes"
    else:
        source = str(text)
        total, unit = len(source), "characters"
        source = source[:limit]
    quoted = repr(source)
    if total <= limit and len(quoted) <= limit:
        return quoted
    return f"{quoted[:limit]}... ({total} {unit}, truncated)"


def _bytes_text(count: int) -> str:
    """A ceiling as the number that was actually configured.

    `count / 1e6` was here and it turned every one of these into a number that
    appears nowhere else in the system: MAX_BUILD_BYTES is 64 MiB and printed as
    "67 MB", the artefact ceiling 256 MiB as "268", and a ceiling lowered under
    a megabyte as "0 MB". Somebody grepping the settings for the number in the
    message would find nothing.
    """
    for unit, size in (("MiB", 1024 ** 2), ("KiB", 1024)):
        if count >= size:
            return f"{count / size:.0f} {unit}"
    return f"{count} bytes"


def _read_capped(response, where: str, cap: int) -> bytes:
    """The body, refusing to hold more than `cap` bytes and refusing a short one.

    Read as `cap + 1` bytes so that crossing the ceiling is observable without
    reading past it: this runs before anything has looked at what arrived, and
    the whole point is not to hold it.

    The message says what the ceiling IS rather than what the hub may send: the
    two numbers here are copies of defaults, and a deployment configured
    differently is entitled to answer with more than this tool will hold.

    AND THE LENGTH IS CHECKED, WHICH THE CAP TOOK AWAY. `response.read()` with
    no argument raises `IncompleteRead` when the body is shorter than the
    `Content-Length` the reply declared; `response.read(n)` does NOT — it hands
    back whatever arrived and closes the connection, silently. Moving to the
    capped read was right on its own and it removed the only integrity check
    this reply had, so the check is restored here explicitly.

    IT MATTERS MOST WHERE NOTHING ELSE LOOKS. A JSON body and a tar both verify
    themselves — a truncated one fails to parse — so the paths that were safe
    were the ones with a format behind them. A build ARTEFACT has none: a short
    read of an `.stl` or a `.step` was written to disk, its shortened size
    printed, and the command exited zero. That is a corrupt file with nothing
    anywhere saying so, which is worse than the traceback the unbounded read
    used to give.

    Only when a length was DECLARED — and a chunked reply, which declares none,
    is NOT the hole this used to claim it was. Its framing is in the stream, so
    `http.client` raises `IncompleteRead` when it stops early rather than
    handing back a short body; that is caught in `_call`, in a clause of its
    own. What is left unverifiable is narrower and duller: a reply with neither
    a length nor chunking, ended by closing the connection.

    The length is taken BEFORE the read, because `.length` is what remains and
    the read is what consumes it.
    """
    declared = _declared_length(response)
    data = response.read(cap + 1)
    if len(data) > cap:
        raise HubError(
            f"{quoted(where)} answered with more than {_bytes_text(cap)}, "
            f"which is "
            f"more than this tool will hold in memory for one reply — nothing "
            f"was kept.")
    if declared is not None and len(data) < declared:
        raise HubError(
            f"{quoted(where)} sent {len(data)} bytes of the {declared} it "
            f"declared, "
            f"then the connection ended.\n"
            f"  Nothing was kept: an incomplete reply is not a shorter one, "
            f"and a truncated artefact\n"
            f"  written to disk would look like a finished file. Try again.")
    return data


def _declared_length(response):
    """How many bytes the body is FRAMED to carry, as the library parsed it.

    ASKED OF THE LIBRARY AND NOT OF THE HEADER, and that is the correctness of
    it rather than a preference. `HTTPResponse.begin` decides the framing once:
    it sets `.chunked` from `Transfer-Encoding` and then reads `Content-Length`
    only `if length and not self.chunked` — because the standard says chunked
    framing WINS and the header is to be ignored. Reading the header here
    instead meant a complete chunked reply that happened to carry both was
    refused as truncated, in the same breath as a docstring saying a chunked
    answer is a legal one. `.length` is that decision: None for chunked, the
    count for a declared body.

    None for anything that has no such field, which includes an unframed reply
    ended by closing the connection — every one of those means the same thing
    here, that completeness cannot be checked.

    THE RESPONSE IS NOT ALWAYS THE RESPONSE. On an error path the object is an
    `HTTPError`, which wraps the real `HTTPResponse` in `.fp`; the field is
    looked for in both places rather than assumed, so the check covers a 500's
    body as well as a 200's.

    ONE KNOWN WAY THIS WOULD FALSELY REFUSE, recorded because it is cheap to
    know and expensive to rediscover: `begin()` sets `.length = 0` outright for
    a 204, a 304, a 1xx and a HEAD, so a reply carrying such a status AND a body
    would read as... nothing, since zero is never more than what arrived. It is
    the reverse case — such a status with a non-zero declared body — that has no
    way to be seen at all. Unreachable today: this client sends no conditional
    headers, issues no HEAD and the hub answers neither code. The day a caching
    layer goes in front of the hub is the day to check it.
    """
    for holder in (response, getattr(response, "fp", None)):
        length = getattr(holder, "length", None)
        if isinstance(length, int) and not isinstance(length, bool):
            return length if length >= 0 else None
    return None


class _SameOriginRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse a redirect that leaves the hub. Installed on EVERY request.

    THE HEADER TRAVELS, WHICH IS THE WHOLE PROBLEM. urllib follows a 3xx on its
    own and copies the request's headers to the new URL, `Authorization`
    included — verified against two local servers, where the second one received
    `Bearer <the token>` intact. So a hub whose address was typed with one
    character wrong, at a domain somebody has registered, can answer every
    tokenized verb — `build`, `commit`, `source`, `comments` — with a redirect
    and be handed the one secret of the system: the same string that deletes a
    project outright.

    Refusing on a change of scheme, host or port covers that, and it costs
    nothing real: a redirect WITHIN the hub is still followed, which is what an
    ordinary trailing-slash or HTTPS-upgrade redirect is.

    Raising HubError rather than returning None: None makes urllib treat the 3xx
    as the final response, so the caller would see a 302 with an empty body and
    no idea why. The exception is not one urllib catches, so it arrives at
    `cli.main`, which prints it as the sentence it is.
    """

    def http_error_302(self, req, fp, code, msg, headers):
        """The base handler, with an unreadable `Location` named as one.

        THIS IS EARLIER THAN `redirect_request`, WHICH IS THE POINT. urllib
        parses the header and joins it onto the request's URL BEFORE it asks
        this class whether the redirect may be followed, so a `Location` of
        `http://[evil` raises `ValueError: Invalid IPv6 URL` inside
        `urlparse` — above `_same_origin`, which swallows its own. That
        ValueError then landed in the one clause in `_call` that used to explain
        a token which cannot go in a header, and a stranger's malformed header
        told somebody to replace the system's secret.

        The existing test for that story sends a non-numeric port, which is the
        variant that DOES reach `_same_origin`; this covers the variant that
        never gets there.

        The four aliases below are what the base class does with these codes,
        restated because overriding one method does not re-point the others.
        """
        try:
            return super().http_error_302(req, fp, code, msg, headers)
        except ValueError as error:
            raise HubError(
                f"{quoted(req.full_url)} answered {code} with a Location "
                f"this tool cannot read ({quoted(error)}).\n"
                f"  Refused, and nothing was sent there. That header is the "
                f"other end's — it is not\n"
                f"  your token and not HUB_URL.") from error

    http_error_301 = http_error_303 = http_error_307 = http_error_302
    http_error_308 = http_error_302

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _same_origin(req.full_url, newurl):
            raise HubError(
                f"{quoted(req.full_url)} redirected to {quoted(newurl)}, "
                f"which is a different host.\n"
                f"  Refused, and nothing was sent there: this tool presents the "
                f"hub's token on most\n"
                f"  requests, and following a redirect off the hub would hand "
                f"that token to whoever\n"
                f"  answers at the other end. Check HUB_URL.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _same_origin(url: str, other: str) -> bool:
    """Same scheme, host and port — the three things a credential is scoped to.

    Ports are compared as they were WRITTEN rather than defaulted, which is the
    conservative direction: `https://hub` and `https://hub:443` are the same
    origin in fact and are refused here as different, and the cost of that
    refusal is a message telling somebody to check HUB_URL.

    ANY FAILURE TO PARSE IS A NO, and that is not tidiness either. `.port` RAISES
    on `http://host:notaport`, and a ValueError escaping here used to be caught
    by the one clause on this path that explains a token which cannot go in a
    header — so a malformed `Location` from the other end told somebody to
    rotate the system's secret. Refusing an address that cannot be read is the
    right answer to it anyway.
    """
    try:
        first, second = urllib.parse.urlsplit(url), urllib.parse.urlsplit(other)
        return (first.scheme == second.scheme
                and (first.hostname or "").lower()
                == (second.hostname or "").lower()
                and first.port == second.port)
    except ValueError:
        return False


def _origin(url: str):
    """`urlsplit` of the hub's address, or a sentence about HUB_URL.

    EVERY WAY AN ADDRESS CAN BE UNUSABLE IS ANSWERED HERE, at the one moment a
    person can still act on it, and each of the three below was found by
    handing the real thing to the real client rather than by reading urllib:

      * `http://[hub.example` — `urlsplit` itself raises `ValueError: Invalid
        IPv6 URL`, and it did so from inside `Hub.__init__`, as a traceback;
      * `http://hub:8O80` — `urlsplit` is perfectly happy, and so is
        `urllib.request.Request`. `.port` is the accessor that raises, and
        without this it was raised much later by `http.client`, as
        `InvalidURL: nonnumeric port` — a different exception class from a
        different module, from a line about sending;
      * an address with no host at all, which cannot be requested and would
        otherwise fail somewhere inside the opener;
      * `//hub.example` — a host and no SCHEME. `urlsplit` is content, `.port`
        is content, the host is there, and `urllib.request.Request` is what
        raises: `ValueError: unknown url type`. Checking the host without
        checking the scheme let this one through into the clause about the
        token;
      * `http://хаб.example` — a non-ASCII HOST. It reaches the wire and dies
        there: `http.client` writes the `Host` header as latin-1. An earlier
        version of this file asserted the opposite in a comment — "urllib
        resolves it through IDNA" — and that was simply wrong;
      * `http://127.0.0.1/старт` — a non-ASCII PATH, which fails a step earlier,
        because the request line is encoded as ASCII;
      * `http://<70 a's>.example` — a DNS label over 63 characters. PURE ASCII,
        so no encodability check on the string finds it; the `idna` codec is
        what refuses it, at send time.

    THE LAST THREE ARE WHY THIS ENDS BY ASKING THE STANDARD LIBRARY instead of
    listing more rules. They all raise `UnicodeEncodeError` — a ValueError —
    from three different codecs at three different moments, and all three landed
    in `_call`'s last-resort clause, which says "the address is checked before
    this point, so this is not it — please report it". A typo in an address,
    presented as a bug in the tool.

    Note what is NOT among them, because the comment that used to stand at the
    call site claimed it: `Request` does not refuse `http://host:notaport/x` or
    an address with a space in it. Both are accepted, host and all.
    """
    try:
        split = urllib.parse.urlsplit(url)
        # Touched, not stored: the accessor is the check. Reading `.port` is
        # what turns "8O80" into a refusal, and nothing above it does.
        split.port
    except ValueError as error:
        raise HubError(
            f"{quoted(url)} is not an address this tool can request "
            f"({quoted(error)}).\n"
            f"  Nothing was sent. Check HUB_URL — this is about the address, "
            f"not about the password.") from error
    if split.scheme not in ALLOWED_SCHEMES or not split.hostname:
        raise HubError(
            f"{quoted(url)} is not an address this tool can request: it needs "
            f"a scheme ({' or '.join(ALLOWED_SCHEMES)}) and a host, as in "
            f"https://hub.example.\n"
            f"  Nothing was sent. Check HUB_URL — this is about the address, "
            f"not about the password.")
    _refuse_unrequestable(url, split)
    return split


def _refuse_unrequestable(url: str, split) -> None:
    """Prove the address can be turned into a request, by doing what that does.

    THE THREE ENCODINGS ARE THE STANDARD LIBRARY'S OWN, in the order it applies
    them, and they are performed here rather than described: the request line is
    ASCII, the `Host` header is latin-1, and the host is IDNA. A rule written
    out by hand would have to know that a 70-character label is refused while a
    63-character one is not, which is exactly the kind of thing a copy gets
    wrong — and the ASCII rule alone does not find it, since that address is
    pure ASCII.

    THE HOST IS UNQUOTED FIRST, WHICH IS ALSO THE LIBRARY'S OWN STEP, and
    getting it wrong made this check miss the very case it was written for:
    `urllib.request.Request._parse` ends with `self.host = unquote(self.host)`,
    so `http://%D1%85%D0%B0%D0%B1.example` is pure ASCII as it is written here
    and `хаб.example` by the time the `Host` header is built. Encoding the
    written form proved something about a string nobody sends. THE PATH IS NOT
    unquoted, because that is the same rule read correctly: the selector goes
    out as written, so percent-encoding in a path is legal and must not be
    refused.

    Everything here happens before a socket is opened, so "nothing was sent" is
    a fact about all of it.
    """
    # UNQUOTED FOR THE IDNA CHECK TOO, mirroring the library rather than adding
    # a guard: no test can tell this line from `split.hostname`, and that is a
    # provable property, not an untested one. Unquoting only ever SHORTENS a
    # label (`%XX` becomes one character), so it can never turn a legal length
    # into an illegal one, and any non-ASCII it uncovers is caught one line
    # above by the latin-1 check on the same string. It stays because a mirror
    # with a piece missing stops being a mirror the day the library's order
    # changes.
    host = urllib.parse.unquote(split.hostname)
    checks = (
        (f"{split.path or '/'}?{split.query}", "ascii",
         "a request line is ASCII"),
        (urllib.parse.unquote(split.netloc), "latin-1",
         "the `Host` header is latin-1"),
        (host, "idna",
         "a host is IDNA-encoded, and every dotted label of it has to be "
         "1 to 63 characters"),
    )
    for value, encoding, why in checks:
        try:
            value.encode(encoding)
        except (UnicodeError, ValueError) as error:
            raise HubError(
                f"{quoted(url)} is not an address this tool can request: "
                f"{why}.\n"
                f"  ({quoted(error)})\n"
                f"  Nothing was sent. Check HUB_URL — this is about the "
                f"address, not about the password.") from error


def _refuse_unsendable_token(token) -> None:
    """Refuse a secret that cannot go in a header, saying so and not showing it.

    ASKED HERE RATHER THAN LEFT TO `http.client`, because the exception it
    raises is a bare `ValueError` that arrives on the same line as several
    others — which is how "the token contains a character that cannot be sent"
    came to be said about a malformed ADDRESS. Checking the token explicitly is
    what lets that clause stop guessing: this is the only place that knows the
    answer is the token, and it is the only place that says so.

    THIS IS FOR THE TOKEN THAT DID NOT COME THROUGH `login`. A password typed at
    the prompt is refused there, by `config.check_storable` and
    `config.check_sendable_as_header` together, with wording that suits somebody
    standing at the prompt; the two checks are the same shape on purpose and a
    test compares them. What still arrives unchecked is `EDIT_TOKEN` out of the
    environment or out of a hand-edited file, which is what this covers. The
    advice it gives — run `login` — is right for that reader and wrong for the
    one inside `login`, which is exactly why `login` no longer reaches it.

    THE VALUE IS NEVER ECHOED. What is wrong with it is stated by kind and never
    by showing it. Note the honest width of "control character": a TAB is legal
    in an HTTP header value and the transport would send it — this refuses it
    anyway, because a secret with a tab in it is a paste that went wrong, and
    that is a decision rather than a limit of the wire.
    """
    if not token:
        # No header is sent at all in that case (`_call`), which is what
        # `create` relies on: it reaches the hub for a public route and
        # deliberately never reads the secret.
        return
    problem = header_value_problem(token)
    if problem is None:
        return
    raise HubError(
        f"the stored secret cannot be sent as an HTTP header: {problem}.\n"
        f"  Nothing was sent. Run `hammerola login` to store it again — a "
        f"stray newline from a paste\n"
        f"  is the usual cause. (The value itself is not shown here.)")


def _opener_for(origin):
    """The opener, with redirects held to this hub on every request.

    The proxy handler is the older half and applies to loopback only; the
    redirect handler applies to everything, because the failure it prevents is
    about the credential rather than about the address.

    Takes the PARSED address rather than the string: `urlsplit` is where an
    unreadable one raises, and it has already been called once, in `_origin`.
    """
    handlers = [_SameOriginRedirects()]
    host = origin.hostname or ""
    if host in LOOPBACK_HOSTS or host.startswith("127."):
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)
