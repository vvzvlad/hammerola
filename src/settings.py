from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.config_errors import load_settings_or_exit


class Settings(BaseSettings):
    # The one credential, without a default: if EDIT_TOKEN is missing from the
    # environment, Settings() fails at startup. Presented as
    # `X-Hammerola-Token: <token>`, it means "may change things here":
    # publish, read a build's sources and log, rename or remove a project, read
    # and resolve the comment queue, leave a comment. There is no second key.
    #
    # Named for what it permits: a name like PUBLISH_TOKEN reads like a CI push
    # credential and invites handing it to a shared CI (SPEC 8A.1). It is one
    # shared string compared with `hmac.compare_digest` — not per-person, not
    # hashed, not revocable on its own, and nothing records who presented it —
    # so it is a token, not a password; `hammerola login` just stores it.
    edit_token: str = Field(min_length=1)

    # Listening socket. No default host/port would be hostile: neither depends on
    # the deployment — Traefik reaches the container on the compose network.
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)

    # All mutable state lives under data/ (a docker volume in production). Assets
    # and templates deliberately live OUTSIDE it: the volume would shadow them.
    data_dir: str = "data"

    # No retention setting: nothing published is ever deleted (SPEC 5.3, 7.3),
    # so there is no window to configure.

    # Hard ceiling on one uploaded build, applied to the compressed body AND to
    # the total uncompressed size — the second one is what stops a gzip bomb.
    max_build_bytes: int = Field(default=64 * 1024 * 1024, ge=1)

    # -- ceilings on the comment endpoint (SPEC 7A.4) --------------------------
    # Not secrets, so they get defaults. All of them bound size: how much work
    # one body makes the hub do, and what it hands back on the same origin as
    # every project's builds. There is deliberately no rate limit and no count
    # ceiling: writing a comment takes EDIT_TOKEN, whose holder can already
    # delete the project, and comments are kept like everything else (SPEC 5.3).

    # The comment body. Long enough for a paragraph of "the bracket fouls the
    # standoff on the left", far short of a novel.
    comment_max_text_chars: int = Field(default=4000, ge=1)

    # One attachment: the uploaded photo, or the viewer's own render of the
    # frame. Separate from MAX_BUILD_BYTES on purpose — a build is 64 MiB of
    # geometry that goes through the archive rules and into a build directory;
    # this is a phone photo that the hub stores as it arrived and hands back on
    # the same origin, and the two ceilings have nothing to do with each other.
    comment_max_photo_bytes: int = Field(default=8 * 1024 * 1024, ge=1)

    # The whole multipart body. Must leave room for a photo AND a render AND the
    # JSON field AND multipart framing, so it is not simply the photo ceiling:
    # it is checked against Content-Length BEFORE a byte is read, which is what
    # makes it the ceiling that actually saves the work.
    comment_max_body_bytes: int = Field(default=20 * 1024 * 1024, ge=1)

    # Ceiling on the body of a stored proposal (`POST /api/v1/proposals/<pid>`).
    # Not a secret, so it has a default, and it is about SIZE like the three
    # above: an unbounded parse and an unbounded store are not made safe by the
    # credential in front of them.
    #
    # FAR SMALLER THAN A COMMENT'S, and the reason is what the two bodies carry.
    # A comment's ceiling has to clear a phone photo AND the viewer's render of
    # the frame; a proposal is a few dozen lines of numbers — the document the
    # browser holds and the aligned text it renders off it — with no image in it
    # anywhere. 256 KiB is orders of magnitude more than the panel can produce
    # by hand and still small enough that the parse is free.
    proposal_max_body_bytes: int = Field(default=256 * 1024, ge=1)

    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


# Build settings with clear startup errors: a missing/invalid variable prints a
# readable message naming the env var and exits, instead of a raw pydantic
# traceback. The same helper is reused by any other entrypoint (e.g. an MCP server).
settings = load_settings_or_exit(Settings)
