import sys

from loguru import logger

from src.settings import settings


def main():
    logger.remove()
    logger.add(sys.stderr, level=settings.log_level)
    logger.info("Starting hammerola")
    # TODO: construct and run your application here.


if __name__ == "__main__":
    main()
