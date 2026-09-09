"""What each version of this tool changed, written for the agent using it.

WHY THE ENTRIES ARE STATEMENTS ABOUT THE INTERFACE AND NOT PROSE. `hammerola
update` replaces the program an agent is in the middle of using, and the
question it has to answer for that agent is not "what is new" but "what did I
know that has stopped being true": a verb that was renamed, a flag that went
away, a default that moved. So an entry is a list of finished sentences of that
shape, one per line, each naming what to write INSTEAD. A release note nobody
can act on is worse than none, because it is read at the one moment the reader
has already been changed under.

WHY IT TRAVELS INSIDE THE ZIPAPP. The client doing the printing is the OLD one,
and an old client's copy of this file knows nothing about the versions that came
after it — printing out of the running program would print nothing, always. So
`update` reads this module out of the archive it has just downloaded and prints
the entries strictly between the version it is and the version it fetched
(`update._read_client`). That is the whole reason the changelog is a module in
the package rather than a document beside it: `client_members()` globs
`hammerola/*.py`, so this rides into the archive with the code it describes and
nothing has to remember to carry it.

VERSIONS ARE READ AS INTEGERS SEPARATED BY DOTS, and `as_tuple` is the one place
that reading happens — the ordering is what decides which entries a reader is
shown and whether a client is behind its hub (`update.refuse_if_behind`), so
both questions are answered by the same three lines.
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

    STRICTLY AFTER THE OLD VERSION AND INCLUDING THE NEW ONE, which is the only
    reading that makes the output true. An entry is filed under the version that
    shipped it, so the running client has already lived with its own entry and
    everything below it, while the version it is moving TO is exactly the one it
    has not seen. Get this off by one and every update either repeats what the
    reader already knew or hides the change it was run for.

    A KEY THAT IS NOT A VERSION IS SKIPPED rather than refused: this dict comes
    out of a downloaded archive that is by definition newer than this code, and
    something added to the file later must not be able to stop the rest of it
    from being printed.
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
