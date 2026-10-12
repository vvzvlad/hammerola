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

    SIGTERM is what `docker stop` sends, so every deploy ends with it. Under the
    default disposition `serve_forever` never returns and `Server.server_close`
    (where `BuildQueue.shutdown` lives) never runs. That shutdown stops the
    workers taking new builds, drops queued ones and their sources, and waits
    for a worker mid-PUBLISH (the rename onto `<pid>/<commit>` and the pointer
    writes), so a build never lands with `latest` pointing elsewhere.

    `shutdown()` is called from another thread: it blocks until the
    `serve_forever` loop on the main thread sees the request, and the signal
    handler runs on that same main thread. Logging happens in that thread too,
    since a handler that logs can deadlock against a log call it interrupted.

    The thread is created at install time and the handler only wakes it:
    `Thread.start()` takes `threading._active_limbo_lock`, which the main thread
    holds whenever `ThreadingHTTPServer` spawns a connection thread, so starting
    it from the handler could deadlock until SIGKILL.
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
        # A second signal must not re-enter `Event.set()`, which holds a
        # non-reentrant lock. The plain flag is set before the call so the check
        # covers all of it (`is_set()` is raised inside that lock).
        if handled:
            return
        handled = True
        signum_seen = signum
        stop_requested.set()

    signal.signal(signal.SIGTERM, stop)


def main():
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)

    # Before anything a build could reach: builds run as the same uid in the
    # same pid namespace, so without this a model could read the token from
    # /proc/<hub pid>/environ. See src/buildproc/hardening.py.
    try:
        logger.info(hide_process_from_same_uid())
    except HardeningFailed as exc:
        # Fatal, like `LimitsUnavailable`: an exposed environment would
        # otherwise look exactly like a working hub.
        logger.error(f"Refusing to start: {exc}")
        raise SystemExit(1) from exc
    # This exact string is the CI smoke gate's STARTUP_MARKER (ci/smoke.py): it
    # proves settings parsed (EDIT_TOKEN arrived) and logging is up. Rename it
    # only together with that constant.
    logger.info("Starting hammerola")

    server = create_server(settings)
    # Before serving: the build pool is already running.
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
