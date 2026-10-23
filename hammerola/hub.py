"""Talking to the hub: one POST, then a job polled to its end.

`urllib.request`, not httpx: the client is stdlib-only so it runs under any
python3 and self-updates as one file. httpx stays a dev dependency for the
tests; the note in `requirements.txt` is about outbound calls from `src/`.

THE PROTOCOL, as `src/app.py` and `src/jobs.py` define it. "Token" below is
`X-Hammerola-Token: <EDIT_TOKEN>`, the hub's own header. The hub never reads
`Authorization`: that header is left to a password proxy in front of it, and
this client puts `Basic <HUB_BASIC_AUTH>` there on every request, public ones
included, when that setting is present.

A missing or wrong token is answered 403, never 401: a browser that gets a 401
drops the credentials it holds for the proxy. So a 401 on any route is the
proxy refusing its login (`PROXY_REFUSED`) and a 403 is the hub refusing its
token (`UNAUTHORIZED`).

    POST /api/v1/publish/<pid>            Token, body = tar.gz. The HUB names
                                          the revision, out of the sources in
                                          the body. `X-Hammerola-Message`, when
                                          the push carries one, is what this
                                          revision says about itself —
                                          percent-encoded UTF-8.
      202 {"job", "status_url", "log_url", "revision"} + Location -> queued
      200 {"url", "revision"}                          -> this exact push is
                                                          already published, and
                                                          nothing was rebuilt
      422 / 403 / 503 {"error"}                        -> refused, here is why
    POST /api/v1/publish/<pid>/dev        the same, into the local slot, whose
                                          name is the constant `dev` and which
                                          therefore has no `revision` to report

    GET  /api/v1/jobs/<id>                Token -> the record, `state` in
                                          queued|building|done|failed
    GET  /api/v1/jobs/<id>/log            Token -> text/plain, what the build
                                          printed

A 202 carries two identifiers: `job` is this build attempt (progress, log),
`revision` is the permanent immutable name of what it publishes. The same
sources pushed twice get two jobs and one revision. Never print one where the
other is meant.

The routes the read-only commands use (`status` and `comments` read what the
browser fetches):

    GET  /project/<pid>/builds.json       Token. `{pid, project, title,
                                          has_dev, latest, builds[],
                                          files_keys}`, and 404 for a project
                                          that has never published anything.
                                          `files_keys` is added by the hub as
                                          it answers: the key that opens each
                                          build's files in a link.
    GET  /project/<pid>/<name>/meta.json  PUBLIC. One build's own record;
                                          `<name>` is `dev`, `latest` or a
                                          revision.
    GET  /project/<pid>/<name>/<file>     Any file the build ships. PUBLIC for
                                          the `.json` and `.png` ones —
                                          metrics.json and the pictures;
                                          Token for the rest — the STL, STEP
                                          and 3MF a part's `files` names in
                                          meta.json, and the overview meshes.
    GET  /api/v1/comments?project=<pid>   Token -> `{"comments": [...]}`
    POST /api/v1/comments/<id>/resolve    Token, `{"note": ...}` -> the record
    GET  /api/v1/proposals/<pid>          Token -> `{"pid", "doc", "text",
                                          "published", "view", "saved"}` — the
                                          one proposal a project has, and 404
                                          when nobody has drawn one over it

The one route asked for with NO token, because it is read before login:

    GET  /start                           `{"empty", "skill", "client",
                                          "template", "skill_version"}` — three
                                          relative paths, the version of the
                                          skill this hub ships, and whether it
                                          has anything on it. `create` follows
                                          the `template` one; `skill` follows
                                          the other two.

The code of a revision, and the two routes that unmake something:

    GET    /api/v1/sources/<revision>     Token -> the pushed body, byte for
                                          byte, as an opaque attachment
    GET    /api/v1/sources/<revision>/log Token -> what that build printed
    POST   /api/v1/projects/<pid>/title   Token, `{"title": ...}` -> renames
    DELETE /api/v1/projects/<pid>         Token -> removes the project whole
    DELETE /api/v1/proposals/<pid>        Token -> `{"removed": true|false}`,
                                          and 200 either way: the document is
                                          gone, and the boolean is the only
                                          thing that says whether there was one

A build's files open to a link that carries their key, and its code to
nothing but the secret, which is why `source` and `artifacts` are two verbs.
Every guarded route checks the one secret, `EDIT_TOKEN`.

A 4xx is returned to the caller rather than raised: 200, 202, 409 and 422 are
all meaningful answers to a push and the caller is the one that knows what to do
with each. Only "the hub could not be reached at all" is an exception.
"""

import base64
import http.client
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from hammerola.config import header_value_problem

# One request: generous because a push carries the whole archive up a domestic
# uplink. The wait for a build is a separate budget (`await_job`).
HTTP_TIMEOUT = 300

