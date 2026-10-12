"""The one Proposal a project has, and the guards on its write path.

Somebody holding the edit token opens a published model and assembles a rough
parametric body over it in the browser panel — the motor the bracket has to
clear, the wall it bolts to, a part of the build dragged to where they want it.
The document (built by `ui/src/proposal.js`) is stored here:

    <data>/proposals/<pid>.json        the whole proposal, one file per project

ONE PER PROJECT, NO HISTORY AND NO RETENTION. A second write REPLACES the first
rather than appending to it, and the only thing that removes one is somebody
asking — `DELETE /api/v1/proposals/<pid>`, or removing the project it belongs
to (SPEC 5.3). A proposal is a working document, so saving replaces it.

Outside the build directory for the comment queue's reasons (SPEC 7A.3): build
directories are public and cached `immutable`, while this is read and written
under EDIT_TOKEN; and a proposal is about the project, edited across rebuilds.
The `published` stamp notes which build the moves were measured on.

The document (`{version, units, nodes}`, as `ui/src/proposal.js` builds it) is
stored opaquely: its author is the project owner under EDIT_TOKEN, and a Python
schema would have to track that module forever.

What is checked is about the bytes and this store, as in `src/comments.py`:

  * the request body has a ceiling (`proposal_max_body_bytes`), because an
    unbounded parse and an unbounded store are not made safe by a credential;
  * `doc` must be a JSON object, `published` and `view` one printable line each
    or null — enough that what comes back off the volume is the shape every
    reader here already assumes;
  * `text` must be a string or null, printable the way a comment's body is
    (`comments._body_text`): newline and tab survive, every other character in
    Unicode category C (e.g. U+202E) is refused. `hammerola proposal` prints
    this field straight into the agent's terminal;
  * no NaN or infinity anywhere in the payload: `json.loads` accepts them but
    `json.dumps(..., allow_nan=False)` would refuse to write them, turning an
    accepted request into a 500. They are refused with a 422 instead.
"""

import json
import threading
from pathlib import Path

from loguru import logger

from src.errors import ProposalError
from src.records import (WIP_PREFIX, check_body_printable, one_line,
                         sweep_leftovers)
from src.store import SAFE_ID, atomic_write_bytes, utcnow_iso


# -- the request body -------------------------------------------------------
def _refuse_constant(literal: str):
    """`json.loads`'s hook for `NaN`, `Infinity` and `-Infinity`.

    Python's parser accepts all three as an extension and hands back a float
    that no strict JSON parser will ever read again — including the one on the
    other end of `GET /api/v1/proposals/<pid>`.
    """
    raise ProposalError(
        422, f"`{literal}` is not a number this store can write back")


def _finite_number(text: str) -> float:
    """`json.loads`'s hook for every float literal in the body.

    `1e999` is an ordinary JSON number that `parse_constant` never sees, yet
    `float()` turns it into `inf`; it is refused here.
    """
    number = float(text)
    if number != number or number in (float("inf"), float("-inf")):
        raise ProposalError(
            422, f"`{text}` is not a number this store can write back")
    return number


