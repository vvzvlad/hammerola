"""The comment queue and the guards on its public write path (SPEC 7A).

A viewer clicks a part, writes "fix this bit", optionally attaches a photo of the
printed part. The comment lands in a queue an agent later reads over the HTTP API
under COMMENT_READ_TOKEN. Layout (SPEC 7A.3):

    <data>/comments/<pid>/<id>.json          the comment
    <data>/comments/<pid>/<id>.<ext>         the photo, if one came with it
    <data>/comments/<pid>/<id>.shot.<ext>    the viewer's own render of the frame

Deliberately OUTSIDE the build directory. Retention (SPEC 7.3) deletes old builds
and a comment outlives its build: a part name and a coordinate still mean
something ten commits later. A comment on a deleted build stays readable; only the
link back to the frame stops opening.

Writing is PUBLIC — no token, by design — so everything in this module that looks
paranoid is load-bearing (SPEC 7A.4):

  * the photo's type is decided by its magic bytes, never by its filename or by
    the Content-Type the sender chose;
  * SVG is refused by name in the error, because it is a script container rather
    than an image, and this service already learned that lesson once on build
    files (SPEC 7.4);
  * text length, photo size, comments per build and comments in total all have
    ceilings, because a public writer with none of them owns the volume;
  * the rate limit is keyed on an address the SENDER cannot choose.

The text of a comment is never rendered on any page (SPEC 7A.4). That is what
keeps this whole feature off the XSS surface: the only consumer is an agent
reading JSON.
"""

import ipaddress
import json
import re
import threading
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from src.store import SAFE_ID, atomic_write_bytes, utcnow_iso

# A comment id, as it appears in a URL and as a filename. uuid4 hex and nothing
# else: generated here, never taken from a request, and the pattern is what keeps
# `..` or a separator out of `<data>/comments/<pid>/<id>.json`.
COMMENT_ID = re.compile(r"\A[0-9a-f]{32}\Z")

# Attachment kinds and the URL suffix each is served under.
PHOTO_KIND = "photo"
SHOT_KIND = "shot"

# Magic bytes -> extension. The three formats a browser can produce from a file
# picker and a canvas, and nothing else. Checked in this order; WebP needs the
# second marker as well, since `RIFF` alone is also WAV and AVI.
IMAGE_MAGIC = (
    (b"\xff\xd8\xff", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "png"),
)

# How much of an upload is enough to identify it. WebP puts `WEBP` at offset 8.
SNIFF_BYTES = 16

# One line of a JSON field: view id, part name, resolve note. Generous enough for
# a nested part path like `/assembly/bracket/screw_3`, short enough that a queue
# entry stays readable.
MAX_FIELD_CHARS = 200

# Ceiling on the parts of a comment that are not text or an image: the coordinate
# and the camera. Fixed shapes, so this is only here to keep a hand-written
# request from asking for a hundred-element "quaternion".
MAX_VECTOR_LEN = 4

# Networks a request may be forwarded from. Behind Traefik the peer is always a
# container on a private docker network; a request arriving from anywhere else did
# NOT come through the proxy, so its X-Forwarded-For is whatever the sender typed.
# Not an env var: what a private network is does not vary by deployment, and a
# ceiling nobody adjusts is one more thing that can be set wrong (SPEC 7.5).
TRUSTED_PROXY_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "::1/128", "fc00::/7",
))

# How many trusted proxies stand in front of this service. Exactly one: Traefik.
PROXY_HOPS = 1

# How many addresses the rate limiter remembers. Bounded because the table is
# keyed by something the world supplies: without a cap, a botnet's worth of
# distinct addresses is an unbounded dict in a long-lived process.
MAX_TRACKED_ADDRESSES = 4096

# Temp-file prefix left behind by an interrupted write, swept at startup. The same
# prefix `store` uses, so one sweep rule covers both trees.
WIP_PREFIX = ".wip-"


