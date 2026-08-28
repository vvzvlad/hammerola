"""`python -m src.client` — the entry point that needs no installation.

The console command (`bin/hammerola`, put on PATH by `make client`) ends up
here too, so there is one code path and not two.

THERE IS A THIRD DOOR AND IT IS NOT IN THIS FILE: the hub builds a one-file
zipapp out of `src/client/` and serves it at `/start/hammerola`, for a machine
with no checkout to `curl` (`src/onboarding.CLIENT_MAIN`). A zip's entry point
has to sit at the archive's root, so that one is generated rather than taken
from here — all three are two lines calling `cli.main`, and a test runs the
downloaded file to prove the generated one still does.
"""

import sys

from src.client.cli import main

if __name__ == "__main__":
    sys.exit(main())