def parse_body(body: bytes) -> dict:
    """The request body as a JSON object. Raises ProposalError otherwise."""
    try:
        raw = json.loads(body.decode("utf-8"),
                         parse_constant=_refuse_constant,
                         parse_float=_finite_number)
    except (UnicodeDecodeError, ValueError) as error:
        raise ProposalError(422, f"body is not valid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise ProposalError(422, "body must be a JSON object")
    return raw


def _body_text(value) -> str:
    """The projection: several lines allowed, control characters not.

    `records.check_body_printable`, not `records.one_line`: the projection is
    a multi-line table, so newline and tab must survive. Everything else in
    Unicode category C goes, since `hammerola proposal` prints this field into
    the agent's terminal.
    """
    if not isinstance(value, str):
        raise ProposalError(422, "`text` must be a string or null")
    check_body_printable(value, ProposalError)
    return value


def validate_payload(raw: dict) -> dict:
    """The four fields a POST carries, checked. The document itself is not.

    `doc` is the browser's own document and travels verbatim — see the module
    docstring for why nothing here looks inside it. `text` is the projection the
    agent reads (`proposalText`), and it is allowed to be null: a document whose
    every node is ticked off sends nothing.

    `published` AND `view` TOGETHER ARE WHERE THE MOVES WERE MEASURED, and it
    takes both: a move's `paths` are paths in one revision's tree AS ONE VIEW
    GROUPS IT (`src/cadbuild/views.py`), and `published` is identical across the
    views of one build. Either is null when there is nothing to measure, and
    `ui/src/HammerolaViewer.jsx` restores the moves only where BOTH match the
    page asking for them.
    """
    doc = raw.get("doc")
    if not isinstance(doc, dict):
        raise ProposalError(422, "`doc` must be a JSON object")
    text = raw.get("text")
    if text is not None:
        text = _body_text(text)
    published = raw.get("published")
    if published is not None:
        published = one_line(published, "published", ProposalError)
    view = raw.get("view")
    if view is not None:
        view = one_line(view, "view", ProposalError)
    return {"doc": doc, "text": text, "published": published, "view": view}


class ProposalStore:
    """Everything under <data>/proposals.

    One instance per process, like Store and CommentStore. Nothing here counts
    anything and nothing expires: there is one file per project and it is
    overwritten in place.
    """

    def __init__(self, data_dir):
        self.root = Path(data_dir).resolve() / "proposals"
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        # One file per project, flat, so the leftovers of an interrupted write
        # sit in the root itself.
        sweep_leftovers(self.root, f"{WIP_PREFIX}*")

    # -- reading ------------------------------------------------------------
    def _path_of(self, pid: str) -> Path | None:
        """Where this project's proposal lives, without trusting the id.

        The pattern check happens first, so nothing that could describe a path
        is ever joined onto the root.
        """
        if not SAFE_ID.match(pid or ""):
            return None
        return self.root / f"{pid}.json"

    def get(self, pid: str) -> dict | None:
        path = self._path_of(pid)
        return None if path is None else _read_record(path)

    # -- writing ------------------------------------------------------------
    def put(self, pid: str, doc: dict, text: str | None,
            published: str | None, view: str | None) -> dict:
        """Store this project's proposal, replacing whatever was there."""
        path = self._path_of(pid)
        if path is None:
            raise ProposalError(422, "invalid project id")
        record = {
            "pid": pid,
            "doc": doc,
            "text": text,
            # BOTH HALVES OF WHERE THE MOVES WERE MEASURED, for the reason
            # `validate_payload` gives: the build alone does not identify the
            # tree a move's paths were numbered in.
            "published": published,
            "view": view,
            "saved": utcnow_iso(),
        }
        body = json.dumps(record, indent=1, ensure_ascii=False,
                          allow_nan=False).encode("utf-8")
        with self._lock:
            # The lock guards the write against a `remove` on another request
            # thread at the same moment; the write itself is atomic, so a reader
            # sees the old document or the new one and never half of either.
            atomic_write_bytes(path, body)
        logger.info(f"proposal stored for {pid}: {len(body)} bytes")
        return record

    def remove(self, pid: str) -> bool:
        """Delete this project's proposal. -> whether there was one."""
        path = self._path_of(pid)
        if path is None:
            return False
        with self._lock:
            try:
                path.unlink()
            except FileNotFoundError:
                return False
        logger.info(f"removed the proposal of {pid}")
        return True

    def remove_project(self, pid: str) -> bool:
        """The same deletion, under the name `DELETE /api/v1/projects/<pid>`
        calls it.

        Named like `CommentStore.remove_project`, so app.py composes the stores
        the same way.
        """
        return self.remove(pid)


def _read_record(path: Path) -> dict | None:
    """One proposal off the volume, or None if what is there is not one.

    A file that fails these checks reads as ABSENT rather than raising: the
    route that reads it answers 404 for a project that has no proposal anyway,
    and a damaged file must not turn that into a 500 on a page somebody has
    open.

    A missing file is plain absence and does not warn: the path is built from
    the URL id, and most projects have no proposal. Anything else (a damaged
    file, a directory in its place) warns.

    No write-back, for the reason `comments._read_record` gives.
    """
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        logger.warning(f"unreadable proposal {path}: {error}")
        return None
    if not isinstance(record, dict):
        return None
    if record.get("pid") != path.stem:
        return None
    if not isinstance(record.get("doc"), dict):
        return None
    return record