class CommentError(Exception):
    """A refusal that carries the HTTP status it must be answered with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# -- attachments ------------------------------------------------------------
def sniff_image(data: bytes) -> str:
    """Extension for an uploaded image, decided by its BYTES. Raises otherwise.

    Never by the filename and never by the part's Content-Type: both are chosen
    by the sender, and the whole point of storing an attachment is that it will
    later be served back. `image/png` on a file whose first bytes are `<svg` is
    one header away from a stored XSS, and the sender writes that header.
    """
    head = data[:SNIFF_BYTES]
    for magic, extension in IMAGE_MAGIC:
        if head.startswith(magic):
            return extension
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "webp"
    if _looks_like_svg(data):
        # Named explicitly rather than folded into "unsupported", because an SVG
        # is what somebody uploads by accident when they meant to send a drawing,
        # and because refusing it is a decision worth being able to see in a log.
        raise CommentError(
            422, "SVG is not accepted: it is active content, not an image")
    raise CommentError(
        422, "unsupported image type: only JPEG, PNG and WebP are accepted")


def _looks_like_svg(data: bytes) -> bool:
    """Is this an XML/SVG document dressed as an upload?

    Only asked once the magic-byte whitelist has already said no, so it decides
    nothing but the wording of the refusal. Leading whitespace and a BOM are
    skipped because both are legal in front of an XML declaration.
    """
    head = data[:256].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith(b"<svg") or head.startswith(b"<?xml")


# -- the address a rate limit may be keyed on -------------------------------
def client_address(peer: str, forwarded: str) -> str:
    """The address to hold responsible for a request.

    `peer` is what the socket says; `forwarded` is the raw X-Forwarded-For.

    Two rules, and both matter:

    1. The header is read ONLY when the peer is a trusted proxy. Reachable
       directly — in development, or if the container is ever exposed — the
       header is whatever the sender typed, and honouring it would make the rate
       limit a formality: one new header value per request and the ceiling never
       trips.

    2. From the header, the RIGHTMOST entry wins, not the leftmost. Each proxy
       APPENDS the address it accepted the connection from, so with exactly one
       trusted hop in front of us (PROXY_HOPS, i.e. Traefik) the last entry is
       the address Traefik actually saw. Anything the client puts in the header
       itself arrives to the LEFT of that and is ignored — which is precisely the
       spoof the leftmost-entry reading walks into, and the reason SPEC 7A.4 says
       the header must not be trusted blindly rather than just "read the header".
    """
    peer = _normalize_address(peer)
    if not _is_trusted_proxy(peer):
        return peer
    entries = [e.strip() for e in (forwarded or "").split(",") if e.strip()]
    if not entries:
        return peer
    candidate = entries[-PROXY_HOPS] if len(entries) >= PROXY_HOPS else entries[0]
    candidate = _normalize_address(candidate)
    if not _is_address(candidate):
        # A junk entry is not a reason to fall back to the leftmost one — that
        # would be a way to choose which entry is read. The peer is always real.
        return peer
    return candidate


def _normalize_address(value: str) -> str:
    value = (value or "").strip()
    if value.startswith("[") and "]" in value:
        # `[2001:db8::1]:443` — the bracketed form, with or without a port.
        return value[1:value.index("]")]
    if value.count(":") == 1:
        # `1.2.3.4:5678`. A bare IPv6 has more than one colon and is left alone.
        return value.split(":", 1)[0]
    return value


def _is_address(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return False
    return True


def _is_trusted_proxy(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return any(address in network for network in TRUSTED_PROXY_NETWORKS)


class RateLimiter:
    """At most `limit` events per `window` seconds, per key.

    A sliding window rather than a fixed one: a fixed window lets twice the limit
    through across a boundary, which on a five-per-ten-minutes ceiling is the
    difference between a nuisance and a flood.
    """

    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> tuple[bool, int]:
        """(allowed, seconds until the next attempt could succeed)."""
        now = time.monotonic() if now is None else now
        cutoff = now - self.window
        with self._lock:
            self._forget_expired(cutoff)
            hits = [t for t in self._hits.get(key, ()) if t > cutoff]
            if len(hits) >= self.limit:
                self._hits[key] = hits
                return False, max(1, int(hits[0] - cutoff) + 1)
            hits.append(now)
            self._hits[key] = hits
            self._evict_if_crowded()
            return True, 0

    def _forget_expired(self, cutoff: float) -> None:
        for key in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            del self._hits[key]

    def _evict_if_crowded(self) -> None:
        """Keep the table bounded once expiry alone has not done it.

        Evicting the least recently seen key is a concession, not a defence: an
        attacker with MAX_TRACKED_ADDRESSES spare addresses can flush their own
        entry out. That attacker already has enough addresses to sit under a
        per-address ceiling anyway, so the trade is a bounded table against a
        limit that was not going to hold in that case regardless. The ceilings on
        comments per build and in total are what still hold there.
        """
        excess = len(self._hits) - MAX_TRACKED_ADDRESSES
        if excess <= 0:
            return
        oldest = sorted(self._hits, key=lambda k: self._hits[k][-1])[:excess]
        for key in oldest:
            del self._hits[key]


# -- validation of the JSON half of a comment -------------------------------
def _one_line(value, field: str, limit: int = MAX_FIELD_CHARS) -> str:
    """A printable single-line string, or a CommentError naming the field."""
    if not isinstance(value, str):
        raise CommentError(422, f"`{field}` must be a string")
    if len(value) > limit:
        raise CommentError(422, f"`{field}` is longer than {limit} characters")
    for char in value:
        if unicodedata.category(char).startswith("C"):
            raise CommentError(
                422, f"`{field}` contains a non-printable character")
    return value


def _body_text(value, limit: int) -> str:
    """The comment itself: several lines allowed, control characters not.

    Newline and tab survive because a comment is prose and people press Enter.
    Everything else in Unicode category C goes — including U+202E, which reverses
    the text around it in any terminal or editor the agent reads the queue in.
    """
    if not isinstance(value, str):
        raise CommentError(422, "`text` must be a string")
    value = value.replace("\r\n", "\n").strip()
    if not value:
        raise CommentError(422, "`text` is empty")
    if len(value) > limit:
        raise CommentError(413, f"`text` is longer than {limit} characters")
    for char in value:
        if char in "\n\t":
            continue
        if unicodedata.category(char).startswith("C"):
            raise CommentError(422, "`text` contains a non-printable character")
    return value


def _numbers(value, field: str, length: int) -> list:
    """Exactly `length` finite numbers.

    Finiteness is not a formality: `json.dumps` writes `NaN` and `Infinity`
    happily, and neither is valid JSON, so one such value in a camera would make
    the stored comment unreadable by every strict parser — including the one the
    agent uses.
    """
    if not isinstance(value, list) or len(value) != length:
        raise CommentError(422, f"`{field}` must be a list of {length} numbers")
    if length > MAX_VECTOR_LEN:
        raise CommentError(422, f"`{field}` is too long")
    out = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise CommentError(422, f"`{field}` must contain only numbers")
        number = float(item)
        if number != number or number in (float("inf"), float("-inf")):
            raise CommentError(422, f"`{field}` must contain finite numbers")
        out.append(number)
    return out


def _camera(value) -> dict | None:
    """The frame this comment was written in front of (SPEC 7A.1)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise CommentError(422, "`camera` must be an object")
    camera = {
        "position": _numbers(value.get("position"), "camera.position", 3),
        "quaternion": _numbers(value.get("quaternion"), "camera.quaternion", 4),
        "target": _numbers(value.get("target"), "camera.target", 3),
    }
    zoom = value.get("zoom")
    if zoom is not None:
        camera["zoom"] = _numbers([zoom], "camera.zoom", 1)[0]
    return camera


