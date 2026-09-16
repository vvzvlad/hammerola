from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.config_errors import load_settings_or_exit


class Settings(BaseSettings):
    # THE CREDENTIAL — one field, WITHOUT a default. If the variable is missing
    # from the environment, Settings() raises a validation error and the app
    # fails at startup. Credentials never have defaults and are never hardcoded.
    #
    # ONE SECRET FOR THE WHOLE SYSTEM (decided 2026-08-27, issue #26,
    # implemented as step 0 of the plan in AGENTS.md). EDIT_TOKEN is presented as
    # `Authorization: Bearer <token>` and it means "may change things here":
    # publish a build, read a build's sources and log, rename a project, remove
    # one, read the comment queue, resolve an item — and, since step 0, leave a
    # comment. There is no second key and there is not going to be one.
    #
    # THE NAME SAYS WHAT IT PERMITS, and that is why it is not PUBLISH_TOKEN
    # any more. Two variables used to live here — PUBLISH_TOKEN for pushes and
    # COMMENT_READ_TOKEN for the queue — and the first of them outgrew its name
    # long before it lost its twin: it already gated the sources of every
    # project on the hub and the route that DELETES a project. A variable called
    # PUBLISH_TOKEN reads like a CI push credential, which is exactly what
    # invites handing it to a shared organisation's CI — the privilege
    # escalation SPEC 8A.1 warns about, now that a push is executed rather than
    # merely stored. EDIT_TOKEN also matches the word the browser UI already
    # uses for the same string: "View only" without it, "Editing on" with it.
    #
    # A TOKEN, NOT A PASSWORD, and the distinction is deliberate even though a
    # person types this one into a web form. It is a single shared string
    # compared for equality with `hmac.compare_digest`; it is not per-person, it
    # is not hashed, it is not revocable on its own, and nothing here records
    # WHO presented it. Calling it a password would advertise an authentication
    # system that does not exist (issue #26 says so out loud), and
    # `hammerola login` means "store the shared secret", nothing more.
    edit_token: str = Field(min_length=1)

    # Listening socket. No default host/port would be hostile: neither depends on
    # the deployment — Traefik reaches the container on the compose network.
    host: str = "0.0.0.0"
    port: int = Field(default=8000, ge=1, le=65535)

    # All mutable state lives under data/ (a docker volume in production). Assets
    # and templates deliberately live OUTSIDE it: the volume would shadow them.
    data_dir: str = "data"

    # NO RETENTION SETTING, and its absence is deliberate rather than an
    # omission (SPEC 5.3, 7.3, decision of 2026-08-27): nothing published is ever
    # deleted, so there is no window to configure. Anything that looks like it
    # belongs here — a build count, an age — would be a knob that decides which
    # builds to destroy, and that decision is not one this service makes.

    # Hard ceiling on one uploaded build, applied to the compressed body AND to
    # the total uncompressed size — the second one is what stops a gzip bomb.
    max_build_bytes: int = Field(default=64 * 1024 * 1024, ge=1)

    # -- ceilings on the comment endpoint (SPEC 7A.4) --------------------------
    # Not secrets, so they get defaults. EVERY ONE OF THEM IS ABOUT SIZE, and
    # that is the whole of what is left here: how much work one body makes the
    # hub do, and what the hub then hands back out on the same origin as every
    # project's builds. None of them is about HOW MANY comments there are or how
    # fast they arrive — see below.
    #
    # THERE IS NO RATE LIMIT AND NO COUNT CEILING, and their absence is a
    # decision (2026-08-27, SPEC §7A.4), not an omission somebody should close.
    # Writing a comment takes EDIT_TOKEN since step 0, and EDIT_TOKEN is the one
    # secret of the whole system: whoever holds it can publish, rename and
    # `DELETE /api/v1/projects/<pid>` — erase the project outright. Throttling
    # the one caller who can delete everything is not a defence, it is a way to
    # refuse the sixth comment of a review. The count ceilings went with the
    # same decision that removed retention everywhere else (SPEC §5.3): a
    # comment is a JSON file and a photo, the volume grows and that is accepted.

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

    # -- the proposal panel, which a hub serves only if it was asked to --------
    #
    # NOT A SECRET, so it has a default — and the default is OFF because of what
    # the flag is FOR. The proposal panel is a feature still being tried out, and
    # an unset variable has to mean "no": a deployment that never heard of it
    # must not start serving it because a release carried it. So the question
    # this field answers is "did somebody ASK for this", and silence is not an
    # answer in favour.
    #
    # ONE KNOB FOR THE WHOLE HUB and no second one. The server decides it once
    # and stamps it on the page (`render.build_page_html`); there is no
    # per-project setting, nothing an editor can turn on from the browser, and
    # nothing about it changes while a page is open.
    proposal_panel: bool = False

    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


# Build settings with clear startup errors: a missing/invalid variable prints a
# readable message naming the env var and exits, instead of a raw pydantic
# traceback. The same helper is reused by any other entrypoint (e.g. an MCP server).
settings = load_settings_or_exit(Settings)
