"""The comment queue and the guards on its write path (SPEC 7A).

Somebody holding the edit token clicks a part, writes "fix this bit", optionally
attaches a photo of the printed part. The comment lands in a queue an agent later
reads over the HTTP API under the same EDIT_TOKEN. Layout (SPEC 7A.3):

    <data>/comments/<pid>/<id>.json          the comment
    <data>/comments/<pid>/<id>.<ext>         the photo, if one came with it
    <data>/comments/<pid>/<id>.shot.<ext>    the viewer's own render of the frame

Deliberately OUTSIDE the build directory (SPEC 7A.3), and for two reasons that
both stand on their own. ACCESS: a build directory is served to anybody who has
the URL, with a year of `immutable`, so a comment placed in one would be public
and irrevocably cached — and this queue is not public to read (SPEC 7A.2).
LIFETIME: a comment is about the PROJECT more than about one revision — a part
name and a coordinate still mean something ten commits later — so it must not be
a file that goes wherever the build goes. Nothing deletes a build on its own any
more (SPEC 5.3), but somebody clearing space on the volume does, and a comment on
a build that is gone stays readable; only the link back to the frame stops
opening.

WRITING TAKES EDIT_TOKEN SINCE STEP 0 (SPEC 8A.1). What survived that change and
what did not is the useful summary, because the two are decided by different
questions — "is this about the bytes?" survives, "is this about the sender?" does
not:

  * the photo's type is decided by its magic bytes, never by its filename or by
    the Content-Type the sender chose. The bytes are handed BACK OUT on the same
    origin as every project's builds, so this is about what the hub serves, not
    about who sent it;
  * SVG is refused by name in the error, because it is a script container rather
    than an image, and this service already learned that lesson once on build
    files (SPEC 7.4);
  * text length and photo size still have ceilings, because an unbounded parse
    and an unbounded store are not made safe by a credential;
  * NOTHING COUNTS COMMENTS AND NOTHING THROTTLES THEM (decided 2026-08-27, SPEC
    7A.4). There was a per-build ceiling, a global one and a rate limit keyed on
    the client's address, and all three existed against a stranger with a script,
    because the endpoint was open to one. It is not any more. The only caller
    that can reach this module holds EDIT_TOKEN — the one secret of the system,
    which also opens `DELETE /api/v1/projects/<pid>` — so a ceiling here would
    rate-limit somebody who can erase the project in one request. Do not put one
    back "for safety": a size ceiling bounds work the hub does, a count ceiling
    only decides how much of their own queue the author may keep, and that
    question was already answered everywhere else (SPEC 5.3 — no retention).

The text of a comment is never rendered on any page (SPEC 7A.4). That is what
keeps this whole feature off the XSS surface: the only consumer is an agent
reading JSON.
"""

import json
import re
import shutil
import threading
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

    One instance per process, like Store. NOTHING IS COUNTED HERE. There used to
    be a per-build tally and a global one, kept in memory and rebuilt by a scan
    at startup so a POST would not have to read the volume to find out whether it
    was allowed; both ceilings are gone (SPEC 7A.4), so the counters that served
    them are gone with them and a comment is written without consulting the ones
    already there.
    """

    def __init__(self, data_dir, max_text_chars: int, max_photo_bytes: int):
        self.root = Path(data_dir).resolve() / "comments"
        self.max_text_chars = max_text_chars
        self.max_photo_bytes = max_photo_bytes
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        self._sweep_leftovers()

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
            # The lock no longer guards a counter — nothing counts comments any
            # more (SPEC 7A.4). It guards the write itself against `resolve` and
            # `remove_project` running on another request thread at the same
            # moment, which is a reason of its own and outlives the ceilings.
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
        logger.info(
            f"comment {cid} on {pid}/{commit}: {len(payload['text'])} chars, "
            f"attachments {sorted(stored) or 'none'}")
        return record

    def remove_project(self, pid: str) -> int:
        """Delete one project's whole queue. -> how many comments went.

        Called only when the PROJECT is being removed (`DELETE
        /api/v1/projects/<pid>`). There is deliberately no route that removes one
        comment: a queue entry is closed with `resolve`, which keeps the record
        and the note, and nothing anywhere else deletes a comment (SPEC 5.3 —
        there is no retention).

        Leaving the queue behind would be worse than a leak: the comments anchor
        to `<pid>/<commit>` (SPEC 7A.1), so every one of them would point at a
        build that no longer exists, and the agent reading the queue would be
        handed work about a project nobody can open.

        The id is checked before it is joined onto the root — nothing that could
        describe a path may reach `rmtree`.
        """
        if not SAFE_ID.match(pid or ""):
            return 0
        directory = self.root / pid
        with self._lock:
            if not directory.is_dir():
                return 0
            gone = sum(1 for _ in directory.glob("*.json"))
            shutil.rmtree(directory)
        logger.info(f"removed the comment queue of {pid}: {gone} comments")
        return gone

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
