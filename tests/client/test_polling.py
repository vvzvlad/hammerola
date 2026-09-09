"""Waiting for a build across a hub that stops answering for a while.

THE INCIDENT, 2026-08-30. A `hammerola build` died mid-wait:

    queued as job M4emizPYJlKnvtyIlLu3RQ: this build's progress and its log
      building
    hammerola: the hub answered HTTP 404 for job M4emizPYJlKnvtyIlLu3RQ:
      '404 page not found\\n'

That 404 was not the hub. Measured against the live deployment: the hub's own
404 is `application/json`, `{"error": "not found"}`, under `Server: hammerola`;
the one that arrived is `text/plain; charset=utf-8`, nineteen bytes, Go's
`http.NotFound` — TRAEFIK, whose docker provider drops the router for a host
while the container is not running. The container is recreated every time
`:latest` moves, which on this fleet is several times an evening, so the window
is ordinary rather than exotic. The push had already been accepted (202), the
build was very probably still running, and the client threw the wait away and
exited 1.

THE TWO ARE TOLD APART BY THE BODY AND BY NOTHING ELSE. A 404 whose body parses
as the hub's own error shape (`{"error": ...}`, what `_error` emits) is the hub
denying the job — permanent, so it fails fast; a 404 that cannot produce that
shape is not identified as the hub's at all, and gets a BOUNDED tolerance of a
consecutive streak of unanswered polls. That is positive evidence rather than
proxy-sniffing: `Server:` and the content type can be set or stripped by
anything on the path, while the error body is the contract `check_token` already
stands on.

Everything here runs against a real socket with a scripted server, in the style
of `test_transport.py`: what is under test is what the client does with a reply,
and a faked opener would be a test of the fake. The client is stdlib-only, so
nothing here imports anything into `hammerola/`.
"""

import http.server
import json
import threading
import time

import pytest

from hammerola import hub as hub_module
from hammerola.hub import Hub, HubError

# What Traefik answers when no router matches the host: Go's `http.NotFound`,
# byte for byte as it was measured on the deployment.
EDGE_404 = (404, "text/plain; charset=utf-8", b"404 page not found\n")

# ...and what the HUB answers for a job it does not have (`_error` in
# `src/app.py`). Indistinguishable by STATUS — the BODY is what identifies it.
HUB_404 = (404, "application/json", b'{"error": "not found"}')

# The same status and the same content type, and NOT the hub's shape: a JSON
# body that is not a dict with an `error` in it is not this service speaking.
# Here to keep the check on the shape rather than on the header beside it.
DRESSED_UP_404 = (404, "application/json", b'["not found"]')

# ...and the one that is a dict and still not the hub's: Starlette and FastAPI
# answer exactly this by default, so it is what a large share of the API
# gateways in the world put in front of a service. `isinstance(payload, dict)`
# alone reads it as the hub denying the job and kills a live build on it.
GATEWAY_404 = (404, "application/json", b'{"detail": "Not Found"}')

REFUSED = (401, "application/json", b'{"error": "unauthorized"}')

# A sentinel in place of an answer: read the request, then hang up. The bytes
# went out and nothing came back, which is the other shape of the same outage —
# a container that stopped between the connection and the reply.
DROP = "drop the connection"


def _record(state, **extra):
    body = json.dumps({"state": state, "build_url": "/project/d/latest/",
                       **extra}).encode()
    return (200, "application/json", body)


def _serve(answers):
    """A server that answers one scripted reply per GET. -> (url, server, seen).

    The script is a list of `(status, content_type, body)` (or `DROP`); once it
    is exhausted the LAST entry repeats, which is how a permanent outage is
    written as a one-entry script. `seen` is the requests it received, so a test
    can assert that something was NOT retried as well as that it was.
    """
    seen = []
    remaining = list(answers)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.append(self.path)
            answer = remaining.pop(0) if len(remaining) > 1 else remaining[0]
            if answer is DROP:
                # HANG UP WITHOUT CLOSING `wfile`. Closing it here is what
                # `test_transport.py` does, and it makes
                # `BaseHTTPRequestHandler`'s own `flush()` afterwards raise —
                # printing a server traceback on every run of this file. Setting
                # the flag and writing nothing ends the connection just as
                # abruptly from the client's side, which is all the test wants.
                self.close_connection = True
                return
            status, content_type, body = answer
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever,
                              kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_address[1]}", server, seen


@pytest.fixture
def quick(monkeypatch):
    """Both cadences, made small enough that a whole file stays fast.

    The NUMBERS are not what is under test — the behaviour is — and a minute of
    real backoff in a suite would be the same test taking a minute to say the
    same thing.

    THE NOTICE FLOOR IS TAKEN AWAY HERE, deliberately, so that the tests
    counting notices are counting the "once per streak" rule and not the
    throttle sitting on top of it. The throttle has a test of its own below,
    which is the only place it is left switched on.
    """
    monkeypatch.setattr(hub_module, "POLL_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_MAX_SECONDS", 0.05)
    monkeypatch.setattr(hub_module, "POLL_ERROR_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_ERROR_MAX_SECONDS", 0.05)
    monkeypatch.setattr(hub_module, "POLL_NOTICE_MIN_SECONDS", 0)