# For requests that upload nothing (status, comments, login check, polls), so
# a black-holed address does not hang the terminal for five minutes.
QUERY_TIMEOUT = 30

# Job polling: fast at first so a quick result returns at once, then backing
# off, since a real build takes minutes.
POLL_FIRST_SECONDS = 0.25
POLL_MAX_SECONDS = 2.0
POLL_BACKOFF = 1.5

# How long a CONSECUTIVE streak of unanswered polls is tolerated. Sized for a
# container recreation when `:latest` moves: for a few seconds Traefik has no
# router and answers its own `404 page not found`. One answered poll resets the
# streak, so several separate recreations during a long build are survivable.
POLL_GRACE_SECONDS = 60

# The cadence while a streak is open. Sleeps are 1.0, 1.5, 2.25, 3.38, 5.06,
# 7.59, 10, 10, 10, 10 s (`POLL_BACKOFF`, capped): eleven attempts in a minute,
# without a burst of connections as the hub comes back.
POLL_ERROR_FIRST_SECONDS = 1.0
POLL_ERROR_MAX_SECONDS = 10.0

# Minimum interval between two connection notices, so a flapping endpoint
# (which opens and closes streaks endlessly) cannot flood the terminal. The
# first notice of a wait is always emitted.
POLL_NOTICE_MIN_SECONDS = 30

# How long `await_job` waits by default. The worst honest wait is a full queue:
# MAX_QUEUED_JOBS (16) builds at buildproc's `wall_seconds` (300) over
# MAX_CONCURRENT_BUILDS (4) workers is twenty minutes; this is that with room to
# spare. `--timeout` moves it.
#
# A COPY: the stdlib-only client cannot import `src.buildproc`. When
# `wall_seconds` moves, update this (`tests/test_build_ceilings.py` checks that
# it clears the worst wait); a stale value shows up as a client timeout on a
# build that is still legitimately queued.
JOB_TIMEOUT = 2700

# When a build is slow enough to warn about. A judgement, not a copy of a hub
# number (hence not in `limits.py`); `tests/test_build_ceilings.py` keeps it
# strictly under the hub's wall clock. Printed by the client rather than the
# build because the hub keeps only the head of a log (`buildproc.runner._Drain`)
# and a warning at the end of a long log would be dropped.
SLOW_BUILD_SECONDS = 180

TERMINAL_STATES = ("done", "failed")

# Loopback bypasses the machine's proxy settings; every other address keeps
# them, as publishing from inside a corporate network needs.
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")

# Checked when a Hub is made: `//hub.example` parses into a host with no scheme
# and would otherwise fail later as a bare ValueError.
ALLOWED_SCHEMES = ("http", "https")

# What a 403 means on any guarded route: the hub refused its one secret, so one
# remedy.
UNAUTHORIZED = (
    "the hub refused the token (HTTP 403).\n"
    "  Run `hammerola login` to store the right one, or check EDIT_TOKEN in "
    "the environment.")

# What a 401 means on any route. The hub never answers 401, so the request
# stopped at a password proxy in front of it and the hub was never asked.
PROXY_REFUSED = (
    "the password proxy in front of the hub refused its login and password "
    "(HTTP 401),\n"
    "  so the hub itself was never asked. `hammerola login` stores the proxy's "
    "login and\n"
    "  password; or check HUB_BASIC_AUTH in the environment.")

# The manifest of what a first run needs, fetched without a token. Copied, not
# imported from `src.onboarding` (the client takes nothing from the service);
# `tests/test_onboarding.py` compares the two. Other onboarding paths are read
# out of the manifest.
START_PATH = "/start"

# An id no job can have but with the alphabet and length of
# `secrets.token_urlsafe(16)`, so it passes the shape check and misses the
# lookup. `check_token`: 404 means the token was accepted, 403 that it was not.
IMPOSSIBLE_JOB_ID = "0" * 22

# The revision message travels as a header, outside the archive whose digest
# names the revision: the same tree with two messages is one revision. Read by
# `src/app.py`.
MESSAGE_HEADER = "X-Hammerola-Message"

# The header the token travels in, read by `src/app.py`. Its own rather than
# `Authorization`, which a password proxy in front of the hub wants for itself.
TOKEN_HEADER = "X-Hammerola-Token"


