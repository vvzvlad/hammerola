"""`python3 -m hammerola` — the entry point that needs no installation.

Run it from the checkout root and pass the model directory as an argument: `-m`
resolves `hammerola` against the current directory, so inside a model directory
the same line fails with `No module named 'hammerola'`. The two working forms:

    cd <this checkout> && python3 -m hammerola -C <model dir> status
    cd <model dir> && PYTHONPATH=<this checkout> python3 -m hammerola status

`-C` is a flag of the tool (`cli.py`), applied after the interpreter has found
this package.

The other entry point is the one-file zipapp the hub builds from `hammerola/` and
serves at `/start/hammerola` (`src/onboarding.CLIENT_MAIN`). A zip's entry point
must sit at the archive root, so that one is generated; both are two lines calling
`cli.main`, and a test runs the downloaded file.

Use the machine's `python3`, not the checkout's `.venv`: the package is stdlib
only, and a path into a virtualenv breaks when the checkout moves.
"""

import sys

from hammerola.cli import main

if __name__ == "__main__":
    sys.exit(main())