@pytest.fixture
def scripted():
    """`scripted([...]) -> (hub, seen)`, cleaned up afterwards."""
    servers = []

    def make(answers, token="token"):
        url, server, seen = _serve(answers)
        servers.append(server)
        return Hub(url, token, timeout=10), seen

    try:
        yield make
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


def test_two_edge_404s_in_a_row_are_outlived_and_the_build_still_reports(
        quick, scripted):
    """THE INCIDENT, as a test: the edge answers 404 while the container is
    being recreated, and then the hub comes back and the wait finishes.

    Three requests, because the two refusals are retried and the third answers —
    before this, the first of them ended the command with exit 1 for a build
    that was still running.
    """
    hub, seen = scripted([EDGE_404, EDGE_404, _record("done")])
    notices = []

    record = hub.await_job("M4emizPYJlKnvtyIlLu3RQ", timeout=10,
                           on_notice=notices.append)

    assert record["state"] == "done"
    assert len(seen) == 3, seen
    # EXACTLY TWO, and the number is the assertion: one when the streak opens
    # and one when the hub is back. A notice per FAILED POLL would be three
    # here — and `assert notices` could not tell the two apart, which is how
    # mutating `if opening and on_notice` to `if on_notice` left 345 tests
    # green.
    assert len(notices) == 2, notices
    assert "still waiting" in notices[0]
    assert "answering again" in notices[1]


def test_a_connection_dropped_with_no_answer_is_outlived_the_same_way(
        quick, scripted):
    """The other shape of the same outage, and it arrives as a different
    exception entirely: the request goes out and the container stops before it
    answers, so `_call` raises rather than returning a status. Both have to fold
    into the same streak — a hub that is being replaced does one and then the
    other.
    """
    hub, seen = scripted([DROP, _record("done")])
    notices = []

    record = hub.await_job("job-1", timeout=10, on_notice=notices.append)

    assert record["state"] == "done"
    assert len(seen) == 2, seen
    assert notices


def test_a_401_IN_THE_HUBS_OWN_WORDS_is_final_and_is_never_retried(
        quick, scripted):
    """A refused token is a definite statement about the credential, it cannot
    heal itself, and repeating the request for a whole minute at a hub that is
    working perfectly is worse than saying so at once. Asserted from the
    SERVER's side as well: exactly one request, so there is no version of this
    where it is reported promptly and hammered anyway.
    """
    hub, seen = scripted([REFUSED])

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=10, grace=5)

    assert "HTTP 401" in str(raised.value)
    assert "hammerola login" in str(raised.value)
    assert len(seen) == 1, seen


def test_a_401_THAT_IS_NOT_THE_HUBS_is_transient_like_any_other_stranger(
        quick, scripted):
    """The same rule as the 404, and it looks surprising until the sentence it
    would otherwise print is read out loud.

    `UNAUTHORIZED` tells the author to replace the one secret of the system.
    `Hub.__init__` names that exact harm — "telling somebody to replace the one
    secret of the system over a typo in an address is the specific harm this
    arrangement exists to prevent" — and a captive portal, an auth gateway
    restarting, or an SSO proxy blinking during its own redeploy is not evidence
    about the token.

    It is safe HERE in particular: the push was accepted with this very token
    seconds earlier, so a genuine credential failure arriving mid-wait is very
    nearly impossible. And a 401 that persists still ends the wait — with the
    give-up message, which quotes it.
    """
    portal = (401, "text/html", b"<html>Please sign in to the network</html>")
    hub, seen = scripted([portal, _record("done")])

    record = hub.await_job("job-1", timeout=10, grace=5)

    assert record["state"] == "done"
    assert len(seen) == 2, seen


def test_a_STRANGERS_401_that_never_stops_still_ends_the_wait(quick, scripted):
    """The other half of the decision above: tolerated is not ignored."""
    portal = (401, "text/html", b"<html>Please sign in to the network</html>")
    hub, _seen = scripted([portal])

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=30, grace=0.3)

    message = str(raised.value)
    assert "stopped answering" in message
    assert "hammerola login" not in message, (
        "somebody else's 401 sent the author to replace the system's secret")


def test_a_hub_that_never_comes_back_gives_up_and_says_which_budget_ran_out(
        quick, scripted):
    """An edge that never lets go costs `grace` seconds and then ends with an
    honest message.

    The message has to say the three things the incident's did not: that the HUB
    stopped answering rather than that the build failed, where to look
    afterwards, and that `--timeout` is not the knob — it is the budget for the
    build, not for the hub being unreachable.
    """
    hub, seen = scripted([EDGE_404])
    started = time.monotonic()

    with pytest.raises(HubError) as raised:
        hub.await_job("M4emizPYJlKnvtyIlLu3RQ", timeout=30, grace=0.3)

    elapsed = time.monotonic() - started
    message = str(raised.value)
    assert "M4emizPYJlKnvtyIlLu3RQ" in message
    assert f"{hub.url}/api/v1/jobs/M4emizPYJlKnvtyIlLu3RQ" in message
    assert "--timeout" in message
    assert "THE BUILD DID NOT FAIL" in message, (
        "the message reads as the build having failed, which is the exact "
        "wrong conclusion — the push was accepted and the build may be running")
    assert elapsed < 5, (
        f"gave up after {elapsed:.1f}s, so the grace it honoured is not the "
        f"one it was given")
    assert len(seen) > 1, "it did not retry at all"


