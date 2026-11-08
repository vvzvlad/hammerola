"""`kicadsvc/server.py`, the KiCad sidecar, in process.

Its `ExportHandler` behind a real HTTP server on a free port, a fake
`kicad-cli` first on PATH, and the hub's own client (`src/kicadcli.py`) or a
bare request asking. After every request the scratch directory the sidecar
works in is empty again.
"""

import importlib.util
import os
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

from src import kicadcli

ROOT = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location("kicadsvc_server",
                                               ROOT / "kicadsvc" / "server.py")
server = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(server)

# kicad-cli as the sidecar runs it, `pcb export <fmt> -f -o <out> <flags...>
# <board>`. It prints its command line and its HOME and TMPDIR. FAKE_KICAD says
# what it does: `write` puts "from " and the board's text in <out>; `refuse`
# writes part of it and exits 1; `nothing` writes none.
FAKE_KICAD = """#!/bin/sh
echo "kicad-cli $*"
echo "HOME=$HOME TMPDIR=$TMPDIR"
out=
board=
while [ $# -gt 0 ]; do
  [ "$1" = -o ] && out=$2
  board=$1
  shift
done
case "$FAKE_KICAD" in
  write) { printf 'from '; cat "$board"; } > "$out" ;;
  refuse) printf 'half' > "$out"; echo "Failed to load board"; exit 1 ;;
  nothing) echo "nothing to export" ;;
esac
"""


@pytest.fixture
def sidecar(tmp_path, monkeypatch):
    tools = tmp_path / "bin"
    tools.mkdir()
    (tools / "kicad-cli").write_text(FAKE_KICAD)
    (tools / "kicad-cli").chmod(0o755)
    monkeypatch.setenv("PATH", f"{tools}{os.pathsep}{os.environ['PATH']}")
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(scratch))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.ExportHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    board = tmp_path / "work" / "amp.kicad_pcb"
    board.parent.mkdir()
    board.write_text("(kicad_pcb)")
    try:
        yield SimpleNamespace(url=f"http://127.0.0.1:{httpd.server_port}", board=board,
                              left=lambda: sorted(p.name for p in scratch.iterdir()),
                              does=lambda mode: monkeypatch.setenv("FAKE_KICAD", mode))
    finally:
        httpd.shutdown()
        httpd.server_close()


def post(url, query, body):
    request = urllib.request.Request(f"{url}{server.EXPORT_PATH}?{query}", data=body,
                                     method="POST")
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(request, timeout=30)
    return caught.value.code, caught.value.read().decode()


def test_an_export_is_the_file_kicad_cli_wrote_and_what_it_printed(sidecar):
    sidecar.does("write")
    data, said = kicadcli.export(sidecar.board, "glb", ["--subst-models"],
                                 url=sidecar.url, timeout=30)
    assert data == b"from (kicad_pcb)"
    line = said[0]
    words = line.split()
    assert words[:6] == ["kicad-cli", "pcb", "export", "glb", "-f", "-o"], line
    assert words[7:8] == ["--subst-models"] and len(words) == 9, line
    assert words[8].endswith("/tree/amp.kicad_pcb"), line
    assert sidecar.left() == []


def test_each_export_has_a_home_and_a_tmpdir_of_its_own(sidecar):
    """kicad-cli 10 keeps its instance lock under $TMPDIR and its settings
    under $HOME: two exports sharing either would see each other's."""
    sidecar.does("write")
    seen = []
    for _ in range(2):
        _, said = kicadcli.export(sidecar.board, "step", [], url=sidecar.url, timeout=30)
        board = Path(said[0].split()[-1])
        work = board.parent.parent
        assert said[1] == f"HOME={work / 'home'} TMPDIR={work / 'tmp'}", said
        assert work.parent == Path(tempfile.tempdir), work
        seen.append(work)
    assert seen[0] != seen[1]
    assert sidecar.left() == []


def test_kicad_cli_exiting_non_zero_is_a_422_with_what_it_printed(sidecar):
    sidecar.does("refuse")
    with pytest.raises(kicadcli.KicadError) as caught:
        kicadcli.export(sidecar.board, "step", [], url=sidecar.url, timeout=30)
    assert "kicad-cli pcb export step amp.kicad_pcb failed (HTTP 422)" in str(caught.value)
    assert str(caught.value).endswith("Failed to load board")
    assert sidecar.left() == []


def test_kicad_cli_writing_nothing_is_a_422_too(sidecar):
    sidecar.does("nothing")
    with pytest.raises(kicadcli.KicadError) as caught:
        kicadcli.export(sidecar.board, "glb", [], url=sidecar.url, timeout=30)
    assert "(HTTP 422)" in str(caught.value)
    assert str(caught.value).endswith("nothing to export")
    assert sidecar.left() == []


def test_a_body_that_is_no_tar_is_a_400(sidecar):
    sidecar.does("write")
    status, said = post(sidecar.url, "board=amp.kicad_pcb&format=glb", b"no tar here")
    assert status == 400
    assert said.startswith("the body is not a tar this can unpack")
    assert sidecar.left() == []


def test_a_format_it_does_not_export_is_a_400(sidecar):
    sidecar.does("write")
    status, said = post(sidecar.url, "board=amp.kicad_pcb&format=svg", b"")
    assert (status, said) == (400, "board= and format= (glb|step) are required")
    assert sidecar.left() == []
