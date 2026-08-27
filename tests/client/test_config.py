"""Where HUB_URL and EDIT_TOKEN come from, and what happens when they do not.

The load-bearing claim is the LAST one in this file: no default for the hub's
address. It is a project rule (AGENTS.md) rather than a preference — a guessed
address is one that resolves somewhere, and "somewhere" for a push carrying a
token is not a place to end up by accident.
"""

import pytest
from modeldir import make_model

from src.client.config import (
    ConfigError,
    display_path,
    hub_url,
    machine_env_file,
    parse_env_file,
    edit_token,
)


def test_the_environment_wins(monkeypatch, tmp_path):
    machine = tmp_path / "machine-env"
    machine.write_text("HUB_URL=https://from-the-file.example\n")
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(machine))
    monkeypatch.setenv("HUB_URL", "https://from-the-environment.example")
    assert hub_url() == "https://from-the-environment.example"


def test_the_project_env_beats_the_machine_file(monkeypatch, tmp_path):
    machine = tmp_path / "machine-env"
    machine.write_text("HUB_URL=https://machine.example\n")
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(machine))
    root = make_model(tmp_path / "demo")
    (root / ".env").write_text("HUB_URL=https://this-project.example\n")
    assert hub_url(root) == "https://this-project.example"


def test_the_machine_file_is_the_last_resort(monkeypatch, tmp_path):
    machine = tmp_path / "machine-env"
    machine.write_text("HUB_URL = https://machine.example/  \nEDIT_TOKEN='tok'\n")
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(machine))
    # The trailing slash is removed: every caller appends a path to this.
    assert hub_url() == "https://machine.example"
    assert edit_token() == "tok"


def test_an_empty_value_counts_as_absent(monkeypatch, tmp_path):
    """A stray `HUB_URL=` in a file must fall through, not arrive later as an
    unusable URL halfway through a push."""
    machine = tmp_path / "machine-env"
    machine.write_text("HUB_URL=https://machine.example\n")
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(machine))
    monkeypatch.setenv("HUB_URL", "   ")
    assert hub_url() == "https://machine.example"


def test_the_env_file_parser_executes_nothing(tmp_path):
    """It is a file that can hold a token, so it is read, never sourced."""
    path = tmp_path / "env"
    path.write_text(
        "# a comment\n"
        "\n"
        "export HUB_URL=\"https://quoted.example\"\n"
        "EDIT_TOKEN=$(echo pwned)\n"
        "not-an-assignment\n"
    )
    values = parse_env_file(path)
    assert values == {"HUB_URL": "https://quoted.example",
                      "EDIT_TOKEN": "$(echo pwned)"}


def test_a_missing_hub_url_names_the_variable_and_the_file(monkeypatch, tmp_path):
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "absent"))
    with pytest.raises(ConfigError) as caught:
        hub_url()
    message = str(caught.value)
    assert "HUB_URL is not set" in message
    # Every place it looked, so the reader knows where to put it.
    assert "the environment" in message
    assert ".env" in message
    assert str(tmp_path / "absent") in message


def test_a_missing_token_names_the_variable(monkeypatch, tmp_path):
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "absent"))
    with pytest.raises(ConfigError) as caught:
        edit_token()
    assert "EDIT_TOKEN is not set" in str(caught.value)


def test_there_is_no_default_hub_address(monkeypatch, tmp_path):
    """The rule itself, asserted rather than assumed: with nothing configured,
    the tool has to FAIL. Anything else means an address is compiled in."""
    monkeypatch.setenv("HAMMEROLA_ENV_FILE", str(tmp_path / "absent"))
    root = make_model(tmp_path / "demo")
    with pytest.raises(ConfigError):
        hub_url(root)


def test_the_machine_file_is_named_after_the_project(monkeypatch):
    """One name everywhere (AGENTS.md), the config directory included."""
    monkeypatch.delenv("HAMMEROLA_ENV_FILE", raising=False)
    assert machine_env_file().parent.name == "hammerola"
    assert display_path(machine_env_file()).endswith("/.config/hammerola/env")
