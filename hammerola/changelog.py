"""What each version of this tool changed, written for the agent using it.

`hammerola update` replaces the program an agent is in the middle of using, so an
entry answers "what did I know that is no longer true": one finished sentence per
renamed verb, removed flag or moved default, each naming what to write instead.

It is a module in the package so it travels inside the zipapp (`client_members()`
globs `hammerola/*.py`): the old client doing the printing reads this module out
of the archive it just downloaded (`update._read_client`), since its own copy
knows nothing about later versions.

Versions are dot-separated integers, parsed only by `as_tuple`; the same ordering
decides which entries are shown and whether a client is behind its hub
(`update.refuse_if_behind`).
"""

# {version: (statement, ...)}. The version is the one that SHIPPED the change,
# which is what makes `between` exclusive at the bottom: a client has already
# lived with its own entry. The dict's order decides nothing — `between` sorts —
# and `tests/client/test_update.py` holds the shape of what is in here, because
# a value that is a bare string rather than a tuple of them would be printed one
# character per line by a client too old to have been written against it.
ENTRIES = {
    # The first version this tool states. Nothing before it carried a number, so
    # nothing before it had `update` either: a client that can print this line
    # is 0.1.0 or newer by construction.
    "0.1.0": (
        "`hammerola update` writes the hub's copy of this tool over the file it "
        "is running from, and prints what changed.",
        "`build` and `commit` refuse to publish from a client older than the "
        "one the hub serves, and name both versions.",
    ),
    "0.2.0": (
        "The hub's password travels in `X-Hammerola-Token`, no longer in "
        "`Authorization: Bearer`, which the hub now refuses, and a refused "
        "token is answered 403 rather than 401: a script that calls the hub "
        "with curl sends `-H \"X-Hammerola-Token: ...\"`.",
        "Behind a password proxy (Traefik basicAuth and the like), "
        "`HUB_BASIC_AUTH=login:password` is sent to it as `Authorization: "
        "Basic` on every request, and a 401 is that proxy refusing it; "
        "`hammerola login` notices such a proxy, asks its login and password, "
        "and stores this setting.",
    ),
    "0.3.0": (
        "`hammerola skill update` installs the skill as a DIRECTORY — "
        "`~/.claude/skills/hammerola/`, an entry `SKILL.md` and the "
        "`references/` it points at — takes `--path DIR` where it took a file, "
        "and removes from an installation of its own the files the new version "
        "no longer ships.",
        "The hub serves the skill at `/start/skill.tar.gz` and no longer at "
        "`/start/skill.md`, so a client older than this one cannot install or "
        "update it at all.",
    ),
}


def as_tuple(version):
    """`"0.2.10"` -> `(0, 2, 10)`, or None when that is not a version at all.

    None rather than a raise, because both callers are reading a number written
    somewhere ELSE — the manifest of a hub that may be newer than this tool, and
    the changelog inside an archive it has just downloaded. Neither can order a
    version it cannot parse, and `update.refuse_if_behind` says what "cannot
    order" is worth there: the push goes ahead rather than being blocked by a
    string this tool did not understand.
    """
    if not isinstance(version, str):
        return None
    parts = version.split(".")
    if not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def between(entries, old, new):
    """The entries after `old` and up to `new`, oldest first.

    -> [(version, lines), ...]

    Strictly after `old` and including `new`: an entry is filed under the version
    that shipped it, so the running client already knows its own entry.

    A key that is not a version is skipped rather than refused, because the dict
    comes from a newer downloaded archive.
    """
    here, there = as_tuple(old), as_tuple(new)
    if here is None or there is None:
        return []
    found = []
    for version, lines in entries.items():
        at = as_tuple(version)
        if at is not None and here < at <= there:
            found.append((at, version, lines))
    return [(version, lines) for _at, version, lines in sorted(found)]
