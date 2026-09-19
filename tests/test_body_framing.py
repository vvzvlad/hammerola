"""One request, two ways of saying how long its body is. Every route says 411.

`_body_length` in `src/app.py` opens the preamble that all five body-taking
routes share, and its docstring states the rule as a fact about the SERVICE
rather than about one handler: "A CHUNKED BODY IS REFUSED HERE LIKE A MISSING
LENGTH IS, on all five routes." That sentence is the specification this file
exists to hold -- `docs/conventions.md` is explicit that an assertion about how
the code behaves belongs in a test rather than in a comment.

IT IS NOT THE SAME CASE `test_a_body_of_unknown_length_is_411` COVERS. That one
sends chunked and NO Content-Length, which the length parse already refused on
its own -- `int("")` raises, and it raised before the preamble existed too. The
case here is a request carrying BOTH headers, where there is a length to parse
and the old code parsed it: two of the five routes read the body by that length
and went on. So this file is what makes removing the `Transfer-Encoding` line
from the preamble a red run instead of a silent return to that.

WHY IT IS A RAW SOCKET, and it is not that httpx cannot send one. It can: an
explicit `Transfer-Encoding: chunked` beside a bytes body survives
`Request._prepare`, which fills Content-Length in with `setdefault` rather than
instead of it, and h11 passes the pair through -- measured on httpx 0.28.1, the
version `requirements-dev.txt` pins. That is a property of one pinned version's
header merging, though, and not of the request under test: written by hand, what
this file sends is what this file says it sends, and a pin bump cannot quietly
turn it into a different request that still passes. No client in this repository
produces it on its own -- `hammerola/hub.py` sets Content-Length itself,
`urllib.request` never switches a bytes body to chunked, and a browser needs a
ReadableStream body to send chunked at all.
"""

import socket

import pytest

from harness import TOKEN, good_build

PID = "proj1"
COMMIT = "abc123"

# The five routes of the preamble, by the name their handler goes by. `resolve`
# is the one that enters the preamble conditionally -- its body is optional, so
# a request with no framing at all is a resolve with no note -- and it is here
# because the framing it does carry is still framing this service cannot read.
ROUTES = {
    "publish": f"/api/v1/publish/{PID}/{COMMIT}",
    "title": f"/api/v1/projects/{PID}/title",
    "comment": f"/api/v1/comments/{PID}/{COMMIT}",
    "resolve": "/api/v1/comments/4RpMfPBRAxHCEJDyIhnUZg/resolve",
    "proposal": f"/api/v1/proposals/{PID}",
}


def _post(hub, path, framing):
    """POST `path` framed by `framing`. -> the reply's head.

    The body is always the same five bytes, and they are a valid EMPTY chunked
    body which is also exactly the length any Content-Length here declares. So
    a hub that took either framing at its word has a complete request either
    way, and what comes back is a verdict on the framing rather than on a
    truncated read: with the refusals gone, each of these routes gets its five
    bytes and answers 422 about the content.
    """
    host, port = hub.server.server_address[:2]
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(
            f"POST {path} HTTP/1.1\r\n".encode()
            + b"Host: hub\r\n"
            b"Authorization: Bearer " + TOKEN.encode() + b"\r\n"
            b"Content-Type: application/json\r\n"
            + framing
            + b"\r\n"
            b"0\r\n\r\n")
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = sock.recv(4096)
            if not chunk:
                break
            head += chunk
    return head


@pytest.mark.parametrize("route", sorted(ROUTES))
def test_both_framing_headers_are_411_on_every_route_that_takes_a_body(
        hub, route):
    """Neither framing is accepted when a request declares both.

    A request that frames itself twice is a request about which of the two the
    server believes, and the answer is neither: nothing here decodes chunked,
    and the ceilings are applied to Content-Length, so believing the length
    would mean reading a body whose real end this service cannot find.

    THE CONNECTION IS CLOSED WITH THE REFUSAL, and that is the half that
    matters beyond the status code: the request's unread remains would
    otherwise sit on a keep-alive socket and be parsed as the next request.
    """
    # The comment route is the one that looks the build up before it takes a
    # body, so there has to be a build. The other four answer before touching
    # the volume, but they are sent against the same published project rather
    # than a made-up one, so a failure here is never about a missing project.
    assert hub.publish(PID, COMMIT, good_build()).status_code == 201

    head = _post(hub, ROUTES[route],
                 b"Content-Length: 5\r\nTransfer-Encoding: chunked\r\n")

    assert head.startswith(b"HTTP/1.1 411 "), (
        f"{route} answered {head.splitlines()[:1]} to a request framed twice; "
        f"411 is what the other routes say and what `_body_length` promises")
    assert b"Connection: close" in head, (
        f"{route} refused the request but offered to keep the connection, so "
        f"the body it did not read becomes the next request on this socket")


def test_a_chunked_resolve_with_no_length_is_411_rather_than_a_silent_note(hub):
    """`resolve` reaches the refusal through a gate of its own, so test the gate.

    It is the one route whose body is OPTIONAL: a resolve with no framing at
    all is a resolve with no note, which `test_resolve_without_a_note_is_fine`
    pins, so the shared preamble is entered only when the headers say a body is
    coming. That gate asks two things -- is there a positive Content-Length, or
    is there a Transfer-Encoding -- and the test above exercises only the first,
    because its request carries a length as well.

    WITHOUT THE SECOND HALF THE REFUSAL DOES NOT HAPPEN AT ALL: a chunked body
    with no Content-Length fails the length half, so the gate is not entered
    and the route answers about the resolve -- a note-less one for a caller who
    sent a note -- without reading the body. Measured with that half removed,
    the hub then logs `code 400, message Bad request syntax ('0')` on the same
    connection: the body it declined to read became the next request on the
    socket, which is the whole reason these refusals close it.
    """
    head = _post(hub, ROUTES["resolve"], b"Transfer-Encoding: chunked\r\n")

    assert head.startswith(b"HTTP/1.1 411 "), (
        f"resolve answered {head.splitlines()[:1]} to a chunked body with no "
        f"length; it must not accept a note it cannot read to the end")
