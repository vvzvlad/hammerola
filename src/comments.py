"""The comment queue and the guards on its write path (SPEC 7A).

Somebody holding the edit token clicks a part, writes "fix this bit", optionally
attaches a photo of the printed part. The comment lands in a queue an agent later
reads over the HTTP API under the same EDIT_TOKEN. Layout (SPEC 7A.3):

    <data>/comments/<pid>/<id>.json          the comment
    <data>/comments/<pid>/<id>.<ext>         the photo, if one came with it
    <data>/comments/<pid>/<id>.shot.<ext>    the viewer's own render of the frame

Deliberately outside the build directory (SPEC 7A.3): build directories are
public and cached `immutable`, while this queue is not public (SPEC 7A.2); and a
comment is about the project (its catalogue key survives later revisions), so it
outlives a build somebody deletes. Only the link back to the frame stops opening.

Writing takes EDIT_TOKEN (SPEC 8A.1). The remaining guards are about the bytes,
not the sender:

  * the photo's type is decided by its magic bytes, never by its filename or
    Content-Type, because the bytes are served back on the builds' origin;
  * SVG is refused by name: it is a script container, not an image (SPEC 7.4);
  * text length and photo size have ceilings, bounding the hub's own work;
  * nothing counts or throttles comments (SPEC 7A.4): the only caller holds
    EDIT_TOKEN, which can also delete the whole project, and there is no
    retention (SPEC 5.3).

THE ANCHOR IS THE CATALOGUE KEY. A comment stores `key` beside `part`: `part` is
a path in ONE revision's tree (`/model/pin(2)` — a number the tessellator hands
out for uniqueness), while `key` is the entity's identity in `meta.parts`, which
survives a rebuild that renumbers or reorders the tree. The build page follows
the key to find the part again, and says so in the feed when the key names
nothing in the current catalogue — the entity is gone and the comment is
orphaned. Older records may have no `key`.

A comment left on a DOCUMENT of the build names it by its path, `doc`, and
hangs on a place in it: a sheet and an area of a schematic, an area of a board,
a quoted passage of markdown (`frame` says which). It has no `key`.

The text of a comment IS rendered: the build page shows the project's queue in
its rail. It reaches the DOM as text and never as markup; this module keeps the
stored text plain (`_body_text` refuses the control characters).
"""

import json
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from src.errors import CommentError
from src.records import (WIP_PREFIX, check_body_printable, one_line,
                         sweep_leftovers)
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

# Ceiling on the parts of a comment that are not text or an image: the coordinate,
# its normal, the camera and a document's area. Fixed shapes, so this is only here
# to keep a hand-written request from asking for a hundred-element "quaternion".
MAX_VECTOR_LEN = 4

# What `point`, `normal` and `area` are in (SPEC 7A.1): "part", the frame of the
# solid `part` names; "sheet" and "board", the millimetres of a schematic's sheet
# or of a board; "text", a markdown document, where the anchor is `quote`.
FRAMES = ("part", "sheet", "board", "text")


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
def _body_text(value, limit: int) -> str:
    """The comment itself: several lines allowed, control characters not.

    The scan is `records.check_body_printable`, which the proposal store shares:
    newline and tab survive because a comment is prose and people press Enter,
    and everything else in Unicode category C goes — including U+202E, which
    reverses the text around it in any terminal or editor the agent reads the
    queue in. What is local is the rest — a comment is normalized, may not be
    empty and has a ceiling, and a proposal's projection has none of the three.
    """
    if not isinstance(value, str):
        raise CommentError(422, "`text` must be a string")
    value = value.replace("\r\n", "\n").strip()
    if not value:
        raise CommentError(422, "`text` is empty")
    if len(value) > limit:
        raise CommentError(413, f"`text` is longer than {limit} characters")
    check_body_printable(value, CommentError)
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


def _area(value) -> list:
    """`[x, y, w, h]` in the document's millimetres; a width or height < 0 is
    no area."""
    area = _numbers(value, "area", 4)
    if area[2] < 0 or area[3] < 0:
        raise CommentError(422, "`area` must have a width and height >= 0")
    return area


def _items(value) -> list:
    """What the area holds — designators and net names, one line each."""
    if not isinstance(value, list):
        raise CommentError(422, "`items` must be a list of strings")
    return [one_line(item, "items", CommentError) for item in value]


def _quote(value, max_text_chars: int) -> dict:
    """A passage of a markdown document: `text`, and the characters `before`
    and `after` it, which may be empty. All three are kept as sent — the page
    finds the passage again by its text between its two sides, which a trimmed
    or re-joined `text` would no longer sit between — and only checked: as a
    body is for its characters, and `text` for not being blank and for the
    comment's own ceiling."""
    if not isinstance(value, dict):
        raise CommentError(422, "`quote` must be an object")
    quote = {}
    for field in ("text", "before", "after"):
        side = value.get(field)
        if not isinstance(side, str):
            raise CommentError(422, f"`quote.{field}` must be a string")
        check_body_printable(side, CommentError, f"quote.{field}")
        quote[field] = side
    if not quote["text"].strip():
        raise CommentError(422, "`quote.text` is empty")
    if len(quote["text"]) > max_text_chars:
        raise CommentError(
            413, f"`quote.text` is longer than {max_text_chars} characters")
    return quote


