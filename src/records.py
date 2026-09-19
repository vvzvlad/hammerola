"""What the comment queue and the proposal store both do to a record.

`src/proposals.py` arrived as a copy of `src/comments.py` and kept the copy's
shape: one printable-line check, one printable-body check, one temp-file sweep
and two constants, written out twice and held by nothing. The two STORES stay
apart — a queue with attachments is not one document per project (SPEC 7A.3),
and that split is a decision rather than an accident — but these four answers
are about the BYTES on the way in and about the tree on the way out, not about
either model, so nothing kept the two copies in step. Two copies of one rule are
free to disagree in silence, which is the failure `hammerola/buildnames.py`
exists to end; this is the same move on the same kind of rule.

THE REFUSAL CLASS IS A PARAMETER, not a shared one. `CommentError` and
`ProposalError` are separate subclasses of `HttpRefusal` because the code that
catches them cares WHICH door refused (`src/errors.py`), so each helper here
raises the class its caller hands it and every status and message stays exactly
where it was.

THE CATEGORY SCAN IS NOT WRITTEN OUT HERE EITHER. `buildnames.first_nonprintable`
is the one copy of that rule, imported across the package boundary the way
`src/render.py` imports it — the hub imports the client's module, never the
other way round.
"""

from pathlib import Path

from loguru import logger

from hammerola.buildnames import first_nonprintable
from src.errors import HttpRefusal

# One line of a JSON field: a comment's view id, part name and resolve note, a
# proposal's `published` stamp and its `view`. Generous enough for a nested part
# path like `/assembly/bracket/screw_3`, short enough that a queue entry stays
# readable — it is here so that a hand-written request cannot put a novel in a
# field that is printed on one line.
MAX_FIELD_CHARS = 200

# Temp-file prefix left behind by an interrupted write, swept at startup. The
# same prefix `store` uses, so one sweep rule covers all three trees.
WIP_PREFIX = ".wip-"


def one_line(value, field: str, error: type[HttpRefusal]) -> str:
    """A printable single-line string, or an `error` naming the field.

    ONE LENGTH FOR ALL FIVE FIELDS, and no parameter for it: both copies this
    replaced hard-coded the same 200, every caller wants that, and a limit
    nobody passes differently is a knob that only makes the two doors free to
    drift apart again — which is the thing this module exists to stop.
    """
    if not isinstance(value, str):
        raise error(422, f"`{field}` must be a string")
    if len(value) > MAX_FIELD_CHARS:
        raise error(
            422, f"`{field}` is longer than {MAX_FIELD_CHARS} characters")
    if first_nonprintable(value) is not None:
        raise error(422, f"`{field}` contains a non-printable character")
    return value


def check_body_printable(value: str, error: type[HttpRefusal]) -> None:
    """Refuse the control characters in a `text` field, or return quietly.

    Newline and tab survive, because a body is prose or a table and people press
    Enter. Everything else in Unicode category C goes — U+202E among them, which
    reverses the text around it in any terminal or editor the agent reads the
    record in. The two survivors are taken OUT of the string rather than skipped
    inside a loop of our own: the loop is `first_nonprintable`'s, and the whole
    point is that there is one of it.
    """
    if first_nonprintable(
            value.replace("\n", "").replace("\t", "")) is not None:
        raise error(422, "`text` contains a non-printable character")


def sweep_leftovers(root: Path, pattern: str) -> None:
    """Drop temp files an earlier run died in the middle of writing.

    They are dot-prefixed, so nothing lists or serves them and nothing else
    would ever notice they are there. The PATTERN belongs to the caller because
    the two trees are shaped differently — a directory per project under
    `<data>/comments`, one file per project under `<data>/proposals`.
    """
    for path in root.glob(pattern):
        try:
            path.unlink()
        except OSError as error:
            logger.warning(f"could not sweep leftover {path}: {error}")
            continue
        logger.info(f"swept leftover {path}")
