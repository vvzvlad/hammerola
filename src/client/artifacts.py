"""`hammerola artifacts` — the STL, STEP and 3MF a build produced.

A SEPARATE VERB FROM `source`, AND THE REASON IS RIGHTS, NOT CONVENIENCE
(issue #26). A build directory is public: the viewer fetches it, the
download buttons link into it, and every file in it is served to anybody with
the URL, cached for a year. The CODE that produced it is behind the publishing
secret and lives in a tree the file server cannot reach at all. One verb with a
`--code` flag would put those two on the same word and make the difference
something a person has to remember; two verbs make it something they choose.

THE ROUTE THIS USES NEEDS NO SECRET — it is the same URL the build page fetches
— and the command still expects the machine to be logged in, exactly as `status`
does and for the same reason: this tool has one login, and a machine that cannot
say where the hub is has not been set up. What the split buys is not a command
that works without credentials; it is that fetching a model's CODE is a
different word from fetching its printable output, so neither can be done by
accident while meaning the other.

WHAT IT FETCHES IS WHAT `meta.json` DECLARES, and there is no directory listing
anywhere on the service to fetch instead — deliberately: the hub serves files by
name and never enumerates a build. `downloads` is the model's own list of what it
ships (`{label: filename}`, validated at publish time and pointed at real
members), so it is both the complete answer and the curated one. The view files
under `variants` are NOT artefacts and are not fetched: they are the viewer's
tessellation payload, megabytes of it, and nothing outside the browser has a use
for them.

`dev` AND `latest` ARE ACCEPTED HERE, unlike in `source`. This asks a BUILD for
its files and the hub serves those two names like any other build directory —
which is exactly what somebody who just ran `hammerola build` wants.
"""

from pathlib import Path

from src.client import project
from src.client.errors import ClientError
from src.client.hub import Hub
from src.client.limits import DEV_SLOT, SAFE_ID
from src.client.sources import LATEST, SHORT_ID_CHARS, hub_for, scratch_dir

# The build names that are not revision ids and are still perfectly good targets:
# the two pointers. `latest` is passed through to the hub rather than resolved
# first — the file it serves under that name IS the newest revision's, and one
# fetch is better than two.
POINTER_NAMES = (LATEST, DEV_SLOT)


def run(args) -> int:
    """Download one build's declared artefacts. -> exit code."""
    root = project.find_project_root(args.directory)
    pid = project.read_project_id(root)
    hub = hub_for(root)

    name = _build_name(args.revision)
    meta = hub.build_meta(pid, name)
    if meta is None:
        raise ClientError(
            f"the hub has no build {name} for project {pid}.\n"
            f"  `hammerola status` lists what it does have.")

    downloads = meta.get("downloads")
    if not isinstance(downloads, dict) or not downloads:
        # A build with no downloads is a model that exported none — the list is
        # the model's own (`printables()` -> `downloads`), so this is a fact
        # about the model rather than about the hub.
        print(f"{name} declares no downloadable artefacts.")
        print("  `downloads` in its meta.json is empty: the model exported no "
              "STL, STEP or 3MF.")
        return 0

    dest = _destination(args, name)
    dest.mkdir(parents=True, exist_ok=True)

    print(f"{pid}/{name} -> {dest}")
    total = 0
    for label in sorted(downloads):
        filename = downloads[label]
        if not isinstance(filename, str) or "/" in filename or \
                filename.startswith("."):
            # The hub validated this map at publish time, so this cannot happen
            # from a build it published — which is why it is a refusal rather
            # than a skip: a name of this shape means the answer did not come
            # from where it should have.
            raise ClientError(
                f"{name} declares a download {label!r} pointing at "
                f"{filename!r}, which is not a file name a build can serve.")
        body = hub.build_file(pid, name, filename)
        if body is None:
            raise ClientError(
                f"{name} declares {label} -> {filename}, and the hub does not "
                f"serve it.\n"
                f"  The build is there and the file is not; nothing was left "
                f"half-written.")
        target = dest / filename
        try:
            target.write_bytes(body)
        except OSError as error:
            raise ClientError(f"cannot write {target}: {error}") from error
        total += len(body)
        print(f"  {label:<12} {filename}  {len(body) / 1e3:.1f} kB")

    print(f"  {len(downloads)} files, {total / 1e6:.2f} MB")
    return 0


def _build_name(given: str) -> str:
    """The build to ask for: a pointer name, or a revision id."""
    if given in POINTER_NAMES:
        return given
    if not SAFE_ID.match(given or ""):
        raise ClientError(
            f"{given!r} is neither a revision id nor one of {', '.join(POINTER_NAMES)}.\n"
            f"  `hammerola status` lists this project's revisions.")
    return given


def _destination(args, name: str) -> Path:
    """Where the files land: `-o DIR`, or `artifacts-<name>` beside the caller.

    A directory of its own under `.hammerola/`, and NOT the working copy, for
    the reason `sources.SCRATCH_DIR` gives: an STL written next to model.py is a
    file the next push would try to publish. Unlike `source` this does not
    refuse a directory that already has something in it — the files are named by
    the build and fetching the same build twice writes the same names, so
    re-running is an update rather than a merge of two different things.
    """
    base = Path(args.directory).expanduser() if args.directory else Path.cwd()
    given = getattr(args, "output", None)
    if given:
        dest = Path(given).expanduser()
    else:
        short = name if name in POINTER_NAMES else name[:SHORT_ID_CHARS]
        dest = scratch_dir(base, f"artifacts-{short}")
    return dest if dest.is_absolute() else (base / dest).resolve()