def test_the_give_up_message_quotes_the_far_end_ONCE_and_keeps_its_advice(
        quick):
    """The unreachable branch interpolates the error with `str` and not
    `quoted`, and that is the correct call at exactly this one site.

    Every `HubError` `_call` raises has ALREADY put whatever came off the wire
    through `quoted` — the far end's bytes are escaped and trimmed there, once.
    Escaping the whole sentence a second time doubles every `\\x15` into
    `\\\\x15` and then trims THAT at `QUOTE_LIMIT`, and what the cut throws away
    is the only advice in it: "Check HUB_URL: an `http://` address where the hub
    speaks `https://` looks exactly like this". The reader is left with a
    doubly-mangled quotation of a TLS record and nothing to do about it, on the
    commonest typo there is.

    Both halves are asserted, because either one alone licenses the wrong fix:
    the advice has to survive, AND the far end's bytes have to still be escaped
    rather than written to a terminal raw.

    Staged with a socket that answers something that is not HTTP, the same shape
    as `test_transport.py`'s. IT IS A RECORD AND NOT SEVEN BYTES, deliberately:
    a server speaking TLS answers a plaintext request with an alert or a
    handshake flight, i.e. a few hundred bytes of binary before anything that
    looks like a line ending, and `http.client` hands the whole line to
    `BadStatusLine`. Seven bytes escape to little enough that the doubled copy
    still fits under the ceiling — the defect is real either way and only this
    length makes it visible.
    """
    # An alert record's first bytes, then binary. Every byte of the tail is a
    # control character, which is what makes the escaped form four times its
    # own length — and none of them is CR or LF, so it is all one "status line".
    garbage = (b"\x15\x03\x01\x00\x02\x02\x46"
               + bytes((index % 8) + 1 for index in range(240)) + b"\r\n")

    class Handler(http.server.BaseHTTPRequestHandler):
        def handle_one_request(self):
            # Not a status line: what a TLS server answers a plaintext request
            # with. Written straight to the socket, because every helper above
            # this level insists on producing valid HTTP.
            self.rfile.readline()
            self.wfile.write(garbage)
            self.close_connection = True

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever,
                     kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        hub = Hub(f"http://127.0.0.1:{server.server_address[1]}", "token",
                  timeout=10)
        with pytest.raises(HubError) as raised:
            hub.await_job("job-1", timeout=30, grace=0.3)
        message = str(raised.value)
        assert "stopped answering" in message, message
        assert "Check HUB_URL" in message, (
            f"the only advice in the quoted reply was cut off: {message!r}")
        assert "\x15" not in message, (
            "a control byte from the far end reached the terminal raw")
        assert "\\x15" in message, (
            "the far end's bytes were stripped rather than escaped")
        # ONCE, and asserted directly rather than through the trim: escaping
        # twice is what this test is named after, and the trim only reveals it
        # while `QUOTE_LIMIT` stays small enough for the doubled copy to
        # overflow it. Raising that constant would otherwise retire this test
        # in silence.
        assert "\\\\x15" not in message, (
            "the far end's bytes were escaped twice — the message quotes a "
            "repr of a repr, and the trim then eats whichever half comes last")
    finally:
        server.shutdown()
        server.server_close()


def test_the_hubs_OWN_404_is_final_and_costs_exactly_one_request(
        quick, scripted):
    """The other side of the same status, and the reason the body is read.

    A 404 carrying the hub's documented error shape is the HUB denying the job,
    which is permanent — waiting a minute for it to change its mind is a minute
    of a person's time for a fact already known. Asserted from the server's
    side, like the 401: exactly one request.

    This is positive identification and not proxy-sniffing. The client is not
    guessing what sits in front of the hub; it requires the hub's own contract
    to be visible before reading the answer as the hub's — the same contract
    `check_token` stands on, where a 404 to `IMPOSSIBLE_JOB_ID` means "the token
    was accepted and the id was not found".
    """
    hub, seen = scripted([HUB_404])

    with pytest.raises(HubError) as raised:
        hub.await_job("M4emizPYJlKnvtyIlLu3RQ", timeout=30, grace=5)

    message = str(raised.value)
    assert "M4emizPYJlKnvtyIlLu3RQ" in message
    assert "stopped answering" not in message, (
        "the hub answered; it said there is no such job")
    assert len(seen) == 1, seen


@pytest.mark.parametrize("answer, what_it_is", [
    (EDGE_404, "Traefik's plain text, which is what the incident was"),
    ((404, "text/html", b"<html><body>404</body></html>"), "a proxy's HTML"),
    ((404, "application/json", b""), "an empty body under a JSON header"),
    (DRESSED_UP_404, "JSON that is not the hub's error shape"),
    (GATEWAY_404,
     "FastAPI's own 404 body, i.e. half the gateways in the world"),
    ((404, "application/json", b'"not found"'),
     "valid JSON that is not a dict"),
    # ...and the other statuses, which have nothing to do with 404 and are here
    # because they take the same transient branch and nothing else watched it.
    ((503, "application/json", b'{"error": "unavailable"}'),
     "a 5xx IN THE HUB'S OWN SHAPE — still transient, deliberately: unlike a "
     "404, 'unavailable' is a statement about right now"),
    ((502, "text/html", b"<html>Bad Gateway</html>"),
     "Traefik's answer when the router exists and the backend does not — at "
     "least as likely in a recreate window as the incident's 404"),
    ((200, "application/json", b"not json"), "a 200 whose body does not parse"),
])
def test_an_answer_that_is_not_IDENTIFIABLY_A_VERDICT_is_treated_as_an_outage(
        quick, scripted, answer, what_it_is):
    """THE HEADER DECIDES NOTHING — the shape of the body does.

    The JSON-typed 404s matter most. A content type saying JSON is not evidence
    that the hub wrote the body, and `{"detail": "Not Found"}` is what Starlette
    and FastAPI answer by default — so a check that accepted any dict, or that
    read the header, would call a gateway's page the hub's verdict and end the
    wait on a build that is still running. That is the incident again with one
    more layer of dressing.
    """
    hub, seen = scripted([answer, _record("done")])

    record = hub.await_job("job-1", timeout=10, grace=5)

    assert record["state"] == "done", what_it_is
    assert len(seen) == 2, seen


