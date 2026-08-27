"""`python -m src.client` — the entry point that needs no installation.

The console command (`bin/hammerola`, put on PATH by `make client`) ends up
here too, so there is one code path and not two.
"""

import sys

from src.client.cli import main

if __name__ == "__main__":
    sys.exit(main())