class HubError(Exception):
    """The hub could not be reached, or answered something unusable.

    `status` is set only by `compare`, `job`, `job_log` and the refusals
    (`_refuse_unauthorized`, `PROXY_REFUSED`); `sources._dev_log` reads it to
    tell a missing job from other failures. None means "not recorded here",
    never "the hub did not answer".
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


# "No poll has ever succeeded", distinct from a reply with no `state` (None).
_NEVER = object()


class Hub:
    """One hub, one token. Nothing here logs or prints the token, nor the
    proxy's `login:password`."""

    def __init__(self, url: str, token: str, timeout: int = HTTP_TIMEOUT,
                 basic_auth: str = ""):
        self.url = url.rstrip("/")
        # Both inputs are checked before any request, separately, because the
        # advice differs: "check HUB_URL" vs "run `hammerola login`". A typo in
        # the address must never send somebody to replace the secret.
        self._origin = _origin(self.url)
        _refuse_unsendable_token(token)
        self._token = token
        # `HUB_BASIC_AUTH`, as a password proxy in front of the hub reads it:
        # base64 of the UTF-8 `login:password`, which is ASCII whatever the
        # value holds. Empty means no proxy and no `Authorization` header.
        self._proxy_authorization = ""
        if basic_auth:
            encoded = base64.b64encode(basic_auth.encode("utf-8"))
            self._proxy_authorization = f"Basic {encoded.decode('ascii')}"
        self.timeout = timeout
        self._opener = _opener_for(self._origin)

    # -- transport ---------------------------------------------------------
    def _call(self, path: str, *, method: str = "GET", body=None,
              content_type=None, timeout=None, message=None):
        """(status, bytes). Raises HubError only when there was no answer.

        `message` (the revision message) is percent-encoded: header values are
        latin-1 and messages are often Russian. The hub unquotes it.

        `timeout` overrides the Hub's for one request; the poll in `await_job`
        uses it so a silent socket does not stretch the grace window to the
        push's 300 s.

        No token header without a token: `create` builds a Hub with none for
        the public `/start` route. The proxy's `Authorization` goes on every
        request, public ones included, since the proxy stands in front of all
        of them.
        """
        headers = {}
        if self._token:
            headers[TOKEN_HEADER] = self._token
        if self._proxy_authorization:
            headers["Authorization"] = self._proxy_authorization
        if content_type is not None:
            headers["Content-Type"] = content_type
        if body is not None:
            headers["Content-Length"] = str(len(body))
        if message:
            headers[MESSAGE_HEADER] = urllib.parse.quote(message, safe="")
        try:
            request = urllib.request.Request(
                self.url + path, data=body, method=method, headers=headers)
            # `_exchange` reads error bodies too, so a failure while reading one
            # reaches the handlers below.
            return self._exchange(request, timeout)
        except ValueError as error:
            # Last resort, deliberately neutral: the address and the secret are
            # checked earlier (`_origin`, `_refuse_unsendable_token`), so this is
            # something unanticipated, e.g. an unparseable `Location` from a
            # proxy. The exception text is NOT printed: `http.client` puts the
            # offending header in it, which could be the token.
            raise HubError(
                f"the request to {self.url} could not be built "
                f"({type(error).__name__}), and was not sent.\n"
                f"  The address, the stored secret and any path the hub named "
                f"are all checked before\n"
                f"  this point, so this is none of them — please report it.")\
                from error
        except http.client.InvalidURL as error:
            # Only `InvalidURL`, which is raised while the request line is
            # assembled, so "nothing was sent" is true. Its parent
            # `HTTPException` also covers `RemoteDisconnected`, which fires after
            # the request has gone. The text may carry far-end input (a
            # `Location` header), so it goes through `quoted`.
            raise HubError(
                f"{self.url} would not take this request: "
                f"{quoted(error)}\n"
                f"  Nothing was sent.") from error
        except urllib.error.URLError as error:
            raise HubError(f"cannot reach {self.url}: {error.reason}") from error
        except OSError as error:
            raise HubError(f"cannot reach {self.url}: {error}") from error
        except http.client.IncompleteRead as error:
            # The far end spoke HTTP and stopped mid-body (short
            # `Content-Length` or truncated chunked stream): a proxy, a restart
            # or a timeout, not a wrong scheme.
            raise HubError(
                f"{self.url} stopped sending part-way through its reply "
                f"({quoted(error)}).\n"
                f"  Nothing was kept. The connection ended mid-body — a proxy, "
                f"a restart or a timeout\n"
                f"  at the other end. Try again.") from error
        except http.client.HTTPException as error:
            # BadStatusLine, LineTooLong, UnknownProtocol: not a working HTTP
            # conversation, usually `http://` where the hub speaks `https://`, or
            # a captive portal. Must stay BELOW `OSError`: `RemoteDisconnected`
            # is both an HTTPException and a `ConnectionResetError` and belongs
            # in "cannot reach". `quoted` matters here: `BadStatusLine` can carry
            # up to 64 KiB of far-end text.
            raise HubError(
                f"{self.url} answered something that is not HTTP "
                f"({type(error).__name__}: {quoted(error)}).\n"
                f"  Check HUB_URL: an `http://` address where the hub speaks "
                f"`https://` looks exactly\n"
                f"  like this, and so does a captive portal or a proxy "
                f"answering in its place.") from error

    def _exchange(self, request, timeout=None):
        """Send it, and read the body — of a 2xx and of an error alike.

        Both reads sit inside `_call`'s single `try`, so a failure while
        reading an error body gets the same diagnosis as any other (an exception
        raised inside an `except` clause would skip its sibling handlers).

        An HTTP status is an answer: the code and the body are returned so the
        hub's explanation of a 4xx is not lost.

        `read()` with no argument raises `IncompleteRead` on a short body;
        `read(n)` would not.
        """
        budget = self.timeout if timeout is None else timeout
        try:
            with self._opener.open(request, timeout=budget) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read()
            finally:
                error.close()

    @staticmethod
    def _payload(status: int, raw: bytes) -> dict:
        """The reply as a dict, or a sentence about what it was instead."""
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
    def publish(self, pid: str, body: bytes, *, slot: str = None,
                force: bool = False, message: str = None):
        """POST one archive. -> (status, payload dict).

        `slot` is the last path segment: `dev` for the local slot, nothing for
        a revision, which asks the hub to name it.

        `force` skips the model's own checks() and travels as a query parameter:
        it changes how the build runs, not where it lands.

        `message` travels as a header and is not part of the revision's digest:
        the same tree with a different message is the same revision, and
        pushing it again updates the stored message.
        """
        path = f"/api/v1/publish/{urllib.parse.quote(pid)}"
        if slot is not None:
            path = f"{path}/{urllib.parse.quote(slot)}"
        if force:
            path = f"{path}?force=1"
        status, raw = self._call(path, method="POST", body=body,
                                 content_type="application/gzip",
                                 message=message)
        if status in (401, 403):
            # The caller answers these two with PROXY_REFUSED and UNAUTHORIZED,
            # and a password proxy's refusal is not JSON, so the body is not
            # parsed.
            return status, {}
        return status, self._payload(status, raw)

    def compare(self, pid: str, old: str, new: str) -> dict:
        """Ask the hub to measure two revisions against each other. -> payload.

        The answer is a job (the CAD kernel takes minutes); the report is that
        job's log. Both ids are already resolved by `revdiff.run`, so only
        permanent revision ids go on the wire, never a slot.
        """
        path = (f"/api/v1/compare/{urllib.parse.quote(pid)}"
                f"/{urllib.parse.quote(old)}/{urllib.parse.quote(new)}")
        status, raw = self._call(path, method="POST")
        _refuse_unauthorized(status)
        if status != 202:
            raise HubError(
                f"the hub answered HTTP {status} when asked to compare {old} "
                f"with {new}: {quoted(raw)}", status)
        return self._payload(status, raw)

    # Both name a refusal explicitly: `hammerola log dev` calls them after a
    # public read, so a stale token first shows up here. Both set `status` on every
    # raise that had an answer.
    def job(self, job_id: str) -> dict:
        status, raw = self._call(f"/api/v1/jobs/{urllib.parse.quote(job_id)}")
        _refuse_unauthorized(status)
        if status != 200:
            raise HubError(
                f"the hub answered HTTP {status} for job {job_id}: "
                f"{quoted(raw)}", status)
        return self._payload(status, raw)

    def job_log(self, job_id: str) -> str:
        status, raw = self._call(
            f"/api/v1/jobs/{urllib.parse.quote(job_id)}/log")
        _refuse_unauthorized(status)
        if status != 200:
            raise HubError(f"the hub answered HTTP {status} for the log of "
                           f"job {job_id}", status)
        return raw.decode("utf-8", "replace")

    def _poll_job(self, job_id: str):
        """One poll, for `await_job` only. -> (record, trouble).

        Unlike the one-shot `job()`, an unusable reply here is "trouble" that
        the caller may tolerate: the far end may be briefly gone (e.g. Traefik's
        own `404 page not found` while the container is recreated).

        Only a 403 or 404 in the hub's own error shape (`{"error": ...}`, from
        `_error` in `src/app.py`) is final: the record is gone, or the token is
        refused. Any other refusal, a 401 included (never the hub's), is
        transient: the push was accepted through the same doors seconds
        earlier; if it persists, the grace window ends the wait. Headers
        (`Server:`, content type) are not evidence of who wrote a body.

        Only `HubError` (no answer at all) becomes trouble; anything else is a
        bug and must not be swallowed by the retry loop.
        """
        # `QUERY_TIMEOUT`, not the push's 300 s: see `_call`.
        try:
            status, raw = self._call(
                f"/api/v1/jobs/{urllib.parse.quote(job_id)}",
                timeout=QUERY_TIMEOUT)
        except HubError as error:
            # `str`, not `quoted`: `_call` already quoted any far-end text.
            return None, f"the hub could not be reached ({error})"
        mine = status in (403, 404) and _carries_the_hubs_error_shape(raw)
        if status == 403 and mine:
            raise HubError(UNAUTHORIZED)
        if status == 404 and mine:
            raise HubError(
                f"the hub itself denies job {job_id} (HTTP 404, in its own "
                f"words), so nothing is polling any more.\n"
                f"  THE RECORD IS GONE, WHICH IS NOT THE BUILD FAILING: a push "
                f"that was accepted may\n"
                f"  still have published. Look at {self.url} for the project, "
                f"and at `hammerola status`\n"
                f"  for what it has.")
        if status != 200:
            return None, (f"the hub answered HTTP {status} for job {job_id}: "
                          f"{quoted(raw)}")
        try:
            return self._payload(status, raw), None
        except HubError as error:
            # `str`, not `quoted`: the message already quotes the body.
            return None, str(error)

    def await_job(self, job_id: str, timeout: float = JOB_TIMEOUT,
                  on_state=None, on_notice=None, grace=None) -> dict:
        """Poll until the job is `done` or `failed`. Raises HubError on timeout.

        `on_state` is called once per NEW state, so a run prints "building" when
        the build starts and not once a second for as long as it lasts.

        `on_notice` is called for the CONNECTION rather than the build: when a
        streak of unanswered polls opens and when the hub answers again, at most
        once per `POLL_NOTICE_MIN_SECONDS`.

        `grace` is how long a CONSECUTIVE streak of unanswered polls is
        tolerated; a good poll resets it. `grace=0` is no tolerance; None means
        `POLL_GRACE_SECONDS`, resolved in the body so tests can lower the
        constant. The streak clock starts when the first failed poll returns, so
        a black-holed path costs up to about `grace + 2 x QUERY_TIMEOUT`.

        `timeout` (the build's budget) and `grace` (the hub's unreachability)
        have separate messages: only the deadline one names `--timeout` as the
        remedy. The streak is checked first.

        Only the read is retried, never the push: a repeated POST could start a
        second build.
        """
        if grace is None:
            grace = POLL_GRACE_SECONDS
        deadline = time.monotonic() + timeout
        # Two cadences; `_next_sleep` decides which grows.
        wait = POLL_FIRST_SECONDS
        error_wait = POLL_ERROR_FIRST_SECONDS
        seen = _NEVER
        # When the current streak of unanswered polls began. None means the hub
        # is answering.
        streak_began = None
        last_notice = None
        # The connection notice not yet delivered. One slot, overwritten: only
        # the current state matters.
        pending = None

        def notice(text) -> bool:
            """Emit one line if the floor has passed. -> whether it went out.

            The caller keeps an undelivered line in `pending` and offers it
            again on every iteration, so the floor rate-limits rather than drops:
            the current connection state is always eventually announced. The
            first line of a wait always goes out.
            """
            nonlocal last_notice
            if on_notice is None:
                return True
            now = time.monotonic()
            if (last_notice is not None
                    and now - last_notice < POLL_NOTICE_MIN_SECONDS):
                return False
            last_notice = now
            on_notice(text)
            return True

        while True:
            new_streak = False
            finished = None
            record, trouble = self._poll_job(job_id)
            if record is not None:
                if streak_began is not None:
                    streak_began = None
                    pending = "the hub is answering again; still waiting"
                state = record.get("state")
                if state != seen:
                    seen = state
                    # A 200 with no state is recorded (for `_timed_out`) but
                    # not printed.
                    if on_state is not None and state is not None:
                        on_state(state)
                if state in TERMINAL_STATES:
                    finished = record
                elif time.monotonic() >= deadline:
                    raise self._timed_out(job_id, state, timeout)
            else:
                now = time.monotonic()
                new_streak = streak_began is None
                if new_streak:
                    streak_began = now
                # The streak first, then the deadline: the streak message says
                # `--timeout` does not help, so it must not fire for a deadline.
                if now - streak_began >= grace:
                    raise HubError(
                        f"the hub stopped answering while job {job_id} was "
                        f"being waited for.\n"
                        f"  Last reply: {trouble}.\n"
                        f"  THE BUILD DID NOT FAIL — the push was accepted "
                        f"before this, and the build may\n"
                        f"  still be running on the hub. Check "
                        f"{self.url}/api/v1/jobs/{job_id} when it is back. "
                        f"A longer\n"
                        f"  --timeout does not help with this one: that is the "
                        f"budget for the BUILD, and\n"
                        f"  what ran out is the tolerance for the hub being "
                        f"unreachable.")
                if now >= deadline:
                    raise self._timed_out(job_id, seen, timeout, trouble)
                # After the give-up checks, so `grace=0` does not announce a
                # wait it then refuses.
                if new_streak:
                    pending = (f"{trouble}; still waiting, the build may be "
                               f"running")
            # Before the terminal return, so "answering again" is printed even
            # when the next poll is `done`. The give-up branches skip it: their
            # messages carry what they need.
            if pending is not None and notice(pending):
                pending = None
            if finished is not None:
                return finished
            # Clamped to both the deadline and the end of the grace window, so
            # the last attempt inside the window is not skipped.
            left = deadline - time.monotonic()
            if streak_began is not None:
                left = min(left, streak_began + grace - time.monotonic())
            sleep_for, wait, error_wait = _next_sleep(
                wait, error_wait, streak_began is not None, new_streak)
            time.sleep(min(sleep_for, max(0.0, left)))

    def _timed_out(self, job_id: str, state, timeout: float,
                   trouble=None) -> HubError:
        """The BUILD's budget ran out — the ordinary deadline, either branch.

        Raised for a job still `queued`/`building` at the deadline, and for a
        failed poll at the deadline whose streak has not expired; the latter
        passes `trouble` so the reader knows the reported state may be stale.
        `state` is `_NEVER` when no poll ever succeeded (None is a real reply:
        a 200 with no `state` field). Names `--timeout` as the remedy, unlike
        the streak message.
        """
        if state is _NEVER:
            was = ("was never seen in any state — no poll of it ever "
                   "succeeded")
        else:
            was = f"was still {state!r}"
        extra = ""
        if trouble is not None:
            extra = f"\n  The last poll failed as well: {trouble}."
            if state is not _NEVER:
                extra += (" The state above is from an earlier one\n"
                          "  and may be out of date.")
        return HubError(
            f"job {job_id} {was} after {timeout:.0f}s.{extra}\n"
            f"  The build is not cancelled by giving up here — the hub kills "
            f"it on its own ceiling.\n"
            f"  Check {self.url}/api/v1/jobs/{job_id} later, or pass a longer "
            f"--timeout.")

    # -- what the hub already knows about a project ------------------------
    def builds(self, pid: str):
        """`builds.json`, or None when the hub has nothing under this id.

        None because "never pushed" is an answer to `hammerola status`, not a
        failure. The same file the project page fetches, so `status` shows what
        the site shows.
        """
        return self._json_or_none(
            f"/project/{urllib.parse.quote(pid)}/builds.json")

    def build_meta(self, pid: str, name: str):
        """One build's `meta.json` — `dev`, `latest` or a revision, or None.

        Needed for the local slot: `builds.json` says only whether it is
        occupied (`has_dev`), so its timestamp exists only in its own meta.
        """
        return self._json_or_none(
            f"/project/{urllib.parse.quote(pid)}/{urllib.parse.quote(name)}"
            f"/meta.json")

    def _json_or_none(self, path: str):
        status, raw = self._call(path)
        if status == 404:
            return None
        _refuse_unauthorized(status)
        if status != 200:
            raise HubError(
                f"the hub answered HTTP {status} for {path}: "
                f"{quoted(raw)}")
        return self._payload(status, raw)

    def build_file(self, pid: str, name: str, filename: str):
        """One file out of a published build, or None when it is not there.

        The same URL the viewer fetches. The JSON and PNG files are public; the
        STEP, STL and 3MF are behind the token, which `_call` sends with every
        request. None for a 404, because "this revision ships no such file"
        (e.g. an old build without metrics.json) is an answer callers act on.
        """
        code, raw = self._call(
            f"/project/{urllib.parse.quote(pid)}/{urllib.parse.quote(name)}"
            f"/{urllib.parse.quote(filename)}")
        if code == 404:
            return None
        _refuse_unauthorized(code)
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

        The hub deliberately answers the same 404 for a revision never
        published, one whose build failed, removed code and a malformed id, so
        the message names all of them.
        """
        _refuse_unauthorized(code)
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
        project: a not-yet-pushed project is renamed in `project.json` and the
        first push carries the title.
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
        _refuse_unauthorized(code)
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

        Filtered on the hub, not after the fact.
        """
        query = {"project": pid}
        if status is not None:
            query["status"] = status
        if since is not None:
            query["since"] = since
        code, raw = self._call(
            f"/api/v1/comments?{urllib.parse.urlencode(query)}")
        _refuse_unauthorized(code)
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

        The note is always sent, `{"note": null}` meaning none, so the POST
        always has a body.
        """
        body = json.dumps({"note": note}).encode("utf-8")
        code, raw = self._call(
            f"/api/v1/comments/{urllib.parse.quote(cid)}/resolve",
            method="POST", body=body, content_type="application/json")
        _refuse_unauthorized(code)
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

    def comment(self, cid: str) -> dict:
        """One comment by its id, whole. -> the record.

        For `comments files`, which has an id but no project and needs to know
        which attachments exist before fetching them.
        """
        code, raw = self._call(f"/api/v1/comments/{urllib.parse.quote(cid)}")
        _refuse_unauthorized(code)
        if code == 404:
            raise HubError(
                f"the hub has no comment {cid}.\n"
                f"  Ids come from `hammerola comments`; a resolved comment "
                f"keeps its id, so this is a wrong id rather than a stale one.")
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for comment {cid}: "
                f"{quoted(self._payload(code, raw).get('error', ''))}")
        return self._payload(code, raw)

    def comment_attachment(self, cid: str, kind: str) -> bytes:
        """The bytes of one attachment — the photo, or the viewer's frame.

        Not via `fetch_path`, which is for paths the hub named; this one is
        built locally and quoted like every other route.
        """
        code, raw = self._call(
            f"/api/v1/comments/{urllib.parse.quote(cid)}/{kind}")
        _refuse_unauthorized(code)
        if code == 404:
            # The caller asks only after the record named the attachment, so a
            # 404 means the record and the volume disagree.
            raise HubError(
                f"comment {cid} names a {kind} the hub does not serve.\n"
                f"  The record is there and the file is not: the bytes are "
                f"gone from the hub's volume.")
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for the {kind} of {cid}: "
                f"{quoted(raw)}")
        return raw

    # -- the stored proposal -----------------------------------------------
    def proposal(self, pid: str):
        """The one proposal this project has, or None when it has none.

        None for a 404: most projects have no proposal, and "there is none" is
        an answer, not a failure. A refusal still raises: nothing was learned.
        """
        code, raw = self._call(f"/api/v1/proposals/{urllib.parse.quote(pid)}")
        _refuse_unauthorized(code)
        if code == 404:
            return None
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for the proposal of {pid}: "
                f"{quoted(self._payload(code, raw).get('error', ''))}")
        return self._payload(code, raw)

    def remove_proposal(self, pid: str) -> bool:
        """Put this project's proposal away. -> whether there was one.

        The hub answers 200 either way (`_handle_delete` in `src/app.py`); the
        boolean says whether anything was stored. A 404 only means an invalid
        id and falls through to the generic refusal.
        """
        code, raw = self._call(
            f"/api/v1/proposals/{urllib.parse.quote(pid)}", method="DELETE")
        _refuse_unauthorized(code)
        if code != 200:
            raise HubError(
                f"the hub refused to remove the proposal of {pid} with HTTP "
                f"{code}: {quoted(self._payload(code, raw).get('error', ''))}")
        return bool(self._payload(code, raw).get("removed"))

    # -- getting started ---------------------------------------------------
    def start(self) -> dict:
        """`GET /start` — the manifest of what a first run needs. NO TOKEN.

        `create`, `skill` and `update` work against a hub the machine is not
        logged in to. The reply is `{"empty", "skill", "client", "template",
        "skill_version", "client_version"}`: three relative paths, two versions
        and one boolean about the hub (see `src/onboarding.py`).
        """
        code, raw = self._call(START_PATH)
        if code == 401:
            # A public route, so only the proxy's refusal can stop it.
            raise HubError(PROXY_REFUSED, code)
        if code != 200:
            # Names the route, not one reader: several verbs read it.
            raise HubError(
                f"the hub answered HTTP {code} for {START_PATH}, the manifest "
                f"naming the skill, the client and the template.\n"
                f"  A hub older than this tool has no such route. `create`, "
                f"`skill`, `skill update` and `update` read it; of those only "
                f"`hammerola create --no-template` works without it.")
        return self._payload(code, raw)

    def fetch_path(self, path: str) -> bytes:
        """One file the manifest NAMED, by its path on this hub.

        The path is untrusted and the only one not built locally through
        `quote`, so it is checked here: a leading slash (it is concatenated onto
        the base address), ASCII only and no control characters (the request
        line is ASCII; a CR/LF would inject a header).
        """
        if not path.startswith("/"):
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

        Asks the jobs route for an impossible id: it needs the token and
        changes nothing. 403 is "wrong secret", 404 "right secret, no such job".
        Any other status counts as accepted: it is not evidence of a mistyped
        password.

        A 401 never reached the hub: a password proxy in front of it refused its
        login, so it is raised as `PROXY_REFUSED` rather than answered as a
        wrong token.
        """
        status, _raw = self._call(f"/api/v1/jobs/{IMPOSSIBLE_JOB_ID}")
        if status == 401:
            raise HubError(PROXY_REFUSED, status)
        return status != 403

    def behind_a_password_proxy(self) -> bool:
        """Does a password proxy in front of the hub refuse this Hub's request?

        Asks `/start`, which the hub answers to anybody, so a 401 there was
        written by something in front of it. `login` asks it with no
        credentials at all, to learn whether to ask for the proxy's.
        """
        status, _raw = self._call(START_PATH)
        return status == 401

    def absolute(self, url: str) -> str:
        """A `build_url` from the hub (`/project/<pid>/<name>/`) made clickable."""
        if not url:
            return ""
        if url.startswith(("http://", "https://")):
            return url
        return f"{self.url}{url}"


