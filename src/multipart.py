"""A small, strict `multipart/form-data` parser.

Written here rather than taken from the standard library on purpose. `cgi.FieldStorage`
was the obvious candidate and it is REMOVED in Python 3.13 — the image is on 3.11
today, so importing it would have worked right up to the base-image bump. The
`email` package can parse the same bytes, but it is a lenient mail parser: it
repairs malformed input rather than refusing it, and the one place this parser is
used (SPEC 7A.2) is the only endpoint on the whole service that reads a
STRUCTURED body at all. Everywhere else a body is bytes with a length; here it is
a format with a grammar, and "refuse anything unusual" is what keeps a
disagreement between this parser and whatever validates the result from becoming
a value that got past a check.

IT IS NOT AN ANONYMOUS BODY, and this paragraph said it was until issue #88.
Writing a comment has taken EDIT_TOKEN since step 0, and `_handle_comment_post`
in src/app.py checks it BEFORE a byte of the body is read — which
`tests/test_comments.py` pins, so this parser never sees a stranger's bytes. The
strictness is worth having for its own reasons above; it is not a boundary
against anybody.

So this is a whitelist, in the same spirit as the tar reader in store.py:

  * the boundary must look like a boundary, or nothing is parsed at all;
  * the number of parts and the size of a part's header block are capped, so a
    body that is within the byte ceiling still cannot ask for unbounded work;
  * a duplicate field name is refused rather than resolved, because "which one
    wins" is exactly the kind of disagreement between a parser and a validator
    that smuggles a value past a check;
  * headers other than Content-Disposition are ignored, `Content-Type` above all:
    what a part contains is decided by looking at its bytes (see
    `comments.sniff_image`), never by what the sender called it.
"""

import re

# RFC 2046: 1-70 characters from a fixed set, and it may not end in a space. Bad
# boundaries are refused rather than guessed at, since a boundary that does not
# match what the sender actually used produces one giant unparsable part.
BOUNDARY = re.compile(r"\A[A-Za-z0-9'()+_,\-./:=? ]{1,70}\Z")

# What a Content-Disposition parameter looks like: `name="value"` or `name=value`.
DISPOSITION_PARAM = re.compile(
    r';\s*(?P<key>[A-Za-z0-9!#$%&\'*+\-.^_`|~]+)\s*=\s*'
    r'(?:"(?P<quoted>[^"\\]*)"|(?P<bare>[^;",\s]*))')

# Ceilings on the SHAPE of the body. The byte ceiling is applied by the caller
# before the body is read at all; these two bound the work done afterwards.
MAX_PARTS = 8
MAX_PART_HEADER_BYTES = 8 * 1024


class MultipartError(ValueError):
    """The body is not a multipart/form-data document we are willing to read."""


class Part:
    """One field: its form name, the filename if it was a file, and its bytes."""

    __slots__ = ("name", "filename", "data")

    def __init__(self, name: str, filename: str | None, data: bytes):
        self.name = name
        self.filename = filename
        self.data = data


def parse_content_type(header: str) -> tuple[str, dict]:
    """(lowercased mime type, parameters) from a Content-Type header."""
    mime, _, rest = (header or "").partition(";")
    params = {}
    for match in DISPOSITION_PARAM.finditer(";" + rest):
        value = match.group("quoted")
        if value is None:
            value = match.group("bare") or ""
        params[match.group("key").lower()] = value
    return mime.strip().lower(), params


def parse_multipart(body: bytes, content_type: str) -> dict:
    """Parse `body` into {field name: Part}, or raise MultipartError.

    The whole body is already in memory by the time this runs, and that is a
    deliberate consequence of the ceiling being small: a comment is a few
    kilobytes of text plus one photo, so the cap is single-digit megabytes rather
    than the 64 MiB a build may be. A streaming parser would buy nothing here and
    would be a great deal more code to get wrong.
    """
    mime, params = parse_content_type(content_type)
    if mime != "multipart/form-data":
        raise MultipartError(
            f"expected multipart/form-data, got {mime or 'no content type'!r}")
    boundary = params.get("boundary", "")
    if not BOUNDARY.match(boundary) or boundary.endswith(" "):
        raise MultipartError("missing or malformed multipart boundary")

    # Every delimiter in the body is preceded by CRLF except the very first one,
    # which sits at the start. Prepending CRLF makes all of them alike, so one
    # split does the whole job and the CRLF that belongs to the DELIMITER is never
    # mistaken for the last two bytes of a part's content.
    delimiter = b"\r\n--" + boundary.encode("ascii")
    segments = (b"\r\n" + body).split(delimiter)
    if len(segments) < 2:
        raise MultipartError("no multipart boundary found in the body")
    # segments[0] is the preamble (ordinarily empty) and is discarded by the RFC.
    # The last segment starts with `--`, the closing delimiter's suffix; a body
    # that never closes is truncated, which is a client failure worth naming.
    if not segments[-1].startswith(b"--"):
        raise MultipartError("the multipart body is truncated")

    parts: dict = {}
    for segment in segments[1:-1]:
        if len(parts) >= MAX_PARTS:
            raise MultipartError(f"more than {MAX_PARTS} multipart fields")
        part = _parse_part(segment)
        if part.name in parts:
            # Refused, not resolved. If this parser kept the last value and a
            # reader elsewhere kept the first, a field could be validated in one
            # form and used in another.
            raise MultipartError(f"duplicate multipart field {part.name!r}")
        parts[part.name] = part
    if not parts:
        raise MultipartError("the multipart body has no fields")
    return parts


def _parse_part(segment: bytes) -> Part:
    """One segment between two delimiters -> a Part."""
    # Transport padding: whitespace is allowed between the delimiter and its CRLF.
    body = segment.lstrip(b" \t")
    if not body.startswith(b"\r\n"):
        raise MultipartError("malformed multipart delimiter line")
    body = body[2:]

    head, sep, data = body.partition(b"\r\n\r\n")
    if not sep:
        raise MultipartError("a multipart field has no header block")
    if len(head) > MAX_PART_HEADER_BYTES:
        raise MultipartError("a multipart field has an oversized header block")

    name = None
    filename = None
    # latin-1 never fails and never invents characters: every byte maps to one
    # code point. A header carrying real UTF-8 would come back mojibake, which is
    # fine — the only two values read out of here are matched against a whitelist
    # (the field name) or ignored entirely (the filename).
    for line in head.decode("latin-1").split("\r\n"):
        key, _, value = line.partition(":")
        if key.strip().lower() != "content-disposition":
            continue
        for match in DISPOSITION_PARAM.finditer(value):
            found = match.group("quoted")
            if found is None:
                found = match.group("bare") or ""
            if match.group("key").lower() == "name":
                name = found
            elif match.group("key").lower() == "filename":
                filename = found
    if not name:
        raise MultipartError("a multipart field has no name")
    return Part(name, filename, data)
