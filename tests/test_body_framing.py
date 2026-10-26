"""One request, two ways of saying how long its body is. Every route says 411.

`_body_length` in `src/app.py` opens the preamble the five routes that read their
body by its length share, and refuses a chunked body like a missing length on all
five. This file holds that rule. The git route is not one of them: it takes a
chunked push and decodes it itself (`githttp.copy_chunked`).

It differs from `test_a_body_of_unknown_length_is_411`, which sends chunked and no
Content-Length (the length parse refuses that on its own): here the request carries
BOTH headers, so there is a length to parse, and only the `Transfer-Encoding` check
in the preamble refuses it.

The request is written to a raw socket so that what is sent does not depend on
an HTTP client's header merging. No client in this repository produces it on its
own: `hammerola/hub.py` sets Content-Length itself, `urllib.request` never switches
a bytes body to chunked, and a browser needs a ReadableStream body to send chunked.
"""

import socket

import pytest

from harness import TOKEN, comment_payload, good_build

from src import githttp
from src.app import HOOK_SECRET_HEADER

PID = "proj1"
COMMIT = "abc123"

# The five routes of the preamble, by the name their handler goes by. `resolve`
# is the one that enters the preamble conditionally -- its body is optional, so
# a request with no framing at all is a resolve with no note -- and it is here
# because the framing it does carry is still framing this service cannot read.
# `pre-receive` is the git hook's, behind the secret of this process.
ROUTES = ("comment", "pre-receive", "proposal", "resolve", "title")


def _setup(hub):
    """A published build and one open comment on it. -> the paths, by name.

    Every route is aimed at something that exists: `comment` looks the build up
    before it takes a body and `resolve` looks the comment up after, so a made-up
    id would answer 404 instead of a verdict about framing.
    """
    assert hub.publish(PID, COMMIT, good_build()).status_code == 201
    cid = hub.post_comment(PID, COMMIT, comment_payload()).json()["id"]
    return {
        "pre-receive": githttp.HOOK_PATH,
        "title": f"/api/v1/projects/{PID}/title",
        "comment": f"/api/v1/comments/{PID}/{COMMIT}",
        "resolve": f"/api/v1/comments/{cid}/resolve",
        "proposal": f"/api/v1/proposals/{PID}",
    }


def _post(hub, path, framing):
    """POST `path` framed by `framing`. -> the reply's head.

    The body is always the same five bytes: a valid EMPTY chunked body and exactly
    the length any Content-Length here declares. A hub that took either framing at
    its word therefore has a complete request, and the reply is a verdict on the
    framing rather than on a truncated read (without the refusal, a request with a
    length gets a 422 about the content). Both secrets go with it, so no route
    refuses it at the door before the framing is looked at.
    """
    host, port = hub.server.server_address[:2]
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.sendall(
            f"POST {path} HTTP/1.1\r\n".encode()
            + b"Host: hub\r\n"
            b"X-Hammerola-Token: " + TOKEN.encode() + b"\r\n"
            + f"{HOOK_SECRET_HEADER}: {hub.server.hook_secret}\r\n".encode()
            + b"Content-Type: application/json\r\n"
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
    head = _post(hub, _setup(hub)[route],
                 b"Content-Length: 5\r\nTransfer-Encoding: chunked\r\n")

    assert head.startswith(b"HTTP/1.1 411 "), (
        f"{route} answered {head.splitlines()[:1]} to a request framed twice; "
        f"411 is what the other routes say and what `_body_length` promises")
    assert b"Connection: close" in head, (
        f"{route} refused the request but offered to keep the connection, so "
        f"the body it did not read becomes the next request on this socket")


def test_a_chunked_resolve_with_no_length_is_411_rather_than_a_silent_note(hub):
    """`resolve` reaches the refusal through a gate of its own, so test the gate.

    It is the one route whose body is OPTIONAL (a resolve with no framing is a
    resolve with no note, `test_resolve_without_a_note_is_fine`), so the shared
    preamble is entered only when the headers say a body is coming. The gate has a
    Content-Length half and a Transfer-Encoding half; the test above goes through
    the first. Without the TE half a chunked body with no length skips the gate,
    the comment is resolved with `note` None, and the unread body is parsed as the
    next request on the connection.
    """
    head = _post(hub, _setup(hub)["resolve"], b"Transfer-Encoding: chunked\r\n")

    assert head.startswith(b"HTTP/1.1 411 "), (
        f"resolve answered {head.splitlines()[:1]} to a chunked body with no "
        f"length; it must not accept a note it cannot read to the end")
