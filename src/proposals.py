"""The one Proposal a project has, and the guards on its write path.

Somebody holding the edit token opens a published model and assembles a rough
parametric body over it in the browser panel — the motor the bracket has to
clear, the wall it bolts to, a part of the build dragged to where they want it.
Until now that document lived in page state and nowhere else
(`ui/src/proposal.js` says so at the head of the file), so a reload lost every
number in it. This is where it goes instead:

    <data>/proposals/<pid>.json        the whole proposal, one file per project

ONE PER PROJECT, NO HISTORY AND NO RETENTION. A second write REPLACES the first
rather than appending to it, and the only thing that removes one is somebody
asking — `DELETE /api/v1/proposals/<pid>`, or removing the project it belongs
to. That is the same answer everything else on this volume gives (SPEC 5.3);
what is different here is that a proposal is the person's working document, so
"replaces" is what they mean by saving it, and a pile of previous versions would
be a mechanism nobody asked for.

DELIBERATELY OUTSIDE THE BUILD DIRECTORY, for the two reasons the comment queue
gives (SPEC 7A.3), and both stand on their own here too. ACCESS: a build
directory is served to anybody who has the URL, with a year of `immutable`, so a
proposal placed in one would be public and irrevocably cached — and this is read
and written under EDIT_TOKEN. LIFETIME: a proposal is about the PROJECT and not
about one revision. The reader goes on editing the same document across
rebuilds, and the `published` stamp it carries is a NOTE about which build the
moves were measured on, not the address the document lives at.

THE DOCUMENT IS STORED OPAQUELY AND ITS NODES ARE NOT CHECKED, which is a
decision rather than an omission. What `doc` holds is `{version, units, nodes}`
as `ui/src/proposal.js` builds it, and the author of a proposal is the owner of
the project, writing through their own browser under the one secret of the
system: there is no adversary on this path to be defended against. A second
definition of the document in Python would be a schema that has to stay in step
with that module forever, and the benefit nobody can name is exactly the shape
AGENTS.md warns about — «не выдумал ли я противника».

WHAT IS CHECKED IS ABOUT THE BYTES AND ABOUT THIS STORE, never about the sender,
which is the same line `src/comments.py` draws:

  * the request body has a ceiling (`proposal_max_body_bytes`), because an
    unbounded parse and an unbounded store are not made safe by a credential;
  * `doc` must be a JSON object, `published` and `view` one printable line each
    or null — enough that what comes back off the volume is the shape every
    reader here already assumes;
  * `text` must be a string or null, and PRINTABLE THE WAY A COMMENT'S BODY IS
    (`comments._body_text`): newline and tab survive, because the projection is
    a table of several lines, and every other character in Unicode category C
    is refused — U+202E among them, which reverses the text around it in any
    terminal. This is the field `hammerola proposal` prints straight into the
    agent's terminal, and the same projection pasted into a comment is refused
    there, so accepting it here would be the same bytes going in through the
    other door;
  * NO NaN AND NO INFINITY ANYWHERE IN THE PAYLOAD. `json.loads` accepts all
    three by default, `json.dumps(..., allow_nan=False)` then refuses to write
    them, and the bad number would surface as a 500 on a request that had
    already been accepted. This is not a defence against anybody: it is our own
    drag arithmetic producing a number that cannot be read back — the hazard
    `comments._numbers` records for a camera — so it is refused at the door
    with a 422 instead.
"""

import json
import threading
from pathlib import Path

from loguru import logger

from src.errors import ProposalError
from src.records import (WIP_PREFIX, check_body_printable, one_line,
                         sweep_leftovers)
from src.safeio import read_regular_text
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

    THE THREE LITERALS ABOVE ARE NOT THE ONLY WAY TO SPELL AN INFINITY, and this
    is the half a `parse_constant` alone misses: `1e999` is an ordinary JSON
    number, it never reaches that hook, and `float()` turns it into `inf` just
    the same. Refusing it here is what makes "no infinity in the payload" true
    at the door rather than nearly true — the alternative is a ValueError out of
    `json.dumps` further down, i.e. the 500 this module exists to avoid.
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

    `records.check_body_printable`, which the comment queue shares, and
    deliberately NOT `records.one_line`. Newline and tab have to survive — the
    projection is a table the panel aligned into columns, so a single-line check
    would refuse every multi-line document and the browser's save would start
    failing silently. Everything else in Unicode category C goes, U+202E
    included: this is the one field of the record that `hammerola proposal`
    prints straight into the agent's terminal, where that codepoint reverses the
    text around it.
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

        Two names for one line because the two callers mean different things by
        it: `remove` is the reader putting their own document away, while this
        is the project going and taking everything about it with it — the name
        `CommentStore.remove_project` already carries, so app.py composes the two
        stores the same way rather than special-casing this one.
        """
        return self.remove(pid)


def _read_record(path: Path) -> dict | None:
    """One proposal off the volume, or None if what is there is not one.

    A file that fails these checks reads as ABSENT rather than raising: the
    route that reads it answers 404 for a project that has no proposal anyway,
    and a damaged file must not turn that into a 500 on a page somebody has
    open.

    A MISSING FILE IS ABSENCE AND SAYS NOTHING, which is the one arm that does
    not warn. `comments._read_record` is handed paths a glob just produced, so
    for it "not there" is a race and worth a line; this one is handed a path
    CONSTRUCTED from the id in the URL, and most projects have no proposal at
    all — so the warning fired on every page load of every project nobody has
    drawn on, naming a file that was never supposed to exist.

    EVERYTHING ELSE GOES ON WARNING, because a damaged file, a directory or a
    fifo where the record should be is real and this line is the only sign of
    it anywhere.

    THROUGH `safeio` FOR THE REASON `comments._read_record` GIVES: this path is
    under `data/`, a build can write anywhere on that volume, and a plain
    `open()` on a fifo planted there parks the request thread for good.
    `NotRegularFile` is an `OSError`, so it lands in the arm already written.
    """
    try:
        record = json.loads(read_regular_text(path))
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
