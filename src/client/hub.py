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

THE TOKEN THE LAST TWO CHECK IS NOT THE ONE THE PUSH ROUTES CHECK — not yet.
The hub still has two variables, PUBLISH_TOKEN and COMMENT_READ_TOKEN, and this
client has one secret by decision (SPEC §8 entry 26, and `config.py`), so a
deployment sets both to the same value until step 0 of the plan removes the
second. `UNAUTHORIZED_QUEUE` below is the sentence that says so when it has not
been done, because the bare 401 sends the reader looking at the wrong thing.

A 4xx is returned to the caller rather than raised: 200, 202, 409 and 422 are
all meaningful answers to a push and the caller is the one that knows what to do
with each. Only "the hub could not be reached at all" is an exception.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

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
# ahead of you: MAX_QUEUED_JOBS (16) builds at buildproc's `wall_seconds` (120)
# over MAX_CONCURRENT_BUILDS (2) workers is about sixteen minutes, and this is
# that with a little room. `--timeout` moves it; a person presses Ctrl-C long
# before either.
JOB_TIMEOUT = 1200

TERMINAL_STATES = ("done", "failed")

# Loopback is never reached through a proxy, and a machine whose environment or
# system settings name one would otherwise send the whole push into it. This is
# the shape that breaks `make test` on a laptop behind a corporate proxy — the
# suite's own httpx client sets `trust_env=False` for exactly this — and it is
# equally wrong for a developer running a hub of their own on 127.0.0.1. Every
# other address keeps the machine's proxy configuration, which is what somebody
# publishing from inside a corporate network actually needs.
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1", "[::1]")

# What a 401 from the push routes means. Short, because there is exactly one
# thing to do about it.
UNAUTHORIZED_PUSH = (
    "the hub refused the token (HTTP 401).\n"
    "  Run `hammerola login` to store the right one, or check PUBLISH_TOKEN in "
    "the environment.")

# What a 401 from the COMMENT routes means, which is the same thing plus one
# deployment detail the reader cannot guess: the hub has a second variable for
# this route until step 0 of the plan (AGENTS.md) removes it, so a token that
# pushes fine can still be refused here.
UNAUTHORIZED_QUEUE = (
    "the hub refused the token on the comment queue (HTTP 401).\n"
    "  This client keeps ONE secret for the whole system, but the hub still "
    "checks a\n"
    "  separate COMMENT_READ_TOKEN on this route. Until step 0 of the plan "
    "merges the\n"
    "  two, the deployment has to set both hub variables to the same value.")

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
        self._token = token
        self.timeout = timeout
        self._opener = _opener_for(self.url)

    # -- transport ---------------------------------------------------------
    def _call(self, path: str, *, method: str = "GET", body=None,
              content_type=None):
        """(status, bytes). Raises HubError only when there was no answer."""
        headers = {"Authorization": f"Bearer {self._token}"}
        if content_type is not None:
            headers["Content-Type"] = content_type
        if body is not None:
            headers["Content-Length"] = str(len(body))
        request = urllib.request.Request(
            self.url + path, data=body, method=method, headers=headers)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                return response.status, response.read()
        except ValueError as error:
            # A token that cannot go in a header — a line break in it, most
            # likely, from a paste. `http.client` refuses to send it, which is
            # right; this turns that into the tool's own sentence instead of a
            # traceback.
            #
            # THE EXCEPTION'S OWN TEXT IS NOT REPEATED, and that is the whole
            # care in this clause: `http.client` puts the offending header in
            # its message, and the offending header here is
            # `Bearer <the token>`. Printing it would put the secret in the
            # scrollback of every run that hit this.
            raise HubError(
                f"the request to {self.url} could not be made: the token "
                f"contains a character that cannot be sent in an HTTP header. "
                f"Run `hammerola login` to store it again.") from error
        except urllib.error.HTTPError as error:
            # An HTTP status IS an answer, and every 4xx this endpoint gives
            # carries the sentence explaining it. Raising here would throw that
            # sentence away and report "HTTP Error 422" instead.
            return error.code, error.read()
        except urllib.error.URLError as error:
            raise HubError(f"cannot reach {self.url}: {error.reason}") from error
        except OSError as error:
            raise HubError(f"cannot reach {self.url}: {error}") from error

    @staticmethod
    def _payload(status: int, raw: bytes) -> dict:
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict):
            raise HubError(
                f"the hub answered HTTP {status} with something that is not "
                f"JSON: {raw[:200]!r}")
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
                f"{raw[:200].decode('utf-8', 'replace')}")
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
                f"{raw[:200].decode('utf-8', 'replace')}")
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
        """
        code, raw = self._call(
            f"/project/{urllib.parse.quote(pid)}/{urllib.parse.quote(name)}"
            f"/{urllib.parse.quote(filename)}")
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
            raise HubError(UNAUTHORIZED_PUSH)
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
            raise HubError(UNAUTHORIZED_PUSH)
        if code == 404:
            raise HubError(
                f"the hub has no project {pid}.\n"
                f"  A project exists on the hub from its first successful push; "
                f"until then there is\n"
                f"  nothing there to {verb}.")
        if code != 200:
            raise HubError(
                f"the hub refused to {verb} {pid} with HTTP {code}: "
                f"{self._payload(code, raw).get('error', '')}")
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
            raise HubError(UNAUTHORIZED_QUEUE)
        if code != 200:
            raise HubError(
                f"the hub answered HTTP {code} for the comment queue: "
                f"{self._payload(code, raw).get('error', '')}")
        payload = self._payload(code, raw)
        records = payload.get("comments")
        if not isinstance(records, list):
            raise HubError(f"the hub answered with no comment list: {payload}")
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
            raise HubError(UNAUTHORIZED_QUEUE)
        if code == 404:
            raise HubError(
                f"the hub has no comment {cid}.\n"
                f"  Ids come from `hammerola comments`; a resolved comment "
                f"keeps its id, so this is a wrong id rather than a stale one.")
        if code != 200:
            raise HubError(
                f"the hub refused to resolve {cid} with HTTP {code}: "
                f"{self._payload(code, raw).get('error', '')}")
        return self._payload(code, raw)

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


def _opener_for(url: str):
    host = urllib.parse.urlsplit(url).hostname or ""
    if host in LOOPBACK_HOSTS or host.startswith("127."):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()
