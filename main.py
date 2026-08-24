"""Entry point: configure logging, build the server, serve until stopped."""

import sys

from loguru import logger

from src.app import create_server
from src.settings import settings


def main():
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
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
