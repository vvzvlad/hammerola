from pydantic_settings import BaseSettings, SettingsConfigDict

from src.config_errors import load_settings_or_exit


class Settings(BaseSettings):
    # Credentials — fields WITHOUT a default. If the variable is missing from the
    # environment, Settings() raises a validation error and the app fails at
    # startup. Credentials never have defaults and are never hardcoded.
    publish_token: str

    # Addresses of YOUR OWN services — also no default. The address depends on the
    # deployment, so it comes from the environment only. Uncomment when needed.
    # my_backend_url: str

    # PUBLIC external services — a default is fine (stable, public endpoint that
    # does not depend on your deployment).
    # google_api_url: str = "https://www.googleapis.com"

    # Other NON-secret config — a sensible default is OK.
    log_level: str = "INFO"
    db_path: str = "data/app.db"  # all mutable state lives under data/

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


# Build settings with clear startup errors: a missing/invalid variable prints a
# readable message naming the env var and exits, instead of a raw pydantic
# traceback. The same helper is reused by any other entrypoint (e.g. an MCP server).
settings = load_settings_or_exit(Settings)
