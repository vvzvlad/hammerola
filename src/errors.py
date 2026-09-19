"""The refusal every door of the service answers with.

`store`, `comments` and `proposals` each carried their own copy of this class:
identical bodies, different docstrings. They are three subclasses of one base
now rather than one shared name, because the code that catches them cares WHICH
door refused — `app.py` answers a publish, a comment and a proposal on separate
routes, and an `except` that could not tell them apart would answer one with
another's status.

The status travels WITH the refusal so `app.py` does not classify a failure a
second time, and the message is one that is safe to hand back to the caller: a
422 exists so that whoever pushed can see WHICH file was missing.

This module imports nothing else from the service, deliberately. Any module may
raise one of these without the import edge that a shared base living inside
`store` would force on everything that needs to refuse.
"""


class HttpRefusal(Exception):
    """A refusal that carries the HTTP status it must be answered with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class PublishError(HttpRefusal):
    """A push the hub would not publish."""


class CommentError(HttpRefusal):
    """A comment the queue would not store."""


class ProposalError(HttpRefusal):
    """A proposal the store would not keep."""
