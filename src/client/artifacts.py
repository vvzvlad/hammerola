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
name and never enumerates a build. THREE MAPS DECLARE, and this takes all three:

  * `downloads` — `{label: filename}`, one entry per file of one PART, exactly
    the three the model's `printables()` produced for each;
  * `overview` — `{stem: filename}`, the two meshes that are about the whole
    build rather than about a part: `assembled.stl`, and `print.stl` where the
    project has a `print` view;
  * `previews` — `{stem: filename}`, every picture the build rendered: one per
    part, one of the assembly, one of the plate.

THIS COMMAND IS THE ONLY READER OF THE LAST TWO. Only `downloads` is drawn as
buttons on the build page — a picture is looked at rather than downloaded, and
a `print.stl` button on a public page would offer a plate that may legitimately
carry a mock of a purchased part — so `overview` and `previews` exist to be
FETCHED and for nothing else. That is exactly why they exist at all: while
`downloads` was the one declaration channel, "a client may fetch this" and "the
page draws a button for this" were the same sentence, so a per-part picture
could not be declared without ten buttons appearing under it, and an agent was
left assembling its URL by hand.

The view files under `variants` are NOT artefacts and are not fetched: they are
the viewer's tessellation payload, megabytes of it, and nothing outside the
browser has a use for them.

`dev` AND `latest` ARE ACCEPTED HERE, unlike in `source`. This asks a BUILD for
its files and the hub serves those two names like any other build directory —
which is exactly what somebody who just ran `hammerola build` wants.
"""

from pathlib import Path

from src.buildnames import unservable_reason
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

# The three maps of `meta.json` that name a file this command fetches, in the
# order their entries are printed. See the module docstring for what each is;
# what matters here is that the list is closed — `variants` is deliberately not
# on it. A fourth map on the hub side is a change to TWO places, not to this
# line alone: the message in `run` below names all three by hand, and
# `test_a_build_declaring_nothing_at_all_says_so_and_still_succeeds` pins that
# sentence as a substring — so a map added here and nowhere else would be
# fetched correctly while the one message about them stayed wrong, with the
# suite green.
DECLARING_FIELDS = ("downloads", "overview", "previews")


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

    declared = _declared(meta)
    if not declared:
        # ALL THREE MAPS EMPTY, which no build the hub published can be:
        # `printables()` has to return at least one part, so `downloads` alone
        # is never empty — and `overview` carries `assembled.stl` on top of
        # that. So this is the same kind of answer as the malformed name below:
        # not from where it should have come. It stays a message and a zero all
        # the same, because the answer is well formed and merely empty — there
        # is nothing here to download and nothing that could be downloaded
        # WRONGLY, which is what the refusal below is for.
        print(f"{name} declares no downloadable artefacts.")
        print("  `downloads`, `overview` and `previews` in its meta.json are "
              "all empty, and a build the hub published exports at least one "
              "part, so this answer did not come from one.")
        return 0

    dest = _destination(args, name)
    dest.mkdir(parents=True, exist_ok=True)

    print(f"{pid}/{name} -> {dest}")
    total = 0
    for field, label, filename in declared:
        # THE HUB'S OWN RULE, IMPORTED RATHER THAN RESTATED (`src/buildnames.py`).
        # The hub validated these maps at publish time, so this cannot happen
        # from a build it published — which is why it is a refusal rather than a
        # skip: a name of this shape means the answer did not come from where it
        # should have. That is also why the rule has to be the hub's whole one
        # and not an approximation of it: the case this defends against is a
        # dishonest or corrupted answer, and against that case the two
        # conditions that used to stand here — `/` and a leading dot — caught
        # nothing of what the check is FOR. The non-printable clause names this
        # very command as its beneficiary: the name is printed on the line below
        # and then written to the author's disk, so a U+202E in it reverses the
        # report of what was just saved.
        reason = unservable_reason(filename)
        if reason is not None:
            raise ClientError(
                f"{name} declares a {field} entry {label!r} pointing at "
                f"{filename!r}, which {reason}.\n"
                f"  That is not a name a build can serve, so this answer did "
                f"not come from a build the hub published.")
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

    print(f"  {len(declared)} files, {total / 1e6:.2f} MB")
    return 0


def _declared(meta: dict) -> list:
    """Every file the build declares, as `(field, key, filename)`, once each.

    ONE PASS OVER THE THREE MAPS rather than a merge of them: their keys are
    minted independently, so two of them can carry the same key for different
    files — `previews` is keyed by a part's stem, and a single-printable build's
    `downloads` key is the bare `stl` — and a merged dict would silently drop
    one. The field travels with the entry so a refusal can say which map the
    unusable name was in.

    Deduplicated BY FILENAME, because nothing stops two maps naming one file and
    the cost of not noticing is fetching the same bytes twice and reporting a
    count nobody can reconcile with the directory. A filename that is not a
    string skips the dedup and is refused by the caller on sight.
    """
    found = []
    seen = set()
    for field in DECLARING_FIELDS:
        entries = meta.get(field)
        if not isinstance(entries, dict):
            continue
        for key in sorted(entries, key=str):
            filename = entries[key]
            if isinstance(filename, str):
                if filename in seen:
                    continue
                seen.add(filename)
            found.append((field, str(key), filename))
    return found


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
