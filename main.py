"""Entry point: configure logging, build the server, serve until stopped."""

import sys

from loguru import logger

from src.app import create_server
from src.buildproc import HardeningFailed, hide_process_from_same_uid
from src.settings import settings


def main():
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)

    # Before the socket, before anything a build could ever reach: the hub's own
    # /proc entry stops being readable by its own uid. Builds run as the same
    # user in the same pid namespace, and the tokens arrive through compose's
    # `environment:`, so without this a model reads them straight out of
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
    # the proof that settings parsed — i.e. BOTH required credentials arrived,
    # PUBLISH_TOKEN and COMMENT_READ_TOKEN — and that logging came up at the
    # configured level. Rename it only together with that constant, in the same
    # commit.
    logger.info("Starting hammerola")

    server = create_server(settings)
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
