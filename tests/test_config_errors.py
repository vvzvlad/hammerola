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


class _TwoRequired(BaseSettings):
    """Two credentials, so the guard can be asked to name BOTH of them.

    src/settings.py declares exactly one no-default field since step 0 of the
    plan (EDIT_TOKEN — one secret for the whole system, issue #26), and
    that is what makes this throwaway class load-bearing rather than decorative.
    The CI smoke gate used to prove the many-names property against the real
    image, because the real image had two credentials to drop; with one, check
    (b) in ci/smoke.py can no longer distinguish "names every missing key" from
    "names the first one" — see REQUIRED_VARIABLES there, which points here.
    """

    first_secret: str
    second_secret: str
    model_config = SettingsConfigDict(env_file=None, extra="ignore")


def test_missing_required_exits_with_clear_message(capsys, monkeypatch):
    monkeypatch.delenv("SOME_REQUIRED_VALUE", raising=False)
    with pytest.raises(SystemExit) as ei:
        load_settings_or_exit(_Req)
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "SOME_REQUIRED_VALUE" in err
    assert "Missing required" in err


def test_every_missing_variable_is_named_not_just_the_first(capsys, monkeypatch):
    """Drop two variables, and the message has to mention both.

    The failure this guards against is quiet and expensive: a guard that names
    only the first missing key sends whoever redeployed the stack round the loop
    once per variable — set it, redeploy, meet the identical error over the next
    one — and nothing anywhere says that is what is happening. A `[0]`, a
    `next(...)` or a loop rewritten as a lookup in src/config_errors.py is all it
    takes, and with one credential in the real Settings no other check in this
    repository would notice.
    """
    monkeypatch.delenv("FIRST_SECRET", raising=False)
    monkeypatch.delenv("SECOND_SECRET", raising=False)
    with pytest.raises(SystemExit) as ei:
        load_settings_or_exit(_TwoRequired)
    assert ei.value.code == 1
    err = capsys.readouterr().err
    assert "FIRST_SECRET" in err
    assert "SECOND_SECRET" in err


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
