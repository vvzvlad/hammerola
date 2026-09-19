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

WHY IT IS A RAW SOCKET. No client in this repository can produce the request:
`hammerola/hub.py` sets Content-Length itself, `urllib.request` never switches
to chunked for a bytes body, and a browser needs a ReadableStream body to send
chunked at all -- which is exactly why an http library cannot be asked to send
one either. httpx picks the framing from the body it is given and will not send
both headers, so the bytes are written out by hand.
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


def _post_both_framings(hub, path):
    """POST `path` declaring Content-Length AND chunked. -> the reply's head.

    The five bytes the length declares are spelled as a valid empty chunked
    body, so that a hub which took either framing at its word would have a
    complete request to work with. That is what makes the answer a verdict on
    the framing rather than on a truncated read: without the refusal every one
    of these routes gets its five bytes and answers 422 about the content.
    """
    host, port = hub.server.server_address[:2]
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(
            f"POST {path} HTTP/1.1\r\n".encode()
            + b"Host: hub\r\n"
            b"Authorization: Bearer " + TOKEN.encode() + b"\r\n"
            b"Content-Type: application/json\r\n"
            b"Content-Length: 5\r\n"
            b"Transfer-Encoding: chunked\r\n"
            b"\r\n"
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

    head = _post_both_framings(hub, ROUTES[route])

    assert head.startswith(b"HTTP/1.1 411 "), (
        f"{route} answered {head.splitlines()[:1]} to a request framed twice; "
        f"411 is what the other routes say and what `_body_length` promises")
    assert b"Connection: close" in head, (
        f"{route} refused the request but offered to keep the connection, so "
        f"the body it did not read becomes the next request on this socket")