def test_the_wait_does_not_overshoot_the_window_by_a_whole_backoff_step(
        monkeypatch, scripted):
    """The sleep is clamped against the STREAK's edge, not only the deadline.

    A 10 s step inside a 60 s window can only end after it, so the attempt that
    would have landed at 59 s never happens and the window is short by up to one
    step — at the moment it matters most, since that attempt is the one where
    the hub has come back. Staged with a cadence far longer than the window,
    which is where an unclamped sleep is visible at all.
    """
    monkeypatch.setattr(hub_module, "POLL_ERROR_FIRST_SECONDS", 5.0)
    monkeypatch.setattr(hub_module, "POLL_ERROR_MAX_SECONDS", 5.0)
    hub, seen = scripted([EDGE_404])
    started = time.monotonic()

    with pytest.raises(HubError):
        hub.await_job("job-1", timeout=30, grace=0.2)

    elapsed = time.monotonic() - started
    assert elapsed < 2, f"{elapsed:.1f}s for a 0.2s window — the sleep overshot"
    assert len(seen) == 2, seen


def test_grace_zero_is_no_tolerance_at_all(quick, scripted):
    """The escape hatch, and what this did before: one bad poll, one refusal.

    No notice either — announcing that the wait continues and then refusing to
    continue it would be two sentences contradicting each other.
    """
    hub, seen = scripted([EDGE_404])
    notices = []

    with pytest.raises(HubError):
        hub.await_job("job-1", timeout=30, grace=0, on_notice=notices.append)

    assert len(seen) == 1, seen
    assert notices == []


def test_a_terminal_failed_record_comes_back_normally_with_no_notice(
        quick, scripted):
    """A build that FAILED is an answer and not an outage. It must not be
    retried, must not print a word about the connection, and must come back as
    the record — the CLI is what turns it into an exit code, after printing the
    log.
    """
    hub, seen = scripted(
        [_record("failed", code=422, error="the gate refused")])
    notices = []
    states = []

    record = hub.await_job("job-1", timeout=10, on_state=states.append,
                           on_notice=notices.append)

    assert record["state"] == "failed"
    assert record["error"] == "the gate refused"
    assert len(seen) == 1, seen
    assert notices == []
    assert states == ["failed"]


def test_a_streak_that_heals_does_not_count_towards_the_next_one(
        quick, scripted):
    """THE REASON THE BUDGET IS A STREAK AND NOT A TOTAL. An update and the
    rollback that follows it are two outages, and a long build straddles both —
    on a fleet where main is merged several times an evening that is the normal
    case rather than the unlucky one.

    THE REAL PROPERTY UNDER TEST, stated plainly because the first version of
    this docstring argued something vacuous ("a total budget of 0.3 s could not
    survive two gaps" — it could, the whole sequence fits inside 0.3 s): the
    streak clock is RESET, not merely paused, by a good poll. The second failure
    is timed from itself and not from the first, and the notices come in pairs
    because each streak is a separate one.
    """
    hub, seen = scripted([EDGE_404, _record("building"),
                          EDGE_404, _record("done")])
    notices = []

    record = hub.await_job("job-1", timeout=10, grace=0.3,
                           on_notice=notices.append)

    assert record["state"] == "done"
    assert len(seen) == 4, seen
    # Two openings and two recoveries: the notice is once per streak, never once
    # per failed poll.
    assert len(notices) == 4, notices


# A body that is valid JSON and blows the parser's stack: `json.loads` recurses
# per nesting level, so this raises `RecursionError` — neither a `ValueError`
# nor a `UnicodeDecodeError`. 400 kB, against a 64 MiB reply ceiling, and the
# far end chooses it.
NESTED = b"[" * 200000 + b"]" * 200000


@pytest.mark.parametrize("status", [404, 200])
def test_a_body_that_blows_the_JSON_parsers_stack_is_an_outage_not_a_traceback(
        quick, scripted, status):
    """Both readers of a body are on this path and both had the same hole.

    Under a 404 it reaches `_carries_the_hubs_error_shape`, whose docstring
    promises "False for anything unparseable rather than raising"; under a 200
    it reaches `_payload`. Neither caught `RecursionError`, so it escaped
    `cli.main` — which catches five exception classes and not that one — as a
    traceback, on input the far end wrote.
    """
    hub, seen = scripted([(status, "application/json", NESTED),
                          _record("done")])

    record = hub.await_job("job-1", timeout=10, grace=5)

    assert record["state"] == "done"
    assert len(seen) == 2, seen


