#!/usr/bin/env python3
"""kicad-cli behind HTTP: the hub's KiCad exports, run in a container of their own.

The hub's image carries no KiCad (the official image is 7.5 GB); this sidecar is
that image plus this file, standard library only, on the image's own python3.

    POST /export?board=<path in the tar>&format=glb|step&flag=<kicad-cli flag>...
    body: an uncompressed tar of the board's files

The tar is unpacked into a fresh directory and

    kicad-cli pcb export <format> -f -o <out> <flags...> <board>

runs there with HOME and TMPDIR inside that directory, so no request sees
another's KiCad settings or its instance lock: kicad-cli 10 keeps the lock at
$TMPDIR/org.kicad.kicad/instances/kicad-cli-10.0, and a second run that opens it
while the first is still writing it prints "Invalid lock file".

The answer is 200 with a tar of `export.<format>` and `output.txt` (what
kicad-cli printed), 422 with kicad-cli's output as text when it exits non-zero
or writes nothing, 400 for a request that cannot be read. The directory is
removed before the answer goes out, so a client holding one leaves nothing.

No auth: it listens on the stack's internal network, where only the hub is.
The hub's client is src/kicadcli.py.
"""

import io
import os
import shutil
import subprocess
import tarfile
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PORT = 8080
EXPORT_PATH = "/export"
FORMATS = ("glb", "step")
OUTPUT_NAME = "output.txt"


class ExportHandler(BaseHTTPRequestHandler):

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != EXPORT_PATH:
            self._answer(404, f"POST {EXPORT_PATH} is the one route".encode())
            return
        query = parse_qs(url.query)
        board = query.get("board", [""])[0]
        fmt = query.get("format", [""])[0]
        flags = query.get("flag", [])
        if not board or fmt not in FORMATS:
            self._answer(400, f"board= and format= ({'|'.join(FORMATS)}) "
                              f"are required".encode())
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        work = tempfile.mkdtemp(prefix="kicadsvc-")
        try:
            answer = self._export(work, body, board, fmt, flags)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self._answer(*answer)

    def _export(self, work, body, board, fmt, flags):
        """-> (status, body[, content type]) of the answer."""
        tree = os.path.join(work, "tree")
        home = os.path.join(work, "home")
        tmp = os.path.join(work, "tmp")
        os.mkdir(home)
        os.mkdir(tmp)
        try:
            with tarfile.open(fileobj=io.BytesIO(body)) as tar:
                # `data`: no absolute path, no `..`, no link out of the tree.
                tar.extractall(tree, filter="data")
        except (tarfile.TarError, OSError) as error:
            return 400, f"the body is not a tar this can unpack: {error}".encode()
        out = os.path.join(work, "export." + fmt)
        done = subprocess.run(
            ["kicad-cli", "pcb", "export", fmt, "-f", "-o", out, *flags,
             os.path.join(tree, board)],
            cwd=tree, env=dict(os.environ, HOME=home, TMPDIR=tmp),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output = done.stdout
        if done.returncode != 0 or not os.path.isfile(out):
            return 422, output or (f"kicad-cli exited {done.returncode} and "
                                   f"printed nothing").encode()
        answer = io.BytesIO()
        with tarfile.open(fileobj=answer, mode="w") as tar:
            tar.add(out, arcname="export." + fmt)
            info = tarfile.TarInfo(OUTPUT_NAME)
            info.size = len(output)
            tar.addfile(info, io.BytesIO(output))
        return 200, answer.getvalue(), "application/x-tar"

    def _answer(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), ExportHandler).serve_forever()