def validate_payload(raw, max_text_chars: int) -> dict:
    """The `comment` field of the form, parsed and checked. Never trusted twice."""
    if not isinstance(raw, dict):
        raise CommentError(422, "the comment must be a JSON object")
    payload = {"text": _body_text(raw.get("text"), max_text_chars)}
    # `doc` is the path of a document of the build the comment was left on
    # (`kicad/board.kicad_sch`), `sheet` the file of a schematic's sheet and
    # `layer` a board's layer; none of them for a comment on the model.
    for field in ("view", "part", "key", "published", "doc", "sheet", "layer"):
        value = raw.get(field)
        payload[field] = (None if value is None
                          else one_line(value, field, CommentError))
    point = raw.get("point")
    payload["point"] = None if point is None else _numbers(point, "point", 3)
    # The face normal at that point, which the build page stands the comment's
    # arrow on. Checked exactly like the point it belongs to.
    normal = raw.get("normal")
    payload["normal"] = None if normal is None else _numbers(normal, "normal", 3)
    # Absent: a world coordinate of the view the comment was left in.
    if "frame" in raw and raw["frame"] not in FRAMES:
        raise CommentError(
            422, f"`frame` must be one of {', '.join(FRAMES)} or absent")
    payload["frame"] = raw.get("frame")
    payload["camera"] = _camera(raw.get("camera"))
    area = raw.get("area")
    payload["area"] = None if area is None else _area(area)
    items = raw.get("items")
    payload["items"] = None if items is None else _items(items)
    quote = raw.get("quote")
    payload["quote"] = None if quote is None else _quote(quote, max_text_chars)
    return payload


class CommentStore:
    """Everything under <data>/comments.

    One instance per process, like Store. Nothing is counted (SPEC 7A.4).
    """

    def __init__(self, data_dir, max_text_chars: int, max_photo_bytes: int):
        self.root = Path(data_dir).resolve() / "comments"
        self.max_text_chars = max_text_chars
        self.max_photo_bytes = max_photo_bytes
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        # One directory per project, so the leftovers of an interrupted write
        # sit one level down.
        sweep_leftovers(self.root, f"*/{WIP_PREFIX}*")

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
        """The path the record NAMES for this comment's photo or render.

        A name, not a verdict about the file: the caller opens it with
        O_NOFOLLOW and fstats the handle (`app._serve_attachment`), which checks
        the bytes it will send without a race. A missing file is a 404 there.
        """
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
        return path.parent / name

    # -- writing ------------------------------------------------------------
    def add(self, pid: str, commit: str, payload: dict,
            attachments: dict, variant: str = None) -> dict:
        """Store one comment. `attachments` maps a kind to raw bytes.

        `variant` is the variant whose draft the comment was left on, for a
        variant other than the default; None for the default one and for a
        revision, as on every comment written before variants.

        The photo is written BEFORE the record, on purpose. A photo with no record
        is invisible to every reader and gets cleaned up; a record naming a photo
        that is not there is a broken entry in the queue an agent has to handle.

        `published` is the stamp of the build the comment was written on, and it
        is what says which build that was: the local slot's `commit` is always
        `dev` (SPEC 7.6). It comes from the caller rather than the hub's disk,
        because the slot can rebuild between the click and the Send. Without a
        stamp it is `None` and the comment hangs by its catalogue key.
        """
        if not SAFE_ID.match(pid or ""):
            raise CommentError(422, "invalid project id")
        if not SAFE_ID.match(commit or ""):
            raise CommentError(422, "invalid commit id")
        if variant is not None and not SAFE_ID.match(variant):
            raise CommentError(422, "invalid variant")

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
            "variant": variant,
            "published": payload["published"],
            "view": payload["view"],
            "part": payload["part"],
            "key": payload["key"],
            "point": payload["point"],
            "normal": payload["normal"],
            "frame": payload["frame"],
            "camera": payload["camera"],
            "doc": payload["doc"],
            "sheet": payload["sheet"],
            "area": payload["area"],
            "items": payload["items"],
            "layer": payload["layer"],
            "quote": payload["quote"],
            "text": payload["text"],
            PHOTO_KIND: None,
            SHOT_KIND: None,
            "status": "open",
            "created": utcnow_iso(),
            "resolved": None,
            "note": None,
        }

        with self._lock:
            # Guards the write against `resolve` and `remove_project` on other
            # request threads.
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
                # behind they would be a slow leak on a write path that runs
                # once per accepted comment, and once more per retry of a
                # rejected one.
                for path in written:
                    try:
                        path.unlink()
                    except OSError:
                        pass
                raise
        where = commit if variant is None else f"v/{variant}/{commit}"
        logger.info(
            f"comment {cid} on {pid}/{where}: {len(payload['text'])} chars, "
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
            record["note"] = (
                None if note is None
                else one_line(note, "note", CommentError))
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

    No write-back, unlike `JobStore._load`: this runs per request, so there
    is no long-lived copy to diverge from the volume.
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