# -- the two budgets, which are not one --------------------------------------
def test_the_DEADLINE_running_out_is_not_reported_as_the_hub_going_away(
        quick, scripted):
    """A failed poll past the deadline is a TIMEOUT, and must say so.

    An opening failure has `now - streak_began == 0`, so a single condition over
    both budgets gave every failed poll at or after the deadline the streak's
    message — including its "a longer --timeout does not help with this one", at
    the exact moment a longer --timeout is precisely what would have helped.

    The state has to be named as what was last SEEN, with the failed poll
    admitted: reporting `'building'` without saying the last look failed hands
    the reader a fact that may be minutes old as if it were current.
    """
    hub, _seen = scripted([_record("building"), EDGE_404])

    with pytest.raises(HubError) as raised:
        # A deadline shorter than the grace, so the deadline is what expires.
        # 0.6 s AND NOT 0.15: the first round-trip to a server that has just
        # been started has to fit inside it, and CI runs this in a container on
        # a shared runner. `quick` patches the normal cadence down so the second
        # poll still arrives at once.
        hub.await_job("job-1", timeout=0.6, grace=30)

    message = str(raised.value)
    assert "still 'building'" in message, message
    assert "The last poll failed as well" in message, message
    assert "pass a longer --timeout" in message
    assert "does not help" not in message, (
        "the deadline's message denies the knob that is exactly the fix for it")


def test_a_deadline_reached_with_no_poll_EVER_answering_says_that(
        quick, scripted):
    """The same branch with nothing observed at all. It must not invent a state
    and must not claim the hub went away either — the build's own budget is what
    ran out."""
    hub, _seen = scripted([EDGE_404])

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=0.6, grace=30)

    message = str(raised.value)
    assert "never seen in any state" in message, message
    assert "pass a longer --timeout" in message


def test_the_grace_window_is_WALL_CLOCK_and_not_a_count_of_returned_polls(
        quick, monkeypatch):
    """A poll that is accepted and then answered by nobody must not eat the
    window whole.

    The streak is measured only when a poll RETURNS, and the Hub's own timeout
    is `HTTP_TIMEOUT` (300 s) — sized for pushing an archive up a domestic
    uplink. A poll inheriting that turns a promised minute of tolerance into ten
    the moment a socket is accepted and goes silent: a dropped VPN, a wifi
    handover, a black hole on the path. `QUERY_TIMEOUT` is the constant that
    already exists for this, and it is passed per request so the PUSH keeps its
    own budget.

    Staged with a server that accepts and never answers, which is the only way
    to observe a socket timeout at all.
    """
    release = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            release.wait(timeout=10)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever,
                              kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    monkeypatch.setattr(hub_module, "QUERY_TIMEOUT", 0.2)
    # The HUB's timeout stays long — that is the push's, and this is what a real
    # `hammerola build` holds while it waits.
    hub = Hub(f"http://127.0.0.1:{server.server_address[1]}", "token",
              timeout=30)
    started = time.monotonic()
    try:
        with pytest.raises(HubError) as raised:
            hub.await_job("job-1", timeout=30, grace=0.3)
        elapsed = time.monotonic() - started
        assert "stopped answering" in str(raised.value)
        assert elapsed < 5, (
            f"{elapsed:.1f}s for a 0.3s window — the poll is waiting on the "
            f"PUSH's budget, so the window is only as short as the far end "
            f"chooses to make it")
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def test_a_throttled_notice_is_DEFERRED_and_not_lost(monkeypatch, scripted):
    """THE TRACE THAT MADE THE FLOOR A DEFECT OF ITS OWN.

    An outage, a recovery inside the floor, then an outage that never ends. An
    opening happens ONCE and never repeats, so a throttle that `return`s instead
    of postponing loses it for good — and what the reader saw was:

        <the first outage>
        the hub is answering again; still waiting
        <silence>
        GAVE UP -> the hub stopped answering ...

    The outage that actually killed the command was never announced, and the
    last thing the terminal said about the connection was that the hub is
    answering: the opposite of the truth. Before the floor existed, a real
    outage always got its line.

    The fix bounds the RATE without losing the LATEST transition — the
    undelivered line waits in `pending`, is overwritten when a newer transition
    supersedes it, and goes out on the first iteration past the floor.
    """
    monkeypatch.setattr(hub_module, "POLL_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_MAX_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_ERROR_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_ERROR_MAX_SECONDS", 0.01)
    # Long enough that the recovery cannot get out on its own schedule, short
    # enough that the file stays fast. The 30 s of production is the same shape.
    monkeypatch.setattr(hub_module, "POLL_NOTICE_MIN_SECONDS", 0.25)

    # outage, recovery inside the floor, then dead for good.
    hub, _seen = scripted([EDGE_404, _record("building"), EDGE_404])
    notices = []

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=30, grace=1.5, on_notice=notices.append)

    assert "stopped answering" in str(raised.value)
    assert len(notices) >= 2, notices
    assert "still waiting, the build may be running" in notices[-1], (
        f"the last thing said about the connection was {notices[-1]!r}, and "
        f"then the command gave up — the fatal outage was never announced")


