"""The refusal a command makes about the local machine.

ONE CLASS FOR THE COMMANDS THAT FETCH, and it is a deliberate departure from the
one-exception-per-module shape of `config.py`, `project.py`, `pack.py` and
`hub.py`. Those four each own a SUBJECT — the machine's settings, the working
directory, the archive, the wire — and a caller can act differently on each. The
verbs added later (`source`, `artifacts`, `diff`, `log`, `rename`, `rm`) fail
about the same subject: the arguments they were given and the directory they were
told to write into. Five classes for that would be five names nothing ever
catches separately, since `cli.main` funnels every one of them into the same
sentence on stderr and the same exit code.

Every message is a finished sentence, sometimes several lines of one, because
that is what `main` prints — it adds the program's name and nothing else.
"""


class ClientError(Exception):
    """A command cannot do what it was asked, and the message says why."""