def validate_payload(raw, max_text_chars: int) -> dict:
    """The `comment` field of the form, parsed and checked. Never trusted twice."""
    if not isinstance(raw, dict):
        raise CommentError(422, "the comment must be a JSON object")
    payload = {"text": _body_text(raw.get("text"), max_text_chars)}
    for field in ("view", "part"):
        value = raw.get(field)
        payload[field] = None if value is None else _one_line(value, field)
    point = raw.get("point")
    payload["point"] = None if point is None else _numbers(point, "point", 3)
    payload["camera"] = _camera(raw.get("camera"))
    return payload


class CommentStore:
    """Everything under <data>/comments.

    One instance per process, like Store. The per-build and total counts are kept
    in memory and rebuilt by one scan at startup: a POST must not have to read
    every comment on the volume to find out whether it is allowed, and this
    service is a single process, so a shared counter is the whole of it.
    """

    def __init__(self, data_dir, max_per_build: int, max_total: int,
                 max_text_chars: int, max_photo_bytes: int):
        self.root = Path(data_dir).resolve() / "comments"
        self.max_per_build = max_per_build
        self.max_total = max_total
        self.max_text_chars = max_text_chars
        self.max_photo_bytes = max_photo_bytes
        self._lock = threading.Lock()
        self._per_build: dict[tuple, int] = {}
        self._total = 0
        self.root.mkdir(parents=True, exist_ok=True)
        self._sweep_leftovers()
        self._recount()

    # -- startup bookkeeping ------------------------------------------------
    def _sweep_leftovers(self) -> None:
        """Drop temp files an earlier run died in the middle of writing.

        They are dot-prefixed, so nothing lists or serves them and nothing else
        would ever notice they are there.
        """
        for path in self.root.glob(f"*/{WIP_PREFIX}*"):
            try:
                path.unlink()
            except OSError as error:
                logger.warning(f"could not sweep leftover {path}: {error}")
                continue
            logger.info(f"swept leftover {path}")

    def _recount(self) -> None:
        self._per_build = {}
        self._total = 0
        for record in self._read_all():
            self._per_build[(record["pid"], record["commit"])] = (
                self._per_build.get((record["pid"], record["commit"]), 0) + 1)
            self._total += 1

    # -- reading ------------------------------------------------------------
    def _read_all(self) -> list:
        records = []
        for path in sorted(self.root.glob("*/*.json")):
            record = _read_record(path)
            if record is not None:
                records.append(record)
        return records

    def list(self, project: str | None = None, status: str | None = None,
             since: str | None = None) -> list:
        """The queue, oldest first. Filters are the ones SPEC 7A.2 names."""
        records = self._read_all()
        if project is not None:
            records = [r for r in records if r["pid"] == project]
        if status is not None:
            records = [r for r in records if r.get("status") == status]
        if since is not None:
            records = [r for r in records if str(r.get("created", "")) >= since]
        records.sort(key=lambda r: (str(r.get("created", "")), r["id"]))
        return records

    def _path_of(self, cid: str) -> Path | None:
        """Where the comment with this id lives, without trusting the id.

        The pattern check happens first, so nothing that could describe a path is
        ever joined onto the root; the glob is then over ONE directory level,
        which is the layout SPEC 7A.3 fixes.
        """
        if not COMMENT_ID.match(cid or ""):
            return None
        for path in self.root.glob(f"*/{cid}.json"):
            return path
        return None

    def get(self, cid: str) -> dict | None:
        path = self._path_of(cid)
        return None if path is None else _read_record(path)

    def attachment(self, cid: str, kind: str) -> Path | None:
        """The photo or the viewer's render for this comment, if it has one."""
        record = self.get(cid)
        if record is None:
            return None
        name = record.get(kind)
        # The name was written by this module from a sniffed extension, but it is
        # read back off the volume, so it is checked again rather than joined
        # blindly: a hand-edited record must not be able to name /etc/passwd.
        if not isinstance(name, str) or not _safe_attachment_name(name, cid):
            return None
        path = self._path_of(cid)
        if path is None:
            return None
        candidate = path.parent / name
        return candidate if candidate.is_file() else None

    # -- writing ------------------------------------------------------------
    def add(self, pid: str, commit: str, payload: dict,
            attachments: dict) -> dict:
        """Store one comment. `attachments` maps a kind to raw bytes.

        The photo is written BEFORE the record, on purpose. A photo with no record
        is invisible to every reader and gets cleaned up; a record naming a photo
        that is not there is a broken entry in the queue an agent has to handle.
        """
        if not SAFE_ID.match(pid or ""):
            raise CommentError(422, "invalid project id")
        if not SAFE_ID.match(commit or ""):
            raise CommentError(422, "invalid commit id")

        stored = {}
        for kind, data in attachments.items():
            if len(data) > self.max_photo_bytes:
                raise CommentError(
                    413,
                    f"`{kind}` is {len(data)} bytes, limit is "
                    f"{self.max_photo_bytes}")
            stored[kind] = sniff_image(data)

        cid = uuid.uuid4().hex
        record = {
            "id": cid,
            "pid": pid,
            "commit": commit,
            "view": payload["view"],
            "part": payload["part"],
            "point": payload["point"],
            "camera": payload["camera"],
            "text": payload["text"],
            PHOTO_KIND: None,
            SHOT_KIND: None,
            "status": "open",
            "created": utcnow_iso(),
            "resolved": None,
            "note": None,
        }

        with self._lock:
            # Counted under the same lock that writes, so two simultaneous posts
            # cannot both read "one below the ceiling" and both land.
            if self._total >= self.max_total:
                raise CommentError(
                    429, f"the queue is full ({self.max_total} comments)")
            key = (pid, commit)
            if self._per_build.get(key, 0) >= self.max_per_build:
                raise CommentError(
                    429,
                    f"this build already has {self.max_per_build} comments")

            directory = self.root / pid
            directory.mkdir(parents=True, exist_ok=True)
            written = []
            try:
                for kind, extension in stored.items():
                    name = _attachment_name(cid, kind, extension)
                    atomic_write_bytes(directory / name, attachments[kind])
                    written.append(directory / name)
                    record[kind] = name
                atomic_write_bytes(
                    directory / f"{cid}.json",
                    json.dumps(record, indent=1, ensure_ascii=False,
                               allow_nan=False).encode("utf-8"))
            except Exception:
                # The record never landed, so these bytes are unreachable. Left
                # behind they would be a slow leak on a PUBLIC endpoint.
                for path in written:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                raise
            self._per_build[key] = self._per_build.get(key, 0) + 1
            self._total += 1
        logger.info(
            f"comment {cid} on {pid}/{commit}: {len(payload['text'])} chars, "
            f"attachments {sorted(stored) or 'none'}")
        return record

    def resolve(self, cid: str, note: str | None) -> dict | None:
        """Mark a comment handled so the agent does not process it twice."""
        with self._lock:
            path = self._path_of(cid)
            if path is None:
                return None
            record = _read_record(path)
            if record is None:
                return None
            record["status"] = "resolved"
            record["resolved"] = utcnow_iso()
            record["note"] = (None if note is None
                              else _one_line(note, "note", MAX_FIELD_CHARS))
            atomic_write_bytes(
                path,
                json.dumps(record, indent=1, ensure_ascii=False,
                           allow_nan=False).encode("utf-8"))
        return record