def test_a_deferred_line_is_the_LATEST_transition_and_not_a_healed_outage(
        monkeypatch, scripted):
    """`pending` IS ONE SLOT, OVERWRITTEN — the mirror of the defect above.

    Two docstrings say so ("ONE SLOT, OVERWRITTEN rather than queued", "is
    overwritten when a newer transition supersedes it") and nothing checked it:
    writing the recovery line only `if pending is None` kept the whole suite
    green. What that mutant produces is the test above run backwards — an
    outage's line waits in the slot, the hub comes back, the recovery cannot
    displace it, and the line that finally goes out says "the hub is not
    answering" while the hub is answering and the build is running to
    completion. A backlog of superseded lines is the same fault in the other
    direction: what a reader needs is the state of the connection NOW.

    Staged as outage, recovery, outage, and then a long healthy stretch, all
    inside one floor: only the LAST of those transitions may reach the reader.
    """
    for name in ("POLL_FIRST_SECONDS", "POLL_MAX_SECONDS",
                 "POLL_ERROR_FIRST_SECONDS", "POLL_ERROR_MAX_SECONDS"):
        monkeypatch.setattr(hub_module, name, 0.01)
    # Long enough that every transition below happens inside it, short enough
    # that the healthy stretch afterwards still outlives it and flushes.
    monkeypatch.setattr(hub_module, "POLL_NOTICE_MIN_SECONDS", 0.4)

    hub, _seen = scripted([EDGE_404, _record("building"), EDGE_404]
                          + [_record("building")] * 60 + [_record("done")])
    notices = []

    record = hub.await_job("job-1", timeout=30, grace=5,
                           on_notice=notices.append)

    assert record["state"] == "done"
    assert "answering again" in notices[-1], (
        f"the last thing said about the connection was {notices[-1]!r}, while "
        f"the hub was answering and the build finished — a superseded line was "
        f"kept instead of being overwritten")


class _Reply:
    """The least a response has to be for `_read_capped` to accept it."""

    def __init__(self, body):
        self.status = 200
        self.length = len(body)
        self._body = body

    def read(self, count):
        return self._body[:count]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_the_POLL_gets_the_short_budget_and_the_PUSH_keeps_the_long_one(
        monkeypatch):
    """THE REGRESSION WITH THE WIDEST BLAST RADIUS IN THIS BRANCH, and nothing
    watched it: making the per-request override the DEFAULT
    (`budget = QUERY_TIMEOUT if timeout is None else timeout`) silently cuts
    every push from 300 s to 30 s, and the whole client suite passes — a push of
    a real archive up a domestic uplink then dies part-way with `cannot reach`.

    Asserted where the number actually lands, on the opener, which is below the
    computation and above the socket. No server: a fake opener is the only thing
    that can see the effective budget at all.
    """
    class Opener:
        def __init__(self):
            self.budgets = []

        def open(self, request, timeout=None):
            self.budgets.append(timeout)
            return _Reply(b'{"state": "done"}')

    hub = Hub("http://hub.example", "token", timeout=300)
    opener = Opener()
    monkeypatch.setattr(hub, "_opener", opener)

    hub.publish("demo0001", b"an archive")
    hub.await_job("job-1", timeout=10)

    assert opener.budgets == [300, hub_module.QUERY_TIMEOUT], opener.budgets


def test_notices_are_floored_so_a_FLAPPING_endpoint_cannot_fill_the_terminal(
        monkeypatch, scripted):
    """"Once per streak" is not a ceiling on its own.

    An endpoint that alternates failure and success opens and closes a streak
    forever, so the notices are unbounded in wall-clock terms — measured at 1.7
    lines a second, which buries the states the command is actually reporting.
    The floor is what makes it a ceiling; the first notice still always gets
    out, because that one is the whole reason notices exist.

    THE ONE TEST HERE THAT LEAVES THE FLOOR SWITCHED ON — every other one runs
    under `quick`, which takes it away so that per-streak counting is what is
    being counted.
    """
    for name in ("POLL_FIRST_SECONDS", "POLL_MAX_SECONDS",
                 "POLL_ERROR_FIRST_SECONDS", "POLL_ERROR_MAX_SECONDS"):
        monkeypatch.setattr(hub_module, name, 0.005)
    monkeypatch.setattr(hub_module, "POLL_NOTICE_MIN_SECONDS", 5.0)

    transitions = 20
    script = [EDGE_404, _record("building")] * transitions + [_record("done")]
    hub, seen = scripted(script)
    notices = []

    record = hub.await_job("job-1", timeout=10, grace=5,
                           on_notice=notices.append)

    assert record["state"] == "done"
    assert len(seen) == len(script), seen
    # Without the floor this is one line per transition in each direction — 40.
    assert len(notices) <= 2, (
        f"{len(notices)} notices for {transitions} outages: the floor is not "
        f"holding")
    assert notices, "and the first one still has to get out"


def test_the_default_grace_is_read_when_the_call_does_not_name_one(
        quick, monkeypatch, scripted):
    """`grace` is resolved in the BODY and not bound in the signature.

    A default binds at `def`, so `POLL_GRACE_SECONDS` was unreachable to
    anything that lowered it — including this test, which is the only way to
    observe that the constant is what an unnamed `grace` means.
    """
    monkeypatch.setattr(hub_module, "POLL_GRACE_SECONDS", 0.2)
    hub, _seen = scripted([EDGE_404])
    started = time.monotonic()

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=30)

    assert "stopped answering" in str(raised.value)
    assert time.monotonic() - started < 5, "the signature's default won"


