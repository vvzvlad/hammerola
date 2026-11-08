"""kicad-cli, asked of the KiCad sidecar (`kicadsvc/server.py`) over HTTP.

The hub's image carries no KiCad; the sidecar does, and this is its client,
standard library only: the hub imports it for a document's GLB
(`src/docsbuild.py`) and the build process for the board a model places
(`src/cadbuild/kicadboard.py`). The sidecar's address is the `KICAD_URL`
setting; the build process reads it from its environment, where
`buildproc.runner.child_environment` puts it.

What travels is the board, its project (`<stem>.kicad_pro`) when there is one,
and the 3D models the board takes from its own directory (`${KIPRJMOD}/...`),
with the STEP or IGES beside each VRML one, which `--subst-models` puts in its
place; the stock library is in the sidecar's image.
"""

import hashlib
import http.client
import io
import json
import os
import posixpath
import re
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

URL_ENV = "KICAD_URL"
# The directory a build keeps its exports in, for `export_cached`: the build
# process and its check units' workers, which import model.py again each, ask
# for one board's exports once (`buildproc.runner.child_environment`).
CACHE_ENV = "KICAD_EXPORT_CACHE"
EXPORT_PATH = "/export"
OUTPUT_NAME = "output.txt"

# A 3D model the board takes from its own directory, as KiCad writes it; a
# string in a KiCad file escapes `"` and `\` with a backslash.
PROJECT_MODEL = re.compile(r'\(model\s+"\$\{KIPRJMOD\}/((?:[^"\\]|\\.)*)"')
ESCAPED = re.compile(r"\\(.)")
# What `--subst-models` looks for beside a VRML model, by its stem.
VRML = ".wrl"
SUBSTITUTES = (".step", ".stp", ".iges", ".igs")

# How much of kicad-cli's output a failure carries.
TAIL_LINES = 20


class KicadError(RuntimeError):
    """The board could not be exported: kicad-cli refused it (the message ends
    with what it printed), or the sidecar did not answer."""


def export(board, fmt, flags, *, url, timeout=None):
    """`kicad-cli pcb export <fmt> <flags> <board>`, run by the sidecar at `url`.

    -> (the exported file's bytes, kicad-cli's output as a list of lines).
    Raises KicadError with the last lines of kicad-cli's output when it fails,
    and with `KICAD_URL` and the error when the sidecar cannot be reached or
    breaks off. `timeout` bounds the wait in the hub's process; the build
    process passes none, its wall clock is the bound.
    """
    data, said, _ = export_cached(board, fmt, flags, url=url, cache=None,
                                  timeout=timeout)
    return data, said


def export_cached(board, fmt, flags, *, url, cache, timeout=None):
    """`export`, with the sidecar's answer kept in the directory `cache` (None:
    nothing kept), under a hash of all the request carries -- the tar, the
    board's name, the format and the flags -- so the same request again is
    answered from there. A build names its own directory (`CACHE_ENV`).

    -> (the exported file's bytes, kicad-cli's lines, whether it was cached).
    """
    board = Path(board)
    body = _pack(board)
    kept = None
    if cache is not None:
        request = json.dumps([board.name, fmt, list(flags)]).encode("utf-8")
        kept = Path(cache) / hashlib.sha256(request + b"\0" + body).hexdigest()
        if kept.is_file():
            return (*_unpack(kept.read_bytes(), fmt), True)
    answer = _ask(body, board.name, fmt, flags, url=url, timeout=timeout)
    if kept is not None:
        kept.parent.mkdir(parents=True, exist_ok=True)
        # Whole or not at all: a reader in another process sees either.
        with tempfile.NamedTemporaryFile(dir=kept.parent, delete=False) as part:
            part.write(answer)
        os.replace(part.name, kept)
    return (*_unpack(answer, fmt), False)


def _ask(body, name, fmt, flags, *, url, timeout):
    """The sidecar's answer to one export: the tar it sends back."""
    query = urllib.parse.urlencode(
        [("board", name), ("format", fmt)] + [("flag", flag) for flag in flags])
    request = urllib.request.Request(
        f"{url.rstrip('/')}{EXPORT_PATH}?{query}", data=body,
        method="POST", headers={"Content-Type": "application/x-tar"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as answer:
            return answer.read()
    except urllib.error.HTTPError as error:
        said = error.read().decode("utf-8", "replace").splitlines()
        raise KicadError(
            f"kicad-cli pcb export {fmt} {name} failed "
            f"(HTTP {error.code}):\n" + "\n".join(said[-TAIL_LINES:])) from None
    except (OSError, http.client.HTTPException) as error:
        # URLError is an OSError: refused, no such host, timed out, reset.
        reason = getattr(error, "reason", None) or error
        raise KicadError(
            f"the KiCad service at {URL_ENV}={url} did not answer the export "
            f"of {name}: {reason}") from None


def _unpack(answer, fmt):
    """(the exported file, kicad-cli's lines) out of the sidecar's tar."""
    with tarfile.open(fileobj=io.BytesIO(answer)) as tar:
        data = tar.extractfile(f"export.{fmt}").read()
        output = tar.extractfile(OUTPUT_NAME).read()
    return data, output.decode("utf-8", "replace").splitlines()


def _pack(board: Path) -> bytes:
    """The tar the sidecar unpacks: the board, its project and its own models,
    at their paths relative to the board's directory."""
    here = board.parent
    names = [board.name]
    project = board.with_suffix(".kicad_pro")
    if project.is_file():
        names.append(project.name)
    text = board.read_text(encoding="utf-8", errors="replace")
    for found in PROJECT_MODEL.findall(text):
        name = posixpath.normpath(ESCAPED.sub(r"\1", found))
        stem, suffix = posixpath.splitext(name)
        candidates = [name] + ([stem + other for other in SUBSTITUTES]
                               if suffix.lower() == VRML else [])
        for candidate in candidates:
            if (candidate not in names and not candidate.startswith("../")
                    and (here / candidate).is_file()):
                names.append(candidate)
    packed = io.BytesIO()
    with tarfile.open(fileobj=packed, mode="w") as tar:
        for name in names:
            tar.add(here / name, arcname=name)
    return packed.getvalue()
