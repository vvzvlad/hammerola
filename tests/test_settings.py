import pytest
from pydantic import ValidationError

from src.settings import Settings


def test_loads_from_env(monkeypatch):
    monkeypatch.setenv("PUBLISH_TOKEN", "s3cret")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    s = Settings(_env_file=None)
    assert s.publish_token == "s3cret"
    assert s.log_level == "DEBUG"


def test_defaults_match_the_spec(monkeypatch):
    # SPEC 7.5 fixes every default, and the deployment relies on them: only
    # PUBLISH_TOKEN is set in docker-compose.yml, so a drift here silently changes
    # how much disk the volume grows to and what size upload is refused.
    monkeypatch.setenv("PUBLISH_TOKEN", "s3cret")
    for name in ("HOST", "PORT", "DATA_DIR", "RETENTION_BUILDS",
                 "MAX_BUILD_BYTES", "LOG_LEVEL"):
        monkeypatch.delenv(name, raising=False)
    s = Settings(_env_file=None)
    assert s.host == "0.0.0.0"
    assert s.port == 8000
    assert s.data_dir == "data"
    assert s.retention_builds == 20
    assert s.max_build_bytes == 64 * 1024 * 1024
    assert s.log_level == "INFO"


def test_missing_credential_fails(monkeypatch):
    # A missing credential must blow up at construction time, not silently default.
    monkeypatch.delenv("PUBLISH_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_empty_credential_fails(monkeypatch):
    # An empty PUBLISH_TOKEN is worse than a missing one: it would start the
    # service and then accept `Authorization: Bearer ` from anybody, so it has to
    # be refused at exactly the same place.
    monkeypatch.setenv("PUBLISH_TOKEN", "")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
