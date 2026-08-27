"""Entry point: configure logging, build the server, serve until stopped."""

import signal
import sys
import threading

from loguru import logger

from src.app import create_server
from src.buildproc import HardeningFailed, hide_process_from_same_uid
from src.settings import settings


def install_stop_handler(server) -> None:
    """Answer SIGTERM by shutting the server down, rather than by dying.

    SIGTERM is not an exotic event here — it is what `docker stop` sends, and it
    is therefore how every deploy, every restart and every `docker compose down`
    of this service ends. Under the default disposition the process is simply
    terminated: `serve_forever` never returns, the `finally` below never runs,
    and `Server.server_close` — which is where `BuildQueue.shutdown` lives —
    never runs either. So until this handler existed, the orderly shutdown ran
    only under Ctrl+C, i.e. only on a laptop, and never once in production.

    What that shutdown does is worth the handler: it stops the workers taking
    new builds, drops the queued ones and removes their unpacked sources, and
    waits for a worker that is mid-PUBLISH — the rename onto `<pid>/<commit>`
    and the pointer writes after it. Being killed inside that window is how a
    build ends up on disk with `latest` still pointing somewhere else.

    `shutdown()` is called FROM ANOTHER THREAD deliberately. It blocks until the
    `serve_forever` loop has come round and seen the request, and a Python
    signal handler runs on the MAIN thread — the one sitting in that loop. Calling
    it directly would be that thread waiting for itself, and the stop would hang
    until docker's SIGKILL. The logging is inside the thread for a smaller
    version of the same reason: a handler that logs can deadlock against a log
    call it interrupted.

    THAT THREAD IS CREATED HERE, at install time, and the handler only wakes it.
    Starting it inside the handler is the version that reads the same and can
    hang the stop outright: `Thread.start()` takes `threading._active_limbo_lock`,
    and the main thread holds that very lock every time `ThreadingHTTPServer`
    spawns a thread for an incoming connection. A signal handler runs on the main
    thread BETWEEN BYTECODES, so it can be entered while that thread is inside
    `start()` — and a `start()` from the handler would then wait for a lock its
    own thread is holding. Nothing releases it, the handler never returns, the
    serve loop never comes round, and the stop hangs until SIGKILL: exactly the
    ending this handler exists to prevent. The window is one function call wide
    and the failure is total, which is a poor trade to keep for the sake of a
    lazily created thread.
    """
    stop_requested = threading.Event()
    signum_seen = 0
    handled = False

    def wait_and_stop() -> None:
        stop_requested.wait()
        logger.info(f"signal {signum_seen}: stopping")
        server.shutdown()

    threading.Thread(target=wait_and_stop, name="hammerola-stop",
                     daemon=True).start()

    def stop(signum, _frame):
        nonlocal signum_seen, handled
        # A second signal must not re-enter `Event.set()`: it holds a plain,
        # non-reentrant lock while it runs, and a handler is interruptible by
        # the next signal on the same thread. The plain flag is set BEFORE the
        # call so the check above covers the whole of it — `is_set()` would not,
        # because the event's own flag is raised inside that lock.
        if handled:
            return
        handled = True
        signum_seen = signum
        stop_requested.set()

    signal.signal(signal.SIGTERM, stop)


def main():
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)

    # Before the socket, before anything a build could ever reach: the hub's own
    # /proc entry stops being readable by its own uid. Builds run as the same
    # user in the same pid namespace, and the token arrives through compose's
    # `environment:`, so without this a model reads it straight out of
    # /proc/<hub pid>/environ -- see src/buildproc/hardening.py, which is where
    # the whole argument lives.
    try:
        logger.info(hide_process_from_same_uid())
    except HardeningFailed as exc:
        # Fatal, and the same reasoning as `LimitsUnavailable`: a hub whose
        # environment is readable by the code it executes looks exactly like a
        # working one, for as long as nobody looks. Refusing is the only version
        # of this that is visible.
        logger.error(f"Refusing to start: {exc}")
        raise SystemExit(1) from exc
    # This exact string is the CI smoke gate's STARTUP_MARKER (ci/smoke.py). It is
    # the proof that settings parsed — i.e. the one required credential arrived,
    # EDIT_TOKEN — and that logging came up at the configured level. Rename it
    # only together with that constant, in the same commit.
    logger.info("Starting hammerola")

    server = create_server(settings)
    # Before the first request is served, because a stop can arrive at any point
    # after that and the build pool is already running by now.
    install_stop_handler(server)
    host, port = server.server_address[:2]
    logger.info(f"Serving on http://{host}:{port} (data dir: {settings.data_dir})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Interrupted, shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
