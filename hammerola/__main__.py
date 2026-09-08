"""`python3 -m hammerola` — the entry point that needs no installation.

RUN FROM THE CHECKOUT ROOT, AND THE MODEL DIRECTORY IS AN ARGUMENT. `-m`
resolves `hammerola` against the directory the command was started in, so out of
a checkout this door opens where the repository is and nowhere else — inside a
model directory the same line is `No module named 'hammerola'` unless the
distribution is installed, which is the one mistake this file is read after
making. Both working forms, and they are the same command from two directions:

    cd <this checkout> && python3 -m hammerola -C <model dir> status
    cd <model dir> && PYTHONPATH=<this checkout> python3 -m hammerola status

`-C` is a flag of the tool (`cli.py`), applied AFTER the interpreter has found
this package, which is why it can point at a directory the import never had to
see. The other two doors have neither problem: they bring the package with them,
so they run from anywhere and need no `-C` at all.

THIS IS THE CHECKOUT'S DOOR, and there are three. Neither of the others is in
this file: `pyproject.toml` installs this package as the distribution
`hammerola`, with a script of the same name, and the hub builds a one-file
zipapp out of `hammerola/` and serves it at `/start/hammerola`, for a machine
with neither a checkout nor an install (`src/onboarding.CLIENT_MAIN`). A zip's
entry point has to sit at the archive's
root, so that one is generated rather than taken from here — both are two lines
calling `cli.main`, and a test runs the downloaded file to prove the generated
one still does.

There used to be one more, `bin/hammerola`, and it is gone rather than
overlooked: it existed to be symlinked onto PATH by `make client`, and the hub's
own bootstrap writes to that same name with `curl -o`, which follows the symlink
and overwrites the file in the repository. It was never part of the zipapp
either — `onboarding.client_members()` carries this package and nothing above
it.

`python3` and not the checkout's `.venv`, wherever this is written down: every
module of this package imports the standard library and nothing else, on
purpose, so the machine's own interpreter is enough — and pointing an entry
point at a virtualenv is pointing it at a path that breaks the moment the
checkout moves.
"""

import sys

from hammerola.cli import main

if __name__ == "__main__":
    sys.exit(main())
