"""The refusal a command makes about the local machine.

`config.py`, `project.py` and `hub.py` each own an exception for their
subject. The other verbs (`connect`, `build`, `artifacts`, `diff`, `log`,
`rename`, `rm`) all fail about their arguments, the repository or the output
directory, and `cli.main` handles them identically, so they share this one
class.

Every message is a finished sentence: `main` prints it with only the program's
name added.
"""


class ClientError(Exception):
    """A command cannot do what it was asked, and the message says why."""
