"""A stand-in for the KiCad sidecar (`kicadsvc/server.py`): its route, its answers.

The test image has no KiCad, so what a test gets back are exports the real
sidecar wrote once from `fixtures/kicad/board.kicad_pcb` (kicad/kicad:10.0.6-full,
the flags of each are in the test that asks for it):

    board.glb      the model's GLB (`kicadboard.GLB_FLAGS`)
    board.step     the bare laminate (`kicadboard.STEP_FLAGS`)
    document.glb   the document's GLB (`docsbuild.GLB_FLAGS`)

The board: R1 (R_0603, F, 90 deg, nets VCC/SIG), C1 (C_0603, B, 30 deg,
SIG/GND), R2 (R_0603, F, DNP), H1 (M3 mounting hole, unplated), J1 (1x02 pin
header, F, VCC/GND), J2 (the same, DNP), H2 (M2 mounting hole, plated), a
track on each side through one via, Edge.Cuts 100,100-140,115 mm with a
3 mm round cut-out at 137.5,111.
"""

import io
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "kicad"
BOARD = FIXTURES / "board.kicad_pcb"


class KicadStub:
    """`answers` maps (format, flags) to a fixture's name, or to (status, text)
    for a refusal; a request it has no answer for is a 400. Each request is
    recorded as (format, flags, board, names in its tar)."""

    def __init__(self, answers):
        self.answers = {(fmt, tuple(flags)): answer
                        for (fmt, flags), answer in answers.items()}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                query = parse_qs(urlsplit(self.path).query)
                body = self.rfile.read(int(self.headers["Content-Length"]))
                with tarfile.open(fileobj=io.BytesIO(body)) as tar:
                    names = sorted(tar.getnames())
                fmt = query["format"][0]
                flags = tuple(query.get("flag", []))
                stub.requests.append((fmt, flags, query["board"][0], names))
                answer = stub.answers.get((fmt, flags))
                if answer is None:
                    self._send(400, b"the stub has no such export")
                elif isinstance(answer, tuple):
                    self._send(answer[0], answer[1].encode())
                else:
                    self._send(200, _answer(fmt, (FIXTURES / answer).read_bytes()))

            def _send(self, status, data):
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self._server.server_address[1]

    def __enter__(self):
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.01},
                                        daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def _answer(fmt, data):
    """The sidecar's 200: a tar of the export and kicad-cli's output."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tar:
        for name, content in ((f"export.{fmt}", data),
                              ("output.txt", b"Could not add 3D model for U9.\n")):
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return out.getvalue()
