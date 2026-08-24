import pytest
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.config_errors import load_settings_or_exit


# Throwaway settings models defined inside the test module. They explicitly do
# NOT read the project .env (env_file=None) so each test is hermetic and depends
# only on the env vars the test sets/unsets via monkeypatch.
class _Req(BaseSettings):
    some_required_value: str
    model_config = SettingsConfigDict(env_file=None, extra="ignore")


class _Ranged(BaseSettings):
    level: int = Field(ge=0, le=3)
    model_config = SettingsConfigDict(env_file=None, extra="ignore")


def test_missing_required_exits_with_clear_message(capsys, monkeypatch):
    monkeypatch.delenv("SOME_REQUIRED_VALUE", raising=False)
    with pytest.raises(SystemExit) as ei:
        load_settings_or_exit(_Req)
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "SOME_REQUIRED_VALUE" in err
    assert "Missing required" in err


def test_invalid_value_exits_with_clear_message(capsys, monkeypatch):
    # Out-of-range value triggers a non-"missing" validation error.
    monkeypatch.setenv("LEVEL", "9")
    with pytest.raises(SystemExit) as ei:
        load_settings_or_exit(_Ranged)
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "LEVEL" in err
    assert "Invalid" in err


def test_happy_path_returns_instance(monkeypatch):
    monkeypatch.setenv("SOME_REQUIRED_VALUE", "ok")
    obj = load_settings_or_exit(_Req)
    assert obj.some_required_value == "ok"