def _attachment_name(cid: str, kind: str, extension: str) -> str:
    """`<id>.jpg` for the photo, `<id>.shot.png` for the viewer's render."""
    if kind == PHOTO_KIND:
        return f"{cid}.{extension}"
    return f"{cid}.{kind}.{extension}"


def _safe_attachment_name(name: str, cid: str) -> bool:
    """Does this name still look like one this module wrote for THIS comment?"""
    if "/" in name or name.startswith("."):
        return False
    head, _, extension = name.rpartition(".")
    if extension not in {"jpg", "png", "webp"}:
        return False
    return head in (cid, f"{cid}.{SHOT_KIND}")


def _read_record(path: Path) -> dict | None:
    """One comment off the volume, or None if it is not one.

    A file that fails these checks is skipped rather than raised on: the queue is
    read by a listing endpoint, and one damaged entry must not take the whole
    queue offline.
    """
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logger.warning(f"unreadable comment {path}: {error}")
        return None
    if not isinstance(record, dict):
        return None
    for key in ("id", "pid", "commit", "text", "status", "created"):
        if not isinstance(record.get(key), str):
            return None
    if record["id"] != path.stem or record["pid"] != path.parent.name:
        return None
    return record


def normalize_since(value: str) -> str | None:
    """A `since` filter, rewritten into the exact shape `created` is stored in.

    None if it is not a timestamp at all. The rewrite is what makes the filter
    correct rather than approximately correct: `list` compares STRINGS, which is
    only the same as comparing instants while both sides are spelled the way
    `utcnow_iso` spells them. A caller passing `2026-08-22T04:00:00+03:00` — a
    perfectly valid ISO-8601 timestamp — would otherwise be compared character by
    character against `2026-08-22T01:00:00Z` and get the wrong half of the queue.
    """
    text = str(value)
    for candidate in (text, text.replace(" ", "+")):
        # The second attempt is for `+03:00` offsets. A query string is decoded as
        # form data, where `+` MEANS space, so a caller who wrote the offset
        # literally into the URL instead of percent-encoding it gets
        # `2026-01-01T03:00:00 03:00` here. Retrying is safe because the retry
        # still has to parse as a timestamp; refusing would be a 422 whose cause
        # is invisible in the URL the caller is looking at.
        try:
            parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None