# How much far-end text goes into a message: enough to recognise a TLS alert,
# a captive portal or a proxy's complaint.
QUOTE_LIMIT = 200


def quoted(text, limit: int = QUOTE_LIMIT) -> str:
    """Something the other end wrote, made safe to print. Trimmed, then escaped.

    Nothing that came off the wire is printed raw. The exception is the build
    log (`job_log`, `revision_log`), which the CLI prints in full and
    unescaped: it is what the person asked to see.

    The source is cut before it is escaped (and bytes before they are
    decoded, with `errors="replace"`), so a whole reply body is never copied.
    The reported length is the source's, in bytes for bytes and characters for
    text.
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


def _next_sleep(wait: float, error_wait: float, streaking: bool,
                new_streak: bool):
    """How long to sleep before the next poll. -> (sleep, wait, error_wait).

    Pure, so its two invariants can be tested from a table:

      * the NORMAL cadence is never restarted by a recovery: it belongs to the
        whole wait, so a flapping endpoint does not poll four times a second;
      * the ERROR cadence restarts on each new streak: a fresh outage gets a
        fast first retry, since most are over in seconds.
    """
    if new_streak:
        error_wait = POLL_ERROR_FIRST_SECONDS
    if streaking:
        return (error_wait, wait,
                min(error_wait * POLL_BACKOFF, POLL_ERROR_MAX_SECONDS))
    return (wait, min(wait * POLL_BACKOFF, POLL_MAX_SECONDS), error_wait)


def _carries_the_hubs_error_shape(raw: bytes) -> bool:
    """Did the HUB write this error, or did something in front of it?

    Positive evidence only: a JSON dict with an `error` key is what `_error` in
    `src/app.py` emits for every refusal. Anything else (Traefik's `404 page not
    found`, a proxy's HTML, an empty or unparseable body, Starlette's default
    `{"detail": ...}`) is not the hub's. Headers are not consulted: anything on
    the path can rewrite them.
    """
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    return isinstance(payload, dict) and "error" in payload


def _refuse_unauthorized(status: int) -> None:
    """Raise for the two refusals a guarded route can meet; otherwise return.

    401 is a password proxy in front of the hub refusing its login, since the
    hub never answers 401; 403 is the hub refusing its token. The body is not
    read: a proxy's refusal is not JSON.
    """
    if status == 401:
        raise HubError(PROXY_REFUSED, status)
    if status == 403:
        raise HubError(UNAUTHORIZED, status)


def _origin(url: str):
    """`urlsplit` of the hub's address, or a sentence about HUB_URL.

    Every way an address can be unusable is caught here, before any request:

      * `http://[hub.example` — `urlsplit` raises `Invalid IPv6 URL`;
      * `http://hub:8O80` — only the `.port` accessor raises;
      * no host, or no scheme (`//hub.example`);
      * `http://хаб.example` — non-ASCII host; the `Host` header is latin-1;
      * `http://127.0.0.1/старт` — non-ASCII path; the request line is ASCII;
      * `http://<70 a's>.example` — a DNS label over 63 characters, refused
        by the `idna` codec.

    The last three are checked by performing the encodings
    (`_refuse_unrequestable`) rather than by listing rules.
    """
    try:
        split = urllib.parse.urlsplit(url)
        # Touched, not stored: reading `.port` is what refuses "8O80".
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

    The standard library's three encodings, in its order: the request line is
    ASCII, the `Host` header latin-1, the host IDNA (labels of 1-63
    characters).

    The host is unquoted first, as `urllib.request.Request._parse` does, so
    `http://%D1%85%D0%B0%D0%B1.example` is checked as `хаб.example`. The path is
    not unquoted: the selector goes out as written.

    Nothing here opens a socket.
    """
    # Unquoted for the IDNA check too, mirroring the library.
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

    Checked explicitly so a bad token is never confused with a bad address
    (`http.client` raises a bare ValueError for both). Covers `EDIT_TOKEN` from
    the environment or a hand-edited file; `login` checks a typed password
    itself with the same predicate (`config.header_value_problem`). The value
    is never echoed.
    """
    if not token:
        # No header is sent then (`_call`); `create` relies on it.
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
    """The opener, with the machine's proxy bypassed for loopback only.

    Takes the address already parsed by `_origin`.
    """
    handlers = []
    host = origin.hostname or ""
    if host in LOOPBACK_HOSTS or host.startswith("127."):
        handlers.append(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener(*handlers)
