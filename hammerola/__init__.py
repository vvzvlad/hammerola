"""`hammerola` — the tool that puts a model's source on the hub.

The verbs, and what each one may not do, are documented in `hammerola/cli.py`
next to `build_parser`. What is below holds for the package as a whole.

Nothing here reads git to decide what to publish: `commit` publishes the sources
of the directory, git repository or not. `gitsuggest` only prints a `git commit`
line recording what was published.

The client lives in the hub's repository because both share a contract (archive
shape, path alphabet, ceilings, status codes, job states): `tests/client/` drives
the real hub over a real socket, so a contract change that breaks the client fails
at the commit that makes it. The hub also serves this package to clients (`COPY
hammerola/ hammerola/`), which is how the tool updates itself.

One secret for the whole system is what `login` stores and every command
presents. The hub only compares it for equality, so `login` means "remember the
system's password on this machine"; there are no per-person keys.

`VERSION` below is what both sides compare: the hub states it as `client_version`
in its manifest, and `build` and `commit` refuse to publish from an older client.
There are two ways to run the tool: `python3 -m hammerola -C <model dir>` from a
checkout (see `__main__.py`), and the zipapp the hub serves. Only the zipapp can
be replaced by `hammerola update`; a checkout is updated with git.

Stdlib only, in every module: this runs under whatever python3 the author's machine
has. `tests/client/test_stdlib_only.py` enforces it. The cost is one copy of the
hub's ceilings (`limits.py`), checked by a test against the modules that enforce
them; `hammerola/metricsdiff.py` is shared with the build instead of duplicated.
"""

# The tool's version, as a literal rather than package metadata because the zipapp
# is never installed. It is read three ways: imported by the running program, read
# out of the served archive by an older client before it replaces itself
# (`update._member_value`), and imported by the hub for its manifest
# (`src/onboarding.py`).
VERSION = "0.4.0"
