import pytest
from pydantic import ValidationError

from src.settings import Settings


def test_loads_from_env(monkeypatch):
    monkeypatch.setenv("PUBLISH_TOKEN", "test-token-value")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    s = Settings(_env_file=None)
    assert s.publish_token == "test-token-value"
    assert s.log_level == "DEBUG"


def test_missing_credential_fails(monkeypatch):
    # A missing credential must blow up at construction time, not silently default.
    monkeypatch.delenv("PUBLISH_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)
