from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.config_errors import load_settings_or_exit


class Settings(BaseSettings):
    # Credentials — fields WITHOUT a default. If the variable is missing from the
    # environment, Settings() raises a validation error and the app fails at
    # startup. Credentials never have defaults and are never hardcoded.
    #
    # PUBLISH_TOKEN is the single shared secret CI presents as `Authorization:
    # Bearer <token>` when it pushes a build. The public SITE has no read-side
    # auth at all (SPEC 5.5); the comment queue is the one thing that does.
    publish_token: str = Field(min_length=1)

    # COMMENT_READ_TOKEN guards everything about the comment queue except writing
    # to it (SPEC 7A.2). The queue is raw input from anyone at all, so reading it
    # back out needs a secret: an open read endpoint turns the project showcase
    # into a public message board. A DIFFERENT secret from PUBLISH_TOKEN because
    # the two go to different places: PUBLISH_TOKEN lives in CI, this one in the
    # agent's MCP server, and either can be rotated without touching the other.
    #
    # WRITING a comment takes no token TODAY. That is the state this project
    # INHERITED from cad_snapshot_hub, ported verbatim, and not a property it
    # stands behind: SPEC 8A.1 reverses it, because a hub that also BUILDS code
    # turns an anonymous body into the first step of a path from unauthenticated
    # input to code execution. Step 0 of the plan (see AGENTS.md) moves the write
    # side behind a token too; until it lands, the fields below stay as ported.
    comment_read_token: str = Field(min_length=1)

    # Listening socket. No default host/port would be hostile: neither depends on
    # the deployment — Traefik reaches the container on the compose network.
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)

    # All mutable state lives under data/ (a docker volume in production). Assets
    # and templates deliberately live OUTSIDE it: the volume would shadow them.
    data_dir: str = "data"

    # Retention: keep this many newest builds per project (SPEC 7.3). The build
    # `latest` points at is never pruned, even when it falls out of the window.
    retention_builds: int = Field(default=20, ge=1)

    # Hard ceiling on one uploaded build, applied to the compressed body AND to
    # the total uncompressed size — the second one is what stops a gzip bomb.
    max_build_bytes: int = Field(default=64 * 1024 * 1024, ge=1)

    # -- ceilings on the public comment endpoint (SPEC 7A.4) -------------------
    # Not secrets, so they get defaults; every one of them exists because the
    # endpoint accepts a body from an unauthenticated stranger, and a public
    # writer with no ceiling eventually owns the volume.

    # The comment body. Long enough for a paragraph of "the bracket fouls the
    # standoff on the left", far short of a novel.
    comment_max_text_chars: int = Field(default=4000, ge=1)

    # One attachment: the uploaded photo, or the viewer's own render of the
    # frame. Separate from MAX_BUILD_BYTES on purpose — a build is 64 MiB of
    # geometry pushed by CI holding a token; this is a phone photo from a
    # stranger, and the two ceilings have nothing to do with each other.
    comment_max_photo_bytes: int = Field(default=8 * 1024 * 1024, ge=1)

    # The whole multipart body. Must leave room for a photo AND a render AND the
    # JSON field AND multipart framing, so it is not simply the photo ceiling:
    # it is checked against Content-Length BEFORE a byte is read, which is what
    # makes it the ceiling that actually saves the work.
    comment_max_body_bytes: int = Field(default=20 * 1024 * 1024, ge=1)

    # Comments one build may collect, and comments the whole hub may hold. The
    # first stops one popular build from filling the disk; the second stops a
    # patient writer from doing it one build at a time.
    comment_max_per_build: int = Field(default=100, ge=1)
    comment_max_total: int = Field(default=5000, ge=1)

    # Rate limit per client address (SPEC 7A.4). Five comments per ten minutes is
    # far more than a person leaving feedback needs and far less than a script
    # wants. The address is resolved by `comments.client_address`, which does not
    # take X-Forwarded-For at face value.
    comment_rate_limit: int = Field(default=5, ge=1)
    comment_rate_window_seconds: int = Field(default=600, ge=1)

    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


# Build settings with clear startup errors: a missing/invalid variable prints a
# readable message naming the env var and exits, instead of a raw pydantic
# traceback. The same helper is reused by any other entrypoint (e.g. an MCP server).
settings = load_settings_or_exit(Settings)
