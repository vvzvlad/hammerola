"""Fixtures for the client suite.

Three things are taken away from every test here, and all of them would
otherwise make a run depend on the machine it is on.

The first is `EDIT_TOKEN`. `tests/conftest.py` puts one in the environment at
import time so `src.settings` can be constructed — and the CLIENT reads a
variable of the same name, for the same hub, meaning something else: the token
the harness's hub actually checks is `harness.TOKEN`. A client test that
inherited the settings one would push with the wrong secret and get a 403 that
has nothing to do with what it was testing.

The second is `~/.config/hammerola/env`. It is a real file on a machine that
publishes models, so a suite that read it could pass because the developer is
configured and fail on anybody else's machine — or, far worse, push at a real
hub. `HAMMEROLA_ENV_FILE` points every test at a path that does not exist, so
the only settings in play are the ones a test sets for itself.

The third is HOME itself. `skill update` writes the whole of
`~/.claude/skills/hammerola/` without asking, and removes what the hub's copy
does not have — that is the verb — and on the machine running this suite that
directory is very likely the developer's own working copy. So the home the
client can reach is a directory under `tmp_path`, and a test that forgets
`--path` writes somewhere harmless.

The helpers live in `modeldir.py`, not here: see its docstring.
"""

import http.server
import threading
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest
from harness import TOKEN
from modeldir import make_model


@pytest.fixture(autouse=True)
def client_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "no-such-file"))
    monkeypatch.delenv("HUB_URL", raising=False)
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    monkeypatch.delenv("HUB_BASIC_AUTH", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    # BOTH names, because `Path.expanduser()` — which is what turns the `~` in
    # `skill.DEFAULT_PATH` into a real path — reads USERPROFILE on Windows and
    # HOME everywhere else. Setting one leaves the other platform pointed at
    # the machine's real home, i.e. exactly the case this is here to prevent.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@pytest.fixture
def configured(monkeypatch, hub):
    """A machine that knows where its hub is and holds the secret that hub checks.

    Two of the three things the fixture above takes away, handed back on
    purpose: a file about PUBLISHING needs an address and a token, and what the
    docstring at the top refuses is inheriting the DEVELOPER's. This gives the
    harness's own hub and `harness.TOKEN`, so a test that passes here would pass
    on any machine.

    Requested and not autouse: autouse would start a hub for every test in this
    directory — several files here need none — and would configure the files
    whose SUBJECT is a machine that is not configured yet (`test_config.py`,
    `test_setup.py`). A file asks for it with one line beside its imports,
    `pytestmark = pytest.mark.usefixtures("configured")`.

    `test_skill.py` keeps a `configured` of its own and means something else by
    it: a hub WITHOUT a token, because every test in that file states by passing
    that `skill` and `update` need no secret.
    """
    monkeypatch.setenv("HUB_URL", hub.url)
    monkeypatch.setenv("EDIT_TOKEN", TOKEN)


@pytest.fixture
def model(tmp_path):
    return make_model(tmp_path / "demo")


@pytest.fixture
def password_proxy(hub):
    """Traefik basicAuth in miniature, in front of the suite's real hub.

    -> `.url` to point the client at, and `.basic_auth`, the `login:password`
    it lets through. Anything else gets Traefik's own 401, plain text and a
    Basic challenge; with it, GET and POST (body and all) go on to the hub
    with every header, `Authorization` included, as Traefik forwards it.
    """
    basic_auth = "zlo:pa:ss"
    expected = "Basic emxvOnBhOnNz"  # base64 of `zlo:pa:ss`
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self._answer(*self._through(None))

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            self._answer(*self._through(self.rfile.read(length)))

        def _through(self, body):
            if self.headers.get("Authorization") != expected:
                return (401, "text/plain", b"401 Unauthorized\n",
                        {"WWW-Authenticate": 'Basic realm="traefik"'})
            forwarded = {name: value for name, value in self.headers.items()
                         if name.lower() not in ("host", "connection")}
            request = urllib.request.Request(
                hub.url + self.path, data=body, method=self.command,
                headers=forwarded)
            try:
                with opener.open(request, timeout=30) as reply:
                    return (reply.status, reply.headers.get("Content-Type"),
                            reply.read(), {})
            except urllib.error.HTTPError as error:
                with error:
                    return (error.code, error.headers.get("Content-Type"),
                            error.read(), {})

        def _answer(self, status, ctype, body, extra):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for name, value in extra.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=server.serve_forever,
                     kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        yield SimpleNamespace(
            url=f"http://127.0.0.1:{server.server_address[1]}",
            basic_auth=basic_auth)
    finally:
        server.shutdown()
        server.server_close()