# -- the two cadences, as a table and as behaviour ---------------------------
# (wait, error_wait, streaking, new_streak) -> (sleep, wait, error_wait), with
# the real constants: POLL_FIRST 0.25, POLL_MAX 2.0, BACKOFF 1.5,
# POLL_ERROR_FIRST 1.0, POLL_ERROR_MAX 10.0.
CADENCE = [
    # A healthy wait climbing its own backoff, error side untouched.
    ((0.25, 7.0, False, False), (0.25, 0.375, 7.0), "the ordinary poll"),
    ((1.5, 7.0, False, False), (1.5, 2.0, 7.0), "...and its ceiling"),
    ((2.0, 7.0, False, False), (2.0, 2.0, 7.0), "which holds"),
    # A streak OPENING: the error cadence restarts, the normal one is frozen
    # exactly where the last good poll left it.
    ((1.5, 7.0, True, True), (1.0, 1.5, 1.5), "a new outage retries fast"),
    # ...and continuing.
    ((1.5, 1.5, True, False), (1.5, 1.5, 2.25), "the same outage backs off"),
    ((1.5, 9.0, True, False), (9.0, 1.5, 10.0), "up to its own ceiling"),
    # RECOVERY: the normal cadence picks up where it stopped, NOT at
    # POLL_FIRST_SECONDS. This row is the defect the previous round removed.
    ((1.5, 10.0, False, False), (1.5, 2.0, 10.0),
     "healing resumes, not resets"),
]


@pytest.mark.parametrize("args, expected, what", CADENCE,
                         ids=[row[2] for row in CADENCE])
def test_the_sleep_decision_is_a_table_and_not_a_stopwatch(args, expected,
                                                          what):
    """`_next_sleep` is pure so that these can be asserted exactly.

    Both properties it carries are about what SURVIVES an iteration, which a
    wall-clock test witnesses badly: the normal cadence is never restarted by a
    recovery (it belongs to the wait, not to the current stretch of it), and the
    error cadence IS restarted on each new streak (it belongs to the outage).
    """
    got = hub_module._next_sleep(*args)
    assert [round(value, 6) for value in got] == list(expected), what


def test_the_LOOP_carries_the_normal_cadence_across_a_recovery(
        monkeypatch, scripted):
    """The table above proves the function; this proves the CALLER uses it that
    way — the mutant lives in `await_job`, not in `_next_sleep`.

    Putting `wait = POLL_FIRST_SECONDS` back into the recovery branch passed all
    28 tests in this file and all 355 in `tests/client/`. Rather than time it,
    the arguments the loop hands the decision are recorded: after a recovery the
    `wait` it passes must be the GROWN value, and `new_streak` must be true on
    each opening and false everywhere else.
    """
    calls = []
    real = hub_module._next_sleep

    def recording(wait, error_wait, streaking, new_streak):
        calls.append((round(wait, 6), streaking, new_streak))
        return real(wait, error_wait, streaking, new_streak)

    monkeypatch.setattr(hub_module, "_next_sleep", recording)
    monkeypatch.setattr(hub_module, "POLL_FIRST_SECONDS", 0.01)
    monkeypatch.setattr(hub_module, "POLL_MAX_SECONDS", 10.0)
    monkeypatch.setattr(hub_module, "POLL_ERROR_FIRST_SECONDS", 0.001)
    monkeypatch.setattr(hub_module, "POLL_ERROR_MAX_SECONDS", 0.001)
    monkeypatch.setattr(hub_module, "POLL_NOTICE_MIN_SECONDS", 0)

    # healthy, healthy, OUTAGE, healthy, OUTAGE, healthy, done
    hub, _seen = scripted([
        _record("queued"), _record("building"), EDGE_404, _record("building"),
        EDGE_404, _record("building"), _record("done")])

    hub.await_job("job-1", timeout=30, grace=5)

    waits = [wait for wait, _streaking, _new in calls]
    assert waits == sorted(waits), (
        f"the normal cadence went backwards: {waits} — a recovery reset it")
    assert waits[0] == 0.01 and waits[-1] > 0.01, waits
    # The normal cadence only ever grows on a HEALTHY poll, so it is frozen
    # across each outage rather than merely un-reset.
    assert [new for _w, _s, new in calls] == [
        False, False, True, False, True, False], calls
    assert [streaking for _w, streaking, _n in calls] == [
        False, False, True, False, True, False], calls


# -- the two budgets, in the same instant ------------------------------------
class _Clock:
    """The clock `hub` reads, moved by this test instead of by the machine.

    `monotonic()` reads it and `sleep(n)` advances it by `n`, so every reading
    `await_job` sees is one chosen here. On top of that it charges what a ROUND
    TRIP appears to cost, which is the only other thing that moves a real clock
    inside that loop: `first` once, and `later` on every sleep — which in this
    loop is always followed immediately by another poll.

    The one-shot is placed where it is because of WHERE the loop reads the
    clock. Its first read is `deadline = monotonic() + timeout`, the last thing
    that happens before the first request goes out, so the cost of that request
    is charged just after it and is visible to every read from the failed
    poll's onwards.

    Substituted for the module's `time` and for nothing else: the socket, the
    server and the suite keep the real one.
    """

    def __init__(self, start, first, later):
        self.now = start
        self._first = first
        self._later = later

    def monotonic(self):
        reading = self.now
        if self._first is not None:
            self.now += self._first
            self._first = None
        return reading

    def sleep(self, seconds):
        self.now += seconds + self._later


# (the first round trip, every later one) — what a poll APPEARS to cost. The
# first row is the cold-start shape that broke the wall-clock version of this
# test; the other two are the shapes it happened to survive. The verdict below
# is the same in all three, which is the whole point of driving the clock.
ROUND_TRIPS = [
    (5.0, 0.25, "a slow first poll and fast ones after"),
    (0.25, 0.25, "polls that all cost the same"),
    (0.05, 0.5, "a fast first poll and slow ones after"),
]


@pytest.mark.parametrize("first, later, shape", ROUND_TRIPS,
                         ids=[row[2] for row in ROUND_TRIPS])
def test_when_BOTH_budgets_expire_at_once_the_streak_is_what_is_reported(
        quick, scripted, monkeypatch, first, later, shape):
    """The order of the two checks is declared load-bearing and nothing tested
    it — swapping the blocks passed everything, because no test had both expire
    together. The streak is the specific diagnosis and must win; the deadline is
    the one that comes true eventually anyway.

    HOW THE INSTANT IS CONSTRUCTED. The deadline lands `timeout` after the read
    that opens the wait; the streak opens when the FIRST poll fails, which is
    one round trip after that same read. So `timeout = first + grace` puts the
    two edges on the same number exactly — for any round trip, at any scale —
    and `_Clock` is what makes `first` a number this test chose rather than one
    the machine happened to produce.

    WHY A REAL CLOCK CANNOT CONSTRUCT IT, and why the fake is not decoration to
    be simplified away. The old version wrote the instant as `timeout == grace`,
    which is a knife edge and not an equality: it puts the deadline at `timeout`
    and the streak's edge at `t1 + grace`, one whole round trip later, so the
    sleep is clamped to the deadline and the deciding poll lands at
    `timeout + rt2`. The streak is therefore reported only when `rt2 >= t1` —
    true merely because the first request of a run is usually the slow one
    (imports, the first socket), and false on a cold run, where the deadline
    branch legitimately wins and the assertion fails. Bigger numbers do not
    remove it: the margin stays `rt2 - rt1` whatever the scale.

    Everything else is real — `await_job`, the socket, the scripted 404 — so
    what is under test is still the decision inside the loop.
    """
    grace = 0.5
    monkeypatch.setattr(hub_module, "time", _Clock(1000.0, first, later))
    hub, _seen = scripted([EDGE_404])

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=first + grace, grace=grace)

    message = str(raised.value)
    assert "stopped answering" in message, f"{shape}: {message}"
    assert "pass a longer --timeout" not in message, (
        f"{shape}: the deadline's message won, so a reader with an unreachable "
        f"hub is sent to raise a budget that is not the one that ran out")


def test_a_200_WITHOUT_a_state_is_not_reported_as_never_having_answered(
        quick, scripted):
    """`record.get("state")` is None for a reply with no `state` field, and None
    used to be the same value as "no poll has ever succeeded".

    So a hub answering 200 with something shaped almost right produced "was
    never seen in any state — no poll of it ever succeeded" about a wait whose
    every poll succeeded — a false sentence in the one message the reader is
    using to work out what happened.

    AND THE STATE CALLBACK STAYS SILENT, which is the other half of the same
    reply and a decision rather than a side effect. `seen` starts at `_NEVER`,
    so `state != seen` is true for a 200 that names nothing, and `on_state(None)`
    fired: the push transcript grew a line reading `  None` as though the hub
    had reported a build state called None. The value is still RECORDED — the
    message above is the reason — and only the callback is skipped.
    """
    hub, _seen = scripted([(200, "application/json", b'{"job": "job-1"}')])
    states = []

    with pytest.raises(HubError) as raised:
        hub.await_job("job-1", timeout=0.4, grace=30, on_state=states.append)

    message = str(raised.value)
    assert "no poll of it ever succeeded" not in message, message
    assert "was still None" in message, message
    assert states == [], (
        f"the transcript got {states} as build states — a 200 with no `state` "
        f"field printed itself as one")


def test_the_one_shot_read_is_left_alone_and_still_raises(scripted):
    """`Hub.job()` is the honest reading of ONE request and must keep raising on
    the first non-200 — the tolerance is a property of waiting, not of asking.

    BE ACCURATE ABOUT WHO CALLS IT, because this paragraph has been wrong twice.
    It said `check_token` did, which is false — that uses the same ROUTE but
    goes to `_call` directly. It then said the method had no caller outside the
    tests, which was true only between `await_job` moving to `_poll_job` and
    issue #79: `sources._dev_log` calls it now, once, to put "(build, state
    done)" in the header of `hammerola log dev`. That call is why `job()` grew a
    401 branch of its own. What this test holds is the one-shot semantics it is
    kept FOR — the first non-200 raises, with none of the polling tolerance —
    and not the emptiness of a caller list that has stopped being empty.
    """
    hub, seen = scripted([EDGE_404])

    with pytest.raises(HubError) as raised:
        hub.job("job-1")

    assert "HTTP 404" in str(raised.value)
    assert len(seen) == 1
